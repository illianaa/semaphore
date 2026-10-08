import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore, Semaphore } from "../lib/core.mjs";
import { queueHumanInput } from "../lib/inputs.mjs";
import { sqliteDatabase } from "../lib/sqlite.mjs";
import { registerSession, signalSession, isRegistered, signalPath, recordPath } from "../lib/claude-registry.mjs";
import { wakeCheck, stopCheck, ClaudeSignalPump, requestClaudeWake, claudeHookEntries, claudeHooksStatus, installClaudeHooks, uninstallClaudeHooks } from "../lib/claude-wake.mjs";

const SESSION = "11111111-2222-4333-8444-5555c1a0de00";
const OTHER = "99999999-8888-4777-8666-555555555555";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-claude-wake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const root = path.join(dir, "rooms");
  // A room whose Claude seat is this native chat, with a queued Claude turn.
  const room = (name = "room", session = SESSION) => {
    const store = new RoomStore(root, name);
    store.acquire();
    const seed = store.loadOrCreate();
    seed.participants.claude = { transport: "claude-inbox", id: session, seen: 0 };
    seed.participants.astra = { transport: "astra-inbox", id: "0190f000-0000-7000-8000-00000000a57a", seen: 0 };
    store.save(seed);
    const app = new Semaphore(store, { claude: { kind: "claude-inbox", async deliver({ turn }) { return { status: "queued", transport: "claude-inbox", turnId: turn.id, at: new Date().toISOString() }; } } });
    return { store, app, done: () => store.release() };
  };
  const wake = (extra = {}) => wakeCheck({ session_id: SESSION, hook_event_name: "FileChanged", file_path: signalPath(SESSION, home), event: "change", ...extra }, { home, root });
  return { dir, home, root, room, wake };
}

test("registration gives each chat a private watched signal in the shape the runtime reads", (t) => {
  const f = fixture(t);
  assert.equal(registerSession({ session_id: "../escape" }, { home: f.home }), null);
  const out = registerSession({ session_id: SESSION, hook_event_name: "SessionStart", source: "startup" }, { home: f.home });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: [signalPath(SESSION, f.home)] } });
  assert.equal(fs.statSync(signalPath(SESSION, f.home)).mode & 0o777, 0o600);
  assert.equal(isRegistered(SESSION, { home: f.home }), true);
  assert.equal(registerSession({ session_id: SESSION, hook_event_name: "CwdChanged" }, { home: f.home }).hookSpecificOutput.hookEventName, "CwdChanged");
  // Re-registering never rewrites the signal, and a busy chat's frequent folder changes are cheap.
  const before = fs.statSync(recordPath(SESSION, f.home)).mtimeMs;
  registerSession({ session_id: SESSION, hook_event_name: "CwdChanged" }, { home: f.home, now: Date.now() + 1000 });
  assert.equal(fs.statSync(recordPath(SESSION, f.home)).mtimeMs, before);
  assert.equal(isRegistered(OTHER, { home: f.home }), false);
  assert.equal(signalSession(OTHER, { room: "x" }, { home: f.home }), false, "an unregistered chat is never signaled");
  const inode = fs.statSync(signalPath(SESSION, f.home)).ino;
  assert.equal(signalSession(SESSION, { room: "room" }, { home: f.home }), true);
  assert.equal(fs.statSync(signalPath(SESSION, f.home)).ino, inode, "written in place, so the watcher keeps following it");
});

test("the wake check stays silent for anything but this chat's own saved room message", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  assert.equal(f.wake({ file_path: "/tmp/.envrc" }).code, 0, "other watched files are ignored");
  assert.equal(f.wake({ event: "unlink" }).code, 0);
  assert.equal(f.wake({ session_id: OTHER, file_path: signalPath(OTHER, f.home) }).code, 0, "unregistered chats get nothing");
  assert.equal(f.wake().code, 0, "no room, nothing to say");
  // A room bound to another chat never leaks into this one.
  const other = f.room("elsewhere", OTHER);
  await other.app.send("For the other chat", "claude");
  other.done();
  assert.equal(f.wake().code, 0);
});

