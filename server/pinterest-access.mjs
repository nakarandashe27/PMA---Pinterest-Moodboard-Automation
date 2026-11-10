import { AppError } from './domain.mjs';

export class PinterestAccessError extends AppError {
  constructor(state){super(state.message,409);this.code=state.kind;}
}

// Evaluated in the page. Read only rendered DOM; never inspect challenge
// contents, responses, tokens or hidden Pinterest application state.
export function inspectPinterestAccess(){
  const visible=element=>{
    let rect=element.getBoundingClientRect();
    let left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
    if(right<=left||bottom<=top)return false;
    for(let parent=element;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent);
      if(parent.hidden||style.display==='none'||['hidden','collapse'].includes(style.visibility)||Number(style.opacity)<=.01||style.contentVisibility==='hidden')return false;
      if(parent!==element&&/(hidden|clip|scroll|auto)/.test(style.overflowX+' '+style.overflowY)){
        rect=parent.getBoundingClientRect();
        if(/hidden|clip|scroll|auto/.test(style.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right);}
        if(/hidden|clip|scroll|auto/.test(style.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}
        if(right<=left||bottom<=top)return false;
      }
    }
    return true;
  };
  const safeURL=value=>{try{const url=new URL(value,location.href);return url.origin+url.pathname;}catch{return '';}};
  const evidence=[];
  let challenge=false;
  for(const frame of document.querySelectorAll('iframe[src]')){
    const src=frame.getAttribute('src')||'';
    if(!/captcha|challenges\.cloudflare\.com/i.test(src))continue;
    let invisibleAnchor=false;
    try{const url=new URL(src,location.href);invisibleAnchor=/\/recaptcha\/(api2|enterprise)\/anchor\/?$/.test(url.pathname)&&url.searchParams.get('size')==='invisible';}catch{}
    const badge=!!frame.closest('.grecaptcha-badge')||invisibleAnchor;
    const shown=visible(frame),rect=frame.getBoundingClientRect();
    evidence.push({element:'iframe',source:safeURL(src),badge,visible:shown,width:Math.round(rect.width),height:Math.round(rect.height)});
    if(shown&&!badge)challenge=true;
  }
  for(const element of document.querySelectorAll('[data-test-id*="captcha"]')){
    const shown=visible(element);
    // A placeholder or a badge wrapper alone is not a request for input.
    const content=!!element.innerText?.trim()||!![...element.querySelectorAll('input:not([type="hidden"]),button')].find(visible);
    const badge=!!element.closest('.grecaptcha-badge')||!!element.querySelector('.grecaptcha-badge');
    evidence.push({element:'captcha-container',visible:shown,content,badge});
    if(shown&&content&&!badge)challenge=true;
  }
  const login=/^\/(login|signup)(\/|$)/i.test(location.pathname)||[...document.querySelectorAll('[data-test-id="fullPageSignupModal"],[data-test-id="unauth-upsell"]')].some(visible);
  const checkpoint=/^\/(challenge|checkpoint|captcha)(\/|$)/i.test(location.pathname);
  const kind=login?'login':challenge||checkpoint?'captcha':null;
  return {kind,message:kind==='login'?'Pinterest запросил вход. Откройте браузер Pinterest и войдите вручную.':kind==='captcha'?'Pinterest показал проверку. Пройдите её вручную в открытом браузере Pinterest.':null,evidence:evidence.slice(0,12),page:safeURL(location.href)};
}
