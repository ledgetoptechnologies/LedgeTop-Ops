import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

import { installLodKtx2Support, guardKtx2WorkerPool } from '../lod-ktx2.mjs';
import { WorkerPool } from 'three/addons/utils/WorkerPool.js';
import { BASIS_THREE_VERSION, BASIS_UPSTREAM_SHA256, patchBasisTranscoder } from '../scripts/install-basis-transcoder.mjs';

test('KTX2 support configures the transcoder before registering the tile loader plugin', () => {
  const calls = [];
  class FakeKtx2Loader {
    setTranscoderPath(value) { calls.push(['transcoder', value]); return this; }
    setWorkerLimit(value) { calls.push(['workers', value]); return this; }
    detectSupport(value) { calls.push(['support', value]); return this; }
    dispose() { calls.push(['dispose']); }
  }
  class FakeGltfExtensionsPlugin {
    constructor(options) {
      this.options = options;
      calls.push(['plugin', options]);
    }
  }
  const webglRenderer = { name: 'renderer' };
  const tilesRenderer = {
    registerPlugin(plugin) { calls.push(['register', plugin]); },
  };

  const installed = installLodKtx2Support(tilesRenderer, webglRenderer, {
    KTX2LoaderClass: FakeKtx2Loader,
    GLTFExtensionsPluginClass: FakeGltfExtensionsPlugin,
    transcoderPath: '/basis/',
    workerLimit: 2,
  });

  assert.equal(installed.loader instanceof FakeKtx2Loader, true);
  assert.equal(installed.plugin instanceof FakeGltfExtensionsPlugin, true);
  assert.deepEqual(calls.slice(0, 3), [
    ['transcoder', '/basis/'],
    ['workers', 2],
    ['support', webglRenderer],
  ]);
  assert.equal(calls[3][0], 'plugin');
  assert.equal(calls[3][1].ktxLoader, installed.loader);
  assert.equal(calls[3][1].autoDispose, false);
  assert.deepEqual(calls[4], ['register', installed.plugin]);
  installed.dispose();
  assert.deepEqual(calls[5], ['dispose']);
});

test('Viewer installs KTX2 support before configuring or updating the tile renderer', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /import \{ installLodKtx2Support \} from '\.\/lod-ktx2\.mjs';/);
  const create = main.indexOf('const rendererInstance = new TilesRenderer(TILES_URL);');
  const install = main.indexOf('lodKtx2Support = installLodKtx2Support(rendererInstance, renderer', create);
  const configure = main.indexOf('configureLodRenderer(rendererInstance', create);
  assert.ok(create >= 0 && install > create);
  assert.ok(configure > install, 'the decoder plugin is installed before renderer configuration');
  assert.match(main, /tilesRenderer\.dispose\(\);[\s\S]*lodKtx2Support\?\.dispose\(\);[\s\S]*lodKtx2Support = null;/);
});

test('postinstall installs the pinned CSP-safe Basis glue with byte-identical upstream WASM', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.postinstall, /install-basis-transcoder\.mjs/);
  for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    const source = fs.readFileSync(path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis', name));
    const installed = fs.readFileSync(path.join(root, 'public', 'basis', name));
    assert.equal(createHash('sha256').update(source).digest('hex'), BASIS_UPSTREAM_SHA256[name]);
    const expected = name.endsWith('.js') ? Buffer.from(patchBasisTranscoder(source)) : source;
    assert.deepEqual(installed, expected, `${name} must match the reviewed pinned asset`);
  }
});