test("a queued turn wakes the chat once with its receive command and tells the app the chat has it", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Please review the plan", "claude");
  const id = r.app.room.pending.id;
  r.done();
  const woke = f.wake();
  assert.equal(woke.code, 2);
  assert.match(woke.text, /^Semaphore: a saved room message for this chat\. This is Semaphore's Claude Code hook delivering it, not an error\./);
  assert.match(woke.text, new RegExp(`it's your turn as Claude\\. Read and acknowledge it first:\\nnode .*cli\\.mjs'? receive room --root .* --turn ${id}`));
  assert.doesNotMatch(woke.text, /listen/);
  assert.ok(fs.existsSync(path.join(f.root, "room", "inbox", "claude", "observed", `${id}.json`)), "the app can show the chat has it");
  assert.equal(f.wake().code, 0, "the same notice isn't repeated within a minute");
  assert.equal(f.wake().code, 0);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now: Date.now() + 120_000 });
  assert.equal(wakeCheck({ session_id: SESSION, file_path: signalPath(SESSION, f.home) },
    { home: f.home, root: f.root, now: Date.now() + 120_000 }).code, 0, "a later signal or re-registration never replays the claimed turn");
});

test("input during a received turn is shown with its revision, not marked read, and later input is new", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Start", "claude");
  const id = r.app.room.pending.id;
  r.app.receive(id, "claude");
  r.done();
  assert.equal(f.wake().code, 0, "nothing new yet");
  queueHumanInput(new RoomStore(f.root, "room"), { text: "Crucial: use staging", to: "claude", clientId: "hook-input-001" });
  const woke = f.wake();
  assert.equal(woke.code, 2);
  assert.match(woke.text, /Human → Claude:\nCrucial: use staging/);
  assert.match(woke.text, new RegExp(`--turn ${id} --revision 2`));
  assert.match(woke.text, /no listener is needed/);
  assert.doesNotMatch(woke.text, / listen /);
  const saved = new RoomStore(f.root, "room").read();
  assert.equal(saved.pending.reviewThrough, 2);
  assert.equal(saved.messages[1].readAt, undefined);
  queueHumanInput(new RoomStore(f.root, "room"), { text: "And keep it short", to: "claude", clientId: "hook-input-002" });
  assert.equal(f.wake().code, 0, "the earlier receipt stays valid until acknowledged");
  const store = new RoomStore(f.root, "room");
  assert.equal(store.read().pending.reviewThrough, 2);
  store.acquire();
  try { new Semaphore(store, {}).receive(id, "claude", 2); } finally { store.release(); }
  const next = f.wake();
  assert.match(next.text, /--revision 3/, "acknowledgment releases the next batch");
  assert.doesNotMatch(next.text, /Crucial: use staging/);
  assert.equal(store.read().messages[2].readAt, undefined);
});

test("taking the stick back from a working chat tells it once to stop", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Long task", "claude");
  const id = r.app.room.pending.id;
  r.app.receive(id, "claude");
  r.app.takeStick();
  r.done();
  const woke = f.wake();
  assert.equal(woke.code, 2);
  assert.match(woke.text, new RegExp(`during your turn ${id}, so that turn is over: stop working on it and don't reply to it`));
  assert.match(woke.text, /no listener is needed\. End your turn now\./);
  assert.equal(f.wake().code, 0);
});

