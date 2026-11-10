// Builds PMA-установка.pdf from index.html with the installed Chrome. Run: node docs/install-guide/build.mjs [previewDir]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const here=path.dirname(fileURLToPath(import.meta.url)),preview=process.argv[2];
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:794,height:1123}});
await page.goto(pathToFileURL(path.join(here,'index.html')).href);await page.emulateMedia({media:'print'});
await page.evaluate(()=>document.fonts.ready);await page.waitForLoadState('networkidle');
// Every page must fit: nothing may be clipped by the fixed A4 height.
const fit=await page.$$eval('.page',pages=>pages.map((p,i)=>{const foot=p.querySelector('.foot').getBoundingClientRect().top,last=[...p.children].filter(c=>!c.classList.contains('foot')).at(-1).getBoundingClientRect().bottom;return {page:i+1,gap:Math.round(foot-last)};}));
console.log('space above footer (px):',fit.map(f=>f.page+':'+f.gap).join('  '));
const bad=fit.filter(f=>f.gap<0);if(bad.length)console.error('OVERFLOW on pages',bad.map(b=>b.page).join(','));
if(preview){fs.mkdirSync(preview,{recursive:true});const pages=await page.$$('.page');for(const [i,p] of pages.entries())await p.screenshot({path:path.join(preview,`p${i+1}.png`)});}
const out=path.join(here,'PMA-установка.pdf');
await page.pdf({path:out,format:'A4',printBackground:true,preferCSSPageSize:true});
await browser.close();
const pdf=fs.readFileSync(out,'latin1'),count=(pdf.match(/\/Type\s*\/Page[^s]/g)||[]).length;
console.log(`PDF: ${path.relative(process.cwd(),out)} · ${(fs.statSync(out).size/1024).toFixed(0)} KB · pages: ${count}`);
process.exit(bad.length?1:0);
