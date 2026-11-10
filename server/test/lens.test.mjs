import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startPinterestLens } from '../pinterest-lens.mjs';
import { Store } from '../store.mjs';
import { performSearch } from '../search.mjs';

test('Lens opens collapsed search after delayed rendering, then uploads the chosen image',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pma-lens-test-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('pma-lens-test-'));fs.rmSync(directory,{recursive:true,force:true});});
  const file=path.join(directory,'selected.jpg');fs.writeFileSync(file,Buffer.from([255,216,255,224]));
  for(const chooser of [true,false])await t.test(chooser?'native Lens file chooser':'image input mounted in Lens panel',async()=>{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<html></html>'}));
    await page.goto('https://www.pinterest.com/');
    await page.setContent(`<input id="unrelated" type="file" accept="application/pdf" hidden><script>
      setTimeout(()=>{
        const search=document.createElement('button');search.setAttribute('aria-label','Search icon');document.body.append(search);
        search.onclick=()=>{
          const lens=document.createElement('button');lens.setAttribute('aria-label','Search by image');document.body.append(lens);
          lens.onclick=()=>{
            const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png';input.hidden=true;input.id='lens-upload';document.body.append(input);
            input.onchange=()=>{document.body.dataset.uploaded=input.files[0].name;history.pushState({},'','/lens-search/');};
            ${chooser?'input.click();':''}
          };
        };
      },120);
    </script>`);
    const phases=[];let diagnostics=0;
    const result=await startPinterestLens(page,{id:'chosen-upload',path:file},{checkAccess:async()=>{},phase:async m=>phases.push(m),diagnose:async()=>{diagnostics++;},timeout:2500,chooserTimeout:200,resultTimeout:2500});
    assert.equal(result.strategy,'pinterest-lens');assert.equal(result.seedUploadId,'chosen-upload');assert.equal(result.resultPath,'/lens-search/');
    assert.equal(await page.evaluate(()=>document.body.dataset.uploaded),'selected.jpg');
    assert.equal(await page.locator('#unrelated').evaluate(el=>el.files.length),0);
    assert.equal(diagnostics,0);assert.ok(phases.length>=4);
    await page.close();
  });
  await t.test('upload without a visual-results transition fails instead of returning a text or home feed',async()=>{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<html></html>'}));
    await page.goto('https://www.pinterest.com/');
    await page.setContent('<button aria-label="Search by image" onclick="document.querySelector(\'input\').click()"></button><input type="file" accept="image/jpeg" hidden>');
    let diagnostics=0;
    await assert.rejects(startPinterestLens(page,{id:'chosen',path:file},{checkAccess:async()=>{},phase:async()=>{},diagnose:async()=>{diagnostics++;},timeout:1000,chooserTimeout:200,resultTimeout:150}),/Текстовый поиск вместо Lens не выполнялся/);
    assert.equal(new URL(page.url()).pathname,'/');assert.equal(diagnostics,1);await page.close();
  });
  await t.test('cancellation before file transfer does not upload the image',async()=>{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<html></html>'}));
    await page.goto('https://www.pinterest.com/');
    await page.setContent('<button aria-label="Search by image" onclick="document.querySelector(\'input\').click()"></button><input type="file" accept="image/jpeg" hidden>');
    const controller=new AbortController();
    await assert.rejects(startPinterestLens(page,{id:'chosen',path:file},{checkAccess:async()=>controller.signal.throwIfAborted(),phase:async message=>{if(message.startsWith('Передаём'))controller.abort();controller.signal.throwIfAborted();},diagnose:async()=>{},timeout:1000,chooserTimeout:200,resultTimeout:1000}),{name:'AbortError'});
    assert.equal(await page.locator('input').evaluate(el=>el.files.length),0);await page.close();
  });
});

test('image jobs cannot download a plain feed without proof of Lens and the exact seed',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pma-lens-state-')),store=new Store(directory);
  try{
    for(const [index,evidence] of [null,{strategy:'pinterest-lens',seedUploadId:'another-upload'}].entries()){
      const run={id:'image-run-'+index,projectId:'p',connectionId:'account',mode:'image',candidates:[],status:'queued'};
      store.save('run',run,'p');let downloads=0;
      await performSearch({store,root:directory,run,connection:{id:'account'},uploads:[{id:'chosen'}],controller:new AbortController(),pinterest:{collect:async(_connection,_brief,_uploads,progress)=>{if(evidence)await progress({searchEvidence:evidence,message:'Lens'});return [{pinId:'1000'}];}},download:async()=>{downloads++;}});
      assert.equal(store.get('run',run.id).status,'error');assert.match(store.get('run',run.id).message,/не подтверждён/);assert.equal(downloads,0);
    }
  }finally{store.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('pma-lens-state-'));fs.rmSync(directory,{recursive:true,force:true});}
});
