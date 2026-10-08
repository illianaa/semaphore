#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RoomStore, Semaphore } from "./lib/core.mjs";
import { liveTransport, liveEnvelope, listenerStatus, deliveryProgress, LIVE_TRANSPORTS, INBOX_TRANSPORTS } from "./lib/live.mjs";
import { projectDir, defaultRoomRoot } from "./lib/paths.mjs";
import { buildInvite } from "./lib/invite.mjs";
import { createLiveRoom, createStartedRoom } from "./lib/rooms.mjs";
import { readPreferences, writePreferences, validLimit } from "./lib/preferences.mjs";
import { askViews } from "./lib/asks.mjs";
import { queueHumanInput, queuedInputs, inputMessages, replyNextAfter } from "./lib/inputs.mjs";
import { wakeStatus, enableWake, disableWake, restartChatGPT } from "./lib/wake.mjs";
import { WakePump } from "./lib/wake-delivery.mjs";
import { diagnose } from "./lib/doctor.mjs";
import { RUNTIME } from './lib/build-info.mjs';
import { statusNote } from './lib/status-note.mjs';
import { artifactView, artifactViews } from './lib/artifacts.mjs';
import { createPreviewServer, previewAvailability } from './lib/preview.mjs';
import { titleText } from './lib/titles.mjs';
import { timingView, timingReport } from './lib/timing.mjs';
import { ClaudeSignalPump, requestClaudeWake } from './lib/claude-wake.mjs';
import { ClaudeDesktopSessions, claudeRecoveryPrompt } from './lib/claude-desktop.mjs';
import { isRegistered, readRecord } from './lib/claude-registry.mjs';
import { AttentionTracker } from './lib/attention.mjs';

const SPEAKERS = ["astra", "claude"];
const MAX_BODY = 80_000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });

