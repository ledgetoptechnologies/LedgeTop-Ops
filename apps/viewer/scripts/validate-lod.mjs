#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectLodTileset } from '../lod-policy.mjs';

const require = createRequire(import.meta.url);
const { verifyLodProvenance } = require('../server/lodProvenance');

function contentUri(tile) {
  return tile?.content?.uri || tile?.content?.url || '';
}

function localContentPath(rootDir, baseDir, uri) {
  if (!uri || /^(?:[a-z]+:)?\/\//i.test(uri) || uri.startsWith('data:')) return null;
  const clean = decodeURIComponent(uri.split(/[?#]/, 1)[0]);
  const resolved = path.resolve(baseDir, clean);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function collectContent(tile, output = []) {
  const uri = contentUri(tile);
  if (uri) output.push(uri);
  for (const child of Array.isArray(tile?.children) ? tile.children : []) collectContent(child, output);
  return output;
}

function auditTileMetadata(tile, label, errors) {
  const volume = tile?.boundingVolume;
  const hasVolume = volume && (
    Array.isArray(volume.box) || Array.isArray(volume.sphere) || Array.isArray(volume.region)
  );
  if (!hasVolume) errors.push(`${label}: boundingVolume box, sphere, or region is required`);
  (Array.isArray(tile?.children) ? tile.children : []).forEach((child, index) => {
    auditTileMetadata(child, `${label}.children[${index}]`, errors);
  });
}

async function validateTileset(tilesetPath, state) {
  const absolute = path.resolve(tilesetPath);
  if (state.visited.has(absolute)) return;
  state.visited.add(absolute);

  let tileset;
  try {
    tileset = JSON.parse(await fs.promises.readFile(absolute, 'utf8'));
  } catch (error) {
    state.errors.push(`${absolute}: cannot read tileset (${error.message})`);
    return;
  }

  if (!['1.0', '1.1'].includes(String(tileset?.asset?.version || ''))) {
    state.errors.push(`${absolute}: asset.version must be 1.0 or 1.1`);
  }

  const report = inspectLodTileset(tileset);
  state.tilesets += 1;
  state.nodes += report.nodeCount;
  state.leaves += report.terminalLeafCount;
  state.errors.push(...report.errors.map((message) => `${absolute}: ${message}`));
  auditTileMetadata(tileset.root, `${absolute}: root`, state.errors);

  const directory = path.dirname(absolute);
  for (const uri of collectContent(tileset.root)) {
    const contentPath = localContentPath(state.rootDir, directory, uri);
    if (!contentPath) {
      state.errors.push(`${absolute}: content URI must be a local, non-traversing path (${uri})`);
      continue;
    }
    let stat;
    try {
      stat = await fs.promises.stat(contentPath);
    } catch {
      state.errors.push(`${absolute}: referenced content is missing (${uri})`);
      continue;
    }
    if (!stat.isFile() || stat.size === 0) {
      state.errors.push(`${absolute}: referenced content is empty or not a file (${uri})`);
      continue;
    }
    state.contentFiles += 1;
    state.contentBytes += stat.size;
    if (/\.json$/i.test(contentPath)) await validateTileset(contentPath, state);
  }
}

async function main() {
  const derivativeDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const explicitFullMesh = process.argv[3] ? path.resolve(process.argv[3]) : '';
  if (!derivativeDir) {
    console.error('Usage: npm run validate:lod -- <derivative-directory> [full-mesh.glb|full-mesh.obj]');
    process.exitCode = 2;
    return;
  }

  const state = {
    visited: new Set(), errors: [], tilesets: 0, nodes: 0, leaves: 0,
    contentFiles: 0, contentBytes: 0, rootDir: derivativeDir,
  };
  await validateTileset(path.join(derivativeDir, 'tileset.json'), state);
  if (state.leaves === 0) state.errors.push('LOD hierarchy has no zero-error terminal leaves');

  const manifestPath = path.join(derivativeDir, 'lod-provenance.json');
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    state.errors.push(`${manifestPath}: cannot read provenance (${error.message})`);
  }
  const fullMesh = explicitFullMesh || (manifest?.sourceAsset
    ? path.join(derivativeDir, path.basename(manifest.sourceAsset))
    : '');
  if (!fullMesh) {
    state.errors.push('full-resolution mesh could not be resolved');
  } else {
    const provenance = await verifyLodProvenance(manifestPath, fullMesh);
    state.errors.push(...provenance.errors.map((message) => `${manifestPath}: ${message}`));
  }

  const result = {
    valid: state.errors.length === 0,
    derivativeDir,
    fullMesh: fullMesh || null,
    tilesets: state.tilesets,
    tileNodes: state.nodes,
    zeroErrorLeaves: state.leaves,
    contentFiles: state.contentFiles,
    contentBytes: state.contentBytes,
    errors: state.errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

await main();
