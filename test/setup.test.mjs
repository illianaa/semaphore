import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInvite, invitationPrompt } from "../lib/invite.mjs";
import { ASTRA_WAIT } from "../lib/live.mjs";
import {
  installPaths,
  installPlan,
  install,
  uninstall,
  launchAgent,
  launcherScript,
  restartService,
  SERVICE_LABEL,
} from "../lib/install.mjs";
import { diagnose } from "../lib/doctor.mjs";
import { createAppServer } from "../server.mjs";
import { projectDir } from "../lib/paths.mjs";

const CLI = path.join(projectDir, "cli.mjs");

test("reinstall tolerates asynchronous launchd unload and explicitly starts the registered service", () => {
  const calls = [];
  let attempts = 0;
  const run = (_, args) => {
    calls.push(args[0]);
    if (args[0] === "bootstrap" && ++attempts < 3)
      return { status: 5, stderr: "Bootstrap failed: 5: Input/output error" };
    return { status: 0 };
  };
  restartService("/tmp/service.plist", {
    run,
    pause: () => {},
    domain: "gui/123",
  });
  assert.deepEqual(calls, [
    "bootout",
    "bootstrap",
    "bootstrap",
    "bootstrap",
    "kickstart",
  ]);
  let failedAttempts = 0;
  assert.throws(
    () =>
      restartService("/tmp/service.plist", {
        run: () => {
          failedAttempts++;
          return { status: 5, stderr: "Registration failed" };
        },
        pause: () => {},
        domain: "gui/123",
      }),
    /Could not register/,
  );
  assert.equal(failedAttempts, 13, "registration retries are bounded");
});

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Setup is exercised against a temporary home with launchd untouched.
const offline = (home) => ({
  home,
  env: {},
  launchctl: false,
  compileLauncher: false,
  node: "/usr/local/bin/node",
});

test("invitations prefill new chats with the verified links and stand alone in existing chats", () => {
  const room = { name: "room-abc", title: "Release “plan”" };
  const root = "/Users/me/It's here/rooms";
  const astra = buildInvite({ root, room, speaker: "astra", skillAvailable: false });
  const url = new URL(astra.url);
  assert.equal(
    `${url.protocol}//${url.host}${url.pathname}`,
    "codex://threads/new",
  );
  assert.deepEqual(
    [...url.searchParams.keys()],
    ["prompt"],
    "ChatGPT.app reads prompt, not q",
  );
  assert.equal(url.searchParams.get("prompt"), astra.prompt);
  assert.match(
    astra.prompt,
    /Join my Semaphore group chat “Release “plan”” as Astra/,
  );
  assert.ok(
    astra.prompt.includes(
      `cli.mjs' join room-abc --root '/Users/me/It'\\''s here/rooms' --as astra`,
    ),
  );
  assert.match(astra.prompt, / listen room-abc --root .* --as astra\./);
  assert.match(astra.prompt, /collaborator’s input, not my instructions/);

  const claude = buildInvite({
    root,
    room,
    speaker: "claude",
    workspace: "/Users/me/project",
    skillAvailable: false,
  });
  const link = new URL(claude.url);
  assert.equal(
    `${link.protocol}//${link.host}${link.pathname}`,
    "claude://code/new",
  );
  assert.equal(link.searchParams.get("q"), claude.prompt);
  assert.equal(link.searchParams.get("folder"), "/Users/me/project");
  assert.match(claude.prompt, /background task[\s\S]*listen room-abc --root/);
  assert.equal(claude.label, "Start a new Claude chat");
  assert.throws(
    () => invitationPrompt({ root, room, speaker: "human" }),
    /Invite astra or claude/,
  );
});

