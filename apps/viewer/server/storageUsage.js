'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { setImmediate: yieldTurn, setTimeout: pause } = require('node:timers/promises');

const ROOT_KEYS = ['datasets', 'models', 'cache', 'trash', 'dataset_import', 'terra_import'];
const CATEGORIES = ['sources', 'products', 'cache', 'trash', 'other'];
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const identity = stat => stat.ino ? `${stat.dev}:${stat.ino}` : null;

// Registry paths classify files, never supply their size. Unknown files remain Other.
async function registryCategories(database, roots, limit = 500000) {
  const result = new Map();
  if (!database) return result;
  const add = (rootKey, relative, category) => {
    const root = roots[rootKey];
    if (!root || typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(relative)) return;
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute)) return;
    if (result.size >= limit) throw Object.assign(new Error('registry limit'), { code: 'registry_entry_limit' });
    if (category === 'sources' || !result.has(absolute)) result.set(absolute, category);
  };
  const queries = [
    ["SELECT rowid AS cursor,root_key,relative_path FROM model_camera_photos WHERE rowid>? ORDER BY rowid LIMIT 250", 'sources'],
    ["SELECT f.rowid AS cursor,d.root_key,d.relative_path || '/' || f.relative_path AS relative_path FROM dataset_files f JOIN datasets d ON d.id=f.dataset_id WHERE d.storage_mode<>'external_reference' AND d.root_key='datasets' AND f.rowid>? ORDER BY f.rowid LIMIT 250", 'sources'],
    ["SELECT rowid AS cursor,root_key,relative_path FROM model_assets WHERE kind IN ('tiles','glb','ept','pointCloud','ortho','dsm','dtm') AND rowid>? ORDER BY rowid LIMIT 250", 'products'],
    ["SELECT f.rowid AS cursor,a.root_key,a.relative_path AS asset_path,f.relative_path FROM model_asset_files f JOIN model_assets a ON a.id=f.asset_id WHERE a.kind IN ('tiles','ept') AND f.rowid>? ORDER BY f.rowid LIMIT 250", 'products'],
    ["SELECT f.rowid AS cursor,d.root_key,d.relative_path || '/' || f.relative_path AS relative_path,f.role FROM retained_import_files f JOIN retained_imports r ON r.id=f.retained_import_id JOIN datasets d ON d.id=r.dataset_id WHERE d.storage_mode<>'external_reference' AND f.rowid>? ORDER BY f.rowid LIMIT 250", 'retained'],
  ];
  let count = 0;
  for (const [query, category] of queries) {
    let cursor = 0;
    while (true) {
      const rows = database.prepare(query).all(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        const selected = category !== 'retained' ? category : row.role === 'source_photo' ? 'sources' : ['mesh_glb','mesh_obj','mesh_mtl','mesh_texture','ept','point_cloud_source','orthophoto','orthophoto_cutline','dsm','dtm'].includes(row.role) ? 'products' : 'other';
        add(row.root_key, row.asset_path ? path.posix.join(path.posix.dirname(row.asset_path), row.relative_path) : row.relative_path, selected);
        if (++count > limit) throw Object.assign(new Error('registry limit'), { code: 'registry_entry_limit' });
        cursor = row.cursor;
      }
      // Never keep a live SQLite iterator/transaction across an event-loop yield.
      await yieldTurn();
    }
  }
  return result;
}

