import assert from 'node:assert/strict';
import test from 'node:test';
import { STARTER_CATEGORIES } from '../viewer-mark-style.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';

async function open(t, { coarse = false, permissions, mount: options = {} } = {}) {
  const setup = await openMarksPanel(t);
  const panel = setup.mount(options);
  panel.dom.window.matchMedia = query => ({ matches: coarse && query.includes('coarse') });
  await panel.marks.setScope(setup.scope('client', 'client-a', permissions ? { permissions } : {}));
  setup.requests.length = 0;
  const strip = text => panel.q('.viewer-mark-strip').querySelectorAll('button').find(node => node.textContent === text);
  const chips = () => panel.q('.viewer-mark-chips').children.map(chip => chip.textContent);
  const chip = name => panel.q('.viewer-mark-chips').children.find(node => node.textContent === name);
  const key = (name, more = {}) => panel.dom.window.fire('keydown', { key: name, ...more });
  const keyIn = (selector, name) => panel.q(selector).fire('keydown', { key: name }).then(event => (event.defaultPrevented ? event : panel.dom.window.fire('keydown', { key: name, target: panel.q(selector) })));
  return { ...setup, panel, strip, chips, chip, key, keyIn, add: () => panel.q('.viewer-mark-add'), form: () => panel.q('.viewer-mark-form'),
    category: (name, icon = 'flag', color = '#1565c0') => panel.store.saveCategory({ name, color, icon }),
    mark: (name, changes = {}) => panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name, color: '#1565c0', icon: 'pin', note: '', ...changes }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const focused = (panel, node) => panel.dom.document.activeElement === node;

test('+ picks a spot with the pointer, a click opens a draft there, and nothing is saved before Save', async t => {
  const { panel, add, form, strip, requests } = await open(t);
  await add().click();
  assert.equal(add().hidden, true);
  assert.match(panel.q('.viewer-mark-strip').textContent, /^Add pin/);
  assert.equal(panel.q('.viewer-mark-cross').hidden, true);
  assert.equal(strip('Place here').hidden, true);
  assert.deepEqual(panel.leaflet.ghosts(), [], 'until the pointer is on the map');
  panel.leaflet.fire('mousemove', { latlng: { lat: 43.01, lng: -87.01 } });
  panel.leaflet.fire('mousemove', { latlng: { lat: 43.02, lng: -87.02 } });
  assert.deepEqual(panel.leaflet.ghosts().map(ghost => [ghost.positions, ghost.options.interactive]), [[{ lat: 43.02, lng: -87.02 }, false]]);
  assert.equal(panel.marks.mapClick({ lat: 43.02, lng: -87.02 }), true);
  assert.deepEqual([form().hidden, panel.q('[name=name]').value, panel.leaflet.ghosts().length], [false, 'Pin', 0]);
  assert.ok(focused(panel, panel.q('[name=name]')), 'the name is ready to type over');
  assert.deepEqual(requests, []);
  await panel.save();
  assert.deepEqual(panel.store.state.marks[0].geometry.coordinates, [-87.02, 43.02]);
  assert.ok(focused(panel, panel.leaflet.pins()[0].getElement()), 'focus goes to the new pin');
  assert.equal(add().hidden, false);
});

test('names count up, and follow the category until they are typed', async t => {
  const { panel, add, category, chip } = await open(t);
  const gates = await category('Gates', 'gate'), water = await category('Water', 'water');
  const place = async choice => { await add().click(); if (choice) await chip(choice).click(); panel.marks.mapClick({ lat: 43, lng: -87 }); };
  for (const expected of ['Pin', 'Pin 2', 'Pin 3']) { await place(); assert.equal(panel.q('[name=name]').value, expected); await panel.save(); }
  for (const expected of ['Gates', 'Gates 2']) { await place('Gates'); assert.equal(panel.q('[name=name]').value, expected); await panel.save(); }
  await place('Gates');
  assert.deepEqual([panel.q('[name=categoryId]').value, panel.q('[name=color]').value], [gates.id, '#1565c0']);
  const choose = async id => { panel.q('[name=categoryId]').value = id; await panel.q('[name=categoryId]').fire('change'); };
  await choose(water.id);
  assert.equal(panel.q('[name=name]').value, 'Water', 'not typed yet, so it follows');
  await panel.type('[name=name]', 'Spring');
  await choose(gates.id);
  assert.equal(panel.q('[name=name]').value, 'Spring');
  await panel.save();
  assert.equal(panel.store.state.marks.at(-1).name, 'Spring');
});

test('the last three categories used come first; suggestions and no category are there too', async t => {
  const { panel, add, category, mark, chips, chip } = await open(t);
  await add().click();
  assert.deepEqual(chips(), [...STARTER_CATEGORIES.map(starter => starter.name), 'No category']);
  assert.equal(chip('No category').getAttribute('aria-pressed'), 'true');
  await panel.q('.viewer-mark-strip').querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
  const made = {};
  for (const name of ['A', 'B', 'C', 'D', 'E']) made[name] = await category(name);
  for (const name of ['B', 'D', 'A', 'E']) { await mark('m' + name, { categoryId: made[name].id }); await settle(); }
  await add().click();
  assert.deepEqual(chips(), ['E', 'A', 'D', 'B', 'C', 'No category']);
  // With just one category shown, that is the one to place into.
  await panel.q('.viewer-mark-strip').querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
  await panel.q(`[data-only="${made.C.id}"]`).click();
  await add().click();
  assert.equal(chip('C').getAttribute('aria-pressed'), 'true');
  chip('D').focus();
  await chip('D').click();
  assert.ok(focused(panel, chip('D')), 'focus stays on the chip');
  panel.marks.mapClick({ lat: 43, lng: -87 });
  await panel.save();
  assert.ok(panel.leaflet.pins().some(pin => pin.label.text === 'D'), 'placed into a hidden category, so it is shown again');
});

test('Place several saves each click, stays, and takes back the last one', async t => {
  const { panel, add, strip, chip, requests, database } = await open(t);
  await add().click();
  await chip('Hazard').click();
  await strip('Place several').click();
  for (const lng of [-87, -87.01, -87.02]) { panel.marks.mapClick({ lat: 43, lng }); await settle(); }
  assert.deepEqual(panel.store.state.marks.map(mark => mark.name), ['Hazard', 'Hazard 2', 'Hazard 3']);
  assert.equal(database.prepare('SELECT count(*) n FROM viewer_mark_categories').get().n, 1, 'the suggestion is made once');
  assert.deepEqual(requests.map(([method]) => method), ['POST', 'POST', 'POST', 'POST']);
  assert.match(panel.q('.viewer-mark-strip').textContent, /Hazard 3 added/);
  assert.equal(panel.q('.viewer-mark-card').hidden, true);
  await panel.q('.viewer-mark-strip').querySelectorAll('button').find(node => node.textContent === 'Undo').click();
  assert.deepEqual(panel.store.state.marks.map(mark => mark.name), ['Hazard', 'Hazard 2']);
  assert.equal(strip('Place several').getAttribute('aria-pressed'), 'true', 'still placing');
  await strip('Cancel').click();
  assert.equal(panel.q('.viewer-mark-strip').hidden, true);
  await add().click();
  assert.equal(strip('Place several').getAttribute('aria-pressed'), 'false', 'off for the next time');
});

test('Place several: a click that cannot be saved says why and keeps the mode; a lost scope ends it', async t => {
  let fail = false;
  const { panel, add, strip, scope } = await open(t, { mount: { request: (path, init) => (fail && init.method === 'POST'
    ? Promise.resolve(new Response(JSON.stringify({ code: 'mark_limit_reached' }), { status: 429 })) : fetch(path, init)) } });
  await add().click();
  await strip('Place several').click();
  fail = true;
  panel.marks.mapClick({ lat: 43, lng: -87 });
  await settle();
  assert.deepEqual(panel.store.state.marks, []);
  assert.match(panel.text(), /limit/);
  assert.equal(panel.q('.viewer-mark-strip').hidden, false);
  fail = false;
  panel.marks.mapClick({ lat: 43, lng: -87 });
  await panel.marks.setScope(scope('client', 'client-b'));
  await settle();
  assert.equal(panel.q('.viewer-mark-strip').hidden, true);
  assert.deepEqual(panel.store.state.marks, []);
  assert.doesNotMatch(panel.q('.viewer-mark-strip').textContent, /added/);
});

test('touch: the map moves under a fixed cross and Place here places; a tap only pans', async t => {
  const { panel, add, strip, form, requests } = await open(t, { coarse: true });
  await add().click();
  assert.equal(panel.q('.viewer-mark-cross').hidden, false);
  assert.deepEqual(panel.leaflet.ghosts(), []);
  assert.equal(panel.marks.mapClick({ lat: 43.5, lng: -87.5 }), true, 'the tap is taken');
  assert.equal(form().hidden, true);
  panel.leaflet.map.setView([43.25, -87.25]);
  await strip('Place here').click();
  assert.equal(form().hidden, false);
  assert.deepEqual(requests, []);
  await panel.save();
  assert.deepEqual(panel.store.state.marks[0].geometry.coordinates, [-87.25, 43.25]);
  await add().click();
  await strip('Place several').click();
  await strip('Place here').click();
  await strip('Place here').click();
  assert.equal(panel.store.state.marks.length, 3);
});

test('keyboard: M, arrows and Enter place; Escape backs out; the map keys are given back', async t => {
  const { panel, form, key, requests } = await open(t);
  const map = panel.leaflet;
  assert.equal((await key('m')).defaultPrevented, true);
  assert.deepEqual([panel.q('.viewer-mark-cross').hidden, map.keyboard.on], [false, false]);
  const before = map.centre();
  await key('ArrowRight');
  await key('ArrowUp', { shiftKey: true });
  assert.ok(map.centre().lng > before.lng && map.centre().lat - before.lat > map.centre().lng - before.lng, 'arrows move the map under the cross');
  await key('Escape');
  assert.deepEqual([panel.q('.viewer-mark-strip').hidden, map.keyboard.on], [true, true]);
  await key('M');
  await key('Enter');
  assert.deepEqual([form().hidden, map.keyboard.on], [false, true]);
  assert.ok(focused(panel, panel.q('[name=name]')));
  const { lat, lng } = map.centre();
  await panel.save();
  assert.deepEqual(panel.store.state.marks[0].geometry.coordinates, [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8]);
  // Enter on a button is that button's own.
  await key('m');
  await key('Enter', { target: panel.q('.viewer-mark-strip').querySelectorAll('button')[0] });
  assert.equal(form().hidden, true);
  await key('Escape');
  // Not while typing, with modifiers, in a dialog, without the map, or already handled.
  requests.length = 0;
  const box = panel.dom.document.createElement('input'), dialog = panel.dom.document.createElement('dialog');
  dialog.setAttribute('open', '');
  for (const more of [{ target: box }, { target: dialog }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    await key('m', more);
    assert.equal(panel.q('.viewer-mark-strip').hidden, true, Object.keys(more)[0]);
  }
  panel.marks.setView({ map: false });
  await key('m');
  assert.equal(panel.q('.viewer-mark-strip').hidden, true);
});

test('a login that cannot keep marks is offered no way to add one', async t => {
  const { panel, add, key } = await open(t, { permissions: { view: true, measure: true } });
  assert.equal(add().hidden, true);
  await add().click();
  await key('m');
  assert.equal(panel.marks.mapContextMenu({ lat: 43, lng: -87 }), false);
  assert.equal(panel.q('.viewer-mark-strip').hidden, true);
  assert.equal(panel.q('.viewer-mark-card').hidden, true);
});

test('right-click, or holding a finger, opens a draft and saves nothing; Cancel leaves no trace', async t => {
  const { panel, form, requests } = await open(t);
  assert.equal(panel.marks.mapContextMenu({ lat: 43.1, lng: -87.1 }), true);
  assert.equal(form().hidden, false);
  assert.deepEqual(panel.leaflet.pins()[0].positions, [43.1, -87.1]);
  // A second one does not throw away the first.
  await panel.type('[name=note]', 'Typed');
  assert.equal(panel.marks.mapContextMenu({ lat: 43.2, lng: -87.2 }), true);
  assert.equal(panel.q('[name=note]').value, 'Typed');
  assert.match(panel.text(), /Save or cancel the open mark first/);
  await panel.card('Cancel').click();
  assert.deepEqual([form().hidden, panel.leaflet.pins().length, requests], [true, 0, []]);
  assert.equal(panel.dom.window.sessionStorage.items.size, 0);
  // While a spot is being picked it is the map's own.
  await panel.q('.viewer-mark-add').click();
  assert.equal(panel.marks.mapContextMenu({ lat: 43, lng: -87 }), false);
});

test('opening another pin does not lose what is being typed', async t => {
  const { panel, mark, key } = await open(t);
  await mark('One');
  await mark('Two');
  await panel.open('One');
  await panel.show('Two');
  assert.match(panel.q('.viewer-mark-view').textContent, /Two/, 'nothing typed: it opens');
  await panel.open('One');
  await panel.type('[name=note]', 'Half a note');
  for (const attempt of [() => panel.show('Two'), () => panel.leaflet.pins().find(pin => pin.label?.text === 'Two').click(), () => panel.place('43.1, -87.1'),
    () => panel.button('Undo').click(), () => key('m')]) {
    await attempt();
    assert.equal(panel.q('[name=note]').value, 'Half a note');
    assert.equal(panel.q('.viewer-mark-form').hidden, false);
  }
  await panel.card('Cancel').click();
  assert.match(panel.q('.viewer-mark-view').textContent, /One/);
  assert.equal(panel.store.state.marks.find(row => row.name === 'One').note, '');
});

test('the card shows what a mark is, as text, and only actions that are allowed', async t => {
  const { panel, category, mark, scope, mount } = await open(t);
  const gates = await category('Gates <b>', 'gate');
  await mark('Main <i>gate</i>', { categoryId: gates.id, note: 'Line one\nLine <b>two</b>', elevationNavd88M: 250, visibility: 'staff' });
  await panel.show('Main');
  const view = panel.q('.viewer-mark-view');
  assert.equal(panel.q('.viewer-mark-card').getAttribute('aria-label'), 'Main <i>gate</i>');
  assert.match(view.textContent, /Main <i>gate<\/i>Gates <b>/);
  assert.match(view.textContent, /Line one\nLine <b>two<\/b>/);
  assert.deepEqual(panel.q('.viewer-mark-facts').children.map(node => node.textContent).filter((_, i) => i !== 3),
    ['Visible to', 'Me and project staff', 'Coordinates', 'NAVD88 Elevation', '820.21 ft']);
  assert.ok(focused(panel, panel.card('Edit')));
  await panel.q('[aria-label=Close]').click();
  assert.equal(panel.q('.viewer-mark-card').hidden, true);
  assert.ok(focused(panel, panel.leaflet.pins()[0].getElement()), 'focus goes back to the pin');
  assert.equal(panel.q('.viewer-mark-view').textContent.includes('Main'), false);

  const staff = mount();
  await staff.marks.setScope(scope('ops', 'staff-person'));
  await staff.show('Main');
  assert.match(staff.q('.viewer-mark-view').textContent, /Gates <b> · From a client/);
  assert.doesNotMatch(staff.q('.viewer-mark-facts').textContent, /Visible to/);
  assert.ok(focused(staff, staff.q('[aria-label=Close]')), 'the only thing to do');
  // The map going away takes the card with it, and nothing stays for the next person.
  staff.marks.setView({ map: false });
  assert.equal(staff.q('.viewer-mark-card').hidden, true);
  staff.marks.setView({ map: true });
  await staff.marks.setScope(scope('ops', 'someone-else', { modelId: 'other-model' }));
  assert.doesNotMatch(staff.overlay.textContent, /Main|Gates/);
  assert.equal(staff.q('.viewer-mark-card').getAttribute('aria-label'), 'Mark');
});

test('a mark that goes away takes its card with it', async t => {
  const { panel, mark, mount, scope } = await open(t);
  const one = await mark('One');
  await panel.show('One');
  const other = mount();
  await other.marks.setScope(scope('client', 'client-a'));
  await other.store.remove(other.store.find(one.id));
  await panel.store.refresh();
  assert.equal(panel.q('.viewer-mark-card').hidden, true);
  await mark('Two');
  assert.equal(panel.q('.viewer-mark-card').hidden, true);
});

test('the card is beside its pin on a wide map and a sheet below it on a narrow one', async t => {
  const { panel, mark } = await open(t);
  await mark('Centre');
  await mark('East', { geometry: { type: 'Point', coordinates: [-86.9955, 43] } });
  await mark('South', { geometry: { type: 'Point', coordinates: [-87, 42.9965] } });
  const card = panel.q('.viewer-mark-card'), style = () => [parseFloat(card.style.left), parseFloat(card.style.top)];
  await panel.show('Centre');
  panel.leaflet.map.setView([43, -87]);
  panel.leaflet.fire('move');
  assert.deepEqual(style(), [528, 340]);
  assert.equal(card.classList.contains('sheet'), false);
  await panel.leaflet.pins().find(pin => pin.label.text === 'East').click();
  assert.ok(style()[0] < 950 - 300, 'no room on the right: on the left');
  await panel.leaflet.pins().find(pin => pin.label.text === 'South').click();
  assert.ok(style()[1] + 260 <= 800, 'kept on the map');
  // Narrow: a sheet, taller while editing, with the pin above it.
  panel.leaflet.setSize(390, 700);
  assert.deepEqual([card.classList.contains('sheet'), card.classList.contains('full'), card.style.left], [true, false, '']);
  await panel.q('[aria-label=Close]').click();
  panel.leaflet.map.setView([43, -87]);
  panel.leaflet.pins().find(pin => pin.label.text === 'South').click();
  const point = panel.leaflet.map.latLngToContainerPoint([42.9965, -87]);
  assert.ok(point.y <= 700 * 0.54, 'the map moved so the pin is above the sheet');
  await panel.card('Edit').click();
  assert.equal(card.classList.contains('full'), true);
  panel.leaflet.setSize(1000, 800);
  assert.equal(card.classList.contains('sheet'), false);
});

test('the picker searches, previews, uses the category style and closes before the editor does', async t => {
  const { panel, category, key, keyIn } = await open(t);
  const water = await category('Ponds', 'water', '#00707a');
  await panel.place('43.05, -87');
  const toggle = panel.q('.viewer-mark-style'), body = panel.q('.viewer-mark-picker');
  assert.deepEqual([body.hidden, toggle.getAttribute('aria-expanded'), toggle.textContent], [true, 'false', 'Icon and colour: Dot, Charcoal']);
  await toggle.click();
  assert.equal(body.hidden, false);
  assert.ok(focused(panel, panel.q('[name=iconSearch]')));
  const shown = () => panel.panel.querySelectorAll('.viewer-mark-icon').filter(button => !button.hidden).map(button => button.getAttribute('aria-label'));
  const headings = () => panel.panel.querySelectorAll('.viewer-mark-icon-group').filter(node => !node.hidden).map(node => node.textContent);
  await panel.type('[name=iconSearch]', 'GAT');
  assert.deepEqual([shown(), headings()], [['Gate'], ['Access']]);
  await panel.type('[name=iconSearch]', 'outdoors');
  assert.equal(shown().length, 8);
  await panel.type('[name=iconSearch]', 'zzz');
  assert.deepEqual([shown(), headings()], [[], []]);
  assert.match(body.textContent, /No icon by that name/);
  await panel.type('[name=iconSearch]', '');
  await panel.q('[data-icon=gate]').click();
  await panel.q('.viewer-mark-swatch[data-color="#c62828"]').click();
  assert.equal(toggle.textContent, 'Icon and colour: Gate, Red');
  assert.equal(panel.q('[data-icon=gate]').getAttribute('aria-pressed'), 'true');
  panel.q('[name=categoryId]').value = water.id;
  await panel.q('[name=categoryId]').fire('change');
  await panel.q('[data-icon=star]').click();
  const use = panel.q('.viewer-mark-picker').querySelectorAll('button').find(node => node.textContent === 'Use category style');
  await use.click();
  assert.equal(toggle.textContent, 'Icon and colour: Water, Teal');
  // One step at a time, also from inside a field.
  await panel.type('[name=iconSearch]', 'x');
  await keyIn('[name=iconSearch]', 'Escape');
  assert.deepEqual([body.hidden, panel.q('.viewer-mark-form').hidden, panel.q('[name=iconSearch]').value], [true, false, '']);
  await keyIn('[name=name]', 'Escape');
  assert.equal(panel.q('.viewer-mark-form').hidden, true);
  assert.equal((await key('Escape')).defaultPrevented, false, 'nothing left to close');

  await panel.q('[data-add=LineString]').click();
  for (const lng of [-87, -87.1]) panel.marks.mapClick({ lat: 43, lng });
  panel.marks.mapDoubleClick();
  await toggle.click();
  assert.equal(panel.q('.viewer-mark-icons').hidden, true, 'a line has no icon');
  assert.equal(toggle.textContent, 'Icon and colour: Charcoal');
});

test('Coordinates, elevation and sharing are under More, which opens when one of them is wrong', async t => {
  const { panel } = await open(t);
  await panel.place('43.05, -87');
  const more = panel.q('.viewer-mark-more');
  for (const name of ['pointCoordinates', 'elevation', 'visibility']) assert.ok(more.contains(panel.q(`[name=${name}]`)), name);
  assert.ok(!more.contains(panel.q('[name=name]')) && !more.contains(panel.q('[name=note]')));
  await panel.type('[name=elevation]', 'high');
  await panel.save();
  assert.equal(more.open, true);
  assert.match(panel.q('.viewer-mark-card-message').textContent, /must be a number/, 'said on the card, not only in the sidebar');
});

test('taking the panel away takes its pop-ups away', async t => {
  const { panel, mark } = await open(t);
  await mark('One');
  await panel.show('One');
  panel.marks.dispose();
  assert.deepEqual(panel.overlay.children, []);
  await panel.dom.window.fire('keydown', { key: 'm' });
});
