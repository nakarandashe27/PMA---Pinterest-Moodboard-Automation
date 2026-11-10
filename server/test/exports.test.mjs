import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../store.mjs';
import {sha256} from '../domain.mjs';
import {prepareExport,exportView,createFigmaAttempt,claimFigma,recordFigmaReceipt,pinterestBoardName} from '../exports.mjs';
import {performPinterestExport,recoverRejectedBoardName} from '../export-pinterest.mjs';
import {ensureExportBoard} from '../pinterest-export-ui.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-exports-')),store=new Store(root);fs.mkdirSync(path.join(root,'assets'));
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('pma-exports-'));fs.rmSync(root,{recursive:true,force:true});});
  const items=[1,2,3].map(n=>{const bytes=Buffer.from([255,216,255,224,n]),hash=sha256(bytes),asset=hash+'.jpg';fs.writeFileSync(path.join(root,'assets',asset),bytes);return {id:'c'+n,pinId:String(n),pinUrl:'https://www.pinterest.com/pin/'+n+'/',imageUrl:'https://i.pinimg.com/1200x/a/b/c/'+String(n).padStart(32,'0')+'.jpg',asset,sha256:hash,altText:'Сад'};});
  const run={id:'r',projectId:'p',connectionId:'a',status:'ready',candidates:items,selectedIds:['c1','c2'],query:'Сад',title:'Сад'},project={id:'p',name:'Сад',ownerConnectionId:'a'},connection={id:'a',username:'owner'};
  store.save('run',run,'p');store.save('project',project);
  return {root,store,items,run,project,connection,prepare:()=>prepareExport(store,root,run,project)};
}
function remote(f,options={}){
  const saved=[],counts={creates:0,saves:0,reads:0};let exists=options.exists||false;
  const board={url:'https://www.pinterest.com/owner/garden/',name:'Сад',secret:true,username:'owner'};
  const add=pin=>saved.push({...pin,pinId:String(1000+Number(pin.pinId)),pinUrl:'https://www.pinterest.com/pin/'+(1000+Number(pin.pinId))+'/',imageUrl:pin.imageUrl.replace('/1200x/','/474x/')});
  const pinterest={
    ensureExportBoard:async(_c,expected,first,args)=>{
      if(!exists){if(args.readOnly)throw Error('Board not found');await args.beforeCreate();counts.creates++;exists=true;add(first);if(options.failCreate)throw Error('Timeout after board creation');}
      return {...board,...options.board};
    },
    readExportBoard:async()=>{counts.reads++;return {board:{...board,...options.board},pins:[...saved],complete:options.complete!==false};},
    saveExportPin:async(_c,_b,pin,args)=>{await args.beforeWrite();counts.saves++;if(options.failBeforeAdd)throw Error('Unknown before readback');add(pin);if(options.cancel)options.cancel.abort();if(options.failSave)throw Error('Timeout after save');}
  };
  return {pinterest,saved,counts,options};
}
async function setup(f){const prepared=await f.prepare(),exp=f.store.get('export',prepared.id),snapshot=f.store.get('selection',exp.selectionId),record=f.store.get('pinterest-export','pinterest-'+exp.selectionId);return {prepared,exp,snapshot,record};}
const work=(f,s,r,extra={})=>performPinterestExport({...f,record:s.record,pinterest:r.pinterest,controller:new AbortController(),...extra});
function evidence(f,s,attempt){return {status:'imported',documentId:attempt.documentId,snapshotHash:attempt.snapshotHash,frameId:'10:1',fileName:'PMA',items:s.snapshot.items.map((p,i)=>({pinId:p.pinId,pinUrl:p.pinUrl,assetSha256:p.sha256,imageNodeId:'10:'+(i+2),sourceLinkNodeId:'10:'+(i+20),imageHash:'a'.repeat(40)}))};}
function checkpoint(f,id){const a=f.store.get('figma-attempt',id),next={...a,frameId:'10:1'};f.store.save('figma-attempt',next,a.projectId);return next;}

