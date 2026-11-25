'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createClientGrantProxy } = require('../server/clientGrantProxy');
const PATH = '/api/v1/workspace/direct-client-grants';
const input = { sourceId: 'project-alpha:primary', workspaceId: 'workspace-one', viewerProjectId: 'viewer-project', taskId: null,
  scopeType: 'project', includeFuturePublished: true, permissions: { measure: true, cameras: false, download: false }, expiresAt: null, confirmedScope: true };
const { confirmedScope, ...scope } = input;
const grant = { ...scope, grantId: 'grant-one', grantVersion: 1, revokedAt: null, clientDisplayName: 'Synthetic client', createdAt: new Date().toISOString() };
const list = { clients: [{ sourceId: input.sourceId, workspaceId: input.workspaceId, displayName: 'Synthetic client', businessName: 'Drone Services' }], grants: [grant], clientsNextCursor: null };
async function fixture(t, respond, allowed = true) {
  const envelopes = [], app = express(); app.use(express.json());
  createClientGrantProxy({ config: { opsAutomationBaseUrl: 'https://incoming.example.test', viewerEventSecret: 's'.repeat(32), viewerEventKeyId: 'viewer-v1' },
    authorize: permission => (req, res, next) => { assert.equal(permission, 'viewer.client_grants.manage');
      if (!allowed) return res.sendStatus(403); req.adminPrincipal = { subject: 'ops:staff-one' }; next(); }, diagnostic() {},
    fetchImpl: async (url, request) => { assert.equal(url.href, 'https://incoming.example.test/api/viewer/workspace/client-grants');
      assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
      assert.ok(request.headers['X-LTDS-Viewer-Signature']);
      const envelope = JSON.parse(request.body); envelopes.push(envelope); return respond(envelope); },
  }).mount(app);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { envelopes, request: (path = PATH, { method = 'GET', body, key = 'direct-proxy-idempotency-0001' } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Authorization: 'Bearer browser-private' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }) };
}
const json = (payload, init = {}) => new Response(JSON.stringify(payload), { status: 200, ...init });

test('direct list signs bounded recipient query, preserves schema and permission boundary', async t => {
  const { request, envelopes } = await fixture(t, () => json(list));
  const response = await request(PATH + '?q=Synthetic&limit=10&viewerProjectId=viewer-project');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), list);
  assert.deepEqual(envelopes, [{ subject: 'ops:staff-one', action: 'list', connection: 'direct', listQuery: { q: 'Synthetic', limit: 10, viewerProjectId: 'viewer-project' } }]);
  for (const query of ['?limit=51', '?limit=2&limit=3', '?cursor=bad%2Fcursor', '?unexpected=true', '?q=control%0A']) assert.equal((await request(PATH + query)).status, 400);
  const denied = await fixture(t, () => { throw new Error('must not reach network'); }, false);
  assert.equal((await denied.request()).status, 403); assert.deepEqual(denied.envelopes, []);
});

test('direct list forwards the name-ordered picker and grant paging fields and accepts the richer client rows', async t => {
  const named = { clients: [{ ...list.clients[0], organizationName: 'Synthetic Org', rootType: 'organization' },
    { ...list.clients[0], workspaceId: 'workspace-two', organizationName: null, rootType: 'standalone_client' }],
  grants: [grant], clientsNextCursor: 'v1.WyJzeW50aGV0aWMiLCJ3b3Jrc3BhY2UtdHdvIl0', grantsNextCursor: 'grant-one' };
  const { request, envelopes } = await fixture(t, () => json(named));
  const response = await request(PATH + '?q=a%25_b&include=clients&cursor=v1.WyJhIiwid29ya3NwYWNlLW9uZSJd&grantsCursor=grant-zero&viewerProjectId=viewer-project');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), named);
  assert.deepEqual(envelopes[0].listQuery, { q: 'a%_b', cursor: 'v1.WyJhIiwid29ya3NwYWNlLW9uZSJd', viewerProjectId: 'viewer-project', include: 'clients', grantsCursor: 'grant-zero' });
  for (const query of ['?include=everything', '?grantsCursor=bad%2Fcursor', '?cursor=v2.abc', '?cursor=v1.bad%2Fcursor', '?include=clients&include=grants'])
    assert.equal((await request(PATH + query)).status, 400, query);
  for (const bad of [{ ...named, clients: [{ ...named.clients[0], rootType: 'department' }] }, { ...named, clients: [{ ...named.clients[0], organizationName: '' }] },
    { ...named, clients: [{ ...named.clients[0], email: 'x@example.test' }] }, { ...named, grantsNextCursor: 'v1.notagrant' }]) {
    const rejected = await fixture(t, () => json(bad)); assert.equal((await rejected.request()).status, 502);
  }
});

test('direct create validates explicit future scope and typed fields before signing', async t => {
  const { request, envelopes } = await fixture(t, () => json({ grant, replayed: false }));
  // The actual Viewer workspace posts the grant fields directly. Only the
  // legacy /client-grants endpoint uses a { grant } envelope.
  assert.equal((await request(PATH, { method: 'POST', body: input })).status, 201);
  assert.deepEqual(envelopes[0].grant, input); assert.equal(envelopes[0].connection, 'direct');
  for (const invalid of [{ ...input, confirmedScope: false }, { ...input, includeFuturePublished: false }, { ...input, scopeType: 'task' },
    { ...input, sourceId: 'other-tenant' }, { ...input, permissions: { ...input.permissions, view: true } }, { ...input, extra: true }, { grant: input }])
    assert.equal((await request(PATH, { method: 'POST', body: invalid })).status, 400);
  assert.equal(envelopes.length, 1);
});

