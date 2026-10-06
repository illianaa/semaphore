import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomStore, Semaphore } from "../lib/core.mjs";
import {
  ClaudeInboxTransport,
  LiveDeliveryError,
  listen,
} from "../lib/live.mjs";

const THREAD = "0190f000-0000-7000-8000-00000000a57a";
const SESSION = "11111111-2222-4333-8444-5555c1a0de00";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-core-live-"));
  let store;
  const open = () => {
    store?.release();
    store = new RoomStore(root, "test");
    store.acquire();
    return store;
  };
  open();
  t.after(() => {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const room = store.loadOrCreate();
  Object.assign(room.participants.astra, {
    transport: "codex-queue",
    id: THREAD,
  });
  Object.assign(room.participants.claude, {
    transport: "claude-inbox",
    id: SESSION,
  });
  store.save(room);
  return { root, store, reopen: open };
}

function queuedAdapters(calls = [], inspect = () => {}) {
  return Object.fromEntries(
    [
      ["astra", "codex-queue"],
      ["claude", "claude-inbox"],
    ].map(([speaker, kind]) => [
      speaker,
      {
        kind,
        async deliver(context) {
          inspect(context);
          calls.push({ speaker, turn: context.turn, prompt: context.prompt });
          return {
            status: "queued",
            turnId: context.turn.id,
            transport: kind,
            at: new Date().toISOString(),
          };
        },
      },
    ]),
  );
}

test("acknowledgment survives reopening, is idempotent, and cannot acknowledge a stale or foreign turn", async (t) => {
  const f = fixture(t);
  const adapters = queuedAdapters();
  const app = new Semaphore(f.store, adapters);
  await app.send("Acknowledge this turn", "astra");
  const id = app.room.pending.id;
  assert.throws(() => app.receive(id, "claude"), /Stale receipt/);
  assert.throws(() => app.receive("old-turn", "astra"), /Stale receipt/);
  assert.equal(app.room.pending.receivedAt, undefined);
  const receivedAt = app.receive(id, "astra").receivedAt;
  app.receive(id, "astra");
  assert.equal(
    app.room.events.filter((e) => e.type === "turn-received").length,
    1,
  );
  const reopened = new Semaphore(f.reopen(), adapters);
  assert.equal(reopened.room.pending.receivedAt, receivedAt);
  assert.equal(reopened.room.messages.length, 1);
  assert.equal(reopened.room.autoTurns, 0);
  reopened.takeStick();
  assert.throws(() => reopened.receive(id, "astra"), /Stale receipt/);
});

test("queued turns survive reopening; acceptance carries unseen context and the original budget across processes", async (t) => {
  const f = fixture(t);
  const calls = [];
  const adapters = queuedAdapters(calls, (context) => {
    const disk = JSON.parse(
      fs.readFileSync(path.join(context.roomDir, "room.json")),
    );
    assert.equal(disk.pending.state, "delivering");
    assert.equal(disk.pending.id, context.turn.id);
    assert.equal(context.workspace, path.join(context.roomDir, "workspace"));
  });
  const first = new Semaphore(f.store, adapters);
  await first.send("Start our discussion.", "astra", {
    maxTurns: 2,
    via: "astra",
  });
  const astraTurn = first.room.pending.id;
  assert.equal(first.room.messages[0].via, "astra");
  assert.equal(first.room.pending.state, "awaiting-reply");
  assert.equal(first.room.pending.receipt.transport, "codex-queue");
  assert.equal(first.room.owner, "astra");
  assert.equal(first.room.autoTurns, 0);
  assert.equal(first.room.participants.astra.seen, 0);
  assert.equal(first.running, false);

  const second = new Semaphore(f.reopen(), adapters);
  assert.equal(second.room.owner, "astra");
  await second.run();
  assert.equal(calls.length, 1, "run must not redeliver a queued turn");
  await assert.rejects(
    second.pass("claude"),
    /native reply is pending/,
  );
  const accepted = await second.accept({
    turnId: astraTurn,
    speaker: "astra",
    message: "Claude, your view?",
    next: "claude",
  });
  assert.equal(accepted.duplicate, false);
  assert.equal(second.room.autoTurns, 1);
  assert.equal(second.room.owner, "claude");
  assert.equal(second.room.pending.state, "awaiting-reply");
  assert.equal(second.room.participants.astra.seen, 2);
  assert.match(calls[1].prompt, /"speaker":"human"/);
  assert.match(calls[1].prompt, /Claude, your view\?/);

  const third = new Semaphore(f.reopen(), adapters);
  assert.equal(third.room.maxTurns, 2);
  await third.accept({
    turnId: third.room.pending.id,
    speaker: "claude",
    message: "GPT, I agree.",
    next: "astra",
  });
  assert.equal(third.room.owner, "human");
  assert.equal(third.room.autoTurns, 2);
  assert.equal(third.room.pending, null);
  assert.equal(third.room.messages.at(-1).next, "astra");
  assert.equal(
    calls.length,
    2,
    "persisted limit prevents a third model delivery",
  );
  await third.pass("astra", { maxTurns: 1 });
  assert.equal(
    third.room.autoTurns,
    0,
    "an explicit human pass starts a fresh exchange",
  );
  assert.equal(third.room.maxTurns, 1);
  assert.match(calls[2].prompt, /GPT, I agree/);
  assert.doesNotMatch(calls[2].prompt, /Start our discussion/);
});

test("an identical accepted reply is idempotent even while the next speaker is pending; conflicts fail", async (t) => {
  const { store, reopen } = fixture(t);
  const calls = [];
  const adapters = queuedAdapters(calls);
  const first = new Semaphore(store, adapters);
  await first.send("Hello");
  const input = {
    turnId: first.room.pending.id,
    speaker: "astra",
    message: "Hello Claude",
    next: "claude",
  };
  await first.accept(input);
  const nextTurn = first.room.pending.id;
  const second = new Semaphore(reopen(), adapters);
  const duplicate = await second.accept(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(second.room.messages.length, 2);
  assert.equal(second.room.autoTurns, 1);
  assert.equal(second.room.pending.id, nextTurn);
  assert.equal(calls.length, 2);
  await assert.rejects(
    second.accept({ ...input, message: "Changed" }),
    /Conflicting duplicate/,
  );
  await assert.rejects(
    second.accept({ ...input, speaker: "claude" }),
    /Conflicting duplicate/,
  );
  assert.equal(calls.length, 2);
});

test("wrong speaker, stale turn, takeover, and recovery cannot accept a late reply", async (t) => {
  const { store, reopen } = fixture(t);
  const adapters = queuedAdapters();
  const first = new Semaphore(store, adapters);
  await first.send("Hello");
  const input = {
    turnId: first.room.pending.id,
    speaker: "astra",
    message: "Late",
    next: "claude",
  };
  await assert.rejects(
    first.accept({ ...input, turnId: "old-turn" }),
    /Stale reply/,
  );
  await assert.rejects(
    first.accept({ ...input, speaker: "claude" }),
    /Stale reply/,
  );
  assert.throws(() => first.recover(), /Take the stick/);
  first.takeStick();
  assert.equal(first.room.pending.state, "uncertain");
  const second = new Semaphore(reopen(), adapters);
  await assert.rejects(second.accept(input), /Stale reply/);
  second.recover();
  await second.pass("astra");
  assert.notEqual(second.room.pending.id, input.turnId);
  await assert.rejects(second.accept(input), /Stale reply/);
  assert.equal(second.room.messages.length, 1);
});

test("only a certain LiveDeliveryError clears the pending journal", async (t) => {
  for (const [error, certain] of [
    [
      new LiveDeliveryError("Not sent", { certain: true, code: "cancelled" }),
      true,
    ],
    [
      new LiveDeliveryError("May be sent", {
        certain: false,
        code: "cancelled",
      }),
      false,
    ],
    [Object.assign(new Error("Unknown failure"), { certain: true }), false],
  ]) {
    await t.test(error.message, async (t) => {
      const { store } = fixture(t);
      const app = new Semaphore(store, {
        astra: {
          kind: "codex-queue",
          deliver: async () => {
            throw error;
          },
        },
      });
      await assert.rejects(app.send("Hello"), error);
      assert.equal(app.room.owner, "human");
      if (certain) assert.equal(app.room.pending, null);
      else assert.equal(app.room.pending.state, "uncertain");
      assert.equal(app.room.autoTurns, 0);
      assert.equal(app.room.participants.astra.seen, 0);
    });
  }
});

test("process death during delivery remains uncertain and is never dispatched on reopen", async (t) => {
  const { store, reopen } = fixture(t);
  const calls = [];
  const adapters = queuedAdapters(calls);
  const first = new Semaphore(store, adapters);
  await first.send("Hello");
  first.room.pending.state = "delivering";
  first.room.pending.receipt = null;
  first.save();
  const second = new Semaphore(reopen(), adapters);
  assert.equal(second.room.pending.state, "uncertain");
  assert.equal(second.room.owner, "human");
  await assert.rejects(second.run(), /uncertain outcome/);
  assert.equal(calls.length, 1);
});

test("reply remains committed when the next delivery fails, and repeating accept never retries it", async (t) => {
  const { store, reopen } = fixture(t);
  const calls = [];
  const adapters = queuedAdapters(calls);
  let claudeCalls = 0;
  adapters.claude.deliver = async () => {
    claudeCalls++;
    throw new Error("Connection lost");
  };
  const first = new Semaphore(store, adapters);
  await first.send("Hello");
  const input = {
    turnId: first.room.pending.id,
    speaker: "astra",
    message: "Your turn",
    next: "claude",
  };
  await assert.rejects(first.accept(input), (error) => {
    assert.deepEqual(error.accepted, { turnId: input.turnId, seq: 2 });
    return /Connection lost/.test(error.message);
  });
  assert.equal(first.room.pending.speaker, "claude");
  assert.equal(first.room.pending.state, "uncertain");
  const second = new Semaphore(reopen(), adapters);
  assert.equal((await second.accept(input)).duplicate, true);
  assert.equal(second.room.messages.length, 2);
  assert.equal(claudeCalls, 1);
});

test("live bindings cannot accidentally invoke the old headless adapter", async (t) => {
  const { store } = fixture(t);
  let called = false;
  const app = new Semaphore(store, {
    astra: {
      reply: () => {
        called = true;
      },
    },
  });
  await assert.rejects(app.send("Hello"), /No codex-queue transport/);
  assert.equal(called, false);
  assert.equal(app.room.pending, null);
  assert.equal(app.room.owner, "human");
});

test("taking the stick during delivery ignores a late queued receipt", async (t) => {
  const { store } = fixture(t);
  let release;
  const app = new Semaphore(store, {
    astra: {
      kind: "codex-queue",
      deliver: (context) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: "queued",
              turnId: context.turn.id,
              transport: "codex-queue",
            });
        }),
    },
  });
  const active = app.send("Hello");
  app.takeStick();
  release();
  await assert.rejects(active, /Human took/);
  assert.equal(app.room.owner, "human");
  assert.equal(app.room.pending.state, "uncertain");
  assert.equal(app.room.messages.length, 1);
});

