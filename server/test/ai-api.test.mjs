import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {httpFixture} from './support/http-fixture.mjs';
import {vision,preparedResponse,waitInterpretation} from './support/interpretation-fixture.mjs';
import {Ledger} from '../ledger.mjs';
import {createApiExecutor,validateProfile,upperCost,parseResponse} from '../ai-api.mjs';
import {checkEndpoint,publicAddress,guardedLookup,postJson} from '../ai-endpoint.mjs';
import {rankCandidates} from '../ranking.mjs';
import {sha256} from '../domain.mjs';

const KEY_A='sk-test-AAAAAAAAAAAAAAAAAAAA-a1b2',KEY_B='sk-test-BBBBBBBBBBBBBBBBBBBB-z9y8';
const profile=(over={})=>({baseUrl:'https://api.example-ai.test/v1',wireFormat:'responses',model:'vision-model-1',enabled:true,
  images:{supported:true,maxPerRequest:60,maxInputTokensPerImage:1600},limits:{maxOutputTokens:4000},
  tariff:{currency:'USD',inputPerMillion:2,outputPerMillion:8,outputLimitCoversReasoning:true,checkedAt:'2026-11-09'},budget:{monthlyLimit:5,monthlyCalls:100},...over});
const wire={
  responses:(json,usage={input_tokens:900,output_tokens:60})=>({status:200,data:{status:'completed',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:JSON.stringify(json)}]}],...(usage?{usage}:{})}}),
  'chat-completions':(json,usage={prompt_tokens:900,completion_tokens:60})=>({status:200,data:{choices:[{message:{content:JSON.stringify(json)},finish_reason:'stop'}],...(usage?{usage}:{})}}),
};

// HTTP fixture with a ledger, an in-memory vault and a recording fake API.
async function aiFixture(t,{answer=body=>JSON.stringify(body).includes('сплошной цвет')?{ok:true,color:'red'}:preparedResponse(),format='responses',usage}={}){
  const vaultData=new Map(),vault={get:async id=>vaultData.get(id)??null,put:async(id,key)=>{vaultData.set(id,key);},delete:async id=>{vaultData.delete(id);}};
  const calls=[];let reply=(url,body)=>wire[format](answer(body),usage);
  const post=async(url,options)=>{calls.push({url,...options});return reply(url,options.body,options);};
  let store;const f=await httpFixture(t,{vault,aiPost:post,aiExecutor:connectionId=>createApiExecutor({store,connectionId,vault,post})});
  store=f.store;const accounting=fs.mkdtempSync(path.join(os.tmpdir(),'pma-ai-ledger-'));store.ledger=new Ledger(accounting,store);
  t.after(()=>{store.ledger.close();fs.rmSync(accounting,{recursive:true,force:true});});
  return {...f,calls,vaultData,setReply:fn=>{reply=fn;}};
}
async function configure(c,over={}){
  assert.equal((await c.request('/api/ai/profile','PUT',profile(over))).status,200);
  assert.equal((await c.request('/api/ai/key','PUT',{key:KEY_A})).status,200);
}

test('D14: endpoint rules — public HTTPS only, no credentials/query/private or local addresses, checked again at connect',async()=>{
  for(const bad of ['http://api.example.com/v1','https://u:p@api.example.com','https://api.example.com/v1?x=1','https://127.0.0.1/v1','https://10.0.0.5','https://[::1]/v1','https://192.168.1.10','https://169.254.169.254/latest','https://localhost:8443','https://ai.internal','not a url'])
    assert.throws(()=>checkEndpoint(bad),undefined,bad);
  assert.equal(checkEndpoint('https://api.example.com/v1/'),'https://api.example.com/v1');
  for(const ip of ['10.1.2.3','172.16.0.1','192.168.0.1','127.0.0.1','169.254.1.1','100.64.0.1','0.0.0.0','::1','fc00::1','fe80::1','::ffff:10.0.0.1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700::1111'])assert.equal(publicAddress(ip),true,ip);
  const lookup=guardedLookup((_h,_o,cb)=>cb(null,[{address:'93.184.216.34',family:4},{address:'10.0.0.7',family:4}]));
  await assert.rejects(new Promise((resolve,reject)=>lookup('rebind.example',{},e=>e?reject(e):resolve())),/частную сеть/);
  // A name that resolves to loopback never gets the request (or the key).
  await assert.rejects(postJson('https://looks-public.example/v1/responses',{headers:{Authorization:'Bearer x'},body:{},lookup:(_h,_o,cb)=>cb(null,[{address:'127.0.0.1',family:4}])}),/частную сеть/);
});

