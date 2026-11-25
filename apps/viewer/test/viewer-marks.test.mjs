import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import auth from '../server/auth.js';
import api from '../server/viewerMarkApi.js';
import schema from '../server/viewerMarkSchema.js';
import marksRepository from '../server/viewerMarkRepository.js';
import database from '../server/database.js';
import { projectViewerMark } from '../viewer-mark-position.mjs';

const modelId = 'synthetic-model';
const ACCOUNT_B = { sourceAuthorization: { type: 'direct_client_grant', id: 'grant-b', version: 3 } };
// Production mints one association id per project model for every client account on it.
const SHARED_ASSOCIATION = { sourceAuthorization: { type: 'model_association', id: 'project-model-association', version: 2 } };
const point = (changes = {}) => ({
  id: randomUUID(), geometry: { type: 'Point', coordinates: [-87, 43.05] }, name: 'Synthetic pin',
  color: '#88AA22', icon: 'pin', note: 'Test only', ...changes,
});

// The API serves SERVED_SHARING by default, as apiV1 mounts it. Tests marked [held
// sharing] opt into the sharing rules that are kept in the code but not served.
const SHARING = { visibility: marksRepository.HELD_SHARING };
async function openApi(t, options) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE models(id TEXT PRIMARY KEY);
    INSERT INTO models VALUES ('synthetic-model'), ('other-model');`);
  db.exec(schema.VIEWER_MARKS_SQL + schema.VIEWER_MARK_SHARING_SQL);
  assert.equal(schema.verifyViewerMarksSchema(db), true);
  const sessions = new Map();
  // Client sessions carry the portal account they were issued under.
  const session = (audience, subject, changes = {}) => {
    const token = randomUUID().replaceAll('-', '');
    sessions.set(auth.hashToken(token), {
      audience, subject, modelId, modelVersionId: 'synthetic-v1',
      permissions: { view: true, measure: true, personalMeasurements: true },
      sourceAuthorization: audience === 'client' ? { type: 'direct_client_grant', id: 'grant-a', version: 1 } : null,
      ...changes,
    });
    return token;
  };
  const repository = {
    database: db,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: record => !record.revoked,
    getModel: id => ({ status: 'ready', activeVersion: { id: id === modelId ? 'synthetic-v1' : 'other-v1', status: 'ready' } }),
    getModelVersion: (_id, version) => ({ status: 'ready', activeVersion: { id: version, status: 'ready' } }),
    rateLimited: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/marks', api.createViewerMarkApi(repository, options));
  const server = createServer(app);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  });
  const raw = async (token, method = 'GET', route = '', body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/marks' + (route ? '/' + route : ''),
      { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  // What the page ends up with: the person's own answer plus every shared page.
  const request = async (token, method = 'GET', route = '', body) => {
    const answer = await raw(token, method, route, body);
    if (method !== 'GET' || route || !answer.body?.capabilities?.shared) return answer;
    for (let next = ''; next !== null;) {
      const { body: page } = await raw(token, 'GET', 'shared' + (next ? '?after=' + encodeURIComponent(next) : ''));
      answer.body.marks.push(...page.marks);
      answer.body.categories.push(...page.categories.filter(row => !answer.body.categories.some(item => item.id === row.id)));
      next = page.next;
    }
    return answer;
  };
  return { session, request, sessions, db };
}

const names = request => async token => (await request(token)).body.marks.map(mark => mark.name).sort();

test('batch status reads only the signed owner’s reserved IDs, including permanent deletions', async t => {
  const { session, request } = await openApi(t);
  const owner = session('client', 'owner'), staff = session('ops', 'owner');
  const live = point({ visibility: 'staff' }), deleted = point(), missing = point();
  for (const mark of [live, deleted]) assert.equal((await request(owner, 'POST', '', mark)).status, 201);
  assert.equal((await request(owner, 'DELETE', deleted.id, { revision: 1, permanent: true })).status, 204);
  const payload = { ids: [live.id, deleted.id, missing.id] };
  const status = await request(owner, 'POST', 'batch/status', payload);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Set(status.body.reservedIds), new Set([live.id, deleted.id]));
  assert.deepEqual((await request(staff, 'POST', 'batch/status', payload)).body, { reservedIds: [] });
  assert.equal((await request('expired', 'POST', 'batch/status', payload)).status, 403);
  assert.equal((await request(owner, 'POST', 'batch/status', { ids: ['bad'] })).status, 400);
});

test('batch import rejects a deleted category reference with status 400 and writes no marks', async t => {
  const { session, request } = await openApi(t);
  const owner = session('client', 'owner');
  const category = { id: randomUUID(), name: 'Gate', color: '#3366ff', icon: 'gate' };
  assert.equal((await request(owner, 'POST', 'categories', category)).status, 201);
  assert.equal((await request(owner, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 204);

  const withDeletedCategory = point({ categoryId: category.id });
  const other = point();
  const result = await request(owner, 'POST', 'batch', { marks: [other, withDeletedCategory] });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'mark_category_not_found');
  assert.deepEqual((await request(owner, 'POST', 'batch/status', { ids: [other.id, withDeletedCategory.id] })).body,
    { reservedIds: [] }, 'the whole batch was refused');
});

test('marks nobody shared stay with their owner, whatever else is asked for or already stored', async t => {
  const { session, request, db } = await openApi(t);
  const people = {
    staff: session('ops', 'staff-person'), otherStaff: session('ops', 'staff-two'),
    client: session('client', 'client-a'), colleague: session('client', 'client-a2'),
    otherClient: session('client', 'client-b', ACCOUNT_B), association: session('client', 'client-c', SHARED_ASSOCIATION),
    // Same subject text as the client, but staff: the audience is part of the owner.
    sameName: session('ops', 'client-a'),
  };
  const made = {}, categories = {};
  for (const [who, token] of Object.entries(people)) {
    const client = !['staff', 'otherStaff', 'sameName'].includes(who);
    const omitted = await request(token, 'POST', '', point({ name: who, ...(!client && { visibility: 'private' }) }));
    assert.equal(omitted.status, 201, who);
    assert.equal(omitted.body.mark.visibility, 'private', who);
    made[who] = omitted.body.mark;
    categories[who] = { id: randomUUID(), name: 'Category', color: '#3366ff', icon: 'flag' };
    assert.equal((await request(token, 'POST', 'categories', categories[who])).status, 201, who);
    assert.deepEqual((await request(token)).body.capabilities.visibility, client ? ['private', 'staff'] : ['shared', 'private'], who);
    for (const visibility of client ? ['internal', 'client'] : ['staff', 'internal', 'client']) {
      assert.equal((await request(token, 'POST', '', point({ visibility }))).status, 403, `${who} ${visibility}`);
      assert.equal((await request(token, 'PUT', made[who].id, { ...point(), id: made[who].id, revision: 1, visibility })).status, 403, `${who} ${visibility}`);
      assert.equal((await request(token, 'POST', 'batch', { marks: [point(), point({ visibility })] })).status, 403, `${who} ${visibility}`);
    }
    assert.equal((await request(token, 'POST', '', point({ shareAccount: 'direct_client_grant:grant-a' }))).status, 400, who);
    assert.equal((await request(token, 'GET', 'audiences')).status, 403, who);
  }
  // Rows written by an older or different build are not shared either.
  const insert = db.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, share_account, document_json,
    creation_hash, revision, created_at, updated_at, updated_by_audience, updated_by_subject)
    VALUES (?, ?, ?, 'absent-person', ?, ?, ?, 'x', 1, ?, ?, ?, 'absent-person')`);
  const stored = [['client', 'private', null], ['ops', 'private', null], ['ops', 'internal', null], ['ops', 'client', 'direct_client_grant:grant-a']].map(([audience, visibility, account]) => {
    const id = randomUUID(), now = new Date().toISOString();
    insert.run(id, modelId, audience, visibility, account, JSON.stringify({ ...point({ name: 'Stored' }), id, categoryId: categories.otherStaff.id }), now, now, audience);
    return id;
  });
  for (const [who, token] of Object.entries(people)) {
    const body = (await request(token)).body;
    assert.deepEqual(body.marks.map(mark => mark.id), [made[who].id], who);
    assert.deepEqual(body.categories.map(category => category.id), [categories[who].id], who);
    for (const id of [...stored, ...Object.entries(made).filter(([other]) => other !== who).map(([, mark]) => mark.id)]) {
      assert.equal((await request(token, 'GET', id)).status, 404, who);
      assert.equal((await request(token, 'PUT', id, { ...point(), id, revision: 1 })).status, 404, who);
      assert.equal((await request(token, 'DELETE', id, { revision: 1 })).status, 404, who);
    }
    for (const [other, category] of Object.entries(categories)) {
      if (other === who) continue;
      assert.equal((await request(token, 'PUT', 'categories/' + category.id, { ...category, revision: 1 })).status, 404, `${who} ${other}`);
      assert.equal((await request(token, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 404, `${who} ${other}`);
      assert.equal((await request(token, 'POST', '', point({ categoryId: category.id }))).status, 400, `${who} ${other}`);
    }
  }
  assert.equal(db.prepare('SELECT count(*) n FROM viewer_mark_accounts').get().n, 0, 'no client grant is recorded for a picker that is not served');
  assert.equal(db.prepare("SELECT count(*) n FROM viewer_marks WHERE deleted_at IS NOT NULL OR (revision<>1)").get().n, 0);
  // The owner still works normally.
  const renamed = await request(people.client, 'PUT', made.client.id, { ...point({ name: 'Renamed', categoryId: categories.client.id }), id: made.client.id, revision: 1 });
  assert.equal(renamed.status, 200);
  assert.equal((await request(people.client, 'DELETE', made.client.id, { revision: 2 })).status, 204);
});

