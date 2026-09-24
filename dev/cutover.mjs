#!/usr/bin/env node
// Points this Mac's Semaphore app service, installed command and skill links at a staged,
// read-only release (docs/releases.md, steps 2–4). A dry run by default: --apply changes
// things, --rollback <backup folder> restores them. It never touches the Codex wake engine
// (local.semaphore.codex-wake), ChatGPT, or any conversation.
//
//   node dev/cutover.mjs --release ~/.semaphore/releases/<version>-<build>            # check only
//   node dev/cutover.mjs --release ~/.semaphore/releases/<version>-<build> --apply
//   node dev/cutover.mjs --rollback ~/.semaphore/backups/cutover-<time>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { RoomStore } from "../lib/core.mjs";
import { sqliteDatabase } from "../lib/sqlite.mjs";
import { parseArgs } from "node:util";

// Dependency injection keeps apply/rollback tests entirely inside temporary folders.
export async function runCutover(values, {
  home = os.homedir(), env = process.env, uid = process.getuid(),
  run = spawnSync, request = fetch, say = console.log,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const MARKER = "Installed by Semaphore";
  const APP = "local.semaphore.app";
  const WAKE = "local.semaphore.codex-wake";
  const domain = `gui/${uid}`;
  const dataHome = path.resolve(env.SEMAPHORE_HOME || path.join(home, ".semaphore"));
  const paths = {
    plist: path.join(home, "Library", "LaunchAgents", `${APP}.plist`),
    command: path.join(dataHome, "bin", "semaphore"),
    links: [
      path.join(home, ".claude", "skills", "semaphore"),
      path.join(env.CODEX_HOME || path.join(home, ".codex"), "skills", "semaphore"),
    ],
    logs: path.join(home, "Library", "Logs", "Semaphore"),
    rooms: path.join(dataHome, "rooms"),
  };
  const port = Number(values.port ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Choose a port between 1 and 65535.");
  if (Boolean(values.release) === Boolean(values.rollback)) throw new Error("Choose --release or --rollback, not both.");
  const fail = (message) => { throw new Error(message); };
  const hash = (text) => createHash("sha256").update(text).digest("hex");

  function ownedFile(file, label) {
    if (!fs.lstatSync(file).isFile()) fail(`${file} must be a regular Semaphore file.`);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(MARKER) || (label && !text.includes(`<string>${label}</string>`)))
      fail(`${file} was not installed by Semaphore.`);
    return text;
  }

  function snapshotRooms(destination) {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const entry of fs.readdirSync(paths.rooms, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const store = new RoomStore(paths.rooms, entry.name);
      // Don't copy across an active writer/delivery. Human input has its own
      // SQLite journal and can still arrive while the room is locked.
      store.acquire();
      try {
        if (store.read().pending?.state === "delivering")
          fail(`Room ${entry.name} has a delivery in progress; finish or pause it before cutover.`);
        const target = path.join(destination, entry.name);
        const inputs = path.join(store.dir, "human-inputs.sqlite");
        fs.cpSync(store.dir, target, { recursive: true, preserveTimestamps: true,
          filter: (source) => source !== store.workspace && source !== store.lockFile &&
            ![inputs, `${inputs}-wal`, `${inputs}-shm`].includes(source) && path.basename(source) !== "listener.pid" });
        if (fs.existsSync(inputs)) {
          const db = new (sqliteDatabase())(inputs, { readOnly: true });
          try {
            db.exec("PRAGMA busy_timeout=2000");
            db.prepare("VACUUM INTO ?").run(path.join(target, "human-inputs.sqlite"));
          } finally { db.close(); }
        }
      } finally { store.release(); }
    }
  }

  function pid(label) {
    const result = run("launchctl", ["print", `${domain}/${label}`], { encoding: "utf8", timeout: 5000 });
    return result.status === 0 ? Number(/^\s*pid = (\d+)/m.exec(result.stdout)?.[1]) || null : null;
  }
  async function health() {
    try {
      const response = await request(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const state = response.ok ? await response.json() : null;
      return state?.app === "semaphore" ? state : null;
    } catch { return null; }
  }
  // A link Semaphore made: it resolves to some Semaphore copy's skills/semaphore folder.
  function semaphoreSkill(link) {
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) return false;
      const target = fs.realpathSync(link);
      return path.basename(target) === "semaphore" && path.basename(path.dirname(target)) === "skills" &&
        /^name: semaphore$/m.test(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")) &&
        fs.existsSync(path.join(target, "..", "..", "cli.mjs"));
    } catch { return false; }
  }
  function writeAtomic(file, text, mode) {
    const temp = `${file}.cutover-${process.pid}.tmp`;
    fs.writeFileSync(temp, text, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  }
  function relink(link, target) {
    const temp = `${link}.cutover-${process.pid}.tmp`;
    fs.rmSync(temp, { force: true });
    fs.symlinkSync(target, temp);
    fs.renameSync(temp, link); // Replaces the old link in one step.
  }
  // Same registration as lib/install.mjs restartService, kept here so a rollback
  // never depends on the release it is leaving.
  async function restartApp() {
    run("launchctl", ["bootout", `${domain}/${APP}`], { stdio: "ignore", timeout: 5000 });
    let result;
    for (let attempt = 0; attempt < 12; attempt++) {
      result = run("launchctl", ["bootstrap", domain, paths.plist], { encoding: "utf8", timeout: 5000 });
      if (result.status !== 5) break;
      await pause(250);
    }
    if (result.status !== 0) fail(`Could not register the app service: ${(result.stderr || result.stdout || "").trim()}`);
    const started = run("launchctl", ["kickstart", `${domain}/${APP}`], { encoding: "utf8", timeout: 5000 });
    if (started.status !== 0) fail(`Could not launch the app service: ${started.stderr || started.error?.message || "launchctl failed"}`);
  }
  async function waitForApp(check) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await health();
      if (state && check(state)) return state;
      await pause(250);
    }
    fail("The app service did not come back as expected. Roll back with the command above.");
  }

  async function cutover() {
    const release = path.resolve(values.release.replace(/^~(?=\/)/, home));
    // The release must be an untouched staged snapshot; importing its build info verifies that.
    const { captureRuntime } = await import(pathToFileURL(path.join(release, "lib", "build-info.mjs")));
    const runtime = captureRuntime(release);
    if (runtime.kind !== "release") fail(`${release} is not a staged release.`);
    const { launchAgent } = await import(pathToFileURL(path.join(release, "lib", "install.mjs")));
    const { shellQuote } = await import(pathToFileURL(path.join(release, "lib", "paths.mjs")));
    const node = values.node ?? "/opt/homebrew/opt/node/bin/node";
    const nodeVersion = run(node, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (nodeVersion.status !== 0 || !(Number(/^v(\d+)\./.exec(nodeVersion.stdout)?.[1]) >= 22))
      fail(`${node} must run Node 22 or later.`);

    // Everything we replace must be Semaphore's own, pointing at an earlier copy.
    const plist = ownedFile(paths.plist, APP);
    const command = ownedFile(paths.command);
    for (const link of paths.links) if (!semaphoreSkill(link)) fail(`${link} is not a Semaphore skill link.`);

    const skills = path.join(release, "skills", "semaphore");
    const nextCommand = `#!/bin/sh\n# ${MARKER}: runs the Semaphore command for this copy of Semaphore.\nexport SEMAPHORE_HOME=${shellQuote(dataHome)}\nexec ${shellQuote(node)} ${shellQuote(path.join(release, "cli.mjs"))} "$@"\n`;
    const nextPlist = launchAgent({ node, port, logs: paths.logs, dataHome });
    const files = {
      command: { file: paths.command, backup: "semaphore", before: hash(command), after: hash(nextCommand), mode: 0o755 },
      plist: { file: paths.plist, backup: "app.plist", before: hash(plist), after: hash(nextPlist), mode: 0o644 },
    };
    const before = { app: pid(APP), wake: pid(WAKE), health: await health() };
    say(`Release: ${release}\n  Semaphore ${runtime.version} · protocol ${runtime.protocol} · build ${runtime.build.slice(0, 12)}`);
    say(`App service ${APP}: pid ${before.app} → restarts on ${path.join(release, "server.mjs")} with ${node}`);
    say(`Command ${paths.command} → ${path.join(release, "cli.mjs")}`);
    for (const link of paths.links) say(`Skill ${link}: ${fs.readlinkSync(link)} → ${skills}`);
    say(`Untouched: ${WAKE} (pid ${before.wake}), ChatGPT, conversations.`);
    if (!values.apply) return say("Dry run only. Add --apply to switch.");

    // Back up the exact files, link targets and conversations before changing anything.
    const backup = path.join(dataHome, "backups", `cutover-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(paths.plist, path.join(backup, "app.plist"));
    fs.copyFileSync(paths.command, path.join(backup, "semaphore"));
    fs.writeFileSync(path.join(backup, "state.json"), JSON.stringify({
      schema: 1, paths, port, files, nextSkill: skills,
      links: Object.fromEntries(paths.links.map((link) => [link, fs.readlinkSync(link)])),
      before, release, at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    snapshotRooms(path.join(backup, "rooms"));
    say(`Backup: ${backup}\nRoll back with: SEMAPHORE_HOME=${shellQuote(dataHome)} node ${shellQuote(fileURLToPath(import.meta.url))} --rollback ${shellQuote(backup)} --port ${port}`);

    writeAtomic(paths.command, nextCommand, 0o755);
    for (const link of paths.links) relink(link, skills);
    writeAtomic(paths.plist, nextPlist, 0o644);
    await restartApp();
    const after = await waitForApp((state) => state.pid === pid(APP) && state.pid !== before.app && state.runtime?.build === runtime.build);
    const wake = pid(WAKE);
    say(`App service is back: pid ${after.pid} · ${after.runtime.kind} ${after.runtime.version} · build ${after.runtime.build.slice(0, 12)}`);
    if (wake !== before.wake) fail(`The app switched, but the wake engine pid changed (${before.wake} → ${wake}). Check instant wake in Setup & connections before continuing.`);
    say(`Wake engine untouched: pid ${wake}.`);
  }

  async function rollback() {
    const backup = path.resolve(values.rollback.replace(/^~(?=\/)/, home));
    const state = JSON.parse(fs.readFileSync(path.join(backup, "state.json"), "utf8"));
    if (state.schema !== 1 || JSON.stringify(state.paths) !== JSON.stringify(paths) || state.port !== port)
      fail("This backup belongs to a different installation or port; nothing was restored.");
    if (JSON.stringify(Object.keys(state.links).sort()) !== JSON.stringify([...paths.links].sort()))
      fail("Unexpected skill links in the backup; nothing was restored.");
    // Preflight every destination before restoring any of them, including a
    // partially applied cutover. A changed or unrelated file must be left alone.
    for (const [key, name] of [["command", "semaphore"], ["plist", "app.plist"]]) {
      const item = state.files?.[key];
      if (item?.file !== paths[key] || item.backup !== name ||
          hash(fs.readFileSync(path.join(backup, name))) !== item.before)
        fail(`Invalid ${key} backup; nothing was restored.`);
      const current = hash(ownedFile(paths[key], key === "plist" ? APP : undefined));
      if (![item.before, item.after].includes(current)) fail(`${paths[key]} changed after this cutover; nothing was restored.`);
    }
    for (const link of paths.links) {
      if (!fs.lstatSync(link).isSymbolicLink() || ![state.links[link], state.nextSkill].includes(fs.readlinkSync(link)))
        fail(`${link} changed after this cutover; nothing was restored.`);
    }
    writeAtomic(paths.command, fs.readFileSync(path.join(backup, "semaphore"), "utf8"), 0o755);
    for (const [link, target] of Object.entries(state.links)) relink(link, target);
    writeAtomic(paths.plist, fs.readFileSync(path.join(backup, "app.plist"), "utf8"), 0o644);
    const previous = pid(APP);
    await restartApp();
    const after = await waitForApp((health) => {
      const current = pid(APP);
      return current && current !== previous && (health.pid === undefined || health.pid === current) &&
        (!state.before.health?.runtime?.build || health.runtime?.build === state.before.health.runtime.build);
    });
    say(`Restored the previous install from ${backup}. App service pid ${after.pid ?? pid(APP)}. Conversations were not changed; their backup stays in ${path.join(backup, "rooms")}.`);
  }

  if (values.rollback) return rollback();
  return cutover();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        release: { type: "string" },
        apply: { type: "boolean" },
        rollback: { type: "string" },
        node: { type: "string", default: "/opt/homebrew/opt/node/bin/node" },
        port: { type: "string", default: "4317" },
      },
    });
    await runCutover(values);
  } catch (error) {
    console.error(`Cutover: ${error.message}`);
    process.exitCode = 1;
  }
}