test("actual inbox transport connects to core delivery and later acceptance without a model call", async (t) => {
  const { store, reopen } = fixture(t);
  const adapters = { claude: new ClaudeInboxTransport() };
  const first = new Semaphore(store, adapters);
  await first.send("A real inbox handoff.", "claude");
  const [mail] = await listen({ roomDir: store.dir, speaker: "claude" });
  assert.equal(mail.session, SESSION);
  assert.equal(mail.turn.id, first.room.pending.id);
  assert.match(mail.prompt, /A real inbox handoff/);
  const second = new Semaphore(reopen(), adapters);
  await second.accept({
    turnId: mail.turn.id,
    speaker: "claude",
    message: "Received.",
    next: "human",
  });
  assert.equal(second.room.owner, "human");
  assert.equal(second.room.pending, null);
  assert.equal(second.room.messages.at(-1).text, "Received.");
});

test("bounded lock wait succeeds after release and never steals a live lock", async (t) => {
  const { root, store } = fixture(t);
  const second = new RoomStore(root, "test");
  const wait = second.acquire({ waitMs: 500 });
  setTimeout(() => store.release(), 25);
  await wait;
  const third = new RoomStore(root, "test");
  await assert.rejects(third.acquire({ waitMs: 40 }), /locked/);
  assert.equal(JSON.parse(fs.readFileSync(second.lockFile)).pid, process.pid);
  second.release();
  store.acquire();
});

