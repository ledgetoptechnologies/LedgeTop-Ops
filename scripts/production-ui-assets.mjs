/** Non-deploying retained-assets review planner. This module cannot upload,
 * activate, amend the production profile, or prove inventory completeness.
 * A separately reviewed inventory digest must be supplied by release policy. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROFILE, canonical, hash, need } from './production-deploy.mjs';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && canonical(Object.keys(value).sort()) === canonical([...keys].sort());

function assetPath(value) {
  need(typeof value === 'string' && value.length <= 1024 && /^\/[A-Za-z0-9._/-]+$/.test(value)
    && !value.includes('//') && !value.endsWith('/'), 'Invalid asset path');
  for (const segment of value.slice(1).split('/')) {
    need(segment && !['.', '..'].includes(segment) && !/[. ]$/.test(segment)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment), 'Unsafe asset path segment');
  }
  return value;
}

function localDirectory(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value), 'A local absolute asset directory is required');
  const resolved = path.resolve(value);
  let current = resolved;
  for (;;) {
    const stat = fs.lstatSync(current);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'Asset directory ancestry must contain only regular local directories');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return resolved;
}

export function inventoryDirectory(directory) {
  const root = localDirectory(directory), result = [], names = new Set();
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name), stat = fs.lstatSync(filename);
      need(!stat.isSymbolicLink(), 'Asset symlinks are not supported');
      if (stat.isDirectory()) { walk(filename); continue; }
      need(stat.isFile() && stat.nlink === 1, 'Only unlinked regular asset files are supported');
      const urlPath = assetPath('/' + path.relative(root, filename).split(path.sep).join('/'));
      need(!names.has(urlPath.toLowerCase()), 'Case-colliding asset paths are not supported'); names.add(urlPath.toLowerCase());
      need(result.length < 20_000 && stat.size <= 32 * 1024 * 1024, 'Review planner asset bound exceeded');
      const bytes = fs.readFileSync(filename), after = fs.lstatSync(filename);
      need(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ino === stat.ino
        && bytes.length === stat.size && !after.isSymbolicLink(), 'Asset changed during inventory');
      result.push({ path: urlPath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
  walk(root); need(result.length > 0, 'Asset inventory must not be empty');
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Input inventory is a review artifact, never a self-authorizing claim.
 * Digest approval and completeness provenance must come from outside this
 * planner; an opaque live association alone does not enumerate old assets. */
export function planRetainedUiAssets({ app, inventoryBytes, approvedInventorySHA256,
  retainedDirectory, candidateDirectory, activeVersionId, assetAssociationSHA256,
  profile = PROFILE }) {
  need(['operations', 'client'].includes(app), 'Only existing UI Workers are supported');
  need(SHA.test(approvedInventorySHA256 ?? '') && Buffer.isBuffer(inventoryBytes)
    && inventoryBytes.length <= 8 * 1024 * 1024 && hash(inventoryBytes) === approvedInventorySHA256,
  'An exact externally reviewed historical inventory digest is required');
  let inventory; try { inventory = JSON.parse(inventoryBytes.toString('utf8')); } catch { throw new Error('Invalid historical inventory JSON'); }
  need(own(inventory, ['schemaVersion', 'workerName', 'activeVersionId', 'assetAssociationSHA256', 'supportedVersionIds', 'files'])
    && inventory.schemaVersion === 1 && inventory.workerName === profile.workers[app].name
    && UUID.test(activeVersionId ?? '') && inventory.activeVersionId === activeVersionId
    && SHA.test(assetAssociationSHA256 ?? '') && inventory.assetAssociationSHA256 === assetAssociationSHA256
    && assetAssociationSHA256 === profile.workers[app].assetsSHA256,
  'Historical inventory does not match the recognized live Worker/version/asset association');
  need(Array.isArray(inventory.supportedVersionIds) && inventory.supportedVersionIds.length > 0
    && inventory.supportedVersionIds.length <= 100 && inventory.supportedVersionIds.every(value => UUID.test(value))
    && new Set(inventory.supportedVersionIds).size === inventory.supportedVersionIds.length
    && inventory.supportedVersionIds.includes(activeVersionId), 'Supported historical version identities are required');
  need(Array.isArray(inventory.files) && inventory.files.length > 0 && inventory.files.length <= 20_000,
    'Historical asset file inventory is required');
  const seen = new Set();
  for (const file of inventory.files) {
    need(own(file, ['path', 'size', 'sha256']) && Number.isSafeInteger(file.size) && file.size >= 0
      && SHA.test(file.sha256 ?? ''), 'Invalid historical asset record');
    assetPath(file.path); need(!seen.has(file.path.toLowerCase()), 'Duplicate/case-colliding historical asset path'); seen.add(file.path.toLowerCase());
  }
  const retained = inventoryDirectory(retainedDirectory), candidate = inventoryDirectory(candidateDirectory);
  need(canonical(retained) === canonical(inventory.files), 'Retained bytes must exactly match the reviewed complete inventory');
  const union = new Map(retained.map(file => [file.path, { ...file, source: 'retained' }]));
  for (const file of candidate) {
    const collision = [...union.keys()].find(name => name.toLowerCase() === file.path.toLowerCase());
    need(!collision || collision === file.path, 'Candidate/retained asset paths collide by case');
    const old = union.get(file.path);
    // Only the new HTML entry advances. Every historical chunk and stable
    // asset path must keep identical bytes; rollback retains the original HTML.
    need(!old || file.path === '/index.html' || old.sha256 === file.sha256 && old.size === file.size,
      'Historical asset path would change bytes');
    union.set(file.path, { ...file, source: 'candidate' });
  }
  need(candidate.some(file => file.path === '/index.html'), 'Candidate HTML entry is required');
  const files = [...union.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { schemaVersion: 1, workerName: inventory.workerName, activeVersionId,
    assetAssociationSHA256, historicalInventorySHA256: approvedInventorySHA256,
    unionSHA256: hash(canonical(files)), files,
    rollback: { activeVersionId, assetAssociationSHA256, inventorySHA256: approvedInventorySHA256, files: retained },
    deploymentEnabled: false, completenessProvedByPlanner: false, writesPerformed: false };
}
