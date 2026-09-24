// Bounded feasibility probe. Never resumes or changes a desktop task.
// --roundtrip additionally creates one ephemeral custom-client thread and sends
// two harmless text turns. This is not proof of desktop attachment or approvals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexClient, codexExecutable } from '../lib/adapters.mjs';

const executable = codexExecutable();
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
const host = spawnSync(executable, ['app-server', 'daemon', 'version'], { encoding: 'utf8', timeout: 5000 });
const report = {
  executable, version: version.stdout.trim(),
  desktopControl: host.status === 0 ? 'daemon responds; desktop ownership still unverified' : 'unavailable',
  desktopControlDetail: host.status === 0 ? 'A daemon response alone is not proof that the desktop uses that runtime.' : host.stderr.trim(),
  desktopCreateWakeApprovalsRecovery: 'not established',
  customClient: 'not tested',
};
if (process.argv.includes('--roundtrip')) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-codex-probe-'));
  const client = new CodexClient({ cwd, executable });
  try {
    await client.initialize();
    const started = await client.request('thread/start', {
      cwd, ephemeral: true, approvalPolicy: 'untrusted', sandbox: 'read-only',
      developerInstructions: 'This is a bounded transport test. Do not use tools, read files, change files, or contact anyone. Reply with only the text requested.',
      config: { web_search: 'disabled' },
    });
    const threadId = started.thread.id;
    async function turn(text) {
      let timer, notify, closed;
      const completed = new Promise((resolve, reject) => {
        const messages = [];
        notify = ({ method, params }) => {
          if (params.threadId !== threadId) return;
          if (method === 'item/completed' && params.item.type === 'agentMessage') messages.push(params.item.text);
          if (method === 'turn/completed') resolve({ status: params.turn.status, text: messages.at(-1) ?? '', error: params.turn.error?.message });
        };
        closed = reject;
        client.on('notification', notify); client.on('closed', closed);
        timer = setTimeout(() => reject(new Error('Probe turn timed out after 60 seconds.')), 60000);
      });
      // Attach a rejection handler before the request, so a transport failure has
      // no unhandled rejection while request() itself is being rejected.
      completed.catch(() => {});
      try {
        await client.request('turn/start', { threadId, input: [{type:'text', text}] });
        return await completed;
      } finally { clearTimeout(timer); client.off('notification', notify); client.off('closed', closed); }
    }
    const first = await turn('Reply exactly: semaphore-first');
    const second = first.status === 'completed' ? await turn('Reply exactly: semaphore-later') : null;
    report.customClient = { ephemeral: started.thread.ephemeral, first, later: second };
    report.approvals = 'Native desktop approval display not tested; probe client declines tool approvals.';
    report.recovery = 'No existing native task was resumed; desktop recovery remains unverified.';
  } catch (error) { report.customClient = { error: error.message }; }
  finally { client.close(); fs.rmSync(cwd, { recursive:true, force:true }); }
}
console.log(JSON.stringify(report, null, 2));
