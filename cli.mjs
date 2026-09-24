#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { RoomStore, SPEAKERS, Semaphore } from "./lib/core.mjs";
import { CodexAdapter, ClaudeAdapter, CodexClient } from "./lib/adapters.mjs";
import {
  DirectTransport,
  bindFromEnv,
  listen,
  listenerStatus,
  liveEnvelope,
  liveTransport,
  INBOX_TRANSPORTS,
  acknowledgeDelivery,
  codexQueueRevision,
  turnGuidance,
  roomCommands,
} from "./lib/live.mjs";
import {
  defaultRoomRoot,
  projectDir,
  shellQuote as quote,
} from "./lib/paths.mjs";
import { buildInvite } from "./lib/invite.mjs";
import { createLiveRoom, createStartedRoom, readRooms } from "./lib/rooms.mjs";
import { diagnose } from "./lib/doctor.mjs";
import { readWakeSettings, wakePaths } from "./lib/wake.mjs";
import { WakeClient, verifyNativeSeat, sameRuntime } from "./lib/codex-runtime.mjs";
import { cancelQueuedWake } from "./lib/wake-delivery.mjs";
import { RUNTIME, formatRuntime, runtimeIdentity, runtimeChange, sameBuild } from './lib/build-info.mjs';
import { statusNote } from './lib/status-note.mjs';
import { artifactViews, artifactView } from './lib/artifacts.mjs';
import { recordListenerObservation, timingReport, timingView } from './lib/timing.mjs';
import {
  DEFAULT_PORT,
  SERVICE_LABEL,
  install,
  installPaths,
  installPlan,
  uninstall,
} from "./lib/install.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string", default: "astra" },
    file: { type: "string" },
    root: { type: "string", default: defaultRoomRoot },
    "max-turns": { type: "string" },
    as: { type: "string" },
    turn: { type: "string" },
    revision: { type: "string" },
    compact: { type: "boolean" },
    "seen-through": { type: "string" },
    show: { type: "boolean" },
    approval: { type: "boolean" },
    clear: { type: "boolean" },
    id: { type: "string" },
    title: { type: "string" },
    asset: { type: "string", multiple: true },
    "no-assets": { type: "boolean" },
    ready: { type: "boolean" },
    draft: { type: "boolean" },
    url: { type: "string" },
    access: { type: "string" },
    sha256: { type: "string" },
    kind: { type: "string" },
    "request-id": { type: "string" },
    first: { type: "string" },
    next: { type: "string" },
    via: { type: "string" },
    rebind: { type: "boolean" },
    manual: { type: "boolean" },
    timeout: { type: "string" },
    folder: { type: "string" },
    yes: { type: "boolean" },
    port: { type: "string" },
    help: { type: "boolean" },
  },
});
const [command = "help", name = "hello", ...words] = positionals;
const root = path.resolve(values.root);
const rootFlag = ` --root ${quote(root)}`;
const help = `Semaphore — you, Astra, and Claude, one speaker at a time.

Setting up (Claude or Astra runs these for you):
  node cli.mjs doctor                       Check this computer's setup
  node cli.mjs version                      Show this process's captured runtime identity
  node cli.mjs install [--yes]              List, then make, the setup changes
  node cli.mjs uninstall [--yes]            Remove Semaphore; conversations are kept
  node cli.mjs open                         Open the Semaphore app

Conversations for live desktop chats:
  node cli.mjs new "<title>"                Start a conversation
  node cli.mjs title <room> "<title>" --turn <id>  First AI's one-time name; human renames need no --turn
  node cli.mjs timings <room>              Delivery stages, distributions and failure counts (JSON)
  node cli.mjs rooms                        List conversations
  node cli.mjs invite <room> --to astra|claude [--folder <path>]   Link and text that bring an AI in

  npm start                               Start the local web app
  node cli.mjs chat <room>                  Legacy headless conversation
  node cli.mjs send <room> --to astra --file message.txt
  node cli.mjs show <room>                  Read the shared transcript
  node cli.mjs status <room>                Stick, pending turn, and chat bindings
  node cli.mjs native <room>                Show native conversation links
  node cli.mjs inspect <room>               Read Astra's saved native history
  node cli.mjs take <room>                  Take the stick; a pending native reply is rejected
  node cli.mjs recover <room>               Acknowledge an uncertain delivery
  node cli.mjs unlock <room>                Remove a lock only if its process died

Live chats (run from inside the Astra or Claude desktop chat):
  node cli.mjs loop-in --as astra --to claude --file request.md --request-id <id>
    Create a group from this chat, save the opening, and prepare the other invitation.
  node cli.mjs join <room> --as astra|claude [--rebind]   Bind this chat to the room
  node cli.mjs listen <room>                Wait for a turn without a timer; --timeout <seconds> opts in
  node cli.mjs stick <room>                 Whose turn is it? Exits 3 if it isn't this chat's
  node cli.mjs receive <room> --turn <id>    Acknowledge and read this chat's current turn
    --compact --seen-through <revision>    Only after reading that exact delivery; newer input is shown in full
    --show                                Read the full turn again
  node cli.mjs reply <room> --turn <id> --next human|astra|claude --file reply.md
    --file - reads stdin; omit --file for short quoted text. Use files or quoted heredocs for long Markdown.
    Replies preserve whitespace. A reply needing review keeps a draft and prints its retry command.
  node cli.mjs note <room> --turn <id> [--approval] "<text>"
    After receive, share a working note (30 minutes) or an approval wait (until cleared).
    Notes use one line, at most 280 characters. Use --clear without text to remove one.
  node cli.mjs artifact <room> list         Selected deliverables and exact registered versions (JSON)
  node cli.mjs artifact <room> add --turn <id> --file <path> [--title "<title>"] [--ready]
    --id <artifact> updates one (omit --file to keep its path); --asset <relative-file> selects an adjacent asset (repeatable).
    Omit --asset to keep the previous selection; --no-assets clears it. --draft removes readiness.
    --url <http(s) link> --access "<who can open it>" records a publication claim for this version.
    --url "" clears the link. No file is uploaded and no URL is fetched.
  node cli.mjs artifact <room> review --turn <id> --id <artifact> --revision <n> --sha256 <hash> --kind source|visual
    A visual review also needs --via "<permitted render inspected>". Reviews apply only to that version.
  A send from a bound chat records the human's message as relayed via that chat.

In a conversation:
  /to astra <message>   /to claude <message>   /pass astra   /pass claude
  /native   /recover   /quit
  Plain text goes to the last model you selected. Ctrl+C takes the stick
  during a response; at the prompt, Ctrl+C exits. Each run defaults to
  the conversation's reply limit, set in the app (four unless changed).
  Use --max-turns 1–20 to override it for one run.
`;
const names = { human: "You", astra: "Astra", claude: "Claude" };
const recipients = { human: "you", astra: "Astra", claude: "Claude" };

