'use strict';

// An upload's cache can hold the only copy of an original CSV or control-point
// source: an unfinished, oversized or cancelled upload never reached its
// dataset, and a newer release keeps such a cache on purpose. Until a release
// that archives those originals runs, no cache with one is removed. Other
// caches are removed as before.
const isSource = (file) => file?.processingRole === 'gcp_source' || /\.csv$/i.test(file?.relativePath || '');

function cleanupUploadCache(processing, storage, uploadId) {
  const upload = processing.getUpload(uploadId);
  if (!upload?.files?.length || upload.files.some(isSource)) return { cleaned: false };
  storage.cleanupUpload(uploadId);
  return { cleaned: true };
}

// `step` isolates one session's failure from the next.
async function cleanUpExpiredUploads(processing, storage, step = (run) => run()) {
  for (const id of processing.expiredUploads().slice(0, 20))
    await step(() => { processing.expireUpload(id); cleanupUploadCache(processing, storage, id); });
}

module.exports = { cleanUpExpiredUploads, cleanupUploadCache };
