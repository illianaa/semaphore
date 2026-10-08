import test from "node:test";
import assert from "node:assert/strict";
import { attentionReason, AttentionTracker } from "../lib/attention.mjs";

const T0 = Date.parse("2026-10-08T12:00:00Z");
const at = (ms) => new Date(T0 + ms).toISOString();
// A room view as the app sees it, for one AI's pending turn.
function view(speaker, { received = false, seat = {}, pending = {}, note = null, ...rest } = {}) {
  return {
    owner: speaker, ended: null, lock: { state: "free" },
    pending: { id: "turn-1", speaker, state: "awaiting-reply", at: at(0), progress: received ? "received" : "queued",
      timing: { queuedAt: at(0), ...(received ? { acknowledgedAt: at(1000) } : {}) }, wake: null, ...pending },
    statusNote: note, connections: { [speaker]: { connected: true, transport: `${speaker}-inbox`, ...seat } }, ...rest,
  };
}
const reason = (v, now = 10 * 60_000, options = {}) => attentionReason(v, { now: T0 + now, ...options })?.reason ?? null;

test("silence alone never needs the person: a received turn with no notes for an hour is calm", () => {
  assert.equal(reason(view("claude", { received: true, seat: { wake: "automatic" } }), 60 * 60_000), null);
  assert.equal(reason(view("astra", { received: true, seat: { wake: "automatic", steering: false } }), 60 * 60_000), null);
});

test("GPT: only the engine's own evidence alerts, and handoffs stay calm", () => {
  assert.equal(reason(view("astra", { seat: { wake: "unloaded" } })), "gpt-asleep");
  assert.equal(reason(view("astra", { seat: { wake: "reconnect" } })), "gpt-reconnect");
  assert.equal(reason(view("astra", { seat: { wake: "off", listening: false } })), "gpt-not-listening");
  assert.equal(reason(view("astra", { seat: { wake: "unavailable" } })), "gpt-unavailable");
  assert.equal(reason(view("astra", { seat: { wake: "automatic", manual: true } })), "gpt-send");
  assert.equal(reason(view("astra", { seat: { wake: "automatic" }, pending: { wake: { status: "needs-send" } } })), "gpt-send");
  assert.equal(reason(view("astra", { seat: { wake: "automatic" }, pending: { wake: { status: "uncertain" } } })), "gpt-check");
  for (const wake of ["automatic", "checking", "listening"]) assert.equal(reason(view("astra", { seat: { wake } })), null, wake);
  assert.equal(reason(view("astra", { seat: { wake: "reconnect", listening: true } })), null, "its listener is running");
  assert.equal(reason(view("astra", { seat: { wake: "unloaded" }, pending: { timing: { queuedAt: at(0), listenerObservedAt: at(500) } } })), null, "the chat has the notice");
  assert.equal(reason(view("astra", { seat: { wake: "reconnect" } }), 10 * 60_000, { lastReplyAt: { astra: at(10 * 60_000 - 30_000) } }), null, "just replied; listener between runs");
});

test("GPT working on a received turn alerts only if its chat went idle, unloaded or lost the binding", () => {
  assert.equal(reason(view("astra", { received: true, seat: { wake: "automatic", nativeIdleSince: at(60_000) } })), "gpt-stopped");
  assert.equal(reason(view("astra", { received: true, seat: { wake: "unloaded" } })), "gpt-asleep");
  assert.equal(reason(view("astra", { received: true, seat: { wake: "reconnect" }, pending: { nativeBound: true } })), "gpt-reconnect");
  assert.equal(reason(view("astra", { received: true, seat: { wake: "reconnect" } })), null, "a listener-route turn has no native binding to lose");
});

