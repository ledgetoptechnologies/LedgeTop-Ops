# Production operations runbook

See [Operational job briefs](job-briefs.md) for the versioned pilot-instruction data model, private KML/reference policy, assignment-scoped access, external navigation coordinate choice, and release sequence.

This runbook records operator-owned controls that are not safely expressible in the application repository.

## Staging

Maintain separate staging Workers, D1 databases, R2 buckets, queues, hostnames, Access applications, and secrets. Never point staging at production `client-data`, production Delivery D1, or production Project Alpha credentials. Before production rollout, test a staff login, scoped folder browse, password-protected share, thumbnail `pending -> ready`, non-image and failed-thumbnail fallback, authorized original activation, range request, bulk download, reconciliation failure, and share revocation.

## Backups and disaster recovery

D1 stores share metadata, access-code hashes, lifecycle state, file-index metadata, thumbnail jobs, job briefs, and audit records. Export production D1 daily to a separate protected R2 prefix or offline destination, retain at least 30 daily copies, and periodically restore into staging. Record the restore owner, timestamp, database version, row counts, and validation results.

TrueNAS ZFS snapshots remain the primary recovery source for originals. R2 is a delivery mirror, not the only backup. Keep the rclone task configuration, R2 bucket lifecycle configuration, Worker bindings, and secret inventory in the operator password manager. Pull `_ltds/audit-archive/**` with a separate protected backup task. The normal `Jobs/Clients/` push must not publish new `.previews` content and must exclude top-level Worker-owned `_ltds` paths and all other reserved subtrees; legacy `.previews` objects may remain only for the documented rollback window. A recovery exercise must cover: restore D1, restore a sample source tree from ZFS, replay or rebuild the file index and current thumbnail jobs, and verify one client link.

## Key rotation

Inventory and version every secret: Access audience/configuration, session signing key, delivery token encryption key, access-code pepper, audit HMAC secret, Stream/API credentials, Project Alpha credentials, webhook signing keys, and TrueNAS/R2 credentials. Delivery accepts `SESSION_KEY_ID` plus `PREVIOUS_SESSION_KEY_ID` and their two secrets during a 24-hour overlap. Access codes and encrypted share-link secrets support current/previous secrets with lazy re-encryption or rehashing. Project Alpha webhooks prefer Ed25519 current/previous public keys; `PROJECT_ALPHA_ALLOW_LEGACY_HMAC=true` is only a dual-rollout switch and must be removed after Project Alpha signs Ed25519 in production. Rotate R2 signing credentials at least every 90 days; their issued URLs live only two minutes.

## Alerts

Send an actionable alert to the team channel/email for: failed or stale rclone sync, failed/dead-lettered thumbnail jobs, ClamAV quarantine, failed D1 backup, failed reconciliation, unusual unavailable-share counts, automatic revocations, repeated Worker 5xx/1102 responses, queue retries/dead letters, and failed deployments. Alerts must include service, environment, time, run id, safe error summary, and the runbook link; never include bearer links, access codes, or secret values.

## Cost and retention controls

Review monthly R2 storage, Class A/Class B operations, egress, Workers requests/CPU, D1 reads/writes, Images transformations, Stream minutes/storage, queue usage, and email volume. Set a budget alert before enabling client bulk downloads at scale. Temporary ZIPs and inbound objects must have lifecycle expiry; derivative objects are rebuildable and should have a documented retention window. The consolidated Operations schedule gzip-archives aged audit/sync rows under the hidden `_ltds/audit-archive/` prefix before deleting D1 rows. Configure TrueNAS to pull that archive prefix into protected backup storage. Never use lifecycle deletion on `Jobs/` originals without a separately approved retention policy.

## Incident order

1. Protect source data: pause destructive rclone and pruning tasks.
2. Confirm Cloudflare service status, Worker errors, queue backlog, and D1 health.
3. Check TrueNAS mount availability and the last successful checksum-verified sync.
4. Disable automatic share revocation if the source-of-truth state is uncertain.
5. Restore or rebuild only after the incident scope is recorded.
6. Reconcile R2, the file index, current thumbnail jobs, and shares; treat
   legacy previews as rollback-only artifacts, then resume normal jobs.

## Combined release residual risks and non-deployment boundary

- Local tests and dry-run configuration checks do not prove Cloudflare Images
  entitlement, decoder behavior, queue/DLQ existence, R2 event subscriptions,
  cron installation, or production bindings. Verify each in isolated staging.
- Delivery migrations `0105`/`0106`/`0107` and Operations migration `0017` are
  additive and remain after a Worker version rollback. Preserve verified D1
  exports and prior Worker version IDs before rollout.
- Folder-grant mail is at-least-once. Revocation before the final authorization
  check suppresses mail, but a provider-accepted message cannot be recalled;
  the authenticated portal route still rechecks and denies revoked access.
- Project Alpha revocation/remapping fails closed when its signed event or a
  complete snapshot reaches the LTDS projection. External event delivery or
  control-plane delay can extend the last-known-good projection window and must
  be monitored.
- Invalid, empty, unsupported, or over-20-MiB images use a local fallback.
  Thumbnail DLQ rows and retained unreferenced objects for deleted sources require monitoring and
  separately reviewed replay/cleanup.
- Job-brief attachments are append-only and consume private R2 storage. Brief
  updates use best-effort polling, unsaved drafts exist only in browser memory,
  and map actions are representative coordinates rather than road, access,
  airspace, or safe-launch guarantees.

Repository verification, documentation, commit, and push do not deploy a
Worker, apply a remote migration, send a real notification, access real client
data, or write Project Alpha. Each of those actions requires a separate,
explicitly approved rollout.
