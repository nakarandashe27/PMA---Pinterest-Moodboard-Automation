import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {AppError,LIMITS,selectedItems,snapshotKey,sha256} from './domain.mjs';

export function imageKey(url){try{return new URL(url).pathname.match(/\/([a-f0-9]{32})\.(?:jpe?g|png|webp)$/i)?.[1]?.toLowerCase()||null;}catch{return null;}}
export const BOARD_NAME_LIMIT=50;
export function pinterestBoardName(project){
  const suffix=' · '+project.id.slice(0,6),base=('PMA · '+project.name).replace(/\s+/g,' ').trim(),budget=BOARD_NAME_LIMIT-suffix.length;
  if(base.length<=budget)return base+suffix;
  let shortened=base.slice(0,budget-1).replace(/[\uD800-\uDBFF]$/,'').trimEnd();
  const space=shortened.lastIndexOf(' ');if(space>budget/2)shortened=shortened.slice(0,space);
  return shortened+'…'+suffix;
}
const attempts=(store,exp)=>store.list('figma-attempt',exp.projectId).filter(a=>a.exportId===exp.id);
export function createFigmaAttempt(store,exp,explicitNew=false){
  if(attempts(store,exp).length>=3)throw new AppError('Для этого набора уже созданы три попытки Figma. Проверьте существующие фреймы.',409);
  const attempt={id:randomUUID(),exportId:exp.id,selectionId:exp.selectionId,projectId:exp.projectId,connectionId:exp.connectionId,snapshotHash:exp.snapshotHash,count:exp.count,state:'prepared',explicitNew,createdAt:new Date().toISOString()};
  store.save('figma-attempt',attempt,exp.projectId);store.save('export',{...exp,currentAttemptId:attempt.id},exp.projectId);return attempt;
}
export function exportView(store,exp){
  const attempt=store.get('figma-attempt',exp.currentAttemptId),pin=store.get('pinterest-export','pinterest-'+exp.selectionId),board=store.get('board','board-'+exp.projectId),snapshot=store.get('selection',exp.selectionId);
  return {id:exp.id,selectionId:exp.selectionId,count:exp.count,accountName:store.get('connection',exp.connectionId)?.username||null,attemptId:attempt?.id,state:attempt?.state||'unknown',frameId:attempt?.receipt?.frameId||null,fileName:attempt?.receipt?.fileName||null,message:attempt?.message||'',verificationConflict:attempt?.verificationConflict||'',attempts:attempts(store,exp).length,
    preview:snapshot.items.map(c=>({pinId:c.pinId,pinUrl:c.pinUrl,mediaUrl:'/media/assets/'+c.asset})),
    pinterest:pin?{id:pin.id,state:pin.state,verified:pin.items.filter(i=>i.state==='verified').length,unknown:pin.items.filter(i=>i.state==='unknown').length,total:pin.items.length,message:pin.message||'',boardName:board?.name||'',boardUrl:board?.url||null}:null};
}
export async function prepareExport(store,root,run,project){
  if(!run.connectionId||run.connectionId!==project.ownerConnectionId||run.projectId!==project.id)throw new AppError('Владелец подбора и проекта не совпал',403);
  if(['queued','searching','downloading','ranking'].includes(run.status)||run.replacement&&['pending','review'].includes(run.replacement.status))throw new AppError('Сначала завершите поиск и решение по заменам',409);
  const items=selectedItems(run,run.selectedIds);if(!items.length)throw new AppError('Сначала выберите изображения');
  const key=snapshotKey(run,items),selectionId='selection-'+key;
  let snapshot=store.get('selection',selectionId);
  if(!snapshot){snapshot={id:selectionId,projectId:project.id,runId:run.id,connectionId:run.connectionId,items,query:run.query,title:run.title,createdAt:new Date().toISOString()};store.save('selection',snapshot,project.id);}
  let size=0;const pins=[];
  for(const c of snapshot.items){
    if(!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(c.asset))throw new AppError('Некорректный файл выбранного изображения',409);
    const bytes=await fs.readFile(path.join(root,'assets',c.asset));size+=bytes.length;
    if(size>LIMITS.packageBytes)throw new AppError('Набор больше 32 МБ. Выберите меньше изображений.');
    if(sha256(bytes)!==c.sha256)throw new AppError('Выбранное изображение изменилось. Экспорт остановлен.',409);
    pins.push({pinId:c.pinId,pinUrl:c.pinUrl,imageUrl:c.imageUrl,altText:c.altText||'',assetSha256:c.sha256,imageBase64:bytes.toString('base64')});
  }
  let exp=store.get('export','figma-'+selectionId);
  if(!exp)exp={id:'figma-'+selectionId,selectionId,projectId:project.id,connectionId:run.connectionId,snapshotHash:key,count:pins.length,createdAt:new Date().toISOString()};
  exp={...exp,snapshotHash:key,count:pins.length};
  // Legacy receipts have no evidence of the imported subset and cannot prove v2.
  if(!exp.currentAttemptId)store.transaction(()=>{const attempt=createFigmaAttempt(store,exp);exp={...exp,currentAttemptId:attempt.id};});
  const attempt=store.get('figma-attempt',exp.currentAttemptId);
  if(run.connectionId&&!store.get('pinterest-export','pinterest-'+selectionId)){
    store.save('pinterest-export',{id:'pinterest-'+selectionId,selectionId,projectId:project.id,connectionId:run.connectionId,state:'prepared',items:snapshot.items.map(c=>({sourcePinId:c.pinId,assetSha256:c.sha256,imageKey:imageKey(c.imageUrl),state:'pending'}))},project.id);
  }
  if(run.connectionId){
    const board=store.get('board','board-'+project.id);
    if(!board)store.save('board',{id:'board-'+project.id,projectId:project.id,connectionId:run.connectionId,name:pinterestBoardName(project),url:null,state:'unbound'},project.id);
    else if(board.state==='unbound'&&!board.url&&board.name.length>BOARD_NAME_LIMIT)store.save('board',{...board,name:pinterestBoardName(project)},project.id);
  }
  const directory=path.join(root,'exports');await fs.mkdir(directory,{recursive:true});
  const packagePath=path.join(directory,attempt.id+'.json');
  await fs.writeFile(packagePath,JSON.stringify({pmaPackageVersion:2,technicalProbe:false,runId:selectionId,snapshotId:selectionId,snapshotHash:key,attemptId:attempt.id,explicitNew:attempt.explicitNew,name:project.name+' · '+snapshot.title,query:snapshot.query,pins}));
  const code=randomBytes(24).toString('base64url'),expiresAt=Date.now()+15*60000;
  store.save('pairing',{id:'pair-'+sha256(code),exportId:exp.id,attemptId:attempt.id,projectId:exp.projectId,connectionId:exp.connectionId,packagePath,expiresAt},exp.projectId);
  return {...exportView(store,exp),code,expiresAt};
}
export function claimFigma(store,attempt,data){
  if(typeof data.documentId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(data.documentId))throw new AppError('Не получен маркер открытого Figma-документа');
  if(attempt.documentId&&attempt.documentId!==data.documentId)throw new AppError('Эта попытка связана с другим Figma-документом. Проверьте файл или явно создайте новую попытку.',409);
  if(data.fileKey!=null&&(typeof data.fileKey!=='string'||!/^[a-zA-Z0-9_-]{10,200}$/.test(data.fileKey)))throw new AppError('Некорректный ключ Figma-файла');
  if(attempt.fileKey&&attempt.fileKey!==data.fileKey)throw new AppError('Это копия или другой Figma-файл. Создайте новую явную попытку.',409);
  if(data.frameId!=null&&!/^\d+:\d+$/.test(data.frameId)||attempt.frameId&&attempt.frameId!==data.frameId)throw new AppError('Фрейм не совпал с сохранённой попыткой. Требуется сверка.',409);
  if(attempt.state==='imported')throw new AppError('Импорт уже подтверждён. Сверьте существующий фрейм.',409);
  if(attempt.state==='importing'&&attempt.leaseExpiresAt>Date.now())throw new AppError('Импорт уже выполняется. Дождитесь результата или сверьте фрейм.',409);
  if(attempt.state!=='prepared'&&!data.frameId)throw new AppError('Результат прошлого импорта неизвестен. Сначала найдите и сверьте фрейм; новый автоматически не создаётся.',409);
  const lease=randomBytes(24).toString('base64url'),next={...attempt,state:'importing',documentId:data.documentId,fileKey:attempt.fileKey||data.fileKey||null,leaseHash:sha256(lease),leaseExpiresAt:Date.now()+120000,startedAt:new Date().toISOString()};
  store.save('figma-attempt',next,attempt.projectId);return {lease};
}
export function recordFigmaReceipt(store,attempt,snapshot,data){
  if(attempt.documentId&&data.documentId!==attempt.documentId)throw new AppError('Подтверждение относится к другому документу',409);
  if(attempt.fileKey&&data.fileKey!==attempt.fileKey)throw new AppError('Квитанция относится к копии или другому Figma-файлу',409);
  if(!['imported','already-imported','conflict','unknown'].includes(data.status))throw new AppError('Некорректный статус импорта');
  if(['conflict','unknown'].includes(data.status)){
    const message=typeof data.message==='string'?data.message.slice(0,500):'Требуется сверка в Figma';
    const next=attempt.state==='imported'?{...attempt,verificationConflict:message}:{...attempt,state:data.status,message};store.save('figma-attempt',next,attempt.projectId);return next;
  }
  if(!attempt.documentId||data.snapshotHash!==attempt.snapshotHash||typeof data.frameId!=='string'||!/^\d+:\d+$/.test(data.frameId)||typeof data.fileName!=='string'||data.fileName.length>200||!Array.isArray(data.items)||data.items.length!==snapshot.items.length)throw new AppError('Нет полного подтверждения выбранного набора',409);
  if((attempt.frameId||attempt.receipt?.frameId)!==data.frameId)throw new AppError('Фрейм квитанции не совпал с checkpoint',409);
  if(data.status==='imported'&&(!data.lease||sha256(data.lease)!==attempt.leaseHash))throw new AppError('Устаревшая попытка импорта',409);
  const images=new Set(),links=new Set();
  for(const [i,item] of data.items.entries()){
    const expected=snapshot.items[i];
    if(item.pinId!==expected.pinId||item.pinUrl!==expected.pinUrl||item.assetSha256!==expected.sha256||!/^\d+:\d+$/.test(item.imageNodeId||'')||!/^\d+:\d+$/.test(item.sourceLinkNodeId||'')||item.imageNodeId===item.sourceLinkNodeId||item.imageNodeId===data.frameId||item.sourceLinkNodeId===data.frameId||typeof item.imageHash!=='string'||!item.imageHash.length||item.imageHash.length>200||images.has(item.imageNodeId)||links.has(item.sourceLinkNodeId)||images.has(item.sourceLinkNodeId)||links.has(item.imageNodeId))throw new AppError('Состав импортированного фрейма не совпал со снимком',409);
    images.add(item.imageNodeId);links.add(item.sourceLinkNodeId);
  }
  if(attempt.receipt&&attempt.receipt.frameId!==data.frameId)throw new AppError('Для этой попытки уже подтверждён другой фрейм',409);
  const next={...attempt,state:'imported',message:'Плагин сверил изображения и ссылки со снимком выбора',receipt:{frameId:data.frameId,fileName:data.fileName,documentId:data.documentId,items:data.items,snapshotHash:data.snapshotHash,verifiedAt:new Date().toISOString()}};
  store.save('figma-attempt',next,attempt.projectId);return next;
}
