import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_CATEGORY, createMarkVisibility } from '../viewer-mark-visibility.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';

const KEY = 'ltds.viewer.marks.hidden';

test('hidden categories are remembered per person and project, without the identity', () => {
  const storage = memoryStorage();
  const open = key => { const visibility = createMarkVisibility({ storage: () => storage }); visibility.setScope(key); return visibility; };
  open('["client","client:someone@example.invalid","model-1"]').hideAll(['a', 'b', NO_CATEGORY]);
  assert.deepEqual(['a', 'b', 'c', NO_CATEGORY].map(open('["client","client:someone@example.invalid","model-1"]').isHidden), [true, true, false, true]);
  for (const key of ['["client","client:someone@example.invalid","model-2"]', '["client","client:other","model-1"]', '["ops","client:someone@example.invalid","model-1"]', null]) {
    assert.equal(open(key).isHidden('a'), false, key);
  }
  assert.doesNotMatch(storage.getItem(KEY), /someone|model/);
  open('["client","client:other","model-1"]').toggle('z');
  assert.equal(open('["client","client:someone@example.invalid","model-1"]').isHidden('a'), true, 'one person\'s choice leaves the other\'s');
  open('["client","client:someone@example.invalid","model-1"]').showAll();
  assert.equal(JSON.parse(storage.getItem(KEY)).length, 1, 'nothing hidden, nothing stored');
});

test('storage is bounded, and blocked or broken storage only forgets', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 80; i += 1) { const visibility = createMarkVisibility({ storage: () => storage }); visibility.setScope('scope ' + i); visibility.toggle('a'); }
  assert.equal(JSON.parse(storage.getItem(KEY)).length, 50);
  const recent = createMarkVisibility({ storage: () => storage });
  recent.setScope('scope 79');
  assert.equal(recent.isHidden('a'), true);
  recent.setScope('scope 0');
  assert.equal(recent.isHidden('a'), false, 'the oldest gave way');
  recent.hideAll(Array.from({ length: 400 }, (_, i) => 'id' + i));
  assert.equal(JSON.parse(storage.getItem(KEY))[0][1].length, 250);
  for (const broken of ['', '{', '7', '{"a":1}', '[1,[2],["x",3]]']) {
    storage.setItem(KEY, broken);
    const visibility = createMarkVisibility({ storage: () => storage });
    visibility.setScope('scope');
    assert.equal(visibility.isHidden('a'), false);
    visibility.toggle('a');
    assert.equal(visibility.isHidden('a'), true);
  }
  const blocked = createMarkVisibility({ storage: () => { throw new Error('denied'); } });
  blocked.setScope('scope');
  blocked.toggle('a');
  assert.equal(blocked.isHidden('a'), true, 'works for this page');
});

const names = panel => panel.panel.querySelectorAll('.viewer-mark-list-item').filter(node => !node.getAttribute('data-only')).map(node => node.textContent);
const pins = panel => panel.leaflet.pins().map(layer => layer.options.title).filter(Boolean).sort();
const eye = (panel, id) => panel.q(`[data-eye="${id}"]`);
async function start(t, localStorage = memoryStorage()) {
  const setup = await openMarksPanel(t);
  const page = () => setup.mount({ dom: createMiniDocument({ localStorage }) });
  const panel = page();
  const person = setup.scope('client', 'client-a');
  await panel.marks.setScope(person);
  const stands = await panel.store.saveCategory({ name: 'Stands', color: '#1e88e5', icon: 'ladder' });
  const trails = await panel.store.saveCategory({ name: 'Trails', color: '#43a047', icon: 'flag' });
  const add = (name, category, changes) => panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name, color: '#1e88e5', icon: 'pin', note: '',
    categoryId: category?.id || null, ...changes });
  await add('Stand 1', stands); await add('Stand 2', stands); await add('Trail', trails); await add('Loose', null);
  return { ...setup, panel, page, person, stands, trails, add, localStorage };
}

test('each category has an eye that hides it on the map and in the list, with the count shown', async t => {
  const { panel, page, person, stands, trails } = await start(t);
  assert.equal(panel.q('.viewer-mark-hidden-count').hidden, true);
  await eye(panel, stands.id).click();
  assert.deepEqual([pins(panel), names(panel).length], [['Loose', 'Trail'], 2]);
  assert.equal(eye(panel, stands.id).getAttribute('aria-label'), 'Show Stands');
  assert.equal(panel.dom.document.activeElement, eye(panel, stands.id), 'focus stays on the eye');
  assert.equal(panel.q('.viewer-mark-hidden-count').textContent, '2 hidden');
  assert.equal(panel.store.state.marks.length, 4, 'nothing but the view changes');
  await panel.q('.viewer-mark-hidden-count').click();
  assert.equal(panel.q('[id=viewer-marks-categories]').hidden, false);

  // Remembered for this person here; not for someone else; not across a public link.
  const again = page();
  await again.marks.setScope(person);
  assert.deepEqual(pins(again), ['Loose', 'Trail']);
  await again.marks.setScope({ mode: 'temporary', key: 'public' });
  await again.place('43.05, -87');
  await again.save();
  await eye(again, NO_CATEGORY).click();
  assert.deepEqual(pins(again), []);
  await again.marks.setScope(person);
  assert.deepEqual(pins(again), ['Loose', 'Trail'], 'hiding on a public link was not stored');
  await eye(again, stands.id).click();
  assert.deepEqual(pins(again), ['Loose', 'Stand 1', 'Stand 2', 'Trail']);
  await eye(again, NO_CATEGORY).click();
  await eye(again, trails.id).click();
  assert.deepEqual(pins(again), ['Stand 1', 'Stand 2']);
});

