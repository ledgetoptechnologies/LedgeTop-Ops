import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_STAFF_PRODUCTION_TARGET, WRANGLER_OAUTH_RELEASE_CREDENTIAL, nativeStaffReadinessEnvironment,
  releaseCredentialAccepted } from './native-staff-cutover-readiness.mjs';
import { createJournaledAssetVerifierProvider, executeOrdinaryFrontendRetainedProduction } from './ordinary-frontend-retained-executor.mjs';

// Synthetic values only: shaped like an API token and like a Wrangler OAuth access token (one '.').
const API = 'A'.repeat(40);
const OAUTH = `${'a'.repeat(40)}.${'B'.repeat(52)}`;
const FLAG = { LEDGETOP_RELEASE_CREDENTIAL: WRANGLER_OAUTH_RELEASE_CREDENTIAL };
const ACCOUNT = NATIVE_STAFF_PRODUCTION_TARGET.accountId;

test('API tokens are accepted with or without the flag', () => {
  assert.equal(WRANGLER_OAUTH_RELEASE_CREDENTIAL, 'wrangler-oauth-v1');
  assert.equal(releaseCredentialAccepted(API, {}), true);
  assert.equal(releaseCredentialAccepted(API, FLAG), true);
});

test('an OAuth-shaped token needs the exact explicit flag', () => {
  assert.equal(releaseCredentialAccepted(OAUTH, {}), false);
  assert.equal(releaseCredentialAccepted(OAUTH, { LEDGETOP_RELEASE_CREDENTIAL: 'wrangler-oauth-v2' }), false);
  assert.equal(releaseCredentialAccepted(OAUTH, { LEDGETOP_RELEASE_CREDENTIAL: 'true' }), false);
  assert.equal(releaseCredentialAccepted(OAUTH, FLAG), true);
});

test('the flag widens the format by "." only, never first or last, within the same length bounds', () => {
  for (const bad of [`.${API}`, `${API}.`, `${API} x`, `${API}+x`, `${API}/x`, `${API}=`, `${API}\n`, 'a.b', `${'a'.repeat(1024)}.b`, null, 42])
    assert.equal(releaseCredentialAccepted(bad, FLAG), false, String(bad).slice(0, 12));
  assert.equal(releaseCredentialAccepted(`${'a'.repeat(10)}.${'b'.repeat(9)}`, FLAG), true);
});

test('the staff reader environment follows the flag and does not forward it', () => {
  assert.throws(() => nativeStaffReadinessEnvironment({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: OAUTH }),
    /noninteractive_environment_required/u);
  const env = nativeStaffReadinessEnvironment({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: OAUTH, ...FLAG });
  assert.equal(env.CLOUDFLARE_API_TOKEN, OAUTH);
  assert.equal(Object.hasOwn(env, 'LEDGETOP_RELEASE_CREDENTIAL'), false);
  assert.throws(() => nativeStaffReadinessEnvironment({ CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_API_TOKEN: OAUTH, ...FLAG }),
    /noninteractive_environment_required/u);
});

test('the temporary verifier provider factory follows the flag', () => {
  class Provider { constructor(options) { this.options = options; } }
  const base = { accountId: ACCOUNT, token: OAUTH, journalDirectory: process.platform === 'win32' ? 'C:\\journal' : '/journal',
    sourceCommit: 'b'.repeat(40), Provider };
  assert.throws(() => createJournaledAssetVerifierProvider({ ...base, env: {} }), /provider identity invalid/u);
  assert.ok(createJournaledAssetVerifierProvider({ ...base, env: FLAG }) instanceof Provider);
  assert.ok(createJournaledAssetVerifierProvider({ ...base, token: API, env: {} }) instanceof Provider);
});

test('the production entry refuses an OAuth-shaped token unless flagged, before any other step', async () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: OAUTH };
  await assert.rejects(executeOrdinaryFrontendRetainedProduction({ app: 'operations', env }),
    /Cloudflare account and API token are required/u);
  // With the flag the credential check passes; the next check (artifact checkout) refuses instead.
  await assert.rejects(executeOrdinaryFrontendRetainedProduction({ app: 'operations', env: { ...env, ...FLAG } }),
    /Pinned frontend artifact source checkout is required/u);
});
