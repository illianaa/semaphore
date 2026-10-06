import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore, Semaphore } from '../lib/core.mjs';
import { queueHumanInput } from '../lib/inputs.mjs';
import { bindNativeWork, steerPending, steerEnded } from '../lib/steering.mjs';
import { WakePump } from '../lib/wake-delivery.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-steering-'));
  const store = new RoomStore(root, 'room'); store.acquire();
  t.after(() => { store.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const room = store.loadOrCreate();
  const verification = { pid: 42, started: 'Thu Sep 24 09:00:00 2026', socket: '/tmp/test.sock' };
  room.owner = 'astra'; room.participants.astra = { id: 'native-thread', transport: 'astra-inbox', seen: 0, wakeVerification: verification };
  room.pending = { id: 'room-turn', speaker: 'astra', state: 'awaiting-reply', receivedAt: new Date().toISOString(), through: 0,
    nativeWork: { ...verification, threadId: 'native-thread', turnId: 'native-turn' } };
  store.save(room);
  const run = () => ({ status: 0, stdout: '1 Thu Sep 24 09:00:00 2026' });
  const native = {
    activeId: 'native-turn', turns: [], calls: [], messages: [], fail: null, visible: true,
    initialize: async () => {}, close() {},
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'server/diagnostics') return { process: { id: 42 } };
      if (method === 'thread/loaded/list') return { data: ['native-thread'] };
      if (method === 'thread/queue/list') return { data: [] };
      if (method === 'thread/turns/list') return { data: [...(this.activeId ? [{ id: this.activeId, status: 'inProgress',
        items: this.visible ? this.messages : [] }] : []), ...this.turns], nextCursor: null };
      if (method === 'turn/steer') {
        assert.equal((params.clientUserMessageId.startsWith('semaphore-ended-') ? store.read().pending.endedDelivery : store.read().pending.steering.batch).status, 'sending', 'intent saved before sending');
        if (this.fail === 'before') throw new Error('connection lost');
        if (this.fail === 'ended') { this.activeId = null; throw Object.assign(new Error('no active turn to steer'), { rpc: true }); }
        assert.equal(params.expectedTurnId, this.activeId);
        this.messages.push({ type: 'userMessage', clientId: params.clientUserMessageId });
        if (this.fail === 'after') throw new Error('response lost');
        return { turnId: this.activeId };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const options = { client: native, runtime: { id: 42 }, loaded: ['native-thread'], socket: '/tmp/test.sock', run };
  const send = (text, n) => queueHumanInput(store, { text, to: 'astra', clientId: `human-input-${n}` });
  const receive = revision => new Semaphore(store, {}).receive('room-turn', 'astra', revision);
  const count = () => native.calls.filter(call => call.method === 'turn/steer').length;
  return { root, store, native, run, options, send, receive, count };
}

test('native receive binds only the currently active turn; an idle chat clears old work', async t => {
  const f = fixture(t); const room = f.store.read(); delete room.pending.nativeWork;
  await bindNativeWork(f.native, room);
  assert.equal(room.pending.nativeWork.turnId, 'native-turn');
  f.native.activeId = null;
  await bindNativeWork(f.native, room);
  assert.equal(room.pending.nativeWork, undefined);
});

test('durable human guidance steers once, preserves ownership/budget, and requires explicit receipt', async t => {
  const f = fixture(t); const before = f.store.read(); f.send('Use the smaller design.', 1);
  assert.equal(await steerPending(f.store, f.options), 'native-turn');
  await steerPending(f.store, f.options);
  const room = f.store.read();
  assert.equal(f.count(), 1);
  assert.equal(room.owner, 'astra'); assert.equal(room.pending.id, before.pending.id);
  assert.equal(room.autoTurns, before.autoTurns);
  assert.equal(room.pending.reviewThrough, 1); assert.equal(room.pending.steering.deliveredThrough, 1);
  assert.equal(room.messages[0].readAt, undefined);
  const command = f.native.calls.find(c => c.method === 'turn/steer').params.input[0].text;
  assert.match(command, /Before your next work step/); assert.match(command, /--revision 1/);
  assert.match(command, /adds no authorization/);
  const app = new Semaphore(f.store, {});
  assert.throws(() => app.commitReplyWithInputs('room-turn', 'astra', { message: 'done', next: 'human' }), { code: 'HUMAN_INPUT_REQUIRED' });
  f.receive(1);
  assert.equal(f.store.read().messages[0].readBy, 'astra');
  await steerPending(f.store, f.options); assert.equal(f.count(), 1);
  assert.equal(f.store.read().pending.steering.batch, undefined);
});

test('a second interjection waits for receipt so the first revision cannot become stale', async t => {
  const f = fixture(t); f.send('First guidance', 1); await steerPending(f.store, f.options);
  f.send('Second guidance', 2); await steerPending(f.store, f.options);
  assert.equal(f.count(), 1); assert.equal(f.store.read().pending.reviewThrough, 1);
  f.receive(1); await steerPending(f.store, f.options);
  assert.equal(f.count(), 2); assert.equal(f.store.read().pending.reviewThrough, 2);
  assert.equal(f.store.read().pending.steering.deliveredThrough, 2);
});

test('lost response remains uncertain until history confirms delivery, without resending', async t => {
  const f = fixture(t); f.send('Crucial input', 1); f.native.fail = 'after'; f.native.visible = false;
  assert.equal(await steerPending(f.store, f.options), null);
  assert.equal(f.store.read().pending.steering.deliveredThrough, undefined);
  await steerPending(f.store, f.options); assert.equal(f.count(), 1);
  assert.equal(f.store.read().pending.steering.batch.status, 'uncertain');
  f.native.visible = true;
  await steerPending(f.store, f.options);
  assert.equal(f.count(), 1); assert.equal(f.store.read().pending.steering.deliveredThrough, 1);
});

test('a lost send and a crash after durable intent never retry; before-reply receipt recovers', async t => {
  for (const failure of ['before', 'crash']) {
    const f = fixture(t); f.send('Saved input', 1); f.native.fail = 'before';
    await steerPending(f.store, f.options);
    if (failure === 'crash') { const room = f.store.read(); room.pending.steering.batch.status = 'sending'; f.store.save(room); }
    f.native.fail = null;
    await steerPending(f.store, f.options); await steerPending(f.store, f.options);
    assert.equal(f.count(), 1); assert.equal(f.store.read().pending.steering.deliveredThrough, undefined);
    f.receive(1); f.send('Fresh input after receipt', 2);
    await steerPending(f.store, f.options); assert.equal(f.count(), 2);
  }
});

test('turn ending during the RPC falls back without starting or steering another turn', async t => {
  const f = fixture(t); f.send('Saved input', 1); f.native.fail = 'ended';
  await steerPending(f.store, f.options);
  assert.equal(f.store.read().pending.steering.batch.status, 'rejected');
  f.native.fail = null; f.native.activeId = 'unrelated-turn';
  await steerPending(f.store, f.options);
  assert.equal(f.count(), 1); assert.equal(f.store.read().pending.steering.deliveredThrough, undefined);
  assert.ok(f.native.calls.every(c => !['turn/start', 'thread/resume', 'turn/interrupt', 'thread/queue/add'].includes(c.method)));
});

test('no steering after take, before receive, without exact work binding, or into a replaced runtime', async t => {
  for (const condition of ['take', 'unreceived', 'binding', 'thread', 'turn', 'pid', 'process', 'unloaded']) {
    const f = fixture(t); f.send('Saved input', 1); const room = f.store.read(); const options = { ...f.options };
    if (condition === 'take') room.owner = 'human';
    if (condition === 'unreceived') room.pending.receivedAt = null;
    if (condition === 'binding') delete room.pending.nativeWork;
    if (condition === 'thread') room.participants.astra.id = 'other-thread';
    if (condition === 'turn') f.native.activeId = 'other-turn';
    if (condition === 'pid') options.runtime = { id: 99 };
    if (condition === 'process') options.run = () => ({ status: 0, stdout: '1 replaced-engine' });
    if (condition === 'unloaded') options.loaded = [];
    f.store.save(room);
    assert.equal(await steerPending(f.store, options), null, condition); assert.equal(f.count(), 0, condition);
  }
});

test('pump advertises steering only for a fresh inspection of the exact received native turn', async t => {
  const f = fixture(t); f.store.release(); let now = 1000;
  const pump = new WakePump({ root: f.root, paths: { socket: '/tmp/test.sock' }, settings: () => ({ enabled: true }),
    clientFactory: () => f.native, run: f.run, now: () => now });
  const capable = () => pump.canSteer(f.store.read(), f.store.dir);
  assert.equal(capable(), false); await pump.tick(); assert.equal(capable(), true);
  now += 11000; assert.equal(capable(), false);
  await pump.tick(); assert.equal(capable(), true);
  f.native.activeId = 'different-turn'; await pump.tick(); assert.equal(capable(), false);
  f.native.activeId = 'native-turn'; await pump.tick(); assert.equal(capable(), true);
  f.send('After disconnect', 1); f.native.fail = 'before'; await pump.tick(); assert.equal(capable(), false);
  assert.equal(f.count(), 1);
});

test('the pump keeps its last steering answer while the next inspection runs', async t => {
  const f = fixture(t); f.store.release();
  const pump = new WakePump({ root: f.root, paths: { socket: '/tmp/test.sock' }, settings: () => ({ enabled: true }),
    clientFactory: () => f.native, run: f.run });
  const capable = () => pump.canSteer(f.store.read(), f.store.dir);
  await pump.tick(); assert.equal(capable(), true);
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const request = f.native.request;
  f.native.request = async function (method, params) {
    if (method === 'thread/turns/list') await gate;
    return request.call(this, method, params);
  };
  const tick = pump.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(capable(), true, 'no flicker while the room is being inspected');
  resume(); await tick;
  assert.equal(capable(), true);
});

test('a locked room keeps a recent steering answer but cannot refresh its age', async t => {
  const f = fixture(t); f.store.release(); let now = 1000;
  const pump = new WakePump({ root: f.root, paths: { socket: '/tmp/test.sock' }, settings: () => ({ enabled: true }),
    clientFactory: () => f.native, run: f.run, now: () => now });
  const capable = () => pump.canSteer(f.store.read(), f.store.dir);
  await pump.tick(); assert.equal(capable(), true);
  f.store.acquire(); now += 1500;
  await pump.tick(); assert.equal(capable(), true, 'short lock does not flicker');
  f.native.activeId = null; now += 11000;
  await pump.tick();
  assert.equal(pump.mode(f.store.read().participants.astra, f.store.dir), 'automatic', 'engine inspection is fresh');
  assert.equal(capable(), false, 'the separate room inspection expired');
  f.store.release(); f.native.activeId = 'native-turn';
  await pump.tick(); assert.equal(capable(), true);
});

test('ending steers a stop once into the exact working GPT turn, never a replacement turn', async t => {
  const f = fixture(t);
  new Semaphore(f.store, {}).end();
  await steerEnded(f.store, f.options);
  await steerEnded(f.store, f.options);
  assert.equal(f.count(), 1);
  assert.equal(f.store.read().pending.endedDelivery.status, 'sent');
  assert.match(f.native.calls.find(c => c.method === 'turn/steer').params.input[0].text, /person ended this conversation/);
});

test('ending never steers into a later GPT turn, and an uncertain stop is not retried', async t => {
  const f = fixture(t);
  new Semaphore(f.store, {}).end();
  f.native.activeId = 'another-turn';
  await steerEnded(f.store, f.options);
  assert.equal(f.count(), 0);
  f.native.activeId = 'native-turn'; f.native.fail = 'after';
  await steerEnded(f.store, f.options);
  await steerEnded(f.store, f.options);
  assert.equal(f.count(), 1);
  assert.equal(f.store.read().pending.endedDelivery.status, 'uncertain');
});
