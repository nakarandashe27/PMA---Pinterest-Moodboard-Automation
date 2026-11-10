import fs from 'node:fs/promises';
import path from 'node:path';
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node upload-assets.mjs <private-config.json>');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
if (!Array.isArray(config.entries) || config.entries.length > 25) throw new Error('Invalid bounded upload set');
for (const item of config.entries) {
  const url = new URL(item.submitUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'mcp.figma.com' || url.username || url.password) throw new Error('Unexpected upload destination');
}
const results = [];
let next = 0;
async function worker() {
  while (next < config.entries.length) {
    const index = next++;
    const item = config.entries[index];
    try {
      const bytes = await fs.readFile(item.path);
      if (bytes.length > 10 * 1024 * 1024) throw new Error('Asset exceeds upload limit');
      const response = await fetch(item.submitUrl, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': item.contentType }, body: bytes, signal: AbortSignal.timeout(30000) });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = {}; }
      if (!response.ok || data.error) throw new Error('Upload HTTP ' + response.status);
      results.push({ index, pinId: item.pinId, targetNodeId: item.targetNodeId,
        status: 'accepted-awaiting-canvas-verification', httpStatus: response.status,
        imageHash: data.imageHash ?? null, responseKeys: Object.keys(data) });
    } catch (error) {
      results.push({ index, pinId:item.pinId,targetNodeId:item.targetNodeId,status:'unknown-or-failed',reason:error.message,code:error.cause?.code??null });
    }
  }
}
await Promise.all([worker(), worker()]);
results.sort((a,b)=>a.index-b.index);
await fs.writeFile(config.receiptPath, JSON.stringify({fileKey:config.fileKey,observedAt:new Date().toISOString(),results},null,2)+'\n');
// Presigned upload URLs are single-use; do not leave them in the artifact directory.
await fs.unlink(configPath);
console.log(JSON.stringify({attempted:results.length,accepted:results.filter(x=>x.status.startsWith('accepted')).length,unknownOrFailed:results.filter(x=>x.status==='unknown-or-failed').length}));
if(results.some(x=>x.status==='unknown-or-failed'))process.exitCode=1;
