import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore, Semaphore } from '../lib/core.mjs';
import { liveEnvelope } from '../lib/live.mjs';
import { askViews, askSummary } from '../lib/asks.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-asks-'));
  const store = new RoomStore(root, 'room'); store.acquire();
  t.after(() => { store.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const room = store.loadOrCreate();
  for (const speaker of ['astra', 'claude']) room.participants[speaker] = { id: speaker, transport: `${speaker}-inbox`, seen: 0 };
  store.save(room);
  const delivered = [];
  const adapters = Object.fromEntries(['astra', 'claude'].map(speaker => [speaker, { kind: `${speaker}-inbox`,
    async deliver({ turn }) { delivered.push(turn); return { status: 'queued', turnId: turn.id, transport: `${speaker}-inbox` }; } }]));
  const app = new Semaphore(store, adapters);
  // Claude holds a received turn.
  const working = async (speaker = 'claude') => {
    await app.send('Plan the launch', speaker);
    const id = app.room.pending.id;
    app.receive(id, speaker);
    return id;
  };
  return { root, store, app, adapters, delivered, working };
}
const reply = (app, turnId, speaker, next = 'human') => app.accept({ turnId, speaker, message: 'Filed my question.', next });

test('a request needs the received turn, and a retry finds the request it already filed', async t => {
  const { app, store, working } = fixture(t);
  await app.send('Plan the launch', 'claude');
  const queued = app.room.pending.id;
  assert.throws(() => app.fileAsk({ turnId: queued, speaker: 'claude', title: 'Which date?' }), /Receive this turn before changing requests/);
  app.receive(queued, 'claude');
  assert.throws(() => app.fileAsk({ turnId: queued, speaker: 'astra', title: 'Which date?' }), /Stale requests/);
  const input = { turnId: queued, speaker: 'claude', title: '  Launch on Tuesday   or Thursday? ', options: ['Tuesday', 'Thursday'], detail: 'Thursday gives QA a day.', blocking: true };
  const first = app.fileAsk(input);
  assert.equal(first.changed, true);
  assert.deepEqual(
    { kind: first.ask.kind, title: first.ask.title, options: first.ask.options, blocking: first.ask.blocking, status: first.ask.status, from: first.ask.from },
    { kind: 'decision', title: 'Launch on Tuesday or Thursday?', options: ['Tuesday', 'Thursday'], blocking: true, status: 'open', from: 'claude' });
  const again = app.fileAsk(input);
  assert.equal(again.changed, false);
  assert.equal(again.ask.id, first.ask.id);
  assert.equal(store.read().asks.length, 1, 'a lost response and a retry make one card');
  // An explicit request ID can't be reused for something else; --id updates in place instead.
  app.fileAsk({ turnId: queued, speaker: 'claude', requestId: 'copy-review-01', title: 'Review the launch copy?', kind: 'review' });
  assert.throws(() => app.fileAsk({ turnId: queued, speaker: 'claude', requestId: 'copy-review-01', title: 'Something else?' }), /already filed request .* Update it with --id/);
  const updated = app.fileAsk({ turnId: queued, speaker: 'claude', id: first.ask.id, title: 'Launch on Tuesday or Thursday next week?', options: ['Tuesday', 'Thursday'] });
  assert.equal(updated.changed, true);
  assert.equal(updated.ask.detail, undefined, 'an update replaces the fields');
  assert.equal(updated.ask.blocking, false);
  assert.ok(updated.ask.updatedAt);
  assert.throws(() => app.fileAsk({ turnId: queued, speaker: 'claude', id: 'nope', title: 'x' }), /no request nope/);
  assert.deepEqual(store.read().events.filter(e => e.type.startsWith('ask')).map(e => e.type), ['ask', 'ask', 'ask-updated']);
  assert.equal(app.room.messages.length, 1, 'filing never adds a message');
  assert.equal(app.room.owner, 'claude', 'or passes the stick');
});

test('requests are validated, kept small, and limited to five open per AI', async t => {
  const { app, working } = fixture(t);
  const turnId = await working();
  const file = (extra) => app.fileAsk({ turnId, speaker: 'claude', ...extra });
  assert.throws(() => file({ title: '   ' }), /one-line title/);
  assert.throws(() => file({ title: 'x'.repeat(161) }), /160 characters/);
  assert.throws(() => file({ title: 'Pick', options: ['A', 'a'] }), /Options must differ/);
  assert.throws(() => file({ title: 'Pick', options: Array.from({ length: 7 }, (_, i) => `O${i}`) }), /at most 6 options/);
  assert.throws(() => file({ title: 'Pick', options: ['y'.repeat(81)] }), /1–80 characters/);
  assert.throws(() => file({ title: 'Pick', kind: 'urgent' }), /--kind must be/);
  assert.throws(() => file({ title: 'Pick', detail: 'z'.repeat(2001) }), /2000 characters/);
  assert.equal(file({ title: 'What is the staging URL?' }).ask.kind, 'info');
  for (let i = 1; i < 5; i++) file({ title: `Question ${i}` });
  assert.throws(() => file({ title: 'One too many' }), /already have 5 open requests/);
  const withdrawn = app.withdrawAsk({ turnId, speaker: 'claude', id: app.room.asks[0].id, reason: 'Found it in the README' });
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.reason, 'Found it in the README');
  assert.equal(app.withdrawAsk({ turnId, speaker: 'claude', id: withdrawn.id }).status, 'withdrawn', 'withdrawing again is harmless');
  assert.throws(() => app.withdrawAsk({ turnId, speaker: 'astra', id: app.room.asks[1].id }), /Stale requests/);
  assert.ok(file({ title: 'Now there is room' }).changed);
  assert.equal(askViews(app.room).length, 5);
});

