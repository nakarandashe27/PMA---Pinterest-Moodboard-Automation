import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pinterest} from '../pinterest.mjs';
import {PinterestAccessError} from '../pinterest-access.mjs';
import {Store} from '../store.mjs';
import {performSearch} from '../search.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-identity-')),store=new Store(root);
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('pma-identity-'));fs.rmSync(root,{recursive:true,force:true});});
  return {root,store};
}
const pin=n=>({pinId:String(n),pinUrl:'https://www.pinterest.com/pin/'+n+'/',imageUrl:'https://i.pinimg.com/474x/aa/bb/cc/'+String(n).padStart(32,'0')+'.jpg'});

for(const initial of [null,'user_b'])test((initial?'a different Pinterest identity':'missing Pinterest identity')+' pauses the worker and explicit resume preserves the same owner and selection',async t=>{
  const {root,store}=fixture(t),pinterest=new Pinterest(root),connection={id:'a',username:'user_a'};let viewer=initial,downloads=0;
  pinterest.identity=async()=>viewer;
  pinterest.collect=async c=>{await pinterest.requireIdentity(c);return [pin(1),pin(2)];};
  const existing={...pin(1),id:'existing',asset:'existing.jpg',sha256:'existing-hash'},run={id:'run',projectId:'p',connectionId:'a',sourceKind:'live',mode:'text',status:'queued',query:'Test',aiEnabled:false,candidates:[existing],selectedIds:['existing']};store.save('run',run,'p');
  const download=async(_root,p)=>{downloads++;return {...p,id:'new',asset:'new.jpg',sha256:'new-hash'};};
  await performSearch({store,pinterest,root,run,connection,uploads:[],controller:new AbortController(),download,rank:async()=>assert.fail('AI must remain off')});
  const paused=store.get('run','run');assert.equal(paused.status,'blocked');assert.equal(paused.blockReason,'login');assert.equal(paused.connectionId,'a');assert.equal(downloads,0);assert.deepEqual(paused.candidates,[existing]);assert.deepEqual(paused.selectedIds,['existing']);
  viewer='user_a';await performSearch({store,pinterest,root,run:paused,connection,uploads:[],controller:new AbortController(),download});
  const done=store.get('run','run');assert.equal(done.status,'ready');assert.equal(done.connectionId,'a');assert.equal(done.blockReason,null);assert.equal(done.candidates.length,2);assert.equal(downloads,1);assert.deepEqual(done.selectedIds,['existing']);
});

for(const switchAt of ['between-pages','during-read'])test('identity change '+switchAt+' stops collection before foreign cards can enter a checkpoint',async t=>{
  const {root}=fixture(t),client=new Pinterest(root),connection={id:'a',username:'user_a'};let viewer='user_a',reads=0,url='https://www.pinterest.com/';const checkpoints=[];
  const page={url:()=>url,setDefaultTimeout:()=>{},goto:async target=>{url=target;},locator:()=>({first:()=>({waitFor:async()=>{}})}),waitForTimeout:async()=>{},evaluate:async fn=>{
    if(fn.name!=='extractPinCards')return;
    reads++;if(switchAt==='during-read')viewer='user_b';return {candidates:[pin(viewer==='user_a'?1:2)]};
  }};
  client.page=async()=>page;client.checkAccess=async()=>{};client.identity=async()=>viewer;
  await assert.rejects(client.collect(connection,{id:'run',mode:'text',query:'Test',candidateLimit:3},[],async progress=>{checkpoints.push(progress);if(switchAt==='between-pages')viewer='user_b';},new AbortController().signal),error=>error instanceof PinterestAccessError&&error.code==='login');
  assert.equal(reads,1);assert.equal(client.busy,false);assert.deepEqual(checkpoints.flatMap(p=>p.pins||[]).map(p=>p.pinId),switchAt==='during-read'?[]:['1']);
});

test('restart repairs only known legacy identity failures without retrying or changing their saved data',t=>{
  const {root,store}=fixture(t);
  for(const [id,message] of [['logged-out','Нужен вход в Pinterest. Откройте подключение и войдите в браузере.'],['wrong-account','В браузере открыт другой аккаунт. Создайте для него отдельное подключение.'],['other','Не удалось загрузить изображение']])store.save('run',{id,projectId:'p',connectionId:'a',sourceKind:'live',status:'error',message,candidates:[{id:'kept'}],selectedIds:['kept']},'p');
  const reopened=new Store(root);try{reopened.recover();for(const id of ['logged-out','wrong-account']){const run=reopened.get('run',id);assert.equal(run.status,'blocked');assert.equal(run.blockReason,'login');assert.equal(run.connectionId,'a');assert.deepEqual(run.candidates,[{id:'kept'}]);assert.deepEqual(run.selectedIds,['kept']);}assert.equal(reopened.get('run','other').status,'error');}finally{reopened.close();}
});