test('D14: the key is stored in the vault, never returned, used only for its owner and only toward the profile host',async t=>{
  const f=await aiFixture(t),a=f.client();await a.login('a');
  assert.equal((await a.request('/api/ai/key','PUT',{key:KEY_A})).status,409,'profile first');
  await configure(a);
  const view=await a.request('/api/ai/profile');assert.equal(view.body.keyConfigured,true);assert.equal(view.body.keyHint,'…a1b2');
  for(const route of ['/api/ai/profile','/api/bootstrap','/api/projects/project-a'])assert.equal(JSON.stringify((await a.request(route)).body).includes(KEY_A),false,route);
  assert.equal(JSON.stringify(f.store.list('ai-profile')).includes(KEY_A),false,'not in the project database');
  assert.equal(f.calls.length,0,'saving profile and key never calls the model');
  assert.equal((await a.request('/api/ai/probe','POST',{})).status,200);
  assert.equal(f.calls.length,1);assert.equal(new URL(f.calls[0].url).host,'api.example-ai.test');assert.equal(f.calls[0].headers.Authorization,'Bearer '+KEY_A);
  // B has no profile and cannot use A's key; after a lock the AI routes are closed.
  const b=f.client();await b.login('b');
  assert.equal((await b.request('/api/ai/profile')).body.profile,null);
  const r=await b.request('/api/interpretations','POST',{projectId:'project-b',query:vision});const done=await waitInterpretation(b,r.body.id);
  assert.equal(done.status,'error');assert.match(done.message,/не настроен/);assert.equal(f.calls.length,1);
  await b.request('/api/active-connection','POST',{id:null});assert.equal((await b.request('/api/ai/profile')).status,401);
  // Deleting the key closes paid calls.
  await a.login('a');assert.equal((await a.request('/api/ai/key/delete','POST',{})).body.keyConfigured,false);assert.equal(f.vaultData.has('a'),false);
});

for(const format of ['responses','chat-completions'])test('D12/D13 ('+format+'): explicit probe proves text+image+structure+usage, then interpretation runs through the API with one reservation',async t=>{
  const f=await aiFixture(t,{format,answer:body=>JSON.stringify(body).includes('сплошной цвет')?{ok:true,color:'red'}:preparedResponse()}),a=f.client();await a.login('a');
  await configure(a,{wireFormat:format});
  const unverified=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});
  assert.match((await waitInterpretation(a,unverified.body.id)).message,/не проверен/);assert.equal(f.calls.length,0);
  const probed=await a.request('/api/ai/probe','POST',{});assert.equal(probed.status,200,JSON.stringify(probed.body));assert.equal(probed.body.verified,true);assert.equal(probed.body.verification.image,true);
  const sent=f.calls[0].body;
  if(format==='responses'){assert.equal(sent.text.format.strict,true);assert.equal(sent.input[0].content[1].type,'input_image');assert.match(sent.input[0].content[1].image_url,/^data:image\/png;base64,/);assert.equal(sent.max_output_tokens,4000);assert.equal(sent.store,false);}
  else{assert.equal(sent.response_format.json_schema.strict,true);assert.equal(sent.messages[0].content[1].type,'image_url');assert.equal(sent.max_tokens,4000);}
  const r=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision+' '+format});const done=await waitInterpretation(a,r.body.id);
  assert.equal(done.status,'ready',done.message);assert.equal(done.result.searchQuery,preparedResponse().searchQuery);assert.equal(f.calls.length,2);
  const again=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision+' '+format});assert.equal(again.body.status,'ready');assert.equal(f.calls.length,2,'ready result reused without a call');
  const spend=(await a.request('/api/ai/profile')).body.month;assert.equal(spend.poolCalls,2);assert.equal(spend.spend[0].currency,'USD');
  assert.equal(spend.spend[0].micros,2*Math.ceil(900*2+60*8),'settled from usage, not the upper bound');
});

