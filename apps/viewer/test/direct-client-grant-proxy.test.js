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

test('direct lists accept additive provider metadata without forwarding it', async t => {
  const known = { ...list, grantsNextCursor: null, capabilities: { replaces: true } };
  for (const olderInclude of [false, true]) {
    for (const include of ['all', 'clients', 'grants']) {
      const { request } = await fixture(t, envelope => olderInclude && include !== 'all' && envelope.listQuery.include
        ? json({ error: 'Viewer client-grant request is invalid' }, { status: 400 })
        : json({ ...known, catalogRevision: 7, providerSummary: { label: 'Synthetic provider' } }));
      const response = await request(PATH + '?include=' + include);
      assert.equal(response.status, 200);
      const expected = olderInclude && include === 'clients'
        ? { clients: known.clients, grants: [], clientsNextCursor: null }
        : olderInclude && include === 'grants' ? { ...known, clients: [] } : { ...known };
      if (include === 'clients') delete expected.capabilities;
      assert.deepEqual(await response.json(), expected);
    }
  }
});

for (const selection of [undefined, { version: 1, mode: 'only', folderIds: ['00000000-0000-4000-8000-000000000001'], taskIds: [] }])
test(`refused replacement uses the existing plain error and sends the exact change once (${selection ? 'Only' : 'Everything'})`, async t => {
  const body = { ...input, ...(selection ? { selection } : {}), replaces: [{ grantId: 'grant-old', grantVersion: 2 }] };
  const { request, envelopes } = await fixture(t, () => json({ error: 'Viewer client-grant request is invalid' }, { status: 400 }));
  const response = await request(PATH, { method: 'POST', body });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Operations rejected the client access request', code: 'operations_request_failed' });
  assert.equal(envelopes.length, 1);
  assert.deepEqual(envelopes[0].grant, body);
});

test('old and capable direct lists preserve the explicit capability, including include compatibility reads', async t => {
  for (const capabilities of [undefined, { replaces: false }, { replaces: true }]) {
    const payload = { ...list, ...(capabilities === undefined ? {} : { capabilities }) };
    for (const include of ['all', 'clients', 'grants']) {
      for (const olderInclude of [false, true]) {
        const { request } = await fixture(t, envelope => olderInclude && envelope.listQuery.include !== undefined && include !== 'all'
          ? json({ error: 'Viewer client-grant request is invalid' }, { status: 400 }) : json(payload));
        const response = await request(PATH + '?viewerProjectId=viewer-project&include=' + include);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).capabilities, include === 'clients' ? undefined : capabilities);
      }
    }
  }
  for (const capabilities of [null, [], { replaces: 'true' }, { replaces: 1 }, { replaces: true, extra: true }]) {
    const { request } = await fixture(t, () => json({ ...list, capabilities }));
    assert.equal((await request()).status, 502);
  }
});

test('direct list signs bounded recipient query, preserves schema and permission boundary', async t => {
  const { request, envelopes } = await fixture(t, () => json(list));
  const response = await request(PATH + '?q=Synthetic&limit=10&viewerProjectId=viewer-project');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), list);
  assert.deepEqual(envelopes, [{ subject: 'ops:staff-one', action: 'list', connection: 'direct', listQuery: { q: 'Synthetic', limit: 10, viewerProjectId: 'viewer-project' } }]);
  for (const query of ['?limit=51', '?limit=2&limit=3', '?cursor=bad%2Fcursor', '?unexpected=true', '?q=control%0A']) assert.equal((await request(PATH + query)).status, 400);
  const denied = await fixture(t, () => { throw new Error('must not reach network'); }, false);
  assert.equal((await denied.request()).status, 403); assert.deepEqual(denied.envelopes, []);
});

