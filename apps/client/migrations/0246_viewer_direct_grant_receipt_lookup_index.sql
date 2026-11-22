-- A direct Viewer grant's create receipt is looked up by (grant_id, action='grant.create'): the recipient
-- authority pin read today, and per restricted grant in the per-client cap and client-portal read once
-- share exclusions land. Without this index each lookup scans the whole receipt ledger.
-- Additive only: no table, trigger or data change.
CREATE INDEX viewer_direct_client_grant_receipts_grant_action
 ON viewer_direct_client_grant_mutation_receipts(grant_id,action);
