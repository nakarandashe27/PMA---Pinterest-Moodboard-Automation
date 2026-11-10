import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {httpFixture} from './support/http-fixture.mjs';
import {apiRequest,trustedSender,protocolTarget,reportRoute,externalPinUrl,OPERATIONS} from '../../desktop/ipc-policy.mjs';

const uuid='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
const ipcLogin=async(f,id,password='test-password-'+id)=>{const c=f.app.createIpcClient();const r=await c.request({method:'POST',route:'/api/active-connection',body:{id,password}});return {c,r};};

test('D4: every operation the UI uses is allowed, and nothing else reaches the worker',()=>{
  const used=[['GET','/api/bootstrap'],['POST','/api/active-connection'],['POST','/api/connections'],['POST',`/api/connections/${uuid}/open`],['POST',`/api/connections/${uuid}/check`],
    ['POST','/api/interpretations'],['GET','/api/interpretations/brief-'+hash],['POST','/api/interpretations/brief-'+hash+'/cancel'],['POST','/api/projects'],['GET','/api/projects/'+uuid],['GET',`/api/projects/${uuid}/interpretations`],
    ['POST','/api/uploads'],['POST','/api/runs'],...['cancel','resume','open-pinterest','export','replacements'].map(a=>['POST',`/api/runs/${uuid}/${a}`]),['POST',`/api/runs/${uuid}/replacements/apply`],['POST',`/api/runs/${uuid}/replacements/discard`],
    ['PUT',`/api/runs/${uuid}/selection`],['GET','/api/exports/figma-selection-'+hash],...['figma-new-attempt','figma-code','pinterest','pinterest-reconcile','pinterest-cancel','board'].map(a=>['POST','/api/exports/figma-selection-'+hash+'/'+a])];
  for(const [method,route] of used)assert.doesNotThrow(()=>apiRequest({method,route,...(method==='GET'?{}:{body:{}})}),method+' '+route);
  const denied=[['DELETE','/api/projects/'+uuid],['GET','/api/projects/'+uuid+'/../x'],['GET','/api/projects/%2e%2e'],['POST','/api/figma/claim'],['GET','/api/projects/'],['GET','/media/assets/'+hash+'.jpg'],
    ['POST','/api/runs/'+uuid+'/selection'],['GET','/api/projects/'+uuid+'?x=1'],['GET','/api/bootstrap/'],['GET','/api/projects/'+'a'.repeat(200)],['GET','file:///C:/Windows/win.ini']];
  for(const [method,route] of denied)assert.throws(()=>apiRequest({method,route,body:method==='GET'?undefined:{}}),/Операция недоступна|Некорректный/,method+' '+route);
  assert.throws(()=>apiRequest({method:'GET',route:'/api/bootstrap',body:{}}),/Лишнее/);
  assert.throws(()=>apiRequest({method:'POST',route:'/api/projects',body:[1]}),/JSON-объект/);
  assert.throws(()=>apiRequest({method:'POST',route:'/api/projects',body:'x'}),/JSON-объект/);
  assert.throws(()=>apiRequest({method:'POST',route:'/api/uploads',body:{imageBase64:'a'.repeat(36*1024*1024)}}),/слишком большой/);
  assert.throws(()=>apiRequest(null),/Некорректный/);
  assert.ok(OPERATIONS.every(o=>!o.pattern.source.includes('.*')));
});

test('D4: only the main frame of PMA’s own window showing app://pma may call the bridge',()=>{
  const mainFrame={url:'app://pma/'},wc={mainFrame};
  assert.equal(trustedSender({sender:wc,senderFrame:mainFrame},wc),true);
  assert.equal(trustedSender({sender:wc,senderFrame:{url:'app://pma/'}},wc),false,'subframe');
  assert.equal(trustedSender({sender:{mainFrame},senderFrame:mainFrame},wc),false,'other webContents');
  assert.equal(trustedSender({sender:wc,senderFrame:{...mainFrame}},wc),false);
  const remote={url:'https://www.pinterest.com/'},wc2={mainFrame:remote};
  assert.equal(trustedSender({sender:wc2,senderFrame:remote},wc2),false,'remote HTML');
  assert.equal(trustedSender({sender:wc,senderFrame:mainFrame},undefined),false);
});

test('D6: app:// serves only packaged UI or authorized media routes; links open only canonical pins',()=>{
  assert.deepEqual(protocolTarget('app://pma/'),{kind:'static',file:'index.html'});
  assert.deepEqual(protocolTarget('app://pma/assets/index-AbC_1.js'),{kind:'static',file:'assets/index-AbC_1.js'});
  assert.deepEqual(protocolTarget(`app://pma/media/assets/${hash}.jpg`),{kind:'media',route:`/media/assets/${hash}.jpg`});
  for(const url of ['app://pma/assets/..%2f..%2fserver%2fapp.mjs','app://pma/../package.json','app://pma/media/assets/../../pma.sqlite','app://pma/media/uploads/'+uuid+'?x','app://evil/index.html','file:///C:/x','app://pma/dist/index.html','app://pma/assets/%2e%2e%5capp.mjs',`app://pma/media/assets/${hash}.svg`])
    assert.equal(protocolTarget(url).kind,'deny',url);
  assert.equal(reportRoute('app://pma/evaluations/'+uuid),'/evaluations/'+uuid);assert.equal(reportRoute('app://pma/'),null);
  assert.equal(externalPinUrl('https://www.pinterest.com/pin/123/'),'https://www.pinterest.com/pin/123/');
  for(const url of ['http://www.pinterest.com/pin/1/','https://pinterest.com.evil.ru/pin/1/','https://www.pinterest.com/settings/','file:///C:/x','javascript:alert(1)','https://u:p@www.pinterest.com/pin/1/','https://www.pinterest.com/pin/1/?next=x'])assert.equal(externalPinUrl(url),null,url);
});

