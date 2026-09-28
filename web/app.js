import { labels, avatar, escape, formatMessage } from "./render.mjs";
import { prepareStartRequest } from "./start-request.mjs";

const $ = (selector) => document.querySelector(selector);
const token = $("meta[name=semaphore-token]").content;
const SEATS = ["astra", "claude"];
// How many model replies in a row run before the stick comes back to the person.
const LIMITS = [4, 10, 20, null];
function limitValue(limit) {
  return String(limit ?? "none");
}
function limitFromValue(value) {
  return value === "none" ? null : Number(value);
}
function limitOptions() {
  return LIMITS.map((option) => `<option value="${limitValue(option)}">${option === null ? "Never" : `${option} replies`}</option>`).join("");
}
function limitHelp(limit) {
  return limit === null ? "No automatic reply limit. An AI can still hand you the stick when it needs you. You can speak or take it anytime." : `They stop after ${limit} AI ${limit === 1 ? "reply" : "replies"} in a row and hand the stick back to you.`;
}
// A new conversation starts with 4 unless this draft picked another limit.
function savedStartLimit() {
  const saved = storageGet("semaphore:start-limit");
  return saved && LIMITS.map(limitValue).includes(saved) ? limitFromValue(saved) : 4;
}
const companion = new URLSearchParams(location.search).get("view") === "companion";
document.body.classList.toggle("companion", companion);
const state = {
  rooms: [],
  room: null,
  selected: null,
  recipient: "astra",
  signatures: {},
  invite: {},
  invites: {},
  startMembers: new Set(SEATS),
  startRecipient: rememberedRecipient(),
  startLimit: savedStartLimit(),
  owners: {},
  approvals: {},
  readySeen: {},
  holders: {},
  deliverablesOpen: null,
  freshDeliverables: new Set(),
  // Preview links issued in this page, by artifact. They are capabilities, so never stored.
  previewLinks: {},
};
// Message requests still in flight, by request ID. The box clears as soon as one is sent.
const inFlight = new Map();
const pendingLimits = new Map();
const loadingInvites = new Set();
let startBusy = false;
const sidebarWidth = matchMedia("(max-width: 760px)");
let sidebarCollapsed = storageGet("semaphore:sidebar-collapsed") === "true";
const sidebarIsDrawer = () => companion || sidebarWidth.matches;
function syncSidebar() {
  const sidebar = $("#sidebar");
  const drawer = sidebarIsDrawer();
  const visible = drawer ? sidebar.classList.contains("open") : !sidebarCollapsed;
  if (!visible && sidebar.contains(document.activeElement)) $("#menu").focus({ preventScroll: true });
  document.body.classList.toggle("sidebar-drawer", drawer);
  document.body.classList.toggle("sidebar-collapsed", !drawer && sidebarCollapsed);
  sidebar.inert = !visible;
  sidebar.setAttribute("aria-hidden", String(!visible));
  $("#menu").setAttribute("aria-expanded", String(visible));
  $("#menu").setAttribute("aria-label", visible ? "Hide sidebar" : "Show sidebar");
  $("#menu").title = `${visible ? "Hide" : "Show"} sidebar (⌘\\ / Ctrl+\\)`;
}
function toggleSidebar() {
  if (sidebarIsDrawer()) $("#sidebar").classList.toggle("open");
  else {
    sidebarCollapsed = !sidebarCollapsed;
    storageSet("semaphore:sidebar-collapsed", String(sidebarCollapsed));
  }
  syncSidebar();
  if (sidebarIsDrawer() && $("#sidebar").classList.contains("open")) $("#search").focus();
}
function closeSidebarDrawer() {
  $("#sidebar").classList.remove("open");
  syncSidebar();
}
sidebarWidth.addEventListener("change", closeSidebarDrawer);
addEventListener("storage", (event) => {
  if (event.key === "semaphore:sidebar-collapsed") {
    sidebarCollapsed = event.newValue === "true";
    syncSidebar();
  }
});
syncSidebar();

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

// Where each AI works, and where it asks the person for approval.
const hostApp = (speaker) => (speaker === "astra" ? "ChatGPT" : "the Claude app");
// A status note is the AI's own line about the turn it holds. Show it only while that exact
// turn is pending, and always as the AI's words, never as Semaphore's.
function currentNote(room) {
  const note = room?.statusNote;
  const pending = room?.pending;
  if (!note || pending?.state !== "awaiting-reply" || note.turnId !== pending.id || note.speaker !== pending.speaker)
    return null;
  if (!["working", "approval"].includes(note.kind) || typeof note.text !== "string" || !note.text.trim())
    return null;
  if (note.expiresAt && !(Date.parse(note.expiresAt) > Date.now())) return null;
  return note;
}
const awaitingApproval = (room) => currentNote(room)?.kind === "approval";
// These per-seat states come from the room poll, not a cached global switch.
const GPT_WAKE = {
  automatic: { badge: "wakes automatically", detail: "waking GPT’s chat", description: "Semaphore can wake this chat automatically. No listener is needed between turns." },
  unloaded: { badge: "asleep in ChatGPT", detail: "GPT’s chat is asleep in ChatGPT · open it to continue", action: "chat", description: "ChatGPT has put this chat to sleep. Open it there so Semaphore can deliver its saved turn. You do not need to ask GPT to listen." },
  reconnect: { badge: "needs reconnecting", detail: "saved in GPT’s inbox · open its chat and reconnect", action: "chat", description: "This chat’s automatic-wake connection needs renewing. Open the existing chat and send the connection instructions below to reconnect it to this room." },
  checking: { badge: "checking wake", detail: "checking automatic wake · your message is saved", description: "Semaphore is checking this chat’s automatic-wake connection. Messages stay saved while it checks." },
  unavailable: { badge: "wake unavailable", detail: "automatic wake is unavailable · your message is saved", action: "setup", description: "Semaphore cannot currently check whether this chat can wake. Your messages are saved. Check Setup & connections for its status." },
  off: { badge: "automatic wake off", detail: "automatic wake is off · your message is saved", action: "setup", description: "Automatic wake is off. Turn it on in Setup & connections, or open GPT’s chat and ask it to listen to this room." },
  listening: { badge: "listening", detail: "waiting for GPT’s chat to pick it up", description: "GPT is listening inside its native chat. Keep that chat active to receive room turns." },
};
const receivedBy = (room, speaker) => room.pending?.speaker === speaker && room.pending.progress === "received";
// Claude's live listener or a fresh inspection of GPT's exact active native turn.
function reachesNow(room) {
  const pending = room?.pending;
  if (!pending || pending.progress !== "received") return false;
  const seat = room.connections[pending.speaker];
  return (seat?.transport === "claude-inbox" && (seat.listening === true || seat.wake === "automatic")) ||
    (seat?.transport === "astra-inbox" && seat.steering === true);
}
// A listener exits once it hands its chat a turn, and the chat acknowledges when it starts, which
// can take a minute or more. In that gap the chat has the turn; it isn't "not listening".
const handedToChat = (room, speaker) =>
  room.pending?.speaker === speaker && room.pending.progress === "queued" && !!room.pending.timing?.listenerObservedAt;
