import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const scope = (label) => path.join(process.cwd(), `.browser-lock-test-${label}-${randomUUID()}`);

test('browser harness lock serializes concurrent contenders', async () => {
  const root = scope('serialize');
  let active = 0;
  let maximumActive = 0;
  const entered = [];
  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const release = await acquireBrowserHarnessLock({ root, waitTimeoutMs: 2_000 });
    try {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered.push(index);
      await wait(75);
      active -= 1;
    } finally {
      release();
    }
  }));
  assert.equal(maximumActive, 1);
  assert.deepEqual(entered.toSorted(), [0, 1, 2, 3]);
});

test('an old release callback cannot delete a successor lock', async () => {
  const root = scope('owner');
  const releaseFirst = await acquireBrowserHarnessLock({ root, waitTimeoutMs: 2_000 });
  releaseFirst();
  const releaseCurrent = await acquireBrowserHarnessLock({ root, waitTimeoutMs: 2_000 });
  releaseFirst();
  await assert.rejects(
    acquireBrowserHarnessLock({ root, waitTimeoutMs: 150 }),
    /Timed out/,
  );
  releaseCurrent();
});

test('browser harness lock has a bounded wait when an owner remains live', async () => {
  const root = scope('timeout');
  const release = await acquireBrowserHarnessLock({ root, waitTimeoutMs: 2_000 });
  await assert.rejects(
    acquireBrowserHarnessLock({ root, waitTimeoutMs: 150 }),
    /Timed out after 150ms/,
  );
  release();
});
