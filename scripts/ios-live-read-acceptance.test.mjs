import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyLivePilot, PILOT_ORIGIN } from './ios-live-read-acceptance.mjs';

const bearer = 'oauth:synthetic-test-credential';
const session = () => ({ schemaVersion: 1, readOnly: true, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'private-user', displayName: 'Private Person', email: 'private@example.test' } });
const root = (id = 'private/root?#') => ({ sourceId: 'project-alpha:primary', rootNamespace: 'business',
  kind: 'organization', clientHubRootId: id, name: 'Private Customer' });
const project = id => ({ id, origin: 'pa', name: 'Private Project', status: null, startDate: null, endDate: null });
const json = (body, options = {}) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, ...options,
});
function fixture({ roots = [root()], projects = [], override } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const target = new URL(url);
    const changed = override?.(target, calls.length);
    if (changed !== undefined) return changed;
    if (target.pathname === '/mobile-pilot/v1/session') return json(session());
    if (target.pathname === '/mobile-pilot/v1/business-roots') return json({ schemaVersion: 1, roots, nextCursor: null });
    return json({ schemaVersion: 1, projects, nextCursor: null });
  } };
}
const fails = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code);

test('only fixed-origin cookie-free GETs; encoded root; receipt contains no record or credential values', async () => {
  const f = fixture({ projects: [project('private-project')] });
  const receipt = await verifyLivePilot({ bearer, fetchImpl: f.fetchImpl });
  assert.equal(receipt.rootCount, 1);
  assert.equal(receipt.projectCount, 1);
  assert.equal(receipt.readOnlySession, true);
  assert.equal(f.calls.length, 3);
  assert.equal(new URL(f.calls[2].url).pathname,
    '/mobile-pilot/v1/business-roots/organization/private%2Froot%3F%23/projects');
  for (const { url, options } of f.calls) {
    assert.equal(new URL(url).origin, PILOT_ORIGIN);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: `Bearer ${bearer}` });
  }
  for (const privateValue of [bearer, 'Private', 'private-user', 'private-project', 'private/root', '@'])
    assert.equal(JSON.stringify(receipt).includes(privateValue), false);
});

test('paginates roots and projects to completion using actual returned opaque cursors', async () => {
  const f = fixture({ override: url => {
    const next = url.searchParams.get('cursor');
    if (url.pathname.endsWith('/business-roots')) return json({ schemaVersion: 1,
      roots: [root(next ? 'second' : 'first')], nextCursor: next ? null : 'opaque_root_cursor' });
    if (url.pathname.endsWith('/projects')) return json({ schemaVersion: 1,
      projects: [project(next ? 'p2' : 'p1')], nextCursor: next ? null : 'opaque_project_cursor' });
  } });
  const result = await verifyLivePilot({ bearer, fetchImpl: f.fetchImpl });
  assert.deepEqual([result.rootCount, result.rootPages, result.projectCount, result.projectPages], [2, 2, 2, 2]);
  assert.deepEqual(f.calls.map(c => new URL(c.url).searchParams.get('cursor')), [null, null, 'opaque_root_cursor', null, 'opaque_project_cursor']);
});

test('missing, header-injection and oversize credentials cause no request', async () => {
  for (const value of [undefined, '', 'oauth:', 'non-oauth-token', 'oauth:private\r\nCookie: value', 'oauth:' + 'x'.repeat(4091)]) {
    const f = fixture();
    await fails(verifyLivePilot({ bearer: value, fetchImpl: f.fetchImpl }), 'credential_format');
    assert.equal(f.calls.length, 0);
  }
});

test('denied, expired or writable sessions never request business records', async () => {
  for (const [response, code] of [
    [json({ private: 'server-message' }, { status: 401 }), 'http_401'],
    [json({ ...session(), readOnly: false }), 'session_contract'],
    [json({ ...session(), expiresAt: 1 }), 'session_contract'],
  ]) {
    const f = fixture({ override: () => response });
    await fails(verifyLivePilot({ bearer, fetchImpl: f.fetchImpl }), code);
    assert.equal(f.calls.length, 1);
  }
});