test("invalid human input does not mutate the transcript or saved exchange budget", async (t) => {
  const { store } = fixture(t);
  const app = new Semaphore(store, queuedAdapters());
  const before = JSON.stringify(app.room);
  await assert.rejects(app.send("Hello", "astra", { maxTurns: 0 }), /maxTurns/);
  await assert.rejects(app.send("Hello", "astra", { via: "someone" }), /via/);
  assert.equal(JSON.stringify(app.room), before);
  assert.deepEqual(store.read(), app.room);
});

test("an unrecognized thrown value is saved as uncertain before returning an error", async (t) => {
  const { store } = fixture(t);
  const app = new Semaphore(store, {
    astra: {
      kind: "codex-queue",
      deliver: async () => {
        throw null;
      },
    },
  });
  await assert.rejects(app.send("Hello"), /non-Error/);
  assert.equal(store.read().pending.state, "uncertain");
  assert.equal(store.read().owner, "human");
});

test("a receipt for the wrong turn cannot put the room into awaiting-reply", async (t) => {
  const { store } = fixture(t);
  const app = new Semaphore(store, {
    astra: {
      kind: "codex-queue",
      deliver: async () => ({
        status: "queued",
        transport: "codex-queue",
        turnId: "a-different-turn",
      }),
    },
  });
  await assert.rejects(app.send("Hello"), /receipt does not match/);
  assert.equal(store.read().pending.state, "uncertain");
  assert.equal(store.read().owner, "human");
});