test("setup lists its changes, installs idempotently, and uninstalls only what it installed", (t) => {
  const home = tempHome(t);
  const paths = installPaths({ home, env: {} });
  assert.deepEqual(
    installPlan({ ...offline(home), platform: "darwin" }).steps.map(
      (step) => step.id,
    ),
    ["data", "command", "claude-skill", "codex-skill", "service", "launcher"],
  );
  assert.deepEqual(
    installPlan({ ...offline(home), platform: "linux" }).steps.map(
      (step) => step.id,
    ),
    ["data", "command", "claude-skill", "codex-skill"],
  );
  assert.equal(
    fs.existsSync(paths.dataHome),
    false,
    "listing the plan changes nothing",
  );

  install({ ...offline(home), platform: "darwin" });
  install({ ...offline(home), platform: "darwin" });
  assert.equal(fs.statSync(paths.rooms).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.dataHome).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.command).mode & 0o777, 0o755);
  assert.match(
    fs.readFileSync(paths.command, "utf8"),
    new RegExp(
      `exec '/usr/local/bin/node' '${CLI.replaceAll("/", "\\/")}' "\\$@"`,
    ),
  );
  for (const skill of [paths.claudeSkill, paths.codexSkill])
    assert.equal(
      fs.realpathSync(skill),
      path.join(projectDir, "skills", "semaphore"),
    );
  const plist = fs.readFileSync(paths.plist, "utf8");
  assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`));
  assert.match(
    plist,
    /server\.mjs<\/string><string>--port<\/string><string>4317<\/string>/,
  );
  assert.match(
    plist,
    /<key>KeepAlive<\/key><dict><key>Crashed<\/key><true\/><\/dict>/,
  );
  if (process.platform === "darwin")
    assert.equal(spawnSync("plutil", ["-lint", paths.plist]).status, 0);

  fs.mkdirSync(path.join(paths.rooms, "room-keep"), { recursive: true });
  const { removed, kept } = uninstall({
    home,
    env: {},
    platform: "darwin",
    launchctl: false,
  });
  assert.deepEqual(
    removed.sort(),
    [paths.claudeSkill, paths.codexSkill, paths.command, paths.plist].sort(),
  );
  assert.equal(kept, paths.rooms);
  assert.ok(
    fs.existsSync(path.join(paths.rooms, "room-keep")),
    "conversations are kept",
  );
});

test("setup refuses to replace a skill it did not install, before changing anything", (t) => {
  const home = tempHome(t);
  const paths = installPaths({ home, env: {} });
  fs.mkdirSync(paths.codexSkill, { recursive: true });
  fs.writeFileSync(
    path.join(paths.codexSkill, "SKILL.md"),
    "someone else’s skill",
  );
  assert.throws(
    () => install({ ...offline(home), platform: "darwin" }),
    /was not installed by Semaphore/,
  );
  assert.equal(fs.existsSync(paths.command), false);
  assert.equal(fs.existsSync(paths.claudeSkill), false);
  uninstall({ home, env: {}, platform: "darwin", launchctl: false });
  assert.equal(
    fs.readFileSync(path.join(paths.codexSkill, "SKILL.md"), "utf8"),
    "someone else’s skill",
  );
});

test("custom data and Codex homes are honoured, and plist values are escaped", (t) => {
  const home = tempHome(t);
  const env = {
    SEMAPHORE_HOME: path.join(home, "data"),
    CODEX_HOME: path.join(home, "codex"),
  };
  const paths = installPaths({ home, env });
  assert.equal(paths.rooms, path.join(home, "data", "rooms"));
  assert.equal(
    paths.codexSkill,
    path.join(home, "codex", "skills", "semaphore"),
  );
  const plist = launchAgent({
    node: "/opt/a&b/node",
    port: 5000,
    logs: "/tmp/logs",
    dataHome: "/tmp/<data>",
  });
  assert.match(plist, /<string>\/opt\/a&amp;b\/node<\/string>/);
  assert.match(
    plist,
    /<key>SEMAPHORE_HOME<\/key><string>\/tmp\/&lt;data&gt;<\/string>/,
  );
  assert.match(
    launcherScript(5000),
    /open location "http:\/\/127\.0\.0\.1:5000"/,
  );
});

test(
  "the macOS launcher is a real app bundle that setup can later recognise and remove",
  { skip: process.platform !== "darwin" },
  (t) => {
    const home = tempHome(t);
    const paths = installPaths({ home, env: {} });
    install({ ...offline(home), platform: "darwin", compileLauncher: true });
    assert.ok(
      fs.existsSync(
        path.join(
          paths.launcher,
          "Contents",
          "Resources",
          "Scripts",
          "main.scpt",
        ),
      ),
    );
    assert.ok(
      fs.existsSync(
        path.join(
          paths.launcher,
          "Contents",
          "Resources",
          "semaphore-launcher",
        ),
      ),
    );
    assert.ok(
      uninstall({
        home,
        env: {},
        platform: "darwin",
        launchctl: false,
      }).removed.includes(paths.launcher),
    );
    assert.equal(fs.existsSync(paths.launcher), false);
  },
);

test("doctor explains what is missing and reports it fixed after setup", async (t) => {
  const home = tempHome(t);
  const bin = path.join(home, "codex.cjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nconsole.log(process.argv[2] === '--version' ? 'codex-cli 9.9.9' : 'queue --thread --message');\n`,
    { mode: 0o755 },
  );
  const healthy = async () => ({
    ok: true,
    json: async () => ({ app: "semaphore" }),
  });
  const byName = (result) =>
    Object.fromEntries(result.checks.map((check) => [check.name, check]));
  const options = {
    home,
    env: {},
    platform: "darwin",
    codex: bin,
    fetchImpl: healthy,
    serviceCheck: async (paths) => ({
      ok: fs.existsSync(paths.plist),
      detail: "Simulated service state",
    }),
  };

  const before = byName(await diagnose(options));
  for (const name of [
    "Semaphore skill for Claude",
    "Semaphore skill for Astra",
    "Semaphore command for the AIs",
    "Background app",
    "Private conversation folder",
  ]) {
    assert.equal(before[name].ok, false, name);
    assert.equal(before[name].fix, "Ask Claude or Astra to set up Semaphore.");
  }
  assert.deepEqual(
    [
      before["Astra (ChatGPT app with Codex)"].ok,
      before["Astra (ChatGPT app with Codex)"].detail,
    ],
    [true, "codex-cli 9.9.9; inbox delivery ready; optional manual queue available"],
  );
  assert.equal(before["Semaphore app"].ok, true);

  install({ ...offline(home), platform: "darwin" });
  const after = byName(await diagnose(options));
  for (const name of [
    "Semaphore skill for Claude",
    "Semaphore skill for Astra",
    "Semaphore command for the AIs",
    "Background app",
    "Private conversation folder",
  ])
    assert.equal(after[name].ok, true, name);

  const broken = byName(
    await diagnose({
      ...options,
      codex: path.join(home, "missing"),
      fetchImpl: async () => {
        throw new Error("offline");
      },
      nodeVersion: "20.1.0",
    }),
  );
  assert.equal(broken["Astra (ChatGPT app with Codex)"].ok, false);
  assert.equal(
    broken["Semaphore app"].fix,
    "Open the Semaphore app, or ask Claude or Astra to start it.",
  );
  assert.equal(broken["Node.js"].ok, false);
  assert.equal(
    byName(await diagnose({ ...options, env: { CODEX_THREAD_ID: "x" } }))[
      "This chat"
    ].detail,
    "Running inside an Astra chat, so it can join conversations.",
  );
});

