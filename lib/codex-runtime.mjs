import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

// A deliberately small, unsubscribed client. No resume, model/settings changes,
// tool execution or approval decisions are available through this connection.
const METHODS = new Set(['initialize', 'server/diagnostics', 'thread/loaded/list',
  'thread/read', 'thread/turns/list', 'thread/queue/list', 'thread/queue/add',
  'thread/queue/delete']);

export function socketURL(socket) {
  if (typeof socket !== 'string' || !socket.startsWith('/') || /[:?#%]/.test(socket))
    throw new Error('The shared runtime needs an absolute Unix socket path without URL delimiters.');
  // localhost also prevents ChatGPT's WebSocket connector selecting a proxy.
  return `ws+unix://localhost${socket}:/rpc`;
}

export class WakeClient extends EventEmitter {
  constructor({ socket, timeoutMs = 5000 } = {}) {
    super();
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.sequence = 0;
    this.socket = new WebSocket(socketURL(socket), { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Shared runtime connection timed out.')), timeoutMs);
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      this.socket.once('open', finish(resolve));
      this.socket.once('error', finish(reject));
      this.socket.once('close', finish(() => reject(new Error('Shared runtime closed before initialization.'))));
    });
    this.opened.catch(() => {});
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Shared Codex runtime disconnected.')));
    this.socket.on('message', data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { this.fail(new Error('Invalid shared runtime response.')); this.close(); return; }
      if (message.method) {
        if (message.id !== undefined) {
          // Never auto-decline/approve: this client is not an approval owner.
          this.emit('unexpectedRequest', message.method);
          return;
        }
        this.emit('notification', message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpc: true, code: message.error.code }));
      else pending.resolve(message.result);
    });
  }
  async initialize() {
    await this.opened;
    await this.request('initialize', { clientInfo: { name: 'semaphore_wake', version: '0.2.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  }
  request(method, params = {}) {
    if (!METHODS.has(method)) return Promise.reject(new Error(`Wake client cannot call ${method}.`));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Shared runtime ${method} timed out; its outcome may be uncertain.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error('Wake connection closed.')); this.socket.terminate(); }
}

export function processInfo(pid, run = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const result = run('/bin/ps', ['-p', String(pid), '-o', 'ppid=,lstart='], { encoding: 'utf8', timeout: 1000 });
  const match = result.status === 0 && String(result.stdout).trim().match(/^(\d+)\s+(.+)$/);
  return match ? { pid, parent: Number(match[1]), started: match[2] } : null;
}

export function ancestorPids({ pid = process.pid, run = spawnSync } = {}) {
  const ancestors = new Set();
  while (pid > 1 && !ancestors.has(pid) && ancestors.size < 32) {
    ancestors.add(pid);
    const info = processInfo(pid, run);
    if (!info) break;
    pid = info.parent;
  }
  return ancestors;
}

export async function loadedThreads(client) {
  const all = []; let cursor;
  do {
    const page = await client.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    all.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  return all;
}

export async function verifyNativeSeat({ client, threadId, socket, run = spawnSync, pid = process.pid }) {
  const { process: runtime } = await client.request('server/diagnostics');
  if (!ancestorPids({ pid, run }).has(runtime.id))
    throw new Error('This chat is not running in Semaphore’s shared Codex engine. Reopen it after restarting ChatGPT.');
  if (!(await loadedThreads(client)).includes(threadId))
    throw new Error('This chat is not loaded in the shared Codex engine.');
  const info = processInfo(runtime.id, run);
  if (!info) throw new Error('The shared Codex engine stopped during verification.');
  return { socket, pid: runtime.id, started: info.started, verifiedAt: new Date().toISOString() };
}

export function sameRuntime(verification, { socket, run = spawnSync } = {}) {
  return !!verification && verification.socket === socket &&
    processInfo(verification.pid, run)?.started === verification.started;
}
