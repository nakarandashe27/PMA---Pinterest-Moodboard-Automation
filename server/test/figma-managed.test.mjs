import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createPmaImporter} from '../../spikes/figma-g1/import-managed.mjs';
import {buildFrame} from '../../spikes/figma-g1/build-frame.mjs';

function fixture(count=3){
  let serial=0,fillWrites=0,failAt=0;const nodes=new Map();
  function node(type){
    const pluginData=new Map(),n={id:'10:'+(++serial),type,name:type,x:0,y:0,width:100,height:20,visible:true,opacity:1,rotation:0,parent:null};
    if(['DOCUMENT','PAGE','FRAME'].includes(type))n.children=[];
    if(type==='TEXT'){n.characters='';n.fontName={family:'Inter',style:'Regular'};n.fontSize=12;n.getRangeHyperlink=()=>n.link||null;n.setRangeHyperlink=(_a,_b,v)=>{n.link=v;};}
    n.getPluginData=key=>pluginData.get(key)||'';n.setPluginData=(key,value)=>pluginData.set(key,value);
    n.resize=(w,h)=>{n.width=w;n.height=h;};
    n.appendChild=child=>{if(child.parent)child.parent.children=child.parent.children.filter(x=>x!==child);child.parent=n;n.children.push(child);};
    n.remove=()=>{if(n.parent)n.parent.children=n.parent.children.filter(x=>x!==n);const remove=x=>{for(const c of x.children||[])remove(c);nodes.delete(x.id);};remove(n);};
    let fills=[];Object.defineProperty(n,'fills',{get:()=>fills,set:value=>{if(value[0]?.type==='IMAGE'){fillWrites++;if(failAt===fillWrites)throw Error('Simulated interruption while filling');}fills=value;},enumerable:true});
    nodes.set(n.id,n);return n;
  }
  const root=node('DOCUMENT');root.name='PMA file';const page=node('PAGE');root.appendChild(page);
  root.findAllWithCriteria=({types})=>[...nodes.values()].filter(n=>types.includes(n.type));
  const create=type=>{const n=node(type);page.appendChild(n);return n;};
  const figma={root,currentPage:page,loadAllPagesAsync:async()=>{},createFrame:()=>create('FRAME'),createText:()=>create('TEXT'),createRectangle:()=>create('RECTANGLE'),getNodeByIdAsync:async id=>nodes.get(id)||null,loadFontAsync:async()=>{},base64Decode:s=>new Uint8Array(Buffer.from(s,'base64')),createImage:bytes=>({hash:createHash('sha1').update(bytes).digest('hex')}),viewport:{scrollAndZoomIntoView:()=>{}}};
  const hash='a'.repeat(64),payload={pmaPackageVersion:2,technicalProbe:false,runId:'selection-'+hash,snapshotId:'selection-'+hash,snapshotHash:hash,attemptId:randomUUID(),explicitNew:false,name:'Мудборд',query:'Сад',pins:Array.from({length:count},(_,i)=>({pinId:String(i+1),pinUrl:'https://www.pinterest.com/pin/'+(i+1)+'/',assetSha256:String(i+1).padStart(64,'0'),altText:'Ландшафтный референс',imageBase64:Buffer.from([255,216,255,i]).toString('base64')}))};
  return {figma,payload,nodes,importer:createPmaImporter(figma,buildFrame),fail:at=>{failAt=at;},writes:()=>fillWrites};
}

test('native-compatible core creates every image and source link, then verifies without a duplicate frame',async()=>{
  const f=fixture(7);assert.equal((await f.importer.inspect(f.payload)).status,'absent');let checkpoints=0;
  const first=await f.importer.importPackage(f.payload,async()=>{checkpoints++;});assert.equal(first.status,'imported');assert.equal(first.items.length,7);assert.equal(checkpoints,1);
  const count=f.nodes.size,writes=f.writes(),second=await f.importer.importPackage(f.payload,async()=>assert.fail('no checkpoint needed'));assert.equal(second.status,'already-imported');assert.equal(second.frameId,first.frameId);assert.equal(f.nodes.size,count);assert.equal(f.writes(),writes);
  assert.deepEqual(first.items.map(i=>i.pinUrl),f.payload.pins.map(p=>p.pinUrl));
});

