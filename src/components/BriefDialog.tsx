import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,ImagePlus,LoaderCircle,Trash2} from 'lucide-react';
import Modal from './Modal';
import {api} from '../api';
import type {BriefPreparation,Run,Upload} from '../types';

const active=new Set(['queued','preparing','running']);
export default function BriefDialog({projectId,initial,onClose,onStarted,connected,onConnect}:{projectId:string;initial?:Run;onClose:()=>void;onStarted:(run:Run)=>void;connected:boolean;onConnect:()=>void}){
  const [query,setQuery]=useState(initial?.query||''),[notes,setNotes]=useState(initial?.notes||''),[mode,setMode]=useState<'text'|'image'>(initial?.mode||'text'),[modeChosen,setModeChosen]=useState(!!initial);
  const [entryKind,setEntryKind]=useState<'vision'|'ready'>(initial?.entryKind||(initial?'ready':'vision')),[aiEnabled,setAIEnabled]=useState(initial?.aiEnabled||false),[uploads,setUploads]=useState<Upload[]>(initial?.uploads||[]);
  const [interpretation,setInterpretation]=useState(initial?.interpretation||''),[step,setStep]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[answer,setAnswer]=useState(initial?.clarificationAnswer||'');
  const [preparation,setPreparation]=useState<BriefPreparation|null>(null),[preparedKey,setPreparedKey]=useState('');
  const [saved,setSaved]=useState<BriefPreparation[]>([]);
  const mounted=useRef(true),pending=useRef<BriefPreparation|null>(null);
  const input={projectId,query,notes,mode,uploadIds:uploads.map(u=>u.id),answer},key=JSON.stringify(input),keyRef=useRef(key);keyRef.current=key;pending.current=preparation;
  const preparing=!!preparation&&active.has(preparation.status),working=busy||preparing,needsAI=entryKind==='vision'&&(mode==='text'||aiEnabled),current=preparedKey===key;
  const result=current?preparation?.result:null,question=preparation?.result?.clarification||'';
  function invalidate(){setPreparation(null);setPreparedKey('');setAnswer('');setInterpretation('');setError('');}
  function accept(next:BriefPreparation,requestKey:string){
    if(!mounted.current||keyRef.current!==requestKey){if(active.has(next.status))void api('/interpretations/'+next.id+'/cancel','POST',{}).catch(()=>{});return;}
    setPreparation(next);if(next.status==='ready'&&next.result)setInterpretation(next.result.searchQuery);
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const p=pending.current;if(p&&active.has(p.status))void api('/interpretations/'+p.id+'/cancel','POST',{}).catch(()=>{});};},[]);
  useEffect(()=>{if(initial)return;const controller=new AbortController();api<BriefPreparation[]>('/projects/'+projectId+'/interpretations','GET',undefined,controller.signal).then(setSaved).catch(()=>{});return()=>controller.abort();},[projectId,initial]);
  useEffect(()=>{
    if(!preparation||!active.has(preparation.status))return;
    const controller=new AbortController(),id=preparation.id,requestKey=preparedKey;
    const timer=setInterval(()=>{api<BriefPreparation>('/interpretations/'+id,'GET',undefined,controller.signal).then(next=>accept(next,requestKey)).catch(e=>{if(e.name!=='AbortError')setError(e.message);});},800);
    return()=>{clearInterval(timer);controller.abort();};
  },[preparation?.id,preparation?.status,preparedKey]);
  async function prepare(){
    setBusy(true);setError('');const requestKey=keyRef.current;setPreparedKey(requestKey);
    try{const next=await api<BriefPreparation>('/interpretations','POST',input);accept(next,requestKey);}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}
  }
  async function upload(files:FileList|null){
    if(!files)return;setBusy(true);setError('');
    try{
      if(files.length+uploads.length>3)throw Error('Добавьте не больше трёх примеров');const next:Upload[]=[];
      for(const file of Array.from(files)){
        if(file.size>8*1024*1024)throw Error('Каждое изображение должно быть не больше 8 МБ');
        const imageBase64=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error('Не удалось прочитать файл'));r.readAsDataURL(file);});
        next.push(await api<Upload>('/uploads','POST',{projectId,name:file.name,imageBase64,notes:''}));
      }
      invalidate();setUploads(all=>[...all,...next]);if(next.length&&!uploads.length&&!modeChosen)setMode('image');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function review(event:FormEvent){
    event.preventDefault();setError('');if(mode==='image'&&!uploads.length){setError('Добавьте пример для поиска по изображению');return;}
    setStep(1);if(needsAI){if(!(current&&preparation?.status==='ready'))await prepare();}else setInterpretation(query.trim());
  }
  async function cancelPreparation(){if(!preparation)return;setError('');try{await api('/interpretations/'+preparation.id+'/cancel','POST',{});}catch(e){setError((e as Error).message);}}
  function manual(){setEntryKind('ready');setInterpretation(preparation?.result?.searchQuery||query.trim());setPreparation(null);setPreparedKey('');setAnswer('');setError('');}
  function restore(record:BriefPreparation){
    const i=record.input;setQuery(i.query);setNotes(i.notes);setMode(i.mode);setModeChosen(true);setAnswer(i.answer);setEntryKind('vision');setError('');
    setUploads(i.uploadIds.map((id,index)=>({id,name:'Сохранённый пример '+(index+1),notes:'',url:'/media/uploads/'+id})));
    setPreparedKey(JSON.stringify({projectId,query:i.query,notes:i.notes,mode:i.mode,uploadIds:i.uploadIds,answer:i.answer}));setPreparation(record);setInterpretation(record.result?.searchQuery||i.query);setStep(1);
  }
  async function launch(){
    setBusy(true);setError('');
    try{onStarted(await api<Run>('/runs','POST',{...input,entryKind,interpretation,aiEnabled,...(needsAI&&current&&preparation?.status==='ready'?{briefInterpretationId:preparation.id}:{})}));}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const canLaunch=!working&&connected&&!!interpretation.trim()&&(!needsAI||current&&preparation?.status==='ready'&&!question);
  return <Modal title={step?'Проверьте направление поиска':'Новое задание'} onClose={onClose} wide><form onSubmit={review} className="form-stack">
    {step===0?<>
      {saved.length?<details className="saved-interpretations"><summary>Сохранённые описания</summary><div>{saved.map(record=><button type="button" key={record.id} onClick={()=>restore(record)}>{record.input.query.slice(0,120)}<small>{record.status==='ready'?'Формулировка готова':active.has(record.status)?'Подготовка выполняется':'Описание сохранено'}</small></button>)}</div></details>:null}
      <fieldset className="search-mode"><legend>Как подготовить запрос</legend><label><input type="radio" name="entry-kind" checked={entryKind==='vision'} onChange={()=>{invalidate();setEntryKind('vision');}}/>Опишу замысел</label><label><input type="radio" name="entry-kind" checked={entryKind==='ready'} onChange={()=>{invalidate();setEntryKind('ready');}}/>У меня готов запрос</label></fieldset>
      <label>{entryKind==='vision'?'Опишите, что хотите увидеть':'Поисковый запрос или ссылка на пин'}<textarea aria-label={entryKind==='vision'?'Опишите, что хотите увидеть':'Поисковый запрос или ссылка на пин'} autoFocus required rows={4} value={query} onChange={e=>{invalidate();setQuery(e.target.value);}} maxLength={1000} placeholder={entryKind==='vision'?'Например: хочу тихий камерный двор, много зелени и ощущение уединения, без парадности':'Например, бионические деревянные скамьи'}/></label>
      <fieldset className="search-mode"><legend>Основа поиска</legend><label><input type="radio" name="source-mode" checked={mode==='text'} onChange={()=>{invalidate();setMode('text');setModeChosen(true);}}/>Текст или ссылка на пин</label><label><input type="radio" name="source-mode" checked={mode==='image'} onChange={()=>{invalidate();setMode('image');setModeChosen(true);}}/>Первое изображение · Pinterest Lens</label></fieldset>
      <div><span className="field-title">Ваши примеры <small>до 3 изображений, JPG / PNG / WebP, до 8 МБ</small></span><div className="upload-row">
        {uploads.map(u=><div className="upload-preview" key={u.id}><img src={u.url} alt={u.name}/><button type="button" aria-label={'Удалить пример '+u.name} onClick={()=>{invalidate();setUploads(all=>all.filter(x=>x.id!==u.id));}}><Trash2 size={14}/></button></div>)}
        {uploads.length<3?<label className="upload-button"><ImagePlus size={22}/><span>{busy?'Загрузка…':'Добавить пример'}</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={working} onChange={e=>{void upload(e.target.files);e.target.value='';}}/></label>:null}
      </div></div>
      <label>Что важно в примерах?<textarea aria-label="Что важно в примерах?" rows={2} value={notes} onChange={e=>{invalidate();setNotes(e.target.value);}} maxLength={2000} placeholder="Здесь нравится форма; материал не важен"/></label>
      <p className="form-hint">{needsAI?'AI предложит короткую поисковую формулировку по вашему описанию и пояснению. Это один AI-запуск; поиск начнётся после подтверждения. Фото на этом шаге не анализируются.':mode==='image'?'Первое фото пойдёт напрямую в Pinterest Lens. Описание сохранится рядом; подготовка текста через AI не требуется.':'Готовый запрос пойдёт напрямую в Pinterest. Подготовка через AI не требуется.'}</p>
      <label className="ai-option"><input type="checkbox" checked={aiEnabled} onChange={e=>setAIEnabled(e.target.checked)}/><span><strong>AI-отбор найденных изображений</strong><small>Отдельный необязательный шаг: до 50 кандидатов, один дополнительный вызов AI, учитывается в месячном пределе. Все исходные изображения сохраняются.</small></span></label>
      {mode==='image'&&aiEnabled?<p className="form-hint">Lens использует первое фото. Его выдачу дополняем текстовым поиском; затем AI сравнивает кандидатов с описанием и примерами.</p>:null}
      {uploads.length>0&&mode==='text'?<p className="form-notice">{aiEnabled?'Фото будут использованы AI при отборе, после текстового поиска.':'Фото сохранятся с заданием. Для визуального поиска выберите Pinterest Lens.'}</p>:null}
    </>:<>
      {working?<div className="interpretation-progress" role="status"><LoaderCircle className="spin" size={18}/><span>Готовим поисковую формулировку. Сам поиск ещё не запущен.</span></div>:null}
      {preparing?<button type="button" className="text-button" onClick={()=>void cancelPreparation()}>Остановить подготовку</button>:null}
      {result?<section className="interpretation-result" aria-label="Подготовка поиска"><strong>{preparation?.method==='direct'?'Готовая ссылка — AI не потребовался':'Как понят замысел'}</strong><p>{result.summary}</p>
        {result.features.length?<p><b>Важно:</b> {result.features.join(' · ')}</p>:null}{result.avoid.length?<p><b>Избегаем:</b> {result.avoid.join(' · ')}</p>:null}
        {result.assumptions.length?<div className="interpretation-assumptions"><b>Предположения — проверьте:</b>{result.assumptions.map((s,i)=><p key={i}>{s}</p>)}</div>:null}
      </section>:null}
      {question?<div className="instruction-panel"><label>{question}<textarea aria-label={question} value={answer} onChange={e=>setAnswer(e.target.value)} rows={2} maxLength={500} disabled={working}/></label><button type="button" className="button secondary" disabled={working||!answer.trim()} onClick={()=>void prepare()}>Учесть ответ</button><p className="form-hint">Уточнение изменит версию задания и использует ещё один AI-запуск.</p></div>:null}
      {preparation&&!active.has(preparation.status)&&preparation.status!=='ready'?<p className="form-error" role="alert">{preparation.message}</p>:null}
      {needsAI&&!working&&(!preparation||!preparation.callCount)&&(!current||preparation?.status!=='ready')&&!question?<button type="button" className="button secondary" onClick={()=>void prepare()}>Подготовить запрос</button>:null}
      {needsAI&&!working?<button type="button" className="text-button" onClick={manual}>Задать запрос вручную</button>:null}
      {mode==='image'&&!aiEnabled?<div><strong>Ваше задание</strong><p>{query}</p><p className="form-hint">Pinterest Lens ищет по первому фото. Текст сохраняется рядом и не заменяет визуальный поиск.</p></div>:!needsAI||result&&!question?<label>{mode==='image'?'Текстовое дополнение к Lens':'Поисковый запрос'}<textarea aria-label={mode==='image'?'Текстовое дополнение к Lens':'Поисковый запрос'} autoFocus rows={3} value={interpretation} onChange={e=>setInterpretation(e.target.value)} maxLength={1000}/></label>:null}
      {result?.alternatives.length&&!question?<div className="interpretation-alternatives"><span className="form-hint">Другие формулировки</span>{result.alternatives.map(q=><button type="button" className="button secondary small" key={q} onClick={()=>setInterpretation(q)}>{q}</button>)}</div>:null}
      <div className="instruction-panel"><strong>{mode==='image'?'Первичный поиск — Pinterest Lens':'Поиск в Pinterest по подтверждённому запросу'}</strong><p>{aiEnabled?'До 50 кандидатов и отдельный AI-отбор по исходному описанию и примерам. Окончательный выбор — за вами.':'Целевой черновик — до 25 изображений. При недоборе сохраним найденное.'}</p></div>
      {mode==='image'&&uploads[0]?<div className="search-seed"><img src={uploads[0].url} alt="Исходное фото для Pinterest Lens"/><span>{uploads[0].name}</span></div>:null}
      {!connected?<div className="connection-prompt"><p>Для запуска подключите Pinterest.</p><button type="button" className="button secondary" onClick={onConnect}>Подключить Pinterest</button></div>:null}
    </>}
    {error?<p role="alert" className="form-error">{error}</p>:null}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={working} onClick={()=>step?setStep(0):onClose()}>{step?'Назад':'Отмена'}</button>{step?<button type="button" className="button primary" disabled={!canLaunch} onClick={()=>void launch()}>Запустить поиск <ArrowRight size={17}/></button>:<button className="button primary" disabled={working||!query.trim()}>{needsAI?'Подготовить поиск':'Проверить запрос'} <ArrowRight size={17}/></button>}</div>
  </form></Modal>;
}
