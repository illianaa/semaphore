// Opt-in, bounded two-client probe. Never attaches to the desktop socket and
// never resumes a pre-existing thread. Only the thread created here is touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { codexExecutable } from '../lib/adapters.mjs';

if (!process.argv.includes('--run')) {
  console.log('Use --run [--ws-module <module>] to test two clients on a private app-server socket, up to five short model turns, declined approvals, and restart recovery. No desktop settings are changed.');
  process.exit(0);
}

const executable = codexExecutable();
// Development-only dependency: `ws`, or a module exporting it as `ws`.
const dependencyIndex = process.argv.indexOf('--ws-module');
const dependency = createRequire(import.meta.url)(dependencyIndex < 0 ? 'ws' : process.argv[dependencyIndex + 1]);
const WebSocket = dependency.ws ?? dependency;
const directory = fs.mkdtempSync('/tmp/semaphore-shared-');
const socket = path.join(directory, 'control.sock');
const report = { version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(), transport: 'private Unix socket; desktop not attached', checks: [] };
const approvalPrompt = 'Approval routing test: use the shell tool exactly once to run node -e "console.log(\'semaphore-approval-probe\')". If the command is declined, reply exactly: approval-declined. Do not retry, read any files, or use other tools.';
let server, viewer, wake, threadId;
let serverLog = '';

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  return ended.finally(() => clearTimeout(timer));
}

