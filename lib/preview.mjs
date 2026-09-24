import http from "node:http";
import { randomBytes } from "node:crypto";
import { artifactSnapshot } from "./artifacts.mjs";

export const PREVIEW_TTL = 30 * 60 * 1000;
const MAX_SNAPSHOTS = 64, MAX_BYTES = 100 * 1024 * 1024;
const TYPES = new Set(["text/html", "text/css", "text/javascript", "application/json", "text/plain", "text/markdown",
  "image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "font/woff", "font/woff2"]);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const failure = (status, message) => Object.assign(new Error(message), { status });

export function previewAvailability(artifact) {
  if (artifact.availability !== "current") return { available: false, reason: "Register the current files before opening a preview." };
  if (artifact.files.find(file => file.name === artifact.entry)?.mediaType !== "text/html")
    return { available: false, reason: "Shared preview supports HTML and its selected local assets. Other formats remain source-only." };
  return { available: true, reason: "Opens an isolated preview of this version. Your native app's access rules still apply." };
}

// This service has no control token, room root, or arbitrary filesystem route.
// A capability holds only a verified in-memory snapshot of one selected revision.
export function createPreviewServer({ now = Date.now, ttl = PREVIEW_TTL, maxBytes = MAX_BYTES, maxSnapshots = MAX_SNAPSHOTS } = {}) {
  const grants = new Map();
  let port, starting, closed = false, totalBytes = 0;
  function prune() {
    for (const [token, grant] of grants) if (grant.expires <= now()) {
      grants.delete(token); totalBytes -= grant.snapshot.bytes;
    }
  }
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) throw failure(403, "Unrecognized preview host.");
      if (!["GET", "HEAD"].includes(req.method)) throw failure(405, "Preview links are read-only.");
      // Parse raw path before URL normalization, decode once, then use only a
      // Map lookup. Neither traversal nor a symlink can become a filesystem read.
      const match = /^\/(preview|files)\/([a-f0-9]{64})(?:\/(.*))?$/.exec(req.url.split("?")[0]);
      if (!match) throw failure(404, "Preview not found.");
      prune();
      const [, route, token, encodedName] = match, grant = grants.get(token);
      if (!grant) throw failure(404, "This preview link expired or is unavailable. Reopen it from Semaphore.");
      const origin = `http://127.0.0.1:${port}`, base = `${origin}/files/${token}/`;
      let body, type;
      if (route === "preview" && encodedName === undefined) {
        const nonce = randomBytes(18).toString("base64");
        res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${base}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        body = Buffer.from(viewer(grant, base, nonce)); type = "text/html; charset=utf-8";
      } else if (route === "files" && encodedName) {
        let name;
        try { name = decodeURIComponent(encodedName); } catch { throw failure(400, "Invalid preview path."); }
        if (name.includes("\\") || name.includes("\0") || name.split("/").some(part => !part || part === "." || part === ".."))
          throw failure(404, "Selected file not found.");
        const file = grant.snapshot.files.get(name);
        if (!file || !TYPES.has(file.mediaType)) throw failure(404, "Selected file not found or not supported for preview.");
        // Sandboxed documents have opaque origins. CORS allows modules/fonts
        // within this capability; CSP still restricts every source to its prefix.
        res.setHeader("Access-Control-Allow-Origin", "null");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Content-Security-Policy", `default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src ${base} data: blob:; font-src ${base} data:; media-src ${base} data: blob:; connect-src ${base}; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; frame-ancestors ${origin}`);
        body = file.body; type = file.mediaType;
      } else throw failure(404, "Preview not found.");
      res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      res.writeHead(error.status ?? 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : error.status ? error.message : "Preview unavailable.");
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  async function listen() {
    if (closed) throw failure(503, "Preview service is closed.");
    starting ??= new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
    });
    await starting;
  }
  return {
    async issue(roomName, artifact) {
      if (!previewAvailability(artifact).available) throw failure(409, previewAvailability(artifact).reason);
      await listen();
      prune();
      const existing = [...grants].find(([, item]) => item.roomName === roomName && item.id === artifact.id &&
        item.revision === artifact.revision && item.sha256 === artifact.sha256);
      if (!existing && (grants.size >= maxSnapshots || totalBytes + artifact.bytes > maxBytes))
        throw failure(429, "Preview capacity is full. Try again after an existing link expires.");
      // Recheck every byte, even on reuse. A metadata-only polling cache never
      // authorizes serving a file under its old revision.
      let snapshot;
      try { snapshot = artifactSnapshot(artifact); }
      catch (error) { throw failure(409, error.message); }
      let token, grant;
      if (existing) [token, grant] = existing;
      else {
        if (grants.size >= maxSnapshots || totalBytes + snapshot.bytes > maxBytes)
          throw failure(429, "Preview capacity is full. Try again after an existing link expires.");
        token = randomBytes(32).toString("hex");
        grant = { roomName, id: artifact.id, title: artifact.title, entry: artifact.entry, revision: artifact.revision,
          sha256: artifact.sha256, expires: now() + ttl, snapshot };
        grants.set(token, grant); totalBytes += snapshot.bytes;
      }
      return { url: `http://127.0.0.1:${port}/preview/${token}`, revision: grant.revision,
        sha256: grant.sha256, expiresAt: new Date(grant.expires).toISOString() };
    },
    async close() {
      closed = true;
      if (starting) {
        try { await starting; } catch { /* a failed bind has no listening server */ }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      grants.clear(); totalBytes = 0;
    },
  };
}

