import { randomUUID } from 'node:crypto';
import { AppError,requiredText,OwnerStop,shortTitle } from './domain.mjs';
import { downloadAsset } from './assets.mjs';
import { rankCandidates } from './ranking.mjs';
import { PinterestAccessError } from './pinterest-access.mjs';
import {reserveRunAI} from './ai-budget.mjs';

export const REPLACEMENT_LIMITS={targets:5,candidates:20,attempts:3};
export const replacementRoot=run=>run.replacement?.rootRunId||run.id;
export const replacementAttempts=(store,run)=>store.list('run',run.projectId).filter(r=>r.replacement?.rootRunId===replacementRoot(run)).length;
const checkRevision=(run,revision)=>{if(!Number.isInteger(revision)||revision!==(run.revision||0))throw new AppError('Подборка изменилась. Обновите страницу и повторите действие.',409);};

export function createReplacement(store,parent,data){
  checkRevision(parent,data.revision);
  if(parent.sourceKind!=='live'||parent.status!=='ready'||parent.replacement&&['pending','review'].includes(parent.replacement.status))throw new AppError('Сначала завершите текущую подборку и просмотр вариантов замены',409);
  const ids=data.targetIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>REPLACEMENT_LIMITS.targets||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new AppError('Отметьте от одного до пяти изображений для замены');
  const targets=parent.candidates.filter(c=>ids.includes(c.id));
  if(targets.length!==ids.length)throw new AppError('Изображение для замены отсутствует в этой версии',409);
  const attempt=replacementAttempts(store,parent)+1;
  if(attempt>REPLACEMENT_LIMITS.attempts)throw new AppError('Для исходной подборки уже использованы три попытки замены. Создайте новое задание с уточнённым запросом.',409);
  if(typeof data.aiEnabled!=='boolean')throw new AppError('Выберите режим AI-отбора');
  const history=store.list('run',parent.projectId).filter(r=>r.replacement?.rootRunId===replacementRoot(parent));
  const reason=requiredText(data.reason,1000),searchQuery=requiredText(data.searchQuery,1000),seen=[...parent.candidates,...history.flatMap(r=>[...r.candidates,...r.replacement.pool])];
  const replacement={parentRunId:parent.id,rootRunId:replacementRoot(parent),baseRevision:parent.revision||0,attempt,reason,searchQuery,targetIds:targets.map(c=>c.id),status:'pending',pool:[],
    excludedPinIds:[...new Set([...(parent.replacement?.excludedPinIds||[]),...seen.map(c=>c.pinId)])],
    excludedHashes:[...new Set([...(parent.replacement?.excludedHashes||[]),...seen.map(c=>c.sha256)])],aiEnabled:data.aiEnabled};
  const run={id:randomUUID(),projectId:parent.projectId,connectionId:parent.connectionId,query:parent.query,interpretation:parent.interpretation,title:shortTitle(parent.title.replace(/ · замена \d+$/,''),55)+' · замена '+attempt,
    status:'queued',sourceKind:'live',createdAt:new Date().toISOString(),revision:0,candidates:parent.candidates,selectedIds:parent.selectedIds,uploads:parent.uploads||[],notes:parent.notes||'',mode:parent.mode,
    aiEnabled:parent.aiEnabled,...(parent.ai?{ai:{...parent.ai,inheritedFromRunId:parent.id}}:{}),...(parent.briefPreparation?{briefPreparation:parent.briefPreparation,entryKind:parent.entryKind,clarificationAnswer:parent.clarificationAnswer}:{}),searchEvidence:parent.searchEvidence,replacement,message:'Ищем варианты для отмеченных изображений…'};
  store.save('run',run,run.projectId);return run;
}

export function applyReplacement(store,run,data){
  const rep=run.replacement,mappings=data.mappings;
  if(!rep)throw new AppError('Это не версия с заменами',409);
  if(rep.status==='applied'){
    if(JSON.stringify(rep.appliedMappings)===JSON.stringify(mappings))return run;
    throw new AppError('Замены этой версии уже применены',409);
  }
  checkRevision(run,data.revision);
  if(rep.status!=='review')throw new AppError('Варианты замены ещё не готовы',409);
  if(!Array.isArray(mappings)||!mappings.length||mappings.length>rep.targetIds.length||mappings.some(m=>!m||typeof m.from!=='string'||typeof m.to!=='string')||new Set(mappings.map(m=>m.from)).size!==mappings.length||new Set(mappings.map(m=>m.to)).size!==mappings.length)throw new AppError('Некорректное сопоставление замен');
  const options=new Map(rep.pool.map(c=>[c.id,c])),changes=new Map();
  for(const m of mappings){if(!rep.targetIds.includes(m.from)||!run.candidates.some(c=>c.id===m.from)||!options.has(m.to))throw new AppError('Вариант отсутствует в этой версии замены',409);changes.set(m.from,options.get(m.to));}
  const candidates=run.candidates.map(c=>changes.get(c.id)||c);
  if(new Set(candidates.map(c=>c.pinId)).size!==candidates.length||new Set(candidates.map(c=>c.sha256)).size!==candidates.length)throw new AppError('Замена создаёт дубликат в подборке',409);
  const mapped=id=>changes.get(id)?.id||id,recommended=new Set(rep.ai?.recommendedIds||[]);
  const next={...run,revision:(run.revision||0)+1,status:'ready',candidates,selectedIds:run.selectedIds.map(mapped),
    ...(run.ai?{ai:{...run.ai,recommendedIds:(run.ai.recommendedIds||[]).filter(id=>!changes.has(id)||recommended.has(mapped(id))).map(mapped)}}:{}),
    replacement:{...rep,status:'applied',appliedMappings:mappings,appliedAt:new Date().toISOString()},
    message:'Применено '+mappings.length+' из '+rep.targetIds.length+' замен. Остальные изображения, порядок и выбор сохранены.'};
  store.save('run',next,run.projectId);return next;
}

