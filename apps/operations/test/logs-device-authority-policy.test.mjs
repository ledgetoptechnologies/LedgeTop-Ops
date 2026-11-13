import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLogsDeviceAuthority, logsDeviceRevisionCurrent } from '../src/worker/logs-device-authority.ts';

const allowed = () => ({ staffActive: true, nativeAdmissionActive: true, identityMatches: true,
  nativeAdmissionVersion: 4, grantAdmissionVersion: 4, effect: 'allow', revision: 7 });

test('explicit coherent allow admits only its issued revision', () => {
  const authority = evaluateLogsDeviceAuthority(allowed());
  assert.deepEqual(authority, { eligible: true, revision: 7 });
  assert.equal(logsDeviceRevisionCurrent(authority, 7), true);
});

for (const [name, patch] of [
  ['missing grant', { effect: null, revision: null, grantAdmissionVersion: null }],
  ['explicit deny', { effect: 'deny' }],
  ['inactive staff', { staffActive: false }],
  ['inactive native admission', { nativeAdmissionActive: false }],
  ['different native identity', { identityMatches: false }],
  ['archived then restored admission', { nativeAdmissionVersion: 6 }],
  ['missing native admission', { nativeAdmissionVersion: null }],
  ['unversioned authority', { revision: 0 }],
  ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }],
]) test(`denies ${name}`, () => {
  const authority = evaluateLogsDeviceAuthority({ ...allowed(), ...patch });
  assert.equal(authority.eligible, false);
  assert.equal(logsDeviceRevisionCurrent(authority, 7), false);
});

test('revoking then explicitly regranting never revives a prior token', () => {
  const first = evaluateLogsDeviceAuthority(allowed());
  const denied = evaluateLogsDeviceAuthority({ ...allowed(), effect: 'deny', revision: 8 });
  const regranted = evaluateLogsDeviceAuthority({ ...allowed(), revision: 9 });
  assert.equal(logsDeviceRevisionCurrent(first, 7), true);
  assert.equal(logsDeviceRevisionCurrent(denied, 7), false);
  assert.equal(logsDeviceRevisionCurrent(regranted, 7), false);
  assert.equal(logsDeviceRevisionCurrent(regranted, 9), true);
});

test('legacy, malformed and missing issued revisions cannot use an eligible account', () => {
  const authority = evaluateLogsDeviceAuthority(allowed());
  for (const revision of [undefined, null, '7', 0, -1, 7.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(logsDeviceRevisionCurrent(authority, revision), false);
});
