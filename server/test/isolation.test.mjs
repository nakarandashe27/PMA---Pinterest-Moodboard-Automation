import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {httpFixture} from './support/http-fixture.mjs';
import {SESSION_MS,setLocalPassword} from '../local-auth.mjs';
import {sha256} from '../domain.mjs';

test('saved active setting, connection name and identity check cannot authenticate another browser',async t=>{
  const f=await httpFixture(t),a=f.client(),anonymous=f.client();await a.login('a');
  assert.deepEqual((await anonymous.request('/api/bootstrap')).body.projects,[]);
  assert.equal((await anonymous.request('/api/active-connection','POST',{id:'a'})).status,401);
  assert.equal((await anonymous.request('/api/connections/a/check','POST',{})).status,401);
  assert.equal((await anonymous.request('/api/connections/a/open','POST',{})).status,401);
  assert.equal((await anonymous.request('/api/projects/project-a')).status,401);
  assert.equal((await anonymous.request('/api/projects','POST',{name:'Unexpected'})).status,401);
  assert.deepEqual(f.opened,[]);
  const bootstrap=(await a.request('/api/bootstrap')).body;assert.deepEqual(bootstrap.projects.map(p=>p.id),['project-a']);assert.ok(!JSON.stringify(bootstrap).includes('local-password-'));
});

test('B cannot read or modify A projects, runs, uploads, media or exports by known ID',async t=>{
  const f=await httpFixture(t),a=f.client(),b=f.client();await a.login('a');
  const exported=await a.request('/api/runs/run-a/export','POST',{});assert.equal(exported.status,201);
  await b.login('b');
  for(const [route,method,data] of [
    ['/api/projects/project-a','GET'],['/api/runs/run-a/selection','PUT',{ids:[]}],['/api/runs/run-a/resume','POST',{}],['/api/runs/run-a/replacements','POST',{}],['/api/runs/run-a/cancel','POST',{}],['/api/runs/run-a/export','POST',{}],
    ['/api/exports/'+exported.body.id,'GET'],['/api/exports/'+exported.body.id+'/figma-code','POST',{}],['/api/exports/'+exported.body.id+'/pinterest','POST',{}],['/api/connections/a/open','POST',{}],['/api/connections/a/check','POST',{}],
    ['/api/uploads','POST',{projectId:'project-a',imageBase64:'a'}],['/media/uploads/'+f.owners.a.uploadId,'GET']
  ])assert.equal((await b.request(route,method,data)).status,403,route);
  for(const method of ['GET','HEAD'])assert.equal((await b.request('/media/assets/'+f.owners.a.item.asset,method)).status,404);
  const media=await b.request('/media/assets/'+f.owners.b.item.asset);assert.equal(media.status,200);assert.equal(media.headers.get('cache-control'),'no-store');
  assert.equal((await b.request('/media/uploads/'+f.owners.b.uploadId)).status,200);
  assert.equal((await a.request('/api/projects/project-a')).status,401,'the former browser session was revoked');
  assert.deepEqual(f.store.get('run','run-a').selectedIds,['candidate-a']);assert.deepEqual(f.opened,[]);
});

test('media access follows owned snapshots and replacement pools, with no shared-cache grant',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');
  const r=await a.request('/api/runs/run-a/export','POST',{});assert.equal(r.status,201);
  f.store.save('run',{...f.owners.a.run,candidates:[],selectedIds:[]},'project-a');
  assert.equal((await a.request('/media/assets/'+f.owners.a.item.asset)).status,200,'a frozen snapshot still owns its asset');
  const b=f.client();await b.login('b');assert.equal((await b.request('/media/assets/'+f.owners.a.item.asset)).status,404);
  f.store.save('run',{...f.owners.b.run,replacement:{pool:[f.owners.a.item]}},'project-b');
  assert.equal((await b.request('/media/assets/'+f.owners.a.item.asset)).status,200,'a separately owned reference grants access to shared bytes');
});

test('G1 package is unavailable even cross-origin; unowned legacy data is quarantined',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');
  for(const method of ['GET','HEAD','OPTIONS']){
    const r=await a.request('/figma-package.json',method,undefined,{Origin:'https://example.com'});assert.equal(r.status,410);assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  assert.equal((await a.request('/api/projects/unowned')).status,403);
  assert.ok(f.store.get('project','unowned'),'retained on disk');
});

test('Figma capability expires on switch, lock, session expiry and password reset; legacy codes do not bypass it',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');
  const first=(await a.request('/api/runs/run-a/export','POST',{})).body;
  const plugin=(code,route='/api/figma/package?protocol=2',method='GET',data)=>a.request(route,method,data,{Authorization:'Bearer '+code,Origin:'null'});
  assert.equal((await plugin(first.code)).status,200);
  assert.equal((await plugin(first.code,'/api/figma/package')).status,426,'old plugin without protocol stops before reading');assert.equal((await plugin(first.code,'/api/figma/package?protocol=1')).status,426);
  const pair=f.store.get('pairing','pair-'+sha256(first.code));f.store.save('pairing',{...pair,id:'pair-'+sha256('legacy'),sessionTokenHash:undefined},pair.projectId);assert.equal((await plugin('legacy')).status,401);
  await f.client().login('b');assert.equal((await plugin(first.code)).status,401);
  await a.login('a');assert.equal((await plugin(first.code)).status,401);
  const second=(await a.request('/api/exports/'+first.id+'/figma-code','POST',{})).body;
  assert.equal((await plugin(second.code)).status,200);assert.equal(second.attemptId,first.attemptId);
  await a.request('/api/active-connection','POST',{id:null});assert.equal((await plugin(second.code)).status,401);
  await a.login('a');f.advance(SESSION_MS+1);assert.equal((await a.request('/api/projects/project-a')).status,401);assert.equal((await plugin(second.code)).status,401);
  await a.login('a');await setLocalPassword(f.store,'a','changed-password-a');assert.equal((await a.request('/api/projects/project-a')).status,401);
});

