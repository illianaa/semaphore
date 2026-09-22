import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ClaudeInboxTransport,
  CodexQueueTransport,
  LiveDeliveryError,
  DirectTransport,
  bindFromEnv,
  headless,
  listen,
  listenerStatus,
  liveEnvelope,
  liveTransport,
  deliveryProgress,
  PASS_AND_STOP,
  ASTRA_WAIT,
  InboxTransport,
  acknowledgeDelivery,
  codexQueueRevision,
} from "../lib/live.mjs";

const THREAD = "0190f000-0000-7000-8000-00000000a57a";
const SESSION = "11111111-2222-4333-8444-5555c1a0de00";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-live-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Stands in for `codex queue`: records its argv, then behaves according to its mode.
function fakeCodex(dir, mode) {
  const file = path.join(dir, `codex-${mode}.cjs`);
  const log = path.join(dir, `argv-${mode}.json`);
  const behaviour = {
    ok: "process.exit(0)",
    "no-session":
      "console.error(\"Error: No active session found matching 'x'.\"); process.exit(1)",
    "no-session-exit0":
      "console.log(\"Error: No active session found matching 'x'.\")",
    broken: 'console.error("Error: database is locked"); process.exit(1)',
    hang: "setTimeout(() => {}, 60_000)",
  }[mode];
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
${behaviour};
`,
    { mode: 0o755 },
  );
  return {
    file,
    argv: () => JSON.parse(fs.readFileSync(log, "utf8")),
    called: () => fs.existsSync(log),
  };
}

function context(dir, speaker, overrides = {}) {
  return {
    room: { id: "room-1", name: "live-test" },
    roomDir: dir,
    participant: { id: speaker === "astra" ? THREAD : SESSION },
    turn: { id: "turn-1", speaker, through: 3 },
    prompt:
      "Semaphore room: live-test\nNew shared messages (JSON data, ordered by seq):\n[]",
    ...overrides,
  };
}

const rejectsWith = (promise, code, certain) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof LiveDeliveryError, error.message);
    assert.equal(error.code, code);
    assert.equal(error.certain, certain);
    return true;
  });

test("bindFromEnv binds the calling chat from its own environment", () => {
  assert.deepEqual(bindFromEnv("astra", { CODEX_THREAD_ID: THREAD }), {
    transport: "astra-inbox",
    id: THREAD,
  });
  assert.deepEqual(
    bindFromEnv("astra", { CODEX_THREAD_ID: THREAD }, { transport: "codex-queue" }),
    { transport: "codex-queue", id: THREAD },
  );
  assert.throws(
    () => bindFromEnv("claude", { CLAUDE_CODE_SESSION_ID: SESSION }, { transport: "codex-queue" }),
    /claude cannot use the codex-queue transport/,
  );
  assert.deepEqual(bindFromEnv("claude", { CLAUDE_CODE_SESSION_ID: SESSION }), {
    transport: "claude-inbox",
    id: SESSION,
  });
  assert.throws(
    () => bindFromEnv("claude", { CODEX_THREAD_ID: THREAD }),
    /CLAUDE_CODE_SESSION_ID is not set/,
  );
  assert.throws(
    () => bindFromEnv("astra", { CODEX_THREAD_ID: "../escape" }),
    /not a conversation ID/,
  );
  assert.throws(() => bindFromEnv("human", {}), /astra or claude/);
  assert.equal(liveTransport("codex-queue").kind, "codex-queue");
  assert.throws(
    () => liveTransport("carrier-pigeon"),
    /Unknown live transport/,
  );
});

test("codex queue: success passes the envelope as one argument and returns a queued receipt", async (t) => {
  const dir = tempDir(t);
  const codex = fakeCodex(dir, "ok");
  const turn = context(dir, "astra");
  const receipt = await new CodexQueueTransport({
    executable: codex.file,
  }).deliver(turn);
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.transport, "codex-queue");
  assert.equal(receipt.turnId, "turn-1");
  const [command, threadFlag, thread, messageFlag, message, ...rest] =
    codex.argv();
  assert.deepEqual(
    [command, threadFlag, thread, messageFlag, rest.length],
    ["queue", "--thread", THREAD, "--message", 0],
  );
  assert.equal(message, liveEnvelope(turn));
  assert.match(
    message,
    /^Semaphore · room live-test · you hold the talking stick as Astra\n/,
  );
  assert.ok(
    message.includes(turn.prompt),
    "falls back to the core prompt when the room has no messages",
  );
  assert.match(
    message,
    /reply live-test --turn turn-1 --next <human\|astra\|claude> --file <path>/,
  );
});

test("codex queue: a missing session is a certain failure whatever the exit code", async (t) => {
  const dir = tempDir(t);
  for (const mode of ["no-session", "no-session-exit0"]) {
    await rejectsWith(
      new CodexQueueTransport({
        executable: fakeCodex(dir, mode).file,
      }).deliver(context(dir, "astra")),
      "no-active-session",
      true,
    );
  }
});

test("codex queue: other errors, timeouts and in-flight cancellation are uncertain", async (t) => {
  const dir = tempDir(t);
  await rejectsWith(
    new CodexQueueTransport({
      executable: fakeCodex(dir, "broken").file,
    }).deliver(context(dir, "astra")),
    "codex-error",
    false,
  );
  const hang = fakeCodex(dir, "hang");
  await rejectsWith(
    new CodexQueueTransport({ executable: hang.file, timeoutMs: 300 }).deliver(
      context(dir, "astra"),
    ),
    "timeout",
    false,
  );
  const controller = new AbortController();
  const running = new CodexQueueTransport({ executable: hang.file }).deliver(
    context(dir, "astra", { signal: controller.signal }),
  );
  setTimeout(
    () => controller.abort(new Error("Human took the talking stick.")),
    300,
  );
  await rejectsWith(running, "cancelled", false);
});

test("codex queue: cancellation before sending, a missing executable, or no binding deliver nothing", async (t) => {
  const dir = tempDir(t);
  const codex = fakeCodex(dir, "ok");
  const transport = new CodexQueueTransport({ executable: codex.file });
  await rejectsWith(
    transport.deliver(context(dir, "astra", { signal: AbortSignal.abort() })),
    "cancelled",
    true,
  );
  await rejectsWith(
    transport.deliver(context(dir, "astra", { participant: { id: null } })),
    "unbound",
    true,
  );
  await rejectsWith(
    transport.deliver(context(dir, "astra", { prompt: "x".repeat(300_000) })),
    "too-large",
    true,
  );
  assert.equal(codex.called(), false);
  await rejectsWith(
    new CodexQueueTransport({ executable: path.join(dir, "missing") }).deliver(
      context(dir, "astra"),
    ),
    "spawn-failed",
    true,
  );
});

test("claude inbox: delivers once, repeats are idempotent, and conflicting content is refused", async (t) => {
  const dir = tempDir(t);
  const inbox = new ClaudeInboxTransport();
  const turn = context(dir, "claude");
  const box = path.join(dir, "inbox", "claude");
  const wake = path.join(box, "turn-1.json");
  const first = await inbox.deliver(turn);
  assert.equal(first.status, "queued");
  assert.equal(first.transport, "claude-inbox");
  assert.deepEqual(first.listener, { active: false });
  assert.equal(fs.statSync(wake).mode & 0o777, 0o600);
  assert.equal(fs.statSync(box).mode & 0o777, 0o700);

  const again = await inbox.deliver(turn);
  assert.equal(again.duplicate, true);
  assert.equal(again.at, first.at);
  assert.deepEqual(
    fs.readdirSync(box).filter((name) => name.endsWith(".json")),
    ["turn-1.json"],
  );

  await rejectsWith(
    inbox.deliver({ ...turn, prompt: "A different prompt for the same turn" }),
    "turn-conflict",
    true,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(wake, "utf8")).prompt,
    liveEnvelope(turn),
  );

  // Reading the delivery does not reopen the turn: the ledger still refuses a conflicting
  // redelivery, and an identical repeat does not wake the chat a second time.
  const [item] = await listen({ roomDir: dir, speaker: "claude", pollMs: 10 });
  assert.equal(item.turn.id, "turn-1");
  assert.equal(fs.existsSync(wake), false);
  await rejectsWith(
    inbox.deliver({ ...turn, prompt: "Changed after reading" }),
    "turn-conflict",
    true,
  );
  assert.equal((await inbox.deliver(turn)).duplicate, true);
  assert.equal(fs.existsSync(wake), false);
});

test("claude inbox: cancellation, unsafe turn IDs and missing context deliver nothing", async (t) => {
  const dir = tempDir(t);
  const inbox = new ClaudeInboxTransport();
  await rejectsWith(
    inbox.deliver(context(dir, "claude", { signal: AbortSignal.abort() })),
    "cancelled",
    true,
  );
  await rejectsWith(
    inbox.deliver(
      context(dir, "claude", {
        turn: { id: "../escape", speaker: "claude", through: 3 },
      }),
    ),
    "invalid-turn",
    true,
  );
  await rejectsWith(
    inbox.deliver(
      context(dir, "claude", {
        turn: { id: "turn-2", speaker: "human", through: 3 },
      }),
    ),
    "invalid-context",
    true,
  );
  await rejectsWith(
    inbox.deliver(context(dir, "claude", { roomDir: undefined })),
    "invalid-context",
    true,
  );
  assert.equal(fs.existsSync(path.join(dir, "inbox")), false);
});

test("listen waits for a delivery, reports itself as listening, and cleans up", async (t) => {
  const dir = tempDir(t);
  const waiting = listen({ roomDir: dir, speaker: "claude", pollMs: 10 });
  assert.deepEqual(listenerStatus(dir, "claude"), {
    active: true,
    pid: process.pid,
  });
  const receipt = await new ClaudeInboxTransport().deliver(
    context(dir, "claude"),
  );
  assert.equal(receipt.listener.active, true);
  const items = await waiting;
  assert.equal(items.length, 1);
  assert.equal(items[0].session, SESSION);
  assert.deepEqual(items[0].turn, {
    id: "turn-1",
    speaker: "claude",
    through: 3,
  });
  assert.match(items[0].prompt, /you hold the talking stick as Claude/);
  assert.deepEqual(listenerStatus(dir, "claude"), { active: false });
});

test("listen returns queued deliveries oldest first and can be cancelled", async (t) => {
  const dir = tempDir(t);
  const inbox = new ClaudeInboxTransport();
  await inbox.deliver(
    context(dir, "claude", {
      turn: { id: "turn-b", speaker: "claude", through: 3 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await inbox.deliver(
    context(dir, "claude", {
      turn: { id: "turn-a", speaker: "claude", through: 5 },
    }),
  );
  assert.deepEqual(
    (await listen({ roomDir: dir, speaker: "claude" })).map(
      (item) => item.turn.id,
    ),
    ["turn-b", "turn-a"],
  );

  const controller = new AbortController();
  const waiting = listen({
    roomDir: dir,
    speaker: "claude",
    pollMs: 10,
    signal: controller.signal,
  });
  controller.abort(new Error("Human took the talking stick."));
  await assert.rejects(waiting, /Human took/);
  assert.deepEqual(listenerStatus(dir, "claude"), { active: false });
});

test("headless wrapper answers inside deliver()", async () => {
  const adapter = {
    reply: async ({ prompt }) => ({
      message: `echo: ${prompt}`,
      next: "human",
    }),
  };
  assert.deepEqual(await headless(adapter).deliver({ prompt: "hi" }), {
    status: "answered",
    reply: { message: "echo: hi", next: "human" },
  });
});

test("live envelopes show unseen messages as a readable transcript and keep a custom root", () => {
  const room = {
    id: "room-1",
    name: "live-test",
    messages: [
      {
        seq: 1,
        speaker: "human",
        via: "astra",
        text: "Start with Astra.",
        next: "astra",
      },
      { seq: 2, speaker: "astra", text: "Here is an idea.", next: "claude" },
      {
        seq: 3,
        speaker: "claude",
        text: "Arrived after this turn was dispatched.",
        next: "human",
      },
    ],
  };
  const envelope = liveEnvelope(
    {
      room,
      participant: { id: SESSION, seen: 0 },
      turn: { id: "turn-9", speaker: "claude", through: 2 },
      prompt: '[{"json":"prompt"}]',
    },
    { root: "/tmp/my rooms" },
  );
  assert.match(
    envelope,
    /^Semaphore · room live-test · you hold the talking stick as Claude\n\nHuman \(relayed by Astra\) → Astra:\nStart with Astra\.\n\nAstra → Claude:\nHere is an idea\./,
  );
  assert.doesNotMatch(envelope, /json|Arrived after/);
  assert.match(
    envelope,
    /reply live-test --root '\/tmp\/my rooms' --turn turn-9 --next/,
  );
  const later = liveEnvelope({
    room,
    participant: { id: SESSION, seen: 2 },
    turn: { id: "turn-10", speaker: "claude", through: 3 },
    prompt: "",
  });
  assert.doesNotMatch(later, /Here is an idea/);
  assert.match(later, /Claude → Human:\nArrived after/);
});

test("direct transport hands the turn to the calling chat and reports the live kind", async (t) => {
  const dir = tempDir(t);
  const printed = [];
  const direct = new DirectTransport({
    kind: "codex-queue",
    write: (text) => printed.push(text),
  });
  const receipt = await direct.deliver(context(dir, "astra"));
  assert.deepEqual(
    [receipt.status, receipt.transport, receipt.turnId, receipt.detail],
    ["queued", "codex-queue", "turn-1", "handed to the calling chat"],
  );
  assert.match(printed.join(""), /--turn turn-1/);
  await rejectsWith(
    direct.deliver(context(dir, "astra", { signal: AbortSignal.abort() })),
    "cancelled",
    true,
  );
  assert.equal(printed.length, 1);
  assert.throws(
    () => new DirectTransport({ kind: "headless" }),
    /Unknown live transport/,
  );
});

test("every delivered turn explains the hand-off for how that speaker receives turns", () => {
  const room = { id: "room-1", name: "live-test", messages: [] };
  const envelope = (speaker, transport, root) =>
    liveEnvelope(
      {
        room,
        participant: { id: speaker === "astra" ? THREAD : SESSION, seen: 0, transport },
        turn: { id: `turn-${transport}`, speaker, through: 0 },
        prompt: "p",
      },
      { root },
    );
  const astra = envelope("astra", "astra-inbox", "/tmp/rooms");
  assert.match(astra, /After passing the stick, wait for your next turn by running this in the foreground:\nnode .*cli\.mjs'? listen live-test --root '?\/tmp\/rooms'? --as astra\n/);
  assert.ok(astra.includes(ASTRA_WAIT));
  assert.doesNotMatch(astra, /end your turn right away/);
  const claude = envelope("claude", "claude-inbox", "/tmp/rooms");
  assert.match(claude, /Before ending your turn, start this as a background task so the next turn wakes you:\nnode .*cli\.mjs'? listen live-test --root '?\/tmp\/rooms'?\nThen, once you have passed the stick, end your turn right away/);
  const manual = envelope("astra", "codex-queue");
  assert.ok(manual.includes(PASS_AND_STOP));
  assert.doesNotMatch(manual, / listen /);
  for (const text of [astra, claude, manual]) assert.match(text, /If you resume on your own later, check first: node .*cli\.mjs'? stick live-test/);
});

test("delivery progress requires acknowledgment even after an inbox entry is consumed", async (t) => {
  const dir = tempDir(t);
  const claude = { transport: "claude-inbox", id: SESSION };
  const turn = { id: "turn-1", speaker: "claude", through: 3 };
  await new ClaudeInboxTransport().deliver(context(dir, "claude"));
  assert.equal(
    deliveryProgress({ roomDir: dir, participant: claude, turn }),
    "queued",
  );
  await listen({ roomDir: dir, speaker: "claude", pollMs: 10 });
  assert.equal(
    deliveryProgress({ roomDir: dir, participant: claude, turn }),
    "queued",
  );
  turn.receivedAt = new Date().toISOString();
  assert.equal(deliveryProgress({ participant: claude, turn }), "received");

  // Native queue contents do not prove this particular turn reached a model.
  const astra = { transport: "codex-queue", id: THREAD };
  const astraTurn = { id: "turn-9", speaker: "astra", through: 3 };
  assert.equal(
    deliveryProgress({ participant: astra, turn: astraTurn }),
    "queued",
  );
  astraTurn.receivedAt = new Date().toISOString();
  assert.equal(
    deliveryProgress({ participant: astra, turn: astraTurn }),
    "received",
  );
  assert.equal(
    deliveryProgress({
      participant: { transport: "headless", id: null },
      turn: astraTurn,
    }),
    "unknown",
  );
});

test("an acknowledgment-aware listener keeps open turns, drops closed ones, and returns on timeout or yield", async (t) => {
  const dir = tempDir(t);
  const astra = new InboxTransport({ kind: "astra-inbox" });
  assert.equal(astra.kind, "astra-inbox");
  await astra.deliver(context(dir, "astra", { turn: { id: "turn-open", speaker: "astra", through: 1 } }));
  await astra.deliver(context(dir, "astra", { turn: { id: "turn-closed", speaker: "astra", through: 1 } }));
  const box = path.join(dir, "inbox", "astra");
  const open = (item) => item.turn.id === "turn-open";
  for (let attempt = 0; attempt < 2; attempt++) {
    const items = await listen({ roomDir: dir, speaker: "astra", pollMs: 10, timeoutMs: 1000, isOpen: open });
    assert.deepEqual(items.map((item) => item.turn.id), ["turn-open"], "an unacknowledged turn is returned again");
  }
  assert.deepEqual(fs.readdirSync(box).filter((name) => name.endsWith(".json")), ["turn-open.json"], "closed turns are dropped");
  // null means "not mine to judge": the entry stays for its rightful listener and isn't returned.
  assert.deepEqual(await listen({ roomDir: dir, speaker: "astra", pollMs: 10, timeoutMs: 100, isOpen: () => null }), []);
  assert.deepEqual(fs.readdirSync(box).filter((name) => name.endsWith(".json")), ["turn-open.json"]);
  acknowledgeDelivery({ roomDir: dir, speaker: "astra", turnId: "turn-open" });
  assert.deepEqual(fs.readdirSync(box).filter((name) => name.endsWith(".json")), []);
  const began = Date.now();
  assert.deepEqual(await listen({ roomDir: dir, speaker: "astra", pollMs: 10, timeoutMs: 150, isOpen: open }), []);
  assert.ok(Date.now() - began < 1000);
  let checks = 0;
  const yielded = Date.now();
  assert.deepEqual(await listen({ roomDir: dir, speaker: "astra", pollMs: 10, timeoutMs: 2000, stopWhen: () => ++checks > 2 }), []);
  assert.ok(Date.now() - yielded < 1000, "stopWhen ends the wait early, not at the timeout");
  assert.deepEqual(listenerStatus(dir, "astra"), { active: false });
  await assert.rejects(astra.deliver(context(dir, "astra", { turn: { id: "turn-open", speaker: "astra", through: 9 } })), (error) => error.code === "turn-conflict");
});

test("codexQueueRevision reads Codex's per-thread queue revision and never guesses", (t) => {
  const dir = tempDir(t);
  const env = { CODEX_HOME: dir };
  assert.equal(codexQueueRevision({ threadId: THREAD, env }), null, "no database");
  assert.equal(codexQueueRevision({ threadId: "../x", env }), null);
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite) return;
  const db = new sqlite.DatabaseSync(path.join(dir, "queue_1.sqlite"));
  db.exec("create table queued_thread_revisions (revision integer primary key autoincrement, thread_id text not null unique)");
  assert.equal(codexQueueRevision({ threadId: THREAD, env }), 0);
  db.prepare("insert into queued_thread_revisions (thread_id) values (?)").run(THREAD);
  db.close();
  assert.equal(codexQueueRevision({ threadId: THREAD, env }), 1);
});
