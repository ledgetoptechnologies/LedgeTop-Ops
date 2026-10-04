export const BULK_CACHE_PENDING_DELETE_LIMIT = 50;
export const BULK_CACHE_EXPIRED_ROW_LIMIT = 50;
export const BULK_CACHE_ORPHAN_CLAIM_LIMIT = 50;

// Fixed statements (job expiry/reads, candidate reads, pruning) plus the
// worst case of one finalize statement per pending intent and three statements
// (two-statement claim + finalize) per newly claimed generation.
export const BULK_CACHE_CLEANUP_MAX_D1_QUERIES = 9 + BULK_CACHE_PENDING_DELETE_LIMIT
  + 3 * BULK_CACHE_EXPIRED_ROW_LIMIT + 3 * BULK_CACHE_ORPHAN_CLAIM_LIMIT + 6;
