import {useEffect,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';
export default function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const el=ref.current!;el.showModal();return()=>el.close();},[]);
  return <dialog ref={ref} className={'modal '+(wide?'wide':'')} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={20}/></button></header>{children}
  </dialog>;
}
