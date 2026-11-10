import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';
import { sha256,selectedItems } from '../domain.mjs';
import { performSearch } from '../search.mjs';
import { rankCandidates } from '../ranking.mjs';
import { evaluationPrompt } from '../selection-eval.mjs';
import { runCodexSelection } from '../codex-selection.mjs';
import { PinterestAccessError } from '../pinterest-access.mjs';

function fixture(t,extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-ranking-')),store=new Store(root);
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('pma-ranking-'));fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'assets'));
  const run={id:'run',projectId:'project',connectionId:'account',mode:'text',query:'Японский сад',notes:'Важна композиция, материал не важен',aiEnabled:true,candidates:[],selectedIds:[],...extra};
  store.save('run',run,'project');
  const pins=(start,count)=>Array.from({length:count},(_,i)=>({pinId:String(start+i),pinUrl:`https://www.pinterest.com/pin/${start+i}/`,imageUrl:`https://i.pinimg.com/474x/${start+i}.jpg`}));
  const download=async(_root,pin)=>{
    const bytes=Buffer.from([255,216,255,224,...Buffer.from(pin.pinId)]),hash=sha256(bytes),asset=hash+'.jpg';fs.writeFileSync(path.join(root,'assets',asset),bytes);
    return {...pin,id:'candidate-'+pin.pinId,asset,sha256:hash};
  };
  return {root,store,run,pins,download};
}
const grade=(id,score=3)=>({candidateId:id,score,landscapeRelevance:3,category:'composition',reason:'Полезна композиция',uncertainty:'Материал не подтверждён',sufficientEvidence:true,duplicateGroup:null});

test('normal image search plus AI keeps 25 Lens and 25 text candidates and never selects for the architect',async t=>{
  const f=fixture(t,{mode:'image',selectedIds:['candidate-1000']}),reference=path.join(f.root,'reference.png');fs.writeFileSync(reference,Buffer.from([1,2,3]));
  let calls=0;const modes=[];
  const pinterest={collect:async(_connection,brief,_uploads,progress)=>{
    modes.push(brief.mode);if(brief.mode==='image')await progress({searchEvidence:{strategy:'pinterest-lens',seedUploadId:'seed'},message:'Lens'});
    return f.pins(brief.mode==='image'?1000:2000,brief.mode==='image'?30:40);
  }};
  const rank=options=>rankCandidates({...options,catalog:async()=>[{id:'test-sol'}],invoke:async request=>{
    calls++;assert.equal(f.store.get('run','run').ai.callCount,1,'budget persisted before inference');assert.equal(request.images.length,51);assert.ok(request.prompt.includes(f.run.notes));
    const ids=request.schema.properties.assessments.items.properties.candidateId.enum;
    return {response:{interpretation:'Сад и архитектура',criteria:['Композиция'],assessments:[...ids].reverse().map((id,i)=>grade(id,i<10?4:2))},usage:{input_tokens:120,output_tokens:50},elapsedMs:20,completedAt:new Date().toISOString()};
  }});
  await performSearch({...f,pinterest,connection:{id:'account'},uploads:[{id:'seed',path:reference}],controller:new AbortController(),rank});
  const done=f.store.get('run','run');
  assert.deepEqual(modes,['image','text']);assert.equal(calls,1);assert.equal(done.status,'ready');assert.equal(done.candidates.length,50);
  assert.equal(done.candidates.filter(c=>c.origin==='lens').length,25);assert.equal(done.candidates.filter(c=>c.origin==='text').length,25);
  assert.equal(done.ai.recommendedIds.length,10);assert.equal(done.ai.callCount,1);assert.deepEqual(done.selectedIds,['candidate-1000']);
  assert.ok(done.ai.recommendedIds.every(id=>done.candidates.some(c=>c.id===id)));
  assert.equal(selectedItems(done,['candidate-1000',done.ai.recommendedIds[0]]).length,2,'manual selection can include a non-recommended candidate');
});

test('when AI is off, one Pinterest search returns 25 and no model is invoked',async t=>{
  const f=fixture(t,{aiEnabled:false});let searches=0;
  await performSearch({...f,pinterest:{collect:async()=>{searches++;return f.pins(1000,60);}},uploads:[],connection:{id:'account'},controller:new AbortController(),rank:async()=>assert.fail('AI must remain off')});
  const done=f.store.get('run','run');assert.equal(searches,1);assert.equal(done.candidates.length,25);assert.equal(done.ai,undefined);assert.equal(done.status,'ready');
});

