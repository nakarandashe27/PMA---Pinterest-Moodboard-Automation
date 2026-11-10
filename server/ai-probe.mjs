// Explicit paid check of an API profile: one structured text(+image) request through the same budget
// and call pool. Never run at startup or on save. A known solid-colour PNG proves the model saw the image.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {AppError} from './domain.mjs';
import {reserveAICall} from './ai-budget.mjs';
import {createApiExecutor,profileId,profileHash} from './ai-api.mjs';

export function solidPng(size,[r,g,b]){
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(zlib.crc32(body)>>>0);return Buffer.concat([len,body,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  const row=Buffer.concat([Buffer.from([0]),Buffer.from(Array.from({length:size},()=>[r,g,b]).flat())]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.concat(Array(size).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
export const PROBE_SCHEMA={type:'object',additionalProperties:false,properties:{ok:{type:'boolean'},color:{type:'string',enum:['red','green','blue','none','other']}},required:['ok','color']};

export async function probeProfile({store,root,connectionId,vault,post,signal}){
  const p=store.get('ai-profile',profileId(connectionId));
  if(!p)throw new AppError('Сначала сохраните профиль API',409);
  if(p.blockedReason)store.save('ai-profile',{...p,blockedReason:null});
  const executor=createApiExecutor({store,connectionId,vault,post,probe:true}),withImage=p.images.supported,images=[];
  if(withImage){const dir=path.join(root,'ai-probe');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'red-64.png');await fs.writeFile(file,solidPng(64,[220,20,20]));images.push(file);}
  const prompt=withImage?'Это техническая проверка. На изображении один сплошной цвет. Верни ok=true и цвет изображения.':'Это техническая проверка. Изображения нет. Верни ok=true и color="none".';
  const cost=executor.estimate({prompt,schema:PROBE_SCHEMA,images});
  const reservation=reserveAICall(store,{connectionId,projectId:null},'probe:'+randomUUID(),{signal,cost});
  const out=await executor.invoke({images,prompt,schema:PROBE_SCHEMA,signal,reservation});
  const current=store.get('ai-profile',profileId(connectionId)),expected=withImage?'red':'none';
  if(current.blockedReason)throw new AppError(current.blockedReason,409);
  if(out.response?.ok!==true||out.response.color!==expected)throw new AppError('Проверка не пройдена: модель ответила '+JSON.stringify(out.response).slice(0,200)+(withImage?'; изображение не распознано':''),409);
  store.save('ai-profile',{...current,verification:{profileHash:profileHash(current),at:new Date().toISOString(),text:true,image:withImage,structured:true,usage:out.usage}});
  return out.usage;
}