test('D5: HTTP and desktop IPC give the same owner/project/run/upload/export refusals',async t=>{
  const f=await httpFixture(t),http=f.client();await http.login('a');
  const exp=(await http.request('/api/runs/run-a/export','POST',{})).body;
  const cases=[['GET','/api/projects/project-a'],['GET','/api/projects/project-a/interpretations'],['PUT','/api/runs/run-a/selection',{ids:[]}],['POST','/api/runs/run-a/export',{}],['POST','/api/runs/run-a/resume',{}],
    ['GET','/api/exports/'+exp.id],['POST','/api/exports/'+exp.id+'/pinterest',{}],['POST','/api/uploads',{projectId:'project-a',name:'x',imageBase64:'/9j/'}],['POST','/api/runs',{projectId:'project-a',query:'x',entryKind:'ready'}],
    ['GET','/media/uploads/'+f.owners.a.uploadId],['GET','/media/assets/'+f.owners.a.item.asset]];
  // PMA has one unlocked owner at a time, so collect B's IPC answers first, then B's HTTP answers.
  const {c:ipcB}=await ipcLogin(f,'b'),viaIpc=[];
  for(const [method,route,body] of cases)viaIpc.push(await ipcB.request({method,route,body}));
  const created=await ipcB.request({method:'POST',route:'/api/projects',body:{name:'Mine',ownerConnectionId:'a'}});
  assert.equal(created.status,201);assert.equal(created.data.ownerConnectionId,'b','an owner named in the body is ignored');
  const httpB=f.client();await httpB.login('b');
  for(const [i,[method,route,body]] of cases.entries()){
    const viaHttp=await httpB.request(route,method,body);
    assert.equal(viaIpc[i].status,viaHttp.status,method+' '+route);assert.ok([403,404].includes(viaIpc[i].status),method+' '+route+' -> '+viaIpc[i].status);
    assert.equal(JSON.stringify(viaIpc[i].data||'').includes('Private a'),false);assert.equal(viaIpc[i].bytes,undefined);
  }
  // The HTTP login replaced the single session: the earlier IPC client is now locked out.
  assert.equal((await ipcB.request({method:'GET',route:'/api/projects/project-b'})).status,401);
  // A fresh IPC client never inherits a session; a wrong or missing password does not unlock it.
  const stranger=f.app.createIpcClient();
  assert.equal((await stranger.request({method:'GET',route:'/api/bootstrap'})).data.activeConnectionId,null);
  assert.equal((await stranger.request({method:'GET',route:'/api/projects/project-b'})).status,401);
  assert.equal((await stranger.request({method:'POST',route:'/api/active-connection',body:{id:'b',password:'wrong-password-b'}})).status,401);
  assert.equal((await stranger.request({method:'POST',route:'/api/active-connection',body:{id:'b'}})).status,401);
  assert.equal((await stranger.request({method:'POST',route:'/api/active-connection'})).status,415);
});

test('D6: IPC media is authorized before and after the read; a lock during the read returns nothing',async t=>{
  const f=await httpFixture(t),{c:a}=await ipcLogin(f,'a');
  const own=await a.request({method:'GET',route:'/media/assets/'+f.owners.a.item.asset});
  assert.equal(own.status,200);assert.deepEqual(Buffer.from(own.bytes),fs.readFileSync(f.root+'/assets/'+f.owners.a.item.asset));assert.equal(own.headers['Cache-Control'],'no-store');
  assert.equal((await a.request({method:'GET',route:'/media/assets/'+f.owners.b.item.asset})).status,404);
  assert.equal((await a.request({method:'GET',route:'/media/uploads/'+f.owners.b.uploadId})).status,403);
  const inFlight=a.request({method:'GET',route:'/media/assets/'+f.owners.a.item.asset});f.app.auth.lock();
  const late=await inFlight;assert.notEqual(late.status,200);assert.equal(late.bytes,undefined);
});

test('D7: a reply computed for A is not delivered after A→B, lock or expiry; B starts clean',async t=>{
  const f=await httpFixture(t);let release;const gate=new Promise(r=>{release=r;});
  f.pinterest.requireIdentity=async c=>{await gate;return c.username;};
  const {c:a}=await ipcLogin(f,'a');
  const slow=a.request({method:'POST',route:'/api/connections/a/check',body:{}});
  const {c:b}=await ipcLogin(f,'b');release();
  const late=await slow;assert.equal(late.status,401);assert.equal(late.data.username,undefined);
  assert.equal((await a.request({method:'GET',route:'/api/projects/project-a'})).status,401,'old A client has no session');
  assert.equal((await b.request({method:'GET',route:'/api/bootstrap'})).data.activeConnectionId,'b');
  // Slow read of A data, then lock: the reply is withheld.
  // A lock that lands while A's project is being read: the computed reply is withheld.
  const {c:a2}=await ipcLogin(f,'a'),original=f.store.list.bind(f.store);let locked=false;
  f.store.list=(...args)=>{if(args[0]==='evaluation'&&!locked){locked=true;f.app.auth.lock();}return original(...args);};
  const read=await a2.request({method:'GET',route:'/api/projects/project-a'});f.store.list=original;assert.ok(locked);
  assert.equal(read.status,401);assert.equal(JSON.stringify(read.data).includes('Private a'),false);
  // Expiry: 30 minutes are kept for IPC sessions too.
  const {c:a3}=await ipcLogin(f,'a');f.advance(30*60*1000+1);assert.equal((await a3.request({method:'GET',route:'/api/projects/project-a'})).status,401);
});
