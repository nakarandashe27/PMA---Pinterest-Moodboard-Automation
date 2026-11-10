// Desktop data root: one resolver, an OS-held instance lock, schema versions, and a technical
// pre-migration backup. The project database is versioned with PRAGMA user_version.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from './domain.mjs';

export const SCHEMA_VERSION=1;
export const MIN_FREE_BYTES=300*1024*1024;
const DOCUMENTS_DDL="CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,parent_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS documents_kind_parent ON documents(kind,parent_id);";
// v0 = the web prototype's unversioned documents table. v1 only stamps the version.
export const MIGRATIONS=[{version:1,up:db=>db.exec(DOCUMENTS_DDL)}];
const IMMUTABLE_DIRS=['assets','uploads','exports','evaluations'];

// %LOCALAPPDATA%\PMA unless a test names another root. Never the workspace or cwd.
export function resolveRoot(env=process.env){
  if(env.PMA_DESKTOP_ROOT)return path.resolve(env.PMA_DESKTOP_ROOT);
  if(!env.LOCALAPPDATA)throw new AppError('Не найдена папка LocalAppData',500);
  return path.join(env.LOCALAPPDATA,'PMA');
}
export function layout(root){
  const at=name=>path.join(root,name);
  return {root,data:at('data'),accounting:at('accounting'),profiles:at('profiles'),settings:at('settings'),secrets:at('secrets'),diagnostics:at('diagnostics'),backups:at('backups'),shell:at('shell')};
}
export function ensureLayout(paths){
  for(const [key,dir] of Object.entries(paths))if(key!=='root')fs.mkdirSync(dir,{recursive:true});
  const probe=path.join(paths.data,'.write-probe-'+process.pid);
  try{fs.writeFileSync(probe,'ok');fs.rmSync(probe);}catch(error){throw new AppError('Нет доступа на запись в папку данных PMA: '+paths.data+' ('+error.code+')',500);}
  return paths;
}

// SQLite exclusive locking mode: the lock lives as long as this process; Windows drops it on crash.
// A second process gets "busy" immediately. No PID guessing, no lock file to delete by hand.
export function acquireInstanceLock(root){
  const db=new DatabaseSync(path.join(root,'instance.lock'));
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder(pid INTEGER); BEGIN EXCLUSIVE; DELETE FROM holder; INSERT INTO holder VALUES('+process.pid+'); COMMIT;');}
  catch(error){db.close();if(/locked|busy/i.test(error.message))throw new AppError('Папка данных PMA уже открыта другим процессом PMA. Закройте его и повторите.',409);throw error;}
  // The caller must keep this object referenced: a collected connection would release the lock.
  return {db,release:()=>{try{db.close();}catch{}}};
}

const fileSize=file=>{try{return fs.statSync(file).size;}catch{return 0;}};
function* walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())yield* walk(full);else if(entry.isFile())yield full;}}
const sha256File=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function diskStatus(paths){
  const s=fs.statfsSync(paths.root),dataBytes=fs.existsSync(paths.data)?[...walk(paths.data)].reduce((n,f)=>n+fileSize(f),0):0;
  return {freeBytes:s.bavail*s.bsize,dataBytes};
}

