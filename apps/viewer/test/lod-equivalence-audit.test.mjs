import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  auditControlledObj2Tiles,
  auditFailureExitCode,
  auditLodEquivalence,
  CONTROLLED_SURFACE_AUDIT_POLICY_V4,
} from '../scripts/lib/lod-equivalence.mjs';
import { TRIANGLE_A, TRIANGLE_B, writeAuditableFixture } from './helpers/lod-fixture.mjs';

const cli = path.join(import.meta.dirname, '..', 'scripts', 'audit-lod-equivalence.mjs');

test('filesystem and operating-system audit failures are retryable rather than semantic invalidity', () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'ENODEV', 'EACCES', 'EBUSY', 'ENOMEM']) {
    assert.equal(auditFailureExitCode(Object.assign(new Error(code), { code })), 4, code);
  }
  assert.equal(auditFailureExitCode(new Error('triangle count differs')), 3);
  assert.equal(auditFailureExitCode(Object.assign(new Error('surface mismatch'), { code: 'lod_surface_equivalence_failed' })), 3);
});

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, source: writeAuditableFixture(directory, options) };
}

test('audits split GLB/B3DM leaves and emits deterministic, artifact-bound evidence', async (t) => {
  const { directory, source } = fixture(t);
  const first = await auditLodEquivalence({ derivativeDir: directory, sourceGlb: source });
  const second = await auditLodEquivalence({ derivativeDir: directory, sourceGlb: source });
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.audit.triangleCount, 2);
  assert.equal(first.audit.leafTriangleCount, 2);
  assert.equal(first.audit.duplicateLeafTriangleCount, 0);
  assert.equal(first.audit.maxNumericDelta, 0);
  assert.deepEqual(first.audit.artifacts.map((entry) => entry.uri), ['leaf-a.b3dm', 'leaf-b.glb', 'tileset.json']);

  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.deepEqual(written, first);
});

test('external source auditing is explicit and keeps provenance artifacts contained', async (t) => {
  const { directory, source } = fixture(t);
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-source-'));
  t.after(() => fs.rmSync(externalDirectory, { recursive: true, force: true }));
  const externalSource = path.join(externalDirectory, 'source.glb');
  fs.copyFileSync(source, externalSource);
  fs.rmSync(source);

  await assert.rejects(
    auditLodEquivalence({ derivativeDir: directory, sourceGlb: externalSource }),
    /source GLB must be inside the derivative directory/,
  );
  const rejected = spawnSync(process.execPath, [cli, directory, externalSource], { encoding: 'utf8' });
  assert.equal(rejected.status, 3);
  assert.match(rejected.stderr, /source GLB must be inside the derivative directory/);

  const accepted = spawnSync(process.execPath, [cli, directory, externalSource, '--external-source'], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.ok(provenance.audit.artifacts.length > 0);
  assert.equal(provenance.audit.artifacts.some((artifact) => artifact.uri.includes('..') || path.isAbsolute(artifact.uri)), false);

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { verifyLodProvenance } = require('../server/lodProvenance');
  const verification = await verifyLodProvenance(path.join(directory, 'lod-provenance.json'), externalSource);
  assert.equal(verification.verified, true, verification.errors?.join('\n'));
});

test('does not emit provenance for arbitrary or nonmatching leaf geometry', (t) => {
  const { directory, source } = fixture(t, { leafABytes: Buffer.from('arbitrary tile bytes') });
  const output = path.join(directory, 'lod-provenance.json');
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /B3DM header is missing/);
  assert.equal(fs.existsSync(output), false);

  writeAuditableFixture(directory, { leafBTriangles: [[[1, 0, 0], [2, 1, 0], [0, 1, 0]]] });
  const mismatch = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(mismatch.status, 3);
  assert.match(mismatch.stderr, /canonical triangle coverage differs|delta .* exceeds tolerance/);
  assert.equal(fs.existsSync(output), false);
});

test('rejects reduced or re-encoded textures even when triangle geometry matches', (t) => {
  const { directory, source } = fixture(t, { leafBTexture: Buffer.from('different-texture') });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /canonical triangle coverage differs|material\/texture evidence differs/);
  assert.equal(fs.existsSync(path.join(directory, 'lod-provenance.json')), false);
});

