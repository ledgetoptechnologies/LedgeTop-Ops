import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_COLOR, MARK_COLORS, MARK_ICONS, PIN_BOX, colorName, contrast, glyphColor, pinSvg } from '../viewer-mark-icons.mjs';
import { areaCentre, createMarkMapLayer } from '../viewer-mark-map-layer.mjs';
import { FAR_OUT_ZOOM, ICONS_BY_GROUP, ICON_CHOICES, mapPin } from '../viewer-mark-style.mjs';
import { PROPERTY_LINE_STYLE } from '../property-lines-layer.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument } from './helpers/mini-dom.mjs';
import { createMiniLeaflet } from './helpers/mini-leaflet.mjs';

const M1_KEYS = ['pin', 'flag', 'star', 'tree', 'home', 'gate', 'ladder', 'feed', 'water', 'camera', 'warning', 'cross', 'target', 'tower', 'tent', 'vehicle', 'post', 'square'];
const U1_KEYS = ['blind', 'plot', 'trailcam', 'track', 'rub', 'bed', 'crossing', 'culvert', 'fence', 'park', 'trail', 'corner'];
const glyphOf = key => pinSvg(key, '#1565c0', 32).match(/stroke-linejoin="round"><path d="([^"]+)"/)[1];

test('every icon key already stored still draws, in one of three shapes, under generic groups and names', () => {
  for (const key of [...M1_KEYS, ...U1_KEYS]) assert.ok(Object.hasOwn(MARK_ICONS, key), key);
  for (const { shape, group, label, path } of Object.values(MARK_ICONS)) {
    assert.ok(['round', 'square', 'diamond'].includes(shape) && label && group);
    assert.match(path, /^[MLHVCSAZmlhvcsaz0-9 .,-]+$/);
  }
  assert.equal(new Set(Object.values(MARK_ICONS).map(icon => icon.path)).size, Object.keys(MARK_ICONS).length, 'no two icons share a drawing');
  assert.deepEqual(ICONS_BY_GROUP.map(({ group }) => group), ['General', 'Land', 'Access', 'Outdoors']);
  // Not all clients hunt: nothing in the picker is about it.
  for (const { label, group } of ICON_CHOICES) assert.doesNotMatch(label + ' ' + group, /hunt|deer|tree stand|blind|food plot|trail camera|sighting|rub|scrape|bedding/i);
  assert.deepEqual(ICON_CHOICES.map(icon => icon.name).sort(), Object.keys(MARK_ICONS).sort(), 'every icon can be picked');
  assert.deepEqual(ICON_CHOICES.map(icon => icon.group), ICONS_BY_GROUP.flatMap(({ group, icons }) => icons.map(() => group)), 'the category list has the same order');
  assert.equal(glyphOf('an-icon-from-later'), glyphOf('pin'), 'an unknown key is drawn as a dot');
});

test('every named colour reads: glyph 4.5 to 1, and orange is not the property line', () => {
  assert.equal(MARK_COLORS.length, 10);
  assert.equal(new Set(MARK_COLORS.map(item => item.color)).size, 10);
  for (const { name, color } of MARK_COLORS) {
    assert.ok(contrast(color, glyphColor(color)) >= 4.5, `${name} ${contrast(color, glyphColor(color)).toFixed(2)}`);
    assert.equal(colorName(color.toUpperCase()), name);
    assert.notEqual(color, PROPERTY_LINE_STYLE.color.toLowerCase());
  }
  assert.equal(DEFAULT_COLOR, MARK_COLORS[0].color);
  const orange = MARK_COLORS.find(item => item.name === 'Orange').color;
  assert.ok(contrast(orange, '#ffffff') > contrast(PROPERTY_LINE_STYLE.color, '#ffffff'), 'darker than the property line');
  // Colours from the first version stay as they are.
  for (const old of ['#ee5007', '#f8cb2e', '#00acc1', '#212121']) {
    assert.equal(colorName(old), 'Custom');
    assert.match(pinSvg('pin', old, 32), new RegExp(`fill="${old}"`));
  }
});

