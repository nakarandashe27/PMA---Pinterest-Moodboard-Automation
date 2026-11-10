let token='';
export const sessionChannelId=crypto.randomUUID();
export function setToken(value:string){token=value;}
type DesktopBridge={version:number;api:(method:string,route:string,body?:unknown)=>Promise<{status:number;data:any}>;reveal:(kind:'figma-plugin'|'diagnostics')=>Promise<boolean>};
const desktop=(window as unknown as {pma?:DesktopBridge}).pma;
export const isDesktop=!!desktop;
export const reveal=(kind:'figma-plugin'|'diagnostics')=>desktop?desktop.reveal(kind):Promise.resolve(false);
// Desktop: validated IPC bridge (no localhost API). Browser/dev: the HTTP prototype.
async function send(route:string,method:string,body:unknown,signal?:AbortSignal):Promise<{status:number;data:any}>{
  if(desktop){
    const reply=await desktop.api(method,'/api'+route,body);
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    return reply;
  }
  const response=await fetch('/api'+route,{method,signal,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(method==='GET'?{}:{'X-PMA-Token':token})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
export async function api<T>(route:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const {status,data}=await send(route,method,body,signal);
  if(status===401&&route!=='/active-connection')window.dispatchEvent(new Event('pma-locked'));
  if(status<200||status>=300)throw Error(data?.error||'Не удалось выполнить запрос');
  return data as T;
}
