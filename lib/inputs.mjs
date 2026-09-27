import fs from "node:fs";
import path from "node:path";
import { sqliteDatabase } from "./sqlite.mjs";

// A small durable ingress journal lets the human save input while a different
// process holds the room lock during native delivery. SQLite's write transaction
// also orders ingress against the reply's final read/commit check. No chat is run
// here, and no native session is resumed.
export function withInputs(roomDir, action) {
  const file = path.join(roomDir, "human-inputs.sqlite");
  try { fs.closeSync(fs.openSync(file, "wx", 0o600)); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const db = new (sqliteDatabase())(file);
  try {
    db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    db.exec("CREATE TABLE IF NOT EXISTS inputs (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action({
        all: () => db.prepare("SELECT payload FROM inputs ORDER BY id").all().map((row) => JSON.parse(row.payload)),
        add: (input) => db.prepare("INSERT INTO inputs (client_id, payload) VALUES (?, ?)").run(input.clientId, JSON.stringify(input)),
        clear: () => db.exec("DELETE FROM inputs"),
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

// Input during a turn guides whoever is working on it. Naming that AI (or the opening's first
// speaker) leaves the handoff to it; naming the other AI routes the stick there after its reply.
// The latest input decides, so guidance also clears an earlier routing choice.
export function replyNextAfter(message) {
  return message.next === message.waitingFor ? null : { to: message.next, seq: message.seq };
}

export function queuedInputs(roomDir) {
  const file = path.join(roomDir, "human-inputs.sqlite");
  if (!fs.existsSync(file)) return [];
  const db = new (sqliteDatabase())(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='inputs'").get()) return [];
    return db.prepare("SELECT payload FROM inputs ORDER BY id").all().map((row) => JSON.parse(row.payload));
  } finally { db.close(); }
}

export function queueHumanInput(store, { text, to, clientId }) {
  if (typeof text !== "string" || !text.trim() || text.length > 64_000 ||
      !["astra", "claude"].includes(to) || typeof clientId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw new Error("Invalid human input.");
  return withInputs(store.dir, (journal) => {
    const room = store.read();
    const existing = room.messages.find((m) => m.clientId === clientId);
    const queued = journal.all().find((m) => m.clientId === clientId);
    if (existing || queued) {
      if (existing ? existing.speaker !== "human" || existing.via || existing.text !== text.trim() || existing.next !== to
        : queued.text !== text.trim() || queued.to !== to)
        throw new Error("Conflicting duplicate: this request already saved a different message.");
      return;
    }
    journal.add({ text: text.trim(), to, clientId, at: new Date().toISOString(),
      waitingFor: room.pending?.speaker ?? room.opening?.to, interjection: true });
  });
}

export function inputMessages(room, inputs) {
  const ids = new Set(room.messages.map((m) => m.clientId));
  return inputs.filter((input) => !ids.has(input.clientId)).map((input, index) => ({
    seq: room.messages.length + index + 1, speaker: "human", text: input.text,
    next: input.to, at: input.at, clientId: input.clientId,
    interjection: true, waitingFor: input.waitingFor, queued: true,
  }));
}
