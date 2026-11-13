import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpFixture} from './support/http-fixture.mjs';
import {vision,preparedResponse,waitInterpretation} from './support/interpretation-fixture.mjs';
import {Ledger} from '../ledger.mjs';
import {codexCandidates,findCodex,createCodexExecutor,pickExecutor} from '../ai-codex.mjs';
import {rankCandidates} from '../ranking.mjs';
import {reserveRunAI} from '../ai-budget.mjs';

const fake=path.join(path.dirname(fileURLToPath(import.meta.url)),'support','fake-codex.mjs');
const runtime={source:'installer',path:fake,command:[process.execPath,fake]};

// HTTP fixture with a ledger and a fake codex.exe; `locate` can be swapped to simulate a missing Codex.
async function codexFixture(t,{login='chatgpt'}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pma-codex-')),log=path.join(dir,'calls.jsonl');
  const saved={...process.env};Object.assign(process.env,{FAKE_CODEX_LOG:log,FAKE_CODEX_LOGIN:login,OPENAI_API_KEY:'sk-should-never-reach-codex'});delete process.env.FAKE_CODEX_FAIL;
  let locate=()=>runtime,apiPosts=0;
  const vault={get:async()=>null,put:async()=>{},delete:async()=>{}},post=async()=>{apiPosts++;throw Error('API must not be called');};
  let store;const f=await httpFixture(t,{vault,aiPost:post,codexLocate:()=>locate(),aiExecutor:connectionId=>pickExecutor({store,connectionId,vault,post,locate:()=>locate()})});
  store=f.store;store.ledger=new Ledger(dir,store);
  t.after(()=>{store.ledger.close();process.env=saved;fs.rmSync(dir,{recursive:true,force:true});});
  const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
  return {...f,calls,execs:()=>calls().filter(c=>c.args[0]==='exec'),apiPosts:()=>apiPosts,setLocate:fn=>{locate=fn;}};
}

test('Codex discovery: official installer, then npm package, then PATH; the Store app folder is skipped',()=>{
  const env={LOCALAPPDATA:'C:\\L',APPDATA:'C:\\R',PATH:['C:\\Tools','C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps'].join(path.delimiter)};
  const list=codexCandidates(env,'x64').map(c=>c.source+':'+c.path);
  assert.deepEqual(list,['installer:'+path.join('C:\\L','Programs','OpenAI','Codex','bin','codex.exe'),
    'npm:'+path.join('C:\\R','npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),
    'path:'+path.join('C:\\Tools','codex.exe')]);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-codex-find-'));
  try{
    assert.equal(findCodex({LOCALAPPDATA:root,PATH:''}),null);
    const exe=path.join(root,'Programs','OpenAI','Codex','bin','codex.exe');fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'');
    assert.deepEqual(findCodex({LOCALAPPDATA:root,PATH:''}),{source:'installer',path:exe,command:[exe]},'native exe, no Node');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('subscription mode: status, explicit probe with an image, then interpretation — one ledger slot each, no money, no API key',async t=>{
  const f=await codexFixture(t),a=f.client();await a.login('a');
  assert.equal((await a.request('/api/ai/profile')).body.mode,'api','API stays the default mode');
  const switched=await a.request('/api/ai/mode','PUT',{mode:'codex'});
  assert.equal(switched.status,200);assert.equal(switched.body.mode,'codex');
  assert.deepEqual({found:switched.body.codex.found,version:switched.body.codex.version,login:switched.body.codex.login,verified:switched.body.codex.verified},{found:true,version:'9.9.9',login:'chatgpt',verified:false});
  assert.equal(f.execs().length,0,'switching and status never call a model');
  const early=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});
  assert.match((await waitInterpretation(a,early.body.id)).message,/ещё не проверена/);assert.equal(f.execs().length,0);
  const probed=await a.request('/api/ai/codex/probe','POST',{});
  assert.equal(probed.status,200,JSON.stringify(probed.body));assert.equal(probed.body.codex.verified,true);assert.equal(probed.body.codex.verification.model,'test-sol');
  const exec=f.execs()[0].args;
  for(const flag of ['--sandbox','--output-schema','--image','--ignore-user-config','--ephemeral'])assert.ok(exec.includes(flag),flag);
  assert.equal(exec[exec.indexOf('--sandbox')+1],'read-only');assert.ok(exec.includes('shell_tool'),'tools disabled');
  assert.ok(f.calls().every(c=>!c.apiKey),'API keys are removed from the Codex environment');
  const r=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});const done=await waitInterpretation(a,r.body.id);
  assert.equal(done.status,'ready',done.message);assert.equal(done.result.searchQuery,preparedResponse().searchQuery);
  const rows=f.store.ledger.db.prepare('SELECT slot,currency,reserved_micros FROM reservations ORDER BY rowid').all();
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.currency===null&&row.reserved_micros===null),'subscription: call slot only');
  assert.equal((await a.request('/api/ai/profile')).body.month.poolCalls,2);
  assert.equal(f.apiPosts(),0);
  // Owner B has its own (default API) mode: A's Codex choice does not leak.
  const b=f.client();await b.login('b');assert.equal((await b.request('/api/ai/profile')).body.mode,'api');
});

