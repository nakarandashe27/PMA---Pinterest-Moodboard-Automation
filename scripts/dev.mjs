import { spawn } from 'node:child_process';
const children=[spawn(process.execPath,['server/index.mjs'],{stdio:'inherit',windowsHide:true}),spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit',windowsHide:true})];
const stop=()=>children.forEach(child=>child.kill());
process.on('SIGINT',()=>{stop();process.exit();});process.on('SIGTERM',()=>{stop();process.exit();});
children.forEach(child=>child.on('exit',code=>{if(code){stop();process.exit(code);}}));
