// Desktop AI over the owner's ChatGPT subscription through their own Codex CLI (ADR 0013).
// Same {catalog, estimate, invoke} seam as the API profile; no money is reserved, but every call still
// takes a slot of the monthly pool in the ledger before it starts. PMA never reads Codex credentials:
// it only runs codex.exe, which uses the owner's own sign-in.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {AppError} from './domain.mjs';
import {reserveAICall} from './ai-budget.mjs';
import {availableCodexModelsAsync,runCodexSelection,codexEnv} from './codex-selection.mjs';
import {solidPng,PROBE_SCHEMA} from './ai-probe.mjs';
import {createApiExecutor} from './ai-api.mjs';

export const AI_MODES=['api','codex'];
export const modeId=connectionId=>'ai-mode-'+connectionId;
export const aiMode=(store,connectionId)=>store.get('ai-mode',modeId(connectionId))?.mode==='codex'?'codex':'api';
const execute=promisify(execFile);

// Documented install locations only (ADR 0013). The Microsoft Store Codex app keeps its codex.exe inside
// WindowsApps, which other programs may not run, so that folder is skipped; its sign-in is still shared.
export function codexCandidates(env=process.env,arch=process.arch){
  const [pkg,triple]=arch==='arm64'?['arm64','aarch64-pc-windows-msvc']:['x64','x86_64-pc-windows-msvc'];
  return [
    env.LOCALAPPDATA&&{source:'installer',path:path.join(env.LOCALAPPDATA,'Programs','OpenAI','Codex','bin','codex.exe')},
    env.APPDATA&&{source:'npm',path:path.join(env.APPDATA,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-'+pkg,'vendor',triple,'bin','codex.exe')},
    ...String(env.PATH||env.Path||'').split(path.delimiter).filter(d=>d&&!/[\\/]WindowsApps[\\/]?$/i.test(d)).map(d=>({source:'path',path:path.join(d,'codex.exe')})),
  ].filter(Boolean);
}
// Returns {source, path, command} for the first existing codex.exe, or null.
export function findCodex(env=process.env){
  for(const c of codexCandidates(env)){try{if(fs.statSync(c.path).isFile())return {...c,command:[c.path]};}catch{}}
  return null;
}

// Version and sign-in method. Raw output never leaves this function: `login status` may print a masked key.
export async function codexStatus(runtime){
  if(!runtime)return {found:false,version:null,login:'unknown'};
  const [program,...lead]=runtime.command,run=args=>execute(program,[...lead,...args],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024,env:codexEnv()});
  let version=null,login='unknown';
  try{version=(await run(['--version'])).stdout.match(/(\d+\.\d+\.\d+)/)?.[1]||null;}catch{return {found:true,source:runtime.source,version:null,login:'unknown',error:'Codex найден, но не запускается'};}
  try{const {stdout,stderr}=await run(['login','status']);login=/Logged in using ChatGPT/i.test(stdout+stderr)?'chatgpt':'other';}
  catch(error){login=/Not logged in/i.test(String(error.stdout||'')+String(error.stderr||''))?'none':'unknown';}
  return {found:true,source:runtime.source,version,login};
}

function usableRuntime(store,connectionId,locate,{probe=false}={}){
  const m=store.get('ai-mode',modeId(connectionId));
  if(m?.mode!=='codex')throw new AppError('Режим подписки ChatGPT (Codex) не выбран в настройках AI',409);
  const runtime=locate();
  if(!runtime)throw new AppError('Codex не найден на этом компьютере. Установите его по инструкции в «Настройках AI». Ручной путь доступен.',409);
  if(!probe&&m.verification?.path!==runtime.path)throw new AppError('Подписка ChatGPT (Codex) ещё не проверена. Запустите проверку в «Настройках AI».',409);
  if(!store.ledger)throw new AppError('Учёт вызовов AI недоступен; AI закрыт',409);
  if(store.ledger.blocked)throw new AppError(store.ledger.blocked,409);
  return runtime;
}

export function createCodexExecutor({store,connectionId,locate=findCodex,probe=false}){
  const usable=()=>usableRuntime(store,connectionId,locate,{probe});
  return {
    catalog:async signal=>{
      try{return await availableCodexModelsAsync(signal,usable().command);}
      catch(error){if(error instanceof AppError||signal?.aborted)throw error;throw new AppError('Codex не вернул список моделей. Проверьте вход в Codex; ручной путь доступен.',409);}
    },
    // Subscription: no money bound, the call slot alone is reserved.
    estimate:()=>{usable();return null;},
    invoke:async({reservation,...args})=>{
      const {command}=usable();
      if(!reservation?.id)throw new AppError('Нет резерва вызова в учёте; запрос не отправлен',409);
      // runCodexSelection's own messages (sign-in, limit, tool use) are safe to show; system errors are not.
      try{return await runCodexSelection({...args,command});}
      catch(error){if(error?.code||error?.name==='AbortError'||error instanceof AppError)throw error;throw new AppError(String(error?.message||'Codex не завершил вызов'),502);}
    },
  };
}

// Exactly one executor per owner, chosen by the owner's explicit mode. No fallback between modes.
export function pickExecutor({store,connectionId,vault,locate=findCodex,post}){
  return aiMode(store,connectionId)==='codex'?createCodexExecutor({store,connectionId,locate}):createApiExecutor({store,connectionId,vault,post});
}

// Explicit check: one structured call with a 64×64 red PNG, counted in the monthly pool.
export async function probeCodex({store,root,connectionId,locate=findCodex,signal}){
  const runtime=usableRuntime(store,connectionId,locate,{probe:true});
  const executor=createCodexExecutor({store,connectionId,locate,probe:true});
  const models=await executor.catalog(signal),model=models.find(m=>/-sol$/.test(m.id))?.id||models[0]?.id;
  if(!model)throw new AppError('В Codex нет доступной модели с изображениями',409);
  const directory=path.join(root,'ai-probe','codex-'+randomUUID());await fsp.mkdir(directory,{recursive:true});
  const file=path.join(directory,'red-64.png');await fsp.writeFile(file,solidPng(64,[220,20,20]));
  const prompt='Это техническая проверка. На изображении один сплошной цвет. Верни ok=true и цвет изображения.';
  const reservation=reserveAICall(store,{connectionId,projectId:null},'probe:'+randomUUID(),{signal});
  const out=await executor.invoke({directory,model,images:[file],prompt,schema:PROBE_SCHEMA,reservation,condition:'probe',signal});
  if(out.response?.ok!==true||out.response.color!=='red')throw new AppError('Проверка не пройдена: модель не распознала изображение',409);
  const current=store.get('ai-mode',modeId(connectionId));
  store.save('ai-mode',{...current,verification:{path:runtime.path,source:runtime.source,model,at:new Date().toISOString(),usage:out.usage||null}});
}

// `codex login` opens the owner's browser for the ChatGPT sign-in; PMA sees neither password nor tokens.
let loginChild=null;
export function startCodexLogin(locate=findCodex){
  const runtime=locate();
  if(!runtime)throw new AppError('Codex не найден. Сначала установите его.',409);
  if(loginChild)return;
  const [program,...lead]=runtime.command;
  loginChild=spawn(program,[...lead,'login'],{env:codexEnv(),windowsHide:true,stdio:'ignore',shell:false});
  // ponytail: the sign-in waits up to 10 minutes, then this child is stopped; a new click starts another.
  const timer=setTimeout(()=>loginChild?.kill(),10*60*1000);
  const done=()=>{clearTimeout(timer);loginChild=null;};
  loginChild.once('error',done);loginChild.once('exit',done);
}
export const stopCodexLogin=()=>loginChild?.kill();
