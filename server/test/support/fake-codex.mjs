// Stand-in for codex.exe: answers --version, login status, debug models and exec the way the real CLI does.
// FAKE_CODEX_LOGIN=chatgpt|key|none, FAKE_CODEX_FAIL=<text> makes exec fail, FAKE_CODEX_LOG records each call.
import fs from 'node:fs';
import {preparedResponse} from './interpretation-fixture.mjs';

const args=process.argv.slice(2),login=process.env.FAKE_CODEX_LOGIN||'chatgpt';
if(process.env.FAKE_CODEX_LOG)fs.appendFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify({args,apiKey:!!(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)})+'\n');
if(args[0]==='--version'){console.log('codex-cli 9.9.9');process.exit(0);}
if(args[0]==='login'&&args[1]==='status'){
  if(login==='chatgpt'){console.error('Logged in using ChatGPT');process.exit(0);}
  if(login==='key'){console.error('API key configured - sk-test-***abcde');process.exit(0);}
  console.error('Not logged in');process.exit(1);
}
if(args[0]==='login')process.exit(0);
if(args[0]==='debug'){console.log(JSON.stringify({models:[{slug:'test-sol',display_name:'Test',visibility:'list',input_modalities:['text','image']}]}));process.exit(0);}
if(args[0]==='exec'){
  let prompt='';process.stdin.on('data',d=>{prompt+=d;});
  process.stdin.on('end',()=>{
    if(process.env.FAKE_CODEX_FAIL){console.log(JSON.stringify({type:'turn.failed',error:{message:process.env.FAKE_CODEX_FAIL}}));process.exit(1);}
    const value=flag=>args[args.indexOf(flag)+1],schema=JSON.parse(fs.readFileSync(value('--output-schema'),'utf8')),images=args.filter((_,i)=>args[i-1]==='--image');
    const response=schema.properties.color?{ok:true,color:images.length&&prompt.includes('сплошной цвет')?'red':'none'}
      :schema.properties.searchQuery?preparedResponse()
      :{interpretation:'x',criteria:['y'],assessments:schema.properties.assessments.items.properties.candidateId.enum.map(candidateId=>({candidateId,score:4,landscapeRelevance:4,category:'atmosphere',reason:'ok',uncertainty:'',sufficientEvidence:true,duplicateGroup:null}))};
    fs.writeFileSync(value('--output-last-message'),JSON.stringify(response));
    console.log(JSON.stringify({type:'thread.started'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));
  });
}
