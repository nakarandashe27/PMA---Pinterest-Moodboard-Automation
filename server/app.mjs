import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {LocalAuth,setLocalPassword} from './local-auth.mjs';
import { performSearch } from './search.mjs';
import {createInterpretation,interpretationView,performInterpretation,confirmedInterpretation} from './interpretation.mjs';
import { createReplacement,applyReplacement,discardReplacement,performReplacement,replacementAttempts,REPLACEMENT_LIMITS } from './replacement.mjs';
import { prepareExport,exportView,createFigmaAttempt,claimFigma,recordFigmaReceipt } from './exports.mjs';
import { performPinterestExport,verifiedBoard } from './export-pinterest.mjs';
import {rankCandidates} from './ranking.mjs';
import {validateProfile,profileHash,profileId} from './ai-api.mjs';
import {probeProfile} from './ai-probe.mjs';
import { AppError,OwnerStop,LIMITS,shortTitle,requiredText,text,selectedItems,mediaType,sha256 } from './domain.mjs';

// Plugin↔app protocol. The plugin sends ?protocol=N on every call; a mismatch stops before any read or write.
export const FIGMA_PROTOCOL=2;
export function createPmaServer({workspace,root,store,pinterest,port=8787,dev=false,figmaOnly=false,freeSpace=null,minFreeBytes=300*1024*1024,aiExecutor=null,vault=null,aiPost,diagnostics=null,figmaStatus=null,authOptions={},interpretationOptions={}}){
const jobs=new Map();
const requestContext=new AsyncLocalStorage();
let changingConnection=false;
async function changeConnection(work){
  if(changingConnection)throw new AppError('Подключение уже меняется. Дождитесь завершения.',409);
  changingConnection=true;try{return await work();}finally{changingConnection=false;}
}
async function stopOwner(){
  const pending=[...jobs.values()];for(const controller of pending)controller.abort(new OwnerStop());
  await pinterest.close();await Promise.allSettled(pending.map(c=>c.done));
}
const auth=new LocalAuth(store,{...authOptions,onLock:()=>{stopOwner().catch(()=>{});}});
const expiryTimer=setInterval(()=>auth.current(),1000);expiryTimer.unref();
const csrf=randomBytes(32).toString('base64url');
const localOrigins=new Set(['http://127.0.0.1:'+port,'http://localhost:'+port]);
if(dev){localOrigins.add('http://127.0.0.1:5173');localOrigins.add('http://localhost:5173');}
const activeId=()=>auth.owner(requestContext.getStore());
const activeConnection=()=>store.get('connection',activeId()||'');
const projectFor=id=>{
  const p=store.get('project',id);if(!p)throw new AppError('Проект не найден',404);
  if(!p.ownerConnectionId||p.ownerConnectionId!==activeId())throw new AppError('Нет доступа к проекту этого владельца',403);
  return p;
};
const runFor=id=>{const r=store.get('run',id);if(!r)throw new AppError('Подборка не найдена',404);const p=projectFor(r.projectId);if(r.connectionId!==p.ownerConnectionId)throw new AppError('Не совпал владелец подборки',403);return r;};
const exportFor=id=>{
  const e=store.get('export',id);if(!e)throw new AppError('Экспорт не найден',404);const p=projectFor(e.projectId),s=store.get('selection',e.selectionId);
  if(e.connectionId!==p.ownerConnectionId||!s||s.connectionId!==e.connectionId||s.projectId!==p.id)throw new AppError('Не совпал владелец экспортного снимка',403);return e;
};
function requireAsset(asset){
  const owner=activeId(),owns=record=>record.connectionId===owner&&owner&&store.get('project',record.projectId)?.ownerConnectionId===owner;
  const accessible=store.list('run').some(r=>owns(r)&&[...r.candidates,...(r.replacement?.pool||[])].some(c=>c.asset===asset))||store.list('selection').some(s=>owns(s)&&s.items.some(c=>c.asset===asset))||store.list('evaluation').some(e=>owns(e)&&e.candidates.some(c=>c.asset===asset));
  if(!accessible)throw new AppError('Изображение не найдено',404);
}
const json=(res,data,status=200,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
const BODY_LIMIT=36*1024*1024;
// Transport-specific readers return parsed JSON; the owner re-check after the await is shared.
async function readHttpBody(req){
  if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError('Ожидался JSON',415);
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>BODY_LIMIT)throw new AppError('Запрос слишком большой',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('Некорректный JSON');}
}
async function body(read){
  const owner=activeId(),data=await read();
  if(owner&&owner!==activeId())throw new AppError('Подключение сменилось во время запроса. Откройте страницу заново.',401);
  return data;
}
function viewRun(run){
  const {observedPins,searchSources,...publicRun}=run;
  const saved=searchSources?new Set(Object.values(searchSources).flatMap(s=>s.pins||[]).map(p=>p.pinId)).size:observedPins?.length||0;
  const candidateView=({asset,...c})=>({...c,mediaUrl:'/media/assets/'+asset});
  let replacement;
  if(run.replacement){const {source,excludedPinIds,excludedHashes,pool,...metadata}=run.replacement;replacement={...metadata,pool:pool.map(candidateView)};}
  return {...publicRun,revision:run.revision||0,...(replacement?{replacement}:{}),replacementAttemptsRemaining:Math.max(0,REPLACEMENT_LIMITS.attempts-replacementAttempts(store,run)),savedPinCount:saved,candidates:run.candidates.map(candidateView),uploads:(run.uploads||[]).map(id=>{const u=store.get('upload',id);return u?{id:u.id,name:u.name,notes:u.notes,url:'/media/uploads/'+u.id}:null;}).filter(Boolean)};
}
function connectionView(c){return {id:c.id,label:c.label,username:c.username,status:c.status,passwordConfigured:auth.protected(c.id)};}
async function openConnection(c){
  try{await pinterest.open(c);return connectionView(c);}
  catch(error){
    const message=String(error?.message||'');
    const browserError=/ERR_NETWORK_ACCESS_DENIED/.test(message)?'Chrome не получил разрешение на сетевой доступ к Pinterest. Подключение сохранено; после исправления запуска откройте Pinterest снова.':/SingletonLock|ProcessSingleton|profile.*in use/i.test(message)?'Этот профиль Chrome уже открыт другим процессом. Закройте его служебное окно и откройте Pinterest снова.':'Не удалось открыть Pinterest. Подключение и локальный пароль сохранены; попробуйте открыть Pinterest снова.';
    console.warn('Pinterest connection: '+browserError);return {...connectionView(c),browserError};
  }
}
function startSearch(run,connection,uploads){
  const controller=new AbortController();jobs.set(run.id,controller);
  // Desktop: ranking uses the owner's API profile; there is no silent fallback to the Codex CLI.
  const rank=aiExecutor?args=>rankCandidates({...args,...aiExecutor(connection.id)}):undefined;
  controller.done=Promise.resolve().then(()=>(run.replacement?performReplacement:performSearch)({store,pinterest,root,run,connection,uploads:uploads.map(u=>({...u,path:path.join(root,'uploads',u.filename)})),controller,rank})).finally(()=>jobs.delete(run.id));
  controller.done.catch(error=>console.error('Search worker failed:',error.message));
}
function interpretationFor(id){
  const record=store.get('interpretation',id);if(!record)throw new AppError('Подготовка запроса не найдена',404);projectFor(record.projectId);
  if(record.connectionId!==activeId())throw new AppError('Нет доступа к подготовке другого владельца',403);return record;
}
function startInterpretation(record){
  const controller=new AbortController();jobs.set(record.id,controller);
  controller.done=Promise.resolve().then(()=>performInterpretation({store,root,record,controller,...interpretationOptions,...(aiExecutor?aiExecutor(record.connectionId):{})})).finally(()=>jobs.delete(record.id));
  controller.done.catch(()=>console.error('Interpretation worker failed; input retained.'));
}
async function makeExport(run){
  const result=await prepareExport(store,root,run,projectFor(run.projectId));
  projectFor(run.projectId);const pair=store.get('pairing','pair-'+sha256(result.code));
  store.save('pairing',{...pair,sessionTokenHash:sha256(requestContext.getStore().token)},pair.projectId);
  // Desktop without its own Figma listener (port taken): never show a code that would reach another process.
  const figma=figmaStatus?.();if(figma&&!figma.available)return {...result,code:null,figmaUnavailable:figma.reason};
  return result;
}
async function reissueExport(exp){
  const s=store.get('selection',exp.selectionId);
  return makeExport({id:s.runId,projectId:s.projectId,connectionId:s.connectionId,query:s.query,title:s.title,status:'ready',candidates:s.items,selectedIds:s.items.map(c=>c.id)});
}
function paired(req){
  const authorization=req.headers.authorization;
  if(!authorization?.startsWith('Bearer '))throw new AppError('Введите код подключения из PMA',401);
  const digest=sha256(authorization.slice(7));
  const match=store.get('pairing','pair-'+digest);
  if(!match||match.expiresAt<Date.now())throw new AppError('Код истёк или не найден. Подготовьте Figma в PMA ещё раз.',401);
  const session=auth.current(),exp=store.get('export',match.exportId),attempt=store.get('figma-attempt',match.attemptId),snapshot=store.get('selection',exp?.selectionId),project=store.get('project',match.projectId);
  if(!session||!match.sessionTokenHash||match.sessionTokenHash!==sha256(session.token)||match.connectionId!==session.connectionId)throw new AppError('Подключение PMA заблокировано или сменилось. Откройте исходный аккаунт и обновите код.',401);
  if(!exp||!attempt||!snapshot||!project||[exp,attempt,snapshot].some(r=>r.connectionId!==match.connectionId||r.projectId!==match.projectId)||project.ownerConnectionId!==match.connectionId||attempt.exportId!==exp.id||attempt.selectionId!==snapshot.id||attempt.snapshotHash!==exp.snapshotHash)throw new AppError('Не совпали владелец и снимок подключения Figma',403);
  return match;
}
const cors={'Access-Control-Allow-Origin':'null','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Vary':'Origin'};
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
async function sendFile(res,file,extra={},authorize=()=>{}){
  const bytes=await fs.readFile(file);
  authorize();
  res.writeHead(200,{'Content-Type':contentTypes[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache',...extra});res.end(bytes);
}
const reply=(data,status=200,extra={})=>({status,data,...extra});
const moscowMonth=(date=new Date())=>{const parts=new Intl.DateTimeFormat('en',{year:'numeric',month:'2-digit',timeZone:'Europe/Moscow'}).formatToParts(date);return parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value;};
async function fileReply(file,headers={},authorize=()=>{}){
  const bytes=await fs.readFile(file);authorize();
  return {status:200,bytes,headers:{'Content-Type':contentTypes[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache',...headers}};
}
// Transport-independent operations shared by dev HTTP and desktop IPC. Owner, project, run,
// upload, export and revision checks live here, never in a transport adapter.
async function dispatch({method,route,readBody=async()=>{throw new AppError('Ожидался JSON',415);}}){
  const started=requestContext.getStore(),result=await dispatchRoute(method,route,readBody);
  // A reply computed for a session that was locked, switched or expired meanwhile is not delivered.
  if(started&&!('session' in result)&&auth.current()!==started)throw new AppError('Подключение сменилось во время запроса. Откройте страницу заново.',401);
  return result;
}
// Operations that download, upload or package files need disk space; cancel/selection/discard never do.
const NEEDS_SPACE=/^\/api\/(?:runs|uploads)$|\/(?:resume|replacements|export|figma|figma-code|figma-new-attempt|pinterest|pinterest-reconcile)$/;
async function dispatchRoute(method,route,readBody){
  if(freeSpace&&method!=='GET'&&NEEDS_SPACE.test(route)&&freeSpace()<minFreeBytes)throw new AppError('На диске осталось меньше '+Math.round(minFreeBytes/1048576)+' МБ. Освободите место: PMA не удаляет данные сама. Отмена и выбор доступны.',507);
    if(route.startsWith('/api/')){
      const parts=route.split('/').filter(Boolean);
      if(route==='/api/bootstrap'&&method==='GET'){return reply({token:csrf,activeConnectionId:activeId(),sessionExpiresAt:activeId()?auth.current().expiresAt:null,connections:store.list('connection').map(connectionView),projects:store.list('project').filter(p=>p.ownerConnectionId&&p.ownerConnectionId===activeId())});}
      if(route==='/api/active-connection'&&method==='POST'){
        return await changeConnection(async()=>{
        const data=await body(readBody);
        if(data.id===null){if(!activeId())throw new AppError('Подключение уже заблокировано',401);auth.lock();await stopOwner();return reply({ok:true},200,{session:null});}
        if(typeof data.id!=='string'||!store.get('connection',data.id))throw new AppError('Подключение не найдено',404);
        await auth.verify(data.id,data.password);auth.lock();await stopOwner();
        const session=auth.unlock(data.id);return reply({ok:true},200,{session});
        });
      }
      if(route==='/api/connections'&&method==='POST'){
        return await changeConnection(async()=>{
        const data=await body(readBody),c={id:randomUUID(),label:requiredText(data.label,60),username:null,status:'waiting',createdAt:new Date().toISOString()};
        if(typeof data.password!=='string'||data.password.length<12||data.password.length>256)throw new AppError('Задайте локальный пароль PMA: 12–256 символов');
        store.save('connection',c);await setLocalPassword(store,c.id,data.password);
        auth.lock();await stopOwner();const session=auth.unlock(c.id);
        return reply(await openConnection(c),201,{session});
        });
      }
      if(diagnostics&&route==='/api/diagnostics'&&method==='GET')return reply(diagnostics.status(activeId()));
      if(diagnostics&&route==='/api/diagnostics/report'&&method==='POST'){await body(readBody);return reply({file:diagnostics.report(activeId())});}
      if(!activeId())throw new AppError('Откройте подключение локальным паролем PMA',401);
      if(route.startsWith('/api/ai/')){
        if(!aiExecutor||!vault)throw new AppError('Настройка API доступна только в настольной PMA',501);
        const owner=activeId(),month=moscowMonth();
        // The key never leaves the vault through this view: only whether it is set and its last 4 characters.
        const view=()=>{const p=store.get('ai-profile',profileId(owner));const {verification,keySetAt,keyHint,blockedReason,id,connectionId,...settings}=p||{};
          return {profile:p?settings:null,keyConfigured:!!keySetAt,keyHint:keyHint||null,verified:!!p&&verification?.profileHash===profileHash(p),verification:verification||null,blockedReason:blockedReason||null,ledgerBlocked:store.ledger?.blocked||null,
            month:{key:month,poolCalls:store.ledger?store.ledger.usedInMonth(month):null,spend:store.ledger?store.ledger.monthSpend(owner,month):[]}};};
        const saveProfile=changes=>{const p=store.get('ai-profile',profileId(owner));store.save('ai-profile',{...p,...changes,id:profileId(owner),connectionId:owner,verification:null,updatedAt:new Date().toISOString()});};
        if(route==='/api/ai/profile'&&method==='GET')return reply(view());
        if(route==='/api/ai/profile'&&method==='PUT'){const settings=validateProfile(await body(readBody));saveProfile({...settings,blockedReason:null});return reply(view());}
        if(route==='/api/ai/key'&&method==='PUT'){
          const data=await body(readBody);if(!store.get('ai-profile',profileId(owner)))throw new AppError('Сначала сохраните профиль API',409);
          if(typeof data.key!=='string'||!/^[\x21-\x7e]{16,512}$/.test(data.key))throw new AppError('Ключ API: от 16 до 512 видимых символов без пробелов',400);
          await vault.put(owner,data.key);if(owner!==activeId())throw new AppError('Подключение сменилось во время сохранения',401);
          saveProfile({keySetAt:new Date().toISOString(),keyHint:'…'+data.key.slice(-4)});return reply(view());
        }
        if(route==='/api/ai/key/delete'&&method==='POST'){await body(readBody);await vault.delete(owner);saveProfile({keySetAt:null,keyHint:null});return reply(view());}
        if(route==='/api/ai/probe'&&method==='POST'){
          await body(readBody);if(jobs.size)throw new AppError('Дождитесь завершения текущей операции',409);
          const controller=new AbortController(),id='ai-probe-'+owner;jobs.set(id,controller);
          controller.done=probeProfile({store,root,connectionId:owner,vault,post:aiPost,signal:controller.signal}).finally(()=>jobs.delete(id));
          await controller.done;return reply(view());
        }
        throw new AppError('Маршрут не найден',404);
      }
      if(route==='/api/interpretations'&&method==='POST'){
        const data=await body(readBody),project=projectFor(data.projectId),record=createInterpretation(store,project,activeId(),data,{canStart:!jobs.size});
        if(record.status==='queued'&&!jobs.has(record.id))startInterpretation(record);
        return reply(interpretationView(record),record.status==='queued'||['preparing','running'].includes(record.status)?202:200);
      }
      if(parts[1]==='interpretations'&&parts.length===3&&method==='GET'){return reply(interpretationView(interpretationFor(parts[2])));}
      if(parts[1]==='interpretations'&&parts.length===4&&parts[3]==='cancel'&&method==='POST'){
        const record=interpretationFor(parts[2]);jobs.get(record.id)?.abort();return reply(interpretationView(record));
      }
      if(route==='/api/projects'&&method==='POST'){
        if(!activeConnection())throw new AppError('Сначала откройте своё подключение Pinterest',401);
        const data=await body(readBody),project={id:randomUUID(),name:requiredText(data.name,100),ownerConnectionId:activeId(),createdAt:new Date().toISOString()};
        store.save('project',project);return reply(project,201);
      }
      if(parts[1]==='projects'&&parts.length===3&&method==='GET'){
        const p=projectFor(parts[2]);
        const evaluations=store.list('evaluation',p.id).filter(e=>e.status==='ready'&&e.connectionId===activeId()).map(e=>({id:e.id,model:e.model,sourceRunIds:e.sourceRunIds,selectedCounts:e.selectedCounts,candidateCount:e.candidates.length,createdAt:e.createdAt}));
        return reply({project:p,runs:store.list('run',p.id).filter(r=>r.connectionId===p.ownerConnectionId).map(viewRun),evaluations});
      }
      if(parts[1]==='projects'&&parts.length===4&&parts[3]==='interpretations'&&method==='GET'){
        const p=projectFor(parts[2]);return reply(store.list('interpretation',p.id).filter(r=>r.connectionId===p.ownerConnectionId).slice(0,8).map(interpretationView));
      }
      if(parts[1]==='connections'&&parts[3]==='check'&&method==='POST'){
        const c=store.get('connection',parts[2]);if(!c)throw new AppError('Подключение не найдено',404);
        if(c.id!==activeId())throw new AppError('Сначала откройте это подключение паролем PMA',403);
        const username=await pinterest.requireIdentity(c),next={...c,username,status:'ready'};
        if(c.id!==activeId())throw new AppError('Подключение уже заблокировано или сменилось',401);
        store.save('connection',next);return reply(connectionView(next));
      }
      if(parts[1]==='connections'&&parts[3]==='open'&&method==='POST'){
        const c=store.get('connection',parts[2]);if(!c)throw new AppError('Подключение не найдено',404);
        if(c.id!==activeId())throw new AppError('Сначала откройте это подключение паролем PMA',403);
        return reply(await openConnection(c));
      }
      if(route==='/api/uploads'&&method==='POST'){
        const data=await body(readBody),p=projectFor(data.projectId);
        if(typeof data.imageBase64!=='string'||data.imageBase64.length>Math.ceil(LIMITS.uploadBytes*4/3)+4)throw new AppError('Пример больше 8 МБ');
        const bytes=Buffer.from(data.imageBase64,'base64'),type=mediaType(bytes),id=randomUUID();
        if(bytes.length>LIMITS.uploadBytes)throw new AppError('Пример больше 8 МБ');
        const filename=id+'.'+type.ext;await fs.mkdir(path.join(root,'uploads'),{recursive:true});
        await fs.writeFile(path.join(root,'uploads',filename),bytes);
        const upload={id,projectId:p.id,name:requiredText(data.name,120),filename,mime:type.mime,notes:typeof data.notes==='string'?text(data.notes,1000):'',createdAt:new Date().toISOString()};
        store.save('upload',upload,p.id);return reply({id,name:upload.name,url:'/media/uploads/'+id,notes:upload.notes},201);
      }
      if(route==='/api/runs'&&method==='POST'){
        const data=await body(readBody),p=projectFor(data.projectId),connection=activeConnection();
        if(!connection||connection.status!=='ready')throw new AppError('Сначала подключите Pinterest',409);
        if(jobs.size)throw new AppError('Дождитесь завершения текущего поиска или отмените его',409);
        const mode=data.mode==='image'?'image':'text',ids=Array.isArray(data.uploadIds)?data.uploadIds:[];
        if(ids.length>LIMITS.uploads||ids.some(id=>typeof id!=='string'))throw new AppError('Можно добавить до трёх примеров');
        const uploads=ids.map(id=>store.get('upload',id));
        if(uploads.some(u=>!u||u.projectId!==p.id))throw new AppError('Пример принадлежит другому проекту',403);
        if(mode==='image'&&!uploads.length)throw new AppError('Добавьте изображение для Lens');
        const query=requiredText(data.query),interpretation=requiredText(data.interpretation||data.query);
        if(data.aiEnabled!==undefined&&typeof data.aiEnabled!=='boolean')throw new AppError('AI-отбор включается явным переключателем');
        if(data.entryKind!==undefined&&!['vision','ready'].includes(data.entryKind))throw new AppError('Некорректный способ подготовки запроса');
        if(data.briefInterpretationId!==undefined&&typeof data.briefInterpretationId!=='string')throw new AppError('Некорректная версия подготовки');
        const needsPreparation=data.entryKind==='vision'&&(mode==='text'||data.aiEnabled===true);
        if(needsPreparation&&!data.briefInterpretationId)throw new AppError('Сначала подготовьте и подтвердите поисковый запрос',409);
        const prepared=data.briefInterpretationId?confirmedInterpretation(store,p,connection.id,data):null;
        const run={id:randomUUID(),projectId:p.id,connectionId:connection.id,query,interpretation,mode,aiEnabled:data.aiEnabled===true,title:shortTitle(prepared?.result?.summary||query),status:'queued',sourceKind:'live',createdAt:new Date().toISOString(),candidates:[],selectedIds:[],uploads:ids,notes:typeof data.notes==='string'?text(data.notes,2000):'',message:'Подготовка поиска…',...(prepared?{briefPreparation:{id:prepared.id,method:prepared.method,model:prepared.model||null,summary:prepared.result.summary,features:prepared.result.features,avoid:prepared.result.avoid,assumptions:prepared.result.assumptions},clarificationAnswer:prepared.input.answer}:{}),entryKind:data.entryKind||'ready'};
        store.transaction(()=>{if(!p.ownerConnectionId)store.save('project',{...p,ownerConnectionId:connection.id});store.save('run',run,p.id);});
        startSearch(run,connection,uploads);
        return reply(viewRun(run),202);
      }
      if(parts[1]==='runs'&&parts[3]==='open-pinterest'&&method==='POST'){
        const run=runFor(parts[2]),connection=store.get('connection',run.connectionId);
        if(!connection||run.connectionId!==activeId())throw new AppError('Выберите исходный Pinterest-аккаунт этой подборки',403);
        await pinterest.open(connection);return reply({ok:true});
      }
      if(parts[1]==='runs'&&parts[3]==='resume'&&method==='POST'){
        const run=runFor(parts[2]),connection=activeConnection();
        if(!connection||run.connectionId!==connection.id||connection.status!=='ready')throw new AppError('Выберите исходный Pinterest-аккаунт этой подборки',403);
        if(run.sourceKind!=='live'||!['blocked','interrupted'].includes(run.status))throw new AppError('Эта подборка не ожидает продолжения',409);
        if(jobs.size)throw new AppError('Дождитесь завершения текущего поиска или отмените его',409);
        const uploads=(run.uploads||[]).map(id=>store.get('upload',id));
        if(uploads.some(u=>!u||u.projectId!==run.projectId))throw new AppError('Не найден исходный пример этой подборки',409);
        const next={...run,status:'queued',message:'Проверяем Pinterest и продолжаем поиск…',resumedAt:new Date().toISOString()};
        store.save('run',next,run.projectId);startSearch(next,connection,uploads);return reply(viewRun(next),202);
      }
      if(parts[1]==='runs'&&parts[3]==='cancel'&&method==='POST'){const run=runFor(parts[2]);jobs.get(run.id)?.abort();return reply({ok:true});}
      if(parts[1]==='runs'&&parts[3]==='replacements'&&method==='POST'){
        const data=await body(readBody),run=runFor(parts[2]);
        if(jobs.size)throw new AppError('Дождитесь завершения текущего поиска или отмените его',409);
        if(parts.length===4){
          const connection=activeConnection();
          if(!connection||connection.id!==run.connectionId||connection.status!=='ready')throw new AppError('Выберите исходный Pinterest-аккаунт этой подборки',403);
          const uploads=(run.uploads||[]).map(id=>store.get('upload',id));
          if(uploads.some(u=>!u||u.projectId!==run.projectId))throw new AppError('Исходные примеры не найдены',409);
          const next=store.transaction(()=>createReplacement(store,run,data));startSearch(next,connection,uploads);return reply(viewRun(next),202);
        }
        if(parts[4]==='apply'&&parts.length===5){return reply(viewRun(store.transaction(()=>applyReplacement(store,run,data))));}
        if(parts[4]==='discard'&&parts.length===5){return reply(viewRun(store.transaction(()=>discardReplacement(store,run,data.revision))));}
      }
      if(parts[1]==='runs'&&parts[3]==='selection'&&method==='PUT'){
        const data=await body(readBody),run=runFor(parts[2]);
        if(data.revision!==undefined&&data.revision!==(run.revision||0))throw new AppError('Подборка изменилась. Обновите страницу перед сохранением выбора.',409);
        selectedItems(run,data.ids);
        const next={...run,selectedIds:data.ids,revision:(run.revision||0)+1};store.save('run',next,run.projectId);return reply(viewRun(next));
      }
      if(parts[1]==='runs'&&['figma','export'].includes(parts[3])&&method==='POST'){return reply(await makeExport(runFor(parts[2])),201);}
      if(parts[1]==='exports'&&parts.length===3&&method==='GET'){
        const e=exportFor(parts[2]);
        return reply(exportView(store,e));
      }
      if(parts[1]==='exports'&&parts.length===4&&method==='POST'){
        const data=await body(readBody),e=exportFor(parts[2]);
        if(parts[3]==='figma-new-attempt'){
          if(data.acknowledgeNewFrame!==true)throw new AppError('Подтвердите создание отдельного нового фрейма');
          const a=store.get('figma-attempt',e.currentAttemptId);if(a?.state==='importing'&&a.leaseExpiresAt>Date.now())throw new AppError('Текущий импорт ещё выполняется',409);
          store.transaction(()=>createFigmaAttempt(store,e,true));
          return reply(await reissueExport(store.get('export',e.id)),201);
        }
        if(parts[3]==='figma-code'){return reply(await reissueExport(e),201);}
        if(['pinterest','pinterest-reconcile','pinterest-cancel','board'].includes(parts[3])){
          const record=store.get('pinterest-export','pinterest-'+e.selectionId),connection=activeConnection();
          if(!record||!connection||connection.id!==e.connectionId||connection.status!=='ready')throw new AppError('Выберите Pinterest-аккаунт этого экспорта',403);
          if(parts[3]==='pinterest-cancel'){jobs.get(record.id)?.abort();return reply({ok:true});}
          if(jobs.size)throw new AppError('Дождитесь завершения текущей операции или отмените её',409);
          if(parts[3]==='board'){
            const board=store.get('board','board-'+e.projectId),name=requiredText(data.name||board.name,70);
            if(name.length>50)throw new AppError('Имя доски Pinterest не должно превышать 50 символов');
            const candidate=verifiedBoard({url:requiredText(data.url),username:connection.username,secret:true},connection,board);
            const actual=await pinterest.exclusive(()=>pinterest.ensureExportBoard(connection,{...board,url:candidate.url,name},null,{signal:AbortSignal.timeout(45000),readOnly:true}));
            store.save('board',verifiedBoard(actual,connection,{...board,name}),e.projectId);return reply(exportView(store,e));
          }
          const controller=new AbortController();jobs.set(record.id,controller);
          controller.done=Promise.resolve().then(()=>pinterest.exclusive(()=>performPinterestExport({store,root,pinterest,record,connection,controller,reconcileOnly:parts[3]==='pinterest-reconcile'}))).finally(()=>jobs.delete(record.id));
          controller.done.catch(error=>console.error('Pinterest export worker failed:',error.message));return reply(exportView(store,e),202);
        }
      }
      throw new AppError('Маршрут не найден',404);
    }
    if(!['GET','HEAD'].includes(method))throw new AppError('Метод не поддерживается',405);
    if(/^\/evaluations\/[a-f0-9-]{36}$/.test(route)){
      const evaluation=store.get('evaluation',path.basename(route));
      if(!evaluation)throw new AppError('Проверка AI не найдена',404);
      projectFor(evaluation.projectId);
      if(evaluation.connectionId!==activeId())throw new AppError('Для этой проверки выберите исходный аккаунт',403);
      if(evaluation.status!=='ready')throw new AppError('Проверка AI ещё не завершена',409);
      return fileReply(path.join(root,'evaluations',evaluation.id,'report.html'),{'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'Cache-Control':'no-store'},()=>projectFor(evaluation.projectId));
    }
    if(/^\/media\/assets\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(route)){
      const asset=path.basename(route);requireAsset(asset);
      return fileReply(path.join(root,'assets',asset),{'Cache-Control':'no-store','Cross-Origin-Resource-Policy':'same-origin'},()=>requireAsset(asset));
    }
    if(/^\/media\/uploads\/[a-f0-9-]{36}$/.test(route)){const u=store.get('upload',path.basename(route));if(!u)throw new AppError('Пример не найден',404);projectFor(u.projectId);return fileReply(path.join(root,'uploads',u.filename),{'Cache-Control':'no-store'},()=>projectFor(u.projectId));}
    throw new AppError('Страница не найдена',404);
}
const errorReply=error=>{
  const status=error instanceof AppError?error.status:error.code==='ENOENT'?404:500;
  if(status===500)console.error(error);
  return {status,data:{error:error instanceof AppError?error.message:status===404?'Файл не найден':'Ошибка локального сервиса. Подробности доступны в журнале запуска.'}};
};
// Desktop IPC client: the worker keeps this client's session token; the renderer never sends an owner.
function createIpcClient(){
  let token=null;
  const session=()=>{const current=auth.current();return current&&token&&current.token===token?current:null;};
  return {request:({method,route,body:data})=>requestContext.run(session(),async()=>{
    try{
      const result=await dispatch({method,route,readBody:async()=>{if(data===null||typeof data!=='object')throw new AppError('Ожидался JSON',415);return data;}});
      if('session' in result)token=result.session?.token||null;
      const {session:_,...wire}=result;return wire;
    }catch(error){return errorReply(error);}
  })};
}
function sendReply(res,result){
  const headers='session' in result?{'Set-Cookie':auth.cookie(result.session)}:{};
  if(result.bytes){res.writeHead(result.status,{...result.headers,...headers});res.end(result.bytes);}
  else json(res,result.data,result.status,headers);
}
const server=http.createServer((req,res)=>requestContext.run(auth.fromRequest(req),async()=>{
  const url=new URL(req.url,'http://127.0.0.1:'+port),route=url.pathname;
  try{
    const listeningPort=server.address()?.port||port;
    if(!['127.0.0.1:'+listeningPort,'localhost:'+listeningPort].includes(req.headers.host))throw new AppError('Недопустимый адрес локального сервиса',403);
    if(route.startsWith('/api/figma/')){
      if(req.headers.origin&&req.headers.origin!=='null')throw new AppError('Недопустимый источник подключения',403);
      if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
      if(url.searchParams.get('protocol')!==String(FIGMA_PROTOCOL))throw new AppError('Плагин PMA другой версии. Закройте окно плагина в Figma и запустите его заново из папки, которую показывает PMA. Ничего не записано.',426);
      const exp=paired(req);
      if(route==='/api/figma/package'&&req.method==='GET'){await sendFile(res,exp.packagePath,{...cors,'Content-Type':'application/json','Cache-Control':'no-store'},()=>paired(req));return;}
      if(route==='/api/figma/claim'&&req.method==='POST'){
        const data=await body(()=>readHttpBody(req));paired(req);const attempt=store.get('figma-attempt',exp.attemptId);
        json(res,store.transaction(()=>claimFigma(store,attempt,data)),200,cors);return;
      }
      if(route==='/api/figma/checkpoint'&&req.method==='POST'){
        const data=await body(()=>readHttpBody(req));paired(req);const attempt=store.get('figma-attempt',exp.attemptId);
        if(!['importing','unknown'].includes(attempt.state)||attempt.documentId!==data.documentId||attempt.fileKey&&attempt.fileKey!==data.fileKey||typeof data.lease!=='string'||sha256(data.lease)!==attempt.leaseHash||attempt.leaseExpiresAt<=Date.now()||!/^\d+:\d+$/.test(data.frameId||'')||attempt.frameId&&attempt.frameId!==data.frameId)throw new AppError('Не совпала попытка создания фрейма',409);
        store.save('figma-attempt',{...attempt,frameId:data.frameId},attempt.projectId);json(res,{ok:true},200,cors);return;
      }
      if(route==='/api/figma/receipt'&&req.method==='POST'){
        const data=await body(()=>readHttpBody(req));paired(req);const attempt=store.get('figma-attempt',exp.attemptId),snapshot=store.get('selection',attempt.selectionId);
        store.transaction(()=>recordFigmaReceipt(store,attempt,snapshot,data));
        json(res,{ok:true},200,cors);return;
      }
      throw new AppError('Маршрут не найден',404);
    }
    if(figmaOnly)throw new AppError('Маршрут не найден',404);
    // Historical experiment files are retained on disk, outside the app's API.
    if(route==='/figma-package.json')throw new AppError('G1 endpoint отключён. Используйте ограниченный код подключения Figma.',410);
    if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&!localOrigins.has(req.headers.origin)))throw new AppError('Недопустимый источник запроса',403);
    if(route.startsWith('/api/')&&!['GET','HEAD'].includes(req.method)&&req.headers['x-pma-token']!==csrf)throw new AppError('Обновите страницу PMA',403);
    if(!route.startsWith('/api/')&&['GET','HEAD'].includes(req.method)){
      if(route==='/favicon.ico'){res.writeHead(204);res.end();return;}
      const csp="default-src 'self'; img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
      if(route==='/'){await sendFile(res,path.join(workspace,'dist/index.html'),{'Content-Security-Policy':csp});return;}
      if(/^\/assets\/[a-zA-Z0-9_.-]+$/.test(route)){await sendFile(res,path.join(workspace,'dist',route.slice(1)));return;}
    }
    sendReply(res,await dispatch({method:req.method,route,readBody:()=>readHttpBody(req)}));
  }catch(error){
    if(!res.headersSent){const {status,data}=errorReply(error);json(res,data,status,route.startsWith('/api/figma/')?cors:{});}
  }
}));
server.on('listening',()=>{localOrigins.add('http://127.0.0.1:'+server.address().port);localOrigins.add('http://localhost:'+server.address().port);});
const shutdown=async()=>{
  clearInterval(expiryTimer);auth.lock();
  const pending=[...jobs.values()],closed=new Promise(resolve=>server.close(resolve));
  for(const controller of pending)controller.abort(new OwnerStop());
  await pinterest.close();await Promise.allSettled(pending.map(c=>c.done));
  // Browsers keep speculative sockets that never send a request; server.close() would wait for their timeout.
  server.closeAllConnections();await closed;
};
return {server,jobs,shutdown,auth,dispatch,createIpcClient};
}
