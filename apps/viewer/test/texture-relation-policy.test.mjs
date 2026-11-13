import assert from 'node:assert/strict';
import test from 'node:test';
import { TextureRelationAccumulator, TEXTURE_RELATION_POLICY } from '../scripts/lib/texture-relation-policy.mjs';
const image = (width, height, rgba) => Uint8Array.from({ length: width * height * 4 }, (_, index) => rgba[index % 4]);

test('full-count RGB and alpha statistics report hand-calculated channel errors', () => {
  const value = new TextureRelationAccumulator({ width: 2, height: 1 });
  value.addRows(0, Uint8Array.of(10,20,30,255,10,20,30,255), Uint8Array.of(7,16,30,254,10,20,18,255));
  const result = value.finish();
  assert.equal(result.rgb.mae, 19 / 6); assert.equal(result.rgb.rmse, Math.sqrt(169 / 6));
  assert.deepEqual(result.rgbChannels.map(channel => channel.mae), [1.5, 2, 6]);
  assert.equal(result.rgb.quantiles.p50, 0); assert.equal(result.rgb.quantiles.p99, 12);
  assert.deepEqual(result.rgb.maximumAt, { x: 1, y: 0, channel: 2 });
  assert.equal(result.alpha.mae, .5); assert.equal(result.alpha.maximum, 1);
  assert.equal(result.pixelsCompared, 2); assert.equal(result.visiblePixels, 2);
  assert.equal(result.candidatePass, true); assert.equal(result.calibrationRequired, true);
});

test('transparent RGB cannot dilute visible errors and alpha is checked everywhere', () => {
  const raw = image(1000, 1, [0,0,0,0]), decoded = image(1000, 1, [255,255,255,0]);
  raw.set([0,0,0,255], 0); decoded.set([40,40,40,255], 0);
  decoded[7] = 21;
  const value = new TextureRelationAccumulator({ width: 1000, height: 1 }); value.addRows(0, raw, decoded);
  const result = value.finish();
  assert.equal(result.visiblePixels, 1); assert.equal(result.rgb.mae, 40);
  assert.equal(result.alpha.maximum, 21); assert.equal(result.alphaPass, false); assert.equal(result.candidatePass, false);
  assert.deepEqual(result.alpha.maximumAt, { x: 1, y: 0, channel: 3 });
});

test('a wrong 512-pixel region cannot hide inside a correct image mean', () => {
  const width = 4096, height = 1, raw = image(width, height, [100,100,100,255]), decoded = raw.slice();
  for (let x = 512; x < 1024; x++) decoded.set([130,130,130,255], x * 4);
  const value = new TextureRelationAccumulator({ width, height }); value.addRows(0, raw, decoded);
  const result = value.finish();
  assert.equal(result.imageRgbPass, true); assert.equal(result.candidatePass, false);
  assert.deepEqual(result.regions.filter(region => !region.passed).map(region => [region.x, region.y]), [[512, 0]]);
});

test('localized corruption records the statistical sensitivity boundary without an equality claim', () => {
  const width=512, height=512, raw=image(width,height,[0,0,0,255]), decoded=raw.slice();
  for(let y=0;y<64;y++) for(let x=0;x<64;x++) decoded.set([128,128,128,255],(y*width+x)*4);
  const value=new TextureRelationAccumulator({width,height}); value.addRows(0,raw,decoded);
  const result=value.finish();
  assert.equal(result.rgb.mae,2); assert.equal(result.rgb.rmse,16); assert.equal(result.rgb.maximum,128);
  assert.equal(result.candidatePass,true,'statistical gates do not establish universal texel equality');
  assert.equal(result.calibrationRequired,true); assert.match(result.scope,/no geometry, source binding, decoder or universal pixel-equality claim/);
});

test('row-band boundaries preserve exact statistics and partial edge regions', () => {
  const width = 513, height = 514, raw = image(width, height, [80,90,100,255]), decoded = image(width, height, [82,92,102,254]);
  const whole = new TextureRelationAccumulator({ width, height }); whole.addRows(0, raw, decoded);
  const bands = new TextureRelationAccumulator({ width, height });
  for (const [start, count] of [[0, 17], [17, 495], [512, 2]])
    bands.addRows(start, raw.subarray(start * width * 4, (start + count) * width * 4), decoded.subarray(start * width * 4, (start + count) * width * 4));
  const result = bands.finish(); assert.deepEqual(result, whole.finish());
  assert.deepEqual(result.regions.map(region => [region.x, region.y, region.width, region.height]), [[0,0,512,512],[512,0,1,512],[0,512,512,2],[512,512,1,2]]);
  assert.equal(result.pixelsCompared, width * height); assert.equal(result.rgb.maximum, 2);
  result.rgb.mae = 999; assert.equal(bands.finish().rgb.mae, 2, 'caller cannot modify retained result');
});

test('gaps, duplicate rows, incomplete coverage and invalid dimensions are refused', () => {
  assert.throws(() => new TextureRelationAccumulator({ width: 16385, height: 1 }), { code: 'lod_texture_relation_dimensions' });
  const value = new TextureRelationAccumulator({ width: 1, height: 2 }), pixel = Uint8Array.of(1,2,3,255);
  assert.throws(() => value.addRows(1, pixel, pixel), { code: 'lod_texture_relation_coverage' });
  value.addRows(0, pixel, pixel);
  assert.throws(() => value.addRows(0, pixel, pixel), { code: 'lod_texture_relation_coverage' });
  assert.throws(() => value.finish(), { code: 'lod_texture_relation_coverage' });
  value.addRows(1, pixel, pixel); assert.equal(value.finish().candidatePass, true);
  assert.throws(() => value.addRows(2, pixel, pixel), { code: 'lod_texture_relation_coverage' });
  assert.equal(TEXTURE_RELATION_POLICY.imageRgbMae, 10);
});