test('without a verified individual identity a client reads nothing, even under a person\'s own subject', async t => {
  for (const options of [undefined, SHARING]) {
    const { session, request, db } = await openApi(t, options);
    const person = session('client', 'client-a');
    const mark = (await request(person, 'POST', '', point({ name: 'Mine' }))).body.mark;
    const category = { id: randomUUID(), name: 'Mine', color: '#3366ff', icon: 'flag' };
    assert.equal((await request(person, 'POST', 'categories', category)).status, 201);
    const accounts = db.prepare('SELECT * FROM viewer_mark_accounts').all();
    for (const permissions of [{ view: true, measure: true }, { view: true, measure: true, personalMeasurements: false },
      { view: true, measure: true, personalMeasurements: 'true' }]) {
      for (const subject of ['client-a', 'company-login']) {
        const transient = session('client', subject, { permissions });
        const list = await request(transient);
        assert.equal(list.status, 200);
        assert.deepEqual(list.body, { marks: [], categories: [], starters: [], capabilities: { write: false, staff: false, visibility: ['private'], ...(!options && { shared: true, access: [] }) } });
        assert.equal((await request(transient, 'GET', mark.id)).status, 403);
        assert.equal((await request(transient, 'HEAD')).status, 403);
        assert.equal((await request(transient, 'GET', 'audiences')).status, 403);
        assert.equal((await request(transient, 'POST', '', point())).status, 403);
        assert.equal((await request(transient, 'PUT', mark.id, { ...point(), id: mark.id, revision: 1 })).status, 403);
        assert.equal((await request(transient, 'DELETE', mark.id, { revision: 1 })).status, 403);
        assert.equal((await request(transient, 'PUT', 'categories/' + category.id, { ...category, revision: 1 })).status, 403);
        assert.equal((await request(transient, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 403);
        assert.equal((await request(transient, 'POST', 'batch', { marks: [point()] })).status, 403);
      }
    }
    assert.equal((await request(person, 'GET', mark.id)).body.mark.revision, 1);
    assert.deepEqual(db.prepare('SELECT * FROM viewer_mark_accounts').all(), accounts, 'a transient read records nothing');
  }
});

test('[held sharing] two clients on one model never read each other\'s marks', async t => {
  const { session, request } = await openApi(t, SHARING);
  const list = names(request);
  const staff = session('ops', 'staff-person');
  const clientA = session('client', 'client-a');
  const colleagueA = session('client', 'client-a2');
  const clientB = session('client', 'client-b', ACCOUNT_B);
  const otherModel = session('client', 'client-a', { modelId: 'other-model', modelVersionId: 'other-v1' });

  const mine = point({ name: 'A private', visibility: 'private' });
  const created = await request(clientA, 'POST', '', mine);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.body.mark.color, '#88aa22');
  assert.equal((await request(clientA, 'POST', '', mine)).status, 200, 'same create replays');
  const omitted = (await request(clientA, 'POST', '', point({ name: 'A default' }))).body.mark;
  assert.equal(omitted.visibility, 'private', 'a client mark defaults to Only me');
  assert.equal((await request(staff, 'GET', omitted.id)).status, 404, 'staff do not see it until the client shares it');
  const withStaff = (await request(clientA, 'POST', '', point({ name: 'A with staff', visibility: 'staff' }))).body.mark;
  assert.equal(withStaff.visibility, 'staff');
  const fromB = (await request(clientB, 'POST', '', point({ name: 'B with staff', visibility: 'staff' }))).body.mark;
  for (const visibility of ['internal', 'client', 'shared', 'everyone']) {
    assert.ok([400, 403].includes((await request(clientA, 'POST', '', point({ visibility }))).status), visibility);
  }

  assert.deepEqual(await list(clientA), ['A default', 'A private', 'A with staff']);
  assert.deepEqual(await list(clientB), ['B with staff']);
  assert.deepEqual(await list(colleagueA), [], 'not even a colleague on the same account');
  assert.deepEqual(await list(staff), ['A with staff', 'B with staff']);
  assert.deepEqual(await list(otherModel), []);
  for (const [token, id] of [[clientB, withStaff.id], [clientB, mine.id], [clientA, fromB.id], [colleagueA, withStaff.id], [staff, mine.id]]) {
    assert.equal((await request(token, 'GET', id)).status, 404);
    assert.equal((await request(token, 'DELETE', id, { revision: 1 })).status, 404);
  }
  const seenByStaff = (await request(staff, 'GET', withStaff.id)).body.mark;
  for (const key of ['owner', 'ownerAccount', 'updatedBy']) assert.equal(seenByStaff[key], undefined, 'no identity is sent');
});

test('[held sharing] staff share a mark with one named client account only', async t => {
  const { session, request } = await openApi(t, SHARING);
  const list = names(request);
  const staff = session('ops', 'staff-person');
  const clientA = session('client', 'client-a');
  const companyA = session('client', 'company-login-a', { permissions: { view: true, measure: true } });
  const clientB = session('client', 'client-b', ACCOUNT_B);
  const unaccounted = session('client', 'legacy-client', { sourceAuthorization: null });
  await request(clientA);
  await request(clientB);

  assert.equal((await request(clientA, 'GET', 'audiences')).status, 403);
  const audiences = (await request(staff, 'GET', 'audiences')).body.audiences.map(row => row.account).sort();
  assert.deepEqual(audiences, ['direct_client_grant:grant-a', 'direct_client_grant:grant-b']);

  const internal = (await request(staff, 'POST', '', point({ name: 'Staff only' }))).body.mark;
  assert.equal(internal.visibility, 'internal', 'staff marks default to staff only');
  assert.equal((await request(staff, 'POST', '', point({ visibility: 'client' }))).status, 400, 'a share needs a named account');
  assert.equal((await request(staff, 'POST', '', point({ visibility: 'client', shareAccount: 'direct_client_grant:never-seen' }))).status, 400);
  assert.equal((await request(staff, 'POST', '', point({ visibility: 'staff' }))).status, 403);
  const toA = (await request(staff, 'POST', '', point({ name: 'For A', visibility: 'client', shareAccount: 'direct_client_grant:grant-a' }))).body.mark;
  assert.equal(toA.shareAccount, 'direct_client_grant:grant-a');

  assert.deepEqual(await list(clientA), ['For A']);
  assert.deepEqual(await list(companyA), [], 'a company login has no person to read as');
  assert.deepEqual(await list(clientB), []);
  assert.deepEqual(await list(unaccounted), []);
  assert.equal((await request(clientB, 'GET', toA.id)).status, 404);
  assert.equal((await request(clientB, 'GET', internal.id)).status, 404);
  const seenByA = (await request(clientA, 'GET', toA.id)).body.mark;
  assert.equal(seenByA.editable, false);
  assert.equal(seenByA.shareAccount, undefined, 'clients do not see share targets');
  assert.equal((await request(clientA, 'PUT', toA.id, { ...point(), id: toA.id, revision: 1 })).status, 403);
  assert.equal((await request(companyA, 'POST', '', point())).status, 403, 'company logins stay read-only');
  assert.deepEqual((await request(companyA)).body.capabilities, { write: false, staff: false, visibility: ['private'] });

  // Moving the share to B takes it away from A.
  const moved = await request(staff, 'PUT', toA.id, { ...point({ name: 'For B' }), id: toA.id, revision: 1, visibility: 'client',
    shareAccount: 'direct_client_grant:grant-b' });
  assert.equal(moved.status, 200);
  assert.deepEqual(await list(clientA), []);
  assert.deepEqual(await list(clientB), ['For B']);
});

test('[held sharing] two accounts on one model under the SAME association id never see each other\'s shares', async t => {
  const { session, request } = await openApi(t, SHARING);
  const list = names(request);
  const staff = session('ops', 'staff-person');
  const accountOne = session('client', 'client:identity-one', SHARED_ASSOCIATION);
  const accountTwo = session('client', 'client:identity-two', SHARED_ASSOCIATION);
  const companyOne = session('client', 'client:company-one', { ...SHARED_ASSOCIATION, permissions: { view: true, measure: true } });

  const own = (await request(accountOne, 'POST', '', point({ name: 'One only me', visibility: 'private' }))).body.mark;
  const toStaff = (await request(accountOne, 'POST', '', point({ name: 'One with staff', visibility: 'staff' }))).body.mark;
  const categoryOne = { id: randomUUID(), name: 'One category', color: '#3366ff', icon: 'flag' };
  assert.equal((await request(accountOne, 'POST', 'categories', categoryOne)).status, 201);
  await request(accountTwo);
  await request(companyOne);

  // No recipient key exists for association sessions: nothing to pick, nothing to share to.
  assert.deepEqual((await request(staff, 'GET', 'audiences')).body.audiences, []);
  for (const shareAccount of ['model_association:project-model-association', 'direct_client_grant:never-seen']) {
    assert.equal((await request(staff, 'POST', '', point({ visibility: 'client', shareAccount }))).status, 400, shareAccount);
  }
  const staffCategory = { id: randomUUID(), name: 'Staff category', color: '#43a047', icon: 'gate' };
  await request(staff, 'POST', 'categories', staffCategory);
  await request(staff, 'POST', '', point({ name: 'Internal', categoryId: staffCategory.id }));

  assert.deepEqual(await list(accountOne), ['One only me', 'One with staff']);
  assert.deepEqual(await list(accountTwo), []);
  assert.deepEqual(await list(companyOne), []);
  assert.deepEqual(await list(staff), ['Internal', 'One with staff']);
  for (const id of [own.id, toStaff.id]) assert.equal((await request(accountTwo, 'GET', id)).status, 404);
  assert.deepEqual((await request(accountTwo)).body.categories, []);
  assert.deepEqual((await request(accountOne)).body.categories.map(row => row.name), ['One category']);
  assert.equal((await request(accountTwo, 'PUT', 'categories/' + categoryOne.id, { ...categoryOne, revision: 1 })).status, 404);
  assert.equal((await request(staff, 'GET', toStaff.id)).body.mark.editable, false);
});

test('[held sharing] staff read each other\'s staff-wide marks and change only their own', async t => {
  const { session, request } = await openApi(t, SHARING);
  const staff = session('ops', 'staff-person'), otherStaff = session('ops', 'staff-two');
  const mark = (await request(staff, 'POST', '', point())).body.mark;
  assert.equal(mark.visibility, 'internal');
  assert.equal((await request(otherStaff, 'GET', mark.id)).body.mark.editable, false);
  assert.equal((await request(otherStaff, 'PUT', mark.id, { ...point(), id: mark.id, revision: 1 })).status, 403);
  assert.equal((await request(otherStaff, 'DELETE', mark.id, { revision: 1 })).status, 403);
});

const bodyOf = (mark, changes) => ({ id: mark.id, geometry: mark.geometry, name: mark.name, color: mark.color, icon: mark.icon,
  note: mark.note, categoryId: mark.categoryId, elevationNavd88M: mark.elevationNavd88M, revision: mark.revision, ...changes });

test('a client mark shared with project staff is view-only to staff and unseen by every other client', async t => {
  const { session, request, db } = await openApi(t);
  const list = names(request);
  const client = session('client', 'client-a');
  const staff = [session('ops', 'staff-person'), session('ops', 'staff-two'), session('ops', 'client-a')];
  const others = [session('client', 'client-a2'), session('client', 'client-b', ACCOUNT_B), session('client', 'client-a', { modelId: 'other-model', modelVersionId: 'other-v1' }),
    session('client', 'client-c', SHARED_ASSOCIATION), session('ops', 'staff-person', { modelId: 'other-model', modelVersionId: 'other-v1' })];
  const used = { id: randomUUID(), name: 'Stands', color: '#3366ff', icon: 'ladder' };
  const unused = { id: randomUUID(), name: 'Private list', color: '#e53935', icon: 'flag' };
  for (const category of [used, unused]) assert.equal((await request(client, 'POST', 'categories', category)).status, 201);
  const hidden = (await request(client, 'POST', '', point({ name: 'Only me', categoryId: unused.id }))).body.mark;
  const shared = (await request(client, 'POST', '', point({ name: 'With staff', visibility: 'staff', categoryId: used.id, note: 'North side' }))).body.mark;

  for (const token of staff) {
    assert.deepEqual(await list(token), ['With staff']);
    const { marks: [seen], categories } = (await request(token)).body;
    assert.deepEqual([seen.mine, seen.editable, seen.author, seen.note, seen.categoryId], [false, false, 'client', 'North side', used.id]);
    for (const key of ['owner', 'ownerAccount', 'updatedBy', 'shareAccount']) assert.ok(!(key in seen), key + ' is not sent');
    assert.deepEqual(categories.map(row => [row.id, row.mine, row.editable]), [[used.id, false, false]], 'only the category a shared mark uses');
    assert.equal((await request(token, 'GET', hidden.id)).status, 404);
    // Reading is all: every change is refused, and nothing is written.
    assert.equal((await request(token, 'PUT', shared.id, bodyOf(shared, { name: 'Changed' }))).status, 403);
    assert.equal((await request(token, 'PUT', shared.id, bodyOf(shared, { visibility: 'private' }))).status, 403);
    assert.equal((await request(token, 'DELETE', shared.id, { revision: 1 })).status, 403);
    assert.equal((await request(token, 'POST', shared.id + '/restore', { revision: 1 })).status, 404);
    assert.equal((await request(token, 'POST', '', bodyOf(shared, { revision: undefined }))).status, 409);
    assert.equal((await request(token, 'POST', '', point({ categoryId: used.id }))).status, 400, 'staff do not use a client category');
    assert.equal((await request(token, 'PUT', 'categories/' + used.id, { ...used, name: 'Changed', revision: 1 })).status, 404);
    assert.equal((await request(token, 'DELETE', 'categories/' + used.id, { revision: 1 })).status, 404);
    assert.equal((await request(token, 'PUT', 'categories/' + unused.id, { ...unused, revision: 1 })).status, 404);
    assert.equal((await request(token, 'DELETE', 'categories/' + unused.id, { revision: 1 })).status, 404);
  }
  for (const token of others) {
    assert.deepEqual((await request(token)).body.marks, []);
    assert.deepEqual((await request(token)).body.categories, []);
    assert.equal((await request(token, 'GET', shared.id)).status, 404);
    assert.equal((await request(token, 'PUT', shared.id, bodyOf(shared))).status, 404);
    assert.equal((await request(token, 'DELETE', shared.id, { revision: 1 })).status, 404);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM viewer_marks WHERE revision<>1 OR deleted_at IS NOT NULL').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM viewer_mark_accounts').get().n, 0);

  // The client's own edit reaches staff, and the client can take the mark back.
  const renamed = (await request(client, 'PUT', shared.id, bodyOf(shared, { name: 'Renamed', visibility: undefined }))).body.mark;
  assert.equal(renamed.visibility, 'staff', 'an edit that does not mention sharing keeps it');
  assert.deepEqual(await list(staff[0]), ['Renamed']);
  const taken = (await request(client, 'PUT', shared.id, bodyOf(renamed, { visibility: 'private' }))).body.mark;
  assert.equal(taken.visibility, 'private');
  for (const token of staff) {
    assert.deepEqual((await request(token)).body, { ...(await request(token)).body, marks: [], categories: [] });
    assert.equal((await request(token, 'GET', shared.id)).status, 404);
  }
});