test('both targets share a frozen selection and concurrent preparation reuses one Figma attempt',async t=>{
  const f=fixture(t),[a,b]=await Promise.all([f.prepare(),f.prepare()]);assert.equal(a.id,b.id);assert.equal(a.attemptId,b.attemptId);assert.notEqual(a.code,b.code);
  const exp=f.store.get('export',a.id),snapshot=f.store.get('selection',exp.selectionId);assert.deepEqual(snapshot.items.map(p=>p.pinId),['1','2']);
  f.store.save('run',{...f.run,selectedIds:['c3']},'p');assert.deepEqual(f.store.get('selection',exp.selectionId),snapshot);assert.equal(f.store.list('figma-attempt').length,1);
  const pair=f.store.get('pairing','pair-'+sha256(a.code)),payload=JSON.parse(fs.readFileSync(pair.packagePath,'utf8'));assert.equal(payload.pmaPackageVersion,2);assert.equal(payload.snapshotId,exp.selectionId);assert.deepEqual(payload.pins.map(p=>p.assetSha256),snapshot.items.map(p=>p.sha256));
});

test('asset corruption is rejected before either target can be prepared',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'assets',f.items[0].asset),'changed');await assert.rejects(f.prepare(),/изменилось/);assert.equal(f.store.list('export').length,0);assert.equal(f.store.list('pinterest-export').length,0);
});

test('Figma claims are exclusive and receipts must match every source and asset',async t=>{
  const f=fixture(t),s=await setup(f),initial=f.store.get('figma-attempt',s.exp.currentAttemptId),{lease}=claimFigma(f.store,initial,{documentId:'document_1234567890'}),attempt=checkpoint(f,initial.id);
  assert.throws(()=>claimFigma(f.store,attempt,{documentId:attempt.documentId,frameId:attempt.frameId}),/выполняется/);assert.throws(()=>claimFigma(f.store,attempt,{documentId:'other_document_123456'}),/другим/);
  const valid={...evidence(f,s,attempt),lease};assert.throws(()=>recordFigmaReceipt(f.store,attempt,s.snapshot,{...valid,items:valid.items.slice(1)}),/полного/);
  assert.throws(()=>recordFigmaReceipt(f.store,attempt,s.snapshot,{...valid,items:valid.items.map((p,i)=>i?{...p,assetSha256:'0'.repeat(64)}:p)}),/не совпал/);
  const done=recordFigmaReceipt(f.store,attempt,s.snapshot,valid);assert.equal(done.state,'imported');assert.equal(exportView(f.store,s.exp).pinterest.state,'prepared');
  const replay=recordFigmaReceipt(f.store,done,s.snapshot,{...valid,status:'already-imported',lease:undefined});assert.equal(replay.receipt.frameId,done.receipt.frameId);
});

test('an unknown Figma result needs an existing frame; late receipts remain in their own attempt',async t=>{
  const f=fixture(t),s=await setup(f),first=f.store.get('figma-attempt',s.exp.currentAttemptId),{lease}=claimFigma(f.store,first,{documentId:'document_1234567890'});
  checkpoint(f,first.id);f.store.recoverExports();const unknown=f.store.get('figma-attempt',first.id);assert.equal(unknown.state,'unknown');assert.throws(()=>claimFigma(f.store,unknown,{documentId:unknown.documentId}),/сверка/);
  const next=createFigmaAttempt(f.store,f.store.get('export',s.exp.id),true);recordFigmaReceipt(f.store,unknown,s.snapshot,{...evidence(f,s,unknown),lease});
  assert.equal(f.store.get('export',s.exp.id).currentAttemptId,next.id);assert.equal(f.store.get('figma-attempt',next.id).state,'prepared');assert.equal(f.store.get('figma-attempt',first.id).state,'imported');
});

test('a later manual conflict preserves the historical successful receipt',async t=>{
  const f=fixture(t),s=await setup(f),first=f.store.get('figma-attempt',s.exp.currentAttemptId),{lease}=claimFigma(f.store,first,{documentId:'document_1234567890'}),a=checkpoint(f,first.id);
  const done=recordFigmaReceipt(f.store,a,s.snapshot,{...evidence(f,s,a),lease});const conflict=recordFigmaReceipt(f.store,done,s.snapshot,{status:'conflict',documentId:a.documentId,message:'Ручная правка'});assert.equal(conflict.state,'imported');assert.deepEqual(conflict.receipt,done.receipt);assert.equal(conflict.verificationConflict,'Ручная правка');
});

