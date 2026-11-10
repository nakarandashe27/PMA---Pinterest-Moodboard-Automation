// PMA desktop main: window, single-instance lock, worker supervisor and the validated UI bridge.
import {app,BrowserWindow,MessageChannelMain,utilityProcess,protocol,ipcMain,shell,net,safeStorage} from 'electron';
import {createHash} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolveRoot,layout} from '../server/data-root.mjs';
import {cleanupManagedChrome,killTrees} from './process-tree.mjs';
import {APP_ORIGIN,trustedSender,apiRequest,protocolTarget,reportRoute,externalPinUrl} from './ipc-policy.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),workspace=path.resolve(here,'..');
// One resolver for the data root (%LOCALAPPDATA%PMA; PMA_DESKTOP_ROOT only for tests). Electron's single-instance
// lock is keyed to userData inside this root; the worker adds its own OS-held data lock.
const root=resolveRoot(),paths=layout(root);
const ui=path.join(workspace,'dist');
const icon=app.isPackaged?path.join(process.resourcesPath,'icon.ico'):path.join(workspace,'design','pma-desktop-icon.ico');
const SHUTDOWN_MS=15000,REQUEST_MS=10*60*1000;
const pluginSource=app.isPackaged?path.join(process.resourcesPath,'figma-plugin'):path.join(workspace,'spikes','figma-g1','plugin'),pluginFiles=['manifest.json','code.js','ui.html'];
const pluginDir=path.join(paths.root,'integrations','figma-plugin');
const CSP="default-src 'self'; img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
fs.mkdirSync(paths.shell,{recursive:true});
app.setPath('userData',paths.shell);
app.setPath('sessionData',path.join(paths.shell,'session'));
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:false}}]);

