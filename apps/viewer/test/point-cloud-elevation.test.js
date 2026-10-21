const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { validRange, automaticRange, createElevationRangeController } = require('../public/pointcloud-elevation.js');

function controllerFixture() {
  let bounds = { min: { z: 200 }, max: { z: 250 } };
  const materials = [{ activeAttributeName: 'rgba', clipBoxes: [], elevationRange: [0, 0] }];
  const controller = createElevationRangeController({ getBounds: () => bounds, getMaterials: () => materials });
  controller.refresh();
  return { controller, materials, setBounds(value) { bounds = value; } };
}

test('elevation range is finite, ordered, nonzero and preserves flat clouds', () => {
  for (const values of [[1, 1], [2, 1], [NaN, 1], [1, Infinity], ['1', 2], [0, 0.00000001],
    [1e300, 2e300], [200, 200.000001]]) assert.equal(validRange(...values), false);
  assert.equal(validRange(-20, 5), true);
  assert.deepEqual(automaticRange({ min: { z: 5 }, max: { z: 5 } }), { min: 4.5, max: 5.5 });
  assert.equal(automaticRange({ min: { z: 9 }, max: { z: 8 } }), null);
  assert.equal(automaticRange(null), null);
});

test('manual elevation modifies paired color uniform only; auto restores world-height bounds', () => {
  const { controller, materials } = controllerFixture();
  assert.deepEqual(materials[0].elevationRange, [200, 250]);
  assert.equal(controller.setRange(210, 220), true);
  assert.deepEqual(materials[0].elevationRange, [210, 220]);
  assert.equal(controller.state().automatic, false);
  assert.equal(materials[0].activeAttributeName, 'rgba', 'range changes do not switch color mode');
  assert.deepEqual(materials[0].clipBoxes, [], 'color range never filters points');
  assert.equal(controller.setRange(230, 210), false);
  assert.deepEqual(materials[0].elevationRange, [210, 220]);
  assert.equal(controller.reset().automatic, true);
  assert.deepEqual(materials[0].elevationRange, [200, 250]);
});

test('late materials inherit retained manual range and unavailable metadata never creates NaN colors', () => {
  const { controller, materials, setBounds } = controllerFixture();
  controller.setRange(205, 225);
  materials.push({ elevationRange: [0, 0] });
  controller.refresh();
  assert.deepEqual(materials[1].elevationRange, [205, 225]);
  setBounds(null);
  assert.equal(controller.reset().available, false);
  assert.deepEqual(materials[1].elevationRange, [205, 225], 'keep last valid uniforms until bounds exist');
});

function panelFixture(units = 'imperial') {
  const { controller, materials } = controllerFixture();
  let current = controller;
  const ids = ['pc2-elevation-controls', 'pc2-color', 'pc2-elevation-min-label', 'pc2-elevation-max-label',
    'pc2-elevation-min', 'pc2-elevation-max', 'pc2-elevation-low', 'pc2-elevation-high', 'pc2-elevation-reset',
    'pc2-elevation-status', 'pc2-budget', 'pc2-size', 'pc2-edl', 'pc2-budget-val', 'pc2-size-val', 'pc2-fit', 'pc2-reset'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', disabled: false, hidden: false, listeners: {},
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; } }]));
  elements['pc2-color'].value = 'elevation';
  const display = {};
  const api = { getElevationState: () => current.state(), setElevationRange: (min, max) => current.setRange(min, max),
    resetElevationRange: () => current.reset(), setBudget(value) { display.budget = value; },
    setSize(value) { display.size = value; }, setSizing(value) { display.sizing = value; },
    setColor(value) { display.color = value; }, setEDL(value) { display.edl = value; },
    fit() { throw new Error('Display reset must not move the view'); },
    clearMeasurements() { throw new Error('Display reset must not clear measurements'); } };
  const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const section = source.slice(source.indexOf('let pcElevationModelId ='), source.indexOf('// View sync between', source.indexOf('let pcElevationModelId =')));
  const applyStart = source.indexOf('function applyPcPanelState()');
  const apply = source.slice(applyStart, source.indexOf('function updateStatus', applyStart));
  const context = { document: { getElementById: id => elements[id] }, PROJECT: { id: 'cloud-one' }, DISPLAY_UNITS: units,
    METERS_TO_FT: 3.28084, pcApi: () => api, elevationInputMeters: value => units === 'metric' ? value : value / 3.28084,
    formatElevation: (value, unit) => `${value} ${unit}` };
  vm.createContext(context);
  vm.runInContext(`${section}\n${apply}\nthis.panel={syncPcElevationControls,applyPcElevationInputs,bindPcPanel,applyPcPanelState}`, context);
  context.panel.bindPcPanel(); context.panel.syncPcElevationControls();
  return { elements, context, panel: context.panel, materials, controller, display, replaceRuntime(next) { current = next; } };
}