test('replacement refusals preserve existing structured errors', async t => {
  const body = { ...input, replaces: [{ grantId: 'grant-old', grantVersion: 2 }] };
  for (const [status, payload, expected] of [
    [400, { error: 'Viewer client-grant request is invalid', code: 'invalid_request' }, 'invalid_request'],
    [400, { error: 'Different refusal' }, 'operations_request_failed'],
    [403, { error: 'Viewer client-grant request is invalid' }, 'operations_request_failed'],
    [409, { error: 'Changed', code: 'share_changed' }, 'share_changed'],
    [503, { error: 'Viewer client-grant request is invalid' }, 'operations_request_failed'],
  ]) {
    const { request, envelopes } = await fixture(t, () => json(payload, { status }));
    const response = await request(PATH, { method: 'POST', body });
    assert.equal(response.status, status >= 500 ? 502 : status);
    assert.equal((await response.json()).code, expected);
    assert.equal(envelopes.length, 1);
    assert.deepEqual(envelopes[0].grant, body);
  }
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

test('a selection is checked before signing and on the way back, only on a whole-project grant', async t => {
  const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
  const selection = { version: 1, mode: 'only', folderIds: [a], taskIds: [b] };
  const { request, envelopes } = await fixture(t, () => json({ grant: { ...grant, selection }, replayed: false }));
  const response = await request(PATH, { method: 'POST', body: { ...input, selection } });
  assert.equal(response.status, 201); assert.deepEqual((await response.json()).grant.selection, selection);
  assert.deepEqual(envelopes[0].grant.selection, selection);
  for (const broken of [null, {}, { ...selection, mode: 'all' }, { ...selection, folderIds: [b, a] }, { ...selection, taskIds: [b, b] }, { ...selection, folderIds: [], taskIds: [] }, { ...selection, extra: 1 }])
    assert.equal((await request(PATH, { method: 'POST', body: { ...input, selection: broken } })).status, 400, JSON.stringify(broken));
  assert.equal((await request(PATH, { method: 'POST', body: { ...input, scopeType: 'task', taskId: 'task', includeFuturePublished: false, selection } })).status, 400);
  assert.equal((await request(PATH, { method: 'POST', body: { ...input, exclusions: selection } })).status, 400);
  assert.equal(envelopes.length, 1);
  for (const bad of [{ ...grant, selection: { ...selection, mode: 'all' } }, { ...grant, scopeType: 'task', taskId: 'task', includeFuturePublished: false, selection }]) {
    const rejected = await fixture(t, () => json({ ...list, grants: [bad] })); assert.equal((await rejected.request()).status, 502);
  }
  const listed = await fixture(t, () => json({ ...list, grants: [{ ...grant, selection }] })); assert.equal((await listed.request()).status, 200);
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

test('a replacement list is checked before signing, and its answer is typed', async t => {
  const list = [{ grantId: 'grant-old', grantVersion: 2 }], answer = extra => ({ grant, replayed: false, ...extra });
  for (const [payload, status] of [[answer({ sessionRevocation: { pending: true, revokedGrants: 1 } }), 202], [answer({ sessionRevocation: { pending: false, revokedGrants: 1 } }), 201],
    [{ ...answer({ sessionRevocation: { pending: false, revokedGrants: 1 } }), replayed: true }, 200], [answer(), 201],
    [answer({ sessionRevocation: { pending: 'no' } }), 502], [answer({ sessionRevocation: { pending: false, revokedGrants: -1 } }), 502], [answer({ sessionRevocation: null }), 502]]) {
    const { request, envelopes } = await fixture(t, () => json(payload));
    assert.equal((await request(PATH, { method: 'POST', body: { ...input, replaces: list } })).status, status, JSON.stringify(payload));
    assert.deepEqual(envelopes[0].grant.replaces, list);
  }
  const { request, envelopes } = await fixture(t, () => json(answer()));
  assert.equal((await request(PATH, { method: 'POST', body: { ...input, replaces: [] } })).status, 201); envelopes.length = 0;
  for (const replaces of [null, {}, [null], [{ grantId: 'grant-old' }], [{ ...list[0], extra: 1 }], [{ ...list[0], grantVersion: 0 }], [{ ...list[0], grantId: 'bad id' }], [...list, ...list],
    Array.from({ length: 101 }, (_, index) => ({ grantId: `grant-${index}`, grantVersion: 1 }))])
    assert.equal((await request(PATH, { method: 'POST', body: { ...input, replaces } })).status, 400, JSON.stringify(replaces).slice(0, 80));
  assert.equal((await request(PATH, { method: 'POST', body: { ...input, scopeType: 'task', taskId: 'task', includeFuturePublished: false, replaces: list } })).status, 400);
  assert.equal(envelopes.length, 0);
  // The refusal carries the current shares, and only well-formed ones.
  for (const [grants, expected] of [[list, list], [[], []], [[{ ...list[0], clientDisplayName: 'private' }], undefined], ['x', undefined]]) {
    const refused = await fixture(t, () => json({ error: 'Changed', code: 'share_changed', grants }, { status: 409 }));
    const response = await refused.request(PATH, { method: 'POST', body: { ...input, replaces: list } });
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Changed', code: 'share_changed', ...(expected ? { grants: expected } : {}) });
  }
});

test('replacement overflow keeps its actionable code and omits any partial grant list', async t => {
  const message = 'Revoke shares the client no longer needs one at a time, then try again';
  const payload = { error: message, code: 'share_replacement_limit' };
  for (const grants of [undefined, [{ grantId: 'grant-old', grantVersion: 2 }]]) {
    const { request } = await fixture(t, () => json({ ...payload, grants }, { status: 409 }));
    const response = await request(PATH, { method: 'POST', body: { ...input, replaces: [] } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), payload);
  }
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
  { ...list, grants: [{ ...grant, grantVersion: 0 }] }]) test('direct list rejects malformed upstream authority', async t => {
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
  // Asked first with the Email client offer, then without it, then the way this older release understands.
  assert.equal(opened.envelopes.length, 3); assert.equal(opened.envelopes[0].capabilities, true); assert.equal('capabilities' in opened.envelopes[1], false);
  assert.deepEqual(opened.envelopes[2].listQuery, { limit: 1, viewerProjectId: 'viewer-project' });
});

test('the older-Operations retry never widens, repeats or hides another refusal', async t => {
  const shape = 'Viewer client-grant request is invalid';
  const status = (code, body) => async (path, options) => { const item = await fixture(t, () => json(body || { error: 'refused' }, { status: code }));
    return { response: await item.request(path, options), calls: item.envelopes.length }; };
  for (const code of [401, 403, 404, 409, 429, 500]) assert.equal((await status(code)(PATH + '?include=grants')).calls, 1, String(code));
  for (const body of [undefined, { error: 'Invalid client picker query', code: 'invalid_request' }])
    assert.equal((await status(400, body)(PATH + '?include=grants')).calls, 1);
  const refusedShape = status(400, { error: shape });
  // Opening Share: without the Email client offer, then without include. Never more.
  const twice = await refusedShape(PATH + '?include=grants'); assert.equal(twice.calls, 3); assert.equal(twice.response.status, 400);
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

test('the Email client choice travels beside the grant, and an older Operations still gets the share once without it', async t => {
  const shape = 'Viewer client-grant request is invalid';
  const current = await fixture(t, () => json({ grant, replayed: false }));
  assert.equal((await current.request(PATH, { method: 'POST', body: { ...input, notifyClient: true } })).status, 201);
  assert.deepEqual(current.envelopes[0].grant, input); assert.equal(current.envelopes[0].notifyClient, true);
  assert.equal((await current.request(PATH, { method: 'POST', body: { ...input, notifyClient: false }, key: 'direct-proxy-idempotency-0002' })).status, 201);
  assert.equal('notifyClient' in current.envelopes[1], false);
  for (const bad of ['yes', 1, null]) assert.equal((await current.request(PATH, { method: 'POST', body: { ...input, notifyClient: bad } })).status, 400);
  assert.equal(current.envelopes.length, 2);
  const older = await fixture(t, envelope => 'notifyClient' in envelope ? json({ error: shape }, { status: 400 }) : json({ grant, replayed: false }, { status: 201 }));
  assert.equal((await older.request(PATH, { method: 'POST', body: { ...input, notifyClient: true } })).status, 201);
  assert.equal(older.envelopes.length, 2); assert.equal('notifyClient' in older.envelopes[1], false);
  assert.equal(older.envelopes[0].idempotencyKey, older.envelopes[1].idempotencyKey);
  // Same key and the same grant: Operations can only ever make this share once.
  assert.deepEqual(older.envelopes[1].grant, older.envelopes[0].grant);
  assert.deepEqual({ ...older.envelopes[0], notifyClient: undefined }, { ...older.envelopes[1], notifyClient: undefined });
  for (const code of [403, 409, 500]) {
    const other = await fixture(t, () => json({ error: shape }, { status: code }));
    await other.request(PATH, { method: 'POST', body: { ...input, notifyClient: true } });
    assert.equal(other.envelopes.length, 1, String(code));
  }
  const refusing = await fixture(t, () => json({ error: shape }, { status: 400 }));
  assert.equal((await refusing.request(PATH, { method: 'POST', body: { ...input, notifyClient: true } })).status, 400);
  assert.equal(refusing.envelopes.length, 2);
});

test('opening Share asks Operations whether it can email the client, and passes on only that answer', async t => {
  const shape = 'Viewer client-grant request is invalid';
  const current = await fixture(t, envelope => json({ ...list, grantsNextCursor: null,
    capabilities: { replaces: true, ...(envelope.capabilities ? { notifyClient: true } : {}) } }));
  const opened = await current.request(PATH + '?include=grants&limit=25&viewerProjectId=viewer-project');
  assert.equal(opened.status, 200); assert.deepEqual((await opened.json()).capabilities, { replaces: true, notifyClient: true });
  assert.equal(current.envelopes[0].capabilities, true);
  // Only the dialog-open list asks; searches, later pages and other lists never do.
  for (const path of ['?include=clients&q=Syn', '?include=grants&grantsCursor=grant-one', '?include=all', ''])
    await current.request(PATH + path);
  assert.equal(current.envelopes.slice(1).some(envelope => 'capabilities' in envelope), false);
  for (const bad of [{ replaces: true, notifyClient: false }, { replaces: true, notifyClient: 'true' }, { notifyClient: true }, ['notify_client_v1']]) {
    const odd = await fixture(t, () => json({ ...list, grantsNextCursor: null, capabilities: bad }));
    assert.equal((await odd.request(PATH + '?include=grants')).status, 502);
  }
  const older = await fixture(t, envelope => 'capabilities' in envelope ? json({ error: shape }, { status: 400 })
    : json({ ...list, grantsNextCursor: null, capabilities: { replaces: true } }));
  const fallback = await older.request(PATH + '?include=grants&limit=25');
  assert.equal(fallback.status, 200); assert.deepEqual((await fallback.json()).capabilities, { replaces: true });
  assert.equal(older.envelopes.length, 2); assert.deepEqual(older.envelopes[1].listQuery, older.envelopes[0].listQuery);
});

test('Operations says it can store the model report choice beside the list; older Viewers drop that key', async t => {
  const current = await fixture(t, () => json({ ...list, grantsNextCursor: null, capabilities: { replaces: true }, modelReport: true }));
  const opened = await current.request(PATH + '?include=grants&limit=25&viewerProjectId=viewer-project');
  assert.equal(opened.status, 200); assert.equal((await opened.json()).modelReport, true);
  const picker = await current.request(PATH + '?include=clients&q=Syn');
  assert.equal('modelReport' in await picker.json(), false, 'a client search does not carry it');
  for (const modelReport of [false, 'true', 1, null]) {
    const bad = await fixture(t, () => json({ ...list, grantsNextCursor: null, modelReport }));
    assert.equal((await bad.request(PATH + '?include=grants')).status, 502, String(modelReport));
  }
});

test('a client share may carry the model report choice; anything but a boolean is refused before Operations', async t => {
  const reported = { ...grant, permissions: { ...grant.permissions, report: false } };
  const current = await fixture(t, () => json({ grant: reported, replayed: false }));
  const body = { ...input, permissions: { ...input.permissions, report: false } };
  assert.equal((await current.request(PATH, { method: 'POST', body })).status, 201);
  assert.deepEqual(current.envelopes[0].grant.permissions, { measure: true, cameras: false, download: false, report: false });
  for (const report of ['no', 0, null]) assert.equal((await current.request(PATH, { method: 'POST', body: { ...input, permissions: { ...input.permissions, report } } })).status, 400);
  assert.equal(current.envelopes.length, 1);
  const malformed = await fixture(t, () => json({ grant: { ...grant, permissions: { ...grant.permissions, report: 'yes' } }, replayed: false }));
  assert.equal((await malformed.request(PATH, { method: 'POST', body: input })).status, 502);
});