test('a name shows only that category, and Show all and Hide all do what they say', async t => {
  const { panel, trails } = await start(t);
  const only = () => panel.q(`[data-only="${trails.id}"]`);
  const button = text => panel.q('[id=viewer-marks-categories]').querySelectorAll('button').find(node => node.textContent === text);
  assert.equal(button('Show all').disabled, true);
  await only().click();
  assert.deepEqual([pins(panel), only().getAttribute('aria-pressed')], [['Trail'], 'true']);
  // A new mark starts in the one category being shown.
  await panel.place('43.05, -87');
  assert.equal(panel.q('[name=categoryId]').value, trails.id);
  await panel.save();
  assert.deepEqual(pins(panel), ['Trail', 'Trails']);
  await only().click();
  assert.equal(pins(panel).length, 5);
  await button('Hide all').click();
  assert.deepEqual(pins(panel), []);
  assert.equal(button('Hide all').disabled, true);
  assert.equal(panel.q('.viewer-mark-hidden-count').textContent, '5 hidden');
  await button('Show all').click();
  assert.equal(pins(panel).length, 5);
});

test('saving, restoring, importing or orphaning a mark never leaves it unseen', async t => {
  const { panel, stands, trails } = await start(t);
  await eye(panel, stands.id).click();
  await panel.open('Trail');
  panel.q('[name=categoryId]').value = stands.id;
  await panel.q('[name=categoryId]').fire('change');
  await panel.save();
  assert.deepEqual(pins(panel), ['Loose', 'Stand 1', 'Stand 2', 'Trail'], 'saved into a hidden category');

  await panel.open('Loose');
  const form = text => panel.q('.viewer-mark-form').querySelectorAll('button').find(node => node.textContent === text);
  await form('Delete').click();
  await form('Tap again to delete').click();
  await eye(panel, NO_CATEGORY).click();
  await panel.q('[data-tab=deleted]').click();
  await panel.q('[aria-label="Restore Loose"]').click();
  assert.ok(pins(panel).includes('Loose'));

  await eye(panel, trails.id).click();
  const file = JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [-87, 43] }, properties: { name: 'Imported', category: 'Trails' } });
  const input = panel.panel.querySelectorAll('input').find(node => node.getAttribute('type') === 'file');
  input.files = [{ size: file.length, text: async () => file }];
  await input.fire('change');
  assert.ok(pins(panel).includes('Imported'));

  // Deleting a hidden category shows the marks it leaves behind.
  await eye(panel, stands.id).click();
  await eye(panel, NO_CATEGORY).click();
  const remove = () => panel.q('[aria-label="Delete Stands"]').click();
  await remove();
  await remove();
  for (const name of ['Stand 1', 'Stand 2', 'Trail', 'Loose']) assert.ok(pins(panel).includes(name), name);
});

test('the list searches names, notes and categories; export is what is shown, and says so', async t => {
  const { panel, stands, add } = await start(t);
  await add('Corner', null, { note: 'Old oak' });
  const search = async text => { panel.q('[name=markSearch]').value = text; await panel.q('[name=markSearch]').fire('input'); return names(panel).length; };
  assert.deepEqual([await search('OAK'), await search('stands'), await search('trail'), await search('nothing'), await search('')], [1, 2, 1, 0, 5]);
  assert.equal(pins(panel).length, 5, 'search is for the list only');
  await eye(panel, stands.id).click();
  let exported;
  panel.dom.window.Blob = class { constructor([text]) { exported = JSON.parse(text); } };
  panel.dom.window.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  await panel.button('Export GeoJSON').click();
  assert.deepEqual(exported.features.map(feature => feature.properties.name).sort(), ['Corner', 'Loose', 'Trail']);
  assert.match(panel.text(), /Exported 3 of 5 marks; the rest are hidden\./);
});

test('staff hide a client category like any other, and nothing is written', async t => {
  const { scope, mount, stands, add, requests } = await start(t);
  await add('Shared', stands, { visibility: 'staff' });
  const staff = mount();
  await staff.marks.setScope(scope('ops', 'staff-person'));
  assert.deepEqual(pins(staff), ['Shared']);
  assert.match(staff.q(`[data-only="${stands.id}"]`).textContent, /From a client/);
  requests.length = 0;
  await eye(staff, stands.id).click();
  assert.deepEqual(pins(staff), []);
  assert.deepEqual(requests, []);
  assert.equal(staff.q('[aria-label="Edit Stands"]'), null);
});

test('the three tabs move with the arrow keys and Deleted is only offered where it exists', async t => {
  const { panel } = await start(t);
  const tabs = () => panel.panel.querySelectorAll('[role=tab]').filter(node => !node.hidden).map(node => [node.textContent, node.getAttribute('aria-selected')]);
  assert.deepEqual(tabs(), [['Categories', 'false'], ['List', 'true'], ['Deleted', 'false']]);
  await panel.q('[data-tab=list]').fire('keydown', { key: 'ArrowRight' });
  assert.equal(panel.dom.document.activeElement, panel.q('[data-tab=deleted]'));
  await panel.q('[data-tab=deleted]').fire('keydown', { key: 'ArrowRight' });
  assert.equal(panel.q('[id=viewer-marks-categories]').hidden, false);
  await panel.q('[data-tab=deleted]').click();
  await panel.marks.setScope({ mode: 'temporary', key: 'public' });
  assert.deepEqual(tabs(), [['Categories', 'false'], ['List', 'true']]);
});
