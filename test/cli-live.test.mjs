import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Runs the real CLI against a temporary root. A fake codex records every queued message, and a
// fake claude on PATH proves that no headless Claude session is ever started for a live room.
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "rooms");
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
  base.SEMAPHORE_HOME = path.join(dir, 'installation');
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args, "--root", root], {
      encoding: "utf8",
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
  };
}

function joinBoth(run, { manual = false } = {}) {
  assert.equal(
    run(["join", "room", "--as", "astra", ...(manual ? ["--manual"] : [])], ASTRA).code,
    0,
  );
  assert.equal(run(["join", "room", "--as", "claude"], CLAUDE).code, 0);
}

test("acceptance flow: human via Astra, Astra → Claude → Astra → human, all in the live chats", (t) => {
  const { run, write, room, queued, claudeCalled } = setup(t);
  assert.equal(run(["join", "room", "--as", "astra"], ASTRA).code, 0);
  const joined = run(["join", "room", "--as", "claude"], CLAUDE);
  assert.equal(joined.code, 0, joined.err);
  assert.match(joined.out, /listen room --root '/);

  // The human spoke in Astra's chat; Astra relays it and gets its own turn handed back directly.
  const sent = run(
    [
      "send",
      "room",
      "--to",
      "astra",
      "--file",
      write("human.txt", "Hello both. Astra first, then Claude."),
    ],
    ASTRA,
  );
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /Human \(relayed by Astra\) → Astra:\nHello both/);
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
      write("a1.txt", "Astra here. Over to Claude."),
    ],
    ASTRA,
  );
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /Accepted as message 2\. Stick: claude/);
  assert.doesNotMatch(
    r1.out,
    /Astra here/,
    "the caller is not shown its own reply again",
  );

  const heard = run(["listen", "room"], CLAUDE);
  assert.equal(heard.code, 0, heard.err);
  assert.match(
    heard.out,
    /Human \(relayed by Astra\) → Astra:\nHello both[\s\S]*Astra → Claude:\nAstra here/,
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
      write("c1.txt", "Claude here. Back to Astra."),
    ],
    CLAUDE,
  );
  assert.equal(r2.code, 0, r2.err);
  const waiting = run(["listen", "room", "--as", "astra", "--timeout", "5"], ASTRA);
  assert.equal(waiting.code, 0, waiting.err);
  const envelope = waiting.out;
  assert.match(envelope, /Claude → Astra:\nClaude here/);
  assert.doesNotMatch(
    envelope,
    /Astra here/,
    "Astra already has its own reply",
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
  assert.deepEqual(final.participants.astra, {
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
  // From anywhere else the human speaks directly, and Astra's turn waits in its inbox.
  const direct = run(["send", "room", "--to", "astra", "--file", message]);
  assert.equal(direct.code, 0, direct.err);
  assert.equal(room("room").messages[0].via, undefined);
  assert.equal(inbox("room", "astra").length, 1);
  assert.equal(queued().length, 0);
});

test("join binds only from inside the chat, is idempotent, and needs --rebind with no pending turn to replace one", (t) => {
  const { run, write, room } = setup(t);
  assert.match(
    run(["join", "room", "--as", "claude"], ASTRA).err,
    /CLAUDE_CODE_SESSION_ID is not set/,
  );
  assert.match(
    run(["join", "room", "--as", "human"], ASTRA).err,
    /--as astra or --as claude/,
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
  assert.deepEqual(saved.participants.claude, {
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
    write("c.txt", "Astra, over to you."),
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
  assert.deepEqual(room(name).participants.claude, {
    transport: "claude-inbox",
    id: SESSION,
    seen: 0,
  });
  assert.match(run(["rooms"]).out, /astra not joined, claude joined/);
  const invite = run(["invite", name, "--to", "astra"]);
  assert.match(
    invite.out,
    /^Start a new Astra chat: codex:\/\/threads\/new\?prompt=/,
  );
  assert.match(
    invite.out,
    new RegExp(
      `Or paste this into an existing Astra chat:\\n\\n(?:Join my Semaphore group chat “Release workshop” as Astra|Use the Semaphore skill to connect this chat as Astra)`,
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
      write("c.txt", "Over to Astra."),
    ],
    CLAUDE,
  );
  assert.equal(passed.code, 0, passed.err);
  assert.match(
    passed.out,
    /You no longer hold the stick\.\nBefore ending your turn, start this as a background task so the next turn wakes you:\nnode .*cli\.mjs'? listen room --root '.*'\nThen, once you have passed the stick, end your turn right away; don't keep working\./,
  );
  assert.equal(run(["stick", "room"], CLAUDE).code, 3);
  assert.equal(run(["stick", "room"], ASTRA).code, 0);
  assert.equal(
    run(["stick", "room"]).code,
    3,
    "a terminal is not the stick holder while a model has it",
  );
});

test("an Astra turn waits in its inbox across listener gaps and timeouts; it is never lost or delivered twice", (t) => {
  const { run, write, inbox, queued } = setup(t);
  joinBoth(run);
  run(["send", "room", "--to", "claude", "--file", write("h.txt", "Claude, then Astra.")]);
  const t1 = turnIn(run(["listen", "room"], CLAUDE).out);
  assert.equal(run(["receive", "room", "--turn", t1], CLAUDE).code, 0);
  // Astra is not listening when Claude hands off: the turn waits durably.
  const passed = run(["reply", "room", "--turn", t1, "--next", "astra", "--file", write("c.txt", "Over to Astra.")], CLAUDE);
  assert.equal(passed.code, 0, passed.err);
  assert.match(passed.out, /Queued for Astra \(astra-inbox; not listening yet/);
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
  assert.match(quiet.out, /No new turn in 1 seconds\. You are still connected; to keep waiting, run: node .*listen room --root .* --as astra/);
  assert.equal(queued().length, 0);
});

test("a cancelled Astra turn is dropped from its inbox instead of being delivered later", (t) => {
  const { run, write, inbox } = setup(t);
  joinBoth(run);
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("h.txt", "Astra, please.")]).code, 0);
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
  assert.match(upgraded.out, /now receives room turns through astra-inbox[\s\S]*wait for turns by running this in the foreground/);
  assert.equal(room("room").participants.astra.transport, "astra-inbox");
  assert.deepEqual(room("room").events.map((e) => e.type), ["join", "transport-changed"]);
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("h.txt", "Hi.")]).code, 0);
  assert.match(run(["join", "room", "--as", "astra", "--manual"], ASTRA).err, /has a turn in progress/);
  assert.match(run(["join", "room", "--as", "claude", "--manual"], CLAUDE).err, /claude cannot use the codex-queue transport/);
});

