import { labels, avatar, escape, formatMessage } from "./render.mjs";

const $ = (selector) => document.querySelector(selector);
const token = $("meta[name=semaphore-token]").content;
const state = {
  rooms: [],
  room: null,
  selected: null,
  recipient: "astra",
  signatures: {},
  invite: {},
  request: null,
};
const sending = new Set();

async function api(route, options = {}) {
  let response;
  try {
    response = await fetch(`/api${route}`, {
      ...options,
      headers: {
        "X-Semaphore-Token": token,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new Error(
      "Connection lost. Your draft is safe. Reconnect before trying again.",
    );
  }
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong.");
    error.room = result.room;
    error.status = response.status;
    throw error;
  }
  return result;
}

let toastTimer;

// Queue acceptance is distinct from acknowledgment by the bound native chat.
function pendingDetail(pending, room) {
  const who = labels[pending.speaker];
  if (pending.state === "delivering") return "delivering the message";
  if (pending.progress === "received")
    return `${who} has the message · waiting for a reply`;
  const seat = room.connections[pending.speaker];
  if (pending.progress === "queued")
    return seat?.manual
      ? `queued in ${who}’s ChatGPT chat · waiting for someone to press Send there`
      : seat?.listening === false
        ? `waiting in ${who}’s inbox until its chat listens again`
        : `queued for ${who} · awaiting acknowledgment`;
  return "waiting for a reply";
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 7000);
}
function showDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function formatTime(at) {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}
function relativeTime(at) {
  const elapsed = Math.max(0, Date.now() - Date.parse(at));
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function finishDraft(name, text, clientId) {
  const current =
    state.selected === name
      ? $("#message").value
      : storageGet(`semaphore:draft:${name}`);
  if (current === text) {
    storageSet(`semaphore:draft:${name}`, "");
    if (state.selected === name) $("#message").value = "";
  }
  storageSet(`semaphore:request:${name}`, "null");
  if (state.request?.clientId === clientId) state.request = null;
}

function renderSidebar() {
  const search = $("#search").value.toLocaleLowerCase();
  const rooms = state.rooms.filter((room) =>
    room.title.toLocaleLowerCase().includes(search),
  );
  $("#room-count").textContent = state.rooms.length;
  $("#room-list").innerHTML = rooms.length
    ? rooms
        .map(
          (room) =>
            `<button class="room-item ${state.selected === room.name ? "selected" : ""}" data-room="${escape(room.name)}" ${state.selected === room.name ? 'aria-current="page"' : ""}><span class="room-symbol" aria-hidden="true">▧</span><span class="room-copy"><strong>${escape(room.title)}</strong><small>${room.pending ? `${labels[room.pending.speaker]}’s turn` : room.messageCount ? `${room.messageCount} messages · ${relativeTime(room.updatedAt)}` : "Ready for a first thought"}</small></span>${room.pending ? '<span class="room-dot" aria-label="Reply pending"></span>' : ""}</button>`,
        )
        .join("")
    : `<p class="no-rooms">${search ? "No matching conversations." : "A good conversation starts with a thought. Make room for yours."}</p>`;
}

function renderRoom(room, force = false) {
  if (room.name !== state.selected) return;
  state.room = room;
  if (
    state.request &&
    room.messages.some((message) => message.clientId === state.request.clientId)
  ) {
    try {
      finishDraft(
        room.name,
        JSON.parse(state.request.fingerprint).text,
        state.request.clientId,
      );
    } catch {}
  }
  const signature = JSON.stringify(room);
  if (!force && signature === state.signatures[room.name]) {
    updateComposer();
    return;
  }
  state.signatures[room.name] = signature;
  $("#welcome").hidden = true;
  $("#conversation").hidden = false;
  $("#top-title").textContent = room.title;
  $("#conversation-title").textContent = room.title;
  document.title = `${room.title} · Semaphore`;
  $("#members").innerHTML = ["human", "astra", "claude"]
    .map(
      (speaker) =>
        `<span class="member ${room.owner === speaker ? "holder" : ""}">${avatar(speaker)}${labels[speaker]}${speaker !== "human" && !room.connections[speaker].connected ? "<small>not connected</small>" : ""}${room.owner === speaker ? '<span class="member-dot" aria-label="Holds the stick"></span>' : ""}</span>`,
    )
    .join("");
  const missing = ["astra", "claude"].filter(
    (speaker) => !room.connections[speaker].connected,
  );
  // Seats that receive turns through an inbox but have no listener running right now.
  const resting = ["claude", "astra"].filter(
    (speaker) =>
      room.connections[speaker].connected &&
      room.connections[speaker].listening === false &&
      !(room.pending?.speaker === speaker && room.pending.progress === "received"),
  );
  const needsListener = resting.length > 0;
  const guide = $("#connection-guide");
  guide.hidden = !missing.length && !needsListener && !room.legacy;
  if (!guide.hidden)
    guide.innerHTML = `<div><strong>${room.legacy ? "This is an earlier headless conversation" : missing.length ? `Make room for ${missing.map((s) => labels[s]).join(" and ")}` : `${resting.map((s) => labels[s]).join(" and ")} ${resting.length > 1 ? "aren’t" : "isn’t"} listening`}</strong><p>${room.legacy ? "Create a new conversation to connect your live desktop chats." : missing.length ? "Invite each model from its desktop chat. We’ll show you when they join." : `Open ${resting.map((s) => labels[s]).join(" and ")}’s chat and ask it to listen to this room again. Messages wait in its inbox until then.`}</p></div><button data-action="connect">${missing.length ? "Connect apps" : "View connection"} ↗</button>`;
  const pending = room.pending;
  const stale = room.lock?.state === "stale";
  const paused = pending?.state === "uncertain" || stale;
  const description = stale
    ? "A previous app process stopped. Your conversation is saved."
    : paused
      ? "Paused · a previous delivery needs your review"
      : pending
        ? `${labels[pending.speaker]} has the stick · ${pendingDetail(pending, room)}`
        : "You have the stick. Where shall we go next?";
  $("#state-banner").classList.toggle("paused", paused);
  $("#state-banner").innerHTML =
    `<span><i class="state-dot"></i>${escape(description)}</span><div class="state-actions">${stale ? '<button data-action="unlock">Recover stopped process</button>' : paused ? '<button data-action="recover">Review &amp; continue</button>' : pending ? '<button data-action="take">Take the stick</button>' : room.messages.length && !room.legacy ? '<button data-action="pass-astra">Ask Astra</button><button data-action="pass-claude">Ask Claude</button>' : ""}</div>`;
  const scroller = $("#message-scroll");
  const atBottom =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  const oldScroll = scroller.scrollTop;
  $("#messages").innerHTML = room.messages.length
    ? room.messages
        .map(
          (message) =>
            `<article class="message" id="message-${Number(message.seq)}">${avatar(message.speaker)}<div class="message-body"><div class="message-header"><strong>${labels[message.speaker] || "Unknown"}</strong><span class="to">→ ${labels[message.next] || "You"}</span><time datetime="${escape(message.at)}">${formatTime(message.at)}</time></div><div class="message-text">${formatMessage(message.text)}</div>${message.via ? `<div class="message-via">Shared from ${labels[message.via]}’s desktop chat</div>` : ""}</div></article>`,
        )
        .join("")
    : `<div class="empty-conversation"><div><div class="empty-mark">✳ &nbsp; ✺</div><h2>Something good starts here.</h2><p>${missing.length ? "Connect your desktop chats, then bring your first thought to the group." : "Share an idea, ask a question, or give us something to build. Pick who you’d like to hear from first."}</p></div></div>`;
  scroller.scrollTop = force || atBottom ? scroller.scrollHeight : oldScroll;
  updateComposer();
}

function updateComposer() {
  const room = state.room;
  const canSend =
    !!room &&
    !sending.has(room.name) &&
    !room.pending &&
    !room.legacy &&
    room.lock?.state !== "stale" &&
    room.connections[state.recipient].connected &&
    $("#message").value.trim().length > 0;
  $("#send").disabled = !canSend;
  $("#message").disabled = !!room?.legacy;
  $("#composer-hint").textContent = room?.pending
    ? "Your draft can wait here while the group is speaking."
    : !room?.connections[state.recipient].connected
      ? `Connect ${labels[state.recipient]} to send your first message.`
      : "One speaker at a time. You can take the stick whenever you like.";
  for (const button of document.querySelectorAll("[data-recipient]")) {
    const selected = button.dataset.recipient === state.recipient;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

async function refresh() {
  const selected = state.selected;
  try {
    const [list, detail] = await Promise.all([
      api("/rooms"),
      selected ? api(`/rooms/${selected}`) : null,
    ]);
    $("#offline").hidden = true;
    state.rooms = list.rooms;
    renderSidebar();
    if (detail && selected === state.selected) renderRoom(detail.room);
  } catch (err) {
    $("#offline").hidden = false;
    $("#offline").textContent =
      err.status === 401
        ? "Semaphore restarted. Reload this page to reconnect; your draft is saved."
        : "Connection lost. Your draft is safe. Reconnecting…";
  }
}

async function selectRoom(name) {
  if (state.selected)
    storageSet(`semaphore:draft:${state.selected}`, $("#message").value);
  state.selected = name;
  state.room = null;
  storageSet("semaphore:last-room", name);
  history.replaceState(null, "", `/#${encodeURIComponent(name)}`);
  $("#message").value = storageGet(`semaphore:draft:${name}`) || "";
  try {
    state.request = JSON.parse(storageGet(`semaphore:request:${name}`));
  } catch {
    state.request = null;
  }
  $("#sidebar").classList.remove("open");
  renderSidebar();
  try {
    const { room } = await api(`/rooms/${name}`);
    renderRoom(room, true);
  } catch (err) {
    toast(err.message);
  }
}

function newConversation(title = "") {
  $("#room-title").value = title;
  showDialog("#new-dialog");
  $("#room-title").focus();
}
async function connections() {
  if (!state.room) return;
  const name = state.room.name;
  $("#connect-title").textContent = "A seat for each mind.";
  $("#connect-body").textContent = "Preparing invitations…";
  showDialog("#connect-dialog");
  try {
    const invitations = await Promise.all(
      ["astra", "claude"].map((speaker) =>
        api(`/rooms/${name}/invite/${speaker}`),
      ),
    );
    if (name !== state.selected) return;
    state.invite = Object.fromEntries(
      invitations.map((invite) => [invite.speaker, invite]),
    );
    $("#connect-body").innerHTML = invitations
      .map((invite) => {
        const speaker = invite.speaker;
        const connected = state.room.connections[speaker].connected;
        const safeURL = /^(codex|claude):\/\//.test(invite.url)
          ? invite.url
          : "#";
        return `<section class="connect-card"><div class="connect-person">${avatar(speaker)}<div><strong>${labels[speaker]}</strong><small>${speaker === "astra" ? "Codex desktop" : "Claude desktop · Code chat"}</small></div>${connected ? '<span class="connected-badge">Connected</span>' : ""}</div><p>${connected ? (speaker === "claude" ? "Keep this chat open and listening. You can continue speaking to Claude in its app." : state.room.connections.astra.manual ? "Manual delivery: messages wait in Astra’s ChatGPT chat until you press Send there." : "While it holds no turn, Astra waits for this room inside its ChatGPT chat. Each wait that times out uses a little of your plan. If it stops listening, ask it there to listen to this room again.") : speaker === "claude" ? "Open Claude, confirm the project folder, then send the invitation. Or copy it into a Code chat you already have." : "Open a new chat with the invitation filled in, then send it. Or copy the invitation into a chat you already have."}</p><div class="connect-actions">${!connected ? `<a href="${escape(safeURL)}">${escape(invite.label || "Open app")} ↗</a>` : state.room.connections[speaker].url ? `<a href="${escape(state.room.connections[speaker].url)}">Open chat ↗</a>` : ""}<button data-copy-invite="${speaker}">${connected ? "Copy connection instructions" : "Copy invitation"}</button></div><details class="invite-details"><summary>View invitation</summary><pre class="invite-prompt">${escape(invite.prompt)}</pre></details></section>`;
      })
      .join("");
  } catch (err) {
    $("#connect-body").textContent = err.message;
  }
}

async function action(kind) {
  if (!state.room) return;
  const name = state.room.name;
  if (kind === "connect") return connections();
  if (kind === "recover") {
    $("#recover-check").checked = false;
    $("#recover-confirm").disabled = true;
    showDialog("#recover-dialog");
    return;
  }
  try {
    const route = kind.startsWith("pass-") ? "pass" : kind;
    const input =
      route === "pass"
        ? { to: kind.slice(5) }
        : route === "recover"
          ? { acknowledged: true }
          : {};
    const { room } = await api(`/rooms/${name}/${route}`, {
      method: "POST",
      body: input,
    });
    renderRoom(room);
    await refresh();
    if (route === "take")
      toast(
        "You have the stick. Check the desktop chat before clearing the pending turn.",
      );
  } catch (err) {
    if (err.room) renderRoom(err.room);
    toast(err.message);
  }
}

$("#new-room").addEventListener("click", () => newConversation());
$("#welcome-new").addEventListener("click", () => newConversation());
for (const button of document.querySelectorAll("[data-starter]"))
  button.addEventListener("click", () =>
    newConversation(button.dataset.starter),
  );
for (const button of document.querySelectorAll(".close-dialog"))
  button.addEventListener("click", () => button.closest("dialog").close());
$("#menu").addEventListener("click", () =>
  $("#sidebar").classList.toggle("open"),
);
$("#search").addEventListener("input", renderSidebar);
$("#room-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-room]");
  if (button) selectRoom(button.dataset.room);
});
$("#manage-connections").addEventListener("click", connections);
$("#connection-guide").addEventListener("click", (event) => {
  if (event.target.closest("button")) connections();
});
$("#state-banner").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) action(button.dataset.action);
});
for (const button of document.querySelectorAll("[data-recipient]"))
  button.addEventListener("click", () => {
    state.recipient = button.dataset.recipient;
    updateComposer();
  });
