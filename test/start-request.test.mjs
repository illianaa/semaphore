import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStartRequest } from '../web/start-request.mjs';

const base = { text: 'Review the plan', to: 'claude', members: ['astra', 'claude'] };
const noNewId = () => { throw new Error('A retry must keep its original ID'); };

test('a pre-limit lost-response retry keeps its identity and omits the new field', () => {
  const previous = { fingerprint: JSON.stringify(base), clientId: 'old-start-request' };
  const retry = prepareStartRequest({ ...base, maxTurns: 4 }, previous, noNewId);
  assert.deepEqual(retry.request, previous);
  assert.deepEqual(retry.body, { ...base, clientId: previous.clientId });
  assert.deepEqual(prepareStartRequest({ ...base, maxTurns: 4 }, retry.request, noNewId), retry);
});

test('new limits survive retries, while changing the choice creates a distinct request', () => {
  for (const maxTurns of [4, 10, 20, null]) {
    const input = { ...base, maxTurns };
    const first = prepareStartRequest(input, null, () => 'new-start-request');
    assert.equal(first.body.maxTurns, maxTurns);
    assert.deepEqual(prepareStartRequest(input, first.request, noNewId), first);
    const changed = prepareStartRequest({ ...input, maxTurns: maxTurns === null ? 4 : null }, first.request, () => 'changed-start-request');
    assert.equal(changed.body.clientId, 'changed-start-request');
  }
  const old = { fingerprint: JSON.stringify(base), clientId: 'old-start-request' };
  const changed = prepareStartRequest({ ...base, maxTurns: null }, old, () => 'changed-start-request');
  assert.equal(changed.body.clientId, 'changed-start-request');
  assert.equal(changed.body.maxTurns, null);
});