test('Pinterest creation saves the seed once and subsequent retries only read back verified pins',async t=>{
  const f=fixture(t),s=await setup(f),r=remote(f);await work(f,s,r);let result=f.store.get('pinterest-export',s.record.id);assert.equal(result.state,'succeeded');assert.equal(r.counts.creates,1);assert.equal(r.counts.saves,1);assert.ok(result.items.every(i=>i.savedPinId!==i.sourcePinId));
  const before={...r.counts};await work(f,s,r);assert.equal(r.counts.creates,before.creates);assert.equal(r.counts.saves,before.saves);assert.equal(f.store.get('figma-attempt',s.exp.currentAttemptId).state,'prepared');
});

test('timeout after save is reconciled without writing the same pin again',async t=>{
  const f=fixture(t),s=await setup(f),r=remote(f,{failSave:true});await work(f,s,r);assert.equal(f.store.get('pinterest-export',s.record.id).state,'unknown');assert.equal(r.counts.saves,1);
  await work(f,s,r,{reconcileOnly:true});assert.equal(f.store.get('pinterest-export',s.record.id).state,'succeeded');assert.equal(r.counts.saves,1);
});

test('delayed board hydration retries only readback and never repeats the save',async t=>{
  for(const complete of [false,true])await t.test(complete?'stale complete view':'incomplete view',async t=>{
    const f=fixture(t),s=await setup(f),r=remote(f),read=r.pinterest.readExportBoard;
    r.pinterest.readExportBoard=async(...args)=>{const result=await read(...args);return r.counts.reads===3?{...result,complete,pins:result.pins.slice(0,-1)}:result;};
    await work(f,s,r);assert.equal(f.store.get('pinterest-export',s.record.id).state,'succeeded');assert.equal(r.counts.creates,1);assert.equal(r.counts.saves,1);assert.equal(r.counts.reads,4);
  });
});

test('unknown absent pins remain blocked even when a normal save is requested again',async t=>{
  const f=fixture(t),s=await setup(f),r=remote(f,{failBeforeAdd:true});await work(f,s,r);await work(f,s,r,{reconcileOnly:true});await work(f,s,r);
  assert.equal(r.counts.saves,1);assert.equal(f.store.get('pinterest-export',s.record.id).state,'unknown');
});

test('timeout after board creation recovers the board and seed without another create',async t=>{
  const f=fixture(t),s=await setup(f),r=remote(f,{failCreate:true});await work(f,s,r);assert.equal(f.store.get('board','board-p').state,'unknown');await work(f,s,r);assert.equal(r.counts.creates,1);assert.equal(r.counts.saves,1);assert.equal(f.store.get('pinterest-export',s.record.id).state,'succeeded');
});

test('a public or foreign board is rejected before any ordinary pin save',async t=>{
  for(const board of [{secret:false},{username:'other',url:'https://www.pinterest.com/other/garden/'}]){
    const f=fixture(t),s=await setup(f),r=remote(f,{board,exists:true});await work(f,s,r);assert.equal(r.counts.creates,0);assert.equal(r.counts.saves,0);assert.notEqual(f.store.get('pinterest-export',s.record.id).state,'succeeded');
  }
});

test('incomplete board readback and manual removal never trigger a repair save',async t=>{
  const f=fixture(t),s=await setup(f),r=remote(f);await work(f,s,r);const saves=r.counts.saves;r.saved.pop();await work(f,s,r);assert.equal(r.counts.saves,saves);assert.match(f.store.get('pinterest-export',s.record.id).message,/отсутствует/);
  r.options.complete=false;await work(f,s,r);assert.equal(r.counts.saves,saves);assert.match(f.store.get('pinterest-export',s.record.id).message,/не завершена/);
});

