#!/usr/bin/env node
'use strict';

// Local, synthetic benchmark for the Viewer asset delivery hot path.
// It builds a temporary database and storage tree (3D Tiles children, EPT
// children and a chunk-hashed orthophoto), serves them through the real
// assets router with a published viewer session, and reports wall time and
// per-request latency for a cold pass and a warm (repeat) pass.
//
//   node scripts/bench-asset-delivery.js [--tiles 120] [--tile-kib 512]
//        [--ortho-mib 64] [--ranges 160] [--concurrency 6] [--json]
//
// Nothing outside the temporary directory is touched; it is removed on exit.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const express = require('express');

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback;
}
const TILE_COUNT = option('tiles', 120);
const TILE_BYTES = option('tile-kib', 512) * 1024;
const EPT_COUNT = option('ept', 120);
const EPT_BYTES = option('ept-kib', 256) * 1024;
const ORTHO_BYTES = option('ortho-mib', 64) * 1024 * 1024;
const RANGE_COUNT = option('ranges', 160);
const RANGE_BYTES = 256 * 1024; // geotiff.js blockSize used by the Viewer
const CONCURRENCY = option('concurrency', 6);
const CHUNK = 4 * 1024 * 1024; // storageManager.hashFileChunks
const JSON_OUTPUT = args.includes('--json');
// --uncached: force the path used on filesystems where verification results
// are not remembered (Windows/NTFS, NFS, CIFS/SMB, FUSE), as the tests do.
const UNCACHED = args.includes('--uncached');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function pseudoRandom(size, seed) {
  // Deterministic, incompressible-ish bytes without a large RNG cost.
  const out = Buffer.allocUnsafe(size);
  let block = crypto.createHash('sha256').update(String(seed)).digest();
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(out, offset, 0, Math.min(block.length, size - offset));
    if ((offset & 0xffff) === 0) block = crypto.createHash('sha256').update(block).digest();
  }
  return out;
}
function write(root, relativePath, body) {
  const absolute = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}
