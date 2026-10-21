'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createPointCloudHealth, FAILURES, hasVisiblePointCloudNodes } = require('../public/pointcloud-health.js');
const CORRELATION_ID = '12345678-abcd-4abc-9abc-1234567890ab';
const BUILD_REVISION = 'a'.repeat(40);

const diagnosticMessage = (type, code, stage, overrides = {}) => ({
  source: 'ltds-pointcloud', type, code, correlationId: CORRELATION_ID, stage, revision: BUILD_REVISION, ...overrides,
});

function fixture(diagnostics = {}) {
  const classes = () => {
    const values = new Set();
    return {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      contains: (name) => values.has(name),
    };
  };
  const elements = {
    'pc-loading': { classList: classes() },
    'pc-loading-text': { textContent: '' },
    'pc-status': { textContent: '' },
    'pc-retry': {
      hidden: true,
      disabled: false,
      addEventListener(type, handler) { if (type === 'click') this.click = handler; },
    },
  };
  const timers = new Map();
  const messages = [];
  let timerId = 0;
  let reloads = 0;
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const win = { parent, location: { origin: 'https://viewer.example' } };
  const health = createPointCloudHealth({
    window: win,
    document: { getElementById: (id) => elements[id] || null },
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    reload: () => { reloads += 1; },
    startupTimeoutMs: 1,
    loadTimeoutMs: 2,
    nodeTimeoutMs: 3,
    correlationId: diagnostics.correlationId || CORRELATION_ID,
    buildRevision: diagnostics.buildRevision || BUILD_REVISION,
  });
  const fireOnlyTimer = () => {
    assert.equal(timers.size, 1);
    const fn = [...timers.values()][0];
    timers.clear();
    fn();
  };
  return { elements, health, messages, timers, fireOnlyTimer, reloads: () => reloads };
}

test('startup and node watchdogs terminate with fixed actionable messages', () => {
  const startup = fixture();
  startup.health.beginStartup();
  startup.fireOnlyTimer();
  assert.equal(startup.health.phase(), 'failed');
  assert.equal(startup.elements['pc-loading-text'].textContent, FAILURES.startup_timeout);
  assert.equal(startup.elements['pc-retry'].hidden, false);
  assert.deepEqual(startup.messages, [{
    message: diagnosticMessage('error', 'startup_timeout', 'startup'),
    origin: 'https://viewer.example',
  }]);

  const nodes = fixture();
  nodes.health.beginStartup();
  nodes.health.beginLoad();
  nodes.health.metadataReady();
  nodes.fireOnlyTimer();
  assert.equal(nodes.elements['pc-loading-text'].textContent, FAILURES.node_timeout);
  assert.equal(nodes.elements['pc-loading-text'].textContent.includes('http'), false);
});

test('visible points clear the watchdog and notify only the same-origin parent', () => {
  const value = fixture();
  value.health.beginStartup();
  value.health.beginLoad();
  value.health.metadataReady();
  value.health.pointsVisible();
  assert.equal(value.health.phase(), 'ready');
  assert.equal(value.timers.size, 0);
  assert.equal(value.elements['pc-loading'].classList.contains('hidden'), true);
  assert.deepEqual(value.messages, [{
    message: diagnosticMessage('ready', 'points_visible', 'nodes'),
    origin: 'https://viewer.example',
  }]);
});

test('expired access after visible points is reported and renewal preserves the ready cloud', () => {
  const f = fixture();
  f.health.pointsVisible();
  f.health.accessRequired();
  f.health.accessRequired();
  f.health.pointsVisible();
  assert.equal(f.health.phase(), 'access-required');
  assert.equal(f.elements['pc-loading'].classList.contains('hidden'), true);
  assert.equal(f.messages.filter(({ message }) => message.code === 'authorization_required').length, 1);
  f.health.accessRestored();
  assert.equal(f.health.phase(), 'ready');
  f.health.accessRequired();
  f.health.accessUnavailable();
  assert.equal(f.health.phase(), 'failed');
  assert.equal(f.messages.at(-1).message.code, 'authorization_unavailable');
});

