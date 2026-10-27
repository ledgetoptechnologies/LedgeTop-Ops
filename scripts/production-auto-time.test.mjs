import test from 'node:test';
import assert from 'node:assert/strict';
import { isProviderUtcTimestamp, minimumRetainedUntil } from './production-auto-time.mjs';

test('provider timestamps retain microsecond precision and retention rounds up lost fractions', () => {
  const observed = '2026-10-27T07:20:51.938465Z';
  assert.equal(isProviderUtcTimestamp(observed), true);
  assert.equal(minimumRetainedUntil(observed, 48), '2026-10-29T07:20:51.939Z');
  assert.equal(minimumRetainedUntil('2026-10-27T07:20:51.938000Z', 48), '2026-10-29T07:20:51.938Z');
  assert.equal(minimumRetainedUntil('2026-10-27T07:20:51.938Z', 48), '2026-10-29T07:20:51.938Z');
});

test('provider timestamps require strict UTC RFC3339 shape and valid calendar fields', () => {
  for (const value of [null, '', '2026-10-27T07:20:51Z', '2026-10-27T07:20:51.9Z',
    '2026-10-27T07:20:51.938+00:00', '2026-02-30T07:20:51.938Z', '2026-10-27T25:20:51.938Z',
    '2026-10-27T07:20:51.9381234567Z']) assert.equal(isProviderUtcTimestamp(value), false);
  assert.throws(() => minimumRetainedUntil('2026-10-27T07:20:51Z', 48));
});
