// Fixed, versioned bridge. No ipcRenderer, no paths, no shell: one call that main validates.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pma',Object.freeze({
  version:1,
  api:(method,route,body)=>ipcRenderer.invoke('pma:api',{method,route,body}),
  reveal:kind=>ipcRenderer.invoke('pma:reveal',kind),
}));
