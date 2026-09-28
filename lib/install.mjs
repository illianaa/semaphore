import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDir, shellQuote } from "./paths.mjs";
import { uninstallClaudeHooks } from "./claude-wake.mjs";

export const SERVICE_LABEL = "local.semaphore.app";
export const DEFAULT_PORT = 4317;
const MARKER = "Installed by Semaphore";

export function installPaths({ home = os.homedir(), env = process.env } = {}) {
  const dataHome = path.resolve(
    env.SEMAPHORE_HOME || path.join(home, ".semaphore"),
  );
  return {
    dataHome,
    rooms: path.join(dataHome, "rooms"),
    command: path.join(dataHome, "bin", "semaphore"),
    skillSource: path.join(projectDir, "skills", "semaphore"),
    claudeSkill: path.join(home, ".claude", "skills", "semaphore"),
    codexSkill: path.join(
      env.CODEX_HOME || path.join(home, ".codex"),
      "skills",
      "semaphore",
    ),
    plist: path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    logs: path.join(home, "Library", "Logs", "Semaphore"),
    launcher: path.join(home, "Applications", "Semaphore.app"),
  };
}

// Each step says what it changes, so an AI can show the plan and ask before running it.
export function installPlan(options = {}) {
  const {
    node = process.execPath,
    port = DEFAULT_PORT,
    platform = process.platform,
  } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Choose a port between 1 and 65535.");
  const paths = installPaths(options);
  const steps = [
    {
      id: "data",
      summary: `Create a private folder for conversations: ${paths.rooms}`,
    },
    {
      id: "command",
      summary: `Add the Semaphore command that Claude and Astra use: ${paths.command}`,
    },
    {
      id: "claude-skill",
      summary: `Teach Claude how to use Semaphore: ${paths.claudeSkill}`,
    },
    {
      id: "codex-skill",
      summary: `Teach Astra how to use Semaphore: ${paths.codexSkill}`,
    },
  ];
  if (platform === "darwin") {
    steps.push(
      {
        id: "service",
        summary: `Keep the Semaphore app running in the background, starting at login (http://127.0.0.1:${port}): ${paths.plist}`,
      },
      {
        id: "launcher",
        summary: `Add a Semaphore app you can open from Finder or Spotlight: ${paths.launcher}`,
      },
    );
  }
  return { steps, paths, node, port, platform };
}

export function install(options = {}) {
  const { steps, paths, node, port, platform } = installPlan(options);
  const {
    env = process.env,
    launchctl = true,
    compileLauncher = true,
  } = options;
  // Preflight every destination before changing anything.
  for (const target of [paths.claudeSkill, paths.codexSkill])
    assertLinkable(paths.skillSource, target);
  for (const target of [
    paths.command,
    ...(platform === "darwin" ? [paths.plist] : []),
  ]) {
    if (fs.existsSync(target) && !ours(target))
      throw new Error(
        `${target} already exists and was not installed by Semaphore.`,
      );
  }
  if (
    platform === "darwin" &&
    fs.existsSync(paths.launcher) &&
    !fs.existsSync(
      path.join(paths.launcher, "Contents", "Resources", "semaphore-launcher"),
    )
  ) {
    throw new Error(
      `${paths.launcher} already exists and was not installed by Semaphore.`,
    );
  }
  fs.mkdirSync(paths.rooms, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.dataHome, 0o700);
  fs.chmodSync(paths.rooms, 0o700);
  fs.mkdirSync(path.dirname(paths.command), { recursive: true, mode: 0o700 });
  writeFile(
    paths.command,
    `#!/bin/sh\n# ${MARKER}: runs the Semaphore command for this copy of Semaphore.\nexport SEMAPHORE_HOME=${shellQuote(paths.dataHome)}\nexec ${shellQuote(node)} ${shellQuote(path.join(projectDir, "cli.mjs"))} "$@"\n`,
    0o755,
  );
  for (const target of [paths.claudeSkill, paths.codexSkill])
    link(paths.skillSource, target);
  if (platform === "darwin") {
    fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
    fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
    writeFile(
      paths.plist,
      launchAgent({ node, port, logs: paths.logs, dataHome: paths.dataHome }),
      0o644,
    );
    if (launchctl) restartService(paths.plist);
    if (compileLauncher) buildLauncher(paths.launcher, port);
  }
  return { done: steps.map((step) => step.id), paths };
}

