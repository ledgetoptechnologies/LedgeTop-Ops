'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { compareUtf8, safeRelativePath } = require('./processingSecurity');
const { buildMeshRecoveryManifest } = require('./retainedManifest');

const MAX_DERIVATIVE_INPUT_BYTES = 16 * 1024 ** 3;
const MESH_ROLES = new Set(['mesh_obj', 'mesh_mtl', 'mesh_texture', 'mesh_glb']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function canonicalDerivativeInput(type, files) {
  if (!['mesh_tiles', 'lod_audit', 'ept'].includes(type) || !Array.isArray(files) || !files.length || files.length > 10000) {
    fail('invalid_derivative_input', 'derivative input snapshot is invalid');
  }
  const normalized = files.map((file) => ({
    role: String(file.role || ''),
    rootKey: String(file.rootKey || ''),
    relativePath: safeRelativePath(file.relativePath),
    byteSize: Number(file.byteSize),
    sha256: String(file.sha256 || '').toLowerCase(),
  })).sort((left, right) => compareUtf8(left.rootKey, right.rootKey)
    || compareUtf8(left.relativePath, right.relativePath) || compareUtf8(left.role, right.role));
  if (normalized.some((file) => !/^[A-Za-z0-9_@-]{1,120}$/.test(file.rootKey) || !file.relativePath
    || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    fail('invalid_derivative_input', 'derivative input file metadata is invalid');
  }
  const identities = new Set(normalized.map((file) => `${file.rootKey}\0${file.relativePath}`));
  if (identities.size !== normalized.length) fail('invalid_derivative_input', 'derivative input contains duplicate files');
  if (type === 'ept') {
    if (normalized.length !== 1 || normalized[0].role !== 'point_cloud_source' || !/\.la[sz]$/i.test(normalized[0].relativePath)) fail('invalid_derivative_input', 'EPT requires exactly one LAS or LAZ point-cloud source');
  } else {
    if (normalized.some((file) => !MESH_ROLES.has(file.role))
      || normalized.filter((file) => file.role === 'mesh_obj').length !== 1
      || normalized.filter((file) => file.role === 'mesh_glb').length !== 1) {
      fail('invalid_derivative_input', 'mesh derivatives require one OBJ, one GLB, and their referenced material closure');
    }
  }
  let totalByteSize = 0;
  for (const file of normalized) {
    totalByteSize += file.byteSize;
    if (!Number.isSafeInteger(totalByteSize)) fail('invalid_derivative_input', 'derivative input size exceeds the safe accounting range');
  }
  if (totalByteSize > MAX_DERIVATIVE_INPUT_BYTES) {
    const error = Object.assign(new Error('derivative input closure exceeds the 16 GiB supported bound'), {
      code: 'derivative_source_too_large',
      details: { inputBytes: totalByteSize, limitBytes: MAX_DERIVATIVE_INPUT_BYTES },
    });
    throw error;
  }
  const manifestSha256 = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { schemaVersion: 1, derivativeType: type, files: normalized, fileCount: normalized.length, totalByteSize, manifestSha256 };
}

function hashFile(filePath, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    const abort = () => stream.destroy(Object.assign(new Error('derivative input verification cancelled'), { code: 'lease_lost' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(error); });
    stream.on('end', () => { signal?.removeEventListener('abort', abort); resolve(hash.digest('hex')); });
  });
}

async function verifyDerivativeInputSnapshot(storage, snapshot, { signal = null } = {}) {
  const verified = [];
  for (const file of snapshot.files) {
    const absolute = storage.resolve(file.rootKey, file.relativePath, { mustExist: true });
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.byteSize) fail('derivative_input_changed', 'derivative input changed after it was snapshotted');
    const sha256 = await hashFile(absolute, signal);
    if (sha256 !== file.sha256) fail('derivative_input_changed', 'derivative input changed after it was snapshotted');
    verified.push({ ...file, absolutePath: absolute });
  }
  return verified;
}

async function discoverMeshDerivativeInput(storage, obj, glb, { signal = null } = {}) {
  if (!obj || !glb || obj.root_key !== glb.root_key) fail('unsupported_mesh_derivative_source', 'mesh inputs must share one managed storage root');
  const objDirectory = path.posix.dirname(obj.relative_path);
  if (path.posix.dirname(glb.relative_path) !== objDirectory) fail('unsupported_mesh_derivative_source', 'mesh OBJ and GLB must share one retained closure directory');
  const absoluteRoot = path.dirname(storage.resolve(obj.root_key, obj.relative_path, { mustExist: true }));
  const manifest = await buildMeshRecoveryManifest(absoluteRoot, { signal });
  return canonicalDerivativeInput('mesh_tiles', manifest.files.map((file) => ({
    role: file.role,
    rootKey: obj.root_key,
    relativePath: path.posix.join(objDirectory, file.relativePath),
    byteSize: file.byteSize,
    sha256: file.sha256,
  })));
}

async function discoverPointDerivativeInput(storage, point, { signal = null } = {}) {
  if (!point) fail('unsupported_pointcloud_source', 'point-cloud source is missing');
  const absolute = storage.resolve(point.root_key, point.relative_path, { mustExist: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Number.MAX_SAFE_INTEGER) fail('invalid_derivative_input', 'point-cloud source is not a safe regular file');
  const sha256 = await hashFile(absolute, signal);
  if (point.sha256 && sha256 !== point.sha256) fail('derivative_input_changed', 'registered point-cloud source hash no longer matches');
  return canonicalDerivativeInput('ept', [{ role: 'point_cloud_source', rootKey: point.root_key, relativePath: point.relative_path, byteSize: stat.size, sha256 }]);
}

function registeredPointDerivativeInput(snapshot, assets) {
  const canonical = canonicalDerivativeInput('ept', snapshot?.files);
  if (snapshot?.manifestSha256 !== canonical.manifestSha256) fail('derivative_input_changed', 'point-cloud input snapshot digest changed');
  const input = canonical.files[0];
  const matches = assets.filter(asset => asset.kind === 'pointCloud'
    && asset.root_key === input.rootKey && asset.relative_path === input.relativePath
    && asset.byte_size === input.byteSize && asset.sha256 === input.sha256);
  if (matches.length !== 1) fail('derivative_input_changed', 'point-cloud input no longer matches one registered source');
  return matches[0];
}

module.exports = {
  MAX_DERIVATIVE_INPUT_BYTES,
  canonicalDerivativeInput,
  discoverMeshDerivativeInput,
  discoverPointDerivativeInput,
  verifyDerivativeInputSnapshot,
  registeredPointDerivativeInput,
};
