// Managed process tree. PMA's Chrome is identified only by its own profile directory inside the PMA data
// root (confirmed ownership), never by image name: other chrome.exe/node.exe processes are left alone.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

// PIDs of processes whose command line points at <root>\profiles\ (Chrome started for a PMA connection).
export async function managedChromePids(root){
  const marker=(root.replace(/[\\/]+$/,'')+'\\profiles\\').toLowerCase();
  const script="Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { '' + $_.ProcessId + \"`t\" + $_.CommandLine }";
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,maxBuffer:32*1024*1024,timeout:20000});
  return stdout.split(/\r?\n/).map(line=>{const tab=line.indexOf('\t');return [Number(line.slice(0,tab)),line.slice(tab+1).toLowerCase().replaceAll('/','\\')];})
    .filter(([pid,cmd])=>pid>0&&pid!==process.pid&&cmd.includes('--user-data-dir=')&&cmd.includes(marker)).map(([pid])=>pid);
}
// Ends exactly these processes and their children.
export async function killTrees(pids){
  for(const pid of pids){try{await run('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:15000});}catch{}}
}
export async function cleanupManagedChrome(root){const pids=await managedChromePids(root);await killTrees(pids);return pids.length;}
