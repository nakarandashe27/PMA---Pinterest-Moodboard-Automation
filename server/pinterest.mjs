import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { extractPinCards } from '../spikes/pinterest-g1/extract-dom.mjs';
import { normalizeCandidates } from '../spikes/pinterest-g1/pins.mjs';
import { AppError,LIMITS } from './domain.mjs';
import { inspectPinterestAccess,PinterestAccessError } from './pinterest-access.mjs';
import { startPinterestLens } from './pinterest-lens.mjs';
import {ensureExportBoard,readExportBoard,saveExportPin} from './pinterest-export-ui.mjs';

// One controlled browser per isolated profile. No ambient cookie extraction,
// stealth plugins, hidden application state or private Pinterest HTTP endpoints.
export class Pinterest {
  constructor(directory,{headless=false}={}){this.directory=directory;this.headless=headless;this.contexts=new Map();this.busy=false;}
  async exclusive(work){if(this.busy)throw new AppError('Браузер Pinterest занят',409);this.busy=true;try{return await work();}finally{this.busy=false;}}
  ensureExportBoard(...args){return ensureExportBoard(this,...args);}
  readExportBoard(...args){return readExportBoard(this,...args);}
  saveExportPin(...args){return saveExportPin(this,...args);}
  async context(connection) {
    const existing=this.contexts.get(connection.id);
    if(existing)return existing;
    const context=await chromium.launchPersistentContext(path.join(this.directory,'profiles',connection.id),{
      channel:'chrome',headless:this.headless,viewport:{width:1280,height:900},acceptDownloads:false
    });
    this.contexts.set(connection.id,context);
    context.on('close',()=>this.contexts.delete(connection.id));
    return context;
  }
  async page(connection) {
    const context=await this.context(connection);
    return context.pages()[0]||await context.newPage();
  }
  async open(connection) {
    if(this.busy)throw new AppError('Сначала завершите текущий поиск',409);
    const page=await this.page(connection);
    if(!/^https:\/\/([a-z0-9-]+\.)?pinterest\.com\//i.test(page.url()))await page.goto('https://www.pinterest.com/',{waitUntil:'domcontentloaded',timeout:35000});
    await page.bringToFront();
  }
  async identity(connection) {
    const page=await this.page(connection);
    if(!/^https:\/\/([a-z0-9-]+\.)?pinterest\.com\//i.test(page.url()))return null;
    return await page.evaluate(()=>{
      const profile=document.querySelector('[data-test-id="header-profile"]');
      const link=profile?.closest('a[href]')||profile?.querySelector('a[href]');
      const path=link?.getAttribute('href');
      const match=path?.match(/^\/([a-zA-Z0-9_]+)\/?$/);
      if(match&&!['login','signup','search','business','settings'].includes(match[1]))return match[1];
      // This fallback only accepts a link labelled as the viewer's profile.
      for(const anchor of document.querySelectorAll('a[aria-label][href]')){
        if(!/^(your profile|ваш профиль|your account)$/i.test(anchor.getAttribute('aria-label')||''))continue;
        const url=new URL(anchor.href,location.href),m=url.pathname.match(/^\/([a-zA-Z0-9_]+)\/?$/);
        if(m)return m[1];
      }
      return null;
    });
  }
  async requireIdentity(connection) {
    const username=await this.identity(connection);
    if(!username)throw new PinterestAccessError({kind:'login',message:'Нужен вход в Pinterest. Откройте подключение и войдите в браузере.'});
    if(connection.username&&connection.username.toLowerCase()!==username.toLowerCase())throw new PinterestAccessError({kind:'login',message:'В этом профиле открыт другой Pinterest-аккаунт. Вернитесь в исходный аккаунт подборки и продолжите поиск.'});
    return username;
  }
  async blocked(page) {
    return page.evaluate(inspectPinterestAccess);
  }
  async checkAccess(page,runId,first=false){
    const state=await this.blocked(page);
    if((first||state.kind)&&/^[a-f0-9-]{36}$/.test(runId||'')){
      const directory=path.join(this.directory,'diagnostics');
      await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(path.join(directory,runId+(state.kind?'-blocked':'-page')+'.json'),JSON.stringify({...state,at:new Date().toISOString()},null,2));
    }
    if(state.kind)throw new PinterestAccessError(state);
  }
  async lensDiagnostics(page,runId){
    if(!/^[a-f0-9-]{36}$/.test(runId||''))return;
    const controls=await page.evaluate(()=>{
      const visible=el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';};
      const describe=el=>({tag:el.tagName,role:el.getAttribute('role'),label:el.getAttribute('aria-label'),placeholder:el.getAttribute('placeholder'),testId:el.getAttribute('data-test-id'),type:el.getAttribute('type'),accept:el.getAttribute('accept'),visible:visible(el),text:el.tagName==='BUTTON'?(el.innerText||'').slice(0,120):undefined});
      return {page:location.origin+location.pathname,controls:[...document.querySelectorAll('button,[role="button"],input')].filter(el=>visible(el)||el.type==='file').slice(0,65).map(describe)};
    });
    const directory=path.join(this.directory,'diagnostics');await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,runId+'-lens.json'),JSON.stringify(controls,null,2));
  }
  async collect(connection,brief,uploads,onProgress,signal) {
    if(this.busy)throw new AppError('Другой поиск уже выполняется',409);
    this.busy=true;
    try{
      const page=await this.page(connection);
      page.setDefaultTimeout(12000);
      await this.checkAccess(page,brief.id);
      if(page.url()==='about:blank')await page.goto('https://www.pinterest.com/',{waitUntil:'domcontentloaded',timeout:35000});
      await this.checkAccess(page,brief.id);
      await page.locator('[data-test-id="header-profile"],a[aria-label="Your profile" i],a[aria-label="Ваш профиль" i]').first().waitFor({state:'attached',timeout:10000}).catch(()=>{});
      await this.checkAccess(page,brief.id);
      await this.requireIdentity(connection);
      let searchEvidence=null;
      if(brief.mode==='image'){
        if(!uploads.length)throw new AppError('Добавьте изображение для Pinterest Lens');
        await page.goto('https://www.pinterest.com/',{waitUntil:'domcontentloaded',timeout:35000});
        await this.checkAccess(page,brief.id);
        searchEvidence=await startPinterestLens(page,uploads[0],{
          checkAccess:async()=>{signal.throwIfAborted();await this.checkAccess(page,brief.id);signal.throwIfAborted();},
          phase:message=>{signal.throwIfAborted();return onProgress({message});},
          diagnose:()=>this.lensDiagnostics(page,brief.id)
        });
        await onProgress({searchEvidence,message:'Pinterest Lens открыт. Собираем визуальную выдачу…'});
      }else{
        let target='https://www.pinterest.com/search/pins/?q='+encodeURIComponent(brief.interpretation||brief.query)+'&rs=typed';
        try{
          const url=new URL(brief.query);
          if(url.protocol==='https:'&&(url.hostname==='pinterest.com'||url.hostname.endsWith('.pinterest.com'))&&/^\/pin\/[1-9]\d*\/?$/.test(url.pathname)&&!url.username&&!url.password&&!url.port)target='https://www.pinterest.com'+url.pathname;
        }catch{/* A normal text query is not a URL. */}
        await page.goto(target,{waitUntil:'domcontentloaded',timeout:35000});
      }
      await page.waitForTimeout(1800);
      const saved=(brief.observedPins||[]).map(pin=>({...pin,alt:pin.altText,width:pin.observedWidth,height:pin.observedHeight}));
      const target=Math.max(1,Math.min(60,brief.candidateLimit||60));
      const found=new Map(normalizeCandidates(saved).pins.map(pin=>[pin.pinId,pin]));let stalled=0;
      const deadline=Date.now()+LIMITS.searchMs;
      await this.checkAccess(page,brief.id,true);
      for(let scroll=0;scroll<LIMITS.scrolls&&Date.now()<deadline&&found.size<target;scroll++){
        signal.throwIfAborted();
        await this.checkAccess(page,brief.id);
        await this.requireIdentity(connection);
        const observed=await page.evaluate(extractPinCards);
        await this.requireIdentity(connection);
        signal.throwIfAborted();
        const {pins}=normalizeCandidates(observed.candidates);
        const before=found.size;
        for(const pin of pins){if(found.size>=target)break;if(!found.has(pin.pinId))found.set(pin.pinId,pin);}
        stalled=before===found.size?stalled+1:0;
        await onProgress({found:found.size,pins:[...found.values()].slice(0,60),searchEvidence,message:'Найдено '+found.size+' пинов Pinterest'+(brief.mode==='image'?' через Lens':'')});
        if(stalled>=5)break;
        await page.evaluate(()=>window.scrollBy(0,Math.round(window.innerHeight*.85)));
        await page.waitForTimeout(900);
      }
      signal.throwIfAborted();
      await this.checkAccess(page,brief.id);
      if(!found.size)throw new AppError('Pinterest не показал подходящие карточки. Можно изменить запрос или проверить открытый браузер.');
      return [...found.values()].slice(0,target);
    }finally{this.busy=false;}
  }
  async close(){await Promise.allSettled([...this.contexts.values()].map(c=>c.close()));}
}
