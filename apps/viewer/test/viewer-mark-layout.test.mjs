import assert from 'node:assert/strict';
import test from 'node:test';
import { openMarksPanel } from './helpers/marks-panel.mjs';

const PX = 1e-5; // degrees per pixel at zoom 18 in the stand-in

async function open(t, { who = ['client', 'client-a'] } = {}) {
  const setup = await openMarksPanel(t);
  const panel = setup.mount();
  panel.dom.window.matchMedia = () => ({ matches: false });
  await panel.marks.setScope(setup.scope(...who));
  const box = () => panel.q('.viewer-mark-box'), card = () => panel.q('.viewer-mark-card');
  const input = () => panel.q('[name=category]'), options = () => panel.q('.viewer-mark-suggest');
  const offered = () => (options().hidden ? [] : options().querySelectorAll('li').map(node => node.textContent));
  const keyIn = (node, key) => node.fire('keydown', { key }).then(event => (event.defaultPrevented ? event : panel.dom.window.fire('keydown', { key, target: node })));
  const add = (name, changes = {}) => panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name, color: '#1565c0', icon: 'pin', note: '', ...changes });
  return { ...setup, panel, box, card, input, options, offered, keyIn, add, key: (key, more) => panel.dom.window.fire('keydown', { key, ...more }) };
}

test('the category is a text box: its map\'s categories are offered on focus and narrowed while typing', async t => {
  const { panel, input, offered } = await open(t);
  for (const name of ['Tree stand', 'Trail', 'Food plot']) await panel.store.saveCategory({ name, color: '#2e7d32', icon: 'tree' });
  await panel.place('43.05, -87');
  assert.equal(input().tagName, 'INPUT');
  assert.equal(panel.q('select[name=categoryId]'), null, 'no fixed drop-down');
  assert.deepEqual([input().value, offered()], ['', []]);
  await input().fire('focus');
  assert.deepEqual(offered(), ['Food plot', 'Trail', 'Tree stand']);
  assert.equal(input().getAttribute('aria-expanded'), 'true');
  input().value = 'tr';
  await input().fire('input');
  assert.deepEqual(offered(), ['Trail', 'Tree stand']);
  input().value = 'stand';
  await input().fire('input');
  assert.deepEqual(offered(), ['Tree stand']);
  await input().fire('blur');
  assert.deepEqual([offered(), input().getAttribute('aria-expanded')], [[], 'false']);
});

