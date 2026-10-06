import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKING_NOTE_TTL } from "../lib/status-note.mjs";

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "cli.mjs",
);
const THREAD = "0190f000-0000-7000-8000-00000000a57a";
const SESSION = "11111111-2222-4333-8444-5555c1a0de00";
const OTHER = "99999999-8888-4777-8666-555555555555";
const ASTRA = { CODEX_THREAD_ID: THREAD };
const CLAUDE = { CLAUDE_CODE_SESSION_ID: SESSION };
const turnIn = (text) => text.match(/--turn ([A-Za-z0-9_-]+)/)?.[1];
const withoutRuntime = ({ joinedRuntime, lastReceivedRuntime, ...seat }) => seat;

// Runs the real CLI against a temporary root. A fake codex records every queued message, and a
// fake claude on PATH proves that no headless Claude session is ever started for a live room.
function setup(t, { defaultRoot = false, quotedRoot = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, quotedRoot ? "shared rooms with an apostrophe's" : "rooms");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const codexLog = path.join(dir, "codex.jsonl");
  const codex = path.join(bin, "codex.cjs");
  fs.writeFileSync(
    codex,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_CODEX_FAIL) { console.error("Error: No active session found matching 'x'."); process.exit(1); }
`,
    { mode: 0o755 },
  );
  const claudeCalled = path.join(dir, "claude-called");
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh\ntouch '${claudeCalled}'\nexit 1\n`,
    { mode: 0o755 },
  );
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^CODEX_|^CLAUDE_CODE_SESSION_ID$/.test(key),
    ),
  );
  // Real instant wake can be enabled on the machine running these tests.
  // Keep fake native identities away from its settings and socket.
  base.SEMAPHORE_HOME = defaultRoot ? dir : path.join(dir, 'installation');
  const run = (args, env = {}, input) => {
    const result = spawnSync(process.execPath, [CLI, ...args, "--root", root], {
      encoding: "utf8",
      input,
      env: {
        ...base,
        PATH: `${bin}:${base.PATH}`,
        SEMAPHORE_CODEX_BIN: codex,
        ...env,
      },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const write = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const room = (name) =>
    JSON.parse(fs.readFileSync(path.join(root, name, "room.json"), "utf8"));
  const queued = () =>
    fs.existsSync(codexLog)
      ? fs
          .readFileSync(codexLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const inbox = (name, speaker = "claude") =>
    fs
      .readdirSync(path.join(root, name, "inbox", speaker))
      .filter((file) => file.endsWith(".json"));
  const start = (args, env = {}) => {
    const child = spawn(process.execPath, [CLI, ...args, "--root", root], {
      env: { ...base, PATH: `${bin}:${base.PATH}`, SEMAPHORE_CODEX_BIN: codex, ...env },
    });
    let out = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (out += data));
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
  };
  return {
    root,
    run,
    start,
    write,
    room,
    queued,
    inbox,
    claudeCalled: () => fs.existsSync(claudeCalled),
    runHint: (command, env = {}) => spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8', timeout: 5000,
      env: { ...base, SEMAPHORE_CODEX_BIN: codex, ...env },
    }),
  };
}

function joinBoth(run, { manual = false } = {}) {
  assert.equal(
    run(["join", "room", "--as", "astra", ...(manual ? ["--manual"] : [])], ASTRA).code,
    0,
  );
  assert.equal(run(["join", "room", "--as", "claude"], CLAUDE).code, 0);
}

test("acceptance flow: human via GPT, GPT → Claude → GPT → human, all in the live chats", (t) => {
  const { run, write, room, queued, claudeCalled } = setup(t);
  assert.equal(run(["join", "room", "--as", "astra"], ASTRA).code, 0);
  const joined = run(["join", "room", "--as", "claude"], CLAUDE);
  assert.equal(joined.code, 0, joined.err);
  assert.match(joined.out, /listen room --root '/);

  // The human spoke in GPT's chat; GPT relays it and gets its own turn handed back directly.
  const sent = run(
    [
      "send",
      "room",
      "--to",
      "astra",
      "--file",
      write("human.txt", "Hello both. GPT first, then Claude."),
    ],
    ASTRA,
  );
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /Human \(relayed by GPT\) → GPT:\nHello both/);
  const t1 = turnIn(sent.out);
  assert.equal(queued().length, 0, "never queued back into the calling chat");

  const r1 = run(
    [
      "reply",
      "room",
      "--turn",
      t1,
      "--next",
      "claude",
      "--file",
      write("a1.txt", "GPT here. Over to Claude."),
    ],
    ASTRA,
  );
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /Accepted as message 2\. Stick: claude/);
  assert.doesNotMatch(
    r1.out,
    /GPT here/,
    "the caller is not shown its own reply again",
  );

  const heard = run(["listen", "room"], CLAUDE);
  assert.equal(heard.code, 0, heard.err);
  assert.match(
    heard.out,
    /Human \(relayed by GPT\) → GPT:\nHello both[\s\S]*GPT → Claude:\nGPT here/,
  );
  const t2 = turnIn(heard.out);

  const r2 = run(
    [
      "reply",
      "room",
      "--turn",
      t2,
      "--next",
      "astra",
      "--file",
      write("c1.txt", "Claude here. Back to GPT."),
    ],
    CLAUDE,
  );
  assert.equal(r2.code, 0, r2.err);
  const waiting = run(["listen", "room", "--as", "astra", "--timeout", "5"], ASTRA);
  assert.equal(waiting.code, 0, waiting.err);
  const envelope = waiting.out;
  assert.match(envelope, /Claude → GPT:\nClaude here/);
  assert.doesNotMatch(
    envelope,
    /GPT here/,
    "GPT already has its own reply",
  );
  const t3 = turnIn(envelope);
  assert.equal(run(["receive", "room", "--turn", t3], ASTRA).code, 0);

  const r3 = run(
    [
      "reply",
      "room",
      "--turn",
      t3,
      "--next",
      "human",
      "--file",
      write("a2.txt", "Done. Your turn."),
    ],
    ASTRA,
  );
  assert.equal(r3.code, 0, r3.err);
  const final = room("room");
  assert.deepEqual(
    final.messages.map((m) => [m.speaker, m.via ?? null, m.next]),
    [
      ["human", "astra", "astra"],
      ["astra", null, "claude"],
      ["claude", null, "astra"],
      ["astra", null, "human"],
    ],
  );
  assert.equal(final.owner, "human");
  assert.equal(final.pending, null);
  assert.deepEqual(withoutRuntime(final.participants.astra), {
    transport: "astra-inbox",
    id: THREAD,
    seen: 4,
  });
  assert.equal(final.participants.claude.id, SESSION);
  assert.equal(queued().length, 0, "the automatic route never uses the ChatGPT queue");
  assert.equal(claudeCalled(), false);
  assert.match(run(["show", "room"]).out, /Stick: human/);
});

