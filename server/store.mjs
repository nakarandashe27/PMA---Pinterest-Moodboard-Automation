import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory) {
    fs.mkdirSync(directory,{recursive:true});
    this.db=new DatabaseSync(path.join(directory,'pma.sqlite'));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,parent_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS documents_kind_parent ON documents(kind,parent_id);");
  }
  get(kind,id) {
    const row=this.db.prepare('SELECT data FROM documents WHERE id=? AND kind=?').get(id,kind);
    return row?JSON.parse(row.data):null;
  }
  list(kind,parentId) {
    const rows=parentId===undefined?this.db.prepare('SELECT data FROM documents WHERE kind=? ORDER BY created_at DESC,id').all(kind):this.db.prepare('SELECT data FROM documents WHERE kind=? AND parent_id=? ORDER BY created_at DESC,id').all(kind,parentId);
    return rows.map(row=>JSON.parse(row.data));
  }
  save(kind,data,parentId='') {
    if(!data||typeof data.id!=='string')throw Error('Record ID is required');
    const old=this.db.prepare('SELECT kind,parent_id,data FROM documents WHERE id=?').get(data.id);
    if(old&&(old.kind!==kind||old.parent_id!==parentId))throw Error('Record owner cannot change');
    if(old){
      const previous=JSON.parse(old.data);
      if(previous.projectId!==data.projectId)throw Error('Record project cannot change');
      if(kind==='local-credential'&&previous.connectionId!==data.connectionId)throw Error('Credential account cannot change');
      if(kind==='connection'&&previous.username&&previous.username.toLowerCase()!==data.username?.toLowerCase())throw Error('Connection identity cannot change');
      const fixedFields={export:['selectionId','snapshotHash'], 'figma-attempt':['exportId','selectionId','snapshotHash'],pairing:['exportId','attemptId','packagePath'],'pinterest-export':['selectionId'],'pin-save':['boardId','sourcePinId','assetSha256']};
      for(const field of fixedFields[kind]||[])if(previous[field]!==undefined&&previous[field]!==data[field])throw Error('Record binding cannot change');
      if(kind==='run'&&previous.connectionId!==data.connectionId)throw Error('Run account cannot change');
      if(kind==='run'&&previous.replacement&&(previous.replacement.parentRunId!==data.replacement?.parentRunId||previous.replacement.rootRunId!==data.replacement?.rootRunId))throw Error('Replacement ancestry cannot change');
      if(kind==='evaluation'&&previous.connectionId!==data.connectionId)throw Error('Evaluation account cannot change');
      if(kind==='ai-profile'&&previous.connectionId!==data.connectionId)throw Error('AI profile account cannot change');
      if(['export','figma-attempt','pinterest-export','pin-save','board','pairing'].includes(kind)&&previous.connectionId!==data.connectionId)throw Error('Export account cannot change');
      if(kind==='board'&&previous.url&&previous.url!==data.url)throw Error('Bound board cannot change');
      if(kind==='project'&&previous.ownerConnectionId&&previous.ownerConnectionId!==data.ownerConnectionId)throw Error('Project account cannot change');
      if(kind==='selection')throw Error('Selection snapshot is immutable');
      if(kind==='export-recovery')throw Error('Export recovery evidence is immutable');
      if(kind==='ai-reservation')throw Error('AI reservation is immutable');
      if(kind==='interpretation'&&(previous.connectionId!==data.connectionId||previous.inputHash!==data.inputHash||previous.promptVersion!==data.promptVersion||JSON.stringify(previous.input)!==JSON.stringify(data.input)||previous.model&&previous.model!==data.model))throw Error('Interpretation owner and input are immutable');
    }
    const now=new Date().toISOString();
    const body=JSON.stringify(data);
    this.db.prepare('INSERT INTO documents(id,kind,parent_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(data.id,kind,parentId,body,now,now);
    return data;
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=work();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  recover() {
    for(const brief of this.list('interpretation'))if(['queued','preparing','running'].includes(brief.status))this.save('interpretation',{...brief,status:brief.callCount?'unknown':'interrupted',message:brief.callCount?'Сервис перезапущен. Результат AI неизвестен; автоматического повтора нет.':'Подготовка остановлена до вызова AI. Её можно запустить явно.'},brief.projectId);
    for(const run of this.list('run')){
      if(['queued','searching','downloading','ranking'].includes(run.status))this.save('run',{...run,status:'interrupted',...(run.ai?.status==='running'?{ai:{...run.ai,status:'unknown',message:'Результат AI-запуска после перезапуска не подтверждён. Автоматического повтора нет.'}}:{}),...(run.replacement?{replacement:{...run.replacement,status:run.replacement.pool?.length?'review':'pending',...(run.replacement.ai?.status==='running'?{ai:{...run.replacement.ai,status:'unknown',message:'Результат оценки замен неизвестен. Автоматического повтора нет.'}}:{})}}:{}),message:'Поиск остановился при перезапуске. Можно продолжить с сохранёнными результатами.'},run.projectId);
      // Older versions discarded observed pins on an access stop. Preserve the
      // history and count, and make these runs explicitly resumable too.
      else if(run.sourceKind==='live'&&run.status==='error'&&/^(?:Pinterest запросил (?:проверку|(?:повторный )?вход)\.|Нужен вход в Pinterest\.|В браузере открыт другой аккаунт\.)/.test(run.message||''))this.save('run',{...run,status:'blocked',blockReason:run.message.includes('проверку')?'captcha':'login'},run.projectId);
    }
  }
  recoverExports(){
    for(const attempt of this.list('figma-attempt'))if(attempt.state==='importing')this.save('figma-attempt',{...attempt,state:'unknown',message:'Сервис перезапущен. Сначала сверка существующего фрейма.'},attempt.projectId);
    for(const exp of this.list('pinterest-export'))if(exp.state==='running')this.save('pinterest-export',{...exp,state:'unknown',message:'Сервис перезапущен. Нужна сверка доски перед новыми записями.'},exp.projectId);
  }
  close(){this.db.close();}
}
