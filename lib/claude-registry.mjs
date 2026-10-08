import fs from "node:fs";
import path from "node:path";
import { dataHome as defaultHome } from "./paths.mjs";

// Which Claude chats Semaphore can wake without a listener. A Claude Code hook registers each chat
// (see claude-wake.mjs); the Semaphore app writes that chat's signal file to wake it. Only the file
// system is used here, so anything may import this module.

const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
export const REFRESH_MS = 60_000;

export function claudeWakePaths(home = defaultHome) {
  const dir = path.join(home, "claude");
  return { dir, signals: path.join(dir, "signals"), sessions: path.join(dir, "sessions") };
}
export const validSession = (id) => SESSION.test(id ?? "");
export const signalPath = (id, home = defaultHome) => path.join(claudeWakePaths(home).signals, id);
export const recordPath = (id, home = defaultHome) => path.join(claudeWakePaths(home).sessions, `${id}.json`);

export function readRecord(id, home = defaultHome) {
  try { return JSON.parse(fs.readFileSync(recordPath(id, home), "utf8")); } catch { return null; }
}
export function writeRecord(id, record, home = defaultHome) {
  const file = recordPath(id, home);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// A chat whose hook registered it: Semaphore can wake it without a listener.
export function isRegistered(id, { home = defaultHome } = {}) {
  return validSession(id) && !fs.existsSync(path.join(claudeWakePaths(home).dir, "disabled")) &&
    readRecord(id, home)?.session === id && fs.existsSync(signalPath(id, home));
}

export function disableRegistrations(home) {
  const { dir, sessions } = claudeWakePaths(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "disabled"), "Hooks uninstalled\n", { mode: 0o600 });
  // Keep watched signal files in place; remove only Semaphore's capability records.
  for (const file of fs.existsSync(sessions) ? fs.readdirSync(sessions) : [])
    if (file.endsWith(".json") && validSession(file.slice(0, -5))) fs.rmSync(path.join(sessions, file));
}
export function enableRegistrations(home) {
  fs.rmSync(path.join(claudeWakePaths(home).dir, "disabled"), { force: true });
}

// SessionStart / CwdChanged. Every chat registers, but a chat only receives room content once it
// has explicitly joined a room; until then nothing ever writes its signal file.
export function registerSession(input, { home = defaultHome, now = Date.now() } = {}) {
  const id = input?.session_id;
  if (!validSession(id) || fs.existsSync(path.join(claudeWakePaths(home).dir, "disabled"))) return null;
  const { signals, sessions } = claudeWakePaths(home);
  fs.mkdirSync(signals, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const signal = signalPath(id, home);
  try { fs.writeFileSync(signal, "", { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const record = readRecord(id, home);
  // A real (re)start of the chat's session: its watcher is new, and anything it was told before is
  // gone from the running process. Clearing or compacting the context is not a restart.
  const started = input.hook_event_name === "SessionStart" && ["startup", "resume"].includes(input.source);
  // Directory changes are frequent: refresh the record at most once a minute.
  if (!record || input.hook_event_name === "SessionStart" || now - Date.parse(record.seenAt ?? 0) > REFRESH_MS)
    writeRecord(id, { ...record, session: id, registeredAt: record?.registeredAt ?? new Date(now).toISOString(),
      seenAt: new Date(now).toISOString(), event: input.hook_event_name ?? null,
      ...(started ? { startedAt: new Date(now).toISOString() } : record?.startedAt ? { startedAt: record.startedAt } : {}) }, home);
  const hookEventName = input.hook_event_name === "CwdChanged" ? "CwdChanged" : "SessionStart";
  // The installed runtime reads watchPaths only inside hookSpecificOutput.
  return { hookSpecificOutput: { hookEventName, watchPaths: [signal] } };
}

// UserPromptSubmit: a manual nudge (or a native background continuation) starts work again.
// Record only its time, never prompt text; no output, context injection or decision control.
export function recordActivity(input, { home = defaultHome, now = Date.now() } = {}) {
  const id = input?.session_id;
  if (input?.hook_event_name !== "UserPromptSubmit" || !isRegistered(id, { home })) return;
  const record = readRecord(id, home);
  writeRecord(id, { ...record, activityAt: new Date(now).toISOString() }, home);
}

// Written in place (not renamed over), the way the desktop probe was proved: a watcher that follows
// the file keeps following it.
export function signalSession(id, payload, { home = defaultHome } = {}) {
  if (!isRegistered(id, { home })) return false;
  fs.writeFileSync(signalPath(id, home), JSON.stringify({ ...payload, at: new Date().toISOString() }), { mode: 0o600 });
  return true;
}
