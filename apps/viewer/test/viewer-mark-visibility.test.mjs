import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_CATEGORY, createMarkVisibility } from '../viewer-mark-visibility.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';

const KEY = 'ltds.viewer.marks.hidden';

test('hidden categories are remembered per person and project, without the identity', () => {
  const storage = memoryStorage();
  const open = key => { const visibility = createMarkVisibility({ storage: () => storage }); visibility.setScope(key); return visibility; };
  const mine = open('["client","client:someone@example.invalid","model-1"]');
  for (const id of ['a', 'b', NO_CATEGORY]) mine.toggle(id);
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
const pins = panel => panel.leaflet.pins().map(layer => layer.label?.text).filter(Boolean).sort();
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

test('a bulk choice is remembered as that choice, however many categories there are', () => {
  const storage = memoryStorage();
  const open = () => { const visibility = createMarkVisibility({ storage: () => storage }); visibility.setScope('scope'); return visibility; };
  const all = [...Array.from({ length: 700 }, (_, i) => 'id' + i), NO_CATEGORY];
  const hidden = visibility => all.filter(visibility.isHidden).length;
  open().hideAll();
  assert.equal(hidden(open()), 701);
  assert.ok(storage.getItem(KEY).length < 200, 'the choice is stored, not a list');
  open().only('id5');
  assert.deepEqual(all.filter(id => !open().isHidden(id)), ['id5']);
  assert.equal(open().isOnly('id5', all), true);
  const many = open();
  many.hideAll();
  for (let i = 0; i < 400; i += 1) many.toggle('id' + i);
  assert.equal(hidden(open()), 301, 'exceptions are all kept too');
  many.showAll();
  for (let i = 0; i < 600; i += 1) many.toggle('id' + i);
  assert.equal(hidden(open()), 600);
  open().showAll();
  assert.equal(hidden(open()), 0);
});

test('when the browser cannot keep the choice, older ones give way, and if it still cannot, that is known', () => {
  let room = 2000;
  const storage = memoryStorage(), setItem = storage.setItem;
  storage.setItem = (key, value) => { if (value.length > room) throw new Error('quota'); setItem(key, value); };
  const open = key => { const visibility = createMarkVisibility({ storage: () => storage }); visibility.setScope(key); return visibility; };
  for (let i = 0; i < 20; i += 1) { const visibility = open('scope ' + i); for (let j = 0; j < 5; j += 1) visibility.toggle(`category-${i}-${j}`); }
  const last = open('scope 19');
  assert.equal(last.isHidden('category-19-4'), true);
  assert.equal(last.remembered(), true);
  for (let j = 0; j < 400; j += 1) last.toggle('much-longer-category-id-' + j);
  assert.equal(last.remembered(), false);
  assert.equal(last.isHidden('much-longer-category-id-399'), true, 'it works for this page');
  room = 0;
  assert.equal(open('scope 1').remembered(), true, 'nothing to keep yet');
});

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

  await panel.show('Loose');
  await panel.card('Delete').click();
  await panel.card('Tap again to delete').click();
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

const draftPins = panel => panel.leaflet.pins().length;
test('hiding the category of the open mark hides its pin and keeps the editor', async t => {
  const { panel, stands, trails } = await start(t);
  await panel.open('Trail');
  await panel.type('[name=note]', 'Being typed');
  assert.equal(draftPins(panel), 4);
  await eye(panel, trails.id).click();
  assert.equal(draftPins(panel), 3, 'the open pin follows its saved category');
  assert.equal(panel.q('.viewer-mark-form').hidden, false);
  assert.equal(panel.q('[name=note]').value, 'Being typed');
  await panel.card('Cancel').click();
  await panel.card('Move').click();
  assert.equal(panel.leaflet.pins().some(layer => layer.options.draggable), false, 'a hidden pin cannot be dragged');
  assert.equal(draftPins(panel), 3);
  await panel.q('.viewer-mark-move').querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
  await panel.card('Edit').click();
  // Another category picked but not saved does not bring it back; saving does.
  panel.q('[name=categoryId]').value = stands.id;
  await panel.q('[name=categoryId]').fire('change');
  assert.equal(draftPins(panel), 3);
  await panel.save();
  assert.deepEqual(pins(panel), ['Loose', 'Stand 1', 'Stand 2', 'Trail']);
  await eye(panel, trails.id).click();
  // A mark not saved yet is always drawn, whatever is hidden.
  await panel.q('[id=viewer-marks-categories]').querySelectorAll('button').find(node => node.textContent === 'Hide all').click();
  await panel.place('43.05, -87');
  assert.equal(draftPins(panel), 1);
});

test('Hide all holds after a reload for staff with hundreds of categories, and is said when it cannot be kept', async t => {
  const { scope, mount, database } = await openMarksPanel(t);
  const add = database.prepare(`INSERT INTO viewer_mark_categories(id, model_id, owner_audience, owner_subject, name, document_json, revision, created_at, updated_at)
    VALUES (?, 'synthetic-model', 'client', ?, ?, ?, 1, 'x', 'x')`);
  const mark = database.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision, created_at, updated_at,
    updated_by_audience, updated_by_subject) VALUES (?, 'synthetic-model', 'client', ?, 'staff', ?, 'x', 1, '2026-11-20T00:00:00.000Z', 'x', 'client', ?)`);
  for (let i = 0; i < 320; i += 1) {
    const id = crypto.randomUUID(), markId = crypto.randomUUID(), subject = 'client-' + (i % 4);
    add.run(id, subject, 'c' + i, JSON.stringify({ id, name: 'c' + i, color: '#1565c0', icon: 'flag' }));
    mark.run(markId, subject, JSON.stringify({ id: markId, geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'm' + i, note: '', categoryId: id, color: '#1565c0', icon: 'pin', elevationNavd88M: null }), subject);
  }
  const localStorage = memoryStorage(), staff = scope('ops', 'staff-person');
  const page = async () => { const panel = mount({ dom: createMiniDocument({ localStorage }) }); await panel.marks.setScope(staff); return panel; };
  const first = await page();
  assert.equal(pins(first).length, 320);
  const hideAll = panel => panel.q('[id=viewer-marks-categories]').querySelectorAll('button').find(node => node.textContent === 'Hide all').click();
  await hideAll(first);
  assert.deepEqual(pins(await page()), []);
  const again = await page();
  await eye(again, again.store.state.categories[0].id).click();
  assert.equal(pins(await page()).length, 1);

  localStorage.setItem = () => { throw new Error('quota'); };
  const blocked = await page();
  await hideAll(blocked);
  assert.deepEqual(pins(blocked), []);
  assert.match(blocked.text(), /could not be remembered/);
});

test('showing the last hidden category by hand is the same as Show all', async t => {
  const { panel, stands, trails, localStorage } = await start(t);
  await panel.q('[id=viewer-marks-categories]').querySelectorAll('button').find(node => node.textContent === 'Hide all').click();
  assert.equal(JSON.parse(localStorage.getItem(KEY)).length, 1);
  for (const id of [stands.id, trails.id, NO_CATEGORY]) await eye(panel, id).click();
  assert.deepEqual(JSON.parse(localStorage.getItem(KEY)), []);
  const later = await panel.store.saveCategory({ name: 'Later', color: '#1565c0', icon: 'flag' });
  assert.equal(eye(panel, later.id).getAttribute('aria-label'), 'Hide Later', 'a later one starts shown');
});
