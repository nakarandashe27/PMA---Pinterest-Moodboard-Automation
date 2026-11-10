import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {AppError,sha256} from './domain.mjs';
import {imageKey,pinterestBoardName,BOARD_NAME_LIMIT} from './exports.mjs';
import {PinterestAccessError} from './pinterest-access.mjs';

export function verifiedBoard(board,connection,expected){
  let url;try{url=new URL(board.url);}catch{throw new AppError('Не получен адрес доски',409);}
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.protocol!=='https:'||!(url.hostname==='pinterest.com'||url.hostname.endsWith('.pinterest.com'))||url.username||url.password||url.port||parts.length!==2||parts[0].toLowerCase()!==connection.username?.toLowerCase()||['pin','search','settings'].includes(parts[0])||board.secret!==true||board.username?.toLowerCase()!==connection.username?.toLowerCase())throw new AppError('Не подтверждены владелец и секретность доски. Сохранение остановлено.',409);
  const canonical='https://www.pinterest.com/'+parts.join('/')+'/';
  if(expected.url&&expected.url!==canonical)throw new AppError('Адрес доски отличается от привязанного к проекту',409);
  return {...expected,url:canonical,username:connection.username,state:'verified',secret:true,verifiedAt:new Date().toISOString()};
}
export function matchSavedPin(pin,pins){
  const key=imageKey(pin.imageUrl);if(!key)throw new AppError('Нельзя сверить изображение этого пина с доской',409);
  const matches=pins.filter(p=>imageKey(p.imageUrl)===key);
  if(matches.length>1)throw new AppError('На доске несколько совпадающих изображений. Требуется ручная сверка.',409);
  return matches[0]||null;
}

// Operator-only repair for a proved client-side rejection, never for an absent
// result after a network timeout. The user supplied the visible validation.
export function recoverRejectedBoardName(store,record,evidence){
  const board=store.get('board','board-'+record.projectId),snapshot=store.get('selection',record.selectionId),first=snapshot?.items[0],project=store.get('project',record.projectId);
  const unknown=store.list('pin-save',record.projectId).filter(r=>r.boardId===board?.id&&r.state==='unknown');
  if(!board||!first||!project||board.connectionId!==record.connectionId||snapshot.connectionId!==record.connectionId||board.url||board.state!=='unknown'||board.name.length<=BOARD_NAME_LIMIT||evidence?.code!=='board-name-too-long'||evidence.confirmedNotCreated!==true||evidence.oldName!==board.name||evidence.source!=='user-screenshot'||!/^[a-f0-9]{64}$/.test(evidence.sha256||'')||unknown.length!==1||unknown[0].sourcePinId!==first.pinId||unknown[0].assetSha256!==first.sha256||unknown[0].connectionId!==record.connectionId||record.items.some(i=>i.sourcePinId===first.pinId?i.state!=='unknown':i.state!=='pending'))throw new AppError('Нет достаточного подтверждения, что создание было отклонено. Неопределённый результат не сброшен.',409);
  const name=pinterestBoardName(project),at=new Date().toISOString();
  return store.transaction(()=>{
    store.save('export-recovery',{id:randomUUID(),projectId:record.projectId,connectionId:record.connectionId,exportId:record.id,boardId:board.id,receiptId:unknown[0].id,previousName:board.name,newName:name,evidence,createdAt:at},record.projectId);
    store.save('pin-save',{...unknown[0],state:'rejected',rejection:'board-name-too-long',rejectedAt:at},record.projectId);
    const nextBoard={...board,state:'unbound',name,creationRejectedAt:at};store.save('board',nextBoard,record.projectId);
    store.save('pinterest-export',{...record,state:'prepared',items:record.items.map(i=>i.sourcePinId===first.pinId?{...i,state:'pending'}:i),message:'Pinterest отклонил слишком длинное название. Имя исправлено; создание доски ещё не выполнено.'},record.projectId);
    return nextBoard;
  });
}

