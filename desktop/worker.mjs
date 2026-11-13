// Backend utilityProcess: the only owner of the store, ledger, jobs and managed Chrome.
// UI requests arrive over the MessagePort from main; the loopback listener serves Figma only.
import {Store} from '../server/store.mjs';
import {Pinterest} from '../server/pinterest.mjs';
import {createPmaServer,FIGMA_PROTOCOL} from '../server/app.mjs';
import {serviceStatus,writeReport} from '../server/diagnostics.mjs';
import {Ledger} from '../server/ledger.mjs';
import {importLegacyReservations} from '../server/ai-budget.mjs';
import {pickExecutor,findCodex} from '../server/ai-codex.mjs';
import {AppError} from '../server/domain.mjs';
import {layout,ensureLayout,acquireInstanceLock,prepareSchema,diskStatus} from '../server/data-root.mjs';

// The Figma plugin expects 8787; PMA_FIGMA_PORT exists only so tests can run beside a live prototype.
const FIGMA_PORT=Number(process.env.PMA_FIGMA_PORT)||8787;
// Smoke tests only: PMA_TEST_CODEX=none stands for a PC without Codex, so the owner's real Codex is never run.
const codexLocate=process.env.PMA_TEST_CODEX==='none'?()=>null:findCodex;
let app,store,ipc,port,lock,stopping=false;
// API keys live only in main's OS-protected vault; the worker asks for one key, for one owner, when sending.
const vaultWaiting=new Map();let vaultSeq=0;
const vaultCall=(op,connectionId,key)=>new Promise((resolve,reject)=>{const id=++vaultSeq;vaultWaiting.set(id,{resolve,reject});port.postMessage({type:'vault',id,op,connectionId,key});});
const vault={get:id=>vaultCall('get',id),put:(id,key)=>vaultCall('put',id,key),delete:id=>vaultCall('delete',id)};

// Order matters: lock before any data is opened, schema/backup before the Store, ledger before jobs.
// Production never seeds G1 data and never imports the developer's .local/pma.
// Smoke tests only: a real managed Chrome (headless, PMA profile) that never opens Pinterest and waits.
class HangingPinterest extends Pinterest {
  async collect(connection,_brief,_uploads,progress,signal){
    await this.context(connection);await progress({pins:[],message:'test: managed Chrome started'});
    await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }
}
async function start({root,workspace,appVersion,pluginReady}){
  const paths=ensureLayout(layout(root));
  lock=acquireInstanceLock(paths.root);
  const schema=prepareSchema(paths);
  store=new Store(paths.data);
  importLegacyReservations(store);
  store.ledger=new Ledger(paths.accounting,store);
  store.recover();store.recoverExports();
  const info={appVersion,pluginReady,figmaProtocol:FIGMA_PROTOCOL,schemaVersion:schema.version,schemaBackup:schema.backup?.id||null,figma:{available:false,reason:'Мост Figma запускается'}};
  const pinterest=process.env.PMA_TEST_PINTEREST==='hang'?new HangingPinterest(paths.root,{headless:true}):new Pinterest(paths.root);
  const diagnostics={status:owner=>serviceStatus({store,owner,info}),report:owner=>writeReport(paths.diagnostics,serviceStatus({store,owner,info}))};
  app=createPmaServer({workspace,root:paths.data,store,pinterest,diagnostics,figmaStatus:()=>info.figma,port:FIGMA_PORT,figmaOnly:true,freeSpace:()=>diskStatus(paths).freeBytes,vault,codexLocate,aiExecutor:connectionId=>pickExecutor({store,connectionId,vault,locate:codexLocate})});
  ipc=app.createIpcClient();
  const figma=await new Promise(resolve=>{
    app.server.once('error',error=>resolve({available:false,reason:error.code==='EADDRINUSE'?'Порт 8787 занят другим процессом':'Не удалось открыть порт Figma'}));
    app.server.listen(FIGMA_PORT,'127.0.0.1',()=>resolve({available:true}));
  });
  info.figma=figma;
  return {figma,schema:{version:schema.version,backup:schema.backup?.id||null},ai:store.ledger.blocked?{available:false,reason:store.ledger.blocked}:{available:true}};
}

async function stop(){
  if(stopping)return;stopping=true;
  try{await app?.shutdown();}catch(error){console.error('shutdown',error?.message);}
  try{store?.ledger?.close();store?.close();}catch{}
  lock?.release();
  process.exit(0);
}

process.parentPort.on('message',async event=>{
  if(event.data?.type!=='init')return;
  port=event.ports[0];
  port.on('message',async({data})=>{
    if(data?.type==='stop')return stop();
    if(data?.type==='vault-reply'){const w=vaultWaiting.get(data.id);vaultWaiting.delete(data.id);if(data.ok)w?.resolve(data.value??null);else w?.reject(new AppError(data.error,409));return;}
    if(data?.type!=='request'||stopping||!ipc)return;
    const result=await ipc.request({method:data.method,route:data.route,body:data.body});
    port.postMessage({type:'reply',id:data.id,...result});
  });
  port.start();
  try{port.postMessage({type:'ready',...await start(event.data)});}
  catch(error){
    // Data stays untouched; the window shows why PMA cannot open it.
    try{store?.ledger?.close();store?.close();}catch{}
    port.postMessage({type:'failed',message:String(error?.message||error).slice(0,500)});
  }
});
