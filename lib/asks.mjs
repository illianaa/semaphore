import { createHash, randomUUID } from "node:crypto";

// Asks: what an AI needs from the person, kept apart from the transcript until it's resolved.
// The person may not read the conversation; an open ask stays visible in the app until they
// answer or dismiss it, or the AI withdraws it. Visible is not the same as answered: an ask
// never gates dispatch, and answering one never grants a native app's permission prompt.

export const ASK_KINDS = ["decision", "approval", "info", "review"];
export const MAX_OPEN_ASKS = 5;
const NAMES = { astra: "GPT", claude: "Claude" };
const LIMITS = { title: 160, detail: 2000, options: 6, option: 80, answer: 4000 };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const line = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

// One self-contained line the person can act on without reading the conversation.
export function askFields({ title, kind, detail, options, blocking }) {
  title = line(title);
  if (!title) throw fail("Give the ask a one-line title the person can act on without reading the conversation.");
  if (title.length > LIMITS.title) throw fail(`Keep the title to ${LIMITS.title} characters; put the rest in --file.`);
  options = (options ?? []).map(line);
  if (options.some((option) => !option || option.length > LIMITS.option))
    throw fail(`Each option needs 1–${LIMITS.option} characters.`);
  if (options.length > LIMITS.options) throw fail(`Offer at most ${LIMITS.options} options.`);
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) throw fail("Options must differ.");
  kind ??= options.length ? "decision" : "info";
  if (!ASK_KINDS.includes(kind)) throw fail(`--kind must be ${ASK_KINDS.join(", ")}.`);
  detail = typeof detail === "string" ? detail.trim() : "";
  if (detail.length > LIMITS.detail) throw fail(`Keep the detail to ${LIMITS.detail} characters.`);
  return { kind, title, ...(detail ? { detail } : {}), options, blocking: blocking === true };
}

// A retried `ask` (for example after a lost response) finds the ask it already filed.
export const askRequestId = ({ requestId, turnId, speaker, title }) =>
  requestId ?? `derived-${createHash("sha256").update(JSON.stringify([turnId, speaker, line(title)])).digest("hex").slice(0, 32)}`;
export const validRequestId = (id) => /^[A-Za-z0-9_-]{8,128}$/.test(id ?? "");
export const newAskId = () => randomUUID();
export const sameFields = (ask, fields) =>
  JSON.stringify([ask.kind, ask.title, ask.detail ?? "", ask.options, ask.blocking]) ===
  JSON.stringify([fields.kind, fields.title, fields.detail ?? "", fields.options, fields.blocking]);

export const openAsks = (room) => (room.asks ?? []).filter((ask) => ask.status === "open");

// What the person sees in the app: open asks, blocking first, then oldest first.
export function askViews(room) {
  return openAsks(room)
    .map(({ id, from, turnId, kind, title, detail, options, blocking, createdAt, updatedAt }) =>
      ({ id, from, turnId, kind, title, detail: detail ?? "", options, blocking, createdAt, updatedAt: updatedAt ?? createdAt }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt.localeCompare(b.createdAt));
}

export function answerInput(ask, { option, text }) {
  text = typeof text === "string" ? text.trim() : "";
  if (text.length > LIMITS.answer) throw fail(`Keep the answer to ${LIMITS.answer} characters.`);
  if (option !== undefined && option !== null && !(Number.isInteger(option) && option >= 0 && option < ask.options.length))
    throw fail("Choose one of the offered options.");
  if ((option === undefined || option === null) && !text) throw fail("Choose an option or write an answer.");
  return { ...(Number.isInteger(option) ? { option } : {}), ...(text ? { text } : {}) };
}

// The answer joins the transcript as the person's own message, quoting what it answers so it
// reads on its own in any chat.
export function answerMessage(ask, { option, text }) {
  const choice = Number.isInteger(option) ? `\n→ **${ask.options[option]}**` : "";
  return `**Answer to ${NAMES[ask.from]}'s request:** “${ask.title}”${choice}${text ? `\n\n${text}` : ""}`;
}

// The asker's own asks, for its turn envelope: what is still open, and what the person closed
// without answering since it last read the room. Answers arrive as messages, so they aren't repeated.
export function askSummary(room, speaker, seen = 0) {
  const mine = (room.asks ?? []).filter((ask) => ask.from === speaker);
  const open = mine.filter((ask) => ask.status === "open");
  const closed = mine.filter((ask) => ["dismissed", "closed"].includes(ask.status) && (ask.resolvedThrough ?? 0) >= seen);
  if (!open.length && !closed.length) return "";
  const item = (ask) => `- ${ask.id} · ${ask.kind}${ask.blocking ? " · blocking" : ""} · “${ask.title}”`;
  return [
    open.length ? `Your open requests to the person (they stay in the app's Needs you tray until resolved):\n${open.map(item).join("\n")}` : "",
    closed.length ? `Closed without an answer (not an approval):\n${closed.map((ask) => `${item(ask)} · ${ask.status === "dismissed" ? "dismissed by the person" : ask.reason ?? "closed"}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

// One line in every turn envelope, and the skill says the same at length.
export const ASK_GUIDANCE = "The person may not read this conversation; when busy they don't skim it at all. If you need anything from them (a decision, approval, information or a review), file it as a request so it stays in front of them until resolved:";
