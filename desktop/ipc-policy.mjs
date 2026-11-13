// Desktop IPC policy, enforced in Electron main before anything reaches the backend worker.
// The renderer is less trusted: it may only name a fixed operation with strict IDs and a bounded
// JSON body. Owner, session and business rules are checked again by the worker's dispatcher.

export const APP_ORIGIN='app://pma';
export const BODY_LIMIT=36*1024*1024;
const ID='[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const op=(method,pattern)=>({method,pattern:new RegExp('^/api'+pattern.replaceAll(':id',ID)+'$')});
export const OPERATIONS=[
  op('GET','/bootstrap'),op('POST','/active-connection'),op('POST','/connections'),
  op('POST','/connections/:id/(?:open|check)'),
  op('POST','/interpretations'),op('GET','/interpretations/:id'),op('POST','/interpretations/:id/cancel'),
  op('POST','/projects'),op('GET','/projects/:id'),op('GET','/projects/:id/interpretations'),
  op('POST','/uploads'),op('POST','/runs'),
  op('POST','/runs/:id/(?:cancel|resume|open-pinterest|export|figma|replacements)'),
  op('POST','/runs/:id/replacements/(?:apply|discard)'),op('PUT','/runs/:id/selection'),
  op('GET','/exports/:id'),
  op('GET','/diagnostics'),op('POST','/diagnostics/report'),
  op('GET','/ai/profile'),op('PUT','/ai/profile'),op('PUT','/ai/key'),op('POST','/ai/key/delete'),op('POST','/ai/probe'),
  op('PUT','/ai/mode'),op('POST','/ai/codex/(?:probe|login)'),
  op('POST','/exports/:id/(?:figma-new-attempt|figma-code|pinterest|pinterest-reconcile|pinterest-cancel|board)'),
];
const MEDIA=[/^\/media\/assets\/[a-f0-9]{64}\.(?:jpg|png|webp)$/,/^\/media\/uploads\/[a-f0-9-]{36}$/,/^\/evaluations\/[a-f0-9-]{36}$/];

export class PolicyError extends Error {constructor(message){super(message);this.status=400;}}

// Only the top-level frame of PMA's own window, showing PMA's packaged UI, may call the bridge.
export function trustedSender(event,webContents){
  const frame=event.senderFrame;
  if(!webContents||event.sender!==webContents||!frame||frame!==webContents.mainFrame)return false;
  // Node's URL reports origin 'null' for custom schemes, so compare scheme and host explicitly.
  try{const u=new URL(frame.url);return u.protocol==='app:'&&u.host==='pma'&&!u.username&&!u.port;}catch{return false;}
}

export function apiRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new PolicyError('Некорректный запрос');
  const {method,route,body}=input;
  if(typeof method!=='string'||typeof route!=='string'||route.length>300)throw new PolicyError('Некорректный запрос');
  if(!OPERATIONS.some(o=>o.method===method&&o.pattern.test(route)))throw new PolicyError('Операция недоступна');
  if(method==='GET'){if(body!==undefined)throw new PolicyError('Лишнее тело запроса');return {method,route};}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new PolicyError('Ожидался JSON-объект');
  const json=JSON.stringify(body);
  if(json.length>BODY_LIMIT)throw new PolicyError('Запрос слишком большой');
  return {method,route,body:JSON.parse(json)};
}

// app://pma/<path>: private media goes to the worker; everything else is packaged static UI.
export function protocolTarget(url){
  let parsed;try{parsed=new URL(url);}catch{return {kind:'deny'};}
  if(parsed.protocol!=='app:'||parsed.host!=='pma'||parsed.search||parsed.hash)return {kind:'deny'};
  // Malformed percent-encoding is refused, not thrown into protocol/navigation handlers.
  let route;try{route=decodeURIComponent(parsed.pathname);}catch{return {kind:'deny'};}
  if(MEDIA.some(r=>r.test(route)))return {kind:'media',route};
  if(route==='/'||route==='/index.html')return {kind:'static',file:'index.html'};
  if(/^\/assets\/[A-Za-z0-9_.-]+$/.test(route)&&!route.includes('..'))return {kind:'static',file:route.slice(1)};
  return {kind:'deny'};
}

export const reportRoute=url=>{const t=protocolTarget(url);return t.kind==='media'&&t.route.startsWith('/evaluations/')?t.route:null;};

// Only canonical Pinterest pin pages open in the user's own browser.
export function externalPinUrl(url){
  try{
    const u=new URL(url);
    if(u.protocol==='https:'&&u.hostname==='www.pinterest.com'&&!u.username&&!u.password&&!u.port&&/^\/pin\/[1-9]\d*\/$/.test(u.pathname)&&!u.search&&!u.hash)return u.href;
  }catch{}
  return null;
}
