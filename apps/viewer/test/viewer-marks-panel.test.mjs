import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { openMarksPanel } from './helpers/marks-panel.mjs';

const collection = name => JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
  geometry: { type: 'Point', coordinates: [-87, 43] }, properties: { name, category: name + ' category', 'marker-color': '#1e88e5' } }] });
function slowFile(text) {
  let release, fail;
  const reading = new Promise((resolve, reject) => { release = () => resolve(text); fail = () => reject(new Error('read failed')); });
  return { file: { size: text.length, text: () => reading }, release, fail };
}
const importInput = panel => panel.panel.querySelectorAll('input').find(node => node.getAttribute('type') === 'file');

test('a file chosen in the panel imports into the scope it was chosen in', async t => {
  const { mount, scope } = await openMarksPanel(t);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  const { file, release } = slowFile(collection('Imported'));
  importInput(panel).files = [file];
  const done = importInput(panel).fire('change');
  release();
  await done;
  assert.deepEqual(panel.store.state.marks.map(mark => mark.name), ['Imported']);
  assert.match(panel.text(), /Imported 1 mark\./);
});

for (const [replacement, next] of [['another person', scope => scope('client', 'client-b')], ['a public link', () => ({ mode: 'temporary', key: 'public' })],
  ['no access', () => null]]) {
  test(`a file still being read when the scope becomes ${replacement} is dropped`, async t => {
    const { mount, scope, requests, database } = await openMarksPanel(t);
    const panel = mount();
    await panel.marks.setScope(scope('client', 'client-a'));
    for (const settle of ['release', 'fail']) {
      const slow = slowFile(collection('Late'));
      importInput(panel).files = [slow.file];
      const done = importInput(panel).fire('change');
      await panel.marks.setScope(next(scope));
      const message = panel.store.state.message;
      requests.length = 0;
      slow[settle]();
      await done;
      assert.deepEqual(requests, []);
      assert.deepEqual([panel.store.state.marks, panel.store.state.categories, panel.store.state.undo], [[], [], []]);
      assert.equal(panel.store.state.message, message);
      assert.doesNotMatch(panel.text(), /Late/);
      await panel.marks.setScope(scope('client', 'client-a'));
    }
    assert.equal(database.prepare('SELECT count(*) n FROM viewer_marks').get().n, 0);
  });
}

test('nothing one person typed or picked stays in the panel for the next', async t => {
  const { mount, scope } = await openMarksPanel(t);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  await panel.store.saveCategory({ name: 'First person category', color: '#1e88e5', icon: 'target' });
  await panel.q('[aria-label="Edit First person category"]').click();
  assert.equal(panel.q('[name=categoryName]').value, 'First person category');
  await panel.place('43.05, -87');
  await panel.type('[name=name]', 'First person label');
  await panel.type('[name=note]', 'First person note');
  await panel.type('[name=elevation]', '812');
  await panel.type('[name=coordinates]', '43.06, -87.01');
  await panel.marks.setScope(scope('client', 'client-b'));
  assert.doesNotMatch(panel.text() + panel.values(), /First person|812|43\.05|43\.06/);
  assert.equal(panel.q('.viewer-mark-form').hidden, true);
  assert.equal(panel.q('.viewer-mark-category-form button').textContent, 'Add', 'the category form is not editing the old category');
});

// The page's own decision about whose marks are shown, against the real panel and API.
const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const syncSource = source.slice(source.indexOf('function syncViewerMarks()'), source.indexOf('function syncViewerMarksView()'));
const REDUCED = [{ view: true, measure: true }, { view: true, measure: true, personalMeasurements: false }, { view: true, measure: true, personalMeasurements: 'true' }];
const FULL = { view: true, measure: true, personalMeasurements: true };

