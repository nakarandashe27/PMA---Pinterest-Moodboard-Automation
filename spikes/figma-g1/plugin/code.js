// Portable core for the G1 technical image import.
// Creates separate editable image nodes and source links, never a flattened board.
async function buildFrame(figma, payload) {
  const createdNodeIds = [];
  const remember = node => { createdNodeIds.push(node.id); return node; };
  const [background, bodyStyle, linkStyle] = payload.useLibraryStyles === false ? [null, {fontName:{family:'Inter',style:'Regular'},id:null}, {fontName:{family:'Inter',style:'Regular'},id:null}] : await Promise.all([
    figma.variables.importVariableByKeyAsync('63a99f708b260ccc6fa8cb069cf4b2bec8b91be5'),
    figma.importStyleByKeyAsync('dd16ffab542d022b9a2d78275ed222c2cb4646b4'),
    figma.importStyleByKeyAsync('6fbe5a142218ceefd0caa5b9183bc64fb90b262f')
  ]);
  const fonts = [{ family: 'Inter', style: 'Bold' }, bodyStyle.fontName, linkStyle.fontName];
  await Promise.all([...new Map(fonts.map(f => [f.family + '/' + f.style, f])).values()].map(f => figma.loadFontAsync(f)));
  const stack = (direction, name) => {
    const node = remember(typeof figma.createAutoLayout === 'function' ? figma.createAutoLayout(direction) : figma.createFrame());
    node.layoutMode = direction;
    node.primaryAxisSizingMode = 'AUTO';
    node.counterAxisSizingMode = 'AUTO';
    node.name = name;
    node.fills = [];
    return node;
  };
  const text = (parent, name, value, width, style, bold = false) => {
    const node = remember(figma.createText());
    node.name = name;
    node.fontName = bold ? { family: 'Inter', style: 'Bold' } : style.fontName;
    if (style?.id) node.textStyleId = style.id;
    node.characters = value;
    if (bold) node.fontSize = 32;
    node.resize(width, Math.max(20, node.height));
    node.textAutoResize = 'HEIGHT';
    parent.appendChild(node);
    return node;
  };
  const page = figma.currentPage;
  const maxX = page.children.reduce((v, n) => Math.max(v, n.x + n.width), 0);
  const root = stack('VERTICAL', payload.name);
  if(payload.onRoot)await payload.onRoot(root);
  root.x = maxX + 160; root.y = 0;
  root.paddingTop = 40; root.paddingRight = 40; root.paddingBottom = 40; root.paddingLeft = 40;
  root.itemSpacing = 28;
  root.fills = [background ? figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }, 'color', background) : {type:'SOLID',color:{r:1,g:1,b:1}}];
  root.resize(1776, 100);
  root.counterAxisSizingMode = 'FIXED';
  if ('placeholder' in root) root.placeholder = true;
  text(root, 'Задание', payload.query, 1696, null, true);
  text(root, 'Статус проверки', payload.technicalProbe ? 'G1 · ' + payload.pins.length + ' технических кандидатов Pinterest. Отдельные изображения и ссылки. Это не утверждённый мудборд проекта.' : 'Pinterest · Выбрано ' + payload.pins.length + ' изображений. Источники сохранены под каждой карточкой.', 1696, bodyStyle);
  const imageNodeIds = [];
  const sourceLinkNodeIds = [];
  for (let index = 0; index < payload.pins.length; index += 5) {
    const row = stack('HORIZONTAL', 'Ряд ' + (Math.floor(index / 5) + 1));
    row.itemSpacing = 24; root.appendChild(row);
    for (const [offset, pin] of payload.pins.slice(index, index + 5).entries()) {
      const card = stack('VERTICAL', 'Референс ' + pin.pinId);
      card.itemSpacing = 10;
      card.resize(320, 100); card.counterAxisSizingMode = 'FIXED';
      row.appendChild(card);
      const image = remember(figma.createRectangle());
      image.name = 'Изображение · ' + pin.pinId;
      image.resize(320, 260);
      image.fills = [];
      card.appendChild(image);
      imageNodeIds.push(image.id);
      text(card, 'Описание · ' + pin.pinId, String(index + offset + 1).padStart(2, '0') + ' · ' + pin.altText.slice(0, 170), 320, bodyStyle);
      const link = text(card, 'Источник · ' + pin.pinId, 'Открыть пин Pinterest ↗', 320, linkStyle);
      link.setRangeHyperlink(0, link.characters.length, { type: 'URL', value: pin.pinUrl });
      sourceLinkNodeIds.push(link.id);
    }
  }
  return { rootNodeId: root.id, pageId: page.id, createdNodeIds, imageNodeIds, sourceLinkNodeIds,
    importedStyleIds: [bodyStyle.id, linkStyle.id].filter(Boolean), importedVariableIds: background ? [background.id] : [],
    fonts: fonts, count: payload.pins.length, size: {width:root.width,height:root.height} };
}

