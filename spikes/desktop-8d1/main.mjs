// 8D.1 probe: Electron main. Owns the window, the single-instance lock and the worker lifecycle.
import {app,BrowserWindow,MessageChannelMain,utilityProcess,protocol,net} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
// ponytail: fixed probe root; the real PMA gets one resolver for %LOCALAPPDATA%/PMA (8D.3).
const root=path.join(process.env.LOCALAPPDATA,'PMA-проба 8D1');
const exitAfterProbe=process.argv.includes('--exit-after-probe');
const SHUTDOWN_MS=15000;
// Window/taskbar icon: packaged copy from build.extraResources; in development the design source.
const icon=app.isPackaged?path.join(process.resourcesPath,'icon.ico'):path.join(here,'..','..','design','pma-desktop-icon.ico');
fs.mkdirSync(path.join(root,'shell'),{recursive:true});
app.setPath('userData',path.join(root,'shell'));
app.setPath('sessionData',path.join(root,'shell','session'));
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true}}]);

if(!app.requestSingleInstanceLock()){app.quit();}
else{
  let win,worker,port,result=null,quitting=false,exitCode=0;
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
  function startWorker(){
    worker=utilityProcess.fork(path.join(here,'worker.mjs'),[],{serviceName:'PMA backend probe',stdio:'inherit'});
    const {port1,port2}=new MessageChannelMain();port=port1;
    port.on('message',({data})=>{
      if(data.type!=='result')return;
      result=data.result;exitCode=result.ok?0:1;
      fs.mkdirSync(path.join(root,'diagnostics'),{recursive:true});
      fs.writeFileSync(path.join(root,'diagnostics','probe-'+result.startedAt.replace(/[:.]/g,'-')+'.json'),JSON.stringify({...result,main:{execPath:process.execPath,resourcesPath:process.resourcesPath,packaged:app.isPackaged,argv:process.argv.slice(1)}},null,2));
      win?.webContents.send('probe-result',result);
      if(exitAfterProbe)app.quit();
    });
    port.start();
    worker.postMessage({type:'init',root},[port2]);
    worker.on('exit',code=>{if(!quitting&&code!==0){exitCode=2;console.error('worker exited unexpectedly',code);}});
  }
  app.whenReady().then(()=>{
    protocol.handle('app',request=>{
      const file=path.normalize(path.join(here,'ui',new URL(request.url).pathname));
      if(!file.startsWith(path.join(here,'ui')+path.sep))return new Response('Not found',{status:404});
      return net.fetch(pathToFileURL(file).toString());
    });
    win=new BrowserWindow({width:760,height:620,show:!exitAfterProbe,title:'PMA — проба 8D.1',icon,webPreferences:{preload:path.join(here,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_p,callback)=>callback(false));
    win.webContents.on('did-finish-load',()=>{if(result)win.webContents.send('probe-result',result);});
    win.loadURL('app://pma/index.html');
    startWorker();
  });
  // The window cross means exit: stop the worker (Chrome, DB) within a deadline, then quit.
  app.on('before-quit',event=>{
    if(quitting||!worker)return;
    event.preventDefault();quitting=true;
    const timer=setTimeout(()=>{console.error('shutdown deadline: killing worker');worker.kill();},SHUTDOWN_MS);
    worker.once('exit',()=>{clearTimeout(timer);app.exit(exitCode);});
    port.postMessage({type:'stop'});
  });
  app.on('window-all-closed',()=>app.quit());
}