test("replies are authenticated against the room binding; stale, conflicting and repeated replies are safe", (t) => {
  const { run, write, queued, inbox } = setup(t);
  joinBoth(run);
  const t1 = turnIn(
    run(
      ["send", "room", "--to", "astra", "--file", write("h.txt", "Hi.")],
      ASTRA,
    ).out,
  );
  const reply = write("a.txt", "Over to Claude.");
  for (const env of [{}, { CLAUDE_CODE_SESSION_ID: OTHER }]) {
    const denied = run(
      ["reply", "room", "--turn", t1, "--next", "claude", "--file", reply],
      env,
    );
    assert.equal(denied.code, 1);
    assert.match(denied.err, /not bound to room room/);
  }
  assert.match(
    run(
      ["reply", "room", "--turn", t1, "--next", "claude", "--file", reply],
      CLAUDE,
    ).err,
    /Stale reply/,
  );
  assert.equal(
    run(
      ["reply", "room", "--turn", t1, "--next", "claude", "--file", reply],
      ASTRA,
    ).code,
    0,
  );
  const again = run(
    ["reply", "room", "--turn", t1, "--next", "claude", "--file", reply],
    ASTRA,
  );
  assert.equal(again.code, 0);
  assert.match(
    again.out,
    /Already accepted as message 2; nothing was sent again/,
  );
  assert.match(
    run(
      ["reply", "room", "--turn", t1, "--next", "human", "--file", reply],
      ASTRA,
    ).err,
    /Conflicting duplicate/,
  );
  assert.equal(inbox("room").length, 1);

  // Taking the stick rejects Claude's late reply even though its turn was delivered.
  const t2 = turnIn(run(["listen", "room"], CLAUDE).out);
  assert.equal(run(["take", "room"]).code, 0);
  assert.match(
    run(
      [
        "reply",
        "room",
        "--turn",
        t2,
        "--next",
        "astra",
        "--file",
        write("c.txt", "Late."),
      ],
      CLAUDE,
    ).err,
    /Stale reply/,
  );
  assert.equal(queued().length, 0);
});

test("a bound chat relays the human with provenance; --via cannot be claimed from anywhere else", (t) => {
  const { run, write, room, queued, inbox } = setup(t);
  assert.equal(run(["join", "room", "--as", "astra"], ASTRA).code, 0);
  const message = write("h.txt", "Hello.");
  assert.match(
    run(["send", "room", "--via", "claude", "--file", message], ASTRA).err,
    /--via claude works only from inside that bound chat/,
  );
  assert.match(
    run(["send", "room", "--via", "astra", "--file", message]).err,
    /--via astra works only/,
  );
  // From anywhere else the human speaks directly, and GPT's turn waits in its inbox.
  const direct = run(["send", "room", "--to", "astra", "--file", message]);
  assert.equal(direct.code, 0, direct.err);
  assert.equal(room("room").messages[0].via, undefined);
  assert.equal(inbox("room", "astra").length, 1);
  assert.equal(queued().length, 0);
});

test("gpt names GPT's seat wherever a speaker is named; the stored seat stays astra", (t) => {
  const { run, write, room, inbox } = setup(t);
  const joined = run(["join", "room", "--as", "gpt"], ASTRA);
  assert.equal(joined.code, 0, joined.err);
  assert.equal(room("room").participants.astra.id, THREAD);
  assert.equal(run(["join", "room", "--as", "GPT"], ASTRA).code, 0);
  const sent = run(["send", "room", "--to", "gpt", "--file", write("h.txt", "Hello.")]);
  assert.equal(sent.code, 0, sent.err);
  assert.equal(room("room").messages[0].next, "astra");
  assert.equal(inbox("room", "astra").length, 1);
});

test("join binds only from inside the chat, is idempotent, and needs --rebind with no pending turn to replace one", (t) => {
  const { run, write, room } = setup(t);
  assert.match(
    run(["join", "room", "--as", "claude"], ASTRA).err,
    /CLAUDE_CODE_SESSION_ID is not set/,
  );
  assert.match(
    run(["join", "room", "--as", "human"], ASTRA).err,
    /--as gpt or --as claude/,
  );
  assert.equal(run(["join", "room", "--as", "claude"], CLAUDE).code, 0);
  assert.match(
    run(["join", "room", "--as", "claude"], CLAUDE).out,
    /already claude/,
  );
  const other = { CLAUDE_CODE_SESSION_ID: OTHER };
  assert.match(run(["join", "room", "--as", "claude"], other).err, /--rebind/);
  assert.equal(
    run(["join", "room", "--as", "claude", "--rebind"], other).code,
    0,
  );
  const saved = room("room");
  assert.deepEqual(withoutRuntime(saved.participants.claude), {
    transport: "claude-inbox",
    id: OTHER,
    seen: 0,
  });
  assert.deepEqual(
    saved.events.map((event) => event.type),
    ["join", "rebind"],
  );
  assert.equal(
    run(["send", "room", "--to", "claude", "--file", write("h.txt", "Hi.")])
      .code,
    0,
  );
  assert.match(
    run(["join", "room", "--as", "claude", "--rebind"], CLAUDE).err,
    /A turn is pending/,
  );
});

test("status and native describe live chats without offering a terminal resume; chat and listen refuse the wrong context", (t) => {
  const { run } = setup(t);
  joinBoth(run);
  const native = run(["native", "room"]).out;
  assert.match(native, new RegExp(`codex://threads/${THREAD} \\(live chat\\)`));
  assert.match(native, /never resume it from a terminal/);
  assert.doesNotMatch(native, /claude --resume/);
  const status = run(["status", "room"]).out;
  assert.match(status, /astra: astra-inbox .* not listening/);
  assert.match(status, /claude: claude-inbox .* not listening/);
  assert.match(run(["chat", "room"]).err, /live chats/);
  assert.match(
    run(["listen", "room", "--as", "claude"], ASTRA).err,
    /inside the claude chat/,
  );
});

test("a reply that commits but cannot reach the next chat says so, and repeating it does not resend", (t) => {
  const { run, write, room, queued } = setup(t);
  joinBoth(run, { manual: true });
  assert.equal(
    run([
      "send",
      "room",
      "--to",
      "claude",
      "--file",
      write("h.txt", "Claude first, please."),
    ]).code,
    0,
  );
  const t1 = turnIn(run(["listen", "room"], CLAUDE).out);
  const reply = [
    "reply",
    "room",
    "--turn",
    t1,
    "--next",
    "astra",
    "--file",
    write("c.txt", "GPT, over to you."),
  ];
  const failed = run(reply, { ...CLAUDE, FAKE_CODEX_FAIL: "1" });
  assert.equal(failed.code, 2);
  assert.match(
    failed.err,
    /saved as message 2, but delivery to the next speaker stopped/,
  );
  const saved = room("room");
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.pending, null);
  assert.equal(saved.owner, "human");
  assert.match(run(reply, CLAUDE).out, /Already accepted as message 2/);
  assert.equal(queued().length, 1);
});

test("a native chat that is not part of the room cannot speak as the human; the app and terminals still can", (t) => {
  const { run, write, room, queued, inbox } = setup(t);
  assert.equal(run(["join", "room", "--as", "astra"], ASTRA).code, 0);
  const message = write("h.txt", "Hello.");
  for (const env of [CLAUDE, { CODEX_THREAD_ID: OTHER }]) {
    const denied = run(
      ["send", "room", "--to", "astra", "--file", message],
      env,
    );
    assert.equal(denied.code, 1);
    assert.match(denied.err, /This chat is not part of room room/);
    assert.match(
      run(["pass", "room", "--to", "astra"], env).err,
      /This chat is not part of room room/,
    );
  }
  assert.equal(room("room").messages.length, 0);
  const direct = run(["send", "room", "--to", "astra", "--file", message]);
  assert.equal(direct.code, 0, direct.err);
  assert.equal(room("room").messages[0].via, undefined);
  assert.equal(inbox("room", "astra").length, 1);
  assert.equal(queued().length, 0);
});

