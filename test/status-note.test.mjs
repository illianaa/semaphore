import test from "node:test";
import assert from "node:assert/strict";
import { statusNote, WORKING_NOTE_TTL } from "../lib/status-note.mjs";

test("status projection expires working notes but preserves a blocked approval until the turn ends", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const room = { owner: "astra", pending: { id: "turn", speaker: "astra", state: "awaiting-reply", receivedAt: new Date(now).toISOString() },
    statusNote: { turnId: "turn", speaker: "astra", kind: "working", text: "Checking the result",
      updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + WORKING_NOTE_TTL).toISOString() } };
  assert.equal(statusNote(room, now + WORKING_NOTE_TTL - 1).text, "Checking the result");
  assert.equal(statusNote(room, now + WORKING_NOTE_TTL), null);
  assert.equal(statusNote({ ...room, statusNote: { ...room.statusNote, expiresAt: null } }, now), null);
  room.statusNote = { ...room.statusNote, kind: "approval", expiresAt: null };
  assert.equal(statusNote(room, now + 24 * 60 * 60 * 1000).kind, "approval");
  for (const override of [
    { owner: "human" }, { pending: null },
    { pending: { ...room.pending, receivedAt: undefined } },
    { statusNote: { ...room.statusNote, updatedAt: "invalid" } },
    { statusNote: { ...room.statusNote, expiresAt: "invalid" } },
  ]) assert.equal(statusNote({ ...room, ...override }, now), null);
});