test("a listening Astra steps aside when something new lands in its own ChatGPT chat", async (t) => {
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

test("stick tells a resumed Astra to keep waiting in the foreground, and Claude to keep its background listener", (t) => {
  const { run, write } = setup(t);
  joinBoth(run);
  assert.equal(run(["send", "room", "--to", "claude", "--file", write("h.txt", "Claude first.")]).code, 0);
  const astra = run(["stick", "room"], ASTRA);
  assert.equal(astra.code, 3);
  assert.match(astra.out, /Stay connected: wait for your turn by running this in the foreground: node .*listen room --root .* --as astra/);
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
  assert.equal(run(["send", "room", "--to", "astra", "--file", write("h.txt", "For the new Astra chat.")]).code, 0);
  const { code, out } = await old;
  assert.equal(code, 0, out);
  assert.match(out, /This chat is no longer astra in room: its seat now belongs to another chat or delivery route\. Stopped listening without taking any messages\./);
  assert.doesNotMatch(out, /For the new Astra chat/);
  assert.equal(inbox("room", "astra").length, 1, "the replacement chat's turn is still waiting");
  assert.match(run(["listen", "room", "--as", "astra", "--timeout", "2"], other).out, /For the new Astra chat/);
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
  const file = f.write("opening.md", "Bring Astra into this discussion");
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

test("Astra's default listener has no timer and stays quiet until a real turn arrives", async (t) => {
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
