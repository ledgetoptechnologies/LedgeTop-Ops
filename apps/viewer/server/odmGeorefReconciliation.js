'use strict';

const { readOdmTaskMetadata } = require('./odmTaskMetadata');

const ODM_GEOREF_RECONCILIATION_REVISION = 1;

function missingPath(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function reconcileMissingOdmGeoreference(repository, storage, { limit = 5, revision = ODM_GEOREF_RECONCILIATION_REVISION } = {}) {
  let candidates = repository.listMissingOdmGeorefCandidates(limit, revision);
  if (!candidates.length && repository.odmGeorefBackfillCursor()) {
    repository.advanceOdmGeorefBackfillCursor(null, false);
    candidates = repository.listMissingOdmGeorefCandidates(limit, revision);
  }
  let scanned = 0, updated = 0, terminal = 0, lastVersionId = null;
  for (const candidate of candidates) {
    scanned += 1;
    try {
      const root = storage.resolve(candidate.outputRootKey, candidate.outputRelativePath, { mustExist: true });
      const metadata = readOdmTaskMetadata(root, { strictGeorefIo: true });
      if (repository.mergeModelVersionGeoref(candidate.modelId, candidate.versionId, metadata.georef)) updated += 1;
      if (!repository.modelVersionHasCompleteGeoref(candidate.modelId, candidate.versionId)
        && repository.markModelVersionGeorefReconciliation(candidate.modelId, candidate.versionId, revision)) terminal += 1;
    } catch (error) {
      // An adopted tree can be temporarily unavailable while storage is being
      // restored. Advance the bounded cursor and retry it on the next wrap;
      // malformed metadata is already handled fail-closed by the reader.
      if (!missingPath(error)) throw error;
    }
    lastVersionId = candidate.versionId;
  }
  if (lastVersionId) repository.advanceOdmGeorefBackfillCursor(lastVersionId, candidates.length >= Math.max(1, Math.min(Number(limit) || 5, 20)));
  else repository.advanceOdmGeorefBackfillCursor(null, false);
  return { scanned, updated, terminal };
}

module.exports = { ODM_GEOREF_RECONCILIATION_REVISION, reconcileMissingOdmGeoreference };