test("the app signals a registered chat for a turn, input and take-back, and retries only undelivered turns", async (t) => {
  const f = fixture(t);
  let now = 1_000_000;
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home, now: () => now });
  const signal = () => fs.readFileSync(signalPath(SESSION, f.home), "utf8");
  const r = f.room();
  await r.app.send("Please review", "claude");
  const id = r.app.room.pending.id;
  r.done();
  pump.tick();
  assert.equal(fs.existsSync(signalPath(SESSION, f.home)), false, "an unregistered chat is never signaled");
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  pump.tick();
  assert.match(signal(), new RegExp(`"reason":"${id}:turn"`));
  fs.writeFileSync(signalPath(SESSION, f.home), "");
  now += 30_000; pump.tick();
  assert.equal(signal(), "", "not again within a minute");
  now += 31_000; pump.tick();
  assert.match(signal(), /:turn"/, "a turn the chat hasn't picked up is signaled again (it may have been closed)");
  f.wake(); // The hook delivers it.
  fs.writeFileSync(signalPath(SESSION, f.home), "");
  now += 61_000; pump.tick();
  assert.equal(signal(), "", "delivered turns are not signaled again");
  const store = new RoomStore(f.root, "room"); store.acquire();
  const app = new Semaphore(store, {});
  app.receive(id, "claude");
  store.release();
  queueHumanInput(new RoomStore(f.root, "room"), { text: "One more thing", to: "claude", clientId: "pump-input-001" });
  pump.tick();
  assert.match(signal(), new RegExp(`"reason":"${id}:2"`));
  fs.writeFileSync(signalPath(SESSION, f.home), "");
  f.wake(); // Shown with its revision.
  now += 61_000; pump.tick();
  assert.equal(signal(), "", "shown input is not signaled again");
  store.acquire(); new Semaphore(store, {}).takeStick(); store.release();
  pump.tick();
  assert.match(signal(), /:taken"/);
  f.wake(); // A take-back is retried only until the hook claims it.
  fs.writeFileSync(signalPath(SESSION, f.home), "");
  now += 61_000; pump.tick();
  assert.equal(signal(), "", "a take-back is signaled once");
  new ClaudeSignalPump({ root: f.root, home: f.home }).tick();
  assert.equal(signal(), "", "restarting the app cannot replay the take-back");
});

test("Wake Claude replays a claimed turn the chat never started, once, and is signaled at once", async (t) => {
  const f = fixture(t);
  let now = 1_000_000;
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home, now: () => now });
  const signal = () => fs.readFileSync(signalPath(SESSION, f.home), "utf8");
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Please review", "claude");
  const id = r.app.room.pending.id;
  r.done();
  assert.equal(f.wake().code, 2, "the hook claims the turn");
  fs.writeFileSync(signalPath(SESSION, f.home), "");
  now += 120_000; pump.tick();
  assert.equal(signal(), "", "a claimed turn is never signaled again on its own");
  assert.equal(f.wake().code, 0);
  // The chat never ran receive. The person presses Wake Claude.
  const store = new RoomStore(f.root, "room");
  store.acquire();
  try { requestClaudeWake(new Semaphore(store, {}), { home: f.home }); } finally { store.release(); }
  assert.equal(store.read().events.at(-1).type, "wake-requested");
  pump.tick();
  assert.match(signal(), new RegExp(`"reason":"${id}:wake:`));
  const woke = f.wake();
  assert.equal(woke.code, 2);
  assert.match(woke.text, /the person pressed Wake Claude because this turn hasn't started yet\. it's your turn as Claude\. Read and acknowledge it first:/);
  assert.match(woke.text, new RegExp(`receive room --root .* --turn ${id}`));
  assert.equal(f.wake().code, 0, "one request, one replay");
  fs.writeFileSync(signalPath(SESSION, f.home), "");
  now += 120_000; pump.tick();
  assert.equal(signal(), "", "an answered request isn't signaled again");
});

test("Open chat: a chat the app restarts after the click is signaled again within seconds, not a minute later", async (t) => {
  // The 7 October field case: the click signaled at once, the app started the chat's session 0.7 s
  // later, and the next retry came a minute after that.
  const f = fixture(t);
  let now = Date.now();
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home, now: () => now });
  const signal = () => fs.readFileSync(signalPath(SESSION, f.home), "utf8");
  const sent = () => { const text = signal(); fs.writeFileSync(signalPath(SESSION, f.home), ""); return text; };
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now: now - 3_600_000 });
  const r = f.room();
  await r.app.send("Please review", "claude");
  const id = r.app.room.pending.id;
  r.done();
  assert.equal(f.wake().code, 2, "claimed earlier, then the chat's session was unloaded");
  now += 300_000;
  const store = new RoomStore(f.root, "room");
  store.acquire();
  try { requestClaudeWake(new Semaphore(store, {}), { home: f.home }); } finally { store.release(); }
  now = Date.parse(store.read().pending.claudeHook.wakeRequestedAt);
  pump.tick();
  assert.match(sent(), new RegExp(`"reason":"${id}:wake:`), "signaled at the click; nothing watches yet");
  now += 700;
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now });
  now += 300; pump.tick();
  assert.equal(sent(), "", "not before its watcher is armed");
  now += 2_000; pump.tick();
  assert.match(sent(), /:wake:/, "about two seconds after the chat started");
  assert.equal(f.wake().code, 2, "the opened chat takes its turn");
  now += 5_000; pump.tick();
  assert.equal(sent(), "", "answered: no more signals");
});

