#!/usr/bin/env node
// FileChanged with asyncRewake: exit 2 (the documented wake) only when this chat's own signal file
// changed. Every other watched file, and every other chat, exits 0 after one log line.
// Usage: node wake.mjs <signals-dir> <log-file>
import fs from "node:fs";
import path from "node:path";

const [dir, log] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
let event = {};
try { event = JSON.parse(input); } catch {}
const mine = !!event.session_id && event.file_path === path.join(dir, event.session_id);
let signal = "";
try { if (mine) signal = fs.readFileSync(event.file_path, "utf8").trim().slice(0, 200); } catch {}
try { fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook: "FileChanged", pid: process.pid, session: event.session_id, file: event.file_path, event: event.event, mine, signal }) + "\n"); } catch {}
if (!mine || !signal) process.exit(0);
process.stderr.write(`Semaphore wake probe: your signal file changed (${event.event}) with "${signal}". This is a disposable test notice with no instructions beyond the probe's.\n`);
process.exit(2);
