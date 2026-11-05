/** Shared bounds for the retained-asset automatic release journal and uploader. */
export const PRODUCTION_AUTO_MAX_INTENTS_PER_RELEASE = 256;
// One asset-session, one worker-version upload, two deployments, plus the
// create/enable/delete lifecycle for three fixed temporary verifiers.
export const PRODUCTION_AUTO_FIXED_RETAINED_INTENTS = 4 + 3 * 3;
export const PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS =
  PRODUCTION_AUTO_MAX_INTENTS_PER_RELEASE - PRODUCTION_AUTO_FIXED_RETAINED_INTENTS;
// Coordinator sourceAndCI runs once initially, once after inactive readback,
// at each of four non-bucket mutation intents, and once at final acceptance.
export const PRODUCTION_AUTO_FIXED_OPS_PRESERVATION_FENCES = 1 + 1 + 4 + 1;
