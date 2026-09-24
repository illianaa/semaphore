// Invoked only by the explicitly enabled Semaphore login item.
import { spawn, spawnSync } from 'node:child_process';
import { readWakeSettings, WAKE_FLAG } from './wake.mjs';
import { socketURL } from './codex-runtime.mjs';
const [settings, socket, codex] = process.argv.slice(2);
if (!settings || !socket || !codex) throw new Error('Missing shared runtime paths.');
if (!readWakeSettings(settings).enabled) process.exit(0);
const flag = spawnSync('/bin/launchctl', ['setenv', WAKE_FLAG, socketURL(socket)], { stdio: 'inherit' });
if (flag.status !== 0) process.exit(1);
// Preserve the app-tools override used by this desktop build. All other model,
// permission and plugin choices remain the person's normal Codex configuration.
const child = spawn(codex, ['-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
  'app-server', '--listen', `unix://${socket}`], { stdio: 'inherit' });
let stopping = false;
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { stopping = true; child.kill(signal); });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => process.exit(stopping ? 0 : code || 1));