test('the person answers while holding the stick: one quoted message goes to the asker and starts its turn', async t => {
  const { app, store, delivered, working } = fixture(t);
  const turnId = await working();
  const { ask } = app.fileAsk({ turnId, speaker: 'claude', title: 'Launch on Tuesday or Thursday?', options: ['Tuesday', 'Thursday'], blocking: true });
  await reply(app, turnId, 'claude');
  assert.equal(app.room.owner, 'human');
  await assert.rejects(app.answerAsk(ask.id, { revision: 1, clientId: 'answer-0001' }), /Choose an option or write an answer/);
  await assert.rejects(app.answerAsk(ask.id, { revision: 1, option: 2, clientId: 'answer-0001' }), /one of the offered options/);
  await assert.rejects(app.answerAsk(ask.id, { revision: 1, option: 1 }), /answer request ID is required/);
  assert.equal(store.read().asks[0].status, 'open', 'a refused answer changes nothing');
  await app.answerAsk(ask.id, { revision: 1, option: 1, text: 'QA needs the extra day.', clientId: 'answer-0001' });
  const saved = store.read();
  const message = saved.messages.at(-1);
  assert.equal(message.speaker, 'human');
  assert.equal(message.next, 'claude');
  assert.equal(message.answers, ask.id);
  assert.equal(message.text, "**Answer to Claude's request:** “Launch on Tuesday or Thursday?”\n→ **Thursday**\n\nQA needs the extra day.");
  assert.equal(saved.asks[0].status, 'answered');
  assert.deepEqual(saved.asks[0].answer, { option: 1, text: 'QA needs the extra day.', clientId: 'answer-0001' });
  assert.equal(saved.pending.speaker, 'claude', 'the answer starts the asker\'s turn');
  const turns = delivered.length;
  await app.answerAsk(ask.id, { revision: 1, option: 1, text: 'QA needs the extra day.', clientId: 'answer-0001' });
  assert.equal(store.read().messages.length, saved.messages.length, 'a retried answer is not repeated');
  assert.equal(delivered.length, turns, 'or delivered again');
  await assert.rejects(app.answerAsk(ask.id, { revision: 1, option: 0, clientId: 'answer-0002' }), /already answered/);
});

test('an answer while the other AI works is read by it now and never changes who speaks next', async t => {
  const { app, store, working } = fixture(t);
  const claudeTurn = await working('claude');
  const { ask } = app.fileAsk({ turnId: claudeTurn, speaker: 'claude', title: 'Is the budget $5k or $10k?', options: ['$5k', '$10k'] });
  await reply(app, claudeTurn, 'claude', 'astra');
  const gptTurn = app.room.pending.id;
  app.receive(gptTurn, 'astra');
  await app.answerAsk(ask.id, { revision: 1, option: 0, clientId: 'answer-1001' });
  const saved = store.read();
  const message = saved.messages.at(-1);
  assert.equal(message.interjection, true);
  assert.equal(message.waitingFor, 'astra');
  assert.equal(message.next, 'astra');
  assert.equal(saved.replyNext, undefined, 'GPT still chooses who speaks next');
  assert.equal(saved.owner, 'astra');
  assert.equal(saved.pending.id, gptTurn, 'GPT keeps its turn');
  assert.equal(saved.asks[0].status, 'answered');
});

test('dismissing is not answering: no message, the asker is told, and ended rooms refuse answers', async t => {
  const { app, store, adapters, root, working } = fixture(t);
  const turnId = await working();
  const first = app.fileAsk({ turnId, speaker: 'claude', title: 'Should I also update the docs site?' }).ask;
  const second = app.fileAsk({ turnId, speaker: 'claude', title: 'Approve the $40 domain purchase?', kind: 'approval' }).ask;
  await reply(app, turnId, 'claude');
  const before = store.read().messages.length;
  app.dismissAsk(first.id, { revision: 1 });
  app.dismissAsk(first.id, { revision: 1 });
  assert.equal(store.read().messages.length, before);
  assert.equal(store.read().asks[0].status, 'dismissed');
  await assert.rejects(app.answerAsk(first.id, { revision: 1, text: 'Actually yes', clientId: 'answer-2001' }), /already dismissed/);
  // The asker's next turn reminds it of what is open and what was closed unanswered.
  const summary = askSummary(store.read(), 'claude', app.room.participants.claude.seen);
  assert.match(summary, new RegExp(`Your open requests to the person .*\\n- ${second.id} · approval · “Approve the \\$40 domain purchase\\?”`));
  assert.match(summary, new RegExp(`Closed without an answer \\(not an approval\\):\\n- ${first.id} · info · “Should I also update the docs site\\?” · dismissed by the person`));
  assert.equal(askSummary(store.read(), 'astra'), '', 'GPT sees only its own requests');
  app.end();
  assert.equal(store.read().asks[1].status, 'closed');
  const reopened = new Semaphore(store, adapters);
  reopened.reopen();
  await assert.rejects(reopened.answerAsk(second.id, { revision: 1, text: 'Yes', clientId: 'answer-2002' }), /already closed/);
  assert.throws(() => reopened.dismissAsk(second.id, { revision: 1 }), /already closed/);
  assert.equal(askViews(reopened.room).length, 0, 'reopening never reopens requests');
  assert.ok(root);
});

