// Machine authentication for the local Logs backend: Access service-token JWTs verified at the origin,
// one role per client id, the Ops directory client, and idempotency. Locally generated RSA keys and fake
// fetches only; no network, no real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyAccessService, accessKeyResolver, canonicalIssuer, AccessDenied } from '../src/access-jwt.mjs';
import { createMachineAuth, parseActor, encodeActor, actorHas, ACTOR_HEADER } from '../src/machine-auth.mjs';
import { createOpsDirectory, DirectoryError, DIRECTORY_PREFIX } from '../src/directory-client.mjs';
import { createIdempotency, IdempotencyError, IDEMPOTENCY } from '../src/idempotency.mjs';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import { LogsError } from '../../logs/src/worker/errors.mjs';

const LOGS_ISSUER = 'https://ledgetoptechnologies.cloudflareaccess.com';
const STAGING_ISSUER = 'https://ledge-top-staging.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const STAFF_PROXY = 'staff-proxy-client.access';
const DEVICE_PROXY = 'device-proxy-client.access';
const T = Date.parse('2026-11-14T06:00:00Z');
const seconds = () => Math.floor(T / 1000);

function keyPair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
const signing = keyPair('k1');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A Cloudflare Access service-token assertion, shaped like the reviewed Ops fixture (type app, empty sub). */
function token(claims = {}, { key = signing, header = {} } = {}) {
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = b64({ type: 'app', sub: '', common_name: STAFF_PROXY, iss: LOGS_ISSUER, aud: [AUD], iat: seconds() - 10, exp: seconds() + 300, ...claims });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')}`;
}
function jwksFetch(keys = [signing.jwk]) {
  const calls = { n: 0, fail: false };
  const fetch = async url => {
    calls.n++;
    assert.equal(String(url), `${LOGS_ISSUER}/cdn-cgi/access/certs`);
    if (calls.fail) throw new Error('offline');
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
  return { fetch, calls };
}
const request = (path, headers = {}) => new Request(`https://logs-backend-staging.example.test${path}`, { headers });
const verify = (assertion, getKey, now = () => T) =>
  verifyAccessService(request('/internal/v1/logs/x', { 'Cf-Access-Jwt-Assertion': assertion }), { issuer: LOGS_ISSUER, audience: AUD }, getKey, { now });

test('a valid service-token assertion yields its client id', async () => {
  const getKey = accessKeyResolver(LOGS_ISSUER, { fetch: jwksFetch().fetch, now: () => T });
  assert.deepEqual(await verify(token(), getKey), { clientId: STAFF_PROXY, expiresAt: seconds() + 300 });
  assert.deepEqual(await verify(token({ aud: AUD }), getKey), { clientId: STAFF_PROXY, expiresAt: seconds() + 300 }, 'a single string aud is accepted');
});

test('human logins, wrong issuer/audience, bad times and tampering are all refused the same way', async () => {
  const getKey = accessKeyResolver(LOGS_ISSUER, { fetch: jwksFetch().fetch, now: () => T });
  const other = keyPair('k1');
  const bad = {
    human: token({ sub: 'user-123', email: 'pilot@example.test' }),
    emailOnly: token({ email: 'x@example.test' }),
    notApp: token({ type: 'org' }),
    wrongIssuer: token({ iss: STAGING_ISSUER }),
    wrongAudience: token({ aud: ['b'.repeat(64)] }),
    twoAudiences: token({ aud: [AUD, 'b'.repeat(64)] }),
    expired: token({ exp: seconds() - 1 }),
    issuedInFuture: token({ iat: seconds() + 60 }),
    notYetValid: token({ nbf: seconds() + 60 }),
    noCommonName: token({ common_name: '' }),
    badCommonName: token({ common_name: 'bad client' }),
    hs256: token({}, { header: { alg: 'HS256' } }),
    none: token({}, { header: { alg: 'none' } }),
    crit: token({}, { header: { crit: ['exp'] } }),
    unknownKid: token({}, { key: { ...signing, kid: 'k9' } }),
    wrongKey: token({}, { key: other }),
    tampered: (() => { const [h, , s] = token().split('.'); return `${h}.${b64({ type: 'app', sub: '', common_name: DEVICE_PROXY, iss: LOGS_ISSUER, aud: [AUD], iat: seconds() - 10, exp: seconds() + 300 })}.${s}`; })(),
    twoParts: 'a.b',
    innerSpace: token().replace(".", ". "),
    oversize: 'a'.repeat(16385),
  };
  for (const [name, assertion] of Object.entries(bad))
    await assert.rejects(verify(assertion, getKey), err => err instanceof AccessDenied && err.message === 'access_denied', name);
  await assert.rejects(verifyAccessService(request('/x'), { issuer: LOGS_ISSUER, audience: AUD }, getKey), AccessDenied, 'no header');
});

test('issuers must be canonical Access team origins', () => {
  assert.equal(canonicalIssuer(LOGS_ISSUER), LOGS_ISSUER);
  for (const bad of [`${LOGS_ISSUER}/`, 'http://x.cloudflareaccess.com', 'https://evil.example', 'https://x.cloudflareaccess.com:8443',
    'https://u:p@x.cloudflareaccess.com', 'https://x.cloudflareaccess.com/path', '', undefined])
    assert.throws(() => canonicalIssuer(bad), /access_issuer_invalid/, String(bad));
});

test('signing keys are cached, refreshed at most once per cooldown, and refused after max age without a refresh', async () => {
  let now = T;
  const { fetch, calls } = jwksFetch();
  const getKey = accessKeyResolver(LOGS_ISSUER, { fetch, now: () => now, cooldownMs: 60_000, maxAgeMs: 3_600_000 });
  await verify(token(), getKey, () => now);
  await verify(token(), getKey, () => now);
  assert.equal(calls.n, 1, 'cached');
  await assert.rejects(verify(token({}, { key: { ...signing, kid: 'k9' } }), getKey, () => now), AccessDenied);
  await assert.rejects(verify(token({}, { key: { ...signing, kid: 'k9' } }), getKey, () => now), AccessDenied);
  assert.equal(calls.n, 1, 'an unknown kid inside the cooldown does not refetch');
  now += 61_000;
  await assert.rejects(verify(token({}, { key: { ...signing, kid: 'k9' } }), getKey, () => now), AccessDenied);
  assert.equal(calls.n, 2, 'after the cooldown one refresh is allowed');
  calls.fail = true;
  now += 30 * 60_000;
  await verify(token({ iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 300 }), getKey, () => now);
  now += 31 * 60_000;
  await assert.rejects(verify(token({ iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 300 }), getKey, () => now), AccessDenied,
    'keys older than max age with no successful refresh are refused (fail closed)');
});

function machineAuth(extra = {}) {
  return createMachineAuth({ issuer: LOGS_ISSUER, audience: AUD, identities: { [STAFF_PROXY]: 'staff-proxy', [DEVICE_PROXY]: 'device-proxy' }, ...extra },
    { getKey: accessKeyResolver(LOGS_ISSUER, { fetch: jwksFetch().fetch, now: () => T }), now: () => T });
}
const actor = { staffId: 'staff-beau', permissions: ['flight_logs.view', 'flight_logs.manage'] };

test('each client id has exactly one role, and each role only its own routes', async () => {
  const authorize = machineAuth();
  const staffJwt = token(), deviceJwt = token({ common_name: DEVICE_PROXY });
  const ok = await authorize(request('/internal/v1/logs/flights', { 'Cf-Access-Jwt-Assertion': staffJwt, [ACTOR_HEADER]: encodeActor(actor) }));
  assert.deepEqual([ok.ok, ok.role, ok.actor], [true, 'staff-proxy', actor]);
  const device = await authorize(request('/api/v1/device/me', { 'Cf-Access-Jwt-Assertion': deviceJwt }));
  assert.deepEqual([device.ok, device.role, device.actor], [true, 'device-proxy', null]);
  const refused = {
    'staff proxy without an actor': request('/internal/v1/logs/flights', { 'Cf-Access-Jwt-Assertion': staffJwt }),
    'staff proxy with a malformed actor': request('/internal/v1/logs/flights', { 'Cf-Access-Jwt-Assertion': staffJwt, [ACTOR_HEADER]: 'not-json' }),
    'staff proxy on the device API': request('/api/v1/device/me', { 'Cf-Access-Jwt-Assertion': staffJwt, [ACTOR_HEADER]: encodeActor(actor) }),
    'device proxy asserting a staff actor': request('/api/v1/device/me', { 'Cf-Access-Jwt-Assertion': deviceJwt, [ACTOR_HEADER]: encodeActor(actor) }),
    'device proxy on the staff API': request('/internal/v1/logs/flights', { 'Cf-Access-Jwt-Assertion': deviceJwt }),
    'an unknown client id': request('/internal/v1/logs/flights', { 'Cf-Access-Jwt-Assertion': token({ common_name: 'someone-else' }), [ACTOR_HEADER]: encodeActor(actor) }),
    'no assertion': request('/api/v1/device/me'),
    'the health route': request('/health', { 'Cf-Access-Jwt-Assertion': deviceJwt }),
    'a prefix look-alike': request('/internal/v1/logsX/flights', { 'Cf-Access-Jwt-Assertion': staffJwt, [ACTOR_HEADER]: encodeActor(actor) }),
    'a double slash': request('/internal/v1/logs//flights', { 'Cf-Access-Jwt-Assertion': staffJwt, [ACTOR_HEADER]: encodeActor(actor) }),
  };
  for (const [name, req] of Object.entries(refused)) assert.deepEqual(await authorize(req), { ok: false, status: 404 }, name);
});

test('machine configuration must be complete: blank or unknown identities never disable authentication', () => {
  assert.throws(() => machineAuth({ identities: {} }), /machine_identities_missing/);
  assert.throws(() => machineAuth({ identities: { [STAFF_PROXY]: 'admin' } }), /machine_role_invalid/);
  assert.throws(() => machineAuth({ identities: { 'bad id': 'staff-proxy' } }), /machine_client_id_invalid/);
  assert.throws(() => machineAuth({ issuer: '' }), /access_issuer_invalid/);
});

test('the staff actor is strictly shaped', () => {
  assert.deepEqual(parseActor(encodeActor(actor)), actor);
  assert.equal(actorHas(parseActor(encodeActor(actor)), 'flight_logs.manage'), true);
  assert.equal(actorHas(parseActor(encodeActor(actor)), 'flight_logs.import'), false);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const bad of [null, '', 'x y', encode([]), encode({ staffId: 'a' }), encode({ staffId: 'a', permissions: ['x'] }),
    encode({ staffId: '../a', permissions: [] }), encode({ staffId: 'a', permissions: ['flight_logs.view', 'flight_logs.view'] }),
    encode({ staffId: 'a', permissions: [], extra: 1 }), encode({ staffId: 'a', permissions: Array(65).fill(0).map((_, i) => `p.x${i}`) })])
    assert.equal(parseActor(bad), null, String(bad));
});

