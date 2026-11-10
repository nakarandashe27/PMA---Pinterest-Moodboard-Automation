import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ensureExportBoard} from '../pinterest-export-ui.mjs';

test('rendered creation form rejects disabled or invalid submission before reserving a write',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  for(const mode of ['disabled','validation'])await t.test(mode,async()=>{
    const page=await browser.newPage();
    const imageUrl='https://i.pinimg.com/1200x/ab/cd/ef/12345678901234567890123456789012.jpg';
    await page.route('**/*',route=>{
      if(route.request().url().startsWith('https://i.pinimg.com/'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1cAAAAASUVORK5CYII=','base64')});
      const profile='<button aria-label="Edit">Edit</button>';
      const pin='<img data-test-id="closeup-image-main" width="100" height="100" src="'+imageUrl+'"><button data-test-id="PinBetterSaveDropdown" onclick="document.querySelector(\'#picker\').hidden=false">Pick</button><div id="picker" data-test-id="board-picker-flyout" hidden><input><button onclick="document.querySelector(\'#create\').hidden=false">Create board</button></div><div id="create" role="dialog" aria-label="Create board" hidden><input id="boardEditName"><input id="secret" type="checkbox">'+(mode==='validation'?'<p>Please enter no more than 50 characters.</p>':'')+'<button '+(mode==='disabled'?'disabled':'')+' onclick="window.created=true">Create</button></div>';
      return route.fulfill({contentType:'text/html',body:'<!doctype html><body><div data-test-id="header-profile"></div>'+(route.request().url().includes('/_saved/')?profile:pin)});
    });
    let reserved=0;
    const client={page:async()=>page,checkAccess:async()=>{},requireIdentity:async()=> 'owner'};
    await assert.rejects(ensureExportBoard(client,{id:'account',username:'owner'},{name:'PMA Garden',url:null},{pinUrl:'https://www.pinterest.com/pin/100/',imageUrl},{signal:AbortSignal.timeout(20000),readOnly:false,beforeCreate:()=>{reserved++;}}),/запись не начиналась/);
    assert.equal(reserved,0);assert.equal(await page.evaluate(()=>window.created||false),false);assert.equal(await page.locator('#secret').isChecked(),true);
    await page.close();
  });
});
