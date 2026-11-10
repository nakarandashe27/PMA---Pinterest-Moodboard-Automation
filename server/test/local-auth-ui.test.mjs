import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {httpFixture} from './support/http-fixture.mjs';

test('built UI unlocks by password, switches owners and clears private screens in both tabs on lock',async t=>{
  const f=await httpFixture(t),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage(),errors=[],responses=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/'))responses.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.goto(f.url);await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).click();
  await page.locator('.connection-list > div').filter({hasText:'Test a'}).getByRole('button',{name:'Открыть',exact:true}).click();await page.getByLabel('Локальный пароль PMA',{exact:true}).fill('wrong');await page.getByRole('button',{name:'Открыть свои проекты'}).click();
  await page.getByRole('alert').filter({hasText:'Неверный локальный пароль'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Private a',exact:true}).count(),0);
  await page.getByLabel('Локальный пароль PMA',{exact:true}).fill('test-password-a');await page.getByRole('button',{name:'Открыть свои проекты'}).click();
  await page.getByRole('button',{name:'Private a',exact:true}).waitFor({timeout:5000}).catch(async e=>{t.diagnostic(JSON.stringify({errors,responses,body:await page.locator('body').innerText()}));throw e;});assert.equal(await page.getByRole('button',{name:'Private b',exact:true}).count(),0);
  await page.getByRole('button',{name:'Управление подключением Pinterest'}).click();await page.getByRole('button',{name:'Открыть',exact:true}).click();
  await page.getByLabel('Локальный пароль PMA',{exact:true}).fill('test-password-b');await page.getByRole('button',{name:'Открыть свои проекты'}).click();
  await page.getByRole('button',{name:'Private b',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Private a',exact:true}).count(),0);
  const second=await context.newPage();await second.goto(f.url);await second.getByRole('button',{name:'Private b',exact:true}).waitFor();
  await page.getByRole('button',{name:'Управление подключением Pinterest'}).click();await page.getByRole('button',{name:'Заблокировать PMA и закрыть Chrome'}).click();
  await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).waitFor();await second.getByRole('button',{name:'Открыть своё подключение',exact:true}).waitFor();
  assert.equal(await second.getByRole('button',{name:'Private b',exact:true}).count(),0);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await fs.mkdir(path.resolve('output/playwright/g2'),{recursive:true});await page.screenshot({path:path.resolve('output/playwright/g2/local-lock-mobile.png')});
});

test('a new connection keeps the manual Pinterest login step and never reveals the local password',async t=>{
  const f=await httpFixture(t),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();f.pinterest.requireIdentity=async()=> 'new_test_user';
  await page.goto(f.url);await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).click();
  await page.getByLabel('Название нового подключения').fill('New test profile');await page.getByLabel('Новый локальный пароль PMA',{exact:true}).fill('new-test-password');await page.getByLabel('Повторите пароль').fill('new-test-password');
  await page.getByRole('button',{name:'Создать подключение',exact:true}).click();await page.getByRole('heading',{name:'Войдите в открытом Chrome'}).waitFor();
  const connection=f.store.list('connection').find(c=>c.label==='New test profile');assert.ok(connection);assert.deepEqual(f.opened,[connection.id]);assert.ok(!JSON.stringify(f.store.get('local-credential','local-password-'+connection.id)).includes('new-test-password'));
  await page.getByRole('button',{name:'Я вошёл — проверить подключение'}).click();await page.getByRole('button',{name:'Управление подключением Pinterest'}).waitFor();await page.getByText('@new_test_user',{exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByRole('button',{name:'Private a',exact:true}).count(),0);
});

test('a browser network failure preserves one connection and offers a retry in the same profile',async t=>{
  const f=await httpFixture(t),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  let calls=0;const opened=[];f.pinterest.open=async c=>{calls++;opened.push(c.id);if(calls===1)throw Error('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://www.pinterest.com/');};
  await page.goto(f.url);await page.getByRole('button',{name:'Открыть своё подключение',exact:true}).click();
  await page.getByLabel('Название нового подключения').fill('Recover existing connection');await page.getByLabel('Новый локальный пароль PMA',{exact:true}).fill('new-test-password');await page.getByLabel('Повторите пароль').fill('new-test-password');
  await page.getByRole('button',{name:'Создать подключение',exact:true}).click();await page.getByRole('heading',{name:'Подключение сохранено',exact:true}).waitFor();
  await page.getByRole('alert').filter({hasText:'сетевой доступ'}).waitFor();assert.equal(await page.getByRole('button',{name:'Я вошёл — проверить подключение'}).isEnabled(),false);
  assert.equal(f.store.list('connection').length,3);assert.equal(f.store.list('local-credential').length,3);
  await page.getByRole('button',{name:'Открыть Pinterest снова',exact:true}).click();await page.getByRole('heading',{name:'Войдите в открытом Chrome'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Я вошёл — проверить подключение'}).isEnabled(),true);assert.equal(f.store.list('connection').length,3);assert.equal(opened.length,2);assert.equal(opened[0],opened[1]);
});