test("human interjections preserve ownership, require revision receipts, and route once across reopen", async (t) => {
  const f = fixture(t);
  const calls = [];
  let app = new Semaphore(f.store, queuedAdapters(calls));
  await app.send("Start", "astra", { maxTurns: 3 });
  const id = app.room.pending.id;
  app.receive(id, "astra");
  await app.send("Please focus on setup", "claude", { clientId: "human-input-1" });
  assert.equal(app.room.owner, "astra");
  assert.equal(app.room.pending.through, 1);
  assert.equal(app.room.autoTurns, 0);
  assert.equal(calls.length, 1);
  assert.equal(app.room.messages[1].readAt, undefined);
  app = new Semaphore(f.reopen(), queuedAdapters(calls));
  await app.send("Please focus on setup", "claude", { clientId: "human-input-1" });
  assert.equal(app.room.messages.length, 2);
  await assert.rejects(app.send("Different", "claude", { clientId: "human-input-1" }), /Conflicting/);
  const reply = { turnId: id, speaker: "astra", message: "Revised setup", next: "astra" };
  const review = await app.accept(reply);
  assert.equal(review.status, "review-required");
  assert.equal(review.revision, 2);
  assert.equal(app.room.messages.length, 2);
  assert.equal(calls.length, 1);
  app.receive(id, "astra"); // Repeating the original receipt does not acknowledge newer text.
  assert.equal((await app.accept(reply)).status, "review-required");
  app.receive(id, "astra", review.revision);
  assert.equal(app.room.messages[1].readBy, "astra");
  await app.send("Also include recovery", "claude", { clientId: "human-input-2" });
  const newer = await app.accept(reply);
  assert.equal(newer.revision, 3);
  assert.throws(() => app.receive(id, "astra", 2), /Stale review/);
  app.receive(id, "astra", 3);
  const accepted = await app.accept(reply);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.message.next, "claude");
  assert.equal(accepted.message.nominatedNext, "astra");
  assert.equal(app.room.owner, "claude");
  assert.equal(app.room.autoTurns, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /Also include recovery/);
  assert.equal((await app.accept(reply)).duplicate, true);
  assert.equal(calls.length, 2);
});

