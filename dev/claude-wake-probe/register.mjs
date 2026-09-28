#!/usr/bin/env node
// SessionStart: give this chat its own signal file and ask Claude Code to watch it.
// Usage: node register.mjs <signals-dir> <log-file>
import fs from "node:fs";
import path from "node:path";

const [dir, log] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
let event = {};
try { event = JSON.parse(input); } catch {}
if (!/^[A-Za-z0-9-]{8,64}$/.test(event.session_id ?? "")) process.exit(0);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const signal = path.join(dir, event.session_id);
if (!fs.existsSync(signal)) fs.writeFileSync(signal, "", { mode: 0o600 });
try { fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook: "SessionStart", source: event.source ?? event.session_start_reason, session: event.session_id, signal }) + "\n"); } catch {}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: [signal] } }));
