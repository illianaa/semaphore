import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataHome as defaultHome, defaultRoomRoot, shellQuote } from "./paths.mjs";
import { RoomStore, Semaphore } from "./core.mjs";
import { roomCommands, inputNotice, takenNotice } from "./live.mjs";
import { queuedInputs } from "./inputs.mjs";
import { recordListenerObservation } from "./timing.mjs";
import { REFRESH_MS, validSession, signalPath, isRegistered, signalSession, disableRegistrations, enableRegistrations } from "./claude-registry.mjs";

// Claude chats without a listener, using only documented Claude Code hooks:
// - SessionStart and CwdChanged run `semaphore hook register` (claude-registry.mjs), which gives the
//   chat a private signal file and has Claude's own file watcher watch it.
// - When the chat has something waiting, the Semaphore app changes that file (ClaudeSignalPump).
// - FileChanged runs `semaphore hook wake` with asyncRewake: wakeCheck prints a short notice and
//   exits 2, which wakes the chat, idle or working. Receipts, revisions and the reply check are
//   unchanged. Proved in the desktop app on 27 September 2026 (docs/claude-event-delivery.md).

const ROOM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const bound = (room, id) => room.participants?.claude?.id === id && room.participants.claude.transport === "claude-inbox";
const replied = (room, turnId) => room.messages.some((m) => m.turnId === turnId && m.speaker === "claude");
const latestHuman = (room) => room.messages.filter((m) => m.speaker === "human").at(-1)?.seq ?? 0;
const shownThrough = (pending) => Math.max(...[pending.reviewThrough, pending.receivedThrough, pending.through].filter(Number.isInteger), 0);
const reviewOutstanding = (pending) => (pending.reviewThrough ?? 0) > (pending.receivedThrough ?? pending.through);

function roomNames(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && ROOM.test(e.name)).map((e) => e.name); }
  catch { return []; }
}

