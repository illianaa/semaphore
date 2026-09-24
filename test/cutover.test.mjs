import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCutover } from '../dev/cutover.mjs';
import { stageRelease } from '../lib/releases.mjs';
import { projectDir } from '../lib/paths.mjs';
import { RoomStore } from '../lib/core.mjs';
import { sqliteDatabase } from '../lib/sqlite.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-cutover-'));
  const home = path.join(directory, 'user');
  const data = path.join(home, '.semaphore');
  const old = path.join(directory, 'old');
  const oldSkill = path.join(old, 'skills', 'semaphore');
  const links = ['.claude', '.codex'].map(folder => path.join(home, folder, 'skills', 'semaphore'));
  const command = path.join(data, 'bin', 'semaphore');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.semaphore.app.plist');
  fs.mkdirSync(oldSkill, { recursive: true });
  fs.writeFileSync(path.join(oldSkill, 'SKILL.md'), '---\nname: semaphore\n---\n');
  fs.writeFileSync(path.join(old, 'cli.mjs'), '// old CLI');
  for (const link of links) { fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(oldSkill, link); }
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const oldCommand = '#!/bin/sh\n# Installed by Semaphore\nold command\n';
  const oldPlist = '<!-- Installed by Semaphore --><string>local.semaphore.app</string>';
  fs.writeFileSync(command, oldCommand); fs.writeFileSync(plist, oldPlist);
  const store = new RoomStore(path.join(data, 'rooms'), 'test');
  store.acquire(); const room = store.loadOrCreate();
  room.owner = 'claude'; room.pending = { id: 'saved-turn', speaker: 'claude', state: 'awaiting-reply' };
  store.save(room); store.release();
  fs.writeFileSync(path.join(store.workspace, 'deliverable.html'), '<h1>Keep my work</h1>');
  const db = new (sqliteDatabase())(path.join(store.dir, 'human-inputs.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE inputs(payload TEXT); INSERT INTO inputs VALUES ('Saved during a turn')");
  const staged = stageRelease({ source: projectDir, destination: path.join(directory, 'releases'), run: () => ({ status: 0 }) });
  const state = { app: 101, wake: 202, generation: 101, failBootstrap: false };
  const calls = [], output = [];
  const deps = { home, env: {}, uid: 501, say: text => output.push(text), pause: async () => {},
    run: (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === '--version') return { status: 0, stdout: 'v23.10.0\n' };
      assert.equal(bin, 'launchctl');
      if (args[0] === 'print') {
        const pid = args[1].endsWith('local.semaphore.codex-wake') ? state.wake : state.app;
        return { status: pid ? 0 : 1, stdout: `\tpid = ${pid}\n` };
      }
      assert.ok(!args.some(arg => arg.includes('codex-wake')), 'never mutate the native wake engine');
      if (args[0] === 'bootout') state.app = null;
      if (args[0] === 'bootstrap') {
        if (state.failBootstrap) return { status: 1, stderr: 'registration failed' };
        state.app = ++state.generation;
      }
      return { status: 0, stdout: '' };
    },
    request: async () => ({ ok: !!state.app, json: async () =>
      fs.readFileSync(plist, 'utf8').includes(staged.directory)
        ? { app: 'semaphore', pid: state.app, runtime: staged.runtime }
        : { app: 'semaphore', pid: state.app } }), // The legacy server does not expose its build.
  };
  const backup = () => path.join(data, 'backups', fs.readdirSync(path.join(data, 'backups'))[0]);
  t.after(() => {
    db.close();
    const unlock = file => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) return;
      fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const child of fs.readdirSync(file)) unlock(path.join(file, child)); };
    unlock(directory); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, data, oldSkill, links, command, plist, oldCommand, oldPlist, store, staged, state, calls, output, deps, backup };
}