test('two clients on one whole-project share: no shared reads, and a revoked grant or identity ends access', async t => {
  const { session, request, sessions } = await openApi(t);
  const list = names(request);
  const tokens = { one: session('client', 'client:identity-one', SHARED_ASSOCIATION), two: session('client', 'client:identity-two', SHARED_ASSOCIATION) };
  const staff = session('ops', 'staff-person');
  for (const [name, token] of Object.entries(tokens)) {
    await request(token, 'POST', '', point({ name: name + ' only me' }));
    await request(token, 'POST', '', point({ name: name + ' with staff', visibility: 'staff' }));
    await request(token, 'POST', 'categories', { id: randomUUID(), name, color: '#3366ff', icon: 'flag' });
  }
  assert.deepEqual(await list(tokens.one), ['one only me', 'one with staff']);
  assert.deepEqual(await list(tokens.two), ['two only me', 'two with staff']);
  assert.deepEqual(await list(staff), ['one with staff', 'two with staff']);
  assert.deepEqual((await request(tokens.one)).body.categories.map(row => row.name), ['one']);

  const record = sessions.get(auth.hashToken(tokens.one));
  record.permissions = { view: true, measure: true };
  assert.deepEqual((await request(tokens.one)).body.marks, [], 'personalMeasurements revoked: nothing is read');
  assert.equal((await request(tokens.one, 'GET', 'deleted')).status, 403);
  assert.equal((await request(tokens.one, 'POST', '', point())).status, 403);
  record.permissions = { view: true, measure: true, personalMeasurements: true };
  record.revoked = true;
  for (const route of ['', 'deleted']) assert.equal((await request(tokens.one, 'GET', route)).status, 403, 'grant revoked');
  assert.deepEqual(await list(tokens.two), ['two only me', 'two with staff'], 'the other client is unaffected');
  assert.deepEqual(await list(staff), ['one with staff', 'two with staff'], 'what was shared with staff stays with staff');
});

