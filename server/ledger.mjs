// Authoritative AI accounting, kept outside the project database so that restoring a project
// backup can never lower what was already spent. The project store keeps only a binding
// {ledgerId, seq}: if the ledger later disappears or is older than the binding, paid AI is closed.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from './domain.mjs';

export const LEDGER_SCHEMA_VERSION=2;
export const BINDING_ID='ledger-binding';

export class Ledger {
  // store: the project Store; legacy: reservations found in it are imported once into a new ledger.
  constructor(directory,store){
    this.file=path.join(directory,'ledger.sqlite');this.store=store;this.blocked=null;this.db=null;
    const binding=store.get('ledger-binding',BINDING_ID),exists=fs.existsSync(this.file);
    if(!exists&&binding){this.blocked='Учёт расхода AI не найден, хотя ранее вёлся. Платный AI закрыт до сверки владельцем; новый пустой счётчик не создаётся.';return;}
    fs.mkdirSync(directory,{recursive:true});
    this.db=new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>LEDGER_SCHEMA_VERSION){this.blocked='Учёт расхода создан более новой версией PMA. Платный AI закрыт.';return;}
    if(version===0){
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE reservations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,slot TEXT NOT NULL,connection_id TEXT,project_id TEXT,month TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),created_at TEXT NOT NULL,legacy INTEGER NOT NULL DEFAULT 0)");
        this.db.prepare('INSERT INTO meta VALUES(?,?)').run('ledgerId',randomUUID());
        for(const r of store.list('ai-reservation'))this.db.prepare('INSERT INTO reservations(id,slot,connection_id,project_id,month,amount,created_at,legacy) VALUES(?,?,?,?,?,?,?,1)').run(r.id,r.slot,r.connectionId??null,r.projectId??null,r.month,r.amount,r.createdAt||new Date(0).toISOString());
        this.db.exec('PRAGMA user_version=1');this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    // v2: money. Old rows stay call-only; the profile snapshot of each paid reservation is immutable.
    if(this.db.prepare('PRAGMA user_version').get().user_version===1){
      this.db.exec('BEGIN IMMEDIATE');
      try{this.db.exec('ALTER TABLE reservations ADD COLUMN currency TEXT; ALTER TABLE reservations ADD COLUMN reserved_micros INTEGER; ALTER TABLE reservations ADD COLUMN actual_micros INTEGER; ALTER TABLE reservations ADD COLUMN snapshot TEXT; PRAGMA user_version=2;');this.db.exec('COMMIT');}
      catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    this.id=this.db.prepare("SELECT value FROM meta WHERE key='ledgerId'").get().value;
    const seq=this.lastSeq();
    if(binding&&binding.ledgerId!==this.id)this.blocked='Учёт расхода AI заменён другим файлом. Платный AI закрыт до сверки владельцем.';
    else if(binding&&seq<binding.seq)this.blocked='Учёт расхода AI старше проектных данных (восстановлена старая копия учёта). Платный AI закрыт до сверки владельцем.';
  }
  lastSeq(){return this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM reservations').get().seq;}
  has(id){return !!this.db?.prepare('SELECT 1 FROM reservations WHERE id=?').get(id);}
  // A lost ledger has no database: nothing is readable, so the view reports 0 calls and no spend while paid AI stays closed.
  usedInMonth(month){if(!this.db)return 0;return this.db.prepare('SELECT coalesce(sum(amount),0) AS n FROM reservations WHERE month=?').get(month).n;}
  // Owner spending this month: settled cost where known, otherwise the reserved upper bound.
  monthSpend(connectionId,month){
    if(!this.db)return [];
    return this.db.prepare('SELECT currency,coalesce(sum(coalesce(actual_micros,reserved_micros)),0) AS micros,count(*) AS calls FROM reservations WHERE connection_id=? AND month=? AND currency IS NOT NULL GROUP BY currency').all(connectionId,month).map(r=>({currency:r.currency,micros:r.micros,calls:r.calls}));
  }
  // Atomic claim of one slot within the monthly call pool and, for paid calls, the owner's money limit.
  // Never released: unknown, failed and cancelled calls stay counted at their reserved upper bound.
  reserve(reservation,limit,cost=null){
    if(this.blocked)throw new AppError(this.blocked,409);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(this.has(reservation.id))throw new AppError('Лимит AI этого шага уже использован. Неизвестный результат не повторяется.',409);
      const callLimit=cost?.callLimit?Math.min(limit,cost.callLimit):limit;
      if(this.usedInMonth(reservation.month)>=callLimit)throw new AppError('Общий месячный предел PMA исчерпан ('+callLimit+' запусков). Исходные данные сохранены; можно продолжить вручную.',409);
      if(cost){
        if(!Number.isSafeInteger(cost.micros)||cost.micros<0||!/^[A-Z]{3}$/.test(cost.currency))throw new AppError('Нет доказанной верхней стоимости; вызов не отправлен',409);
        const spend=this.monthSpend(reservation.connectionId,reservation.month);
        if(spend.some(s=>s.currency!==cost.currency))throw new AppError('В этом месяце расход уже учтён в другой валюте ('+spend.map(s=>s.currency).join(', ')+'). Платный AI закрыт до следующего месяца или сверки.',409);
        const used=spend[0]?.micros||0;
        if(used+cost.micros>cost.monthlyLimitMicros)throw new AppError('Денежный предел месяца не позволяет этот вызов: использовано '+(used/1e6).toFixed(2)+', верхняя оценка вызова '+(cost.micros/1e6).toFixed(2)+', предел '+(cost.monthlyLimitMicros/1e6).toFixed(2)+' '+cost.currency+'.',409);
      }
      const {lastInsertRowid}=this.db.prepare('INSERT INTO reservations(id,slot,connection_id,project_id,month,amount,created_at,currency,reserved_micros,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)').run(reservation.id,reservation.slot,reservation.connectionId??null,reservation.projectId??null,reservation.month,reservation.amount,reservation.createdAt,cost?.currency??null,cost?.micros??null,cost?JSON.stringify(cost.snapshot):null);
      this.db.exec('COMMIT');return {...reservation,seq:Number(lastInsertRowid),cost};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  // Confirmed cost from usage. Recorded once; later reads use it instead of the upper bound.
  settle(id,micros){this.db.prepare('UPDATE reservations SET actual_micros=? WHERE id=? AND actual_micros IS NULL').run(micros,id);}
  close(){try{this.db?.close();}catch{}}
}