function viewer(grant, base, nonce) {
  const src = base + grant.entry.split("/").map(encodeURIComponent).join("/");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(grant.title)} · v${grant.revision} · Semaphore preview</title>
<style>*{box-sizing:border-box}body{margin:0;background:#e9eee9;color:#203c31;font:13px system-ui,sans-serif}header{padding:12px 18px;background:#fffef9;border-bottom:1px solid #cbd6cc;display:flex;gap:12px;align-items:center;flex-wrap:wrap}strong{font-size:14px}small{display:block;color:#5b6b62;margin-top:4px;overflow-wrap:anywhere}.controls{margin-left:auto;display:flex;gap:8px}button{font:inherit;border:1px solid #bdcbbf;background:#fff;border-radius:7px;padding:7px 11px;color:inherit;cursor:pointer}button[aria-pressed=true]{background:#264e3c;color:white}main{padding:16px;display:flex;justify-content:center}iframe{display:block;width:100%;height:calc(100dvh - 114px);min-height:420px;border:1px solid #c3d0c5;background:white;border-radius:6px}main.phone iframe{width:390px;max-width:100%;height:760px}#mode{position:absolute;left:-10000px}@media(max-width:550px){header{padding:10px 12px}.controls{margin-left:0}main{padding:8px}iframe{height:calc(100dvh - 154px)}}button:focus-visible{outline:3px solid #589372;outline-offset:2px}</style></head>
<body><header><div><strong>${escape(grant.title)} · Version ${grant.revision}</strong><small>${escape(grant.entry)} · SHA-256 ${grant.sha256.slice(0, 12)} · Saved preview; later edits are not shown.<br>Selected local files · Link expires ${escape(new Date(grant.expires).toISOString())}</small></div><div class="controls"><button type="button" data-mode="desktop" aria-pressed="true">Desktop</button><button type="button" data-mode="phone" aria-pressed="false">Phone</button></div></header>
<p id="mode" role="status" aria-live="polite">Desktop preview</p><main><iframe title="${escape(grant.title)} — version ${grant.revision}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${escape(src)}"></iframe></main>
<script nonce="${nonce}">for(const button of document.querySelectorAll('button[data-mode]'))button.addEventListener('click',()=>{document.querySelector('main').className=button.dataset.mode==='phone'?'phone':'';for(const item of document.querySelectorAll('button[data-mode]'))item.setAttribute('aria-pressed',String(item===button));document.getElementById('mode').textContent=button.textContent+' preview'});</script></body></html>`;
}