if(!app.requestSingleInstanceLock())app.quit();
else{
  let win,worker,workerPid,port,ready,quitting=false,nextId=0;
  const reports=new Set();
  const pending=new Map();
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});

  function toWorker(message){
    if(quitting)return Promise.resolve({status:503,data:{error:'PMA завершает работу'}});
    return ready.catch(error=>({failed:error.message})).then(state=>state?.failed?{status:503,data:{error:'PMA не может открыть свои данные: '+state.failed}}:new Promise(resolve=>{
      const id=++nextId,timer=setTimeout(()=>{pending.delete(id);resolve({status:504,data:{error:'Локальный сервис не ответил'}});},REQUEST_MS);
      pending.set(id,reply=>{clearTimeout(timer);resolve(reply);});
      port.postMessage({type:'request',id,...message});
    }));
  }
  function startWorker(){
    worker=utilityProcess.fork(path.join(here,'worker.mjs'),[],{serviceName:'PMA backend',stdio:'inherit'});
    const channel=new MessageChannelMain();port=channel.port1;
    ready=new Promise((resolve,reject)=>{
      port.on('message',({data})=>{
        if(data.type==='ready'){if(!data.figma.available)console.warn('Figma bridge unavailable: '+data.figma.reason);resolve();}
        else if(data.type==='failed')reject(Error(data.message));
        else if(data.type==='reply'){const done=pending.get(data.id);pending.delete(data.id);done?.(data);}
        else if(data.type==='vault'){try{port.postMessage({type:'vault-reply',id:data.id,ok:true,value:vaultOp(data)});}catch(error){port.postMessage({type:'vault-reply',id:data.id,ok:false,error:error.message});}}
      });
    });
    ready.catch(error=>console.error('PMA backend failed to start:',error.message));
    port.start();
    worker.postMessage({type:'init',root,workspace,appVersion:app.getVersion(),pluginReady:installPlugin()},[channel.port2]);
    workerPid=worker.pid;
    worker.on('exit',code=>{
      for(const done of pending.values())done({status:503,data:{error:'Локальный сервис остановлен'}});pending.clear();
      // Unexpected death: its Chrome may be orphaned. End only processes using PMA's own profile folder.
      if(!quitting){console.error('PMA backend exited',code);quitting=true;cleanupManagedChrome(paths.root).catch(()=>{}).finally(()=>app.exit(1));}
    });
  }
  // Lock or account switch: close reports, drop cached private media and reload the UI from scratch.
  async function clearPrivateScreen(){
    for(const report of reports)report.close();
    if(!win)return;
    await win.webContents.session.clearCache();
    win.webContents.reloadIgnoringCache();
  }
  // Vault: DPAPI via safeStorage, one file per owner under secrets/. Only the worker's private port reaches it;
  // the renderer can set or delete a key through the worker but has no operation that returns it.
  function vaultOp({op,connectionId,key}){
    if(typeof connectionId!=='string'||!connectionId)throw Error('Нет владельца ключа');
    const file=path.join(paths.secrets,createHash('sha256').update(connectionId).digest('hex')+'.bin');
    if(op==='get')return fs.existsSync(file)?safeStorage.decryptString(fs.readFileSync(file)):null;
    if(op==='delete'){fs.rmSync(file,{force:true});return null;}
    if(op==='put'){
      if(!safeStorage.isEncryptionAvailable())throw Error('Защищённое хранилище Windows недоступно; ключ не сохранён');
      fs.mkdirSync(paths.secrets,{recursive:true});fs.writeFileSync(file+'.tmp',safeStorage.encryptString(key));fs.renameSync(file+'.tmp',file);return null;
    }
    throw Error('Неизвестная операция хранилища');
  }
  // Stable plugin folder outside the install directory; refreshed when the shipped files change.
  function installPlugin(){
    try{
      fs.mkdirSync(pluginDir,{recursive:true});
      for(const name of pluginFiles){const from=path.join(pluginSource,name),to=path.join(pluginDir,name),bytes=fs.readFileSync(from);
        if(!fs.existsSync(to)||!fs.readFileSync(to).equals(bytes)){fs.writeFileSync(to+'.tmp',bytes);fs.renameSync(to+'.tmp',to);}}
      return true;
    }catch(error){console.error('Figma plugin folder:',error.message);return false;}
  }
  function openReport(route){
    // Reports get their own window: sandboxed, no preload, no navigation.
    const report=new BrowserWindow({width:1100,height:800,icon,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    report.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    report.webContents.on('will-navigate',event=>event.preventDefault());
    reports.add(report);report.on('closed',()=>reports.delete(report));
    report.loadURL(APP_ORIGIN+route);
  }
  app.whenReady().then(()=>{
    protocol.handle('app',async request=>{
      const target=protocolTarget(request.url);
      if(target.kind==='static'){
        const file=path.join(ui,target.file);
        const response=await net.fetch(pathToFileURL(file).toString());
        if(target.file!=='index.html')return response;
        return new Response(response.body,{status:response.status,headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':CSP,'Cache-Control':'no-store'}});
      }
      if(target.kind==='media'&&request.method==='GET'){
        const reply=await toWorker({method:'GET',route:target.route});
        if(reply.bytes)return new Response(reply.bytes,{status:reply.status,headers:{...reply.headers,'Cache-Control':'no-store'}});
        return new Response(JSON.stringify(reply.data),{status:reply.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      }
      return new Response('Not found',{status:404});
    });
    // Shows a fixed PMA folder in Explorer. The renderer names only the kind, never a path.
    ipcMain.handle('pma:reveal',(event,kind)=>{
      if(!trustedSender(event,win?.webContents))return false;
      if(kind==='figma-plugin'){shell.openPath(pluginDir);return true;}
      if(kind==='diagnostics'){shell.openPath(paths.diagnostics);return true;}
      return false;
    });
    ipcMain.handle('pma:api',async(event,input)=>{
      if(!trustedSender(event,win?.webContents))return {status:403,data:{error:'Недопустимый источник запроса'}};
      let request;try{request=apiRequest(input);}catch(error){return {status:error.status||400,data:{error:error.message}};}
      const {status,data}=await toWorker(request);
      if(request.route==='/api/active-connection'&&status===200)setImmediate(()=>clearPrivateScreen());
      return {status,data};
    });
    win=new BrowserWindow({width:1280,height:820,minWidth:900,minHeight:600,title:'PMA',icon,webPreferences:{preload:path.join(here,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false}});
    win.webContents.setWindowOpenHandler(({url})=>{
      const pin=externalPinUrl(url),report=reportRoute(url);
      if(pin)shell.openExternal(pin);else if(report)openReport(report);
      return {action:'deny'};
    });
    win.webContents.on('will-navigate',(event,url)=>{if(protocolTarget(url).kind!=='static')event.preventDefault();});
    win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    win.on('closed',()=>{win=null;});
    // A previous crash may have left PMA's own Chrome running; nothing else is touched.
    cleanupManagedChrome(paths.root).catch(error=>console.error('Chrome cleanup:',error.message)).finally(()=>{startWorker();win.loadURL(APP_ORIGIN+'/');});
  });
  // The window cross means exit: no new operations, worker stops jobs/Chrome/store within a deadline.
  app.on('before-quit',event=>{
    if(quitting||!worker)return;
    event.preventDefault();quitting=true;
    // No new operations from here (toWorker answers 503). Deadline: end the worker's own tree, then any PMA Chrome.
    const timer=setTimeout(()=>{console.error('PMA shutdown deadline reached; ending the backend tree');killTrees([workerPid]).finally(()=>worker.kill());},SHUTDOWN_MS);
    worker.once('exit',()=>{clearTimeout(timer);cleanupManagedChrome(paths.root).catch(()=>{}).finally(()=>app.exit(0));});
    port.postMessage({type:'stop'});
  });
  app.on('window-all-closed',()=>app.quit());
}
