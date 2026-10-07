#!/usr/bin/env node
// A newly generated, harmless fixture for independent native-host preview checks.
// No real rooms, native identities, private artifacts, or model calls are used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../server.mjs";
import { createLiveRoom } from "../lib/rooms.mjs";
import { upsertArtifact } from "../lib/artifacts.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-preview-harness-"));
const { room, store } = createLiveRoom(root, "Shared preview · harmless fixture");
fs.writeFileSync(path.join(store.workspace, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared preview check</title><link rel="stylesheet" href="style.css"><script src="demo.js" defer></script></head><body><main><p class="eyebrow">Semaphore / shared preview check</p><h1>One version.<br>Both perspectives.</h1><p class="intro">A new, harmless test page for checking the same local artifact in both native apps.</p><section><article><img src="diagram.svg" alt="Two circles connected to one shared page"><h2>Selected files</h2><p>This page, its stylesheet, illustration and script are the complete selection.</p></article><article><span class="number">01</span><h2>Exact revision</h2><p>The viewer labels the registered version and the selected content hash.</p></article><article><span class="number">02</span><h2>Desktop and phone</h2><p>Use the viewer controls to check this responsive layout at both widths.</p></article></section><button id="details" type="button">Show interaction check</button><p id="result" hidden>Local interaction works inside the sandbox.</p><footer>Fixture only · No personal content · No external resources</footer></main></body></html>`);
fs.writeFileSync(path.join(store.workspace, "style.css"), `*{box-sizing:border-box}body{margin:0;background:#f8f6ee;color:#183d30;font-family:system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:50px 42px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#617768}h1{font-size:clamp(38px,6vw,70px);line-height:1.02;letter-spacing:-3px;margin:24px 0}.intro{max-width:550px;font-size:17px;line-height:1.65;color:#596a5f}section{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:34px 0}article{padding:22px;background:white;border:1px solid #dce1d5;border-radius:16px}article img{height:56px;width:100px;object-fit:contain}.number{display:block;font-size:38px;line-height:56px;color:#7f997e}h2{font-size:18px;letter-spacing:-.4px}article p{color:#5b6b60;font-size:14px;line-height:1.7}button{background:#1f533b;color:#fff;border:0;border-radius:9px;padding:13px 18px;font:600 13px system-ui;cursor:pointer}#result{color:#256744;font-weight:600}footer{margin-top:35px;font-size:11px;color:#758174}@media(max-width:600px){main{padding:28px 23px}h1{letter-spacing:-1.8px}section{grid-template-columns:1fr;gap:12px;margin:24px 0}article{padding:18px}.intro{font-size:15px}footer{line-height:1.7}}`);
fs.writeFileSync(path.join(store.workspace, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="56" viewBox="0 0 100 56"><path d="M15 28H85" stroke="#bccdb8" stroke-width="3"/><circle cx="15" cy="28" r="10" fill="#376449"/><circle cx="85" cy="28" r="10" fill="#d39d6a"/><rect x="39" y="9" width="22" height="38" rx="4" fill="#f3f2e8" stroke="#7c927c"/><path d="M44 20H56M44 27H56M44 34H52" stroke="#7c927c"/></svg>');
fs.writeFileSync(path.join(store.workspace, "demo.js"), "document.getElementById('details').addEventListener('click',()=>document.getElementById('result').hidden=false);\n");
store.acquire();
let artifact;
try {
  artifact = upsertArtifact(room, { file: path.join(store.workspace, "index.html"), assets: ["style.css", "diagram.svg", "demo.js"],
    speaker: "astra", title: "Shared preview check", ready: true }).artifact;
  store.save(room);
} finally { store.release(); }
const app = createAppServer({ root, wakePump: false, claudePump: false, claudeDesktop: false });
const url = await app.listen(0);
const html = await (await fetch(url)).text();
const token = html.match(/name="semaphore-token" content="([a-f0-9]+)"/)[1];
const route = `/api/rooms/${room.name}/artifacts/${artifact.id}/preview`;
const response = await fetch(url + route, { method: "POST", headers: { Origin: url, "X-Semaphore-Token": token, "Content-Type": "application/json" }, body: "{}" });
if (!response.ok) throw new Error(await response.text());
const info = { pid: process.pid, root, room: room.name, artifact: artifact.id, source: artifact.path,
  controlUrl: url, previewRoute: route, ...await response.json() };
fs.writeFileSync("/tmp/semaphore-preview-handoff.json", JSON.stringify(info, null, 2), { mode: 0o600 });
console.log(JSON.stringify(info, null, 2));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await app.close(); process.exit(0); });