test('D13: tool calls, refusals and incomplete answers are rejected and never executed',()=>{
  const p=validateProfile(profile());
  assert.throws(()=>parseResponse(p,{status:'completed',output:[{type:'function_call',name:'shell'}]}),/инструмент/);
  assert.throws(()=>parseResponse(p,{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}),/отказалась/);
  assert.throws(()=>parseResponse(p,{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),/неполный/);
  const c={...p,wireFormat:'chat-completions'};
  assert.throws(()=>parseResponse(c,{choices:[{message:{tool_calls:[{}]},finish_reason:'tool_calls'}]}),/инструмент/);
  assert.throws(()=>parseResponse(c,{choices:[{message:{content:'{}'},finish_reason:'length'}]}),/неполный/);
  assert.throws(()=>parseResponse(c,{choices:[{},{}]}),/одного/);
});

test('D15: unknown bounds, too many images, the money limit and the call pool all stop before sending',async t=>{
  const p=validateProfile(profile());
  assert.throws(()=>upperCost(validateProfile(profile({tariff:{...profile().tariff,outputLimitCoversReasoning:false}})),{prompt:'x',schema:{},imageCount:0}),/рассуждения/);
  assert.throws(()=>upperCost(validateProfile(profile({images:{supported:false}})),{prompt:'x',schema:{},imageCount:1}),/не принимает изображения/);
  assert.throws(()=>upperCost(validateProfile(profile({images:{supported:true,maxPerRequest:4,maxInputTokensPerImage:1000}})),{prompt:'x',schema:{},imageCount:5}),/Дополнительные вызовы не делаются/);
  assert.ok(upperCost(p,{prompt:'Привет',schema:{},imageCount:2}).micros>=Math.ceil((12+2+512+3200)*2+4000*8));
  // Money: with a limit of 0.038 USD, the probe (upper bound ≈ 0.037, settled ≈ 0.002) fits once; the next one is refused before sending.
  const f=await aiFixture(t,{answer:()=>({ok:true,color:'red'})}),a=f.client();await a.login('a');
  await configure(a,{budget:{monthlyLimit:0.038,monthlyCalls:100}});
  assert.equal((await a.request('/api/ai/probe','POST',{})).status,200);
  const again=await a.request('/api/ai/probe','POST',{});assert.equal(again.status,409);assert.match(again.body.error,/Денежный предел/);assert.equal(f.calls.length,1);
  // Call pool: an owner-lowered pool of 1 is already used.
  await configure(a,{budget:{monthlyLimit:5,monthlyCalls:1}});
  const pool=await a.request('/api/ai/probe','POST',{});assert.equal(pool.status,409);assert.match(pool.body.error,/предел PMA исчерпан \(1/);assert.equal(f.calls.length,1);
  // Concurrent reservations of one slot: exactly one wins.
  const ledger=f.store.ledger,cost={currency:'USD',micros:1,monthlyLimitMicros:1e9,callLimit:100,snapshot:{}};
  const r={id:'same',slot:'s',connectionId:'a',projectId:'p',month:'2026-11',amount:1,createdAt:new Date().toISOString()};
  const results=[0,1,2].map(()=>{try{ledger.reserve(r,100,cost);return 'ok';}catch(e){return e.message;}});
  assert.equal(results.filter(x=>x==='ok').length,1);
});

test('D16: timeout after sending keeps the reservation, marks the result unknown and is never retried; profile changes keep history',async t=>{
  const f=await aiFixture(t,{answer:()=>({ok:true,color:'red'})}),a=f.client();await a.login('a');await configure(a);
  assert.equal((await a.request('/api/ai/probe','POST',{})).status,200);
  f.setReply(async()=>{throw Object.assign(Error('socket hang up'),{code:'ECONNRESET'});});
  const r=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});const done=await waitInterpretation(a,r.body.id);
  assert.equal(done.status,'unknown');assert.equal(f.calls.length,2);
  const again=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});assert.equal(again.body.status,'unknown');assert.equal(f.calls.length,2,'no hidden retry');
  const month=(await a.request('/api/ai/profile')).body.month;assert.equal(month.poolCalls,2);
  const reserved=f.store.ledger.db.prepare("SELECT reserved_micros,actual_micros,snapshot FROM reservations WHERE slot LIKE 'interpretation:%'").get();
  assert.equal(reserved.actual_micros,null);assert.ok(reserved.reserved_micros>0);assert.equal(month.spend[0].micros,Math.ceil(900*2+60*8)+reserved.reserved_micros,'unknown counts at its upper bound');
  // Changing model/tariff does not rewrite old reservations or reset the month; it needs a new probe.
  await configure(a,{model:'other-model',tariff:{...profile().tariff,inputPerMillion:1}});
  const after=(await a.request('/api/ai/profile')).body;assert.equal(after.verified,false);assert.equal(after.month.poolCalls,2);assert.equal(after.month.spend[0].micros,month.spend[0].micros);
  assert.equal(JSON.parse(reserved.snapshot).model,'vision-model-1');assert.equal(JSON.parse(reserved.snapshot).tariff.inputPerMillion,2);
  // A different currency in the same month is refused.
  await configure(a,{tariff:{...profile().tariff,currency:'EUR'}});const eur=await a.request('/api/ai/probe','POST',{});assert.equal(eur.status,409);assert.match(eur.body.error,/другой валюте/);
});

