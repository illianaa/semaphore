import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPaths } from './install.mjs';
import { socketURL, wakeWebSocket } from './codex-runtime.mjs';

export const WAKE_LABEL = 'local.semaphore.codex-wake';
export const WAKE_FLAG = 'CODEX_APP_SERVER_WS_URL';
export const CHATGPT_BUNDLE = 'com.openai.codex';
const MARKER = 'Installed by Semaphore';
const output = result => String(result?.stdout ?? '').trim();
const failure = (result, fallback) => (String(result?.stderr ?? '') || output(result) || result?.error?.message || fallback).trim();
const ours = file => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER);
const xml = value => String(value).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

export function wakePaths({ home = os.homedir(), env = process.env } = {}) {
  const { dataHome, logs } = installPaths({ home, env });
  const app = '/Applications/ChatGPT.app';
  return { settings: path.join(dataHome, 'wake.json'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${WAKE_LABEL}.plist`),
    log: path.join(logs, 'codex-wake.log'), app,
    codex: path.join(app, 'Contents', 'Resources', 'codex'),
    socket: path.join(dataHome, 'codex-wake', 'control.sock'),
    runner: fileURLToPath(new URL('./wake-runner.mjs', import.meta.url)), node: process.execPath };
}
export function readWakeSettings(file = wakePaths().settings) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}
function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function wakeAgent(paths) {
  const args = [paths.node, paths.runner, paths.settings, paths.socket, paths.codex];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARKER} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${WAKE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(paths.log)}</string>
<key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict></plist>\n`;
}

export function chatgptState(run = spawnSync, app = wakePaths().app) {
  const ps = run('ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding:'utf8', timeout:5000 });
  if (ps.status !== 0) return { running: null, engine: 'unknown', startedAt: null };
  const rows = String(ps.stdout ?? '').split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/)).filter(Boolean)
    .map(([,pid,ppid,started,command]) => ({ pid:Number(pid), ppid:Number(ppid), startedAt:Date.parse(started), command }));
  const main = `${app}/Contents/MacOS/ChatGPT`;
  const appProcess = rows.find(row => row.command === main || row.command.startsWith(`${main} `));
  if (!appProcess) return { running:false, engine:null, startedAt:null };
  const privateEngine = rows.some(row => row.ppid === appProcess.pid && /\/codex\b.*\bapp-server\b/.test(row.command));
  // No private child is not proof of attachment: the app may still be starting.
  return { running:true, pid:appProcess.pid, engine:privateEngine ? 'private' : 'unknown',
    startedAt:Number.isFinite(appProcess.startedAt) ? new Date(appProcess.startedAt).toISOString() : null };
}
function engineState(run, paths, uid) {
  const result = run('launchctl', ['print', `gui/${uid}/${WAKE_LABEL}`], { encoding:'utf8', timeout:3000 });
  const pid = Number(output(result).match(/\bpid = (\d+)/)?.[1]);
  return { installed:fs.existsSync(paths.codex), running:result.status === 0 && pid > 0 && fs.existsSync(paths.socket), pid:pid || null };
}
export function wakeStatus(options = {}) {
  const { run = spawnSync, platform = process.platform, uid = process.getuid?.() } = options;
  const paths = options.paths ?? wakePaths(options);
  if (platform !== 'darwin' || !fs.existsSync(paths.codex))
    return { supported:false, enabled:false, state:'unsupported', detail:'Instant wake needs macOS and the ChatGPT desktop app.' };
  const settings = readWakeSettings(paths.settings);
  const enabled = settings.enabled === true;
  const configuredURL = output(run('launchctl', ['getenv', WAKE_FLAG], { encoding:'utf8', timeout:3000 }));
  const flag = configuredURL === socketURL(paths.socket);
  const agent = ours(paths.plist);
  const engine = engineState(run, paths, uid);
  const chatgpt = chatgptState(run, paths.app);
  let state, detail;
  if (!enabled) {
    if (settings.pendingStop && engine.running) { state='turning-off'; detail='Restart ChatGPT to disconnect the shared engine and finish turning instant wake off.'; }
    else if (flag || agent) { state='attention'; detail='Instant wake is off, but its setup needs cleanup. Turn it off again.'; }
    else { state='off'; detail='GPT waits for its turn inside its ChatGPT chat.'; }
  } else if (!flag || !agent || !engine.running) {
    state='attention'; detail='The shared engine is not ready. Turn instant wake off and on again.';
  } else if (chatgpt.engine === 'private') {
    state='restart-chatgpt'; detail='Restart ChatGPT to connect it to the shared engine.';
  } else {
    state='on'; detail='The shared engine is ready. Each GPT chat verifies its connection before automatic wake is used.';
  }
  return { supported:true, enabled, state, detail, flag, agent, engine, chatgpt,
    enabledAt:settings.enabledAt ?? null, disabledAt:settings.disabledAt ?? null, restartedAt:settings.restartedAt ?? null };
}
function unload(run, paths, uid) {
  if (fs.existsSync(paths.plist) && !ours(paths.plist)) throw new Error('Refusing to unload a login item not written by Semaphore.');
  run('launchctl', ['bootout', `gui/${uid}/${WAKE_LABEL}`], { encoding:'utf8', timeout:5000 });
  if (ours(paths.plist)) fs.rmSync(paths.plist);
}
function unsetOwnFlag(run, paths) {
  const value = output(run('launchctl', ['getenv', WAKE_FLAG], { encoding:'utf8', timeout:3000 }));
  if (value === socketURL(paths.socket)) {
    const result = run('launchctl', ['unsetenv', WAKE_FLAG], { encoding:'utf8', timeout:3000 });
    if (result.status !== 0) throw new Error(`Could not remove the wake setting: ${failure(result, 'launchctl failed')}`);
  }
}
export function enableWake(options = {}) {
  const { run = spawnSync, uid = process.getuid?.(), pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms) } = options;
  const paths = options.paths ?? wakePaths(options);
  const before = wakeStatus({...options,paths});
  if (!before.supported) throw Object.assign(new Error(before.detail),{status:409});
  wakeWebSocket(); // Missing optional dependencies must fail before changing host settings.
  const target = socketURL(paths.socket);
  const previousURL = output(run('launchctl',['getenv',WAKE_FLAG],{encoding:'utf8',timeout:3000}));
  if (previousURL && previousURL !== target) throw new Error('ChatGPT already uses another explicit engine. Its setting was left unchanged.');
  if (output(run('launchctl',['getenv','CODEX_APP_SERVER_FORCE_CLI'],{encoding:'utf8',timeout:3000})) === '1')
    throw new Error('ChatGPT is explicitly configured to force its private engine. That setting was left unchanged.');
  if (fs.existsSync(paths.plist) && !ours(paths.plist)) throw new Error(`${paths.plist} exists and wasn't written by Semaphore.`);
  if (before.enabled && before.engine.running && before.flag) return before;
  if (before.engine.running) throw new Error('Finish restarting ChatGPT to turn the old connection off before enabling it again.');
  fs.mkdirSync(path.dirname(paths.plist),{recursive:true});
  fs.mkdirSync(path.dirname(paths.log),{recursive:true});
  fs.mkdirSync(path.dirname(paths.socket),{recursive:true,mode:0o700});
  const previous = readWakeSettings(paths.settings);
  writeSettings(paths.settings,{...previous,enabled:true,enabledAt:new Date().toISOString(),disabledAt:null,pendingStop:false});
  try {
    fs.writeFileSync(paths.plist,wakeAgent(paths),{mode:0o600});
    const flag = run('launchctl',['setenv',WAKE_FLAG,target],{encoding:'utf8',timeout:3000});
    if (flag.status !== 0) throw new Error(failure(flag,'Could not set the shared engine URL.'));
    run('launchctl',['bootout',`gui/${uid}/${WAKE_LABEL}`],{encoding:'utf8',timeout:5000});
    let result;
    for (let attempt=0;attempt<12;attempt++) {
      result=run('launchctl',['bootstrap',`gui/${uid}`,paths.plist],{encoding:'utf8',timeout:5000});
      if (result.status !== 5) break;
      pause(250);
    }
    if (result.status !== 0) throw new Error(failure(result,'Could not register the shared engine.'));
    // launchd can defer RunAtLoad for a speculative launch; start it now, as the installer does.
    run('launchctl',['kickstart',`gui/${uid}/${WAKE_LABEL}`],{encoding:'utf8',timeout:5000});
    for (let attempt=0;attempt<40;attempt++) {
      if (engineState(run,paths,uid).running) return wakeStatus({...options,paths});
      pause(250);
    }
    throw new Error('The shared engine did not start. Check the Semaphore wake log.');
  } catch (error) {
    unload(run,paths,uid); unsetOwnFlag(run,paths);
    writeSettings(paths.settings,{...previous,enabled:false,pendingStop:false,lastError:error.message});
    throw error;
  }
}
export function disableWake(options = {}) {
  const { run = spawnSync, uid = process.getuid?.() } = options;
  const paths = options.paths ?? wakePaths(options);
  if (fs.existsSync(paths.plist) && !ours(paths.plist)) throw new Error('Refusing to remove a login item not written by Semaphore.');
  const chatgpt = chatgptState(run,paths.app);
  const keepEngine = chatgpt.running !== false && chatgpt.engine !== 'private' && engineState(run,paths,uid).running;
  // Write first: a crashing runner must not restore the flag after it is unset.
  writeSettings(paths.settings,{...readWakeSettings(paths.settings),enabled:false,disabledAt:new Date().toISOString(),pendingStop:keepEngine});
  unsetOwnFlag(run,paths);
  if (!keepEngine) unload(run,paths,uid);
  return wakeStatus({...options,paths});
}
export async function restartChatGPT(options = {}) {
  const { run = spawnSync, uid = process.getuid?.(), sleep = ms => new Promise(resolve=>setTimeout(resolve,ms)), waitMs=30000 } = options;
  const paths = options.paths ?? wakePaths(options);
  if (chatgptState(run,paths.app).running !== false) {
    const quit=run('osascript',['-e',`tell application id "${CHATGPT_BUNDLE}" to quit`],{encoding:'utf8',timeout:10000});
    if (quit.status !== 0) throw new Error(failure(quit,"ChatGPT could not quit."));
    const deadline=Date.now()+waitMs;
    while(chatgptState(run,paths.app).running !== false) {
      if(Date.now()>deadline)throw new Error("ChatGPT didn't quit. Quit it yourself, then try again.");
      await sleep(250);
    }
  }
  const settings=readWakeSettings(paths.settings);
  if(!settings.enabled){unload(run,paths,uid);unsetOwnFlag(run,paths);}
  const opened=run('open',['-b',CHATGPT_BUNDLE],{encoding:'utf8',timeout:10000});
  if(opened.status!==0)throw new Error("Couldn't reopen ChatGPT. Open it from the Dock.");
  writeSettings(paths.settings,{...settings,pendingStop:false,restartedAt:new Date().toISOString()});
  return wakeStatus({...options,paths});
}