// Consistent snapshot of the closed database (VACUUM INTO includes WAL content) plus a SHA manifest of
// the immutable files it references. The directory is renamed from *.partial only when complete.
export function createBackup(paths,{reason,freeBytes=()=>diskStatus(paths).freeBytes}={}){
  const file=path.join(paths.data,'pma.sqlite');
  if(!fs.existsSync(file))throw new AppError('Нет базы данных для резервной копии',404);
  const need=Math.ceil((fileSize(file)+fileSize(file+'-wal'))*1.2)+64*1024*1024;
  if(freeBytes()<need)throw new AppError('Недостаточно места для резервной копии: нужно ещё около '+Math.ceil(need/1048576)+' МБ. Данные не изменены.',507);
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'),partial=path.join(paths.backups,id+'.partial'),done=path.join(paths.backups,id);
  fs.mkdirSync(partial,{recursive:true});
  try{
    const target=path.join(partial,'pma.sqlite'),db=new DatabaseSync(file);
    try{db.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");}finally{db.close();}
    const files=[];
    for(const dir of IMMUTABLE_DIRS){const full=path.join(paths.data,dir);if(fs.existsSync(full))for(const f of walk(full))files.push({path:path.relative(paths.data,f).replaceAll('\\','/'),size:fileSize(f),sha256:sha256File(f)});}
    const check=new DatabaseSync(target,{readOnly:true});let version;try{version=check.prepare('PRAGMA user_version').get().user_version;}finally{check.close();}
    fs.writeFileSync(path.join(partial,'manifest.json'),JSON.stringify({id,reason,createdAt:new Date().toISOString(),schemaVersion:version,database:{file:'pma.sqlite',sha256:sha256File(target)},files},null,1));
    fs.renameSync(partial,done);
    return {id,dir:done};
  }catch(error){fs.rmSync(partial,{recursive:true,force:true});throw error;}
}
export function listBackups(paths){
  if(!fs.existsSync(paths.backups))return [];
  return fs.readdirSync(paths.backups).filter(n=>!n.endsWith('.partial')&&fs.existsSync(path.join(paths.backups,n,'manifest.json'))).sort();
}

// Brings the project database to SCHEMA_VERSION. A newer database is never written. Each migration
// runs in one transaction after a complete backup, so a crash leaves the old version and can be repeated.
export function prepareSchema(paths,{migrations=MIGRATIONS,current=SCHEMA_VERSION,freeBytes}={}){
  const file=path.join(paths.data,'pma.sqlite');
  if(!fs.existsSync(file)){
    const db=new DatabaseSync(file);
    try{db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;'+DOCUMENTS_DDL+'PRAGMA user_version='+current+'; COMMIT;');}finally{db.close();}
    return {version:current,created:true,backup:null};
  }
  const read=()=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}};
  const version=read();
  if(version>current)throw new AppError('Данные созданы более новой версией PMA (схема '+version+', эта версия знает '+current+'). Эта версия их не изменяет; установите актуальную PMA.',409);
  if(version===current)return {version,created:false,backup:null};
  const backup=createBackup(paths,{reason:'before migration '+version+'→'+current,freeBytes});
  const db=new DatabaseSync(file);
  try{
    for(const m of [...migrations].sort((a,b)=>a.version-b.version).filter(m=>m.version>version&&m.version<=current)){
      db.exec('BEGIN IMMEDIATE');
      try{m.up(db);db.exec('PRAGMA user_version='+m.version);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    }
  }finally{db.close();}
  return {version:read(),created:false,backup};
}

// Operator-only: replace the project database with a verified backup while PMA is closed (caller holds
// the instance lock). The AI ledger is not touched, so spending never goes down; pairing codes are revoked.
export function restoreBackup(paths,id,{freeBytes}={}){
  const dir=path.join(paths.backups,id),manifestFile=path.join(dir,'manifest.json');
  if(id.includes('/')||id.includes('\\')||id.endsWith('.partial')||!fs.existsSync(manifestFile))throw new AppError('Резервная копия не найдена или не завершена',404);
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),source=path.join(dir,'pma.sqlite');
  if(sha256File(source)!==manifest.database.sha256)throw new AppError('Резервная копия повреждена: контрольная сумма базы не совпала',409);
  if(manifest.schemaVersion>SCHEMA_VERSION)throw new AppError('Резервная копия от более новой версии PMA',409);
  for(const f of manifest.files){const full=path.join(paths.data,f.path);if(!fs.existsSync(full)||sha256File(full)!==f.sha256)throw new AppError('Файл из резервной копии отсутствует или изменён: '+f.path+'. Восстановление остановлено.',409);}
  const safety=fs.existsSync(path.join(paths.data,'pma.sqlite'))?createBackup(paths,{reason:'before restore of '+id,freeBytes}):null;
  const file=path.join(paths.data,'pma.sqlite');
  for(const extra of ['-wal','-shm'])fs.rmSync(file+extra,{force:true});
  fs.copyFileSync(source,file);
  const db=new DatabaseSync(file);
  try{db.exec("DELETE FROM documents WHERE kind='pairing'");}finally{db.close();}
  return {restored:id,safety:safety?.id||null};
}
