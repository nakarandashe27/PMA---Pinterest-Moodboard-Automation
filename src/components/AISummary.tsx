import type {Run} from '../types';
import {usageText} from '../usage';

export default function AISummary({run}:{run:Run}){
  if(!run.aiEnabled)return null;
  const ai=run.ai;
  if(ai?.status==='ready')return <section className="ai-summary" aria-label="Результат AI-отбора">
    <strong>AI предложил {(ai.recommendedIds||[]).length} из {run.candidates.length} изображений</strong>
    <p>{ai.interpretation}{ai.criteria?.length?<span className="ai-criteria"> Критерии: {ai.criteria.join(' · ')}.</span>:null}</p>
    <details><summary>Предварительный отбор — выбор за вами. Источники и расход AI</summary>
      <p>Проверьте соответствие заданию и выберите до 25 изображений. Все варианты доступны во вкладке «Все».</p>
      <p>Найдено через Lens: {run.candidates.filter(c=>c.origin==='lens').length}; по тексту или пину: {run.candidates.filter(c=>c.origin==='text').length}.</p>
      <p>Модель: {ai.model}. Вызовов этой оценки: {ai.callCount||1}.{ai.inheritedFromRunId?' Оценка исходной версии; расход на замены показан отдельно.':''}</p>
      <p>{usageText(ai.usage)} Вызов учтён в месячном пределе AI.</p>
    </details>
  </section>;
  if(ai&&['error','unknown','cancelled'].includes(ai.status))return <div className="error-banner" role="status"><span><strong>AI-отбор не завершён.</strong> {ai.message} Найденные изображения доступны для ручного выбора.</span></div>;
  return null;
}
