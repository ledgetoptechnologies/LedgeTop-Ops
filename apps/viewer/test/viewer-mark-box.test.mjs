import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkMapLayer, groupPoints, placeMarkLabels } from '../viewer-mark-map-layer.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';
import { createMiniLeaflet } from './helpers/mini-leaflet.mjs';

const PX = 1e-5; // degrees per pixel at zoom 18 in the stand-in
const at = (x, y = 0) => ({ type: 'Point', coordinates: [-87 + x * PX, 43 - y * PX] });
const mark = (id, x = 0, y = 0, changes = {}) => ({ id, name: id, color: '#1565c0', icon: 'pin', geometry: at(x, y), ...changes });

test('points within 24 px are grouped the same way whatever their order, and each once', () => {
  const points = [['a', 0, 0], ['b', 20, 0], ['c', 40, 0], ['d', 200, 200], ['e', 210, 210], ['f', 224.1, 224.1], ['g', 500, 500]].map(([id, x, y]) => ({ id, x, y }));
  const groups = groupPoints(points);
  assert.deepEqual(groups, [['a', 'b'], ['d', 'e']]);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(groupPoints([...points].sort(() => Math.random() - 0.5)), groups);
  assert.deepEqual(groupPoints([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 24, y: 0 }]), [], '24 px apart is apart');
  assert.deepEqual(groupPoints([{ id: 'a', x: -1, y: -1 }, { id: 'b', x: 1, y: 1 }]), [['a', 'b']], 'also across cells and below zero');
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: 'm' + i, x: (i * 37) % 2000, y: (i * 91) % 1500 }));
  const started = performance.now();
  assert.equal(new Set(groupPoints(many).flat()).size, groupPoints(many).flat().length);
  assert.ok(performance.now() - started < 2000);
});

test('a label gives way to pins, owner names and labels before it; a selected one stays', () => {
  const label = (id, x, y, selected = false) => ({ id, x, y, width: 60, height: 18, selected });
  const pins = [{ id: 'a', x: 0, y: 0, width: 26, height: 40 }, { id: 'b', x: 100, y: 0, width: 26, height: 40 }];
  const owners = [{ x: 300, y: 300, width: 120, height: 30 }];
  assert.deepEqual([...placeMarkLabels([label('a', 0, 10)], pins, owners)], ['a'], 'its own pin is no obstacle');
  assert.deepEqual([...placeMarkLabels([label('a', 90, 10)], pins, owners)], [], 'another pin is');
  assert.deepEqual([...placeMarkLabels([label('a', 350, 310)], pins, owners)], [], 'an owner name is');
  assert.deepEqual([...placeMarkLabels([label('a', 350, 310, true)], pins, owners)], ['a'], 'unless it is selected');
  assert.deepEqual([...placeMarkLabels([label('a', 500, 500), label('b', 520, 505)], [], [])], ['a']);
  assert.deepEqual([...placeMarkLabels([label('a', 500, 500), label('b', 560, 500)], [], [])], ['a', 'b'], 'touching is not over');
});

function layerFixture(options = {}) {
  const { document } = createMiniDocument();
  const leaflet = createMiniLeaflet(document), selected = [], groups = [];
  const layer = createMarkMapLayer({ L: leaflet.L, getMap: () => leaflet.map, onSelect: id => selected.push(id), onGroup: ids => groups.push(ids), ...options });
  const render = (marks, more = {}) => layer.render({ visible: true, marks, draft: null, selectedId: null, labels: 'selected', group: true, preview: null, drawing: null, ...more });
  const names = () => leaflet.pins().map(pin => pin.label.text).sort();
  const kept = () => leaflet.shown();
  return { document, leaflet, layer, render, selected, groups, names, kept };
}
const key = (element, name) => element.fire('keydown', { key: name, stopPropagation() {} });

