// Serves this checkout's web app against a throwaway room root with fake transports,
// so UI states can be checked in a browser without touching live rooms or native chats.
// Usage: node dev/ui-harness.mjs [port]   (default 4321)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../server.mjs";
import { RoomStore } from "../lib/core.mjs";
import { createLiveRoom } from "../lib/rooms.mjs";
import { registerSession } from "../lib/claude-registry.mjs";
import { dataHome } from "../lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// --attention registers a fake Claude hook only in an explicitly isolated data home.
const attentionPreview = process.argv.includes("--attention");
if (attentionPreview && (!process.env.SEMAPHORE_HOME || dataHome === path.join(os.homedir(), ".semaphore")))
  throw new Error("Use a fresh temporary SEMAPHORE_HOME for --attention.");
const root = attentionPreview ? path.join(dataHome, "rooms") : path.join(here, "..", ".semaphore", "dev-rooms");
const port = Number(process.argv[2] ?? 4321);
fs.rmSync(root, { recursive: true, force: true });

const fake = (kind) => ({
  kind,
  async deliver(context) {
    return {
      status: "queued",
      transport: kind,
      turnId: context.turn.id,
      at: new Date().toISOString(),
    };
  },
});
// A pretend instant wake: it only changes state in memory, never this Mac's settings.
const wake = (() => {
  let enabled = false;
  let chatgpt = "private";
  const status = () => ({
    supported: true,
    enabled,
    state: enabled
      ? chatgpt === "shared" ? "on" : "restart-chatgpt"
      : chatgpt === "shared" ? "turning-off" : "off",
    detail: enabled
      ? chatgpt === "shared"
        ? "ChatGPT is using the shared engine. Astra's chat can rest between turns."
        : "Restart ChatGPT so it uses the shared engine."
      : chatgpt === "shared"
        ? "Restart ChatGPT to put Codex back on its own engine."
        : "Astra waits for its turn inside its ChatGPT chat.",
  });
  return {
    status,
    enable: () => ((enabled = true), status()),
    disable: () => ((enabled = false), status()),
    restart: async () => ((chatgpt = enabled ? "shared" : "private"), status()),
  };
})();
const app = createAppServer({
  root,
  transports: { astra: fake("astra-inbox"), claude: fake("claude-inbox") },
  wake,
  wakePump: false,
  claudePump: attentionPreview ? { start() {}, close() {}, tick() {} } : false,
  // A pretend Claude app record, so the fake hooked Claude chat has an Open chat link.
  claudeDesktop: attentionPreview ? { url: (id) => (id === ids.claude ? "claude://code/continue?session=local_harness-preview" : null) } : false,
});
const url = (await app.listen(port)).replace(/\/$/, "");

function edit(name, change) {
  const store = new RoomStore(root, name);
  store.acquire();
  try {
    const room = store.read();
    change(room);
    store.save(room);
  } finally {
    store.release();
  }
}
const ids = {
  astra: "00000000-0000-4000-8000-000000000001",
  claude: "00000000-0000-4000-8000-000000000002",
};
function connect(name, speakers = ["astra", "claude"]) {
  edit(name, (room) => {
    for (const speaker of speakers) room.participants[speaker].id = ids[speaker];
  });
  for (const speaker of speakers) {
    const dir = path.join(root, name, "inbox", speaker);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "listener.pid"),
      JSON.stringify({ pid: process.pid }),
    );
  }
}
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
function say(name, lines) {
  edit(name, (room) => {
    for (const [speaker, next, text, minutes] of lines) {
      room.messages.push({
        seq: room.messages.length + 1,
        speaker,
        next,
        text,
        at: ago(minutes),
      });
      room.owner = next;
    }
  });
}

const token = (await (await fetch(url)).text()).match(
  /name="semaphore-token" content="([a-f0-9]+)"/,
)[1];
async function send(name, text, to, route = "messages", extra = {}) {
  const response = await fetch(`${url}/api/rooms/${name}/${route}`, {
    method: "POST",
    headers: {
      "X-Semaphore-Token": token,
      Origin: url,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, to, clientId: `harness-${name}-${route}-${to}-${text.length}`, ...extra }),
  });
  if (!response.ok) throw new Error(`send failed: ${await response.text()}`);
}

