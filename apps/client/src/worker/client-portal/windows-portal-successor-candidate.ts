/** Supplemental local candidate query, NOT authorization. Ordinary live_heads
 * stays original-publication-only. The shared read-only view is also usable by
 * successor audit guards, but never replaces fresh private Ops proof. */
export const WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL = `SELECT canonical_command_json,request_fingerprint,
    publication_operation_id,publication_id,publication_revision,publication_source_sequence,snapshot_id,snapshot_sha256
  FROM operations_portal_native_delivery_successor_candidates
  WHERE authority_id=? AND issuer=? AND subject=?`;
