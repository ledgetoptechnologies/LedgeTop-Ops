// The temporary diagnostics name the first failing check and never reveal values. Synthetic keys, fake bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { diagnose } from '../src/diagnose.mjs';

const ISSUER = 'https://ledge-top-staging.cloudflareaccess.com';
const AUD = 'b'.repeat(64);
const CLIENT = 'secretish-client-0001.access';
const HOST = 'logs-export-staging.example.test';
const KEY = 'telemetry/v1/0b6f1c1e-1a2b-4c3d-8e9f-0123456789ab.json.gz';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] };
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
function jwt(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1' });
  const body = b64({ type: 'app', sub: '', common_name: CLIENT, iss: ISSUER, aud: [AUD], iat: now - 5, exp: now + 300, ...claims });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const env = (patch = {}) => ({ EXPORT_HOST: HOST, ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUD, EXPORT_CLIENT_ID: CLIENT,
  EXPORT_BUCKET: { async head(key) { return key === KEY ? { size: 1 } : null; } }, ...patch });
const run = (assertion = jwt(), { path = `/${KEY}`, e = env() } = {}) =>
  diagnose(new Request(`https://${HOST}${path}`, { headers: assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {} }), e,
    { fetch: async () => Response.json(jwks) });

test('names the first failing check', async () => {
  assert.equal((await run()).stage, 'ok');
  assert.equal((await run(null)).stage, 'assertion_missing');
  assert.equal((await run(jwt(), { e: env({ EXPORT_CLIENT_ID: 'secretish-client-0001' }) })).stage, 'client_id_mismatch');
  assert.equal((await run(jwt({ aud: [AUD, 'c'.repeat(64)] }))).stage, 'claim_aud_count');
  assert.equal((await run(jwt({ aud: ['c'.repeat(64)] }))).stage, 'claim_aud');
  assert.equal((await run(jwt({ iss: 'https://other.cloudflareaccess.com' }))).stage, 'claim_iss');
  assert.equal((await run(jwt({ sub: 'someone' }))).stage, 'claim_sub');
  assert.equal((await run(jwt(), { path: `/${KEY.replace('0b6f', '1b6f')}` })).stage, 'object_not_found');
  assert.equal((await run(jwt(), { e: env({ EXPORT_HOST: 'other.example.test' }) })).stage, 'host_mismatch');
  const tampered = jwt().split('.'); tampered[2] = tampered[2].split('').reverse().join('');
  assert.equal((await run(tampered.join('.'))).stage, 'signature_invalid');
});

test('reports claim names and booleans only, never values', async () => {
  const result = await run(jwt({ email: 'person@example.test' }));
  assert.equal(result.stage, 'claim_email_present');
  const text = JSON.stringify(result);
  for (const secret of [CLIENT, AUD, KEY, 'person@example.test', ISSUER, HOST]) assert.ok(!text.includes(secret), secret);
  assert.ok(result.facts.claimNames.includes('common_name'));
});