test('an interrupted fill resumes only missing images in the same unchanged frame',async()=>{
  const f=fixture();f.fail(2);await assert.rejects(f.importer.importPackage(f.payload,async()=>{}),/Simulated interruption/);const partial=await f.importer.inspect(f.payload);assert.equal(partial.status,'partial');
  const count=f.nodes.size;f.fail(0);const result=await f.importer.importPackage(f.payload,async()=>{});assert.equal(result.frameId,partial.frameId);assert.equal(result.status,'imported');assert.equal(f.nodes.size,count);assert.equal(f.writes(),4,'one successful fill, one interrupted write and two remaining fills');
});

test('manual edits to geometry, caption, link or image stop recovery without overwriting them',async()=>{
  for(const change of ['geometry','caption','link','image']){
    const f=fixture();const result=await f.importer.importPackage(f.payload,async()=>{});
    if(change==='geometry')f.nodes.get(result.frameId).x+=40;
    if(change==='caption')[...f.nodes.values()].find(n=>n.type==='TEXT'&&n.name.startsWith('Описание')).characters='Ручная правка';
    if(change==='link')f.nodes.get(result.items[0].sourceLinkNodeId).link={type:'URL',value:'https://example.com/'};
    if(change==='image')f.nodes.get(result.items[0].imageNodeId).fills=[{type:'IMAGE',imageHash:'other',scaleMode:'FIT'}];
    const before=f.nodes.size,writes=f.writes();assert.equal((await f.importer.inspect(f.payload)).status,'conflict');await assert.rejects(f.importer.importPackage(f.payload,async()=>{}));assert.equal(f.nodes.size,before);assert.equal(f.writes(),writes);
  }
});

test('deleted objects and lost document or frame markers cannot cause a replacement frame',async()=>{
  for(const change of ['image','frame','ledger','marker']){
    const f=fixture();const result=await f.importer.importPackage(f.payload,async()=>{});
    if(change==='image')f.nodes.get(result.items[0].imageNodeId).remove();
    if(change==='frame')f.nodes.get(result.frameId).remove();
    if(change==='ledger')f.figma.root.setPluginData('pmaAttempt_'+f.payload.attemptId,'');
    if(change==='marker')f.nodes.get(result.frameId).setPluginData('pmaAttemptId','');
    const count=f.nodes.size;assert.equal((await f.importer.inspect(f.payload)).status,'conflict');await assert.rejects(f.importer.importPackage(f.payload,async()=>{}));assert.equal(f.nodes.size,count);
  }
});

test('structure creation interrupted before its baseline never silently restarts',async()=>{
  const f=fixture(),broken=createPmaImporter(f.figma,async(figma,payload)=>{const root=figma.createFrame();await payload.onRoot(root);throw Error('Stopped during structure creation');});
  await assert.rejects(broken.importPackage(f.payload,async()=>{}),/structure creation/);const count=f.nodes.size;assert.equal((await f.importer.inspect(f.payload)).status,'conflict');await assert.rejects(f.importer.importPackage(f.payload,async()=>{}));assert.equal(f.nodes.size,count);
});

test('a new acknowledged attempt creates a separate frame without touching the old one',async()=>{
  const f=fixture(),first=await f.importer.importPackage(f.payload,async()=>{}),old=f.nodes.get(first.frameId);old.x+=100;
  const payload={...f.payload,attemptId:randomUUID(),explicitNew:true},next=await f.importer.importPackage(payload,async()=>{});assert.notEqual(next.frameId,first.frameId);assert.equal(f.nodes.get(first.frameId),old);assert.equal(old.x,260);
});

test('a frame already filled before the final marker can be read back as complete',async()=>{
  const f=fixture(),done=await f.importer.importPackage(f.payload,async()=>{}),root=f.nodes.get(done.frameId),manifest=JSON.parse(root.getPluginData('pmaManifest'));manifest.stage='filling';manifest.images.forEach(i=>i.done=false);root.setPluginData('pmaManifest',JSON.stringify(manifest));const before=f.writes();assert.equal((await f.importer.inspect(f.payload)).status,'complete');assert.equal(f.writes(),before);
});