test("an unanswered Open chat request is retried every five seconds for ten minutes, then every minute", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home, now: () => now });
  const sent = () => { const text = fs.readFileSync(signalPath(SESSION, f.home), "utf8"); fs.writeFileSync(signalPath(SESSION, f.home), ""); return text; };
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now: now - 3_600_000 });
  const r = f.room();
  await r.app.send("Long task", "claude");
  r.app.receive(r.app.room.pending.id, "claude");
  requestClaudeWake(r.app, { home: f.home });
  r.done();
  now = Date.parse(new RoomStore(f.root, "room").read().pending.claudeHook.wakeRequestedAt);
  pump.tick();
  assert.match(sent(), /:check-in:/);
  now += 4_000; pump.tick();
  assert.equal(sent(), "");
  now += 1_000; pump.tick();
  assert.match(sent(), /:check-in:/, "five seconds later");
  now += 10 * 60_000; pump.tick();
  assert.match(sent(), /:check-in:/);
  now += 30_000; pump.tick();
  assert.equal(sent(), "", "after ten minutes, back to once a minute");
  now += 30_000; pump.tick();
  assert.match(sent(), /:check-in:/);
});

test("a signal sent during watcher startup is retried after arming, even when newer than registration", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home, now: () => now });
  const sent = () => { const text = fs.readFileSync(signalPath(SESSION, f.home), "utf8"); fs.writeFileSync(signalPath(SESSION, f.home), ""); return text; };
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now });
  const r = f.room();
  await r.app.send("Please review", "claude");
  r.done();
  now += 500; pump.tick();
  assert.match(sent(), /:turn"/, "the first signal may arrive before the watcher is armed");
  now += 1_000; pump.tick();
  assert.equal(sent(), "");
  now += 500; pump.tick();
  assert.match(sent(), /:turn"/, "retry after arming instead of waiting a minute");
  now += 1_000; pump.tick();
  assert.equal(sent(), "", "one post-registration signal");
  assert.equal(f.wake().code, 2);
  now += 60_000; pump.tick();
  assert.equal(sent(), "", "a claimed notice stays claimed");
});

test("a queued turn reaches a chat the person reopens in the Claude app, without any button", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home, now: () => now });
  const sent = () => { const text = fs.readFileSync(signalPath(SESSION, f.home), "utf8"); fs.writeFileSync(signalPath(SESSION, f.home), ""); return text; };
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now: now - 3_600_000 });
  const r = f.room();
  await r.app.send("Please review", "claude");
  r.done();
  pump.tick();
  assert.match(sent(), /:turn"/, "the app's session is closed, so this is missed");
  now += 20_000;
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home, now });
  now += 2_000; pump.tick();
  assert.match(sent(), /:turn"/, "re-signaled once the reopened chat is watching, not 40 seconds later");
  now += 2_000; pump.tick();
  assert.equal(sent(), "", "once per restart");
});

test("a chat that restarts before starting its claimed turn gets the turn again, once, without any button", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart", source: "startup" }, { home: f.home, now: Date.now() - 3_600_000 });
  const r = f.room();
  await r.app.send("Please review", "claude");
  const id = r.app.room.pending.id;
  r.done();
  assert.equal(f.wake().code, 2, "claimed, then the app quit before the chat acted");
  assert.equal(f.wake().code, 0);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart", source: "compact" }, { home: f.home });
  assert.equal(f.wake().code, 0, "compacting the context is not a restart");
  await new Promise((resolve) => setTimeout(resolve, 5));
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart", source: "resume" }, { home: f.home });
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home });
  assert.match(JSON.stringify(pump.wants(pump.summary("room"))), /:restart:/);
  const again = f.wake();
  assert.equal(again.code, 2);
  assert.match(again.text, /this chat restarted before it started this turn, so here it is again\. it's your turn as Claude/);
  assert.match(again.text, new RegExp(`--turn ${id}`));
  assert.equal(f.wake().code, 0, "once per restart");
  assert.equal(new ClaudeSignalPump({ root: f.root, home: f.home }).wants(pump.summary("room")), null);
});