const fresh = createLiveRoom(root, "Fresh idea").room.name;

const queued = createLiveRoom(root, "Onboarding copy").room.name;
connect(queued);
await send(queued, "Can you tighten the welcome screen copy? Keep it warm.", "claude");

const received = createLiveRoom(root, "Retry logic review").room.name;
connect(received);
say(received, [
  ["human", "claude", "I think retries can double-send after a crash. Can you two check?", 42],
  [
    "claude",
    "astra",
    "I traced it to `commitReply`. The cursor and the reply are saved together, so a crash between them can't double-send.\n\nAstra, can you confirm the lock covers the recovery path too?",
    38,
  ],
]);
edit(received, (room) => {
  room.owner = "human";
});
await send(received, "Also check the listener restart path, please.", "astra");
edit(received, (room) => {
  room.pending.receivedAt = new Date().toISOString();
});

const pricing = createLiveRoom(root, "Pricing page redesign").room.name;
connect(pricing);
say(pricing, [
  ["human", "claude", "Plan the pricing page with me. Claude on layout, Astra on the numbers.", 30],
  [
    "claude",
    "astra",
    "First layout draft:\n\n- **Starter**: one room, both AIs\n- **Team**: shared rooms and history\n- **Studio**: everything, plus priority support\n\nThe annual toggle sits above the cards, and the comparison table folds under each card. Astra, can you check the plan limits against the backend?",
    24,
  ],
  [
    "astra",
    "human",
    "The limits hold. Rooms are cheap on disk, so Starter could allow three instead of one. I'd keep history unlimited on every tier.",
    20,
  ],
]);

// Two requests waiting on the person in the Needs you tray, one of them blocking.
edit(pricing, (room) => {
  room.asks = [
    { id: "00000000-0000-4000-8000-0000000000a1", requestId: "harness-ask-1", from: "astra", turnId: "harness", kind: "decision",
      title: "Should the Starter plan include three rooms instead of one?",
      detail: "Rooms are cheap on disk, and one room makes Starter hard to try with a real project.\n\n**Recommendation:** three rooms. The pricing table copy depends on this.",
      options: ["One room", "Three rooms"], blocking: true, status: "open", createdAt: ago(19) },
    { id: "00000000-0000-4000-8000-0000000000a2", requestId: "harness-ask-2", from: "claude", turnId: "harness", kind: "review",
      title: "Review the layout draft before I build the comparison table?", options: [], blocking: false, status: "open", createdAt: ago(23) },
  ];
});

await send(received, "One more thing: keep the fix small enough to review today.", "claude");

const launch = createLiveRoom(root, "Launch checklist").room.name;
await send(
  launch,
  "Help me write the launch checklist for Semaphore. Claude on the announcement, Astra on the rollback plan.",
  "claude",
  "opening",
  { members: ["astra", "claude"] },
);
connect(launch, ["claude"]);

if (attentionPreview) {
  registerSession({ session_id: ids.claude, hook_event_name: "SessionStart" });
  for (const speaker of ["claude", "astra"]) {
    const name = createLiveRoom(root, `${speaker === "claude" ? "Claude" : "GPT"} went quiet`).room.name;
    connect(name);
    await send(name, "Please review the companion layout.", speaker);
    edit(name, room => {
      room.pending.receivedAt = ago(8);
      room.statusNote = { turnId: room.pending.id, speaker, kind: "working",
        text: "Checking the companion layout", updatedAt: ago(7), expiresAt: ago(-23) };
    });
    console.log(`Attention preview: ${url}/?view=companion#${name}`);
  }
  // A turn the hooked Claude chat was signaled for three minutes ago and never started.
  const stuck = createLiveRoom(root, "Claude didn't start").room.name;
  connect(stuck);
  await send(stuck, "Please tighten the onboarding copy.", "claude");
  edit(stuck, (room) => {
    room.pending.at = ago(3);
    if (room.pending.receipt) room.pending.receipt.at = ago(3);
  });
  console.log(`Stuck Claude preview: ${url}/?view=companion#${stuck}`);
}

console.log(`UI harness ready at ${url} (rooms in ${root})`);
console.log(
  `Rooms: pricing ${pricing}, received ${received}, queued ${queued}, fresh ${fresh}, launch ${launch}`,
);
