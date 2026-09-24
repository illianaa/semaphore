import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { upsertArtifact, artifactView } from "../lib/artifacts.mjs";
import { createPreviewServer, previewAvailability } from "../lib/preview.mjs";

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-preview-"));
  const file = path.join(directory, "index file.html");
  fs.writeFileSync(file, '<h1>Only this revision</h1><link rel="stylesheet" href="style.css">');
  fs.writeFileSync(path.join(directory, "style.css"), "h1 { color: green }");
  fs.writeFileSync(path.join(directory, "secret.txt"), "unselected private content");
  const room = {}, preview = createPreviewServer(options);
  const artifact = upsertArtifact(room, { file, assets: ["style.css"], speaker: "astra", title: '<safe title "quoted">' }).artifact;
  t.after(async () => { await preview.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, room, artifact, preview };
}
async function raw(url, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    http.get({ hostname: parsed.hostname, port: parsed.port, path: pathname, headers }, response => {
      let body = ""; response.on("data", chunk => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on("error", reject);
  });
}
const fileURL = grant => grant.url.replace("/preview/", "/files/") + "/index%20file.html";

test("preview grants expose only selected, immutable bytes behind an isolated sandboxed viewer", async t => {
  const f = fixture(t), grant = await f.preview.issue("room-a", artifactView(f.artifact));
  assert.equal(grant.revision, 1); assert.equal(grant.sha256, f.artifact.sha256);
  assert.match(grant.url, /^http:\/\/127\.0\.0\.1:\d+\/preview\/[a-f0-9]{64}$/);
  const viewer = await fetch(grant.url), html = await viewer.text();
  assert.equal(viewer.status, 200); assert.match(html, /&lt;safe title &quot;quoted&quot;&gt;/);
  assert.match(html, /Version 1/); assert.match(html, /Saved preview; later edits are not shown/);
  assert.match(html, /sandbox="allow-scripts"/); assert.doesNotMatch(html, /allow-same-origin|semaphore-token/);
  const response = await fetch(fileURL(grant));
  const original = await response.text();
  assert.equal(original, fs.readFileSync(f.file, "utf8"));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /sandbox allow-scripts;/);
  assert.doesNotMatch(response.headers.get("content-security-policy"), /allow-same-origin|allow-top-navigation|allow-forms|allow-popups/);
  const css = new URL("style.css", fileURL(grant));
  assert.match(await (await fetch(css)).text(), /color: green/);
  assert.equal((await fetch(new URL("secret.txt", css))).status, 404);
  const otherFile = path.join(f.directory, "other.html"); fs.writeFileSync(otherFile, "Another artifact");
  const other = upsertArtifact({}, { file: otherFile, speaker: "claude" }).artifact;
  await f.preview.issue("another-room", artifactView(other));
  assert.equal((await fetch(new URL("other.html", css))).status, 404);
  fs.writeFileSync(f.file, "Changed after issue");
  assert.equal(await (await fetch(fileURL(grant))).text(), original, "an issued link remains the labeled old snapshot");
  await assert.rejects(f.preview.issue("room-a", { ...f.artifact, availability: "current" }), /Artifact changed/);
});

test("preview requests reject traversal, forged hosts, writes and expired capabilities", async t => {
  let now = Date.now(); const f = fixture(t, { now: () => now, ttl: 1000 });
  const grant = await f.preview.issue("room", artifactView(f.artifact));
  const base = new URL(grant.url).pathname.replace("/preview/", "/files/");
  for (const tail of ["../secret.txt", "%2e%2e/secret.txt", "%252e%252e/secret.txt", "%2fetc%2fpasswd", "..%5csecret.txt", "%00", "%XX"])
    assert.ok([400, 404].includes((await raw(grant.url, `${base}/${tail}`)).status), tail);
  assert.equal((await raw(grant.url, `${base}/style.css`, { Host: "attacker.example" })).status, 403);
  const origin = new URL(grant.url).origin;
  assert.equal((await fetch(origin + "/api/rooms")).status, 404);
  assert.equal((await fetch(origin + "/api/wake", { method: "POST", body: "{}" })).status, 405);
  now += 1001;
  assert.equal((await fetch(grant.url)).status, 404);
  assert.equal((await fetch(fileURL(grant))).status, 404);
  assert.notEqual((await f.preview.issue("room", artifactView(f.artifact))).url, grant.url);
});

test("preview rejects changed paths and unsupported entries, and bounds snapshot storage", async t => {
  const f = fixture(t, { maxSnapshots: 1 });
  const view = artifactView(f.artifact);
  const first = await f.preview.issue("room", view);
  assert.equal((await f.preview.issue("room", view)).url, first.url, "the same version reuses its active link");
  await assert.rejects(f.preview.issue("other-room", view), /capacity is full/);
  fs.unlinkSync(f.file); fs.symlinkSync(path.join(f.directory, "secret.txt"), f.file);
  await assert.rejects(f.preview.issue("room", view), /resolves somewhere else/);
  assert.equal(previewAvailability(artifactView(f.artifact)).available, false);
  const text = upsertArtifact({}, { file: path.join(f.directory, "secret.txt"), speaker: "astra" }).artifact;
  await assert.rejects(f.preview.issue("room", artifactView(text)), /supports HTML/);
});
