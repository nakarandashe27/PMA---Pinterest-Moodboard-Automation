import {Activity,Folder,Plus,Plug,Sparkles} from 'lucide-react';
import {isDesktop} from '../api';
import type {Workspace} from '../types';
export default function Sidebar({workspace,projectId,onProject,onNew,onConnect,onAISettings,onDiagnostics}:{workspace:Workspace;projectId:string;onProject:(id:string)=>void;onNew:()=>void;onConnect:()=>void;onAISettings:()=>void;onDiagnostics:()=>void}){
  const connection=workspace.connections.find(c=>c.id===workspace.activeConnectionId);
  return <aside className="sidebar">
    <a href="/" className="wordmark" aria-label="PMA — главная">PMA</a>
    <div className="project-nav"><div className="sidebar-title"><h2>Проекты</h2><button className="icon-button outlined" aria-label="Новый проект" disabled={!workspace.activeConnectionId} onClick={onNew}><Plus size={18}/></button></div>
      <nav aria-label="Проекты">{workspace.projects.map(p=><button key={p.id} className={'project-item '+(p.id===projectId?'active':'')} onClick={()=>onProject(p.id)}>{p.name}</button>)}</nav>
      <select className="mobile-projects" aria-label="Выбрать проект" value={projectId} onChange={e=>onProject(e.target.value)}>{workspace.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <div className="sidebar-subtitle"><Folder size={18}/><span>Подборки</span></div>
    </div>
    {isDesktop?<button className="button tiny secondary" onClick={onDiagnostics}><Activity size={15}/> Состояние PMA</button>:null}
    {isDesktop&&workspace.activeConnectionId?<button className="button tiny secondary" onClick={onAISettings}><Sparkles size={15}/> Настройки AI</button>:null}
    <div className="connection-row"><span className={'status-dot '+(connection?.status==='ready'?'online':'')}/><div className="connection-info"><strong>Pinterest</strong><small>{connection?.username?'@'+connection.username:'Не подключён'}</small></div><button className="button tiny secondary" onClick={onConnect} aria-label="Управление подключением Pinterest">{connection?.status==='ready'?<Plug size={15}/>:<><Plug className="mobile-icon" size={15}/><span className="connection-label">Подключить</span></>}</button></div>
  </aside>;
}
