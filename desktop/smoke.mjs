// Desktop smoke check on artificial data: real Electron, real utilityProcess, packaged UI from dist/.
// No Pinterest, no AI. Run: npm run desktop:smoke
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {_electron} from 'playwright';
import net from 'node:net';
import {Store} from '../server/store.mjs';
import {setLocalPassword} from '../server/local-auth.mjs';
import {sha256} from '../server/domain.mjs';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {acquireInstanceLock,listBackups,layout,SCHEMA_VERSION} from '../server/data-root.mjs';
import {managedChromePids} from './process-tree.mjs';
import {execFileSync} from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url)),electronPath=createRequire(import.meta.url)('electron');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-desktop-smoke-')),data=path.join(root,'data');
// A real 1x1 PNG per owner, so the renderer can tell a decoded image from a refusal.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
const store=new Store(data),assets={};
for(const id of ['a','b']){
  store.save('connection',{id,label:'Test '+id,username:'test_'+id,status:'ready'});await setLocalPassword(store,id,'test-password-'+id);
  store.save('project',{id:'project-'+id,name:'Private '+id,ownerConnectionId:id,createdAt:new Date().toISOString()});
  const bytes=Buffer.concat([png,Buffer.from(id)]),hash=sha256(bytes),asset=hash+'.png';assets[id]=asset;
  fs.mkdirSync(path.join(data,'assets'),{recursive:true});fs.writeFileSync(path.join(data,'assets',asset),bytes);
  const item={id:'candidate-'+id,pinId:id==='a'?'111':'222',pinUrl:'https://www.pinterest.com/pin/'+(id==='a'?'111':'222')+'/',asset,sha256:hash,altText:'Test',imageUrl:'https://i.pinimg.com/474x/aa/bb/cc/'+hash.slice(0,32)+'.png'};
  store.save('run',{id:'run-'+id,projectId:'project-'+id,connectionId:id,query:'Test '+id,title:'Test '+id,sourceKind:'live',status:'ready',createdAt:new Date().toISOString(),candidates:[item],selectedIds:[item.id],uploads:[]},'project-'+id);
}
const evaluationId='33333333-3333-4333-8333-333333333333';
store.save('evaluation',{id:evaluationId,projectId:'project-a',connectionId:'a',status:'ready',model:'test',selectedCounts:{photoText:0},candidates:[],sourceRunIds:['run-a']},'project-a');
fs.mkdirSync(path.join(data,'evaluations',evaluationId),{recursive:true});fs.writeFileSync(path.join(data,'evaluations',evaluationId,'report.html'),'<title>Report</title><p id="r">Private report A</p>');
store.close();