function directoryFetch(handler) {
  const seen = [];
  return { seen, fetch: async (url, init) => { seen.push({ url: String(url), init }); return handler(String(url), JSON.parse(init.body)); } };
}
const opsConfig = { baseUrl: 'https://ops-staging.example.test/', clientId: 'directory-client.access', clientSecret: 's'.repeat(32) };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('the Ops directory client sends its own service token to the three fixed routes and checks every reply', async () => {
  const { fetch, seen } = directoryFetch((url, body) => {
    if (url.endsWith('resolve-pilot')) return reply({ pilot: body.username === 'bkoltz' ? { staffId: 'staff-beau', eligibilityRevision: 3 } : null });
    if (url.endsWith('pilot-authority')) return reply(body.staffId === 'staff-beau' ? { eligible: true, revision: 3 } : { eligible: false });
    if (url.endsWith('staff-active')) return reply({ active: body.staffId === 'staff-beau' });
    return reply({}, 404);
  });
  const ops = createOpsDirectory(opsConfig, { fetch });
  assert.deepEqual(await ops.resolvePilotUsername('bkoltz'), { staffId: 'staff-beau', eligibilityRevision: 3 });
  assert.equal(await ops.resolvePilotUsername('nobody'), null);
  assert.deepEqual(await ops.getPilotDeviceAuthority('staff-beau'), { eligible: true, revision: 3 });
  assert.deepEqual(await ops.getPilotDeviceAuthority('staff-x'), { eligible: false, revision: null });
  assert.equal(await ops.isActiveStaff('staff-beau'), true);
  assert.equal(await ops.isActiveStaff('staff-x'), false);
  assert.deepEqual([...new Set(seen.map(s => new URL(s.url).pathname))],
    ['resolve-pilot', 'pilot-authority', 'staff-active'].map(m => `${DIRECTORY_PREFIX}${m}`));
  for (const { init } of seen) {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual', 'an Access login redirect is never followed');
    assert.equal(init.headers['CF-Access-Client-Id'], opsConfig.clientId);
  }
});

