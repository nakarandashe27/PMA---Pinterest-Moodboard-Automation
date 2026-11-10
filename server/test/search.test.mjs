import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';
import { performSearch } from '../search.mjs';
import { PinterestAccessError } from '../pinterest-access.mjs';

test('a challenge preserves observed pins across restart; manual resume keeps selection and avoids duplicates',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pma-access-test-'));
  let store=new Store(directory);
  t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('pma-access-test-'));fs.rmSync(directory,{recursive:true,force:true});});
  const pins=Array.from({length:29},(_,i)=>({pinId:String(1000+i),pinUrl:`https://www.pinterest.com/pin/${1000+i}/`,imageUrl:`https://i.pinimg.com/474x/${i}.jpg`,altText:'форма '+i}));
  const existing={...pins[0],id:'already-downloaded',asset:'existing.jpg',sha256:'hash-1000'};
  const run={id:'run',projectId:'project',connectionId:'account',sourceKind:'live',status:'queued',candidates:[existing],selectedIds:[existing.id]};
  store.save('run',run,'project');
  let downloads=0;
  const download=async(_root,pin)=>{downloads++;return {...pin,id:'candidate-'+pin.pinId,asset:pin.pinId+'.jpg',sha256:'hash-'+pin.pinId};};
  const blockedPinterest={collect:async(_connection,_brief,_uploads,progress)=>{
    await progress({found:pins.length,pins,message:'Найдено 29'});
    throw new PinterestAccessError({kind:'captcha',message:'Пройдите проверку вручную'});
  }};
  await performSearch({store,pinterest:blockedPinterest,root:directory,run,connection:{id:'account'},uploads:[],controller:new AbortController(),download});
  assert.equal(downloads,0,'no downloads after an access challenge');
  assert.equal(store.get('run','run').status,'blocked');
  store.close();store=new Store(directory);store.recover();
  const paused=store.get('run','run');
  assert.equal(paused.status,'blocked');assert.equal(paused.blockReason,'captcha');
  assert.equal(paused.observedPins.length,29);assert.equal(paused.foundCount,29);
  assert.deepEqual(paused.selectedIds,['already-downloaded']);
  const resumedPinterest={collect:async(_connection,brief)=>{
    assert.equal(brief.observedPins.length,29);return brief.observedPins;
  }};
  await performSearch({store,pinterest:resumedPinterest,root:directory,run:paused,connection:{id:'account'},uploads:[],controller:new AbortController(),download});
  const done=store.get('run','run');
  assert.equal(done.status,'ready');assert.equal(done.blockReason,null);
  assert.equal(done.candidates.length,25);assert.equal(downloads,24);
  assert.equal(new Set(done.candidates.map(c=>c.pinId)).size,25);
  assert.deepEqual(done.selectedIds,['already-downloaded']);
});

test('legacy access failures become resumable without deleting their history',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pma-legacy-test-')),store=new Store(directory);
  try{
    store.save('run',{id:'old',projectId:'p',connectionId:'a',sourceKind:'live',status:'error',message:'Pinterest запросил проверку. Поиск остановлен; пройдите её самостоятельно.',foundCount:48,candidates:[]},'p');
    store.recover();const run=store.get('run','old');
    assert.equal(run.status,'blocked');assert.equal(run.blockReason,'captcha');assert.equal(run.foundCount,48);assert.deepEqual(run.candidates,[]);
  }finally{store.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('pma-legacy-test-'));fs.rmSync(directory,{recursive:true,force:true});}
});