test('pins on one spot are one plate with a count; it lists them, and opens apart when zoomed in', () => {
  const { leaflet, render, groups, names } = layerFixture();
  const marks = [mark('a', 0), mark('b', 10), mark('c', 15, 5), mark('far', 400)];
  render(marks);
  assert.deepEqual(names(), ['far']);
  const [plate] = leaflet.groups();
  assert.match(plate.options.icon.html, /<b>3<\/b>/);
  assert.equal((plate.options.icon.html.match(/<svg/g) || []).length, 2, 'two sample pins');
  assert.equal(plate.getElement().getAttribute('aria-label'), '3 marks: a, b, c');
  assert.ok(plate.options.icon.iconSize[0] >= 36 && plate.options.icon.iconSize[0] <= 46);
  plate.click();
  assert.deepEqual(groups, [['a', 'b', 'c']]);
  // Same plate while nothing about it changes.
  const made = leaflet.made.length;
  render(marks, { preview: [-87, 43] });
  assert.equal(leaflet.groups()[0], plate);
  assert.equal(leaflet.made.length, made + 1);
  leaflet.setZoom(21);
  assert.deepEqual([names(), leaflet.groups().length], [['a', 'b', 'c', 'far'], 0]);
  leaflet.setZoom(12);
  assert.match(leaflet.groups()[0].options.icon.html, /<b>4<\/b>/);
  // Off, and while drawing: every pin by itself.
  leaflet.setZoom(18);
  render(marks, { group: false });
  assert.equal(names().length, 4);
  render(marks, { drawing: { type: 'LineString', positions: [[-87, 43]], color: '#1565c0' } });
  assert.deepEqual([names().length, leaflet.groups().length], [4, 0]);
});

