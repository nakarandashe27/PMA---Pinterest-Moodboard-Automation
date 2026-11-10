import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,LoaderCircle,Pencil,Plus,Square} from 'lucide-react';
import {api,setToken,sessionChannelId} from './api';
import type {PreparedExport,Project,ProjectData,ReplacementMapping,Run,Workspace} from './types';
import Sidebar from './components/Sidebar';
import ReferenceGrid from './components/ReferenceGrid';
import AISummary from './components/AISummary';
import {ReplacementDialog,ReplacementReview} from './components/Replacement';
import {BriefDialog,ConnectionDialog,ExportDialog,ProjectDialog} from './components/Dialogs';
import AISettings from './components/AISettings';
import Diagnostics from './components/Diagnostics';

const working=new Set(['queued','searching','downloading','ranking']);
const formatDate=(value:string)=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'Europe/Moscow'}).format(new Date(value));
const formatHistory=(value:string)=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(value));
export default function App(){
  const [workspace,setWorkspace]=useState<Workspace|null>(null),[projectId,setProjectId]=useState(''),[data,setData]=useState<ProjectData|null>(null),[runId,setRunId]=useState('');
  const [selection,setSelection]=useState<string[]>([]),[tab,setTab]=useState<'all'|'selected'|'recommended'>('recommended'),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const [aiSettingsOpen,setAISettingsOpen]=useState(false),[diagnosticsOpen,setDiagnosticsOpen]=useState(false);
  const [newProject,setNewProject]=useState(false),[brief,setBrief]=useState<'new'|'edit'|null>(null),[connectionOpen,setConnectionOpen]=useState(false),[exportData,setExportData]=useState<PreparedExport|null>(null),[saving,setSaving]=useState(false);
  const [replacementIds,setReplacementIds]=useState<string[]>([]),[replacementOpen,setReplacementOpen]=useState(false);
  const projectRef=useRef(projectId);projectRef.current=projectId;
  const run=data?.runs.find(r=>r.id===runId)||data?.runs[0];
  const runRef=useRef(run?.id);runRef.current=run?.id;
  const isWorking=!!run&&working.has(run.status);
  const anyWorking=!!data?.runs.some(r=>working.has(r.status));
  const replacementPending=!!run?.replacement&&['pending','review'].includes(run.replacement.status);
  const canReplace=run?.sourceKind==='live'&&run.status==='ready'&&!replacementPending&&run.replacementAttemptsRemaining>0;
  const dirty=!!run&&[...selection].sort().join(',')!==[...run.selectedIds].sort().join(',');
  const connected=workspace?.connections.some(c=>c.id===workspace.activeConnectionId&&c.status==='ready')||false;
  const refreshWorkspace=useCallback(async()=>{
    const next=await api<Workspace>('/bootstrap');setToken(next.token);setWorkspace(next);
    if(!next.projects.some(p=>p.id===projectRef.current)){setProjectId(next.projects[0]?.id||'');setData(null);setBrief(null);}
    return next;
  },[]);
  useEffect(()=>{const controller=new AbortController();api<Workspace>('/bootstrap','GET',undefined,controller.signal).then(next=>{setToken(next.token);setWorkspace(next);setProjectId(next.projects[0]?.id||'');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[]);
  useEffect(()=>{
    if(!projectId){setData(null);return;}
    const controller=new AbortController();setData(null);setError('');setTab('all');
    api<ProjectData>('/projects/'+projectId,'GET',undefined,controller.signal).then(next=>{setData(next);setRunId(next.runs[0]?.id||'');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});
    return()=>controller.abort();
  },[projectId]);
  useEffect(()=>{setSelection(run?.selectedIds||[]);setTab('recommended');setReplacementIds([]);setReplacementOpen(false);},[run?.id]);
  useEffect(()=>{
    if(!anyWorking||!projectId)return;
    const controller=new AbortController();
    const timer=setInterval(()=>api<ProjectData>('/projects/'+projectId,'GET',undefined,controller.signal).then(next=>{if(next.project.id===projectRef.current)setData(next);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);}),1400);
    return()=>{clearInterval(timer);controller.abort();};
  },[projectId,anyWorking]);
  useEffect(()=>{if(!feedback)return;const timer=setTimeout(()=>setFeedback(''),5000);return()=>clearTimeout(timer);},[feedback]);
  const toggle=useCallback((id:string)=>setSelection(current=>current.includes(id)?current.filter(x=>x!==id):current.length<25?[...current,id]:current),[]);
  const toggleReplacement=useCallback((id:string)=>setReplacementIds(current=>current.includes(id)?current.filter(x=>x!==id):current.length<5?[...current,id]:current),[]);
  async function saveSelection(){
    if(!run)return;setSaving(true);setError('');
    try{
      const updated=await api<Run>('/runs/'+run.id+'/selection','PUT',{ids:selection,revision:run.revision});
      setData(current=>current?{...current,runs:current.runs.map(r=>r.id===updated.id?updated:r)}:current);
      setFeedback('Выбор сохранён');
      return updated;
    }catch(e){setError((e as Error).message);throw e;}finally{setSaving(false);}
  }
  async function prepareFigma(){
    if(!run)return;
    try{await saveSelection();setSaving(true);setExportData(await api<PreparedExport>('/runs/'+run.id+'/export','POST',{}));}
    catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  async function createdProject(p:Project){await refreshWorkspace();setNewProject(false);setProjectId(p.id);setBrief('new');}
  function startedRun(next:Run){if(projectRef.current!==next.projectId)return;setData(current=>current?{...current,runs:[next,...current.runs]}:current);setRunId(next.id);setBrief(null);setReplacementOpen(false);setError('');}
  async function openReplacement(){try{if(dirty)await saveSelection();setReplacementOpen(true);}catch{/* The save error is already shown. */}}
  async function resolveReplacement(mappings?:ReplacementMapping[]){
    if(!run)return;setError('');setSaving(true);
    try{
      const latest=dirty?await saveSelection():run;
      setSaving(true);
      const next=await api<Run>('/runs/'+run.id+'/replacements/'+(mappings?'apply':'discard'),'POST',{revision:latest?.revision??run.revision,...(mappings?{mappings}:{})});
      setData(current=>current?{...current,runs:current.runs.map(r=>r.id===next.id?next:r)}:current);if(runRef.current===next.id){setSelection(next.selectedIds);setReplacementIds([]);setFeedback(mappings?'Замены применены':'Исходный набор сохранён');}
    }catch(e){setError((e as Error).message);const fresh=await api<ProjectData>('/projects/'+run.projectId).catch(()=>null);if(fresh&&projectRef.current===run.projectId){setData(fresh);if(runRef.current===run.id)setSelection(fresh.runs.find(r=>r.id===run.id)?.selectedIds||[]);}}
    finally{setSaving(false);}
  }
  async function cancel(){if(!run)return;try{await api('/runs/'+run.id+'/cancel','POST',{});setFeedback('Отменяем поиск…');}catch(e){setError((e as Error).message);}}
  async function openPinterest(){if(!run)return;setSaving(true);try{await api('/runs/'+run.id+'/open-pinterest','POST',{});setFeedback('Открыт браузер Pinterest этого аккаунта');}catch(e){setError((e as Error).message);}finally{setSaving(false);}}
  async function resume(){
    if(!run)return;setSaving(true);setError('');
    try{const next=await api<Run>('/runs/'+run.id+'/resume','POST',{});setData(current=>current?{...current,runs:current.runs.map(r=>r.id===next.id?next:r)}:current);}
    catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  async function connectionChanged(){setData(null);setProjectId('');setRunId('');setSelection([]);setBrief(null);setNewProject(false);setExportData(null);setReplacementOpen(false);await refreshWorkspace();setFeedback('Подключение обновлено');}
  useEffect(()=>{
    const reload=()=>window.location.reload(),channel=new BroadcastChannel('pma-session');channel.onmessage=event=>{if(event.data?.source!==sessionChannelId)reload();};
    window.addEventListener('pma-locked',reload);
    const timer=workspace?.sessionExpiresAt?setTimeout(reload,Math.max(0,workspace.sessionExpiresAt-Date.now()+50)):undefined;
    return()=>{channel.close();window.removeEventListener('pma-locked',reload);if(timer)clearTimeout(timer);};
  },[workspace?.sessionExpiresAt]);
  if(!workspace)return <div className="app-loading"><span className="wordmark">PMA</span>{error?<><p role="alert">{error}</p><button className="button secondary" onClick={()=>window.location.reload()}>Повторить</button></>:<p><LoaderCircle size={18} className="spin"/> Открываем мастерскую…</p>}</div>;
  const candidates=run?.candidates||[];
  const hasRanking=run?.ai?.status==='ready';
  const recommended=run?.ai?.recommendedIds||[];
  const currentTab=tab==='recommended'&&!hasRanking?'all':tab;
  const visible=currentTab==='selected'?candidates.filter(c=>selection.includes(c.id)):currentTab==='recommended'?candidates.filter(c=>recommended.includes(c.id)).sort((a,b)=>recommended.indexOf(a.id)-recommended.indexOf(b.id)):candidates;
  const evaluation=data?.evaluations?.find(e=>run&&e.sourceRunIds.includes(run.id));
  return <div className="app-shell">
    <Sidebar workspace={workspace} projectId={projectId} onProject={id=>{setProjectId(id);setSelection([]);}} onNew={()=>setNewProject(true)} onConnect={()=>setConnectionOpen(true)} onAISettings={()=>setAISettingsOpen(true)} onDiagnostics={()=>setDiagnosticsOpen(true)}/>
    <main className="workspace">
      <div className="workspace-top"><div className="breadcrumb"><span>Проекты</span><span>/</span><strong>{data?.project.name||'Новый проект'}</strong></div><span className={'save-status '+(dirty?'unsaved':'')}>{dirty?'Есть несохранённый выбор':'Сохранено на этом ПК'}</span></div>
      <header className="project-header"><div><h1>{run?.title||data?.project.name||'Ваши проекты'}</h1><div className="subtitle">{run?run.sourceKind==='technical'?'Техническая подборка · 2 ноября':'Подборка · '+formatDate(run.createdAt):'Начните с задания для новой подборки'}</div></div><button className="button secondary" onClick={()=>setBrief('new')} disabled={!projectId||anyWorking}><span className="mobile-icon"><Plus size={17}/></span>Новое задание</button></header>
      {data&&data.runs.length>1?<label className="history-select">История подборок<select aria-label="История подборок" value={run?.id||''} onChange={e=>setRunId(e.target.value)}>{data.runs.map(r=><option key={r.id} value={r.id}>{r.title} · {r.sourceKind==='technical'?'G1':formatHistory(r.createdAt)}{r.aiEnabled?' · AI':''}</option>)}</select></label>:null}
      {run?<div className="brief-summary"><span className="brief-label">Задание</span><p>{run.query}</p><button className="text-button" aria-label="Изменить задание" onClick={()=>setBrief('edit')} disabled={isWorking}><Pencil size={17}/><span>Изменить</span></button></div>:null}
      {run?.briefPreparation?<div className="brief-preparation"><strong>{run.briefPreparation.method==='direct'?'Готовая ссылка Pinterest':'Как понят замысел'}</strong>{run.briefPreparation.summary&&!run.title.startsWith(run.briefPreparation.summary.slice(0,40))?<p>{run.briefPreparation.summary}</p>:null}<p><b>{run.mode==='image'?'Текстовое дополнение к Lens':'Поисковый запрос'}:</b> {run.interpretation}</p></div>:null}
      {run?.sourceKind==='live'?<div className="search-method"><strong>{run.replacement?'Основа исходной подборки: ':'Основа поиска: '}{run.mode==='image'?'фото · Pinterest Lens':'текст или ссылка на пин'}{run.aiEnabled?' + AI-отбор':''}</strong>{run.mode==='image'&&run.uploads[0]?<><div className="search-seed"><img src={run.uploads[0].url} alt="Исходное фото для поиска"/><span>{run.uploads[0].name}</span></div>{run.searchEvidence?.strategy==='pinterest-lens'?<p>{run.aiEnabled?'Фото передано в Lens. AI-отбор учитывает текст задания и приложенные примеры.':'Фото передано в Pinterest Lens. Текстовые уточнения в визуальном поиске пока не применяются.'}</p>:null}</>:run.uploads.length>0?<p>{run.aiEnabled?'Приложенные фото используются AI при отборе кандидатов текстового поиска.':'В этом запуске фотографии не использовались. Вы можете создать новое задание с поиском через Lens.'}</p>:null}</div>:null}
      {evaluation?<p className="results-note">Готова проверка AI-отбора: по фото и тексту отобрано {evaluation.selectedCounts.photoText} из {evaluation.candidateCount}. <a href={'/evaluations/'+evaluation.id} target="_blank" rel="noreferrer">Открыть сравнение</a></p>:null}
      {error?<div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={()=>setError('')}>Закрыть</button></div>:null}
      {run?.replacement?<ReplacementReview key={run.id} run={run} working={isWorking} busy={saving} onApply={resolveReplacement} onDiscard={()=>resolveReplacement()} onParent={()=>setRunId(run.replacement!.parentRunId)}/>:null}
      {run?<AISummary run={run}/>:null}
      {run?.searchWarning?<p className="results-note">{run.searchWarning}</p>:null}
      {isWorking?<div className="search-progress" role="status"><LoaderCircle className="spin" size={18}/><span>{run?.message}</span><button className="text-button" onClick={cancel}><Square size={13}/>Отменить</button></div>:run&&['blocked','interrupted'].includes(run.status)?<div className="error-banner access-pause" role="status"><div><p>{run.message}</p><p className="pause-detail">{run.savedPinCount?`Сохранены ссылки на ${run.savedPinCount} пинов. После продолжения загрузим изображения.`:run.candidates.length?'Загруженные изображения и ваш выбор сохранены.':'Поиск продолжится по тому же заданию.'}</p><p className="pause-detail">Откройте Pinterest. Если он просит проверку или вход, пройдите их вручную, затем продолжите поиск.</p></div><div className="pause-actions"><button className="button secondary" disabled={saving} onClick={openPinterest}>Открыть Pinterest</button><button className="button primary" disabled={saving} onClick={resume}>Продолжить поиск</button></div></div>:run&&['error','cancelled'].includes(run.status)?<div className="error-banner" role="status">{run.message}</div>:run?.sourceKind==='live'&&!(run.aiEnabled&&run.ai?.status==='ready')?<p className="results-note">{run.message}</p>:null}
      {run?<><div className="collection-toolbar"><div className="collection-tabs" role="tablist" aria-label="Изображения">{hasRanking?<button role="tab" aria-selected={currentTab==='recommended'} className={currentTab==='recommended'?'active':''} onClick={()=>setTab('recommended')}>AI-отбор {recommended.length}</button>:null}<button role="tab" aria-selected={currentTab==='all'} className={currentTab==='all'?'active':''} onClick={()=>setTab('all')}>Все {candidates.length}</button><button role="tab" aria-selected={currentTab==='selected'} className={currentTab==='selected'?'active':''} onClick={()=>setTab('selected')}>Выбранные {selection.length}</button></div><button className="text-button clear-selection" disabled={!selection.length} onClick={()=>setSelection([])}>Снять выбор</button></div>
      {canReplace?<div className="replacement-toolbar"><p>{replacementIds.length?'К замене отмечено: '+replacementIds.length+' из 5. Остальные кадры сохранятся.':'Для точечной замены отметьте до пяти кадров кнопкой под изображением.'}</p><button className="button secondary small" disabled={!replacementIds.length||saving||anyWorking} onClick={()=>void openReplacement()}>Найти замены ({replacementIds.length})</button></div>:null}
      {currentTab==='recommended'&&!visible.length?<div className="grid-empty"><h2>Подходящих рекомендаций пока нет</h2><p>Откройте «Все», чтобы посмотреть найденные изображения, или уточните задание.</p></div>:<ReferenceGrid candidates={visible} allCandidates={candidates} selectedIds={selection} onToggle={toggle} replacementIds={replacementIds} canReplace={canReplace&&!anyWorking} onReplace={toggleReplacement}/>}</>:<div className="empty-project"><div className="empty-symbol"><Plus size={30}/></div><h2>Начнём с того, что ищем</h2><p>Опишите пространство, формы или материалы.<br/>При необходимости добавьте изображения-примеры.</p><button className="button primary" onClick={()=>!workspace.activeConnectionId?setConnectionOpen(true):projectId?setBrief('new'):setNewProject(true)}>{!workspace.activeConnectionId?'Открыть своё подключение':projectId?'Новое задание':'Создать проект'}<ArrowRight size={17}/></button></div>}
    </main>
    {run?<div className="selection-bar"><strong>Выбрано {selection.length} из 25</strong><div><button className="button secondary" disabled={saving||!dirty} onClick={()=>void saveSelection().catch(()=>{})}>{saving?<LoaderCircle size={17} className="spin"/>:null}Сохранить выбор</button><button className="button primary" disabled={saving||isWorking||replacementPending||!selection.length} onClick={prepareFigma}>Экспорт выбранного <ArrowRight size={18}/></button></div></div>:null}
    {feedback?<div className="toast" role="status"><Check size={17}/>{feedback}</div>:null}
    {newProject&&workspace.activeConnectionId?<ProjectDialog onClose={()=>setNewProject(false)} onCreated={createdProject}/>:null}
    {brief&&projectId?<BriefDialog key={projectId+'-'+brief+'-'+(brief==='edit'?run?.id:'new')} projectId={projectId} initial={brief==='edit'?run:undefined} onClose={()=>setBrief(null)} onStarted={startedRun} connected={connected} onConnect={()=>setConnectionOpen(true)}/>:null}
    {replacementOpen&&run?<ReplacementDialog run={run} targetIds={replacementIds} onClose={()=>setReplacementOpen(false)} onStarted={startedRun}/>:null}
    {exportData?<ExportDialog prepared={exportData} onClose={()=>setExportData(null)}/>:null}
    {diagnosticsOpen?<Diagnostics onClose={()=>setDiagnosticsOpen(false)}/>:null}
    {aiSettingsOpen?<AISettings onClose={()=>setAISettingsOpen(false)}/>:null}
    {connectionOpen?<ConnectionDialog workspace={workspace} onClose={()=>setConnectionOpen(false)} onConnected={connectionChanged}/>:null}
  </div>;
}