test("a chat that restarts while holding a received turn is asked to check in, once", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart", source: "startup" }, { home: f.home, now: Date.now() - 3_600_000 });
  const r = f.room();
  await r.app.send("Long task", "claude");
  r.app.receive(r.app.room.pending.id, "claude");
  r.done();
  assert.equal(f.wake().code, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart", source: "resume" }, { home: f.home });
  const woke = f.wake();
  assert.equal(woke.code, 2);
  assert.match(woke.text, /this chat restarted while it held a turn\. You still hold the stick/);
  assert.equal(f.wake().code, 0);
});

test("Wake Claude asks a chat that received its turn and went quiet to check in, once", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Long task", "claude");
  const id = r.app.room.pending.id;
  r.app.receive(id, "claude");
  r.done();
  assert.equal(f.wake().code, 0, "nothing to say while it works");
  const store = new RoomStore(f.root, "room");
  store.acquire();
  try { requestClaudeWake(new Semaphore(store, {}), { home: f.home }); } finally { store.release(); }
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home });
  pump.tick();
  assert.match(fs.readFileSync(signalPath(SESSION, f.home), "utf8"), new RegExp(`"reason":"${id}:check-in:`));
  const woke = f.wake();
  assert.equal(woke.code, 2);
  assert.match(woke.text, new RegExp(`the person pressed Wake Claude\\. You still hold the stick for turn ${id}, which you already received\\. If your work is done, send your reply now:\\nnode .*reply room --root .* --turn ${id} --next <human\\|gpt\\|claude>`));
  assert.match(woke.text, /post a status note/);
  assert.equal(f.wake().code, 0);
  // Human input that arrives with a pending request answers it too; no separate check-in follows.
  store.acquire();
  try { requestClaudeWake(new Semaphore(store, {}), { home: f.home }); } finally { store.release(); }
  queueHumanInput(new RoomStore(f.root, "room"), { text: "Are you still on it?", to: "claude", clientId: "wake-input-001" });
  const input = f.wake();
  assert.match(input.text, /Human → Claude:\nAre you still on it\?/);
  assert.equal(f.wake().code, 0);
});

test("Wake Claude is refused unless a hooked Claude chat holds a turn", async (t) => {
  const f = fixture(t);
  const r = f.room();
  assert.throws(() => requestClaudeWake(r.app, { home: f.home }), /Claude doesn't hold a turn/);
  await r.app.send("Please review", "claude");
  assert.throws(() => requestClaudeWake(r.app, { home: f.home }), /can't wake this Claude chat from here/, "an unregistered chat");
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  r.app.takeStick();
  assert.throws(() => requestClaudeWake(r.app, { home: f.home }), /Claude doesn't hold a turn/);
  r.done();
});

test("concurrent native file events claim only one wake for the same turn", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room(); await r.app.send("One wake only", "claude"); r.done();
  const module = new URL("../lib/claude-wake.mjs", import.meta.url).href;
  const script = `import { wakeCheck } from ${JSON.stringify(module)};
    console.log(JSON.stringify(wakeCheck(${JSON.stringify({ session_id: SESSION, file_path: signalPath(SESSION, f.home) })},
      ${JSON.stringify({ home: f.home, root: f.root })})));`;
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
  const results = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(results.filter((r) => JSON.parse(r.stdout).code === 2).length, 1);
});

test("the pump sees journal input after intervening AI messages and uncheckpointed WAL writes", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Starting human input", "claude");
  r.app.append("astra", "An intervening AI reply", "claude");
  r.app.room.pending.through = 2;
  r.app.receive(r.app.room.pending.id, "claude");
  r.done();
  const file = path.join(r.store.dir, "human-inputs.sqlite");
  const db = new (sqliteDatabase())(file);
  t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home });
  pump.tick();
  const before = fs.statSync(file).mtimeMs;
  queueHumanInput(r.store, { text: "Guidance after the AI reply", to: "claude", clientId: "wal-input-001" });
  assert.equal(fs.statSync(file).mtimeMs, before, "the main database file did not change");
  assert.ok(fs.statSync(`${file}-wal`).size > 0);
  pump.tick();
  assert.match(fs.readFileSync(signalPath(SESSION, f.home), "utf8"), /:3"/);
  assert.match(f.wake().text, /Guidance after the AI reply/);
});