// Native Plugin API only. Document markers are local identity hints, not fileKey.
function createPmaImporter(figma,buildFrame){
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

figma.showUI(__html__,{width:440,height:500});
const managed=createPmaImporter(figma,buildFrame);
const checkpoints=new Map();let managedBusy=false;
const legacyHandler=async message=>{
 if(message.type!=='import-g1')return;
 try{
  const p=message.payload;
  const legacy=p?.technicalProbe===true&&p.pins?.length===25;
  const current=p?.pmaPackageVersion===1&&p.technicalProbe===false&&p.pins?.length>=1&&p.pins?.length<=25;
  if((!legacy&&!current)||!Array.isArray(p.pins)||typeof p.runId!=='string'||p.runId.length>200||typeof p.name!=='string'||p.name.length>300||typeof p.query!=='string'||p.query.length>1000)throw Error('Некорректный пакет подборки');
  const ids=new Set();
  for(const pin of p.pins){
   if(typeof pin.pinId!=='string'||!(/^[1-9]\d*$/.test(pin.pinId))||pin.pinUrl!=='https://www.pinterest.com/pin/'+pin.pinId+'/'||typeof pin.imageBase64!=='string'||pin.imageBase64.length>12000000||typeof pin.altText!=='string'||ids.has(pin.pinId))throw Error('Некорректный референс');
   ids.add(pin.pinId);
  }
  const existing=figma.currentPage.children.find(n=>n.type==='FRAME'&&(n.getPluginData('pmaRunId')===p.runId||(legacy&&n.name===p.name)));
  if(existing){
   const status=existing.getPluginData('pmaStatus');
   if(status&&status!=='complete')throw Error('В файле есть незавершённый импорт этого набора. Проверьте его перед повтором.');
   figma.ui.postMessage({type:'already-imported',frameId:existing.id,fileName:figma.root.name});return;
  }
  const images=p.pins.map(pin=>figma.createImage(figma.base64Decode(pin.imageBase64)));
  const built=await buildFrame(figma,{...p,useLibraryStyles:false});
  const root=await figma.getNodeByIdAsync(built.rootNodeId);
  root.setPluginData('pmaRunId',p.runId);
  root.setPluginData('pmaStatus','importing');
  const targets=await Promise.all(built.imageNodeIds.map(id=>figma.getNodeByIdAsync(id)));
  for(let i=0;i<targets.length;i++)targets[i].fills=[{type:'IMAGE',imageHash:images[i].hash,scaleMode:'FIT'}];
  root.setPluginData('pmaStatus','complete');
  if('placeholder' in root)root.placeholder=false;
  figma.viewport.scrollAndZoomIntoView([root]);
  figma.ui.postMessage({type:'complete',count:targets.length,frameId:root.id,fileName:figma.root.name});
 }catch(error){figma.ui.postMessage({type:'error',message:error.message});}
};
figma.ui.onmessage=async message=>{
 if(message.type==='checkpoint-result'){const pending=checkpoints.get(message.requestId);if(pending&&message.channel===pending.channel){checkpoints.delete(message.requestId);message.error?pending.reject(Error(message.error)):pending.resolve();}return;}
 if(message.type!=='inspect-pma'&&message.type!=='import-pma'){await legacyHandler(message);return;}
 if(typeof message.channel!=='string'||message.channel.length<16||message.channel.length>150)return;
 if(managedBusy){figma.ui.postMessage({requestId:message.requestId,channel:message.channel,error:'Импорт уже выполняется'});return;}
 managedBusy=true;
 try{
  const result=message.type==='inspect-pma'?await managed.inspect(message.payload):await managed.importPackage(message.payload,frameId=>new Promise((resolve,reject)=>{
   const id='checkpoint-'+Date.now()+'-'+Math.random();checkpoints.set(id,{resolve,reject,channel:message.channel});figma.ui.postMessage({type:'checkpoint',requestId:id,frameId,channel:message.channel});
   setTimeout(()=>{if(checkpoints.delete(id))reject(Error('PMA не подтвердил создание фрейма. Повтор требует сверки.'));},12000);
  }));
  figma.ui.postMessage({requestId:message.requestId,channel:message.channel,result});
 }catch(error){figma.ui.postMessage({requestId:message.requestId,channel:message.channel,error:error.message});}finally{managedBusy=false;}
};