test('asset changes after preparation and a different account stop before board access',async t=>{
  const f=fixture(t),s=await setup(f),r=remote(f);await work(f,s,r,{connection:{id:'different',username:'other'}});assert.equal(r.counts.creates,0);
  fs.writeFileSync(path.join(f.root,'assets',f.items[0].asset),'changed');await work(f,s,r);assert.equal(r.counts.creates,0);assert.equal(r.counts.saves,0);
});

test('generated board names include the project suffix within 50 UTF-16 units, including Cyrillic and emoji',()=>{
  for(const name of ['общественный сад прямоугольные формы','a'.repeat(200),'🌱'.repeat(100),'Японский сад','Очень длинный проект с пробелами '.repeat(15)]){
    const result=pinterestBoardName({id:'2519132e-1234',name});assert.ok(result.length<=50);assert.ok(result.startsWith('PMA · '));assert.ok(result.endsWith(' · 251913'));assert.equal(result.isWellFormed(),true);
  }
});

test('overlong board names fail before any browser access or write reservation',async()=>{
  let accessed=0,reserved=0;await assert.rejects(ensureExportBoard({page:async()=>{accessed++;throw Error('not expected');}},{id:'a'},{name:'x'.repeat(51),url:null},null,{signal:new AbortController().signal,readOnly:false,beforeCreate:()=>{reserved++;}}),/50 символов/);assert.equal(accessed,0);assert.equal(reserved,0);
});

function legacyRejectedName(f,s,name='x'.repeat(51)){
  const board=f.store.get('board','board-p'),first=s.snapshot.items[0],id='save-'+sha256(JSON.stringify({boardId:board.id,pinId:first.pinId,sha256:first.sha256}));
  f.store.save('board',{...board,name,state:'unknown',creationStartedAt:new Date().toISOString()},'p');
  f.store.save('pin-save',{id,boardId:board.id,projectId:'p',connectionId:'a',sourcePinId:first.pinId,assetSha256:first.sha256,state:'unknown'},'p');
  const record={...s.record,state:'unknown',items:s.record.items.map((item,index)=>({...item,state:index?'pending':'unknown'}))};f.store.save('pinterest-export',record,'p');
  return {record,id,evidence:{code:'board-name-too-long',confirmedNotCreated:true,oldName:name,source:'user-screenshot',sha256:'a'.repeat(64)}};
}
test('a proved name-validation rejection is repaired with immutable evidence, preserving all other targets',async t=>{
  const f=fixture(t),s=await setup(f),legacy=legacyRejectedName(f,s),figma=f.store.get('figma-attempt',s.exp.currentAttemptId);
  const board=recoverRejectedBoardName(f.store,legacy.record,legacy.evidence);assert.ok(board.name.length<=50);assert.equal(board.state,'unbound');assert.equal(f.store.get('pin-save',legacy.id).state,'rejected');
  assert.ok(f.store.get('pinterest-export',s.record.id).items.every(i=>i.state==='pending'));assert.deepEqual(f.store.get('figma-attempt',s.exp.currentAttemptId),figma);
  const audit=f.store.list('export-recovery')[0];assert.equal(audit.evidence.sha256,legacy.evidence.sha256);assert.throws(()=>f.store.save('export-recovery',audit,'p'),/immutable/);
});
test('ordinary unknown results, missing proof and bound boards cannot be reset by name repair',async t=>{
  const f=fixture(t),s=await setup(f),legacy=legacyRejectedName(f,s,'Обычное допустимое имя');assert.throws(()=>recoverRejectedBoardName(f.store,legacy.record,legacy.evidence),/Неопределённый/);
  const overlong=legacyRejectedName(f,s);assert.throws(()=>recoverRejectedBoardName(f.store,overlong.record,{...overlong.evidence,confirmedNotCreated:false}),/Неопределённый/);assert.throws(()=>recoverRejectedBoardName(f.store,overlong.record,{...overlong.evidence,sha256:''}),/Неопределённый/);
  f.store.save('board',{...f.store.get('board','board-p'),url:'https://www.pinterest.com/owner/existing/'},'p');assert.throws(()=>recoverRejectedBoardName(f.store,overlong.record,overlong.evidence),/Неопределённый/);assert.equal(f.store.list('export-recovery').length,0);
});