function readMessage() {
  return values.file
    ? fs.readFileSync(values.file === "-" ? 0 : path.resolve(values.file), "utf8")
    : words.join(" ");
}

// True when this process runs inside a Claude or Codex chat, whether or not that chat is bound here.
function nativeChat() {
  return Boolean(
    process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID,
  );
}

// The calling chat, verified against the room's saved binding rather than a model-supplied name.
function callerIn(room) {
  const matches = ["astra", "claude"].filter((speaker) => {
    const participant = room.participants[speaker];
    if ((participant.transport ?? "headless") === "headless") return false;
    try {
      return bindFromEnv(speaker).id === participant.id;
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0] : null;
}

function port() {
  const value = Number(values.port ?? DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("--port must be between 1 and 65535.");
  return value;
}

function seat(participant) {
  if ((participant.transport ?? "headless") === "headless") return "headless";
  return participant.id ? "joined" : "not joined";
}

function listRooms() {
  const rooms = readRooms(root);
  if (!rooms.length) {
    console.log('No conversations yet. Start one with: new "<title>"');
    return;
  }
  for (const { room } of rooms) {
    const seats = ["astra", "claude"]
      .map((speaker) => `${speaker} ${seat(room.participants[speaker])}`)
      .join(", ");
    const caller = callerIn(room);
    console.log(
      `${room.name} · “${room.title || room.name}” · stick: ${room.owner}${room.pending ? ` (waiting for ${room.pending.speaker})` : ""} · ${room.messages.length} messages · ${seats}${caller ? ` · this chat: ${caller}` : ""}`,
    );
  }
}

function newRoom() {
  const { room } = createLiveRoom(root, positionals.slice(1).join(" "));
  console.log(`Started “${room.title}” as room ${room.name}.`);
  console.log(
    `Each chat joins with: join ${room.name}${rootFlag} --as astra|claude`,
  );
  console.log(
    `To bring an AI in: invite ${room.name}${rootFlag} --to astra|claude`,
  );
}

async function loopIn() {
  const speaker = values.as;
  if (!["astra", "claude"].includes(speaker) || !["astra", "claude"].includes(values.to) || values.to === speaker)
    throw new Error("Choose this chat with --as and the other participant with --to.");
  const binding = bindFromEnv(speaker);
  const appPort = port();
  const text = readMessage();
  const clientId = values["request-id"];
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId))
    throw new Error("Provide --request-id and keep it for retries of this opening.");
  const existing = readRooms(root).find(({ room }) => room.participants[speaker]?.id === binding.id);
  if (existing && existing.room.creationRequest?.clientId !== clientId)
    throw new Error(`This chat is already connected to ${existing.room.name}. Reuse that room, or start a new native chat for a separate conversation.`);
  const first = values.first ?? speaker;
  const { room, duplicate } = await createStartedRoom(root, { text, to: first, members: [speaker, values.to], clientId },
    { source: { speaker, ...binding } });
  console.log(`${duplicate ? "Already saved" : "Saved"} your request in ${room.name}. This chat is connected as ${names[speaker]}.`);
  console.log(`Conversation: http://127.0.0.1:${appPort}/#${encodeURIComponent(room.name)}`);
  if (room.opening.state === "waiting")
    console.log(`The opening waits for ${names[values.to]} to join, then goes to ${names[first]} once.`);
  invite(room);
  printTurnGuidance(room, speaker);
}

function invite(room) {
  const speaker = values.to;
  const invitation = buildInvite({
    root,
    room,
    speaker,
    ...(values.folder ? { workspace: path.resolve(values.folder) } : {}),
  });
  console.log(
    `${invitation.label}: ${invitation.url}\n\nOr paste this into an existing ${names[speaker]} chat:\n\n${invitation.prompt}`,
  );
}

async function doctor() {
  const { ok, checks } = await diagnose({ port: port() });
  for (const check of checks)
    console.log(
      `${check.ok ? "✓" : "○"} ${check.name}: ${check.detail}${check.fix ? `\n    ${check.fix}` : ""}`,
    );
  console.log(
    ok
      ? "\nEverything Semaphore needs is ready."
      : "\nSome things need attention.",
  );
  if (!ok) process.exitCode = 1;
}

async function installCommand() {
  const plan = installPlan({ port: port() });
  if (!values.yes) {
    console.log("Semaphore setup will make these changes:");
    plan.steps.forEach((step, index) =>
      console.log(`${index + 1}. ${step.summary}`),
    );
    console.log("\nNothing has changed yet. Run again with --yes to set up.");
    return;
  }
  const { paths } = install({ port: port() });
  if (process.platform === "darwin") {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port()}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        const health = await response.json();
        if (health.app === "semaphore" && health.pid) {
          const service = spawnSync(
            "launchctl",
            ["print", `gui/${process.getuid()}/${SERVICE_LABEL}`],
            { encoding: "utf8", timeout: 2000 },
          );
          ready =
            service.status === 0 &&
            service.stdout.includes(`pid = ${health.pid}\n`);
          if (ready) break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready)
      throw new Error(
        "Setup files were saved, but the background app did not become ready. Another app may be using this port. Check doctor or choose a different --port.",
      );
  }
  console.log(
    `Semaphore is set up. Open it from ${process.platform === "darwin" ? `${paths.launcher} or ` : ""}http://127.0.0.1:${port()}.`,
  );
}