test('parent elevation fields use displayed feet or metres and update the shader live', () => {
  for (const units of ['imperial', 'metric']) {
    const { elements, materials } = panelFixture(units);
    const factor = units === 'metric' ? 1 : 3.28084;
    assert.equal(elements['pc2-elevation-min-label'].textContent, `Min ${units === 'metric' ? 'm' : 'ft'}`);
    assert.ok(Math.abs(Number(elements['pc2-elevation-min'].value) - 200 * factor) < 1e-6);
    elements['pc2-elevation-min'].value = String(210 * factor);
    elements['pc2-elevation-max'].value = String(220 * factor);
    elements['pc2-elevation-min'].listeners.input();
    assert.ok(Math.abs(materials[0].elevationRange[0] - 210) < 1e-10);
    assert.ok(Math.abs(materials[0].elevationRange[1] - 220) < 1e-10);
    elements['pc2-elevation-max'].value = '';
    elements['pc2-elevation-max'].listeners.input();
    assert.match(elements['pc2-elevation-status'].textContent, /last valid/);
    assert.ok(Math.abs(materials[0].elevationRange[1] - 220) < 1e-10);
  }
});

test('range handles cannot cross, custom range survives runtime replacement, new model resets', () => {
  const { elements, panel, context, replaceRuntime } = panelFixture('metric');
  elements['pc2-elevation-low'].value = '230'; elements['pc2-elevation-low'].listeners.input();
  elements['pc2-elevation-high'].value = '200'; elements['pc2-elevation-high'].listeners.input();
  assert.ok(Number(elements['pc2-elevation-max'].value) > Number(elements['pc2-elevation-min'].value));
  const fresh = controllerFixture(); replaceRuntime(fresh.controller); panel.applyPcPanelState();
  assert.equal(fresh.controller.state().automatic, false);
  assert.equal(fresh.materials[0].elevationRange[0], 230);
  context.PROJECT = { id: 'cloud-two' }; panel.applyPcPanelState();
  // Runtime for a new model starts with its own automatic bounds.
  const another = controllerFixture(); replaceRuntime(another.controller); panel.applyPcPanelState();
  assert.equal(another.controller.state().automatic, true);
  elements['pc2-elevation-reset'].listeners.click();
  assert.deepEqual(another.materials[0].elevationRange, [200, 250]);
});

test('display reset restores defaults and auto elevation without altering viewpoint or measurements', () => {
  const { elements, controller, display } = panelFixture('metric');
  elements['pc2-budget'].value = '2';
  elements['pc2-size'].value = '2.5';
  elements['pc2-edl'].checked = false;
  elements['pc2-elevation-min'].value = '220';
  elements['pc2-elevation-min'].listeners.input();
  assert.equal(controller.state().automatic, false);
  elements['pc2-reset'].listeners.click();
  assert.deepEqual(display, { budget: 10, size: 1, sizing: 'fixed', color: 'rgba', edl: true });
  assert.equal(controller.state().automatic, true);
  assert.equal(elements['pc2-elevation-controls'].hidden, true);
  assert.equal(elements['pc2-budget-val'].textContent, '10M');
  assert.equal(elements['pc2-size-val'].textContent, '1.0');
});