test("interjections cannot reset the cap, unpause a room, or override a request for human input", async (t) => {
  const f = fixture(t);
  const calls = [];
  const app = new Semaphore(f.store, queuedAdapters(calls));
  await app.send("Start", "astra", { maxTurns: 1 });
  const id = app.room.pending.id;
  await app.send("Keep it short", "astra"); // Guidance for the AI at work, not a routing choice.
  await app.send("Claude next", "claude");
  const reply = { turnId: id, speaker: "astra", message: "Done", next: "astra" };
  const review = await app.accept(reply);
  app.receive(id, "astra", review.revision);
  await app.accept(reply);
  assert.equal(app.room.owner, "human");
  assert.equal(app.room.autoTurns, 1);
  assert.equal(app.room.replyNext.to, "claude");
  assert.equal(calls.length, 1);
  await app.pass("claude");
  const nextId = app.room.pending.id;
  await app.send("GPT next", "astra");
  const question = { turnId: nextId, speaker: "claude", message: "Which project?", next: "human" };
  app.receive(nextId, "claude", (await app.accept(question)).revision);
  await app.accept(question);
  assert.equal(app.room.owner, "human");
  await app.pass("astra");
  const stoppedId = app.room.pending.id;
  app.takeStick();
  await app.send("Save this while paused", "claude");
  assert.equal(app.room.owner, "human");
  assert.equal(app.room.pending.state, "uncertain");
  await assert.rejects(app.accept({ ...reply, turnId: stoppedId }), /Stale reply/);
});

test("opening request waits for all selected seats and never repeats its dispatch", async (t) => {
  const f = fixture(t);
  const calls = [];
  let app = new Semaphore(f.store, queuedAdapters(calls));
  app.room.participants.astra.id = null;
  app.room.participants.claude.id = null;
  const options = { clientId: "opening-request-1", members: ["astra", "claude"] };
  await app.setOpening("Discuss the UX", "claude", options);
  assert.equal(app.room.opening.state, "waiting");
  assert.equal(app.room.owner, "human");
  assert.equal(calls.length, 0);
  app.room.participants.claude.id = SESSION;
  await app.startOpening();
  assert.equal(calls.length, 0);
  app.save();
  app = new Semaphore(f.reopen(), queuedAdapters(calls));
  app.room.participants.astra.id = THREAD;
  await app.startOpening();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].speaker, "claude");
  assert.equal(app.room.opening.state, "started");
  await app.setOpening("Discuss the UX", "claude", options);
  await app.startOpening();
  assert.equal(app.room.messages.length, 1);
  assert.equal(calls.length, 1);
  await assert.rejects(app.setOpening("Different", "claude", options), /different opening/);
});

test("opening dispatch uncertainty and a paused opening survive restart without retry", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const adapters = queuedAdapters();
  adapters.astra.deliver = async () => { calls++; throw new Error("lost receipt"); };
  let app = new Semaphore(f.store, adapters);
  const options = { clientId: "opening-request-2", members: ["astra"] };
  await assert.rejects(app.setOpening("Start", "astra", options), /lost receipt/);
  assert.equal(app.room.opening.state, "uncertain");
  app = new Semaphore(f.reopen(), adapters);
  await app.setOpening("Start", "astra", options);
  await app.startOpening();
  assert.equal(calls, 1);
  assert.equal(app.room.owner, "human");
});

