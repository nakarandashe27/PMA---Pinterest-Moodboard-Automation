import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store.mjs';
import {Ledger} from '../ledger.mjs';
import {reserveAICall} from '../ai-budget.mjs';
import {sha256} from '../domain.mjs';
import {layout,ensureLayout,acquireInstanceLock,prepareSchema,createBackup,listBackups,restoreBackup,SCHEMA_VERSION} from '../data-root.mjs';

function rootFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-data-test-')),paths=ensureLayout(layout(root));
  t.after(()=>{assert.ok(path.basename(root).startsWith('pma-data-test-'));fs.rmSync(root,{recursive:true,force:true});});
  return paths;
}
// Prototype-shaped (v0) data with owners, an asset, a paused run, an unknown Figma attempt and a verified receipt.
function seedPrototype(paths){
  const store=new Store(paths.data),bytes=Buffer.from([255,216,255,224,1,2,3]),hash=sha256(bytes);
  fs.mkdirSync(path.join(paths.data,'assets'),{recursive:true});fs.writeFileSync(path.join(paths.data,'assets',hash+'.jpg'),bytes);
  store.save('connection',{id:'a',label:'A',username:'user_a',status:'ready'});
  store.save('project',{id:'p',name:'Private A',ownerConnectionId:'a'});
  store.save('run',{id:'r',projectId:'p',connectionId:'a',status:'blocked',blockReason:'captcha',candidates:[{id:'c',pinId:'1',asset:hash+'.jpg',sha256:hash}],selectedIds:['c']},'p');
  store.save('selection',{id:'s',projectId:'p',connectionId:'a',runId:'r',items:[{id:'c',pinId:'1',sha256:hash}]},'p');
  store.save('figma-attempt',{id:'f',exportId:'e',selectionId:'s',projectId:'p',connectionId:'a',snapshotHash:'x',state:'unknown'},'p');
  store.save('pin-save',{id:'ps',boardId:'b',projectId:'p',connectionId:'a',sourcePinId:'1',assetSha256:hash,state:'verified',savedPinId:'99'},'p');
  store.save('pairing',{id:'pair-x',exportId:'e',attemptId:'f',projectId:'p',connectionId:'a',packagePath:'x',expiresAt:Date.now()+60000},'p');
  store.close();return hash;
}
const userVersion=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}};
const fileHash=file=>sha256(fs.readFileSync(file));

test('D3: the data lock is exclusive across processes and released by the OS when its holder dies',async t=>{
  const paths=rootFixture(t),lock=acquireInstanceLock(paths.root);
  assert.throws(()=>acquireInstanceLock(paths.root),/уже открыта/);
  const script=`import {acquireInstanceLock} from ${JSON.stringify(new URL('../data-root.mjs',import.meta.url).href)};try{acquireInstanceLock(process.argv[1]);console.log('got');}catch(e){console.log('busy');}`;
  const run=(code,args=[])=>new Promise(resolve=>{const p=spawn(process.execPath,['--input-type=module','-e',code,...args]);let out='';p.stdout.on('data',d=>out+=d);p.on('exit',()=>resolve(out.trim()));});
  assert.equal(await run(script,[paths.root]),'busy','second process is refused');
  lock.release();
  // A holder that crashes without releasing: the next process still gets the lock, no manual cleanup.
  const holder=spawn(process.execPath,['--input-type=module','-e',`import {acquireInstanceLock} from ${JSON.stringify(new URL('../data-root.mjs',import.meta.url).href)};globalThis.held=acquireInstanceLock(process.argv[1]);console.log('held');setInterval(()=>{},1000);`,paths.root]);
  await new Promise(resolve=>holder.stdout.once('data',resolve));
  assert.equal(await run(script,[paths.root]),'busy');
  holder.kill('SIGKILL');await new Promise(resolve=>holder.once('exit',resolve));
  assert.equal(await run(script,[paths.root]),'got');
});

test('D18: prototype data is backed up, then versioned; owners, snapshots, receipts and files survive',t=>{
  const paths=rootFixture(t),hash=seedPrototype(paths),file=path.join(paths.data,'pma.sqlite');
  assert.equal(userVersion(file),0);
  const result=prepareSchema(paths);assert.equal(result.version,SCHEMA_VERSION);assert.ok(result.backup);
  const manifest=JSON.parse(fs.readFileSync(path.join(paths.backups,result.backup.id,'manifest.json'),'utf8'));
  assert.equal(manifest.schemaVersion,0);assert.deepEqual(manifest.files.map(f=>f.path),['assets/'+hash+'.jpg']);assert.equal(manifest.files[0].sha256,hash);
  const store=new Store(paths.data);
  assert.equal(store.get('project','p').ownerConnectionId,'a');assert.equal(store.get('run','r').status,'blocked');assert.equal(store.get('figma-attempt','f').state,'unknown');assert.equal(store.get('pin-save','ps').savedPinId,'99');assert.ok(store.get('selection','s'));
  store.close();
  assert.equal(prepareSchema(paths).backup,null,'repeat start: no new backup, no change');assert.equal(listBackups(paths).length,1);
});

