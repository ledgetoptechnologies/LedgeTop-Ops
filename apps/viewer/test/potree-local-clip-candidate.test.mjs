import test from 'node:test';
import assert from 'node:assert/strict';
import { patchPotreeLocalClip, POTREE_INPUT_SHA256, POTREE_OUTPUT_SHA256 } from '../scripts/potree-local-clip-candidate.mjs';

test('candidate rejects anything other than the exact reviewed bundle', () => {
  assert.match(POTREE_INPUT_SHA256, /^[a-f0-9]{64}$/);
  assert.match(POTREE_OUTPUT_SHA256, /^[a-f0-9]{64}$/);
  assert.notEqual(POTREE_INPUT_SHA256, POTREE_OUTPUT_SHA256);
  for (const value of [null, '', 'clipBoxes[i] * modelMatrix * vec4( position, 1.0 )'])
    assert.throws(() => patchPotreeLocalClip(value), /Unexpected Potree bundle hash/);
});