async function measureStorageUsage({ roots, database, categories, maxEntries = 500000, maxDurationMs = 600000, throttleMs = 100, now = Date.now, io = fs }) {
  const started = now(), counts = Object.fromEntries(CATEGORIES.map(key => [key, { bytes: 0, files: 0 }]));
  const errors = [], resolved = {}, seenFiles = new Map(), seenDirs = new Set(), filesystems = new Map();
  let entries = 0, skippedSymlinks = 0, complete = true;
  const issue = (root, code) => { complete = false; if (errors.length < 20) errors.push({ root, code }); };
  for (const key of ROOT_KEYS) {
    if (!roots[key]) continue;
    try {
      const root = path.resolve(roots[key]), stat = await io.lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { issue(key, 'unsafe_storage_root'); continue; }
      resolved[key] = await io.realpath(root);
      const capacity = await io.statfs(root), device = String(stat.dev);
      if (!filesystems.has(device)) filesystems.set(device, { roots: [], totalBytes: Number(capacity.blocks) * Number(capacity.bsize), availableBytes: Number(capacity.bavail) * Number(capacity.bsize) });
      filesystems.get(device).roots.push(key);
    } catch (error) { issue(key, error.code || 'storage_root_unavailable'); }
  }
  let classified = categories;
  if (!classified) { try { classified = await registryCategories(database, resolved, maxEntries); } catch (error) { issue('registry', error.code || 'classification_unavailable'); classified = new Map(); } }
  // Nested roots are visited once, but the most specific root determines category.
  const ordered = Object.entries(resolved).sort((a, b) => b[1].length - a[1].length || ROOT_KEYS.indexOf(a[0]) - ROOT_KEYS.indexOf(b[0]));
  const owner = absolute => ordered.find(([, root]) => inside(root, absolute))?.[0];
  const walk = async (directory, key, boundary, depth = 0) => {
    if (entries >= maxEntries || now() - started >= maxDurationMs) { issue(key, 'scan_limit'); return; }
    if (depth > 128) { issue(key, 'scan_depth_limit'); return; }
    let handle;
    try {
      if (!inside(boundary, await io.realpath(directory))) { issue(key, 'path_outside_root'); return; }
      const stat = await io.lstat(directory);
      if (stat.isSymbolicLink()) { skippedSymlinks++; issue(key, 'symlink_skipped'); return; }
      const dirId = identity(stat) || directory;
      if (seenDirs.has(dirId)) return;
      seenDirs.add(dirId);
      handle = await io.opendir(directory);
      for await (const entry of handle) {
        if (++entries > maxEntries || now() - started >= maxDurationMs) { issue(key, 'scan_limit'); break; }
        if (entries % 100 === 0) await pause(throttleMs);
        const absolute = path.join(directory, entry.name);
        try {
          const info = await io.lstat(absolute);
          if (info.isSymbolicLink()) { skippedSymlinks++; issue(key, 'symlink_skipped'); continue; }
          if (info.isDirectory()) { await walk(absolute, owner(absolute) || key, boundary, depth + 1); continue; }
          if (!info.isFile()) { issue(key, 'special_file_skipped'); continue; }
          if (!inside(boundary, await io.realpath(absolute))) { issue(key, 'path_outside_root'); continue; }
          const id = identity(info) || absolute;
          const rootKey = owner(absolute), category = rootKey === 'trash' ? 'trash' : ['cache', 'dataset_import', 'terra_import'].includes(rootKey) ? 'cache' : classified.get(absolute) || 'other';
          const previous = seenFiles.get(id), rank = { sources: 5, products: 4, other: 3, trash: 2, cache: 1 };
          if (previous) {
            if (info.size !== previous.bytes) issue(key, 'file_changed_during_measurement');
            if (rank[category] <= rank[previous.category]) continue;
            counts[previous.category].bytes -= previous.bytes; counts[previous.category].files--;
          }
          seenFiles.set(id, { category, bytes: info.size });
          counts[category].bytes += info.size; counts[category].files++;
        } catch (error) { issue(key, error.code || 'file_unavailable'); }
      }
    } catch (error) { issue(key, error.code || 'directory_unavailable'); }
  };
  for (const [key, root] of [...ordered].reverse()) await walk(root, key, root);
  return { status: complete ? 'complete' : 'partial', measuredAt: new Date(now()).toISOString(), startedAt: new Date(started).toISOString(), totalBytes: Object.values(counts).reduce((sum, item) => sum + item.bytes, 0), categories: counts, filesystems: [...filesystems.values()], errors, skippedSymlinks, entries, accounting: 'unique-file-logical-bytes', scope: 'Configured dataset/model/cache/trash/import roots only; excludes database/WAL outside those roots, external references, snapshots, filesystem metadata and compression effects', excluded: ['database_and_other_data_outside_scanned_roots', 'external_references', 'snapshots'] };
}

function createStorageUsageMonitor({ storage, database, ttlMs = 300000, measure = measureStorageUsage, now = Date.now }) {
  let snapshot = null, pending = null, finished = 0;
  const read = () => {
    const stale = !snapshot || now() - finished >= ttlMs;
    if (stale && !pending) {
      pending = Promise.resolve().then(() => measure({ roots: storage.roots, database })).then(value => { snapshot = value; finished = now(); }, error => { snapshot = { status: 'error', measuredAt: null, totalBytes: null, categories: null, errors: [{ code: error.code || 'storage_measurement_failed' }] }; finished = now(); }).finally(() => { pending = null; });
    }
    return { ...(snapshot || { status: 'pending', measuredAt: null, totalBytes: null, categories: null, errors: [] }), stale, refreshing: Boolean(pending), refreshIntervalMs: ttlMs };
  };
  return { read, whenIdle: () => pending || Promise.resolve() };
}

module.exports = { measureStorageUsage, createStorageUsageMonitor, registryCategories };
