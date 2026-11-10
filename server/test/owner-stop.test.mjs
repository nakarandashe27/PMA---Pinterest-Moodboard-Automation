import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {httpFixture} from './support/http-fixture.mjs';
import {Store} from '../store.mjs';
import {performSearch} from '../search.mjs';
import {OwnerStop} from '../domain.mjs';

// Fake Pinterest CDN in this process only: a distinct JPEG per URL, no network.
const realFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=async(url,opts)=>{const u=new URL(String(url));if(u.hostname!=='i.pinimg.com')return realFetch(url,opts);return new Response(Buffer.concat([Buffer.from([255,216,255,224]),Buffer.from(u.pathname)]),{status:200});};});
test.after(()=>{globalThis.fetch=realFetch;});
const pins=(from,count)=>Array.from({length:count},(_,i)=>({pinId:String(from+i),pinUrl:`https://www.pinterest.com/pin/${from+i}/`,imageUrl:`https://i.pinimg.com/474x/aa/bb/cc/${(from+i).toString(16).padStart(32,'0')}.jpg`,altText:'pin'}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hang=signal=>new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
async function until(check){for(let i=0;i<300;i++){if(check())return;await sleep(10);}assert.fail('condition not reached');}

for(const [name,stop] of [
  ['lock',async f=>{await f.a.request('/api/active-connection','POST',{id:null});}],
  ['switch to B',async f=>{await f.client().login('b');}],
  ['session expiry',async f=>{f.advance(30*60*1000+1);}],
  ['service shutdown',async f=>{await f.app.shutdown();f.store.recover();}],
])test('owner stop by '+name+' keeps the live search resumable by its owner, without duplicates',async t=>{
  const f=await httpFixture(t),a=f.client();f.a=a;await a.login('a');let calls=0;
  f.pinterest.collect=async(_c,brief,_u,progress,signal)=>{calls++;if(calls===1){await progress({pins:pins(3000,12),message:'12'});return hang(signal);}assert.equal(brief.observedPins.length,12);return [...brief.observedPins,...pins(3012,20)];};
  const started=await a.request('/api/runs','POST',{projectId:'project-a',query:'pergola',entryKind:'ready'});assert.equal(started.status,202);
  const id=started.body.id;await until(()=>f.store.get('run',id).observedPins?.length===12);
  await stop(f);await until(()=>!['queued','searching','downloading'].includes(f.store.get('run',id).status));
  const stopped=f.store.get('run',id);assert.equal(stopped.status,'interrupted');assert.equal(stopped.connectionId,'a');assert.equal(stopped.observedPins.length,12);
  if(name==='service shutdown')return; // A restarted service resumes through the same route; the fixture server is closed here.
  const again=f.client();await again.login('a');
  assert.equal((await again.request('/api/runs/'+id+'/resume','POST',{})).status,202);
  await until(()=>f.store.get('run',id).status==='ready');const done=f.store.get('run',id);
  assert.equal(done.candidates.length,25);assert.equal(new Set(done.candidates.map(c=>c.pinId)).size,25);
});

test('an explicit user cancel stays cancelled and is not offered as resumable',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');
  f.pinterest.collect=async(_c,_b,_u,progress,signal)=>{await progress({pins:pins(4000,3),message:'3'});return hang(signal);};
  const id=(await a.request('/api/runs','POST',{projectId:'project-a',query:'deck',entryKind:'ready'})).body.id;
  await until(()=>f.store.get('run',id).observedPins);assert.equal((await a.request('/api/runs/'+id+'/cancel','POST',{})).status,200);
  await until(()=>f.store.get('run',id).status==='cancelled');assert.equal((await a.request('/api/runs/'+id+'/resume','POST',{})).status,409);
});

test('an owner stop during AI ranking marks the result unknown and resume sends no second model call',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pma-owner-stop-'));const store=new Store(directory);
  t.after(()=>{store.close();assert.ok(path.basename(directory).startsWith('pma-owner-stop-'));fs.rmSync(directory,{recursive:true,force:true});});
  const run={id:'run',projectId:'project',connectionId:'account',sourceKind:'live',status:'queued',aiEnabled:true,mode:'text',candidates:[],selectedIds:[]};store.save('run',run,'project');
  const download=async(_r,pin)=>({...pin,id:'c'+pin.pinId,asset:pin.pinId+'.jpg',sha256:'h'+pin.pinId});let invoked=0;
  const controller=new AbortController();
  const rank=async({onStart,signal})=>{await onStart({status:'running',callCount:1});invoked++;controller.abort(new OwnerStop());return hang(signal);};
  await performSearch({store,root:directory,run,connection:{id:'account'},uploads:[],controller,download,pinterest:{collect:async()=>pins(5000,3)},rank});
  const stopped=store.get('run','run');assert.equal(stopped.status,'interrupted');assert.equal(stopped.ai.status,'unknown');
  await performSearch({store,root:directory,run:stopped,connection:{id:'account'},uploads:[],controller:new AbortController(),download,pinterest:{collect:async()=>pins(5000,3)},rank:async(args)=>{const {rankCandidates}=await import('../ranking.mjs');return rankCandidates({...args,catalog:async()=>assert.fail('model catalog must not be reached'),invoke:async()=>assert.fail('model must not be called')});}});
  const done=store.get('run','run');assert.equal(done.status,'ready');assert.equal(done.ai.status,'unknown');assert.equal(invoked,1);
  assert.equal(store.list('ai-reservation').length,1);
});

test('a lock during a replacement search keeps that replacement resumable and the source board intact',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');let calls=0;
  f.pinterest.collect=async(_c,_b,_u,progress,signal)=>{calls++;if(calls===1){await progress({pins:pins(7000,4),message:'4'});return hang(signal);}return pins(7000,6);};
  const source=f.owners.a.run;
  const started=await a.request('/api/runs/'+source.id+'/replacements','POST',{revision:0,targetIds:[f.owners.a.item.id],reason:'Другое настроение',searchQuery:'shade garden',aiEnabled:false});assert.equal(started.status,202);
  const id=started.body.id;await until(()=>f.store.get('run',id).replacement.source?.pins?.length===4);
  await a.request('/api/active-connection','POST',{id:null});await until(()=>f.store.get('run',id).status!=='searching');
  const stopped=f.store.get('run',id);assert.equal(stopped.status,'interrupted');assert.equal(stopped.replacement.status,'pending');
  const again=f.client();await again.login('a');assert.equal((await again.request('/api/runs/'+id+'/resume','POST',{})).status,202);
  await until(()=>f.store.get('run',id).status==='ready');assert.equal(f.store.get('run',id).replacement.status,'review');
  assert.deepEqual(f.store.get('run',source.id).candidates,source.candidates);
});
