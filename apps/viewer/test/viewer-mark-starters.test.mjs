import assert from 'node:assert/strict';
import test from 'node:test';
import marksRepository from '../server/viewerMarkRepository.js';
import { ICON_CHOICES, MARK_COLORS, STARTER_CATEGORIES } from '../viewer-mark-style.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';

const keys = list => list.map(item => item.key);
const starter = key => STARTER_CATEGORIES.find(item => item.key === key);
const principal = (subject, changes = {}) => ({ modelId: 'synthetic-model', modelVersionId: 'synthetic-v1', audience: 'client', subject, session: {}, personalPersistence: true, ...changes });
async function open(t) {
  const setup = await openMarksPanel(t);
  const repository = new marksRepository.ViewerMarkRepository(setup.database);
  const rows = () => setup.database.prepare('SELECT count(*) n FROM viewer_mark_categories').get().n;
  return { ...setup, repository, rows };
}
const input = key => ({ ...starter(key) });

test('the starters are generic, distinct and use icons and colours that exist', () => {
  assert.deepEqual(STARTER_CATEGORIES.map(item => item.name), ['Point of interest', 'Building', 'Gate or access', 'Road or trail', 'Utility', 'Water', 'Vegetation',
    'Hazard', 'Boundary or corner', 'Equipment', 'Photo spot', 'Other']);
  assert.deepEqual(keys(STARTER_CATEGORIES), [...marksRepository.STARTERS], 'the server knows the same ones');
  for (const { icon, color } of STARTER_CATEGORIES) {
    assert.ok(MARK_COLORS.some(item => item.color === color));
    assert.notEqual(ICON_CHOICES.find(item => item.name === icon).group, 'Outdoors');
  }
  assert.equal(new Set(STARTER_CATEGORIES.map(item => item.icon)).size, 12);
});

test('they are offered to a person with no categories and writing nothing until one is used', async t => {
  const { repository, rows } = await open(t);
  const person = principal('client-a');
  assert.deepEqual(repository.starters(person), keys(STARTER_CATEGORIES));
  assert.equal(rows(), 0);
  const made = repository.createStarter(person, input('access'));
  assert.deepEqual([made.replayed, made.category.name, made.category.icon, made.category.mine], [false, 'Gate or access', 'gate', true]);
  assert.equal(rows(), 1);
  assert.deepEqual(repository.starters(person), keys(STARTER_CATEGORIES).filter(key => key !== 'access'), 'the rest stay on offer');
  // Their own list beside it does not end the offer; a list with no starter never had one.
  repository.createCategory(person, { id: crypto.randomUUID(), name: 'Tree stands', color: '#1565c0', icon: 'ladder' });
  assert.equal(repository.starters(person).length, 11);
  const existing = principal('client-b');
  repository.createCategory(existing, { id: crypto.randomUUID(), name: 'Mine', color: '#1565c0', icon: 'flag' });
  assert.deepEqual(repository.starters(existing), []);
  // Other people, audiences and models are separate.
  for (const other of [principal('client-c'), principal('client-a', { audience: 'ops' }), principal('client-a', { modelId: 'other-model' })]) {
    assert.equal(repository.starters(other).length, 12);
    assert.notEqual(repository.createStarter(other, input('access')).category.id, made.category.id);
  }
});

test('two devices never make two of one starter, whatever happened to it meanwhile', async t => {
  const { repository, rows } = await open(t);
  const person = principal('client-a');
  const first = repository.createStarter(person, input('hazard')).category;
  const again = repository.createStarter(person, input('hazard'));
  assert.deepEqual([again.replayed, again.category.id], [true, first.id]);
  repository.updateCategory(person, first.id, { id: first.id, name: 'Danger', color: '#1565c0', icon: 'warning', revision: 1 });
  const renamed = repository.createStarter(person, input('hazard'));
  assert.deepEqual([renamed.replayed, renamed.category.id, renamed.category.name], [true, first.id, 'Danger'], 'the renamed one is handed back, not reset');
  assert.equal(rows(), 1);
  // A category of their own with that name counts too, in any case.
  repository.createCategory(person, { id: crypto.randomUUID(), name: 'WATER', color: '#1565c0', icon: 'flag' });
  assert.equal(repository.createStarter(person, input('water')).category.name, 'WATER');
  assert.equal(rows(), 2);
  // Deleted stays deleted: it is not offered and not brought back.
  repository.deleteCategory(person, first.id, 2);
  assert.ok(!repository.starters(person).includes('hazard'));
  assert.throws(() => repository.createStarter(person, input('hazard')), { code: 'mark_category_id_conflict', status: 409 });
  assert.equal(rows(), 2);
});

