// Operator tool for the desktop data root. Runs only while PMA is closed (takes the same instance lock).
//   node scripts/pma-data.mjs status | backup | list | restore <backup-id>
// Restore replaces only the project database; the AI ledger is never rolled back.
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {resolveRoot,layout,ensureLayout,acquireInstanceLock,createBackup,listBackups,restoreBackup,diskStatus,SCHEMA_VERSION} from '../server/data-root.mjs';

const [command,arg]=process.argv.slice(2),paths=layout(resolveRoot());
const mb=n=>Math.round(n/1048576)+' МБ';
if(!['status','backup','list','restore'].includes(command)){console.log('Команды: status | backup | list | restore <id>');process.exit(2);}
let lock;
// Open PMA (or another operator run) holds the lock: say so plainly, without a stack trace.
try{ensureLayout(paths);lock=acquireInstanceLock(paths.root);}catch(error){console.error(error.message);process.exit(1);}
try{
  if(command==='status'){
    const disk=diskStatus(paths),file=path.join(paths.data,'pma.sqlite');let version='нет базы';
    try{const db=new DatabaseSync(file,{readOnly:true});version=db.prepare('PRAGMA user_version').get().user_version;db.close();}catch{}
    console.log(`Папка: ${paths.root}\nСхема данных: ${version} (эта версия PMA: ${SCHEMA_VERSION})\nДанные: ${mb(disk.dataBytes)}\nСвободно на диске: ${mb(disk.freeBytes)}\nРезервных копий: ${listBackups(paths).length}`);
  }
  if(command==='backup')console.log('Готово: '+createBackup(paths,{reason:'manual'}).id);
  if(command==='list')for(const id of listBackups(paths))console.log(id);
  if(command==='restore'){
    if(!arg)throw Error('Укажите id копии (node scripts/pma-data.mjs list)');
    const r=restoreBackup(paths,arg);console.log('Восстановлено: '+r.restored+(r.safety?'. Предыдущее состояние сохранено как '+r.safety:''));
  }
}catch(error){console.error(error.message);process.exitCode=1;}
finally{lock.release();}