test("Claude: a turn the hook hasn't delivered since it was needed alerts; a delivered one is calm while Claude is busy", () => {
  const seat = { wake: "automatic" };
  assert.equal(reason(view("claude", { seat })), "claude-asleep");
  assert.equal(reason(view("claude", { seat, pending: { claudeClaimedAt: at(2000) } })), null, "claimed: the chat has it");
  assert.equal(reason(view("claude", { seat, pending: { timing: { queuedAt: at(0), listenerObservedAt: at(2000) } } })), null);
  assert.equal(reason(view("claude", { seat, pending: { claudeClaimedAt: at(2000), wakeRequestedAt: at(60_000) } })), "claude-asleep", "Open chat asked again");
  assert.equal(reason(view("claude", { seat: { ...seat, startedAt: at(90_000) }, pending: { claudeClaimedAt: at(2000) } })), "claude-asleep", "restarted after the claim");
  assert.equal(reason(view("claude", { seat: { ...seat, startedAt: at(90_000) }, pending: { claudeClaimedAt: at(95_000) } })), null, "replayed after the restart");
  assert.equal(reason(view("claude", { seat: { listening: false } })), "claude-not-listening");
  assert.equal(reason(view("claude", { seat: { listening: true } })), null);
});

test("Claude stopped without replying alerts only with the Stop hook's evidence and no sign it is still going", () => {
  const stopped = { claudeReminderAt: at(5 * 60_000), claudeStoppedAt: at(5 * 60_000 + 20_000) };
  assert.equal(reason(view("claude", { received: true, seat: { wake: "automatic" }, pending: stopped })), "claude-stopped");
  assert.equal(reason(view("claude", { received: true, seat: { wake: "automatic" }, pending: { ...stopped, noteAt: at(4 * 60_000) } })), null,
    "it posted a note this turn (waiting on a build): calm, even after the note expires");
  assert.equal(reason(view("claude", { received: true, seat: { wake: "automatic" }, pending: { ...stopped, claudeInputAt: at(5 * 60_000 + 25_000) } })), null,
    "it took a notice after stopping: still going");
  assert.equal(reason(view("claude", { received: true, seat: { wake: "automatic" }, pending: { claudeReminderAt: at(5 * 60_000) } })), null, "reminded but not stopped");
});

test("an older headless seat never needs waking", () => {
  assert.equal(reason(view("claude", { seat: { transport: "headless" } })), null);
});

test("an approval note alerts until the AI plainly moves on; nothing alerts once the turn is over or taken", () => {
  const note = { turnId: "turn-1", kind: "approval", text: "Approve the deploy", updatedAt: at(60_000) };
  assert.equal(reason(view("claude", { received: true, note })), "approval");
  assert.equal(reason(view("claude", { received: true, note, pending: { noteAt: note.updatedAt, claudeStoppedAt: at(120_000) } })), null,
    "Claude stopped after asking: the approval is retired, and its note keeps the stop calm");
  assert.equal(reason(view("astra", { received: true, note, seat: { nativeIdleSince: at(120_000) } })), "gpt-stopped", "GPT's chat went idle instead");
  assert.equal(reason({ ...view("astra", { seat: { wake: "unloaded" } }), owner: "human" }), null, "the person took the stick");
  assert.equal(reason({ ...view("astra", { seat: { wake: "unloaded" } }), ended: { at: at(0) } }), null);
  assert.equal(reason({ ...view("astra", { seat: { wake: "unloaded" } }), lock: { state: "stale" } }), null);
  assert.equal(reason({ ...view("astra", { seat: { wake: "unloaded" } }), pending: null }), null);
});

test("a reason alerts only after holding continuously for its grace, timed from when this app first saw it", () => {
  let now = T0 + 30 * 60_000; // queued half an hour ago: that alone must not skip the grace.
  const tracker = new AttentionTracker({ now: () => now });
  const asleep = view("astra", { seat: { wake: "unloaded" } });
  assert.equal(tracker.check("room", asleep), null, "first sighting");
  now += 30_000;
  assert.equal(tracker.check("room", asleep), null);
  now += 20_000;
  const shown = tracker.check("room", asleep);
  assert.deepEqual([shown.reason, shown.label, shown.key], ["gpt-asleep", "Open GPT to continue", "turn-1:gpt-asleep"]);
  assert.match(shown.detail, /ChatGPT put GPT's chat to sleep/);
  // One calm snapshot resets it.
  now += 1_500;
  assert.equal(tracker.check("room", view("astra", { seat: { wake: "checking" } })), null);
  now += 1_500;
  assert.equal(tracker.check("room", asleep), null, "back to the start of its grace");
  assert.equal(new AttentionTracker({ now: () => now }).check("other", view("claude", { received: true, note: { turnId: "turn-1", kind: "approval", text: "x", updatedAt: at(0) } })).label,
    "Approve in Claude", "approvals need no grace");
});
