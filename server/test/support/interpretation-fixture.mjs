import assert from 'node:assert/strict';
export const vision='Хочу тихий камерный двор, много зелени и ощущение уединения, без парадности';
export const preparedResponse=(extra={})=>({summary:'Камерный зелёный двор для спокойного отдыха',searchQuery:'уединённый зелёный внутренний двор ландшафтный дизайн',alternatives:['камерный двор с густой зеленью'],features:['зелень','уединение'],avoid:['парадность'],assumptions:[],clarification:'',...extra});
export const catalog=async()=>[{id:'test-sol'}];
export async function waitInterpretation(client,id){
  for(let i=0;i<80;i++){const response=await client.request('/api/interpretations/'+id);assert.equal(response.status,200);if(!['queued','preparing','running'].includes(response.body.status))return response.body;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Interpretation did not finish');
}