test("hook settings install beside existing settings, are idempotent, and uninstall only Semaphore's entries", (t) => {
  const f = fixture(t);
  const settingsPath = path.join(f.dir, "claude", "settings.json");
  const backupDir = path.join(f.dir, "backups");
  const command = path.join(f.home, "bin", "semaphore");
  const theirs = { type: "command", command: "direnv reload" };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, alwaysThinkingEnabled: true,
    hooks: { CwdChanged: [{ hooks: [theirs] }] } }), { mode: 0o600 });
  assert.equal(claudeHooksStatus({ settingsPath, command }).installed, false);
  const first = installClaudeHooks({ settingsPath, command, backupDir });
  assert.equal(first.changed, true);
  assert.ok(fs.existsSync(first.backup));
  const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(installed.permissions, { allow: ["Bash(ls)"] });
  assert.equal(installed.alwaysThinkingEnabled, true);
  assert.deepEqual(installed.hooks.CwdChanged[0], { hooks: [theirs] }, "their hook stays first and untouched");
  const want = claudeHookEntries(command);
  assert.deepEqual(installed.hooks.SessionStart, [want.SessionStart]);
  assert.deepEqual(installed.hooks.FileChanged, [want.FileChanged]);
  assert.equal(want.FileChanged.hooks[0].asyncRewake, true);
  assert.deepEqual(installed.hooks.Stop, [want.Stop]);
  assert.match(want.Stop.hooks[0].command, /\/bin\/semaphore' hook stop$|\/bin\/semaphore hook stop$/);
  assert.equal(want.Stop.hooks[0].asyncRewake, undefined, "the stop check runs before the chat stops, not in the background");
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, "the file keeps its permissions");
  assert.equal(claudeHooksStatus({ settingsPath, command }).installed, true);
  assert.equal(installClaudeHooks({ settingsPath, command, backupDir }).changed, false, "idempotent");
  // A moved installation replaces its old entries instead of adding more.
  const moved = path.join(f.dir, "elsewhere", "bin", "semaphore");
  assert.equal(claudeHooksStatus({ settingsPath, command: moved }).stale, true);
  installClaudeHooks({ settingsPath, command: moved, backupDir });
  const replaced = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(replaced.hooks.SessionStart.length, 1);
  assert.equal(replaced.hooks.CwdChanged.length, 2);
  const removed = uninstallClaudeHooks({ settingsPath, backupDir });
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { permissions: { allow: ["Bash(ls)"] }, alwaysThinkingEnabled: true,
    hooks: { CwdChanged: [{ hooks: [theirs] }] } });
  assert.equal(uninstallClaudeHooks({ settingsPath, backupDir }).changed, false);
});

test("an install from before the Stop check upgrades in place and keeps everything else", (t) => {
  const f = fixture(t);
  const settingsPath = path.join(f.dir, "settings.json");
  const command = path.join(f.home, "bin", "semaphore");
  const options = { settingsPath, command, backupDir: path.join(f.dir, "backups") };
  const theirs = { hooks: [{ type: "command", command: "say done" }] };
  const { Stop, ...older } = claudeHookEntries(command);
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { ...Object.fromEntries(Object.entries(older).map(([event, group]) => [event, [group]])), Stop: [theirs] }, model: "opus" }));
  const before = claudeHooksStatus(options);
  assert.equal(before.installed, false);
  assert.equal(before.present.Stop, false);
  assert.equal(before.present.FileChanged, true);
  assert.equal(installClaudeHooks(options).changed, true);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(after.hooks.Stop, [theirs, Stop], "their Stop hook stays first");
  assert.equal(after.hooks.FileChanged.length, 1, "no duplicate entries");
  assert.equal(after.model, "opus");
  assert.equal(claudeHooksStatus(options).installed, true);
  assert.equal(installClaudeHooks(options).changed, false);
  uninstallClaudeHooks(options);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { hooks: { Stop: [theirs] }, model: "opus" });
});