function uninstallCommand() {
  if (!values.yes) {
    console.log(
      `This removes Semaphore's command, its skill for Claude and Astra, the background app and the Semaphore app.\nConversations stay in ${installPaths().rooms}. Run again with --yes to remove.`,
    );
    return;
  }
  const { removed, kept } = uninstall();
  console.log(
    removed.length
      ? `Removed:\n${removed.map((item) => `  ${item}`).join("\n")}`
      : "Nothing to remove.",
  );
  console.log(`Conversations are kept in ${kept}.`);
}

async function openApp() {
  const url = `http://127.0.0.1:${port()}`;
  if (process.platform === "darwin")
    spawnSync(
      "launchctl",
      ["kickstart", `gui/${process.getuid()}/${SERVICE_LABEL}`],
      { stdio: "ignore" },
    );
  let running = false;
  try {
    running =
      (
        await (
          await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
        ).json()
      ).app === "semaphore";
  } catch {}
  if (!running)
    throw new Error(
      "The Semaphore app is not running. Set it up with install, or start it with: node server.mjs",
    );
  if (process.platform === "darwin")
    spawnSync("open", [url], { stdio: "ignore" });
  console.log(`Semaphore is open at ${url}`);
}

function liveSpeakers(room) {
  return new Set(
    ["astra", "claude"].filter(
      (speaker) =>
        (room?.participants[speaker].transport ?? "headless") !== "headless",
    ),
  );
}

function transportsFor(room, caller) {
  const formatEnvelope = (context) =>
    liveEnvelope(context, { root });
  const headless = { astra: new CodexAdapter(), claude: new ClaudeAdapter() };
  return Object.fromEntries(
    ["astra", "claude"].map((speaker) => {
      const kind = room?.participants[speaker].transport ?? "headless";
      if (kind === "headless") return [speaker, headless[speaker]];
      // A turn for the chat running this command is handed over here, not queued back into itself.
      if (speaker === caller)
        return [speaker, new DirectTransport({ kind, formatEnvelope })];
      return [speaker, liveTransport(kind, { formatEnvelope })];
    }),
  );
}

function native(room, store) {
  const { astra, claude } = room.participants;
  console.log(
    `\nCodex: ${astra.id ? `codex://threads/${astra.id}` : "starts on Astra’s first turn"}${["astra-inbox", "codex-queue"].includes(astra.transport) ? " (live chat)" : ""}`,
  );
  if (claude.transport === "claude-inbox") {
    console.log(
      `Claude: live desktop chat ${claude.id}. Open it in the Claude app; never resume it from a terminal.\n`,
    );
    return;
  }
  console.log(
    `Claude Code: ${claude.started ? `cd ${quote(store.workspace)} && claude --resume ${quote(claude.id)} --model ${quote(claude.actualModel ?? claude.model)}` : "starts on Claude’s first turn"}`,
  );
  console.log(
    "Pause/close Semaphore before writing in a native conversation. Native edits are not imported into the shared transcript yet.\n",
  );
}

