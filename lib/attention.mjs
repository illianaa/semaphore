// When a conversation needs the person to act so an AI can continue: open or reconnect a chat,
// press Send, approve something in the AI's app, or nudge an AI that ended its turn without
// replying. One rule feeds the banner, the sidebar, the sidebar toggle and notifications.
//
// It fires only on evidence, never on silence: an AI working on a received turn may be quiet for
// an hour. Each reason must hold continuously for its grace period, timed from when this server
// first saw it (not from when the turn was queued), so one stale snapshot never alerts and a
// restarted app starts calm. Signal handoffs (a listener between runs, a reply just sent, a chat
// that already has the notice) stay calm.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const time = (at) => (at ? Date.parse(at) || 0 : 0);
const APP = { astra: "ChatGPT", claude: "the Claude app" };

export const REASONS = {
  approval: { grace: 0, label: (s) => (s === "astra" ? "Approve in ChatGPT" : "Approve in Claude"),
    detail: (s) => `${name(s)} is waiting for your approval in ${APP[s]}.` },
  "gpt-asleep": { grace: 45 * SECOND, label: () => "Open GPT to continue",
    detail: () => "ChatGPT put GPT's chat to sleep. Open it so GPT picks up its turn." },
  "gpt-reconnect": { grace: MINUTE, label: () => "Reconnect GPT's chat",
    detail: () => "GPT's chat lost its connection to this conversation. Open it and reconnect it." },
  "gpt-send": { grace: 30 * SECOND, label: () => "Press Send in ChatGPT",
    detail: () => "The turn is waiting in GPT's chat. Press Send there." },
  "gpt-check": { grace: 2 * MINUTE, label: () => "Check GPT's chat",
    detail: () => "Semaphore can't tell whether GPT's chat got this turn. Check it before continuing." },
  "gpt-not-listening": { grace: MINUTE, label: () => "Open GPT to continue",
    detail: () => "Automatic wake is off and GPT's chat isn't listening. Open it and ask it to listen to this room." },
  "gpt-unavailable": { grace: 3 * MINUTE, label: () => "Check ChatGPT is open",
    detail: () => "Semaphore can't reach ChatGPT's engine, so GPT can't get its turn. Make sure ChatGPT is open." },
  "gpt-stopped": { grace: 90 * SECOND, label: () => "Remind GPT to reply",
    detail: () => "GPT's chat finished its work without replying here. Open it and ask GPT to reply in the room." },
  "claude-asleep": { grace: 2 * MINUTE, label: () => "Open Claude to continue",
    detail: () => "Claude's chat hasn't picked up its turn. Open it in the Claude app and it continues on its own." },
  "claude-not-listening": { grace: MINUTE, label: () => "Open Claude to continue",
    detail: () => "Claude's chat isn't listening. Open it and ask it to listen to this room." },
  "claude-stopped": { grace: MINUTE, label: () => "Remind Claude to reply",
    detail: () => "Claude ended its turn without replying here. Open its chat and ask it to reply in the room." },
};
const name = (speaker) => (speaker === "astra" ? "GPT" : "Claude");

