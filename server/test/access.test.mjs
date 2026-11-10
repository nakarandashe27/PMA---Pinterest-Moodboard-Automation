import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectPinterestAccess } from '../pinterest-access.mjs';

test('rendered access detection distinguishes background widgets from manual challenges',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  // Fixtures do not contact CAPTCHA services or attempt to solve a challenge.
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<html></html>'}));
  await page.goto('https://www.pinterest.com/search/pins/?q=fixture');
  const frame='<iframe style="width:300px;height:400px" src="https://www.google.com/recaptcha/api2/bframe?k=DO-NOT-LOG&token=SECRET"></iframe>';
  const cases=[
    {name:'visible invisible-reCAPTCHA badge',html:'<div class="grecaptcha-badge" style="position:fixed;bottom:0;right:0;width:256px;height:60px"><iframe src="https://www.google.com/recaptcha/api2/anchor?size=invisible" width="256" height="60"></iframe></div>',kind:null},
    {name:'invisible anchor without badge class',html:'<iframe src="https://www.google.com/recaptcha/enterprise/anchor?size=invisible" width="256" height="60"></iframe>',kind:null},
    {name:'hidden parent with non-zero frame rect',html:'<div style="visibility:hidden">'+frame+'</div>',kind:null},
    {name:'transparent parent',html:'<div style="opacity:0">'+frame+'</div>',kind:null},
    {name:'offscreen background frame',html:'<div style="position:absolute;top:-10000px">'+frame+'</div>',kind:null},
    {name:'clipped background frame',html:'<div style="width:1px;height:1px;overflow:hidden"><div style="margin:20px">'+frame+'</div></div>',kind:null},
    {name:'empty CAPTCHA placeholder',html:'<div data-test-id="captcha" style="width:300px;height:200px"></div>',kind:null},
    {name:'foreground image challenge',html:frame,kind:'captcha'},
    {name:'foreground checkbox',html:'<iframe width="304" height="78" src="https://www.google.com/recaptcha/api2/anchor?size=normal"></iframe>',kind:'captcha'},
    {name:'challenge container',html:'<div data-test-id="captcha-modal">Пройдите проверку<button>Проверить</button></div>',kind:'captcha'},
    {name:'login takes precedence over captcha',html:'<div data-test-id="fullPageSignupModal">Войти</div>'+frame,kind:'login'}
  ];
  for(const fixture of cases)await t.test(fixture.name,async()=>{
    await page.setContent(fixture.html);
    const result=await page.evaluate(inspectPinterestAccess);
    assert.equal(result.kind,fixture.kind);
    const diagnostic=JSON.stringify(result);
    assert.ok(!diagnostic.includes('SECRET')&&!diagnostic.includes('DO-NOT-LOG'));
  });
  for(const [url,kind] of [['https://www.pinterest.com/login/','login'],['https://www.pinterest.com/checkpoint/','captcha']]){
    await page.goto(url);assert.equal((await page.evaluate(inspectPinterestAccess)).kind,kind);
  }
});
