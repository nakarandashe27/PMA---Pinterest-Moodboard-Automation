// Outbound AI transport: public HTTPS only. The resolved address is checked at connect time (no DNS
// rebinding window), redirects are never followed, so the key reaches only the configured host.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import {AppError} from './domain.mjs';

const RESPONSE_LIMIT=10*1024*1024;

export function publicAddress(ip){
  if(net.isIPv4(ip)){
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===192&&b===0)||(a===198&&(b===18||b===19)));
  }
  if(net.isIPv6(ip)){
    const v=ip.toLowerCase();
    const mapped=v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);if(mapped)return publicAddress(mapped[1]);
    // WHATWG URL writes [::ffff:127.0.0.1] as [::ffff:7f00:1]; read the embedded IPv4 in that form too.
    const hex=v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if(hex){const [hi,lo]=hex.slice(1).map(x=>parseInt(x,16));return publicAddress([hi>>8,hi&255,lo>>8,lo&255].join('.'));}
    // fec0::/10 is the deprecated site-local range: private, like fe80::/10.
    return !(v==='::'||v==='::1'||/^f[cd]/.test(v)||/^fe[89a-f]/.test(v)||/^ff/.test(v)||v.startsWith('64:ff9b:')||v.startsWith('2001:db8'));
  }
  return false;
}

// Static checks on the configured base URL. Address checks happen again on every connection.
export function checkEndpoint(value){
  let u;try{u=new URL(value);}catch{throw new AppError('Адрес API должен быть полным URL',400);}
  if(u.protocol!=='https:')throw new AppError('Адрес API должен начинаться с https://',400);
  if(u.username||u.password)throw new AppError('Логин и пароль в адресе API запрещены; ключ задаётся отдельно',400);
  if(u.search||u.hash)throw new AppError('Адрес API без параметров запроса и якоря',400);
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(net.isIP(host)&&!publicAddress(host))throw new AppError('Служебные, локальные и частные адреса для API запрещены',400);
  if(/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host))throw new AppError('Локальные имена для API запрещены',400);
  return u.origin+u.pathname.replace(/\/+$/,'');
}

export function guardedLookup(lookup=dns.lookup){
  return (hostname,options,callback)=>{
    lookup(hostname,{...options,all:true},(error,addresses)=>{
      if(error)return callback(error);
      const list=Array.isArray(addresses)?addresses:[{address:addresses,family:options.family||4}];
      const bad=list.find(a=>!publicAddress(a.address));
      if(bad)return callback(new AppError('Адрес API указывает на служебную или частную сеть. Запрос не отправлен.',400));
      if(options.all)callback(null,list);else callback(null,list[0].address,list[0].family);
    });
  };
}

// One POST, no retries, no redirects, bounded response. Status ≥300 is returned to the caller.
export function postJson(url,{headers={},body,signal,timeoutMs=120000,lookup}={}){
  const target=new URL(checkEndpoint(url));
  return new Promise((resolve,reject)=>{
    const payload=Buffer.from(JSON.stringify(body));
    const req=https.request({hostname:target.hostname,port:target.port||443,path:target.pathname,method:'POST',lookup:guardedLookup(lookup),signal,timeout:timeoutMs,
      headers:{'Content-Type':'application/json','Content-Length':payload.length,'Accept':'application/json',...headers}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>RESPONSE_LIMIT){req.destroy(new AppError('Ответ API слишком большой',502));return;}chunks.push(chunk);});
      res.on('end',()=>{let data=null;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}resolve({status:res.statusCode,data});});
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Object.assign(Error('timeout'),{code:'ETIMEDOUT'})));
    req.on('error',reject);
    req.end(payload);
  });
}