function status(room, store) {
  console.log(`CLI runtime: ${formatRuntime()}`);
  console.log(
    `Room ${room.name} “${room.title || room.name}” · stick: ${room.owner} · model turns ${room.autoTurns ?? 0}${room.maxTurns === null ? " (no limit)" : `/${room.maxTurns ?? 4}`}`,
  );
  for (const speaker of ["astra", "claude"]) {
    const participant = room.participants[speaker];
    const transport = participant.transport ?? "headless";
    const listening =
      INBOX_TRANSPORTS.includes(transport)
        ? listenerStatus(store.dir, speaker).active
          ? " · listening"
          : " · not listening"
        : "";
    console.log(
      `  ${speaker}: ${transport} ${participant.id ?? "(not started)"} · seen ${participant.seen}${listening}`,
    );
  }
  const pending = room.pending;
  if (pending) console.log(`Timing: ${JSON.stringify(timingView(room, store.dir))}`);
  if (pending)
    console.log(
      `Pending: turn ${pending.id} for ${pending.speaker} · ${pending.state ?? "uncertain"}${pending.receipt ? ` via ${pending.receipt.transport}` : ""}`,
    );
  const last = room.messages.at(-1);
  const note = statusNote(room);
  if (note) {
    const host = note.speaker === "astra" ? "ChatGPT" : "the Claude app";
    console.log(`Status note: ${names[note.speaker]} ${note.kind === "approval" ? `is waiting for your approval in ${host}` : "is working"} · ${note.updatedAt}\n  ${note.text}`);
  }
  if (last)
    console.log(
      `Last message: #${last.seq} ${last.speaker}${last.via ? ` via ${last.via}` : ""} → ${last.next}`,
    );
}

function display(
  { type, speaker, message, text, receipt },
  { live = new Set(), ownTurn } = {},
) {
  if (type === "thinking" && !live.has(speaker))
    console.log(`\n${names[speaker]} has the stick… (Ctrl+C to take it)`);
  if (type === "message" && !(ownTurn && message.turnId === ownTurn)) {
    console.log(
      `\n${names[message.speaker]}${message.via ? ` (via ${names[message.via]})` : ""} → ${recipients[message.next]}\n${message.text}\n`,
    );
  }
  if (type === "queued") {
    const idle =
      receipt.listener && !receipt.listener.active
        ? "; not listening yet, it will see this when it next listens"
        : "";
    console.log(
      `\nQueued for ${names[speaker]} (${receipt.detail ?? receipt.transport}${idle}). Waiting for its acknowledgment and reply.\n`,
    );
  }
  if (type === "notice") console.log(`\n${text}\n`);
}

async function refreshWakeSeat(app, speaker) {
  if (speaker !== "astra" || app.room.participants.astra.transport !== "astra-inbox") return;
  const seat = app.room.participants.astra;
  const paths = wakePaths();
  delete seat.wakeAutomatic;
  if (!readWakeSettings(paths.settings).enabled) { delete seat.wakeVerification; app.save(); return; }
  const client = new WakeClient({ socket: paths.socket });
  try {
    await client.initialize();
    seat.wakeVerification = await verifyNativeSeat({ client, threadId: seat.id, socket: paths.socket });
    seat.wakeAutomatic = true;
    if (app.room.pending?.receivedAt) await cancelQueuedWake(client, app.room);
    delete seat.wakeError;
  } catch (error) {
    delete seat.wakeVerification;
    seat.wakeError = error.message;
  } finally { client.close(); app.save(); }
}

function automaticallyWakes(participant) {
  const paths = wakePaths();
  return participant?.wakeAutomatic === true && readWakeSettings(paths.settings).enabled &&
    sameRuntime(participant.wakeVerification, { socket: paths.socket });
}

