// 8D.1 probe: backend utilityProcess. Exercises the runtime pieces PMA's server/ relies on.
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright-core';
import {ESM_MARKER} from './probe-lib.mjs';

let port,context=null,db=null;
const checks=[];
async function check(name,work){
  const started=Date.now();
  try{const detail=await work();checks.push({name,ok:true,ms:Date.now()-started,...detail});}
  catch(error){checks.push({name,ok:false,ms:Date.now()-started,error:String(error?.stack||error).slice(0,2000)});}
}
function readBack(file){
  const again=new DatabaseSync(file);
  try{return {count:again.prepare('SELECT count(*) AS n FROM launches').get().n,integrity:again.prepare('PRAGMA integrity_check').get().integrity_check};}
  finally{again.close();}
}

async function probe(root){
  const startedAt=new Date().toISOString();
  await check('runtime',async()=>({node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome,type:process.type,execPath:process.execPath,platform:process.platform,arch:process.arch,pathHasNode:(process.env.PATH||'').toLowerCase().includes('nodejs')}));
  await check('esm-import',async()=>{if(ESM_MARKER!=='probe-lib-loaded')throw Error('relative ESM import failed');return {marker:ESM_MARKER,workerUrl:import.meta.url};});
  await check('sqlite',async()=>{
    const dir=path.join(root,'data');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'pma.sqlite');
    db=new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS launches(id INTEGER PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)))");
    db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO launches(at,data) VALUES(?,?)').run(startedAt,JSON.stringify({electron:process.versions.electron}));db.exec('COMMIT');
    const written=db.prepare('SELECT count(*) AS n FROM launches').get().n;db.close();db=null;
    const reread=readBack(file);if(reread.count!==written||reread.integrity!=='ok')throw Error('re-read mismatch '+JSON.stringify({written,reread}));
    return {file,launchesSoFar:reread.count,integrity:reread.integrity};
  });
  await check('files-unicode-path',async()=>{
    const dir=path.join(root,'data','файлы с пробелом');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'проба изображения.bin'),bytes=Buffer.from(Array.from({length:4096},(_,i)=>i%251));
    fs.writeFileSync(file,bytes);const back=fs.readFileSync(file),hash=b=>createHash('sha256').update(b).digest('hex');
    if(hash(back)!==hash(bytes))throw Error('bytes changed');return {file,sha256:hash(back)};
  });
  await check('chrome-playwright',async()=>{
    const profile=path.join(root,'profiles','проба профиль');fs.mkdirSync(profile,{recursive:true});
    // ponytail: headless + local content only; no Pinterest, no network in this probe.
    context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,timeout:60000});
    const page=context.pages()[0]||await context.newPage();
    await page.setContent('<title>PMA probe</title><p id="x">проба</p>');
    const text=await page.textContent('#x'),title=await page.title(),version=context.browser()?.version()||await page.evaluate(()=>navigator.userAgent);
    await context.close();context=null;
    if(text!=='проба'||title!=='PMA probe')throw Error('page content mismatch');
    return {profile,browser:version,profileFiles:fs.readdirSync(profile).length};
  });
  return {ok:checks.every(c=>c.ok),startedAt,root,checks};
}

async function stop(){
  try{await context?.close();}catch{}
  try{db?.close();}catch{}
  process.exit(0);
}

process.parentPort.on('message',async event=>{
  if(event.data?.type!=='init')return;
  port=event.ports[0];
  port.on('message',({data})=>{if(data?.type==='stop')stop();});
  port.start();
  port.postMessage({type:'result',result:await probe(event.data.root)});
});
