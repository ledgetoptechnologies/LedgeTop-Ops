import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '@loaders.gl/core';
import { LASLoader } from '@loaders.gl/las';

function minimalLas12() {
  const headerSize = 227;
  const pointSize = 26;
  const buffer = new ArrayBuffer(headerSize + pointSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode('LASF'), 0);
  bytes[24] = 1;
  bytes[25] = 2;
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint32(100, 0, true);
  bytes[104] = 2; // LAS point format 2: XYZ + RGB
  view.setUint16(105, pointSize, true);
  view.setUint32(107, 1, true);
  view.setUint32(111, 1, true);
  view.setFloat64(131, 0.001, true);
  view.setFloat64(139, 0.001, true);
  view.setFloat64(147, 0.001, true);
  view.setFloat64(155, 367257, true);
  view.setFloat64(163, 4759982, true);
  view.setFloat64(171, 200, true);

  const coordinates = [367257.012, 4759982.025, 202.125];
  view.setFloat64(179, coordinates[0], true); // max X
  view.setFloat64(187, coordinates[0], true); // min X
  view.setFloat64(195, coordinates[1], true); // max Y
  view.setFloat64(203, coordinates[1], true); // min Y
  view.setFloat64(211, coordinates[2], true); // max Z
  view.setFloat64(219, coordinates[2], true); // min Z

  view.setInt32(headerSize, 12, true);
  view.setInt32(headerSize + 4, 25, true);
  view.setInt32(headerSize + 8, 2125, true);
  view.setUint16(headerSize + 20, 65535, true);
  view.setUint16(headerSize + 22, 32768, true);
  view.setUint16(headerSize + 24, 0, true);
  return { buffer, coordinates };
}

test('the configured LAS loader preserves UTM precision as Float64', async () => {
  const fixture = minimalLas12();
  const data = await parse(fixture.buffer, LASLoader, { las: { colorDepth: 8, fp64: true } });
  const positions = data.attributes.POSITION.value;
  assert.ok(positions instanceof Float64Array);
  fixture.coordinates.forEach((expected, index) => {
    assert.ok(Math.abs(positions[index] - expected) < 1e-9);
  });
});