test("new starts a live conversation whose empty seats each chat can join; rooms and invite describe it", (t) => {
  const { run, room } = setup(t);
  const created = run(["new", "Release", "workshop"]);
  assert.equal(created.code, 0, created.err);
  const name = created.out.match(/as room (room-[A-Za-z0-9-]+)\./)[1];
  assert.match(
    run(["rooms"]).out,
    new RegExp(
      `${name} · “Release workshop” · stick: human · 0 messages · astra not joined, claude not joined`,
    ),
  );
  assert.equal(run(["join", name, "--as", "claude"], CLAUDE).code, 0);
  assert.deepEqual(withoutRuntime(room(name).participants.claude), {
    transport: "claude-inbox",
    id: SESSION,
    seen: 0,
  });
  assert.match(run(["rooms"]).out, /astra not joined, claude joined/);
  const invite = run(["invite", name, "--to", "astra"]);
  assert.match(
    invite.out,
    /^Start a new GPT chat: codex:\/\/threads\/new\?prompt=/,
  );
  assert.match(
    invite.out,
    new RegExp(
      `Or paste this into an existing GPT chat:\\n\\n(?:Join my Semaphore group chat “Release workshop” as GPT|Use the Semaphore skill to connect this chat as GPT)`,
    ),
  );
  assert.match(run(["new"]).err, /title of 1–100 characters/);
});

test("receive authenticates the native chat and preserves the turn until it replies", (t) => {
  const { run, write, room } = setup(t);
  joinBoth(run);
  run([
    "send",
    "room",
    "--to",
    "claude",
    "--file",
    write("h.txt", "Please read this."),
  ]);
  const id = room("room").pending.id;
  assert.notEqual(run(["receive", "room", "--turn", id], ASTRA).code, 0);
  assert.notEqual(run(["receive", "room", "--turn", id]).code, 0);
  assert.equal(room("room").pending.receivedAt, undefined);
  const received = run(["receive", "room", "--turn", id], CLAUDE);
  assert.equal(received.code, 0, received.err);
  assert.match(received.out, /Please read this/);
  assert.ok(room("room").pending.receivedAt);
  assert.equal(room("room").owner, "claude");
  assert.equal(room("room").messages.length, 1);
  assert.equal(run(["receive", "room", "--turn", id], CLAUDE).code, 0);
  run(["take", "room"]);
  assert.notEqual(run(["receive", "room", "--turn", id], CLAUDE).code, 0);
});

test("reply tells a speaker who passed the stick to stop, and stick reports whose turn it is", (t) => {
  const { run, write } = setup(t);
  joinBoth(run);
  const t1 = turnIn(
    run([
      "send",
      "room",
      "--to",
      "claude",
      "--file",
      write("h.txt", "Claude first."),
    ]).out,
  );
  assert.equal(run(["stick", "room"], CLAUDE).code, 0);
  const waiting = run(["stick", "room"], ASTRA);
  assert.equal(waiting.code, 3);
  assert.match(
    waiting.out,
    /Claude holds the stick in room and has a pending turn\. Don't edit shared files or continue on your own/,
  );
  const listened = turnIn(run(["listen", "room"], CLAUDE).out);
  assert.equal(listened, t1 ?? listened);
  const passed = run(
    [
      "reply",
      "room",
      "--turn",
      listened,
      "--next",
      "astra",
      "--file",
      write("c.txt", "Over to GPT."),
    ],
    CLAUDE,
  );
  assert.equal(passed.code, 0, passed.err);
  assert.match(
    passed.out,
    /You no longer hold the stick\.\nYour background listener now waits for your next turn\. If it isn't running \(it finishes each time it tells you something\), start it again as a background task:\nnode .*cli\.mjs'? listen room --root '.*'\nThen end your turn right away; don't keep working\./,
  );
  assert.equal(run(["stick", "room"], CLAUDE).code, 3);
  assert.equal(run(["stick", "room"], ASTRA).code, 0);
  assert.equal(
    run(["stick", "room"]).code,
    3,
    "a terminal is not the stick holder while a model has it",
  );
});

test("a GPT turn waits in its inbox across listener gaps and timeouts; it is never lost or delivered twice", (t) => {
  const { run, write, inbox, queued } = setup(t);
  joinBoth(run);
  run(["send", "room", "--to", "claude", "--file", write("h.txt", "Claude, then GPT.")]);
  const t1 = turnIn(run(["listen", "room"], CLAUDE).out);
  assert.equal(run(["receive", "room", "--turn", t1], CLAUDE).code, 0);
  // GPT is not listening when Claude hands off: the turn waits durably.
  const passed = run(["reply", "room", "--turn", t1, "--next", "astra", "--file", write("c.txt", "Over to GPT.")], CLAUDE);
  assert.equal(passed.code, 0, passed.err);
  assert.match(passed.out, /Queued for GPT \(astra-inbox; not listening yet/);
  assert.equal(inbox("room", "astra").length, 1);
  const first = run(["listen", "room", "--as", "astra", "--timeout", "2"], ASTRA);
  const t2 = turnIn(first.out);
  assert.ok(t2, first.out);
  // A listener that restarts before acknowledging gets the same turn again, not a new one.
  assert.equal(turnIn(run(["listen", "room", "--as", "astra", "--timeout", "2"], ASTRA).out), t2);
  assert.equal(run(["receive", "room", "--turn", t2], ASTRA).code, 0);
  assert.equal(inbox("room", "astra").length, 0, "acknowledged turns leave the inbox");
  const quiet = run(["listen", "room", "--as", "astra", "--timeout", "1"], ASTRA);
  assert.equal(quiet.code, 0);
  assert.match(quiet.out, /already received turn .*Continue your work, then reply:/);
  assert.doesNotMatch(quiet.out, /No new turn| listen room/);
  assert.equal(queued().length, 0);
});

test("a cancelled GPT turn is dropped from its inbox instead of being delivered later", (t) => {
  const { run, write, inbox } = setup(t);
  joinBoth(run);
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("h.txt", "GPT, please.")]).code, 0);
  assert.equal(inbox("room", "astra").length, 1);
  assert.equal(run(["take", "room"]).code, 0);
  assert.match(run(["listen", "room", "--as", "astra", "--timeout", "1"], ASTRA).out, /No new turn in 1 seconds/);
  assert.equal(inbox("room", "astra").length, 0);
});

test("the same chat can switch its idle seat between the manual ChatGPT queue and its inbox", (t) => {
  const { run, write, room } = setup(t);
  const manual = run(["join", "room", "--as", "astra", "--manual"], ASTRA);
  assert.match(manual.out, /Manual delivery: turns are queued in this ChatGPT chat and wait there until someone presses Send/);
  assert.equal(room("room").participants.astra.transport, "codex-queue");
  const upgraded = run(["join", "room", "--as", "astra"], ASTRA);
  assert.equal(upgraded.code, 0, upgraded.err);
  assert.match(upgraded.out, /now receives room turns through astra-inbox[\s\S]*wait for your turn by running this in the foreground/);
  assert.equal(room("room").participants.astra.transport, "astra-inbox");
  assert.deepEqual(room("room").events.map((e) => e.type), ["join", "transport-changed"]);
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("h.txt", "Hi.")]).code, 0);
  assert.match(run(["join", "room", "--as", "astra", "--manual"], ASTRA).err, /has a turn in progress/);
  assert.match(run(["join", "room", "--as", "claude", "--manual"], CLAUDE).err, /claude cannot use the codex-queue transport/);
});

