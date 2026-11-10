import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {httpFixture} from './support/http-fixture.mjs';
import {vision,preparedResponse,catalog} from './support/interpretation-fixture.mjs';
import {PinterestAccessError} from '../pinterest-access.mjs';

async function browserFixture(t,invoke){
  const f=await httpFixture(t,{interpretationOptions:{catalog,invoke}}),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const a=f.client();await a.login('a');const [name,value]=a.cookie().split('=');await context.addCookies([{name,value,url:f.url,httpOnly:true,sameSite:'Strict'}]);
  let searched=null;f.pinterest.collect=async(connection,brief)=>{searched={connectionId:connection.id,mode:brief.mode,interpretation:brief.interpretation};throw new PinterestAccessError({kind:'login',message:'Test login stop'});};
  await page.goto(f.url);await page.getByRole('button',{name:'Изменить задание',exact:true}).waitFor();await page.locator('.project-header').getByRole('button',{name:'Новое задание',exact:true}).click();
  return {...f,page,errors,searched:()=>searched};
}
async function enterVision(page){await page.getByLabel('Опишите, что хотите увидеть').fill(vision);await page.getByRole('button',{name:'Подготовить поиск',exact:true}).click();}
async function screenshot(page,name){if(!process.env.PMA_QA_OUTPUT_DIR)return;await fs.mkdir(process.env.PMA_QA_OUTPUT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PMA_QA_OUTPUT_DIR,name)});}

test('compiled UI prepares a vision once, keeps human edits and starts only after confirmation',async t=>{
  let calls=0;const f=await browserFixture(t,async()=>{calls++;return {response:preparedResponse()};});await enterVision(f.page);
  await f.page.getByText(preparedResponse().summary,{exact:true}).waitFor();assert.equal(calls,1);assert.equal(f.store.list('run').length,2);assert.equal(f.searched(),null);
  await f.page.getByLabel('Поисковый запрос',{exact:true}).fill('камерный двор зелень тень');await f.page.getByRole('button',{name:'Назад',exact:true}).click();await f.page.getByRole('button',{name:'Подготовить поиск',exact:true}).click();
  assert.equal(await f.page.getByLabel('Поисковый запрос',{exact:true}).inputValue(),'камерный двор зелень тень');assert.equal(calls,1);
  await screenshot(f.page,'vision-review-desktop.png');await f.page.setViewportSize({width:390,height:844});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await screenshot(f.page,'vision-review-mobile.png');
  await f.page.getByRole('button',{name:'Запустить поиск',exact:true}).click();await f.page.getByText('Test login stop',{exact:true}).waitFor();
  assert.equal(f.searched().interpretation,'камерный двор зелень тень');const run=f.store.list('run').find(r=>r.query===vision);assert.equal(run.briefPreparation.summary,preparedResponse().summary);assert.equal(run.connectionId,'a');assert.deepEqual(f.errors,[]);
});

test('compiled UI offers direct ready-query and pin-link paths without inference',async t=>{
  let calls=0;const f=await browserFixture(t,async()=>{calls++;throw Error('must not invoke');});
  await f.page.getByLabel('У меня готов запрос',{exact:true}).check();await f.page.getByLabel('Поисковый запрос или ссылка на пин').fill('камерный двор');await f.page.getByRole('button',{name:'Проверить запрос',exact:true}).click();
  assert.equal(await f.page.getByLabel('Поисковый запрос',{exact:true}).inputValue(),'камерный двор');assert.equal(calls,0);assert.equal(f.store.list('interpretation').length,0);
  await f.page.getByRole('button',{name:'Назад',exact:true}).click();await f.page.getByLabel('Опишу замысел',{exact:true}).check();await f.page.getByLabel('Опишите, что хотите увидеть').fill('https://www.pinterest.com/pin/123/');await f.page.getByRole('button',{name:'Подготовить поиск',exact:true}).click();
  await f.page.getByText('Готовая ссылка — AI не потребовался',{exact:true}).waitFor();assert.equal(calls,0);assert.equal(f.store.list('ai-reservation').length,0);
});