// A free port for the Figma listener, so the check never touches a running prototype on 8787.
const figmaPort=await new Promise(resolve=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
// PMA_SMOKE_EXE=<installed PMA.exe> runs the same checks against the installed package, with no Node/npm on PATH.
const packagedExe=process.env.PMA_SMOKE_EXE||null,appArgs=packagedExe?[]:[path.join(here,'main.mjs')],appExe=packagedExe||electronPath;
const cleanPath=(process.env.PATH||'').split(';').filter(p=>p&&!/nodejs|\npm|node_modules|codex/i.test(p)).join(';');
const launchEnv={...process.env,PMA_DESKTOP_ROOT:root,PMA_FIGMA_PORT:String(figmaPort),PMA_TEST_PINTEREST:'hang',PMA_TEST_CODEX:'none',...(packagedExe?{PATH:cleanPath}:{})};
if(packagedExe)console.log('Installed package:',packagedExe);
const launch=()=>_electron.launch({executablePath:appExe,args:appArgs,env:launchEnv});
const app=await launch();
const results=[];const ok=(name,detail='')=>{results.push(name);console.log('✓',name,detail);};
try{
  const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');
  assert.equal(new URL(page.url()).protocol,'app:');ok('window loads packaged UI',page.url());
  assert.equal((await page.evaluate(()=>window.pma.api('GET','/api/bootstrap'))).status,200);
  const db=new DatabaseSync(path.join(data,'pma.sqlite'),{readOnly:true});const version=db.prepare('PRAGMA user_version').get().user_version;db.close();
  assert.equal(version,SCHEMA_VERSION);assert.equal(listBackups(layout(root)).length,1);assert.ok(fs.existsSync(path.join(root,'accounting','ledger.sqlite')));ok('prototype-shaped data migrated after a backup; ledger created','schema '+version);
  assert.throws(()=>acquireInstanceLock(root),/уже открыта/);ok('data root locked against other processes');
  const pluginDir=path.join(root,'integrations','figma-plugin');for(const name of ['manifest.json','code.js','ui.html'])assert.deepEqual(fs.readFileSync(path.join(pluginDir,name)),fs.readFileSync(path.join(here,'..','spikes','figma-g1','plugin',name)));
  assert.match(fs.readFileSync(path.join(pluginDir,'ui.html'),'utf8'),/\?protocol=2/);ok('Figma plugin copied to the stable folder, protocol 2');
  const diag=(await page.evaluate(()=>window.pma.api('GET','/api/diagnostics'))).data;assert.equal(diag.figma.bridge,'listening');assert.equal(diag.figma.pluginFolderReady,true);assert.equal(diag.session.unlocked,false);ok('diagnostics available while locked, without owner data');
  const second=spawn(appExe,appArgs,{env:launchEnv}),t0=Date.now();
  await new Promise((resolve,reject)=>{second.once('exit',resolve);setTimeout(()=>reject(Error('second instance kept running')),15000);});
  assert.equal(app.windows().length,1);ok('second launch exits and leaves one window',(Date.now()-t0)+'ms');
  const env=await page.evaluate(()=>({pma:typeof window.pma,keys:Object.keys(window.pma||{}),require:typeof window.require,process:typeof window.process,ipc:typeof window.ipcRenderer}));
  assert.deepEqual(env,{pma:'object',keys:['version','api','reveal'],require:'undefined',process:'undefined',ipc:'undefined'});ok('renderer has only the fixed bridge',JSON.stringify(env.keys));
  const call=(m,r,b)=>page.evaluate(([m,r,b])=>window.pma.api(m,r,b),[m,r,b]);
  assert.equal((await call('GET','/api/bootstrap')).data.activeConnectionId,null);ok('starts locked');
  for(const [m,r,b] of [['DELETE','/api/projects/project-a'],['GET','/api/projects/../../x'],['POST','/api/figma/claim',{}],['GET','/media/assets/'+assets.a],['GET','/api/bootstrap',{}]])assert.equal((await call(m,r,b)).status,400,m+' '+r);
  ok('main rejects operations outside the allowlist');
  assert.equal((await call('GET','/api/projects/project-a')).status,401);
  const reloaded=()=>page.waitForEvent('load',{timeout:15000});
  let next=reloaded();assert.equal((await call('POST','/api/active-connection',{id:'a',password:'test-password-a'})).status,200);ok('unlock A through IPC');
  await next;await page.getByText('Private a').first().waitFor({timeout:15000});ok('UI shows A project after unlock');
  const image=src=>page.evaluate(src=>new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(img.naturalWidth);img.onerror=()=>resolve('error');img.src=src;}),src);
  assert.equal(await image('/media/assets/'+assets.a),1);assert.equal(await image('/media/assets/'+assets.b),'error');ok('app:// media: own image decodes, foreign is refused');
  assert.equal((await call('GET','/api/projects/project-b')).status,403);ok('A cannot read B project');
  // AI settings with the real DPAPI vault: no network, no paid call.
  await page.getByRole('button',{name:'Настройки AI'}).click();await page.getByRole('heading',{name:'Настройки AI'}).waitFor();await page.getByRole('button',{name:'Закрыть'}).last().click();
  const key='sk-smoke-0123456789abcdef-WXYZ',aiProfile={baseUrl:'https://api.example-ai.test/v1',wireFormat:'responses',model:'m1',images:{supported:true,maxPerRequest:10,maxInputTokensPerImage:1000},limits:{maxOutputTokens:1000},tariff:{currency:'USD',inputPerMillion:1,outputPerMillion:2,outputLimitCoversReasoning:true,checkedAt:'2026-11-09'},budget:{monthlyLimit:1,monthlyCalls:100}};
  assert.equal((await call('PUT','/api/ai/profile',aiProfile)).status,200);
  const saved=await call('PUT','/api/ai/key',{key});assert.equal(saved.status,200);assert.equal(saved.data.keyHint,'…WXYZ');assert.equal(JSON.stringify(saved.data).includes(key),false);
  const secretFiles=fs.readdirSync(path.join(root,'secrets'));assert.equal(secretFiles.length,1);
  const sealed=fs.readFileSync(path.join(root,'secrets',secretFiles[0]));assert.equal(sealed.includes(Buffer.from(key)),false);assert.equal(sealed.includes(Buffer.from('WXYZ')),false);
  const everything=JSON.stringify([await call('GET','/api/ai/profile'),await call('GET','/api/bootstrap'),await call('GET','/api/projects/project-a')]);assert.equal(everything.includes(key),false);
  const dbText=fs.readFileSync(path.join(data,'pma.sqlite')).toString('latin1')+(fs.existsSync(path.join(data,'pma.sqlite-wal'))?fs.readFileSync(path.join(data,'pma.sqlite-wal')).toString('latin1'):'');assert.equal(dbText.includes(key),false);
  ok('AI key sealed by Windows DPAPI, shown only as …WXYZ, absent from the database and replies');
  assert.equal((await call('POST','/api/ai/key/delete',{})).data.keyConfigured,false);assert.deepEqual(fs.readdirSync(path.join(root,'secrets')),[]);ok('AI key deleted from the vault');
  // Subscription mode in the UI; PMA_TEST_CODEX=none stands for a PC without Codex, so no real Codex runs.
  await page.getByRole('button',{name:'Настройки AI'}).click();await page.getByLabel('Подписка ChatGPT (Codex)').click();
  await page.getByText('Codex: не найден на этом компьютере').waitFor();assert.equal(await page.getByRole('button',{name:'Проверить'}).isDisabled(),true);
  assert.equal((await call('POST','/api/ai/codex/probe',{})).status,409);
  await page.getByLabel('Свой API-ключ').click();await page.getByText('Адрес API (HTTPS)').waitFor();await page.getByRole('button',{name:'Закрыть'}).last().click();
  ok('AI mode: missing Codex is explained, its check is closed, API mode comes back');
  const reportOpened=app.waitForEvent('window');await page.evaluate(id=>window.open('/evaluations/'+id),evaluationId);const report=await reportOpened;await report.waitForLoadState('domcontentloaded');
  assert.equal(await report.textContent('#r'),'Private report A');assert.equal(await report.evaluate(()=>typeof window.pma),'undefined');ok('AI report opens in its own window without the bridge');
  assert.equal(await page.evaluate(()=>{window.open('https://example.com/');window.open('file:///C:/Windows/win.ini');return 1;}),1);await new Promise(r=>setTimeout(r,500));assert.equal(app.windows().length,2);ok('other window.open targets are denied');
  const loopback=async route=>{try{return (await fetch('http://127.0.0.1:'+figmaPort+route)).status;}catch{return 'closed';}};
  const oldPlugin=await loopback('/api/figma/package');assert.equal(oldPlugin,426);const figma=await loopback('/api/figma/package?protocol=2'),ui=await loopback('/api/bootstrap'),media=await loopback('/media/assets/'+assets.a),index=await loopback('/');
  assert.equal(figma,401);assert.deepEqual([ui,media,index],[404,404,404]);ok('loopback listener serves Figma only','plugin without protocol=426, figma=401, bootstrap/media/ui=404');
  next=reloaded();assert.equal((await call('POST','/api/active-connection',{id:null})).status,200);await next;
  assert.equal(report.isClosed(),true);
  assert.equal(await page.getByText('Private a').count(),0);assert.equal(await image('/media/assets/'+assets.a),'error');ok('lock reloads the window: no A project, cached media dropped');
  const pid=app.process().pid,closed=new Promise(resolve=>app.process().once('exit',resolve)),started=Date.now();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;ok('window close exits',(Date.now()-started)+'ms, pid '+pid);
}finally{
  try{await app.close();}catch{}
}

