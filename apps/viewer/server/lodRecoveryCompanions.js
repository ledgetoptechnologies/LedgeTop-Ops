'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validCameraFilename } = require('./cameraPhotos');
const { compareUtf8, safeRelativePath } = require('./processingSecurity');
const { MAX_FILES, verifyRetainedClosure } = require('./retainedManifest');

const COMPANION_KINDS = new Set(['ept', 'pointCloud', 'ortho', 'dsm', 'dtm', 'shots', 'report']);
const PREFIX = 'recovery-companions';
const fail = (message) => { throw Object.assign(new Error(message), { code: 'lod_recovery_companion_changed' }); };
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function checkedPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || safeRelativePath(value) !== value
    || value.includes(':') || /[\u0000-\u001f]/.test(value)) fail('recovery companion path is unsafe');
  return value;
}
function checkedIntegrity(file) {
  if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('recovery companion has no registered integrity proof');
}
function chunksFor(database, assetId, relativePath, byteSize) {
  const chunks = database.prepare('SELECT chunk_index,byte_offset,byte_size,sha256 FROM model_asset_chunks WHERE asset_id=? AND relative_path=? ORDER BY chunk_index')
    .all(assetId, relativePath).map(row => ({ chunkIndex: row.chunk_index, byteOffset: row.byte_offset, byteSize: row.byte_size, sha256: row.sha256 }));
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    checkedIntegrity(chunk);
    if (chunk.chunkIndex !== index || chunk.byteOffset !== offset || chunk.byteSize < 1) fail('recovery companion chunks are incomplete');
    offset += chunk.byteSize;
  }
  if (chunks.length && offset !== byteSize) fail('recovery companion chunks do not cover their file');
  return chunks;
}

// This is an exact registry snapshot, not rediscovery of a filesystem tree.
// Private provider files and unregistered EPT siblings can never enter it.
function collectRecoveryCompanions(database, versionId, { meshTilesOnly = false } = {}) {
  const assets = [], cameraPhotos = [], files = [], destinations = new Set();
  const addFile = (rootKey, sourceRelativePath, relativePath, file, role) => {
    if (!['models', 'datasets'].includes(rootKey)) fail('recovery companion is outside Viewer-owned storage');
    checkedPath(sourceRelativePath); checkedPath(relativePath); checkedIntegrity(file);
    if (destinations.has(relativePath) || files.length >= MAX_FILES) fail('recovery companion closure is ambiguous or too large');
    destinations.add(relativePath);
    files.push({ rootKey, sourceRelativePath, relativePath, role, byteSize: file.byteSize, sha256: file.sha256,
      ...(file.chunks?.length ? { chunks: file.chunks } : {}) });
  };
  const rows = database.prepare('SELECT * FROM model_assets WHERE version_id=? ORDER BY kind').all(versionId);
  for (const row of rows) {
    if (meshTilesOnly ? row.kind !== 'tiles' : !COMPANION_KINDS.has(row.kind)) continue;
    checkedPath(row.relative_path);
    const relativePath = `${PREFIX}/${row.kind}/${path.posix.basename(row.relative_path)}`;
    const asset = { kind: row.kind, relativePath, format: row.format, contentType: row.content_type,
      byteSize: row.byte_size, sha256: row.sha256, manifestSha256: row.manifest_sha256, chunks: [], manifestFiles: [] };
    checkedIntegrity(asset);
    if (row.kind === 'ept' || row.kind === 'tiles') {
      const members = database.prepare('SELECT relative_path,byte_size,sha256 FROM model_asset_files WHERE asset_id=? ORDER BY relative_path')
        .all(row.id).map(file => ({ relativePath: file.relative_path, byteSize: file.byte_size, sha256: file.sha256 }));
      for (const file of members) { checkedPath(file.relativePath); checkedIntegrity(file); }
      const entry = members.find(file => file.relativePath === path.posix.basename(row.relative_path));
      // Existing tree digests use localeCompare; retain that exact contract.
      const canonical = [...members].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      if (!entry || entry.byteSize !== asset.byteSize || entry.sha256 !== asset.sha256
        || digest(canonical) !== asset.manifestSha256) fail('recovery hierarchical manifest no longer matches its registered digest');
      for (const file of members) {
        const chunks = chunksFor(database, row.id, file.relativePath, file.byteSize);
        addFile(row.root_key, path.posix.join(path.posix.dirname(row.relative_path), file.relativePath),
          `${PREFIX}/${row.kind}/${file.relativePath}`, { ...file, chunks }, row.kind);
        asset.manifestFiles.push({ ...file, chunks });
      }
    } else {
      asset.chunks = chunksFor(database, row.id, '', row.byte_size);
      addFile(row.root_key, row.relative_path, relativePath, asset, row.kind);
    }
    assets.push(asset);
  }
  const photos = meshTilesOnly ? [] : database.prepare('SELECT filename,root_key,relative_path,content_type,byte_size,sha256 FROM model_camera_photos WHERE version_id=? ORDER BY filename').all(versionId);
  if (photos.length && !assets.some(asset => asset.kind === 'shots')) fail('recovery photos have no registered camera positions');
  for (const photo of photos) {
    if (!validCameraFilename(photo.filename) || photo.content_type !== 'image/jpeg') fail('recovery photo metadata is invalid');
    const value = { filename: photo.filename, relativePath: `${PREFIX}/camera-photos/${photo.filename}`,
      contentType: photo.content_type, byteSize: photo.byte_size, sha256: photo.sha256 };
    addFile(photo.root_key, photo.relative_path, value.relativePath, value, 'camera_photo');
    cameraPhotos.push(value);
  }
  files.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  const byteSize = files.reduce((sum, file) => sum + file.byteSize, 0);
  if (!Number.isSafeInteger(byteSize)) fail('recovery companion storage estimate overflowed');
  const value = { schemaVersion: 1, sourceVersionId: versionId, assets, cameraPhotos, files, byteSize };
  return { ...value, manifestSha256: digest(value) };
}