test('directory failures throw so the Logs code fails closed; nothing is cached here', async () => {
  const cases = {
    unreachable: async () => { throw new Error('ECONNREFUSED'); },
    accessRedirect: async () => new Response(null, { status: 302, headers: { Location: `${STAGING_ISSUER}/login` } }),
    forbidden: async () => reply({}, 403),
    serverError: async () => reply({}, 500),
    notJson: async () => new Response('<html>', { status: 200 }),
    oversize: async () => new Response('x'.repeat(70_000), { status: 200 }),
    wrongShape: async () => reply({ pilot: { staffId: 'staff-beau' } }),
    eligibleWithoutRevision: async () => reply({ eligible: true }),
    activeNotBoolean: async () => reply({ active: 'yes' }),
  };
  for (const [name, fetch] of Object.entries(cases)) {
    const ops = createOpsDirectory(opsConfig, { fetch });
    const method = name === 'eligibleWithoutRevision' ? () => ops.getPilotDeviceAuthority('staff-beau')
      : name === 'activeNotBoolean' ? () => ops.isActiveStaff('staff-beau') : () => ops.resolvePilotUsername('bkoltz');
    await assert.rejects(method(), DirectoryError, name);
  }
  let calls = 0;
  const counting = createOpsDirectory(opsConfig, { fetch: async () => { calls++; return reply({ active: true }); } });
  await counting.isActiveStaff('staff-beau');
  await counting.isActiveStaff('staff-beau');
  assert.equal(calls, 2, 'no client-side cache: the Logs device code owns the single <=60 s positive cache');
});