test('every turn tells the AI the person may not read it and how to file a request', async t => {
  const { app, root, working } = fixture(t);
  const turnId = await working();
  app.fileAsk({ turnId, speaker: 'claude', title: 'Which region should the bucket use?', blocking: true });
  const envelope = liveEnvelope({ room: app.room, participant: app.room.participants.claude, turn: app.room.pending, prompt: '' }, { root });
  assert.match(envelope, /The person may not read this conversation; when busy they don't skim it at all\. If you need anything from them/);
  assert.match(envelope, new RegExp(`node .*cli\\.mjs'? ask room --root .* --turn ${turnId} \\[--kind decision\\|approval\\|info\\|review\\] \\[--option "<choice>"\\]… \\[--blocking\\] \\[--file <detail\\.md>\\] "<self-contained question>"`));
  assert.match(envelope, /Your open requests to the person \(they stay in the app's Needs you tray until resolved\):\n- .* · info · blocking · “Which region should the bucket use\?”/);
});

test('answering preserves a handoff the person already requested during this turn', async t => {
  const { app, working } = fixture(t);
  const c = await working();
  const { ask } = app.fileAsk({ turnId: c, speaker: 'claude', title: 'Pick a day', options: ['Tue', 'Thu'] });
  await reply(app, c, 'claude', 'astra');
  const g = app.room.pending.id; app.receive(g, 'astra');
  await app.send('Give Claude the next turn', 'claude', { clientId: 'route-human-1' });
  const route = structuredClone(app.room.replyNext);
  await app.answerAsk(ask.id, { revision: 1, option: 1, clientId: 'answer-route-1' });
  assert.deepEqual(app.room.replyNext, route);
  assert.equal(app.room.owner, 'astra');
});

test('an outdated request cannot reinterpret an option or dismiss the new question', async t => {
  const { app, working, store } = fixture(t);
  const turnId = await working();
  const { ask } = app.fileAsk({ turnId, speaker: 'claude', title: 'Which environment?', options: ['Staging', 'Production'] });
  app.fileAsk({ turnId, speaker: 'claude', id: ask.id, title: 'Which environment?', options: ['Production', 'Staging'] });
  await assert.rejects(app.answerAsk(ask.id, { revision: 1, option: 0, clientId: 'answer-stale-1' }), /request changed/);
  assert.throws(() => app.dismissAsk(ask.id, { revision: 1 }), /request changed/);
  assert.equal(store.read().asks[0].status, 'open');
  assert.equal(store.read().messages.length, 1);
  assert.equal(askViews(app.room)[0].revision, 2);
  await app.answerAsk(ask.id, { revision: 2, option: 1, clientId: 'answer-fresh-1' });
  assert.match(store.read().messages.at(-1).text, /Staging/);
});

test('reusing an answer ID with different content is rejected, not reported as saved', async t => {
  const { app, working, store } = fixture(t);
  const turnId = await working();
  const { ask } = app.fileAsk({ turnId, speaker: 'claude', title: 'Ready?', options: ['No', 'Yes'] });
  await app.answerAsk(ask.id, { revision: 1, option: 0, clientId: 'answer-conflict-1' });
  await assert.rejects(app.answerAsk(ask.id, { revision: 1, option: 1, clientId: 'answer-conflict-1' }), /Conflicting duplicate/);
  assert.equal(store.read().asks[0].answer.option, 0);
});

test('a mid-turn dismissal stays visible until the asker receives it, regardless of later messages', async t => {
  const { app, working, root } = fixture(t);
  const c = await working();
  const { ask } = app.fileAsk({ turnId: c, speaker: 'claude', title: 'Also publish?', kind: 'approval' });
  app.dismissAsk(ask.id, { revision: 1 });
  await reply(app, c, 'claude', 'astra');
  app.receive(app.room.pending.id, 'astra');
  await reply(app, app.room.pending.id, 'astra', 'claude');
  assert.match(askSummary(app.room, 'claude'), /Also publish/);
  const next = app.receive(app.room.pending.id, 'claude');
  const envelope = liveEnvelope({ room: app.room, participant: app.room.participants.claude, turn: next, prompt: '' }, { root });
  assert.match(envelope, /Closed without an answer \(not an approval\)/);
  await reply(app, next.id, 'claude');
  assert.equal(askSummary(app.room, 'claude'), '', 'acknowledged closure is not repeated forever');
});
