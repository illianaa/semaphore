import fs from "node:fs";
import path from "node:path";

const validId = value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value ?? "");
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const observationPath = (roomDir, speaker, turnId) => {
  if (!["astra", "claude"].includes(speaker) || !validId(turnId)) throw new Error("Invalid observation identity.");
  return path.join(roomDir, "inbox", speaker, "observed", `${turnId}.json`);
};

// Advisory evidence, not a read receipt. The authenticated CLI listener calls
// this only for mail still belonging to its native binding. A separate exclusive
// file avoids waiting on a room lock held by the sender. First observation wins.
export function recordListenerObservation(roomDir, item) {
  try {
    const file = observationPath(roomDir, item.turn.speaker, item.turn.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ roomId: item.roomId, session: item.session,
        turnId: item.turn.id, speaker: item.turn.speaker, observedAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch { /* Missing instrumentation must never prevent delivery or imply receipt. */ }
}

export function timingView(room, roomDir, turn = room.pending, outcome) {
  if (!turn) return null;
  let listenerObservedAt = iso(turn.timing?.listenerObservedAt);
  try {
    const observed = JSON.parse(fs.readFileSync(observationPath(roomDir, turn.speaker, turn.id), "utf8"));
    if (observed.roomId === room.id && observed.turnId === turn.id && observed.speaker === turn.speaker &&
        observed.session === (turn.timing?.session ?? room.participants[turn.speaker]?.id))
      listenerObservedAt ??= iso(observed.observedAt);
  } catch { /* Legacy, automatic-wake or unobserved turn. */ }
  return { turnId: turn.id, speaker: turn.speaker,
    transport: turn.timing?.transport ?? turn.receipt?.transport ?? "unknown",
    route: turn.wake?.queuedAt ? listenerObservedAt ? "automatic+listener" : "automatic" : listenerObservedAt ? "listener" : turn.timing?.route ?? "unknown",
    instrumentation: turn.timing?.transport ? "v1" : "legacy",
    startedAt: iso(turn.at), queuedAt: iso(turn.receipt?.at), listenerObservedAt,
    nativeQueuedAt: iso(turn.wake?.queuedAt),
    // Discovery of a host turn is an upper bound, not its actual delivery time.
    hostStartedObservedAt: iso(turn.wake?.startedObservedAt), hostDeliveredAt: null,
    acknowledgedAt: iso(turn.receivedAt), repliedAt: iso(turn.timing?.repliedAt),
    failedAt: iso(turn.timing?.failedAt), failureCode: turn.timing?.failureCode ?? null,
    outcome: outcome ?? (turn.state === "uncertain" ? "uncertain" : turn.receivedAt ? "acknowledged" : turn.receipt ? "queued" : "delivering") };
}

const phases = { deliveryToQueue: ["startedAt", "queuedAt"], queueToListener: ["queuedAt", "listenerObservedAt"],
  queueToAcknowledgment: ["queuedAt", "acknowledgedAt"], listenerToAcknowledgment: ["listenerObservedAt", "acknowledgedAt"],
  nativeQueueToHostObservation: ["nativeQueuedAt", "hostStartedObservedAt"], acknowledgmentToReply: ["acknowledgedAt", "repliedAt"] };

export function timingReport(room, roomDir) {
  const turns = new Map();
  // Preserve useful old queue/receipt data, explicitly labeled legacy. Never
  // invent listener or host timestamps from queue disappearance.
  for (const event of room.events ?? []) {
    const id = event.detail?.turnId;
    if (!id) continue;
    if (event.type === "turn-timing") { turns.set(id, structuredClone(event.detail)); continue; }
    if (!["delivery-queued", "turn-received"].includes(event.type) || turns.get(id)?.instrumentation === "v1") continue;
    const row = turns.get(id) ?? { turnId: id, instrumentation: "legacy", route: "unknown", outcome: "queued" };
    if (event.type === "delivery-queued") {
      row.transport = event.detail.receipt?.transport ?? "unknown";
      row.queuedAt = iso(event.detail.receipt?.at);
      row.speaker = row.transport === "claude-inbox" ? "claude" : ["astra-inbox", "codex-queue"].includes(row.transport) ? "astra" : "unknown";
    } else { row.acknowledgedAt = iso(event.at); row.speaker = event.detail.speaker; row.outcome = "acknowledged"; }
    turns.set(id, row);
  }
  for (const message of room.messages ?? []) {
    const row = turns.get(message.turnId);
    if (row && row.instrumentation === "legacy") { row.repliedAt = iso(message.at); row.outcome = "replied"; }
  }
  if (room.pending) turns.set(room.pending.id, timingView(room, roomDir));
  const samples = [...turns.values()], groups = new Map();
  for (const sample of samples) {
    const key = [sample.speaker, sample.transport, sample.route, sample.instrumentation].join("/");
    if (!groups.has(key)) groups.set(key, { speaker: sample.speaker, transport: sample.transport, route: sample.route,
      instrumentation: sample.instrumentation, turns: 0, failures: sample.instrumentation === "legacy" ? null : 0, outcomes: {}, phases: {} });
    const group = groups.get(key); group.turns++; if (sample.failedAt && group.failures !== null) group.failures++;
    group.outcomes[sample.outcome] = (group.outcomes[sample.outcome] ?? 0) + 1;
    for (const [name, [start, end]] of Object.entries(phases)) {
      const phase = group.phases[name] ??= { values: [], missing: 0, clockReversed: 0 };
      if (!iso(sample[start]) || !iso(sample[end])) { phase.missing++; continue; }
      const duration = Date.parse(sample[end]) - Date.parse(sample[start]);
      if (duration < 0) phase.clockReversed++;
      else phase.values.push(duration);
    }
  }
  for (const group of groups.values()) for (const [name, phase] of Object.entries(group.phases)) {
    const values = phase.values.sort((a, b) => a - b), n = values.length;
    const percentile = p => n ? values[Math.ceil(n * p) - 1] : null;
    group.phases[name] = { count: n, missing: phase.missing, clockReversed: phase.clockReversed,
      minMs: n ? values[0] : null, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: n ? values[n - 1] : null };
  }
  return { room: room.name, measuredAt: new Date().toISOString(),
    note: "Local wall-clock observations, grouped by speaker/transport/route. Missing stages are unknown, not zero. Host busy time and model work are not isolated. Legacy failure counts are unavailable.",
    groups: [...groups.values()], samples };
}