test('a blank or malformed directory credential is a startup error, never "no authentication"', () => {
  for (const bad of [{ clientSecret: '' }, { clientSecret: 'short' }, { clientId: '' }, { baseUrl: 'http://ops.example.test/' },
    { baseUrl: 'https://ops.example.test/api/' }, { baseUrl: 'https://u:p@ops.example.test/' }])
    assert.throws(() => createOpsDirectory({ ...opsConfig, ...bad }), /directory_/, JSON.stringify(bad));
});

function idempotencyDb(t) {
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  return db;
}
const scope = { identity: 'staff-proxy', actorId: 'staff-beau', operation: 'revoke-device', scope: 'dev-1', key: 'k'.repeat(24), request: { deviceId: 'dev-1' } };

test('idempotency: same key and request replays the stored result; a different request or actor is never confused', async t => {
  let now = T;
  const once = createIdempotency(idempotencyDb(t), { now: () => now });
  let runs = 0;
  const work = async () => ({ revoked: ++runs });
  assert.deepEqual(await once(scope, work), { revoked: 1 });
  assert.deepEqual(await once(scope, work), { revoked: 1 }, 'replayed, not re-run');
  await assert.rejects(once({ ...scope, request: { deviceId: 'dev-2' } }, work), err => err instanceof IdempotencyError && err.code === 'idempotency_conflict');
  assert.deepEqual(await once({ ...scope, actorId: 'staff-kollin' }, work), { revoked: 2 }, 'another actor with the same key is a separate record');
  assert.deepEqual(await once({ ...scope, operation: 'decide-sign-in' }, work), { revoked: 3 });
  now += IDEMPOTENCY.ttlMs + 1;
  assert.deepEqual(await once(scope, work), { revoked: 4 }, 'expired records are dropped (a new request after 24 h)');
  await assert.rejects(once({ ...scope, key: 'short' }, work), err => err.code === 'idempotency_key_invalid');
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('idempotency: a slow first attempt is never run again, even after the in-progress window; its late answer is kept', async t => {
  let now = T;
  const once = createIdempotency(idempotencyDb(t), { now: () => now });
  let release, runs = 0;
  const slow = once(scope, () => { runs++; return new Promise(resolve => { release = resolve; }); });
  await tick();
  await assert.rejects(once(scope, async () => { runs++; }), err => err.code === 'idempotency_in_progress');
  now += IDEMPOTENCY.unresolvedAfterMs + 1;
  await assert.rejects(once(scope, async () => { runs++; }), err => err.code === 'idempotency_unresolved',
    'after the window it is unresolved, not reclaimed and re-run');
  release({ done: 'A' });
  assert.deepEqual(await slow, { done: 'A' });
  assert.deepEqual(await once(scope, async () => { runs++; }), { done: 'A' }, 'the late first answer is what a retry replays');
  assert.equal(runs, 1, 'the operation ran exactly once');
});

test('idempotency: an unknown failure (effect may have committed) is never re-executed; a business refusal is replayed', async t => {
  const once = createIdempotency(idempotencyDb(t), { now: () => T });
  let runs = 0;
  const crashed = { ...scope, key: 'c'.repeat(24) };
  await assert.rejects(once(crashed, async () => { runs++; throw new Error('connection lost after commit'); }), /connection lost/);
  await assert.rejects(once(crashed, async () => { runs++; return 'again'; }), err => err.code === 'idempotency_unresolved');
  assert.equal(runs, 1);
  const refused = { ...scope, key: 'r'.repeat(24) };
  await assert.rejects(once(refused, async () => { runs++; throw new LogsError('device_not_found', 404, 'No such controller.'); }),
    err => err instanceof LogsError && err.code === 'device_not_found');
  await assert.rejects(once(refused, async () => { runs++; return 'again'; }), err => err instanceof LogsError && err.code === 'device_not_found',
    'the same refusal is replayed');
  assert.equal(runs, 2);
});

test('idempotency: an answer too large to store is recorded as completed, never recomputed by re-running', async t => {
  const once = createIdempotency(idempotencyDb(t), { now: () => T });
  let runs = 0;
  const big = { ...scope, key: 'b'.repeat(24) };
  const value = await once(big, async () => { runs++; return { blob: 'x'.repeat(IDEMPOTENCY.maxResultBytes + 1) }; });
  assert.equal(value.blob.length, IDEMPOTENCY.maxResultBytes + 1, 'the first caller still gets the answer');
  await assert.rejects(once(big, async () => { runs++; }), err => err.code === 'idempotency_result_unavailable');
  assert.equal(runs, 1);
});

test('idempotency: a late attempt can never overwrite another attempt\'s record (fenced by attempt token)', async t => {
  let now = T;
  const db = idempotencyDb(t);
  const once = createIdempotency(db, { now: () => now });
  let release;
  const late = once(scope, () => new Promise(resolve => { release = resolve; }));
  await tick();
  // The record expires and a new attempt owns the key before the late one finishes.
  now += IDEMPOTENCY.ttlMs + 1;
  assert.deepEqual(await once(scope, async () => ({ owner: 'B' })), { owner: 'B' });
  release({ owner: 'A' });
  assert.deepEqual(await late, { owner: 'A' });
  assert.deepEqual(await once(scope, async () => ({ owner: 'C' })), { owner: 'B' }, 'B\'s record survived A finishing late');
});

test('Logs and local-only migrations keep separate ledgers on one database', async t => {
  const db = idempotencyDb(t);
  assert.deepEqual(migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url))).applied, []);
  assert.deepEqual(migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local }).applied, []);
  assert.throws(() => migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: 'other' }), err => err.code === 'migration_ledger');
});

