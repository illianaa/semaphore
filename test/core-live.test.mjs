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
    second.send("Overlap", "claude"),
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
    message: "Astra, I agree.",
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
  assert.match(calls[2].prompt, /Astra, I agree/);
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
