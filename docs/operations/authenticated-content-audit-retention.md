# Authenticated content audit retention

`portal_authenticated_content_events` is an online, append-only Delivery D1
ledger. Operations retains these rows online for 365 days. A scheduled retention
pass selects at most 1,000 expired rows ordered by occurrence time, writes the
complete selected rows as gzip-compressed JSONL under
`_ltds/audit-archive/delivery/portal_authenticated_content_events/`, and only
then deletes those exact event IDs.

The migration-created `portal_authenticated_content_retention_control` gate is
closed (`delete_enabled=0`, `delete_before=NULL`) during normal operation.
After an archive upload succeeds, Operations uses one atomic D1 batch to open
the gate with the exact canonical 365-day cutoff, delete only selected IDs whose
event timestamp is older than that cutoff, and close and clear the gate. The D1
delete trigger rejects newer rows even while the gate is open. A failed delete
rolls back the entire D1 batch, including the gate change. A failed R2 archive
upload never opens the gate and never deletes a D1 row. Re-running retention is
safe; each pass operates only on rows still online and older than the cutoff.

The R2 archive is protected recovery evidence, not an interactive timeline
source. Staff timelines query online D1 rows and must not claim lifetime
coverage. Configure the protected backup workflow to copy the hidden audit
archive prefix before applying any R2 lifecycle policy to it.

Operational checks:

1. Confirm the scheduled Operations job completed without an archive or D1
   error.
2. Confirm `portal_authenticated_content_retention_control.delete_enabled` is
   `0` and `delete_before` is `NULL`; any other state is a fail-closed incident
   requiring investigation.
3. Confirm new archive objects contain no more than 1,000 JSONL rows and carry
   `table`, `rows`, and `retentionDays=365` custom metadata.
4. Never delete or update ledger rows manually. Restore evidence from the
   protected archive only through a separately reviewed recovery procedure.
