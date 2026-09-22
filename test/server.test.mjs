import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createAppServer } from "../server.mjs";
import { RoomStore } from "../lib/core.mjs";
import { LiveDeliveryError } from "../lib/live.mjs";

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-http-"));
  const calls = [];
  const fake = (kind) => ({
    kind,
    async deliver(context) {
      calls.push(context.turn);
      return {
        status: "queued",
        transport: kind,
        turnId: context.turn.id,
        at: new Date().toISOString(),
      };
    },
  });
  const app = createAppServer({
    root,
    transports: { astra: fake("astra-inbox"), claude: fake("claude-inbox") },
    ...options,
  });
  const url = await app.listen(0);
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await fetch(url);
  const html = await page.text();
  const token = html.match(/name="semaphore-token" content="([a-f0-9]+)"/)[1];
  const request = async (route, { method = "GET", body, headers } = {}) => {
    const response = await fetch(url + route, {
      method,
      headers: {
        "X-Semaphore-Token": token,
        Origin: url,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  };
  const create = async (title) =>
    (await request("/api/rooms", { method: "POST", body: { title } })).body
      .room;
  const bind = (name) => {
    const store = new RoomStore(root, name);
    store.acquire();
    try {
      const room = store.read();
      room.participants.astra.id = "00000000-0000-4000-8000-000000000001";
      room.participants.claude.id = "00000000-0000-4000-8000-000000000002";
      store.save(room);
    } finally {
      store.release();
    }
  };
  return { root, app, url, request, create, bind, calls, page, html };
}

test("web shell is available, uses restrictive headers, and never exposes raw room files", async (t) => {
  const f = await fixture(t);
  assert.equal(f.page.status, 200);
  assert.match(f.html, /Great minds/);
  assert.match(
    f.page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(f.page.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(f.url + "/app.js")).status, 200);
  assert.equal(
    (await fetch(f.url + "/.semaphore/rooms/hello/room.json")).status,
    401,
  );
  assert.equal((await f.request("/api/rooms/../private")).status, 404);
});

test("API refuses unauthenticated, cross-origin, DNS-rebinding, and non-JSON requests", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + "/api/rooms")).status, 401);
  assert.equal(
    (
      await f.request("/api/rooms", {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  const forgedHost = await new Promise((resolve, reject) => {
    http
      .get(
        f.url,
        { headers: { Host: `attacker.example:${new URL(f.url).port}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(forgedHost, 403);
  assert.equal(
    (
      await f.request("/api/rooms", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/rooms", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(
    (await f.request("/api/rooms", { method: "POST", body: "[" })).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/rooms", {
        headers: { "X-Semaphore-Token": "x".repeat(64) },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/rooms", {
        method: "POST",
        body: { title: "Blocked" },
        headers: { Origin: "" },
      })
    ).status,
    403,
  );
});

test("new rooms are live-only, private, persist titles, and offer portable invitations", async (t) => {
  const f = await fixture(t);
  const room = await f.create("A beautiful idea <script>");
  assert.equal(room.title, "A beautiful idea <script>");
  assert.equal(room.connections.astra.connected, false);
  assert.equal(room.connections.claude.connected, false);
  assert.equal(room.legacy, false);
  const list = await f.request("/api/rooms");
  assert.equal(list.body.rooms[0].name, room.name);
  assert.equal(
    fs.statSync(path.join(f.root, room.name, "room.json")).mode & 0o777,
    0o600,
  );
  const invite = await f.request(`/api/rooms/${room.name}/invite/claude`);
  assert.match(invite.body.prompt, /--root/);
  assert.ok(invite.body.prompt.includes(f.root));
  assert.equal(new URL(invite.body.url).protocol, "claude:");
  assert.equal(
    new URL(invite.body.url).searchParams.get("q"),
    invite.body.prompt,
  );
  const send = await f.request(`/api/rooms/${room.name}/messages`, {
    method: "POST",
    body: { text: "Hi", to: "astra", clientId: "human-request-one" },
  });
  assert.equal(send.status, 409);
  assert.equal(send.body.room.messages.length, 0);
  assert.equal(f.calls.length, 0);
});

test("a retried HTTP message is committed and delivered only once, including after reopen", async (t) => {
  const f = await fixture(t);
  const room = await f.create("Idempotence");
  f.bind(room.name);
  const route = `/api/rooms/${room.name}/messages`;
  const payload = {
    text: "One thought",
    to: "astra",
    clientId: "human-request-one",
  };
  const [first, second] = await Promise.all([
    f.request(route, { method: "POST", body: payload }),
    f.request(route, { method: "POST", body: payload }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.room.messages.length, 1);
  assert.equal(second.body.room.pending.state, "awaiting-reply");
  assert.equal(f.calls.length, 1);
  assert.equal(
    (
      await f.request(route, {
        method: "POST",
        body: { ...payload, text: "Conflicting thought" },
      })
    ).status,
    409,
  );
  assert.equal(f.calls.length, 1);
  const store = new RoomStore(f.root, room.name);
  assert.equal(store.read().messages[0].clientId, payload.clientId);
});

test("take and recover require explicit acknowledgment and never resend", async (t) => {
  const f = await fixture(t);
  const room = await f.create("Recovery");
  f.bind(room.name);
  const route = `/api/rooms/${room.name}`;
  await f.request(route + "/messages", {
    method: "POST",
    body: { text: "Hello", to: "claude", clientId: "human-request-one" },
  });
  const taken = await f.request(route + "/take", { method: "POST", body: {} });
  assert.equal(taken.body.room.owner, "human");
  assert.equal(taken.body.room.pending.state, "uncertain");
  assert.equal(
    (await f.request(route + "/recover", { method: "POST", body: {} })).status,
    400,
  );
  const recovered = await f.request(route + "/recover", {
    method: "POST",
    body: { acknowledged: true },
  });
  assert.equal(recovered.body.room.pending, null);
  assert.equal(f.calls.length, 1);
  assert.equal(recovered.body.room.messageCount, 1);
});

test("a delivery failure reports the saved user message; retry cannot send it twice", async (t) => {
  let deliveries = 0;
  const f = await fixture(t, {
    transports: {
      astra: {
        kind: "astra-inbox",
        async deliver() {
          deliveries++;
          throw new LiveDeliveryError("Delivery outcome is unknown.", {
            certain: false,
          });
        },
      },
    },
  });
  const room = await f.create("Uncertain");
  f.bind(room.name);
  const input = {
    text: "A durable thought",
    to: "astra",
    clientId: "human-request-one",
  };
  const route = `/api/rooms/${room.name}/messages`;
  const first = await f.request(route, { method: "POST", body: input });
  assert.equal(first.status, 409);
  assert.equal(first.body.room.messages[0].text, input.text);
  assert.equal(first.body.room.pending.state, "uncertain");
  assert.equal(
    (await f.request(route, { method: "POST", body: input })).status,
    200,
  );
  assert.equal(deliveries, 1);
});

test("take interrupts an active server delivery without waiting for its lock", async (t) => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const f = await fixture(t, {
    transports: {
      astra: {
        kind: "astra-inbox",
        async deliver({ signal }) {
          began();
          await new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
    },
  });
  const room = await f.create("Interrupt");
  f.bind(room.name);
  const route = `/api/rooms/${room.name}`;
  const sending = f.request(route + "/messages", {
    method: "POST",
    body: { text: "Please start", to: "astra", clientId: "human-request-one" },
  });
  await started;
  const taken = await f.request(route + "/take", { method: "POST", body: {} });
  assert.equal(taken.status, 200);
  assert.equal(taken.body.room.owner, "human");
  const stopped = await sending;
  assert.equal(stopped.status, 409);
  assert.equal(stopped.body.room.pending.state, "uncertain");
});

test("invalid input cannot create or mutate rooms", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/api/rooms", { method: "POST", body: { title: " " } }))
      .status,
    400,
  );
  const room = await f.create("Valid");
  f.bind(room.name);
  const route = `/api/rooms/${room.name}/messages`;
  for (const body of [
    { text: " ", to: "astra", clientId: "human-request-one" },
    { text: "Hello", to: "human", clientId: "human-request-one" },
    { text: "Hello", to: "astra" },
    { text: "x".repeat(64001), to: "astra", clientId: "human-request-one" },
  ])
    assert.equal(
      (await f.request(route, { method: "POST", body })).status,
      400,
    );
  assert.equal(
    (await f.request(`/api/rooms/${room.name}`)).body.room.messages.length,
    0,
  );
  assert.equal(f.calls.length, 0);
});

test("browser recovery releases only a dead process lock and never redelivers a crashed turn", async (t) => {
  const f = await fixture(t);
  const room = await f.create("Crashed process");
  f.bind(room.name);
  const store = new RoomStore(f.root, room.name);
  store.acquire();
  const saved = store.read();
  saved.owner = "astra";
  saved.pending = {
    id: "crashed-turn",
    speaker: "astra",
    through: 0,
    state: "delivering",
  };
  store.save(saved);
  store.release();
  const { spawnSync } = await import("node:child_process");
  const deadPid = Number(
    spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
      encoding: "utf8",
    }).stdout.trim(),
  );
  assert.ok(Number.isSafeInteger(deadPid) && deadPid > 0);
  fs.writeFileSync(store.lockFile, JSON.stringify({ pid: deadPid }));
  const route = `/api/rooms/${room.name}`;
  assert.equal((await f.request(route)).body.room.lock.state, "stale");
  const recovered = await f.request(route + "/unlock", {
    method: "POST",
    body: {},
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.room.pending.state, "uncertain");
  assert.equal(recovered.body.room.owner, "human");
  assert.equal(fs.existsSync(store.lockFile), false);
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid }));
  assert.equal(
    (await f.request(route + "/unlock", { method: "POST", body: {} })).status,
    409,
  );
  assert.equal(fs.existsSync(store.lockFile), true);
});
