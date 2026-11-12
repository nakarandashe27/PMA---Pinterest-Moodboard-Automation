// Builds PMA-установка.pdf (landscape slides) from index.html with the installed Chrome.
// Run: node docs/install-guide/build.mjs [previewDir]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const here=path.dirname(fileURLToPath(import.meta.url)),preview=process.argv[2];
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1123,height:794}});
await page.goto(pathToFileURL(path.join(here,'index.html')).href);await page.emulateMedia({media:'print'});
await page.evaluate(()=>document.fonts.ready);await page.waitForLoadState('networkidle');
// Content must end above the footer: nothing may be clipped by the fixed slide height.
const fit=await page.locator('.slide').evaluateAll(slides=>slides.map((s,i)=>{
  const foot=s.querySelector('.foot').getBoundingClientRect().top;
  const last=Math.max(...[...s.querySelectorAll('*')].filter(e=>!e.closest('.foot')).map(e=>e.getBoundingClientRect().bottom));
  return {page:i+1,gap:Math.round(foot-last)};
}));
console.log('space above footer (px):',fit.map(f=>f.page+':'+f.gap).join('  '));
const bad=fit.filter(f=>f.gap<0);if(bad.length)console.error('OVERFLOW on pages',bad.map(b=>b.page).join(','));
if(preview){fs.mkdirSync(preview,{recursive:true});const slides=await page.locator('.slide').all();for(const [i,s] of slides.entries())await s.screenshot({path:path.join(preview,`p${i+1}.png`)});}
const out=path.join(here,'PMA-установка.pdf');
await page.pdf({path:out,printBackground:true,preferCSSPageSize:true});
await browser.close();
const pdf=fs.readFileSync(out,'latin1'),count=(pdf.match(/\/Type\s*\/Page[^s]/g)||[]).length;
console.log(`PDF: ${path.relative(process.cwd(),out)} · ${(fs.statSync(out).size/1024).toFixed(0)} KB · pages: ${count}`);
process.exit(bad.length?1:0);
