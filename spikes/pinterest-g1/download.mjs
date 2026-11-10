import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizePin } from './pins.mjs';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: node download.mjs <capture.json>');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pins)) throw new Error('Invalid evidence manifest');
if (manifest.pins.length > 25) throw new Error('G1 download limit is 25');
const directory = path.join(path.dirname(path.resolve(manifestPath)), 'media');
await fs.mkdir(directory, { recursive: true });
const results = [];
for (const raw of manifest.pins) {
  const pin = normalizePin({ ...raw, alt: raw.altText, width: raw.observedWidth, height: raw.observedHeight });
  try {
    const response = await fetch(pin.imageUrl, {
      redirect: 'error', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const type = response.headers.get('content-type')?.split(';')[0];
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    if (!ext) throw new Error('Unsupported image type');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        await response.body.cancel().catch(() => {});
        throw new Error('Image exceeds 8 MiB');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const filename = pin.pinId + '.' + ext;
    await fs.writeFile(path.join(directory, filename), bytes);
    results.push({ pinId: pin.pinId, status: 'downloaded', relativePath: 'media/' + filename,
      contentType: type, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch (error) {
    results.push({ pinId: pin.pinId, status: 'failed', reason: error.message,
      code: error.cause?.code ?? null });
  }
  // Checkpoint each result; no authorization material is recorded.
  await fs.writeFile(path.join(path.dirname(path.resolve(manifestPath)), 'downloads.json'),
    JSON.stringify({ observedAt: new Date().toISOString(), results }, null, 2) + '\n');
}
console.log(JSON.stringify({ attempted: results.length,
  downloaded: results.filter(x => x.status === 'downloaded').length,
  failed: results.filter(x => x.status === 'failed').length }));
if (results.some(x => x.status === 'failed')) process.exitCode = 1;
