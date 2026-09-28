#!/usr/bin/env node
// CwdChanged: register this chat's own signal file (an absolute path outside the working folder),
// the same registration a SessionStart hook would make. Usage: node register-cwd.mjs <dir> <log>
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
try { fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook: event.hook_event_name, cwd: event.cwd, session: event.session_id, signal }) + "\n"); } catch {}
// The installed runtime reads hookSpecificOutput.watchPaths, not a top-level watchPaths.
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name ?? "CwdChanged", watchPaths: [signal] } }));
