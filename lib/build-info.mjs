import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectDir } from './paths.mjs';

export const PROTOCOL_VERSION = 1;
export const RELEASE_MANIFEST = 'semaphore-release.json';
const SOURCES = ['package.json', 'package-lock.json', 'cli.mjs', 'server.mjs', 'lib', 'web', 'skills', 'docs', 'README.md', 'DESIGN.md', 'LICENSE'];

export function sourceFingerprint(directory) {
  const hash = createHash('sha256');
  function visit(relative) {
    const file = path.join(directory, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Runtime source must not be a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const contents = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      hash.update(JSON.stringify([relative, contents]));
    } else throw new Error(`Runtime source is not a regular file: ${relative}`);
  }
  for (const source of SOURCES) visit(source);
  return hash.digest('hex');
}

export function captureRuntime(directory = projectDir) {
  const { version } = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const build = sourceFingerprint(directory);
  const manifestPath = path.join(directory, RELEASE_MANIFEST);
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  if (manifest && (manifest.kind !== 'semaphore-release' || manifest.schema !== 1 ||
      manifest.build !== build || manifest.version !== version || manifest.protocol !== PROTOCOL_VERSION))
    throw new Error('This Semaphore release no longer matches its manifest. Restore or stage a reviewed release; do not edit it in place.');
  return Object.freeze({ version, protocol: PROTOCOL_VERSION, build,
    kind: manifest ? 'release' : 'development snapshot', pid: process.pid, startedAt: new Date().toISOString() });
}

// Captured once for this module graph, never re-read when a turn is rendered.
export const RUNTIME = captureRuntime();
export function runtimeIdentity(runtime = RUNTIME) {
  const { version, protocol, build, kind } = runtime;
  return { version, protocol, build, kind };
}
export function sameBuild(a, b = RUNTIME) {
  return !!a && a.version === b.version && a.protocol === b.protocol && a.build === b.build;
}
export function formatRuntime(runtime = RUNTIME) {
  if (!runtime || typeof runtime.version !== 'string' || !Number.isInteger(runtime.protocol) ||
      typeof runtime.build !== 'string' || typeof runtime.kind !== 'string') return 'unknown runtime';
  return `Semaphore ${runtime.version} · protocol ${runtime.protocol} · build ${runtime.build.slice(0, 12)} · ${runtime.kind}`;
}
export function runtimeChange(participant) {
  const previous = participant?.lastReceivedRuntime ?? participant?.joinedRuntime;
  if (!previous) return `This chat's earlier runtime was not recorded. Current receive: ${formatRuntime()}. Follow the commands in this envelope.`;
  if (sameBuild(previous)) return '';
  return `Runtime changed since this chat's ${participant.lastReceivedRuntime ? 'last receive' : 'join'}: ${formatRuntime(previous)} → ${formatRuntime()}. Use this envelope's commands; the skill already loaded in your chat may be older.`;
}