// The reason that applies right now, before any grace: { reason, speaker, since? } or null.
// `view` is the room as the app sees it (server view()); `lastReplyAt` is each AI's last message.
export function attentionReason(view, { now = Date.now(), lastReplyAt = {} } = {}) {
  const pending = view?.pending;
  if (!pending || view.ended || view.lock?.state === "stale" || pending.state !== "awaiting-reply" ||
      view.owner !== pending.speaker || !["astra", "claude"].includes(pending.speaker)) return null;
  const speaker = pending.speaker;
  const seat = view.connections?.[speaker] ?? {};
  // Only live desktop chats can need waking; an older headless seat never does.
  if (!["astra-inbox", "codex-queue", "claude-inbox"].includes(seat.transport)) return null;
  const note = view.statusNote?.turnId === pending.id ? view.statusNote : null;
  const received = pending.progress === "received";
  const result = (reason, since) => ({ reason, speaker, ...(since ? { since } : {}) });

  // Stopping or resuming a native turn cannot resolve an explicit approval request.
  // It stays until the agent replaces/clears its note or hands back the room turn.
  if (note?.kind === "approval") return result("approval");

  if (!received) {
    // The chat already has the notice, or the AI just replied and its listener is between runs.
    const handed = !!pending.timing?.listenerObservedAt;
    const justReplied = now - time(lastReplyAt[speaker]) < 90 * SECOND;
    if (speaker === "astra") {
      if (seat.manual || pending.wake?.status === "needs-send") return result("gpt-send");
      if (pending.wake?.status === "uncertain") return result("gpt-check");
      if (handed || justReplied || seat.listening) return null;
      if (seat.wake === "unloaded") return result("gpt-asleep");
      if (seat.wake === "reconnect") return result("gpt-reconnect");
      if (seat.wake === "off") return result("gpt-not-listening");
      if (seat.wake === "unavailable") return result("gpt-unavailable");
      return null; // automatic, checking: delivery is under way.
    }
    if (seat.wake === "automatic") {
      // Delivered (claimed or observed by the hook) since the turn last needed delivering: the chat
      // has it and is busy. A restart after the claim means it needs delivering again.
      const restarted = time(seat.startedAt) > time(pending.claudeClaimedAt) && time(pending.claudeClaimedAt) > 0;
      const needed = Math.max(time(pending.timing?.queuedAt) || time(pending.at), time(pending.wakeRequestedAt),
        restarted ? time(seat.startedAt) : 0);
      const delivered = Math.max(time(pending.claudeClaimedAt), time(pending.timing?.listenerObservedAt));
      return delivered >= needed ? null : result("claude-asleep");
    }
    if (handed || justReplied || seat.listening) return null;
    return result("claude-not-listening");
  }

  // Received: the AI is working. Only direct evidence that it stopped counts.
  if (speaker === "astra") {
    if (seat.wake === "unloaded") return result("gpt-asleep");
    if (seat.wake === "reconnect" && pending.nativeBound) return result("gpt-reconnect");
    if (seat.nativeIdleSince) return result("gpt-stopped", seat.nativeIdleSince);
    return null;
  }
  const stopped = time(pending.claudeStoppedAt);
  if (!stopped || pending.noteAt) return null; // Any note this turn: it said it was waiting on something.
  // A prompt in the existing native chat resumes work without a SessionStart or room notice.
  if (time(seat.activityAt) > stopped) return null;
  // Anything Claude did after the stop (a notice it took, a check-in) means it's still going.
  const after = Math.max(time(pending.claudeInputAt), time(pending.claudeCheckInAt), time(pending.claudeClaimedAt));
  if (after >= stopped - 10 * SECOND && after > time(pending.claudeReminderAt)) return null;
  return result("claude-stopped", pending.claudeStoppedAt);
}

// Keeps when each reason was first seen for a room's turn, and reports it once it has held for its
// grace period. A reason that lapses starts over. Returns { reason, speaker, label, detail, since, key } or null.
export class AttentionTracker {
  // graceScale 0 shows every alert at once; only the dev harness uses it, for previews.
  constructor({ now = Date.now, graceScale = 1 } = {}) {
    this.now = now;
    this.graceScale = graceScale;
    this.seen = new Map();
  }
  // Forget rooms that no longer exist (deleted or unreadable), so the map can't grow forever.
  prune(roomNames) {
    const keep = new Set(roomNames);
    for (const key of this.seen.keys()) if (!keep.has(key.slice(0, key.indexOf("\u0000")))) this.seen.delete(key);
  }
  check(roomName, view, options = {}) {
    const now = this.now();
    const found = attentionReason(view, { ...options, now });
    const key = found ? `${view.pending.id}:${found.reason}` : null;
    for (const seenKey of this.seen.keys())
      if (seenKey.startsWith(`${roomName}\u0000`) && seenKey !== `${roomName}\u0000${key}`) this.seen.delete(seenKey);
    if (!found) return null;
    const mapKey = `${roomName}\u0000${key}`;
    if (!this.seen.has(mapKey)) this.seen.set(mapKey, now);
    const since = Math.max(this.seen.get(mapKey), time(found.since));
    const spec = REASONS[found.reason];
    if (now - since < spec.grace * this.graceScale) return null;
    return { reason: found.reason, speaker: found.speaker, label: spec.label(found.speaker),
      detail: spec.detail(found.speaker), since: new Date(since).toISOString(), key };
  }
}