function sessionPage(panel, scope) {
  const scopes = [];
  const context = vm.createContext({
    viewerMarks: { setScope(next, options) {
      const done = panel.marks.setScope(next, options);
      scopes.push({ next, done, state: structuredClone(panel.store.state) });
      return done;
    } },
    PROJECT: { id: 'synthetic-model', activeVersion: { id: 'synthetic-v1' } }, SHARE_PERMISSIONS: FULL, VIEW_MODE: 'session',
    sessionAccessState: 'active', sessionAccessReason: null, activeViewerSession: null, sessionStorageKey: 'key', sessionCapabilities: { read: () => null }, Date, JSON,
  });
  vm.runInContext(syncSource, context);
  const sync = async change => { Object.assign(context, change); context.syncViewerMarks(); await scopes.at(-1).done; };
  return {
    scopes, sync,
    // A renewal or recovery the page accepts: same person and model, other permissions and token.
    accept(audience, subject, permissions) {
      const { token } = scope(audience, subject, { permissions });
      return sync({ SHARE_PERMISSIONS: permissions, sessionCapabilities: { read: token },
        activeViewerSession: { audience, subject, permissions, expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    },
  };
}

for (const permissions of REDUCED) {
  test(`losing the individual identity on the same person and model clears everything first (${JSON.stringify(permissions.personalMeasurements)})`, async t => {
    const { mount, scope, requests, database } = await openMarksPanel(t);
    let hold = null;
    const panel = mount({ request: async (path, init) => {
      if (hold && init.method === 'POST') await hold.promise;
      return fetch(path, { ...init, signal: undefined });
    } });
    const page = sessionPage(panel, scope);
    await page.accept('client', 'client-a', FULL);
    await panel.store.saveCategory({ name: 'Private category', color: '#1e88e5', icon: 'target' });
    await panel.place('43.05, -87');
    await panel.type('[name=name]', 'Private pin');
    await panel.save();
    assert.equal(panel.store.state.undo.length, 1);
    await panel.open('Private pin');
    await panel.type('[name=note]', 'Private note');
    // A save and a file are on their way when the identity goes.
    hold = Promise.withResolvers();
    const saving = panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Private late', color: '#1e88e5', icon: 'pin', note: '' });
    const slow = slowFile(collection('Private import'));
    importInput(panel).files = [slow.file];
    const importing = importInput(panel).fire('change');
    requests.length = 0;
    await page.accept('client', 'client-a', permissions);
    const at = page.scopes.at(-1);
    assert.deepEqual([at.state.marks, at.state.categories, at.state.undo, at.state.ready, at.state.busy], [[], [], [], false, false], 'cleared before the new load answers');
    assert.deepEqual(requests, [['GET', '/api/v1/marks']]);
    slow.release();
    hold.resolve();
    assert.equal(await saving, null);
    await importing;
    assert.deepEqual([panel.store.state.marks, panel.store.state.categories, panel.store.state.undo], [[], [], []]);
    assert.doesNotMatch(panel.text() + panel.values(), /Private/);
    assert.equal(panel.store.canWrite(), false);
    assert.equal(panel.q('.viewer-mark-form').hidden, true);
    assert.equal(panel.q('.viewer-mark-tools').hidden, true);
    assert.equal(database.prepare("SELECT count(*) n FROM viewer_marks WHERE document_json LIKE '%import%'").get().n, 0, 'the import was never sent');

    // Recovery with the identity back: their own marks return, from a new load. The
    // save that was already on its way had been theirs and did land.
    requests.length = 0;
    await page.accept('client', 'client-a', FULL);
    assert.deepEqual(panel.store.state.marks.map(mark => mark.name).sort(), ['Private late', 'Private pin']);
    assert.deepEqual(panel.store.state.undo, [], 'undo does not come back');
    assert.equal(panel.store.canWrite(), true);
    assert.deepEqual(requests, [['GET', '/api/v1/marks']]);
  });
}

test('an ordinary renewal keeps marks, undo and typing; staff do not depend on the client permission', async t => {
  const { mount, scope, requests } = await openMarksPanel(t);
  for (const [audience, first, second] of [['client', FULL, { ...FULL }], ['ops', REDUCED[0], FULL], ['ops', FULL, REDUCED[0]]]) {
    const panel = mount(), page = sessionPage(panel, scope);
    await page.accept(audience, 'same-person', first);
    await panel.place('43.05, -87');
    await panel.save();
    await panel.open('Pin');
    await panel.type('[name=name]', 'Typing');
    requests.length = 0;
    await page.accept(audience, 'same-person', second);
    assert.deepEqual(requests, []);
    assert.equal(panel.q('[name=name]').value, 'Typing');
    assert.equal(panel.store.state.undo.length, 1);
    await panel.store.remove(panel.store.state.marks[0]);
    assert.equal(requests.at(-1)[0], 'DELETE');
    assert.deepEqual(panel.store.state.marks, [], 'and the renewed session works');
  }
});

test('expired or refused access clears the panel, and coming back with less identity brings nothing back', async t => {
  const { mount, scope } = await openMarksPanel(t);
  const panel = mount(), page = sessionPage(panel, scope);
  await page.accept('client', 'client-a', FULL);
  await panel.place('43.05, -87');
  await panel.save();
  const lost = { sessionAccessState: 'unavailable', sessionAccessReason: 'session-expired' }, active = { sessionAccessState: 'active', sessionAccessReason: null };
  await page.sync(lost);
  assert.equal(page.scopes.at(-1).next, null);
  assert.deepEqual(panel.store.state.marks, []);
  await page.sync(active);
  assert.equal(panel.store.state.marks.length, 1);
  await page.sync(lost);
  await page.accept('client', 'client-a', REDUCED[0]);
  await page.sync(active);
  assert.deepEqual([panel.store.state.marks, panel.store.state.undo, panel.store.canWrite()], [[], [], false]);
});