test('compiled UI requires one clarification and discards a prepared result when the description changes',async t=>{
  let calls=0;const f=await browserFixture(t,async({prompt})=>{calls++;return {response:preparedResponse({clarification:prompt.includes('"answer":"Небольшой двор"')?'':'Какой масштаб пространства?'})};});
  await enterVision(f.page);await f.page.getByLabel('Какой масштаб пространства?').waitFor();assert.equal(await f.page.getByRole('button',{name:'Запустить поиск',exact:true}).isEnabled(),false);
  await f.page.getByLabel('Какой масштаб пространства?').fill('Небольшой двор');await f.page.getByRole('button',{name:'Учесть ответ',exact:true}).click();await f.page.getByLabel('Поисковый запрос',{exact:true}).waitFor();assert.equal(calls,2);assert.equal(await f.page.getByRole('button',{name:'Запустить поиск',exact:true}).isEnabled(),true);
  await f.page.getByRole('button',{name:'Назад',exact:true}).click();await f.page.getByLabel('Опишите, что хотите увидеть').fill('Совсем другое описание');assert.equal(await f.page.getByText(preparedResponse().summary,{exact:true}).count(),0);assert.equal(f.store.list('run').length,2);
});

test('compiled UI retains the description after an unknown result and offers an explicit manual path',async t=>{
  let calls=0;const f=await browserFixture(t,async()=>{calls++;throw Error('Unknown response');});await enterVision(f.page);await f.page.getByRole('alert').filter({hasText:'Результат AI-вызова не подтверждён'}).waitFor();
  assert.equal(await f.page.getByRole('button',{name:'Запустить поиск',exact:true}).isEnabled(),false);await f.page.getByRole('button',{name:'Задать запрос вручную',exact:true}).click();await f.page.getByLabel('Поисковый запрос',{exact:true}).fill('зелёный двор');
  await f.page.getByRole('button',{name:'Запустить поиск',exact:true}).click();await f.page.getByText('Test login stop',{exact:true}).waitFor();assert.equal(calls,1);assert.equal(f.searched().interpretation,'зелёный двор');assert.equal(f.store.list('ai-reservation').length,1);
});

test('closing preparation cancels its worker and prevents late UI output',async t=>{
  let began;const started=new Promise(resolve=>{began=resolve;});const f=await browserFixture(t,async({signal})=>{began();await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});return {response:preparedResponse()};});
  await enterVision(f.page);await started;await f.page.getByRole('button',{name:'Закрыть',exact:true}).click();await f.page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  for(let i=0;i<50&&f.store.list('interpretation')[0]?.status!=='cancelled';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.store.list('interpretation')[0].status,'cancelled');assert.equal(f.store.list('interpretation')[0].result,undefined);assert.equal(f.store.list('ai-reservation').length,1);
});

test('pure Lens keeps the photo path and skips text preparation when image ranking is off',async t=>{
  let calls=0;const f=await browserFixture(t,async()=>{calls++;throw Error('must remain off');});await f.page.getByRole('button',{name:'Закрыть',exact:true}).click();await f.page.getByRole('button',{name:'Изменить задание',exact:true}).click();
  await f.page.getByLabel('Первое изображение · Pinterest Lens',{exact:true}).check();await f.page.getByRole('button',{name:'Проверить запрос',exact:true}).click();await f.page.getByText('Первичный поиск — Pinterest Lens',{exact:true}).waitFor();
  assert.equal(await f.page.getByLabel('Поисковый запрос',{exact:true}).count(),0);assert.equal(calls,0);assert.equal(f.store.list('ai-reservation').length,0);
});

test('the saved owned description restores its ready result after closing without another inference',async t=>{
  let calls=0;const f=await browserFixture(t,async()=>{calls++;return {response:preparedResponse()};});await enterVision(f.page);await f.page.getByText(preparedResponse().summary,{exact:true}).waitFor();await f.page.getByRole('button',{name:'Закрыть',exact:true}).click();
  await f.page.locator('.project-header').getByRole('button',{name:'Новое задание',exact:true}).click();await f.page.getByText('Сохранённые описания',{exact:true}).click();await f.page.locator('.saved-interpretations button').filter({hasText:vision}).click();
  await f.page.getByText(preparedResponse().summary,{exact:true}).waitFor();assert.equal(calls,1);assert.equal(await f.page.getByLabel('Поисковый запрос',{exact:true}).inputValue(),preparedResponse().searchQuery);assert.equal(f.store.list('ai-reservation').length,1);
});
