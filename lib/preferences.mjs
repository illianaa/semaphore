import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The person's app-wide choices, kept beside the conversations they apply to. Room names start
// with a letter or digit, so this dotfile is never mistaken for a room.
const FILE = ".preferences.json";
const DEFAULTS = { startLimit: 4 };

export const validLimit = (limit) => limit === null || (Number.isInteger(limit) && limit >= 1 && limit <= 20);

export function readPreferences(root) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8")); } catch {}
  return { startLimit: saved && validLimit(saved.startLimit) ? saved.startLimit : DEFAULTS.startLimit };
}

export function writePreferences(root, changes) {
  const next = { ...readPreferences(root) };
  if ("startLimit" in changes) {
    if (!validLimit(changes.startLimit)) throw new Error("Choose a limit of 1 to 20 replies, or no limit.");
    next.startLimit = changes.startLimit;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
  return next;
}
