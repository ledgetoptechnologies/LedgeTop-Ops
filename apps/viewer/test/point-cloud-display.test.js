const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { classificationLabel, createHoverReader } = require('../public/pointcloud-display.js');

test('class readout uses the decoded code, distinguishing unclassified, unavailable and unknown', () => {
  assert.equal(classificationLabel({ classification: new Uint8Array([2]) }), 'Classification: Ground (2)');
  assert.equal(classificationLabel({ classification: [6] }), 'Classification: Building (6)');
  assert.equal(classificationLabel({ classification: 1 }), 'Classification: Unclassified (1)');
  assert.equal(classificationLabel({ classification: 0 }), 'Classification: Never classified (0)');
  assert.equal(classificationLabel({ classification: 201 }), 'Classification: Unknown / user-defined (201)');
  for (const classification of [undefined, null, [], NaN, 2.5, '2', -1, 256]) {
    assert.equal(classificationLabel({ classification }), 'Classification: unavailable');
  }
  assert.equal(classificationLabel(null), 'Classification: —');
  assert.equal(classificationLabel({ rgb: [0, 255, 0], position: { z: 1 } }), 'Classification: unavailable');
});

function hoverFixture() {
  let allowed = true, label = '', calls = 0, counter = 0;
  const jobs = new Map();
  const picked = [];
  const reader = createHoverReader({
    canPick: () => allowed, show: text => { label = text; },
    pick: position => { calls++; picked.push(position); return { classification: new Uint8Array([5]) }; },
    schedule: (fn, delay) => { const id = ++counter; jobs.set(id, { fn, delay }); return id; },
    cancel: id => jobs.delete(id),
  });
  return { reader, jobs, picked, allow: value => { allowed = value; },
    state: () => ({ label, calls }), flush() { const pending = [...jobs.values()]; jobs.clear(); pending.forEach(job => job.fn()); } };
}

test('rapid motion coalesces into one idle decoded pick with the latest cursor', () => {
  const fixture = hoverFixture();
  for (let i = 0; i < 200; i++) fixture.reader.move({ clientX: i, clientY: 10, buttons: 0 });
  assert.equal(fixture.state().calls, 0);
  assert.equal(fixture.jobs.size, 1);
  assert.equal([...fixture.jobs.values()][0].delay, 180);
  fixture.flush();
  assert.equal(fixture.state().calls, 1);
  assert.deepEqual(fixture.picked, [{ x: 199, y: 10 }]);
  assert.equal(fixture.state().label, 'Classification: High vegetation (5)');
});

test('drag, touch, mode changes, leave and cancellation do no hover GPU work', () => {
  const fixture = hoverFixture();
  fixture.reader.move({ clientX: 10, clientY: 10, buttons: 1 });
  fixture.reader.move({ clientX: 10, clientY: 10, pointerType: 'touch' });
  assert.equal(fixture.jobs.size, 0);
  fixture.reader.move({ clientX: 10, clientY: 10 });
  fixture.allow(false); fixture.flush();
  assert.equal(fixture.state().calls, 0);
  fixture.allow(true); fixture.reader.move({ clientX: 10, clientY: 10 });
  const stale = [...fixture.jobs.values()][0].fn;
  fixture.reader.clear(); stale(); fixture.flush();
  assert.equal(fixture.state().calls, 0);
  assert.equal(fixture.state().label, 'Classification: —');
});

test('point display markup offers one dual-thumb track, typed bounds and no alternate sizing/intensity', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const panel = html.slice(html.indexOf('id="panel-pc"'), html.indexOf('id="viewer-wrap"'));
  assert.match(panel, /class="pc-elevation-range"[^>]*>[\s\S]*?id="pc2-elevation-low"[^>]*>[\s\S]*?id="pc2-elevation-high"[^>]*>\s*<\/div>/);
  assert.match(panel, /type="number" id="pc2-elevation-min"/);
  assert.match(panel, /type="number" id="pc2-elevation-max"/);
  assert.match(panel, /id="pc2-reset"/);
  assert.doesNotMatch(panel, /id="pc2-sizing"|value="intensity"/);
  const shell = fs.readFileSync(require.resolve('../public/pointcloud.html'), 'utf8');
  assert.match(shell, /id="pc-classification" hidden/);
  assert.match(shell, /pickWindowSize: 5, pickClipped: true/);
  assert.match(shell, /pcControls\._mode === 'none' && !pcControls\._inertia.active/);
  assert.match(shell, /const schema = cloud\.pcoGeometry\?\.ept\?\.schema/);
  assert.match(shell, /!schema\.some\(field => field\.name\?\.toLowerCase\(\) === 'classification'\)/);
});