// After replying, a chat takes a few moments to start listening again.
const LISTEN_AGAIN_MS = 90_000;
function justReplied(room, speaker) {
  const last = room.messages.findLast((message) => message.speaker === speaker);
  return !!last && Date.now() - Date.parse(last.at) < LISTEN_AGAIN_MS;
}
const claudeWakes = (seat) => seat?.transport === "claude-inbox" && seat.wake === "automatic";
function memberDetail(room, speaker) {
  const seat = room.connections[speaker];
  if (!seat?.connected) return speaker === "human" ? "" : "not connected";
  if (receivedBy(room, speaker)) return "";
  if (claudeWakes(seat)) return "wakes automatically";
  return speaker === "astra" ? GPT_WAKE[seat.wake]?.badge ?? "" : "";
}
function connectionDescription(room, speaker) {
  const seat = room.connections[speaker];
  if (receivedBy(room, speaker)) return `${labels[speaker]} has received this turn and is working in ${hostApp(speaker)}.`;
  if (speaker === "claude" && claudeWakes(seat)) return "Semaphore wakes this chat through its Claude Code hook, so no listener is needed. Keep the chat open in the Claude app.";
  if (speaker === "claude") return "Keep this chat open and listening. You can continue speaking to Claude in its app.";
  if (seat.manual) return "Manual delivery: messages wait in GPT’s Codex chat until you press Send there.";
  return GPT_WAKE[seat.wake]?.description ?? "Open GPT’s chat and ask it to listen to this room. Messages wait in its inbox until then.";
}
// Queue acceptance is distinct from acknowledgment by the bound native chat.
function pendingDetail(pending, room) {
  const who = labels[pending.speaker];
  if (pending.state === "delivering") return "sending";
  if (pending.progress === "received") return `working in ${hostApp(pending.speaker)}`;
  if (pending.wake?.status === "uncertain") return "wake status uncertain · check GPT’s chat";
  if (pending.wake?.status === "needs-send") return "wake queued in GPT’s chat · press Send there";
  const seat = room.connections[pending.speaker];
  if (pending.progress === "queued") {
    if (seat?.manual) return `queued in ${who}’s Codex chat · press Send there`;
    if (pending.speaker === "astra" && GPT_WAKE[seat?.wake]) return GPT_WAKE[seat.wake].detail;
    if (pending.wake?.status === "blocked") return "saved in GPT’s inbox · open its chat and reconnect";
    if (handedToChat(room, pending.speaker)) return `starting in ${hostApp(pending.speaker)}`;
    // Registered Claude chats are woken by their hook; a chat that doesn't respond is probably closed.
    if (claudeWakes(seat))
      return Date.now() - Date.parse(pending.timing?.queuedAt ?? pending.at) < 60_000
        ? "waking Claude's chat"
        : "Claude's chat hasn't woken yet · open it in the Claude app to continue";
    return seat?.listening === false
      ? `waiting in ${who}’s inbox until its chat listens again`
      : `waiting for ${who}’s chat to pick it up`;
  }
  return "waiting for a reply";
}
function pendingAction(pending, room) {
  if (!pending || pending.state === "delivering" || pending.progress === "received") return null;
  if (["uncertain", "needs-send"].includes(pending.wake?.status)) return "chat";
  const seat = room.connections[pending.speaker];
  if (seat?.manual) return "chat";
  return pending.speaker === "astra" ? GPT_WAKE[seat?.wake]?.action ?? (pending.wake?.status === "blocked" ? "chat" : null) : null;
}
function waitingOn(room) {
  return (room.members ?? SEATS).filter(
    (speaker) => !room.connections[speaker].connected,
  );
}
function joinPhrase(room) {
  const missing = waitingOn(room);
  if (!missing.length) return "everyone has";
  return missing.length > 1 ? "both have" : `${labels[missing[0]]} has`;
}
// A message sent while an AI holds the stick is saved at once and read before that AI replies.
function interjectionNote(message, room) {
  if (!message.interjection) return "";
  if (message.readAt)
    return `<div class="message-note read">Read by ${labels[message.readBy] || "the group"}</div>`;
  const paused =
    room.pending?.state === "uncertain" || room.lock?.state === "stale" || (!room.pending && room.opening?.state !== "waiting");
  const reader = labels[message.waitingFor];
  if (paused || !reader) return `<div class="message-note">Saved · waits until the conversation continues</div>`;
  const current = room.pending?.speaker === message.waitingFor;
  if (current && room.pending.deliveredThrough >= message.seq)
    return `<div class="message-note">Delivered to ${reader} · reading it at its next step</div>`;
  if (current && room.pending.offeredThrough >= message.seq)
    return `<div class="message-note">Saved · waiting for ${reader} to acknowledge</div>`;
  if (current && reachesNow(room)) return `<div class="message-note">Sending to ${reader}…</div>`;
  return `<div class="message-note">Saved · ${reader} will read this before replying</div>`;
}
function openingNote(message, room) {
  const opening = room.opening;
  if (!message.opening || opening?.clientId !== message.clientId) return "";
  const note = {
    waiting: `Saved · goes to ${labels[opening.to]} once ${joinPhrase(room)} joined`,
    dispatching: `Sending to ${labels[opening.to]}…`,
    paused: "Paused · you took the stick before it went out",
    uncertain: "Check before continuing · it may have reached its chat",
  }[opening.state];
  return note ? `<div class="message-note">${escape(note)}</div>` : "";
}
function destination(message, room) {
  if (message.opening) return labels[room.opening?.to] || "You";
  return labels[message.next] || "You";
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
function rememberedRecipient(name) {
  const saved =
    (name && storageGet(`semaphore:recipient:${name}`)) ||
    storageGet("semaphore:recipient");
  return saved === "claude" ? "claude" : "astra";
}
// A message box grows with its text, up to 40% of the window.
function fitBox(box) {
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight + 2, Math.round(innerHeight * 0.4))}px`;
}
function fitComposer() {
  fitBox($("#message"));
}
async function copyText(text) {
  let timeout;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Clipboard unavailable")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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

// Unconfirmed sends, per room, kept until the server shows the message was saved. Sending
// the same text again reuses its request ID, so one message can never be committed twice.
function unconfirmed(name) {
  let list = [];
  try {
    const saved = JSON.parse(storageGet(`semaphore:requests:${name}`));
    if (Array.isArray(saved)) list = saved;
  } catch {}
  // Adopt the single record an earlier version of this page kept.
  try {
    const legacy = JSON.parse(storageGet(`semaphore:request:${name}`));
    if (legacy?.clientId && !list.some((item) => item.clientId === legacy.clientId)) {
      const { text, to } = JSON.parse(legacy.fingerprint);
      list.push({
        clientId: legacy.clientId,
        fingerprint: JSON.stringify({ text, to, opening: false }),
      });
      storageSet(`semaphore:requests:${name}`, JSON.stringify(list));
    }
  } catch {}
  storageSet(`semaphore:request:${name}`, "null");
  return list;
}
function requestFor(name, fingerprint) {
  const list = unconfirmed(name);
  const match = list.find(
    (item) => item.fingerprint === fingerprint && !inFlight.has(item.clientId),
  );
  if (match) return match;
  const request = { fingerprint, clientId: crypto.randomUUID() };
  storageSet(`semaphore:requests:${name}`, JSON.stringify([...list, request]));
  return request;
}
function settleRequest(name, clientId) {
  storageSet(
    `semaphore:requests:${name}`,
    JSON.stringify(unconfirmed(name).filter((item) => item.clientId !== clientId)),
  );
}
// Forgets records the server has committed and returns the ones still unconfirmed.
function settleCommitted(room) {
  const committed = new Set(room.messages.map((message) => message.clientId));
  // A response can be lost after a successful commit. Only clear a draft that
  // we restored automatically; never erase text the human has since edited.
  try {
    const restored = JSON.parse(storageGet(`semaphore:restored:${room.name}`));
    if (restored && committed.has(restored.clientId)) {
      const current = state.selected === room.name ? $("#message").value : storageGet(`semaphore:draft:${room.name}`);
      if (current === restored.text) {
        storageSet(`semaphore:draft:${room.name}`, "");
        if (state.selected === room.name) { $("#message").value = ""; fitComposer(); }
      }
      storageSet(`semaphore:restored:${room.name}`, "null");
    }
  } catch {}
  const list = unconfirmed(room.name);
  const open = list.filter((item) => !committed.has(item.clientId));
  if (open.length !== list.length)
    storageSet(`semaphore:requests:${room.name}`, JSON.stringify(open));
  return open;
}
// Puts an unsent message back in its box. When the outcome is unknown it only goes
// into an empty box, so sending the same text again reuses the same request ID.
function restoreDraft(name, text, rejected, clientId) {
  const current =
    state.selected === name
      ? $("#message").value
      : storageGet(`semaphore:draft:${name}`) || "";
  if (current.trim() && !rejected) return false;
  const value = current.trim() ? `${text}\n\n${current}` : text;
  storageSet(`semaphore:draft:${name}`, value);
  if (!rejected) storageSet(`semaphore:restored:${name}`, JSON.stringify({ text: value, clientId }));
  if (state.selected === name) {
    $("#message").value = value;
    if (!rejected) {
      try {
        const request = unconfirmed(name).find((item) => item.clientId === clientId);
        state.recipient = JSON.parse(request.fingerprint).to;
      } catch {}
    }
    fitComposer();
  }
  return true;
}

function roomSubtitle(room) {
  if (room.opening?.state === "waiting") {
    const missing = waitingOn(room);
    return missing.length > 1
      ? "Waiting for both to join"
      : missing.length
        ? `Waiting for ${labels[missing[0]]} to join`
        : "Starting…";
  }
  if (awaitingApproval(room)) return `${labels[room.pending.speaker]} needs your approval`;
  const ready = room.deliverables?.ready ? ` · ${room.deliverables.ready} ready` : "";
  if (room.pending) return `${labels[room.pending.speaker]}’s turn${ready}`;
  return room.messageCount
    ? `${room.messageCount} messages${ready} · ${relativeTime(room.updatedAt)}`
    : "Ready for a first thought";
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
            `<button class="room-item ${state.selected === room.name ? "selected" : ""}" data-room="${escape(room.name)}" ${state.selected === room.name ? 'aria-current="page"' : ""}><span class="room-copy"><strong>${escape(room.title)}</strong><small>${escape(roomSubtitle(room))}</small></span>${awaitingApproval(room) ? '<span class="room-dot approval" aria-label="Approval needed"></span>' : room.pending ? '<span class="room-dot" aria-label="Reply pending"></span>' : ""}</button>`,
        )
        .join("")
    : `<p class="no-rooms">${search ? "No matching conversations." : "A good conversation starts with a thought. Make room for yours."}</p>`;
}

async function loadInvites(name) {
  if (state.invites[name] || loadingInvites.has(name)) return;
  loadingInvites.add(name);
  try {
    const invites = await Promise.all(
      SEATS.map((speaker) => api(`/rooms/${name}/invite/${speaker}`)),
    );
    state.invites[name] = Object.fromEntries(
      invites.map((invite) => [invite.speaker, invite]),
    );
    if (state.selected === name && state.room) renderRoom(state.room, true);
  } catch {
  } finally {
    loadingInvites.delete(name);
  }
}

// The guided start: invite each member, then the saved first message waits for them.
function startCard(room) {
  const opening = room.opening;
  const members = room.members ?? SEATS;
  const invites = state.invites[room.name];
  const seats = members
    .map((speaker) => {
      const seat = room.connections[speaker];
      const invite = invites?.[speaker];
      const url =
        invite && /^(codex|claude):\/\//.test(invite.url) ? invite.url : null;
      const app = speaker === "astra" ? "ChatGPT" : "Claude";
      const detail = seat.connected
        ? claudeWakes(seat)
          ? "Joined · wakes automatically"
          : seat.listening === false
          ? "Joined · its chat isn’t listening right now"
          : "Joined and listening"
        : speaker === "claude"
          ? "Opens a new Code chat in Claude; confirm the folder, then press Send"
          : "Opens a new Codex chat in ChatGPT; press Send there";
      const actions = seat.connected
        ? '<span class="joined-pill">Joined</span>'
        : `<div class="seat-actions">${url ? `<a class="primary" href="${escape(url)}">Open ${app} ↗</a>` : ""}<button type="button" data-copy-start="${speaker}" ${invite ? "" : "disabled"}>Copy invite</button>${invite?.compactAvailable ? `<button type="button" class="quiet" data-copy-full="${speaker}">Full invitation</button>` : ""}</div>`;
      return `<div class="seat-row">${avatar(speaker)}<div class="seat-copy"><strong>${labels[speaker]}</strong><span>${escape(detail)}</span></div>${actions}</div>`;
    })
    .join("");
  const everyone = !waitingOn(room).length;
  const say = opening
    ? `<div class="opening-preview">${escape(opening.text)}</div><p class="start-note">${escape(opening.state === "dispatching" ? `Sending to ${labels[opening.to]}…` : `Goes to ${labels[opening.to]} once ${joinPhrase(room)} joined.`)}</p>`
    : `<p class="start-note">Write your first message below and pick who replies first. It waits until ${members.length > 1 ? "both have" : `${labels[members[0]]} has`} joined, then goes out once.</p>`;
  return `<section class="start-card" aria-label="Get the group together"><h2>Get the group together</h2><div class="start-step"><span class="step-number${everyone ? " done" : ""}">${everyone ? "✓" : "1"}</span><div><h3>Invite ${members.map((speaker) => labels[speaker]).join(" and ")}</h3>${seats}<p class="start-note">Each app opens a new chat with the invitation filled in. Press Send there, and we’ll show you when it joins.</p></div></div><div class="start-step"><span class="step-number${opening ? " done" : ""}">${opening ? "✓" : "2"}</span><div><h3>Say what you need</h3>${say}</div></div></section>`;
}

// Whose turn it is, in one compact bar. The Semaphore mark signals while an AI works and
// pings when the stick comes back to the person; deliverables open over the conversation.
function renderStatus(room, setup) {
  const pending = room.pending;
  const stale = room.lock?.state === "stale";
  const paused = pending?.state === "uncertain" || stale;
  const banner = $("#state-banner");
  const changedRoom = banner.dataset.room !== room.name;
  banner.dataset.room = room.name;
  const note = paused ? null : currentNote(room);
  const approval = note?.kind === "approval";
  const recoveryAction = paused ? null : pendingAction(pending, room);
  const chatURL = approval || recoveryAction === "chat" ? room.connections[pending.speaker]?.url : null;
  const holder = paused ? "paused" : (pending?.speaker ?? "human");
  // The stick coming back from an AI plays the arrival once; later redraws stay calm.
  const arrived = holder === "human" && ["astra", "claude"].includes(state.holders[room.name]);
  state.holders[room.name] = holder;
  trackDeliverables(room);
  banner.classList.toggle("paused", paused);
  banner.classList.toggle("approval", approval);
  if (arrived) banner.classList.add("arrived");
  else if (holder !== "human" || changedRoom) banner.classList.remove("arrived");
  banner.dataset.holder = holder;
  const who = paused
    ? `<i class="state-dot"></i><span>${stale ? "A previous app process stopped. Your conversation is saved." : "Paused · a previous delivery needs your review"}</span>`
    : pending
      ? `${signalMark(pending.speaker, approval ? "" : "working")}<span>${approval ? `<strong>${labels[pending.speaker]} is waiting for your approval in ${hostApp(pending.speaker)}</strong>` : `<strong>${labels[pending.speaker]} has the stick</strong><span class="state-detail"> · ${escape(pendingDetail(pending, room))}${Number.isInteger(room.maxTurns) ? ` · reply ${Math.min((room.autoTurns ?? 0) + 1, room.maxTurns)} of ${room.maxTurns}` : ""}</span>`}${note ? `<span class="state-note" title="${escape(note.text)}">“${escape(note.text)}” · ${escape(relativeTime(note.updatedAt))}</span>` : ""}</span>`
      : `${signalMark("human")}<span><strong>Your turn</strong><span class="state-detail"> · reply, or hand the stick to one of them</span></span>`;
  // During the guided start, the start card is the only call to action.
  const markup = setup
    ? ""
    : `<span class="state-who">${who}</span><div class="state-actions">${deliverablesPill(room)}${stale ? '<button class="primary" data-action="unlock">Recover stopped process</button>' : paused ? '<button class="primary" data-action="recover">Review &amp; continue</button>' : pending ? `${chatURL ? `<a class="state-link" href="${escape(chatURL)}">Open chat ↗</a>` : recoveryAction === "setup" ? '<button data-action="setup">Check setup</button>' : ""}<button data-action="take">Take the stick</button>` : room.messages.length && !room.legacy ? (room.members ?? SEATS).map((speaker) => `<button data-action="pass-${speaker}">Ask ${labels[speaker]}</button>`).join("") : ""}</div>`;
  if (changedRoom || banner.renderedMarkup !== markup) {
    const signal = changedRoom ? null : banner.querySelector(".signal");
    const focused = !changedRoom && banner.contains(document.activeElement) ? document.activeElement : null;
    const action = focused?.dataset.action;
    const pill = focused?.hasAttribute("data-deliverables");
    banner.innerHTML = markup;
    banner.renderedMarkup = markup;
    const nextSignal = banner.querySelector(".signal");
    // Keep an existing animation running through polling, notes and pill toggles.
    if (signal && nextSignal && signal.className.replace(/\s+ping\b/, "") === nextSignal.className)
      nextSignal.replaceWith(signal);
    if (focused) {
      const replacement = pill ? banner.querySelector("[data-deliverables]")
        : action ? banner.querySelector(`[data-action="${CSS.escape(action)}"]`) : banner.querySelector(".state-link");
      replacement?.focus({ preventScroll: true });
    }
  }
  if (arrived) banner.querySelector(".signal")?.classList.add("ping");
  renderDeliverables(room, setup);
}
// The Semaphore mark, drawn inline so its bars can move.
function signalMark(holder, motion = "") {
  return `<span class="signal ${holder}${motion ? ` ${motion}` : ""}" aria-hidden="true"><svg viewBox="0 0 40 40"><rect class="signal-bg" width="40" height="40" rx="12"/><rect class="bar b1" x="10" y="10" width="5" height="20" rx="2.5"/><rect class="bar b2" x="18" y="16" width="5" height="14" rx="2.5"/><rect class="bar b3" x="26" y="10" width="5" height="14" rx="2.5"/></svg></span>`;
}
// Newly finished work marks the Deliverables pill instead of covering the conversation.
function trackDeliverables(room) {
  const ready = (room.artifacts ?? []).filter((item) => item.ready).length;
  const seen = state.readySeen[room.name];
  state.readySeen[room.name] = ready;
  if (seen !== undefined && ready > seen) state.freshDeliverables.add(room.name);
}
function deliverablesPill(room) {
  const items = room.artifacts ?? [];
  if (!items.length) return "";
  const ready = items.filter((item) => item.ready).length;
  const attention = items.some((item) => item.availability !== "current");
  const fresh = state.freshDeliverables.has(room.name);
  return `<button type="button" class="deliverables-pill${fresh ? " fresh" : ""}${attention ? " attention" : ""}" data-deliverables aria-expanded="${state.deliverablesOpen === room.name}" aria-controls="deliverables"${fresh ? ' aria-description="New finished work"' : ""}>Deliverables <span>${ready ? `${ready} ready` : items.length}</span></button>`;
}
function setDeliverablesOpen(open, { focus = true } = {}) {
  const room = state.room;
  if (!room || (!open && state.deliverablesOpen === null)) return;
  state.deliverablesOpen = open ? room.name : null;
  if (open) state.freshDeliverables.delete(room.name);
  renderStatus(room, false);
  if (focus) (open ? $("#deliverables .deliverables-close") : $(".deliverables-pill"))?.focus();
}
function renderRoom(room, force = false) {
  if (room.name !== state.selected) return;
  state.room = room;
  settleCommitted(room);
  // Reply grace and wake timeout can change without any room mutation.
  const signature = JSON.stringify(room) + SEATS.map((speaker) => justReplied(room, speaker)).join() +
    (room.pending ? pendingDetail(room.pending, room) : "");
  if (!force && signature === state.signatures[room.name]) {
    updateComposer();
    return;
  }
  state.signatures[room.name] = signature;
  $("#welcome").hidden = true;
  $("#conversation").hidden = false;
  $("#top-title").textContent = room.title;
  $("#conversation-title").textContent = room.title;
  // A name an AI suggested stays visibly theirs until the person renames it.
  $("#conversation-eyebrow").textContent = ["astra", "claude"].includes(room.titleSource)
    ? `GROUP CONVERSATION · NAMED BY ${labels[room.titleSource].toUpperCase()}`
    : "GROUP CONVERSATION";
  document.title = `${room.title} · Semaphore`;
  $("#members").innerHTML = ["human", ...(room.members ?? SEATS)]
    .map(
      (speaker) =>
        `<span class="member ${room.owner === speaker ? "holder" : ""}">${avatar(speaker)}${labels[speaker]}${memberDetail(room, speaker) ? `<small>${escape(memberDetail(room, speaker))}</small>` : ""}${room.owner === speaker ? '<span class="member-dot" aria-label="Holds the stick"></span>' : ""}</span>`,
    )
    .join("");
  const opening = room.opening;
  // A new conversation stays in the guided start until its opening has gone out.
  const setup =
    !room.legacy &&
    (!room.messages.length ||
      ["waiting", "dispatching"].includes(opening?.state));
  if (setup) loadInvites(room.name);
  // The start card already shows who has joined.
  $("#members").hidden = setup;
  renderLimit(room, setup);
  const missing = waitingOn(room);
  // Seats that receive turns through an inbox but have no listener running right now.
  // A seat Semaphore wakes automatically needs no listener, so it is never "not listening".
  const resting = (room.members ?? SEATS).filter(
    (speaker) =>
      room.connections[speaker].connected &&
      room.connections[speaker].listening === false &&
      // A Claude chat Semaphore wakes through its hook needs no listener.
      !claudeWakes(room.connections[speaker]) &&
      // Known GPT wake states have their own truthful guidance, including Off.
      !(speaker === "astra" && GPT_WAKE[room.connections[speaker].wake]) &&
      !receivedBy(room, speaker) &&
      !handedToChat(room, speaker) &&
      !justReplied(room, speaker),
  );
  const needsListener = resting.length > 0;
  const guide = $("#connection-guide");
  guide.hidden = setup || (!missing.length && !needsListener && !room.legacy);
  if (!guide.hidden)
    guide.innerHTML = `<div><strong>${room.legacy ? "This is an earlier headless conversation" : missing.length ? `Make room for ${missing.map((s) => labels[s]).join(" and ")}` : `${resting.map((s) => labels[s]).join(" and ")} ${resting.length > 1 ? "aren’t" : "isn’t"} listening`}</strong><p>${room.legacy ? "Create a new conversation to connect your live desktop chats." : missing.length ? "Invite each model from its desktop chat. We’ll show you when they join." : `Open ${resting.map((s) => labels[s]).join(" and ")}’s chat and ask it to listen to this room again. Messages wait in its inbox until then.`}</p></div><button data-action="connect">${missing.length ? "Connect apps" : "View connection"} ↗</button>`;
  renderStatus(room, setup);
  const messages = setup ? room.messages.filter((message) => !message.opening) : room.messages;
  const markup = (setup ? startCard(room) : "") + messages
        .map(
          (message) =>
            `<article class="message" id="message-${Number(message.seq)}" tabindex="-1">${avatar(message.speaker)}<div class="message-body"><div class="message-header"><strong>${labels[message.speaker] || "Unknown"}</strong><span class="to">→ ${destination(message, room)}</span><time datetime="${escape(message.at)}">${formatTime(message.at)}</time></div><div class="message-text">${formatMessage(message.text)}</div>${message.via ? `<div class="message-via">Shared from ${labels[message.via]}’s desktop chat</div>` : ""}${openingNote(message, room)}${interjectionNote(message, room)}</div></article>`,
        )
        .join("");
  const container = $("#messages");
  const changedRoom = container.dataset.room !== room.name;
  // Status polling must not replace the text being read or the focused rail button.
  if (changedRoom || container.renderedMarkup !== markup) {
    const scroller = $("#message-scroll");
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    const oldScroll = scroller.scrollTop;
    container.innerHTML = markup;
    container.renderedMarkup = markup;
    container.dataset.room = room.name;
    scroller.scrollTop = setup ? 0 : changedRoom || atBottom ? scroller.scrollHeight : oldScroll;
    renderMessageRail(messages, changedRoom);
    // Composer sizing completes after a room opens. Keep its final paragraph in view.
    if (!setup && (changedRoom || atBottom)) requestAnimationFrame(() => {
      if (state.selected === room.name && !rail.contains(document.activeElement))
        scroller.scrollTop = scroller.scrollHeight;
    });
  }
  updateComposer();
}

// Alerts float over the conversation. The messages start below them, and the rail centres
// in the space that remains.
new ResizeObserver(sizeMessageRail).observe($("#room-alerts"));
// One quiet dash per message. The rail is outside the scroller, so it stays in place.
let railEntries = [];
let railObserver;
let railInset = -1;
let previewedButton;
let jumpTimer;
let jumpedMessage;
const rail = $("#message-rail");
const railList = rail.querySelector(".rail-list");
const railPreview = rail.querySelector(".rail-preview");
const messageInset = () => $("#room-alerts").offsetHeight + 16;
function sizeMessageRail() {
  const area = $("#message-area");
  const alertsHeight = $("#room-alerts").offsetHeight;
  area.style.setProperty("--alerts-height", `${alertsHeight}px`);
  const height = Math.max(0, area.clientHeight - messageInset());
  area.style.setProperty("--deliverables-height", `${Math.max(80, height - 8)}px`);
  // Companion is a deliberately compact desktop window. Ordinary phone/touch layouts
  // keep their full reading width instead of exposing tiny navigation targets.
  const compactWidth = companion ? area.clientWidth < 240 : area.clientWidth < 400 || matchMedia("(max-width: 760px), (pointer: coarse)").matches;
  const hidden = railEntries.length < 4 || height < 200 || compactWidth;
  if (hidden && rail.contains(document.activeElement)) {
    const entry = railEntries.find((item) => item.button === document.activeElement);
    entry?.article.focus({ preventScroll: true });
  }
  rail.hidden = hidden;
  area.classList.toggle("has-rail", !hidden);
  observeRailMessages();
  if (hidden) { railPreview.hidden = true; return; }
  const available = Math.floor(height * 0.6);
  const step = Math.max(4, Math.min(10, available / railEntries.length));
  rail.style.height = `${Math.min(available, step * railEntries.length)}px`;
  rail.style.setProperty("--rail-step", `${step}px`);
  if (!railPreview.hidden && previewedButton) previewMessage(previewedButton);
}
function previewMessage(button) {
  const entry = railEntries.find((item) => item.button === button);
  if (!entry || rail.hidden) return;
  previewedButton = button;
  railPreview.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `${entry.speaker} · ${entry.time}`;
  const text = document.createElement("span");
  text.textContent = entry.excerpt;
  railPreview.append(heading, text);
  railPreview.hidden = false;
  const buttonRect = button.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  const areaRect = $("#message-area").getBoundingClientRect();
  const minimum = areaRect.top + messageInset();
  const maximum = areaRect.bottom - railPreview.offsetHeight - 4;
  const above = buttonRect.top - railPreview.offsetHeight - 8;
  const preferred = companion ? (above >= minimum ? above : buttonRect.bottom + 8) : buttonRect.top;
  railPreview.style.top = `${Math.max(minimum, Math.min(preferred, maximum)) - railRect.top}px`;
}
function keepRailButtonVisible(button) {
  // Very long conversations keep every message reachable in a scrollable rail.
  const top = button.offsetTop;
  if (top < railList.scrollTop) railList.scrollTop = top;
  else if (top + button.offsetHeight > railList.scrollTop + railList.clientHeight)
    railList.scrollTop = top + button.offsetHeight - railList.clientHeight;
}
function focusRailButton(button) {
  for (const entry of railEntries) entry.button.tabIndex = entry.button === button ? 0 : -1;
  button.focus({ preventScroll: true });
  keepRailButtonVisible(button);
  previewMessage(button);
}
function jumpToMessage(button) {
  const entry = railEntries.find((item) => item.button === button);
  if (!entry) return;
  focusRailButton(button);
  const scroller = $("#message-scroll");
  const top = scroller.scrollTop + entry.article.getBoundingClientRect().top - scroller.getBoundingClientRect().top - messageInset();
  scroller.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  clearTimeout(jumpTimer);
  jumpedMessage?.classList.remove("jump-target");
  jumpedMessage = entry.article;
  jumpedMessage.classList.add("jump-target");
  jumpTimer = setTimeout(() => jumpedMessage?.classList.remove("jump-target"), 1800);
}
function renderMessageRail(messages, changedRoom) {
  const focusedSeq = !changedRoom && rail.contains(document.activeElement) ? document.activeElement.dataset.seq : null;
  const tabSeq = !changedRoom ? railEntries.find((entry) => entry.button.tabIndex === 0)?.seq : null;
  railObserver?.disconnect();
  railObserver = null;
  previewedButton = null;
  railPreview.hidden = true;
  railList.replaceChildren();
  railEntries = messages.map((message) => {
    const button = document.createElement("button");
    const seq = String(message.seq);
    const speaker = labels[message.speaker] || "Unknown";
    const time = formatTime(message.at);
    const plain = Array.from(message.text.replace(/\s+/g, " ").trim());
    const excerpt = plain.slice(0, 80).join("") + (plain.length > 80 ? "…" : "");
    button.type = "button";
    button.className = `rail-dash ${SEATS.includes(message.speaker) ? message.speaker : "human"}`;
    button.dataset.seq = seq;
    button.tabIndex = -1;
    button.setAttribute("aria-label", `${speaker}, ${time}: ${excerpt}`);
    button.setAttribute("aria-controls", `message-${seq}`);
    railList.append(button);
    return { seq, speaker, time, excerpt, button, article: document.getElementById(`message-${seq}`) };
  });
  const selected = railEntries.find((entry) => entry.seq === (focusedSeq || tabSeq)) ?? railEntries.at(-1);
  if (selected) selected.button.tabIndex = 0;
  sizeMessageRail();
  if (focusedSeq && selected && !rail.hidden) focusRailButton(selected.button);
}
function observeRailMessages() {
  const inset = messageInset();
  if (railObserver && railInset === inset) return;
  railObserver?.disconnect();
  railInset = inset;
  const byArticle = new Map(railEntries.map((entry) => [entry.article, entry]));
  for (const { button } of railEntries) {
    button.classList.remove("in-view");
    button.removeAttribute("aria-current");
  }
  railObserver = new IntersectionObserver((entries) => {
    for (const item of entries) {
      const button = byArticle.get(item.target)?.button;
      if (!button) continue;
      const visible = item.isIntersecting && item.intersectionRect.height > 0.5;
      button.classList.toggle("in-view", visible);
      if (visible) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
    if (!rail.hidden && !rail.matches(":hover, :focus-within")) {
      const current = railEntries.find((entry) => entry.button.classList.contains("in-view"));
      if (current) keepRailButtonVisible(current.button);
    }
  }, { root: $("#message-scroll"), rootMargin: `-${inset}px 0px 0px 0px`, threshold: [0, 0.000001, 0.01] });
  for (const entry of railEntries) railObserver.observe(entry.article);
}
railList.addEventListener("click", (event) => {
  const button = event.target.closest(".rail-dash");
  if (button) jumpToMessage(button);
});
railList.addEventListener("pointerover", (event) => previewMessage(event.target.closest(".rail-dash")));
rail.addEventListener("pointerleave", () => {
  if (rail.contains(document.activeElement)) previewMessage(document.activeElement);
  else railPreview.hidden = true;
});
railList.addEventListener("focusin", (event) => previewMessage(event.target));
rail.addEventListener("focusout", (event) => {
  if (!rail.contains(event.relatedTarget)) railPreview.hidden = true;
});
railList.addEventListener("scroll", () => { railPreview.hidden = true; });
railList.addEventListener("keydown", (event) => {
  const index = railEntries.findIndex((entry) => entry.button === event.target);
  if (index < 0) return;
  const next = event.key === "ArrowDown" ? Math.min(index + 1, railEntries.length - 1)
    : event.key === "ArrowUp" ? Math.max(index - 1, 0)
    : event.key === "Home" ? 0 : event.key === "End" ? railEntries.length - 1 : null;
  if (next !== null) { event.preventDefault(); focusRailButton(railEntries[next].button); }
  if (event.key === "Escape") {
    event.preventDefault();
    railEntries[index].article.focus({ preventScroll: true });
    railPreview.hidden = true;
  }
});
new ResizeObserver(sizeMessageRail).observe($("#message-area"));

// Finished work the AIs registered: exactly which version is ready, who reviewed it and how,
// and any link a participant reports publishing. Everything shown is escaped data.
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function webLink(url) {
  try {
    const link = new URL(url);
    return ["http:", "https:"].includes(link.protocol) && !link.username && !link.password ? link : null;
  } catch {
    return null;
  }
}
function artifactStatus(item) {
  if (item.availability === "changed") return ["attention", `Changed since v${Number(item.revision)}`];
  if (item.availability === "missing") return ["attention", "File missing"];
  if (item.availability !== "current") return ["attention", "Can’t be read"];
  return item.ready ? ["ready", "Ready"] : ["draft", "Draft"];
}
function artifactReviews(item) {
  const reviews = item.currentReviews ?? [];
  if (reviews.length)
    return reviews
      .map((review) => `${review.kind === "visual" ? "Visual" : "Source"} review by ${escape(labels[review.speaker] ?? review.speaker)}${review.kind === "visual" ? ` <span class="artifact-via">(${escape(review.via)})</span>` : ""}`)
      .join(" · ");
  if (item.availability !== "current")
    return item.reviews?.length ? "Earlier reviews don’t cover these changes" : "Not reviewed";
  return "Not reviewed yet";
}
function artifactCard(item) {
  const [tone, status] = artifactStatus(item);
  const extra = (item.files?.length ?? 1) - 1;
  const link = item.published && webLink(item.published.url);
  const published = item.published
    ? `<div class="artifact-line">${link ? `<a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">${escape(link.host + (link.pathname === "/" ? "" : link.pathname))} ↗</a>` : "Link"} · ${escape(item.published.access)} · reported by ${escape(labels[item.published.by] ?? item.published.by)} for v${Number(item.published.revision)}${item.publishedCurrent ? "" : ' <span class="artifact-warning">· an earlier version</span>'}</div>`
    : "";
  const files = (item.files ?? [])
    .map((file) => `<li><span>${escape(file.name)}</span><span>${escape(formatBytes(file.bytes))}</span></li>`)
    .join("");
  return `<article class="artifact" data-artifact-id="${escape(item.id)}" data-availability="${escape(item.availability)}"><div class="artifact-head"><strong class="artifact-title">${escape(item.title)}</strong><span class="artifact-status ${tone}">${escape(status)}</span></div><div class="artifact-meta">${escape(item.entry)}${extra > 0 ? ` + ${extra} ${extra === 1 ? "file" : "files"}` : ""} · ${escape(formatBytes(item.bytes))} · v${Number(item.revision)} · updated by ${escape(labels[item.updatedBy] ?? item.updatedBy)} ${escape(relativeTime(item.updatedAt).replace(/^Just now$/, "just now"))}</div><div class="artifact-line">${artifactReviews(item)}</div>${published}${item.preview?.available ? previewActions(item) : ""}<details class="artifact-files"><summary>${(item.files?.length ?? 1) === 1 ? "1 file" : `${item.files.length} files`}${item.preview?.available ? "" : ` · ${escape(item.preview?.reason ?? "No shared preview.")}`}</summary><code class="artifact-path">${escape(item.path)}</code><ul>${files}</ul><button type="button" data-copy-path="${escape(item.id)}">Copy path</button></details></article>`;
}
// A link issued for this exact version stays usable as a plain link until it expires, so a
// blocked pop-up never strands the person.
function previewActions(item) {
  const issued = state.previewLinks[item.id];
  const link =
    issued && issued.revision === Number(item.revision) && issued.sha256 === item.sha256 &&
    Date.parse(issued.expiresAt) > Date.now()
      ? webLink(issued.url)
      : null;
  return link
    ? `<div class="artifact-actions"><a class="artifact-open" href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">Open version ${Number(item.revision)} ↗</a><span>Link works until ${escape(formatTime(issued.expiresAt))}</span></div>`
    : `<div class="artifact-actions"><button type="button" data-preview="${escape(item.id)}">Open preview ↗</button><span>Version ${Number(item.revision)}, as registered</span></div>`;
}
function renderDeliverables(room, setup) {
  const panel = $("#deliverables");
  const items = room.artifacts ?? [];
  const open = !setup && items.length > 0 && state.deliverablesOpen === room.name;
  panel.hidden = !open;
  if (!open) return;
  const ready = items.filter((item) => item.ready).length;
  const attention = items.filter((item) => item.availability !== "current").length;
  const summary = `${ready} of ${items.length} ready${attention ? ` · ${attention} ${attention === 1 ? "needs" : "need"} a look` : ""}`;
  const markup = `<div class="deliverables-head"><strong>Deliverables</strong><span>${escape(summary)}</span><button type="button" class="deliverables-close" data-close-deliverables aria-label="Close deliverables">×</button></div><div class="deliverables-list">${items.map(artifactCard).join("")}</div>`;
  if (panel.renderedMarkup === markup && panel.dataset.room === room.name) return;
  const sameRoom = panel.dataset.room === room.name;
  const focused = panel.contains(document.activeElement) ? document.activeElement : null;
  const artifactId = focused?.closest("[data-artifact-id]")?.dataset.artifactId;
  const control = focused?.matches("summary") ? "summary" : focused?.matches("[data-copy-path]") ? "[data-copy-path]"
    : focused?.matches("[data-preview]") ? "[data-preview]" : focused?.matches(".artifact-open") ? ".artifact-open" : null;
  const expanded = sameRoom ? [...panel.querySelectorAll("details[open]")].map((node) => node.closest("[data-artifact-id]").dataset.artifactId) : [];
  const scroll = sameRoom ? panel.scrollTop : 0;
  panel.innerHTML = markup;
  panel.renderedMarkup = markup;
  panel.dataset.room = room.name;
  for (const id of expanded) {
    const details = panel.querySelector(`[data-artifact-id="${CSS.escape(id)}"] details`);
    if (details) details.open = true;
  }
  panel.scrollTop = scroll;
  if (focused && sameRoom) {
    const replacement = artifactId && control ? panel.querySelector(`[data-artifact-id="${CSS.escape(artifactId)}"] ${control}`) : null;
    (replacement || panel.querySelector(".deliverables-close"))?.focus({ preventScroll: true });
  }
}

