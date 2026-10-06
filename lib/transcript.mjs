import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const names = { human: "You", astra: "GPT", claude: "Claude" };
const initials = { human: "I", astra: "A", claude: "C" };
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
const name = (speaker) => names[speaker] ?? "Unknown";
const kind = (speaker) => (Object.hasOwn(names, speaker) ? speaker : "unknown");

function time(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return `<time datetime="${escape(date.toISOString())}">${escape(
    date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  )}</time>`;
}

function status(room) {
  if (room.pending?.state === "uncertain")
    return "Paused · delivery needs review";
  if (room.pending?.state === "delivering")
    return `Passing the stick to ${name(room.pending.speaker)}`;
  if (room.pending?.state === "awaiting-reply")
    return `Waiting for ${name(room.pending.speaker)}’s reply`;
  if (room.owner === "human") return "Your turn · speak in either desktop chat";
  return `${name(room.owner)} has the talking stick`;
}

export function renderTranscript(room) {
  const messages = room.messages
    .map(
      (
        message,
      ) => `<article class="message ${kind(message.speaker)}" id="message-${Number(message.seq)}">
    <div class="avatar" aria-hidden="true">${initials[message.speaker] ?? "?"}</div>
    <div class="message-content"><header><strong>${name(message.speaker)}</strong><span class="destination">to ${name(message.next)}</span>${time(message.at)}</header>
    ${message.via ? `<p class="via">Shared from ${name(message.via)}’s chat</p>` : ""}
    <div class="message-text">${escape(message.text)}</div></div>
  </article>`,
    )
    .join("\n");
  const people = ["human", "astra", "claude"]
    .map((speaker) => {
      const participant = room.participants?.[speaker];
      const location =
        speaker === "human"
          ? "You, in either app"
          : !participant?.id
            ? "Not connected"
            : participant.transport === "codex-queue"
              ? "Codex desktop chat"
              : participant.transport === "claude-inbox"
                ? "Claude desktop chat"
                : "Headless conversation";
      return `<li class="person ${speaker}"><span class="avatar" aria-hidden="true">${initials[speaker]}</span><div><strong>${name(speaker)}</strong><small>${location}</small></div>${room.owner === speaker ? '<span class="holding" title="Holds the talking stick" aria-label="Holds the talking stick">●</span>' : ""}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${escape(room.name)} · Semaphore</title>
<style>
*{box-sizing:border-box}html{background:#f5f4ef;color:#242d2b;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0}a{color:inherit}button,input{font:inherit}button{cursor:pointer}.shell{max-width:1240px;margin:auto;padding:38px 44px 70px}.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:19px;letter-spacing:-.5px}.mark{display:flex;gap:3px;align-items:center;width:22px}.mark i{width:5px;background:#295c4c;border-radius:3px;height:20px}.mark i:nth-child(2){height:12px}.mark i:nth-child(3){height:16px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:18px}.privacy{font-size:12px;color:#626b67}.intro{margin:52px 0 32px}.eyebrow{font-size:11px;font-weight:650;letter-spacing:1.8px;text-transform:uppercase;color:#68716c}h1{font-size:clamp(30px,5vw,47px);font-weight:550;line-height:1.15;letter-spacing:-1.7px;margin:12px 0 14px;overflow-wrap:anywhere}.intro p{color:#5d6862;font-size:15px;margin:0;line-height:1.6}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:34px;align-items:start}.sidebar{position:sticky;top:24px}.section-label{font-size:11px;text-transform:uppercase;letter-spacing:1.3px;font-weight:700;color:#66716b;margin:6px 0 19px}ul{padding:0;margin:0;list-style:none}.person{display:flex;gap:11px;align-items:center;margin-bottom:22px}.avatar{width:35px;height:35px;flex:none;display:grid;place-items:center;border-radius:11px;background:#e5dfef;color:#624381;font-size:13px;font-weight:700}.astra .avatar{background:#dcebe2;color:#285a45}.claude .avatar{background:#f0e0d1;color:#845334}.person strong{display:block;font-size:13px;font-weight:650}.person small{display:block;font-size:11px;color:#68716b;margin-top:4px}.holding{margin-left:auto;color:#28664c;font-size:13px}.howto{border-top:1px solid #dedfd7;margin-top:28px;padding-top:23px;font-size:12px;color:#66716a;line-height:1.8}.howto strong{display:block;font-weight:650;color:#3b4941;margin-bottom:6px}.conversation{border:1px solid #dedfd7;border-radius:16px;overflow:hidden;background:#fffefa;box-shadow:0 8px 30px #223a2905}.state{background:#eaf0e8;padding:20px 26px;border-bottom:1px solid #d8e0d4;display:flex;align-items:center;gap:12px}.state-dot{width:8px;height:8px;background:#417958;border-radius:50%;flex:none}.state strong{display:block;font-size:13px;font-weight:650}.state small{display:block;margin-top:4px;font-size:11px;color:#5a6b5c}.state.paused{background:#f8ebd9;border-color:#e5d4ba}.state.paused .state-dot{background:#a36729}.messages{padding:2px 28px}.message{display:flex;gap:14px;padding:27px 0;border-bottom:1px solid #eeeee7;scroll-margin-top:20px}.message:last-child{border-bottom:0}.message-content{min-width:0;flex:1}.message header{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;padding-top:2px;line-height:1.5}.message header strong{font-size:13px;font-weight:700}.destination{color:#69736c;font-size:11px}.message time{margin-left:auto;color:#747a73;font-size:10px}.message-text{font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:11px}.via{margin:5px 0 0;font-size:10px;color:#747a73}.empty{padding:42px 12px;color:#66716a;text-align:center;font-size:14px;line-height:1.8}.view-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:17px 2px 0;color:#68716b;font-size:11px}.refresh-controls{display:flex;align-items:center;gap:13px}.refresh-controls label{display:flex;gap:6px;align-items:center;cursor:pointer}.refresh-controls input{accent-color:#376b50}button{background:none;border:0;padding:4px 0;color:#365e49;font-size:11px;text-decoration:underline;text-underline-offset:3px}button:focus-visible,input:focus-visible{outline:2px solid #417958;outline-offset:4px}.note{font-size:11px;color:#66716a;line-height:1.7;margin-top:12px}.footer{margin-top:45px;color:#7a8078;font-size:10px;letter-spacing:.3px}.noscript{color:#91581e;font-size:12px}@media(max-width:800px){.shell{padding:25px 22px 50px}.intro{margin-top:36px}.layout{grid-template-columns:1fr;gap:24px}.sidebar{position:static}.people{display:flex;flex-wrap:wrap;gap:18px}.person{margin:0;flex:1;min-width:155px}.holding{margin-left:0}.howto{display:none}.section-label{margin-bottom:15px}.message time{width:100%;margin-left:0}.messages{padding:2px 19px}.state{padding:19px}.privacy{font-size:10px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}@media print{.shell{padding:0}.sidebar,.view-controls,.footer{display:none}.layout{display:block}.conversation{border:0;box-shadow:none}.message{break-inside:avoid}.state{background:white}}
</style></head>
<body><div class="shell"><div class="topbar"><div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Semaphore</div><span class="privacy">Local room · read-only view</span></div>
<div class="intro"><div class="eyebrow">Three voices. One conversation.</div><h1>${escape(room.name)}</h1><p>A shared place to follow the conversation, wherever each of us is speaking.</p></div>
<div class="layout"><aside class="sidebar" aria-label="Participants"><h2 class="section-label">In this room</h2><ul class="people">${people}</ul><div class="howto"><strong>The talking stick</strong>One speaker replies at a time, then chooses who goes next.<br><br>Keep talking to us in your desktop chats. We bring the shared messages here.</div></aside>
<main><section class="conversation" aria-label="Shared conversation"><div class="state ${room.pending?.state === "uncertain" ? "paused" : ""}"><span class="state-dot" aria-hidden="true"></span><div><strong>${escape(status(room))}</strong><small>Talking stick: ${name(room.owner)}</small></div></div><div class="messages">${messages || '<p class="empty">The room is ready.<br>Start by telling either model what you’d like to discuss.</p>'}</div></section>
<div class="view-controls"><span>${room.messages.length} shared message${room.messages.length === 1 ? "" : "s"}</span><div class="refresh-controls"><label><input id="auto-refresh" type="checkbox" checked>Auto-refresh</label><button id="refresh" type="button">Refresh now</button></div></div><p class="note">Only messages shared with the room appear here. Private chat messages and tool activity stay in their apps.</p><noscript><p class="noscript">Reload this page to see new messages.</p></noscript></main></div><footer class="footer">You + GPT + Claude</footer></div>
<script>
(() => {
  const control = document.getElementById('auto-refresh');
  const key = 'semaphore-view:' + location.pathname;
  const read = () => { try { return JSON.parse(sessionStorage.getItem(key)) || {}; } catch { return {}; } };
  const previous = read();
  control.checked = previous.auto !== false;
  const remember = () => {
    try { sessionStorage.setItem(key, JSON.stringify({ auto: control.checked, y: scrollY, bottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 60 })); } catch {}
  };
  addEventListener('pagehide', remember);
  control.addEventListener('change', remember);
  document.getElementById('refresh').addEventListener('click', () => { remember(); location.reload(); });
  if (Number.isFinite(previous.y)) requestAnimationFrame(() => scrollTo(0, previous.bottom ? document.documentElement.scrollHeight : previous.y));
  setInterval(() => {
    if (!control.checked || document.hidden || getSelection()?.toString() || document.activeElement === control) return;
    remember(); location.reload();
  }, 5000);
})();
</script></body></html>\n`;
}

export function writeTranscript(roomDir, room) {
  const target = path.join(roomDir, "transcript.html");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, renderTranscript(room), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