export function discardReplacement(store,run,revision){
  checkRevision(run,revision);
  if(!run.replacement||!['pending','review'].includes(run.replacement.status))throw new AppError('Нет ожидающих вариантов замены',409);
  const next={...run,revision:(run.revision||0)+1,status:'ready',replacement:{...run.replacement,status:'discarded'},message:'Сохранён исходный набор этой версии. Новые варианты не применены.'};
  store.save('run',next,run.projectId);return next;
}

export async function performReplacement({store,pinterest,root,run,connection,uploads,controller,download=downloadAsset,rank=rankCandidates}){
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(360000)]),current=()=>store.get('run',run.id);
  const update=(changes={},rep={})=>store.save('run',{...current(),...changes,replacement:{...current().replacement,...rep}},run.projectId);
  const pool=[...(current().replacement.pool||[])],rep=current().replacement;
  const pinsSeen=new Set([...rep.excludedPinIds,...pool.map(c=>c.pinId)]),hashes=new Set([...rep.excludedHashes,...pool.map(c=>c.sha256)]);
  try{
    signal.throwIfAborted();update({status:'searching',blockReason:null,message:'Ищем новые варианты по уточнённому запросу…'});
    let pins=rep.source?.pins||[];
    if(!rep.source?.complete){
      pins=await pinterest.collect(connection,{...run,mode:'text',query:rep.searchQuery,interpretation:rep.searchQuery,candidateLimit:60,observedPins:pins},[],progress=>update({message:progress.message},{source:{...current().replacement.source,...(progress.pins?{pins:progress.pins}:{})}}),signal);
      update({},{source:{pins,complete:true}});
    }
    update({status:'downloading'});
    for(const pin of pins){
      signal.throwIfAborted();if(pool.length>=REPLACEMENT_LIMITS.candidates)break;if(pinsSeen.has(pin.pinId))continue;
      try{const candidate=await download(root,pin,signal);if(hashes.has(candidate.sha256))continue;pinsSeen.add(candidate.pinId);hashes.add(candidate.sha256);pool.push({...candidate,origin:'text'});update({message:'Загружено '+pool.length+' новых вариантов'},{pool:[...pool]});}
      catch(error){if(signal.aborted)throw error;}
    }
    if(!pool.length)throw new AppError('Новых подходящих изображений не найдено. Исходный набор сохранён; уточните поисковый запрос.');
    if(rep.aiEnabled&&current().replacement.ai?.status!=='ready'){
      update({status:'ranking',message:'AI оценивает новые варианты с учётом причины замены…'});
      try{
        const latest=current(),result=await rank({root,run:{...latest,ai:latest.replacement.ai,replacementReason:rep.reason},candidates:pool,uploads,excludedReferences:run.candidates.filter(c=>rep.targetIds.includes(c.id)),recommendationLimit:rep.targetIds.length,signal,
          onStart:(ai,cost)=>reserveRunAI(store,run,ai,{replacement:true,signal,cost}),onUsage:usage=>update({},{ai:{...current().replacement.ai,usage}})});
        signal.throwIfAborted();update({},{pool:result.candidates,ai:result.ai});
      }catch(error){if(signal.aborted)throw error;update({},{ai:{...current().replacement.ai,status:current().replacement.ai?.status==='unknown'?'unknown':'error',message:error.message}});}
    }
    signal.throwIfAborted();
    const ai=current().replacement.ai;
    update({status:'ready',completedAt:new Date().toISOString(),message:ai?.status==='ready'?'Готовы варианты замены. Проверьте и примените нужные.':'Новые варианты доступны для ручного выбора. Исходная подборка сохранена.'},{status:'review'});
  }catch(error){
    const paused=error instanceof PinterestAccessError&&!signal.aborted,ai=current().replacement.ai;
    const interrupted=controller.signal.reason instanceof OwnerStop,cancelled=controller.signal.aborted&&!interrupted;
    update({status:interrupted?'interrupted':cancelled?'cancelled':paused?'blocked':'error',blockReason:paused?error.code:null,
      message:interrupted?'Поиск замены остановлен: PMA заблокирована, сменился аккаунт или сервис закрыт. Исходный набор и варианты сохранены; можно продолжить.':cancelled?'Замена остановлена. Исходный набор и загруженные варианты сохранены.':error instanceof AppError?error.message:signal.aborted?'Время поиска замены истекло. Исходный набор сохранён.':'Не удалось получить варианты замены. Исходный набор сохранён.'},
      {status:pool.length?'review':'pending',...(ai?.status==='running'?{ai:{...ai,status:cancelled?'cancelled':'unknown',message:'Оценка остановлена. Автоматического повтора нет.'}}:{})});
  }
}
