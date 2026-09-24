import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WAKE_FLAG,
  WAKE_LABEL,
  chatgptState,
  disableWake,
  enableWake,
  restartChatGPT,
  wakeStatus,
  wakeAgent,
} from "../lib/wake.mjs";

const APP = "/Applications/ChatGPT.app";
import { socketURL } from "../lib/codex-runtime.mjs";

const started = "Thu Sep 24 09:00:00 2026";

// A fake Mac: launchd's environment, the shared engine, and ChatGPT's processes.
function fakeMac(t, { installed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-wake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    settings: path.join(dir, "data", "wake.json"),
    plist: path.join(dir, "LaunchAgents", `${WAKE_LABEL}.plist`),
    log: path.join(dir, "Logs", "codex-wake.log"),
    app: APP,
    codex: path.join(dir, "codex"),
    node: process.execPath, runner: path.join(dir, "wake-runner.mjs"),
    socket: path.join(dir, "app-server-control.sock"),
  };
  if (installed) fs.writeFileSync(paths.codex, "");
  const mac = {
    paths,
    calls: [],
    env: {},
    engine: false,
    chatgpt: "private",
    quitAfter: 0,
    run(command, args) {
      mac.calls.push([command, ...args].join(" "));
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (command === "launchctl" && args[0] === "getenv")
        return ok(mac.env[args[1]] ?? "");
      if (command === "launchctl" && args[0] === "setenv") {
        mac.env[args[1]] = args[2];
        return ok();
      }
      if (command === "launchctl" && args[0] === "unsetenv") {
        delete mac.env[args[1]];
        return ok();
      }
      if (command === "launchctl" && args[0] === "bootstrap") {
        mac.engine = true; fs.writeFileSync(paths.socket, "socket"); return ok();
      }
      if (command === "launchctl" && args[0] === "bootout") {
        mac.engine = false; fs.rmSync(paths.socket, {force: true}); return ok();
      }
      if (command === "launchctl" && args[0] === "print")
        return mac.engine ? ok("state = running\npid = 888") : { status: 113, stdout: "" };
      if (command === "launchctl") return ok();
      if (command === paths.codex && args.join(" ") === "app-server daemon version")
        return mac.engine
          ? ok(JSON.stringify({ status: "running", appServerVersion: "0.154.0" }))
          : { status: 1, stdout: "", stderr: "failed to connect" };
      if (command === paths.codex && args.join(" ") === "app-server daemon start") {
        mac.engine = true;
        return ok();
      }
      if (command === paths.codex && args.join(" ") === "app-server daemon stop") {
        mac.engine = false;
        return ok();
      }
      if (command === "ps") {
        if (!mac.chatgpt) return ok("  1 0 Thu Sep 24 08:00:00 2026 /sbin/launchd\n");
        const rows = [`  700   1 ${started} ${APP}/Contents/MacOS/ChatGPT`];
        if (mac.chatgpt === "private")
          rows.push(`  701 700 ${started} ${APP}/Contents/Resources/codex app-server --analytics-default-enabled`);
        return ok(`${rows.join("\n")}\n`);
      }
      if (command === "osascript") {
        mac.quitAfter = 2;
        return ok();
      }
      if (command === "open") {
        mac.chatgpt = mac.env[WAKE_FLAG] === socketURL(paths.socket) && mac.engine ? "shared" : "private";
        return ok();
      }
      return { status: 127, stdout: "", stderr: `unexpected ${command}` };
    },
  };
  return mac;
}
const options = (mac) => ({
  run: mac.run,
  paths: mac.paths,
  platform: "darwin",
  uid: 501,
  pause: () => {},
});

test("instant wake is off by default and reports ChatGPT's own engine", (t) => {
  const mac = fakeMac(t);
  const status = wakeStatus(options(mac));
  assert.equal(status.state, "off");
  assert.equal(status.enabled, false);
  assert.equal(status.chatgpt.engine, "private");
  assert.equal(status.engine.running, false);
  assert.equal(
    wakeStatus({ ...options(mac), platform: "linux" }).state,
    "unsupported",
  );
});

test("turning instant wake on registers the agent, sets the flag and starts the engine", (t) => {
  const mac = fakeMac(t);
  const status = enableWake(options(mac));
  assert.equal(status.state, "restart-chatgpt", "ChatGPT keeps its engine until it restarts");
  assert.equal(mac.env[WAKE_FLAG], socketURL(mac.paths.socket));
  assert.equal(mac.engine, true);
  const plist = fs.readFileSync(mac.paths.plist, "utf8");
  assert.match(plist, /Installed by Semaphore/);
  assert.match(plist, /wake-runner.mjs/);
  assert.match(plist, /SuccessfulExit/);
  assert.ok(mac.calls.includes(`launchctl bootstrap gui/501 ${mac.paths.plist}`));
  assert.equal(JSON.parse(fs.readFileSync(mac.paths.settings)).enabled, true);
  mac.chatgpt = "shared";
  assert.equal(wakeStatus(options(mac)).state, "on");
  mac.chatgpt = null;
  assert.equal(wakeStatus(options(mac)).state, "on", "a closed ChatGPT picks it up when it opens");
});

