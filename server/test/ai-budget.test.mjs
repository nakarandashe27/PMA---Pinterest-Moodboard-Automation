import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../store.mjs';
import {reserveRunAI,reserveAICall} from '../ai-budget.mjs';
import {rankCandidates} from '../ranking.mjs';
import {sha256} from '../domain.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-budget-')),store=new Store(root);
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('pma-budget-'));fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'assets'));const bytes=Buffer.from([255,216,255,224]),hash=sha256(bytes),candidate={id:'c',asset:hash+'.jpg',sha256:hash,pinId:'123'};fs.writeFileSync(path.join(root,'assets',candidate.asset),bytes);
  const run={id:'run',projectId:'p',connectionId:'a',status:'ranking',query:'Test',candidates:[candidate]};store.save('run',run,'p');
  const ai={status:'running',callCount:1,startedAt:new Date().toISOString()};return {root,store,run,candidate,ai};
}
test('concurrent inferences from the same stale run reserve a single call before invocation',async t=>{
  const f=fixture(t);let invoked=0;
  const attempt=()=>rankCandidates({root:f.root,run:f.run,candidates:[f.candidate],uploads:[],signal:new AbortController().signal,catalog:async()=>[{id:'test-sol'}],onStart:ai=>reserveRunAI(f.store,f.run,ai),onUsage:async()=>{},invoke:async()=>{invoked++;assert.equal(f.store.list('ai-reservation').length,1);throw Error('Test inference failed');}});
  const results=await Promise.allSettled([attempt(),attempt()]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(invoked,1);assert.equal(f.store.list('ai-reservation').length,1);
});
test('a shared monthly cap covers different owners, replacement calls and unknown work across restart',t=>{
  const f=fixture(t),other={id:'other',projectId:'q',connectionId:'b'},now=new Date('2026-11-05T10:00:00Z');
  reserveAICall(f.store,f.run,'search:one',{limit:2,now});reserveAICall(f.store,other,'replacement:two',{limit:2,now});
  const reopened=new Store(f.root);try{
    assert.throws(()=>reserveAICall(reopened,other,'search:three',{limit:2,now}),/месячный/);
    assert.throws(()=>reserveAICall(reopened,f.run,'search:one',{limit:20,now}),/уже использован/);
    assert.equal(reopened.list('ai-reservation').length,2);
  }finally{reopened.close();}
});
test('cancellation before reservation spends nothing; cancellation and errors after reservation never refund',t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();
  assert.throws(()=>reserveRunAI(f.store,f.run,f.ai,{signal:controller.signal}));assert.equal(f.store.list('ai-reservation').length,0);
  reserveRunAI(f.store,f.run,f.ai,{limit:1});f.store.save('run',{...f.store.get('run','run'),ai:{...f.ai,status:'cancelled'}},'p');
  assert.throws(()=>reserveAICall(f.store,f.run,'another',{limit:1}),/месячный/);assert.equal(f.store.list('ai-reservation').length,1);
});
test('historical calls count once; inherited recommendations do not consume a second reservation',t=>{
  const f=fixture(t);f.store.save('run',{...f.run,ai:f.ai},'p');
  f.store.save('run',{...f.run,id:'child',ai:{...f.ai,inheritedFromRunId:'run'},replacement:{ai:f.ai}},'p');
  f.store.save('evaluation',{id:'legacy-eval',projectId:'p',connectionId:'a',maxCliRuns:2,createdAt:new Date().toISOString()},'p');
  reserveAICall(f.store,f.run,'new',{limit:5});assert.equal(f.store.list('ai-reservation').reduce((sum,r)=>sum+r.amount,0),5);
  assert.throws(()=>reserveAICall(f.store,f.run,'over',{limit:5}),/месячный/);assert.equal(f.store.list('ai-reservation').reduce((sum,r)=>sum+r.amount,0),5);
});
test('rolling into another Moscow calendar month opens a new finite pool without resetting step reservations',t=>{
  const f=fixture(t);reserveAICall(f.store,f.run,'old',{limit:1,now:new Date('2026-11-30T20:59:59Z')});
  assert.throws(()=>reserveAICall(f.store,f.run,'too-early',{limit:1,now:new Date('2026-11-30T20:59:59Z')}),/месячный/);
  reserveAICall(f.store,f.run,'new',{limit:1,now:new Date('2026-11-30T21:00:00Z')});
  assert.throws(()=>reserveAICall(f.store,f.run,'old',{limit:3,now:new Date('2026-12-01T10:00:00Z')}),/уже использован/);
  assert.deepEqual(f.store.list('ai-reservation').map(r=>r.month).sort(),['2026-11','2026-12']);
});
test('a failed atomic save rolls back its reservation and invalid limits stop before accounting',t=>{
  const f=fixture(t);assert.throws(()=>reserveAICall(f.store,f.run,'failed',{save:()=>{throw Error('failed save');}}),/failed save/);assert.equal(f.store.list('ai-reservation').length,0);
  for(const limit of [0,-1,Infinity,NaN,1.5])assert.throws(()=>reserveAICall(f.store,f.run,'bad',{limit}),/конечный/);
});