test("input journal replay after a partial drain cannot duplicate input or spend another turn", async (t) => {
  const { queueHumanInput, queuedInputs, withInputs, inputMessages } = await import("../lib/inputs.mjs");
  const f = fixture(t);
  const app = new Semaphore(f.store, queuedAdapters());
  await app.send("Start", "astra");
  const turnId = app.room.pending.id;
  app.receive(turnId, "astra");
  queueHumanInput(f.store, { text: "One extra thought", to: "claude", clientId: "replay-input-123" });
  // Simulate a crash after the main journal is durable but before ingress clears.
  withInputs(f.store.dir, (journal) => {
    for (const message of inputMessages(app.room, journal.all())) {
      delete message.queued;
      app.room.messages.push(message);
      app.room.replyNext = { to: message.next, seq: message.seq };
    }
    app.save();
  });
  assert.equal(queuedInputs(f.store.dir).length, 1);
  const restarted = new Semaphore(f.reopen(), queuedAdapters());
  assert.equal(restarted.room.messages.length, 2);
  assert.equal(queuedInputs(f.store.dir).length, 0);
  const review = await restarted.accept({ turnId, speaker: "astra", message: "Old response", next: "claude" });
  assert.equal(review.status, "review-required");
  assert.equal(restarted.room.autoTurns, 0);
  assert.equal(restarted.room.pending.id, turnId);
  restarted.receive(turnId, "astra", review.revision);
  await restarted.send("Newer routing choice", "claude", { clientId: "newer-input-123" });
  const second = await restarted.accept({ turnId, speaker: "astra", message: "Updated response", next: "claude" });
  assert.equal(second.status, "review-required");
  assert.deepEqual(restarted.room.replyNext, { to: "claude", seq: 3 });
});

test("a direct human send drains older queued input before choosing the next speaker", async (t) => {
  const { queueHumanInput } = await import("../lib/inputs.mjs");
  const f = fixture(t);
  const app = new Semaphore(f.store, queuedAdapters());
  await app.send("Start", "astra");
  queueHumanInput(f.store, { text: "Earlier queued thought", to: "claude", clientId: "ordering-early-123" });
  await app.send("Later direct thought", "astra", { clientId: "ordering-later-123" });
  assert.deepEqual(app.room.messages.map((m) => m.text), ["Start", "Earlier queued thought", "Later direct thought"]);
  // The later input is guidance for GPT, which is working, so it clears the earlier routing.
  assert.equal(app.room.replyNext, undefined);
  assert.equal(app.room.owner, "astra");
});

test("the per-conversation reply limit applies now, persists, and can be turned off", async (t) => {
  const f = fixture(t);
  const calls = [];
  const adapters = queuedAdapters(calls);
  const app = new Semaphore(f.store, adapters);
  assert.equal(app.room.turnLimit, 4);
  await app.send("Start.", "astra");
  assert.equal(app.room.maxTurns, 4, "an exchange uses the conversation's limit");
  app.setTurnLimit(10);
  assert.equal(app.room.maxTurns, 10, "a change applies to the exchange in progress");
  assert.throws(() => app.setTurnLimit(0), /1 to 20/);
  assert.throws(() => app.setTurnLimit(21), /1 to 20/);
  app.setTurnLimit(null);
  const reopened = new Semaphore(f.reopen(), adapters);
  assert.equal(reopened.room.turnLimit, null, "no limit survives reopening");
  assert.equal(reopened.room.maxTurns, null);
  let turn = reopened.room.pending;
  for (let i = 0; i < 6; i++) {
    const speaker = turn.speaker;
    await reopened.accept({
      turnId: turn.id,
      speaker,
      message: `Reply ${i + 1}`,
      next: speaker === "astra" ? "claude" : "astra",
    });
    turn = reopened.room.pending;
  }
  assert.equal(reopened.room.autoTurns, 6);
  assert.notEqual(reopened.room.owner, "human", "no limit never pauses on its own");
  assert.equal(
    reopened.room.events.filter((event) => event.type === "turn-limit").length,
    0,
  );
  reopened.setTurnLimit(4);
  await reopened.accept({
    turnId: turn.id,
    speaker: turn.speaker,
    message: "One more",
    next: turn.speaker === "astra" ? "claude" : "astra",
  });
  assert.equal(reopened.room.owner, "human", "a lower limit pauses at the next reply");
  reopened.takeStick();
  await reopened.pass("claude");
  assert.equal(reopened.room.maxTurns, 4, "the next exchange keeps the chosen limit");
});

