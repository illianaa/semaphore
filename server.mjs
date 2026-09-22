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
import { createLiveRoom } from "./lib/rooms.mjs";
import { diagnose } from "./lib/doctor.mjs";

const SPEAKERS = ["astra", "claude"];
const MAX_BODY = 80_000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });

export function createAppServer({
  root = defaultRoomRoot,
  workspace = projectDir,
  transports,
  inviteBuilder = buildInvite,
  diagnosticsProvider,
} = {}) {
  root = path.resolve(root);
  const token = randomBytes(32).toString("hex");
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/render.mjs", ["render.mjs", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/icon.svg", ["icon.svg", "image/svg+xml"]],
  ]);
  const active = new Map();
  let port;
  diagnosticsProvider ??= () => diagnose({ port, root });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

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
    const connections = Object.fromEntries(
      SPEAKERS.map((speaker) => {
        const p = room.participants[speaker];
        const live = LIVE_TRANSPORTS.includes(p?.transport);
        return [
          speaker,
          {
            connected: !!(live && p.id),
            manual: p?.transport === "codex-queue",
            transport: p?.transport,
            ...(INBOX_TRANSPORTS.includes(p?.transport) && p.id
              ? { listening: listenerStatus(store.dir, speaker).active }
              : {}),
            ...(speaker === "astra" &&
            live &&
            /^[a-f0-9-]{36}$/i.test(p.id ?? "")
              ? { url: `codex://threads/${p.id}` }
              : {}),
          },
        ];
      }),
    );
    const last = room.messages.at(-1);
    return {
      name: room.name,
      title: room.title || room.name,
      createdAt: room.createdAt,
      owner: room.owner,
      pending: room.pending
        ? {
            id: room.pending.id,
            speaker: room.pending.speaker,
            state: room.pending.state,
            at: room.pending.at,
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
      connections,
      lock: store.lockStatus(),
      autoTurns: room.autoTurns ?? 0,
      maxTurns: room.maxTurns ?? 4,
      messageCount: room.messages.length,
      updatedAt: room.events.at(-1)?.at || last?.at || room.createdAt,
      lastMessage: last
        ? { speaker: last.speaker, text: last.text.slice(0, 140), at: last.at }
        : null,
      ...(summary
        ? {}
        : {
            messages: room.messages,
            events: room.events.slice(-15),
            legacy: Object.values(room.participants).some(
              (p) => (p.transport ?? "headless") === "headless",
            ),
          }),
    };
  }

  function listRooms() {
    return fs
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
  }

  async function mutate(name, action) {
    const { store } = readRoom(name);
    await store.acquire({ waitMs: 5000 });
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
      throw error(400, "Choose Astra or Claude.");
  }
  function assertLive(app, speaker) {
    const p = app.room.participants[speaker];
    if (!LIVE_TRANSPORTS.includes(p?.transport) || !p.id)
      throw error(
        409,
        `Connect ${speaker === "astra" ? "Astra" : "Claude"} before sending a message.`,
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
        let contents = fs.readFileSync(
          path.join(projectDir, "web", file),
          "utf8",
        );
        if (file === "index.html")
          contents = contents.replace("__SEMAPHORE_TOKEN__", token);
        res.writeHead(200, { "Content-Type": type });
        res.end(contents);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health")
        return json(200, { ok: true, app: "semaphore", pid: process.pid });
      const supplied = req.headers["x-semaphore-token"];
      if (
        typeof supplied !== "string" ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        throw error(401, "Reload Semaphore to reconnect.");
      if (req.method === "GET" && url.pathname === "/api/session")
        return json(200, {
          version: "0.2.0",
          platform: process.platform,
          workspace,
          root,
        });
      if (req.method === "GET" && url.pathname === "/api/diagnostics")
        return json(200, await diagnosticsProvider());
      if (req.method === "GET" && url.pathname === "/api/rooms")
        return json(200, { rooms: listRooms() });
      if (req.method === "POST" && url.pathname === "/api/rooms") {
        const input = await body(req);
        if (
          typeof input.title !== "string" ||
          !input.title.trim() ||
          input.title.trim().length > 100
        )
          throw error(
            400,
            "Give the conversation a title of 1–100 characters.",
          );
        const { room, store } = createLiveRoom(root, input.title);
        return json(201, { room: view(room, store) });
      }
      const match =
        /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/(messages|take|recover|pass|invite|unlock)(?:\/(astra|claude))?)?$/.exec(
          url.pathname,
        );
      if (!match) throw error(404, "Not found.");
      const [, name, action, speaker] = match;
      if (req.method === "GET" && !action) {
        const { room, store } = readRoom(name);
        return json(200, { room: view(room, store) });
      }
      if (req.method === "GET" && action === "invite" && speaker) {
        const { room } = readRoom(name);
        return json(
          200,
          await inviteBuilder({ root, room, speaker, workspace }),
        );
      }
      if (
        req.method !== "POST" ||
        !["messages", "take", "recover", "pass", "unlock"].includes(action)
      )
        throw error(405, "Method not allowed.");
      const input = await body(req);
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
      if (action === "messages") {
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
      // Abort an in-flight delivery in this server immediately, while its process
      // still owns the lock. The existing handler persists the uncertain outcome.
      if (action === "take" && active.get(name)?.running) {
        const app = active.get(name);
        app.takeStick();
        return json(200, { room: view(app.room, app.store) });
      }
      const room = await mutate(name, async (app) => {
        if (action === "messages") {
          assertLive(app, input.to);
          await app.send(input.text, input.to, { clientId: input.clientId });
        }
        if (action === "pass") {
          assertLive(app, input.to);
          await app.pass(input.to);
        }
        if (action === "take") app.takeStick();
        if (action === "recover") {
          if (input.acknowledged !== true)
            throw error(
              400,
              "Confirm that you checked the native chat before continuing.",
            );
          app.recover();
        }
      });
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
      return `http://127.0.0.1:${port}`;
    },
    async close() {
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