test("turning it on refuses without the desktop engine or over someone else's agent", (t) => {
  const missing = fakeMac(t, { installed: false });
  assert.throws(() => enableWake(options(missing)), (err) => {
    assert.equal(err.status, 409);
    return true;
  });
  assert.equal(fs.existsSync(missing.paths.plist), false);
  assert.equal(missing.env[WAKE_FLAG], undefined);
  const foreign = fakeMac(t);
  fs.mkdirSync(path.dirname(foreign.paths.plist), { recursive: true });
  fs.writeFileSync(foreign.paths.plist, "<plist>someone else</plist>");
  assert.throws(() => enableWake(options(foreign)), /wasn't written by Semaphore/);
  assert.equal(fs.readFileSync(foreign.paths.plist, "utf8"), "<plist>someone else</plist>");
});

test("activation starts an engine whose RunAtLoad launch was deferred", (t) => {
  const mac = fakeMac(t); const run = mac.run;
  mac.run = (command, args) => {
    const result = run(command, args);
    if (command === 'launchctl' && args[0] === 'bootstrap') {
      mac.engine = false; fs.rmSync(mac.paths.socket, { force: true });
    }
    if (command === 'launchctl' && args[0] === 'kickstart') {
      mac.engine = true; fs.writeFileSync(mac.paths.socket, 'socket');
    }
    return result;
  };
  assert.equal(enableWake(options(mac)).engine.running, true);
  assert.ok(mac.calls.includes(`launchctl kickstart gui/501/${WAKE_LABEL}`));
});

test("turning it off keeps the engine for an attached ChatGPT until the restart", (t) => {
  const mac = fakeMac(t);
  enableWake(options(mac));
  mac.chatgpt = "shared";
  const off = disableWake(options(mac));
  assert.equal(off.state, "turning-off");
  assert.equal(mac.env[WAKE_FLAG], undefined);
  assert.equal(fs.existsSync(mac.paths.plist), true);
  assert.equal(mac.engine, true, "ChatGPT is still using it");
  mac.chatgpt = "private";
  disableWake(options(mac));
  assert.equal(mac.engine, false);
  assert.equal(wakeStatus(options(mac)).state, "off");
});

test("the restart step quits and reopens ChatGPT, then reports the engine it uses", async (t) => {
  const mac = fakeMac(t);
  enableWake(options(mac));
  const ps = mac.run;
  let polls = 0;
  mac.run = (command, args) => {
    if (command === "ps" && mac.quitAfter) {
      polls++;
      if (polls >= mac.quitAfter) {
        mac.quitAfter = 0;
        mac.chatgpt = null;
      }
    }
    return ps(command, args);
  };
  const on = await restartChatGPT({ ...options(mac), run: (...a) => mac.run(...a), sleep: async () => {} });
  assert.equal(on.state, "on");
  assert.equal(on.chatgpt.engine, "unknown", "absence of a private child is not proof of shared attachment");
  assert.ok(mac.calls.some((call) => call.startsWith("osascript")));
  assert.ok(mac.calls.includes("open -b com.openai.codex"));
  assert.ok(JSON.parse(fs.readFileSync(mac.paths.settings)).restartedAt);
  disableWake({ ...options(mac), run: (...a) => mac.run(...a) });
  const off = await restartChatGPT({ ...options(mac), run: (...a) => mac.run(...a), sleep: async () => {} });
  assert.equal(off.state, "off", "after turning off, the restart puts ChatGPT back on its own engine");
  assert.equal(off.chatgpt.engine, "private");
});

test("a ChatGPT that won't quit stops the restart with a clear message", async (t) => {
  const mac = fakeMac(t);
  await assert.rejects(
    restartChatGPT({ ...options(mac), sleep: async () => {}, waitMs: -1 }),
    /didn't quit/,
  );
  assert.equal(mac.calls.includes("open -b com.openai.codex"), false);
});

test("process detection reads ChatGPT's start time and its private engine child", () => {
  const run = () => ({
    status: 0,
    stdout: ` 1357     1 Mon Sep 21 14:43:55 2026     ${APP}/Contents/MacOS/ChatGPT\n 1440  1357 Mon Sep 21 14:43:56 2026     ${APP}/Contents/Resources/codex -c x app-server --analytics-default-enabled\n`,
  });
  const state = chatgptState(run, APP);
  assert.equal(state.pid, 1357);
  assert.equal(state.engine, "private");
  assert.equal(new Date(state.startedAt).getTime(), Date.parse("Mon Sep 21 14:43:55 2026"));
});

test("failed activation removes only its own setup and restores disabled status", (t) => {
  const mac=fakeMac(t); const run=mac.run;
  mac.run=(command,args)=>command==='launchctl'&&args[0]==='bootstrap'
    ? {status:1,stdout:'',stderr:'simulated registration failure'} : run(command,args);
  assert.throws(()=>enableWake(options(mac)),/simulated registration failure/);
  assert.equal(mac.env[WAKE_FLAG],undefined);
  assert.equal(fs.existsSync(mac.paths.plist),false);
  assert.equal(wakeStatus(options(mac)).state,'off');
});

test("existing external engine settings and foreign login items survive enable and disable", (t) => {
  const mac=fakeMac(t);mac.env[WAKE_FLAG]='ws://127.0.0.1:9876';
  assert.throws(()=>enableWake(options(mac)),/another explicit engine/);
  assert.equal(mac.env[WAKE_FLAG],'ws://127.0.0.1:9876');
  fs.mkdirSync(path.dirname(mac.paths.plist),{recursive:true});fs.writeFileSync(mac.paths.plist,'foreign');
  const before=mac.calls.length;
  assert.throws(()=>disableWake(options(mac)),/not written by Semaphore/);
  assert.equal(mac.calls.length,before);
  assert.equal(fs.readFileSync(mac.paths.plist,'utf8'),'foreign');
});

test("missing private child or a failed process listing never proves shared attachment", (t) => {
  const mac=fakeMac(t);mac.chatgpt='shared';
  assert.equal(chatgptState(mac.run,APP).engine,'unknown');
  assert.deepEqual(chatgptState(()=>({status:1}),APP),{running:null,engine:'unknown',startedAt:null});
});
