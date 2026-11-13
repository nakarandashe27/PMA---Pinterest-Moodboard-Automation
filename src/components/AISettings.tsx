import {useEffect,useState,type FormEvent} from 'react';
import {LoaderCircle} from 'lucide-react';
import Modal from './Modal';
import {api} from '../api';

type Profile={baseUrl:string;wireFormat:'responses'|'chat-completions';model:string;enabled:boolean;images:{supported:boolean;maxPerRequest:number;maxInputTokensPerImage:number};limits:{maxOutputTokens:number;maxInputTokens:number|null};tariff:{currency:string;inputPerMillion:number;outputPerMillion:number;outputLimitCoversReasoning:boolean;checkedAt:string};budget:{monthlyLimit:number;monthlyCalls:number}};
type Codex={found:boolean;source?:'installer'|'npm'|'path';version:string|null;login:'chatgpt'|'none'|'other'|'unknown';error?:string;verified:boolean;verification:{at:string;model:string}|null};
type View={mode:'api'|'codex';codex:Codex|null;profile:Profile|null;keyConfigured:boolean;keyHint:string|null;verified:boolean;verification:{at:string;image:boolean}|null;blockedReason:string|null;ledgerBlocked:string|null;month:{key:string;poolCalls:number|null;spend:{currency:string;micros:number;calls:number}[]}};
const empty:Profile={baseUrl:'https://',wireFormat:'responses',model:'',enabled:true,images:{supported:true,maxPerRequest:50,maxInputTokensPerImage:1600},limits:{maxOutputTokens:4000,maxInputTokens:null},tariff:{currency:'USD',inputPerMillion:0,outputPerMillion:0,outputLimitCoversReasoning:false,checkedAt:new Date().toISOString().slice(0,10)},budget:{monthlyLimit:10,monthlyCalls:100}};

const INSTALL='powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"';
const loginText={chatgpt:'выполнен через ChatGPT',none:'не выполнен',other:'выполнен не через ChatGPT — для режима подписки войдите через ChatGPT',unknown:'не удалось определить'};
const sourceText={installer:'официальный установщик',npm:'npm',path:'PATH'};

