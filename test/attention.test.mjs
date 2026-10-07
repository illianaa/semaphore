import test from "node:test";
import assert from "node:assert/strict";
import { quietTurn, claudeChatOffer, claudeWakeOffer, notifyQuietTurns, QUIET_MS } from "../web/attention.mjs";

const now = Date.parse("2026-10-07T12:00:00Z");
const at = age => new Date(now - age).toISOString();
function room(speaker = "claude") {
  return { name: "room", title: "Project", owner: speaker,
    connections: { claude: { transport: "claude-inbox", wake: "automatic" } },
    pending: { id: "turn-1", speaker, state: "awaiting-reply", progress: "received",
      at: at(20 * 60_000), timing: { acknowledgedAt: at(QUIET_MS) } } };
}
function note(r, age, kind = "working") {
  r.statusNote = { turnId: r.pending.id, speaker: r.pending.speaker, kind,
    text: "Checking the result", updatedAt: at(age),
    expiresAt: kind === "approval" ? null : new Date(now + 25 * 60_000).toISOString() };
}

test("both agents become quiet based on their receipt, not time spent in the inbox", () => {
  for (const speaker of ["claude", "astra"]) {
    const r = room(speaker);
    assert.equal(quietTurn(r, now).speaker, speaker);
    r.pending.timing.acknowledgedAt = at(60_000);
    assert.equal(quietTurn(r, now), null);
    r.pending.timing.acknowledgedAt = null;
    assert.equal(quietTurn(r, now), null, "unknown acknowledgment time is not inactivity evidence");
  }
});

test("fresh status updates clear quiet, unrelated notes cannot hide it, approvals stay distinct", () => {
  const r = room();
  note(r, 60_000);
  assert.equal(quietTurn(r, now), null);
  assert.ok(quietTurn(r, now + QUIET_MS));
  r.statusNote.turnId = "old-turn";
  assert.ok(quietTurn(r, now));
  note(r, 24 * 60 * 60_000, "approval");
  assert.equal(quietTurn(r, now), null);
  assert.equal(claudeWakeOffer(r, now), null);
});

test("quiet never overrides ended, taken, queued, delivering or uncertain turns", () => {
  for (const change of [
    r => { r.ended = { at: at(0) }; },
    r => { r.owner = "human"; },
    r => { r.pending = null; },
    r => { r.pending.progress = "queued"; },
    r => { r.pending.state = "delivering"; },
    r => { r.pending.state = "uncertain"; },
    r => { r.lock = { state: "stale" }; },
  ]) {
    const r = room(); change(r);
    assert.equal(quietTurn(r, now), null);
  }
});

test("Wake Claude gets a cooldown and quiet grace, and still recovers unreceived turns", () => {
  const r = room();
  assert.equal(claudeWakeOffer(r, now), "quiet");
  r.pending.wakeRequestedAt = at(0);
  assert.equal(claudeWakeOffer(r, now), "waking");
  assert.equal(claudeWakeOffer(r, now + 60_000), null);
  assert.equal(quietTurn(r, now + QUIET_MS - 1), null);
  assert.equal(claudeWakeOffer(r, now + QUIET_MS), "quiet");
  r.pending.progress = "queued";
  assert.equal(claudeWakeOffer(r, now + 60_000), "stuck");
  r.connections.claude.wake = "unavailable";
  assert.equal(claudeWakeOffer(r, now + QUIET_MS), null);
});

test("opening a stalled desktop chat stays available when Claude's hook is unavailable", () => {
  const r = room();
  delete r.connections.claude.wake;
  assert.equal(claudeChatOffer(r, now), "quiet");
  assert.equal(claudeWakeOffer(r, now), null);
  r.pending.progress = "queued";
  assert.equal(claudeChatOffer(r, now), "stuck");
  assert.equal(claudeWakeOffer(r, now), null);
  r.owner = "human";
  assert.equal(claudeChatOffer(r, now), null);
});

test("quiet notifications survive reloads without repeating, and a new turn can notify", () => {
  const saved = new Map(); const alerts = [];
  const options = { now, enabled: true, foreground: false,
    read: key => saved.get(key), write: (key, value) => saved.set(key, value),
    notify: (r, quiet) => alerts.push([r.name, quiet.turnId]) };
  const r = room();
  notifyQuietTurns([r], { ...options, foreground: true });
  notifyQuietTurns([r], { ...options, enabled: false });
  assert.equal(saved.size, 0, "suppressed notifications remain eligible");
  notifyQuietTurns([r], options);
  notifyQuietTurns([r], { ...options });
  note(r, 0);
  notifyQuietTurns([r], { ...options, now: now + QUIET_MS });
  assert.deepEqual(alerts, [["room", "turn-1"]]);
  r.pending.id = "turn-2";
  notifyQuietTurns([r], options);
  assert.deepEqual(alerts, [["room", "turn-1"], ["room", "turn-2"]]);
});

test("failed OS alerts don't poison later notification attempts or other rooms", () => {
  const saved = new Map(); const alerts = [];
  const broken = room(); broken.name = "broken";
  const good = room("astra");
  const options = { now, enabled: true, foreground: false,
    read: key => saved.get(key), write: (key, value) => saved.set(key, value),
    notify: r => { if (r.name === "broken") throw Error("OS unavailable"); alerts.push(r.name); } };
  notifyQuietTurns([broken, good], options);
  assert.deepEqual(alerts, ["room"]);
  notifyQuietTurns([broken, good], { ...options, notify: r => alerts.push(r.name) });
  assert.deepEqual(alerts, ["room", "broken"]);
});