async function join(app) {
  const speaker = values.as;
  if (!["astra", "claude"].includes(speaker))
    throw new Error("Use join <room> --as astra or --as claude.");
  const binding = bindFromEnv(
    speaker,
    process.env,
    values.manual ? { transport: "codex-queue" } : {},
  );
  const participant = app.room.participants[speaker];
  console.log(`Join runtime: ${formatRuntime()}`);
  if (
    participant.transport === binding.transport &&
    participant.id === binding.id
  ) {
    console.log(`This chat is already ${speaker} in ${app.room.name}.`);
    participant.joinedRuntime ??= runtimeIdentity();
    app.save();
    await refreshWakeSeat(app, speaker);
    return;
  }
  // The same chat changing how it receives turns. Its identity is proven by its environment, so
  // no other chat is replaced; only its own seat, and only while it has no turn in progress.
  if (participant.id === binding.id) {
    if (app.room.pending?.speaker === speaker)
      throw new Error(
        `This chat has a turn in progress in ${app.room.name}. Answer it first, then join again to switch.`,
      );
    app.record("transport-changed", {
      speaker,
      id: binding.id,
      from: participant.transport,
      to: binding.transport,
    });
    participant.transport = binding.transport;
    if (app.room.statusNote?.speaker === speaker) delete app.room.statusNote;
    delete participant.wakeVerification;
    delete participant.wakeAutomatic;
    app.save();
    console.log(
      `This chat now receives ${app.room.name} turns through ${binding.transport}.`,
    );
    await refreshWakeSeat(app, speaker);
    return;
  }
  // Unused seats: a live placeholder or never-started headless astra (no id), or a never-started headless claude.
  const unused =
    !participant.id ||
    (participant.transport === "headless" && !participant.started);
  if (!unused && !values.rebind) {
    throw new Error(
      `${speaker} is already bound to ${participant.transport} ${participant.id}. Use --rebind to replace it.`,
    );
  }
  if (!unused && app.room.pending)
    throw new Error(
      "A turn is pending. Take the stick and recover before rebinding.",
    );
  app.record(unused ? "join" : "rebind", {
    speaker,
    ...binding,
    ...(!unused && {
      previous: { transport: participant.transport, id: participant.id },
    }),
  });
  // A newly bound chat has seen none of the room, so its first turn carries the whole transcript.
  for (const key of ["model", "actualModel", "started", "wakeVerification", "wakeAutomatic", "wakeError", "joinedRuntime", "lastReceivedRuntime"])
    delete participant[key];
  Object.assign(participant, { ...binding, seen: 0, joinedRuntime: runtimeIdentity() });
  if (app.room.statusNote?.speaker === speaker) delete app.room.statusNote;
  app.save();
  console.log(
    `Joined ${app.room.name} as ${speaker} (${binding.transport} ${binding.id}).`,
  );
  await refreshWakeSeat(app, speaker);
}

function listenCommand(speaker, room) {
  return roomCommands({ room: { name: room }, speaker, root }).listen;
}

function printTurnGuidance(room, speaker) {
  console.log(turnGuidance({ room, speaker, root, automatic: automaticallyWakes(room.participants[speaker]) }));
}

async function reply(app, caller) {
  if (!caller)
    throw new Error(
      `This chat is not bound to room ${app.room.name}. Run join from inside the Astra or Claude chat first.`,
    );
  if (!values.turn)
    throw new Error(
      "Use reply <room> --turn <id> --next human|astra|claude --file reply.md.",
    );
  if (!SPEAKERS.includes(values.next))
    throw new Error("--next must be human, astra, or claude.");
  await refreshWakeSeat(app, caller);
  const message = readMessage();
  try {
    const result = await app.accept({
      turnId: values.turn,
      speaker: caller,
      message,
      next: values.next,
    });
    if (result.status === "review-required") {
      console.log("Your reply was not accepted. New human input arrived; you still hold the stick. Read it, run the receive command below, then revise and submit your reply.");
      let draft = values.file && values.file !== "-" ? path.resolve(values.file) : null;
      if (!draft) {
        const directory = path.join(app.store.dir, "drafts", caller);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        draft = path.join(directory, `${app.room.pending.id}.md`);
        const temp = `${draft}.${process.pid}.tmp`;
        fs.writeFileSync(temp, message, { mode: 0o600 });
        fs.renameSync(temp, draft);
      }
      console.log(`Your draft is kept at ${draft}. Revise it after reading the new input, then retry:\nnode ${quote(path.join(projectDir, "cli.mjs"))} reply ${app.room.name}${rootFlag} --turn ${values.turn} --next ${values.next} --file ${quote(draft)}`);
      console.log(liveEnvelope({ room: app.room, participant: app.room.participants[caller],
        turn: { ...app.room.pending, through: result.revision, revision: result.revision, reviewRequired: true }, prompt: "" }, { root }));
      process.exitCode = 3;
      return;
    }
    console.log(
      result.duplicate
        ? `Already accepted as message ${result.message.seq}; nothing was sent again.`
        : `Accepted as message ${result.message.seq}. Stick: ${app.room.owner}.`,
    );
    handOff(app.room, caller);
  } catch (error) {
    if (!error.accepted) throw error;
    console.error(
      `Semaphore: your reply was saved as message ${error.accepted.seq}, but delivery to the next speaker stopped: ${error.message}`,
    );
    handOff(app.room, caller);
    process.exitCode = 2;
  }
}

// A queued delivery is not an interruption. Yield promptly after handing off.
function handOff(room, caller) {
  if (room.owner === caller) return;
  console.log(
    `You no longer hold the stick.\n${turnGuidance({ room, speaker: caller, root, afterReply: true, automatic: automaticallyWakes(room.participants[caller]) })}`,
  );
}

