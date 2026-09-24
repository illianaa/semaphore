import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertArtifact, artifactView, recordArtifactReview } from "../lib/artifacts.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-artifact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "index.html");
  fs.writeFileSync(file, '<link rel="stylesheet" href="style.css"><h1>A page</h1>');
  fs.writeFileSync(path.join(directory, "style.css"), "h1 { color: blue }");
  return { directory, file, room: {} };
}

test("artifact versions include selected assets and never carry old reviews or publication claims forward", t => {
  const f = fixture(t), cache = new Map();
  const options = { file: f.file, assets: ["style.css"], title: "The result", speaker: "astra", ready: true };
  const first = upsertArtifact(f.room, options).artifact;
  assert.equal(first.revision, 1);
  assert.equal(first.path, fs.realpathSync(f.file));
  assert.equal(upsertArtifact(f.room, options).duplicate, true);
  recordArtifactReview(f.room, { id: first.id, revision: 1, sha256: first.sha256, kind: "source", speaker: "astra" });
  upsertArtifact(f.room, { ...options, url: "https://example.com/result", access: "account-private" });
  let view = artifactView(f.room.artifacts[0], { cache });
  assert.equal(view.ready, true); assert.equal(view.currentReviews[0].kind, "source");
  assert.equal(view.publishedCurrent, true);
  assert.equal(view.published.verification, "reported-by-publisher");
  assert.equal(view.preview.available, false);

  fs.writeFileSync(path.join(f.directory, "style.css"), "h1 { color: rebeccapurple }");
  view = artifactView(f.room.artifacts[0], { cache });
  assert.equal(view.availability, "changed");
  assert.equal(view.ready, false); assert.deepEqual(view.currentReviews, []); assert.equal(view.publishedCurrent, false);
  assert.throws(() => recordArtifactReview(f.room, { id: first.id, revision: 1, sha256: first.sha256, kind: "source", speaker: "claude" }), /Stale artifact review/);
  const second = upsertArtifact(f.room, { file: f.file, speaker: "claude" }).artifact;
  assert.equal(second.id, first.id); assert.equal(second.revision, 2); assert.notEqual(second.sha256, first.sha256);
  assert.equal(second.files.length, 2, "omitted assets preserve the explicit selection");
  assert.equal(second.ready, false);
  assert.equal(second.reviews.length, 1, "history remains attributed to its old revision");
  assert.deepEqual(artifactView(second).currentReviews, []);
  assert.equal(second.published.revision, 1);
  assert.throws(() => recordArtifactReview(f.room, { id: second.id, revision: 1, sha256: first.sha256, kind: "source", speaker: "astra" }), /Stale artifact review/);
  assert.throws(() => recordArtifactReview(f.room, { id: second.id, revision: 2, sha256: second.sha256, kind: "visual", speaker: "claude" }), /permitted render/);
  const review = { id: second.id, revision: 2, sha256: second.sha256, kind: "visual", speaker: "claude", via: "Permitted browser at desktop and phone widths" };
  recordArtifactReview(f.room, review);
  assert.equal(recordArtifactReview(f.room, review).duplicate, true);
  const final = upsertArtifact(f.room, { file: f.file, speaker: "astra", ready: true, url: "https://example.com/result", access: "public" }).artifact;
  assert.equal(final.revision, 2); assert.equal(final.published.revision, 2);
  assert.equal(artifactView(final).currentReviews.length, 1);
  assert.equal(artifactView(final).currentReviews[0].kind, "visual");
  assert.equal(artifactView(final).publishedCurrent, true);
});

test("artifact selection rejects traversal, symlinks, special paths, unsafe links and oversized files", t => {
  const f = fixture(t);
  for (const assets of [["../outside"], ["/absolute"], ["x/../style.css"], ["style.css", "style.css"], ["index.html"]])
    assert.throws(() => upsertArtifact(f.room, { file: f.file, assets, speaker: "astra" }), /relative file paths/);
  fs.symlinkSync(f.file, path.join(f.directory, "linked.html"));
  assert.throws(() => upsertArtifact(f.room, { file: f.file, assets: ["linked.html"], speaker: "astra" }), /symlinks/);
  assert.throws(() => upsertArtifact(f.room, { file: f.directory, speaker: "astra" }), /regular files/);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"])
    assert.throws(() => upsertArtifact(f.room, { file: f.file, speaker: "astra", url, access: "public" }), /http or https/);
  assert.throws(() => upsertArtifact(f.room, { file: f.file, speaker: "astra", url: "https://example.com" }), /--access/);
  assert.equal(f.room.artifacts, undefined, "failed registration doesn't mutate the record");
  fs.truncateSync(f.file, 50 * 1024 * 1024 + 1);
  assert.throws(() => upsertArtifact(f.room, { file: f.file, speaker: "astra" }), /50 MiB/);
});

test("missing and replaced canonical files cannot retain ready or reviewed status", t => {
  const f = fixture(t);
  const artifact = upsertArtifact(f.room, { file: f.file, speaker: "astra", ready: true }).artifact;
  recordArtifactReview(f.room, { id: artifact.id, revision: 1, sha256: artifact.sha256, kind: "source", speaker: "astra" });
  fs.unlinkSync(f.file);
  assert.equal(artifactView(artifact).availability, "missing");
  fs.symlinkSync(path.join(f.directory, "style.css"), f.file);
  const view = artifactView(artifact);
  assert.equal(view.availability, "unavailable"); assert.equal(view.ready, false); assert.deepEqual(view.currentReviews, []);
});
