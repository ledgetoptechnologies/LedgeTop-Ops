import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnedUploadTagBaseline, expectedOwnedUploadAnnotations, projectOwnedUploadTagSettings } from './production-auto-upload-tag.mjs';
import { projectAcknowledgedProductionAutoUploadTagSettings } from './production-auto-provider.mjs';

const sourceCommit = 'a'.repeat(40), candidateVersionId = '22222222-2222-4222-8222-222222222222';
const refusal = { message: 'production_auto_upload_tag_refused' };
function state(workerName) {
  const annotations = expectedOwnedUploadAnnotations(workerName, sourceCommit);
  return { latest: candidateVersionId, version: { id: '11111111-1111-4111-8111-111111111111' },
    latestVersion: { id: candidateVersionId, annotations },
    settings: { annotations: { ...annotations, other: 'protected' }, other: { retained: true } } };
}

test('raw baseline distinguishes absent from present null and refuses foreign tags/accessors', () => {
  assert.equal(readOwnedUploadTagBaseline({ settings: {} }), null);
  assert.equal(readOwnedUploadTagBaseline({ settings: { annotations: {} } }), null);
  assert.equal(readOwnedUploadTagBaseline({ settings: { annotations: { 'workers/tag': 'auto-bbbbbbbbbbbb' } } }), 'auto-bbbbbbbbbbbb');
  for (const value of [null, undefined, '', 'foreign-client-text', 'auto-aaaaaaaaaaa', {}, true])
    assert.throws(() => readOwnedUploadTagBaseline({ settings: { annotations: { 'workers/tag': value } } }), refusal);
  let invoked = false;
  const annotations = Object.defineProperty({}, 'workers/tag', { get() { invoked = true; return 'auto-aaaaaaaaaaaa'; } });
  assert.throws(() => readOwnedUploadTagBaseline({ settings: { annotations } }), refusal);
  assert.equal(invoked, false);
});

for (const workerName of ['ledgetop-clients','ledgetop-ops','ledgetop-ops-sync']) {
  test(`${workerName} exact acknowledged phase shape projects only its tag and preserves raw metadata`, () => {
    const raw = state(workerName), original = structuredClone(raw);
    for (const baseline of [null, 'auto-bbbbbbbbbbbb']) {
      const projected = projectOwnedUploadTagSettings(raw, { workerName, sourceCommit, candidateVersionId }, baseline);
      if (baseline === null) assert.equal(Object.hasOwn(projected.annotations, 'workers/tag'), false);
      else assert.equal(projected.annotations['workers/tag'], baseline);
      assert.equal(projected.annotations.other, 'protected'); assert.deepEqual(projected.other, raw.settings.other);
      assert.equal(projected.annotations['workers/message'], raw.settings.annotations['workers/message']);
      assert.deepEqual(raw, original);
    }
    for (const mutate of [
      value => { value.latest = value.version.id; },
      value => { value.latestVersion.id = value.version.id; },
      value => { value.settings.annotations['workers/tag'] = 'auto-bbbbbbbbbbbb'; },
      value => { delete value.settings.annotations['workers/tag']; },
      value => { value.latestVersion.annotations['workers/tag'] = 'auto-bbbbbbbbbbbb'; },
      value => { value.latestVersion.annotations['workers/message'] = 'foreign'; },
      value => { value.settings.annotations['workers/triggered_by'] = 'manual'; },
    ]) {
      const changed = structuredClone(raw); mutate(changed);
      assert.throws(() => projectOwnedUploadTagSettings(changed, { workerName, sourceCommit, candidateVersionId }, null), refusal);
    }
    assert.throws(() => projectOwnedUploadTagSettings(raw, { workerName, sourceCommit: 'b'.repeat(40), candidateVersionId }, null), refusal);
    assert.throws(() => projectOwnedUploadTagSettings(raw, { workerName, sourceCommit, candidateVersionId }, undefined), refusal);
    assert.throws(() => projectAcknowledgedProductionAutoUploadTagSettings({ id: candidateVersionId }, raw,
      { workerName, sourceCommit }), refusal, 'pure shapes cannot manufacture provider ACK authority');
  });
}
