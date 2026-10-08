// How a request ("ask") reads in the Needs you tray. Pure functions, shared by the app and tests.

const LONG_WORDS = 60;
const LONG_OPTION = 32;
const MAX_INLINE_OPTIONS = 3;
const LONG_TITLE = 140;

export const wordCount = (text) => (String(text ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’.,/:$%-]*/gu) ?? []).length;

// A request answers in its card only when all of it fits there. Anything longer gets a summary
// card that opens the full reader, so nothing is ever cut off mid-card.
export function isLong(ask) {
  const options = ask?.options ?? [];
  return wordCount(ask?.detail) > LONG_WORDS || (ask?.title?.length ?? 0) > LONG_TITLE || options.length > MAX_INLINE_OPTIONS ||
    options.some((option) => option.length > LONG_OPTION);
}

// The first prose paragraph of the detail as plain text: headings, tables, code and list markers
// are skipped or stripped, so a 3-line preview never shows "## Context" or a table rule.
export function plainPreview(markdown, limit = 320) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = [];
  let current = [];
  let fenced = false;
  const flush = () => { if (current.length) paragraphs.push(current.join(" ")); current = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; flush(); continue; }
    if (fenced) continue;
    if (!line || /^#{1,6}\s/.test(line) || /^\|/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^>/.test(line)) { flush(); continue; }
    current.push(line.replace(/^([-*+]|\d+[.)])\s+/, ""));
  }
  flush();
  const text = (paragraphs[0] ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=$|[^\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

// "412 words · 6 options", for the summary card and the reader.
export function sizeLabel(ask) {
  const words = wordCount(ask?.detail);
  const options = ask?.options?.length ?? 0;
  return [words ? `${words} ${words === 1 ? "word" : "words"}` : "", options ? `${options} ${options === 1 ? "option" : "options"}` : ""]
    .filter(Boolean).join(" · ");
}
