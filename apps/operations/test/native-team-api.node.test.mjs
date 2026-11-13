import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTeamApi, NativeTeamApiError } from '../src/client/native-team-api.ts';

const now = Date.parse('2026-11-13T20:00:00Z');
const commandId = '6ff2d6d5-b657-4b4b-8ff2-7d3aa74db246';
const token = '2991000.' + 'a'.repeat(64);
const session = { csrfToken: token, verifiedUntil: new Date(now + 60_000).toISOString() };
const command = { commandId, expectedVersion: 3, reason: 'Staff request' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const receipt = (action = 'disable', overrides = {}) => ({ receipt: {
  commandId, contractVersion: 1,
  capability: action === 'profile' ? 'staff.profile.edit' : `staff.admission.${action}`,
  targetStaffId: 'staff-test', resultVersion: 4, replayed: false, ...overrides,
}, accessReconciliation: action === 'profile' ? 'unchanged' : 'pending' });
const fails = (code, outcome, id) => error => {
  assert.ok(error instanceof NativeTeamApiError);
  assert.equal(error.code, code); assert.equal(error.outcome, outcome);
  if (id) assert.equal(error.commandId, id);
  return true;
};

test('native mutation obtains fresh native CSRF; preserves command and expected revision', async () => {
  const calls = [];
  const api = createNativeTeamApi(async (path, init) => {
    calls.push({ path, init }); return json(calls.length === 1 ? session : receipt());
  }, () => now);
  await api.lifecycle('staff-test', 'disable', command);
  assert.deepEqual(calls.map(c => c.path), ['/api/native-staff/session', '/api/native-staff/staff-test/disable']);
  assert.equal(calls[0].init.headers['X-Native-Staff-Request'], '1');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], token);
  assert.deepEqual(JSON.parse(calls[1].init.body), command);
  for (const { init } of calls) {
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
  }
});

test('gate-off and denied sessions never attempt a mutation or fallback identity', async () => {
  for (const [status, code] of [[404, 'setup_required'], [403, 'denied'], [401, 'ended']]) {
    let calls = 0;
    const api = createNativeTeamApi(async () => { calls++; return new Response('', { status }); }, () => now);
    await assert.rejects(api.lifecycle('staff-test', 'disable', command), fails(code, 'not_sent'));
    assert.equal(calls, 1);
  }
});

test('invalid IDs, extra fields, unsupported actions and oversized UTF-8 bodies stay local', async () => {
  let calls = 0;
  const api = createNativeTeamApi(async () => { calls++; throw Error(); }, () => now);
  for (const [id, action, body] of [
    ['../owner', 'disable', command], ['staff-test', 'delete', command],
    ['staff-test', 'enable', { ...command, isOwner: true }],
    ['staff-test', 'profile', { ...command, reason: '漢'.repeat(500), displayName: '字'.repeat(160) }],
    ['staff-test', 'disable', { ...command, expectedVersion: Number.MAX_SAFE_INTEGER }],
  ]) await assert.rejects(api.lifecycle(id, action, body), fails('invalid_request', 'not_sent'));
  assert.equal(calls, 0);
});

test('request snapshot cannot be edited while the native session is being fetched', async () => {
  const input = { ...command }; let sent;
  const api = createNativeTeamApi(async (path, init) => {
    if (path.endsWith('/session')) { input.expectedVersion = 99; input.reason = 'changed'; return json(session); }
    sent = JSON.parse(init.body); return json(receipt());
  }, () => now);
  await api.lifecycle('staff-test', 'disable', input);
  assert.deepEqual(sent, command);
});

test('lost acknowledgement never auto-retries and retains the exact command ID', async () => {
  let calls = 0;
  const api = createNativeTeamApi(async () => { calls++; if (calls === 1) return json(session); throw Error('lost ACK'); }, () => now);
  await assert.rejects(api.lifecycle('staff-test', 'disable', command), fails('unavailable', 'unknown', commandId));
  assert.equal(calls, 2);
});

test('only matching committed receipts are accepted, including legitimate replay', async () => {
  for (const overrides of [{ targetStaffId: 'staff-other' }, { commandId: crypto.randomUUID() }, { resultVersion: 8 }, { capability: 'staff.identity.recover' }]) {
    const api = createNativeTeamApi(async path => json(path.endsWith('/session') ? session : receipt('disable', overrides)), () => now);
    await assert.rejects(api.lifecycle('staff-test', 'disable', command), fails('invalid_response', 'unknown', commandId));
  }
  const api = createNativeTeamApi(async path => json(path.endsWith('/session') ? session : receipt('disable', { replayed: true })), () => now);
  assert.equal((await api.lifecycle('staff-test', 'disable', command)).receipt.replayed, true);
});

test('profile edits cannot change login email and require the profile revision', async () => {
  const api = createNativeTeamApi(async path => json(path.endsWith('/session') ? session : receipt('profile')), () => now);
  assert.equal((await api.lifecycle('staff-test', 'profile', { ...command, displayName: 'Updated name' })).accessReconciliation, 'unchanged');
  await assert.rejects(api.lifecycle('staff-test', 'profile', { ...command, displayName: 'Updated', loginEmail: 'other@example.test' }), fails('invalid_request', 'not_sent'));
});