// Lifecycle with a real managed Chrome (PMA profile, headless, never opens Pinterest).
const until=async(check,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,300));}return false;};
async function startSearch(){
  const instance=await launch(),page=await instance.firstWindow();await page.waitForLoadState('domcontentloaded');
  await until(async()=>(await page.evaluate(()=>window.pma.api('GET','/api/bootstrap'))).status===200);
  await page.evaluate(()=>window.pma.api('POST','/api/active-connection',{id:'a',password:'test-password-a'}));await page.waitForLoadState('domcontentloaded');
  await until(async()=>{try{return (await page.evaluate(()=>window.pma.api('GET','/api/bootstrap'))).data.activeConnectionId==='a';}catch{return false;}});
  const run=await page.evaluate(()=>window.pma.api('POST','/api/runs',{projectId:'project-a',query:'lifecycle test',entryKind:'ready'}));assert.equal(run.status,202,JSON.stringify(run.data));
  assert.ok(await until(async()=>(await managedChromePids(root)).length>0),'managed Chrome started');
  return {instance,page,runId:run.data.id};
}
const runStatus=id=>{const db=new DatabaseSync(path.join(data,'pma.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare("SELECT data FROM documents WHERE id=?").get(id).data).status;}finally{db.close();}};
const childPids=pid=>execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { '' + $_.ProcessId + ' ' + $_.CommandLine }`],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);
// Playwright starts Electron through a launcher process: the real main is its child, the backend is main's child.
const realMain=instance=>{const p=instance.process().pid;const line=childPids(p).find(l=>!l.includes('--type='));return line?Number(line.split(' ')[0]):p;};
try{
  // D10: the window cross during a search.
  {const {instance,runId}=await startSearch(),proc=instance.process(),gone=new Promise(r=>proc.once('exit',r)),t0=Date.now();
   await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await gone;const ms=Date.now()-t0;
   assert.ok(ms<=15000,'exit took '+ms+'ms');assert.equal((await managedChromePids(root)).length,0);assert.equal(runStatus(runId),'interrupted');
   ok('D10: closing during a search exits without PMA Chrome; the search is resumable',ms+'ms');}
  // D11a: the backend dies.
  {const {instance,runId}=await startSearch(),proc=instance.process(),gone=new Promise(r=>proc.once('exit',r));
   const worker=childPids(realMain(instance)).find(l=>l.includes('node.mojom.NodeService'));assert.ok(worker,'backend utility process found');
   execFileSync('taskkill.exe',['/PID',worker.split(' ')[0],'/F']);await gone;
   assert.equal((await managedChromePids(root)).length,0);assert.equal(runStatus(runId),'searching','crash leaves the last checkpoint; recovery marks it on start');
   ok('D11: backend crash ends PMA Chrome, the app closes, data readable');}
  // D11b: main dies; the next start removes the orphaned PMA Chrome before opening data.
  {const {instance}=await startSearch(),proc=instance.process(),gone=new Promise(r=>proc.once('exit',r));
   const mainPid=realMain(instance);execFileSync('taskkill.exe',['/PID',String(mainPid),'/F']);
   await Promise.race([gone,new Promise(r=>setTimeout(r,5000))]);try{execFileSync('taskkill.exe',['/PID',String(proc.pid),'/F'],{stdio:'ignore'});}catch{}
   await until(async()=>!childPids(mainPid).length,5000);
   const next=await launch(),page=await next.firstWindow();await page.waitForLoadState('domcontentloaded');
   assert.ok(await until(async()=>(await managedChromePids(root)).length===0),'orphaned PMA Chrome removed on start');
   await until(async()=>(await page.evaluate(()=>window.pma.api('GET','/api/bootstrap'))).status===200);
   const statuses=JSON.parse(execFileSync(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(db.prepare("SELECT data FROM documents WHERE kind='run'").all().map(r=>JSON.parse(r.data).status)))`,path.join(data,'pma.sqlite')],{encoding:'utf8'}));
   assert.equal(statuses.filter(s=>['queued','searching','downloading','ranking'].includes(s)).length,0,'no search restarts by itself');
   const closed=new Promise(r=>next.process().once('exit',r));await next.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;
   ok('D11: after a main crash the next start cleans PMA Chrome first; nothing resumes on its own',JSON.stringify(statuses));}
}finally{
  // Processes ended a moment ago may still release file handles.
  for(let i=0;i<20;i++){try{fs.rmSync(root,{recursive:true,force:true});break;}catch{await new Promise(r=>setTimeout(r,500));}}
}
console.log(results.length+' desktop smoke checks passed');
