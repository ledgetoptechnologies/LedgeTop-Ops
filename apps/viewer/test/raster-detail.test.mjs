import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRasterDetailImage } from '../raster-detail.mjs';

const image = (width, height) => ({ getWidth: () => width, getHeight: () => height });
const options = { sourceWidth: 10000, sourceHeight: 10000, windowWidth: 1024, windowHeight: 1024, tileWidth: 256, tileHeight: 256 };

test('irregular, unordered overviews do not substitute blurry samples for available detail', () => {
  const full = image(10000, 10000), tenth = image(1000, 1000), quarter = image(2500, 2500);
  assert.equal(selectRasterDetailImage([full, tenth], options), full);
  assert.equal(selectRasterDetailImage([tenth, full, quarter], options), quarter);
});

test('regular pyramids choose the smallest level that preserves screen resolution', () => {
  const levels = [10000, 5000, 2500, 1250].map(size => image(size, size));
  assert.equal(selectRasterDetailImage(levels, options), levels[2]);
  assert.equal(selectRasterDetailImage(levels, { ...options, windowWidth: 100, windowHeight: 100 }), levels[0]);
  assert.equal(selectRasterDetailImage(levels, { ...options, windowWidth: 10000, windowHeight: 10000 }), levels[3]);
});

test('both axes constrain selection for rounded overview dimensions', () => {
  const full = image(1000, 997), half = image(500, 498), tooShort = image(500, 450);
  const rounded = { ...options, sourceWidth: 1000, sourceHeight: 997, windowWidth: 512, windowHeight: 512 };
  assert.equal(selectRasterDetailImage([full, half], rounded), half);
  assert.equal(selectRasterDetailImage([full, tooShort], rounded), full);
});
