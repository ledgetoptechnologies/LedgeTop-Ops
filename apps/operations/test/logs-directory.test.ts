// The NAS Logs directory: four read-only lookups behind a dedicated Access service identity, against all
// current Ops D1 migrations in Miniflare. Synthetic staff only; local signing keys; no network.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { handleLogsDirectory, LOGS_DIRECTORY_PREFIX, type LogsDirectoryEnv } from '../src/worker/logs-directory-routes';

const issuer = 'https://example.cloudflareaccess.com', audience = 'logs-directory-audience-123456';
const host = 'ops-staging.example.test', clientId = 'logs-directory.access';
let runtime: Miniflare, db: D1Database, privateKey: CryptoKey, keyResolver: ReturnType<typeof createLocalJWKSet>;

async function assertion(claims: Record<string, unknown> = {}, signer?: CryptoKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: 'app', sub: '', common_name: clientId, iss: issuer, aud: [audience], iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'dir-test' }).sign(signer ?? privateKey);
}
function env(overrides: Partial<LogsDirectoryEnv> = {}): LogsDirectoryEnv {
  return { OPS_DB: db, ENVIRONMENT: 'staging', FLIGHT_LOGS_ENABLED: 'true', TEAM_DOMAIN: issuer, LOGS_DIRECTORY_ENABLED: 'true',
    LOGS_DIRECTORY_HOST: host, LOGS_DIRECTORY_AUD: audience, LOGS_DIRECTORY_CLIENT_ID: clientId, ...overrides } as LogsDirectoryEnv;
}
async function call(method: string, body: unknown, { claims = {}, headers = {}, url, httpMethod = 'POST', e = env(), signer }:
  { claims?: Record<string, unknown>; headers?: Record<string, string>; url?: string; httpMethod?: string; e?: LogsDirectoryEnv; signer?: CryptoKey } = {}) {
  const request = new Request(url ?? `https://${host}${LOGS_DIRECTORY_PREFIX}${method}`, { method: httpMethod,
    headers: { 'Cf-Access-Jwt-Assertion': await assertion(claims, signer), 'Content-Type': 'application/json', ...headers },
    body: httpMethod === 'POST' ? JSON.stringify(body) : undefined });
  const response = await handleLogsDirectory(request, e, { keyResolver });
  return { status: response?.status ?? null, body: response ? await response.json() : null };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'dir-test', alg: 'RS256' }] });
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', cf: false, script: 'export default {}', d1Databases: ['OPS_DB'] });
  db = await runtime.getD1Database('OPS_DB') as D1Database;
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(file => file.endsWith('.sql')).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('staff-admin','admin@example.test','Admin','access|admin','active')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('staff-plain','plain@example.test','Plain','access|plain','active')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('staff-gone','gone@example.test','Gone','access|gone','inactive')"),
    db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('o1','staff-plain','flight_logs.import','allow','global','global','staff-admin')"),
  ]);
}, 240_000);
afterAll(async () => { await runtime?.dispose(); });

describe('Logs directory for the local Logs host', () => {
  it('answers only the configured service identity on the configured host; everything else is a 404 before any lookup', async () => {
    const refused = [
      await call('staff-active', { staffId: 'staff-plain' }, { claims: { common_name: 'someone-else.access' } }),
      await call('staff-active', { staffId: 'staff-plain' }, { claims: { sub: 'human', email: 'x@example.test' } }),
      await call('staff-active', { staffId: 'staff-plain' }, { claims: { aud: ['other-audience-1234567'] } }),
      await call('staff-active', { staffId: 'staff-plain' }, { signer: (await generateKeyPair('RS256')).privateKey }),
      await call('staff-active', { staffId: 'staff-plain' }, { url: `https://other.example.test${LOGS_DIRECTORY_PREFIX}staff-active` }),
      await call('staff-active', { staffId: 'staff-plain' }, { e: env({ LOGS_DIRECTORY_ENABLED: 'false' }) }),
      await call('staff-active', { staffId: 'staff-plain' }, { e: env({ LOGS_DIRECTORY_AUD: '' }) }),
      await call('list-staff', {}),
      await call('staff-active', null, { httpMethod: 'GET' }),
      await call('staff-active', { staffId: 'staff-plain' }, { url: `https://${host}${LOGS_DIRECTORY_PREFIX}staff-active?x=1` }),
    ];
    for (const result of refused) expect(result.status).toBe(404);
    const outside = await handleLogsDirectory(new Request(`https://${host}/api/other`), env(), { keyResolver });
    expect(outside).toBeNull();
  });

  it('staff-authority returns exactly the four current booleans from canonical status and ACL', async () => {
    const plain = await call('staff-authority', { staffId: 'staff-plain' });
    expect(plain).toEqual({ status: 200, body: { active: true, canViewAll: true, canImport: true, administrator: false } });
    const gone = await call('staff-authority', { staffId: 'staff-gone' });
    expect(gone.body).toEqual({ active: false, canViewAll: false, canImport: false, administrator: false });
    const unknown = await call('staff-authority', { staffId: 'nobody' });
    expect(unknown.body).toEqual({ active: false, canViewAll: false, canImport: false, administrator: false });
    expect(Object.keys((await call('staff-authority', { staffId: 'staff-admin' })).body as Record<string, unknown>).sort()).toEqual(['active', 'administrator', 'canImport', 'canViewAll']);
  });

  it('a removed permission is reflected immediately (no cache)', async () => {
    await db.prepare("DELETE FROM staff_permission_overrides WHERE id = 'o1'").run();
    expect((await call('staff-authority', { staffId: 'staff-plain' })).body).toMatchObject({ canImport: false, canViewAll: false });
    await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('o1','staff-plain','flight_logs.import','allow','global','global','staff-admin')").run();
  });

  it('pilot lookups give the same shape for unknown and ineligible pilots; bodies are strictly shaped', async () => {
    expect(await call('resolve-pilot', { username: 'nobody' })).toEqual({ status: 200, body: { pilot: null } });
    expect(await call('pilot-authority', { staffId: 'staff-plain' })).toEqual({ status: 200, body: { eligible: false } });
    expect(await call('staff-active', { staffId: 'staff-plain' })).toEqual({ status: 200, body: { active: false } });
    for (const body of [{ staffId: 'staff-plain', extra: 1 }, { staffId: '../x' }, { username: 'a', staffId: 'b' }, [], 'x'])
      expect((await call('staff-authority', body)).status).toBe(400);
    expect((await call('resolve-pilot', { username: 'a', extra: true })).status).toBe(400);
  });
});