test("hook status and reinstall tolerate settings key reordering without rewriting the file", (t) => {
  const f = fixture(t);
  const settingsPath = path.join(f.dir, "settings.json");
  const options = { settingsPath, command: path.join(f.home, "bin", "semaphore"), backupDir: path.join(f.dir, "backups") };
  const entries = claudeHookEntries(options.command);
  for (const group of Object.values(entries))
    group.hooks = group.hooks.map(hook => Object.fromEntries(Object.entries(hook).reverse()));
  const content = JSON.stringify({ hooks: Object.fromEntries(Object.entries(entries).map(([event, group]) => [event, [group]])) });
  fs.writeFileSync(settingsPath, content);
  assert.equal(claudeHooksStatus(options).installed, true);
  assert.equal(claudeHooksStatus(options).stale, false);
  assert.deepEqual(installClaudeHooks(options), { changed: false, backup: null });
  assert.equal(fs.readFileSync(settingsPath, "utf8"), content);
});

test("the Stop check reminds a chat once per turn while it holds a received, unanswered turn", async (t) => {
  const f = fixture(t);
  const stop = (extra = {}) => stopCheck({ session_id: SESSION, hook_event_name: "Stop", stop_hook_active: false, ...extra }, { home: f.home, root: f.root });
  const r = f.room();
  await r.app.send("Install the release", "claude");
  const id = r.app.room.pending.id;
  r.app.receive(id, "claude");
  r.done();
  assert.deepEqual(stop(), { block: false }, "an unregistered chat is never held");
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  assert.deepEqual(stop({ session_id: OTHER }), { block: false }, "another chat's turn is not this chat's business");
  const first = stop({ stop_hook_active: true });
  assert.equal(first.block, true, "Semaphore's own wake-ups can make stop_hook_active true; the per-turn claim is the guard");
  assert.match(first.reason, /^Semaphore: before you stop, answer your room turn\. This reminder appears once per turn\./);
  assert.match(first.reason, new RegExp(`you still hold the talking stick for turn ${id}, which you received but haven't answered`));
  assert.match(first.reason, new RegExp(`Done\\? Reply now: node .*reply room --root .* --turn ${id} --next <human\\|gpt\\|claude>`));
  assert.match(first.reason, /Blocked .*file it as a blocking request, and pass to human:\n  node .*ask room --root .* --turn .* --blocking /);
  assert.doesNotMatch(first.reason, /\[--blocking\]/);
  assert.match(first.reason, /Still working on purpose .*Post a status note, then you may stop: node .*note room/);
  const saved = new RoomStore(f.root, "room").read();
  assert.ok(saved.pending.claudeHook.stopReminderAt);
  assert.equal(saved.messages.length, 1, "nothing is said on the chat's behalf");
  assert.equal(saved.owner, "claude", "and the stick isn't released for it");
  assert.equal(saved.pending.state, "awaiting-reply");
  assert.deepEqual(stop(), { block: false }, "the second stop in the same turn goes through, so it can't loop");
  assert.deepEqual(new ClaudeSignalPump({ root: f.root, home: f.home }).wants(new ClaudeSignalPump({ root: f.root, home: f.home }).summary("room")), null,
    "the reminder never makes the app wake the chat");
});

test("the Stop check stays out of the way: queued, replied, taken, ended, busy or damaged rooms", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const stop = () => stopCheck({ session_id: SESSION, hook_event_name: "Stop" }, { home: f.home, root: f.root });
  const r = f.room();
  await r.app.send("Review the plan", "claude");
  const id = r.app.room.pending.id;
  assert.deepEqual(stop(), { block: false }, "a turn the chat hasn't received is left to the wake path");
  r.app.receive(id, "claude");
  await r.app.accept({ turnId: id, speaker: "claude", message: "Reviewed.", next: "human" });
  assert.deepEqual(stop(), { block: false }, "answered");
  await r.app.send("One more pass", "claude");
  const second = r.app.room.pending.id;
  r.app.receive(second, "claude");
  r.app.takeStick();
  assert.deepEqual(stop(), { block: false }, "taken back");
  r.app.recover();
  await r.app.send("Last pass", "claude");
  const third = r.app.room.pending.id;
  r.app.receive(third, "claude");
  // Someone else is saving the room: let the chat stop, and don't use up the reminder.
  assert.deepEqual(stopCheck({ session_id: SESSION }, { home: f.home, root: f.root }), { block: false });
  r.done();
  fs.mkdirSync(path.join(f.root, "broken"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "broken", "room.json"), "{not json");
  const reminded = stop();
  assert.equal(reminded.block, true, "a damaged room doesn't hide the others");
  assert.match(reminded.reason, new RegExp(`turn ${third}`));
  const store = new RoomStore(f.root, "room");
  store.acquire();
  try {
    const app = new Semaphore(store, {});
    delete app.room.pending.claudeHook;
    app.save();
    app.end();
  } finally { store.release(); }
  assert.deepEqual(stop(), { block: false }, "ended");
});

