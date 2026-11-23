import assert from 'node:assert/strict';
import test from 'node:test';
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
