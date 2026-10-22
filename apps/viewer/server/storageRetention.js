'use strict';

// The short recovery window applies only to freshly proven automatic output
// retirement. Manual deletions retain their existing recovery contract, and
// existing trash rows keep their persisted deadlines.
const AUTOMATIC_OUTPUT_RETENTION_DAYS = 7;
const MANUAL_ASSET_RETENTION_DAYS = 14;
function storageTrashRetentionMs(actor) {
  return (actor === 'viewer-output-maintenance'
    ? AUTOMATIC_OUTPUT_RETENTION_DAYS : MANUAL_ASSET_RETENTION_DAYS) * 86400_000;
}
module.exports = { AUTOMATIC_OUTPUT_RETENTION_DAYS, MANUAL_ASSET_RETENTION_DAYS, storageTrashRetentionMs };
