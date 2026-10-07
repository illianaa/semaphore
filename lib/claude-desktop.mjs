import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Links that open a Claude Code chat in the Claude desktop app, the way GPT's seat links to
// codex://threads/<id>. The app keeps one record per Code chat that names both its own session id
// (local_…) and the Claude Code session id Semaphore binds (cliSessionId). Its Dock menu and
// Spotlight entries open a chat with claude://code/continue?session=<local id>; Semaphore offers the
// same link. Opening it only shows the chat: it never starts a turn or a second process.
// Only these three fields are read, and nothing is written.

export const DESKTOP_SESSIONS = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
const LOCAL = /^local_[A-Za-z0-9-]{1,64}$/;
const CLI = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
// A new chat's record appears once; an archived chat can be restored. Look again now and then.
const RESCAN_MS = 30_000;
const RECHECK_MS = 30_000;

export const continueLink = (localId) => `claude://code/continue?${new URLSearchParams({ session: localId })}`;

function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!LOCAL.test(record?.sessionId ?? "") || typeof record.cliSessionId !== "string") return null;
    return { local: record.sessionId, cli: record.cliSessionId, archived: record.isArchived === true };
  } catch { return null; }
}

// Records are filed by account and organization: <dir>/<account>/<org>/local_<id>.json.
function recordFiles(dir) {
  const files = [];
  const list = (folder) => { try { return fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; } };
  for (const account of list(dir)) if (account.isDirectory())
    for (const org of list(path.join(dir, account.name))) if (org.isDirectory())
      for (const entry of list(path.join(dir, account.name, org.name)))
        if (entry.isFile() && /^local_[A-Za-z0-9-]{1,64}\.json$/.test(entry.name))
          files.push(path.join(dir, account.name, org.name, entry.name));
  return files;
}

export class ClaudeDesktopSessions {
  constructor({ dir = DESKTOP_SESSIONS, now = Date.now } = {}) {
    Object.assign(this, { dir, now });
    this.known = new Map();
    this.scannedAt = -Infinity;
  }
  scan() {
    this.scannedAt = this.now();
    for (const file of recordFiles(this.dir)) {
      const record = readRecord(file);
      if (record && CLI.test(record.cli)) this.known.set(record.cli, { ...record, file, checkedAt: this.scannedAt });
    }
  }
  // The link for a bound Claude chat, or null when the desktop app has no open record for it
  // (another platform, a terminal session, or an archived chat).
  url(cliSessionId) {
    if (!CLI.test(cliSessionId ?? "")) return null;
    let hit = this.known.get(cliSessionId);
    if (!hit && this.now() - this.scannedAt >= RESCAN_MS) {
      try { this.scan(); } catch {}
      hit = this.known.get(cliSessionId);
    }
    if (!hit) return null;
    if (this.now() - hit.checkedAt >= RECHECK_MS) {
      const record = readRecord(hit.file);
      if (!record || record.cli !== cliSessionId) { this.known.delete(cliSessionId); return null; }
      hit = { ...hit, ...record, checkedAt: this.now() };
      this.known.set(cliSessionId, hit);
    }
    return hit.archived ? null : continueLink(hit.local);
  }
}