test('model failure leaves all downloaded candidates and the manual selection available',async t=>{
  const f=fixture(t,{selectedIds:['candidate-1000']});
  await performSearch({...f,pinterest:{collect:async()=>f.pins(1000,55)},uploads:[],connection:{id:'account'},controller:new AbortController(),rank:async({onStart})=>{await onStart({status:'running',callCount:1});throw Error('Лимит Codex');}});
  const done=f.store.get('run','run');assert.equal(done.status,'ready');assert.equal(done.candidates.length,50);assert.equal(done.ai.status,'error');assert.equal(done.ai.callCount,1);assert.deepEqual(done.selectedIds,['candidate-1000']);
});

test('a challenge in supplemental search preserves primary images and resumes only the incomplete source',async t=>{
  const f=fixture(t,{mode:'image'});let imageSearches=0,secondary=0,ranked=0;
  const pinterest={collect:async(_connection,brief,_uploads,progress)=>{
    if(brief.mode==='image'){imageSearches++;await progress({searchEvidence:{strategy:'pinterest-lens',seedUploadId:'seed'},message:'Lens'});return f.pins(1000,30);}
    secondary++;if(secondary===1){await progress({pins:f.pins(2000,10),message:'10 найдено'});throw new PinterestAccessError({kind:'captcha',message:'Проверка Pinterest'});}
    assert.equal(brief.observedPins.length,10);return f.pins(2000,40);
  }};
  const rank=async({candidates})=>{ranked++;return {candidates,ai:{status:'ready',recommendedIds:[],callCount:1,candidateCount:candidates.length}};};
  await performSearch({...f,pinterest,uploads:[{id:'seed'}],connection:{id:'account'},controller:new AbortController(),rank});
  const paused=f.store.get('run','run');assert.equal(paused.status,'blocked');assert.equal(paused.candidates.length,25);assert.equal(ranked,0);
  await performSearch({...f,run:paused,pinterest,uploads:[{id:'seed'}],connection:{id:'account'},controller:new AbortController(),rank});
  assert.equal(imageSearches,1);assert.equal(secondary,2);assert.equal(ranked,1);assert.equal(f.store.get('run','run').status,'ready');
});

test('late model output after cancellation cannot replace the saved candidates or manual selection',async t=>{
  const f=fixture(t,{selectedIds:['candidate-1000']}),controller=new AbortController();
  await performSearch({...f,pinterest:{collect:async()=>f.pins(1000,3)},uploads:[],connection:{id:'account'},controller,rank:async({onStart})=>{
    await onStart({status:'running',callCount:1});controller.abort();return {candidates:[],selectedIds:[],ai:{status:'ready',recommendedIds:['invented']}};
  }});
  const done=f.store.get('run','run');assert.equal(done.status,'cancelled');assert.equal(done.candidates.length,3);assert.deepEqual(done.selectedIds,['candidate-1000']);assert.equal(done.ai.status,'cancelled');assert.equal(done.ai.recommendedIds,undefined);
});

test('restart during inference preserves the reservation and prevents another inference call',async t=>{
  const f=fixture(t,{status:'ranking',ai:{status:'running',callCount:1}});f.store.recover();const recovered=f.store.get('run','run');
  assert.equal(recovered.status,'interrupted');assert.equal(recovered.ai.status,'unknown');let invoked=0;
  await assert.rejects(rankCandidates({root:f.root,run:recovered,candidates:[],uploads:[],signal:new AbortController().signal,onStart:async()=>{},onUsage:async()=>{},catalog:async()=>{invoked++;return[];},invoke:async()=>{invoked++;}}),/Лимит AI/);
  assert.equal(invoked,0);
});

test('text-only and multiple-reference prompts map candidate images without counting examples as candidates',()=>{
  const candidates=[{evalId:'C01'}],brief={query:'Древесина',notes:'Форма'};
  assert.match(evaluationPrompt(candidates,brief,'photo-text',{referenceCount:0}),/C01 = изображение №1/);
  assert.match(evaluationPrompt(candidates,brief,'photo-text',{referenceCount:3}),/C01 = изображение №4/);
});

test('a pre-cancelled CLI request exits before any filesystem or process access',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runCodexSelection({directory:'does-not-exist',signal:controller.signal}),{name:'AbortError'});
});
