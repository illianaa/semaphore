// What the person must do so an AI can continue comes from the server (lib/attention.mjs), which
// alerts only on evidence that has held for a grace period, never on silence. Everything here
// reads that one answer, so the banner, the sidebar row, the sidebar toggle and notifications agree.
export const CLAUDE_RETRY_MS = 60_000;
// After this long with no reply or note, a working turn gets a plain "no update" line. Not an alert.
export const QUIET_TEXT_MS = 20 * 60_000;
const time = (at) => at ? Date.parse(at) || 0 : 0;

export function currentNote(room, now = Date.now()) {
  const note = room?.statusNote;
  const pending = room?.pending;
  if (room?.ended || !note || pending?.state !== "awaiting-reply" ||
      note.turnId !== pending.id || note.speaker !== pending.speaker) return null;
  if (!["working", "approval"].includes(note.kind) || typeof note.text !== "string" ||
      !note.text.trim() || !time(note.updatedAt)) return null;
  if (note.expiresAt && !(time(note.expiresAt) > now)) return null;
  return note;
}

// The server's answer, if it still describes this room's current turn.
export function attentionOf(room) {
  const attention = room?.attention;
  if (!attention || room.ended || !room.pending || !attention.key?.startsWith(`${room.pending.id}:`)) return null;
  return attention;
}

// Minutes since a working AI last said anything, once that's long enough to mention calmly.
export function quietMinutes(room, now = Date.now()) {
  const pending = room?.pending;
  if (!pending || pending.progress !== "received" || pending.state !== "awaiting-reply" || attentionOf(room)) return 0;
  const since = Math.max(time(pending.timing?.acknowledgedAt), time(pending.noteAt), time(pending.wakeRequestedAt));
  return since && now - since >= QUIET_TEXT_MS ? Math.floor((now - since) / 60_000) : 0;
}

// Opening the desktop chat must still work when its wake hook is unavailable. "stuck" is the
// in-room offer for a turn not yet picked up; "quiet" only when the server says Claude stopped.
export function claudeChatOffer(room, now = Date.now()) {
  const pending = room?.pending;
  const seat = room?.connections?.claude;
  if (room?.ended || room?.lock?.state === "stale" || pending?.speaker !== "claude" ||
      pending.state !== "awaiting-reply" || room.owner !== "claude" ||
      seat?.transport !== "claude-inbox") return null;
  const requested = time(pending.wakeRequestedAt);
  if (requested && now - requested < CLAUDE_RETRY_MS) return "waking";
  if (pending.progress === "received") return attentionOf(room)?.reason === "claude-stopped" ? "quiet" : null;
  const since = Math.max(time(pending.timing?.queuedAt) || time(pending.at), requested);
  return since && now - since >= CLAUDE_RETRY_MS ? "stuck" : null;
}

export function claudeWakeOffer(room, now = Date.now()) {
  return room?.connections?.claude?.wake === "automatic" ? claudeChatOffer(room, now) : null;
}

// Rooms other than the one on screen that need the person, for the sidebar toggle.
export function roomsNeedingYou(rooms, current) {
  return rooms.filter((room) => room.name !== current && attentionOf(room));
}

// One notification per room, turn and reason, remembered across refreshes and windows. A failed
// OS notification stays eligible. The caller supplies its storage and notification API.
export function notifyAttention(rooms, { enabled, foreground, read, write, notify }) {
  if (!enabled || foreground) return;
  for (const room of rooms) {
    const attention = attentionOf(room);
    const key = `semaphore:attention-notified:${room.name}`;
    if (!attention || attention.reason === "approval" || read(key) === attention.key) continue;
    try {
      notify(room, attention);
      write(key, attention.key);
    } catch { /* Notification failures must not mark the app offline. */ }
  }
}
