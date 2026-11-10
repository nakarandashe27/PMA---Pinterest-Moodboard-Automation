import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';
import { sha256 } from '../domain.mjs';
import { createReplacement,applyReplacement,discardReplacement,performReplacement,replacementAttempts } from '../replacement.mjs';
import { rankCandidates } from '../ranking.mjs';
import { PinterestAccessError } from '../pinterest-access.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-replacement-')),store=new Store(root);fs.mkdirSync(path.join(root,'assets'));
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('pma-replacement-'));fs.rmSync(root,{recursive:true,force:true});});
  const candidate=n=>{const bytes=Buffer.from([255,216,255,224,...Buffer.from(String(n))]),hash=sha256(bytes),asset=hash+'.jpg';fs.writeFileSync(path.join(root,'assets',asset),bytes);return {id:'c'+n,pinId:String(n),pinUrl:'https://www.pinterest.com/pin/'+n+'/',imageUrl:'https://i.pinimg.com/474x/'+n+'.jpg',asset,sha256:hash};};
  const candidates=[1,2,3,4].map(candidate),parent={id:'parent',projectId:'project',connectionId:'account',sourceKind:'live',status:'ready',revision:4,query:'Японский сад',interpretation:'Японский сад',title:'Японский сад',candidates,selectedIds:['c1','c3'],uploads:[],notes:'Связь сада с архитектурой',mode:'image',aiEnabled:true,ai:{status:'ready',callCount:1,recommendedIds:['c1','c2','c3']}};
  store.save('run',parent,parent.projectId);
  const data={revision:4,targetIds:['c2','c1'],reason:'Нужна древесина, важна форма',searchQuery:'Japanese garden wood walkway',aiEnabled:true};
  const create=(extra={},source=parent)=>store.transaction(()=>createReplacement(store,source,{...data,revision:source.revision||0,...extra}));
  const pins=(start=100,count=35)=>Array.from({length:count},(_,i)=>({pinId:String(start+i),pinUrl:'https://www.pinterest.com/pin/'+(start+i)+'/'}));
  const download=async(_root,pin)=>({...candidate(Number(pin.pinId)),...pin});
  const review=(run,pool=[candidate(100),candidate(101)])=>store.save('run',{...run,status:'ready',replacement:{...run.replacement,status:'review',pool,ai:{status:'ready',callCount:1,recommendedIds:pool.map(c=>c.id)}}},run.projectId);
  const work=(run,extra={})=>performReplacement({store,root,run,connection:{id:'account'},uploads:[],controller:new AbortController(),pinterest:{collect:async()=>pins()},download,...extra});
  return {root,store,parent,data,candidate,create,pins,download,review,work};
}
const grade=id=>({candidateId:id,score:3,landscapeRelevance:3,category:'elements',reason:'Деревянная конструкция',uncertainty:'',sufficientEvidence:true,duplicateGroup:null});

test('replacement validates the version, source and one to five unique target IDs',t=>{
  const f=fixture(t);
  for(const targetIds of [[],['foreign'],['c1','c1'],['c1','c2','c3','c4','c5','c6']])assert.throws(()=>f.create({targetIds}));
  assert.throws(()=>f.create({revision:3}),/изменилась/);assert.throws(()=>f.create({aiEnabled:undefined}),/режим/);
  const next=f.create();assert.deepEqual(next.replacement.targetIds,['c1','c2']);assert.deepEqual(next.selectedIds,f.parent.selectedIds);assert.equal(next.connectionId,'account');assert.notEqual(next.id,f.parent.id);
});

test('the three-attempt limit includes sibling branches, errors and discarded attempts',t=>{
  const f=fixture(t);
  for(let i=0;i<3;i++){const r=f.create();f.store.save('run',{...r,status:'error',replacement:{...r.replacement,status:'discarded'}},r.projectId);}
  assert.equal(replacementAttempts(f.store,f.parent),3);assert.throws(()=>f.create(),/три попытки/);
});

test('new sibling attempts exclude alternatives already reviewed in another branch',t=>{
  const f=fixture(t),first=f.review(f.create());discardReplacement(f.store,first,0);
  const sibling=f.create();assert.ok(sibling.replacement.excludedPinIds.includes('100'));assert.ok(sibling.replacement.excludedHashes.includes(f.candidate(101).sha256));
});

