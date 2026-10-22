// Tiny JSON-file metadata store. This intentionally never duplicates WebODM's
// database — it only caches viewer-relevant fields (title, resolved asset
// paths, georeference, sync status) keyed by a stable viewer project id
// (`webodm-{projectId}-{taskId}`). Good enough for the handful of projects a
// small business viewer needs; swap for SQLite later if that changes.
'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const FILE = path.join(config.dataDir, 'viewer-projects.json');

let cache = null;

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch (err) {
    cache = {};
  }
  return cache;
}

function persist() {
  ensureDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

function getAll() {
  return Object.values(load());
}

function getById(id) {
  return load()[id] || null;
}

function upsert(record) {
  const db = load();
  db[record.id] = { ...(db[record.id] || {}), ...record, updatedAt: new Date().toISOString() };
  persist();
  return db[record.id];
}

function removeMissing(keepIds) {
  const db = load();
  const keep = new Set(keepIds);
  let changed = false;
  for (const id of Object.keys(db)) {
    if (!keep.has(id)) { delete db[id]; changed = true; }
  }
  if (changed) persist();
}

module.exports = { getAll, getById, upsert, removeMissing };