// Two explicit modes: the owner's ChatGPT subscription through Codex, or the owner's own API profile.
// Saving or switching never calls a model; each mode has its own explicit check button.
export default function AISettings({onClose}:{onClose:()=>void}){
  const [view,setView]=useState<View|null>(null),[form,setForm]=useState<Profile>(empty),[key,setKey]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[note,setNote]=useState('');
  const accept=(next:View)=>{setView(next);if(next.profile)setForm({...next.profile,tariff:{...next.profile.tariff,checkedAt:next.profile.tariff.checkedAt.slice(0,10)}});};
  useEffect(()=>{api<View>('/ai/profile').then(accept).catch(e=>setError((e as Error).message));},[]);
  async function run(label:string,work:()=>Promise<View>,done:string){setBusy(label);setError('');setNote('');try{accept(await work());setNote(done);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
  const set=<K extends keyof Profile>(k:K,v:Profile[K])=>setForm(f=>({...f,[k]:v}));
  const num=(v:string)=>v===''?0:Number(v);
  function save(event:FormEvent){event.preventDefault();void run('save',()=>api<View>('/ai/profile','PUT',form),'Профиль сохранён. Модель не вызывалась; нужна новая проверка.');}
  const spend=view?.month.spend[0],codex=view?.codex;
  const mode=(m:View['mode'])=>void run('mode',()=>api<View>('/ai/mode','PUT',{mode:m}),m==='codex'?'Выбран режим подписки ChatGPT (Codex). API-ключ не используется.':'Выбран режим своего API-ключа. Codex не используется.');
  return <Modal title="Настройки AI" onClose={onClose} wide>
  <fieldset className="form-stack" disabled={!view||!!busy}><legend>Как PMA обращается к AI</legend>
    <label className="checkbox"><input type="radio" name="ai-mode" checked={view?.mode==='codex'} onChange={()=>mode('codex')}/>Подписка ChatGPT (Codex)</label>
    <label className="checkbox"><input type="radio" name="ai-mode" checked={view?.mode==='api'} onChange={()=>mode('api')}/>Свой API-ключ</label>
  </fieldset>
  {view?.mode==='codex'?<div className="form-stack">
    <p><strong>Codex: {!codex?.found?'не найден на этом компьютере':codex.error||'найден'+(codex.version?', версия '+codex.version:'')+(codex.source?' ('+sourceText[codex.source]+')':'')}</strong><br/>
      {codex?.found&&!codex.error?<>Вход: {loginText[codex.login]}</>:null}</p>
    <ol className="muted">
      <li>Нужна подписка ChatGPT, в которую входит Codex (например, Plus или Pro). Вызовы расходуют лимиты подписки; PMA не платит и не переходит на API сама.</li>
      <li>Установите Codex: откройте PowerShell (Пуск → «PowerShell») и выполните официальную команду<br/><code style={{userSelect:'all'}}>{INSTALL}</code><br/>Приложение Codex из Microsoft Store само по себе не подходит: Windows не даёт другим программам запускать его. Вход в нём подходит.</li>
      <li>Войдите через ChatGPT: в приложении Codex или кнопкой «Войти через ChatGPT» ниже — откроется браузер. Пароль вводите только на странице ChatGPT; PMA его не видит.</li>
      <li>Нажмите «Обновить состояние», затем «Проверить».</li>
    </ol>
    <div className="modal-actions">
      <button type="button" className="button secondary" disabled={!!busy} onClick={()=>void run('status',()=>api<View>('/ai/profile'),'Состояние обновлено')}>{busy==='status'?<LoaderCircle size={17} className="spin"/>:null}Обновить состояние</button>
      <button type="button" className="button secondary" disabled={!!busy||!codex?.found} onClick={()=>void run('login',()=>api<View>('/ai/codex/login','POST',{}),'Открыт вход ChatGPT в браузере. После входа нажмите «Обновить состояние».')}>Войти через ChatGPT</button>
      <button type="button" className="button primary" disabled={!!busy||!codex?.found||codex.login==='none'||codex.login==='other'} onClick={()=>void run('probe',()=>api<View>('/ai/codex/probe','POST',{}),'Проверка пройдена: Codex видит изображение и отвечает по схеме')}>{busy==='probe'?<LoaderCircle size={17} className="spin"/>:null}Проверить</button>
    </div>
    <p className="muted">Проверка — один короткий вызов с маленькой картинкой; он расходует лимит подписки и считается в счётчике вызовов.</p>
    <p><strong>{codex?.verified?'Проверка пройдена'+(codex.verification?' ('+new Date(codex.verification.at).toLocaleString('ru-RU')+')':''):'Не проверено — AI пока недоступен, ручной путь работает'}</strong></p>
    <p className="muted">В этом месяце ({view.month.key}): вызовов AI {view.month.poolCalls??0} из 100.</p>
  </div>:null}
  {view?.mode==='api'?<><form className="form-stack" onSubmit={save}>
    <p className="muted">Свой API-ключ и бюджет владельца. Сохранение ничего не оплачивает. Платная проверка — отдельная кнопка ниже.</p>
    <label>Адрес API (HTTPS)<input value={form.baseUrl} onChange={e=>set('baseUrl',e.target.value)} placeholder="https://api.example.com/v1" required/></label>
    <label>Формат<select value={form.wireFormat} onChange={e=>set('wireFormat',e.target.value as Profile['wireFormat'])}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option></select></label>
    <label>ID модели<input value={form.model} onChange={e=>set('model',e.target.value)} required/></label>
    <label className="checkbox"><input type="checkbox" checked={form.images.supported} onChange={e=>set('images',{...form.images,supported:e.target.checked})}/>Модель принимает изображения</label>
    {form.images.supported?<><label>Изображений за один запрос (по документации модели)<input type="number" min={1} max={64} value={form.images.maxPerRequest} onChange={e=>set('images',{...form.images,maxPerRequest:num(e.target.value)})}/></label>
    <label>Верхний предел токенов на одно изображение<input type="number" min={1} value={form.images.maxInputTokensPerImage} onChange={e=>set('images',{...form.images,maxInputTokensPerImage:num(e.target.value)})}/></label></>:null}
    <label>Предел вывода, токенов<input type="number" min={64} value={form.limits.maxOutputTokens} onChange={e=>set('limits',{...form.limits,maxOutputTokens:num(e.target.value)})}/></label>
    <label>Валюта тарифа<input value={form.tariff.currency} maxLength={3} onChange={e=>set('tariff',{...form.tariff,currency:e.target.value.toUpperCase()})}/></label>
    <label>Цена входа за 1 млн токенов<input type="number" min={0} step="any" value={form.tariff.inputPerMillion} onChange={e=>set('tariff',{...form.tariff,inputPerMillion:num(e.target.value)})}/></label>
    <label>Цена вывода за 1 млн токенов<input type="number" min={0} step="any" value={form.tariff.outputPerMillion} onChange={e=>set('tariff',{...form.tariff,outputPerMillion:num(e.target.value)})}/></label>
    <label className="checkbox"><input type="checkbox" checked={form.tariff.outputLimitCoversReasoning} onChange={e=>set('tariff',{...form.tariff,outputLimitCoversReasoning:e.target.checked})}/>Рассуждения модели оплачиваются как вывод и входят в предел вывода (проверено по документации)</label>
    <label>Дата проверки тарифа<input type="date" value={form.tariff.checkedAt} onChange={e=>set('tariff',{...form.tariff,checkedAt:e.target.value})}/></label>
    <label>Денежный предел в месяц, {form.tariff.currency}<input type="number" min={0.01} step="any" value={form.budget.monthlyLimit} onChange={e=>set('budget',{...form.budget,monthlyLimit:num(e.target.value)})}/></label>
    <label>Вызовов AI в месяц (не больше 100)<input type="number" min={1} max={100} value={form.budget.monthlyCalls} onChange={e=>set('budget',{...form.budget,monthlyCalls:num(e.target.value)})}/></label>
    <label className="checkbox"><input type="checkbox" checked={form.enabled} onChange={e=>set('enabled',e.target.checked)}/>AI включён</label>
    <div className="modal-actions"><button className="button primary" disabled={!!busy}>{busy==='save'?<LoaderCircle size={17} className="spin"/>:null}Сохранить профиль</button></div>
  </form>
  {view?.profile?<div className="form-stack">
    <label>Ключ API{view.keyConfigured?<span className="muted"> — задан ({view.keyHint})</span>:null}<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder={view.keyConfigured?'Заменить ключ':'Вставьте ключ'}/></label>
    <div className="modal-actions">
      {view.keyConfigured?<button type="button" className="button secondary" disabled={!!busy} onClick={()=>void run('del',()=>api<View>('/ai/key/delete','POST',{}),'Ключ удалён')}>Удалить ключ</button>:null}
      <button type="button" className="button secondary" disabled={!!busy||!key} onClick={()=>void run('key',async()=>{const v=await api<View>('/ai/key','PUT',{key});setKey('');return v;},'Ключ сохранён в защищённом хранилище Windows')}>Сохранить ключ</button>
      <button type="button" className="button primary" disabled={!!busy||!view.keyConfigured} onClick={()=>void run('probe',()=>api<View>('/ai/probe','POST',{}),'Проверка пройдена')}>{busy==='probe'?<LoaderCircle size={17} className="spin"/>:null}Платная проверка</button>
    </div>
    <p className="muted">Проверка отправляет один короткий запрос с маленькой картинкой и учитывается в бюджете и счётчике вызовов.</p>
    <p><strong>{view.verified?'Профиль проверен'+(view.verification?.image?' (текст и изображения)':' (только текст)'):'Профиль не проверен — AI пока недоступен'}</strong></p>
    <p className="muted">В этом месяце ({view.month.key}): вызовов {view.month.poolCalls??0} из {form.budget.monthlyCalls}{spend?', расход '+(spend.micros/1e6).toFixed(2)+' '+spend.currency+' из '+form.budget.monthlyLimit:''}.</p>
  </div>:null}</>:null}
  {view?.ledgerBlocked||view?.mode==='api'&&view.blockedReason?<p role="alert" className="form-error">{view.ledgerBlocked||view.blockedReason}</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}{note?<p role="status" className="muted">{note}</p>:null}
  </Modal>;
}