// Keep the native select mounted through saves and polling, including room switches.
function renderLimit(room, setup) {
  const limit = room.turnLimit === undefined ? 4 : room.turnLimit;
  const bar = $("#limit-switch");
  bar.hidden = !!room.legacy;
  const saving = pendingLimits.has(room.name);
  const value = limitValue(saving ? pendingLimits.get(room.name) : limit);
  bar.dataset.room = room.name;
  bar.setAttribute("aria-busy", String(saving));
  const help = limitHelp(limit);
  bar.title = help;
  if (!$("#limit-select")) bar.innerHTML = `<label for="limit-select">Stop after</label><select id="limit-select" aria-describedby="limit-help">${limitOptions()}</select><span id="limit-help" class="sr-only"></span>`;
  const select = $("#limit-select");
  if (select.value !== value) select.value = value;
  select.disabled = saving;
  $("#limit-help").textContent = help;
}
// The new-conversation screen offers the same choice, and the conversation starts with it.
function renderStartLimit() {
  const bar = $("#start-limit");
  if (!$("#start-limit-select")) bar.innerHTML = `<label for="start-limit-select">Stop after</label><select id="start-limit-select" aria-describedby="start-limit-help">${limitOptions()}</select><span id="start-limit-help" class="sr-only"></span>`;
  const select = $("#start-limit-select");
  const value = limitValue(state.startLimit);
  if (select.value !== value) select.value = value;
  select.disabled = startBusy;
  bar.title = limitHelp(state.startLimit);
  $("#start-limit-help").textContent = limitHelp(state.startLimit);
}
// What sending does right now: start the conversation, speak mid-turn, or send normally.
function composerMode(room) {
  if (!room || room.legacy) return "closed";
  if (room.pending) return room.canInterject ? "interject" : "wait";
  if (room.opening?.state === "waiting") return "setup-input";
  if (!room.messages.length && waitingOn(room).length) return "opening";
  return "message";
}
function composerHint(room, mode) {
  const stale = room?.lock?.state === "stale";
  if (room && [...inFlight.values()].includes(room.name)) return "Sending…";
  if (mode === "setup-input")
    return `Add another thought anytime. ${labels[room.opening.to]} will read it with your first message once ${joinPhrase(room)} joined.`;
  if (mode === "opening")
    return `Your first message waits until ${joinPhrase(room)} joined, then goes to ${labels[state.recipient]}.`;
  if (stale) return "You can keep sending. Saved messages wait until the stopped process is recovered.";
  if (mode === "interject" && awaitingApproval(room))
    return `${labels[room.pending.speaker]} is waiting for your approval in ${hostApp(room.pending.speaker)}. It will read your message before replying.`;
  if (mode === "interject")
    return room.pending.state === "uncertain"
      ? "Your message is saved until the conversation continues."
      : `${reachesNow(room) ? `Your message reaches ${labels[room.pending.speaker]} at its next step, to guide the work in progress.` : `${labels[room.pending.speaker]} will read your message before replying.`} Approvals for ${labels[room.pending.speaker]} happen in ${hostApp(room.pending.speaker)}.`;
  if (mode === "wait")
    return "Your draft is saved here until the stick comes back to you.";
  if (mode === "message" && !room.connections[state.recipient].connected)
    return `Connect ${labels[state.recipient]} to send to them.`;
  return "Pick who replies first, then send.";
}
function updateComposer() {
  const room = state.room;
  const members = room?.members ?? SEATS;
  if (!members.includes(state.recipient)) state.recipient = members[0];
  const mode = composerMode(room);
  const canSend =
    $("#message").value.trim().length > 0 &&
    (mode === "interject" ||
      mode === "setup-input" ||
      mode === "opening" ||
      (mode === "message" && room.connections[state.recipient].connected));
  $("#send").disabled = !canSend;
  $("#message").disabled = mode === "closed";
  // While the opening waits, or while an AI works, the message goes to that AI: nothing to pick.
  $("#composer").classList.toggle("fixed-reply", mode === "setup-input" || mode === "interject");
  $("#recipient-label").textContent =
    mode === "interject" ? `To ${labels[room.pending.speaker]}`
      : mode === "setup-input" ? `To ${labels[room.opening.to]}`
        : room?.pending ? "Reply next" : "Reply first";
  $("#composer-hint").textContent = composerHint(room, mode);
  for (const button of document.querySelectorAll("[data-recipient]")) {
    button.hidden = !members.includes(button.dataset.recipient);
    const selected = button.dataset.recipient === state.recipient;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function updateStart() {
  for (const button of document.querySelectorAll("[data-member]")) {
    const on = state.startMembers.has(button.dataset.member);
    button.classList.toggle("selected", on);
    button.setAttribute("aria-pressed", String(on));
  }
  if (!state.startMembers.has(state.startRecipient))
    state.startRecipient = SEATS.find((speaker) =>
      state.startMembers.has(speaker),
    );
  for (const button of document.querySelectorAll("[data-start-recipient]")) {
    const speaker = button.dataset.startRecipient;
    const selected = speaker === state.startRecipient;
    button.hidden = !state.startMembers.has(speaker);
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  $("#start-send").disabled = startBusy || !$("#start-message").value.trim();
  renderStartLimit();
}

const canNotify = () =>
  "Notification" in window && Notification.permission === "granted";
function updateNotify() {
  $("#notify").hidden =
    !("Notification" in window) || Notification.permission !== "default";
}
// Tells you when the stick comes back to you while Semaphore is in the background.
function notifyTurns(rooms) {
  for (const room of rooms) {
    const before = state.owners[room.name];
    state.owners[room.name] = room.owner;
    if (
      !before ||
      before === "human" ||
      room.owner !== "human" ||
      room.lastMessage?.speaker === "human" ||
      !canNotify() ||
      (!document.hidden && document.hasFocus())
    )
      continue;
    let note;
    try {
      note = new Notification(`Your turn · ${room.title}`, {
        body: `${labels[room.lastMessage?.speaker] || "The group"} handed you the stick.`,
        tag: room.name,
      });
    } catch { continue; } // An OS notification failure must not mark the app offline.
    note.onclick = () => {
      window.focus();
      selectRoom(room.name);
      note.close();
    };
  }
}
// Tells you when an AI starts waiting for your approval in its own app.
function notifyApprovals(rooms) {
  for (const room of rooms) {
    const note = currentNote(room);
    const key = note?.kind === "approval" ? `${note.turnId}:${note.updatedAt}` : null;
    const seen = room.name in state.approvals;
    const before = state.approvals[room.name];
    state.approvals[room.name] = key;
    if (!seen || !key || key === before || !canNotify() || (!document.hidden && document.hasFocus()))
      continue;
    let alert;
    try {
      alert = new Notification(`Approval needed · ${room.title}`, {
        body: `${labels[note.speaker]} is waiting for your approval in ${hostApp(note.speaker)}: “${note.text}”`,
        tag: `${room.name}:approval`,
      });
    } catch { continue; } // An OS notification failure must not mark the app offline.
    alert.onclick = () => {
      window.focus();
      selectRoom(room.name);
      alert.close();
    };
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
    notifyTurns(list.rooms);
    notifyApprovals(list.rooms);
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

// The address bar names the open conversation. "push" adds a Back/Forward step, "replace"
// corrects the address in place, and "none" means the address already matches.
function setRoute(hash, mode) {
  const url = `/${location.search}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
  if (mode === "none" || `${location.pathname}${location.search}${location.hash}` === url) return;
  if (mode === "push") history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}
function routeTarget() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
}
// Follows a pasted link, an edited address or Back/Forward to the room it names.
async function followRoute() {
  const target = routeTarget();
  if (location.hash.length > 1 && !target) {
    toast("That link isn’t a conversation address.");
    return showHome(undefined, { route: "replace" });
  }
  if (target === (state.selected ?? "")) return;
  if (!target) return showHome(undefined, { route: "none" });
  if (!state.rooms.some((room) => room.name === target)) await refresh();
  if (state.rooms.some((room) => room.name === target))
    return selectRoom(target, { route: "none" });
  toast("That conversation wasn’t found. The link may be incomplete or the conversation removed.");
  showHome(undefined, { route: "replace" });
}
let renameGeneration = 0;
function closeRename() {
  renameGeneration++;
  $("#rename-form").hidden = true;
  $(".title-row").hidden = false;
  $(".rename-save").disabled = false;
}
async function selectRoom(name, { route = "push" } = {}) {
  closeRename();
  setDeliverablesOpen(false, { focus: false });
  if (state.selected)
    storageSet(`semaphore:draft:${state.selected}`, $("#message").value);
  state.selected = name;
  state.room = null;
  storageSet("semaphore:last-room", name);
  setRoute(name, route);
  $("#message").value = storageGet(`semaphore:draft:${name}`) || "";
  state.recipient = rememberedRecipient(name);
  closeSidebarDrawer();
  renderSidebar();
  try {
    const { room } = await api(`/rooms/${name}`);
    // A send the server never confirmed comes back into an empty box, oldest first;
    // sending it unchanged reuses its request ID.
    const open = settleCommitted(room).filter(
      (item) => !inFlight.has(item.clientId),
    );
    if (open.length && !$("#message").value.trim()) {
      try {
        const request = JSON.parse(open[0].fingerprint);
        $("#message").value = request.text;
        state.recipient = request.to;
        storageSet(`semaphore:draft:${name}`, request.text);
        storageSet(`semaphore:restored:${name}`, JSON.stringify({ text: request.text, clientId: open[0].clientId }));
        if (open.length > 1)
          toast(
            `${open.length} messages may not have been sent. The oldest is back in the box.`,
          );
      } catch {}
    }
    renderRoom(room, true);
  } catch (err) {
    toast(err.message);
  }
  fitComposer();
}

// Home is where a new conversation starts: one message, who joins, who replies first.
function showHome(prefill, { route = "push" } = {}) {
  setDeliverablesOpen(false, { focus: false });
  if (state.selected)
    storageSet(`semaphore:draft:${state.selected}`, $("#message").value);
  state.selected = null;
  state.room = null;
  storageSet("semaphore:last-room", "");
  setRoute("", route);
  $("#welcome").hidden = false;
  $("#conversation").hidden = true;
  $("#top-title").textContent = "New conversation";
  document.title = "Semaphore";
  closeSidebarDrawer();
  renderSidebar();
  const box = $("#start-message");
  box.value =
    typeof prefill === "string"
      ? prefill
      : storageGet("semaphore:start-draft") || "";
  if (prefill === undefined) {
    try {
      const pending = JSON.parse(storageGet("semaphore:start-request"));
      const saved = JSON.parse(pending.fingerprint);
      if (saved.text === box.value.trim()) {
        state.startMembers = new Set(saved.members);
        state.startRecipient = saved.to;
        state.startLimit = saved.maxTurns === undefined ? 4 : saved.maxTurns;
      }
    } catch {}
  }
  fitBox(box);
  updateStart();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}
async function connections() {
  if (!state.room) return;
  const name = state.room.name;
  $("#connect-title").textContent = "A seat for each mind.";
  $("#connect-body").textContent = "Preparing invitations…";
  showDialog("#connect-dialog");
  try {
    const invitations = await Promise.all(
      (state.room.members ?? SEATS).map((speaker) =>
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
        return `<section class="connect-card"><div class="connect-person">${avatar(speaker)}<div><strong>${labels[speaker]}</strong><small>${speaker === "astra" ? "Codex chat in ChatGPT" : "Code chat in Claude"}</small></div>${connected ? '<span class="connected-badge">Connected</span>' : ""}</div><p>${connected ? escape(connectionDescription(state.room, speaker)) : speaker === "claude" ? "Open Claude, confirm the project folder, then send the invitation. Or copy it into a Code chat you already have." : "Open a new chat with the invitation filled in, then send it. Or copy the invitation into a chat you already have."}</p><div class="connect-actions">${!connected ? `<a href="${escape(safeURL)}">${escape(invite.label || "Open app")} ↗</a>` : state.room.connections[speaker].url ? `<a href="${escape(state.room.connections[speaker].url)}">Open chat ↗</a>` : ""}<button data-copy-invite="${speaker}">${connected ? "Copy connection instructions" : "Copy invitation"}</button></div><details class="invite-details"><summary>View invitation</summary><pre class="invite-prompt">${escape(invite.prompt)}</pre></details></section>`;
      })
      .join("");
  } catch (err) {
    $("#connect-body").textContent = err.message;
  }
}

async function action(kind) {
  if (kind === "setup") return openSettings();
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

// Enter sends, like other chat apps; Shift+Enter adds a line. IME composition is left alone.
function sendOnEnter(box, form) {
  box.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing
    )
      return;
    event.preventDefault();
    form.requestSubmit();
  });
}

$("#new-room").addEventListener("click", () => showHome());
$("#limit-switch").addEventListener("change", async (event) => {
  if (event.target.id !== "limit-select" || !state.room) return;
  const name = state.room.name;
  if (pendingLimits.has(name)) return;
  const maxTurns = limitFromValue(event.target.value);
  const hadFocus = document.activeElement === event.target;
  pendingLimits.set(name, maxTurns);
  renderLimit(state.room);
  try {
    const { room } = await api(`/rooms/${name}/limit`, {
      method: "POST",
      body: { maxTurns },
    });
    pendingLimits.delete(name);
    renderRoom(room, true);
  } catch (err) {
    pendingLimits.delete(name);
    if (state.selected === name) {
      if (err.room) renderRoom(err.room, true);
      else if (state.room) renderLimit(state.room);
    }
    toast(err.message);
  }
  // Disabling during a save prevents out-of-order writes. Restore keyboard focus only
  // if the person hasn't moved to another control or conversation in the meantime.
  if (hadFocus && state.selected === name && document.activeElement === document.body)
    $("#limit-select")?.focus({ preventScroll: true });
});
$("#open-companion").addEventListener("click", () =>
  window.open(
    `/?view=companion${state.selected ? `#${encodeURIComponent(state.selected)}` : ""}`,
    "semaphore-companion",
    "popup,width=420,height=720",
  ),
);
$("#notify").addEventListener("click", async () => {
  await Notification.requestPermission();
  updateNotify();
  if (canNotify()) toast("We’ll let you know when the stick comes back to you.");
});
updateNotify();
for (const button of document.querySelectorAll("[data-starter]"))
  button.addEventListener("click", () => showHome(button.dataset.starter));
for (const button of document.querySelectorAll(".close-dialog"))
  button.addEventListener("click", () => button.closest("dialog").close());
$("#menu").addEventListener("click", toggleSidebar);
$("#new-room-top").addEventListener("click", () => showHome());
document.addEventListener("click", (event) => {
  if (sidebarIsDrawer() && $("#sidebar").classList.contains("open") &&
      !event.target.closest("#sidebar, #menu")) closeSidebarDrawer();
});
$("#search").addEventListener("input", renderSidebar);
$("#room-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-room]");
  if (button) selectRoom(button.dataset.room);
});
$("#manage-connections").addEventListener("click", connections);
$("#connection-guide").addEventListener("click", (event) => {
  if (event.target.closest("button")) connections();
});
// Opens an isolated preview of one registered version. The tab opens inside the click, so
// browsers allow it; it only learns its address once Semaphore has issued the link.
async function openPreview(room, button) {
  const item = (room.artifacts ?? []).find((artifact) => artifact.id === button.dataset.preview);
  if (!item || button.disabled) return;
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  button.disabled = true;
  try {
    const preview = await api(
      `/rooms/${encodeURIComponent(room.name)}/artifacts/${encodeURIComponent(item.id)}/preview`,
      { method: "POST", body: {} },
    );
    const link = webLink(preview.url);
    if (!link || link.protocol !== "http:" || link.hostname !== "127.0.0.1")
      throw new Error("Semaphore returned an unexpected preview address.");
    state.previewLinks[item.id] = { url: link.href, revision: Number(preview.revision), sha256: preview.sha256, expiresAt: preview.expiresAt };
    if (tab) {
      tab.location.replace(link.href);
      toast(`Opened version ${Number(preview.revision)}. The link works until ${formatTime(preview.expiresAt)}.`);
    } else toast("Your browser blocked the new tab. Use the “Open version” link on the card instead.");
    if (state.room?.name === room.name) renderDeliverables(state.room, false);
  } catch (err) {
    tab?.close();
    toast(err.message || "The preview couldn’t open. The files are still listed here.");
  } finally {
    button.disabled = false;
  }
}
// Renaming never takes the stick or sends anything; the server decides what a valid name is.
$("#rename").addEventListener("click", () => {
  if (!state.room) return;
  renameGeneration++;
  $(".title-row").hidden = true;
  $("#rename-form").hidden = false;
  $("#rename-input").value = state.room.title;
  $("#rename-input").focus();
  $("#rename-input").select();
});
$("#rename-cancel").addEventListener("click", closeRename);
$("#rename-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRename();
});
$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const room = state.room;
  const title = $("#rename-input").value;
  if (!room) return closeRename();
  if (title.replace(/\s+/g, " ").trim() === room.title && room.titleSource === "human") return closeRename();
  const save = $(".rename-save");
  if (save.disabled) return;
  const generation = renameGeneration;
  save.disabled = true;
  try {
    const result = await api(`/rooms/${encodeURIComponent(room.name)}/title`, {
      method: "POST",
      body: { title },
    });
    if (renameGeneration === generation && state.selected === room.name) closeRename();
    if (state.selected === room.name) renderRoom(result.room, true);
    await refresh();
    toast("Renamed.");
  } catch (err) {
    toast(err.message || "The name wasn’t saved.");
    if (renameGeneration === generation && state.selected === room.name) $("#rename-input").focus();
  } finally {
    if (renameGeneration === generation) save.disabled = false;
  }
});
$("#deliverables").addEventListener("click", async (event) => {
  const room = state.room;
  if (!room) return;
  if (event.target.closest("[data-close-deliverables]")) return setDeliverablesOpen(false);
  const preview = event.target.closest("[data-preview]");
  if (preview) return openPreview(room, preview);
  const button = event.target.closest("[data-copy-path]");
  const item = button && (room.artifacts ?? []).find((artifact) => artifact.id === button.dataset.copyPath);
  if (!item) return;
  try {
    await copyText(item.path);
    toast("Path copied. Open it from Finder or your editor.");
  } catch {
    toast("Select the path above and copy it.");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.deliverablesOpen) setDeliverablesOpen(false);
});
// The pill redraws the bar during its own click, so test the event's original path, not
// its (now detached) target.
document.addEventListener("click", (event) => {
  if (state.deliverablesOpen && !event.composedPath().some((node) => node.classList?.contains("status-area")))
    setDeliverablesOpen(false, { focus: false });
});
$("#state-banner").addEventListener("click", (event) => {
  if (event.target.closest("[data-deliverables]"))
    return setDeliverablesOpen(state.deliverablesOpen !== state.room?.name);
  const button = event.target.closest("[data-action]");
  if (button) action(button.dataset.action);
});
for (const button of document.querySelectorAll("[data-recipient]"))
  button.addEventListener("click", () => {
    state.recipient = button.dataset.recipient;
    storageSet("semaphore:recipient", state.recipient);
    if (state.selected)
      storageSet(`semaphore:recipient:${state.selected}`, state.recipient);
    updateComposer();
    $("#message").focus();
  });
$("#message").addEventListener("input", () => {
  if (state.selected) storageSet(`semaphore:restored:${state.selected}`, "null");
  if (state.selected)
    storageSet(`semaphore:draft:${state.selected}`, $("#message").value);
  // @GPT and @Astra both pick the ChatGPT seat.
  const mentioned = [
    ...$("#message").value.matchAll(/(?:^|\s)@(claude|astra|gpt)\b/gi),
  ].at(-1)?.[1].toLowerCase();
  const mention = mentioned === "gpt" ? "astra" : mentioned;
  if (
    mention &&
    mention !== state.recipient &&
    (state.room?.members ?? SEATS).includes(mention)
  ) {
    state.recipient = mention;
    if (state.selected)
      storageSet(`semaphore:recipient:${state.selected}`, mention);
  }
  fitComposer();
  updateComposer();
});
sendOnEnter($("#message"), $("#composer"));
sendOnEnter($("#start-message"), $("#start-form"));
addEventListener("resize", () => {
  fitComposer();
  fitBox($("#start-message"));
});
for (const button of document.querySelectorAll("[data-member]"))
  button.addEventListener("click", () => {
    const speaker = button.dataset.member;
    if (!state.startMembers.has(speaker)) state.startMembers.add(speaker);
    else if (state.startMembers.size > 1) state.startMembers.delete(speaker);
    updateStart();
  });
for (const button of document.querySelectorAll("[data-start-recipient]"))
  button.addEventListener("click", () => {
    state.startRecipient = button.dataset.startRecipient;
    storageSet("semaphore:recipient", state.startRecipient);
    updateStart();
    $("#start-message").focus();
  });
$("#start-limit").addEventListener("change", (event) => {
  if (event.target.id !== "start-limit-select") return;
  state.startLimit = limitFromValue(event.target.value);
  storageSet("semaphore:start-limit", event.target.value);
  updateStart();
});
$("#start-message").addEventListener("input", () => {
  storageSet("semaphore:start-draft", $("#start-message").value);
  fitBox($("#start-message"));
  updateStart();
});
$("#start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const box = $("#start-message");
  const text = box.value.trim();
  if (!text || startBusy) return;
  const members = SEATS.filter((speaker) => state.startMembers.has(speaker));
  const to = state.startRecipient;
  const maxTurns = state.startLimit;
  startBusy = true;
  updateStart();
  let previous;
  try { previous = JSON.parse(storageGet("semaphore:start-request")); } catch {}
  const { request, body } = prepareStartRequest({ text, to, members, maxTurns }, previous);
  storageSet("semaphore:start-request", JSON.stringify(request));
  try {
    const { room } = await api("/rooms/start", {
      method: "POST",
      body,
    });
    storageSet(`semaphore:recipient:${room.name}`, to);
    storageSet("semaphore:start-request", "");
    storageSet("semaphore:start-limit", "");
    state.startLimit = 4;
    box.value = "";
    storageSet("semaphore:start-draft", "");
    await selectRoom(room.name);
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    startBusy = false;
    updateStart();
  }
});
$("#messages").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-start], [data-copy-full]");
  if (!button || !state.room) return;
  const full = "copyFull" in button.dataset;
  const speaker = full ? button.dataset.copyFull : button.dataset.copyStart;
  const invite = state.invites[state.room.name]?.[speaker];
  if (!invite) return;
  const chat = speaker === "astra" ? "Codex chat in ChatGPT" : "Code chat in Claude";
  try {
    await copyText(full ? invite.fullPrompt : invite.prompt);
    toast(
      full
        ? `Full invitation copied. It works in a new ${chat}, even without the Semaphore skill.`
        : `Invitation copied. Paste it into a new ${chat} and press Send.`,
    );
  } catch {
    toast("Couldn’t copy it. Open “Manage members” to see the invitation.");
  }
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
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const room = state.room;
  if ($("#send").disabled || !room) return;
  const name = room.name;
  const text = $("#message").value;
  const mode = composerMode(room);
  // Input during a turn guides the AI at work, and never picks who speaks after it.
  const to = mode === "interject" ? room.pending.speaker : mode === "setup-input" ? room.opening.to : state.recipient;
  const opening = mode === "opening";
  // An unconfirmed identical send keeps its request ID. The core commits it with
  // the message, so an explicit retry cannot duplicate a delivered turn.
  const { clientId } = requestFor(
    name,
    JSON.stringify({ text, to, opening }),
  );
  inFlight.set(clientId, name);
  // Clear the box at once so the next thought can start; a failed send puts it back.
  $("#message").value = "";
  storageSet(`semaphore:draft:${name}`, "");
  fitComposer();
  updateComposer();
  try {
    const { room: updated } = await api(
      `/rooms/${name}/${opening ? "opening" : "messages"}`,
      {
        method: "POST",
        body: opening
          ? { text, to, members: room.members ?? SEATS, clientId }
          : { text, to, clientId },
      },
    );
    settleRequest(name, clientId);
    if (state.selected === name) renderRoom(updated);
    await refresh();
  } catch (err) {
    const confirmed = err.room ?? (state.selected === name ? state.room : null);
    const saved = !!confirmed?.messages.some(
      (message) => message.clientId === clientId,
    );
    const restored = saved ? false : restoreDraft(name, text, !!err.room, clientId);
    // Saved, or definitely refused: either way this request ID has nothing left to retry.
    if (saved || err.room) settleRequest(name, clientId);
    if (err.room && state.selected === name) renderRoom(err.room);
    toast(
      saved
        ? `Your message was saved. ${err.message}`
        : restored || err.room
          ? err.message
          : "Connection lost. Your last message may not have gone through; check the conversation before sending it again.",
    );
  } finally {
    inFlight.delete(clientId);
    if (state.selected === name) updateComposer();
  }
});
$("#connect-body").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-invite]");
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    await copyText(state.invite[button.dataset.copyInvite].prompt);
    button.textContent = "Copied ✓";
    toast("Invitation copied. Paste it into the native chat and send.");
  } catch {
    button.closest(".connect-card").querySelector("details").open = true;
    button.textContent = "Copy again";
    toast("Open “View invitation” and copy the text there.");
  } finally {
    button.disabled = false;
  }
});
// Asks before a change that reaches beyond Semaphore. Resolves true only on confirm.
function confirmAction({ title, text, action }) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = action;
  dialog.returnValue = "";
  showDialog("#confirm-dialog");
  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), {
      once: true,
    }),
  );
}
$("#confirm-ok").addEventListener("click", () => $("#confirm-dialog").close("ok"));
$("#confirm-cancel").addEventListener("click", () =>
  $("#confirm-dialog").close("cancel"),
);
const WAKE_STATES = {
  off: "Off",
  "needs-engine": "Needs Codex’s shared engine",
  "restart-chatgpt": "Almost on",
  on: "On",
  "turning-off": "Almost off",
  attention: "Needs attention",
};
function renderWake(wake) {
  $("#wake-card").hidden = !wake?.supported;
  if (!wake?.supported) return;
  $("#wake-toggle").setAttribute("aria-checked", String(wake.enabled));
  $("#wake-status").dataset.state = wake.state;
  $("#wake-status").innerHTML = `<strong>${escape(WAKE_STATES[wake.state] ?? wake.state)}</strong> · ${escape(wake.detail)}`;
  $("#wake-actions").innerHTML = ["restart-chatgpt", "turning-off"].includes(
    wake.state,
  )
    ? '<button type="button" class="primary-button" data-wake="restart">Restart ChatGPT now</button>'
    : "";
}
async function loadWake() {
  try {
    renderWake((await api("/wake")).wake);
  } catch {
    // An older background app has no instant wake yet.
    $("#wake-card").hidden = true;
  }
}
$("#wake-toggle").addEventListener("click", async () => {
  const turningOn = $("#wake-toggle").getAttribute("aria-checked") !== "true";
  if (
    turningOn &&
    !(await confirmAction({
      title: "Turn on instant wake?",
      text: "Semaphore adds a login item and a setting that points ChatGPT at Codex’s shared engine, then starts that engine. Every Codex chat in ChatGPT uses it once ChatGPT restarts. You can turn it off anytime.",
      action: "Turn on",
    }))
  )
    return;
  $("#wake-toggle").disabled = true;
  try {
    renderWake(
      (await api("/wake", { method: "POST", body: { enabled: turningOn } })).wake,
    );
  } catch (err) {
    toast(err.message);
    await loadWake();
  } finally {
    $("#wake-toggle").disabled = false;
  }
});
$("#wake-actions").addEventListener("click", async (event) => {
  if (!event.target.closest("[data-wake=restart]")) return;
  if (
    !(await confirmAction({
      title: "Restart ChatGPT now?",
      text: "ChatGPT quits and reopens. Any Codex task running there stops, so do this while no one is mid-reply.",
      action: "Restart ChatGPT",
    }))
  )
    return;
  $("#wake-status").textContent = "Restarting ChatGPT…";
  $("#wake-actions").innerHTML = "";
  try {
    renderWake(
      (await api("/wake/restart", { method: "POST", body: { confirm: true } }))
        .wake,
    );
  } catch (err) {
    toast(err.message);
    await loadWake();
  }
});
async function openSettings() {
  showDialog("#settings-dialog");
  loadWake();
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
}
$("#settings").addEventListener("click", openSettings);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("dialog[open]") && sidebarIsDrawer() && $("#sidebar").classList.contains("open"))
    closeSidebarDrawer();
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === "\\" && !$("dialog[open]")) {
    event.preventDefault();
    toggleSidebar();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showHome();
  }
});
await refresh();
const linked = routeTarget();
const initial = linked || storageGet("semaphore:last-room");
if (state.rooms.some((room) => room.name === initial))
  await selectRoom(initial, { route: "replace" });
else {
  if (linked)
    toast("That conversation wasn’t found. The link may be incomplete or the conversation removed.");
  showHome(undefined, { route: "replace" });
}
addEventListener("popstate", followRoute);
addEventListener("hashchange", followRoute);
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