test('D18: a newer schema is never written; a crash mid-migration keeps the old version and can be repeated',t=>{
  const paths=rootFixture(t);seedPrototype(paths);prepareSchema(paths);const file=path.join(paths.data,'pma.sqlite');
  // Downgrade: data from a future PMA.
  const db=new DatabaseSync(file);db.exec('PRAGMA user_version=7');db.close();const before=fileHash(file);
  assert.throws(()=>prepareSchema(paths),/более новой версией/);assert.equal(fileHash(file),before);
  const fix=new DatabaseSync(file);fix.exec('PRAGMA user_version=1');fix.close();
  // Crash inside migration 2: the transaction rolls back; the pre-migration backup is complete.
  const broken=[{version:1,up:()=>{}},{version:2,up:db=>{db.exec("UPDATE documents SET data=json_set(data,'$.name','half') WHERE id='p'");throw Error('power loss');}}];
  assert.throws(()=>prepareSchema(paths,{migrations:broken,current:2}),/power loss/);
  assert.equal(userVersion(file),1);const store=new Store(paths.data);assert.equal(store.get('project','p').name,'Private A');store.close();
  const backups=listBackups(paths);assert.equal(backups.length,2);assert.equal(fs.readdirSync(paths.backups).some(n=>n.endsWith('.partial')),false);
  const fixed=[{version:1,up:()=>{}},{version:2,up:db=>db.exec('CREATE TABLE IF NOT EXISTS extra(x)')}];
  assert.equal(prepareSchema(paths,{migrations:fixed,current:2}).version,2);
});

test('D19: no space or a failure while copying leaves no backup that looks complete and no changed data',t=>{
  const paths=rootFixture(t);seedPrototype(paths);const file=path.join(paths.data,'pma.sqlite'),before=fileHash(file);
  assert.throws(()=>prepareSchema(paths,{freeBytes:()=>1024}),/Недостаточно места/);
  assert.equal(userVersion(file),0,'not migrated without a backup');assert.equal(fileHash(file),before);assert.deepEqual(fs.readdirSync(paths.backups),[]);
  const rename=fs.renameSync;fs.renameSync=()=>{const e=Error('ENOSPC: no space left on device');e.code='ENOSPC';throw e;};
  try{assert.throws(()=>createBackup(paths,{reason:'test'}),/ENOSPC/);}finally{fs.renameSync=rename;}
  assert.deepEqual(fs.readdirSync(paths.backups),[]);assert.deepEqual(listBackups(paths),[]);
  const store=new Store(paths.data);assert.equal(store.get('run','r').status,'blocked','paused work is not cleaned up');store.close();
});

test('D17: restore brings back owners/receipts but never lowers spending; a restored pre-call record cannot call again',t=>{
  const paths=rootFixture(t);seedPrototype(paths);prepareSchema(paths);
  let store=new Store(paths.data);store.ledger=new Ledger(paths.accounting,store);
  const backup=(store.ledger.close(),store.close(),createBackup(paths,{reason:'before spending'}));
  store=new Store(paths.data);store.ledger=new Ledger(paths.accounting,store);
  const record={id:'r',projectId:'p',connectionId:'a'};
  reserveAICall(store,record,'search:r',{save:()=>store.save('run',{...store.get('run','r'),ai:{status:'running',callCount:1}},'p')});
  store.save('pin-save',{id:'ps2',boardId:'b',projectId:'p',connectionId:'a',sourcePinId:'2',assetSha256:'h',state:'verified'},'p');
  assert.equal(store.ledger.usedInMonth(store.ledger.db.prepare('SELECT month FROM reservations').get().month),1);
  store.ledger.close();store.close();
  const restored=restoreBackup(paths,backup.id);assert.ok(restored.safety);
  store=new Store(paths.data);store.ledger=new Ledger(paths.accounting,store);
  assert.equal(store.ledger.blocked,null,'project older than ledger is fine');
  assert.equal(store.get('run','r').ai,undefined,'project is back to before the call');assert.equal(store.get('pin-save','ps2'),null);assert.equal(store.get('pin-save','ps').state,'verified');
  assert.equal(store.list('pairing').length,0,'pairing codes revoked');
  assert.throws(()=>reserveAICall(store,record,'search:r'),/уже использован/,'same operation never gets a second inference');
  assert.equal(store.ledger.lastSeq(),1);
  // A failure between the reservation and the project update keeps the reservation.
  assert.throws(()=>reserveAICall(store,{id:'r2',projectId:'p',connectionId:'a'},'search:r2',{save:()=>{throw Error('crash before link');}}),/crash before link/);
  assert.throws(()=>reserveAICall(store,{id:'r2',projectId:'p',connectionId:'a'},'search:r2'),/уже использован/);
  assert.equal(store.ledger.lastSeq(),2);
  store.ledger.close();store.close();
});