test('only known starters with plain category fields are accepted', async t => {
  const { repository, rows } = await open(t);
  const person = principal('client-a');
  for (const bad of [null, [], {}, input('access').name, { ...input('access'), key: 'deer' }, { ...input('access'), id: crypto.randomUUID() }, { ...input('access'), owner: 'x' },
    { ...input('access'), name: ' ' }, { ...input('access'), color: 'red' }, { ...input('access'), icon: '../x' }, { ...input('access'), key: '__proto__' }]) {
    assert.throws(() => repository.createStarter(person, bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.equal(rows(), 0);
  for (let i = 0; i < marksRepository.LIMITS.categories; i += 1) repository.createCategory(person, { id: crypto.randomUUID(), name: 'c' + i, color: '#1565c0', icon: 'flag' });
  assert.throws(() => repository.createStarter(person, input('access')), { code: 'mark_category_limit_reached' });
});

const suggested = panel => panel.q('.viewer-mark-starters').querySelectorAll('.viewer-mark-list-name').map(node => node.textContent);
const own = panel => panel.store.state.categories.map(category => category.name);

test('in the panel: suggestions add one or all, and go away with the person\'s own first category', async t => {
  const { mount, scope, rows, requests } = await open(t);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  assert.equal(suggested(panel).length, 12);
  assert.deepEqual(requests.map(([method]) => method), ['GET'], 'nothing is written to show them');
  await panel.q('[aria-label="Add Water"]').click();
  assert.deepEqual([own(panel), suggested(panel).length, rows()], [['Water'], 11, 1]);
  await panel.q('[aria-label="Edit Water"]').click();
  panel.q('[name=categoryName]').value = 'Ponds';
  await panel.q('.viewer-mark-category-form').fire('submit');
  assert.deepEqual(own(panel), ['Ponds']);
  const remove = () => panel.q('[aria-label="Delete Ponds"]').click();
  await remove();
  await remove();
  assert.ok(!suggested(panel).includes('Water'));
  await panel.q('.viewer-mark-suggested').querySelectorAll('button').find(node => node.textContent === 'Add all').click();
  assert.deepEqual([own(panel).length, suggested(panel).length, rows()], [11, 0, 12]);
  assert.equal(panel.q('.viewer-mark-suggested').hidden, true);
  const again = mount();
  await again.marks.setScope(scope('client', 'client-a'));
  assert.deepEqual([own(again).length, suggested(again)], [11, []]);

  const other = mount();
  await other.marks.setScope(scope('client', 'client-b'));
  await other.store.saveCategory({ name: 'Mine', color: '#1565c0', icon: 'flag' });
  assert.deepEqual(suggested(other), []);
});

test('in the editor: a suggestion is made on Save, once, and survives a reload before that', async t => {
  const { mount, scope, rows, database } = await open(t);
  const sessionStorage = memoryStorage();
  const page = () => mount({ dom: createMiniDocument({ sessionStorage }) });
  const first = page(), person = scope('client', 'client-a');
  await first.marks.setScope(person);
  await first.place('43.05, -87');
  first.q('[name=categoryId]').value = 'starter:access';
  await first.q('[name=categoryId]').fire('change');
  assert.deepEqual([first.q('[name=name]').value, first.q('[name=color]').value], ['Gate or access', starter('access').color]);
  assert.equal(rows(), 0);
  const second = page();
  await second.marks.setScope(person);
  assert.equal(second.q('[name=categoryId]').value, 'starter:access');
  await second.save();
  const [mark] = second.store.state.marks, [category] = second.store.state.categories;
  assert.deepEqual([mark.categoryId, mark.icon, mark.name, category.name, rows()], [category.id, 'gate', 'Gate or access', 'Gate or access', 1]);
  await second.open('Gate or access');
  assert.equal(second.q('[name=categoryId]').value, category.id);
  assert.ok(!second.q('[name=categoryId]').children.some(option => option.value === 'starter:access'));
  // A second device that still shows the suggestion ends up with the same category.
  const stale = mount();
  await stale.marks.setScope(scope('client', 'client-b'));
  const repository = new marksRepository.ViewerMarkRepository(database);
  database.prepare('DELETE FROM viewer_mark_categories').run();
  const made = repository.createStarter(principal('client-b'), input('road')).category;
  await stale.place('43.06, -87');
  stale.q('[name=categoryId]').value = 'starter:road';
  await stale.q('[name=categoryId]').fire('change');
  await stale.save();
  assert.deepEqual([stale.store.state.marks[0].categoryId, rows()], [made.id, 1]);
});

test('a suggestion that cannot be made leaves the mark unsaved and the editor open', async t => {
  const { mount, scope, database, repository } = await open(t);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  const made = repository.createStarter(principal('client-a'), input('other')).category;
  repository.deleteCategory(principal('client-a'), made.id, 1);
  await panel.place('43.05, -87');
  panel.q('[name=categoryId]').value = 'starter:other';
  await panel.q('[name=categoryId]').fire('change');
  await panel.save();
  assert.equal(panel.q('.viewer-mark-form').hidden, false);
  assert.equal(database.prepare('SELECT count(*) n FROM viewer_marks').get().n, 0);
  assert.ok(!suggested(panel).includes('Other'), 'the list was read again');
});

test('suggestions can be put away, stay away through Show all and Only, and come back', async t => {
  const { mount, scope } = await open(t);
  const localStorage = memoryStorage();
  const page = () => mount({ dom: createMiniDocument({ localStorage }) });
  const panel = page(), person = scope('client', 'client-a');
  await panel.marks.setScope(person);
  const list = () => panel.q('.viewer-mark-starters');
  await panel.q('[aria-label="Add Water"]').click();
  await panel.q('[aria-label="Hide suggested categories"]').click();
  assert.equal(list().hidden, true);
  const { id } = panel.store.state.categories[0];
  const button = text => panel.q('[id=viewer-marks-categories]').querySelectorAll('button').find(node => node.textContent === text);
  await panel.q(`[data-only="${id}"]`).click();
  await button('Hide all').click();
  await button('Show all').click();
  assert.equal(list().hidden, true);
  await panel.place('43.05, -87');
  assert.ok(!panel.q('[name=categoryId]').children.some(option => option.value.startsWith('starter:')));
  const again = page();
  await again.marks.setScope(person);
  assert.equal(again.q('.viewer-mark-starters').hidden, true);
  await again.q('[aria-label="Show suggested categories"]').click();
  assert.equal(again.q('.viewer-mark-starters').hidden, false);
});

test('a public link offers them in the tab only; read-only logins are not offered any', async t => {
  const { mount, scope, rows, requests } = await open(t);
  const panel = mount();
  await panel.marks.setScope({ mode: 'temporary', key: 'public' });
  assert.equal(suggested(panel).length, 12);
  await panel.q('[aria-label="Add Hazard"]').click();
  assert.deepEqual([own(panel), suggested(panel).length], [['Hazard'], 11]);
  await panel.store.saveCategory({ name: 'Mine', color: '#1565c0', icon: 'flag' });
  assert.equal(suggested(panel).length, 11);
  assert.deepEqual([requests.length, rows()], [0, 0]);
  await panel.marks.setScope(scope('client', 'company-login', { permissions: { view: true, measure: true } }));
  assert.equal(panel.q('.viewer-mark-suggested').hidden, true);
});
