import { createHash } from 'node:crypto';
export const LIMITS={candidates:25,scrolls:40,searchMs:120000,imageBytes:8*1024*1024,packageBytes:32*1024*1024,uploadBytes:8*1024*1024,uploads:3};
export class AppError extends Error {constructor(message,status=400){super(message);this.status=status;}}
// Abort reason for lock, account switch, session expiry and service shutdown.
// Unlike an explicit user cancel, the job stays resumable by its owner.
export class OwnerStop extends Error {constructor(){super('PMA остановлена владельцем или закрыта');this.name='AbortError';}}
// Short readable title: whole words, one ellipsis, no trailing spaces or punctuation.
export function shortTitle(value,max=70){const s=String(value||'').replace(/\s+/g,' ').trim();if(s.length<=max)return s;const cut=s.slice(0,max-1),space=cut.lastIndexOf(' ');return (space>max*0.5?cut.slice(0,space):cut).replace(/[\s,.;:—-]+$/,'')+'…';}
export function text(value,max=1000){if(typeof value!=='string')throw new AppError('Ожидался текст');return value.trim().slice(0,max);}
export function requiredText(value,max=1000){const result=text(value,max);if(!result)throw new AppError('Заполните поле');return result;}
export function selectedItems(run,ids) {
  if(!Array.isArray(ids)||ids.length>LIMITS.candidates||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw new AppError('Некорректный выбор');
  const wanted=new Set(ids),items=run.candidates.filter(c=>wanted.has(c.id));
  if(items.length!==ids.length)throw new AppError('Выбраны изображения из другой подборки',409);
  return items;
}
export function snapshotKey(run,items) {
  return createHash('sha256').update(JSON.stringify({projectId:run.projectId,runId:run.id,connectionId:run.connectionId,items:items.map(c=>({id:c.id,pinId:c.pinId,sha256:c.sha256}))})).digest('hex');
}
export function mediaType(bytes) {
  if(bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',ext:'jpg'};
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png'};
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {mime:'image/webp',ext:'webp'};
  throw new AppError('Поддерживаются фотографии JPG, PNG и WebP');
}
export function sha256(value){return createHash('sha256').update(value).digest('hex');}
