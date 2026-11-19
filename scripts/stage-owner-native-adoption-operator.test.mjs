// Synthetic signing keys live only in this test process. No file/provider/real identity access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from './native-staff-bootstrap-owner-approval.mjs';
import { STAGE_PINS, STAGE_OWNER_ADOPTION_TARGET_STAFF_ID } from './stage-owner-native-adoption.mjs';
import { STAGE_OWNER_ACCESS, stageOwnerClaimsFromVerifiedJwt, createStageOwnerIdentityVerifier,
  parseStageOwnerOperatorTrust, verifyStageOwnerConsentProof, createStageOwnerSingleDispatch,
  createStageOwnerAdoptionOperator } from './stage-owner-native-adoption-operator.mjs';
import { STAGE_OWNER_ADOPTION_OPERATOR_TRUST_SHA256 } from './stage-owner-native-adoption-operator-trust-pin.mjs';

const T = Date.parse('2035-01-01T00:00:00.000Z');
const owner = { id: STAGE_OWNER_ADOPTION_TARGET_STAFF_ID, email: 'synthetic@example.test',
  access_subject: 'synthetic-subject', status: 'active', display_name: 'Synthetic Owner' };
const target = { accountId: STAGE_PINS.accountId, databaseId: STAGE_PINS.databaseId };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const sha = x => createHash('sha256').update(x).digest('hex');
const keyId = sha(publicKey.export({ type: 'spki', format: 'der' }));
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-kid', alg: 'RS256', use: 'sig' };
const jwt = (changes = {}, signature = true) => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: STAGE_OWNER_ACCESS.issuer, aud: [STAGE_OWNER_ACCESS.audience],
    sub: owner.access_subject, email: owner.email, type: 'app', iat: T / 1000 - 1, exp: T / 1000 + 60, ...changes })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${(signature ? sign('RSA-SHA256', Buffer.from(input), privateKey) : Buffer.alloc(384)).toString('base64url')}`;
};
const db = (rows = [owner, owner]) => {
  let n = 0;
  return { prepare(sql) {
    assert.equal(sql, 'SELECT id,email,display_name,access_subject,status FROM staff_users WHERE id=?');
    return { bind(id) { assert.equal(id, owner.id); return this; }, async first() { return rows[Math.min(n++, rows.length - 1)]; } };
  } };
};
const jwks = async (url, init) => {
  assert.equal(String(url), `${STAGE_OWNER_ACCESS.issuer}/cdn-cgi/access/certs`);
  assert.equal(init.method, 'GET');
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
};

test('real RS256/JWKS verification maps only the current fixed owner and actual JWT expiry', async () => {
  const verifier = createStageOwnerIdentityVerifier(db(), { fetchImpl: jwks, now: () => T });
  assert.deepEqual(await verifier(jwt()), { staffId: owner.id, email: owner.email, accessSubject: owner.access_subject,
    verifiedUntil: new Date(T + 60000).toISOString() });
});

test('real verifier rejects wrong issuer/audience/subject, service identity, signature and expired JWT', async () => {
  for (const changes of [{ iss: 'https://wrong.example.test' }, { aud: 'wrong' }, { sub: 'other' },
    { common_name: 'service' }, { exp: T / 1000 }, { iat: T / 1000 + 1 }]) {
    await assert.rejects(createStageOwnerIdentityVerifier(db(), { fetchImpl: jwks, now: () => T })(jwt(changes)));
  }
  await assert.rejects(createStageOwnerIdentityVerifier(db(), { fetchImpl: jwks, now: () => T })(jwt({}, false)));
});

test('owner drift while fetching JWKS refuses even an authentic assertion', async () => {
  await assert.rejects(createStageOwnerIdentityVerifier(db([owner, { ...owner, access_subject: 'changed' }]),
    { fetchImpl: jwks, now: () => T })(jwt()), /owner_changed_during_jwks/);
});

test('expiry is checked again after asynchronous JWKS verification', async () => {
  let clock = T;
  await assert.rejects(createStageOwnerIdentityVerifier(db(), { fetchImpl: async (...args) => {
    const response = await jwks(...args); clock = T + 60000; return response;
  }, now: () => clock })(jwt()), /verified_owner_mismatch_or_expired/);
});

test('claim mapping rejects noncanonical/inactive/wrong owner and invalid deadline', () => {
  const claims = { issuer: STAGE_OWNER_ACCESS.issuer, audience: STAGE_OWNER_ACCESS.audience,
    subject: owner.access_subject, email: owner.email, issuedAt: T / 1000 - 1, expiresAt: T / 1000 + 60 };
  for (const changed of [{ ...owner, id: 'other' }, { ...owner, status: 'disabled' }, { ...owner, email: ' Wrong@example.test' }])
    assert.throws(() => stageOwnerClaimsFromVerifiedJwt(claims, changed, T));
  for (const changed of [{ ...claims, expiresAt: T / 1000 }, { ...claims, expiresAt: 253402300800 },
    { ...claims, email: 'other@example.test' }]) assert.throws(() => stageOwnerClaimsFromVerifiedJwt(changed, owner, T));
});

const trustObject = () => ({ schemaVersion: 1, kind: 'operations-stage-owner-adoption-operator-trust-v1',
  target, ownerStaffId: owner.id, issuer: STAGE_OWNER_ACCESS.issuer, audience: STAGE_OWNER_ACCESS.audience,
  keyId, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  consentDirectory: process.cwd() });
test('trust is unprovisioned by default; exact reviewed bytes and Stage target are mandatory', () => {
  assert.equal(STAGE_OWNER_ADOPTION_OPERATOR_TRUST_SHA256, null);
  const raw = canonicalJson(trustObject());
  assert.throws(() => parseStageOwnerOperatorTrust(raw, null));
  assert.throws(() => parseStageOwnerOperatorTrust(`${raw}\n`, sha(raw)));
  assert.equal(parseStageOwnerOperatorTrust(raw, sha(raw)).keyId, keyId);
  for (const changes of [{ target: { ...target, accountId: '0'.repeat(32) } }, { audience: 'wrong' },
    { ownerStaffId: 'other' }, { keyId: '0'.repeat(64) }, { extra: true }]) {
    const altered = canonicalJson({ ...trustObject(), ...changes });
    assert.throws(() => parseStageOwnerOperatorTrust(altered, sha(altered)));
  }
});

test('external consent signature binds exact closed envelope, signer and algorithm', () => {
  const trust = trustObject(), envelope = { schemaVersion: 1, commandId: 'synthetic-command', planSha256: 'a'.repeat(64) };
  const proof = { schemaVersion: 1, algorithm: 'RSA-PSS-SHA256', keyId,
    signature: sign('sha256', Buffer.from(canonicalJson(envelope)), { key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64') };
  assert.equal(verifyStageOwnerConsentProof(envelope, proof, trust), true);
  assert.equal(verifyStageOwnerConsentProof({ ...envelope, commandId: 'changed' }, proof, trust), false);
  for (const changes of [{ keyId: '0'.repeat(64) }, { algorithm: 'RS256' }, { signature: 'invalid' }, { approved: true }])
    assert.equal(verifyStageOwnerConsentProof(envelope, { ...proof, ...changes }, trust), false);
});

test('lost ACK cannot retry; incorrect target does not consume the one dispatch', async () => {
  let calls = 0;
  const transport = createStageOwnerSingleDispatch(async () => { calls++; throw Error('synthetic_lost_ack'); });
  await assert.rejects(transport.submit({ batch: [] }, { ...target, accountId: '0'.repeat(32) }));
  assert.equal(transport.dispatched, false);
  await assert.rejects(transport.submit({ batch: [] }, target), /synthetic_lost_ack/);
  assert.equal(transport.dispatched, true);
  await assert.rejects(transport.submit({ batch: [] }, target), /duplicate_or_wrong_target_dispatch/);
  assert.equal(calls, 1);
});

test('provider primitives are required; imports and construction perform no requests', () => {
  assert.throws(() => createStageOwnerAdoptionOperator());
  let calls = 0;
  const operator = createStageOwnerAdoptionOperator({ getBearerToken: () => 'synthetic-bearer-not-used',
    getOwnerIdentityToken: () => 'synthetic-jwt-not-used', fetchImpl: async () => { calls++; throw Error('unexpected'); } });
  assert.equal(typeof operator.prepare, 'function'); assert.equal(calls, 0);
});
