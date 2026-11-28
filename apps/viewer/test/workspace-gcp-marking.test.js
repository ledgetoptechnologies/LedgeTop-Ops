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
  for (const name of ['gcpWorkspace', 'gcpPanel', 'refreshGcpCandidates', 'gcpCheckpointSection', 'gcpHeight', 'gcpPointOptionName', 'gcpPointName']) {
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

test('staff set each point as control or checkpoint, and checkpoints are labelled in the point list', () => {
  assert.match(source, /class="gcp-role-select"/);
  assert.match(source, /<option value="control"[^>]*>Control<\/option><option value="checkpoint"[^>]*>Checkpoint<\/option>/);
  assert.match(source, /\/api\/v1\/gcp-points\/\$\{encodeURIComponent\(pointId\)\}`,\{method:'PATCH',body:\{role\}\}/);
  assert.match(source, /querySelectorAll\('\.gcp-role-select'\)\.forEach\(select=>select\.onchange=\(\)=>changeGcpRole\(/);
  assert.match(source, /point\?\.role==='checkpoint'\?' · checkpoint':''/);
});

test('the GCP panel shows checkpoint accuracy for the task latest run', () => {
  assert.match(source, /\/api\/v1\/attempts\/\$\{encodeURIComponent\(latestAttemptId\)\}\/gcp-checkpoints/);
  assert.match(source, /<h4>Checkpoint accuracy<\/h4>/);
  assert.match(source, /<th>Checkpoint<\/th><th>Surveyed<\/th><th>DSM<\/th><th>DSM − surveyed<\/th>/);
  assert.match(source, /RMSE \$\{esc\(gcpHeight\(summary\.rmseZM,units\)\)\}/);
  assert.match(source, /vertical only/);
  assert.match(source, /awaiting_output:'Waiting for this run to finish\.'/);
  assert.ok(css.includes('.gcp-checkpoint-table'));
});

test('checkpoint accuracy renders residuals in feet, statuses for unmeasured points, and nothing without checkpoints', () => {
  const context = gcpUiFixture();
  assert.equal(context.gcpCheckpointSection({ reportStatus: 'no_checkpoints', checkpoints: [] }, 'imperial'), '');
  const ready = context.gcpCheckpointSection({ reportStatus: 'ready', checkpoints: [], report: {
    summary: { rmseZM: 0.03048, meanZM: -0.01524, measuredCount: 1, checkpointCount: 2 },
    points: [{ externalId: 'CHK1', label: 'CHK1', elevationM: 100, dsmZM: 100.03048, dzM: 0.03048, status: 'measured' },
      { externalId: 'CHK2', label: 'CHK2', elevationM: 101, dsmZM: null, dzM: null, status: 'outside_dsm' }] } }, 'imperial');
  assert.match(ready, /RMSE 0\.10 ft/);
  assert.match(ready, /mean -0\.05 ft/);
  assert.match(ready, /<td>CHK1<\/td><td>328\.08 ft<\/td><td>328\.18 ft<\/td><td>\+0\.10 ft<\/td>/);
  assert.match(ready, /<td>CHK2<\/td>.*Outside DSM/);
  const waiting = context.gcpCheckpointSection({ reportStatus: 'awaiting_output', report: null,
    checkpoints: [{ externalId: 'CHK1', label: 'CHK1', elevationM: 100 }] }, 'metric');
  assert.match(waiting, /Waiting for this run to finish\./);
  assert.match(waiting, /<td>CHK1<\/td><td>100\.000 m<\/td><td>—<\/td><td>—<\/td>/);
});