function verifyRecoveryCompanionPlan(database, versionId, plan, options = {}) {
  const current = collectRecoveryCompanions(database, versionId, options);
  if (!plan || JSON.stringify(current) !== JSON.stringify(plan)) fail('registered recovery companions changed after authorization');
  return current;
}

function companionCopyManifests(plan, storage) {
  try {
  const groups = new Map();
  for (const file of plan.files) {
    // resolve performs configured-root containment; the retained copier then
    // opens every original path component with O_NOFOLLOW, relative to its fd.
    const absolute = storage.resolve(file.rootKey, file.sourceRelativePath);
    let mount = absolute;
    const segments = file.sourceRelativePath.split('/');
    for (const _segment of segments) mount = path.dirname(mount);
    const mountPath = fs.realpathSync.native(mount);
    let checked = mountPath;
    for (const segment of segments.slice(0, -1)) {
      checked = path.join(checked, segment);
      if (fs.lstatSync(checked).isSymbolicLink()) fail('recovery companion source contains a symlink');
    }
    const root = fs.realpathSync.native(path.dirname(absolute)), key = `${file.rootKey}:${root}`;
    if (root !== checked) fail('recovery companion directory changed during containment checks');
    if (root !== mountPath && !root.startsWith(`${mountPath}${path.sep}`)) fail('recovery companion source escaped Viewer storage');
    if (!groups.has(key)) groups.set(key, {
      sourceRootPath: root, sourceRootIdentity: fs.lstatSync(root, { bigint: true }), files: [],
    });
    const group = groups.get(key);
    if (group.sourceRootPath !== root) fail('recovery companion storage root changed');
    const { rootKey: _rootKey, ...member } = file;
    group.files.push({ ...member, sourceRelativePath: path.posix.basename(file.sourceRelativePath) });
  }
  return [...groups.values()];
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) fail('registered recovery companion storage is unavailable; restore the original source before retrying');
    throw error;
  }
}

async function verifyRecoveryCompanionDestination(plan, destination, { signal = null } = {}) {
  if (!plan.files.length) return;
  await verifyRetainedClosure(destination, plan.files.map(file => ({ ...file, sourceRelativePath: file.relativePath })), { signal });
}

function ownedRecoveryCompanions(plan, targetRelativePath, attemptId) {
  return {
    assets: plan.assets.map(asset => ({ ...asset, relativePath: `${targetRelativePath}/${asset.relativePath}`,
      rootKey: 'models', storageMode: 'managed', published: false, sourceAttemptId: attemptId })),
    cameraPhotos: plan.cameraPhotos.map(photo => ({ ...photo,
      relativePath: `${targetRelativePath}/${photo.relativePath}`, rootKey: 'models' })),
  };
}

module.exports = { collectRecoveryCompanions, companionCopyManifests, ownedRecoveryCompanions,
  verifyRecoveryCompanionDestination, verifyRecoveryCompanionPlan };
