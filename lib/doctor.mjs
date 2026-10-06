import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexExecutable } from "./adapters.mjs";
import {
  DEFAULT_PORT,
  SERVICE_LABEL,
  installPaths,
  linksTo,
} from "./install.mjs";
import { projectDir } from "./paths.mjs";

const MIN_NODE = 22;
const SETUP = "Ask Claude or GPT to set up Semaphore.";
const execute = promisify(execFile);

// Plain-language checks for the app's settings panel and `semaphore doctor`. Every failed check
// says what to do next without assuming the person uses a terminal.
export async function diagnose({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  codex = codexExecutable(),
  port = DEFAULT_PORT,
  fetchImpl = fetch,
  serviceCheck = checkService,
  root,
} = {}) {
  const paths = installPaths({ home, env });
  const checks = [];
  const add = (name, ok, detail, fix) =>
    checks.push({ name, ok, detail, ...(!ok && fix ? { fix } : {}) });

  add(
    "Node.js",
    Number(nodeVersion.split(".")[0]) >= MIN_NODE,
    `Version ${nodeVersion}`,
    `Semaphore needs Node.js ${MIN_NODE} or newer.`,
  );
  add(
    "macOS",
    platform === "darwin",
    platform === "darwin"
      ? "Live desktop chats are supported here."
      : `Live desktop chats currently need macOS; this is ${platform}.`,
  );
  const astra = await codexCheck(codex);
  add(
    "GPT (ChatGPT app with Codex)",
    astra.ok,
    astra.detail,
    "Install or update the ChatGPT desktop app, then open it once.",
  );
  const claude = claudeCheck(home);
  add(
    "Claude desktop app",
    claude.ok,
    claude.detail,
    "Install the Claude desktop app and open one Code chat.",
  );
  for (const [who, target] of [
    ["Claude", paths.claudeSkill],
    ["GPT", paths.codexSkill],
  ]) {
    const linked = linksTo(target, paths.skillSource);
    add(
      `Semaphore skill for ${who}`,
      linked,
      linked ? "Installed" : "Not installed",
      SETUP,
    );
  }
  let command = false;
  try {
    command = fs
      .readFileSync(paths.command, "utf8")
      .includes(path.join(projectDir, "cli.mjs"));
  } catch {}
  add(
    "Semaphore command for the AIs",
    command,
    command ? paths.command : "Not installed",
    SETUP,
  );
  if (platform === "darwin") {
    const service = await serviceCheck(paths);
    add("Background app", service.ok, service.detail, SETUP);
  }
  const running = await reachable(`http://127.0.0.1:${port}/health`, fetchImpl);
  add(
    "Semaphore app",
    running,
    running ? `Running at http://127.0.0.1:${port}` : "Not running",
    "Open the Semaphore app, or ask Claude or GPT to start it.",
  );
  let privateRooms = false;
  const rooms = root || paths.rooms;
  try {
    privateRooms = (fs.statSync(rooms).mode & 0o077) === 0;
  } catch {}
  add(
    "Private conversation folder",
    privateRooms,
    privateRooms ? rooms : "Missing, or readable by other users",
    SETUP,
  );
  const inside = env.CODEX_THREAD_ID
    ? "a GPT chat"
    : env.CLAUDE_CODE_SESSION_ID
      ? "a Claude chat"
      : null;
  if (inside)
    add(
      "This chat",
      true,
      `Running inside ${inside}, so it can join conversations.`,
    );
  return { ok: checks.every((check) => check.ok), checks, platform };
}

async function codexCheck(codex) {
  try {
    const [help, version] = await Promise.allSettled([
      execute(codex, ["queue", "--help"], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 64_000,
      }),
      execute(codex, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 64_000,
      }),
    ]);
    if (version.status !== "fulfilled" || !/^codex(?:-cli)?\s/i.test(version.value.stdout.trim()))
      return {
        ok: false,
        detail: "The Codex runtime was not found or did not report its version.",
      };
    const manualQueue = help.status === "fulfilled" &&
      /--thread\b/.test(help.value.stdout) && /--message\b/.test(help.value.stdout);
    return {
      ok: true,
      detail: `${version.value.stdout.trim()}; inbox delivery ready; optional manual queue ${manualQueue ? "available" : "unavailable"}`,
    };
  } catch {
    return {
      ok: false,
      detail:
        "Codex was not found or did not respond.",
    };
  }
}

async function checkService(paths) {
  if (!fs.existsSync(paths.plist))
    return { ok: false, detail: "Not installed" };
  const plist = fs.readFileSync(paths.plist, "utf8");
  const node = plist
    .match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>(.*?)<\/string>/s,
    )?.[1]
    ?.replace(
      /&(lt|gt|amp|quot|apos);/g,
      (_, key) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[key],
    );
  try {
    fs.accessSync(node || "", fs.constants.X_OK);
  } catch {
    return {
      ok: false,
      detail:
        "The installed Node runtime moved or is missing. Run setup again to update it.",
    };
  }
  try {
    const { stdout } = await execute(
      "launchctl",
      ["print", `gui/${process.getuid()}/${SERVICE_LABEL}`],
      { timeout: 2500, maxBuffer: 64_000 },
    );
    return /state = running/.test(stdout)
      ? { ok: true, detail: "Running; starts when you log in" }
      : {
          ok: false,
          detail: "Installed, but stopped. Open Semaphore or run setup again.",
        };
  } catch {
    return { ok: false, detail: "Installed, but not loaded. Run setup again." };
  }
}

function claudeCheck(home) {
  const app = [
    "/Applications/Claude.app",
    path.join(home, "Applications", "Claude.app"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!app) return { ok: false, detail: "Not found" };
  let versions = [];
  try {
    versions = fs
      .readdirSync(
        path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude-code",
        ),
      )
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name));
  } catch {}
  const latest = versions
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  return {
    ok: true,
    detail: latest ? `Installed, with Claude Code ${latest}` : "Installed",
  };
}

async function reachable(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok && (await response.json()).app === "semaphore";
  } catch {
    return false;
  }
}