test('during a JWKS outage a storm of requests costs at most one fetch per cooldown, before and after expiry', async () => {
  let now = T, fetches = 0, failing = true;
  const fetch = async () => { fetches++; if (failing) throw new Error('offline'); return new Response(JSON.stringify({ keys: [signing.jwk] })); };
  const getKey = accessKeyResolver(LOGS_ISSUER, { fetch, now: () => now, cooldownMs: 60_000, maxAgeMs: 3_600_000 });
  const at = () => token({ iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 300 });
  for (let i = 0; i < 20; i++) await assert.rejects(verify(at(), getKey, () => now), AccessDenied);
  assert.equal(fetches, 1, 'an initial failed fetch is not retried on every request');
  now += 60_001;
  failing = false;
  await verify(at(), getKey, () => now);
  assert.equal(fetches, 2);
  failing = true;
  now += 3_600_001;
  for (let i = 0; i < 20; i++) await assert.rejects(verify(at(), getKey, () => now), AccessDenied);
  assert.equal(fetches, 3, 'expired keys during an outage: one attempt, then the cooldown holds');
});

test('a JWKS reply larger than the bound is cancelled, not buffered', async () => {
  let cancelled = false;
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); }, cancel() { cancelled = true; } }));
  const getKey = accessKeyResolver(LOGS_ISSUER, { fetch, now: () => T });
  await assert.rejects(verify(token(), getKey), AccessDenied);
  assert.equal(cancelled, true);
});

test('an invalid audience is refused at startup, not on the first request', () => {
  for (const audience of [undefined, '', 'short', 'x'.repeat(129), 'has space here and more'])
    assert.throws(() => machineAuth({ audience }), /machine_audience_invalid/, String(audience));
});

test('a chunked directory reply without Content-Length is bounded while reading', async () => {
  let cancelled = false, sent = 0;
  const ops = createOpsDirectory(opsConfig, { fetch: async () => new Response(new ReadableStream({
    pull(controller) { sent += 8192; controller.enqueue(new Uint8Array(8192).fill(32)); }, cancel() { cancelled = true; } }), { status: 200 }) });
  await assert.rejects(ops.isActiveStaff('staff-beau'), err => err instanceof DirectoryError && err.code === 'directory_reply_invalid');
  assert.equal(cancelled, true);
  assert.ok(sent <= 64 * 1024 + 2 * 8192, `read stopped near the bound (${sent} bytes pulled)`);
});