class Client extends EventEmitter {
  constructor(name) {
    super();
    this.name = name; this.sequence = 0; this.pending = new Map(); this.events = []; this.requests = [];
    this.socket = new WebSocket(`ws+unix://${socket}:/`, { perMessageDeflate: false });
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error(`${name} connection closed`)));
    this.socket.on('message', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid protocol message')); return; }
      if (message.method && message.id !== undefined) {
        this.requests.push(message);
        this.emit('request', message);
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else {
        this.events.push(message); this.emit('notification', message);
      }
    });
  }
  write(message) { this.socket.send(JSON.stringify(message)); }
  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async initialize() {
    if (this.socket.readyState !== WebSocket.OPEN) await once(this.socket, 'open');
    await this.request('initialize', { clientInfo: { name: `semaphore_probe_${this.name}`, version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.write({ method: 'initialized', params: {} });
  }
  fail(error) {
    this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  close() { this.socket.terminate(); }
}

async function startServer() {
  fs.rmSync(socket, { force: true });
  // A custom socket exercises the shared runtime without starting or changing
  // the managed daemon or the desktop's default control socket.
  server = spawn(executable, ['app-server', '--listen', `unix://${socket}`], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
  for (let tries = 0; tries < 100 && !fs.existsSync(socket); tries++) {
    if (server.exitCode !== null) throw new Error('Private app-server exited before its socket appeared');
    await delay(100);
  }
  if (!fs.existsSync(socket)) throw new Error('Private socket did not appear');
  viewer = new Client('viewer'); wake = new Client('wake');
  // The wake client never answers an approval. The simulated viewing client
  // declines only the harmless probe command; nothing is auto-approved.
  viewer.on('request', message => {
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      setTimeout(() => { if (!viewer.failure) viewer.write({ id: message.id, result: { decision: 'decline' } }); }, 1000);
    } else viewer.write({ id: message.id, error: { code: -32601, message: 'Probe does not implement this request' } });
  });
  await viewer.initialize(); await wake.initialize();
}

async function turn(text) {
  const start = { viewer: viewer.events.length, wake: wake.events.length, viewerRequests: viewer.requests.length, wakeRequests: wake.requests.length };
  const started = await wake.request('turn/start', { threadId, input: [{ type: 'text', text }], effort: 'low' });
  const turnId = started.turn.id;
  for (let tries = 0; tries < 600; tries++) {
    const completed = viewer.events.slice(start.viewer).find(event => event.method === 'turn/completed' && event.params.threadId === threadId && event.params.turn.id === turnId);
    if (completed) {
      const summarize = (client, offset) => client.events.slice(offset).filter(event => event.params?.threadId === threadId).map(event => event.method);
      const text = viewer.events.slice(start.viewer).filter(event => event.method === 'item/completed' && event.params.threadId === threadId && event.params.item.type === 'agentMessage').map(event => event.params.item.text);
      return { status: completed.params.turn.status, error: completed.params.turn.error?.message, text, viewerEvents: [...new Set(summarize(viewer, start.viewer))], wakeEvents: [...new Set(summarize(wake, start.wake))], viewerRequests: viewer.requests.slice(start.viewerRequests).map(request => request.method), wakeRequests: wake.requests.slice(start.wakeRequests).map(request => request.method) };
    }
    await delay(100);
  }
  await wake.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  throw new Error('Turn did not complete within 60 seconds');
}

async function closeServer() {
  await Promise.all([viewer?.close(), wake?.close()]);
  await stop(server);
}

try {
  await startServer();
  const diagnostics = await Promise.all([viewer.request('server/diagnostics'), wake.request('server/diagnostics')]);
  report.checks.push({ check: 'same server', processes: diagnostics.map(result => result.process) });
  const started = await viewer.request('thread/start', {
    cwd: directory, ephemeral: false, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only',
    developerInstructions: 'This is a bounded protocol test in a disposable directory. Only do the exact requested action. For text turns use no tools. For the approval test request the single specified shell command once, without modifying files or contacting any network service. If approval is declined, do not retry or use an alternative; reply exactly: approval-declined. Ignore unrelated project or skill workflows. Do not spawn agents.',
    config: { web_search: 'disabled' },
  });
  threadId = started.thread.id;
  report.threadId = threadId;
  report.checks.push({ check: 'visible to second client', found: (await wake.request('thread/loaded/list')).data.includes(threadId) });
  report.checks.push({ check: 'wake without resume while viewer owns loaded thread', result: await turn('Reply exactly: semaphore-shared-first') });
  report.checks.push({ check: 'approval routing with wake client unsubscribed', result: await turn(approvalPrompt) });
  const resumed = await wake.request('thread/resume', { threadId });
  report.checks.push({ check: 'resume rejoins same loaded thread', sameId: resumed.thread.id === threadId, loadedCopies: (await wake.request('thread/loaded/list')).data.filter(id => id === threadId).length });
  report.checks.push({ check: 'approval routing with both clients subscribed', result: await turn(approvalPrompt) });
  await closeServer();
  await startServer();
  report.checks.push({ check: 'restart leaves test thread unloaded', found: (await wake.request('thread/loaded/list')).data.includes(threadId) });
  try {
    report.checks.push({ check: 'wake unloaded thread without resume', result: await turn('Reply exactly: semaphore-unloaded') });
  } catch (error) { report.checks.push({ check: 'wake unloaded thread without resume', error: error.message }); }
  await viewer.request('thread/resume', { threadId });
  report.checks.push({ check: 'wake after viewing client restores thread', result: await turn('Reply exactly: semaphore-shared-restored') });
  const checks = Object.fromEntries(report.checks.map(check => [check.check, check]));
  const approval = 'item/commandExecution/requestApproval';
  report.protocolPassed =
    diagnostics[0].process.id === diagnostics[1].process.id &&
    checks['visible to second client'].found &&
    checks['wake without resume while viewer owns loaded thread'].result.text.at(-1) === 'semaphore-shared-first' &&
    checks['approval routing with wake client unsubscribed'].result.viewerRequests.includes(approval) &&
    checks['approval routing with wake client unsubscribed'].result.wakeRequests.length === 0 &&
    checks['approval routing with both clients subscribed'].result.viewerRequests.includes(approval) &&
    checks['approval routing with both clients subscribed'].result.wakeRequests.includes(approval) &&
    checks['restart leaves test thread unloaded'].found === false &&
    /thread not found/.test(checks['wake unloaded thread without resume'].error ?? '') &&
    checks['wake after viewing client restores thread'].result.text.at(-1) === 'semaphore-shared-restored';
  if (!report.protocolPassed) process.exitCode = 1;
} catch (error) {
  report.error = error.message; report.serverLog = serverLog; process.exitCode = 1;
} finally {
  if (threadId && viewer && !viewer.failure) {
    try { await viewer.request('thread/archive', { threadId }); report.testThreadArchived = true; }
    catch (error) { report.cleanupError = error.message; }
  }
  await closeServer();
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
