'use strict';

const express = require('express');
const store = require('./store');
const { requireAdmin } = require('./adminAuth');

const TASK_STATUS = Object.freeze({ QUEUED: 10, RUNNING: 20, FAILED: 30, COMPLETED: 40, CANCELED: 50 });

const router = express.Router();

function assetUrl(projectId, entry) {
  if (!entry) return null;
  return `/assets/${projectId}/${entry.root}/${entry.rel}`;
}

// Shape consumed by main.js / index.html / pointcloud.html. Never includes
// assetRoots (real filesystem paths) or WebODM credentials.
function toClientConfig(p) {
  const a = p.relAssets || {};
  return {
    id: p.id,
    title: p.title,
    projectName: p.projectName,
    status: p.status,
    statusLabel: Object.keys(TASK_STATUS).find((k) => TASK_STATUS[k] === p.status) || 'UNKNOWN',
    available: p.available,
    georef: p.georef,
    pointCount: p.pointCount,
    lodProvenance: p.lodProvenance || null,
    assets: {
      glb: assetUrl(p.id, a.glb),
      tiles: assetUrl(p.id, a.tiles),
      ept: assetUrl(p.id, a.ept),
      obj: assetUrl(p.id, a.obj),
      ortho: assetUrl(p.id, a.ortho),
      dsm: assetUrl(p.id, a.dsm),
      dtm: assetUrl(p.id, a.dtm),
      shots: assetUrl(p.id, a.shots),
      pointCloud: assetUrl(p.id, a.pointCloud),
      pointCloudFormat: a.pointCloud ? a.pointCloud.format : null,
    },
    lastSyncedAt: p.lastSyncedAt,
  };
}

// These endpoints expose the FULL internal project catalog (working asset
// URLs, no share token needed) so they are admin-only — the public-facing
// equivalent is server/shareApi.js's token-gated /api/share/:token.
router.get('/api/models', requireAdmin, (req, res) => {
  const models = store.getAll()
    .filter((p) => p.available)
    .map(toClientConfig)
    .sort((a, b) => a.title.localeCompare(b.title));
  res.json(models);
});

router.get('/api/models/:id', requireAdmin, (req, res) => {
  const p = store.getById(req.params.id);
  if (!p || !p.available) return res.status(404).json({ error: 'model not found' });
  res.json(toClientConfig(p));
});

module.exports = router;
module.exports.toClientConfig = toClientConfig;