test('D17: a lost, replaced or older ledger closes paid AI; no empty counter is created silently',t=>{
  const paths=rootFixture(t);seedPrototype(paths);prepareSchema(paths);
  const open=()=>{const s=new Store(paths.data);s.ledger=new Ledger(paths.accounting,s);return s;};
  let store=open();reserveAICall(store,{id:'r',projectId:'p',connectionId:'a'},'search:r');store.ledger.close();
  const ledgerFile=path.join(paths.accounting,'ledger.sqlite'),old=path.join(paths.root,'old-ledger.sqlite');
  { const db=new DatabaseSync(ledgerFile);db.exec("VACUUM INTO '"+old.replaceAll("'","''")+"'");db.close(); }
  store.ledger=new Ledger(paths.accounting,store);reserveAICall(store,{id:'r2',projectId:'p',connectionId:'a'},'search:r2');store.ledger.close();store.close();
  // Older copy of the ledger put back.
  for(const x of ['','-wal','-shm'])fs.rmSync(ledgerFile+x,{force:true});fs.copyFileSync(old,ledgerFile);
  store=open();assert.match(store.ledger.blocked,/старше/);assert.throws(()=>reserveAICall(store,{id:'r3',projectId:'p',connectionId:'a'},'search:r3'),/старше/);store.ledger.close();store.close();
  // Ledger deleted: blocked, and no new file appears.
  for(const x of ['','-wal','-shm'])fs.rmSync(ledgerFile+x,{force:true});
  store=open();assert.match(store.ledger.blocked,/не найден/);assert.equal(fs.existsSync(ledgerFile),false);store.close();
  // A different ledger (fresh file from elsewhere): blocked.
  const other=fs.mkdtempSync(path.join(os.tmpdir(),'pma-data-test-other-'));const s2=new Store(other);new Ledger(path.join(other,'acc'),s2).close();s2.close();
  fs.copyFileSync(path.join(other,'acc','ledger.sqlite'),ledgerFile);fs.rmSync(other,{recursive:true,force:true});
  store=open();assert.match(store.ledger.blocked,/заменён/);store.ledger.close();store.close();
});

test('D17/D18: restore refuses incomplete, tampered or file-missing backups',t=>{
  const paths=rootFixture(t),hash=seedPrototype(paths);prepareSchema(paths);const b=createBackup(paths,{reason:'t'});
  assert.throws(()=>restoreBackup(paths,b.id+'.partial'),/не найдена/);assert.throws(()=>restoreBackup(paths,'../x'),/не найдена/);
  const asset=path.join(paths.data,'assets',hash+'.jpg'),bytes=fs.readFileSync(asset);fs.rmSync(asset);
  assert.throws(()=>restoreBackup(paths,b.id),/отсутствует или изменён/);fs.writeFileSync(asset,bytes);
  fs.appendFileSync(path.join(paths.backups,b.id,'pma.sqlite'),'x');assert.throws(()=>restoreBackup(paths,b.id),/повреждена/);
});

test('D19: low disk space refuses new downloads/uploads/exports with a clear message; cancel and selection still work',async t=>{
  const {httpFixture}=await import('./support/http-fixture.mjs');
  let free=0;const f=await httpFixture(t,{freeSpace:()=>free}),a=f.client();await a.login('a');
  for(const [route,body] of [['/api/runs',{projectId:'project-a',query:'x',entryKind:'ready'}],['/api/uploads',{projectId:'project-a',name:'x',imageBase64:'/9j/'}],['/api/runs/run-a/export',{}],['/api/runs/run-a/resume',{}]]){
    const r=await a.request(route,'POST',body);assert.equal(r.status,507,route);assert.match(r.body.error,/не удаляет данные сама/);
  }
  assert.equal((await a.request('/api/runs/run-a/cancel','POST',{})).status,200);
  assert.equal((await a.request('/api/runs/run-a/selection','PUT',{ids:[f.owners.a.item.id],revision:0})).status,200);
  free=10*1024*1024*1024;assert.equal((await a.request('/api/runs/run-a/export','POST',{})).status,201);
});