test('search keeps the parent and current board unchanged, caps the pool and excludes known IDs and image hashes',async t=>{
  const f=fixture(t),run=f.create({aiEnabled:false}),before=JSON.stringify(f.store.get('run','parent'));
  const downloaded=[];
  await f.work(run,{pinterest:{collect:async(_c,brief)=>{assert.equal(brief.mode,'text');assert.equal(brief.query,f.data.searchQuery);return [{pinId:'1'},{pinId:'99'},...f.pins()];}},download:async(root,pin)=>{downloaded.push(pin.pinId);return pin.pinId==='99'?{...f.candidate(1),id:'different',pinId:'99'}:f.download(root,pin);}});
  const next=f.store.get('run',run.id);assert.equal(next.replacement.pool.length,20);assert.ok(!downloaded.includes('1'));assert.ok(!next.replacement.pool.some(c=>c.pinId==='99'));assert.equal(next.replacement.status,'review');assert.equal(next.replacement.ai,undefined);
  assert.deepEqual(next.candidates,f.parent.candidates);assert.deepEqual(next.selectedIds,f.parent.selectedIds);assert.equal(JSON.stringify(f.store.get('run','parent')),before);
});

test('AI receives original examples and rejected frames with the reason, reserves one call and only proposes target-count options',async t=>{
  const f=fixture(t),run=f.create(),reference=path.join(f.root,'seed.png');fs.writeFileSync(reference,Buffer.from([1,2,3]));let calls=0;
  const rank=options=>rankCandidates({...options,catalog:async()=>[{id:'test-sol'}],invoke:async request=>{
    calls++;assert.equal(f.store.get('run',run.id).replacement.ai.callCount,1);assert.equal(request.images.length,23);assert.match(request.prompt,/ОТМЕЧЕННЫЕ ДЛЯ ЗАМЕНЫ/);assert.ok(request.prompt.includes(f.data.reason));assert.match(request.prompt,/C01 = изображение №4/);
    const ids=request.schema.properties.assessments.items.properties.candidateId.enum;return {response:{interpretation:'Древесина в японском саду',criteria:['Форма и древесина'],assessments:ids.map(grade)},usage:{input_tokens:40,output_tokens:20},elapsedMs:10};
  }});
  await f.work(run,{uploads:[{id:'seed',path:reference}],rank});const next=f.store.get('run',run.id);
  assert.equal(calls,1);assert.equal(next.replacement.ai.recommendedIds.length,2);assert.equal(next.replacement.ai.usage.input_tokens,40);assert.deepEqual(next.candidates,f.parent.candidates);assert.deepEqual(next.selectedIds,['c1','c3']);
});

test('partial explicit application preserves untouched positions, selection and immutable export snapshots; identical replay is harmless',t=>{
  const f=fixture(t),run=f.review(f.create()),snapshot={id:'snapshot',runId:'parent',items:f.parent.candidates};f.store.save('selection',snapshot,'project');
  const request={revision:0,mappings:[{from:'c1',to:'c100'}]},next=applyReplacement(f.store,run,request);
  assert.deepEqual(next.candidates.map(c=>c.id),['c100','c2','c3','c4']);assert.deepEqual(next.selectedIds,['c100','c3']);assert.equal(next.replacement.status,'applied');
  assert.deepEqual(f.store.get('run','parent'),f.parent);assert.deepEqual(f.store.get('selection','snapshot'),snapshot);
  assert.deepEqual(applyReplacement(f.store,next,request),next);assert.throws(()=>applyReplacement(f.store,next,{revision:1,mappings:[{from:'c2',to:'c101'}]}),/уже применены/);
});

test('a replacement of an unselected slot remains unselected and stale application cannot overwrite a newer manual choice',t=>{
  const f=fixture(t),run=f.review(f.create());const edited={...run,revision:1,selectedIds:['c3']};f.store.save('run',edited,'project');
  assert.throws(()=>applyReplacement(f.store,edited,{revision:0,mappings:[{from:'c2',to:'c100'}]}),/изменилась/);
  const done=applyReplacement(f.store,edited,{revision:1,mappings:[{from:'c2',to:'c100'}]});assert.deepEqual(done.selectedIds,['c3']);assert.equal(done.candidates[1].id,'c100');
});

