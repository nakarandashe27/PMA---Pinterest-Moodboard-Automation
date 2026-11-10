import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizePin } from '../spikes/pinterest-g1/pins.mjs';
import { AppError,LIMITS,mediaType,sha256 } from './domain.mjs';

export async function saveAsset(root,bytes) {
  if(bytes.length>LIMITS.imageBytes)throw new AppError('Изображение больше 8 МБ');
  const type=mediaType(bytes),hash=sha256(bytes),filename=hash+'.'+type.ext;
  await fs.mkdir(path.join(root,'assets'),{recursive:true});
  await fs.writeFile(path.join(root,'assets',filename),bytes,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  return {asset:filename,sha256:hash,mime:type.mime,bytes:bytes.length};
}
export async function downloadAsset(root,raw,signal) {
  const pin=normalizePin({...raw,alt:raw.altText,width:raw.observedWidth,height:raw.observedHeight});
  const response=await fetch(pin.imageUrl,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  if(!response.ok)throw new AppError('Не удалось загрузить изображение: HTTP '+response.status);
  if(Number(response.headers.get('content-length'))>LIMITS.imageBytes)throw new AppError('Изображение больше 8 МБ');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>LIMITS.imageBytes)throw new AppError('Изображение больше 8 МБ');chunks.push(chunk);}
  return {...pin,...await saveAsset(root,Buffer.concat(chunks)),id:randomUUID()};
}
export async function seedG1(store,root,workspace) {
  if(store.get('project','g1-project'))return;
  const file=path.join(workspace,'output/playwright/g1/figma-package.json');
  let p;try{p=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  const candidates=[];
  for(const pin of p.pins.slice(0,LIMITS.candidates)){
    const normalized=normalizePin({...pin,alt:pin.altText,width:pin.observedWidth,height:pin.observedHeight});
    candidates.push({...normalized,...await saveAsset(root,Buffer.from(pin.imageBase64,'base64')),id:randomUUID()});
  }
  store.transaction(()=>{
    store.save('project',{id:'g1-project',name:'Пробная подборка G1',createdAt:new Date().toISOString()});
    store.save('run',{id:'g1-run',projectId:'g1-project',connectionId:null,query:p.query,title:'Бионические скамьи',interpretation:p.query,status:'ready',sourceKind:'technical',sourceDate:'2026-11-02',createdAt:new Date().toISOString(),candidates,selectedIds:[],message:'Реальные изображения из технической проверки 2 ноября. Автоматический AI-отбор ещё не выполнялся.',uploads:[],notes:''},'g1-project');
  });
}
