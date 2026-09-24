#!/usr/bin/env node
// Browser-level isolation probe. Its only network target is a disposable local
// canary, never the real app or private data. Open the printed URL with the host's
// permitted browser tool, inspect the results, then inspect /observations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { upsertArtifact, artifactView } from "../lib/artifacts.mjs";
import { createPreviewServer } from "../lib/preview.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-isolation-"));
const room = { artifacts: [] }, previews = createPreviewServer();
let canaryRequests = 0;
const canary = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/observations") res.end(JSON.stringify({ canaryRequests }));
  else { canaryRequests++; res.end('{"canary":true}'); }
});
await new Promise(resolve => canary.listen(0, "127.0.0.1", resolve));
const control = `http://127.0.0.1:${canary.address().port}`;
fs.writeFileSync(path.join(root, "witness.html"), "<!doctype html><title>Separate capability</title><p>Harmless witness</p>");
const witness = upsertArtifact(room, { file: path.join(root, "witness.html"), speaker: "astra" }).artifact;
const other = await previews.issue("isolation-fixture", artifactView(witness));
const otherFile = other.url.replace("/preview/", "/files/") + "/witness.html";
fs.writeFileSync(path.join(root, "selected.json"), '{"selected":true}');
fs.writeFileSync(path.join(root, "unselected.txt"), "This harmless file must not be served.");
fs.writeFileSync(path.join(root, "module.js"), "document.getElementById('module').textContent='PASS · selected module executes';\n");
fs.writeFileSync(path.join(root, "probe.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Preview isolation check</title><style>body{font:16px/1.65 system-ui;padding:24px;color:#173d30;background:#f8f6ee}li{margin:8px 0}</style><h1>Preview isolation check</h1><p>New synthetic fixture. No private data or real room controls.</p><ul id="results"><li id="module">WAIT · selected module</li></ul><p id="done">Checking…</p><script type="module" src="module.js"></script><script>
const output=document.getElementById('results');
function report(name,pass){const li=document.createElement('li');li.textContent=(pass?'PASS':'FAIL')+' · '+name;output.append(li)}
function blocked(name,action){try{action();report(name,false)}catch{report(name,true)}}
blocked('parent document is inaccessible',()=>parent.document.body);
blocked('local storage is inaccessible',()=>localStorage.getItem('probe'));
blocked('cookies are inaccessible',()=>document.cookie);
report('no opener',window.opener===null);
report('no referrer',document.referrer==='');
blocked('top navigation is blocked',()=>{top.location.href=${JSON.stringify(control + "/top")}});
report('popups are blocked',window.open(${JSON.stringify(control + "/popup")})===null);
(async()=>{
 try{const value=await(await fetch('selected.json')).json();report('selected local fetch works',value.selected===true)}catch{report('selected local fetch works',false)}
 try{const value=await fetch('unselected.txt');report('unselected file is denied',value.status===404)}catch{report('unselected file is denied',true)}
 for(const [name,url,options] of [
  ['another capability is inaccessible',${JSON.stringify(otherFile)},{}],
  ['control reads are blocked',${JSON.stringify(control + "/api/rooms")},{}],
  ['control writes are blocked',${JSON.stringify(control + "/api/take")},{method:'POST',body:'synthetic probe'}]
 ]){try{await fetch(url,options);report(name,false)}catch{report(name,true)}}
 document.getElementById('done').textContent='Complete · verify every result says PASS and the canary received 0 requests.';
})();
</script></html>`);
const artifact = upsertArtifact(room, { file: path.join(root, "probe.html"), assets: ["module.js", "selected.json"],
  speaker: "astra", title: "Preview isolation check" }).artifact;
console.log(JSON.stringify({ pid: process.pid, root, observations: control + "/observations",
  ...await previews.issue("isolation-fixture", artifactView(artifact)) }, null, 2));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
  await previews.close(); canary.closeAllConnections(); canary.close(() => process.exit(0));
});