test("a listening GPT steps aside when something new lands in its own ChatGPT chat", async (t) => {
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite) return t.skip("node:sqlite is unavailable");
  const { run, start, root } = setup(t);
  joinBoth(run);
  const codexHome = path.join(path.dirname(root), "codex-home");
  fs.mkdirSync(codexHome);
  const db = new sqlite.DatabaseSync(path.join(codexHome, "queue_1.sqlite"));
  db.exec("create table queued_thread_revisions (revision integer primary key autoincrement, thread_id text not null unique)");
  const listening = start(["listen", "room", "--as", "astra", "--timeout", "20"], { ...ASTRA, CODEX_HOME: codexHome });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  db.prepare("insert into queued_thread_revisions (thread_id) values (?)").run(THREAD);
  db.close();
  const began = Date.now();
  const { code, out } = await listening;
  assert.equal(code, 0, out);
  assert.match(out, /Something new is waiting in your chat, possibly from the human\. Stop listening and end your turn/);
  assert.ok(Date.now() - began < 10_000, "it returns promptly, not at the timeout");
});

test("stick tells a resumed GPT to keep waiting in the foreground, and Claude to keep its background listener", (t) => {
  const { run, write } = setup(t);
  joinBoth(run);
  assert.equal(run(["send", "room", "--to", "claude", "--file", write("h.txt", "Claude first.")]).code, 0);
  const astra = run(["stick", "room"], ASTRA);
  assert.equal(astra.code, 3);
  assert.match(astra.out, /Stay connected: wait for your turn by running this in the foreground: node .*listen room --root .* --as gpt/);
  assert.doesNotMatch(astra.out, /end your turn/i);
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("x.txt", "x")]).code, 0, "human input saves while Claude holds the stick");
  assert.equal(run(["stick", "room"], CLAUDE).code, 0, "sending does not take Claude's stick");
});

test("an old listener whose seat moves to another chat stops without taking that chat's messages", async (t) => {
  const { run, start, write, inbox } = setup(t);
  joinBoth(run);
  const old = start(["listen", "room", "--as", "astra", "--timeout", "20"], ASTRA);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const other = { CODEX_THREAD_ID: OTHER };
  assert.equal(run(["join", "room", "--as", "astra", "--rebind"], other).code, 0);
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("h.txt", "For the new GPT chat.")]).code, 0);
  const { code, out } = await old;
  assert.equal(code, 0, out);
  assert.match(out, /This chat is no longer astra in room: its seat now belongs to another chat or delivery route\. Stopped listening without taking any messages\./);
  assert.doesNotMatch(out, /For the new GPT chat/);
  assert.equal(inbox("room", "astra").length, 1, "the replacement chat's turn is still waiting");
  assert.match(run(["listen", "room", "--as", "astra", "--timeout", "2"], other).out, /For the new GPT chat/);
});

test("CLI rejects a stale answer until the new human input is explicitly received", (t) => {
  const { run, write, room } = setup(t);
  joinBoth(run);
  run(["send", "room", "--to", "astra", "--file", write("first.txt", "Start")]);
  const id = room("room").pending.id;
  run(["receive", "room", "--turn", id], ASTRA);
  run(["send", "room", "--to", "claude", "--file", write("more.txt", "Include recovery")]);
  const command = ["reply", "room", "--turn", id, "--next", "astra", "--file", write("answer.txt", "Here is the revised plan")];
  const review = run(command, ASTRA);
  assert.equal(review.code, 3, review.err);
  assert.match(review.out, /Your reply was not accepted/);
  assert.match(review.out, /Include recovery/);
  assert.match(review.out, /receive room --root .* --turn .* --revision 2/);
  assert.equal(room("room").messages.length, 2);
  const received = run(["receive", "room", "--turn", id, "--revision", "2"], ASTRA);
  assert.equal(received.code, 0, received.err);
  assert.equal(run(command, ASTRA).code, 0);
  assert.equal(room("room").owner, "claude");
  assert.equal(run(command, ASTRA).code, 0);
  assert.equal(room("room").messages.length, 3);
});

test("the last CLI join starts the saved opening exactly once", async (t) => {
  const { run, root, room, inbox } = setup(t);
  const { RoomStore, Semaphore } = await import('../lib/core.mjs');
  const name = run(["new", "Opening flow"]).out.match(/as room (room-[A-Za-z0-9-]+)\./)[1];
  const store = new RoomStore(root, name);
  store.acquire();
  try {
    const app = new Semaphore(store, {});
    await app.setOpening("Plan our release", "claude", { clientId: "cli-opening-request", members: ["astra", "claude"] });
  } finally { store.release(); }
  const first = run(["join", name, "--as", "claude"], CLAUDE);
  assert.equal(first.code, 0, first.err);
  assert.equal(room(name).opening.state, "waiting");
  const last = run(["join", name, "--as", "astra"], ASTRA);
  assert.equal(last.code, 0, last.err);
  assert.equal(room(name).opening.state, "started");
  assert.equal(room(name).owner, "claude");
  assert.equal(inbox(name).length, 1);
  assert.equal(run(["join", name, "--as", "astra"], ASTRA).code, 0);
  assert.equal(inbox(name).length, 1);
  assert.match(run(["listen", name], CLAUDE).out, /Plan our release/);
});

test("loop-in creates a native group and opening atomically, without starting another chat process", (t) => {
  const f = setup(t);
  const file = f.write("opening.md", "Please invite Claude to review this plan");
  const args = ["loop-in", "--as", "astra", "--to", "claude", "--first", "claude", "--file", file, "--request-id", "native-opening-123"];
  const first = f.run(args, ASTRA);
  assert.equal(first.code, 0, first.err);
  const name = first.out.match(/in (room-[a-f0-9]+)\./)[1];
  const saved = f.room(name);
  assert.equal(saved.participants.astra.id, THREAD);
  assert.equal(saved.participants.astra.transport, "astra-inbox");
  assert.equal(saved.participants.claude.id, null);
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].via, "astra");
  assert.equal(saved.opening.state, "waiting");
  assert.equal(saved.owner, "human");
  assert.equal(saved.pending, null);
  assert.ok(first.out.includes(f.root));
  assert.match(first.out, /claude:\/\//);
  assert.equal(f.run(args, ASTRA).code, 0);
  assert.equal(f.room(name).messages.length, 1);
  assert.equal(fs.readdirSync(f.root).length, 1);
  assert.match(f.run([...args.slice(0, -1), "different-request"], ASTRA).err, /already connected/);
  assert.equal(fs.readdirSync(f.root).length, 1);
  assert.equal(f.run(args, { CODEX_THREAD_ID: OTHER }).code, 1);
  assert.equal(f.room(name).participants.astra.id, THREAD);
  assert.equal(f.queued().length, 0);
  assert.equal(f.claudeCalled(), false);
  const joined = f.run(["join", name, "--as", "claude"], CLAUDE);
  assert.equal(joined.code, 0, joined.err);
  assert.equal(f.room(name).opening.state, "started");
  const turnId = f.room(name).pending.id;
  assert.equal(f.room(name).pending.speaker, "claude");
  assert.equal(f.run(args, ASTRA).code, 0);
  assert.equal(f.room(name).pending.id, turnId);
  assert.equal(f.claudeCalled(), false);
});

test("loop-in refuses missing native identity before creating a room", (t) => {
  const f = setup(t);
  const file = f.write("opening.md", "A new group");
  const result = f.run(["loop-in", "--as", "astra", "--to", "claude", "--file", file, "--request-id", "missing-native-123"]);
  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(f.root), false);
});