$("#message").addEventListener("input", () => {
  if (state.selected)
    storageSet(`semaphore:draft:${state.selected}`, $("#message").value);
  updateComposer();
});
$("#recover-check").addEventListener("change", () => {
  $("#recover-confirm").disabled = !$("#recover-check").checked;
});
$("#recover-confirm").addEventListener("click", async () => {
  if (!$("#recover-check").checked || !state.room) return;
  try {
    const { room } = await api(`/rooms/${state.room.name}/recover`, {
      method: "POST",
      body: { acknowledged: true },
    });
    renderRoom(room);
    $("#recover-dialog").close();
  } catch (err) {
    toast(err.message);
  }
});
$("#create-room").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#create-button").disabled = true;
  try {
    const { room } = await api("/rooms", {
      method: "POST",
      body: { title: $("#room-title").value },
    });
    $("#new-dialog").close();
    await selectRoom(room.name);
    await refresh();
    await connections();
  } catch (err) {
    toast(err.message);
  } finally {
    $("#create-button").disabled = false;
  }
});
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#send").disabled || !state.room) return;
  const name = state.room.name;
  const text = $("#message").value;
  const to = state.recipient;
  const fingerprint = JSON.stringify({ name, text, to });
  // Preserve the same request ID after a network error. The core commits it with
  // the message, so an explicit retry cannot duplicate a delivered turn.
  if (state.request?.fingerprint !== fingerprint)
    state.request = { fingerprint, clientId: crypto.randomUUID() };
  storageSet(`semaphore:request:${name}`, JSON.stringify(state.request));
  const clientId = state.request.clientId;
  sending.add(name);
  updateComposer();
  try {
    const { room } = await api(`/rooms/${name}/messages`, {
      method: "POST",
      body: { text, to, clientId },
    });
    finishDraft(name, text, clientId);
    if (state.selected === name) renderRoom(room);
    await refresh();
  } catch (err) {
    if (err.room) {
      const saved = err.room.messages.some(
        (message) => message.clientId === clientId,
      );
      if (saved) finishDraft(name, text, clientId);
      renderRoom(err.room);
      toast(`${saved ? "Your message was saved. " : ""}${err.message}`);
    } else toast(err.message);
  } finally {
    sending.delete(name);
    updateComposer();
  }
});
$("#connect-body").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-invite]");
  if (!button || button.disabled) return;
  button.disabled = true;
  let timeout;
  try {
    await Promise.race([
      navigator.clipboard.writeText(state.invite[button.dataset.copyInvite].prompt),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Clipboard unavailable")), 1500);
      }),
    ]);
    button.textContent = "Copied ✓";
    toast("Invitation copied. Paste it into the native chat and send.");
  } catch {
    button.closest(".connect-card").querySelector("details").open = true;
    button.textContent = "Copy again";
    toast("Open “View invitation” and copy the text there.");
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
  }
});
$("#settings").addEventListener("click", async () => {
  showDialog("#settings-dialog");
  $("#diagnostics").textContent = "Checking your setup…";
  try {
    const result = await api("/diagnostics");
    $("#diagnostics").innerHTML = result.checks
      .map(
        (check) =>
          `<div class="diagnostic"><span class="diagnostic-icon ${check.ok ? "" : "warn"}">${check.ok ? "✓" : "○"}</span><div><strong>${escape(check.name)}</strong><p>${escape(check.detail)}</p>${check.fix ? `<p class="diagnostic-fix">${escape(check.fix)}</p>` : ""}</div></div>`,
      )
      .join("");
  } catch (err) {
    $("#diagnostics").textContent = err.message;
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newConversation();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    document.activeElement === $("#message")
  ) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
});
await refresh();
let initial;
try {
  initial = decodeURIComponent(location.hash.slice(1));
} catch {}
initial ||= storageGet("semaphore:last-room");
if (state.rooms.some((room) => room.name === initial))
  await selectRoom(initial);
let refreshing = false;
setInterval(async () => {
  if (document.hidden || refreshing) return;
  refreshing = true;
  try {
    await refresh();
  } finally {
    refreshing = false;
  }
}, 1500);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