test('the tip of the pin sits on the point at every size', () => {
  const mark = { icon: 'gate', color: '#ffffff' };
  for (const [look, width] of [[{}, 32], [{ far: true }, 25], [{ selected: true }, 40], [{ selected: true, far: true }, 40], [{ draft: true }, 32]]) {
    const { size, anchor, labelOffset, html } = mapPin(mark, look);
    assert.deepEqual(size, [width, width * 1.25]);
    assert.deepEqual(anchor, [PIN_BOX.tipX * width / 32, PIN_BOX.tipY * width / 32]);
    assert.deepEqual(labelOffset, [0, -size[1]], 'the label is above the pin');
    assert.equal(html.includes('stroke-dasharray'), Boolean(look.draft));
    assert.equal(html.includes('<circle'), Boolean(look.selected), 'a dot on the point when selected');
  }
  const css = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(css, /\.viewer-map-mark::before \{[^}]*width:44px; height:44px;/);
  assert.doesNotMatch(css, /\.viewer-map-mark[^{]*\{[^}]*(ee5007|brand-orange)/);
});

function layerFixture(options = {}) {
  const { document } = createMiniDocument();
  const leaflet = createMiniLeaflet(document);
  const selected = [], moved = [];
  const layer = createMarkMapLayer({ L: leaflet.L, getMap: () => leaflet.map, onSelect: id => selected.push(id), onDraftMove: geometry => moved.push(geometry), ...options });
  const render = (marks, more = {}) => layer.render({ visible: true, marks, draft: null, selectedId: null, labels: false, preview: null, drawing: null, ...more });
  // The pin being placed has no name on the map; it is found by what it is spoken as.
  const pin = id => leaflet.pins().find(item => (item.label?.text ?? item.getElement().getAttribute('aria-label')) === id);
  return { document, leaflet, layer, render, pin, selected, moved };
}
const mark = (id, changes = {}) => ({ id, name: id, color: '#1565c0', icon: 'pin', geometry: { type: 'Point', coordinates: [-87, 43] }, ...changes });
const key = (element, name) => {
  let stopped = false;
  return element.fire('keydown', { key: name, stopPropagation() { stopped = true; } }).then(event => ({ prevented: event.defaultPrevented, stopped }));
};

test('a pin keeps its element while anything else changes, and 1000 pins are not redrawn for one', () => {
  const { leaflet, render, pin } = layerFixture();
  const many = Array.from({ length: 1000 }, (_, i) => mark('m' + i, { geometry: { type: 'Point', coordinates: [-87 + i / 1e5, 43] } }));
  render(many);
  assert.equal(leaflet.made.length, 1000);
  const elements = new Map(many.map(item => [item.id, pin(item.id).getElement()]));
  render(many, { preview: [-87, 43] });
  assert.equal(leaflet.made.length, 1001, 'only the preview circle is new');
  // Rename, restyle, move and select change the same element in place.
  const changed = { ...many[5], color: '#c62828', icon: 'gate', geometry: { type: 'Point', coordinates: [-87.5, 43.5] } };
  render(many.with(5, changed), { selectedId: 'm7', draft: { ...many[9], movable: true } });
  assert.equal(leaflet.made.length, 1001);
  for (const item of many) assert.equal(pin(item.id).getElement(), elements.get(item.id), item.id);
  assert.deepEqual(pin('m5').positions, [43.5, -87.5]);
  assert.match(pin('m5').options.icon.html, /#c62828/);
  // Hiding and deleting remove only those.
  render(many.slice(0, 990));
  assert.equal(leaflet.pins().length, 990);
  assert.equal(pin('m3').getElement(), elements.get('m3'));
});

test('selected and open pins are on top; the far-out size follows the zoom', () => {
  const { leaflet, render, pin } = layerFixture();
  const marks = [mark('a'), mark('b'), mark('c')];
  render(marks, { selectedId: 'b', draft: { ...marks[2], movable: false } });
  assert.equal(pin('a').options.zIndexOffset, 0);
  assert.ok(pin('b').options.zIndexOffset > 0 && pin('c').options.zIndexOffset > 0);
  assert.deepEqual(['a', 'b', 'c'].map(id => pin(id).options.icon.iconSize[0]), [32, 40, 40]);
  leaflet.setZoom(FAR_OUT_ZOOM - 0.5);
  assert.deepEqual(['a', 'b', 'c'].map(id => pin(id).options.icon.iconSize[0]), [25, 40, 40]);
  leaflet.setZoom(FAR_OUT_ZOOM);
  assert.equal(pin('a').options.icon.iconSize[0], 32);
  const made = leaflet.made.length;
  leaflet.setZoom(FAR_OUT_ZOOM + 2);
  assert.equal(leaflet.made.length, made);
});

test('pins are one tab stop: arrows move between them, Enter and Space open, the map does not pan', async () => {
  const { document, render, pin, selected } = layerFixture({ describe: item => `${item.name}, Gates, Blue` });
  const marks = ['a', 'b', 'c'].map(id => mark(id));
  render(marks);
  const stops = () => marks.map(({ id }) => pin(id).getElement().tabIndex);
  assert.deepEqual(stops(), [0, -1, -1]);
  assert.equal(pin('b').getElement().getAttribute('aria-label'), 'b, Gates, Blue');
  assert.deepEqual(await key(pin('a').getElement(), 'ArrowRight'), { prevented: true, stopped: true });
  assert.equal(document.activeElement, pin('b').getElement());
  assert.deepEqual(stops(), [-1, 0, -1]);
  await key(pin('b').getElement(), 'ArrowUp');
  await key(pin('a').getElement(), 'ArrowLeft');
  assert.equal(document.activeElement, pin('c').getElement(), 'wraps');
  for (const name of ['Enter', ' ']) assert.deepEqual(await key(pin('c').getElement(), name), { prevented: true, stopped: true });
  assert.deepEqual(selected, ['c', 'c']);
  assert.deepEqual(await key(pin('c').getElement(), 'Tab'), { prevented: false, stopped: false });
  // A redraw repaints icons (Leaflet makes each a tab stop again); there is still one, and focus is not moved.
  render(marks.map(item => ({ ...item, color: '#c62828' })));
  assert.deepEqual(stops(), [-1, -1, 0]);
  assert.equal(document.activeElement, pin('c').getElement());
  render(marks.slice(0, 2));
  assert.deepEqual(marks.slice(0, 2).map(({ id }) => pin(id).getElement().tabIndex), [0, -1], 'the stop moves on when its pin goes');
});

test('while drawing, pins take no input, and nothing is left behind when the map closes', () => {
  const { leaflet, layer, render, pin, selected } = layerFixture();
  render([mark('a')], { drawing: { type: 'LineString', positions: [[-87, 43]], color: '#1565c0' } });
  assert.equal(pin('a').options.interactive, false);
  pin('a').click();
  assert.deepEqual(selected, []);
  render([mark('a')]);
  pin('a').click();
  assert.deepEqual(selected, ['a']);
  render([mark('a')], { visible: false });
  assert.deepEqual(leaflet.drawn(), []);
  assert.deepEqual(Object.values(leaflet.mapHandlers).map(handlers => handlers.size), [0, 0]);
  render([mark('a')]);
  assert.equal(leaflet.pins().length, 1);
  layer.dispose();
  assert.deepEqual(leaflet.drawn(), []);
});

test('lines and areas have a dark casing, an area has its glyph in the middle, and corners move both', () => {
  const { leaflet, render, moved } = layerFixture();
  const ring = [[-87, 43], [-86.99, 43], [-86.99, 43.01], [-87, 43.01], [-87, 43]];
  const area = mark('area', { icon: 'water', geometry: { type: 'Polygon', coordinates: [ring] } });
  const line = mark('line', { geometry: { type: 'LineString', coordinates: [[-87, 43], [-86.9, 43.1]] } });
  render([area, line]);
  const shapes = leaflet.drawn().filter(item => ['polygon', 'polyline'].includes(item.kind));
  assert.deepEqual(shapes.map(item => [item.kind, item.options.color, item.options.interactive]), [['polygon', '#0b0d10', false], ['polygon', '#1565c0', true],
    ['polyline', '#0b0d10', false], ['polyline', '#1565c0', true]]);
  assert.ok(shapes[0].options.weight > shapes[1].options.weight);
  assert.equal(shapes[0].options.fill, false);
  const [glyph] = leaflet.areaGlyphs();
  assert.equal(leaflet.areaGlyphs().length, 1);
  assert.ok(Math.abs(glyph.positions[0] - 43.005) < 1e-9 && Math.abs(glyph.positions[1] + 86.995) < 1e-9);
  assert.equal(glyph.options.interactive, false);
  render([area, line], { draft: { ...area, movable: true } });
  const corners = leaflet.corners();
  assert.equal(corners.length, 4);
  corners[2].drag(43.02, -86.98);
  assert.deepEqual(moved.at(-1).coordinates[0][2], [-86.98, 43.02]);
  for (const item of leaflet.drawn().filter(row => row.kind === 'polygon')) assert.deepEqual(item.positions[2], [43.02, -86.98], 'casing and line together');
  // Not a rectangle, and a shape with no area.
  const triangle = areaCentre([[0, 0], [3, 0], [0, 3]]);
  assert.ok(Math.abs(triangle[0] - 1) < 1e-9 && Math.abs(triangle[1] - 1) < 1e-9);
  assert.deepEqual(areaCentre([[1, 1], [2, 2], [3, 3]]), [1, 1]);
});

test('in the panel: opening a pin keeps its element, and clicking it again keeps what is typed', async t => {
  const { mount, scope } = await openMarksPanel(t);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  await panel.store.saveCategory({ name: 'Gates', color: '#2e7d32', icon: 'gate' });
  const category = panel.store.state.categories[0];
  await panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Main gate', color: '#1565c0', icon: 'gate', note: '', categoryId: category.id });
  const pin = panel.leaflet.pins()[0], element = pin.getElement();
  assert.equal(element.getAttribute('aria-label'), 'Main gate, Gates, Blue');
  pin.click();
  assert.equal(panel.leaflet.pins()[0].getElement(), element);
  assert.equal(panel.leaflet.pins()[0].options.icon.iconSize[0], 40);
  await panel.type('[name=name]', 'Typed');
  panel.leaflet.pins()[0].click();
  assert.equal(panel.q('[name=name]').value, 'Typed');
  assert.equal(panel.dom.document.activeElement, panel.q('[name=name]'));
  await panel.q('.viewer-mark-swatch[data-color="#c62828"]').click();
  await panel.q('[data-icon=warning]').click();
  await panel.save();
  assert.equal(panel.leaflet.pins()[0].getElement(), element, 'still the same pin after Save');
  assert.equal(element.getAttribute('aria-label'), 'Typed, Gates, Red');
  assert.deepEqual([panel.store.state.marks[0].icon, panel.store.state.marks[0].color], ['warning', '#c62828']);
  // Colours are spoken by name, and every icon is under its group.
  assert.deepEqual(panel.panel.querySelectorAll('.viewer-mark-swatch').map(node => node.getAttribute('aria-label')), MARK_COLORS.map(item => item.name));
  assert.deepEqual(panel.panel.querySelectorAll('.viewer-mark-icon-group').map(node => node.textContent), ['General', 'Land', 'Access', 'Outdoors']);
  assert.equal(panel.panel.querySelectorAll('.viewer-mark-icon').length, Object.keys(MARK_ICONS).length);
});

test('a pin not saved yet is no tab stop and takes no keys; the saved ones keep theirs', async () => {
  const { document, leaflet, layer, pin, selected } = layerFixture();
  const render = draft => layer.render({ visible: true, marks: [mark('a'), mark('b')], draft, selectedId: null, labels: false, preview: null, drawing: null });
  render({ ...mark('__draft__'), name: 'Draft', movable: true });
  const draft = pin('Draft');
  assert.equal(draft.options.keyboard, false);
  assert.equal(draft.getElement().tabIndex, undefined, 'Leaflet gives it no tab stop');
  assert.equal(draft.options.draggable, true, 'it can still be placed with the pointer');
  assert.deepEqual([pin('a').getElement().tabIndex, pin('b').getElement().tabIndex], [0, -1]);
  await key(pin('a').getElement(), 'ArrowRight');
  assert.equal(document.activeElement, pin('b').getElement());
  await key(pin('b').getElement(), 'ArrowRight');
  assert.equal(document.activeElement, pin('a').getElement(), 'the arrows pass it by');
  await key(draft.getElement(), 'Enter');
  draft.click();
  assert.deepEqual(selected, []);
  // Restyled while being placed: still none.
  render({ ...mark('__draft__'), name: 'Draft', color: '#c62828', movable: true });
  assert.equal(pin('Draft').getElement().tabIndex, undefined);
  // With nothing else there is no stop to find.
  layer.render({ visible: true, marks: [], draft: { ...mark('__draft__'), name: 'Draft', movable: true }, selectedId: null, labels: false, preview: null, drawing: null });
  assert.equal(leaflet.pins().length, 1);
});

test('a removed or replaced marker keeps no handlers', async () => {
  const { leaflet, layer, render, pin, selected, moved } = layerFixture();
  const ring = [[-87, 43], [-86.99, 43], [-86.99, 43.01], [-87, 43]];
  const area = mark('area', { geometry: { type: 'Polygon', coordinates: [ring] } });
  const dead = [];
  const keep = () => { for (const item of leaflet.drawn()) if (!dead.includes(item)) dead.push(item); };
  const steps = [
    () => render([mark('a'), mark('b'), area], { draft: { ...mark('b'), movable: true } }),
    () => render([mark('a'), area], { draft: { ...area, movable: true } }), // b hidden, corners shown
    () => render([mark('a'), area]), // corners gone, area redrawn
    () => render([mark('a'), area], { drawing: { type: 'LineString', positions: [[-87, 43]], color: '#1565c0' } }), // markers replaced by ones that take no input
    () => render([mark('a', { geometry: area.geometry }), area]), // a point became an area
    () => render([area], { visible: false }),
  ];
  for (const step of steps) { step(); keep(); }
  for (const item of dead) {
    assert.deepEqual(Object.values(item.handlers).flat(), [], item.kind);
    assert.equal(item.label, null);
    item.click();
    if (item.element) {
      for (const name of ['Enter', 'ArrowRight']) assert.deepEqual(await key(item.element, name), { prevented: false, stopped: false });
      await item.element.fire('focus');
    }
  }
  assert.deepEqual([selected, moved], [[], []]);
  // Live ones still work, once each.
  render([mark('a'), mark('b')]);
  pin('a').click();
  await key(pin('b').getElement(), 'Enter');
  assert.deepEqual(selected, ['a', 'b']);
  for (let i = 0; i < 5; i += 1) render([mark('a', { color: i % 2 ? '#c62828' : '#1565c0' }), mark('b')]);
  pin('a').click();
  assert.deepEqual(selected, ['a', 'b', 'a'], 'redrawing adds no second handler');
  layer.dispose();
  for (const item of leaflet.made) assert.deepEqual(Object.values(item.handlers).flat(), []);
});

test('a pin being placed has no name on the map, not even on hover', () => {
  const { leaflet, layer, pin } = layerFixture();
  for (const labels of [false, true]) {
    layer.render({ visible: true, marks: [mark('a')], draft: { ...mark('__draft__'), name: 'Pin', movable: true }, selectedId: null, labels, preview: null, drawing: null });
    const draft = leaflet.pins().find(item => item.options.icon.className.includes('draft'));
    assert.equal(draft.label, null);
    assert.ok(!leaflet.shown().includes('Pin'), 'what is being typed is in the editor');
    assert.equal(pin('a').label.text, 'a');
  }
});

test('labels that are on stay through focus and blur, and redrawing binds nothing again', async () => {
  const { leaflet, render, pin } = layerFixture();
  const area = mark('area', { geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-86.99, 43], [-86.99, 43.01], [-87, 43]]] } });
  render([mark('a'), area], { labels: false });
  assert.deepEqual(leaflet.shown(), []);
  render([mark('a'), area], { labels: true });
  assert.deepEqual(leaflet.shown(), ['a', 'area']);
  const element = pin('a').getElement();
  for (const type of ['focus', 'blur', 'focus']) {
    await element.fire(type);
    assert.deepEqual(leaflet.shown(), ['a', 'area'], type);
  }
  assert.equal(pin('a').label.open, false, 'its name is not shown twice');
  for (let i = 0; i < 10; i += 1) render([mark('a', { name: 'a' + i, color: i % 2 ? '#c62828' : '#1565c0' }), area], { labels: i % 2 === 0, selectedId: i % 3 ? 'a' : null });
  assert.equal(pin('a9').binds, 1);
  assert.equal(pin('a9').label.text, 'a9', 'renamed in place');
  render([mark('a', { name: 'Moved', geometry: { type: 'Point', coordinates: [-87.5, 43.5] } })], { labels: true });
  const [kept] = leaflet.drawn().filter(item => item.kind === 'tooltip');
  assert.deepEqual([leaflet.shown(), kept.positions], [['Moved'], [43.5, -87.5]]);
  render([]);
  assert.deepEqual(leaflet.shown(), []);
  render([mark('a')], { labels: false });
  await pin('a').getElement().fire('focus');
  assert.equal(pin('a').label.open, true, 'with labels off the name still comes on hover and focus');
});