test("loop-in from Claude defaults to a catch-up turn in the initiating native chat", (t) => {
  const f = setup(t);
  const file = f.write("opening.md", "Bring GPT into this discussion");
  const started = f.run(["loop-in", "--as", "claude", "--to", "astra", "--file", file, "--request-id", "claude-native-start"], CLAUDE);
  assert.equal(started.code, 0, started.err);
  const name = started.out.match(/in (room-[a-f0-9]+)\./)[1];
  assert.equal(f.room(name).opening.to, "claude");
  assert.equal(f.room(name).messages[0].via, "claude");
  assert.equal(f.room(name).participants.claude.id, SESSION);
  const joined = f.run(["join", name, "--as", "astra"], ASTRA);
  assert.equal(joined.code, 0, joined.err);
  assert.equal(f.room(name).pending.speaker, "claude");
  assert.equal(f.room(name).opening.state, "started");
  assert.equal(f.inbox(name).length, 1);
  assert.equal(f.claudeCalled(), false);
});

test("GPT's default listener has no timer and stays quiet until a real turn arrives", async (t) => {
  const f = setup(t); joinBoth(f.run);
  // Advance the child clock by ten minutes each read. A former 300-second
  // default would exit immediately; an event-only wait must remain attached.
  const clock = f.write('fast-clock.mjs', 'let now = Date.now(); Date.now = () => (now += 600000);');
  const listening = f.start(['listen', 'room', '--as', 'astra'], { ...ASTRA, NODE_OPTIONS: `--import=${clock}` });
  await new Promise(resolve => setTimeout(resolve, 750));
  const marker = path.join(f.root, 'room', 'inbox', 'astra', 'listener.pid');
  assert.equal(fs.existsSync(marker), true, 'the default listener remains attached past the old virtual deadline');
  const sent = f.run(['send', 'room', '--to', 'astra', '--file', f.write('event.md', 'Your next turn')]);
  assert.equal(sent.code, 0, sent.err);
  let timer;
  try {
    const result = await Promise.race([listening, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Listener failed to return the turn')), 5000); })]);
    assert.equal(result.code, 0, result.out);
    assert.ok(turnIn(result.out));
    assert.doesNotMatch(result.out, /ExperimentalWarning|No new turn in/);
  } finally { clearTimeout(timer); }
});

for (const options of [{ defaultRoot: true }, { quotedRoot: true }]) {
  test(`generated commands keep their room root across environments: ${JSON.stringify(options)}`, (t) => {
    const f = setup(t, options); joinBoth(f.run);
    const joined = f.run(['join', 'room', '--as', 'claude'], CLAUDE);
    assert.match(joined.out, /listen room --root /);
    f.run(['send', 'room', '--to', 'claude', 'Keep this root']);
    const envelope = f.run(['listen', 'room'], CLAUDE).out;
    const receive = envelope.split('\n').find(line => line.startsWith('node ') && line.includes(' receive room '));
    assert.ok(receive.includes('--root '));
    const got = f.runHint(receive, { ...CLAUDE, SEMAPHORE_HOME: path.join(f.root, 'different-installation') });
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /Keep this root/);
    for (const line of got.stdout.split('\n').filter(line => line.startsWith('node ')))
      assert.ok(line.includes('--root '), line);
    const reply = f.run(['reply', 'room', '--turn', f.room('room').pending.id, '--next', 'astra', 'Root retained'], CLAUDE);
    assert.equal(reply.code, 0, reply.err);
    assert.match(reply.out, /listen room --root /);
    const next = f.run(['listen', 'room', '--as', 'astra'], ASTRA).out;
    assert.match(next, /receive room --root /);
    assert.match(next, /reply room --root /);
    assert.match(next, /stick room --root /);
  });
}

test('join with its own opening gives the turn first; repeat joins and listen guide the current holder', (t) => {
  const f=setup(t);
  const opening=f.run(['loop-in','--as','astra','--to','claude','--first','claude','--file',f.write('opening.md','Start with Claude'),'--request-id','state-aware-opening'],ASTRA);
  const room=opening.out.match(/in (room-[a-f0-9]+)\./)[1];
  const join=f.run(['join',room,'--as','claude'],CLAUDE);
  assert.equal(join.code,0,join.err);
  assert.match(join.out,/Start with Claude/);
  assert.doesNotMatch(join.out,/Make sure this is running|Keep this running|Stay connected/);
  const id=f.room(room).pending.id;
  const duplicate=f.run(['join',room,'--as','claude'],CLAUDE);
  assert.match(duplicate.out,/Read and acknowledge your saved turn first/);
  assert.doesNotMatch(duplicate.out,/ listen /);
  f.run(['receive',room,'--turn',id],CLAUDE);
  for(const args of [['join',room,'--as','claude'],['stick',room]]){
    const result=f.run(args,CLAUDE);
    assert.equal(result.code,0,result.err);
    assert.match(result.out,/already received turn/);
    assert.match(result.out,/Keep your listener running as a background task so the human's messages reach you while you work: node .* listen /);
  }
  // Claude's listener keeps running through its own turn, waiting for the human's messages.
  const quiet=f.run(['listen',room,'--timeout','1'],CLAUDE);
  assert.equal(quiet.code,0,quiet.err);
  assert.match(quiet.out,/No new input for your turn in 1 seconds/);
});

test('stdin, files and positional replies preserve literal Markdown and trailing newlines', (t) => {
  const f=setup(t);joinBoth(f.run);
  const message="## Today's draft — café 🌱\n\n`code` and $HOME, $(not-a-command), apostrophe's\n\n";
  for(const mode of ['stdin','file','positional']){
    f.run(['send','room','--to','astra',`Test ${mode}`]);
    const id=f.room('room').pending.id;
    f.run(['receive','room','--turn',id],ASTRA);
    const input=mode==='stdin' ? ['--file','-'] : mode==='file' ? ['--file',f.write('literal.md',message)] : [message];
    const result=f.run(['reply','room','--turn',id,'--next','human',...input],ASTRA,mode==='stdin'?message:undefined);
    assert.equal(result.code,0,result.err);
    assert.equal(f.room('room').messages.at(-1).text,message);
    assert.equal(f.run(['reply','room','--turn',id,'--next','human',...input],ASTRA,mode==='stdin'?message:undefined).code,0);
  }
  // Simulate an accepted reply from a pre-upgrade process that trimmed it.
  const legacy=f.room('room');const last=legacy.messages.at(-1);
  last.text=last.text.trim();
  fs.writeFileSync(path.join(f.root,'room','room.json'),JSON.stringify(legacy));
  const retry=f.run(['reply','room','--turn',last.turnId,'--next','human','--file','-'],ASTRA,message);
  assert.equal(retry.code,0,retry.err);assert.match(retry.out,/Already accepted/);
  assert.equal(f.room('room').messages.length,legacy.messages.length);
});

test('a stdin reply requiring review leaves an exact private draft and a usable retry', (t) => {
  const f=setup(t);joinBoth(f.run);
  f.run(['send','room','--to','astra','Start']);
  const id=f.room('room').pending.id;f.run(['receive','room','--turn',id],ASTRA);
  f.run(['send','room','--to','astra','Include the new requirement']);
  const text="A draft with `code`, $HOME and an apostrophe's — 🌱\n\n";
  const review=f.run(['reply','room','--turn',id,'--next','human','--file','-'],ASTRA,text);
  assert.equal(review.code,3,review.err);
  const draft=review.out.match(/Your draft is kept at (.*)\. Revise/)[1];
  assert.equal(fs.readFileSync(draft,'utf8'),text);
  assert.equal(fs.statSync(draft).mode & 0o777,0o600);
  const retry=review.out.split('\n').find(line=>line.startsWith('node ') && line.includes(' --next human --file '));
  const revision=f.room('room').pending.reviewThrough;
  assert.equal(f.run(['receive','room','--turn',id,'--revision',String(revision)],ASTRA).code,0);
  const accepted=f.runHint(retry,ASTRA);
  assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(f.room('room').messages.at(-1).text,text);
});

test('compact receipt is explicit, exact and recoverable with full output', (t) => {
  const f=setup(t);joinBoth(f.run);
  const body='Distinct long context '.repeat(400);
  f.run(['send','room','--to','astra',body]);
  const id=f.room('room').pending.id;
  assert.equal(f.run(['receive','room','--turn',id,'--compact'],ASTRA).code,1);
  assert.equal(f.room('room').pending.receivedAt,undefined);
  const delivered=f.run(['listen','room','--as','astra'],ASTRA);
  assert.match(delivered.out,/revision 1/);
  const compact=f.run(['receive','room','--turn',id,'--compact','--seen-through','1'],ASTRA);
  assert.equal(compact.code,0,compact.err);
  assert.match(compact.out,/Acknowledged turn .*revision 1 · holder: astra/);
  assert.match(compact.out,/reply room --root /);
  assert.doesNotMatch(compact.out,/Distinct long context/);
  assert.match(f.run(['receive','room','--turn',id,'--show'],ASTRA).out,/Distinct long context/);
});

test('new input forces full review instead of a compact acknowledgment, including later revisions', (t) => {
  const f=setup(t);joinBoth(f.run);
  f.run(['send','room','--to','astra','Original']);
  const id=f.room('room').pending.id;
  f.run(['send','room','--to','astra','New human input']);
  const compact=f.run(['receive','room','--turn',id,'--compact','--seen-through','1'],ASTRA);
  assert.equal(compact.code,3,compact.err);
  assert.match(compact.out,/New human input/);
  assert.match(compact.out,/--revision 2/);
  assert.equal(f.room('room').pending.receivedAt,undefined);
  assert.equal(f.room('room').messages[1].readAt,undefined);
  f.run(['send','room','--to','astra','Even newer human input']);
  const newer=f.run(['receive','room','--turn',id,'--revision','2','--compact','--seen-through','2'],ASTRA);
  assert.equal(newer.code,3,newer.err);
  assert.match(newer.out,/Even newer human input/);
  assert.match(newer.out,/--revision 3/);
  assert.equal(f.room('room').pending.receivedAt,undefined);
  const bad=f.run(['receive','room','--turn',id,'--revision','999','--compact','--seen-through','999'],ASTRA);
  assert.equal(bad.code,1);assert.equal(f.room('room').pending.reviewThrough,3);
  const show=f.run(['receive','room','--turn',id,'--revision','3','--show'],ASTRA);
  assert.equal(show.code,0,show.err);
  assert.match(show.out,/New human input/);assert.match(show.out,/Even newer human input/);
  assert.equal(f.room('room').pending.receivedThrough,3);
  assert.ok(f.room('room').messages[2].readAt);
});

test('a wrong compact display revision never acknowledges a turn', (t) => {
  const f=setup(t);joinBoth(f.run);
  f.run(['send','room','--to','astra','Read this full body']);
  const id=f.room('room').pending.id;
  const result=f.run(['receive','room','--turn',id,'--compact','--seen-through','0'],ASTRA);
  assert.equal(result.code,3,result.err);
  assert.match(result.out,/Read this full body/);
  assert.equal(f.room('room').pending.receivedAt,undefined);
  const recovered=f.run(['receive','room','--turn',id,'--revision','1','--show'],ASTRA);
  assert.equal(recovered.code,0,recovered.err);
});

test('notes require the bound, acknowledged turn and never deliver a reply', (t) => {
  const f = setup(t); joinBoth(f.run);
  assert.equal(f.run(['send', 'room', '--to', 'astra', 'Make the presentation']).code, 0);
  const id = f.room('room').pending.id;
  const note = (args, env = ASTRA) => f.run(['note', 'room', '--turn', id, ...args], env);
  assert.match(note(['Starting']).err, /Receive this turn/);
  assert.equal(f.room('room').statusNote, undefined);
  assert.equal(f.run(['receive', 'room', '--turn', id], ASTRA).code, 0);
  const before = f.room('room');
  for (const env of [{}, { CODEX_THREAD_ID: OTHER }, CLAUDE])
    assert.equal(note(['Not mine'], env).code, 1);
  assert.equal(note(['--as', 'claude', 'Impersonating']).code, 1);
  assert.equal(f.run(['note', 'room', '--turn', 'stale-turn', 'Stale'], ASTRA).code, 1);
  assert.equal(note(['   \n\t']).code, 1);
  assert.equal(note(['--clear', '--approval']).code, 1);
  assert.equal(note(['--clear', 'ambiguous']).code, 1);
  assert.equal(note(['--clear', '--file', '-']).code, 1);
  assert.equal(note(['Comparing\n\tthree  options']).code, 0);
  const working = f.room('room').statusNote;
  assert.equal(working.text, 'Comparing three options');
  assert.equal(working.kind, 'working');
  assert.equal(Date.parse(working.expiresAt) - Date.parse(working.updatedAt), WORKING_NOTE_TTL);
  assert.match(f.run(['status', 'room']).out, /GPT is working[\s\S]*Comparing three options/);

  assert.equal(note(['--approval', 'Approve the native file operation']).code, 0);
  assert.equal(f.room('room').statusNote.expiresAt, null);
  assert.match(f.run(['status', 'room']).out, /waiting for your approval in ChatGPT/);
  assert.equal(note(['🦋'.repeat(281)]).code, 0);
  assert.equal(f.room('room').statusNote.text, '🦋'.repeat(280), 'the cap never splits a Unicode code point');
  const after = f.room('room');
  for (const key of ['owner', 'messages', 'pending', 'autoTurns', 'maxTurns', 'participants'])
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.events.filter(e => e.type === 'status-note').length, 3);
  assert.ok(after.events.filter(e => e.type.startsWith('status-note')).every(e => !('text' in e.detail)));
  assert.equal(f.queued().length, 0);
  assert.equal(f.claudeCalled(), false);
  assert.equal(note(['--clear']).code, 0);
  assert.equal(note(['--clear']).code, 0, 'clearing twice is harmless');
  assert.equal(f.room('room').statusNote, undefined);
});

test('notes survive human interjections and review retries, then clear on reply and take', (t) => {
  const f = setup(t); joinBoth(f.run);
  f.run(['send', 'room', '--to', 'astra', 'Please work']);
  const id = f.room('room').pending.id;
  f.run(['receive', 'room', '--turn', id], ASTRA);
  assert.equal(f.run(['note', 'room', '--turn', id, '--approval', 'Native approval pending'], ASTRA).code, 0);
  const original = f.room('room').statusNote;
  assert.equal(f.run(['send', 'room', '--to', 'claude', 'Keep the new requirement']).code, 0);
  assert.deepEqual(f.room('room').statusNote, original);
  const reply = ['reply', 'room', '--turn', id, '--next', 'claude', 'Incorporated the requirement'];
  assert.equal(f.run(reply, ASTRA).code, 3);
  assert.deepEqual(f.room('room').statusNote, original, 'an uncommitted reply keeps the note');
  assert.equal(f.run(['receive', 'room', '--turn', id, '--revision', '2'], ASTRA).code, 0);
  assert.equal(f.run(reply, ASTRA).code, 0);
  assert.equal(f.room('room').statusNote, undefined);
  const next = f.room('room').pending.id;
  assert.equal(f.run(['note', 'room', '--turn', id, '--clear'], ASTRA).code, 1);
  assert.equal(f.run(['receive', 'room', '--turn', next], CLAUDE).code, 0);
  assert.equal(f.run(['note', 'room', '--turn', next, '--approval', 'Please approve in Claude'], CLAUDE).code, 0);
  assert.match(f.run(['status', 'room']).out, /waiting for your approval in the Claude app/);
  assert.equal(f.run(['take', 'room']).code, 0);
  assert.equal(f.room('room').statusNote, undefined);
  assert.equal(f.run(['note', 'room', '--turn', next, 'Still working'], CLAUDE).code, 1);
});

test('status hides expired notes and a rebind removes the old seat note', (t) => {
  const f = setup(t); joinBoth(f.run);
  f.run(['send', 'room', '--to', 'astra', 'Please work']);
  const id = f.room('room').pending.id;
  f.run(['receive', 'room', '--turn', id], ASTRA);
  f.run(['note', 'room', '--turn', id, 'An old working note'], ASTRA);
  const file = path.join(f.root, 'room', 'room.json');
  const expired = f.room('room');
  expired.statusNote.expiresAt = new Date(Date.now() - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(expired));
  assert.doesNotMatch(f.run(['status', 'room']).out, /An old working note/);
  f.run(['take', 'room']); f.run(['recover', 'room']);
  // A legacy or interrupted writer may have left stale state in the journal.
  const saved = f.room('room'); saved.statusNote = expired.statusNote;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(f.run(['join', 'room', '--as', 'astra', '--rebind'], { CODEX_THREAD_ID: OTHER }).code, 0);
  assert.equal(f.room('room').statusNote, undefined);
  assert.equal(f.run(['note', 'room', '--turn', id, 'Old chat'], ASTRA).code, 1);
});

test('artifact commands require this received turn and leave conversation delivery unchanged', t => {
  const f = setup(t); joinBoth(f.run);
  f.run(['send', 'room', '--to', 'astra', 'Create a deliverable']);
  const id = f.room('room').pending.id;
  const file = f.write('result.html', '<h1>A deliverable</h1>');
  const add = ['artifact', 'room', 'add', '--turn', id, '--file', file, '--title', 'Our result', '--ready'];
  assert.match(f.run(add, ASTRA).err, /Receive this turn/);
  f.run(['receive', 'room', '--turn', id], ASTRA);
  for (const env of [{}, CLAUDE, { CODEX_THREAD_ID: OTHER }]) assert.equal(f.run(add, env).code, 1);
  assert.equal(f.run([...add, '--as', 'claude'], ASTRA).code, 1);
  const before = f.room('room');
  const registered = f.run(add, ASTRA);
  assert.equal(registered.code, 0, registered.err);
  const artifact = JSON.parse(registered.out).artifact;
  assert.equal(JSON.parse(f.run(add, ASTRA).out).duplicate, true);
  const review = ['artifact', 'room', 'review', '--turn', id, '--id', artifact.id, '--revision', '1', '--sha256', artifact.sha256, '--kind', 'source'];
  assert.equal(f.run(review, ASTRA).code, 0);
  const listed = JSON.parse(f.run(['artifact', 'room', 'list']).out).artifacts;
  assert.equal(listed[0].ready, true); assert.equal(listed[0].currentReviews[0].speaker, 'astra');
  for (const key of ['owner', 'messages', 'pending', 'autoTurns', 'maxTurns', 'participants'])
    assert.deepEqual(f.room('room')[key], before[key], key);
  const reply = f.run(['reply', 'room', '--turn', id, '--next', 'claude', 'Review our result'], ASTRA);
  assert.equal(reply.code, 0, reply.err);
  assert.equal(f.run(review, ASTRA).code, 1, 'old turn cannot write a review');
  const envelope = f.run(['listen', 'room'], CLAUDE).out;
  assert.ok(envelope.includes(`revision 1 · SHA-256 ${artifact.sha256}`));
  assert.ok(envelope.includes(artifact.path));
  assert.match(envelope, /artifact room --root .* list/);
  assert.equal(f.queued().length, 0);
  assert.equal(f.claudeCalled(), false);
});

test('title suggestion authenticates the first received native turn and preserves human renames', t => {
  const f=setup(t);
  const started=f.run(['loop-in','--as','astra','--to','claude','--first','claude','--file',f.write('name.md','A long opening that needs a short name'),'--request-id','title-opening-123'],ASTRA);
  const room=started.out.match(/in (room-[a-f0-9]+)\./)[1];
  f.run(['join',room,'--as','claude'],CLAUDE);
  const id=f.room(room).pending.id, args=['title',room,'A concise 🌱 name','--turn',id];
  assert.equal(f.run(args,CLAUDE).code,1);
  f.run(['receive',room,'--turn',id],CLAUDE);
  assert.equal(f.run(args,{CLAUDE_CODE_SESSION_ID:OTHER}).code,1);
  assert.equal(f.run(args,ASTRA).code,1);
  const named=f.run(args,CLAUDE); assert.equal(named.code,0,named.err);
  assert.equal(f.room(room).title,'A concise 🌱 name');
  assert.equal(JSON.parse(f.run(args,CLAUDE).out).duplicate,true);
  assert.equal(f.run(['title',room,'My chosen name']).code,0);
  assert.equal(f.run(args,CLAUDE).code,1);
  assert.equal(f.room(room).title,'My chosen name'); assert.equal(f.room(room).messages.length,1);
});

test('CLI listener records observation without receiving and timings retain it after the reply', t => {
  const f=setup(t); joinBoth(f.run);
  f.run(['send','room','--to','claude','Timing probe']);
  const id=f.room('room').pending.id;
  const listened=f.run(['listen','room','--timeout','1'],CLAUDE); assert.equal(listened.code,0,listened.err);
  let report=JSON.parse(f.run(['timings','room']).out), first=report.samples[0].listenerObservedAt;
  assert.ok(first); assert.equal(report.samples[0].acknowledgedAt,null);
  assert.equal(f.room('room').pending.receivedAt,undefined); assert.equal(f.room('room').messages[0].readAt,undefined);
  f.run(['listen','room','--timeout','1'],CLAUDE);
  assert.equal(JSON.parse(f.run(['timings','room']).out).samples[0].listenerObservedAt,first);
  f.run(['receive','room','--turn',id],CLAUDE);
  f.run(['reply','room','--turn',id,'--next','human','Finished'],CLAUDE);
  report=JSON.parse(f.run(['timings','room']).out);
  assert.equal(report.samples[0].listenerObservedAt,first); assert.ok(report.samples[0].acknowledgedAt);
  assert.ok(report.samples[0].repliedAt); assert.equal(report.groups[0].turns,1);
});

const settled = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
async function attached(f, speaker = "claude") {
  const marker = path.join(f.root, "room", "inbox", speaker, "listener.pid");
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(marker), true, "the listener is attached");
}

