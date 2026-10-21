import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fullMeshByteLimit,
  fullMeshDecodeTimeoutMs,
  fullMeshFailureDisposition,
  fullMeshUserMessage,
  isRetryableFullMeshError,
  withDecodeWatchdog,
} from '../full-mesh-runtime.mjs';

test('full mesh guardrail reserves decode headroom on low and high memory devices', () => {
  assert.equal(fullMeshByteLimit(2), 128 * 1024 * 1024);
  assert.equal(fullMeshByteLimit(4), 256 * 1024 * 1024);
  assert.equal(fullMeshByteLimit(8), 512 * 1024 * 1024);
  assert.equal(fullMeshByteLimit(32), 768 * 1024 * 1024);
  assert.equal(fullMeshByteLimit(8, 4 * 1024 * 1024 * 1024), Math.floor(4 * 1024 * 1024 * 1024 * 0.15));
  assert.equal(fullMeshDecodeTimeoutMs(64 * 1024 * 1024), 90_000);
  assert.equal(fullMeshDecodeTimeoutMs(512 * 1024 * 1024), 240_000);
});

test('a stale cancelled attempt cannot clear or recover over a newer retry', () => {
  const stale = {}, current = {};
  assert.deepEqual(fullMeshFailureDisposition(current, stale, { cancelled: true }), {
    isCurrent: false, clearSharedState: false, recover: false,
  });
  assert.deepEqual(fullMeshFailureDisposition(current, current, { cancelled: true }), {
    isCurrent: true, clearSharedState: true, recover: false,
  });
  assert.deepEqual(fullMeshFailureDisposition(current, current), {
    isCurrent: true, clearSharedState: true, recover: true,
  });
});

test('decode watchdog is bounded and invokes cancellation once', async () => {
  let cancelled = 0;
  await assert.rejects(withDecodeWatchdog(new Promise(() => {}), {
    timeoutMs: 10,
    onTimeout: () => { cancelled += 1; },
  }), { code: 'full_mesh_decode_timeout' });
  assert.equal(cancelled, 1);
});

test('full mesh errors are sanitized and classify safe retry behavior', () => {
  const tooLarge = Object.assign(new Error('/session-assets/secret/model.glb'), { code: 'asset_too_large' });
  const message = fullMeshUserMessage(tooLarge, { hasLod: true });
  assert.doesNotMatch(message, /session-assets|secret|model\.glb/);
  assert.match(message, /streaming LOD/);
  assert.match(fullMeshUserMessage(tooLarge, { hasLod: false }), /LOD derivative must finish/);
  assert.equal(isRetryableFullMeshError(tooLarge), false);
  assert.equal(isRetryableFullMeshError(Object.assign(new Error('network'), { code: 'asset_range_failed' })), true);
});
