'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createClientGrantProxy } = require('../server/clientGrantProxy');

// Synthetic data only.
const GROUPS = '/api/v1/workspace/direct-client-groups', LIST = '/api/v1/workspace/direct-client-grants';
const A = 'project-alpha:division-a', B = 'project-alpha:division-b';
const groups = { groups: [[[A, 'ws-linked-a'], [B, 'ws-linked-b']]] };
const list = { clients: [{ sourceId: A, workspaceId: 'ws-linked-a', displayName: 'Acme Survey', businessName: 'Division A' }], grants: [], clientsNextCursor: null };
async function fixture(t, respond) {
  const envelopes = [], app = express(); app.use(express.json());
  createClientGrantProxy({ config: { opsAutomationBaseUrl: 'https://incoming.example.test', viewerEventSecret: 's'.repeat(32), viewerEventKeyId: 'viewer-v1' },
    authorize: () => (req, res, next) => { req.adminPrincipal = { subject: 'ops:staff-one' }; next(); }, diagnostic() {},
    fetchImpl: async (url, request) => { const envelope = JSON.parse(request.body); envelopes.push(envelope); return respond(envelope, request); },
  }).mount(app);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { envelopes, request: path => fetch(`http://127.0.0.1:${server.address().port}${path}`) };
}
const json = (payload, init = {}) => new Response(JSON.stringify(payload), { status: 200, ...init });

test('groups is its own signed request with no fields; the base list request is unchanged', async t => {
  const { request, envelopes } = await fixture(t, envelope => json(envelope.action === 'groups' ? groups : list));
  const grouped = await request(GROUPS);
  assert.equal(grouped.status, 200); assert.deepEqual(await grouped.json(), groups);
  const base = await request(`${LIST}?q=Acme&include=clients&viewerProjectId=viewer-project&limit=25`);
  assert.equal(base.status, 200); assert.deepEqual(await base.json(), list);
  assert.deepEqual(envelopes, [{ subject: 'ops:staff-one', action: 'groups', connection: 'direct' },
    { subject: 'ops:staff-one', action: 'list', connection: 'direct', listQuery: { q: 'Acme', include: 'clients', viewerProjectId: 'viewer-project', limit: 25 } }]);
  assert.equal((await request(`${GROUPS}?q=Acme`)).status, 400);
  assert.equal(envelopes.length, 2);
});

test('an older Operations that refuses groups is answered with a refusal, once, and the list still works', async t => {
  const { request, envelopes } = await fixture(t, envelope => envelope.action === 'groups'
    ? json({ error: 'Viewer client-grant request is invalid' }, { status: 400 }) : json(list));
  assert.equal((await request(GROUPS)).status, 400);
  assert.equal(envelopes.length, 1, 'no retry in another shape');
  assert.deepEqual(await (await request(`${LIST}?include=clients&q=Acme`)).json(), list);
});

test('malformed or oversized groups are refused', async t => {
  const bad = [{ groups: [[[A, 'ws-1']]] }, { groups: [[[A, 'ws-1'], [A, 'ws-2']]] },
    { groups: [[[A, 'ws-1'], [B, 'ws-2']], [[A, 'ws-1'], [B, 'ws-3']]] }, { groups: [], extra: true },
    { groups: [[['not-a-source', 'ws-1'], [B, 'ws-2']]] },
    { groups: Array.from({ length: 251 }, (_, index) => [[A, `a-${index}`], [B, `b-${index}`]]) }];
  let next = 0;
  const { request } = await fixture(t, () => json(bad[next++]));
  for (let index = 0; index < bad.length; index++) assert.equal((await request(GROUPS)).status, 502, `case ${index}`);
});

test('a stalled grouping read is cut off after about two seconds', async t => {
  const { request } = await fixture(t, (envelope, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  assert.equal((await request(GROUPS)).status, 502);
  const waited = Date.now() - started;
  assert.ok(waited >= 1900 && waited < 5000, `waited ${waited} ms`);
});
