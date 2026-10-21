import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPhotoView, fitPhotoBox, panPhotoView, zoomPhotoView } from '../camera-photo-view.mjs';

const landscape = { baseWidth: 400, baseHeight: 225, viewportWidth: 400, viewportHeight: 225 };

test('camera photo fit boxes preserve each image natural aspect ratio', () => {
  assert.deepEqual(fitPhotoBox({ naturalWidth: 4000, naturalHeight: 2000, maxWidth: 380, maxHeight: 420 }), {
    width: 380, height: 190, aspectRatio: 2,
  });
  assert.deepEqual(fitPhotoBox({ naturalWidth: 2000, naturalHeight: 4000, maxWidth: 380, maxHeight: 420 }), {
    width: 210, height: 420, aspectRatio: 0.5,
  });
  assert.deepEqual(fitPhotoBox({ naturalWidth: 0, naturalHeight: 0, maxWidth: 400, maxHeight: 300 }), {
    width: 400, height: 300, aspectRatio: 4 / 3,
  });
});

test('fit-scale photos cannot be panned away from center', () => {
  assert.deepEqual(clampPhotoView({ scale: 1, tx: 900, ty: -900 }, landscape), { scale: 1, tx: 0, ty: 0 });
  assert.deepEqual(panPhotoView({ scale: 1, tx: 0, ty: 0 }, { dx: 120, dy: -80, ...landscape }), { scale: 1, tx: 0, ty: 0 });
});

test('expanded photo zoom and pan remain clamped without exposing empty frame background', () => {
  const zoomed = zoomPhotoView({ scale: 1, tx: 0, ty: 0 }, {
    factor: 2, cursorX: 190, cursorY: 100, ...landscape,
  });
  assert.deepEqual(zoomed, { scale: 2, tx: -190, ty: -100 });
  const dragged = panPhotoView(zoomed, { dx: -10_000, dy: 10_000, ...landscape });
  assert.deepEqual(dragged, { scale: 2, tx: -200, ty: 112.5 });
  const fit = zoomPhotoView(dragged, { factor: 0.001, cursorX: -200, cursorY: 100, ...landscape });
  assert.deepEqual(fit, { scale: 1, tx: 0, ty: 0 });
});

test('photo translation is re-clamped after the viewport changes', () => {
  const view = clampPhotoView({ scale: 3, tx: 400, ty: -300 }, landscape);
  assert.deepEqual(view, { scale: 3, tx: 400, ty: -225 });
  assert.deepEqual(clampPhotoView(view, {
    baseWidth: 600, baseHeight: 400, viewportWidth: 600, viewportHeight: 400,
  }), { scale: 3, tx: 400, ty: -225 });
  assert.deepEqual(clampPhotoView(view, {
    baseWidth: 200, baseHeight: 100, viewportWidth: 800, viewportHeight: 500,
  }), { scale: 3, tx: 0, ty: 0 });
});
