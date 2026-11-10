import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {httpFixture} from './support/http-fixture.mjs';
import {serviceStatus,writeReport} from '../diagnostics.mjs';

const info={appVersion:'0.1.0',pluginReady:true,figmaProtocol:2,schemaVersion:1,schemaBackup:null,figma:{available:true,reason:null}};
const SENTINELS=['sk-SENTINEL-KEY-0123456789','_pinterest_sess=SENTINELCOOKIE','SENTINEL-PROMPT-тихий двор','https://private.example/SENTINEL','C:\\Users\\sentinel\\secret','raw provider error SENTINEL','pair-SENTINELCODE'];

test('D23: status and the explicit report carry only versions, states and counts — no sentinels, paths or images',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pma-diag-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=await httpFixture(t,{diagnostics:{status:owner=>serviceStatus({store:f.store,owner,info}),report:owner=>writeReport(dir,serviceStatus({store:f.store,owner,info}))}});
  // Fill the owner's data with secrets in every free-text field the report could touch.
  const run=f.store.get('run','run-a');
  f.store.save('run',{...run,query:SENTINELS[2],message:SENTINELS[5]+' '+SENTINELS[3],notes:SENTINELS[4],status:'error'},'project-a');
  f.store.save('interpretation',{id:'brief-x',projectId:'project-a',connectionId:'a',input:{query:SENTINELS[2]},status:'unknown',message:SENTINELS[5],result:{searchQuery:SENTINELS[0]}},'project-a');
  f.store.save('ai-profile',{id:'ai-profile-a',connectionId:'a',baseUrl:SENTINELS[3],model:'m',enabled:true,keySetAt:'2026-11-09',keyHint:'…'+SENTINELS[0].slice(-4),blockedReason:SENTINELS[5]});
  f.store.save('pairing',{id:SENTINELS[6],exportId:'e',attemptId:'x',projectId:'project-a',connectionId:'a',packagePath:SENTINELS[4],expiresAt:Date.now()+1e6},'project-a');
  const a=f.client();
  const locked=await a.request('/api/diagnostics');assert.equal(locked.status,200);assert.equal(locked.body.ai,null);assert.equal(locked.body.work,null,'no owner data while locked');
  await a.login('a');
  const status=await a.request('/api/diagnostics');assert.equal(status.body.work.runs.error,1);assert.equal(status.body.work.interpretations.unknown,1);assert.equal(status.body.ai.blocked,true);
  const report=await a.request('/api/diagnostics/report','POST',{});assert.match(report.body.file,/^pma-report-[\d-TZ]+\.json$/);
  const text=fs.readFileSync(path.join(dir,report.body.file),'utf8')+JSON.stringify(status.body);
  for(const s of SENTINELS)assert.equal(text.includes(s),false,s);
  assert.equal(/[A-Za-z]:\\|\/Users\/|https?:\/\/|base64|\.jpg|\.png/.test(text),false,'no paths, URLs or images');
  assert.equal(f.store.get('run','run-a').query,SENTINELS[2],'source data untouched');
  assert.equal(fs.readdirSync(dir).length,1,'written only on request');
});

test('D8: without its own Figma listener the app prepares the snapshot but shows no pairing code',async t=>{
  let figma={available:false,reason:'Порт 8787 занят другим процессом'};
  const f=await httpFixture(t,{figmaStatus:()=>figma}),a=f.client();await a.login('a');
  const r=await a.request('/api/runs/run-a/export','POST',{});assert.equal(r.status,201);assert.equal(r.body.code,null);assert.match(r.body.figmaUnavailable,/занят/);
  assert.ok(f.store.get('selection',r.body.selectionId),'snapshot still fixed for Pinterest');
  figma={available:true,reason:null};
  const again=await a.request('/api/exports/'+r.body.id+'/figma-code','POST',{});assert.equal(again.status,201);assert.match(again.body.code,/^[A-Za-z0-9_-]{20,}$/);
});
