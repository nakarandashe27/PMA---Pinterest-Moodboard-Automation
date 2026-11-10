import {memo} from 'react';
import {ArrowUpRight,Check,ImageOff} from 'lucide-react';
import type {Candidate} from '../types';
const ReferenceCard=memo(function ReferenceCard({candidate,index,selected,limitReached,onToggle,replacing,canReplace,replacementLimit,onReplace}:{candidate:Candidate;index:number;selected:boolean;limitReached:boolean;onToggle:(id:string)=>void;replacing:boolean;canReplace:boolean;replacementLimit:boolean;onReplace:(id:string)=>void}){
  return <article className={'reference-card '+(selected?'selected':'')}>
    <button className="reference-image" disabled={limitReached&&!selected} onClick={()=>onToggle(candidate.id)} aria-label={(selected?'Снять выбор: ':'Выбрать: ')+'референс '+(index+1)} aria-pressed={selected}>
      <img src={candidate.mediaUrl} alt={candidate.altText||'Ландшафтный референс '+(index+1)} loading={index<8?'eager':'lazy'} decoding="async"/>
    </button>
    <label className="reference-check"><input type="checkbox" disabled={limitReached&&!selected} checked={selected} onChange={()=>onToggle(candidate.id)} aria-label={'Выбрать референс '+(index+1)}/><span>{selected?<Check size={17}/>:null}</span></label>
    <footer><span>Референс {String(index+1).padStart(2,'0')}</span><a href={candidate.pinUrl} target="_blank" rel="noreferrer">Открыть пин <ArrowUpRight size={14}/></a></footer>
    {canReplace?<button className={'replace-card '+(replacing?'marked':'')} disabled={replacementLimit&&!replacing} aria-label={'Отметить для замены референс '+(index+1)} aria-pressed={replacing} onClick={()=>onReplace(candidate.id)}>{replacing?'Отмечен для замены':'Заменить этот кадр'}</button>:null}
    {candidate.ai?<div className="ai-reason"><strong>{candidate.ai.score>=3?'AI: полезный вариант':candidate.ai.score===2?'AI: частичное соответствие':'AI: слабое соответствие'}</strong><p>{candidate.ai.reason}</p>{candidate.ai.uncertainty?<p className="uncertainty">Что неясно: {candidate.ai.uncertainty}</p>:null}</div>:null}
  </article>;
});
export default function ReferenceGrid({candidates,allCandidates,selectedIds,onToggle,replacementIds,canReplace,onReplace}:{candidates:Candidate[];allCandidates:Candidate[];selectedIds:string[];onToggle:(id:string)=>void;replacementIds:string[];canReplace:boolean;onReplace:(id:string)=>void}){
  if(!candidates.length)return <div className="grid-empty"><ImageOff size={28}/><p>Здесь появятся изображения</p><span>Запустите поиск или переключитесь на все референсы.</span></div>;
  const selected=new Set(selectedIds);
  return <section className="reference-grid" aria-label="Референсы Pinterest">{candidates.map(c=><ReferenceCard key={c.id} candidate={c} index={allCandidates.findIndex(item=>item.id===c.id)} selected={selected.has(c.id)} limitReached={selected.size>=25} onToggle={onToggle} replacing={replacementIds.includes(c.id)} canReplace={canReplace} replacementLimit={replacementIds.length>=5} onReplace={onReplace}/>)}</section>;
}
