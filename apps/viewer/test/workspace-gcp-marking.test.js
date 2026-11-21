'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const searchPolicy = require('../server/gcpSearchPolicy.mjs');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'workspace-projects.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'workspace-management.css'), 'utf8');

function gcpUiFixture() {
  const context = { ...searchPolicy, state: { gcpWorkspaces: {}, adminSession: { displayUnits: 'imperial' } },
    can: () => false, esc: value => String(value ?? ''), empty: value => `<p>${value}</p>`,
    field: (label, name, attrs) => `<label>${label}<input name="${name}" ${attrs}></label>`,
    button: () => '', badge: () => '', toast() { context.toasts++; }, toasts: 0, refreshes: 0,
    async refreshGcpWorkspace() { context.refreshes++; } };
  for (const name of ['gcpWorkspace', 'gcpPanel', 'refreshGcpCandidates']) {
    const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]+$`, 'm'))?.[0];
    assert.ok(declaration, name);
    vm.runInNewContext(declaration, context);
  }
  const task = { id: 'task-1', datasetId: 'dataset-1', status: 'draft' }, dataset = { id: 'dataset-1' };
  context.render = () => context.gcpPanel(task, dataset, { sets: [{ id: 'set-1', displayName: 'Survey', pointCount: 1 }], points: [], candidates: [], correspondences: [] });
  return context;
}

test('actual GCP panel renders 50 feet or 15.24 metres and retains a custom SI radius', () => {
  const f = gcpUiFixture();
  const imperial = f.render();
  assert.match(imperial, /Radius \(feet\)/);
  assert.match(imperial, /name="radius"[^>]*value="50"/);
  assert.match(imperial, /value="radius" selected/);
  assert.match(imperial, /step="any"/);
  f.state.adminSession.displayUnits = 'metric';
  assert.match(f.render(), /Radius \(metres\)/);
  assert.match(f.render(), /name="radius"[^>]*value="15\.24"/);
  f.gcpWorkspace('task-1').radiusM = 38.1;
  assert.match(f.render(), /name="radius"[^>]*value="38\.1"/);
});

test('radius submit uses the units shown on the form even if a renewal changed display preference', async () => {
  const f = gcpUiFixture(); f.render();
  f.state.adminSession.displayUnits = 'metric';
  const form = { dataset: { taskId: 'task-1', radiusUnits: 'imperial' },
    elements: { mode: { value: 'radius' }, radius: { value: '50' } } };
  await f.refreshGcpCandidates({ preventDefault() {}, currentTarget: form });
  assert.equal(f.gcpWorkspace('task-1').radiusM, 15.24);
  assert.equal(f.refreshes, 1); assert.equal(f.toasts, 0);
  form.elements.radius.value = '0';
  await f.refreshGcpCandidates({ preventDefault() {}, currentTarget: form });
  assert.equal(f.gcpWorkspace('task-1').radiusM, 15.24);
  assert.equal(f.refreshes, 1); assert.equal(f.toasts, 1);
});

test('task GCP workspace selects authoritative sets and points before bounded image ranking', () => {
  for (const value of [
    'gcp-set-select', 'gcp-point-select', 'Control-point set', 'Control point',
    'Auto radius', 'Fixed radius', 'Nearest images', 'visibility not confirmed',
  ]) assert.ok(source.includes(value), value);
  assert.match(source, /\/api\/v1\/gcp-sets\/\$\{encodeURIComponent\(workspace\.setId\)\}/);
  assert.match(source, /\/gcp-images\?\$\{query\}/);
  assert.match(source, /limit:'24'/);
  assert.match(source, /query\.set\('radiusM',String\(workspace\.radiusM\)\)/);
  assert.match(source, /\.slice\(0,100\)/);
});

test('private source images use the staff bearer and a no-store object URL lifecycle', () => {
  assert.match(source, /gcp-images\/\$\{encodeURIComponent\(fileId\)\}\/content/);
  assert.match(source, /Authorization:`Bearer \$\{state\.token\}`/);
  assert.match(source, /Accept:'image\/\*'/);
  assert.match(source, /cache:'no-store'/);
  assert.match(source, /startsWith\('image\/'\)/);
  assert.match(source, /URL\.createObjectURL\(await response\.blob\(\)\)/);
  assert.match(source, /URL\.revokeObjectURL\(workspace\.imageUrl\)/);
  assert.doesNotMatch(source, /<img[^>]+\/api\/v1\/datasets/);
});

test('image clicks and numeric fields create update and delete exact correspondences', () => {
  for (const value of ['Pixel X', 'Pixel Y', 'Save mark', 'Update mark', 'Saved correspondences'])
    assert.ok(source.includes(value), value);
  assert.match(source, /event\.clientX-rect\.left/);
  assert.match(source, /image\.naturalWidth\/rect\.width/);
  assert.match(source, /event\.clientY-rect\.top/);
  assert.match(source, /image\.naturalHeight\/rect\.height/);
  assert.match(source, /\/api\/v1\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/gcp-correspondences/);
  assert.match(source, /\/api\/v1\/gcp-correspondences\/\$\{encodeURIComponent\(existing\.id\)\}/);
  assert.match(source, /method:'PATCH',body:\{pixelX,pixelY\}/);
  assert.match(source, /method:'DELETE'/);
  assert.match(source, /await dialogs\.confirm\('Delete this saved image correspondence\?',/);
});

test('marking layout is bounded responsive and preserves exact import provenance confirmation', () => {
  for (const selector of ['.gcp-marker-workspace', '.gcp-candidates', '.gcp-image-stage', '.gcp-marker', '.gcp-pixel-fields'])
    assert.ok(css.includes(selector), selector);
  assert.match(css, /\.gcp-candidates\{[^}]*max-height:360px[^}]*overflow:auto/);
  assert.match(css, /max-height:min\(62vh,680px\)/);
  assert.match(css, /@media\(max-width:1000px\)[\s\S]*\.gcp-marker-workspace/);
  assert.match(css, /@media\(max-width:720px\)[\s\S]*\.gcp-pixel-fields/);
  assert.match(source, /\/gcp-sets\/import-preview/);
  assert.match(source, /confirmationToken:preview\.confirmationToken/);
  assert.match(source, /preview\.provenance\?\.coordinateSystem/);
  assert.doesNotMatch(source, /NAD83 \/ Wisconsin Central|value="NAVD88"/);
});