test('wrong passwords are throttled persistently and lock aborts background work without changing its owner',async t=>{
  const f=await httpFixture(t),a=f.client();await a.request('/api/bootstrap');
  for(let i=0;i<5;i++)assert.equal((await a.request('/api/active-connection','POST',{id:'a',password:'wrong'})).status,401);
  assert.equal((await a.request('/api/active-connection','POST',{id:'a',password:'test-password-a'})).status,429);
  assert.ok(f.store.get('local-credential','local-password-a').blockedUntil>Date.now());f.advance(300001);await a.login('a');
  const controller=new AbortController();controller.done=new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));f.app.jobs.set('test-running',controller);
  await a.request('/api/active-connection','POST',{id:null});assert.equal(controller.signal.aborted,true);f.app.jobs.delete('test-running');assert.equal(f.store.get('run','run-a').connectionId,'a');
});

test('evaluations and their report images enforce both project and account ownership',async t=>{
  const f=await httpFixture(t),a=f.client(),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.store.save('evaluation',{id,projectId:'project-a',connectionId:'a',status:'ready',candidates:[f.owners.a.item],sourceRunIds:['run-a']},'project-a');fs.mkdirSync(path.join(f.root,'evaluations',id),{recursive:true});fs.writeFileSync(path.join(f.root,'evaluations',id,'report.html'),'<p>Private test</p>');
  await a.login('a');assert.equal((await a.request('/evaluations/'+id)).status,200);
  await f.client().login('b');assert.equal((await f.client().request('/evaluations/'+id)).status,403);
});

test('Figma claim, checkpoint and receipt bind the same frame and available file key',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');
  const prepared=(await a.request('/api/runs/run-a/export','POST',{})).body,headers={Authorization:'Bearer '+prepared.code,Origin:'null'};
  const post=(route,data)=>a.request('/api/figma/'+route+'?protocol=2','POST',data,headers),documentId='document_1234567890',fileKey='file_original_123456';
  const claim=await post('claim',{documentId,fileKey});assert.equal(claim.status,200);const lease=claim.body.lease;
  const item=f.owners.a.item,receipt={documentId,fileKey,lease,status:'imported',frameId:'10:1',snapshotHash:prepared.selectionId.slice(10),fileName:'Test',items:[{pinId:item.pinId,pinUrl:item.pinUrl,assetSha256:item.sha256,imageNodeId:'10:2',sourceLinkNodeId:'10:3',imageHash:'a'.repeat(40)}]};
  assert.equal((await post('receipt',receipt)).status,409,'receipt requires the durable checkpoint');
  assert.equal((await post('checkpoint',{documentId,fileKey,lease,frameId:'10:1'})).status,200);
  assert.equal((await post('checkpoint',{documentId,fileKey,lease,frameId:'20:1'})).status,409);
  assert.equal((await post('receipt',{...receipt,frameId:'20:1'})).status,409);
  assert.equal((await post('receipt',{...receipt,fileKey:'file_copied_123456789'})).status,409);
  assert.equal((await post('receipt',receipt)).status,200);
  assert.equal((await post('receipt',{...receipt,status:'already-imported',lease:undefined})).status,200);
  const attempt=f.store.get('figma-attempt',prepared.attemptId);f.store.save('figma-attempt',{...attempt,state:'unknown'},attempt.projectId);
  assert.equal((await post('claim',{documentId,fileKey,frameId:'20:1'})).status,409);
  assert.equal((await post('claim',{documentId,fileKey:'file_copied_123456789',frameId:'10:1'})).status,409);
  assert.equal((await post('claim',{documentId,frameId:'10:1'})).status,409,'a known fileKey cannot be omitted');
});

test('revocation during a slow Figma request body prevents the late claim',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');const prepared=(await a.request('/api/runs/run-a/export','POST',{})).body;
  const received=new Promise(resolve=>f.app.server.once('request',resolve));
  let req;const completed=new Promise((resolve,reject)=>{
    req=http.request(f.url+'/api/figma/claim?protocol=2',{method:'POST',headers:{Authorization:'Bearer '+prepared.code,'Content-Type':'application/json',Origin:'null'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{"documentId":');
  });
  await received;await f.client().login('b');req.end('"document_1234567890"}');assert.equal(await completed,401);assert.equal(f.store.get('figma-attempt',prepared.attemptId).state,'prepared');
});

test('service restart starts locked while preserving owners and successful export evidence',async t=>{
  const f=await httpFixture(t),a=f.client();await a.login('a');const prepared=(await a.request('/api/runs/run-a/export','POST',{})).body;
  const {LocalAuth}=await import('../local-auth.mjs'),restarted=new LocalAuth(f.store);assert.equal(restarted.fromRequest({headers:{cookie:a.cookie()}}),null);assert.equal(f.store.get('project','project-a').ownerConnectionId,'a');assert.equal(f.store.get('export',prepared.id).currentAttemptId,prepared.attemptId);
});