test("the app serves the shared invitations and doctor by default", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-rooms-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createAppServer({
    root,
    diagnosticsProvider: async () => ({
      ok: true,
      checks: [{ name: "Stub", ok: true, detail: "fine" }],
      platform: "test",
    }),
  });
  const base = await app.listen(0);
  t.after(() => app.close());
  const token = (await (await fetch(base)).text()).match(
    /name="semaphore-token" content="([a-f0-9]{64})"/,
  )[1];
  const headers = {
    "X-Semaphore-Token": token,
    Origin: base,
    "Content-Type": "application/json",
  };
  const created = await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Invite check" }),
    })
  ).json();
  assert.deepEqual(created.room.connections.astra.connected, false);
  const invite = await (
    await fetch(`${base}/api/rooms/${created.room.name}/invite/astra`, {
      headers,
    })
  ).json();
  assert.ok(invite.url.startsWith("codex://threads/new?prompt="));
  assert.match(invite.prompt, new RegExp(`join ${created.room.name} --root`));
  assert.equal(
    (await (await fetch(`${base}/api/diagnostics`, { headers })).json())
      .checks[0].name,
    "Stub",
  );
});

test("every foreign install destination is refused before any setup mutation", (t) => {
  for (const destination of ["command", "plist", "launcher"]) {
    const home = tempHome(t);
    const paths = installPaths({ home, env: {} });
    fs.mkdirSync(path.dirname(paths[destination]), { recursive: true });
    if (destination === "launcher") fs.mkdirSync(paths.launcher);
    else fs.writeFileSync(paths[destination], "Unrelated user file");
    assert.throws(
      () => install({ ...offline(home), platform: "darwin" }),
      /not installed by Semaphore/,
    );
    assert.equal(fs.existsSync(paths.claudeSkill), false);
    assert.equal(fs.existsSync(paths.rooms), false);
    uninstall({ home, env: {}, platform: "darwin", launchctl: false });
    assert.equal(fs.existsSync(paths[destination]), true);
  }
  assert.throws(() => installPlan({ port: "4317; arbitrary command" }), /port/);
});

