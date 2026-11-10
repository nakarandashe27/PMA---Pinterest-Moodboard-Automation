import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationSchema,evaluationPrompt,validateEvaluation,selectEvaluation,evaluationHTML } from '../selection-eval.mjs';
import { codexArguments } from '../codex-selection.mjs';
const assessment=(id,score=3,extra={})=>({candidateId:id,score,landscapeRelevance:3,category:'composition',reason:'Видна композиция сада',uncertainty:'',sufficientEvidence:true,duplicateGroup:null,...extra});
const response=assessments=>({interpretation:'Форма и композиция',criteria:['Форма'],assessments});
test('evaluation requires every supplied candidate exactly once and rejects invented identities',()=>{
  assert.equal(validateEvaluation(response([assessment('C01'),assessment('C02')]),['C01','C02']).assessments.length,2);
  assert.throws(()=>validateEvaluation(response([assessment('C01'),assessment('C01')]),['C01','C02']));
  assert.throws(()=>validateEvaluation(response([assessment('C01'),assessment('C99')]),['C01','C02']));
  assert.throws(()=>validateEvaluation(response([assessment('C01')]),['C01','C02']));
  assert.throws(()=>validateEvaluation(response([assessment('C01',4,{sufficientEvidence:false})]),['C01']));
});
test('selection preserves honest shortfall and only collapses explicitly marked duplicate groups',()=>{
  const value=response([assessment('C01',4,{duplicateGroup:'same-frame'}),assessment('C02',3,{duplicateGroup:'same-frame'}),assessment('C03',2),assessment('C04',4),assessment('C05',1,{sufficientEvidence:false})]);
  assert.deepEqual(selectEvaluation(value),['C01','C04']);
  assert.equal(value.assessments.length,5,'unselected candidates remain available');
});
test('photo control excludes text and notes while keeping candidate order identical',()=>{
  const candidates=[{evalId:'C01'},{evalId:'C02'}],brief={query:'ЯПОНСКИЙ_САД',notes:'ВАЖНА_КОМПОЗИЦИЯ'};
  const a=evaluationPrompt(candidates,brief,'photo'),b=evaluationPrompt(candidates,brief,'photo-text');
  assert.ok(!a.includes(brief.query)&&!a.includes(brief.notes));assert.ok(b.includes(brief.query)&&b.includes(brief.notes));
  for(const prompt of [a,b]){assert.ok(prompt.includes('C01 = изображение №2'));assert.ok(prompt.includes('C02 = изображение №3'));}
  assert.deepEqual(evaluationSchema(['C01']).properties.assessments.items.properties.candidateId.enum,['C01']);
});
test('Codex child uses ChatGPT auth, read-only permissions and disabled tools without shell interpolation',()=>{
  const args=codexArguments({model:'gpt-6.1-sol',cwd:'C:/local folder',schemaFile:'schema.json',outputFile:'output.json',images:['C:/image with spaces.jpg']});
  assert.ok(args.includes('forced_login_method="chatgpt"'));assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  for(const feature of ['plugins','apps','shell_tool','unified_exec','multi_agent'])assert.ok(args.some((x,i)=>x==='--disable'&&args[i+1]===feature));
  assert.ok(args.includes('C:/image with spaces.jpg'));assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));assert.deepEqual(args.slice(-2),['--','-']);
});
test('comparison escapes model and user text and keeps both source identities as strings',()=>{
  const manifest={model:'model',brief:{query:'<script>alert(1)</script>',notes:'shape'},seed:{id:'seed'},lensIds:['C01'],candidates:[{evalId:'C01',asset:'hash.jpg',pinId:'4608308449952188288',pinUrl:'https://www.pinterest.com/pin/4608308449952188288/',origin:'lens'},{evalId:'C02',asset:'other.jpg',pinUrl:'https://www.pinterest.com/pin/123/',origin:'text'}]};
  const value=response([assessment('C01'),assessment('C02',2)]),results={photo:{response:value,selectedIds:['C01'],usage:{}},'photo-text':{response:value,selectedIds:['C01'],usage:{}}};
  const html=evaluationHTML(manifest,results);
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('/pin/4608308449952188288/'));assert.ok(html.includes('Найдено по тексту'));assert.ok(html.includes('Исходные 1 Lens'));
});
