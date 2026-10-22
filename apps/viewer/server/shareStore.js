// Tiny JSON-file store for share links (`ViewerShare`). Separate file from
// store.js's project records so the two collections never collide, but same
// load/persist pattern. Never stores raw tokens — only their SHA-256 hash
// (see server/auth.js).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

const FILE = path.join(config.dataDir, 'viewer-shares.json');

let cache = null;

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
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

function getAllForProject(viewerProjectId) {
  return getAll().filter((s) => s.viewerProjectId === viewerProjectId);
}

function getById(id) {
  return load()[id] || null;
}

function getByTokenHash(tokenHash) {
  return getAll().find((s) => s.tokenHash === tokenHash) || null;
}

function create(record) {
  const db = load();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db[id] = {
    id,
    active: true,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: now,
    permissions: { measure: true, cameras: true },
    ...record,
  };
  persist();
  return db[id];
}

function update(id, patch) {
  const db = load();
  if (!db[id]) return null;
  db[id] = { ...db[id], ...patch };
  persist();
  return db[id];
}

function recordAccess(id) {
  const db = load();
  if (!db[id]) return;
  db[id].accessCount = (db[id].accessCount || 0) + 1;
  db[id].lastAccessedAt = new Date().toISOString();
  persist();
}

// A share is live if it exists, is active, and (if set) hasn't expired yet.
function isLive(share) {
  if (!share || !share.active) return false;
  if (share.expiresAt && Date.now() > Date.parse(share.expiresAt)) return false;
  return true;
}

module.exports = { getAll, getAllForProject, getById, getByTokenHash, create, update, recordAccess, isLive };
