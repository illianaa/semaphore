import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderTranscript } from "../lib/transcript.mjs";
import { RoomStore } from "../lib/core.mjs";

const room = {
  name: "first-live",
  owner: "human",
  pending: null,
  participants: {
    astra: { id: "a", transport: "codex-queue" },
    claude: { id: "c", transport: "claude-inbox" },
  },
  messages: [
    {
      seq: 1,
      speaker: "human",
      text: 'Hello <script>alert("no")</script> & welcome',
      next: "astra",
      via: "astra",
      at: "2026-09-22T17:00:00Z",
    },
    {
      seq: 2,
      speaker: "astra",
      text: "GPT replies.",
      next: "claude",
      at: "2026-09-22T17:01:00Z",
    },
    {
      seq: 3,
      speaker: "claude",
      text: "Claude replies.",
      next: "human",
      at: "2026-09-22T17:02:00Z",
    },
  ],
};

test("shared view preserves ordered speakers, routing, and literal message text", () => {
  const html = renderTranscript({
    ...room,
    name: "<img src=x onerror=alert(1)>",
  });
  assert.ok(html.indexOf('id="message-1"') < html.indexOf('id="message-2"'));
  assert.ok(html.indexOf('id="message-2"') < html.indexOf('id="message-3"'));
  for (const name of ["You", "GPT", "Claude"])
    assert.ok(html.includes(`<strong>${name}</strong>`));
  assert.match(html, /Shared from GPT’s chat/);
  assert.match(
    html,
    /&lt;script&gt;alert\(&quot;no&quot;\)&lt;\/script&gt; &amp; welcome/,
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<script>alert/);
  assert.match(html, /Your turn · speak in either desktop chat/);
  assert.match(html, /3 shared messages/);
});

test("view distinguishes pending delivery, waiting for reply, and uncertainty", () => {
  for (const [state, text] of [
    ["delivering", "Passing the stick to Claude"],
    ["awaiting-reply", "Waiting for Claude’s reply"],
    ["uncertain", "Paused · delivery needs review"],
  ]) {
    assert.ok(
      renderTranscript({
        ...room,
        owner: "claude",
        pending: { state, speaker: "claude" },
      }).includes(text),
    );
  }
});

test("every committed save updates the view; a failed view leaves the journal committed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-view-"));
  const store = new RoomStore(root, "view-test");
  store.acquire();
  t.after(() => {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const saved = store.loadOrCreate();
  const view = path.join(store.dir, "transcript.html");
  assert.match(fs.readFileSync(view, "utf8"), /The room is ready/);
  saved.messages = room.messages;
  store.save(saved);
  assert.match(fs.readFileSync(view, "utf8"), /Claude replies/);
  assert.equal(fs.statSync(view).mode & 0o777, 0o600);
  fs.unlinkSync(view);
  fs.mkdirSync(view); // Force the derived file's rename to fail.
  saved.owner = "astra";
  assert.doesNotThrow(() => store.save(saved));
  assert.equal(store.read().owner, "astra");
  assert.ok(store.transcriptError);
  assert.equal(
    fs.readdirSync(store.dir).some((file) => file.endsWith(".tmp")),
    false,
  );
  fs.rmdirSync(view);
  store.save(saved);
  assert.equal(store.transcriptError, null);
  assert.match(fs.readFileSync(view, "utf8"), /Talking stick: GPT/);
});
