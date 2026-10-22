import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableViewerModes,
  chooseViewerMode,
  viewerModeFromUrl,
  viewerModeUrl,
} from '../view-mode.mjs';

test('verified LOD is the default while a valid requested view is preserved', () => {
  const available = availableViewerModes({
    meshSource: 'tiles', cloudMode: 'potree', ortho: true, dsm: true, dtm: true,
  });
  assert.deepEqual(available, ['model', 'cloud', 'ortho', 'dsm', 'dtm']);
  assert.equal(chooseViewerMode(null, available), 'model');
  assert.equal(chooseViewerMode('cloud', available), 'cloud');
});

test('original-only models never expose the interactive 3D mode', () => {
  const available = availableViewerModes({
    meshSource: 'lod-required', cloudMode: 'potree', ortho: false, dsm: false, dtm: false,
  });
  assert.deepEqual(available, ['cloud']);
  assert.equal(chooseViewerMode('model', available), 'cloud');
});

test('fallback uses the first available view only when no orthophoto exists', () => {
  assert.equal(chooseViewerMode(null, ['model', 'cloud']), 'model');
  assert.equal(chooseViewerMode(null, ['cloud', 'dsm']), 'cloud');
  assert.equal(chooseViewerMode(null, []), null);
});

test('view mode URL state preserves other query parameters and hash', () => {
  const next = viewerModeUrl('/session/active/example?project=one#tools', 'cloud');
  assert.equal(next, '/session/active/example?project=one&view=cloud#tools');
  assert.equal(viewerModeFromUrl(`https://viewer.example${next}`), 'cloud');
  assert.equal(viewerModeFromUrl('https://viewer.example/?view=unknown'), null);
});
