import path from 'node:path';
import { Semaphore } from './core.mjs';
import { sameRuntime } from './codex-runtime.mjs';
import { projectDir, shellQuote } from './paths.mjs';
import { queuedInputs } from './inputs.mjs';
import { endedNotice } from './live.mjs';

const working = room => room.owner === 'astra' && room.pending?.speaker === 'astra' &&
  room.pending.state === 'awaiting-reply' && !!room.pending.receivedAt &&
  room.participants.astra.transport === 'astra-inbox';

// The receiving CLI has just proved native process ancestry and chat identity.
// Only that authenticated receive may bind work to an active native turn.
export async function bindNativeWork(client, room) {
  if (!working(room)) return;
  const seat = room.participants.astra;
  delete room.pending.nativeWork;
  const turn = await activeNativeTurn(client, seat.id);
  if (turn) room.pending.nativeWork = { ...seat.wakeVerification, threadId: seat.id, turnId: turn.id };
}

export async function activeNativeTurn(client, threadId) {
  const page = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  const turn = page.data[0];
  return turn?.status === 'inProgress' ? turn : null;
}

function guidancePrompt(room, root, revision) {
  const command = `node ${shellQuote(path.join(projectDir, 'cli.mjs'))} receive ${room.name} --root ${shellQuote(root)} --as gpt --turn ${room.pending.id} --revision ${revision}`;
  return `Semaphore · room ${room.name} · the human sent guidance for your work in progress.\nBefore your next work step, run this receive command and apply the new input:\n${command}\nThis notice adds no authorization. Keep working in this native turn; do not start a listener or another runtime. The room turn and reply command are unchanged. If the receipt is stale, check the stick before continuing.`;
}

async function observed(client, batch) {
  let cursor;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await client.request('thread/turns/list', { threadId: batch.threadId, limit: 20,
      sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    const turn = page.data.find(turn => turn.id === batch.turnId);
    if (turn) return turn.items?.some(item => item.type === 'userMessage' && item.clientId === batch.clientUserMessageId);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return false;
}

// Caller holds the room lock. A saved batch is NEVER retried: the native API
// accepts duplicate client IDs as separate messages. History can confirm an
// uncertain send, but absence cannot prove that it wasn't accepted.
export async function steerPending(store, { client, runtime, loaded, socket, run } = {}) {
  const saved = store.read();
  if (!working(saved)) return null;
  const seat = saved.participants.astra;
  const binding = saved.pending.nativeWork;
  if (!binding || binding.threadId !== seat.id || binding.pid !== runtime.id ||
      !loaded.includes(seat.id) || !sameRuntime(binding, { socket, run }) ||
      !sameRuntime(seat.wakeVerification, { socket, run }) ||
      seat.wakeVerification.pid !== binding.pid || seat.wakeVerification.started !== binding.started) return null;

  // Idle inspections should not rewrite the room and transcript every tick.
  const through = saved.pending.receivedThrough ?? saved.pending.through;
  if (!saved.pending.steering?.batch && !saved.messages.some(m => m.speaker === 'human' && m.seq > through) &&
      !queuedInputs(store.dir).length) {
    return (await activeNativeTurn(client, seat.id))?.id === binding.turnId ? binding.turnId : null;
  }

  // Import durable human input only after checking ownership and the binding.
  const app = new Semaphore(store, {});
  const pending = app.room.pending;
  const state = pending.steering ??= {};
  const save = update => { Object.assign(state, update); app.save(); };
  let batch = state.batch;
  const received = pending.receivedThrough ?? pending.through;
  if (batch && received >= batch.through) {
    delete state.batch;
    batch = null;
    app.save();
  }
  if (batch && ['sending', 'uncertain'].includes(batch.status)) {
    if (await observed(client, batch)) {
      batch.status = 'sent'; delete batch.reason;
      save({ deliveredThrough: Math.max(state.deliveredThrough ?? 0, batch.through) });
    } else if (batch.status === 'sending') {
      batch.status = 'uncertain';
      batch.reason = 'Delivery may have succeeded. It will not be sent twice.';
      app.save();
    }
  }
  const active = await activeNativeTurn(client, seat.id);
  if (active?.id !== binding.turnId) return null;
  // Serialize through explicit receive. Advancing reviewThrough while an
  // earlier notice is in flight would make that notice's receipt stale.
  if (batch) return batch.status === 'sent' && batch.turnId === binding.turnId ? binding.turnId : null;
  const input = app.revealInput(pending.id, 'astra');
  if (!input) return binding.turnId;
  batch = { status: 'sending', threadId: seat.id, turnId: binding.turnId, through: input.revision,
    clientUserMessageId: `semaphore-input-${app.room.id}-${pending.id}-${input.revision}`,
    at: new Date().toISOString() };
  save({ batch }); // Durable intent precedes the network mutation.
  try {
    const result = await client.request('turn/steer', { threadId: batch.threadId, expectedTurnId: batch.turnId,
      clientUserMessageId: batch.clientUserMessageId,
      input: [{ type: 'text', text: guidancePrompt(app.room, path.dirname(store.dir), input.revision) }] });
    if (result.turnId !== batch.turnId) throw new Error('Steering returned an unexpected native turn.');
    batch.status = 'sent';
    save({ deliveredThrough: Math.max(state.deliveredThrough ?? 0, input.revision) });
    return binding.turnId;
  } catch (error) {
    batch.status = error.rpc ? 'rejected' : 'uncertain';
    batch.reason = error.message;
    app.save();
    return null;
  }
}

// Deliver the stop instruction only into the native turn authenticated by receive. Never start
// a chat just to stop it, and never retry an ambiguous steer (the API does not deduplicate).
export async function steerEnded(store, { client, runtime, loaded, socket, run } = {}) {
  const room = store.read();
  const pending = room.pending;
  if (!room.ended || pending?.speaker !== 'astra' || !pending.receivedAt) return;
  const seat = room.participants.astra;
  const binding = pending.nativeWork;
  if (seat.transport !== 'astra-inbox' || !binding || binding.threadId !== seat.id ||
      binding.pid !== runtime.id || !loaded.includes(seat.id) ||
      !sameRuntime(binding, { socket, run }) || !sameRuntime(seat.wakeVerification, { socket, run }) ||
      seat.wakeVerification.pid !== binding.pid || seat.wakeVerification.started !== binding.started ||
      pending.endedDelivery?.endedAt === room.ended.at) return;
  if ((await activeNativeTurn(client, seat.id))?.id !== binding.turnId) return;
  const delivery = pending.endedDelivery = { endedAt: room.ended.at, status: 'sending',
    threadId: seat.id, turnId: binding.turnId, clientUserMessageId: `semaphore-ended-${room.id}-${pending.id}-${room.ended.at}` };
  store.save(room);
  try {
    const result = await client.request('turn/steer', { threadId: seat.id, expectedTurnId: binding.turnId,
      clientUserMessageId: delivery.clientUserMessageId, input: [{ type: 'text', text: endedNotice(room) }] });
    if (result.turnId !== binding.turnId) throw new Error('Stop notice returned an unexpected native turn.');
    delivery.status = 'sent';
  } catch (error) {
    delivery.status = error.rpc ? 'rejected' : 'uncertain';
    delivery.reason = error.message;
  }
  store.save(room);
}