test("concurrent Stop hook processes remind once, and bad input never blocks a chat", async (t) => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  const r = f.room();
  await r.app.send("Ship it", "claude");
  r.app.receive(r.app.room.pending.id, "claude");
  r.done();
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cli.mjs");
  const env = { ...process.env, SEMAPHORE_HOME: f.home };
  const hook = (input) => new Promise((resolve) => {
    const child = execFile(process.execPath, [cli, "hook", "stop", "--root", f.root], { env }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(input);
  });
  const event = JSON.stringify({ session_id: SESSION, hook_event_name: "Stop", stop_hook_active: false });
  const results = await Promise.all([hook(event), hook(event), hook(event)]);
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0]);
  const blocked = results.filter((result) => result.stdout);
  assert.equal(blocked.length, 1, "exactly one process claims the reminder");
  assert.equal(new RoomStore(f.root, "room").read().pending.claudeHook.stoppedAt, undefined,
    "processes racing the reminder's own stop don't count as Claude stopping again");
  const decision = JSON.parse(blocked[0].stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /you still hold the talking stick/);
  for (const input of ["", "not json", "[]", JSON.stringify({ session_id: "../escape" })]) {
    const result = await hook(input);
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, "", ""]);
  }
});

test("uninstall preserves mixed hook groups and revokes stale automatic-wake registrations", (t) => {
  const f = fixture(t);
  const settingsPath = path.join(f.dir, "settings.json");
  const command = path.join(f.home, "bin", "semaphore");
  const options = { settingsPath, command, backupDir: path.join(f.dir, "backups"), registryHome: f.home };
  const other = { type: "command", command: "another-semaphore hook wake" };
  const mixed = { matcher: "*", hooks: [other, ...claudeHookEntries(command).FileChanged.hooks] };
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { FileChanged: [mixed] }, custom: true }));
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  uninstallClaudeHooks(options);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
    hooks: { FileChanged: [{ matcher: "*", hooks: [other] }] }, custom: true,
  });
  assert.equal(isRegistered(SESSION, { home: f.home }), false);
  assert.equal(registerSession({ session_id: SESSION, hook_event_name: "CwdChanged" }, { home: f.home }), null,
    "a hook still running while settings reload cannot re-enable an uninstalled route");
  installClaudeHooks(options);
  assert.equal(isRegistered(SESSION, { home: f.home }), false, "reinstall requires a fresh native registration");
  registerSession({ session_id: SESSION, hook_event_name: "SessionStart" }, { home: f.home });
  assert.equal(isRegistered(SESSION, { home: f.home }), true);
  fs.writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true }));
  assert.equal(claudeHooksStatus(options).disabled, true);
  assert.throws(() => installClaudeHooks(options), /disableAllHooks/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { disableAllHooks: true });
});

test('ending wakes a working Claude once with a stop notice, including after take-back', async t => {
  const f = fixture(t);
  registerSession({ session_id: SESSION, hook_event_name: 'SessionStart' }, { home: f.home });
  const { app, store, done } = f.room();
  await app.send('Work on this', 'claude');
  app.receive(app.room.pending.id, 'claude');
  app.takeStick(); done();
  assert.match(f.wake().text, /took the stick back/);
  store.acquire();
  new Semaphore(store, {}).end();
  store.release();
  const pump = new ClaudeSignalPump({ root: f.root, home: f.home });
  assert.match(pump.wants(pump.summary('room')).key, /:ended:/);
  const notice = f.wake();
  assert.equal(notice.code, 2);
  assert.match(notice.text, /person ended this conversation/);
  assert.match(notice.text, /Do not reply, restart a listener/);
  assert.equal(f.wake().code, 0);
  assert.equal(pump.wants(pump.summary('room')), null);
});