test("Claude's listener brings the human's message to the turn Claude is working on, then waits for its next turn", async (t) => {
  const f = setup(t);
  joinBoth(f.run);
  f.run(["send", "room", "--to", "claude", "--file", f.write("h.txt", "Claude first.")]);
  const id = f.room("room").pending.id;
  assert.equal(f.run(["receive", "room", "--turn", id], CLAUDE).code, 0);
  const listening = f.start(["listen", "room", "--timeout", "20"], CLAUDE);
  await attached(f);
  f.run(["send", "room", "--to", "claude", "--file", f.write("more.txt", "Crucial: use the staging database.")]);
  const heard = await settled(listening, 10_000);
  assert.ok(heard, "the listener finishes as soon as the human writes");
  assert.equal(heard.code, 0, heard.out);
  assert.match(heard.out, /new input for your current turn as Claude/);
  assert.match(heard.out, /Human → Claude:\nCrucial: use the staging database\./);
  assert.doesNotMatch(heard.out, /Claude first\./, "only the new input, not the whole turn again");
  assert.match(heard.out, new RegExp(`receive room --root .* --turn ${id} --revision 2`));
  assert.match(heard.out, /Then start your listener again as a background task/);
  assert.equal(f.room("room").pending.reviewThrough, 2);
  assert.equal(f.room("room").messages[1].readAt, undefined, "shown, not yet read");
  assert.equal(f.room("room").replyNext, undefined, "guidance for Claude leaves the handoff to Claude");
  assert.equal(f.run(["receive", "room", "--turn", id, "--revision", "2"], CLAUDE).code, 0);
  assert.equal(f.room("room").messages[1].readBy, "claude");
  // Started again, the listener lets Claude's own handoff pass quietly and waits for its next turn.
  const next = f.start(["listen", "room", "--timeout", "20"], CLAUDE);
  await attached(f);
  const passed = f.run(["reply", "room", "--turn", id, "--next", "astra", "--file", f.write("c.txt", "Used staging. Over to GPT.")], CLAUDE);
  assert.equal(passed.code, 0, passed.err);
  assert.equal(f.room("room").owner, "astra");
  assert.equal(await settled(next, 1500), null, "a handoff does not end the listener");
  const t2 = f.room("room").pending.id;
  f.run(["receive", "room", "--turn", t2], ASTRA);
  assert.equal(f.run(["reply", "room", "--turn", t2, "--next", "claude", "--file", f.write("a.txt", "Back to Claude.")], ASTRA).code, 0);
  const turn = await settled(next, 10_000);
  assert.ok(turn, "the next turn arrives");
  assert.match(turn.out, /you hold the talking stick as Claude/);
  assert.match(turn.out, /Back to Claude\./);
});

