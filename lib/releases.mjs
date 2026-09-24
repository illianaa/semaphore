import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { projectDir, dataHome } from './paths.mjs';
import { captureRuntime, RELEASE_MANIFEST } from './build-info.mjs';

function walk(file, visitor) {
  const stat = fs.lstatSync(file);
  if (stat.isDirectory()) for (const child of fs.readdirSync(file)) walk(path.join(file, child), visitor);
  visitor(file, stat);
}

// Staging has no activation side effects. The installation cutover is deliberate
// and separately reviewed; old snapshots remain available to existing commands.
export function stageRelease({ source = projectDir, destination = path.join(dataHome, 'releases'), run = spawnSync } = {}) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (destination === source || destination.startsWith(source + path.sep))
    throw new Error('Stage releases outside the source checkout.');
  const runtime = captureRuntime(source);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(runtime.version)) throw new Error('Invalid package version for a release folder.');
  const target = path.join(destination, `${runtime.version}-${runtime.build.slice(0, 16)}`);
  if (fs.existsSync(target)) {
    const existing = captureRuntime(target);
    if (existing.kind !== 'release' || existing.build !== runtime.build) throw new Error('Release destination is already occupied.');
    return { directory: target, runtime: existing, existing: true };
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const temp = path.join(destination, `.staging-${randomUUID()}`);
  fs.mkdirSync(temp, { mode: 0o700 });
  try {
    const files = [...new Set(['package.json', 'package-lock.json', ...pkg.files])];
    for (const relative of files) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid package release path.');
      const from = path.join(source, relative);
      walk(from, (file, stat) => { if (stat.isSymbolicLink()) throw new Error(`Release source must not be a symlink: ${file}`); });
      fs.cpSync(from, path.join(temp, relative), { recursive: true, preserveTimestamps: true });
    }
    const npm = path.join(path.dirname(process.execPath), 'npm');
    const installed = run(fs.existsSync(npm) ? npm : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: temp, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    if (installed.status !== 0) throw new Error(`Release dependencies failed: ${installed.stderr || installed.error?.message || installed.stdout || 'npm ci failed'}`);
    if (captureRuntime(temp).build !== runtime.build || captureRuntime(source).build !== runtime.build)
      throw new Error('Source changed during staging. Review it and stage again.');
    fs.writeFileSync(path.join(temp, RELEASE_MANIFEST), JSON.stringify({ kind: 'semaphore-release', schema: 1,
      version: runtime.version, protocol: runtime.protocol, build: runtime.build, stagedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    walk(temp, (file, stat) => {
      if (!stat.isSymbolicLink()) fs.chmodSync(file, stat.isDirectory() || (stat.mode & 0o111) ? 0o555 : 0o444);
    });
    fs.renameSync(temp, target);
    return { directory: target, runtime: captureRuntime(target), existing: false };
  } catch (error) {
    if (fs.existsSync(temp)) {
      // Undo only our temporary snapshot's permissions so failed staging can clean up.
      const unlock = file => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) return;
        fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
        if (stat.isDirectory()) for (const child of fs.readdirSync(file)) unlock(path.join(file, child)); };
      unlock(temp); fs.rmSync(temp, { recursive: true, force: true });
    }
    throw error;
  }
}