test('cutover dry-run is read-only, then apply snapshots WAL input and preserves turns through rollback', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.store.file, 'utf8');
  await runCutover({ release: f.staged.directory }, f.deps);
  assert.equal(fs.existsSync(path.join(f.data, 'backups')), false);
  assert.equal(fs.readFileSync(f.command, 'utf8'), f.oldCommand);
  assert.ok(f.calls.every(call => call[1] === 'print' || call[1] === '--version'));
  await runCutover({ release: f.staged.directory, apply: true }, f.deps);
  assert.match(fs.readFileSync(f.command, 'utf8'), /\/opt\/homebrew\/opt\/node\/bin\/node/);
  assert.ok(fs.readFileSync(f.plist, 'utf8').includes(f.staged.directory));
  for (const link of f.links) assert.equal(fs.readlinkSync(link), path.join(f.staged.directory, 'skills', 'semaphore'));
  const backup = f.backup();
  const copy = new (sqliteDatabase())(path.join(backup, 'rooms', 'test', 'human-inputs.sqlite'), { readOnly: true });
  assert.equal(copy.prepare('SELECT payload FROM inputs').get().payload, 'Saved during a turn'); copy.close();
  assert.equal(fs.existsSync(path.join(backup, 'rooms', 'test', 'lock')), false);
  assert.equal(fs.existsSync(path.join(backup, 'rooms', 'test', 'workspace')), false);
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
  await runCutover({ rollback: backup }, f.deps);
  assert.equal(fs.readFileSync(f.command, 'utf8'), f.oldCommand);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), f.oldPlist);
  for (const link of f.links) assert.equal(fs.readlinkSync(link), f.oldSkill);
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
  assert.equal(f.state.wake, 202);
});

test('cutover rejects foreign destinations, invalid ports, and an in-flight delivery before activation', async t => {
  const f = fixture(t);
  await assert.rejects(runCutover({ release: f.staged.directory, port: 'bad', apply: true }, f.deps), /port/);
  fs.writeFileSync(f.command, '#!/bin/sh\nAn unrelated command');
  await assert.rejects(runCutover({ release: f.staged.directory, apply: true }, f.deps), /not installed by Semaphore/);
  assert.equal(fs.existsSync(path.join(f.data, 'backups')), false);
  fs.writeFileSync(f.command, f.oldCommand);
  f.store.acquire(); const room = f.store.read(); room.pending.state = 'delivering'; f.store.save(room); f.store.release();
  await assert.rejects(runCutover({ release: f.staged.directory, apply: true }, f.deps), /delivery in progress/);
  assert.equal(fs.readFileSync(f.command, 'utf8'), f.oldCommand);
  assert.equal(fs.existsSync(f.store.lockFile), false);
  assert.ok(f.calls.every(call => call[1] === 'print' || call[1] === '--version'));
});

test('rollback preflights the whole installation and refuses newer or unrelated replacements', async t => {
  const f = fixture(t);
  await runCutover({ release: f.staged.directory, apply: true }, f.deps);
  const backup = f.backup();
  await assert.rejects(runCutover({ rollback: backup }, { ...f.deps, env: { SEMAPHORE_HOME: path.join(f.directory, 'other') } }), /different installation/);
  const installedCommand = fs.readFileSync(f.command, 'utf8');
  fs.appendFileSync(f.plist, '\n<!-- A later edit -->');
  await assert.rejects(runCutover({ rollback: backup }, f.deps), /changed after this cutover/);
  assert.equal(fs.readFileSync(f.command, 'utf8'), installedCommand, 'preflight before any restore');
  fs.writeFileSync(f.plist, fs.readFileSync(f.plist, 'utf8').replace('\n<!-- A later edit -->', ''));
  fs.unlinkSync(f.links[1]); fs.mkdirSync(f.links[1]);
  await assert.rejects(runCutover({ rollback: backup }, f.deps), /changed after this cutover/);
  assert.equal(fs.readFileSync(f.command, 'utf8'), installedCommand);
});

test('failed registration leaves a recoverable backup and rollback works with a missing release', async t => {
  const f = fixture(t);
  f.state.failBootstrap = true;
  await assert.rejects(runCutover({ release: f.staged.directory, apply: true }, f.deps), /Could not register/);
  const backup = f.backup();
  fs.renameSync(f.staged.directory, `${f.staged.directory}-unavailable`);
  f.state.failBootstrap = false;
  await runCutover({ rollback: backup }, f.deps);
  assert.equal(fs.readFileSync(f.command, 'utf8'), f.oldCommand);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), f.oldPlist);
  assert.ok(f.state.app);
});
