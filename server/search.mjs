import { downloadAsset } from './assets.mjs';
import { AppError,LIMITS,OwnerStop } from './domain.mjs';
import { PinterestAccessError } from './pinterest-access.mjs';
import { rankCandidates } from './ranking.mjs';
import {reserveRunAI} from './ai-budget.mjs';

export async function performSearch({store,pinterest,root,run,connection,uploads,controller,download=downloadAsset,rank=rankCandidates}){
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(run.aiEnabled?540000:360000)]);
  const current=()=>store.get('run',run.id);
  const update=changes=>store.save('run',{...current(),...changes},run.projectId);
  const candidates=[...(current().candidates||[])],seen=new Set(candidates.map(c=>c.sha256)),downloaded=new Set(candidates.map(c=>c.pinId));let failed=0;
  const max=run.aiEnabled?50:LIMITS.candidates;
  async function collectSource(key,mode,limit){
    const saved=current().searchSources?.[key];
    if(saved?.complete)return saved.pins;
    const brief={...run,mode,candidateLimit:limit,observedPins:saved?.pins||(key==='primary'?current().observedPins:[])||[]};
    const checkpoint=(progress,complete=false)=>{
      const sources={...(current().searchSources||{})},previous=sources[key]||{};
      sources[key]={...previous,...(progress.pins?{pins:progress.pins}:{}),complete};
      const all=Object.values(sources).flatMap(s=>s.pins||[]);
      update({searchSources:sources,foundCount:new Set(all.map(p=>p.pinId)).size,
        ...(key==='primary'&&progress.pins?{observedPins:progress.pins}:{}),
        ...(key==='primary'&&progress.searchEvidence?{searchEvidence:progress.searchEvidence}:{}),
        message:key==='supplemental'?'Дополняем Lens текстовым поиском Pinterest: '+(progress.message||''):progress.message});
    };
    const pins=await pinterest.collect(connection,brief,uploads,progress=>checkpoint(progress),signal);
    checkpoint({pins,message:'Поиск Pinterest завершён'},true);return pins;
  }
  async function load(pins,cap,origin){
    update({status:'downloading'});
    for(const pin of pins){
      signal.throwIfAborted();if(candidates.length>=cap)break;if(downloaded.has(pin.pinId))continue;
      try{
        const c=await download(root,pin,signal);if(seen.has(c.sha256))continue;
        seen.add(c.sha256);downloaded.add(c.pinId);candidates.push({...c,origin});
        update({candidates:[...candidates],message:'Загружено '+candidates.length+' из '+max+' изображений'});
      }catch(error){if(signal.aborted)throw error;failed++;}
    }
  }
  try{
    update({status:'searching',blockReason:null,completedAt:null});
    const primary=await collectSource('primary',run.mode,run.aiEnabled&&run.mode==='image'?30:60);
    if(run.mode==='image'){
      const evidence=current().searchEvidence;
      if(evidence?.strategy!=='pinterest-lens'||evidence.seedUploadId!==uploads[0]?.id)throw new AppError('Запуск Pinterest Lens по исходному фото не подтверждён. Подборка не выдана за поиск по фото.',409);
    }
    await load(primary,run.aiEnabled&&run.mode==='image'?25:max,run.mode==='image'?'lens':'text');
    if(run.aiEnabled&&run.mode==='image'){
      update({status:'searching',message:'Дополняем Lens поиском по вашему тексту…'});
      try{const extra=await collectSource('supplemental','text',40);await load(extra,max,'text');}
      catch(error){
        if(signal.aborted||error instanceof PinterestAccessError||!(error instanceof AppError)||error.status!==400)throw error;
        update({searchWarning:'Дополнительный текстовый поиск не дал кандидатов. Сохранена выдача Lens.'});
      }
      await load(primary,max,'lens');
    }
    if(!candidates.length)throw new AppError('Не удалось загрузить изображения. Проверьте сеть и попробуйте другой запрос.');
    const savedAI=current().ai;
    const reusable=savedAI?.status==='ready'&&savedAI.candidateCount===candidates.length&&candidates.every(c=>c.ai);
    if(run.aiEnabled&&!reusable){
      update({status:'ranking',message:'AI оценивает '+candidates.length+' изображений по заданию и примерам…'});
      try{
        const result=await rank({root,run:current(),candidates:[...candidates],uploads,signal,
          onStart:(ai,cost)=>reserveRunAI(store,run,ai,{signal,cost}),onUsage:usage=>update({ai:{...current().ai,usage}})});
        signal.throwIfAborted();update(result);
      }catch(error){
        if(signal.aborted)throw error;
        update({ai:{...current().ai,status:current().ai?.status==='unknown'?'unknown':'error',message:error.message||'Не удалось выполнить AI-отбор. Исходные изображения сохранены.'}});
      }
    }
    signal.throwIfAborted();
    const ai=current().ai;
    update({status:'ready',completedAt:new Date().toISOString(),downloadFailures:failed,message:run.aiEnabled?
      ai?.status==='ready'?'AI предложил '+ai.recommendedIds.length+' из '+candidates.length+' изображений. Проверьте рекомендации и сделайте свой выбор.':'AI-отбор не завершён. Доступны все '+candidates.length+' найденных изображений для ручного выбора.':
      candidates.length<LIMITS.candidates?'Найдено '+candidates.length+' изображений. Можно уточнить запрос, если нужно больше вариантов.':'Подборка готова. Проверьте соответствие заданию и выберите изображения.'});
  }catch(error){
    const paused=error instanceof PinterestAccessError&&!controller.signal.aborted&&!signal.aborted,ai=current().ai;
    const interrupted=controller.signal.reason instanceof OwnerStop,cancelled=controller.signal.aborted&&!interrupted;
    update({status:interrupted?'interrupted':cancelled?'cancelled':paused?'blocked':'error',blockReason:paused?error.code:null,completedAt:new Date().toISOString(),
      ...(ai?.status==='running'?{ai:{...ai,status:cancelled?'cancelled':'unknown',message:'AI был остановлен. Повтор автоматически не выполняется.'}}:{}),
      message:interrupted?'Поиск остановлен: PMA заблокирована, сменился аккаунт или сервис закрыт. Сохранённые результаты на месте; можно продолжить.':cancelled?'Поиск отменён. Уже загруженные изображения сохранены.':error instanceof AppError?error.message:signal.aborted?'Поиск остановлен по пределу времени. Промежуточные результаты сохранены.':'Ошибка подключения к Pinterest. Проверьте открытый браузер и сеть.'});
  }
}