test("Claude's listener tells a working Claude when the human takes the stick back", async (t) => {
  const f = setup(t);
  joinBoth(f.run);
  f.run(["send", "room", "--to", "claude", "--file", f.write("h.txt", "Long task.")]);
  const id = f.room("room").pending.id;
  f.run(["receive", "room", "--turn", id], CLAUDE);
  const listening = f.start(["listen", "room", "--timeout", "20"], CLAUDE);
  await attached(f);
  assert.equal(f.run(["take", "room"]).code, 0);
  const heard = await settled(listening, 10_000);
  assert.ok(heard, "the listener finishes when the stick is taken");
  assert.match(heard.out, /the human took the stick back from Claude/);
  assert.match(heard.out, new RegExp(`during your turn ${id}, so that turn is over: stop working on it and don't reply to it`));
  assert.match(heard.out, /listen room --root /);
});

test("GPT's foreground listener still returns guidance at once while GPT works", (t) => {
  const f = setup(t);
  joinBoth(f.run);
  f.run(["send", "room", "--to", "astra", "--file", f.write("h.txt", "GPT first.")]);
  const id = f.room("room").pending.id;
  f.run(["receive", "room", "--turn", id], ASTRA);
  const result = f.run(["listen", "room", "--as", "astra"], ASTRA);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /already received turn/);
  assert.doesNotMatch(result.out, /Keep your listener running/);
});

