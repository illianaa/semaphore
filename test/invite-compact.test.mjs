import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInvite, compactSkillAvailable } from '../lib/invite.mjs';

test('compact invites preserve a custom root and full fallback, gated by installed skill', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-skill-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {};
  assert.equal(compactSkillAvailable('astra', { home, env }), false);
  const skill = path.join(home, '.codex/skills/semaphore');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'old skill');
  assert.equal(compactSkillAvailable('astra', { home, env }), false);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'SEMAPHORE_CONNECT_V1');
  assert.equal(compactSkillAvailable('astra', { home, env }), true);
  for (const speaker of ['astra', 'claude']) {
    const options = { room: { name: 'room-test', title: 'Test' }, root: "/Users/me/It's here/rooms", speaker };
    const full = buildInvite({ ...options, skillAvailable: false });
    assert.equal(full.prompt, full.fullPrompt);
    const compact = buildInvite({ ...options, skillAvailable: true });
    assert.equal(compact.prompt, compact.compactPrompt);
    assert.equal(compact.prompt.split('\n').length, 1);
    assert.match(compact.prompt, /--root '\/Users\/me\/It'\\''s here\/rooms'/);
    assert.match(compact.fullPrompt, /Only the speaker holding the talking stick/);
    const key = speaker === 'astra' ? 'prompt' : 'q';
    assert.equal(new URL(compact.url).searchParams.get(key), compact.prompt);
    assert.equal(new URL(compact.fullUrl).searchParams.get(key), compact.fullPrompt);
  }
});
