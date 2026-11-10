import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {sha256Bytes} from '../../spikes/figma-g1/sha256.mjs';
import vm from 'node:vm';

test('sandbox SHA-256 matches standard vectors and Node across padding boundaries',()=>{
  const bytes=new TextEncoder();
  assert.equal(sha256Bytes(bytes.encode('')),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Bytes(bytes.encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Bytes(bytes.encode('a'.repeat(1000000))),'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  for(const size of [1,55,56,63,64,65,119,120,128,1024,16384]){const value=randomBytes(size);assert.equal(sha256Bytes(value),createHash('sha256').update(value).digest('hex'));}
  const unicode=bytes.encode('Японский сад 🌱');assert.equal(sha256Bytes(unicode),createHash('sha256').update(unicode).digest('hex'));
});

test('built plugin UI verifies files without Web Crypto and rejects changed bytes before native inspection',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const html=await fs.readFile('spikes/figma-g1/plugin/ui.html','utf8');
  assert.ok(html.includes(sha256Bytes.toString()),'rebuild the generated plugin UI');
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1cAAAAASUVORK5CYII=','base64');
  for(const mode of ['valid','changed','relayed','synthetic'])await t.test(mode,async()=>{
    const changed=mode==='changed';
    const page=await browser.newPage();
    const payload={pmaPackageVersion:2,name:'Проверка снимка',pins:[{pinId:'123',pinUrl:'https://www.pinterest.com/pin/123/',imageBase64:bytes.toString('base64'),assetSha256:changed?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')}]};
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname==='localhost')return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type'},body:JSON.stringify(payload)});
      if(url.pathname==='/plugin')return route.fulfill({contentType:'text/html',body:html.replace('<script>','<script>Object.defineProperty(globalThis,"crypto",{value:undefined});')});
      if(url.pathname==='/relay')return route.fulfill({contentType:'text/html',body:'<!doctype html><iframe src="/plugin"></iframe><script>addEventListener("message",e=>parent.postMessage(e.data,"*"));</script>'});
      const target=mode==='relayed'?'document.querySelector("iframe").contentWindow.frames[0]':'e.source';
      const response='const response={pluginMessage:{requestId:m.requestId,channel:m.channel,result:{documentId:"fixture_document_12345",fileName:"Fixture",status:"absent",frameId:null}}};';
      const deliver=mode==='synthetic'?'value=>e.source.dispatchEvent(new MessageEvent("message",{data:value,source:null}))':'value=>'+target+'.postMessage(value,"*")';
      return route.fulfill({contentType:'text/html',body:'<!doctype html><iframe src="/'+(mode==='relayed'?'relay':'plugin')+'"></iframe><script>window.inspections=0;addEventListener("message",e=>{const m=e.data.pluginMessage;if(m?.type==="inspect-pma"){window.inspections++;'+response+'const send='+deliver+';send({pluginMessage:{...response.pluginMessage,channel:"other-channel",result:{status:"conflict",message:"Unrelated response"}}});send(response);}});</script>'});
    });
    await page.goto('http://pma-plugin-fixture.test/');
    const outer=page.frameLocator('iframe'),frame=mode==='relayed'?outer.frameLocator('iframe'):outer;await frame.getByLabel('Код подключения из PMA').fill('fixture-code');await frame.getByRole('button',{name:'Загрузить и сверить подборку',exact:true}).click();
    await frame.locator('#status').filter({hasText:changed?'Файл изображения не совпал со снимком PMA':'Можно создать отдельный фрейм.'}).waitFor({timeout:2000});
    assert.equal(await frame.getByRole('button',{name:'Создать или завершить фрейм',exact:true}).isEnabled(),!changed);
    assert.equal(await page.evaluate(()=>window.inspections),changed?0:1);
    await page.close();
  });
});

test('native bridge correlates UI instances and ignores a checkpoint from another channel',async()=>{
  const messages=[],figma={showUI(){},ui:{postMessage:m=>messages.push(m)}};
  const managed={inspect:async()=>({status:'absent'}),importPackage:async(_p,checkpoint)=>{await checkpoint('42:1');return {status:'imported'};}};
  vm.runInNewContext(await fs.readFile('spikes/figma-g1/plugin/handler.js','utf8'),{figma,createPmaImporter:()=>managed,buildFrame(){},__html__:'',setTimeout(){}});
  const channel='pma-fixture-channel-123456';
  await figma.ui.onmessage({type:'inspect-pma',requestId:'inspect',channel,payload:{}});assert.equal(messages[0].channel,channel);assert.equal(messages[0].result.status,'absent');
  const pending=figma.ui.onmessage({type:'import-pma',requestId:'import',channel,payload:{}}),checkpoint=messages[1];assert.equal(checkpoint.type,'checkpoint');assert.equal(checkpoint.channel,channel);
  await figma.ui.onmessage({type:'checkpoint-result',requestId:checkpoint.requestId,channel:'other-channel'});assert.equal(messages.length,2);
  await figma.ui.onmessage({type:'checkpoint-result',requestId:checkpoint.requestId,channel});await pending;
  assert.equal(messages[2].requestId,'import');assert.equal(messages[2].channel,channel);assert.equal(messages[2].result.status,'imported');
});
