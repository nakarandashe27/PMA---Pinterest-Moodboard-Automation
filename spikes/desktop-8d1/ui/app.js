window.pma.onResult(result=>{
  document.getElementById('status').textContent=result.ok?'Все проверки пройдены':'Есть ошибки';
  document.getElementById('status').className=result.ok?'ok':'bad';
  const list=document.getElementById('list');list.textContent='';
  for(const c of result.checks){const li=document.createElement('li');li.className=c.ok?'ok':'bad';li.textContent=(c.ok?'✓ ':'✗ ')+c.name+(c.error?': '+c.error.split('\n')[0]:'');list.append(li);}
  const pre=document.createElement('pre');pre.textContent=JSON.stringify(result,null,2);document.body.append(pre);
});
