import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decoderPath = path.join(root, 'ept-lazrs-decoder.mjs');
const fixturePath = path.join(root, 'test', 'fixtures', 'synthetic-ept-node.laz');

function close(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test('LAZ-RS decodes a standalone EPT LAZ node into Potree-ready relative buffers', async (t) => {
  assert.equal(existsSync(decoderPath), true, 'the EPT LAZ-RS decoder module exists');
  assert.equal(existsSync(fixturePath), true, 'the synthetic EPT LAZ fixture exists');

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.protocol === 'file:') {
      return new Response(readFileSync(fileURLToPath(url)), {
        headers: { 'content-type': 'application/wasm' },
      });
    }
    return nativeFetch(input, init);
  };
  t.after(() => { globalThis.fetch = nativeFetch; });

  const { decodeEptLazNode, readLasPointCount } = await import(`${pathToFileURL(decoderPath).href}?test=${Date.now()}`);
  const bytes = readFileSync(fixturePath);
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.equal(readLasPointCount(input), 64);
  const malformed = input.slice(0);
  new Uint8Array(malformed, 0, 4).set([0, 0, 0, 0]);
  assert.throws(() => readLasPointCount(malformed), /LAS signature/);
  const decoded = await decodeEptLazNode(input, [367000, 4759000, 100]);

  assert.equal(decoded.pointCount, 64);
  assert.equal(decoded.position.byteLength, 64 * 3 * 4);
  assert.equal(decoded.color.byteLength, 64 * 4);
  assert.equal(decoded.intensity.byteLength, 64 * 4);
  assert.equal(decoded.classification.byteLength, 64);
  assert.equal(decoded.indices.byteLength, 64 * 4);

  const positions = new Float32Array(decoded.position);
  assert.deepEqual(Array.from(positions.slice(0, 3)), [0, 0, 0]);
  close(positions.at(-3), 15.75);
  close(positions.at(-2), 3.5);
  close(positions.at(-1), 0.3);
  assert.deepEqual(decoded.tightBoundingBox.min, [0, 0, 0]);
  close(decoded.tightBoundingBox.max[0], 15.75);
  close(decoded.tightBoundingBox.max[1], 3.5);
  close(decoded.tightBoundingBox.max[2], 0.3);
  assert.ok(decoded.mean.every(Number.isFinite));
  assert.deepEqual(decoded.ranges['return number'], [0, 0]);
  assert.deepEqual(decoded.ranges['number of returns'], [0, 0]);
  assert.deepEqual(decoded.ranges['source id'], [0, 0]);
});
