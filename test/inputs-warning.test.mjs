import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('loading the input journal suppresses only SQLite startup noise and restores warning handling', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { withInputs } from ${JSON.stringify(new URL('../lib/inputs.mjs', import.meta.url).href)};
    const original = process.emitWarning;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-warning-'));
    try { withInputs(dir, (journal) => journal.all()); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
    if (process.emitWarning !== original) throw new Error('Warning handler was not restored');
    process.emitWarning('An unrelated warning remains visible', 'ExperimentalWarning');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  assert.match(result.stderr, /An unrelated warning remains visible/);
});
