import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../../store.mjs';
import {setLocalPassword} from '../../local-auth.mjs';
import {createPmaServer} from '../../app.mjs';
import {sha256} from '../../domain.mjs';

export async function httpFixture(t,{workspace=path.resolve('.'),...extra}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pma-isolation-')),store=new Store(root),opened=[];
  let now=Date.now();const pinterest={close:async()=>{},open:async c=>opened.push(c.id),requireIdentity:async c=>c.username,exclusive:async fn=>fn()};
  const owners={};
  for(const id of ['a','b']){
    store.save('connection',{id,label:'Test '+id,username:'test_'+id,status:'ready'});await setLocalPassword(store,id,'test-password-'+id);
    const p={id:'project-'+id,name:'Private '+id,ownerConnectionId:id};store.save('project',p);
    const bytes=Buffer.from([255,216,255,224,id.charCodeAt(0)]),hash=sha256(bytes),asset=hash+'.jpg';fs.mkdirSync(path.join(root,'assets'),{recursive:true});fs.writeFileSync(path.join(root,'assets',asset),bytes);
    const item={id:'candidate-'+id,pinId:id==='a'?'111':'222',pinUrl:'https://www.pinterest.com/pin/'+(id==='a'?'111':'222')+'/',asset,sha256:hash,altText:'Test',imageUrl:'https://i.pinimg.com/474x/aa/bb/cc/'+hash.slice(0,32)+'.jpg'};
    const uploadId=id==='a'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222';fs.mkdirSync(path.join(root,'uploads'),{recursive:true});fs.writeFileSync(path.join(root,'uploads',uploadId+'.jpg'),bytes);store.save('upload',{id:uploadId,projectId:p.id,filename:uploadId+'.jpg',name:'Test'},p.id);
    const run={id:'run-'+id,projectId:p.id,connectionId:id,query:'Test',title:'Test',sourceKind:'live',status:'ready',createdAt:new Date().toISOString(),candidates:[item],selectedIds:[item.id],uploads:[uploadId]};store.save('run',run,p.id);
    owners[id]={p,run,item,uploadId};
  }
  store.save('project',{id:'unowned',name:'Legacy unowned'});store.save('settings',{id:'workspace-settings',activeConnectionId:'a'});
  const app=createPmaServer({workspace,root,store,pinterest,port:0,authOptions:{now:()=>now},...extra});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+app.server.address().port;
  function client(){
    let cookie='',token='';
    const request=async(route,method='GET',data,headers={})=>{
      const r=await fetch(url+route,{method,headers:{Cookie:cookie,...(token?{'X-PMA-Token':token}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
      const setCookie=r.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
      const content=await r.text();let body;try{body=JSON.parse(content);}catch{body=content;}
      if(route==='/api/bootstrap'&&body.token)token=body.token;
      return {status:r.status,headers:r.headers,body};
    };
    return {request,login:async id=>{await request('/api/bootstrap');const r=await request('/api/active-connection','POST',{id,password:'test-password-'+id});assert.equal(r.status,200);return r;},cookie:()=>cookie};
  }
  t.after(async()=>{await app.shutdown();store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('pma-isolation-'));fs.rmSync(root,{recursive:true,force:true});});
  return {root,store,app,url,client,owners,opened,pinterest,advance:ms=>{now+=ms;app.auth.current();}};
}