test('a deleted mark can be restored by its owner for 30 days', async t => {
  const { session, request, db } = await openApi(t);
  const client = session('client', 'client-a'), staff = session('ops', 'staff-person');
  const others = [staff, session('client', 'client-a2'), session('client', 'client-b', ACCOUNT_B), session('ops', 'client-a'),
    session('client', 'client-a', { modelId: 'other-model', modelVersionId: 'other-v1' })];
  assert.equal((await request(client)).body.capabilities.recoveryDays, 30);
  const category = { id: randomUUID(), name: 'Stands', color: '#3366ff', icon: 'ladder' };
  await request(client, 'POST', 'categories', category);
  const mark = (await request(client, 'POST', '', point({ name: 'Kept', visibility: 'staff', note: 'Note', categoryId: category.id, elevationNavd88M: 250 }))).body.mark;
  assert.equal((await request(client, 'DELETE', mark.id, { revision: 1 })).status, 204);
  assert.deepEqual((await request(client)).body.marks, []);
  assert.deepEqual((await request(staff)).body.marks, [], 'staff lose it at once');
  assert.deepEqual((await request(staff)).body.categories, []);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const payload = method === 'GET' ? undefined : method === 'PUT' ? bodyOf(mark) : { revision: 1 };
    assert.equal((await request(client, method, mark.id, payload)).status, 404, 'a deleted mark is only restored, never edited');
  }
  const [listed] = (await request(client, 'GET', 'deleted')).body.marks;
  assert.deepEqual([listed.id, listed.name, listed.note, listed.revision, listed.visibility], [mark.id, 'Kept', 'Note', 1, 'staff']);
  assert.ok(Date.parse(listed.deletedAt));
  for (const token of others) {
    assert.deepEqual((await request(token, 'GET', 'deleted')).body.marks, []);
    assert.equal((await request(token, 'POST', mark.id + '/restore', { revision: 1 })).status, 404);
  }
  assert.equal((await request(client, 'POST', mark.id + '/restore', { revision: 2 })).status, 409);
  assert.equal((await request(client, 'POST', mark.id + '/restore', {})).status, 428);
  assert.equal((await request(client, 'POST', mark.id + '/restore', { revision: 1, visibility: 'private' })).status, 400);
  const restored = (await request(client, 'POST', mark.id + '/restore', { revision: 1 })).body.mark;
  const { updatedAt, ...kept } = restored;
  assert.deepEqual(kept, { ...Object.fromEntries(Object.entries(mark).filter(([key]) => key !== 'updatedAt')), revision: 2 }, 'it comes back exactly, one revision on');
  assert.deepEqual((await request(client, 'GET', 'deleted')).body.marks, []);
  assert.deepEqual((await request(staff)).body.marks.map(row => row.name), ['Kept']);
  assert.equal((await request(client, 'POST', mark.id + '/restore', { revision: 2 })).status, 404, 'not deleted any more');

  // 30 days to the millisecond, then the content is gone and the id stays used.
  const repository = new marksRepository.ViewerMarkRepository(db);
  const person = { modelId, modelVersionId: 'synthetic-v1', audience: 'client', subject: 'client-a', session: {}, personalPersistence: true };
  const deletedAt = Date.parse('2026-11-01T00:00:00.000Z'), limit = deletedAt + 30 * 86_400_000;
  db.prepare('UPDATE viewer_marks SET deleted_at=? WHERE id=?').run(new Date(deletedAt).toISOString(), mark.id);
  assert.equal(repository.deleted(person, limit).length, 1);
  assert.equal(repository.purgeDeleted(limit), 0);
  assert.equal(repository.deleted(person, limit + 1).length, 0);
  assert.throws(() => repository.restore(person, mark.id, 2, limit + 1), { code: 'mark_not_found' });
  assert.equal(repository.restore(person, mark.id, 2, limit).name, 'Kept');
  db.prepare('UPDATE viewer_marks SET deleted_at=? WHERE id=?').run(new Date(deletedAt).toISOString(), mark.id);
  const live = (await request(client, 'POST', '', point({ name: 'Live' }))).body.mark;
  assert.equal(repository.purgeDeleted(limit + 1), 1);
  assert.equal(repository.purgeDeleted(limit + 1), 0);
  assert.equal(db.prepare('SELECT document_json d FROM viewer_marks WHERE id=?').get(mark.id).d, '{}');
  assert.throws(() => repository.restore(person, mark.id, 3, limit), { code: 'mark_not_found' }, 'purged content never comes back empty');
  assert.equal(repository.get(person, live.id).name, 'Live', 'live marks are never purged');
  assert.equal((await request(client, 'POST', '', point({ id: mark.id }))).status, 409, 'deleted ids stay used');
});

