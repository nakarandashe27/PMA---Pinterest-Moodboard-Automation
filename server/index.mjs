import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './store.mjs';
import {Pinterest} from './pinterest.mjs';
import {seedG1} from './assets.mjs';
import {createPmaServer} from './app.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(workspace,'.local','pma'),port=Number(process.env.PORT||8787);
const store=new Store(root),pinterest=new Pinterest(root);
await seedG1(store,root,workspace);store.recover();store.recoverExports();
const app=createPmaServer({workspace,root,store,pinterest,port,dev:process.env.PMA_DEV==='1'});
app.server.listen(port,'127.0.0.1',()=>console.log('PMA: http://127.0.0.1:'+port));
let shuttingDown=false;
const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await app.shutdown();store.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
