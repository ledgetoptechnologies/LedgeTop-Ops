import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTeamApi, NativeTeamApiError } from '../src/client/native-team-api.ts';
import { nativeStaffInvitationUrl, parseNativeStaffInvitation } from '../src/client/native-staff-onboarding-link.ts';

const commandId = '6ff2d6d5-b657-4b4b-8ff2-7d3aa74db246';
const onboardingId = '09bd08d6-3fe8-4c3c-a73d-8515a950a25b';
const now = Date.parse('2026-11-13T20:00:00Z');
const session = { csrfToken: '2991000.' + 'a'.repeat(64), verifiedUntil: new Date(now + 60_000).toISOString() };
const input = { commandId, loginEmail: 'synthetic@example.test', displayName: 'Synthetic employee', expiresAt: new Date(now + 86_400_000).toISOString(), reason: 'Synthetic test' };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const created = { receipt: { commandId, onboardingId, proposedStaffId: 'staff-synthetic', resultVersion: 1, replayed: false, state: 'pending' }, state: 'pending', permissionsGranted: false };
const review = { onboardingId, proposedStaffId: 'staff-synthetic', state: 'claimed', version: 2, loginEmail: input.loginEmail,
  displayName: input.displayName, expiresAt: input.expiresAt, claimedAccessSubject: ' opaque-subject ', claimEvidenceSha256: 'b'.repeat(64),
  proposalSha256: 'c'.repeat(64), proposal: { memberships: [], directoryGrants: [], managementGrants: [] }, createdByStaffId: 'staff-inviter', reason: input.reason };
const errorIs = (code, outcome) => e => e instanceof NativeTeamApiError && e.code === code && e.outcome === outcome;

test('invitation creation snapshots exact body and grants no permissions', async () => {
  let body; const mutable = { ...input };
  const api = createNativeTeamApi(async (path, init) => {
    if (path.endsWith('/session')) { mutable.loginEmail = 'changed@example.test'; return json(session); }
    body = JSON.parse(init.body); assert.equal(init.headers['X-CSRF-Token'], session.csrfToken); return json(created);
  }, () => now);
  assert.deepEqual(await api.onboardingCreate(mutable), created);
  assert.deepEqual(body, input);
});

test('invitation creation rejects ACL injection, expired inputs and a permissions-granting receipt', async () => {
  let calls = 0;
  const api = createNativeTeamApi(async path => { calls++; return json(path.endsWith('/session') ? session : { ...created, permissionsGranted: true }); }, () => now);
  await assert.rejects(api.onboardingCreate({ ...input, roles: ['owner'] }), errorIs('invalid_request', 'not_sent'));
  await assert.rejects(api.onboardingCreate({ ...input, expiresAt: new Date(now).toISOString() }), errorIs('invalid_request', 'not_sent'));
  assert.equal(calls, 0);
  await assert.rejects(api.onboardingCreate(input), errorIs('invalid_response', 'unknown'));
});

test('revealing is explicit, validates secret and never retains it in errors', async () => {
  let calls = 0;
  const api = createNativeTeamApi(async path => { calls++; return json(path.endsWith('/session') ? session : {
    commandId, onboardingId, proposedStaffId: 'staff-synthetic', expiresAt: input.expiresAt, invitationSecret: 'sensitive malformed secret',
  }); }, () => now);
  assert.equal(calls, 0);
  await assert.rejects(api.onboardingReveal(commandId), error => {
    assert.ok(errorIs('invalid_response', 'unknown')(error)); assert.ok(!JSON.stringify(error).includes('sensitive')); return true;
  });
});

test('uncertain creation can reconcile an exact expired snapshot without extending expiry', async () => {
  const expired = { ...input, expiresAt: new Date(now - 1000).toISOString() };
  let posted;
  const api = createNativeTeamApi(async (path, init) => {
    if (path.endsWith('/session')) return json(session);
    posted = JSON.parse(init.body); return json({ ...created, receipt: { ...created.receipt, replayed: true } });
  }, () => now);
  await assert.rejects(api.onboardingCreate(expired), errorIs('invalid_request', 'not_sent'));
  assert.equal((await api.onboardingCreate(expired, undefined, true)).receipt.replayed, true);
  assert.deepEqual(posted, expired);
});

