import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 256;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const mediaTypes = { ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".woff": "font/woff", ".woff2": "font/woff2", ".gif": "image/gif", ".ico": "image/x-icon",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" };

// Hash only selected regular files. Never follow a replacement symlink, read a
// device/FIFO, or silently certify bytes that changed while being inspected.
function inspectFile(file, cache, capture = false) {
  if (fs.realpathSync(file) !== file) throw new Error("An artifact path now resolves somewhere else.");
  const before = fs.statSync(file, { bigint: true });
  if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new Error("Artifacts need regular files of at most 50 MiB.");
  const key = signature(before);
  if (!capture && cache?.get(file)?.key === key) return cache.get(file).info;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let info;
  try {
    if (signature(fs.fstatSync(fd, { bigint: true })) !== key) throw new Error("Artifact changed while reading; register it again.");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), chunks = [];
    let bytes = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, MAX_BYTES - bytes + 1), null))) {
      bytes += count;
      if (bytes > MAX_BYTES) throw new Error("Artifacts are limited to 50 MiB in total.");
      hash.update(buffer.subarray(0, count));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (signature(fs.fstatSync(fd, { bigint: true })) !== key || fs.realpathSync(file) !== file ||
        signature(fs.statSync(file, { bigint: true })) !== key) throw new Error("Artifact changed while reading; register it again.");
    info = { sha256: hash.digest("hex"), bytes, mediaType: mediaTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
    if (capture) info.body = Buffer.concat(chunks);
  } finally { fs.closeSync(fd); }
  if (cache && !capture) {
    if (cache.size >= 16_384) cache.clear();
    cache.set(file, { key, info });
  }
  return info;
}

function fileSet(file, assets = []) {
  if (typeof file !== "string" || !file) throw new Error("Choose the canonical artifact with --file <path>.");
  const source = fs.realpathSync(path.resolve(file));
  const directory = path.dirname(source);
  if (!Array.isArray(assets) || assets.length >= MAX_FILES) throw new Error("Select at most 255 adjacent asset files.");
  const names = [path.basename(source)];
  for (const name of assets) {
    if (typeof name !== "string" || !name || name.includes("\\") || path.isAbsolute(name) ||
        name.split("/").some(part => !part || part === "." || part === "..") || names.includes(name))
      throw new Error("Assets need unique relative file paths inside the artifact directory, without traversal.");
    names.push(name);
  }
  let bytes = 0;
  const files = names.sort().map(name => {
    const selected = path.join(directory, name);
    if (fs.realpathSync(selected) !== selected) throw new Error("Artifact assets must not use symlinks.");
    const info = inspectFile(selected);
    bytes += info.bytes;
    if (bytes > MAX_BYTES) throw new Error("Artifacts are limited to 50 MiB in total.");
    return { name, path: selected, ...info };
  });
  const sha256 = digest(JSON.stringify(files.map(({ name, sha256, bytes }) => [name, sha256, bytes])));
  return { path: source, entry: path.basename(source), files, bytes, sha256 };
}

function label(value, fallback) {
  if (value === undefined) value = fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error("An artifact title must not be blank.");
  return Array.from(value.replace(/\s+/gu, " ").trim()).slice(0, 160).join("");
}

