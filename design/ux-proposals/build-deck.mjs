import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));
const project = JSON.parse(fs.readFileSync(path.join(base, 'project/deck.json'), 'utf8'));
const sections = project.order.map(id => fs.readFileSync(path.join(base, 'project/slides', `${id}.html`), 'utf8'));
const faces = Object.values(project.faces).map(face => `<link rel="stylesheet" href="${face.href.replaceAll('&', '&amp;')}">`).join('\n');
const icons = { Settings:'⚙', CheckCircle:'✓', Clock:'◷', Warning:'⚠', Link:'↗', Search:'⌕', Chat:'▤', PaperPlane:'➤', ThumbsUp:'✓', Users:'♧', Verified:'✓', Book:'▥', Code:'‹›' };

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>Semaphore · Three UX proposals</title>
${faces}
<style>
*{box-sizing:border-box}html,body{margin:0;padding:0;height:100%;overflow:hidden}body{background:#e8ebe3;font-family:Inter,Arial,sans-serif;color:#2b342f}p,h1,h2,h3,h4{margin:0}p{line-height:1.3}table{border-collapse:collapse;table-layout:fixed;text-align:left;line-height:1.35}th,td{vertical-align:top}aside{display:none}svg,x-icon{flex-shrink:0}x-icon{display:inline-flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;font-size:1em;line-height:1}section{position:relative;width:1920px;height:1080px;flex-shrink:0;overflow:hidden}section[hidden]{display:none!important}#viewport{height:calc(100dvh - 64px);width:100vw;display:flex;align-items:center;justify-content:center;overflow:hidden}#frame{position:relative;flex-shrink:0;box-shadow:0 10px 50px #25342b22}#slides{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:top left}#controls{height:64px;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;background:#f8faf5;border-top:1px solid #dce3d0}button,select{font:500 14px Inter,Arial,sans-serif;border:1px solid #c6d0c1;background:#fffefa;color:#2b342f;border-radius:8px;padding:9px 12px;cursor:pointer}button:hover,select:hover{background:#e9efdd}button:focus-visible,select:focus-visible{outline:3px solid #556d4a;outline-offset:2px}button:disabled{opacity:.35;cursor:default}#counter{font-size:13px;font-variant-numeric:tabular-nums;min-width:48px;text-align:center}#jump{max-width:270px}#notes{position:fixed;z-index:5;inset:10% max(20px,10%);max-width:900px;max-height:80%;overflow:auto;border:1px solid #c6d0c1;border-radius:18px;background:#fffefa;padding:32px;color:#2b342f}#notes::backdrop{background:#1b2e22aa}#notes h2{font-family:Georgia,serif;font-size:30px;margin-bottom:16px}#notes p{font-size:18px;line-height:1.6;white-space:pre-wrap}#notes button{margin-top:20px}.hint{font-size:12px;color:#66735e}@media(max-width:650px){.hint,#print{display:none}#controls{gap:6px;padding:8px}#jump{max-width:150px}button,select{padding:8px}}
@media print{@page{size:1920px 1080px;margin:0}html,body{height:auto;overflow:visible;background:white}#viewport{display:block;height:auto;width:1920px;overflow:visible}#frame{width:1920px!important;height:auto!important;box-shadow:none}#slides{position:static;transform:none!important;height:auto}section,section[hidden]{display:flex!important;break-after:page;page-break-after:always}section:last-child{break-after:auto}#controls,#notes{display:none!important}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<main id="viewport" aria-label="Semaphore UX proposals"><div id="frame"><div id="slides">${sections.join('\n')}</div></div></main>
<nav id="controls" aria-label="Slide navigation"><button id="prev" aria-label="Previous slide">←</button><span id="counter" aria-live="polite"></span><button id="next" aria-label="Next slide">→</button><select id="jump" aria-label="Jump to slide"></select><button id="show-notes">Notes</button><button id="print">Print / PDF</button><span class="hint">Arrow keys navigate · N shows notes</span></nav>
<dialog id="notes"><h2 id="notes-title"></h2><p id="notes-copy"></p><button id="close-notes">Close</button></dialog>
<script>
const icons=${JSON.stringify(icons)};
document.querySelectorAll('x-icon').forEach(el=>{el.textContent=icons[el.getAttribute('name')]||'·';el.style.fontSize=el.style.width||'32px';el.setAttribute('aria-hidden','true')});
const slides=[...document.querySelectorAll('#slides > section')];
const jump=document.querySelector('#jump'),counter=document.querySelector('#counter'),notes=document.querySelector('#notes');
let current=0;
slides.forEach((slide,i)=>{const option=document.createElement('option');option.value=i;option.textContent=(i+1)+'. '+(slide.querySelector('h1,h2')?.textContent||slide.id);jump.append(option);slide.setAttribute('aria-label','Slide '+(i+1)+' of '+slides.length)});
function fit(){const scale=Math.min((innerWidth-24)/1920,(innerHeight-88)/1080);document.querySelector('#slides').style.transform='scale('+Math.max(.1,scale)+')';document.querySelector('#frame').style.width=1920*scale+'px';document.querySelector('#frame').style.height=1080*scale+'px'}
function show(i){current=Math.max(0,Math.min(slides.length-1,i));slides.forEach((s,n)=>{s.hidden=n!==current;s.setAttribute('aria-hidden',String(n!==current))});counter.textContent=(current+1)+' / '+slides.length;jump.value=current;document.querySelector('#prev').disabled=current===0;document.querySelector('#next').disabled=current===slides.length-1;history.replaceState(null,'','#'+slides[current].id);fit()}
function openNotes(){document.querySelector('#notes-title').textContent=slides[current].querySelector('h1,h2')?.textContent||'Notes';document.querySelector('#notes-copy').textContent=slides[current].querySelector('aside')?.textContent||'Concept proposal. Design by Claude; technical review by Astra. These mockups describe proposed behavior.';notes.showModal()}
document.querySelector('#prev').onclick=()=>show(current-1);document.querySelector('#next').onclick=()=>show(current+1);jump.onchange=()=>show(Number(jump.value));document.querySelector('#show-notes').onclick=openNotes;document.querySelector('#close-notes').onclick=()=>notes.close();document.querySelector('#print').onclick=()=>window.print();
addEventListener('keydown',event=>{if(notes.open||event.target.matches('select,button'))return;if(['ArrowRight','PageDown',' '].includes(event.key)){event.preventDefault();show(current+1)}if(['ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();show(current-1)}if(event.key==='Home')show(0);if(event.key==='End')show(slides.length-1);if(event.key.toLowerCase()==='n')openNotes()});
addEventListener('resize',fit);show(Math.max(0,slides.findIndex(s=>s.id===location.hash.slice(1))));
</script></body></html>`;
fs.writeFileSync(path.join(base, 'semaphore-ux-proposals.html'), html);
console.log(`Built ${project.order.length} slides: ${path.join(base, 'semaphore-ux-proposals.html')}`);
