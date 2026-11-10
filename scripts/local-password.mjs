import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';
import {Store} from '../server/store.mjs';
import {setLocalPassword} from '../server/local-auth.mjs';

if(!process.stdin.isTTY)throw Error('Запустите npm run password в интерактивном терминале на этом ПК.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.local/pma'),store=new Store(root);
const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:false});
async function hidden(prompt){
  process.stdout.write(prompt);rl.pause();process.stdin.setRawMode(true);process.stdin.resume();
  try{return await new Promise((resolve,reject)=>{
    let value='';const receive=chunk=>{for(const char of chunk.toString()){
      if(char==='\u0003'){process.stdin.off('data',receive);reject(Error('Отменено'));return;}
      if(char==='\r'||char==='\n'){process.stdin.off('data',receive);resolve(value);return;}
      if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' '&&value.length<257)value+=char;
    }};process.stdin.on('data',receive);
  });}finally{process.stdin.setRawMode(false);rl.resume();process.stdout.write('\n');}
}
try{
  console.log('Первичная защита/сброс пароля доступны доверенному владельцу этой учётной записи Windows. Сначала заблокируйте PMA или остановите сервис. Пароль Pinterest здесь не нужен.');
  const connections=store.list('connection');connections.forEach((c,i)=>console.log(`${i+1}. ${c.label}${c.username?' (@'+c.username+')':''}`));
  const index=Number(await rl.question('Номер своего подключения: '))-1,c=connections[index];if(!c)throw Error('Подключение не выбрано');
  const first=await hidden('Новый локальный пароль PMA (12–256 символов): '),second=await hidden('Повторите пароль: ');
  if(first!==second)throw Error('Пароли не совпали');await setLocalPassword(store,c.id,first);console.log('Пароль установлен. Откройте PMA и разблокируйте подключение.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{rl.close();store.close();}
