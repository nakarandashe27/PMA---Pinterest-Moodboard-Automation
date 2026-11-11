import {useEffect,useId,useRef,type MouseEvent,type ReactNode} from 'react';
import {X} from 'lucide-react';
// Closes on the backdrop only: both press and release must land outside the dialog box. A click in the
// dialog's own padding or a text selection dragged out of a field keeps the form and its draft.
const outside=(event:MouseEvent<HTMLDialogElement>)=>{const r=event.currentTarget.getBoundingClientRect();return event.target===event.currentTarget&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};
export default function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}){
  const ref=useRef<HTMLDialogElement>(null),pressedOutside=useRef(false),titleId=useId();
  // React removes the open dialog, so the browser cannot restore focus itself: return it to the opener.
  useEffect(()=>{const el=ref.current!,opener=document.activeElement as HTMLElement|null;el.showModal();return()=>{el.close();if(opener?.isConnected)opener.focus();};},[]);
  return <dialog ref={ref} aria-labelledby={titleId} className={'modal '+(wide?'wide':'')} onCancel={event=>{event.preventDefault();onClose();}} onMouseDown={event=>{pressedOutside.current=outside(event);}} onClick={event=>{const close=pressedOutside.current&&outside(event);pressedOutside.current=false;if(close)onClose();}}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={20}/></button></header>{children}
  </dialog>;
}
