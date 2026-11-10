// Desktop AI over the owner's own API profile. The executor plugs into interpretation/ranking through
// the same {catalog, estimate, invoke} seam as the legacy Codex CLI. Money is reserved as a proven upper
// bound before sending and settled from usage afterwards; nothing is retried or swapped silently.
import fs from 'node:fs/promises';
import path from 'node:path';
import {AppError,sha256} from './domain.mjs';
import {checkEndpoint,postJson} from './ai-endpoint.mjs';

export const WIRE_FORMATS=['responses','chat-completions'];
export const MAX_POOL_CALLS=100;
const REQUEST_OVERHEAD_TOKENS=512;
export const profileId=connectionId=>'ai-profile-'+connectionId;

const int=(value,min,max,label)=>{if(!Number.isInteger(value)||value<min||value>max)throw new AppError(label+': целое от '+min+' до '+max,400);return value;};
const price=(value,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1e6)throw new AppError(label+': неотрицательное число',400);return value;};

// Owner-entered profile. Saving never calls a model; any change requires a new explicit paid check.
export function validateProfile(input){
  if(!input||typeof input!=='object')throw new AppError('Ожидался профиль AI',400);
  const {baseUrl,wireFormat,model,images={},limits={},tariff={},budget={},enabled}=input;
  if(!WIRE_FORMATS.includes(wireFormat))throw new AppError('Формат API: responses или chat-completions',400);
  if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(model))throw new AppError('Укажите ID модели',400);
  if(typeof images.supported!=='boolean')throw new AppError('Укажите, принимает ли модель изображения',400);
  if(typeof tariff.currency!=='string'||!/^[A-Z]{3}$/.test(tariff.currency))throw new AppError('Валюта тарифа: трёхбуквенный код, например USD',400);
  if(typeof tariff.checkedAt!=='string'||Number.isNaN(Date.parse(tariff.checkedAt)))throw new AppError('Укажите дату проверки тарифа',400);
  if(typeof budget.monthlyLimit!=='number'||!(budget.monthlyLimit>0)||budget.monthlyLimit>1e6)throw new AppError('Месячный денежный предел должен быть больше нуля',400);
  return {
    baseUrl:checkEndpoint(baseUrl),wireFormat,model,enabled:enabled!==false,
    images:images.supported?{supported:true,maxPerRequest:int(images.maxPerRequest,1,64,'Изображений за запрос'),maxInputTokensPerImage:int(images.maxInputTokensPerImage,1,1e6,'Верхний предел токенов на изображение')}:{supported:false,maxPerRequest:0,maxInputTokensPerImage:0},
    limits:{maxOutputTokens:int(limits.maxOutputTokens,64,200000,'Предел вывода'),maxInputTokens:limits.maxInputTokens==null?null:int(limits.maxInputTokens,1000,10000000,'Предел входа')},
    tariff:{currency:tariff.currency,inputPerMillion:price(tariff.inputPerMillion,'Цена входа за 1 млн токенов'),outputPerMillion:price(tariff.outputPerMillion,'Цена вывода за 1 млн токенов'),
      // Reasoning tokens must be billed as output and counted inside the output limit, or there is no upper bound.
      outputLimitCoversReasoning:tariff.outputLimitCoversReasoning===true,checkedAt:new Date(tariff.checkedAt).toISOString()},
    budget:{monthlyLimit:budget.monthlyLimit,monthlyCalls:int(budget.monthlyCalls??MAX_POOL_CALLS,1,MAX_POOL_CALLS,'Предел вызовов в месяц')},
  };
}
export const profileHash=p=>sha256(JSON.stringify({baseUrl:p.baseUrl,wireFormat:p.wireFormat,model:p.model,images:p.images,limits:p.limits,tariff:p.tariff,keySetAt:p.keySetAt||null}));
const toMicros=units=>Math.ceil(units*1e6);

