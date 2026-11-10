import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../store.mjs';
import { selectedItems,snapshotKey,mediaType } from '../domain.mjs';

const base=path.resolve('.local/tests');fs.mkdirSync(base,{recursive:true});
function fixture(t){
  const directory=fs.mkdtempSync(path.join(base,'pma-state-')),store=new Store(directory);
  t.after(()=>{try{store.close();}catch{}const target=path.resolve(directory);assert.equal(path.dirname(target),base);assert.ok(path.basename(target).startsWith('pma-state-'));fs.rmSync(target,{recursive:true,force:true});});
  return {directory,store};
}
test('selection rejects another run, duplicate IDs and invalid inputs',()=>{
  const run={candidates:[{id:'a'},{id:'b'}]};
  assert.throws(()=>selectedItems(run,['other-run-id']),/другой подборки/);
  assert.throws(()=>selectedItems(run,['a','a']),/Некорректный/);
  assert.throws(()=>selectedItems(run,null),/Некорректный/);
  assert.deepEqual(selectedItems(run,['b','a']),run.candidates);
});
test('snapshot identity changes with image version and account, preserving large source IDs',()=>{
  const run={id:'run',projectId:'project',connectionId:'account-a'};
  const items=[{id:'item',pinId:'4608308449952188288',sha256:'asset-v1'}];
  const first=snapshotKey(run,items);
  assert.equal(items[0].pinId,'4608308449952188288');
  assert.equal(first,snapshotKey({...run},items.map(i=>({...i}))));
  assert.notEqual(first,snapshotKey({...run,connectionId:'account-b'},items));
  assert.notEqual(first,snapshotKey(run,[{...items[0],sha256:'asset-v2'}]));
});
test('a saved run and bound project cannot silently move to another account or project',t=>{
  const {store}=fixture(t);
  store.save('run',{id:'run',connectionId:'account-a'},'project-a');
  assert.throws(()=>store.save('run',{id:'run',connectionId:'account-a'},'project-b'),/owner/);
  assert.throws(()=>store.save('run',{id:'run',connectionId:'account-b'},'project-a'),/account/);
  store.save('evaluation',{id:'evaluation',connectionId:'account-a'},'project-a');
  assert.throws(()=>store.save('evaluation',{id:'evaluation',connectionId:'account-b'},'project-a'),/account/);
  store.save('project',{id:'project-a',ownerConnectionId:'account-a'});
  assert.throws(()=>store.save('project',{id:'project-a',ownerConnectionId:'account-b'}),/account/);
});
test('export snapshots are immutable even after a new review selection',t=>{
  const {store}=fixture(t);
  store.save('selection',{id:'selection',items:['first']},'project');
  assert.throws(()=>store.save('selection',{id:'selection',items:['second']},'project'),/immutable/);
  assert.deepEqual(store.get('selection','selection').items,['first']);
});
test('failed transaction leaves neither a half-created project nor a run',t=>{
  const {store}=fixture(t);
  assert.throws(()=>store.transaction(()=>{store.save('project',{id:'temporary'});throw Error('interrupted');}));
  assert.equal(store.get('project','temporary'),null);
});
test('restart preserves completed data and marks abandoned search without automatic retry',t=>{
  const {store,directory}=fixture(t);
  store.save('run',{id:'running',projectId:'p',connectionId:'a',status:'searching',candidates:[{pinId:'4608308449952188288'}]},'p');
  store.save('run',{id:'ready',projectId:'p',connectionId:'a',status:'ready',selectedIds:['one']},'p');
  store.close();const reopened=new Store(directory);
  try{reopened.recover();assert.equal(reopened.get('run','running').status,'interrupted');assert.equal(reopened.get('run','running').candidates[0].pinId,'4608308449952188288');assert.deepEqual(reopened.get('run','ready').selectedIds,['one']);}finally{reopened.close();}
});
test('image boundary rejects HTML even when a filename claims to be a photograph',()=>{
  assert.throws(()=>mediaType(Buffer.from('<html>not an image</html>')),/Поддерживаются/);
  assert.equal(mediaType(Buffer.from([255,216,255,224])).mime,'image/jpeg');
});
