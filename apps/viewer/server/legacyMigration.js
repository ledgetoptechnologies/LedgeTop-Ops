'use strict';

const fs = require('fs');
const path = require('path');

const STATE_KEY = 'legacy-json-import-v1';

function readObject(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw new Error(`${path.basename(file)} must contain a JSON object`);
  return parsed;
}

function legacyAssets(record) {
  const assets = [];
  for (const [kind, entry] of Object.entries(record.relAssets || {})) {
    if (!entry || typeof entry !== 'object' || !entry.root || !entry.rel) continue;
    assets.push({
      kind,
      rootKey: String(entry.root),
      relativePath: String(entry.rel),
      format: entry.format ? String(entry.format) : null,
    });
  }
  return assets;
}

function legacyModelInput(record) {
  return {
    provider: 'webodm',
    providerModelId: String(record.webodmProjectId ?? record.id),
    providerVersionId: String(record.webodmTaskId ?? record.id),
    displayName: String(record.title || record.projectName || record.id).slice(0, 240),
    status: record.available ? 'ready' : 'failed',
    metadata: {
      legacy: true,
      projectName: record.projectName || null,
      webodmStatus: record.status ?? null,
      lastSyncedAt: record.lastSyncedAt || null,
      lodProvenance: record.lodProvenance || null,
    },
    versionMetadata: { legacy: true },
    sourceLocator: {
      projectId: record.webodmProjectId ?? null,
      taskId: record.webodmTaskId ?? null,
      legacyAssetRoots: record.assetRoots || {},
    },
    georef: record.georef || {},
    pointCount: record.pointCount ?? null,
    assets: legacyAssets(record),
    aliasId: String(record.id),
  };
}

function migrateLegacyJson(repository, dataDir) {
  if (repository.getState(STATE_KEY) === 'complete') return { skipped: true, models: 0, shares: 0 };
  const projects = readObject(path.join(dataDir, 'viewer-projects.json'));
  const shares = readObject(path.join(dataDir, 'viewer-shares.json'));
  let modelCount = 0;
  let shareCount = 0;

  for (const record of Object.values(projects)) {
    if (!record || typeof record !== 'object' || !record.id) continue;
    repository.upsertModelVersion(legacyModelInput(record));
    modelCount += 1;
  }

  for (const share of Object.values(shares)) {
    if (!share || typeof share !== 'object' || !share.tokenHash || !share.viewerProjectId) continue;
    const model = repository.getModel(String(share.viewerProjectId));
    if (!model) continue;
    repository.importLegacyPublicShare({
      id: share.id ? String(share.id) : undefined,
      modelId: model.id,
      versionPolicy: 'latest',
      publicIdHash: String(share.tokenHash),
      passwordHash: share.passwordHash || null,
      permissions: share.permissions || { measure: true, cameras: true },
      createdAt: share.createdAt || null,
      updatedAt: share.updatedAt || share.createdAt || null,
      expiresAt: share.expiresAt || null,
      revokedAt: share.active === false ? (share.revokedAt || share.updatedAt || new Date().toISOString()) : null,
      accessCount: Number(share.accessCount) || 0,
      lastAccessedAt: share.lastAccessedAt || null,
    });
    shareCount += 1;
  }

  repository.setState(STATE_KEY, 'complete');
  return { skipped: false, models: modelCount, shares: shareCount };
}

module.exports = { STATE_KEY, legacyAssets, legacyModelInput, migrateLegacyJson, readObject };