// Removes only what Semaphore installed. Conversations stay in the data folder.
export function uninstall(options = {}) {
  const { platform = process.platform, launchctl = true, home = os.homedir() } = options;
  const paths = installPaths(options);
  const removed = [];
  // Remove command hooks before their executable, preserving other settings and a backup.
  const settingsPath = path.join(home, ".claude", "settings.json");
  const hooks = uninstallClaudeHooks({ settingsPath, backupDir: path.join(paths.dataHome, "backups"), registryHome: paths.dataHome });
  if (hooks.changed) removed.push(`${settingsPath} (Semaphore hooks only)`);
  if (platform === "darwin") {
    if (launchctl && ours(paths.plist))
      spawnSync(
        "launchctl",
        ["bootout", `gui/${process.getuid()}/${SERVICE_LABEL}`],
        { stdio: "ignore", timeout: 5000 },
      );
    if (ours(paths.plist)) {
      fs.rmSync(paths.plist);
      removed.push(paths.plist);
    }
    if (
      fs.existsSync(
        path.join(
          paths.launcher,
          "Contents",
          "Resources",
          "semaphore-launcher",
        ),
      )
    ) {
      fs.rmSync(paths.launcher, { recursive: true });
      removed.push(paths.launcher);
    }
  }
  for (const target of [paths.claudeSkill, paths.codexSkill]) {
    if (linksTo(target, paths.skillSource)) {
      fs.unlinkSync(target);
      removed.push(target);
    }
  }
  if (ours(paths.command)) {
    fs.rmSync(paths.command);
    removed.push(paths.command);
  }
  return { removed, kept: paths.rooms };
}

export function linksTo(target, source) {
  try {
    return (
      fs.lstatSync(target).isSymbolicLink() &&
      fs.realpathSync(target) === fs.realpathSync(source)
    );
  } catch {
    return false;
  }
}

function assertLinkable(source, target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!(stat.isSymbolicLink() && linksTo(target, source))) {
    throw new Error(
      `${target} already exists and was not installed by Semaphore. Move it aside, then run setup again.`,
    );
  }
}

function link(source, target) {
  if (linksTo(target, source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
}

function ours(file) {
  try {
    return fs.readFileSync(file, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

function writeFile(file, text, mode) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

const xml = (value) =>
  String(value).replace(
    /[<>&'"]/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[character],
  );

export function launchAgent({ node, port, logs, dataHome }) {
  const args = [
    node,
    path.join(projectDir, "server.mjs"),
    "--port",
    String(port),
  ]
    .map((arg) => `<string>${xml(arg)}</string>`)
    .join("");
  const environment = dataHome
    ? `<key>EnvironmentVariables</key><dict><key>SEMAPHORE_HOME</key><string>${xml(dataHome)}</string></dict>`
    : "";
  // KeepAlive only restarts after a crash, so a busy port does not cause a restart loop.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(projectDir)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
<key>StandardOutPath</key><string>${xml(path.join(logs, "server.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, "server.log"))}</string>${environment}
</dict></plist>
`;
}

export function restartService(
  plist,
  {
    run = spawnSync,
    pause = (ms) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    domain = `gui/${process.getuid()}`,
  } = {},
) {
  run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], {
    stdio: "ignore",
    timeout: 5000,
  });
  let result;
  // bootout can return before launchd finishes unloading the old job. During
  // that short interval bootstrap returns EIO (5), even for a valid plist.
  // Retry registration only; never retry a conversation delivery.
  for (let attempt = 0; attempt < 12; attempt++) {
    result = run("launchctl", ["bootstrap", domain, plist], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 5 || attempt === 11) break;
    pause(250);
  }
  if (result.status !== 0)
    throw new Error(
      `Could not register the background app: ${(result.stderr || result.stdout || result.error?.message || "launchctl failed").trim()}`,
    );
  // RunAtLoad may be deferred by launchd for a speculative, non-demand launch.
  const started = run(
    "launchctl",
    ["kickstart", `${domain}/${SERVICE_LABEL}`],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (started.status !== 0)
    throw new Error(
      `Could not launch the background app: ${started.stderr || started.error?.message || "launchctl failed"}`,
    );
}

export function launcherScript(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Choose a valid port.");
  return `do shell script "launchctl kickstart gui/$(id -u)/${SERVICE_LABEL} >/dev/null 2>&1 || true"
do shell script "n=0; until /usr/bin/curl --silent --fail --max-time 1 http://127.0.0.1:${port}/health >/dev/null; do n=$((n+1)); if [ $n -ge 30 ]; then echo 'Semaphore did not start. Ask your AI to check Semaphore setup.' >&2; exit 1; fi; sleep 0.2; done"
open location "http://127.0.0.1:${port}"`;
}

function buildLauncher(target, port) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (
    fs.existsSync(target) &&
    !fs.existsSync(
      path.join(target, "Contents", "Resources", "semaphore-launcher"),
    )
  ) {
    throw new Error(
      `${target} already exists and was not installed by Semaphore.`,
    );
  }
  fs.rmSync(target, { recursive: true, force: true });
  const result = spawnSync(
    "osacompile",
    ["-o", target, "-e", launcherScript(port)],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      `Could not create the Semaphore app: ${(result.stderr || result.stdout).trim()}`,
    );
  fs.writeFileSync(
    path.join(target, "Contents", "Resources", "semaphore-launcher"),
    `${MARKER}\n`,
  );
}
