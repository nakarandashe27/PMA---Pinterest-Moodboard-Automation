// State of the local service and a safe error report. Both are built from an allowlist of versions,
// enumerated states and counts: no project text, prompts, provider bodies, URLs, paths, keys or images.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {profileId,profileHash} from './ai-api.mjs';
import {aiMode,modeId} from './ai-codex.mjs';

const tally=(items,field)=>items.reduce((acc,item)=>{const k=String(item?.[field]??'none').replace(/[^a-z-]/gi,'').slice(0,30)||'other';acc[k]=(acc[k]||0)+1;return acc;},{});

// owner: the unlocked connection or null. Owner-specific parts appear only for that owner.
export function serviceStatus({store,owner,info}){
  const p=owner?store.get('ai-profile',profileId(owner)):null;
  const own=r=>owner&&r.connectionId===owner;
  return {
    app:{version:info.appVersion,electron:process.versions.electron||null,node:process.versions.node,os:os.release(),arch:process.arch},
    data:{schema:info.schemaVersion,backupBeforeMigration:!!info.schemaBackup,ledger:store.ledger?{available:!store.ledger.blocked}:null},
    figma:{bridge:info.figma.available?'listening':'unavailable',reason:info.figma.available?null:info.figma.reason,protocol:info.figmaProtocol,pluginFolderReady:!!info.pluginReady},
    session:{unlocked:!!owner},
    ai:owner?{mode:aiMode(store,owner),codexVerified:!!store.get('ai-mode',modeId(owner))?.verification,configured:!!p,enabled:!!p?.enabled,keyConfigured:!!p?.keySetAt,verified:!!p&&p.verification?.profileHash===profileHash(p),blocked:!!p?.blockedReason}:null,
    work:owner?{runs:tally(store.list('run').filter(own),'status'),interpretations:tally(store.list('interpretation').filter(own),'status'),
      figmaAttempts:tally(store.list('figma-attempt').filter(own),'state'),pinterestExports:tally(store.list('pinterest-export').filter(own),'state')}:null,
  };
}

// Written only on the owner's explicit action, into diagnostics/. Returns the file name, never a path.
export function writeReport(dir,status){
  fs.mkdirSync(dir,{recursive:true});
  const name='pma-report-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  fs.writeFileSync(path.join(dir,name),JSON.stringify({kind:'pma-safe-report',createdAt:new Date().toISOString(),...status},null,2));
  return name;
}
