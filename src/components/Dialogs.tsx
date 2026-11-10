import {useEffect,useState,type FormEvent} from 'react';
import {ArrowRight,Check,Copy,ExternalLink,LoaderCircle} from 'lucide-react';
import Modal from './Modal';
import {api,sessionChannelId} from '../api';
import type {Connection,PreparedExport,Project,Workspace} from '../types';

export function ProjectDialog({onClose,onCreated}:{onClose:()=>void;onCreated:(p:Project)=>Promise<void>}){
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{await onCreated(await api<Project>('/projects','POST',{name}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Modal title="Новый проект" onClose={onClose}><form onSubmit={submit} className="form-stack">
    <label>Название проекта<input autoFocus value={name} onChange={e=>setName(e.target.value)} maxLength={100} required placeholder="Например, общественный сад"/></label>
    <p className="muted">Задания и подборки этого проекта будут храниться вместе.</p>{error?<p role="alert" className="form-error">{error}</p>:null}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" disabled={busy||!name.trim()}>Создать проект <ArrowRight size={17}/></button></div>
  </form></Modal>;
}

export function ConnectionDialog({workspace,onClose,onConnected}:{workspace:Workspace;onClose:()=>void;onConnected:()=>Promise<void>}){
  const [label,setLabel]=useState('Мой Pinterest'),[waiting,setWaiting]=useState<Connection|null>(null),[unlocking,setUnlocking]=useState<Connection|null>(null),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function changed(){setPassword('');setConfirmation('');await onConnected();const channel=new BroadcastChannel('pma-session');channel.postMessage({source:sessionChannelId});channel.close();}
  async function open(existing?:Connection){
    setBusy(true);setError('');
    try{
      if(!existing&&password!==confirmation)throw Error('Пароли не совпали');
      const next=await api<Connection>(existing?'/connections/'+existing.id+'/open':'/connections','POST',existing?{}:{label,password});
      await changed();setWaiting(next);setUnlocking(null);if(next.browserError)setError(next.browserError);
    }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function verify(){if(!waiting)return;setBusy(true);setError('');try{await api('/connections/'+waiting.id+'/check','POST',{});await onConnected();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function choose(event:FormEvent){event.preventDefault();if(!unlocking)return;setBusy(true);setError('');try{await api('/active-connection','POST',{id:unlocking.id,password});await changed();if(unlocking.status==='ready')onClose();else{setWaiting(unlocking);const next=await api<Connection>('/connections/'+unlocking.id+'/open','POST',{});setWaiting(next);if(next.browserError)setError(next.browserError);}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function lock(){setBusy(true);setError('');try{await api('/active-connection','POST',{id:null});await changed();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Modal title="Подключение Pinterest" onClose={onClose}><div className="form-stack">
    {waiting?<><div className="instruction-panel"><h3>{waiting.browserError?'Подключение сохранено':'Войдите в открытом Chrome'}</h3><p>{waiting.browserError?'Повторно создавать подключение не нужно. Откройте Pinterest снова в этом же профиле.':'Завершите вход в свой аккаунт Pinterest, затем вернитесь сюда и проверьте подключение.'}</p><p>Профиль останется на этом ПК для следующих запусков.</p></div><button className="button secondary" disabled={busy} onClick={()=>open(waiting)}><ExternalLink size={17}/>Открыть Pinterest снова</button><button className="button primary" disabled={busy||!!waiting.browserError} onClick={verify}>{busy?<LoaderCircle className="spin" size={17}/>:<Check size={17}/>}Я вошёл — проверить подключение</button></>:unlocking?<form className="form-stack" onSubmit={choose}>
      <p>Открыть {unlocking.label}</p>{unlocking.passwordConfigured?<><label>Локальный пароль PMA<input autoFocus type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} maxLength={256} required/></label><button className="button primary" disabled={busy||!password}>Открыть свои проекты</button></>:<p className="form-notice">Для существующего подключения сначала задайте пароль на этом ПК: откройте терминал в папке проекта и выполните <code>npm run password</code>. Затем обновите страницу. Это первичная защита сохранённого профиля.</p>}
      <button type="button" className="button secondary" disabled={busy} onClick={()=>{setUnlocking(null);setPassword('');setError('');}}>Назад</button>
    </form>:<>
      <p className="muted">Данные и отдельный профиль Chrome открываются локальным паролем PMA. Через 30 минут потребуется ввести его снова.</p>
      {workspace.connections.length?<div className="connection-list">{workspace.connections.map(c=><div key={c.id}><span><strong>{c.label}</strong><small>{c.username?'@'+c.username:'Вход ещё не завершён'}</small></span><button className="button secondary small" disabled={busy} onClick={()=>c.id===workspace.activeConnectionId?open(c):setUnlocking(c)}>{c.id===workspace.activeConnectionId?'Открыть Chrome':'Открыть'}</button></div>)}</div>:null}
      {workspace.activeConnectionId?<button className="button secondary" disabled={busy} onClick={lock}>Заблокировать PMA и закрыть Chrome</button>:null}
      <label>Название нового подключения<input value={label} onChange={e=>setLabel(e.target.value)} maxLength={60}/></label>
      <label>Новый локальный пароль PMA<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={12} maxLength={256}/></label>
      <label>Повторите пароль<input type="password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} maxLength={256}/></label>
      <p className="form-hint">От 12 символов. Выберите отдельный пароль PMA; пароль Pinterest вводится только в Chrome.</p>
      <button className="button primary" disabled={busy||!label.trim()||password.length<12||password!==confirmation} onClick={()=>open()}>{busy?<LoaderCircle className="spin" size={17}/>:<ExternalLink size={17}/>}Создать подключение</button>
    </>}
    {error?<p role="alert" className="form-error">{error}</p>:null}
  </div></Modal>;
}

export {default as BriefDialog} from './BriefDialog';

export function ExportDialog({prepared,onClose}:{prepared:PreparedExport;onClose:()=>void}){
  const [data,setData]=useState(prepared),[copied,setCopied]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[newFrame,setNewFrame]=useState(false),[boardUrl,setBoardUrl]=useState(''),[boardName,setBoardName]=useState(prepared.pinterest?.boardName||'');
  useEffect(()=>{
    let alive=true;const controller=new AbortController();
    const timer=setInterval(()=>{api<Partial<PreparedExport>>('/exports/'+prepared.id,'GET',undefined,controller.signal).then(status=>{if(alive)setData(current=>({...current,...status}));}).catch(e=>{if(alive&&e.name!=='AbortError')setError(e.message);});},1800);
    return()=>{alive=false;clearInterval(timer);controller.abort();};
  },[prepared.id]);
  async function copy(){try{await navigator.clipboard.writeText(data.code||'');setCopied(true);}catch{setError('Выделите код и скопируйте его вручную.');}}
  async function action(name:string,body:object={}){setBusy(true);setError('');try{const next=await api<Partial<PreparedExport>>('/exports/'+data.id+'/'+name,'POST',body);setData(current=>({...current,...next}));if(next.code){setCopied(false);setNewFrame(false);}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const pin=data.pinterest;
  const labels:Record<string,string>={prepared:'Готов к отправке',importing:'Импорт выполняется',imported:'Изображения и ссылки сверены',unknown:'Нужна сверка результата',conflict:'Нужна ручная проверка',error:'Операция не завершена',running:'Сохранение и сверка…',partial:'Сохранено частично',blocked:'Нужен вход или проверка Pinterest',succeeded:'Все пины сверены на доске'};
  return <Modal title="Отправка выбранного набора" onClose={onClose} wide><div className="form-stack">
    <p className="muted">Зафиксировано изображений: <strong>{data.count}</strong>{data.accountName?' · Pinterest @'+data.accountName:''}. Оба назначения используют этот набор.</p>
    <details className="export-preview"><summary>Посмотреть зафиксированные изображения ({data.count})</summary><div>{data.preview.map(p=><a key={p.pinId} href={p.pinUrl} target="_blank" rel="noreferrer"><img src={p.mediaUrl} alt="Выбранный референс"/><span>Открыть источник ↗</span></a>)}</div></details>
    {pin?<section className="export-target" aria-label="Экспорт Pinterest"><h3>Pinterest · секретная доска</h3><p><strong>{labels[pin.state]||pin.state}</strong> · подтверждено {pin.verified} из {pin.total}</p><p className="form-hint">Доска: {pin.boardName}</p>{pin.boardUrl?<a href={pin.boardUrl} target="_blank" rel="noreferrer">Открыть доску ↗</a>:<p className="form-hint">Доска будет создана при сохранении первого пина.</p>}<p className="form-hint">{pin.message}</p>
      {pin.unknown?<p className="form-error">Неопределённых результатов: {pin.unknown}. Эти пины автоматически повторно не записываются.</p>:null}
      <div className="export-actions">{pin.state==='running'?<button className="button secondary small" disabled={busy} onClick={()=>void action('pinterest-cancel')}>Остановить сохранение</button>:<>{pin.state!=='succeeded'?<button className="button primary small" disabled={busy} onClick={()=>void action('pinterest')}>{pin.state==='prepared'?'Сохранить в секретную доску':'Продолжить для неотправленных'}</button>:null}<button className="button secondary small" disabled={busy} onClick={()=>void action('pinterest-reconcile')}>Сверить доску</button></>}</div>
      {['unknown','error','partial'].includes(pin.state)?<details className="export-recovery"><summary>Указать адрес доски после сбоя</summary><p className="form-hint">Если доска создана, но её адрес не установлен, укажите существующую секретную доску этого аккаунта. Сначала проверим её владельца и секретность.</p><label>Имя доски<input value={boardName} onChange={e=>setBoardName(e.target.value)} maxLength={50}/></label><label>Адрес доски Pinterest<input value={boardUrl} onChange={e=>setBoardUrl(e.target.value)} placeholder="https://www.pinterest.com/ваш_аккаунт/доска/"/></label><button className="button secondary small" disabled={busy||!boardUrl.trim()} onClick={()=>void action('board',{name:boardName,url:boardUrl})}>Проверить и привязать доску</button></details>:null}
    </section>:null}
    <section className="export-target" aria-label="Экспорт Figma"><h3>Figma Design</h3><p><strong>{labels[data.state]||data.state}</strong></p>
      {data.state==='imported'?<p>{data.fileName} · фрейм {data.frameId}. Плагин подтвердил состав выбранного набора.</p>:<ol className="instructions"><li>Откройте нужный файл Figma Design.</li><li>Запустите <strong>Plugins → Development → PMA — локальная проба импорта</strong>.</li><li>Вставьте код, нажмите «Загрузить и сверить подборку», затем создайте или завершите фрейм.</li></ol>}
      {data.message?<p className="form-hint">{data.message}</p>:null}{data.verificationConflict?<p className="form-error">{data.verificationConflict} Подтверждение прежнего импорта сохранено.</p>:null}
      {data.figmaUnavailable?<p role="alert" className="form-error">Figma сейчас недоступна: {data.figmaUnavailable}. Код подключения не показан, чтобы плагин не обратился к чужой программе. Закройте программу, занявшую порт 8787, и перезапустите PMA.</p>:null}
      {data.code?<details className="export-recovery"><summary>Код подключения Figma</summary><div className="copy-row"><input aria-label="Код подключения Figma" readOnly value={data.code} onFocus={e=>e.target.select()}/><button className="button secondary small" onClick={copy}>{copied?<Check size={17}/>:<Copy size={17}/>} {copied?'Скопирован':'Копировать'}</button></div><p className="form-hint">Код действует 15 минут. Новый код открывает тот же снимок и не создаёт новую попытку импорта.</p><button className="text-button" disabled={busy} onClick={()=>void action('figma-code')}>Обновить код этого набора</button></details>:null}
      {data.state!=='importing'&&data.attempts<3?<details className="export-recovery"><summary>Отдельный новый импорт в Figma</summary><label className="new-frame-consent"><input type="checkbox" checked={newFrame} onChange={e=>setNewFrame(e.target.checked)}/>Существующий фрейм сохранится. Я хочу создать отдельный фрейм; он может дублировать этот набор.</label><button className="button secondary small" disabled={busy||!newFrame} onClick={()=>void action('figma-new-attempt',{acknowledgeNewFrame:true})}>Подготовить новую попытку Figma</button></details>:null}
    </section>
    {error?<p role="alert" className="form-error">{error}</p>:null}
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>Закрыть</button></div>
  </div></Modal>;
}