test('direct revoke uses path grant id, optional bounded reason and requires a typed completion', async t => {
  const receipt = { success: true, replayed: true, sessionRevocation: { pending: true } };
  const { request, envelopes } = await fixture(t, () => json(receipt, { status: 202 }));
  assert.equal((await request(PATH + '/grant-one', { method: 'DELETE', body: {} })).status, 202);
  assert.deepEqual(envelopes[0], { subject: 'ops:staff-one', action: 'revoke', connection: 'direct', idempotencyKey: 'direct-proxy-idempotency-0001', grantId: 'grant-one', reason: 'Revoked by staff' });
  assert.equal((await request(PATH + '/grant-one', { method: 'DELETE', body: { reason: 'Ended access', grantId: 'forged' } })).status, 400);
  assert.equal((await request(PATH + '/grant-one', { method: 'DELETE', body: {}, key: 'short' })).status, 400);
});

for (const bad of [{ ...list, clientsNextCursor: undefined }, { ...list, clients: [{ ...list.clients[0], sourceId: 'unknown' }] },
  { ...list, grants: [{ ...grant, scopeType: 'task', taskId: 'task-one', includeFuturePublished: true }] },
  { ...list, grants: [{ ...grant, grantVersion: 0 }] }, { ...list, extra: 'unexpected' }]) test('direct list rejects malformed upstream authority', async t => {
  const { request } = await fixture(t, () => json(bad)); assert.equal((await request()).status, 502);
});

test('direct known bounded rejection is preserved while unstructured upstream errors stay generic', async t => {
  const rejection = { error: 'Choose a current client', code: 'client_not_available', ignored: 'private' };
  const { request } = await fixture(t, () => new Response(JSON.stringify(rejection), { status: 409 }));
  const response = await request(); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: rejection.error, code: rejection.code });
});

test('an Operations release without the include field still lists clients and shares, once each, with nothing extra', async t => {
  const refused = () => json({ error: 'Viewer client-grant request is invalid' }, { status: 400 });
  const older = envelope => envelope.listQuery.include !== undefined ? refused() : json({ ...list, clientsNextCursor: 'workspace-one', grantsNextCursor: 'grant-one' });
  const picker = await fixture(t, older);
  const clients = await picker.request(PATH + '?q=Synthetic&include=clients&limit=25&viewerProjectId=viewer-project&cursor=workspace-zero');
  assert.equal(clients.status, 200);
  assert.deepEqual(await clients.json(), { clients: list.clients, grants: [], clientsNextCursor: 'workspace-one' });
  assert.deepEqual(picker.envelopes.map(item => item.listQuery), [
    { q: 'Synthetic', cursor: 'workspace-zero', limit: 25, viewerProjectId: 'viewer-project', include: 'clients' },
    { q: 'Synthetic', cursor: 'workspace-zero', limit: 25, viewerProjectId: 'viewer-project' }]);
  // Opening the dialog must not bring a client list with it.
  const opened = await fixture(t, older);
  const grants = await opened.request(PATH + '?include=grants&limit=25&viewerProjectId=viewer-project');
  assert.equal(grants.status, 200); assert.deepEqual(await grants.json(), { clients: [], grants: [grant], clientsNextCursor: null, grantsNextCursor: 'grant-one' });
  assert.deepEqual(opened.envelopes[1].listQuery, { limit: 1, viewerProjectId: 'viewer-project' });
});

test('the older-Operations retry never widens, repeats or hides another refusal', async t => {
  const shape = 'Viewer client-grant request is invalid';
  const status = (code, body) => async (path, options) => { const item = await fixture(t, () => json(body || { error: 'refused' }, { status: code }));
    return { response: await item.request(path, options), calls: item.envelopes.length }; };
  for (const code of [401, 403, 404, 409, 429, 500]) assert.equal((await status(code)(PATH + '?include=grants')).calls, 1, String(code));
  for (const body of [undefined, { error: 'Invalid client picker query', code: 'invalid_request' }])
    assert.equal((await status(400, body)(PATH + '?include=grants')).calls, 1);
  const refusedShape = status(400, { error: shape });
  const twice = await refusedShape(PATH + '?include=grants'); assert.equal(twice.calls, 2); assert.equal(twice.response.status, 400);
  assert.equal((await refusedShape(PATH)).calls, 1); assert.equal((await refusedShape(PATH + '?include=all')).calls, 1);
  assert.equal((await refusedShape(PATH + '?include=grants&grantsCursor=grant-one')).calls, 1);
  assert.equal((await refusedShape(PATH, { method: 'POST', body: input })).calls, 1);
  assert.equal((await refusedShape(PATH + '/grant-one', { method: 'DELETE', body: {} })).calls, 1);
  const denied = await fixture(t, envelope => json({ error: envelope.listQuery.include ? shape : 'refused' }, { status: envelope.listQuery.include ? 400 : 403 }));
  assert.equal((await denied.request(PATH + '?include=clients')).status, 403);
  const malformed = await fixture(t, envelope => envelope.listQuery.include ? json({ error: shape }, { status: 400 })
    : json({ ...list, clients: [{ ...list.clients[0], email: 'x@example.test' }] }));
  assert.equal((await malformed.request(PATH + '?include=grants')).status, 502);
});
