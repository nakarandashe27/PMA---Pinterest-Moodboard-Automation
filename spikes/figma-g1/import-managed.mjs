// Native Plugin API only. Document markers are local identity hints, not fileKey.
export function createPmaImporter(figma,buildFrame){
  const data=(node,key)=>{const value=node.getPluginData(key);try{return value?JSON.parse(value):null;}catch{throw Error('Повреждены метки импорта. Автоматический повтор остановлен.');}};
  const save=(node,key,value)=>node.setPluginData(key,JSON.stringify(value));
  const ledgerKey=p=>'pmaAttempt_'+p.attemptId;
  function context(){
    let documentId=figma.root.getPluginData('pmaDocumentId');
    if(!documentId){documentId='pma_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);figma.root.setPluginData('pmaDocumentId',documentId);}
    let fileKey=null;try{fileKey=figma.fileKey||null;}catch{}
    return {documentId,fileKey,fileName:figma.root.name};
  }
  function validate(p){
    if(p?.pmaPackageVersion!==2||p.technicalProbe!==false||!/^selection-[a-f0-9]{64}$/.test(p.snapshotId||'')||p.runId!==p.snapshotId||p.snapshotHash!==p.snapshotId.slice(10)||!/^[a-f0-9-]{36}$/.test(p.attemptId||'')||typeof p.name!=='string'||p.name.length>300||typeof p.query!=='string'||p.query.length>1000||!Array.isArray(p.pins)||!p.pins.length||p.pins.length>25)throw Error('Неверный пакет PMA. Обновите код подключения.');
    const ids=new Set();let total=0;
    for(const pin of p.pins){
      if(typeof pin.pinId!=='string'||!/^[1-9]\d*$/.test(pin.pinId)||pin.pinUrl!=='https://www.pinterest.com/pin/'+pin.pinId+'/'||!/^[a-f0-9]{64}$/.test(pin.assetSha256||'')||typeof pin.altText!=='string'||pin.altText.length>1000||typeof pin.imageBase64!=='string'||pin.imageBase64.length>16000000||ids.has(pin.pinId))throw Error('Неверный референс в пакете');
      total+=pin.imageBase64.length;ids.add(pin.pinId);
    }
    if(total>48*1024*1024)throw Error('Пакет слишком большой');
  }
  function shape(node,managedImage){
    const result={id:node.id,type:node.type,parent:node.parent?.id};
    for(const key of ['name','x','y','width','height','rotation','visible','opacity','blendMode','layoutMode','primaryAxisSizingMode','counterAxisSizingMode','paddingTop','paddingRight','paddingBottom','paddingLeft','itemSpacing','clipsContent','strokes','strokeWeight','cornerRadius','effects'])if(key in node)result[key]=node[key];
    if('fills' in node)result.fills=managedImage?'managed-image':node.fills;
    if('children' in node)result.children=node.children.map(c=>c.id);
    if(node.type==='TEXT'){
      for(const key of ['characters','fontName','fontSize','textStyleId','textCase','textDecoration','lineHeight','letterSpacing','paragraphSpacing','textAlignHorizontal','textAutoResize'])result[key]=node[key];
      result.hyperlink=node.characters.length?node.getRangeHyperlink(0,node.characters.length):null;
    }
    return JSON.stringify(result);
  }
  function expectedPaint(paint,hash){
    return paint?.type==='IMAGE'&&paint.imageHash===hash&&paint.scaleMode==='FIT'&&(paint.opacity??1)===1&&(paint.visible??true)===true&&(paint.rotation??0)===0&&(!paint.filters||Object.values(paint.filters).every(v=>v===0))&&(!paint.blendMode||paint.blendMode==='NORMAL');
  }
  async function verify(p,root,manifest){
    if(root.getPluginData('pmaAttemptId')!==p.attemptId||root.getPluginData('pmaSnapshotHash')!==p.snapshotHash||manifest?.snapshotHash!==p.snapshotHash||manifest.stage!=='filling'&&manifest.stage!=='complete'||manifest.images?.length!==p.pins.length||manifest.links?.length!==p.pins.length||!Array.isArray(manifest.nodes)||manifest.nodes.length>200)throw Error('Метки фрейма изменены или импорт не дошёл до проверяемого этапа.');
    const imageIds=new Set(manifest.images.map(i=>i.id));
    for(const id of manifest.nodes){const node=await figma.getNodeByIdAsync(id);if(!node||node.getPluginData('pmaExpected')!==shape(node,imageIds.has(id)))throw Error('Есть ручные изменения, удалённые объекты или потерянные метки. Автоматическое восстановление остановлено.');}
    const items=[];let pending=0;
    for(const [index,image] of manifest.images.entries()){
      const pin=p.pins[index],node=await figma.getNodeByIdAsync(image.id),link=await figma.getNodeByIdAsync(manifest.links[index]);
      const hash=figma.createImage(figma.base64Decode(pin.imageBase64)).hash;
      if(image.hash!==hash||image.pinId!==pin.pinId||image.assetSha256!==pin.assetSha256||link.type!=='TEXT'||link.getRangeHyperlink(0,link.characters.length)?.value!==pin.pinUrl)throw Error('Изображения или исходные ссылки не совпали со снимком.');
      if(node.fills.length===0&&!image.done&&manifest.stage==='filling')pending++;
      else if(node.fills.length!==1||!expectedPaint(node.fills[0],hash))throw Error('Изображение во фрейме изменено вручную.');
      items.push({pinId:pin.pinId,pinUrl:pin.pinUrl,assetSha256:pin.assetSha256,imageNodeId:node.id,sourceLinkNodeId:link.id,imageHash:hash});
    }
    return {items,pending};
  }
  async function inspect(p){
    validate(p);const ctx=context(),ledger=data(figma.root,ledgerKey(p));
    if(!ledger){
      if(typeof figma.loadAllPagesAsync==='function')await figma.loadAllPagesAsync();
      else if(figma.root.children.length>1)throw Error('Нельзя проверить остальные страницы документа.');
      const frames=figma.root.findAllWithCriteria({types:['FRAME']});
      if(frames.some(n=>n.getPluginData('pmaAttemptId')===p.attemptId||!p.explicitNew&&n.getPluginData('pmaRunId')===p.snapshotId))return {...ctx,status:'conflict',message:'Найден фрейм с потерянной или старой меткой. Новый автоматически не создан.'};
      return {...ctx,status:'absent',frameId:null};
    }
    try{
      if(ledger.snapshotHash!==p.snapshotHash||!ledger.frameId)throw Error('Предыдущий запуск остановился во время создания структуры. Нужна ручная проверка.');
      const root=await figma.getNodeByIdAsync(ledger.frameId);if(!root)throw Error('Фрейм удалён. Автоматически воссоздавать его нельзя.');
      const manifest=data(root,'pmaManifest'),checked=await verify(p,root,manifest);
      return {...ctx,status:checked.pending?'partial':'complete',frameId:root.id,snapshotHash:p.snapshotHash,items:checked.items};
    }catch(error){return {...ctx,status:'conflict',frameId:ledger.frameId||null,message:error.message};}
  }
  async function importPackage(p,checkpoint){
    const state=await inspect(p);if(state.status==='conflict')throw Error(state.message);if(state.status==='complete')return {...state,status:'already-imported'};
    let root,manifest;
    if(state.status==='absent'){
      await Promise.all([{family:'Inter',style:'Regular'},{family:'Inter',style:'Bold'}].map(f=>figma.loadFontAsync(f)));
      const images=p.pins.map(pin=>figma.createImage(figma.base64Decode(pin.imageBase64)));
      save(figma.root,ledgerKey(p),{snapshotHash:p.snapshotHash,frameId:null,stage:'building'});
      const built=await buildFrame(figma,{...p,useLibraryStyles:false,onRoot:async node=>{
        root=node;root.setPluginData('pmaRunId',p.snapshotId);root.setPluginData('pmaAttemptId',p.attemptId);root.setPluginData('pmaSnapshotHash',p.snapshotHash);
        save(figma.root,ledgerKey(p),{snapshotHash:p.snapshotHash,frameId:root.id});await checkpoint(root.id);
      }});
      manifest={snapshotHash:p.snapshotHash,stage:'filling',nodes:built.createdNodeIds,links:built.sourceLinkNodeIds,images:built.imageNodeIds.map((id,i)=>({id,hash:images[i].hash,pinId:p.pins[i].pinId,assetSha256:p.pins[i].assetSha256,done:false}))};
      const imagesSet=new Set(built.imageNodeIds);
      for(const id of built.createdNodeIds){const node=await figma.getNodeByIdAsync(id);node.setPluginData('pmaExpected',shape(node,imagesSet.has(id)));}
      save(root,'pmaManifest',manifest);
    }else{root=await figma.getNodeByIdAsync(state.frameId);manifest=data(root,'pmaManifest');await checkpoint(root.id);}
    await verify(p,root,manifest);
    for(const image of manifest.images){
      const node=await figma.getNodeByIdAsync(image.id);
      if(node.fills.length===0&&!image.done)node.fills=[{type:'IMAGE',imageHash:image.hash,scaleMode:'FIT'}];
      else if(node.fills.length!==1||!expectedPaint(node.fills[0],image.hash))throw Error('Изображение изменилось во время импорта. Восстановление остановлено.');
      image.done=true;save(root,'pmaManifest',manifest);
    }
    manifest.stage='complete';save(root,'pmaManifest',manifest);root.setPluginData('pmaStatus','complete');
    const result=await inspect(p);if(result.status!=='complete')throw Error(result.message||'Не удалось сверить импорт');
    figma.viewport.scrollAndZoomIntoView([root]);return {...result,status:'imported'};
  }
  return {context,inspect,importPackage};
}
