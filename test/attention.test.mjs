import test from "node:test";
import assert from "node:assert/strict";
import { attentionOf, quietMinutes, claudeChatOffer, claudeWakeOffer, roomsNeedingYou, notifyAttention, QUIET_TEXT_MS } from "../web/attention.mjs";

const now = Date.parse("2026-10-08T12:00:00Z");
const at = (ms) => new Date(now - ms).toISOString();
function room(speaker = "claude", { progress = "received", attention = null, name = "room" } = {}) {
  return { name, owner: speaker, ended: null, lock: { state: "free" }, attention,
    pending: { id: "turn-1", speaker, state: "awaiting-reply", progress, at: at(10 * 60_000),
      timing: { queuedAt: at(10 * 60_000), acknowledgedAt: at(9 * 60_000) } },
    connections: { claude: { transport: "claude-inbox", wake: "automatic" }, astra: { transport: "astra-inbox" } } };
}
const stopped = { reason: "claude-stopped", speaker: "claude", label: "Remind Claude to reply", key: "turn-1:claude-stopped" };

test("the app shows only the server's alert, and only for the current turn", () => {
  assert.equal(attentionOf(room()), null, "silence alone is not an alert");
  assert.deepEqual(attentionOf(room("claude", { attention: stopped })), stopped);
  assert.equal(attentionOf(room("claude", { attention: { ...stopped, key: "turn-0:claude-stopped" } })), null, "a stale answer");
  assert.equal(attentionOf({ ...room("claude", { attention: stopped }), ended: { at: at(0) } }), null);
});

test("a long-silent working turn gets calm text, not an alert", () => {
  assert.equal(quietMinutes(room(), now), 0, "nine minutes");
  const r = room(); r.pending.timing.acknowledgedAt = at(QUIET_TEXT_MS + 5 * 60_000);
  assert.equal(quietMinutes(r, now), 25);
  r.pending.noteAt = at(60_000);
  assert.equal(quietMinutes(r, now), 0, "a recent note");
  assert.equal(quietMinutes(room("claude", { attention: stopped }), now), 0, "an alert says more");
});

test("Open chat for Claude: offered for an unstarted turn, or when the server says it stopped", () => {
  const r = room();
  assert.equal(claudeWakeOffer(r, now), null, "working quietly is not an offer");
  r.attention = stopped;
  assert.equal(claudeWakeOffer(r, now), "quiet");
  r.pending.wakeRequestedAt = at(0);
  assert.equal(claudeWakeOffer(r, now), "waking");
  r.pending.wakeRequestedAt = at(2 * 60_000);
  r.pending.progress = "queued";
  r.attention = null;
  assert.equal(claudeWakeOffer(r, now), "stuck");
  delete r.connections.claude.wake;
  assert.equal(claudeWakeOffer(r, now), null);
  assert.equal(claudeChatOffer(r, now), "stuck", "the link works without the hook");
  r.owner = "human";
  assert.equal(claudeChatOffer(r, now), null);
});

test("the sidebar toggle counts other rooms that need the person", () => {
  const rooms = [room("claude", { attention: stopped, name: "a" }), room("claude", { name: "b" }), room("claude", { attention: stopped, name: "c" })];
  assert.deepEqual(roomsNeedingYou(rooms, "a").map((r) => r.name), ["c"]);
  assert.deepEqual(roomsNeedingYou(rooms, null).map((r) => r.name), ["a", "c"]);
});

test("one notification per room, turn and reason, surviving reloads; approvals use their own", () => {
  const saved = new Map(); const alerts = [];
  const options = { enabled: true, foreground: false,
    read: (key) => saved.get(key), write: (key, value) => saved.set(key, value),
    notify: (r, attention) => alerts.push([r.name, attention.key]) };
  const r = room("claude", { attention: stopped });
  notifyAttention([r], { ...options, foreground: true });
  notifyAttention([r], { ...options, enabled: false });
  assert.equal(saved.size, 0, "suppressed notifications remain eligible");
  notifyAttention([r], options);
  notifyAttention([r], options);
  assert.deepEqual(alerts, [["room", "turn-1:claude-stopped"]]);
  r.attention = { ...stopped, reason: "approval", key: "turn-1:approval" };
  notifyAttention([r], options);
  assert.equal(alerts.length, 1, "approvals already notify on their own");
  r.attention = { ...stopped, reason: "claude-asleep", key: "turn-1:claude-asleep" };
  notifyAttention([r], options);
  assert.deepEqual(alerts.at(-1), ["room", "turn-1:claude-asleep"]);
  const broken = room("claude", { attention: { ...stopped, key: "turn-1:claude-stopped" }, name: "broken" });
  notifyAttention([broken], { ...options, notify: () => { throw Error("OS unavailable"); } });
  assert.equal(saved.has("semaphore:attention-notified:broken"), false, "a failed alert can be retried");
});
