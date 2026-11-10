import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,Check,LoaderCircle} from 'lucide-react';
import Modal from './Modal';
import {api} from '../api';
import type {ReplacementMapping,Run} from '../types';
import {usageText} from '../usage';

export function ReplacementDialog({run,targetIds,onClose,onStarted}:{run:Run;targetIds:string[];onClose:()=>void;onStarted:(run:Run)=>void}){
  const [reason,setReason]=useState(''),[customQuery,setCustomQuery]=useState<string|null>(null),[aiEnabled,setAIEnabled]=useState(run.aiEnabled||false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const query=customQuery??[run.query,reason].filter(Boolean).join(' ').slice(0,1000);
  const targets=run.candidates.filter(c=>targetIds.includes(c.id));
  async function submit(event:FormEvent){
    event.preventDefault();setBusy(true);setError('');
    try{onStarted(await api<Run>('/runs/'+run.id+'/replacements','POST',{revision:run.revision,targetIds,reason,searchQuery:query,aiEnabled}));}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal title="Найти варианты замены" onClose={onClose} wide><form className="form-stack" onSubmit={submit}>
    <div className="replacement-targets">{targets.map(c=><figure key={c.id}><img src={c.mediaUrl} alt="Отмеченный для замены кадр"/><figcaption>Референс {run.candidates.findIndex(x=>x.id===c.id)+1}</figcaption></figure>)}</div>
    <label>Что изменить?<textarea required autoFocus rows={2} value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)} placeholder="Например, важна форма, но нужна древесина вместо бетона"/></label>
    <label>Запрос для Pinterest<input required value={query} maxLength={1000} onChange={e=>setCustomQuery(e.target.value)}/></label>
    <p className="form-hint">Уточните короткий поисковый запрос. Замены ищем текстовым поиском Pinterest. После поиска вы проверите варианты и укажете, какой кадр на что заменить.</p>
    <label className="ai-option"><input type="checkbox" checked={aiEnabled} onChange={e=>setAIEnabled(e.target.checked)}/><span><strong>AI-отбор вариантов замены</strong><small>Учитывает задание, исходные примеры, отмеченные кадры и причину. До 20 новых вариантов, один вызов AI, учитывается в месячном пределе.</small></span></label>
    <p className="form-hint">Создадим отдельную версию. Остальные кадры и выбор сохранятся. Для исходной подборки осталось попыток замены: {run.replacementAttemptsRemaining}.</p>
    {error?<p className="form-error" role="alert">{error}</p>:null}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="button primary" disabled={busy||!reason.trim()||!query.trim()}>{busy?<LoaderCircle className="spin" size={16}/>:null}Найти замены <ArrowRight size={16}/></button></div>
  </form></Modal>;
}