test('review accepts opaque verified subject unchanged, but refuses nonempty permissions or wrong target', async () => {
  let value = review;
  const api = createNativeTeamApi(async () => json({ review: value }), () => now);
  assert.equal((await api.onboardingReview(onboardingId)).claimedAccessSubject, review.claimedAccessSubject);
  value = { ...review, proposal: { ...review.proposal, directoryGrants: [{ permission: 'owner' }] } };
  await assert.rejects(api.onboardingReview(onboardingId), errorIs('invalid_response', 'not_sent'));
  value = { ...review, onboardingId: commandId };
  await assert.rejects(api.onboardingReview(onboardingId), errorIs('invalid_response', 'not_sent'));
});

test('approval binds exact reviewed hashes and version and reports reconciliation pending', async () => {
  const approved = { receipt: { commandId, onboardingId, proposedStaffId: 'staff-synthetic', resultVersion: 3, state: 'approved', replayed: true }, permissionsGranted: false, accessReconciliation: 'pending' };
  const approval = { commandId, onboardingId, expectedVersion: 2, proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256, reason: 'Independent review' };
  let body;
  const api = createNativeTeamApi(async (path, init) => {
    if (path.endsWith('/session')) return json(session);
    body = JSON.parse(init.body); return json(approved);
  }, () => now);
  assert.deepEqual(await api.onboardingApprove(approval), approved); assert.deepEqual(body, approval);
  await assert.rejects(api.onboardingApprove({ ...approval, expectedVersion: 1 }), errorIs('invalid_request', 'not_sent'));
});

test('cancellation supports only the reviewed pending or claimed revision', async () => {
  for (const expectedVersion of [1, 2]) {
    const api = createNativeTeamApi(async path => json(path.endsWith('/session') ? session : { receipt: { commandId, onboardingId, resultVersion: expectedVersion + 1, state: 'cancelled', replayed: false } }), () => now);
    assert.equal((await api.onboardingCancel({ commandId, onboardingId, expectedVersion, reason: 'Withdraw invite' })).receipt.resultVersion, expectedVersion + 1);
  }
});

test('recipient claim obtains only claimant-audience session with separate request header', async () => {
  const calls = [];
  const claimToken = '2991000.' + 'd'.repeat(64);
  const claim = { onboardingId, invitationSecret: 'e'.repeat(64) };
  const api = createNativeTeamApi(async (path, init) => {
    calls.push({ path, init });
    return json(path.endsWith('/session') ? { ...session, csrfToken: claimToken } : { onboardingId, state: 'claimed' });
  }, () => now);
  assert.deepEqual(await api.onboardingClaim(claim), { onboardingId, state: 'claimed' });
  assert.deepEqual(calls.map(c => c.path), ['/api/native-staff/onboarding/claim/session', '/api/native-staff/onboarding/claim']);
  assert.equal(calls[0].init.headers['X-Onboarding-Claim-Request'], '1');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], claimToken);
  assert.deepEqual(JSON.parse(calls[1].init.body), claim);
});

test('claim gate/authority failure cannot fall back to an existing staff identity', async () => {
  for (const status of [404, 403]) {
    const paths = [];
    const api = createNativeTeamApi(async path => { paths.push(path); return new Response('', { status }); }, () => now);
    await assert.rejects(api.onboardingClaim({ onboardingId, invitationSecret: 'e'.repeat(64) }), error => error instanceof NativeTeamApiError && error.outcome === 'not_sent');
    assert.deepEqual(paths, ['/api/native-staff/onboarding/claim/session']);
  }
});

test('invitation URL places only an exact secret pair in fragment, no query or redirect', () => {
  const invitation = { onboardingId, invitationSecret: 'f'.repeat(64) };
  const url = new URL(nativeStaffInvitationUrl('https://ops.example.test', invitation));
  assert.equal(url.pathname, '/staff/onboarding'); assert.equal(url.search, '');
  assert.deepEqual(parseNativeStaffInvitation(url.hash), invitation);
  for (const invalid of [url.hash + '&onboardingId=' + onboardingId, url.hash + '&returnTo=https://external.test', '#invitationSecret=bad', url.hash.slice(1), '#' + 'x'.repeat(257)]) {
    assert.equal(parseNativeStaffInvitation(invalid), null);
  }
  for (const origin of ['http://ops.example.test', 'https://ops.example.test/path', 'https://user:pass@ops.example.test', 'https://ops.example.test?secret=bad']) {
    assert.throws(() => nativeStaffInvitationUrl(origin, invitation));
  }
});