test('HTML, malformed JSON, expired sessions and oversized responses are rejected', async () => {
  for (const response of [
    new Response('<html>sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    json({ ...session, verifiedUntil: new Date(now).toISOString() }),
    json({ ...session, csrfToken: 'generic-token' }), json({ ...session, extra: true }),
    json({ data: 'x'.repeat(128 * 1024) }),
  ]) {
    const api = createNativeTeamApi(async () => response, () => now);
    await assert.rejects(api.session(), fails('invalid_response', 'not_sent'));
  }
});

test('profile reads verify exact target and do not expose a wider management snapshot', async () => {
  const profile = { capability: 'staff.profile.read', target: { staffId: 'staff-test', admissionActive: true, admissionVersion: 1, profileVersion: 2 }, authorization: { allowed: true }, scopedProfile: { loginEmail: 'test@example.test', displayName: 'Test' }, managementSnapshot: null };
  let result = profile;
  const api = createNativeTeamApi(async () => json(result), () => now);
  assert.deepEqual(await api.profile('staff-test'), profile);
  result = { ...profile, managementSnapshot: { delegations: [] } };
  await assert.rejects(api.profile('staff-test'), fails('invalid_response', 'not_sent'));
  result = { ...profile, target: { ...profile.target, staffId: 'other' } };
  await assert.rejects(api.profile('staff-test'), fails('invalid_response', 'not_sent'));
});

const eligibility = { staffId: 'staff-test', username: 'pilot-test', effect: null, revision: 0,
  admissionVersion: 2, eligible: false, csrfToken: 'b'.repeat(43), verifiedUntil: session.verifiedUntil };

test('Logs eligibility uses its own exact readback token; no implicit grant from a username', async () => {
  const calls = [];
  const api = createNativeTeamApi(async (path, init) => {
    calls.push({ path, init });
    return json(init.method === 'GET' ? eligibility : { receipt: { commandId, staffId: 'staff-test', revision: 1, effect: 'allow', replayed: false } });
  }, () => now);
  assert.equal((await api.logsEligibility('staff-test')).eligible, false);
  assert.equal(calls.length, 1);
  await api.setLogsEligibility('staff-test', { commandId, expectedRevision: 0, expectedAdmissionVersion: 2, effect: 'allow', reason: 'Approved pilot' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.path === '/api/staff-device-eligibility/staff-test'));
  assert.equal(calls[2].init.headers['X-CSRF-Token'], eligibility.csrfToken);
  assert.equal(JSON.parse(calls[2].init.body).expectedRevision, 0);
});

test('Logs retries do not rebase stale revisions or accept another target receipt', async () => {
  let body;
  const api = createNativeTeamApi(async (_path, init) => {
    if (init.method === 'GET') return json({ ...eligibility, effect: 'deny', revision: 7 });
    body = JSON.parse(init.body);
    return json({ receipt: { commandId, staffId: 'staff-other', revision: 1, effect: 'allow', replayed: false } });
  }, () => now);
  await assert.rejects(api.setLogsEligibility('staff-test', { commandId, expectedRevision: 0, expectedAdmissionVersion: 2, effect: 'allow', reason: 'Approved' }), fails('invalid_response', 'unknown', commandId));
  assert.equal(body.expectedRevision, 0);
  assert.equal(body.expectedAdmissionVersion, 2);
});

test('definite command rejections allow review; ambiguous failures retain the command', async () => {
  for (const [status, code, outcome] of [[409, 'conflict', 'rejected'], [400, 'invalid_request', 'rejected'],
    [404, 'not_found', 'rejected'], [403, 'denied', 'unknown'], [503, 'unavailable', 'unknown']]) {
    const api = createNativeTeamApi(async (_path, init) => init.method === 'GET' ? json(eligibility) : new Response('', { status }), () => now);
    await assert.rejects(api.setLogsEligibility('staff-test', { commandId, expectedRevision: 0, expectedAdmissionVersion: 2, effect: 'allow', reason: 'Reviewed' }), fails(code, outcome, commandId));
  }
});

test('Logs missing schema or authority is a failure, not an empty/ineligible success', async () => {
  for (const status of [403, 404, 503]) {
    let calls = 0;
    const api = createNativeTeamApi(async () => { calls++; return new Response('', { status }); }, () => now);
    await assert.rejects(api.setLogsEligibility('staff-test', { commandId, expectedRevision: 0, expectedAdmissionVersion: 2, effect: 'allow', reason: 'Approved' }), error => error instanceof NativeTeamApiError && error.outcome === 'not_sent');
    assert.equal(calls, 1);
  }
  const api = createNativeTeamApi(async () => json({ ...eligibility, effect: 'deny', eligible: true }), () => now);
  await assert.rejects(api.logsEligibility('staff-test'), fails('invalid_response', 'not_sent'));
});
