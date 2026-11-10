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
