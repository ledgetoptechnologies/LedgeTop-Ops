import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');
const auth = require('../server/auth.js');
const { createViewerMarkApi } = require('../server/viewerMarkApi.js');
const schema = require('../server/viewerMarkSchema.js');
const { ViewerMarkRepository, LIMITS } = require('../server/viewerMarkRepository.js');
const { newSharePermissions, effectiveSharePermissions } = require('../server/publicSharePolicy.js');

const MODEL = 'synthetic-model';
const GRANT = { type: 'direct_client_grant', id: 'grant-a', version: 1 }, ASSOCIATION = { type: 'model_association', id: 'association', version: 1 };
const point = (changes = {}) => ({ id: randomUUID(), geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Pin', note: 'Staff note', color: '#88aa22', icon: 'pin', ...changes });
const content = (mark, changes = {}) => ({ id: mark.id, geometry: mark.geometry, name: mark.name, note: mark.note, color: mark.color, icon: mark.icon,
  categoryId: mark.categoryId, elevationNavd88M: mark.elevationNavd88M, revision: mark.revision, ...changes });

async function open(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('${MODEL}'), ('other-model');`);
  db.exec(schema.VIEWER_MARKS_SQL + (schema.VIEWER_MARK_SHARING_SQL || ''));
  const sessions = new Map(), links = new Map();
  const version = id => ({ id: id + '-v1', status: 'ready' });
  const repository = {
    database: db, rateLimited: () => false,
    getViewerSessionByHash: hash => sessions.get(hash), viewerSessionLive: session => !session.revoked,
    getModel: id => ({ id, status: 'ready', activeVersion: version(id) }),
    getPublicShare: id => links.get(id), publicShareLive: link => Boolean(link) && !link.revokedAt,
    getProjectShare: () => null, projectShareLive: () => false,
  };
  const session = (audience, subject, changes = {}) => {
    const token = randomUUID().replaceAll('-', ''), modelId = changes.modelId || MODEL;
    sessions.set(auth.hashToken(token), { audience, subject, modelId, modelVersionId: modelId + '-v1',
      permissions: { view: true, measure: true, personalMeasurements: true }, sourceAuthorization: audience === 'client' ? GRANT : null, ...changes });
    return token;
  };
  const link = (permissions, modelId = MODEL) => {
    const record = { id: randomUUID(), modelId, permissions, versionPolicy: 'latest', authorizationRevision: 0, shareClass: 'staff', revokedAt: null };
    links.set(record.id, record);
    return { record, token: auth.sign({ kind: 'share-asset', shareId: record.id, shareRevision: 0, modelId }, 60_000) };
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/marks', createViewerMarkApi(repository));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const call = async (token, method = 'GET', route = '', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/marks${route ? '/' + route : ''}`,
      { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const refused = async (status, code, ...request) => {
    const answer = await call(...request);
    assert.deepEqual([answer.status, answer.body?.code], [status, code], request.slice(1, 3).join(' '));
  };
  const shared = async token => (await call(token, 'GET', 'shared')).body.marks?.map(mark => mark.name);
  const make = async (token, changes) => { const answer = await call(token, 'POST', '', point(changes)); assert.equal(answer.status, 201); return answer.body.mark; };
  return { db, session, sessions, link, call, refused, shared, make };
}

test('a new staff mark is shared for editing; stored marks stay private; client marks keep their rules', async t => {
  const { db, session, call, refused, shared, make } = await open(t);
  const staff = session('ops', 'one'), other = session('ops', 'two'), client = session('client', 'c');
  const id = randomUUID(), { id: _, ...rest } = point({ name: 'Old' });
  db.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision, created_at, updated_at, updated_by_audience, updated_by_subject)
    VALUES (?, ?, 'ops', 'one', 'private', ?, 'x', 1, '2026-11-01', '2026-11-01', 'ops', 'one')`).run(id, MODEL, JSON.stringify({ id, ...rest }));
  const mark = await make(staff);
  assert.deepEqual([mark.visibility, mark.access, mark.mine, mark.editable, mark.deletable], ['shared', 'edit', true, true, true]);
  assert.equal((await call(staff, 'POST', '', content(mark, { revision: undefined }))).status, 200, 'the same request again');
  assert.deepEqual((await call(staff)).body.marks.map(row => [row.name, row.visibility, row.access]), [['Old', 'private', null], ['Pin', 'shared', 'edit']]);
  assert.deepEqual([await shared(other), await shared(client)], [['Pin'], ['Pin']]);
  await refused(404, 'mark_not_found', other, 'GET', id);
  const caps = async token => { const { visibility, access } = (await call(token)).body.capabilities; return [visibility, access]; };
  assert.deepEqual(await caps(staff), [['shared', 'private'], ['edit', 'view']]);
  assert.deepEqual(await caps(client), [['private', 'staff'], []]);
  assert.equal((await make(client)).visibility, 'private');
  await refused(403, 'mark_visibility_forbidden', client, 'POST', '', point({ visibility: 'shared' }));
  await refused(400, 'invalid_mark', client, 'POST', '', point({ access: 'edit' }));
  await refused(400, 'invalid_mark', staff, 'POST', '', point({ visibility: 'private', access: 'edit' }));
  await refused(400, 'invalid_mark', staff, 'POST', '', point({ access: 'all' }));
});

test('a client changes content of an editable shared mark and nothing else', async t => {
  const { db, session, call, refused, make } = await open(t);
  const staff = session('ops', 'one'), client = session('client', 'c', { sourceAuthorization: ASSOCIATION });
  const used = { id: randomUUID(), name: 'Used', color: '#3366ff', icon: 'flag' }, own = { ...used, id: randomUUID(), name: 'Own' }, hidden = { ...used, id: randomUUID(), name: 'Hidden' };
  for (const category of [used, hidden]) await call(staff, 'POST', 'categories', category);
  await call(client, 'POST', 'categories', own);
  await make(staff, { name: 'Other', categoryId: used.id });
  await make(staff, { name: 'Alone', visibility: 'private', categoryId: hidden.id });
  const mark = await make(staff), view = await make(staff, { name: 'View', access: 'view' });
  const seen = (await call(client, 'GET', mark.id)).body.mark;
  assert.deepEqual([seen.editable, seen.deletable, seen.mine, seen.note, 'changedBy' in seen], [true, false, false, 'Staff note', false]);
  const changed = await call(client, 'PUT', mark.id, content(seen, { name: 'New', note: 'Mine', icon: 'flag', color: '#112233', categoryId: used.id,
    geometry: { type: 'Point', coordinates: [-86, 42] }, visibility: 'shared', access: 'edit' }));
  assert.deepEqual([changed.status, changed.body.mark?.name, changed.body.mark?.categoryId, changed.body.mark?.access], [200, 'New', used.id, 'edit']);
  const now = changed.body.mark;
  await refused(403, 'mark_visibility_forbidden', client, 'PUT', mark.id, content(now, { visibility: 'private' }));
  await refused(403, 'mark_visibility_forbidden', client, 'PUT', mark.id, content(now, { access: 'view' }));
  await refused(403, 'mark_visibility_forbidden', client, 'PUT', mark.id, content(now, { shareAccount: 'direct_client_grant:grant-a' }));
  for (const category of [own, hidden]) await refused(400, 'mark_category_not_found', client, 'PUT', mark.id, content(now, { categoryId: category.id }));
  await refused(409, 'mark_revision_conflict', client, 'PUT', mark.id, content(mark));
  for (const permanent of [false, true]) await refused(403, 'mark_edit_forbidden', client, 'DELETE', mark.id, { revision: now.revision, permanent });
  await refused(403, 'mark_edit_forbidden', client, 'POST', 'batch/delete', { marks: [{ id: mark.id, revision: now.revision }] });
  await refused(403, 'mark_edit_forbidden', client, 'PUT', view.id, content(view, { name: 'No' }));
  await refused(404, 'mark_not_found', client, 'GET', mark.id + '/history');
  await refused(404, 'mark_not_found', client, 'POST', mark.id + '/revert', { revision: now.revision });
  await refused(403, 'mark_visibility_forbidden', client, 'POST', 'batch/share', { marks: [{ id: mark.id, revision: now.revision }] });
  assert.deepEqual({ ...db.prepare('SELECT updated_by_audience a, updated_by_subject s, owner_subject o FROM viewer_marks WHERE id=?').get(mark.id) }, { a: 'client', s: 'c', o: 'one' });
  assert.equal((await call(staff, 'GET', mark.id)).body.mark.changedBy, 'client');
  // No verified person: refused, as before.
  const login = session('client', 'company', { permissions: { view: true, measure: true } });
  await refused(403, 'mark_identity_required', login, 'GET', 'shared');
  await refused(403, 'mark_identity_required', login, 'GET', mark.id);
  assert.deepEqual((await call(login)).body, { marks: [], categories: [], starters: [], capabilities: { write: false, staff: false, visibility: ['private'] } });
  await refused(403, 'mark_identity_required', login, 'PUT', mark.id, content(now));
});

test('only sessions of that model, live and issued for it, read shared marks; private and revoked end at once', async t => {
  const { session, sessions, call, shared, make, refused } = await open(t);
  const staff = session('ops', 'one'), client = session('client', 'c'), association = session('client', 'd', { sourceAuthorization: ASSOCIATION });
  const elsewhere = session('client', 'c', { modelId: 'other-model' }), staffElsewhere = session('ops', 'one', { modelId: 'other-model' });
  const unbound = session('client', 'e', { sourceAuthorization: null });
  const mark = await make(staff);
  for (const token of [client, association]) assert.deepEqual(await shared(token), ['Pin']);
  for (const token of [elsewhere, staffElsewhere, unbound]) {
    assert.deepEqual(await shared(token), []);
    await refused(404, 'mark_not_found', token, 'GET', mark.id);
    await refused(404, 'mark_not_found', token, 'PUT', mark.id, content(mark));
  }
  sessions.get(auth.hashToken(association)).revoked = true;
  for (const [method, route, body] of [['GET', 'shared'], ['GET', mark.id], ['PUT', mark.id, content(mark)]]) await refused(403, 'marks_unavailable', association, method, route, body);
  assert.equal((await call(staff, 'PUT', mark.id, content(mark, { visibility: 'private' }))).body.mark.access, null);
  assert.deepEqual(await shared(client), []);
  await refused(404, 'mark_not_found', client, 'PUT', mark.id, content(mark, { revision: 2 }));
});

test('staff manage each other\'s shared marks, never a private one', async t => {
  const { session, call, refused, make, shared } = await open(t);
  const one = session('ops', 'one'), two = session('ops', 'two'), client = session('client', 'c');
  const mark = await make(one), alone = await make(one, { visibility: 'private', name: 'Alone' });
  for (const [method, body] of [['GET'], ['PUT', content(alone)], ['DELETE', { revision: 1 }]]) await refused(404, 'mark_not_found', two, method, alone.id, body);
  const edited = (await call(two, 'PUT', mark.id, content(mark, { name: 'Two', access: 'view' }))).body.mark;
  assert.deepEqual([edited?.name, edited?.access, edited?.mine, edited?.deletable], ['Two', 'view', false, true]);
  assert.equal((await call(two, 'DELETE', mark.id, { revision: 2 })).status, 204);
  assert.deepEqual(await shared(client), []);
  assert.deepEqual((await call(client, 'GET', 'deleted')).body.marks, []);
  await refused(404, 'mark_not_found', client, 'POST', mark.id + '/restore', { revision: 2 });
  const three = session('ops', 'three');
  assert.deepEqual((await call(three, 'GET', 'deleted')).body.marks.map(row => [row.name, row.visibility, row.mine]), [['Two', 'shared', false]]);
  assert.equal((await call(three, 'POST', mark.id + '/restore', { revision: 2 })).body.mark.access, 'view');
  assert.equal((await call(one, 'DELETE', alone.id, { revision: 1 })).status, 204);
  assert.deepEqual((await call(three, 'GET', 'deleted')).body.marks, [], 'a private one is its owner\'s');
  await refused(404, 'mark_not_found', three, 'POST', alone.id + '/restore', { revision: 1 });
  assert.equal((await call(two, 'PUT', mark.id, content({ ...edited, revision: 3 }, { visibility: 'private' }))).body.mark.editable, false);
  await refused(404, 'mark_not_found', two, 'GET', mark.id);
});

test('a client session without measure reads the shared lists and nothing else', async t => {
  const { session, sessions, call, refused, make, shared } = await open(t);
  const staff = session('ops', 'one'), client = session('client', 'c');
  const mark = await make(staff), own = await make(client, { name: 'Own' });
  sessions.get(auth.hashToken(client)).permissions = { view: true, measure: false, personalMeasurements: true };
  assert.deepEqual(await shared(client), ['Pin']);
  assert.deepEqual((await call(client, 'GET', 'shared')).body.marks.map(row => [row.mine, row.editable, row.deletable]), [[false, false, false]]);
  assert.deepEqual((await call(client)).body, { marks: [], categories: [], starters: [], capabilities: { write: false, staff: false, visibility: ['private'], shared: true, access: [] } });
  for (const target of [mark, own]) {
    for (const [method, route, body] of [['GET', target.id], ['PUT', target.id, content(target)], ['DELETE', target.id, { revision: 1 }], ['POST', target.id + '/restore', { revision: 1 }],
      ['POST', target.id + '/revert', { revision: 1 }], ['GET', target.id + '/history'], ['POST', 'batch/delete', { marks: [{ id: target.id, revision: 1 }] }]]) await refused(403, 'marks_unavailable', client, method, route, body);
  }
  for (const [method, route, body] of [['POST', '', point()], ['POST', 'batch', { marks: [point()] }], ['POST', 'batch/share', {}], ['POST', 'batch/status', { ids: [own.id] }],
    ['POST', 'categories', {}], ['POST', 'categories/starter', {}], ['POST', 'shared', {}], ['GET', 'deleted'], ['GET', 'audiences']]) await refused(403, 'marks_unavailable', client, method, route, body);
  assert.equal((await call(staff, 'GET', mark.id)).body.mark.revision, 1);
  for (const token of [session('client', 'd', { permissions: { view: false } }), session('client', 'e', { permissions: { view: true, personalMeasurements: true }, sourceAuthorization: null }),
    session('client', 'f', { permissions: { view: true } }),
    session('ops', 'two', { permissions: { view: true } })]) {
    for (const route of ['', 'shared']) await refused(403, 'marks_unavailable', token, 'GET', route);
  }
});

test('staff undo a client edit; history is bounded, keeps staff\'s version, and goes with the mark', async t => {
  const { db, session, call, refused, make } = await open(t);
  const staff = session('ops', 'one'), client = session('client', 'c');
  let mark = await make(staff, { name: 'Original' });
  for (let i = 1; i <= 14; i += 1) mark = (await call(client, 'PUT', mark.id, content(mark, { name: 'Client ' + i }))).body.mark;
  const { versions } = (await call(staff, 'GET', mark.id + '/history')).body;
  assert.equal(versions.length, LIMITS.history + 1);
  assert.deepEqual([versions[0].mark.name, versions[0].changedBy, versions.at(-1).mark.name, versions.at(-1).changedBy], ['Client 13', 'client', 'Original', 'staff']);
  await refused(409, 'mark_revision_conflict', staff, 'POST', mark.id + '/revert', { revision: 1 });
  await refused(404, 'mark_version_not_found', staff, 'POST', mark.id + '/revert', { revision: mark.revision, to: 2 });
  await refused(428, 'mark_revision_required', staff, 'POST', mark.id + '/revert', {});
  await refused(400, 'invalid_mark_revert', staff, 'POST', mark.id + '/revert', { revision: mark.revision, to: 'x' });
  const back = (await call(staff, 'POST', mark.id + '/revert', { revision: mark.revision, to: 1 })).body.mark;
  assert.deepEqual([back.name, back.revision, back.access, back.changedBy], ['Original', mark.revision + 1, 'edit', 'staff']);
  assert.equal((await call(staff, 'POST', mark.id + '/revert', { revision: back.revision, to: mark.revision })).body.mark.name, 'Client 14', 'the undo can be undone');
  const count = () => db.prepare('SELECT count(*) n FROM viewer_mark_history').get().n;
  assert.ok(count() > 0);
  assert.equal((await call(staff, 'DELETE', mark.id, { revision: back.revision + 1 })).status, 204);
  new ViewerMarkRepository(db).purgeDeleted(Date.now() + 40 * 86_400_000);
  assert.equal(count(), 0);
  const gone = await make(staff);
  await call(client, 'PUT', gone.id, content(gone, { name: 'x' }));
  assert.equal((await call(staff, 'DELETE', gone.id, { revision: 2, permanent: true })).status, 204);
  assert.equal(count(), 0);
});

test('share all: own marks, exact revisions, bounded, all or none', async t => {
  const { session, call, refused, make, shared } = await open(t);
  const staff = session('ops', 'one'), other = session('ops', 'two'), client = session('client', 'c');
  const a = await make(staff, { visibility: 'private', name: 'A' }), b = await make(staff, { visibility: 'private', name: 'B' });
  const theirs = await make(other, { name: 'Theirs' }), hidden = await make(other, { visibility: 'private' });
  const item = (mark, revision = mark.revision) => ({ id: mark.id, revision });
  await refused(409, 'mark_revision_conflict', staff, 'POST', 'batch/share', { marks: [item(a), item(b, 9)] });
  await refused(403, 'mark_edit_forbidden', staff, 'POST', 'batch/share', { marks: [item(a), item(theirs)] });
  await refused(404, 'mark_not_found', staff, 'POST', 'batch/share', { marks: [item(a), item(hidden)] });
  for (const body of [{ marks: [] }, { marks: [item(a), item(a)] }, { marks: [item(a)], access: 'all' }, { marks: [item(a)], extra: 1 },
    { marks: Array.from({ length: LIMITS.batch + 1 }, () => ({ id: randomUUID(), revision: 1 })) }]) await refused(400, 'invalid_mark_batch', staff, 'POST', 'batch/share', body);
  await refused(428, 'mark_revision_required', staff, 'POST', 'batch/share', { marks: [{ id: a.id }] });
  assert.deepEqual(await shared(client), ['Theirs'], 'nothing happened');
  const done = await call(staff, 'POST', 'batch/share', { marks: [item(a), item(b)], access: 'view' });
  assert.deepEqual(done.body.marks.map(mark => [mark.name, mark.visibility, mark.access, mark.revision]), [['A', 'shared', 'view', 2], ['B', 'shared', 'view', 2]]);
  assert.deepEqual((await shared(client)).sort(), ['A', 'B', 'Theirs']);
  assert.equal((await call(staff, 'POST', 'batch/share', { marks: [item(a, 2)] })).body.marks[0].revision, 2, 'already shared');
});

test('a public link reads shared marks only while it shows them, without notes or people, and writes nothing', async t => {
  const { session, link, call, refused, make, shared } = await open(t);
  const staff = session('ops', 'secret-person'), client = session('client', 'c');
  const category = { id: randomUUID(), name: 'Used', color: '#3366ff', icon: 'flag' };
  await call(staff, 'POST', 'categories', category);
  const mark = await make(staff, { categoryId: category.id });
  await make(staff, { visibility: 'private', name: 'Alone' });
  await make(client, { visibility: 'staff', name: 'Client' });
  const away = await make(staff, { name: 'Deleted' });
  await call(staff, 'DELETE', away.id, { revision: 1 });
  await make(session('ops', 'x', { modelId: 'other-model' }), { name: 'Elsewhere' });
  for (const permissions of [{ view: true, measure: true }, { view: true, marks: false }, { view: false, marks: true }, { view: true, marks: 'true' }]) {
    for (const route of ['', 'shared']) await refused(403, 'marks_unavailable', link(permissions).token, 'GET', route);
  }
  const { record, token } = link(newSharePermissions({}));
  const page = await call(token, 'GET', 'shared');
  assert.deepEqual(page.body.marks, [{ id: mark.id, geometry: mark.geometry, name: 'Pin', categoryId: category.id, color: mark.color, icon: 'pin', elevationNavd88M: null,
    visibility: 'shared', access: 'view', revision: 1, author: 'staff', mine: false, editable: false, deletable: false }]);
  assert.deepEqual(page.body.categories.map(row => row.name), ['Used']);
  assert.ok(!/secret-person|note/i.test(JSON.stringify(page.body)));
  assert.deepEqual((await call(token)).body, { marks: [], categories: [], starters: [], capabilities: { write: false, staff: false, visibility: ['private'], shared: true, access: [] } });
  for (const [method, route, body] of [['POST', '', point()], ['PUT', mark.id, content(mark)], ['DELETE', mark.id, { revision: 1 }], ['POST', mark.id + '/restore', { revision: 1 }],
    ['POST', mark.id + '/revert', { revision: 1 }], ['POST', 'batch', { marks: [point()] }], ['POST', 'batch/delete', {}], ['POST', 'batch/share', {}], ['POST', 'batch/status', {}],
    ['POST', 'categories', category], ['POST', 'categories/starter', {}], ['PUT', 'categories/' + category.id, category], ['DELETE', 'categories/' + category.id, { revision: 1 }],
    ['POST', 'shared', {}], ['GET', mark.id], ['GET', 'deleted'], ['GET', 'audiences'], ['GET', mark.id + '/history']]) await refused(403, 'mark_read_only', token, method, route, body);
  assert.equal((await call(staff, 'GET', mark.id)).body.mark.revision, 1);
  assert.deepEqual(await shared(link({ view: true, marks: true }, 'other-model').token), ['Elsewhere']);
  await refused(403, 'marks_unavailable', token.slice(0, -4) + 'xxxx', 'GET', 'shared');
  const now = (await call(staff, 'PUT', mark.id, content(mark, { visibility: 'private' }))).body.mark;
  assert.deepEqual(await shared(token), []);
  await call(staff, 'PUT', mark.id, content(now, { visibility: 'shared' }));
  assert.deepEqual(await shared(token), ['Pin']);
  record.permissions = { ...record.permissions, marks: false };
  await refused(403, 'marks_unavailable', token, 'GET', 'shared');
  record.permissions.marks = true; record.revokedAt = 'now';
  await refused(403, 'marks_unavailable', token, 'GET', 'shared');
  assert.deepEqual([newSharePermissions({}).marks, newSharePermissions({ marks: false }).marks, effectiveSharePermissions({ view: true }).marks], [true, false, false]);
});

test('a link a client creates does not show marks unless that was chosen', async t => {
  const { session, link, refused, make, shared } = await open(t);
  await make(session('ops', 'one'));
  for (const value of [undefined, {}, { view: true, measure: true }, { view: true, marks: 'true' }]) {
    assert.equal(newSharePermissions(value, 'client').marks, false);
    for (const route of ['', 'shared']) await refused(403, 'marks_unavailable', link(newSharePermissions(value, 'client')).token, 'GET', route);
  }
  assert.equal(newSharePermissions({ marks: true }, 'client').marks, true);
  assert.equal(newSharePermissions({}, 'staff').marks, true);
  assert.deepEqual(await shared(link(newSharePermissions({}, 'staff')).token), ['Pin']);
  const route = fs.readFileSync(new URL('../server/apiV1.js', import.meta.url), 'utf8');
  assert.ok(route.includes('newSharePermissions(body.permissions,shareClass)'), 'the route that creates client links says whose link it is');
});

test('shared lists come in bounded pages', async t => {
  const { db, session, link, call } = await open(t);
  const insert = db.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision, created_at, updated_at, updated_by_audience, updated_by_subject)
    VALUES (?, ?, 'ops', 'one', 'internal', ?, 'x', 1, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'ops', 'one')`);
  const add = db.prepare("INSERT INTO viewer_mark_shares VALUES (?, ?, 'edit')");
  for (let i = 0; i < LIMITS.pageRows + 3; i += 1) { const mark = { ...point(), categoryId: null }; insert.run(mark.id, MODEL, JSON.stringify(mark)); add.run(MODEL, mark.id); }
  for (const token of [session('client', 'c'), session('ops', 'two'), link({ view: true, marks: true }).token]) {
    const first = (await call(token, 'GET', 'shared')).body, second = (await call(token, 'GET', 'shared?after=' + encodeURIComponent(first.next))).body;
    assert.deepEqual([first.marks.length, second.marks.length, second.next], [LIMITS.pageRows, 3, null]);
  }
});
