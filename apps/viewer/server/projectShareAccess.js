'use strict';

// What a whole-project public link covers, in one place: the link's own routes
// (projectShareApi.js) and its property lines (propertyLines.js) both use it.

const path = require('node:path');
const { publicDerivativeKind } = require('./processingSecurity');

const PROJECT_SHARE_COOKIE = 'ltds_project_share';

// A verified cookie payload is the session of exactly this link. Asset
// capabilities and single-model link cookies are other kinds and never match.
function projectShareSessionMatches(payload, share) {
  return Boolean(payload && share && payload.kind === 'project-share'
    && payload.shareId === share.id && payload.projectId === share.projectId);
}

// The only assets a project link serves.
function projectShareAssets(asset) {
  return asset.published && publicDerivativeKind(asset.kind);
}

// The link opens a model only when it has such assets and each is verified.
function projectShareAssetsReady(repository, model) {
  const publicAssets = model.activeVersion.assets.filter(projectShareAssets);
  return publicAssets.length > 0 && publicAssets.every((asset) => asset.sha256
    && (!['ept', 'tiles'].includes(asset.kind)
      || (asset.manifestSha256 && repository.getModelAssetFile(asset.id, path.posix.basename(asset.relativePath)))));
}

// The model this project link covers under the requested id, or null: the
// active published output of a task of the link's own project, the same rule
// as the link's task and asset routes (getActivePublishedProjectTask). The
// strict form used here also leaves out a task in the recycle bin, whose
// single-model links are revoked.
function projectShareModel(repository, processing, share, modelId) {
  const selected = processing.getActivePublishedProjectTaskForModel(share.projectId, modelId);
  const model = selected ? repository.getModel(modelId) : null;
  if (!model || model.status !== 'ready' || model.activeVersion?.id !== selected.modelVersionId) return null;
  return projectShareAssetsReady(repository, model) ? model : null;
}

module.exports = {
  PROJECT_SHARE_COOKIE,
  projectShareSessionMatches,
  projectShareAssets,
  projectShareAssetsReady,
  projectShareModel,
};