test("input for the AI at work guides its turn; only naming the other AI moves the stick after it", async (t) => {
  const { queueHumanInput } = await import("../lib/inputs.mjs");
  const f = fixture(t);
  const calls = [];
  const app = new Semaphore(f.store, queuedAdapters(calls));
  await app.send("Start", "claude");
  const id = app.room.pending.id;
  app.receive(id, "claude");
  await app.send("Use the new colours", "claude", { clientId: "guidance-input-1" });
  assert.equal(app.room.replyNext, undefined, "guidance for Claude leaves the handoff to Claude");
  assert.equal(app.room.messages.at(-1).waitingFor, "claude");
  await app.send("Then ask GPT to check", "astra", { clientId: "routing-input-1" });
  assert.deepEqual(app.room.replyNext, { to: "astra", seq: 3 });
  // Queued input (saved while another process held the room) follows the same rule, in order.
  queueHumanInput(f.store, { text: "Actually, Claude decides", to: "claude", clientId: "guidance-input-2" });
  app.drainInputs();
  assert.equal(app.room.replyNext, undefined);
  app.receive(id, "claude", (await app.accept({ turnId: id, speaker: "claude", message: "Done", next: "human" })).revision);
  const reply = await app.accept({ turnId: id, speaker: "claude", message: "Done with the colours", next: "astra" });
  assert.equal(reply.status, "accepted");
  assert.equal(reply.message.next, "astra");
  assert.equal(reply.message.nominatedNext, "astra");
  assert.equal(app.room.owner, "astra");
});

test("setup input for the opening's first speaker never overrides that speaker's first handoff", async (t) => {
  const f = fixture(t);
  const calls = [];
  const app = new Semaphore(f.store, queuedAdapters(calls));
  app.room.participants.astra.id = null;
  await app.setOpening("Plan the launch", "claude", { clientId: "opening-guidance-1", members: ["astra", "claude"] });
  await app.send("Also keep it accessible", "claude", { clientId: "setup-guidance-1" });
  assert.equal(app.room.replyNext, undefined);
  app.room.participants.astra.id = THREAD;
  await app.startOpening();
  const id = app.room.pending.id;
  app.receive(id, "claude");
  const reply = await app.accept({ turnId: id, speaker: "claude", message: "Plan drafted", next: "astra" });
  assert.equal(reply.message.next, "astra");
  assert.equal(app.room.owner, "astra");
});

test("new input reaches a received turn at once: it is shown, then must be received before replying", async (t) => {
  const { queueHumanInput } = await import("../lib/inputs.mjs");
  const f = fixture(t);
  const app = new Semaphore(f.store, queuedAdapters());
  await app.send("Start", "claude");
  const id = app.room.pending.id;
  assert.equal(app.revealInput(id, "claude"), null, "a turn the chat hasn't received shows nothing yet");
  app.receive(id, "claude");
  assert.equal(app.revealInput(id, "claude"), null, "nothing new");
  queueHumanInput(f.store, { text: "Crucial detail: use the staging database", to: "claude", clientId: "live-input-123" });
  const shown = app.revealInput(id, "claude");
  assert.equal(shown.revision, 2);
  assert.deepEqual(shown.messages.map((m) => m.text), ["Crucial detail: use the staging database"]);
  assert.equal(app.room.pending.reviewThrough, 2);
  assert.equal(app.room.messages[1].readAt, undefined, "showing is not reading");
  assert.deepEqual(app.revealInput(id, "claude"), shown, "showing again changes nothing");
  assert.equal(app.revealInput(id, "astra"), null, "only the working chat's turn");
  assert.equal(app.revealInput("00000000-0000-4000-8000-00000000dead", "claude"), null);
  // The reply check still applies until this revision is received.
  assert.equal((await app.accept({ turnId: id, speaker: "claude", message: "Done", next: "human" })).status, "review-required");
  app.receive(id, "claude", 2);
  assert.equal(app.room.messages[1].readBy, "claude");
  assert.equal(app.revealInput(id, "claude"), null);
  assert.equal((await app.accept({ turnId: id, speaker: "claude", message: "Done", next: "human" })).status, "accepted");
  assert.equal(app.revealInput(id, "claude"), null, "a finished turn shows nothing");
});