test("a chat registered by its Claude Code hook is woken without a listener and told so", (t) => {
  const f = setup(t);
  joinBoth(f.run);
  const home = path.join(path.dirname(f.root), "installation");
  const signal = path.join(home, "claude", "signals", SESSION);
  const registered = f.run(["hook", "register"], {}, JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", source: "startup" }));
  assert.equal(registered.code, 0, registered.err);
  assert.deepEqual(JSON.parse(registered.out), { hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: [signal] } });
  assert.equal(f.run(["hook", "register"], {}, "not json").code, 0, "a malformed hook input never disturbs the chat");
  f.run(["send", "room", "--to", "claude", "--file", f.write("h.txt", "Hello Claude")]);
  const id = f.room("room").pending.id;
  const event = JSON.stringify({ session_id: SESSION, hook_event_name: "FileChanged", file_path: signal, event: "change" });
  const woke = f.run(["hook", "wake"], {}, event);
  assert.equal(woke.code, 2);
  assert.match(woke.err, new RegExp(`it's your turn as Claude\\. Read and acknowledge it first:\\nnode .* receive room --root .* --turn ${id}`));
  assert.equal(f.run(["hook", "wake"], {}, event).code, 0, "not repeated");
  const received = f.run(["receive", "room", "--turn", id], CLAUDE);
  assert.equal(received.code, 0, received.err);
  assert.match(received.out, /Semaphore brings you the human's messages while you work and wakes this chat for its next turn, so no listener is needed\./);
  assert.doesNotMatch(received.out, /start this as a background task/);
  const passed = f.run(["reply", "room", "--turn", id, "--next", "astra", "--file", f.write("c.txt", "Over to GPT.")], CLAUDE);
  assert.equal(passed.code, 0, passed.err);
  assert.match(passed.out, /Semaphore wakes this chat when its next turn is ready; no listener is needed\. End your turn right away/);
  assert.match(f.run(["stick", "room"], CLAUDE).out, /Semaphore wakes this chat when it has something for you; no listener is needed\. End your turn\./);
});

test("end releases GPT and Claude listeners, rejects late replies and needs explicit reopen", { timeout: 15000 }, async t => {
  const f = setup(t);
  assert.equal(f.run(['join', 'room', '--as', 'gpt'], ASTRA).code, 0);
  assert.equal(f.run(['join', 'room', '--as', 'claude'], CLAUDE).code, 0);
  const sent = f.run(['send', 'room', '--to', 'gpt', 'Please work'], ASTRA);
  const turn = turnIn(sent.out);
  assert.equal(f.run(['receive', 'room', '--as', 'gpt', '--turn', turn], ASTRA).code, 0);
  assert.equal(f.run(['reply', 'room', '--turn', turn, '--next', 'human', 'Waiting'], ASTRA).code, 0);
  const gpt = f.start(['listen', 'room', '--as', 'gpt', '--timeout', '6'], ASTRA);
  const claude = f.start(['listen', 'room', '--timeout', '6'], CLAUDE);
  for (let i = 0; i < 100; i++) {
    if (['astra', 'claude'].every(s => fs.existsSync(path.join(f.root, 'room', 'inbox', s, 'listener.pid')))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.run(['end', 'room']).code, 0);
  for (const result of await Promise.all([gpt, claude])) {
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /person ended this conversation/);
    assert.doesNotMatch(result.out, /to keep waiting, run/);
  }
  assert.equal(f.run(['stick', 'room'], ASTRA).code, 3);
  assert.match(f.run(['listen', 'room', '--as', 'gpt'], ASTRA).out, /person ended/);
  assert.equal(f.run(['send', 'room', '--to', 'gpt', 'More'], ASTRA).code, 1);
  assert.equal(f.run(['reopen', 'room']).code, 0);
  assert.equal(f.room('room').owner, 'human');
});