test('a suggestion is picked by pointer or keys; Escape closes only the list', async t => {
  const { panel, input, options, offered, keyIn } = await open(t);
  const stand = await panel.store.saveCategory({ name: 'Tree stand', color: '#2e7d32', icon: 'tree' });
  await panel.store.saveCategory({ name: 'Trail', color: '#6d4c41', icon: 'trail' });
  await panel.place('43.05, -87');
  await input().fire('focus');
  const down = await options().querySelectorAll('li')[1].fire('mousedown');
  assert.equal(down.defaultPrevented, true, 'pressing keeps the focus in the box');
  await options().querySelectorAll('li')[1].click();
  assert.deepEqual([input().value, panel.q('[name=name]').value, panel.q('[name=color]').value, offered()], ['Tree stand', 'Tree stand', '#2e7d32', []]);
  await input().fire('focus');
  await keyIn(input(), 'ArrowDown');
  assert.equal(input().getAttribute('aria-activedescendant'), 'viewer-mark-category-option-0');
  assert.equal(options().querySelectorAll('li')[0].getAttribute('aria-selected'), 'true');
  const enter = await keyIn(input(), 'Enter');
  assert.equal(enter.defaultPrevented, true, 'Enter picks instead of saving');
  assert.equal(input().value, 'Trail');
  assert.equal(panel.store.state.marks.length, 0);
  await input().fire('focus');
  const escape = await keyIn(input(), 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual([offered(), panel.q('.viewer-mark-form').hidden], [[], false], 'the mark stays open');
  await keyIn(input(), 'Escape');
  assert.equal(panel.q('.viewer-mark-form').hidden, true, 'the next Escape is the editor\'s');
  assert.ok(stand.id);
});

test('a name typed once becomes a category of this map on Save, in the mark\'s look, and is offered next time', async t => {
  const { panel, input, offered, requests } = await open(t);
  await panel.place('43.05, -87');
  await panel.q('[data-icon=tree]').click();
  await panel.chooseCategory('Tree stand');
  assert.equal(panel.q('[name=name]').value, 'Tree stand', 'the automatic name follows');
  assert.equal(panel.store.state.categories.length, 0, 'nothing is made before Save');
  await panel.save();
  const [category] = panel.store.state.categories, [mark] = panel.store.state.marks;
  assert.deepEqual([category.name, category.icon, mark.categoryId, mark.icon], ['Tree stand', 'tree', category.id, 'tree']);
  requests.length = 0;
  await panel.place('43.06, -87');
  await input().fire('focus');
  assert.ok(offered().includes('Tree stand'));
  // Typed again in any case, it is the same category, not a second one.
  await panel.chooseCategory('  TREE STAND ');
  assert.equal(panel.q('[name=color]').value, category.color);
  await panel.save();
  assert.equal(panel.store.state.categories.length, 1);
  assert.equal(panel.store.state.marks.at(-1).categoryId, category.id);
  assert.ok(!requests.some(([method, path]) => method === 'POST' && path.endsWith('/categories')), 'no second category');
  // An emptied box is no category.
  await panel.open('Tree stand');
  await panel.chooseCategory('');
  await panel.save();
  assert.equal(panel.store.find(mark.id).categoryId, null);
});

test('another map has its own categories', async t => {
  const setup = await openMarksPanel(t);
  const first = setup.mount();
  await first.marks.setScope(setup.scope('client', 'client-a'));
  await first.place('43.05, -87');
  await first.chooseCategory('Tree stand');
  await first.save();
  const other = setup.mount();
  await other.marks.setScope(setup.scope('client', 'client-a', { modelId: 'other-model' }));
  await other.place('43.05, -87');
  assert.ok(!(await other.categoryOptions()).includes('Tree stand'));
});

test('a long new name is cut to the 60 characters a category may have', async t => {
  const { panel, requests } = await open(t);
  await panel.place('43.05, -87');
  await panel.chooseCategory('x'.repeat(80));
  assert.equal(panel.q('[name=category]').value.length, 80);
  await panel.save();
  assert.ok(panel.store.state.categories.every(category => category.name.length <= 60));
  // Long text is cut to the 60 a category name may have.
  assert.deepEqual(panel.store.state.categories.map(category => category.name), ['x'.repeat(60)]);
  assert.equal(panel.store.state.marks.length, 1);
  assert.ok(requests.length);
});

test('a typed new category survives a reload before Save', async t => {
  const setup = await openMarksPanel(t);
  const { createMiniDocument, memoryStorage } = await import('./helpers/mini-dom.mjs');
  const sessionStorage = memoryStorage(), person = setup.scope('client', 'client-a');
  const first = setup.mount({ dom: createMiniDocument({ sessionStorage }) });
  await first.marks.setScope(person);
  await first.place('43.05, -87');
  await first.chooseCategory('Blind');
  const second = setup.mount({ dom: createMiniDocument({ sessionStorage }) });
  await second.marks.setScope(person);
  assert.equal(second.q('[name=category]').value, 'Blind');
  await second.save();
  assert.deepEqual(second.store.state.categories.map(category => category.name), ['Blind']);
});

test('the list is docked at the top left; a card never covers it or the map\'s controls on the right', async t => {
  const { panel, box, card, key, add } = await open(t);
  panel.leaflet.setSize(1200, 800);
  for (const [name, x] of [['Left', -560], ['Right', 560], ['Middle', 0]]) await add(name, { geometry: { type: 'Point', coordinates: [-87 + x * PX, 43] } });
  await key('l');
  assert.equal(box().hidden, false);
  assert.equal(box().classList.contains('sheet'), false);
  for (const name of ['Left', 'Right', 'Middle']) {
    panel.leaflet.map.setView([43, -87]);
    await panel.leaflet.pins().find(pin => pin.label.text === name).click();
    panel.leaflet.fire('move');
    const left = parseFloat(card().style.left);
    assert.ok(left >= 56 + 340 + 12, `${name}: right of the list (${left})`);
    assert.ok(left + 300 <= 1200 - 64, `${name}: clear of the controls (${left})`);
    const [x] = [panel.leaflet.map.latLngToContainerPoint([43, panel.store.state.marks.find(mark => mark.name === name).geometry.coordinates[0]]).x];
    assert.ok(x >= 56 + 340 + 12, `${name}: its pin is not under the list (${x})`);
    await key('Escape');
  }
});

test('the undo note sits at the bottom, above the strip while placing several', async t => {
  const { panel } = await open(t);
  panel.leaflet.setSize(1200, 800);
  await panel.q('.viewer-mark-add').click();
  const strip = panel.q('.viewer-mark-strip');
  strip.offsetHeight = 120;
  await strip.querySelectorAll('button').find(node => node.textContent === 'Place several').click();
  panel.marks.mapClick({ lat: 43, lng: -87 });
  await new Promise(resolve => setTimeout(resolve, 50));
  const bar = panel.q('.viewer-mark-undo');
  assert.equal(bar.hidden, false);
  assert.equal(bar.style.bottom, `${16 + 120 + 8}px`);
});

test('the sidebar: Pin, Line and Area in one row, then All marks with the count', async t => {
  const { panel, add } = await open(t);
  await add('One');
  await add('Two');
  const tools = panel.sidebar.querySelector('.viewer-mark-tools');
  assert.deepEqual(tools.children.map(node => node.textContent), ['Pin', 'Line', 'Area']);
  const all = panel.sidebar.querySelector('.viewer-mark-open');
  assert.ok(all.classList.contains('tool-btn') && all.classList.contains('full'));
  assert.equal(all.textContent, 'All marks2');
  assert.equal(panel.q('.viewer-mark-box').querySelector('.viewer-mark-count').textContent, '2');
  // The map's own buttons are icons with names.
  for (const [selector, name] of [['.viewer-mark-add', 'Add mark'], ['.viewer-mark-layers', 'Marks']]) {
    const button = panel.q(selector);
    assert.deepEqual([button.getAttribute('aria-label'), button.classList.contains('viewer-mark-rail')], [name, true]);
  }
});
