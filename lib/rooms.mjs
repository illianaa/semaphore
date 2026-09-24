import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { RoomStore } from "./core.mjs";

const ROOM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// A room for live desktop chats: both seats wait, unbound, until each chat joins itself.
export function createLiveRoom(root, title) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 100)
    throw new Error("Give the conversation a title of 1–100 characters.");
  const store = new RoomStore(root, `room-${randomUUID().slice(0, 12)}`);
  store.acquire();
  try {
    const room = store.loadOrCreate();
    room.title = title.trim();
    room.participants = {
      astra: { transport: "astra-inbox", id: null, seen: 0 },
      claude: { transport: "claude-inbox", id: null, seen: 0 },
    };
    store.save(room);
    return { store, room };
  } finally {
    store.release();
  }
}

// Deterministic request identity survives a lost create response. The entire
// opening and member selection are committed together; retry never dispatches.
export async function createStartedRoom(root, { text, to, members = ["astra", "claude"], clientId }, { source } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 64_000)
    throw new Error("Enter an opening message of 1–64,000 characters.");
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId))
    throw new Error("A conversation request ID is required.");
  if (!Array.isArray(members) || !members.length || new Set(members).size !== members.length ||
      members.some((s) => !["astra", "claude"].includes(s)) || !members.includes(to))
    throw new Error("Choose participants and a first speaker from that group.");
  if (source && (!members.includes(source.speaker) ||
      !["astra-inbox", "claude-inbox", "codex-queue"].includes(source.transport) ||
      !/^[a-f0-9-]{36}$/i.test(source.id ?? "")))
    throw new Error("A native opening needs a verified chat binding.");
  const request = { text: text.trim(), to, members: [...members].sort(), clientId,
    ...(source ? { source: { speaker: source.speaker, transport: source.transport, id: source.id } } : {}) };
  const store = new RoomStore(root, `room-${createHash("sha256").update(clientId).digest("hex").slice(0, 24)}`);
  await store.acquire({ waitMs: 5000 });
  try {
    const room = store.loadOrCreate();
    if (room.creationRequest) {
      if (JSON.stringify(room.creationRequest) !== JSON.stringify(request))
        throw new Error("Conflicting duplicate: this request already created a different conversation.");
      return { store, room, duplicate: true };
    }
    if (room.messages.length || room.title) throw new Error("Conversation request identity is already in use.");
    room.title = request.text.split(/\r?\n/)[0].slice(0, 80);
    room.creationRequest = request;
    room.members = request.members;
    room.participants = {
      astra: { transport: "astra-inbox", id: null, seen: 0 },
      claude: { transport: "claude-inbox", id: null, seen: 0 },
    };
    if (source) Object.assign(room.participants[source.speaker], { transport: source.transport, id: source.id });
    room.messages = [{ seq: 1, speaker: "human", text: request.text, next: to,
      at: new Date().toISOString(), clientId, opening: true, ...(source ? { via: source.speaker } : {}) }];
    room.opening = { ...request, seq: 1, state: "waiting" };
    store.save(room);
    return { store, room, duplicate: false };
  } finally { store.release(); }
}

// Every readable room under root, most recently created first. A damaged room is skipped, not fatal.
export function readRooms(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ROOM_NAME.test(entry.name))
    .flatMap((entry) => {
      try {
        const store = new RoomStore(root, entry.name);
        return [{ store, room: store.read() }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.room.createdAt.localeCompare(a.room.createdAt));
}
