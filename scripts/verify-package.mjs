// Checks the built desktop package against the delivery allowlist and writes the release checksum.
//   node scripts/verify-package.mjs
// Fails if the package contains developer data, tests, context, databases, profiles, keys or user images,
// or misses required runtime files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),asar=require('@electron/asar');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8')),release=path.resolve('release'),unpacked=path.join(release,'win-unpacked');
const installer=path.join(release,`PMA-Setup-${pkg.version}-x64.exe`);
const problems=[];
const files=asar.listPackage(path.join(unpacked,'resources','app.asar')).map(f=>f.replaceAll('\\','/').replace(/^\//,''));
const own=files.filter(f=>f!=='node_modules'&&!f.startsWith('node_modules/'));
const required=['package.json','desktop/main.mjs','desktop/worker.mjs','desktop/preload.cjs','desktop/ipc-policy.mjs','desktop/process-tree.mjs','server/app.mjs','server/data-root.mjs','server/ledger.mjs','server/ai-api.mjs','server/diagnostics.mjs','spikes/pinterest-g1/pins.mjs','spikes/pinterest-g1/extract-dom.mjs','dist/index.html','node_modules/playwright/package.json','node_modules/playwright-core/package.json'];
for(const f of required)if(!files.includes(f))problems.push('missing '+f);
// Own files may only come from the allowlisted runtime folders.
for(const f of own)if(!/^(package\.json|desktop\/[a-z-]+\.(mjs|cjs)|server\/[a-z0-9-]+\.mjs|spikes\/pinterest-g1\/(pins|extract-dom)\.mjs|dist(\/.*)?|desktop|server|spikes|spikes\/pinterest-g1)$/.test(f))problems.push('unexpected app file '+f);
const forbidden=[/(^|\/)\.local(\/|$)/,/(^|\/)output\//,/(^|\/)context\//,/(^|\/)research\//,/(^|\/)server\/test\//,/(^|\/)server\/index\.mjs$/,/\.sqlite(-wal|-shm)?$/,/(^|\/)\.env/,/(^|\/)profiles\//,/(^|\/)(Cookies|Login Data)$/,/\.(har|trace\.zip|key|pem)$/,/(^|\/)figma-package\.json$/,/(^|\/)smoke\.mjs$/];
for(const f of files)for(const rule of forbidden)if(rule.test(f))problems.push('forbidden '+f);
// Images inside the app: only the UI's own font/icon assets.
for(const f of own)if(/\.(jpe?g|png|webp|gif)$/i.test(f))problems.push('image in app '+f);
const resources=fs.readdirSync(path.join(unpacked,'resources')).sort();
for(const r of resources)if(!['app.asar','figma-plugin','icon.ico'].includes(r))problems.push('unexpected resource '+r);
const plugin=fs.readdirSync(path.join(unpacked,'resources','figma-plugin')).sort();
if(plugin.join()!=='code.js,manifest.json,ui.html')problems.push('plugin files '+plugin.join());
if(!/\?protocol=2/.test(fs.readFileSync(path.join(unpacked,'resources','figma-plugin','ui.html'),'utf8')))problems.push('plugin protocol is not 2');
if(problems.length){console.error('Package check FAILED:\n- '+problems.join('\n- '));process.exit(1);}
const sha=createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),size=fs.statSync(installer).size;
fs.writeFileSync(installer+'.sha256',sha+'  '+path.basename(installer)+'\n');
console.log(`Package check passed: ${own.length} app files, ${files.length-own.length} dependency files, resources ${resources.join(', ')}.`);
console.log(`${path.basename(installer)}  ${(size/1048576).toFixed(1)} MB\nSHA-256 ${sha}`);