// Upper bound for one request. Text tokens ≤ UTF-8 bytes (+ fixed overhead); each image ≤ the owner's
// per-image bound; output (including reasoning) ≤ the enforced output limit. Unknown parts block the call.
export function upperCost(profile,{prompt,schema,imageCount}){
  if(!profile.tariff.outputLimitCoversReasoning)throw new AppError('Не подтверждено, что рассуждения модели входят в предел вывода. Верхнюю стоимость нельзя оценить; платный вызов закрыт.',409);
  if(imageCount&&!profile.images.supported)throw new AppError('Модель профиля не принимает изображения. Этот шаг AI недоступен.',409);
  if(imageCount>profile.images.maxPerRequest)throw new AppError('Изображений больше ('+imageCount+'), чем модель принимает за один запрос ('+profile.images.maxPerRequest+'). Дополнительные вызовы не делаются.',409);
  const inputTokens=Buffer.byteLength(prompt)+Buffer.byteLength(JSON.stringify(schema))+REQUEST_OVERHEAD_TOKENS+imageCount*profile.images.maxInputTokensPerImage;
  if(profile.limits.maxInputTokens&&inputTokens>profile.limits.maxInputTokens)throw new AppError('Запрос может превысить предел входа модели. Платный вызов не отправлен.',409);
  return {inputTokens,micros:Math.ceil(inputTokens*profile.tariff.inputPerMillion+profile.limits.maxOutputTokens*profile.tariff.outputPerMillion)};
}
export function actualMicros(profile,usage){
  if(!usage||!Number.isInteger(usage.inputTokens)||!Number.isInteger(usage.outputTokens))return null;
  return Math.ceil(usage.inputTokens*profile.tariff.inputPerMillion+usage.outputTokens*profile.tariff.outputPerMillion);
}

const imageMime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
async function dataUrls(images){return Promise.all(images.map(async file=>'data:'+(imageMime[path.extname(file).toLowerCase()]||'application/octet-stream')+';base64,'+(await fs.readFile(file)).toString('base64')));}

export function requestBody(profile,{prompt,schema,urls}){
  if(profile.wireFormat==='responses')return {model:profile.model,store:false,max_output_tokens:profile.limits.maxOutputTokens,
    input:[{role:'user',content:[{type:'input_text',text:prompt},...urls.map(url=>({type:'input_image',image_url:url}))]}],
    text:{format:{type:'json_schema',name:'pma_result',schema,strict:true}}};
  return {model:profile.model,max_tokens:profile.limits.maxOutputTokens,stream:false,n:1,
    messages:[{role:'user',content:[{type:'text',text:prompt},...urls.map(url=>({type:'image_url',image_url:{url}}))]}],
    response_format:{type:'json_schema',json_schema:{name:'pma_result',schema,strict:true}}};
}
// Returns {text, usage}; anything but one complete plain-text answer is rejected, never executed.
export function parseResponse(profile,data){
  if(!data||typeof data!=='object')throw new AppError('API вернул не JSON',502);
  if(profile.wireFormat==='responses'){
    if(data.status!=='completed')throw new AppError('Ответ модели неполный ('+(data.incomplete_details?.reason||data.status||'нет статуса')+')',502);
    const items=Array.isArray(data.output)?data.output:[];
    if(items.some(i=>!['message','reasoning'].includes(i.type)))throw new AppError('Модель вернула вызов инструмента вместо ответа. Ничего не исполнено.',502);
    const parts=items.filter(i=>i.type==='message').flatMap(i=>i.content||[]);
    if(parts.some(p=>p.type==='refusal'))throw new AppError('Модель отказалась отвечать',502);
    const texts=parts.filter(p=>p.type==='output_text');if(texts.length!==1)throw new AppError('Ответ модели не содержит одного результата',502);
    const u=data.usage;return {text:texts[0].text,usage:u?{inputTokens:u.input_tokens,outputTokens:u.output_tokens,reasoningTokens:u.output_tokens_details?.reasoning_tokens??null}:null};
  }
  const choices=Array.isArray(data.choices)?data.choices:[];
  if(choices.length!==1)throw new AppError('Ответ модели не содержит одного варианта',502);
  const {message,finish_reason}=choices[0];
  if(message?.tool_calls?.length||message?.function_call)throw new AppError('Модель вернула вызов инструмента вместо ответа. Ничего не исполнено.',502);
  if(message?.refusal)throw new AppError('Модель отказалась отвечать',502);
  if(finish_reason!=='stop')throw new AppError('Ответ модели неполный ('+(finish_reason||'нет причины')+')',502);
  if(typeof message?.content!=='string')throw new AppError('Ответ модели не содержит текста',502);
  const u=data.usage;return {text:message.content,usage:u?{inputTokens:u.prompt_tokens,outputTokens:u.completion_tokens,reasoningTokens:u.completion_tokens_details?.reasoning_tokens??null}:null};
}

