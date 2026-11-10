// AI usage as recorded by either executor: the legacy Codex CLI (input_tokens) or the API profile (inputTokens, costMicros).
type Usage={input_tokens?:number;output_tokens?:number;inputTokens?:number;outputTokens?:number;costMicros?:number|null;currency?:string}|null|undefined;
export function usageText(usage:Usage):string{
  if(!usage)return 'Данные о расходе не получены.';
  const input=usage.inputTokens??usage.input_tokens,output=usage.outputTokens??usage.output_tokens;
  const tokens=`Входных токенов: ${input??'не получено'}; выходных: ${output??'не получено'}.`;
  return typeof usage.costMicros==='number'&&usage.currency?`${tokens} Стоимость: ${(usage.costMicros/1e6).toFixed(4)} ${usage.currency}.`:tokens;
}
