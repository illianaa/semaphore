export const NOTE_LIMIT = 280;
export const WORKING_NOTE_TTL = 30 * 60 * 1000;

export function noteText(text) {
  if (typeof text !== "string" || !text.trim())
    throw new Error("A status note needs non-empty text, or use --clear.");
  return Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, NOTE_LIMIT).join("");
}

// Shared by the browser API and CLI status. Old or malformed stored notes must
// never imply that a different turn is working or waiting for approval.
export function statusNote(room, now = Date.now()) {
  const note = room.statusNote;
  const pending = room.pending;
  if (!note || pending?.state !== "awaiting-reply" || !pending.receivedAt ||
      room.owner !== pending.speaker || note.turnId !== pending.id || note.speaker !== pending.speaker) return null;
  if (!["working", "approval"].includes(note.kind) || typeof note.text !== "string" || !note.text.trim() ||
      !Number.isFinite(Date.parse(note.updatedAt))) return null;
  if (!(note.kind === "approval" && note.expiresAt === null) && !(Date.parse(note.expiresAt) > now)) return null;
  return { speaker: note.speaker, turnId: note.turnId, kind: note.kind, text: noteText(note.text),
    updatedAt: note.updatedAt, expiresAt: note.expiresAt };
}
