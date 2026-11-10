import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn,spawnSync,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EVAL_LIMITS } from './selection-eval.mjs';

const codexWrapper=()=>path.join(process.env.APPDATA||'', 'npm/node_modules/@openai/codex/bin/codex.js');
const execute=promisify(execFile);
export async function availableCodexModelsAsync(signal){
  signal?.throwIfAborted();
  const result=await execute(process.execPath,[codexWrapper(),'debug','models','-c','model_provider="openai"'],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:4*1024*1024,signal});
  return (JSON.parse(result.stdout).models||[]).filter(m=>m.visibility==='list'&&(m.input_modalities||['text','image']).includes('image')).map(m=>({id:m.slug,name:m.display_name}));
}
export function availableCodexModels(){
  const result=spawnSync(process.execPath,[codexWrapper(),'debug','models','-c','model_provider="openai"'],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:4*1024*1024,shell:false});
  if(result.status!==0)throw Error('Не удалось получить каталог моделей Codex CLI');
  const models=JSON.parse(result.stdout).models||[];
  return models.filter(m=>m.visibility==='list'&&(m.input_modalities||['text','image']).includes('image')).map(m=>({id:m.slug,name:m.display_name}));
}

export function codexArguments({model,cwd,schemaFile,outputFile,images}){
  const disabled=['apps','plugins','browser_use','computer_use','shell_tool','unified_exec','multi_agent','code_mode','code_mode_host','view_image','workspace_dependencies','image_generation','skill_search','tool_suggest','unbounded_connection_retries'];
  return ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--model',model,'-c','forced_login_method="chatgpt"','-c','web_search="disabled"','-c','project_doc_max_bytes=0','-c','model_reasoning_effort="medium"',...disabled.flatMap(x=>['--disable',x]),'--cd',cwd,'--json','--color','never','--output-schema',schemaFile,'--output-last-message',outputFile,...images.flatMap(file=>['--image',file]),'--','-'];
}
export async function runCodexSelection({directory,model,images,prompt,schema,condition,signal}){
  signal?.throwIfAborted();
  const wrapper=codexWrapper();
  await fs.access(wrapper);
  const schemaFile=path.join(directory,'schema.json'),outputFile=path.join(directory,condition+'-response.json'),cwd=path.join(directory,'sandbox');
  await fs.mkdir(cwd,{recursive:true});await fs.writeFile(schemaFile,JSON.stringify(schema));await fs.writeFile(path.join(directory,condition+'-prompt.txt'),prompt);
  const env={...process.env};for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL'])delete env[name];
  const args=codexArguments({model,cwd,schemaFile,outputFile,images});
  const started=Date.now();let stdout='',stderr='',stopped=false;
  const events=[];
  signal?.throwIfAborted();
  const child=spawn(process.execPath,[wrapper,...args],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
  const stop=()=>{
    if(stopped||child.exitCode!==null||!child.pid)return;stopped=true;
    // Only terminate this exact child and the subprocesses it created.
    if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});else child.kill('SIGTERM');
  };
  const timer=setTimeout(stop,EVAL_LIMITS.timeoutMs);signal?.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(Buffer.byteLength(stdout)>EVAL_LIMITS.outputBytes)stop();});
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-300000);});
  child.stdin.on('error',()=>{});child.stdin.end(prompt);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
  await fs.writeFile(path.join(directory,condition+'-events.jsonl'),stdout);await fs.writeFile(path.join(directory,condition+'-stderr.txt'),stderr);
  for(const line of stdout.split('\n')){try{events.push(JSON.parse(line));}catch{}}
  if(stopped||signal?.aborted)throw Error('Проверка Codex остановлена по отмене, времени или размеру ответа. Автоматического повтора нет.');
  if(code!==0||events.some(e=>e.type==='turn.failed')){
    if(/model_not_found|model is not supported/i.test(stdout+stderr))throw Error('Модель недоступна в текущем аккаунте Codex CLI. Выберите модель из каталога CLI; автоматической подмены нет.');
    if(/not logged in|authentication|401|refresh token/i.test(stdout+stderr))throw Error('Codex CLI требует вход через ChatGPT в окружении локального сервиса.');
    if(/usage limit|rate.limit|quota|429/i.test(stdout+stderr))throw Error('Достигнут лимит Codex. Проверка остановлена без перехода на платный API.');
    throw Error('Codex CLI не завершил оценку. Локальная диагностика сохранена; автоматического повтора нет.');
  }
  const forbidden=events.find(e=>e.item&&['command_execution','mcp_tool_call','web_search','file_change'].includes(e.item.type));
  if(forbidden)throw Error('Оценка отклонена: вместо чистого анализа изображений модель использовала инструмент.');
  const completed=events.findLast(e=>e.type==='turn.completed');
  if(!completed)throw Error('Нет подтверждения завершения Codex');
  const response=JSON.parse(await fs.readFile(outputFile,'utf8'));
  return {response,usage:completed.usage||null,elapsedMs:Date.now()-started,completedAt:new Date().toISOString()};
}
