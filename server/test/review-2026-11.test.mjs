// Regression checks for defects found in the 2026-11 independent review (docs/review-2026-11.md).
// Each test failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import {httpFixture} from './support/http-fixture.mjs';
import {Ledger} from '../ledger.mjs';
import {checkEndpoint,publicAddress} from '../ai-endpoint.mjs';
import {layout,ensureLayout,acquireInstanceLock} from '../data-root.mjs';
import {protocolTarget,reportRoute} from '../../desktop/ipc-policy.mjs';

test('R1: with a lost ledger the AI settings view still answers and shows the block; paid AI stays closed',async t=>{
  const calls=[],vault={get:async()=>'sk-test-AAAAAAAAAAAAAAAAAAAA',put:async()=>{},delete:async()=>{}};
  const f=await httpFixture(t,{vault,aiPost:async(...args)=>{calls.push(args);return {status:500,data:null};},aiExecutor:()=>({})});
  f.store.save('ledger-binding',{id:'ledger-binding',ledgerId:'lost',seq:3});
  const accounting=fs.mkdtempSync(path.join(os.tmpdir(),'pma-review-ledger-'));t.after(()=>fs.rmSync(accounting,{recursive:true,force:true}));
  f.store.ledger=new Ledger(accounting,f.store);assert.match(f.store.ledger.blocked,/не найден/);
  const a=f.client();await a.login('a');
  const view=await a.request('/api/ai/profile');
  assert.equal(view.status,200);assert.match(view.body.ledgerBlocked,/не найден/);assert.equal(view.body.month.poolCalls,0);assert.deepEqual(view.body.month.spend,[]);
  assert.equal(calls.length,0);assert.equal(fs.existsSync(path.join(accounting,'ledger.sqlite')),false,'no empty counter appears');
});

test('R2: IPv4-mapped IPv6 in the WHATWG hex form and site-local IPv6 are not public API addresses',()=>{
  for(const ip of ['::ffff:7f00:1','::ffff:a00:1','::ffff:c0a8:101','::ffff:a9fe:a9fe','fec0::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('::ffff:808:808'),true,'mapped public IPv4 stays public');
  for(const bad of ['https://[::ffff:127.0.0.1]/v1','https://[::ffff:7f00:1]:8443/v1','https://[::ffff:169.254.169.254]/latest','https://[fec0::1]/v1'])assert.throws(()=>checkEndpoint(bad),/запрещены/,bad);
});

test('R3: malformed percent-encoding in app:// is refused instead of throwing',()=>{
  for(const url of ['app://pma/%E0%A4%A','app://pma/evaluations/%','app://pma/assets/%ZZ']){
    assert.deepEqual(protocolTarget(url),{kind:'deny'},url);assert.equal(reportRoute(url),null,url);
  }
});

test('R4: the operator tool reports a busy data folder in one line, without a stack trace',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-review-data-'));
  const lock=acquireInstanceLock(ensureLayout(layout(root)).root);
  t.after(()=>{lock.release();assert.ok(path.basename(root).startsWith('pma-review-data-'));fs.rmSync(root,{recursive:true,force:true});});
  const r=spawnSync(process.execPath,['scripts/pma-data.mjs','status'],{env:{...process.env,PMA_DESKTOP_ROOT:root},encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stderr,/уже открыта другим процессом PMA/);assert.doesNotMatch(r.stderr,/\n\s+at |AppError|node:internal/);
});

test('R6: an HTTP body that is not a JSON object gets 400, like desktop IPC, never a 500',async t=>{
  const f=await httpFixture(t),a=f.client();await a.request('/api/bootstrap');
  for(const body of [null,[],7,'x'])assert.equal((await a.request('/api/active-connection','POST',body)).status,400,JSON.stringify(body));
  await a.login('a');
  for(const [route,method] of [['/api/runs/run-a/selection','PUT'],['/api/projects','POST'],['/api/uploads','POST']])assert.equal((await a.request(route,method,null)).status,400,route);
});

test('R5: dialogs keep a draft on a click in their own padding or a drag-out; named dialog; contrast; filter buttons',async t=>{
  const f=await httpFixture(t),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:820}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.url);await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Подключение Pinterest'});await dialog.waitFor();
  const name=page.getByLabel('Название нового подключения');await name.fill('Черновик');
  const box=await dialog.boundingBox(),field=await name.boundingBox();
  // Inside the dialog, in its 26px padding.
  await page.mouse.click(box.x+8,field.y+field.height/2);
  assert.equal(await dialog.isVisible(),true,'padding click keeps the dialog');
  // Text selection that starts in the field and ends on the backdrop.
  await page.mouse.move(field.x+field.width-10,field.y+field.height/2);await page.mouse.down();await page.mouse.move(box.x-120,field.y+field.height/2,{steps:5});await page.mouse.up();
  assert.equal(await dialog.isVisible(),true,'drag-out keeps the dialog');assert.equal(await name.inputValue(),'Черновик');
  // A real backdrop click still closes.
  await page.mouse.click(box.x-120,box.y+20);await dialog.waitFor({state:'hidden'});
  // Login, then check the image filter buttons and colour contrast of muted text and focus rings.
  await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).click();
  await page.locator('.connection-list > div').filter({hasText:'Test a'}).getByRole('button',{name:'Открыть',exact:true}).click();
  await page.getByLabel('Локальный пароль PMA',{exact:true}).fill('test-password-a');await page.getByRole('button',{name:'Открыть свои проекты'}).click();
  const group=page.getByRole('group',{name:'Показать изображения'});await group.waitFor();
  assert.equal(await page.getByRole('tab').count(),0,'no tab roles without tab panels');
  assert.equal(await group.getByRole('button',{name:/^Все/}).getAttribute('aria-pressed'),'true');
  await group.getByRole('button',{name:/^Выбранные/}).click();assert.equal(await group.getByRole('button',{name:/^Выбранные/}).getAttribute('aria-pressed'),'true');
  const ratios=await page.evaluate(()=>{
    const rgb=c=>c.match(/[\d.]+/g).slice(0,3).map(Number),lum=c=>{const [r,g,b]=rgb(c).map(v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
    const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
    const rule=[...document.styleSheets].flatMap(s=>[...s.cssRules]).find(r=>r.selectorText?.startsWith('button:focus-visible'));const ring=rule.style.outlineColor;
    const canvas=getComputedStyle(document.body).backgroundColor,muted=getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    const sample=document.createElement('span');sample.style.color=muted;document.body.append(sample);const mutedRgb=getComputedStyle(sample).color;sample.remove();
    return {muted:ratio(mutedRgb,canvas),mutedOnWhite:ratio(mutedRgb,'rgb(255,255,255)'),ring:ratio(ring,'rgb(255,255,255)'),subtitle:ratio(getComputedStyle(document.querySelector('.subtitle')).color,canvas)};
  });
  assert.ok(ratios.muted>=4.5&&ratios.mutedOnWhite>=4.5,'muted text '+JSON.stringify(ratios));assert.ok(ratios.subtitle>=4.5,'subtitle '+ratios.subtitle);assert.ok(ratios.ring>=3,'focus ring '+ratios.ring);
  assert.deepEqual(errors,[]);
});
