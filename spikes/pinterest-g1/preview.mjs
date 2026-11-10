import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePin } from './pins.mjs';
const input = process.argv[2];
if (!input) throw new Error('Usage: node preview.mjs <capture.json>');
const dir = path.dirname(path.resolve(input));
const manifest = JSON.parse(await fs.readFile(input, 'utf8'));
const downloads = JSON.parse(await fs.readFile(path.join(dir, 'downloads.json'), 'utf8'));
const files = new Map(downloads.results.filter(x => x.status === 'downloaded').map(x => [x.pinId, x]));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sources = manifest.pins.map(p => normalizePin({ ...p, alt: p.altText }));
const cards = sources.map((p, i) => {
  const asset = files.get(p.pinId);
  if (!asset || !/^media\/[1-9]\d*\.(jpg|png|webp)$/.test(asset.relativePath)) throw new Error('Missing or unsafe local image');
  return '<article><a href="' + escape(p.pinUrl) + '" target="_blank" rel="noreferrer"><img src="' +
    escape(asset.relativePath) + '" alt="' + escape(p.altText) + '"></a><div><strong>' + (i+1) +
    '</strong><a href="' + escape(p.pinUrl) + '" target="_blank" rel="noreferrer">Открыть пин ↗</a></div><p>' +
    escape(p.altText) + '</p><small>Pin ' + p.pinId + '</small></article>';
}).join('\n');
const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Проверка Pinterest · G1</title><style>body{margin:0;background:#f4f4ef;color:#192b27;font:16px system-ui,sans-serif}header{max-width:1440px;margin:auto;padding:32px 24px 24px}h1{font-size:30px;margin:8px 0 16px}header p{max-width:900px;line-height:1.6}.label{font-size:12px;letter-spacing:.12em;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;max-width:1440px;margin:auto;padding:0 24px 40px}article{background:white;border:1px solid #dddeda;border-radius:12px;overflow:hidden}article img{display:block;width:100%;height:260px;object-fit:contain;background:#e8ebe4}article div{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 0}article strong{display:grid;place-items:center;background:#e7eee5;border-radius:50%;width:30px;height:30px}a{color:#27563b}article p{font-size:13px;line-height:1.5;margin:12px 16px;color:#536158;min-height:58px}small{display:block;margin:0 16px 16px;color:#68746d;font-size:11px}.notice{border-left:3px solid #a76c21;padding-left:14px}</style>' +
'<header><div class="label">Техническая проверка · G1</div><h1>' + escape(manifest.query) + '</h1>' +
'<p>25 локально скачанных изображений из реальной выдачи Pinterest. У каждого сохранена ссылка на исходный пин.</p>' +
'<p class="notice">Это технические кандидаты: релевантность ещё не оценена архитектором. Подписи взяты из Pinterest и могут быть неточными. Ничего из этой страницы автоматически не сохраняется в доски.</p>' +
'<p><a href="sources.json">JSON со ссылками на источники</a></p></header><main class="grid">' + cards + '</main></html>';
await fs.writeFile(path.join(dir, 'review.html'), html);
await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
console.log(JSON.stringify({ preview: path.join(dir, 'review.html'), cards: sources.length }));