test('applies tile transforms and accepts small bounded floating-point deltas', (t) => {
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
  const translated = TRIANGLE_B.map(([x, y, z]) => [x - 5 + 1e-7, y, z]);
  const { directory, source } = fixture(t, {
    leafBTriangles: [translated],
    leafBTransform: transform,
    leafBTexcoordTransform: (x, y) => [x + 5 - 1e-7, y],
  });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.ok(evidence.audit.maxNumericDelta > 0);
  assert.ok(evidence.audit.maxNumericDelta <= evidence.audit.coordinateTolerance);
});

test('treats an explicit null tile transform as inherited', (t) => {
  const { directory, source } = fixture(t);
  const manifestPath = path.join(directory, 'tileset.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.root.children[0].transform = null;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('binds external texture payloads so post-audit changes invalidate provenance', async (t) => {
  const { directory, source } = fixture(t, { externalTexture: true });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.ok(evidence.audit.artifacts.some((artifact) => artifact.uri === 'texture.png'));

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { verifyLodProvenance } = require('../server/lodProvenance');
  fs.writeFileSync(path.join(directory, 'texture.png'), 'changed-external-texture');
  const verification = await verifyLodProvenance(path.join(directory, 'lod-provenance.json'), source);
  assert.equal(verification.verified, false);
  assert.match(verification.errors.join('\n'), /artifact size changed \(texture\.png\)/);
});

test('applies a JSON B3DM RTC_CENTER to the audited leaf coordinate frame', (t) => {
  const translated = TRIANGLE_A.map(([x, y, z]) => [x - 2, y, z]);
  const { directory, source } = fixture(t, {
    leafATriangles: [translated],
    leafARtc: [2, 0, 0],
    leafATexcoordTransform: (x, y) => [x + 2, y],
  });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('accepts bounded space padding after an embedded B3DM GLB', (t) => {
  const { directory, source } = fixture(t);
  const leafPath = path.join(directory, 'leaf-a.b3dm');
  const leaf = fs.readFileSync(leafPath);
  const padded = Buffer.concat([leaf, Buffer.alloc(4, 0x20)]);
  padded.writeUInt32LE(padded.length, 8);
  fs.writeFileSync(leafPath, padded);

  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('fails when spatial splitting retriangulates the full-quality frontier', async (t) => {
  const splitHalf = [[TRIANGLE_B[0], [1, 0.5, 0], TRIANGLE_B[2]], [[1, 0.5, 0], TRIANGLE_B[1], TRIANGLE_B[2]]];
  const { directory, source } = fixture(t, { leafBTriangles: splitHalf });
  await assert.rejects(
    auditLodEquivalence({ derivativeDir: directory, sourceGlb: source }),
    /canonical triangle coverage differs/,
  );
});

test('accepts only exact opaque boundary duplicates without inflating source coverage', async (t) => {
  const { directory, source } = fixture(t, { leafBTriangles: [TRIANGLE_B, TRIANGLE_B] });
  const evidence = await auditLodEquivalence({ derivativeDir: directory, sourceGlb: source });
  assert.equal(evidence.audit.triangleCount, 2);
  assert.equal(evidence.audit.leafTriangleCount, 3);
  assert.equal(evidence.audit.duplicateLeafTriangleCount, 1);
});

test('rejects extra non-source geometry even when leaf count inflation resembles boundary overlap', async (t) => {
  const unrelated = [[10, 10, 0], [11, 10, 0], [10, 11, 0]];
  const { directory, source } = fixture(t, { leafBTriangles: [TRIANGLE_B, unrelated] });
  await assert.rejects(
    auditLodEquivalence({ derivativeDir: directory, sourceGlb: source }),
    /canonical triangle coverage differs/,
  );
});

function controlledInputs(directory) {
  const converterInput = path.join(directory, 'model.obj');
  const converterBinary = path.join(directory, 'Obj2Tiles');
  fs.writeFileSync(converterInput, 'o fixture\nv 0 0 0\n');
  const binary = Buffer.from('pinned Obj2Tiles 1.6.2 fixture binary');
  fs.writeFileSync(converterBinary, binary);
  return { converterInput, converterBinary, trustedConverterBinarySha256: [crypto.createHash('sha256').update(binary).digest('hex')] };
}

test('controlled Obj2Tiles audit rejects an unapproved executable before accepting geometry evidence',async t=>{
  const {directory,source}=fixture(t),converterInput=path.join(directory,'model.obj'),converterBinary=path.join(directory,'Obj2Tiles');
  fs.writeFileSync(converterInput,'o fixture\n');
  fs.writeFileSync(converterBinary,'not the pinned release executable');
  await assert.rejects(auditControlledObj2Tiles({derivativeDir:directory,sourceGlb:source,converterInput,converterBinary}),/not an approved Obj2Tiles 1\.6\.2 executable/);
});

test('controlled Obj2Tiles audit accepts boundary retriangulation and texture atlas repacking with bidirectional surface proof', async (t) => {
  const split = [[TRIANGLE_B[0], [1, 0.5, 0], TRIANGLE_B[2]], [[1, 0.5, 0], TRIANGLE_B[1], TRIANGLE_B[2]]];
  const { directory, source } = fixture(t, { leafBTriangles: split, leafBTexture: Buffer.from('repacked-atlas') });
  const provenance = await auditControlledObj2Tiles({ derivativeDir: directory, sourceGlb: source, ...controlledInputs(directory) });
  assert.equal(provenance.schemaVersion, 4);
  assert.equal(provenance.audit.algorithm, 'ltds-obj2tiles-surface-equivalence-v4');
  assert.deepEqual(provenance.audit.policy, CONTROLLED_SURFACE_AUDIT_POLICY_V4);
  assert.equal(provenance.audit.accumulationMethod, CONTROLLED_SURFACE_AUDIT_POLICY_V4.accumulationMethod);
  assert.equal(provenance.audit.acceptance, 'normal');
  assert.equal(provenance.audit.sourceTriangleCount, 2);
  assert.equal(provenance.audit.leafTriangleCount, 3);
  assert.equal(provenance.audit.sourceRender.uvTriangleCount, 2);
  assert.equal(provenance.audit.leafRender.texturedTriangleCount, 3);
  assert.ok(provenance.audit.sourceToLeaves.sampleCount >= 4);
  assert.ok(provenance.audit.leavesToSource.maximumDistance <= provenance.audit.surfaceTolerance);
});

function scaleTriangleForTotalAreaDelta(triangle, areaRelativeDelta) {
  // controlledSurfaceComparison normalizes this fixture by diagonal^2 = 2.
  const totalLeafArea = 1 + (2 * areaRelativeDelta);
  const scale = Math.sqrt((2 * totalLeafArea) - 1);
  const centroid = triangle.reduce((sum, point) => sum.map((value, axis) => value + point[axis] / 3), [0, 0, 0]);
  return triangle.map((point) => point.map((value, axis) => centroid[axis] + ((value - centroid[axis]) * scale)));
}

test('controlled v4 accepts the Rome-sized gray zone only with all margin gates', async (t) => {
  const requestedDelta = 10.618457348535776e-6;
  const scale = Math.sqrt(1 + (2 * requestedDelta));
  const scalePoint = (point) => point.map((value, axis) => axis < 2 ? 0.5 + ((value - 0.5) * scale) : value);
  const { directory, source } = fixture(t, {
    leafATriangles: [TRIANGLE_A.map(scalePoint)],
    leafBTriangles: [TRIANGLE_B.map(scalePoint)],
    leafBTexture: Buffer.from('repacked-atlas'),
  });
  const provenance = await auditControlledObj2Tiles({ derivativeDir: directory, sourceGlb: source, ...controlledInputs(directory) });
  assert.equal(provenance.schemaVersion, 4);
  assert.equal(provenance.audit.acceptance, 'gray-zone');
  assert.ok(provenance.audit.areaRelativeDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalAreaRelativeDeltaLimit);
  assert.ok(provenance.audit.areaRelativeDelta <= CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit);
  assert.ok(provenance.audit.boundsDelta <= provenance.audit.surfaceTolerance * 0.5);
  assert.ok(provenance.audit.centroidDelta <= provenance.audit.surfaceTolerance * 0.5);
  assert.ok(provenance.audit.normalizedSecondMomentDelta <= CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayNormalizedSecondMomentDeltaLimit);
  assert.ok(provenance.audit.numericalAgreement.maximumRelativeDelta <= CONTROLLED_SURFACE_AUDIT_POLICY_V4.numericalAgreementLimit);
});

test('controlled v4 never accepts surface area beyond twelve ppm', async (t) => {
  const leafBTriangle = scaleTriangleForTotalAreaDelta(TRIANGLE_B, 13e-6);
  const { directory, source } = fixture(t, { leafBTriangles: [leafBTriangle], leafBTexture: Buffer.from('repacked-atlas') });
  await assert.rejects(
    auditControlledObj2Tiles({ derivativeDir: directory, sourceGlb: source, ...controlledInputs(directory) }),
    (error) => error.code === 'lod_surface_equivalence_failed'
      && error.details?.metric === 'areaRelativeDelta'
      && error.details?.grayZoneLimit === CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit,
  );
});

test('controlled v4 rejects missing and added geometry despite valid textures', async (t) => {
  let created = fixture(t, { leafBTriangles: [], leafBTexture: Buffer.from('repacked-atlas') });
  await assert.rejects(
    auditControlledObj2Tiles({ derivativeDir: created.directory, sourceGlb: created.source, ...controlledInputs(created.directory) }),
    /controlled surface area differs|no non-degenerate surface area/,
  );

  const added = [[10, 10, 0], [11, 10, 0], [10, 11, 0]];
  created = fixture(t, { leafBTriangles: [TRIANGLE_B, added], leafBTexture: Buffer.from('repacked-atlas') });
  await assert.rejects(
    auditControlledObj2Tiles({ derivativeDir: created.directory, sourceGlb: created.source, ...controlledInputs(created.directory) }),
    (error) => error.code === 'lod_surface_equivalence_failed'
      && error.details?.metric === 'areaRelativeDelta',
  );
});

test('controlled Obj2Tiles audit rejects shifted or missing surface patches', async (t) => {
  const shifted = [[[1.02, 0, 0], [1.02, 1, 0], [0.02, 1, 0]]];
  let created = fixture(t, { leafBTriangles: shifted, leafBTexture: Buffer.from('repacked-atlas') });
  await assert.rejects(
    auditControlledObj2Tiles({ derivativeDir: created.directory, sourceGlb: created.source, ...controlledInputs(created.directory) }),
    /surface (?:bounds|area|distance)/,
  );
  created = fixture(t, { leafBTriangles: [], leafBTexture: Buffer.from('repacked-atlas') });
  await assert.rejects(
    auditControlledObj2Tiles({ derivativeDir: created.directory, sourceGlb: created.source, ...controlledInputs(created.directory) }),
    /surface area differs|no non-degenerate surface area/,
  );
});

test('controlled Obj2Tiles audit rejects missing UV and textured material coverage', async (t) => {
  for (const [needle, replacement, expected] of [
    ['TEXCOORD_0', '_NO_UV____', /does not retain TEXCOORD_0/],
    ['baseColorTexture', 'baseColorFactor_', /does not retain textured base-color material coverage/],
  ]) {
    const { directory, source } = fixture(t);
    const leaf = path.join(directory, 'leaf-b.glb');
    const bytes = fs.readFileSync(leaf);
    const offset = bytes.indexOf(needle);
    assert.ok(offset > 0);
    assert.equal(Buffer.byteLength(needle), Buffer.byteLength(replacement));
    bytes.write(replacement, offset, 'utf8');
    fs.writeFileSync(leaf, bytes);
    await assert.rejects(
      auditControlledObj2Tiles({ derivativeDir: directory, sourceGlb: source, ...controlledInputs(directory) }),
      expected,
    );
  }
});