// Claim each notice under the room lock before handing it to the native hook. A claim is
// durable and never replayed, even after a restart or an ambiguous hook exit. Only receive
// marks messages read. Keep one review outstanding so a later input cannot stale its receipt.
function roomNotice(root, name, id, deadline) {
  const store = new RoomStore(root, name);
  const initial = store.read();
  if (!bound(initial, id) || initial.pending?.speaker !== "claude") return null;
  for (;;) {
    try { store.acquire(); break; }
    catch (error) {
      if (error.code !== "ROOM_LOCKED" || Date.now() > deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    const room = store.read();
    const pending = room.pending;
    if (!bound(room, id) || pending?.speaker !== "claude") return null;
    const claim = pending.claudeHook?.session === id ? pending.claudeHook : { session: id };
    if (pending.state === "awaiting-reply" && room.owner === "claude" && !pending.receivedAt) {
      if (claim.turnAt) return null;
      const { receive } = roomCommands({ room, turn: pending, speaker: "claude", root });
      const text = `Room “${room.title || name}” (${name}): it's your turn as Claude. Read and acknowledge it first:\n${receive}`;
      pending.claudeHook = { ...claim, turnAt: new Date().toISOString() };
      store.save(room);
      recordListenerObservation(store.dir, { roomId: room.id, session: id, turn: { id: pending.id, speaker: "claude" } });
      return { text };
    }
    if (pending.state === "awaiting-reply" && room.owner === "claude") {
      if (reviewOutstanding(pending) || (latestHuman(room) <= shownThrough(pending) && !queuedInputs(store.dir).length)) return null;
      const app = new Semaphore(store, {});
      const result = app.revealInput(pending.id, "claude");
      if (!result) return null;
      const text = inputNotice({ room: app.room, turn: app.room.pending, ...result }, { root, hooked: true });
      app.room.pending.claudeHook = { ...claim, inputThrough: result.revision, inputAt: new Date().toISOString() };
      app.save();
      return { text };
    }
    if (pending.state === "uncertain" && room.owner === "human" && pending.receivedAt && !replied(room, pending.id)) {
      if (claim.takenAt) return null;
      const text = takenNotice({ room, turnId: pending.id, speaker: "claude" }, { root, hooked: true });
      pending.claudeHook = { ...claim, takenAt: new Date().toISOString() };
      store.save(room);
      return { text };
    }
    return null;
  } finally { store.release(); }
}

// FileChanged. Exit code 2 wakes the chat with `text`; 0 does nothing. Any file that isn't this
// chat's own signal (other tools may watch files too) exits 0 at once.
export function wakeCheck(input, { home = defaultHome, root = defaultRoomRoot } = {}) {
  const id = input?.session_id;
  if (!validSession(id) || input.file_path !== signalPath(id, home) || input.event === "unlink" || !isRegistered(id, { home }))
    return { code: 0 };
  let signal = {};
  try { signal = JSON.parse(fs.readFileSync(signalPath(id, home), "utf8")); } catch {}
  const roots = [...new Set([root, ...(typeof signal?.root === "string" && path.isAbsolute(signal.root) ? [signal.root] : [])])];
  const notices = [];
  const deadline = Date.now() + 2000;
  for (const base of roots)
    for (const name of roomNames(base)) {
      try {
        const notice = roomNotice(base, name, id, deadline);
        if (notice) notices.push(notice);
      } catch { /* One damaged room must not block the others. */ }
    }
  if (!notices.length) return { code: 0 };
  return { code: 2, text: `Semaphore: a saved room message for this chat. This is Semaphore's Claude Code hook delivering it, not an error.\n\n${notices.map((n) => n.text).join("\n\n")}` };
}

// Runs in the Semaphore app beside the GPT wake pump. It signals a registered Claude chat when a
// turn is queued for it, when new human input arrives during its turn, and when the human takes
// the stick back. A queued turn or unshown input is signaled again at most once a minute until
// the hook has claimed it (for example once the chat is reopened). These retries are file writes,
// not model turns: a claimed notice never wakes the model again, including after an app restart.
export class ClaudeSignalPump {
  constructor({ root = defaultRoomRoot, home = defaultHome, intervalMs = 1000, now = Date.now } = {}) {
    Object.assign(this, { root, home, intervalMs, now });
    this.sent = new Map();
    this.rooms = new Map();
  }
  // Rooms are reparsed only when their file or input journal changes.
  summary(name) {
    const store = new RoomStore(this.root, name);
    const file = path.join(store.dir, "room.json");
    const inputs = path.join(store.dir, "human-inputs.sqlite");
    // A live SQLite connection can keep new input exclusively in the WAL.
    const stamp = [file, inputs, `${inputs}-wal`].map((file) => {
      try { const s = fs.statSync(file, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.size}`; }
      catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
    }).join("/");
    const cached = this.rooms.get(name);
    if (cached?.stamp === stamp) return cached;
    const room = store.read();
    const pending = room.pending;
    const summary = { stamp, dir: store.dir, owner: room.owner, seat: room.participants?.claude,
      pending: pending && { id: pending.id, speaker: pending.speaker, state: pending.state, receivedAt: pending.receivedAt,
        shown: shownThrough(pending), reviewing: reviewOutstanding(pending), hook: pending.claudeHook,
        replied: replied(room, pending.id) },
      latest: latestHuman(room) };
    const queued = pending?.speaker === "claude" && pending.receivedAt ? queuedInputs(store.dir).length : 0;
    // Sequence numbers count AI replies too, not just human messages.
    if (queued) summary.latest = Math.max(summary.latest, room.messages.length + queued);
    this.rooms.set(name, summary);
    return summary;
  }
  wants(s) {
    const pending = s.pending;
    if (!pending || pending.speaker !== "claude" || s.seat?.transport !== "claude-inbox" || !isRegistered(s.seat.id, { home: this.home })) return null;
    const claim = pending.hook?.session === s.seat.id ? pending.hook : {};
    if (pending.state === "awaiting-reply" && s.owner === "claude" && !pending.receivedAt)
      return claim.turnAt || fs.existsSync(path.join(s.dir, "inbox", "claude", "observed", `${pending.id}.json`)) ? null : { key: `${pending.id}:turn`, retry: true };
    if (pending.state === "awaiting-reply" && s.owner === "claude")
      return !pending.reviewing && s.latest > pending.shown ? { key: `${pending.id}:${s.latest}`, retry: true } : null;
    if (pending.state === "uncertain" && s.owner === "human" && pending.receivedAt && !pending.replied)
      return claim.takenAt ? null : { key: `${pending.id}:taken`, retry: true };
    return null;
  }
  tick() {
    const now = this.now();
    for (const name of roomNames(this.root)) {
      try {
        const summary = this.summary(name);
        const want = this.wants(summary);
        if (!want) continue;
        const key = `${name}:${want.key}`;
        const last = this.sent.get(key);
        if (last !== undefined && (!want.retry || now - last < REFRESH_MS)) continue;
        if (signalSession(summary.seat.id, { root: this.root, room: name, reason: want.key }, { home: this.home }))
          this.sent.set(key, now);
      } catch { /* A damaged or busy room is looked at again next tick. */ }
    }
    if (this.sent.size > 500) this.sent = new Map([...this.sent].slice(-250));
  }
  start() { this.timer = setInterval(() => this.tick(), this.intervalMs); this.timer.unref(); this.tick(); }
  close() { clearInterval(this.timer); }
}

// ~/.claude/settings.json: three entries identified by their Semaphore command; everything else is
// preserved, and a backup is written before any change.
const OURS = /^(?:'(?:[^']|'\\'')*\/bin\/semaphore'|\/[^\s'";|&<>`$]*\/bin\/semaphore) hook (register|wake)\s*$/;
export function claudeHookEntries(command) {
  const run = (verb) => `${shellQuote(command)} hook ${verb}`;
  return {
    SessionStart: { hooks: [{ type: "command", command: run("register"), timeout: 10 }] },
    CwdChanged: { hooks: [{ type: "command", command: run("register"), timeout: 10 }] },
    FileChanged: { hooks: [{ type: "command", command: run("wake"), asyncRewake: true, timeout: 10 }] },
  };
}
const ours = (group) => Array.isArray(group?.hooks) &&
  group.hooks.some((hook) => typeof hook?.command === "string" && OURS.test(hook.command));

function withoutOurs(settings) {
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== "object") return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].flatMap((group) => {
      if (!ours(group)) return [group];
      const hooks = group.hooks.filter((hook) => !(typeof hook?.command === "string" && OURS.test(hook.command)));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${file} is not a settings object.`);
  return settings;
}
function writeSettings(file, settings, { backupDir, now = new Date() }) {
  let backup = null;
  if (fs.existsSync(file)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    backup = path.join(backupDir, `claude-settings-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temp = `${file}.semaphore-${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", { mode, flag: "wx" });
  fs.renameSync(temp, file);
  return backup;
}

export function claudeHooksStatus({ settingsPath, command }) {
  const settings = readSettings(settingsPath);
  const want = claudeHookEntries(command);
  const present = Object.fromEntries(Object.keys(want).map((event) =>
    [event, (settings.hooks?.[event] ?? []).some((group) => JSON.stringify(group) === JSON.stringify(want[event]))]));
  const stale = Object.entries(settings.hooks ?? {}).some(([event, groups]) =>
    Array.isArray(groups) && groups.some((group) => ours(group) && JSON.stringify(group) !== JSON.stringify(want[event])));
  const disabled = settings.disableAllHooks === true;
  return { installed: Object.values(present).every(Boolean) && !stale && !disabled, present, stale, disabled };
}

export function installClaudeHooks({ settingsPath, command, backupDir, now, registryHome }) {
  const status = claudeHooksStatus({ settingsPath, command });
  if (status.disabled) throw new Error("Claude Code has disableAllHooks enabled. Semaphore left that setting unchanged; hooks cannot wake chats while it is enabled.");
  if (status.installed) {
    if (registryHome) enableRegistrations(registryHome);
    return { changed: false, backup: null };
  }
  const settings = withoutOurs(readSettings(settingsPath));
  settings.hooks ??= {};
  for (const [event, group] of Object.entries(claudeHookEntries(command)))
    settings.hooks[event] = [...(Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []), group];
  const backup = writeSettings(settingsPath, settings, { backupDir, now });
  if (registryHome) enableRegistrations(registryHome);
  return { changed: true, backup };
}

export function uninstallClaudeHooks({ settingsPath, backupDir, now, registryHome }) {
  const settings = readSettings(settingsPath);
  const next = withoutOurs(settings);
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  const backup = changed ? writeSettings(settingsPath, next, { backupDir, now }) : null;
  if (registryHome) disableRegistrations(registryHome);
  return { changed, backup };
}