test('Basis CSP patch rejects changed versions or bytes rather than loosely patching new upstream code', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const source = fs.readFileSync(path.join(root, 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.js'), 'utf8');
  assert.throws(() => patchBasisTranscoder(source, '0.186.0'), /source changed/);
  assert.throws(() => patchBasisTranscoder(source + '\n', BASIS_THREE_VERSION), /source changed/);
  assert.doesNotMatch(patchBasisTranscoder(source), /\bnewFunc\b|\bnew\s+Function\b|\beval\s*\(|return Function/);
});

function embeddedKtx2Images(b3dm) {
  const glbOffset = 28 + [12, 16, 20, 24].reduce((total, offset) => total + b3dm.readUInt32LE(offset), 0);
  const jsonLength = b3dm.readUInt32LE(glbOffset + 12);
  const json = JSON.parse(b3dm.subarray(glbOffset + 20, glbOffset + 20 + jsonLength).toString());
  const binaryOffset = glbOffset + 20 + jsonLength + 8;
  return json.images.filter(image => image.mimeType === 'image/ktx2').map(image => {
    const view = json.bufferViews[image.bufferView];
    return b3dm.subarray(binaryOffset + (view.byteOffset || 0), binaryOffset + (view.byteOffset || 0) + view.byteLength);
  });
}

async function loadBasis(source, wasmBinary, strings) {
  const context = vm.createContext({ console, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance }, {
    codeGeneration: { strings, wasm: true },
  });
  vm.runInContext(source, context);
  const module = await context.BASIS({ wasmBinary });
  module.initializeBasis();
  return module;
}

function transcodeImage(module, bytes, format) {
  const texture = new module.KTX2File(new Uint8Array(bytes));
  try {
    assert.equal(texture.isValid(), true);
    assert.equal(Boolean(texture.startTranscoding()), true);
    const levels = [];
    for (let level = 0; level < texture.getLevels(); level += 1) {
      const info = texture.getImageLevelInfo(level, 0, 0);
      const output = new Uint8Array(texture.getImageTranscodedSizeInBytes(level, 0, 0, format));
      assert.equal(Boolean(texture.transcodeImage(output, level, 0, 0, format, 0, -1, -1)), true);
      levels.push({ width: info.origWidth, height: info.origHeight, output: Buffer.from(output) });
    }
    return levels;
  } finally { texture.close(); texture.delete(); }
}

test('actual Basis WASM initializes without JS string compilation and produces identical KTX2 mip bytes', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const directory = path.join(root, 'node_modules/three/examples/jsm/libs/basis');
  const source = fs.readFileSync(path.join(directory, 'basis_transcoder.js'), 'utf8');
  const wasm = fs.readFileSync(path.join(directory, 'basis_transcoder.wasm'));
  // Reproduce production's exact distinction: JS dynamic compilation forbidden,
  // WASM compilation permitted. Do not use a test that disables WASM as well.
  await assert.rejects(loadBasis(source, wasm, false), /Code generation from strings disallowed/);
  const original = await loadBasis(source, wasm, true);
  const patched = await loadBasis(patchBasisTranscoder(source), wasm, false);
  const tiles = ['root.b3dm', 'LOD-0/Mesh.b3dm'];
  let imageCount = 0;
  for (const tile of tiles) {
    for (const bytes of embeddedKtx2Images(fs.readFileSync(path.join(root, 'test/fixtures/ktx2-tiles', tile)))) {
      imageCount += 1;
      // BC1, BC3, BC7 and RGBA32 exercise compressed and uncompressed result
      // bridges; each mip must remain byte-identical to the pinned decoder.
      for (const format of [2, 3, 6, 13]) {
        assert.deepEqual(transcodeImage(patched, bytes, format), transcodeImage(original, bytes, format));
      }
    }
  }
  assert.ok(imageCount >= 2, 'both root and leaf must contain real compressed textures');
});

test('both container install stages receive the Basis installer before npm ci', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const copies = dockerfile.match(/COPY scripts\/patch-3d-tiles-renderer\.mjs scripts\/install-basis-transcoder\.mjs \.\/scripts\//g) || [];
  assert.equal(copies.length, 2);
});

class FakeWorker extends EventTarget {
  constructor(delayMs = null) { super(); this.delayMs = delayMs; this.terminated = false; this.messages = []; }
  postMessage(message) {
    this.messages.push(message);
    if (this.delayMs !== null) setTimeout(() => {
      if (!this.terminated) this.dispatchEvent(new MessageEvent('message', { data: { type: 'transcode', id: message.id } }));
    }, this.delayMs);
  }
  terminate() { this.terminated = true; }
}

test('KTX2 worker crash rejects active and queued textures instead of leaving tile parsing pending', async () => {
  const pool = new WorkerPool(1);
  guardKtx2WorkerPool(pool, { timeoutMs: 1_000 });
  const worker = new FakeWorker();
  pool.setWorkerCreator(() => worker);
  const first = pool.postMessage({ type: 'transcode', id: 1 });
  const second = pool.postMessage({ type: 'transcode', id: 2 });
  const results = Promise.allSettled([first, second]);
  await Promise.resolve();
  worker.dispatchEvent(new Event('error'));
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'ktx2_transcoder_failed');
  }
  assert.equal(worker.terminated, true);
  assert.equal(pool.queue.length, 0);
  await assert.rejects(pool.postMessage({ type: 'transcode', id: 3 }), { code: 'ktx2_transcoder_failed' });
  pool.dispose();
});

test('KTX2 silent worker initialization failure is bounded and releases the pool', async () => {
  const pool = new WorkerPool(1);
  guardKtx2WorkerPool(pool, { timeoutMs: 15 });
  const worker = new FakeWorker();
  pool.setWorkerCreator(() => worker);
  await assert.rejects(pool.postMessage({ type: 'transcode', id: 1 }), /processing deadline/);
  assert.equal(worker.terminated, true);
  assert.equal(pool.workers.length, 0);
});

test('KTX2 timeout counts active work only, not time behind other healthy texture jobs', async () => {
  const pool = new WorkerPool(1);
  guardKtx2WorkerPool(pool, { timeoutMs: 80 });
  const worker = new FakeWorker(25);
  pool.setWorkerCreator(() => worker);
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, id) => pool.postMessage({ type: 'transcode', id })));
    assert.deepEqual(results.map(result => result.data.id), [0, 1, 2, 3, 4, 5]);
    assert.equal(worker.terminated, false);
  } finally { pool.dispose(); }
});

test('disposing the KTX2 loader rejects in-flight textures and clears the deadline timer', async () => {
  const pool = new WorkerPool(1);
  guardKtx2WorkerPool(pool, { timeoutMs: 120_000 });
  pool.setWorkerCreator(() => new FakeWorker());
  const request = pool.postMessage({ type: 'transcode', id: 1 });
  const result = assert.rejects(request, /disposed/);
  await Promise.resolve();
  pool.dispose();
  await result;
  assert.equal(pool.workers.length, 0);
});
