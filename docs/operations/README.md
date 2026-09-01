# Production operations runbook

See [Operational job briefs](job-briefs.md) for the versioned pilot-instruction data model, private KML/reference policy, assignment-scoped access, external navigation coordinate choice, and release sequence.

See [Internal browser SOP library](sops.md) for the separate Operations-owned authoring lifecycle, Markdown allow list, immutable revisions, published staff access, and exact job-brief revision links. Browser SOPs are not repository runbooks.

See [Staff Client Hub audit timeline](client-audit-timeline.md) for the bounded,
source-qualified event federation, per-adapter authorization and coverage,
cursor/redaction contract, and online-retention boundary.

See [Project Alpha service-assignment receiver foundation](project-alpha-service-assignment-receiver.md)
for the default-off DELIVERY_DB ingress, explicit source/workspace admission,
tenant-containment fences, and the later coordinated enrollment boundary.

See [service-assignment request policy](client-service-assignment-request-policy.md)
for the mandatory `0179` expand, compatible-writer drain, and `0180`-`0181`
contract/review sequence. See [delivery intent source ownership](delivery-intent-source-ownership.md)
for registered-source Access/HMAC authority, `0182`/`0183` notification
scheduling, Operations `0049`, and the default-off activation boundary. See
[business-party linking](business-party-linking.md) for Operations `0048` and
recoverable presentation lifecycle.

See [native portal requests and feedback](native-portal-requests-feedback.md)
for Client migrations `0184`-`0186`, Operations `0050`, exact-source request and
feedback authority, storage-only account isolation, dedicated connector
draft-quote credentials, and the required drain/rollback order.

This runbook records operator-owned controls that are not safely expressible in the application repository.

## Staging

Maintain separate staging Workers, D1 databases, R2 buckets, queues, hostnames, Access applications, and secrets. Never point staging at production `client-data`, production Delivery D1, or production Project Alpha credentials. Before production rollout, test a staff login, scoped folder browse, password-protected share, thumbnail `pending -> ready`, non-image and failed-thumbnail fallback, authorized original activation, range request, bulk download, reconciliation failure, and share revocation.

## Backups and disaster recovery

D1 stores share metadata, access-code hashes, lifecycle state, file-index metadata, thumbnail jobs, job briefs, browser SOPs, and audit records. Export production D1 daily to a separate protected R2 prefix or offline destination, retain at least 30 daily copies, and periodically restore into staging. Record the restore owner, timestamp, database version, row counts, and validation results.

TrueNAS ZFS snapshots remain the primary recovery source for originals. R2 is a delivery mirror, not the only backup. Keep the rclone task configuration, R2 bucket lifecycle configuration, Worker bindings, and secret inventory in the operator password manager. Pull `_ltds/audit-archive/**` with a separate protected backup task. Thumbnail events and backfill cover the exact `Jobs/` tree; normal client delivery uploads still land under `Jobs/Clients/`. A `Jobs/` push must not publish new `.previews` content and must exclude Worker-owned `_ltds` paths and all other reserved subtrees; legacy `.previews` objects may remain only for the documented rollback window. A recovery exercise must cover: restore D1, restore a sample source tree from ZFS, replay or rebuild the file index and current thumbnail jobs, and verify one client link.

Moves do not issue an unsafe R2 `delete(key)`. After an ETag-conditional copy,
the exact old source version is ETag-conditionally replaced by a private
zero-byte `ltds-moved-source-v1` marker. All delivery/list/index paths ignore
the marker, while a later real upload at that path overwrites it normally.
Treat these intentional zero-byte markers as negligible tracked R2 objects;
do not add a lifecycle rule for them, because an unconditional lifecycle
delete could race a later upload at the same key.

## Key rotation

Inventory and version every secret: Access audience/configuration, session signing key, delivery token encryption key, access-code pepper, audit HMAC secret, Stream/API credentials, Project Alpha credentials, webhook signing keys, and TrueNAS/R2 credentials. Delivery accepts `SESSION_KEY_ID` plus `PREVIOUS_SESSION_KEY_ID` and their two secrets during a 24-hour overlap. Access codes and encrypted share-link secrets support current/previous secrets with lazy re-encryption or rehashing. The legacy primary Project Alpha path remains HMAC-compatible, so `PROJECT_ALPHA_ALLOW_LEGACY_HMAC=true` is required with `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET` until a coordinated Ed25519 rollout is proven. Registered business sources use their exact source-owned Ed25519 event authority and portal HMAC/Access authority instead of inheriting that legacy fallback. Provision the same reviewed `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` envelope independently to Delivery, Operations, and Ops Sync; never store it in Wrangler `vars` or logs. Rotate R2 signing credentials at least every 90 days; their issued URLs live only two minutes.

## Alerts