export async function performPinterestExport({store,root,pinterest,record,connection,controller,reconcileOnly=false}){
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(600000)]),snapshot=store.get('selection',record.selectionId);
  const current=()=>store.get('pinterest-export',record.id),update=changes=>store.save('pinterest-export',{...current(),...changes},record.projectId);
  let board=store.get('board','board-'+record.projectId);
  const receiptId=pin=>'save-'+sha256(JSON.stringify({boardId:board.id,pinId:pin.pinId,sha256:pin.sha256}));
  const itemState=(pin,state,extra={})=>update({items:current().items.map(i=>i.sourcePinId===pin.pinId?{...i,state,...extra}:i)});
  const beforeWrite=pin=>{
    signal.throwIfAborted();
    store.transaction(()=>{store.save('pin-save',{id:receiptId(pin),boardId:board.id,projectId:record.projectId,connectionId:record.connectionId,sourcePinId:pin.pinId,assetSha256:pin.sha256,imageKey:imageKey(pin.imageUrl),state:'unknown',startedAt:new Date().toISOString()},record.projectId);itemState(pin,'unknown');});
  };
  async function read(expectedPin){
    let last;
    for(let attempt=0;attempt<3;attempt++){
      signal.throwIfAborted();last=await pinterest.readExportBoard(connection,board,signal);
      board=verifiedBoard(last.board,connection,board);store.save('board',board,record.projectId);
      if(last.complete===true&&(!expectedPin||matchSavedPin(expectedPin,last.pins)))return last.pins;
      if(attempt<2)await delay(600,undefined,{signal});
    }
    if(last.complete!==true)throw new AppError('Сверка доски не завершена. Запись новых пинов остановлена.',409);
    return last.pins;
  }
  function confirm(pin,saved){
    const receipt={id:receiptId(pin),boardId:board.id,projectId:record.projectId,connectionId:record.connectionId,sourcePinId:pin.pinId,assetSha256:pin.sha256,imageKey:imageKey(pin.imageUrl),savedPinId:saved.pinId,savedPinUrl:saved.pinUrl,boardUrl:board.url,state:'verified',verifiedAt:new Date().toISOString()};
    store.transaction(()=>{store.save('pin-save',receipt,record.projectId);itemState(pin,'verified',{savedPinId:saved.pinId,receiptId:receipt.id});});
  }
  try{
    if(!snapshot||snapshot.connectionId!==connection.id||record.connectionId!==connection.id||board.connectionId!==connection.id)throw new AppError('Экспорт принадлежит другому аккаунту',403);
    for(const pin of snapshot.items){signal.throwIfAborted();if(!imageKey(pin.imageUrl)||sha256(await fs.readFile(path.join(root,'assets',pin.asset)))!==pin.sha256)throw new AppError('Версия выбранного изображения не подтверждена. Экспорт остановлен.',409);}
    update({state:'running',message:reconcileOnly?'Сверяем сохранённое без новых записей…':'Проверяем секретную доску проекта…'});
    const first=snapshot.items[0];
    const found=await pinterest.ensureExportBoard(connection,board,first,{signal,readOnly:reconcileOnly||board.state!=='unbound',beforeCreate:()=>{
      beforeWrite(first);board={...board,state:'unknown',creationStartedAt:new Date().toISOString()};store.save('board',board,record.projectId);
    }});
    board=verifiedBoard(found,connection,board);store.save('board',board,record.projectId);
    for(const pin of snapshot.items){
      signal.throwIfAborted();
      update({message:'Сверяем пин '+(snapshot.items.indexOf(pin)+1)+' из '+snapshot.items.length});
      const saved=matchSavedPin(pin,await read()),previous=store.get('pin-save',receiptId(pin));
      if(saved){confirm(pin,saved);continue;}
      if(previous?.state==='verified'){itemState(pin,'conflict');throw new AppError('Ранее подтверждённый пин отсутствует на доске. Автоматически восстанавливать удалённое не будем.',409);}
      if(previous?.state==='unknown'||current().items.find(i=>i.sourcePinId===pin.pinId)?.state==='unknown'){
        itemState(pin,'unknown');continue; // Absence after a timeout is not permission to repeat the mutation.
      }
      if(reconcileOnly)continue;
      await pinterest.saveExportPin(connection,board,pin,{signal,beforeWrite:()=>beforeWrite(pin)});
      const actual=matchSavedPin(pin,await read(pin));
      if(actual)confirm(pin,actual);else{itemState(pin,'unknown');throw new AppError('Результат сохранения пока не подтверждён. Повторная запись не выполняется.',409);}
    }
    const items=current().items,complete=items.every(i=>i.state==='verified'),unknown=items.some(i=>i.state==='unknown');
    update({state:complete?'succeeded':unknown?'unknown':'partial',message:complete?'Все '+items.length+' выбранных пинов сверены на секретной доске.':unknown?'Есть неопределённые результаты. Сверьте доску; повторная запись этих пинов заблокирована.':'Сверка закончена. Для ещё не сохранённых пинов нужен явный запуск сохранения.',completedAt:new Date().toISOString()});
  }catch(error){
    await fs.mkdir(path.join(root,'diagnostics'),{recursive:true}).then(()=>fs.writeFile(path.join(root,'diagnostics',record.id+'-error.json'),JSON.stringify({at:new Date().toISOString(),message:String(error.message).slice(0,3000),boardState:board?.state}))).catch(()=>{});
    const items=current().items,unknown=items.some(i=>i.state==='unknown')||board?.state==='unknown';
    update({state:unknown?'unknown':error instanceof PinterestAccessError?'blocked':items.some(i=>i.state==='verified')?'partial':'error',message:controller.signal.aborted?'Экспорт остановлен. Подтверждённые и неопределённые результаты сохранены.':error instanceof AppError?error.message:signal.aborted?'Время экспорта истекло. Перед повтором нужна сверка.':'Не удалось завершить экспорт Pinterest. Сохранённые результаты не сброшены.'});
  }
}
