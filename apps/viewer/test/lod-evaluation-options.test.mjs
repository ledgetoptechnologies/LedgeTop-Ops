import test from 'node:test';
import assert from 'node:assert/strict';
import { lodEvaluationOptions, formatJsHeap } from '../lod-evaluation-options.mjs';

test('distance demand defaults on with an explicit off override; loading timing stays opt-in', () => {
  assert.deepEqual(lodEvaluationOptions(), { distanceDemand: true, loadingTiming: false });
  assert.deepEqual(lodEvaluationOptions('?lodDistanceDemand=1'), { distanceDemand: true, loadingTiming: false });
  assert.deepEqual(lodEvaluationOptions('?lodLoadingTiming=1'), { distanceDemand: true, loadingTiming: true });
  assert.deepEqual(lodEvaluationOptions('?lodDistanceDemand=0'), { distanceDemand: false, loadingTiming: false });
  assert.deepEqual(lodEvaluationOptions('?lodDistanceDemand=0&lodLoadingTiming=1'), { distanceDemand: false, loadingTiming: true });
  assert.deepEqual(lodEvaluationOptions('?lodDistanceDemand=1&lodLoadingTiming=1'), { distanceDemand: true, loadingTiming: true });
  for (const value of ['true', 'yes', '-1', '100', 'NaN', '']) {
    assert.equal(lodEvaluationOptions('?lodDistanceDemand=' + value).distanceDemand, true);
    assert.equal(lodEvaluationOptions('?lodLoadingTiming=' + value).loadingTiming, false);
  }
  assert.equal(Object.isFrozen(lodEvaluationOptions()), true);
});

test('memory HUD identifies JS heap and binary units, not cache or device memory', () => {
  assert.equal(formatJsHeap(5 * 1024 ** 3), 'JS heap: 5120 MiB');
  assert.equal(formatJsHeap(0), 'JS heap: 0 MiB');
  for (const missing of [undefined, null, NaN, Infinity, -1, '1024']) {
    assert.equal(formatJsHeap(missing), 'JS heap: unavailable');
  }
});
