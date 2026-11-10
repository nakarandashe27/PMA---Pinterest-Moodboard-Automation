// Fixed, minimal surface: the renderer can only receive the probe result.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pma',{onResult:callback=>ipcRenderer.on('probe-result',(_event,result)=>callback(result))});