function chunksOf(body) {
  const chunks = [];
  for (let offset = 0, index = 0; offset < body.length; offset += CHUNK, index += 1) {
    const slice = body.subarray(offset, Math.min(body.length, offset + CHUNK));
    chunks.push({ chunkIndex: index, byteOffset: offset, byteSize: slice.length, sha256: sha256(slice) });
  }
  return chunks;
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

async function runPool(jobs, concurrency) {
  const latencies = [];
  let next = 0;
  const started = performance.now();
  async function lane() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t0 = performance.now();
      await job();
      latencies.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  return { wallMs: performance.now() - started, ...stats(latencies) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-asset-bench-'));
  const modelsMount = path.join(root, 'models');
  fs.mkdirSync(modelsMount, { recursive: true });
  process.env.DATA_DIR = path.join(root, 'data');

  const { config } = require('../server/config');
  config.modelsMount = modelsMount;
  config.xAccelRedirectPrefix = '';
  const auth = require('../server/auth');
  const assets = require('../server/assets');
  const { openDatabase } = require('../server/database');
  const { ViewerRepository } = require('../server/repository');

  let server;
  let database;
  try {
    const tilesDir = 'task-1/attempt-1/tiles';
    const eptDir = 'task-1/attempt-1/ept';
    const tilesManifest = [];
    const tileset = Buffer.from(JSON.stringify({ asset: { version: '1.1' }, root: {} }));
    write(modelsMount, `${tilesDir}/tileset.json`, tileset);
    tilesManifest.push({ relativePath: 'tileset.json', byteSize: tileset.length, sha256: sha256(tileset) });
    for (let i = 0; i < TILE_COUNT; i += 1) {
      const rel = `${Math.floor(i / 16)}/${i % 4}/tile-${i}.b3dm`;
      const body = pseudoRandom(TILE_BYTES, `tile${i}`);
      write(modelsMount, `${tilesDir}/${rel}`, body);
      tilesManifest.push({ relativePath: rel, byteSize: body.length, sha256: sha256(body) });
    }
    const eptManifest = [];
    const eptJson = Buffer.from('{"dataType":"laszip","schema":[]}');
    write(modelsMount, `${eptDir}/ept.json`, eptJson);
    eptManifest.push({ relativePath: 'ept.json', byteSize: eptJson.length, sha256: sha256(eptJson) });
    for (let i = 0; i < EPT_COUNT; i += 1) {
      const rel = `ept-data/${Math.floor(i / 8)}-${i % 8}-0-0.laz`;
      const body = pseudoRandom(EPT_BYTES, `ept${i}`);
      write(modelsMount, `${eptDir}/${rel}`, body);
      eptManifest.push({ relativePath: rel, byteSize: body.length, sha256: sha256(body) });
    }
    const ortho = pseudoRandom(ORTHO_BYTES, 'ortho');
    write(modelsMount, 'task-1/attempt-1/odm_orthophoto.tif', ortho);
    const dsm = pseudoRandom(ORTHO_BYTES / 2, 'dsm');
    write(modelsMount, 'task-1/attempt-1/dsm.tif', dsm);

    // Published assets are long settled. Let the fixture age past the integrity
    // cache's racily-clean window so it is measured like real storage.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    database = openDatabase(path.join(root, 'viewer.sqlite'));
    const repository = new ViewerRepository(database);
    const modelId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    repository.upsertModelVersion({
      modelId, versionId, provider: 'ltds-processing', providerModelId: 'bench', providerVersionId: sha256('bench'),
      displayName: 'Bench model', status: 'ready', sourceLocator: {}, versionMetadata: {},
      assets: [
        { kind: 'tiles', rootKey: 'models', relativePath: `${tilesDir}/tileset.json`, format: '3dtiles', byteSize: tileset.length, sha256: sha256(tileset), manifestSha256: sha256(JSON.stringify(tilesManifest)), manifestFiles: tilesManifest, storageMode: 'managed', published: true },
        { kind: 'ept', rootKey: 'models', relativePath: `${eptDir}/ept.json`, format: 'ept', byteSize: eptJson.length, sha256: sha256(eptJson), manifestSha256: sha256(JSON.stringify(eptManifest)), manifestFiles: eptManifest, storageMode: 'managed', published: true },
        { kind: 'ortho', rootKey: 'models', relativePath: 'task-1/attempt-1/odm_orthophoto.tif', format: 'tif', byteSize: ortho.length, sha256: sha256(ortho), chunks: chunksOf(ortho), storageMode: 'managed', published: true },
        // Legacy shape: whole-file SHA-256 only, no chunk rows.
        { kind: 'dsm', rootKey: 'models', relativePath: 'task-1/attempt-1/dsm.tif', format: 'tif', byteSize: dsm.length, sha256: sha256(dsm), storageMode: 'managed', published: true },
      ],
      makeActive: true,
    });
    repository.createViewerSession({
      tokenHash: auth.hashToken(token), modelId, modelVersionId: versionId, subject: 'ops:bench', audience: 'ops',
      permissions: { view: true, measure: true, cameras: true }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assets.setRepository(repository);
    if (UNCACHED && assets.assetIntegrityCache) assets.assetIntegrityCache.platform = 'win32';
    const app = express();
    app.use((req, _res, next) => { req.cookies = {}; next(); });
    app.use(assets);
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Same capability URL shape the session configuration hands the browser.
    const base = `/session-assets/${encodeURIComponent(token)}/${encodeURIComponent(modelId)}/models/`;
    const urls = { ortho: `${base}task-1/attempt-1/odm_orthophoto.tif`, dsm: `${base}task-1/attempt-1/dsm.tif` };
    const tileBase = `${base}${tilesDir}/`;
    const eptBase = `${base}${eptDir}/`;

    async function get(url, headers = {}, expectedBytes = null) {
      const response = await fetch(url, { headers });
      const body = Buffer.from(await response.arrayBuffer());
      if (response.status !== 200 && response.status !== 206) throw new Error(`${response.status} for ${url}`);
      if (expectedBytes !== null && body.length !== expectedBytes) throw new Error(`short body for ${url}`);
      return response;
    }
    const tileJobs = tilesManifest.slice(1).map((file) => () => get(`${origin}${tileBase}${file.relativePath}`, {}, file.byteSize));
    const eptJobs = eptManifest.slice(1).map((file) => () => get(`${origin}${eptBase}${file.relativePath}`, {}, file.byteSize));
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const offsets = Array.from({ length: RANGE_COUNT }, () => Math.floor(rand() * (ORTHO_BYTES / RANGE_BYTES)) * RANGE_BYTES);
    const rangeJobs = (url, size) => offsets.map((offset) => () => {
      const start = offset % size;
      const end = Math.min(size - 1, start + RANGE_BYTES - 1);
      return get(`${origin}${url}`, { range: `bytes=${start}-${end}` }, end - start + 1);
    });
    const dsmRanges = rangeJobs(urls.dsm, dsm.length).slice(0, Math.max(8, Math.floor(RANGE_COUNT / 8)));

    const firstResponse = await fetch(`${origin}${tileBase}${tilesManifest[1].relativePath}`);
    await firstResponse.arrayBuffer();
    const headers = Object.fromEntries(['cache-control', 'etag', 'content-encoding', 'accept-ranges', 'server-timing'].map((name) => [name, firstResponse.headers.get(name)]));

    const result = { fixture: { tiles: TILE_COUNT, tileKiB: TILE_BYTES / 1024, ept: EPT_COUNT, eptKiB: EPT_BYTES / 1024, orthoMiB: ORTHO_BYTES / 1048576, orthoRanges: RANGE_COUNT, legacyDsmRanges: dsmRanges.length, concurrency: CONCURRENCY, uncached: UNCACHED }, headers, passes: {} };
    for (const pass of ['cold', 'warm']) {
      result.passes[pass] = {
        tiles: await runPool(tileJobs, CONCURRENCY),
        ept: await runPool(eptJobs, CONCURRENCY),
        orthoRanges: await runPool(rangeJobs(urls.ortho, ortho.length), CONCURRENCY),
        legacyDsmRanges: await runPool(dsmRanges, CONCURRENCY),
      };
    }
    if (assets.assetIntegrityCache) result.integrityCache = { ...assets.assetIntegrityCache.stats };
    const round = (value) => typeof value === 'number' ? Math.round(value * 10) / 10 : value;
    const rounded = JSON.parse(JSON.stringify(result, (_key, value) => round(value)));
    if (JSON_OUTPUT) { console.log(JSON.stringify(rounded, null, 2)); return; }
    console.log('fixture', JSON.stringify(rounded.fixture));
    console.log('tile response headers', JSON.stringify(rounded.headers));
    if (rounded.integrityCache) console.log('integrity cache', JSON.stringify(rounded.integrityCache));
    for (const [pass, groups] of Object.entries(rounded.passes)) {
      for (const [name, value] of Object.entries(groups)) {
        console.log(`${pass.padEnd(5)} ${name.padEnd(16)} wall ${String(value.wallMs).padStart(8)} ms  p50 ${String(value.p50).padStart(7)}  p95 ${String(value.p95).padStart(7)}  max ${String(value.max).padStart(7)}  n=${value.n}`);
      }
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { assets.setRepository(null); } catch { /* not loaded */ }
    try { database?.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
