import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError,sha256 } from './domain.mjs';
import { EVAL_LIMITS,evaluationSchema,evaluationPrompt,validateEvaluation,selectEvaluation } from './selection-eval.mjs';
import { availableCodexModelsAsync,runCodexSelection } from './codex-selection.mjs';

export async function rankCandidates({root,run,candidates,uploads,signal,onStart,onUsage,excludedReferences=[],recommendationLimit=25,catalog=availableCodexModelsAsync,invoke=runCodexSelection,estimate=null}){
  signal.throwIfAborted();
  if((run.ai?.callCount||0)>=1)throw new AppError('Лимит AI этого задания уже использован. Исходные изображения сохранены; автоматического повтора нет.',409);
  if(!candidates.length||candidates.length>EVAL_LIMITS.candidates||uploads.length>3||excludedReferences.length>5||!Number.isInteger(recommendationLimit)||recommendationLimit<1||recommendationLimit>25)throw new AppError('Некорректный размер набора для AI');
  const models=await catalog(signal),model=models.find(m=>/-sol$/.test(m.id))?.id||models[0]?.id;
  if(!model)throw new AppError('Нет доступной модели AI с изображениями',409);
  signal.throwIfAborted();
  const attemptId=randomUUID(),directory=path.join(root,'rankings',run.id,attemptId),input=path.join(directory,'input');
  await fs.mkdir(input,{recursive:true});
  let size=0;const images=[],references=[],rejectedReferences=[],items=[];
  for(const [i,upload] of uploads.entries()){
    const bytes=await fs.readFile(upload.path);size+=bytes.length;
    if(size>EVAL_LIMITS.imageBytes)throw new AppError('Примеры и кандидаты превышают 24 МиБ для одного AI-запуска');
    const file=path.join(input,'reference-'+i+path.extname(upload.path));await fs.writeFile(file,bytes);images.push(file);references.push({id:upload.id,sha256:sha256(bytes)});
  }
  for(const [i,c] of [...excludedReferences,...candidates].entries()){
    signal.throwIfAborted();
    if(!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(c.asset))throw new AppError('Некорректный локальный файл кандидата');
    const bytes=await fs.readFile(path.join(root,'assets',c.asset));size+=bytes.length;
    if(size>EVAL_LIMITS.imageBytes)throw new AppError('Примеры и кандидаты превышают 24 МиБ для одного AI-запуска');
    if(sha256(bytes)!==c.sha256)throw new AppError('Изображение кандидата изменилось');
    const rejected=i<excludedReferences.length,evalId=(rejected?'R':'C')+String((rejected?i:i-excludedReferences.length)+1).padStart(2,'0'),file=path.join(input,evalId+path.extname(c.asset));await fs.writeFile(file,bytes);images.push(file);
    if(rejected)rejectedReferences.push({id:c.id,sha256:c.sha256});else items.push({...c,evalId});
  }
  const inputHash=sha256(JSON.stringify({model,query:run.query,notes:run.notes,replacementReason:run.replacementReason,references,rejectedReferences,candidates:items.map(c=>({id:c.id,sha256:c.sha256}))}));
  await fs.writeFile(path.join(directory,'input-manifest.json'),JSON.stringify({runId:run.id,connectionId:run.connectionId,model,inputHash,references,rejectedReferences,candidates:items.map(({evalId,id,pinId,pinUrl,sha256})=>({evalId,id,pinId,pinUrl,sha256}))}));
  signal.throwIfAborted();
  const prompt=evaluationPrompt(items,run,'photo-text',{referenceCount:references.length+rejectedReferences.length,rejectedCount:rejectedReferences.length}),schema=evaluationSchema(items.map(c=>c.evalId));
  // Paid API: the proven upper cost is reserved together with the call slot, before anything is sent.
  const cost=estimate?estimate({prompt,schema,images}):null;
  const reservation=await onStart({status:'running',model,attemptId,inputHash,callCount:1,candidateCount:items.length,startedAt:new Date().toISOString()},cost);
  const result=await invoke({directory,model,images,prompt,schema,reservation,condition:'selection',signal});
  await onUsage(result.usage);
  signal.throwIfAborted();
  const response=validateEvaluation(result.response,items.map(c=>c.evalId)),byId=new Map(response.assessments.map(a=>[a.candidateId,a]));
  const ordered={...response,assessments:items.map(c=>byId.get(c.evalId))},selected=selectEvaluation(ordered,recommendationLimit),mapping=new Map(items.map(c=>[c.evalId,c.id]));
  return {candidates:items.map(({evalId,...c})=>({...c,ai:byId.get(evalId)})),ai:{status:'ready',model,attemptId,inputHash,callCount:1,candidateCount:items.length,recommendedIds:selected.map(id=>mapping.get(id)),interpretation:response.interpretation,criteria:response.criteria,usage:result.usage,elapsedMs:result.elapsedMs,completedAt:result.completedAt}};
}
