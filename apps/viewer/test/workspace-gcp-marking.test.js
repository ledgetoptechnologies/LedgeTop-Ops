'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'workspace-projects.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'workspace-management.css'), 'utf8');

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