test('the selected mark, the open one, lines and areas are never grouped, and names cannot become markup', () => {
  const { leaflet, render, names } = layerFixture();
  const line = mark('line', 0, 0, { geometry: { type: 'LineString', coordinates: [at(0).coordinates, at(9).coordinates] } });
  const marks = [mark('<img src=x>', 0, 0, { icon: '"><script>', color: 'red"' }), mark('b', 5), mark('c', 8), line];
  render(marks, { selectedId: 'b' });
  assert.deepEqual(names(), ['b']);
  assert.doesNotMatch(leaflet.groups()[0].options.icon.html, /script|img|red"/);
  assert.equal(leaflet.groups()[0].getElement().getAttribute('aria-label'), '2 marks: <img src=x>, c');
  render(marks, { selectedId: 'b', draft: { ...marks[2], movable: true } });
  assert.deepEqual([names(), leaflet.groups().length], [['<img src=x>', 'b', 'c'], 0]);
  assert.equal(leaflet.drawn().filter(item => item.kind === 'polyline').length, 2);
});

test('a plate is a tab stop like a pin: arrows reach it and Enter lists it; nothing is left when it goes', async () => {
  const { document, leaflet, layer, render, groups, selected } = layerFixture();
  render([mark('a', 0), mark('b', 5), mark('z', 300)]);
  const plate = leaflet.groups()[0], pin = leaflet.pins()[0];
  assert.deepEqual([plate.getElement().tabIndex, pin.getElement().tabIndex].sort(), [-1, 0]);
  await key(plate.getElement(), 'ArrowRight');
  assert.ok(document.activeElement === pin.getElement());
  await key(pin.getElement(), 'ArrowRight');
  assert.ok(document.activeElement === plate.getElement());
  await key(plate.getElement(), 'Enter');
  assert.deepEqual([groups, selected], [[['a', 'b']], []]);
  layer.focusPin('b');
  assert.ok(document.activeElement === plate.getElement(), 'a grouped mark is found at its plate');
  render([mark('a', 0)]);
  assert.deepEqual(Object.values(plate.handlers).flat(), []);
  await key(plate.getElement(), 'Enter');
  assert.equal(groups.length, 1);
  layer.dispose();
  assert.deepEqual(Object.values(leaflet.mapHandlers).map(handlers => handlers.size).filter(Boolean), []);
});

test('labels: on, only the selected one, or off; they give way on the map and follow it', () => {
  let names = [];
  const { leaflet, render, kept } = layerFixture({ obstacles: () => names });
  const marks = [mark('Left', -200), mark('Right', 200), mark('Close', 215, 4)];
  render(marks, { group: false });
  assert.deepEqual(kept(), []);
  render(marks, { group: false, selectedId: 'Right' });
  assert.deepEqual(kept(), ['Right']);
  render(marks, { group: false, labels: 'on', selectedId: 'Right' });
  assert.deepEqual(kept(), ['Left', 'Right'], 'Close would be over the pin and label beside it');
  render(marks, { group: false, labels: 'off', selectedId: 'Right' });
  assert.deepEqual(kept(), []);
  for (const pin of leaflet.pins()) assert.equal(pin.label.options.permanent, false, 'each still has its name on hover');
  // An owner name arrives over one label, then goes.
  render(marks, { group: false, labels: 'on' });
  assert.ok(kept().includes('Left'));
  names = [{ x: 260, y: 320, width: 80, height: 40 }];
  leaflet.fire('layeradd', {});
  assert.ok(!kept().includes('Left'), 'it gives way');
  names = [];
  leaflet.fire('moveend', {});
  assert.ok(kept().includes('Left'));
  // Off the screen there is nothing to label.
  leaflet.map.setView([44, -88]);
  leaflet.fire('moveend', {});
  assert.deepEqual(kept(), []);
});

test('label work is done once after the map settles and never sets itself off', () => {
  const queue = [];
  let asked = 0;
  const { leaflet, render, kept } = layerFixture({ schedule: work => queue.push(work), obstacles: () => { asked += 1; return []; } });
  render([mark('a', 0), mark('b', 300)], { labels: 'on', group: false });
  for (let i = 0; i < 5; i += 1) leaflet.fire('layeradd', {});
  assert.equal(queue.length, 1);
  assert.deepEqual(kept(), []);
  queue.shift()();
  assert.deepEqual(kept(), ['a', 'b']);
  assert.deepEqual([queue.length, asked], [0, 1]);
  leaflet.fire('moveend', {});
  render([], { visible: false });
  queue.shift()();
  assert.equal(asked, 1, 'the map went away first');
});

// ---- in the panel -------------------------------------------------------------
async function open(t, options = {}) {
  const setup = await openMarksPanel(t);
  const panel = setup.mount({ group: true, ...options });
  panel.dom.window.matchMedia = () => ({ matches: Boolean(options.coarse) });
  await panel.marks.setScope(setup.scope('client', 'client-a'));
  const add = (name, x = 0, changes = {}) => panel.store.create({ geometry: at(x), name, color: '#1565c0', icon: 'pin', note: '', ...changes });
  const box = () => panel.q('.viewer-mark-box'), pick = () => panel.q('.viewer-mark-pick');
  const picks = () => pick().querySelectorAll('.viewer-mark-list-item').map(node => node.textContent);
  return { ...setup, panel, add, box, pick, picks, key: (name, more) => panel.dom.window.fire('keydown', { key: name, ...more }) };
}
const focused = (panel, node) => panel.dom.document.activeElement === node;

test('a plate opens a list by name; picking one opens its card, Zoom in separates them, Escape goes back', async t => {
  const { panel, add, pick, picks, key } = await open(t);
  for (const [name, x] of [['One', 0], ['Two', 6], ['Three', 12]]) await add(name, x);
  await panel.leaflet.groups()[0].click();
  assert.deepEqual([pick().hidden, picks().sort()], [false, ['One', 'Three', 'Two']]);
  assert.match(pick().textContent, /^3 marks here/);
  assert.ok(focused(panel, pick().querySelector('button.viewer-mark-list-item')));
  await key('Escape');
  assert.equal(pick().hidden, true);
  assert.ok(focused(panel, panel.leaflet.groups()[0].getElement()));
  panel.leaflet.groups()[0].click();
  await pick().querySelectorAll('.viewer-mark-list-item').find(node => node.textContent.startsWith('Two')).click();
  assert.equal(pick().hidden, true);
  assert.match(panel.q('.viewer-mark-view').textContent, /Two/);
  assert.equal(panel.leaflet.pins().map(pin => pin.label.text).join(), 'Two', 'it stands apart while open');
  await panel.q('[aria-label=Close]').click();
  panel.leaflet.groups()[0].click();
  await pick().querySelectorAll('button').find(node => node.textContent === 'Zoom in').click();
  assert.equal(pick().hidden, true);
  assert.ok(panel.leaflet.map.getZoom() > 18);
  // A list is not left behind when its marks go.
  panel.leaflet.setZoom(18);
  panel.leaflet.groups()[0].click();
  for (const mark_ of [...panel.store.state.marks].slice(0, 2)) await panel.store.remove(mark_);
  assert.equal(pick().hidden, true);
});

test('with grouping off, two pins under one finger ask instead of guessing: 13 px, or 24 by touch', async t => {
  for (const [coarse, gap, asks] of [[false, 12, true], [false, 14, false], [true, 23, true], [true, 25, false]]) {
    const { panel, add, pick, key } = await open(t, { coarse });
    await add('One', 0);
    await add('Two', gap);
    panel.q('[name=group]').checked = false;
    await panel.q('[name=group]').fire('change');
    assert.equal(panel.leaflet.pins().length, 2);
    panel.leaflet.pins().find(pin => pin.label.text === 'One').click();
    assert.equal(pick().hidden, !asks, `${coarse} ${gap}`);
    if (!asks) { assert.match(panel.q('.viewer-mark-view').textContent, /One/); continue; }
    await key('Escape');
    // The keyboard says which one exactly.
    await panel.leaflet.pins().find(pin => pin.label.text === 'One').getElement().fire('keydown', { key: 'Enter', stopPropagation() {} });
    assert.match(panel.q('.viewer-mark-view').textContent, /One/);
  }
});

test('the open mark is not among the pins asked about, and the list is by name', async t => {
  const { panel, add, pick, picks, key } = await open(t);
  for (const [name, x] of [['b', 0], ['a', 6], ['Open', 3], ['Draft', 4], ['Bee', 2], ['a', 8]]) await add(name, x);
  panel.q('[name=group]').checked = false;
  await panel.q('[name=group]').fire('change');
  const pin = name => panel.leaflet.pins().find(item => item.label.text === name);
  const names = () => picks().map(text => text.replace(/No category$/, ''));
  for (const start of ['card', 'editor']) {
    await panel.show('Open');
    if (start === 'editor') await panel.card('Edit').click();
    pin('b').click();
    assert.deepEqual(names(), ['a', 'a', 'b', 'Bee', 'Draft'], start);
    assert.equal(panel.q('.viewer-mark-card').hidden, true);
    await key('Escape');
    assert.ok(focused(panel, pin('b').getElement()), 'back to the pin that was asked about');
  }
  // The same two, always in the same order.
  const twins = panel.store.state.marks.filter(item => item.name === 'a').map(item => item.id).sort();
  for (const order of [twins, [...twins].reverse()]) {
    panel.store.state.marks.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
    pin('b').click();
    await pick().querySelector('button.viewer-mark-list-item').click();
    assert.equal(panel.leaflet.pins().find(item => item.options.icon.className.includes('selected')).getElement().getAttribute('aria-label').split(',')[0], 'a');
    await panel.card('Edit').click();
    await panel.type('[name=note]', 'first');
    await panel.save();
    await panel.q('[aria-label=Close]').click();
  }
  assert.deepEqual(panel.store.state.marks.filter(item => item.note === 'first').map(item => item.id), [twins[0]]);
  // With only the open one near, there is nothing to ask.
  const alone = await open(t);
  await alone.add('One', 0);
  await alone.add('Two', 5);
  alone.panel.q('[name=group]').checked = false;
  await alone.panel.q('[name=group]').fire('change');
  await alone.panel.show('One');
  alone.panel.leaflet.pins().find(item => item.label.text === 'Two').click();
  assert.equal(alone.pick().hidden, true);
  assert.match(alone.panel.q('.viewer-mark-view').textContent, /Two/);
});

test('a plate lists by name whatever the order on the map', async t => {
  const { panel, add, picks } = await open(t);
  for (const [name, x] of [['Two', 0], ['one', 5], ['Three', 10]]) await add(name, x);
  await panel.leaflet.groups()[0].click();
  assert.deepEqual(picks().map(text => text.replace(/No category$/, '')), ['one', 'Three', 'Two']);
});

test('turning a wide screen narrow leaves one thing open and loses nothing', async t => {
  const { panel, add, box, pick, key } = await open(t);
  await add('One', 0);
  await add('Two', 5);
  await add('Far', 400);
  const card = () => panel.q('.viewer-mark-card'), turn = async work => {
    panel.leaflet.setSize(1200, 800);
    if (box().hidden) await key('l');
    await work();
    assert.equal(box().hidden, false, 'beside it while there is room');
    panel.leaflet.setSize(390, 700);
    assert.equal(box().hidden, true);
  };
  await turn(() => panel.show('Far'));
  assert.equal(card().hidden, false);
  assert.ok(focused(panel, panel.card('Edit')) || !box().contains(panel.dom.document.activeElement));
  await key('Escape');
  await turn(() => panel.leaflet.groups()[0].click());
  assert.equal(pick().hidden, false);
  await key('Escape');
  await turn(async () => { await panel.open('Far'); await panel.type('[name=note]', 'Typing'); panel.q('[name=markSearch]').focus(); });
  assert.deepEqual([card().hidden, panel.q('[name=note]').value], [false, 'Typing']);
  assert.ok(card().contains(panel.dom.document.activeElement), 'focus does not stay in what closed');
  await panel.card('Cancel').click();
  await panel.q('[aria-label=Close]').click();
  await turn(() => panel.q('[data-add=LineString]').click());
  panel.marks.mapClick({ lat: 43, lng: -87 });
  panel.leaflet.setSize(1200, 800);
  panel.leaflet.setSize(390, 700);
  assert.match(panel.q('.viewer-mark-strip').textContent, /1 point/);
  panel.leaflet.setSize(1200, 800);
  await key('Escape');
  // The box alone stays.
  await key('l');
  panel.leaflet.setSize(390, 700);
  assert.equal(box().hidden, false);
});

test('one Marks pop-up: from the map, the sidebar or L; it holds the list, categories, deleted, coordinates and import', async t => {
  const { panel, add, box, key } = await open(t);
  await add('One');
  assert.equal(box().hidden, true);
  for (const selector of ['[role=tablist]', '[name=coordinates]', '[name=markSearch]', '.viewer-mark-category-form', '.viewer-mark-deleted']) assert.ok(box().contains(panel.q(selector)), selector);
  assert.ok(!box().contains(panel.q('[data-add=Point]')), 'the sidebar keeps the tools');
  for (const opener of [panel.q('[aria-label=Marks]'), panel.q('.viewer-mark-open')]) {
    await opener.click();
    assert.deepEqual([box().hidden, opener.getAttribute('aria-expanded')], [false, 'true']);
    assert.ok(focused(panel, panel.q('[data-tab=list]')));
    await panel.q('[aria-label="Close marks"]').click();
    assert.equal(box().hidden, true);
  }
  await key('l');
  assert.equal(box().hidden, false);
  await panel.show('One');
  assert.equal(box().hidden, false, 'on a wide screen it stays beside the card');
  await key('Escape');
  assert.deepEqual([panel.q('.viewer-mark-card').hidden, box().hidden], [true, false]);
  await key('Escape');
  assert.equal(box().hidden, true);
  await key('L', { target: panel.q('[name=markSearch]') });
  assert.equal(box().hidden, true, 'not while typing');
  // It also opens from a view without the map, where nothing can be placed.
  panel.marks.setView({ map: false });
  assert.equal(panel.q('[aria-label=Marks]').hidden, true);
  await panel.q('.viewer-mark-open').click();
  assert.equal(box().hidden, false);
});

test('what is hidden is said on the map and opens Categories', async t => {
  const { panel, add, box } = await open(t);
  const category = await panel.store.saveCategory({ name: 'Gates', color: '#1565c0', icon: 'gate' });
  for (let i = 0; i < 3; i += 1) await add('g' + i, i * 100, { categoryId: category.id });
  const pill = () => panel.q('.viewer-mark-hidden-count');
  assert.equal(pill().hidden, true);
  await panel.q(`[data-eye="${category.id}"]`).click();
  assert.deepEqual([pill().hidden, pill().textContent], [false, '3 hidden']);
  assert.ok(panel.overlay.children.includes(pill()), 'on the map, not inside the pop-up');
  await pill().click();
  assert.deepEqual([box().hidden, panel.q('[id=viewer-marks-categories]').hidden], [false, false]);
  panel.marks.setView({ map: false });
  assert.equal(pill().hidden, true);
});

test('on a phone one thing is open at a time, and an unsaved mark is never covered or lost', async t => {
  const { panel, add, box, key } = await open(t);
  await add('One');
  await add('Two', 300);
  panel.leaflet.setSize(390, 700);
  await panel.q('[aria-label=Marks]').click();
  assert.ok(box().classList.contains('sheet'));
  await panel.show('One');
  assert.deepEqual([box().hidden, panel.q('.viewer-mark-card').hidden], [true, false]);
  await key('l');
  assert.deepEqual([box().hidden, panel.q('.viewer-mark-card').hidden], [false, true]);
  await panel.q('.viewer-mark-add').click();
  assert.deepEqual([box().hidden, panel.q('.viewer-mark-strip').hidden], [true, false]);
  await key('l');
  assert.deepEqual([box().hidden, panel.q('.viewer-mark-strip').hidden], [false, true]);
  await key('l');
  await panel.open('One');
  await panel.type('[name=note]', 'Typing');
  await key('l');
  assert.deepEqual([box().hidden, panel.q('[name=note]').value], [true, 'Typing']);
  assert.match(panel.text(), /Save or cancel the open mark first/);
});

test('labels and grouping are remembered in this browser, and the old choice still counts', async t => {
  for (const [stored, expected] of [[null, 'selected'], ['on', 'on'], ['off', 'off'], ['nonsense', 'selected']]) {
    const { scope, mount } = await openMarksPanel(t);
    const localStorage = memoryStorage();
    if (stored) localStorage.setItem('ltds.viewer.marks.labels', stored);
    const panel = mount({ group: true, dom: createMiniDocument({ localStorage }) });
    await panel.marks.setScope(scope('client', 'client-a'));
    assert.equal(panel.q('[name=labels]').value, expected);
    panel.q('[name=labels]').value = 'on';
    await panel.q('[name=labels]').fire('change');
    panel.q('[name=group]').checked = false;
    await panel.q('[name=group]').fire('change');
    const again = mount({ group: true, dom: createMiniDocument({ localStorage }) });
    await again.marks.setScope(scope('client', 'client-a'));
    assert.deepEqual([again.q('[name=labels]').value, again.q('[name=group]').checked], ['on', false]);
  }
});

test('the next person starts with everything closed and nothing of the last one', async t => {
  const { panel, add, box, pick, scope } = await open(t);
  await add('Private one');
  await add('Private two', 4);
  await panel.q('[aria-label=Marks]').click();
  panel.leaflet.groups()[0].click();
  assert.equal(pick().hidden, false);
  for (const next of [scope('client', 'client-b'), { mode: 'temporary', key: 'public' }, null]) {
    await panel.marks.setScope(next);
    assert.deepEqual([box().hidden, pick().hidden, panel.leaflet.groups()], [true, true, []]);
    assert.doesNotMatch(panel.text() + panel.values(), /Private/);
  }
  panel.marks.dispose();
  assert.deepEqual(panel.overlay.children, []);
});

test('a delete that answers late leaves a list opened meanwhile alone', async t => {
  let held = null;
  const reached = Promise.withResolvers(), go = Promise.withResolvers();
  const { panel, add, pick } = await open(t, { request: async (path, init) => {
    if (held && init.method === 'DELETE') { reached.resolve(); await go.promise; }
    return fetch(path, { ...init, signal: undefined });
  } });
  for (const [name, x] of [['One', 0], ['Two', 5], ['Far', 400]]) await add(name, x);
  await panel.show('Far');
  held = true;
  let going = panel.card('Delete').click();
  const again = panel.card('Tap again to delete');
  if (again) going = again.click();
  await reached.promise;
  panel.leaflet.groups()[0].click();
  assert.equal(pick().hidden, false);
  go.resolve();
  await going;
  assert.equal(panel.store.state.marks.length, 2);
  assert.equal(pick().hidden, false);
});