test('D16: missing usage or cost above the bound closes paid AI until a new check',async t=>{
  const f=await aiFixture(t,{answer:()=>({ok:true,color:'red'}),usage:null}),a=f.client();await a.login('a');await configure(a);
  const r=await a.request('/api/ai/probe','POST',{});assert.equal(r.status,409);assert.match(r.body.error,/расход/);
  assert.match((await a.request('/api/ai/profile')).body.blockedReason,/расход токенов/);
  f.setReply(()=>wire.responses({ok:true,color:'red'},{input_tokens:10_000_000,output_tokens:10}));
  const over=await a.request('/api/ai/probe','POST',{});assert.equal(over.status,409);assert.match(over.body.error,/превысила верхнюю оценку/);
});

test('D12: ranking uses the API executor with the real candidate images and one reservation',async t=>{
  const f=await aiFixture(t),a=f.client();await a.login('a');await configure(a);
  f.setReply((_u,body)=>JSON.stringify(body).includes('сплошной цвет')?wire.responses({ok:true,color:'red'}):wire.responses({interpretation:'x',criteria:['y'],assessments:[{candidateId:'C01',score:4,landscapeRelevance:4,category:'atmosphere',reason:'ok',uncertainty:'',sufficientEvidence:true,duplicateGroup:null}]}));
  assert.equal((await a.request('/api/ai/probe','POST',{})).status,200);
  const bytes=fs.readFileSync(path.join(f.root,'assets',f.owners.a.item.asset));assert.equal(sha256(bytes),f.owners.a.item.sha256);
  const run={...f.owners.a.run,ai:null},executor=createApiExecutor({store:f.store,connectionId:'a',vault:{get:async()=>KEY_A},post:async(u,o)=>{f.calls.push({url:u,...o});return wire.responses({interpretation:'x',criteria:['y'],assessments:[{candidateId:'C01',score:4,landscapeRelevance:4,category:'atmosphere',reason:'ok',uncertainty:'',sufficientEvidence:true,duplicateGroup:null}]});}});
  const {reserveRunAI}=await import('../ai-budget.mjs');
  const result=await rankCandidates({root:f.root,run,candidates:[f.owners.a.item],uploads:[],signal:new AbortController().signal,onStart:(ai,cost)=>reserveRunAI(f.store,run,ai,{cost}),onUsage:()=>{},...executor});
  assert.equal(result.ai.status,'ready');assert.deepEqual(result.ai.recommendedIds,[f.owners.a.item.id]);
  const last=f.calls.at(-1).body;assert.equal(last.input[0].content.filter(c=>c.type==='input_image').length,1);
  const row=f.store.ledger.db.prepare('SELECT reserved_micros,actual_micros FROM reservations WHERE slot=?').get('search:'+run.id);assert.ok(row.reserved_micros>=row.actual_micros);
});
