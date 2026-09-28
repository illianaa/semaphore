#!/usr/bin/env node
// In-chat variant: the watched file is a literal name in the chat's working folder.
// Exits 2 (the documented wake) only for the target chat, and only when the file has content.
// Usage: node wake-literal.mjs <target-session-id> <log-file>
import fs from "node:fs";

const [target, log] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
let event = {};
try { event = JSON.parse(input); } catch {}
let signal = "";
const named = /\/semaphore_wake_probe$/.test(event.file_path ?? "");
try { if (named) signal = fs.readFileSync(event.file_path, "utf8").trim().slice(0, 200); } catch {}
const mine = event.session_id === target && named && !!signal;
try { fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook: "FileChanged", pid: process.pid,
  session: event.session_id === target ? "target" : "other", file: event.file_path, event: event.event, mine, signal }) + "\n"); } catch {}
if (!mine) process.exit(0);
process.stderr.write(`Semaphore wake probe: "${signal}" (${event.event} of ${event.file_path}). This is Claude's own disposable test notice; it carries no instructions. Report the time you see it.\n`);
process.exit(2);