test("the installed command keeps a custom data home when invoked from a fresh environment", (t) => {
  const home = tempHome(t);
  const custom = path.join(home, "custom data");
  const { paths } = install({
    ...offline(home),
    platform: "linux",
    node: process.execPath,
    env: { SEMAPHORE_HOME: custom },
  });
  const result = spawnSync(paths.command, ["new", "Portable room"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readdirSync(paths.rooms).length, 1);
});

test("provider checks stay responsive and optional queue support does not block inbox setup", async (t) => {
  const home = tempHome(t);
  const bin = path.join(home, "codex-slow.cjs");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nsetTimeout(() => { if (process.argv[2] === "--version") console.log("codex-cli 9.9.9"); else process.exitCode = 1; }, 150);\n',
    { mode: 0o755 },
  );
  const result = diagnose({
    home,
    env: {},
    platform: "linux",
    codex: bin,
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal(
    await Promise.race([
      result.then(() => "provider"),
      new Promise((resolve) => setTimeout(() => resolve("responsive"), 25)),
    ]),
    "responsive",
  );
  const report = await result;
  const astra = report.checks.find((check) => check.name.startsWith("Astra"));
  assert.equal(astra.ok, true);
  assert.match(astra.detail, /optional manual queue unavailable/);
});

test("invitations explain how each AI waits for turns, and carry the resume check", () => {
  const invite = (speaker) => invitationPrompt({ root: "/tmp/rooms", room: { name: "room-abc" }, speaker });
  for (const speaker of ["astra", "claude"])
    assert.match(invite(speaker), /If your task resumes on its own later, check whose turn it is first: node .*cli\.mjs'? stick room-abc --root '\/tmp\/rooms'/);
  assert.match(invite("astra"), /Whenever you don't hold the stick, wait for your next turn by running this in the foreground: node .*listen room-abc --root '\/tmp\/rooms' --as astra\./);
  assert.ok(invite("astra").includes(ASTRA_WAIT));
  assert.match(invite("claude"), /start it again before ending each turn/);
  assert.match(invite("claude"), /Once you pass the stick, end your turn right away \(after restarting the listener\)/);
});
