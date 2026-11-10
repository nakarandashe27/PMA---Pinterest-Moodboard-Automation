import {AppError,sha256} from './domain.mjs';

export const DEFAULT_MONTHLY_CALLS=100;
const monthAt=date=>{
  const parts=new Intl.DateTimeFormat('en',{year:'numeric',month:'2-digit',timeZone:'Europe/Moscow'}).formatToParts(date);
  return parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value;
};
const reservationId=slot=>'ai-reservation-'+sha256(slot);
function historicalReservations(store,now){
  const reserve=(slot,record,ai,amount)=>{
    if(!amount||store.get('ai-reservation',reservationId(slot)))return;
    const date=new Date(ai?.startedAt||record.createdAt||now);
    store.save('ai-reservation',{id:reservationId(slot),slot,connectionId:record.connectionId,projectId:record.projectId,amount,month:monthAt(Number.isNaN(date.valueOf())?now:date),legacy:true},record.projectId);
  };
  for(const r of store.list('run')){
    if(!r.ai?.inheritedFromRunId)reserve('search:'+r.id,r,r.ai,r.ai?.callCount||0);
    reserve('replacement:'+r.id,r,r.replacement?.ai,r.replacement?.ai?.callCount||0);
  }
  for(const e of store.list('evaluation'))if(!e.budgetManaged)reserve('evaluation:'+e.id,e,null,e.maxCliRuns||2);
}
// Turns historic AI usage recorded on runs/evaluations into reservations (once), so a new ledger starts from it.
export function importLegacyReservations(store,now=new Date()){store.transaction(()=>historicalReservations(store,now));}
export function reserveAICall(store,record,slot,{signal,now=new Date(),limit=Number(process.env.PMA_AI_MONTHLY_CALLS||DEFAULT_MONTHLY_CALLS),save=()=>{},cost=null}={}){
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw new AppError('Задайте конечный PMA_AI_MONTHLY_CALLS от 1 до 100000',409);
  if(cost&&!store.ledger)throw new AppError('Платный API-вызов возможен только с учётом расхода настольной PMA',409);
  if(store.ledger){
    // Desktop: the ledger commits first and is never rolled back. A failure while linking the
    // project record keeps the reservation (conservative) and the slot cannot be reserved again.
    const reservation=store.ledger.reserve({id:reservationId(slot),slot,connectionId:record.connectionId,projectId:record.projectId,month:monthAt(now),amount:1,createdAt:now.toISOString()},limit,cost);
    store.transaction(()=>{save();const binding=store.get('ledger-binding','ledger-binding');store.save('ledger-binding',{id:'ledger-binding',ledgerId:store.ledger.id,seq:Math.max(binding?.seq||0,reservation.seq)});});
    return reservation;
  }
  return store.transaction(()=>{
    signal?.throwIfAborted();historicalReservations(store,now);
    const id=reservationId(slot),month=monthAt(now);
    if(store.get('ai-reservation',id))throw new AppError('Лимит AI этого шага уже использован. Неизвестный результат не повторяется.',409);
    const used=store.list('ai-reservation').filter(r=>r.month===month).reduce((sum,r)=>sum+r.amount,0);
    if(used>=limit)throw new AppError('Общий месячный предел PMA исчерпан ('+limit+' запусков). Исходные данные сохранены; можно продолжить вручную.',409);
    const reservation={id,slot,connectionId:record.connectionId,projectId:record.projectId,month,amount:1,createdAt:now.toISOString()};
    store.save('ai-reservation',reservation,record.projectId);save();return reservation;
  });
}
export function reserveRunAI(store,run,ai,{replacement=false,signal,...options}={}){
  // cost (paid API) arrives via options and is reserved together with the call slot.
  return reserveAICall(store,run,(replacement?'replacement:':'search:')+run.id,{...options,signal,save:()=>{
    const current=store.get('run',run.id),previous=replacement?current?.replacement?.ai:current?.ai;
    if(!current||current.connectionId!==run.connectionId||current.projectId!==run.projectId||(previous?.callCount||0)>=1)throw new AppError('Лимит AI этого задания уже использован',409);
    store.save('run',replacement?{...current,replacement:{...current.replacement,ai}}:{...current,ai},run.projectId);
  }});
}