// Lets a chat whose task resumed on its own check whose turn it is before doing anything.
function stick(room) {
  const caller = callerIn(room);
  const mine = caller
    ? room.owner === caller
    : !nativeChat() && room.owner === "human";
  if (mine) {
    if (caller) printTurnGuidance(room, caller);
    else console.log(`You hold the stick in ${room.name}.`);
    return;
  }
  printTurnGuidance(room, caller);
  process.exitCode = 3;
}

async function listenForTurn(room, store) {
  const caller = callerIn(room);
  const speaker = values.as ?? caller ?? "claude";
  if (caller !== speaker)
    throw new Error(
      `Run listen from inside the ${speaker} chat bound to room ${room.name}.`,
    );
  const transport = room.participants[speaker].transport;
  if (room.owner === speaker && room.pending?.speaker === speaker && room.pending.receivedAt) {
    printTurnGuidance(room, speaker);
    return;
  }
  if (speaker === "astra" && transport === "astra-inbox" && readWakeSettings().enabled &&
      !automaticallyWakes(room.participants.astra)) {
    await store.acquire({ waitMs: 5000 });
    try {
      room = store.read();
      if (callerIn(room) !== speaker) throw new Error("This chat’s room binding changed.");
      await refreshWakeSeat({ room, save: () => store.save(room) }, speaker);
    } finally { store.release(); }
  }
  if (automaticallyWakes(room.participants[speaker]) && room.owner !== speaker) {
    console.log("Automatic wake is verified. End your native turn now; no listener is needed.");
    return;
  }
  if (!INBOX_TRANSPORTS.includes(transport))
    throw new Error(
      `${speaker} receives turns through ${transport}, not an inbox. Join again without --manual to switch.`,
    );
  // Keep a single listener attached until a turn, native input, disconnect or
  // cancellation. An explicit timeout remains available for tests/manual waits.
  const seconds = values.timeout === undefined ? 0 : Number(values.timeout);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600)
    throw new Error("--timeout must be between 0 and 3600 seconds.");
  // A turn stays in the inbox until this chat acknowledges it with receive. Only the session that
  // started listening may judge its mail; after a rebind, mail belongs to the new chat.
  const session = room.participants[speaker].id;
  const stillMine = (current) =>
    current.participants[speaker]?.id === session &&
    current.participants[speaker]?.transport === transport;
  const isOpen = (item) => {
    let current;
    try {
      current = store.read();
    } catch {
      return null;
    }
    if (!stillMine(current) || item.session !== session) return null;
    const pending = current.pending;
    return (
      !!pending &&
      pending.id === item.turn?.id &&
      pending.speaker === speaker &&
      current.owner === speaker &&
      ["delivering", "awaiting-reply"].includes(pending.state) &&
      !pending.receivedAt
    );
  };
  // Astra steps aside when its own chat's queue changes, usually because the human typed there.
  const threadId = speaker === "astra" ? room.participants.astra.id : null;
  const baseline = threadId ? codexQueueRevision({ threadId }) : null;
  let nudged = false;
  let disconnected = false;
  const stopWhen = () => {
    try {
      disconnected = !stillMine(store.read());
    } catch {}
    if (disconnected) return true;
    if (baseline === null) return false;
    const revision = codexQueueRevision({ threadId });
    nudged = revision !== null && revision !== baseline;
    return nudged;
  };
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Stopped listening."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const items = await listen({
      roomDir: store.dir,
      speaker,
      signal: controller.signal,
      timeoutMs: seconds ? seconds * 1000 : undefined,
      isOpen,
      stopWhen,
      onObserved: item => { if (isOpen(item)) recordListenerObservation(store.dir, item); },
    });
    for (const item of items) console.log(`Listener runtime: ${formatRuntime()}${item.runtime ? '' : '\nThe saved envelope was produced by an unstamped release.'}\n${item.prompt}\n`);
    if (items.length) return;
    const again = listenCommand(speaker, room.name);
    if (disconnected) {
      console.log(
        `This chat is no longer ${speaker} in ${room.name}: its seat now belongs to another chat or delivery route. Stopped listening without taking any messages.`,
      );
      return;
    }
    console.log(
      nudged
        ? `Something new is waiting in your chat, possibly from the human. Stop listening and end your turn so it can reach you, then listen again afterwards: ${again}`
        : `No new turn in ${seconds} seconds. You are still connected; to keep waiting, run: ${again}`,
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function main() {
  if (values.help || command === "help") {
    console.log(help);
    return;
  }
  const commands = [
    "chat",
    "send",
    "show",
    "status",
    "native",
    "inspect",
    "recover",
    "unlock",
    "pass",
    "take",
    "join",
    "reply",
    "listen",
    "stick",
    "receive",
    "note",
    "artifact",
    "title",
    "timings",
    "new",
    "loop-in",
    "rooms",
    "invite",
    "doctor",
    "install",
    "uninstall",
    "open",
    "wake",
    "version",
  ];
  if (!commands.includes(command)) throw new Error(help);
  if (command === "version") return console.log(JSON.stringify(RUNTIME, null, 2));
  // Read-only: instant wake is turned on and off from the Semaphore app, by the person.
  if (command === "wake") {
    const { wakeStatus } = await import("./lib/wake.mjs");
    console.log(JSON.stringify(wakeStatus(), null, 2));
    return;
  }
  if (command === "doctor") return doctor();
  if (command === "install") return installCommand();
  if (command === "uninstall") return uninstallCommand();
  if (command === "open") return openApp();
  if (command === "rooms") return listRooms();
  if (command === "new") return newRoom();
  if (command === "loop-in") return loopIn();
  const store = new RoomStore(root, name);
  if (command === "timings") return console.log(JSON.stringify(timingReport(store.read(), store.dir), null, 2));
  if (command === "artifact" && words[0] === "list") {
    console.log(JSON.stringify({ artifacts: artifactViews(store.read()) }, null, 2));
    return;
  }
  if (command === "unlock") {
    store.unlock();
    console.log("No stale lock remains.");
    return;
  }
  if (
    [
      "show",
      "status",
      "native",
      "inspect",
      "listen",
      "invite",
      "stick",
    ].includes(command)
  ) {
    const room = store.read();
    if (command === "stick") return stick(room);
    if (command === "invite") return invite(room);
    if (command === "native") return native(room, store);
    if (command === "status") return status(room, store);
    if (command === "listen") return listenForTurn(room, store);
    if (command === "show") {
      room.messages.forEach((message) => display({ type: "message", message }));
      console.log(
        `Stick: ${room.owner}${room.pending ? ` (${room.pending.state === "awaiting-reply" ? `waiting for ${room.pending.speaker}` : "delivery needs review"})` : ""}`,
      );
      return;
    }
    if (!room.participants.astra.id)
      throw new Error("Astra has not spoken yet.");
    const client = new CodexClient({ cwd: store.workspace });
    try {
      await client.initialize();
      console.log(
        JSON.stringify(
          await client.request("thread/read", {
            threadId: room.participants.astra.id,
            includeTurns: true,
          }),
          null,
          2,
        ),
      );
    } finally {
      client.close();
    }
    return;
  }
  // Without --max-turns, each exchange uses the conversation's own reply limit.
  const maxTurns =
    values["max-turns"] === undefined ? undefined : Number(values["max-turns"]);
  if (
    maxTurns !== undefined &&
    (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20)
  )
    throw new Error("--max-turns must be between 1 and 20.");
  await store.acquire({ waitMs: 15_000 });
  let semaphore;
  let rl;
  const interrupt = () => {
    if (semaphore?.running) semaphore.takeStick();
    else rl?.close();
  };
  process.on("SIGINT", interrupt);
  const terminate = () => {
    semaphore?.takeStick();
    rl?.close();
    process.exitCode = 130;
  };
  process.on("SIGTERM", terminate);
  try {
    const saved = fs.existsSync(store.file) ? store.read() : null;
    const caller = saved ? callerIn(saved) : null;
    const live = liveSpeakers(saved);
    semaphore = new Semaphore(store, transportsFor(saved, caller), (event) =>
      display(event, {
        live,
        ownTurn: command === "reply" ? values.turn : undefined,
      }),
    );
    if (command === "join") {
      await join(semaphore);
      // A new binding can complete setup. Refresh the adapters from that binding.
      semaphore.adapters = transportsFor(semaphore.room, callerIn(semaphore.room));
      const beforeTurn = semaphore.room.pending?.id;
      await semaphore.startOpening();
      // Direct delivery already printed a full envelope. Otherwise render the
      // current state only after opening dispatch decides who holds the stick.
      if (!(semaphore.room.pending?.id !== beforeTurn && semaphore.room.owner === values.as))
        printTurnGuidance(semaphore.room, values.as);
      return;
    }
    if (command === "receive") {
      if (!caller)
        throw new Error("Receive must run inside the chat bound to this room.");
      const participant = semaphore.room.participants[caller];
      const change = runtimeChange(participant);
      const producer = semaphore.room.pending?.runtime;
      const runtimeNotice = [change, producer && !sameBuild(producer)
        ? `This saved turn was produced by ${formatRuntime(producer)}. Its turn ID and receipt remain unchanged.` : ''].filter(Boolean).join('\n');
      const turn = semaphore.receive(values.turn, caller, values.revision === undefined ? undefined : Number(values.revision), {
        compact: values.compact && !values.show,
        seenThrough: values["seen-through"] === undefined ? undefined : Number(values["seen-through"]),
      });
      if (turn.reviewRequired) {
        console.log("Compact receipt was not accepted. Read the full turn below, then run its receive command. New input has not been marked read.");
        process.exitCode = 3;
      } else {
        acknowledgeDelivery({ roomDir: store.dir, speaker: caller, turnId: turn.id });
        participant.lastReceivedRuntime = runtimeIdentity();
        semaphore.save();
      }
      await refreshWakeSeat(semaphore, caller);
      console.log(
        liveEnvelope(
          {
            room: semaphore.room,
            participant: semaphore.room.participants[caller],
            turn,
            prompt: "",
          },
          { root, compact: turn.compact === true, runtimeNotice },
        ),
      );
      return;
    }
    if (command === "title") {
      if (nativeChat() && (!caller || (values.as && values.as !== caller)))
        throw new Error("Name the room from its bound native chat, or rename it in the Semaphore app.");
      const result = semaphore.setTitle(readMessage(), { speaker: caller ?? "human", turnId: values.turn });
      console.log(JSON.stringify(result));
      return;
    }
    if (command === "artifact") {
      if (!caller || (values.as && values.as !== caller))
        throw new Error("Artifact changes must run inside the chat bound to this room as their speaker.");
      if (values.ready && values.draft) throw new Error("Choose --ready or --draft, not both.");
      if (values.asset && values["no-assets"]) throw new Error("Choose --asset files or --no-assets, not both.");
      const common = { turnId: values.turn, speaker: caller, id: values.id };
      let result;
      if (words[0] === "add") result = semaphore.registerArtifact({ ...common,
        file: values.file, title: values.title, assets: values["no-assets"] ? [] : values.asset,
        ready: values.ready ? true : values.draft ? false : undefined, url: values.url, access: values.access });
      else if (words[0] === "review") result = semaphore.reviewArtifact({ ...common,
        revision: Number(values.revision), sha256: values.sha256, kind: values.kind, via: values.via });
      else throw new Error("Use artifact <room> list, add or review.");
      console.log(JSON.stringify({ ...result, artifact: artifactView(result.artifact) }, null, 2));
      return;
    }
    if (command === "note") {
      if (!caller || (values.as && values.as !== caller))
        throw new Error("Status notes must run inside the chat bound to this room as their speaker.");
      if (values.clear && (values.approval || values.file || words.length))
        throw new Error("Use --clear without text, --file or --approval.");
      const note = semaphore.note({ turnId: values.turn, speaker: caller,
        text: readMessage(), approval: values.approval, clear: values.clear });
      console.log(note ? `Status note saved (${note.kind}): ${note.text}` : "Status note cleared.");
      console.log("You still hold the stick. No reply was sent.");
      return;
    }
    if (command === "reply") return await reply(semaphore, caller);
    if (command === "take") {
      semaphore.takeStick();
      console.log(
        "You hold the stick. A pending native reply will be rejected; use recover to clear it.",
      );
      return;
    }
    if (command === "recover") {
      semaphore.recover();
      console.log("Acknowledged. You hold the stick; nothing was retried.");
      return;
    }
    if (["send", "pass"].includes(command) && !caller && nativeChat()) {
      throw new Error(
        `This chat is not part of room ${name}. Join it first, or speak from the Semaphore app.`,
      );
    }
    if (command === "send") {
      if (values.via && values.via !== caller)
        throw new Error(
          `--via ${values.via} works only from inside that bound chat.`,
        );
      // A bound chat relays the human's words with provenance; it cannot post as the human directly.
      await semaphore.send(readMessage(), values.to, {
        maxTurns,
        ...(caller && { via: caller }),
      });
      if (!live.size) native(semaphore.room, store);
      return;
    }
    if (command === "pass") {
      await semaphore.pass(values.to, { maxTurns });
      return;
    }
    if (live.size)
      throw new Error(
        "This room has live chats. Use send, status, take and native instead of the interactive chat.",
      );
    if (!process.stdin.isTTY)
      throw new Error(
        "Interactive chat needs a terminal. Use send --file for scripts.",
      );
    console.log(`\nSemaphore · ${name}\n${help}`);
    semaphore.room.messages
      .slice(-6)
      .forEach((message) => display({ type: "message", message }));
    if (semaphore.room.pending)
      console.log(
        "A previous delivery needs review. Use /native, inspect the conversation, then /recover.",
      );
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", interrupt);
    let next = values.to;
    console.log(
      `You hold the stick. Message ${next}, or /to astra|claude <message>:`,
    );
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit") break;
      try {
        if (text === "/native") native(semaphore.room, store);
        else if (text === "/recover") {
          semaphore.recover();
          console.log("Acknowledged. You hold the stick.");
        } else if (text.startsWith("/pass "))
          await semaphore.pass(text.slice(6).trim(), { maxTurns });
        else if (text.startsWith("/to ")) {
          const match = text.match(/^\/to (astra|claude)\s+([\s\S]+)$/);
          if (!match)
            throw new Error("Use /to astra <message> or /to claude <message>.");
          next = match[1];
          await semaphore.send(match[2], next, { maxTurns });
        } else if (text.startsWith("/")) console.log(help);
        else await semaphore.send(text, next, { maxTurns });
      } catch (error) {
        console.error(error.message);
      }
      console.log(
        `You hold the stick. Message ${next}, or /to astra|claude <message>:`,
      );
    }
  } finally {
    rl?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    store.release();
  }
}

main().catch((error) => {
  console.error(`Semaphore: ${error.message}`);
  process.exitCode = 1;
});
