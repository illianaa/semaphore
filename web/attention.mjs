// Silence is an observation about room updates, not proof that native work stopped.
export const QUIET_MS = 5 * 60_000;
export const CLAUDE_RETRY_MS = 60_000;
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

export function quietTurn(room, now = Date.now()) {
  const pending = room?.pending;
  if (room?.ended || room?.lock?.state === "stale" || !pending?.id ||
      pending.state !== "awaiting-reply" || pending.progress !== "received" ||
      room.owner !== pending.speaker || !["astra", "claude"].includes(pending.speaker)) return null;
  const note = currentNote(room, now);
  if (note?.kind === "approval") return null;
  const since = Math.max(time(pending.timing?.acknowledgedAt), time(note?.updatedAt),
    time(pending.wakeRequestedAt));
  if (!since || now - since < QUIET_MS) return null;
  return { turnId: pending.id, speaker: pending.speaker, since };
}

// Opening the desktop chat must still work when its wake hook is unavailable.
export function claudeChatOffer(room, now = Date.now()) {
  const pending = room?.pending;
  const seat = room?.connections?.claude;
  if (room?.ended || room?.lock?.state === "stale" || pending?.speaker !== "claude" ||
      pending.state !== "awaiting-reply" || room.owner !== "claude" ||
      seat?.transport !== "claude-inbox") return null;
  const requested = time(pending.wakeRequestedAt);
  if (requested && now - requested < CLAUDE_RETRY_MS) return "waking";
  if (pending.progress === "received") return quietTurn(room, now) ? "quiet" : null;
  const since = Math.max(time(pending.timing?.queuedAt) || time(pending.at), requested);
  return since && now - since >= CLAUDE_RETRY_MS ? "stuck" : null;
}

export function claudeWakeOffer(room, now = Date.now()) {
  return room?.connections?.claude?.wake === "automatic" ? claudeChatOffer(room, now) : null;
}

// Remember one notification per room turn, including across refreshes and companion windows.
// A failed OS notification remains eligible. The caller supplies its existing storage/OS API.
export function notifyQuietTurns(rooms, { now = Date.now(), enabled, foreground, read, write, notify }) {
  if (!enabled || foreground) return;
  for (const room of rooms) {
    const quiet = quietTurn(room, now);
    const key = `semaphore:quiet-notified:${room.name}`;
    if (!quiet || read(key) === quiet.turnId) continue;
    try {
      notify(room, quiet);
      write(key, quiet.turnId);
    } catch { /* Notification failures must not mark the app offline. */ }
  }
}
