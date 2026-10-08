import fs from 'node:fs';
import path from 'node:path';
import { RoomStore } from './core.mjs';
import { listenerStatus } from './live.mjs';
import { WakeClient, loadedThreads, sameRuntime, processInfo } from './codex-runtime.mjs';
import { readWakeSettings, wakePaths } from './wake.mjs';
import { projectDir, shellQuote } from './paths.mjs';
import { steerPending, steerEnded, activeNativeTurn } from './steering.mjs';

const timestamp = () => new Date().toISOString();
const actionable = room => room.pending?.speaker === 'astra' && room.pending.state === 'awaiting-reply' &&
  !room.pending.receivedAt && room.owner === 'astra' && room.participants.astra.transport === 'astra-inbox';

export async function nativeQueue(client, threadId) {
  const all = []; let cursor;
  do {
    const page = await client.request('thread/queue/list', { threadId, ...(cursor ? { cursor } : {}) });
    all.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  return all;
}

export function wakePrompt(room, root) {
  const command = `node ${shellQuote(path.join(projectDir, 'cli.mjs'))} receive ${room.name} --root ${shellQuote(root)} --as gpt --turn ${room.pending.id}`;
  return `Semaphore · room ${room.name} · GPT has a saved turn.\nRun this receive command first to read the room's current messages and authorization:\n${command}\nThis is an automatic delivery notice, not additional authorization. After replying and passing the stick, end your turn if Semaphore confirms automatic wake. Stay in this native chat; never resume it from another runtime.`;
}

async function findWakeTurn(client, threadId, clientId) {
  let cursor;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await client.request('thread/turns/list', { threadId, limit: 20, itemsView: 'full', ...(cursor ? { cursor } : {}) });
    const turn = page.data.find(turn => turn.items?.some(item => item.type === 'userMessage' && item.clientId === clientId));
    if (turn) return turn;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return null;
}

// Call under the room lock. Both intent and receipt are durable. A timeout may
// have enqueued/started a turn, so absence is never permission to enqueue again.
export async function wakePending(store, { client, runtime, loaded, socket, run, isListening = listenerStatus, now = Date.now } = {}) {
  const room = store.read();
  if (!actionable(room)) return;
  const seat = room.participants.astra;
  const pending = room.pending;
  if (!fs.existsSync(path.join(store.dir, 'inbox', 'astra', `${pending.id}.json`))) return;
  if (isListening(store.dir, 'astra').active) return;
  const save = update => {
    pending.wake = { ...pending.wake, ...update, at: timestamp() };
    store.save(room);
  };
  if (!sameRuntime(seat.wakeVerification, { socket, run }) || seat.wakeVerification.pid !== runtime.id || !loaded.includes(seat.id)) {
    if (!pending.wake || pending.wake.status === 'blocked')
      save({ status: 'blocked', reason: 'Open GPT’s chat in ChatGPT and reconnect it to this room.' });
    return;
  }
  if (pending.wake?.status === 'sent') return;
  const { thread: current } = await client.request('thread/read', { threadId: seat.id });
  if (current.status.type !== 'idle' && !pending.wake?.clientUserMessageId) return;
  const messageId = `semaphore-${room.id}-${pending.id}`;
  let queue = (await nativeQueue(client, seat.id)).filter(item => item.clientUserMessageId === messageId);
  if (queue.length > 1) { save({ status: 'uncertain', reason: 'More than one wake message exists. Inspect GPT’s native queue.' }); return; }
  if (!queue.length) {
    if (pending.wake && !['blocked'].includes(pending.wake.status)) {
      const started = await findWakeTurn(client, seat.id, messageId);
      save(started ? { status: 'sent', nativeTurnId: started.id,
        startedObservedAt: pending.wake?.startedObservedAt ?? new Date(now()).toISOString(), reason: null }
        : { status: 'uncertain', reason: 'The wake may already have started. It will not be sent twice.' });
      return;
    }
    save({ status: 'queueing', clientUserMessageId: messageId });
    try {
      const result = await client.request('thread/queue/add', { threadId: seat.id, clientUserMessageId: messageId,
        input: [{ type: 'text', text: wakePrompt(room, path.dirname(store.dir)) }] });
      queue = [result.queuedSubmission];
    } catch (error) {
      save({ status: 'uncertain', reason: error.message });
      return;
    }
  }
  const queued = queue[0];
  const queuedAt = pending.wake?.queuedAt ?? new Date(now()).toISOString();
  const needsSend = current.status.type === 'idle' && now() - Date.parse(queuedAt) >= 15000;
  save({ status: needsSend ? 'needs-send' : 'queued', queuedAt,
    queuedSubmissionId: queued.id, clientUserMessageId: messageId,
    reason: needsSend ? 'Open GPT’s chat in ChatGPT and press Send on the queued Semaphore notice.' : null });
  // The shared runtime automatically consumes its native queue, including
  // after a busy turn. Do not call turn/start (which steers) or queue/start
  // (which could jump past a person's earlier queued message). An interrupted
  // native turn can pause queue draining; show the native Send action instead
  // of undoing the app's pause or repeatedly adding the notice.
}

// If a foreground listener or a manual native turn receives the room first,
// remove our still-queued wake notice. This never removes the person's input.
export async function cancelQueuedWake(client, room) {
  const pending = room.pending;
  if (pending?.speaker !== 'astra' || !pending.wake?.clientUserMessageId) return;
  for (const item of await nativeQueue(client, room.participants.astra.id)) {
    if (item.clientUserMessageId === pending.wake.clientUserMessageId)
      await client.request('thread/queue/delete', { threadId: room.participants.astra.id, queuedSubmissionId: item.id });
  }
}

async function pruneClosedWakes(client, room) {
  const expected = actionable(room) ? `semaphore-${room.id}-${room.pending.id}` : null;
  for (const item of await nativeQueue(client, room.participants.astra.id)) {
    if (item.clientUserMessageId?.startsWith(`semaphore-${room.id}-`) && item.clientUserMessageId !== expected)
      await client.request('thread/queue/delete', { threadId: room.participants.astra.id, queuedSubmissionId: item.id });
  }
}

export class WakePump {
  constructor({ root, paths = wakePaths(), settings = () => readWakeSettings(paths.settings),
    clientFactory = () => new WakeClient({ socket: paths.socket }), run, intervalMs = 1500, now = Date.now } = {}) {
    Object.assign(this, { root, paths, settings, clientFactory, run, intervalMs, now });
    this.loaded = new Set(); this.runtime = null; this.checkedAt = null; this.working = new Map();
    // Rooms whose received GPT turn has no native turn running: GPT's chat went idle without
    // replying. Only an inspection of the exact bound chat sets it; anything else clears it.
    this.idle = new Map();
  }
  // When GPT's chat was first seen idle while it still holds this exact received turn, or null.
  // A recent inspection is required: an old or missing snapshot is not evidence.
  nativeIdleSince(room) {
    const idle = this.idle.get(room.name);
    if (!idle || idle.turnId !== room.pending?.id || room.pending?.speaker !== 'astra' || room.owner !== 'astra' ||
        room.pending.state !== 'awaiting-reply' || !room.pending.receivedAt || room.ended) return null;
    if (this.checkedAt === null || this.now() - this.checkedAt > Math.max(10000, this.intervalMs * 4)) return null;
    return new Date(idle.since).toISOString();
  }
  canSteer(room, roomDir) {
    const inspected = this.working.get(room.name);
    return this.mode(room.participants.astra, roomDir) === 'automatic' &&
      room.owner === 'astra' && room.pending?.speaker === 'astra' &&
      room.pending.state === 'awaiting-reply' && !!room.pending.receivedAt &&
      !!room.pending.nativeWork?.turnId &&
      inspected?.turnId === room.pending.nativeWork.turnId &&
      this.now() - inspected.checkedAt <= Math.max(10000, this.intervalMs * 4);
  }
  mode(participant, roomDir) {
    if (participant?.transport !== 'astra-inbox' || !participant.id) return undefined;
    if (listenerStatus(roomDir, 'astra').active) return 'listening';
    if (!this.settings().enabled) return 'off';
    // A missing/stale inspection cannot prove that a chat is unloaded or that
    // its binding is wrong. Publish only a complete, recent engine snapshot.
    if (!this.runtime || this.checkedAt === null)
      return this.lastError ? 'unavailable' : 'checking';
    if (this.now() - this.checkedAt > Math.max(10000, this.intervalMs * 4)) return 'unavailable';
    const verified = participant.wakeVerification;
    if (!verified || verified.socket !== this.paths.socket || verified.pid !== this.runtime.id ||
      this.runtime.started !== verified.started) return 'reconnect';
    return this.loaded.has(participant.id) ? 'automatic' : 'unloaded';
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let client;
    try {
      if (!this.settings().enabled) { this.loaded.clear(); this.working.clear(); this.idle.clear(); this.runtime = null; this.checkedAt = null; this.lastError = null; return; }
      client = this.clientFactory(); this.client = client;
      await client.initialize();
      const { process: runtime } = await client.request('server/diagnostics');
      const info = processInfo(runtime.id, this.run);
      if (!info) throw new Error('The shared Codex engine could not be inspected.');
      const loaded = await loadedThreads(client);
      this.runtime = { ...runtime, started: info.started }; this.loaded = new Set(loaded);
      this.checkedAt = this.now(); this.lastError = null;
      // Built during the tick and swapped in at the end: the app reads steering availability
      // between the tick's awaits, and must never see a half-built snapshot.
      const working = new Map();
      const idle = new Map();
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name)) continue;
        const store = new RoomStore(this.root, entry.name);
        try {
          const saved = store.read();
          const seat = saved.participants.astra;
          if (seat?.transport !== 'astra-inbox' || !loaded.includes(seat.id) ||
            seat.wakeVerification?.pid !== runtime.id || !sameRuntime(seat.wakeVerification, { socket: this.paths.socket, run: this.run })) continue;
          store.acquire();
          await pruneClosedWakes(client, store.read());
          await wakePending(store, { client, runtime, loaded, socket: this.paths.socket, run: this.run });
          await steerEnded(store, { client, runtime, loaded, socket: this.paths.socket, run: this.run });
          const nativeTurn = await steerPending(store, { client, runtime, loaded, socket: this.paths.socket, run: this.run });
          if (nativeTurn) working.set(entry.name, { turnId: nativeTurn, checkedAt: this.now() });
          else {
            // A received turn bound to this chat's native turn, and nothing running in the chat now:
            // GPT ended its turn without replying. A new native turn (the person typing there) is not idle.
            const room = store.read();
            const pending = room.pending;
            if (!room.ended && room.owner === 'astra' && pending?.speaker === 'astra' && pending.state === 'awaiting-reply' &&
                pending.receivedAt && pending.nativeWork?.threadId === seat.id && pending.nativeWork.pid === runtime.id &&
                !(await activeNativeTurn(client, seat.id))) {
              const before = this.idle.get(entry.name);
              idle.set(entry.name, { turnId: pending.id, since: before?.turnId === pending.id ? before.since : this.now() });
            }
          }
        } catch (error) {
          // Another process can be committing a reply or receive. The next
          // local tick will read the new state; it never creates a model turn.
          // Keep the original inspection time: a lock cannot renew its freshness.
          if (error.code === 'ROOM_LOCKED' && this.working.has(entry.name)) working.set(entry.name, this.working.get(entry.name));
          if (error.code === 'ROOM_LOCKED' && this.idle.has(entry.name)) idle.set(entry.name, this.idle.get(entry.name));
          if (error.code !== 'ROOM_LOCKED' && error.code !== 'ENOENT') this.lastError = error.message;
        } finally { store.release(); }
      }
      this.working = working;
      this.idle = idle;
    } catch (error) {
      this.lastError = error.message; this.loaded.clear(); this.working.clear(); this.idle.clear(); this.runtime = null;
    } finally { client?.close(); this.client = null; this.busy = false; }
  }
  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); void this.tick(); }
  close() { this.stopped = true; clearInterval(this.timer); this.client?.close(); }
}
