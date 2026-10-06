import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore, Semaphore } from '../lib/core.mjs';
import { queueHumanInput } from '../lib/inputs.mjs';
import { turnGuidance } from '../lib/live.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-end-'));
  const store = new RoomStore(root, 'room'); store.acquire();
  t.after(() => { store.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const room = store.loadOrCreate();
  for (const speaker of ['astra', 'claude']) room.participants[speaker] = { id: speaker, transport: `${speaker}-inbox`, seen: 0 };
  store.save(room);
  const adapters = Object.fromEntries(['astra', 'claude'].map(speaker => [speaker, { kind: `${speaker}-inbox`,
    async deliver({ turn }) { return { status: 'queued', turnId: turn.id, transport: `${speaker}-inbox` }; } }]));
  const app = new Semaphore(store, adapters);
  return { store, app, adapters };
}

test('end survives reload, closes asks, and rejects work until explicit reopen and recovery', async t => {
  const { store, app, adapters } = fixture(t);
  await app.send('Build it', 'astra');
  const id = app.room.pending.id;
  app.receive(id, 'astra');
  app.note({ turnId: id, speaker: 'astra', text: 'Working' });
  app.room.asks = [{ status: 'open' }, { status: 'answered' }];
  app.end();
  const ended = structuredClone(store.read());
  app.end();
  assert.deepEqual(store.read(), ended, 'end is idempotent');
  assert.equal(ended.owner, 'human');
  assert.equal(ended.pending.state, 'uncertain');
  assert.equal(ended.statusNote, undefined);
  assert.equal(ended.asks[0].status, 'closed');
  assert.equal(ended.asks[1].status, 'answered');
  const next = new Semaphore(store, adapters);
  assert.throws(() => next.receive(id, 'astra'), { code: 'ROOM_ENDED' });
  assert.throws(() => next.note({ turnId: id, speaker: 'astra', text: 'More work' }), { code: 'ROOM_ENDED' });
  await assert.rejects(next.accept({ turnId: id, speaker: 'astra', message: 'Late reply', next: 'claude' }), { code: 'ROOM_ENDED' });
  await assert.rejects(next.send('More', 'claude'), { code: 'ROOM_ENDED' });
  await assert.rejects(next.pass('claude'), { code: 'ROOM_ENDED' });
  assert.throws(() => next.recover(), { code: 'ROOM_ENDED' });
  assert.throws(() => queueHumanInput(store, { text: 'Queued', to: 'astra', clientId: 'input-ended-1' }), /has ended/);
  assert.match(turnGuidance({ room: next.room, speaker: 'astra' }), /Do not reply, restart a listener, reopen it/);
  next.reopen();
  assert.equal(next.room.owner, 'human');
  assert.equal(next.room.pending.id, id);
  await assert.rejects(next.pass('astra'), /uncertain/);
  next.recover();
  await next.pass('astra');
  assert.notEqual(next.room.pending.id, id);
  await assert.rejects(next.accept({ turnId: id, speaker: 'astra', message: 'Still late', next: 'human' }), /Stale reply/);
});

test('ending during setup prevents join from dispatching the saved opening', async t => {
  const { app } = fixture(t);
  app.room.participants.claude.id = null;
  await app.setOpening('Opening', 'astra', { clientId: 'opening-end-1' });
  app.end();
  app.room.participants.claude.id = 'claude';
  await app.startOpening();
  assert.equal(app.room.owner, 'human');
  assert.equal(app.room.pending, null);
  app.reopen();
  await app.startOpening();
  assert.equal(app.room.pending, null, 'reopen does not dispatch the opening');
  await app.pass('astra');
  assert.equal(app.room.owner, 'astra');
});

test('end aborts in-flight delivery without losing the ended state or accepting its late result', async t => {
  const { app, store } = fixture(t);
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  app.adapters.astra.deliver = async ({ signal, turn }) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'queued', turnId: turn.id, transport: 'astra-inbox' };
  };
  const delivering = app.send('Start', 'astra');
  await entered;
  app.end();
  await assert.rejects(delivering, /took the talking stick/);
  assert.ok(store.read().ended);
  assert.equal(store.read().pending.state, 'uncertain');
  assert.equal(store.read().messages.length, 1);
});
