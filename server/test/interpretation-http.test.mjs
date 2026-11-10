import test from 'node:test';
import assert from 'node:assert/strict';
import {httpFixture} from './support/http-fixture.mjs';
import {vision,preparedResponse,catalog,waitInterpretation} from './support/interpretation-fixture.mjs';
import {PinterestAccessError} from '../pinterest-access.mjs';

test('HTTP preparation does not search; confirmation preserves the original brief and uses the edited query',async t=>{
  let calls=0;const f=await httpFixture(t,{interpretationOptions:{catalog,invoke:async()=>{calls++;return {response:preparedResponse()};}}}),a=f.client();await a.login('a');let searches=0,actualQuery;
  f.pinterest.collect=async(_c,brief)=>{searches++;actualQuery=brief.interpretation;throw new PinterestAccessError({kind:'login',message:'Test login stop'});};
  const input={projectId:'project-a',query:vision,mode:'text',uploadIds:[],notes:''};
  const first=await a.request('/api/interpretations','POST',input);assert.equal(first.status,202);const ready=await waitInterpretation(a,first.body.id);assert.equal(ready.status,'ready');assert.equal(searches,0);assert.equal(f.store.list('run').length,2);
  const reused=await a.request('/api/interpretations','POST',input);assert.equal(reused.status,200);assert.equal(reused.body.id,ready.id);assert.equal(calls,1);
  const saved=await a.request('/api/projects/project-a/interpretations');assert.equal(saved.status,200);assert.equal(saved.body[0].id,ready.id);assert.equal(saved.body[0].input.query,vision);
  assert.equal((await a.request('/api/runs','POST',{...input,entryKind:'vision',interpretation:'Edited'})).status,409);
  assert.equal((await a.request('/api/runs','POST',{...input,query:'Changed description',entryKind:'vision',interpretation:'Edited',briefInterpretationId:ready.id})).status,409);
  const started=await a.request('/api/runs','POST',{...input,entryKind:'vision',interpretation:'камерный двор зелень тень',briefInterpretationId:ready.id});assert.equal(started.status,202);assert.equal(started.body.query,vision);assert.equal(started.body.briefPreparation.id,ready.id);assert.equal(started.body.interpretation,'камерный двор зелень тень');assert.equal(searches,1);assert.equal(actualQuery,started.body.interpretation);
});

test('a foreign preparation cannot be read, cancelled or attached to another owner, project or upload',async t=>{
  let calls=0;const f=await httpFixture(t,{interpretationOptions:{catalog,invoke:async()=>{calls++;return {response:preparedResponse()};}}}),a=f.client(),b=f.client();await a.login('a');
  assert.equal((await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision,uploadIds:[f.owners.b.uploadId]})).status,403);
  const first=(await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision})).body;await waitInterpretation(a,first.id);await b.login('b');
  assert.equal((await b.request('/api/interpretations/'+first.id)).status,403);assert.equal((await b.request('/api/interpretations/'+first.id+'/cancel','POST',{})).status,403);assert.equal((await b.request('/api/interpretations','POST',{projectId:'project-a',query:vision})).status,403);
  assert.equal((await b.request('/api/projects/project-a/interpretations')).status,403);assert.deepEqual((await b.request('/api/projects/project-b/interpretations')).body,[]);
  assert.equal((await b.request('/api/runs','POST',{projectId:'project-b',query:vision,interpretation:'Test',entryKind:'vision',briefInterpretationId:first.id})).status,403);assert.equal(calls,1);
});

test('locking or switching aborts the in-flight preparation and cannot publish a late result to B',async t=>{
  let began;const started=new Promise(resolve=>{began=resolve;});const f=await httpFixture(t,{interpretationOptions:{catalog,invoke:async({signal})=>{began();await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});return {response:preparedResponse()};}}}),a=f.client();await a.login('a');
  const first=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});await started;await f.client().login('b');
  const record=f.store.get('interpretation',first.body.id);assert.equal(record.status,'cancelled');assert.equal(record.callCount,1);assert.equal(record.result,undefined);assert.equal(record.connectionId,'a');assert.equal(f.store.list('ai-reservation').filter(r=>r.slot==='interpretation:'+record.id).length,1);
});

test('a clarification blocks launch until a new confirmed version incorporates the answer',async t=>{
  const f=await httpFixture(t,{interpretationOptions:{catalog,invoke:async({prompt})=>({response:preparedResponse({clarification:prompt.includes('"answer":"Небольшой двор"')?'':'Какой масштаб пространства?'})})}}),a=f.client();await a.login('a');const input={projectId:'project-a',query:vision,notes:''};
  const first=(await a.request('/api/interpretations','POST',input)).body;await waitInterpretation(a,first.id);
  assert.equal((await a.request('/api/runs','POST',{...input,entryKind:'vision',interpretation:'Test',briefInterpretationId:first.id})).status,409);
  const second=(await a.request('/api/interpretations','POST',{...input,answer:'Небольшой двор'})).body,ready=await waitInterpretation(a,second.id);assert.notEqual(second.id,first.id);assert.equal(ready.result.clarification,'');assert.equal(f.store.list('ai-reservation').length,2);
});

test('pin links and an explicit ready query never consume interpretation inference',async t=>{
  const f=await httpFixture(t,{interpretationOptions:{catalog:async()=>assert.fail('no inference for a URL')}}),a=f.client();await a.login('a');
  const direct=await a.request('/api/interpretations','POST',{projectId:'project-a',query:'https://www.pinterest.com/pin/123/'});assert.equal(direct.status,200);assert.equal(direct.body.method,'direct');assert.equal(f.store.list('ai-reservation').length,0);
  f.pinterest.collect=async()=>{throw new PinterestAccessError({kind:'login',message:'Test login stop'});};
  const run=await a.request('/api/runs','POST',{projectId:'project-a',query:'камерный двор',entryKind:'ready',interpretation:'камерный двор'});assert.equal(run.status,202);assert.equal(f.store.list('interpretation').length,1);assert.equal(f.store.list('ai-reservation').length,0);
});
