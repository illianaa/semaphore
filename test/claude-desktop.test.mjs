import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeDesktopSessions, continueLink } from "../lib/claude-desktop.mjs";

const CLI = "f9bdb53b-14f6-488f-9256-b0da362609ce";
const LOCAL = "local_906b48d3-0c1b-42ad-a23c-5abc1437544f";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-claude-desktop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "account-1", "org-1");
  fs.mkdirSync(folder, { recursive: true });
  const write = (local, record, name = `${local}.json`) =>
    fs.writeFileSync(path.join(folder, name), typeof record === "string" ? record : JSON.stringify({ sessionId: local, title: "Plan", cwd: "/tmp", ...record }));
  let now = 1_000_000;
  const sessions = new ClaudeDesktopSessions({ dir, now: () => now });
  return { dir, folder, write, sessions, tick: (ms) => { now += ms; } };
}

test("a bound Claude chat links to the desktop app's own continue route for that chat", (t) => {
  const f = fixture(t);
  f.write(LOCAL, { cliSessionId: CLI, isArchived: false, promptAppendSnapshot: "x".repeat(10_000) });
  f.write("local_other-chat", { cliSessionId: "11111111-2222-4333-8444-555555555555" });
  assert.equal(f.sessions.url(CLI), `claude://code/continue?session=${LOCAL}`);
  assert.equal(continueLink(LOCAL), "claude://code/continue?session=local_906b48d3-0c1b-42ad-a23c-5abc1437544f");
  assert.equal(f.sessions.url("11111111-2222-4333-8444-555555555555"), "claude://code/continue?session=local_other-chat");
});

test("no link for unknown, invalid, archived or malformed chats, and misses rescan only every 30 seconds", (t) => {
  const f = fixture(t);
  f.write("local_broken", "{not json");
  f.write("local_no-cli", {});
  f.write("not-local", { cliSessionId: CLI }, "notes.json");
  f.write("local_bad", { sessionId: "../escape", cliSessionId: CLI });
  for (const id of [CLI, "", undefined, "../../etc", "x"]) assert.equal(f.sessions.url(id), null);
  // A record created after a miss is found on the next scan, not on every poll.
  f.write(LOCAL, { cliSessionId: CLI });
  f.tick(10_000);
  assert.equal(f.sessions.url(CLI), null);
  f.tick(20_000);
  assert.equal(f.sessions.url(CLI), `claude://code/continue?session=${LOCAL}`);
  // Archiving it in the app removes the link once the record is checked again.
  f.write(LOCAL, { cliSessionId: CLI, isArchived: true });
  assert.equal(f.sessions.url(CLI), `claude://code/continue?session=${LOCAL}`, "cached between checks");
  f.tick(30_000);
  assert.equal(f.sessions.url(CLI), null);
  f.write(LOCAL, { cliSessionId: CLI, isArchived: false });
  f.tick(30_000);
  assert.equal(f.sessions.url(CLI), `claude://code/continue?session=${LOCAL}`, "restored");
  fs.rmSync(path.join(f.folder, `${LOCAL}.json`));
  f.tick(30_000);
  assert.equal(f.sessions.url(CLI), null, "deleted");
});

test("a missing desktop folder (another platform, or no Claude app) means no link and no error", () => {
  const sessions = new ClaudeDesktopSessions({ dir: path.join(os.tmpdir(), "semaphore-no-such-claude-folder") });
  assert.equal(sessions.url(CLI), null);
});