function blockProfile(store,connectionId,reason){
  const p=store.get('ai-profile',profileId(connectionId));
  if(p)store.save('ai-profile',{...p,verification:null,blockedReason:reason});
}

// Executor bound to one owner. vault.get(connectionId) returns the key from the OS-protected store.
export function createApiExecutor({store,connectionId,vault,post=postJson,probe=false}){
  const usable=()=>{
    const p=store.get('ai-profile',profileId(connectionId));
    if(!p)throw new AppError('AI не настроен: задайте профиль API в настройках PMA. Ручной путь доступен.',409);
    if(!p.enabled)throw new AppError('AI выключен владельцем в настройках PMA',409);
    if(p.blockedReason)throw new AppError(p.blockedReason,409);
    if(!p.keySetAt)throw new AppError('Не задан ключ API',409);
    if(!probe&&p.verification?.profileHash!==profileHash(p))throw new AppError('Профиль API ещё не проверен. Запустите платную проверку в настройках PMA.',409);
    if(!store.ledger)throw new AppError('Учёт расхода недоступен; платный AI закрыт',409);
    if(store.ledger.blocked)throw new AppError(store.ledger.blocked,409);
    return p;
  };
  return {
    catalog:async()=>[{id:usable().model}],
    // Called before the reservation: the cost travels with it into the ledger transaction.
    estimate:({prompt,schema,images=[]})=>{
      const p=usable(),{micros}=upperCost(p,{prompt,schema,imageCount:images.length});
      return {currency:p.tariff.currency,micros,monthlyLimitMicros:toMicros(p.budget.monthlyLimit),callLimit:p.budget.monthlyCalls,
        snapshot:{profileHash:profileHash(p),host:new URL(p.baseUrl).host,wireFormat:p.wireFormat,model:p.model,tariff:p.tariff,limits:p.limits,images:p.images}};
    },
    invoke:async({images=[],prompt,schema,signal,reservation})=>{
      const p=usable();
      if(!reservation?.id||!reservation.cost)throw new AppError('Нет денежного резерва для вызова; запрос не отправлен',409);
      const key=await vault.get(connectionId);
      if(!key)throw new AppError('Ключ API не найден в защищённом хранилище',409);
      const started=Date.now(),url=p.baseUrl+(p.wireFormat==='responses'?'/responses':'/chat/completions');
      const {status,data}=await post(url,{headers:{Authorization:'Bearer '+key},body:requestBody(p,{prompt,schema,urls:await dataUrls(images)}),signal});
      if(status<200||status>=300)throw new AppError('API ответил '+status+(data?.error?.message?': '+String(data.error.message).slice(0,200):'')+'. Резерв сохранён; автоматического повтора нет.',status===401||status===403?409:502);
      const {text,usage}=parseResponse(p,data);
      const actual=actualMicros(p,usage);
      if(actual===null)blockProfile(store,connectionId,'API не сообщил расход токенов. Фактическую стоимость нельзя сверить; платный AI закрыт до новой проверки.');
      else{
        store.ledger.settle(reservation.id,actual);
        if(actual>reservation.cost.micros)blockProfile(store,connectionId,'Фактическая стоимость превысила верхнюю оценку. Проверьте тариф и пределы профиля; платный AI закрыт до новой проверки.');
      }
      let response;try{response=JSON.parse(text);}catch{throw new AppError('Модель вернула не JSON',502);}
      return {response,usage:usage&&{...usage,costMicros:actual,currency:p.tariff.currency},elapsedMs:Date.now()-started,completedAt:new Date().toISOString()};
    },
  };
}