export function createAppServer({
  root = defaultRoomRoot,
  workspace,
  transports,
  inviteBuilder = buildInvite,
  diagnosticsProvider,
  wakePump,
  claudePump,
  claudeDesktop,
  attentionTracker,
  wake = {
    status: wakeStatus,
    enable: enableWake,
    disable: disableWake,
    restart: restartChatGPT,
  },
} = {}) {
  root = path.resolve(root);
  const token = randomBytes(32).toString("hex");
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
    ["/start-request.mjs", ["start-request.mjs", "text/javascript; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/render.mjs", ["render.mjs", "text/javascript; charset=utf-8"]],
    ["/attention.mjs", ["attention.mjs", "text/javascript; charset=utf-8"]],
    ["/requests.mjs", ["requests.mjs", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/icon.svg", ["icon.svg", "image/svg+xml"]],
    // Fonts are bundled under the SIL Open Font License (web/fonts/*-OFL.txt), never fetched.
    ["/fonts/jersey-10.ttf", ["fonts/Jersey10-Regular.ttf", "font/ttf"]],
    ["/fonts/outfit.ttf", ["fonts/Outfit-Variable.ttf", "font/ttf"]],
  ]);
  const active = new Map();
  const artifactCache = new Map();
  const previews = createPreviewServer();
  const flushing = new Set();
  const flushTimers = new Set();
  let closing = false;
  let port;
  diagnosticsProvider ??= () => diagnose({ port, root });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const pump = wakePump === false ? null : wakePump ?? new WakePump({ root });
  // Wakes registered Claude chats through their Claude Code hook (lib/claude-wake.mjs).
  const claudeSignals = claudePump === false ? null : claudePump ?? new ClaudeSignalPump({ root });
  const attention = attentionTracker ?? new AttentionTracker();
  // Links that open a bound Claude chat in the Claude desktop app (lib/claude-desktop.mjs).
  const claudeChats = claudeDesktop === false ? null : claudeDesktop ?? new ClaudeDesktopSessions();

  function readRoom(name) {
    let store;
    try {
      store = new RoomStore(root, name);
    } catch {
      throw error(400, "Invalid room name.");
    }
    try {
      return { store, room: store.read() };
    } catch (err) {
      if (err.code === "ENOENT") throw error(404, "Conversation not found.");
      throw err;
    }
  }

  function view(room, store, { summary = false } = {}) {
    // Queued human input is already durable even while a foreign CLI owns the
    // room lock. Display it immediately and deduplicate against the main journal.
    const queued = inputMessages(room, queuedInputs(store.dir));
    room = { ...room, messages: [...room.messages, ...queued],
      ...(queued.length ? { replyNext: replyNextAfter(queued.at(-1)) } : {}) };
    const connections = Object.fromEntries(
      SPEAKERS.map((speaker) => {
        const p = room.participants[speaker];
        const live = LIVE_TRANSPORTS.includes(p?.transport);
        const claudeURL = speaker === "claude" && p?.transport === "claude-inbox" && p.id
          ? claudeChats?.url(p.id) : null;
        return [
          speaker,
          {
            connected: !!(live && p.id),
            manual: p?.transport === "codex-queue",
            transport: p?.transport,
            ...(speaker === "astra" ? { wake: pump?.mode(p, store.dir, room), steering: pump?.canSteer?.(room, store.dir) === true,
              nativeIdleSince: pump?.nativeIdleSince?.(room) ?? null } : {}),
            // A Claude chat whose hook registered it is woken by Semaphore; it needs no listener.
            ...(speaker === "claude" && p?.transport === "claude-inbox" && claudeSignals && isRegistered(p.id)
              ? { wake: "automatic", startedAt: readRecord(p.id)?.startedAt ?? null,
                activityAt: readRecord(p.id)?.activityAt ?? null } : {}),
            ...(INBOX_TRANSPORTS.includes(p?.transport) && p.id
              ? { listening: listenerStatus(store.dir, speaker).active }
              : {}),
            ...(speaker === "astra" &&
            live &&
            /^[a-f0-9-]{36}$/i.test(p.id ?? "")
              ? { url: `codex://threads/${p.id}` }
              : {}),
            ...(claudeURL
              ? { url: claudeURL, recoveryPrompt: claudeRecoveryPrompt({ room, root }) }
              : {}),
          },
        ];
      }),
    );
    const last = room.messages.at(-1);
    const artifacts = artifactViews(summary ? { artifacts: room.artifacts?.filter(item => item.ready) } : room, { cache: artifactCache });
    const result = {
      name: room.name,
      title: room.title || room.name,
      titleSource: room.titleSource ?? "existing",
      createdAt: room.createdAt,
      owner: room.owner,
      ended: room.ended ?? null,
      canInterject: !room.ended && (!!room.pending || room.opening?.state === "waiting"),
      opening: room.opening ?? null,
      members: room.members ?? SPEAKERS,
      replyNext: room.replyNext ?? null,
      pending: room.pending
        ? {
            id: room.pending.id,
            speaker: room.pending.speaker,
            state: room.pending.state,
            at: room.pending.at,
            wake: room.pending.wake ?? null,
            wakeRequestedAt: room.pending.claudeHook?.wakeRequestedAt ?? null,
            // Evidence for "Claude stopped without replying": the Stop hook's reminder, the stop
            // after it, and the last status note's time (expired or not).
            claudeReminderAt: room.pending.claudeHook?.stopReminderAt ?? null,
            claudeStoppedAt: room.pending.claudeHook?.stoppedAt ?? null,
            claudeClaimedAt: room.pending.claudeHook?.turnAt ?? null,
            claudeInputAt: room.pending.claudeHook?.inputAt ?? null,
            claudeCheckInAt: room.pending.claudeHook?.checkInAt ?? null,
            nativeBound: !!room.pending.nativeWork?.turnId,
            noteAt: room.statusNote?.turnId === room.pending.id ? room.statusNote.updatedAt ?? null : null,
            timing: timingView(room, store.dir),
            // Preparing a revision or claiming a hook is not native delivery confirmation.
            deliveredThrough: room.pending.speaker === 'astra'
              ? room.pending.steering?.deliveredThrough ?? null
              : connections.claude.wake === 'automatic' || room.pending.claudeHook
                ? null : room.pending.reviewThrough ?? null,
            offeredThrough: room.pending.claudeHook?.inputThrough ?? null,
            ...(room.pending.state === "awaiting-reply"
              ? {
                  progress: deliveryProgress({
                    roomDir: store.dir,
                    participant: room.participants[room.pending.speaker],
                    turn: room.pending,
                  }),
                }
              : {}),
          }
        : null,
      statusNote: statusNote(room),
      // What the AIs need from the person, open until answered, dismissed or withdrawn.
      asks: askViews(room),
      deliverables: { total: room.artifacts?.length ?? 0, ready: artifacts.filter(item => item.ready).length },
      connections,
      lock: store.lockStatus(),
      autoTurns: room.autoTurns ?? 0,
      maxTurns: room.maxTurns === undefined ? 4 : room.maxTurns,
      turnLimit: room.turnLimit === undefined ? 4 : room.turnLimit,
      messageCount: room.messages.length,
      updatedAt: [room.events.at(-1)?.at, last?.at, room.createdAt].filter(Boolean).sort().at(-1),
      lastMessage: last
        ? { speaker: last.speaker, text: last.text.slice(0, 140), at: last.at }
        : null,
      ...(summary
        ? {}
        : {
            artifacts: artifacts.map(artifact => ({ ...artifact, preview: previewAvailability(artifact) })),
            messages: room.messages,
            events: room.events.slice(-15),
            legacy: Object.values(room.participants).some(
              (p) => (p.transport ?? "headless") === "headless",
            ),
          }),
    };
    // What the person must do so an AI can continue, if anything (lib/attention.mjs).
    const lastReplyAt = {};
    for (let i = room.messages.length - 1; i >= 0 && Object.keys(lastReplyAt).length < 2; i--) {
      const message = room.messages[i];
      if (message.speaker !== "human") lastReplyAt[message.speaker] ??= message.at;
    }
    result.attention = attention.check(room.name, result, { lastReplyAt });
    return result;
  }

  function listRooms() {
    const rooms = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name),
      )
      .flatMap((entry) => {
        try {
          const { room, store } = readRoom(entry.name);
          return [view(room, store, { summary: true })];
        } catch {
          return [];
        } // One damaged room must not hide the other conversations.
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    attention.prune(rooms.map((room) => room.name));
    return rooms;
  }

  async function mutate(name, action, { waitMs = 5000 } = {}) {
    const { store } = readRoom(name);
    await store.acquire({ waitMs });
    let app;
    try {
      const saved = store.read();
      const adapters =
        transports ??
        Object.fromEntries(
          SPEAKERS.filter((s) =>
            LIVE_TRANSPORTS.includes(
              saved.participants[s].transport,
            ),
          ).map((s) => [
            s,
            liveTransport(saved.participants[s].transport, {
              formatEnvelope: (context) => liveEnvelope(context, { root }),
            }),
          ]),
        );
      app = new Semaphore(store, adapters);
      active.set(name, app);
      await action(app);
      return view(app.room, store);
    } catch (err) {
      if (app) err.room = view(app.room, store);
      throw err;
    } finally {
      active.delete(name);
      store.release();
    }
  }

  function flushLater(name) {
    if (flushing.has(name) || closing) return;
    flushing.add(name);
    const timer = setTimeout(async () => {
      flushTimers.delete(timer);
      try {
        await mutate(name, () => {}, { waitMs: 0 }); // Constructor drains the input journal.
      } catch (err) {
        let stillActive = false;
        try { stillActive = readRoom(name).store.lockStatus().state === "active"; } catch {}
        if (err.code === "ROOM_LOCKED" && !closing && stillActive) {
          flushing.delete(name);
          flushLater(name);
          return;
        }
      }
      flushing.delete(name);
    }, 100);
    timer.unref();
    flushTimers.add(timer);
  }

  async function body(req) {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw error(415, "Send JSON.");
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY)
        throw error(
          413,
          "This message is too large. Keep it under 64,000 characters.",
        );
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString());
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw Error();
      return result;
    } catch {
      throw error(400, "Invalid JSON.");
    }
  }

  function assertSpeaker(speaker) {
    if (!SPEAKERS.includes(speaker))
      throw error(400, "Choose GPT or Claude.");
  }
  function assertLive(app, speaker) {
    const p = app.room.participants[speaker];
    if (!LIVE_TRANSPORTS.includes(p?.transport) || !p.id)
      throw error(
        409,
        `Connect ${speaker === "astra" ? "GPT" : "Claude"} before sending a message.`,
      );
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    try {
      const host = req.headers.host;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
        throw error(403, "Unrecognized local host.");
      const origin = `http://${host}`;
      if (
        (req.method !== "GET" && req.headers.origin !== origin) ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        throw error(403, "Cross-origin requests are not allowed.");
      if (
        req.headers["sec-fetch-site"] === "cross-site" &&
        req.headers["sec-fetch-mode"] !== "navigate"
      )
        throw error(403, "Cross-site requests are not allowed.");
      const url = new URL(req.url, origin);
      if (req.method === "GET" && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        // Bytes, so the font stays intact; only the page is edited as text.
        let contents = fs.readFileSync(path.join(projectDir, "web", file));
        if (file === "index.html")
          contents = contents.toString("utf8").replace("__SEMAPHORE_TOKEN__", token);
        res.writeHead(200, { "Content-Type": type });
        res.end(contents);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health")
        return json(200, { ok: true, app: "semaphore", pid: process.pid, runtime: RUNTIME });
      const supplied = req.headers["x-semaphore-token"];
      if (
        typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        throw error(401, "Reload Semaphore to reconnect.");
      if (req.method === "GET" && url.pathname === "/api/session")
        return json(200, {
          version: RUNTIME.version,
          platform: process.platform,
          workspace: workspace ?? null,
          root,
        });
      if (req.method === "GET" && url.pathname === "/api/diagnostics")
        return json(200, await diagnosticsProvider());
      // Instant wake for Astra: off by default, turned on and off only from the app.
      if (url.pathname === "/api/wake" || url.pathname === "/api/wake/restart") {
        if (req.method === "GET" && url.pathname === "/api/wake")
          return json(200, { wake: await wake.status() });
        if (req.method !== "POST") throw error(405, "Method not allowed.");
        const input = await body(req);
        if (url.pathname === "/api/wake" && typeof input.enabled !== "boolean")
          throw error(400, "Say whether instant wake should be on or off.");
        if (url.pathname === "/api/wake/restart") {
          if (input.confirm !== true)
            throw error(400, "Confirm the ChatGPT restart first.");
          // Restarting stops any Codex task running in ChatGPT, so wait for Astra's turn to end.
          const busy = listRooms().find(
            (room) =>
              room.pending?.speaker === "astra" &&
              room.pending.progress === "received",
          );
          if (busy)
            throw error(
              409,
              `GPT is working in “${busy.title}”. Restart ChatGPT once GPT has passed the stick.`,
            );
        }
        try {
          const status =
            url.pathname === "/api/wake/restart"
              ? await wake.restart()
              : input.enabled
                ? await wake.enable()
                : await wake.disable();
          return json(200, { wake: status });
        } catch (err) {
          return json(err.status || 500, {
            error: err.message,
            wake: err.wake ?? (await wake.status()),
          });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/rooms")
        return json(200, { rooms: listRooms(), preferences: readPreferences(root) });
      // App-wide choices, such as the reply limit a new conversation starts with.
      if (url.pathname === "/api/preferences") {
        if (req.method === "GET") return json(200, { preferences: readPreferences(root) });
        if (req.method !== "POST") throw error(405, "Method not allowed.");
        const input = await body(req);
        if ("startLimit" in input && !validLimit(input.startLimit))
          throw error(400, "Choose a limit of 1 to 20 replies, or no limit.");
        return json(200, { preferences: writePreferences(root, input) });
      }
      if (req.method === "POST" && url.pathname === "/api/rooms") {
        const input = await body(req);
        try { titleText(input.title); } catch (err) { throw error(400, err.message); }
        const { room, store } = createLiveRoom(root, input.title);
        return json(201, { room: view(room, store) });
      }
      if (req.method === "POST" && url.pathname === "/api/rooms/start") {
        const input = await body(req);
        try {
          const { room, store, duplicate } = await createStartedRoom(root, input);
          return json(duplicate ? 200 : 201, { room: view(room, store), duplicate });
        } catch (err) { err.status ??= err.code === "ROOM_LOCKED" ? 423 : 409; throw err; }
      }
      // The person answers or dismisses an AI's request from the Needs you tray.
      const askMatch = /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/asks\/([a-f0-9-]{36})\/(answer|dismiss)$/.exec(url.pathname);
      if (askMatch) {
        if (req.method !== "POST") throw error(405, "Method not allowed.");
        const [, name, id, verb] = askMatch;
        const input = await body(req);
        const answer = (app) => verb === "answer"
          ? app.answerAsk(id, { option: input.option, text: input.text, clientId: input.clientId, revision: input.revision })
          : app.dismissAsk(id, { revision: input.revision });
        // A delivery running in this server holds the room; answer through it, like a message.
        const running = active.get(name);
        if (running) {
          try { await answer(running); } catch (err) { err.room = view(running.room, running.store); throw err; }
          return json(200, { room: view(running.room, running.store) });
        }
        return json(200, { room: await mutate(name, answer) });
      }
      const previewMatch = /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/artifacts\/([a-f0-9-]{36})\/preview$/.exec(url.pathname);
      if (previewMatch) {
        if (req.method !== "POST") throw error(405, "Method not allowed.");
        const input = await body(req);
        if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).length)
          throw error(400, "Preview selection comes from the registered artifact, not request paths.");
        const { room } = readRoom(previewMatch[1]);
        const artifact = room.artifacts?.find(item => item.id === previewMatch[2]);
        if (!artifact) throw error(404, "Artifact not found.");
        return json(200, await previews.issue(room.name, artifactView(artifact)));
      }
      const match =
        /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/(messages|opening|take|end|reopen|recover|pass|invite|unlock|limit|title|timings|wake)(?:\/(astra|claude))?)?$/.exec(
          url.pathname,
        );
      if (!match) throw error(404, "Not found.");
      const [, name, action, speaker] = match;
      if (req.method === "GET" && action === "timings") {
        const { room, store } = readRoom(name);
        return json(200, timingReport(room, store.dir));
      }
      if (req.method === "GET" && !action) {
        const { room, store } = readRoom(name);
        return json(200, { room: view(room, store) });
      }
      if (req.method === "GET" && action === "invite" && speaker) {
        const { room } = readRoom(name);
        return json(
          200,
          await inviteBuilder({ root, room, speaker, ...(workspace ? { workspace } : {}) }),
        );
      }
      if (
        req.method !== "POST" ||
        !["messages", "opening", "take", "end", "reopen", "recover", "pass", "unlock", "limit", "title", "wake"].includes(action)
      )
        throw error(405, "Method not allowed.");
      const input = await body(req);
      if (action === "title") {
        try { titleText(input?.title); } catch (err) { throw error(400, err.message); }
        if (active.get(name)) {
          const app = active.get(name);
          app.setTitle(input.title);
          return json(200, { room: view(app.room, app.store) });
        }
      }
      if (action === "unlock") {
        const { store } = readRoom(name);
        if (store.lockStatus().state !== "stale")
          throw error(
            409,
            "There is no stopped process to recover. An active process keeps its lock.",
          );
        store.unlock();
        return json(200, { room: await mutate(name, () => {}) });
      }
      if (["messages", "opening"].includes(action)) {
        assertSpeaker(input.to);
        if (
          typeof input.text !== "string" ||
          !input.text.trim() ||
          input.text.length > 64_000
        )
          throw error(400, "Enter a message of 1–64,000 characters.");
        if (
          typeof input.clientId !== "string" ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(input.clientId)
        )
          throw error(400, "A message request ID is required.");
      }
      if (action === "pass") assertSpeaker(input.to);
      // GPT's chat is reopened from its link; only a hooked Claude chat can be woken from here.
      if (action === "wake" && speaker !== "claude")
        throw error(400, "Only a Claude chat can be woken from Semaphore. Open GPT's chat to continue it.");
      if (
        action === "limit" &&
        input.maxTurns !== null &&
        !(Number.isInteger(input.maxTurns) && input.maxTurns >= 1 && input.maxTurns <= 20)
      )
        throw error(400, "Choose a limit of 1 to 20 replies, or no limit.");
      // A delivery running in this server holds the room; change its limit in place.
      if (action === "limit" && active.get(name)) {
        const app = active.get(name);
        app.setTurnLimit(input.maxTurns);
        return json(200, { room: view(app.room, app.store) });
      }
      if (action === "messages" && active.get(name)?.room.pending) {
        const app = active.get(name);
        try {
          await app.send(input.text, input.to, { clientId: input.clientId });
        } catch (err) {
          err.room = view(app.room, app.store);
          throw err;
        }
        return json(200, { room: view(app.room, app.store) });
      }
      // Abort an in-flight delivery in this server immediately, while its process
      // still owns the lock. The existing handler persists the uncertain outcome.
      if (["take", "end"].includes(action) && active.get(name)?.running) {
        const app = active.get(name);
        action === "end" ? app.end() : app.takeStick();
        return json(200, { room: view(app.room, app.store) });
      }
      const change = async (app) => {
        if (action === "messages") {
          if (!app.room.pending && app.room.opening?.state !== "waiting") assertLive(app, input.to);
          await app.send(input.text, input.to, { clientId: input.clientId });
        }
        if (action === "opening")
          await app.setOpening(input.text, input.to, { clientId: input.clientId, members: input.members });
        if (action === "pass") {
          assertLive(app, input.to);
          await app.pass(input.to);
        }
        if (action === "take") app.takeStick();
        if (action === "end") app.end();
        if (action === "reopen") app.reopen();
        if (action === "limit") app.setTurnLimit(input.maxTurns);
        if (action === "title") app.setTitle(input.title);
        if (action === "wake") {
          if (!claudeSignals) throw error(409, "Claude wake-ups are off in this app.");
          requestClaudeWake(app);
        }
        if (action === "recover") {
          if (input.acknowledged !== true)
            throw error(
              400,
              "Confirm that you checked the native chat before continuing.",
            );
          app.recover();
        }
      };
      let room;
      try {
        room = await mutate(name, change, { waitMs: action === "messages" ? 0 : 5000 });
        // Signal at once rather than on the pump's next tick.
        if (["wake", "end"].includes(action)) try { claudeSignals?.tick(); } catch {}
      } catch (err) {
        if (action !== "messages" || err.code !== "ROOM_LOCKED") throw err;
        const { room: saved, store } = readRoom(name);
        if (Object.values(saved.participants).some((p) => p.transport === "headless")) throw err;
        try { queueHumanInput(store, input); }
        catch (error) { error.status = 409; throw error; }
        flushLater(name);
        return json(202, { room: view(store.read(), store), saved: true });
      }
      return json(200, { room });
    } catch (err) {
      if (!res.headersSent)
        json(
          err.status ||
            (err.code === "ROOM_LOCKED" ? 423 : err.room ? 409 : 500),
          {
            error:
              err.status || err.room || err.code === "ROOM_LOCKED"
                ? err.message
                : "Semaphore could not complete that request. Reopen the conversation to check its saved state.",
            ...(err.room ? { room: err.room } : {}),
          },
        );
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server,
    root,
    async listen(requestedPort = 4317) {
      if (
        !Number.isInteger(requestedPort) ||
        requestedPort < 0 ||
        requestedPort > 65535
      )
        throw error(400, "Invalid port.");
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, "127.0.0.1", resolve);
      });
      port = server.address().port;
      pump?.start();
      claudeSignals?.start();
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      closing = true;
      pump?.close();
      claudeSignals?.close();
      await previews.close();
      for (const timer of flushTimers) clearTimeout(timer);
      for (const app of active.values()) if (app.running) app.takeStick();
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      port: { type: "string", default: "4317" },
    },
  });
  const app = createAppServer({
    ...(values.root ? { root: values.root } : {}),
  });
  try {
    const url = await app.listen(Number(values.port));
    console.log(`Semaphore is ready at ${url}`);
    console.log(`Conversations: ${app.root}`);
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, async () => {
        if (closing) return;
        closing = true;
        await app.close();
        process.exit(0);
      });
  } catch (err) {
    console.error(
      `Semaphore: ${err.code === "EADDRINUSE" ? "This port is already in use. Open the running app or choose another --port." : err.message}`,
    );
    process.exitCode = 1;
  }
}
