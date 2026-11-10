import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { sha256 } from '../server/domain.mjs';
import { normalizePin } from '../spikes/pinterest-g1/pins.mjs';
import { EVAL_LIMITS,evaluationSchema,evaluationPrompt,validateEvaluation,selectEvaluation,evaluationHTML } from '../server/selection-eval.mjs';
import { runCodexSelection,availableCodexModels } from '../server/codex-selection.mjs';
import {reserveAICall} from '../server/ai-budget.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.join(workspace,'.local/pma');
const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];
const sourceId=args.includes('--source-run')?option('--source-run'):null,textId=args.includes('--text-run')?option('--text-run'):null;
if(!sourceId||!textId)throw Error('Нужны --source-run <Lens run ID> и --text-run <text run ID>');
const store=new Store(root),id=randomUUID(),directory=path.join(root,'evaluations',id),controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
let manifest;
try{
  const source=store.get('run',sourceId),text=store.get('run',textId),active=store.get('settings','workspace-settings')?.activeConnectionId;
  if(!source||!text||source.status!=='ready'||text.status!=='ready'||source.mode!=='image'||text.mode!=='text'||source.projectId!==text.projectId||source.connectionId!==text.connectionId||source.connectionId!==active)throw Error('Нужны готовые Lens/text подборки одного проекта и активного владельца');
  const project=store.get('project',source.projectId),seed=store.get('upload',source.uploads[0]);
  if(!seed||seed.projectId!==source.projectId||project.ownerConnectionId!==active)throw Error('Не найден принадлежащий проекту исходный пример');
  const catalog=availableCodexModels(),model=args.includes('--model')?option('--model'):catalog[0]?.id;
  if(!catalog.some(m=>m.id===model))throw Error('Выбранной модели нет в каталоге Codex CLI с поддержкой изображений');
  await fs.mkdir(path.join(directory,'input'),{recursive:true});
  const seedBytes=await fs.readFile(path.join(root,'uploads',path.basename(seed.filename)));
  const seedFile=path.join(directory,'input','000-reference'+path.extname(seed.filename));await fs.writeFile(seedFile,seedBytes);
  const candidates=[],seenIDs=new Set(),seenHashes=new Set();let bytes=seedBytes.length;
  for(const [run,origin] of [[source,'lens'],[text,'text']])for(const item of run.candidates){
    if(candidates.length>=EVAL_LIMITS.candidates)break;
    normalizePin({...item,alt:item.altText});
    if(!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(item.asset)||seenIDs.has(item.pinId)||seenHashes.has(item.sha256))continue;
    const image=await fs.readFile(path.join(root,'assets',item.asset));if(sha256(image)!==item.sha256)throw Error('Изображение кандидата изменилось');
    bytes+=image.length;if(bytes>EVAL_LIMITS.imageBytes)throw Error('Пакет изображений превышает предел проверки');
    const evalId='C'+String(candidates.length+1).padStart(2,'0'),file=path.join(directory,'input',evalId+path.extname(item.asset));
    await fs.writeFile(file,image);seenIDs.add(item.pinId);seenHashes.add(item.sha256);
    candidates.push({evalId,pinId:item.pinId,pinUrl:item.pinUrl,asset:item.asset,sha256:item.sha256,sourceRunId:run.id,origin,file});
  }
  if(candidates.length<26)throw Error('Для сравнения нужен пул больше целевого набора 25');
  manifest={id,projectId:source.projectId,connectionId:active,status:'running',createdAt:new Date().toISOString(),sourceRunIds:[source.id,text.id],model,reasoningEffort:'medium',authMethod:'chatgpt',maxCliRuns:EVAL_LIMITS.calls,seed:{id:seed.id,sha256:sha256(seedBytes),name:seed.name},brief:{query:source.query,notes:source.notes},candidates,lensIds:candidates.filter(c=>c.origin==='lens').map(c=>c.evalId)};
  store.save('evaluation',manifest,source.projectId);await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  manifest={...manifest,budgetManaged:true};store.save('evaluation',manifest,source.projectId);
  const results={};
  for(const condition of ['photo','photo-text']){
    controller.signal.throwIfAborted();console.log(JSON.stringify({evaluationId:id,condition,status:'running',candidates:candidates.length}));
    reserveAICall(store,manifest,'evaluation:'+id+':'+condition,{signal:controller.signal});
    const result=await runCodexSelection({directory,model:manifest.model,images:[seedFile,...candidates.map(c=>c.file)],prompt:evaluationPrompt(candidates,manifest.brief,condition),schema:evaluationSchema(candidates.map(c=>c.evalId)),condition,signal:controller.signal});
    validateEvaluation(result.response,candidates.map(c=>c.evalId));result.selectedIds=selectEvaluation(result.response);results[condition]=result;
    await fs.writeFile(path.join(directory,'results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({evaluationId:id,condition,status:'completed',selected:result.selectedIds.length,elapsedMs:result.elapsedMs,usage:result.usage}));
  }
  await fs.writeFile(path.join(directory,'report.html'),evaluationHTML(manifest,results));
  manifest={...manifest,status:'ready',completedAt:new Date().toISOString(),selectedCounts:{photo:results.photo.selectedIds.length,photoText:results['photo-text'].selectedIds.length},usage:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,v.usage]))};
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));store.save('evaluation',manifest,manifest.projectId);
  console.log(JSON.stringify({evaluationId:id,status:'ready',report:'http://127.0.0.1:8787/evaluations/'+id}));
}catch(error){
  if(manifest){manifest={...manifest,status:'error',message:error.message};store.save('evaluation',manifest,manifest.projectId);await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));}
  console.error(error.message);process.exitCode=1;
}finally{store.close();}