test('AI selection through Codex passes every candidate image and reserves the slot before the call',async t=>{
  const f=await codexFixture(t),a=f.client();await a.login('a');
  await a.request('/api/ai/mode','PUT',{mode:'codex'});await a.request('/api/ai/codex/probe','POST',{});
  const run={...f.owners.a.run,ai:null},executor=createCodexExecutor({store:f.store,connectionId:'a',locate:()=>runtime});
  const result=await rankCandidates({root:f.root,run,candidates:[f.owners.a.item],uploads:[],signal:new AbortController().signal,onStart:(ai,cost)=>{assert.equal(cost,null);return reserveRunAI(f.store,run,ai,{cost});},onUsage:()=>{},...executor});
  assert.equal(result.ai.status,'ready');assert.deepEqual(result.ai.recommendedIds,[f.owners.a.item.id]);
  const exec=f.execs().at(-1).args;assert.equal(exec.filter(x=>x==='--image').length,1);
  await assert.rejects(executor.invoke({directory:f.root,model:'test-sol',images:[],prompt:'x',schema:{}}),/Нет резерва/,'no call without a ledger reservation');
});

test('without Codex, without sign-in or after a failure PMA explains why, never retries and never switches to the API',async t=>{
  const f=await codexFixture(t,{login:'none'}),a=f.client();await a.login('a');
  let view=(await a.request('/api/ai/mode','PUT',{mode:'codex'})).body;assert.equal(view.codex.login,'none');
  process.env.FAKE_CODEX_LOGIN='key';view=(await a.request('/api/ai/profile')).body;
  assert.equal(view.codex.login,'other');assert.equal(JSON.stringify(view).includes('sk-test'),false,'login status text never reaches the UI');
  process.env.FAKE_CODEX_FAIL='401 not logged in';
  const failed=await a.request('/api/ai/codex/probe','POST',{});assert.equal(failed.status,502);assert.match(failed.body.error,/вход через ChatGPT/);
  assert.equal(f.execs().length,1);assert.equal((await a.request('/api/ai/profile')).body.month.poolCalls,1,'the failed call stays counted');
  f.setLocate(()=>null);
  view=(await a.request('/api/ai/profile')).body;assert.equal(view.codex.found,false);
  const r=await a.request('/api/interpretations','POST',{projectId:'project-a',query:vision});
  assert.match((await waitInterpretation(a,r.body.id)).message,/не найден/);
  assert.equal((await a.request('/api/ai/codex/probe','POST',{})).status,409);
  assert.equal(f.execs().length,1);assert.equal(f.apiPosts(),0);
  assert.equal((await a.request('/api/ai/mode','PUT',{mode:'other'})).status,400);
});
