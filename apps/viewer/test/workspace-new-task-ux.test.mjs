import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTaskOptions, taskOptionGroup } from '../workspace-task-options.mjs';

class Element {
  constructor(tag, ownerDocument) { this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.listeners = {}; this.value = ''; }
  append(...children) { this.children.push(...children); } setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; } replaceChildren() { this.children = []; } remove() { this.removed = true; }
}

test('advertised options are grouped by name, nothing is dropped, and unknown options fall into Other', () => {
  assert.deepEqual(taskOptionGroup('feature-quality'), { id: 'quality', label: 'Quality & features' });
  assert.equal(taskOptionGroup('pc-quality').id, 'point-cloud');
  assert.equal(taskOptionGroup('dsm').id, 'elevation');
  assert.equal(taskOptionGroup('dem-resolution').id, 'elevation');
  assert.equal(taskOptionGroup('orthophoto-resolution').id, 'orthophoto');
  assert.equal(taskOptionGroup('mesh-size').id, 'mesh');
  assert.equal(taskOptionGroup('3d-tiles').id, 'mesh');
  assert.equal(taskOptionGroup('gps-accuracy').id, 'georeferencing');
  assert.equal(taskOptionGroup('max-concurrency').id, 'output');
  assert.equal(taskOptionGroup('brand-new-option').id, 'other');

  const options = [
    { name: 'max-concurrency', type: 'int', value: 4 },
    { name: 'pc-quality', type: 'enum', value: 'medium', domain: ['high', 'medium', 'low'] },
    { name: 'feature-quality', type: 'enum', value: 'high', domain: ['high', 'low'] },
    { name: 'brand-new-option', type: 'bool', value: false },
  ];
  const document = { createElement(tag) { return new Element(tag, this); } }, container = new Element('div', document);
  mountTaskOptions({ container, provider: { id: 'node', capabilityFingerprint: 'f', capabilities: { options } } });
  const list = container.children[0].children[3];
  // Sections appear in the fixed group order, each with a heading, and hold every advertised option once.
  assert.deepEqual(list.children.map(section => section['data-group']), ['quality', 'point-cloud', 'output', 'other']);
  assert.deepEqual(list.children.map(section => section.children[0].textContent), ['Quality & features', 'Point cloud', 'Output & performance', 'Other']);
  const names = list.children.flatMap(section => section.children.filter(child => child.tag === 'fieldset').map(row => row['data-option']));
  assert.deepEqual(names.sort(), options.map(option => option.name).sort());

  // Searching hides groups with no matching option.
  const search = container.children[0].children[1];
  search.value = 'pc-quality'; search.listeners.input();
  assert.deepEqual(list.children.map(section => section.hidden), [true, false, true, true]);
  search.value = ''; search.listeners.input();
  assert.ok(list.children.every(section => section.hidden === false));
});

test('busy nodes say they will queue without claiming a job count; other labels are unchanged', async () => {
  const { availabilityText } = await import('../workspace-new-task-text.mjs');
  assert.equal(availabilityText({}, { status: 'ready', label: 'Ready' }), 'Ready');
  assert.equal(availabilityText({}, { status: 'disabled', label: 'Disabled' }), 'Disabled');
  assert.equal(availabilityText({ capabilities: { taskQueueCount: 2 }, activeAttempts: 1 }, { status: 'busy', label: 'Available · queues work' }),
    'Ready — busy, your task will queue');
  assert.equal(availabilityText({ capabilities: {}, activeAttempts: 0 }, { status: 'busy', label: 'Available · queues work' }), 'Ready — busy, your task will queue');
});

test('server source preparation shows a finite percentage and keeps queued apart from working', async () => {
  const { sourcePreparationState } = await import('../workspace-new-task-text.mjs');
  const queued = sourcePreparationState({ status: 'queued', progress: 0.4 });
  assert.equal(queued.queued, true); assert.equal(queued.percent, 0);
  assert.match(queued.message, /Waiting for the server/); assert.match(queued.message, /Processing has not started/);
  const working = sourcePreparationState({ status: 'leased', phase: 'assembling_upload', progress: 0.426 });
  assert.equal(working.percent, 43); assert.match(working.message, /^Assembling and verifying uploaded photos: 43%/);
  assert.match(working.message, /Processing starts after preparation finishes/);
  assert.equal(sourcePreparationState({ status: 'leased', progress: 7 }).percent, 100);
  assert.equal(sourcePreparationState({ status: 'leased', progress: 'x' }).percent, 0);
  assert.match(sourcePreparationState({ status: 'leased', phase: 'unknown' }).message, /^Preparing your source photos on the server: 0%/);
});

test('GPS summary leads with every selected photo and labels the scanned sample as the preview', async () => {
  const { photoMapSummary } = await import('../workspace-task-photo-map.mjs');
  assert.equal(photoMapSummary({ photoCount: 25000, scanned: 20000, located: 19990, missingGps: 10, omitted: 5000 }),
    '25,000 photos selected. GPS preview scanned 20,000 of them: 19,990 located · 10 without readable GPS · 5,000 not scanned (preview limit).');
  assert.equal(photoMapSummary({ photoCount: 120, scanned: 120, located: 118, missingGps: 2, omitted: 0 }),
    '120 photos selected. GPS preview scanned all 120: 118 located · 2 without readable GPS.');
  assert.equal(photoMapSummary({ photoCount: 1, scanned: 1, located: 1, missingGps: 0, omitted: 0 }),
    '1 photo selected. GPS preview scanned all of them: 1 located · 0 without readable GPS.');
});

test('import errors read plainly, never claim a count or a skip, and unknown messages pass through', async () => {
  const { taskErrorMessage } = await import('../workspace-new-task-text.mjs');
  const empty = taskErrorMessage(new Error('invalid_image_size'));
  assert.match(empty, /empty \(0 bytes\)/);
  assert.match(empty, /stopped before anything was created/);
  assert.doesNotMatch(empty, /\d+ photos?|skipp/i, 'no count and no skipping are implied');
  assert.equal(taskErrorMessage(Object.assign(new Error('Request failed'), { code: 'no_raw_images' })), 'No photos were found in the selection. Choose photos or folders that contain photos.');
  assert.equal(taskErrorMessage(new Error('The selected node is no longer available.')), 'The selected node is no longer available.');
  assert.equal(taskErrorMessage(null), 'The task could not be started.');
});
