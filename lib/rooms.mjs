import { randomUUID } from "node:crypto";
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