function publication(url, revision, sha256, speaker, at, access) {
  if (url === "") return null;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("The published link must be an http or https URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("The published link must use http or https without embedded credentials.");
  if (typeof access !== "string" || !access.trim())
    throw new Error("Describe the published link's access with --access, such as public or account-private.");
  return { url: parsed.href, access: label(access), revision, sha256, by: speaker, at,
    verification: "reported-by-publisher" };
}

export function upsertArtifact(room, { id, file, title, assets, ready, url, access, speaker }) {
  if (ready !== undefined && typeof ready !== "boolean") throw new Error("Artifact readiness must be true or false.");
  const existing = id ? (room.artifacts ?? []).find(item => item.id === id) :
    (room.artifacts ?? []).find(item => item.path === fs.realpathSync(path.resolve(file ?? "")));
  if (id && !existing) throw new Error("No artifact has that ID in this room.");
  // Updating without --asset keeps the explicit selection; passing a new list replaces it.
  const selected = assets ?? existing?.files.filter(item => item.name !== existing.entry).map(item => item.name) ?? [];
  const snapshot = fileSet(file ?? existing?.path, selected);
  if (!existing && (room.artifacts?.length ?? 0) >= 50) throw new Error("This room already has 50 selected artifacts.");
  const changed = !existing || existing.sha256 !== snapshot.sha256 || existing.path !== snapshot.path;
  const revision = (existing?.revision ?? 0) + (changed ? 1 : 0);
  const at = new Date().toISOString();
  let published = existing?.published ?? null;
  if (url !== undefined) {
    const reported = publication(url, revision, snapshot.sha256, speaker, at, access);
    published = reported && published && ["url", "access", "revision", "sha256", "by"].every(key => reported[key] === published[key]) ? published : reported;
  } else if (access !== undefined) throw new Error("--access describes a --url; supply both together.");
  const artifact = { ...snapshot, id: existing?.id ?? randomUUID(),
    title: label(title, existing?.title ?? snapshot.entry), revision,
    ready: ready ?? (changed ? false : existing.ready), published,
    reviews: existing?.reviews ?? [], createdAt: existing?.createdAt ?? at, createdBy: existing?.createdBy ?? speaker,
    updatedAt: existing?.updatedAt ?? at, updatedBy: existing?.updatedBy ?? speaker };
  if (existing && JSON.stringify(artifact) === JSON.stringify(existing)) return { artifact: existing, duplicate: true };
  artifact.updatedAt = at; artifact.updatedBy = speaker;
  room.artifacts ??= [];
  if (existing) room.artifacts[room.artifacts.indexOf(existing)] = artifact;
  else room.artifacts.push(artifact);
  return { artifact, duplicate: false };
}

export function artifactView(artifact, { cache } = {}) {
  let availability = "current";
  try {
    for (const item of artifact.files) {
      const current = inspectFile(item.path, cache);
      if (current.sha256 !== item.sha256 || current.bytes !== item.bytes) availability = "changed";
    }
  } catch (error) { availability = error.code === "ENOENT" ? "missing" : "unavailable"; }
  const reviews = artifact.reviews.filter(review => review.revision === artifact.revision && review.sha256 === artifact.sha256);
  return { ...artifact, availability, currentReviews: availability === "current" ? reviews : [],
    ready: artifact.ready && availability === "current", declaredReady: artifact.ready,
    publishedCurrent: availability === "current" && artifact.published?.revision === artifact.revision && artifact.published?.sha256 === artifact.sha256,
    preview: { available: false, reason: "Request a shared preview from the Semaphore app." } };
}

export function artifactViews(room, options) {
  return (room.artifacts ?? []).map(artifact => artifactView(artifact, options));
}

// A preview serves these verified bytes, never a later read through a pathname.
// The manifest is an allowlist, including each file's canonical location/hash.
export function artifactSnapshot(artifact) {
  if (!Array.isArray(artifact.files) || !artifact.files.length || artifact.files.length > MAX_FILES ||
      artifact.entry !== path.basename(artifact.path)) throw new Error("Invalid artifact manifest.");
  const directory = path.dirname(artifact.path), files = new Map();
  let bytes = 0;
  for (const item of artifact.files) {
    if (typeof item.name !== "string" || !item.name || item.name.includes("\\") || path.isAbsolute(item.name) ||
        item.name.split("/").some(part => !part || part === "." || part === "..") || files.has(item.name) ||
        item.path !== path.join(directory, item.name)) throw new Error("Invalid artifact manifest path.");
    const info = inspectFile(item.path, undefined, true);
    if (info.sha256 !== item.sha256 || info.bytes !== item.bytes) throw new Error("Artifact changed; register its current version first.");
    bytes += info.bytes;
    if (bytes > MAX_BYTES) throw new Error("Artifacts are limited to 50 MiB in total.");
    files.set(item.name, info);
  }
  const tuples = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, info]) => [name, info.sha256, info.bytes]);
  if (!files.has(artifact.entry) || digest(JSON.stringify(tuples)) !== artifact.sha256)
    throw new Error("Artifact manifest does not match its registered hash.");
  return { files, bytes };
}

export function recordArtifactReview(room, { id, revision, sha256, kind, speaker, via }) {
  const artifact = (room.artifacts ?? []).find(item => item.id === id);
  if (!artifact) throw new Error("No artifact has that ID in this room.");
  if (!["source", "visual"].includes(kind)) throw new Error("Review kind must be source or visual.");
  if (kind === "visual" && (typeof via !== "string" || !via.trim()))
    throw new Error("A visual review needs --via describing the permitted render you inspected.");
  const surface = label(via, "source files");
  if (!Number.isSafeInteger(revision) || revision !== artifact.revision || sha256 !== artifact.sha256 ||
      artifactView(artifact).availability !== "current") throw new Error("Stale artifact review: inspect the current registered revision and hash first.");
  const previous = artifact.reviews.find(item => item.speaker === speaker && item.kind === kind && item.revision === revision && item.sha256 === sha256);
  if (previous?.via === surface)
    return { artifact, duplicate: true };
  const at = new Date().toISOString();
  const review = { speaker, kind, revision, sha256, via: surface, at };
  if (previous) Object.assign(previous, review);
  else artifact.reviews.push(review);
  artifact.updatedAt = at; artifact.updatedBy = speaker;
  return { artifact, duplicate: false };
}
