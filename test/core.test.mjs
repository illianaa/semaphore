import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomStore, Semaphore, parseReply } from "../lib/core.mjs";
import { claudeResult } from "../lib/adapters.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-test-"));
  const store = new RoomStore(root, "test");
  store.acquire();
  t.after(() => {
    store.release();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

test("real routing contract: attributed messages, one turn, durable IDs, resume delivers only unseen messages", async (t) => {
  const { store } = fixture(t);
  const calls = [];
  let active = 0;
  const adapters = Object.fromEntries(
    ["astra", "claude"].map((speaker) => [
      speaker,
      {
        async reply({ prompt, onSession }) {
          assert.equal(active++, 0);
          calls.push({ speaker, prompt });
          onSession({ id: `${speaker}-persistent`, started: true });
          await new Promise((resolve) => setImmediate(resolve));
          active--;
          return {
            message: `${speaker} says hello`,
            next: speaker === "astra" ? "claude" : "human",
          };
        },
      },
    ]),
  );
  const first = new Semaphore(store, adapters);
  await first.send("Let us talk.", "astra");
  assert.deepEqual(
    first.room.messages.map((m) => m.speaker),
    ["human", "astra", "claude"],
  );
  assert.equal(first.room.owner, "human");
  assert.match(calls[1].prompt, /"speaker":"human"/);
  assert.match(calls[1].prompt, /"speaker":"astra"/);
  const next = new Semaphore(store, adapters);
  assert.equal(next.room.participants.astra.id, "astra-persistent");
  await next.send("Continue.", "astra");
  assert.match(calls[2].prompt, /claude says hello/);
  assert.match(calls[2].prompt, /Continue\./);
  assert.doesNotMatch(calls[2].prompt, /Let us talk/);
  assert.doesNotMatch(calls[2].prompt, /astra says hello/);
  assert.deepEqual(
    next.room.messages.map((m) => m.seq),
    [1, 2, 3, 4, 5, 6],
  );
});

test("interruption rejects late model output and never starts the nominated model", async (t) => {
  const { store } = fixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let claudeCalls = 0;
  const app = new Semaphore(store, {
    astra: { reply: () => gate },
    claude: {
      reply: () => {
        claudeCalls++;
        return { message: "bad", next: "human" };
      },
    },
  });
  const running = app.send("Hello", "astra");
  await assert.rejects(app.send("Overlap", "claude"), /already running/);
  app.takeStick();
  release({ message: "Late output", next: "claude" });
  await assert.rejects(running, /Human took/);
  assert.equal(claudeCalls, 0);
  assert.equal(app.room.owner, "human");
  assert.equal(app.room.messages.length, 1);
  assert.ok(app.room.pending);
});

test("malformed nomination stops the loop, survives restart, and requires explicit recovery", async (t) => {
  const { store } = fixture(t);
  let count = 0;
  const adapters = {
    astra: {
      reply: () => {
        count++;
        return { message: "Hello", next: "someone-else" };
      },
    },
  };
  const app = new Semaphore(store, adapters);
  await assert.rejects(app.send("Hello"), /valid message/);
  assert.equal(app.room.messages.length, 1);
  const restarted = new Semaphore(store, adapters);
  await assert.rejects(restarted.send("Again"), /uncertain outcome/);
  assert.equal(count, 1);
  restarted.recover();
  assert.equal(restarted.room.pending, null);
  assert.equal(restarted.room.owner, "human");
  assert.equal(count, 1);
});

test("crash journal restores human ownership without dispatching or losing native session ID", (t) => {
  const { store } = fixture(t);
  const room = store.loadOrCreate();
  room.owner = "astra";
  room.pending = { speaker: "astra", through: 1 };
  room.participants.astra.id = "saved-thread";
  store.save(room);
  const app = new Semaphore(store, {});
  assert.equal(app.room.owner, "human");
  assert.ok(app.room.pending);
  assert.equal(app.room.participants.astra.id, "saved-thread");
});

test("turn limit returns the stick while preserving the last nomination", async (t) => {
  const { store } = fixture(t);
  const app = new Semaphore(store, {
    astra: {
      reply: async () => ({ message: "One more thought.", next: "astra" }),
    },
  });
  await app.send("Think.", "astra", { maxTurns: 2 });
  assert.equal(app.room.messages.length, 3);
  assert.equal(app.room.messages.at(-1).next, "astra");
  assert.equal(app.room.owner, "human");
  assert.equal(app.room.events.at(-1).type, "turn-limit");
});

test("room lock rejects a competing coordinator and refuses to unlock a live one", (t) => {
  const { root } = fixture(t);
  const second = new RoomStore(root, "test");
  assert.throws(() => second.acquire(), /locked/);
  assert.throws(() => second.unlock(), /still running/);
  assert.throws(() => new RoomStore(root, "../escape"), /Room names/);
});

test("Claude API errors are not published as conversation messages", () => {
  assert.throws(
    () =>
      claudeResult({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Authentication failed",
      }),
    /Authentication failed/,
  );
  assert.throws(
    () =>
      claudeResult({
        type: "result",
        subtype: "error_max_turns",
        errors: ["No valid output"],
      }),
    /No valid output/,
  );
  assert.deepEqual(
    claudeResult({
      type: "result",
      subtype: "success",
      structured_output: { message: "Hello", next: "human" },
    }),
    { message: "Hello", next: "human" },
  );
  assert.throws(
    () => parseReply('{"message":"  ","next":"human"}'),
    /valid message/,
  );
});