test('stale point totals cannot mark an empty black canvas ready', () => {
  assert.equal(hasVisiblePointCloudNodes({ numVisiblePoints: 1_192_224, visibleNodes: [] }), false);
  assert.equal(hasVisiblePointCloudNodes({
    numVisiblePoints: 1_192_224,
    visibleNodes: [{ sceneNode: { visible: false, geometry: {} } }],
  }), false);
  assert.equal(hasVisiblePointCloudNodes({
    numVisiblePoints: 12_646,
    visibleNodes: [{ sceneNode: { visible: true, geometry: {} } }],
  }), true);
});

test('late visible points recover from the observational node timeout only', () => {
  const late = fixture();
  late.health.beginStartup();
  late.health.beginLoad();
  late.health.metadataReady();
  late.fireOnlyTimer();
  assert.equal(late.health.phase(), 'failed');
  late.health.pointsVisible();
  assert.equal(late.health.phase(), 'ready');
  assert.equal(late.elements['pc-loading'].classList.contains('hidden'), true);
  assert.deepEqual(late.messages.map(({ message }) => message), [
    diagnosticMessage('error', 'node_timeout', 'nodes'),
    diagnosticMessage('ready', 'points_visible', 'nodes'),
  ]);

  const structural = fixture();
  structural.health.beginStartup();
  structural.health.fail('metadata_failed');
  structural.health.pointsVisible();
  assert.equal(structural.health.phase(), 'failed');
});

test('retry is explicit and missing configuration does not offer a reload loop', () => {
  const failed = fixture();
  failed.health.beginStartup();
  failed.health.fail('metadata_failed');
  assert.equal(failed.reloads(), 0);
  failed.elements['pc-retry'].click();
  assert.equal(failed.reloads(), 1);
  assert.equal(failed.elements['pc-retry'].disabled, true);

  const missing = fixture();
  missing.health.beginStartup();
  missing.health.fail('not_configured', { retryable: false });
  assert.equal(missing.elements['pc-retry'].hidden, true);
  assert.equal(missing.elements['pc-loading-text'].textContent, FAILURES.not_configured);
});

test('diagnostics expose only sanitized correlation, stage, code and build revision', () => {
  const value = fixture({ correlationId: 'https://private.example/ept.json', buildRevision: 'not-a-revision/path' });
  value.health.beginStartup();
  value.health.fail('metadata_failed');
  assert.deepEqual(value.messages[0].message, diagnosticMessage('error', 'metadata_failed', 'startup', {
    correlationId: 'unavailable',
    revision: 'unavailable',
  }));
  assert.equal(FAILURES.runtime_error.includes('Viewer logs'), false);
  assert.match(FAILURES.runtime_error, /browser diagnostics/);
});

test('point-cloud shell starts watchdogs before Potree and requires visible nodes before readiness', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'pointcloud.html'), 'utf8');
  assert.ok(shell.indexOf('/pointcloud-health.js') < shell.indexOf('/potree/libs/jquery/jquery-3.1.1.min.js'));
  assert.match(shell, /pointCloudHealth\.beginStartup\(\)/);
  assert.match(shell, /pointCloudHealth\.beginLoad\(\)[\s\S]*Potree\.loadPointCloud/);
  assert.match(shell, /hasVisiblePointCloudNodes\(pc\)[\s\S]*pointCloudHealth\.pointsVisible\(\)/);
  assert.doesNotMatch(shell, /pc\.numVisiblePoints > 0\s*\|\|/);
  assert.doesNotMatch(shell, /showPointCloudBootstrapError\([^)]*(?:event\.message|event\.reason|target\.src|target\.href)/);
  assert.match(shell, /correlationId: window\.__pointCloudDiagnosticContext\.correlationId/);
  assert.match(shell, /buildRevision: window\.__pointCloudDiagnosticContext\.revision/);
});