test('empty roots are not real-data acceptance', async () => {
  const f = fixture({ roots: [] });
  await fails(verifyLivePilot({ bearer, fetchImpl: f.fetchImpl }), 'no_visible_business_records');
  assert.equal(f.calls.length, 2);
});

test('wrong source, namespace, extra fields and path dot-segments fail closed', async () => {
  for (const value of [
    { ...root(), sourceId: 'project-alpha:staging' }, { ...root(), rootNamespace: 'other' },
    { ...root(), contactEmail: 'private@example.test' }, root('.'), root('..'),
  ]) {
    const f = fixture({ roots: [value] });
    await fails(verifyLivePilot({ bearer, fetchImpl: f.fetchImpl }), 'roots_contract');
    assert.equal(f.calls.length, 2);
  }
});

test('duplicate records, repeated cursors and traversal limits cannot pass as complete', async () => {
  await fails(verifyLivePilot({ bearer, fetchImpl: fixture({ roots: [root(), root()] }).fetchImpl }), 'roots_duplicate');
  const repeated = fixture({ override: url => url.pathname.endsWith('/business-roots')
    ? json({ schemaVersion: 1, roots: [], nextCursor: 'same_cursor' }) : undefined });
  await fails(verifyLivePilot({ bearer, fetchImpl: repeated.fetchImpl }), 'roots_cursor_repeated');
  const forever = fixture({ override: (url, count) => url.pathname.endsWith('/business-roots')
    ? json({ schemaVersion: 1, roots: [root(String(count))], nextCursor: `cursor_${count}` }) : undefined });
  await fails(verifyLivePilot({ bearer, fetchImpl: forever.fetchImpl }), 'roots_page_limit');
  assert.equal(forever.calls.length, 11);
});

test('malformed project DTO and project duplicate are refused', async () => {
  await fails(verifyLivePilot({ bearer, fetchImpl: fixture({ projects: [{ ...project('x'), origin: 'unknown' }] }).fetchImpl }), 'projects_contract');
  await fails(verifyLivePilot({ bearer, fetchImpl: fixture({ projects: [project('x'), project('x')] }).fetchImpl }), 'projects_duplicate');
});

test('PA and canonical projects with the same local ID are distinct native identities', async () => {
  const f = fixture({ projects: [project('same-id'), { ...project('same-id'), origin: 'canonical' }] });
  const result = await verifyLivePilot({ bearer, fetchImpl: f.fetchImpl });
  assert.equal(result.projectCount, 2);
  assert.equal(JSON.stringify(result).includes('same-id'), false);
});

test('HTML, malformed JSON, oversized advertised and streamed bodies are refused', async () => {
  for (const [response, code] of [
    [new Response('<html>Private</html>'), 'content_type'],
    [new Response('bad-json', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), 'response_json'],
    [new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': '1048577' } }), 'response_size'],
    [new Response('x'.repeat(1_048_577), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), 'response_size'],
    [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), 'cache_policy'],
  ]) {
    await fails(verifyLivePilot({ bearer, fetchImpl: async () => response }), code);
  }
});

test('redirects and raw network errors are sanitized; no fallback or retry', async () => {
  let requests = 0;
  await fails(verifyLivePilot({ bearer, fetchImpl: async () => { requests++; throw new Error(`private ${bearer}`); } }), 'network_or_redirect');
  assert.equal(requests, 1);
  const response = json(session());
  Object.defineProperty(response, 'url', { value: 'https://unexpected.example.test/private-cursor' });
  await fails(verifyLivePilot({ bearer, fetchImpl: async () => response }), 'response_origin');
});

test('CLI accepts no credential arguments and prints only a fixed failure category', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ios-live-read-acceptance.mjs', import.meta.url)), 'private-secret'],
    { env: { ...process.env, LT_IOS_ACCEPTANCE_BEARER: 'private-secret' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), '{"ok":false,"code":"arguments_not_supported"}');
});