test('multiple explicit mappings replace their own slots regardless of request order',t=>{
  const f=fixture(t),run=f.review(f.create());
  const next=applyReplacement(f.store,run,{revision:0,mappings:[{from:'c2',to:'c100'},{from:'c1',to:'c101'}]});
  assert.deepEqual(next.candidates.map(c=>c.id),['c101','c100','c3','c4']);assert.deepEqual(next.selectedIds,['c101','c3']);assert.deepEqual(next.candidates.slice(2),f.parent.candidates.slice(2));
});

test('application rejects invented identities, a non-target slot, reused options and image duplicates',t=>{
  const f=fixture(t),run=f.review(f.create());
  for(const mappings of [[{from:'c1',to:'alien'}],[{from:'c4',to:'c100'}],[{from:'c1',to:'c100'},{from:'c2',to:'c100'}]])assert.throws(()=>applyReplacement(f.store,run,{revision:0,mappings}));
  const duplicate=f.review(run,[{...f.candidate(3),id:'dup'}]);assert.throws(()=>applyReplacement(f.store,duplicate,{revision:0,mappings:[{from:'c1',to:'dup'}]}),/дубликат/);
});

test('no results leave the original state available and can be explicitly discarded',async t=>{
  const f=fixture(t),run=f.create({aiEnabled:false});await f.work(run,{pinterest:{collect:async()=>[]}});const stopped=f.store.get('run',run.id);
  assert.equal(stopped.status,'error');assert.deepEqual(stopped.candidates,f.parent.candidates);const next=discardReplacement(f.store,stopped,0);assert.equal(next.status,'ready');assert.equal(next.replacement.status,'discarded');assert.deepEqual(next.selectedIds,f.parent.selectedIds);
});

test('a model failure leaves the downloaded alternatives for manual review without changing the board',async t=>{
  const f=fixture(t),run=f.create();await f.work(run,{rank:async({onStart})=>{onStart({status:'running',callCount:1});throw Error('Лимит Codex');}});const next=f.store.get('run',run.id);
  assert.equal(next.status,'ready');assert.equal(next.replacement.status,'review');assert.equal(next.replacement.pool.length,20);assert.equal(next.replacement.ai.callCount,1);assert.equal(next.replacement.ai.status,'error');assert.deepEqual(next.candidates,f.parent.candidates);
});

test('challenge checkpoints survive and resume does not lose the original board or the collected sources',async t=>{
  const f=fixture(t),run=f.create({aiEnabled:false});let searches=0;
  const pinterest={collect:async(_c,brief,_u,progress)=>{searches++;if(searches===1){await progress({pins:f.pins(100,7)});throw new PinterestAccessError({kind:'captcha',message:'Проверка'});}assert.equal(brief.observedPins.length,7);return f.pins();}};
  await f.work(run,{pinterest});const paused=f.store.get('run',run.id);assert.equal(paused.status,'blocked');assert.equal(paused.replacement.source.pins.length,7);
  await f.work(paused,{pinterest});assert.equal(f.store.get('run',run.id).replacement.pool.length,20);assert.deepEqual(f.store.get('run',run.id).candidates,f.parent.candidates);
});

test('a late response after cancellation cannot apply changes or remove the source board',async t=>{
  const f=fixture(t),run=f.create(),controller=new AbortController();await f.work(run,{controller,rank:async({onStart})=>{onStart({status:'running',callCount:1});controller.abort();return {candidates:[],ai:{status:'ready',recommendedIds:['wrong']}};}});
  const stopped=f.store.get('run',run.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.replacement.ai.status,'cancelled');assert.equal(stopped.replacement.pool.length,20);assert.deepEqual(stopped.candidates,f.parent.candidates);assert.deepEqual(stopped.selectedIds,f.parent.selectedIds);
});

test('restart preserves an unknown AI reservation and resume never sends another model call',async t=>{
  const f=fixture(t),run=f.create(),pool=[f.candidate(100)];f.store.save('run',{...run,status:'ranking',replacement:{...run.replacement,pool,source:{pins:[],complete:true},ai:{status:'running',callCount:1}}},'project');f.store.recover();const recovered=f.store.get('run',run.id);
  assert.equal(recovered.status,'interrupted');assert.equal(recovered.replacement.ai.status,'unknown');let calls=0;
  await f.work(recovered,{rank:options=>rankCandidates({...options,catalog:async()=>{calls++;throw Error('must not call');}})});
  const done=f.store.get('run',run.id);assert.equal(calls,0);assert.equal(done.replacement.ai.callCount,1);assert.equal(done.replacement.status,'review');assert.deepEqual(done.candidates,f.parent.candidates);
});