export function ReplacementReview({run,working,busy,onApply,onDiscard,onParent}:{run:Run;working:boolean;busy:boolean;onApply:(mappings:ReplacementMapping[])=>Promise<void>;onDiscard:()=>Promise<void>;onParent:()=>void}){
  const rep=run.replacement!;
  const [mapping,setMapping]=useState<Record<string,string>>({}),[active,setActive]=useState(rep.targetIds[0]),[showAll,setShowAll]=useState(false);
  const pending=['pending','review'].includes(rep.status),recommended=rep.ai?.recommendedIds||[],aiReady=rep.ai?.status==='ready';
  const options=showAll||!aiReady?rep.pool:recommended.map(id=>rep.pool.find(c=>c.id===id)!).filter(Boolean);
  const count=Object.keys(mapping).length,activeIndex=run.candidates.findIndex(c=>c.id===active)+1;
  // Opened from a scrolled grid: bring the review into view so the new versions are not off-screen.
  const ref=useRef<HTMLElement>(null);useEffect(()=>{ref.current?.scrollIntoView({block:'start',behavior:'smooth'});},[]);
  function choose(id:string){setMapping(current=>{const next={...current,[active]:id};for(const key of Object.keys(next))if(key!==active&&next[key]===id)delete next[key];return next;});}
  return <section ref={ref} className="replacement-review" aria-label="Варианты замены">
    <div className="replacement-heading"><h2>{rep.status==='applied'?'Замены применены':rep.status==='discarded'?'Сохранён исходный набор':'Просмотр вариантов замены'}</h2><button className="text-button" onClick={onParent}>К предыдущей версии</button></div>
    <p><strong>Что меняем:</strong> {rep.reason}</p><p className="form-hint">Запрос Pinterest: {rep.searchQuery}</p>
    {rep.ai?<details className="replacement-usage"><summary>Оценка вариантов и расход AI</summary><p>{rep.ai.interpretation||rep.ai.message||'Оценка выполняется…'}</p><p>Модель: {rep.ai.model||'не выбрана'}. Вызовов: {rep.ai.callCount||0}. {usageText(rep.ai.usage)}</p></details>:null}
    {pending&&!working?<>
      <p>Выберите отмеченное место, затем новый кадр для него. Неотмеченные и оставленные без замены изображения сохранятся.</p>
      <div className="replacement-targets">{rep.targetIds.map(id=>{const c=run.candidates.find(c=>c.id===id)!;return <div className="replacement-target" key={id}><button className={active===id?'active':''} aria-pressed={active===id} aria-label={'Выбрать место референса '+(run.candidates.indexOf(c)+1)} onClick={()=>setActive(id)}><img src={c.mediaUrl} alt="Исходный кадр"/><span>Референс {run.candidates.indexOf(c)+1}</span><small>{mapping[id]?'Вариант '+(rep.pool.findIndex(x=>x.id===mapping[id])+1):'Без замены'}</small></button>{mapping[id]?<button className="text-button" onClick={()=>setMapping(current=>{const next={...current};delete next[id];return next;})}>Снять замену</button>:null}</div>;})}</div>
      {rep.pool.length?<>
        {rep.ai&&!aiReady?<p className="form-error">AI-отбор не завершён. {rep.ai.message} Можно выбрать из всех загруженных вариантов вручную.</p>:null}
        {aiReady?<div className="replacement-filters"><button className={'button small '+(!showAll?'primary':'secondary')} onClick={()=>setShowAll(false)}>AI предлагает {recommended.length}</button><button className={'button small '+(showAll?'primary':'secondary')} onClick={()=>setShowAll(true)}>Все варианты {rep.pool.length}</button></div>:null}
        <p className="replacement-active" role="status">Выбираем замену для референса {activeIndex}</p>
        {!options.length?<p>AI не нашёл подходящих рекомендаций. Посмотрите все варианты или оставьте исходный набор.</p>:null}
        <div className="replacement-options">{options.map(c=>{const assigned=Object.keys(mapping).find(id=>mapping[id]===c.id),number=rep.pool.findIndex(x=>x.id===c.id)+1;return <article key={c.id} className={assigned?'assigned':''}><button className="replacement-option" aria-label={'Выбрать вариант замены '+number} aria-pressed={!!assigned} disabled={busy} onClick={()=>choose(c.id)}><img src={c.mediaUrl} alt={c.altText||'Вариант замены '+number}/><strong>Вариант {number} {assigned?<Check size={15}/>:null}</strong>{assigned?<small>Для референса {run.candidates.findIndex(x=>x.id===assigned)+1}</small>:null}</button>{c.ai?<p>{c.ai.reason}</p>:null}<a href={c.pinUrl} target="_blank" rel="noreferrer">Открыть пин ↗</a></article>;})}</div>
      </>:<p>Новых вариантов пока нет. Можно оставить исходный набор и изменить запрос в новой попытке.</p>}
      <div className="replacement-actions"><button className="button secondary" disabled={busy} onClick={()=>void onDiscard()}>Оставить исходный набор</button><button className="button primary" disabled={busy||!count} onClick={()=>void onApply(rep.targetIds.filter(id=>mapping[id]).map(from=>({from,to:mapping[from]})))}>Применить замены ({count})</button></div>
    </>:null}
    {rep.status==='applied'?<p>Заменено {rep.appliedMappings?.length||0} из {rep.targetIds.length} отмеченных кадров. Порядок остальных и ручной выбор сохранены.</p>:null}
    {working?<p className="form-hint">Ищем варианты. Исходный набор этой версии сохраняется до вашего решения.</p>:null}
  </section>;
}