Send an actionable alert to the team channel/email for: failed or stale rclone sync, failed/dead-lettered thumbnail jobs, ClamAV quarantine, failed D1 backup, failed reconciliation, unusual unavailable-share counts, automatic revocations, repeated Worker 5xx/1102 responses, queue retries/dead letters, and failed deployments. Alerts must include service, environment, time, run id, safe error summary, and the runbook link; never include bearer links, access codes, or secret values.

## Cost and retention controls

Review monthly R2 storage, Class A/Class B operations, egress, Workers requests/CPU, D1 reads/writes, Container compute, Stream minutes/storage, queue usage, and email volume. Set a budget alert before enabling client bulk downloads at scale. Temporary ZIPs and inbound objects must have lifecycle expiry; derivative objects are rebuildable and should have a documented retention window. The consolidated Operations schedule gzip-archives aged audit/sync rows under the hidden `_ltds/audit-archive/` prefix before deleting D1 rows. Configure TrueNAS to pull that archive prefix into protected backup storage. Never use lifecycle deletion on `Jobs/` originals without a separately approved retention policy.

## Incident order

1. Protect source data: pause destructive rclone and pruning tasks.
2. Confirm Cloudflare service status, Worker errors, queue backlog, and D1 health.
3. Check TrueNAS mount availability and the last successful checksum-verified sync.
4. Disable automatic share revocation if the source-of-truth state is uncertain.
5. Restore or rebuild only after the incident scope is recorded.
6. Reconcile R2, the file index, current thumbnail jobs, and shares; treat
   legacy previews as rollback-only artifacts, then resume normal jobs.

## Delivery navigation and thumbnail recovery

Delivery opens at `Jobs/Clients/` because that is the normal workspace. For a
currently authorized global delivery operator, the `Jobs` breadcrumb is active
and opens the true `Jobs/` root so internal job folders are reachable. Scoped
operators do not receive that root capability and the breadcrumb is not an
authorization bypass. Direct `/jobs` navigation is subject to the same current
staff session and `delivery.browse` checks.

New supported uploads anywhere under `Jobs/` enter the same version-bound
thumbnail lifecycle. A transient processing or Queue publication failure gets
one automatic bounded second queue lifecycle after a 15-minute delay, with an
overall twelve-attempt ceiling. Continuing failures remain visible for review;
do not manually replay them concurrently. Unsupported files and permanent size
failures correctly remain on their local file-type icon.

## Combined release residual risks and non-deployment boundary

- Local tests and dry-run configuration checks do not prove Cloudflare Container
  entitlement, decoder behavior, queue/DLQ existence, R2 event subscriptions,
  cron installation, or production bindings. Verify each in isolated staging.
- Delivery migrations through `0186` (with reserved ledger gap `0113`), plus
  Operations migrations through `0050`, are
  additive and remain after a Worker version rollback. Preserve verified D1
  exports and prior Worker version IDs before rollout.
- Do not apply `0179`-`0186` as one pending batch. Apply `0179` from a reviewed
  expand-only input, deploy and fully drain the compatible Client writer, then
  apply `0180`-`0183` in order. Apply `0184`-`0186` migration-first before the
  paired final Client/Operations Workers, and keep native request/feedback source
  capabilities unavailable until their exact-source acceptance gates pass.
- Folder-grant mail is at-least-once. Revocation before the final authorization
  check suppresses mail, but a provider-accepted message cannot be recalled;
  the authenticated portal route still rechecks and denies revoked access.
- Project Alpha revocation/remapping fails closed when its signed event or a
  complete snapshot reaches the LTDS projection. External event delivery or
  control-plane delay can extend the last-known-good projection window and must
  be monitored.
- Invalid, empty, unsupported, over-512-MiB or over-110-MP still images and
  over-256-MiB PDFs use a local file-type icon. Supported PDFs render page one.
  The authenticated TrueNAS renderer claims supported images, PDFs, and videos;
  video uses bounded range reads instead of a full scratch copy. Cloudflare is
  a delayed still/PDF fallback only. Office, audio and archive files remain
  icon-only. Thumbnail DLQ rows and retained unregistered prebuilt objects
  require monitoring and separately reviewed replay/cleanup.
- The unified TrueNAS queue renderer, private Container fallback, and optional
  TrueNAS prebuilt renderer
  require separate entitlement/cost and staging evidence. Neither may expose a
  public route, public R2 URL, source credential, or original fallback.
- Job-brief attachments are append-only and consume private R2 storage. Brief
  updates use best-effort polling, unsaved drafts exist only in browser memory,
  and map actions are representative coordinates rather than road, access,
  airspace, or safe-launch guarantees.

Repository verification, documentation, commit, and push do not deploy a
Worker, apply a remote migration, send a real notification, access real client
data, or write Project Alpha. Each of those actions requires a separate,
explicitly approved rollout.