test('deleted marks are bounded, and restoring respects the mark limits and a removed category', async t => {
  const { session, request, db } = await openApi(t);
  const client = session('client', 'client-a');
  const category = { id: randomUUID(), name: 'Gone', color: '#3366ff', icon: 'flag' };
  await request(client, 'POST', 'categories', category);
  const mark = (await request(client, 'POST', '', point({ name: 'Mine', categoryId: category.id }))).body.mark;
  const insert = db.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision,
    created_at, updated_at, updated_by_audience, updated_by_subject, deleted_at) VALUES (?, ?, 'client', ?, 'private', ?, 'x', 1, ?, ?, 'client', ?, ?)`);
  const fill = (subject, count, deletedAt) => {
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID(), at = '2026-01-01T00:00:00.000Z';
      insert.run(id, modelId, subject, JSON.stringify({ ...point(), id }), at, at, subject, deletedAt && new Date(Date.now() - 1000 - i).toISOString());
    }
  };
  fill('client-a', marksRepository.LIMITS.deleted - 1, true);
  fill('client-b', 5, true);
  assert.equal((await request(client, 'DELETE', mark.id, { revision: 1 })).status, 204);
  const kept = subject => db.prepare("SELECT count(*) n FROM viewer_marks WHERE owner_subject=? AND deleted_at IS NOT NULL AND document_json<>'{}'").get(subject).n;
  assert.equal(kept('client-a'), marksRepository.LIMITS.deleted, 'full, and nothing older went');
  const extra = (await request(client, 'POST', '', point({ name: 'Extra' }))).body.mark;
  const refused = await request(client, 'DELETE', extra.id, { revision: 1 });
  assert.deepEqual([refused.status, refused.body.code], [409, 'mark_deleted_full']);
  assert.equal((await request(client, 'DELETE', extra.id, { revision: 1, permanent: 'yes' })).status, 400);
  assert.equal((await request(client, 'DELETE', extra.id, { revision: 1, permanent: true })).status, 204);
  assert.equal((await request(client, 'POST', extra.id + '/restore', { revision: 1 })).status, 404, 'for good');
  assert.equal(kept('client-a'), marksRepository.LIMITS.deleted);
  assert.equal(kept('client-b'), 5, 'nobody else\'s');
  assert.equal((await request(client, 'GET', 'deleted')).body.marks[0].id, mark.id);
  assert.equal((await request(client, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 204);
  fill('client-a', marksRepository.LIMITS.perOwner, null);
  assert.equal((await request(client, 'POST', mark.id + '/restore', { revision: 1 })).status, 429);
  db.prepare("DELETE FROM viewer_marks WHERE owner_subject='client-a' AND deleted_at IS NULL").run();
  const restored = (await request(client, 'POST', mark.id + '/restore', { revision: 1 })).body.mark;
  assert.deepEqual([restored.name, restored.categoryId, restored.color], ['Mine', null, '#88aa22']);
});

test('lines, areas and typed values are validated', async t => {
  const { session, request } = await openApi(t);
  const client = session('client', 'client-a');
  const line = await request(client, 'POST', '', point({ geometry: { type: 'LineString', coordinates: [[-87, 43], [-87.001, 43.001, 250]] } }));
  assert.equal(line.status, 201);
  assert.deepEqual(line.body.mark.geometry.coordinates[1], [-87.001, 43.001], 'third GeoJSON value is not kept as a height');
  const area = await request(client, 'POST', '', point({ geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-87.001, 43], [-87.001, 43.001]]] } }));
  assert.equal(area.status, 201);
  assert.equal(area.body.mark.geometry.coordinates[0].length, 4, 'area rings are closed');
  for (const change of [
    { geometry: { type: 'Point', coordinates: [-181, 43] } }, { geometry: { type: 'Point', coordinates: [-87, 91] } },
    { geometry: { type: 'Point', coordinates: ['-87', 43] } }, { geometry: { type: 'LineString', coordinates: [[-87, 43]] } },
    { geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-87.1, 43]]] } }, { geometry: { type: 'Circle', coordinates: [0, 0] } },
    { name: ' ' }, { name: 'a\u0007b' }, { color: 'orange' }, { note: 'a'.repeat(2001) }, { icon: '../x' },
    { elevationNavd88M: 'high' }, { elevationNavd88M: 99999 }, { visibility: 'everyone' }, { shareAccount: 'not an account' },
    { ownerSubject: 'spoofed' }, { categoryId: randomUUID() },
  ]) {
    assert.equal((await request(client, 'POST', '', point(change))).status, 400, JSON.stringify(change));
  }
});

test('[held sharing] categories stay with their owner; clients see staff categories only on marks shared with them', async t => {
  const { session, request } = await openApi(t, SHARING);
  const staff = session('ops', 'staff-person');
  const clientA = session('client', 'client-a');
  const clientB = session('client', 'client-b', ACCOUNT_B);
  await request(clientA);
  const category = { id: randomUUID(), name: 'Survey point', color: '#3366ff', icon: 'flag' };
  assert.equal((await request(clientA, 'POST', 'categories', category)).status, 201);
  assert.equal((await request(clientA, 'POST', 'categories', { ...category, id: randomUUID(), name: 'survey POINT' })).status, 409);
  const categoryB = { ...category, id: randomUUID() };
  assert.equal((await request(clientB, 'POST', 'categories', categoryB)).status, 201, 'names are per owner, so nothing leaks');
  const mark = (await request(clientA, 'POST', '', point({ categoryId: category.id }))).body.mark;
  assert.equal(mark.categoryId, category.id);
  assert.equal((await request(clientB, 'POST', '', point({ categoryId: category.id }))).status, 400, 'no using another client\'s category');

  const categoryIds = async token => (await request(token)).body.categories.map(row => row.id).sort();
  assert.deepEqual(await categoryIds(clientB), [categoryB.id], 'only B\'s own category');
  assert.equal((await request(clientB, 'PUT', 'categories/' + category.id, { ...category, name: 'Mine', revision: 1 })).status, 404);
  assert.equal((await request(clientB, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 404);

  const staffCategory = { id: randomUUID(), name: 'Gate', color: '#43a047', icon: 'gate' };
  const unusedStaff = { id: randomUUID(), name: 'Internal review', color: '#e53935', icon: 'warning' };
  await request(staff, 'POST', 'categories', staffCategory);
  await request(staff, 'POST', 'categories', unusedStaff);
  assert.equal((await request(staff, 'POST', '', point({ categoryId: category.id }))).status, 400, 'staff use staff categories');
  assert.deepEqual(await categoryIds(clientA), [category.id]);
  await request(staff, 'POST', '', point({ categoryId: staffCategory.id, visibility: 'client', shareAccount: 'direct_client_grant:grant-a' }));
  assert.deepEqual(await categoryIds(clientA), [category.id, staffCategory.id].sort(), 'a shared mark brings its category name');
  assert.deepEqual(await categoryIds(clientB), [categoryB.id]);
  assert.equal((await request(clientA)).body.categories.find(row => row.id === staffCategory.id).editable, false);
  assert.deepEqual((await request(staff)).body.categories.map(row => row.name).sort(), ['Gate', 'Internal review'], 'no client category, as no client mark is shared');

  assert.equal((await request(staff, 'PUT', 'categories/' + category.id, { ...category, name: 'Gate post', revision: 1 })).status, 404);
  assert.equal((await request(clientA, 'PUT', 'categories/' + category.id, { ...category, name: 'Gate post', revision: 1 })).status, 200);
  assert.equal((await request(clientA, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 409);
  assert.equal((await request(clientA, 'DELETE', 'categories/' + category.id, { revision: 2 })).status, 204);
  const after = (await request(clientA)).body;
  assert.equal(after.marks.find(row => row.id === mark.id).categoryId, null);
  assert.equal(after.marks.find(row => row.id === mark.id).color, '#88aa22');
  assert.equal((await request(clientA, 'POST', 'categories', { ...category, id: randomUUID() })).status, 201, 'a deleted name can be reused');
});

test('GeoJSON import lands as one batch or not at all', async t => {
  const { session, request } = await openApi(t);
  const client = session('client', 'client-a');
  const good = [point({ name: 'One' }), point({ name: 'Two', visibility: 'private' })];
  const saved = await request(client, 'POST', 'batch', { marks: good });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.marks.length, 2);
  const failed = await request(client, 'POST', 'batch', { marks: [point({ name: 'Three' }), point({ color: 'bad' })] });
  assert.equal(failed.status, 400);
  assert.deepEqual((await request(client)).body.marks.map(mark => mark.name).sort(), ['One', 'Two']);
  assert.equal((await request(client, 'POST', 'batch', { marks: [] })).status, 400);
});

test('revoked, public and unverifiable sessions cannot read or write Marks', async t => {
  const { session, request, sessions } = await openApi(t);
  const revoked = session('client', 'client-a');
  sessions.get(auth.hashToken(revoked)).revoked = true;
  for (const token of [revoked, session('public', 'recipient'), session('client', 'no-measure', { permissions: { view: true } }),
    session('client', 'stale', { modelVersionId: 'synthetic-v2' }), 'not-a-real-token-value']) {
    assert.equal((await request(token)).status, 403);
    assert.equal((await request(token, 'POST', '', point())).status, 403);
    assert.equal((await request(token, 'GET', 'audiences')).status, 403);
  }
});

test('schema 84 migrates in the ledger and a stamped database without the tables is refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-marks-84-'));
  const filename = path.join(dir, 'viewer.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = database.openDatabase(filename);
  try {
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=84').get().name, 'viewer_coordinate_marks');
    assert.equal(schema.verifyViewerMarksSchema(db), true);
    db.exec('DROP TABLE viewer_mark_accounts');
  } finally { db.close(); }
  assert.throws(() => database.openDatabase(filename), { code: 'viewer_migration_history_conflict' });
});

test('WGS84 mark placement shares map position and verifies the projected horizontal frame', () => {
  const mark = { latitude: 43.05, longitude: -87 };
  const wgs = { epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' };
  const position = projectViewerMark(mark, wgs);
  assert.equal(position.utm.easting, 500000);
  assert.ok(position.utm.northing > 4_700_000);
  assert.deepEqual(projectViewerMark(mark, { ...wgs, epsg: 26916 }), { ...mark, utm: null });
});
