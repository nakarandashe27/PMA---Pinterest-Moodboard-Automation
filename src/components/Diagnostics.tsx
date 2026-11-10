import {useEffect,useState} from 'react';
import Modal from './Modal';
import {api,reveal} from '../api';

type Status={app:{version:string;electron:string|null;os:string;arch:string};data:{schema:number;ledger:{available:boolean}|null};
  figma:{bridge:'listening'|'unavailable';reason:string|null;protocol:number;pluginFolderReady:boolean};session:{unlocked:boolean};
  ai:{configured:boolean;enabled:boolean;keyConfigured:boolean;verified:boolean;blocked:boolean}|null};

// Minimal self-service status: what works, where the Figma plugin is, and a safe report on request.
export default function Diagnostics({onClose}:{onClose:()=>void}){
  const [status,setStatus]=useState<Status|null>(null),[note,setNote]=useState(''),[error,setError]=useState('');
  useEffect(()=>{api<Status>('/diagnostics').then(setStatus).catch(e=>setError((e as Error).message));},[]);
  async function report(){setError('');try{const r=await api<{file:string}>('/diagnostics/report','POST',{});setNote('Отчёт сохранён: '+r.file+'. В нём нет проектов, картинок, ключей и адресов. Передайте его сами, если нужна помощь.');await reveal('diagnostics');}catch(e){setError((e as Error).message);}}
  const ai=status?.ai;
  return <Modal title="Состояние PMA" onClose={onClose} wide><div className="form-stack">
    {status?<>
      <p>Версия PMA {status.app.version} · Windows {status.app.os} {status.app.arch} · схема данных {status.data.schema}</p>
      <section className="export-target"><h3>Figma</h3>
        <p><strong>{status.figma.bridge==='listening'?'Мост Figma работает':'Мост Figma недоступен'}</strong>{status.figma.reason?' — '+status.figma.reason:''}</p>
        <ol className="instructions"><li>Откройте Figma Desktop и любой файл Figma Design.</li><li>Меню <strong>Plugins → Development → Import plugin from manifest…</strong>, выберите <code>manifest.json</code> в папке плагина PMA.</li><li>Это нужно сделать один раз. После обновления PMA закройте окно плагина и запустите его снова.</li></ol>
        <button className="button secondary small" disabled={!status.figma.pluginFolderReady} onClick={()=>void reveal('figma-plugin')}>Открыть папку плагина</button>
      </section>
      <section className="export-target"><h3>AI</h3><p>{!status.session.unlocked?'Откройте своё подключение, чтобы увидеть состояние AI.':!ai?.configured?'Не настроен — работает ручной путь.':ai.blocked?'Закрыт до новой проверки (см. «Настройки AI»).':!ai.verified?'Профиль не проверен.':ai.enabled?'Готов к работе.':'Выключен владельцем.'}</p>
        {status.data.ledger&&!status.data.ledger.available?<p className="form-error">Учёт расхода AI требует сверки; платный AI закрыт.</p>:null}</section>
      <div className="modal-actions"><button className="button secondary" onClick={()=>void report()}>Создать отчёт для помощи</button></div>
    </>:null}
    {note?<p role="status" className="muted">{note}</p>:null}{error?<p role="alert" className="form-error">{error}</p>:null}
  </div></Modal>;
}
