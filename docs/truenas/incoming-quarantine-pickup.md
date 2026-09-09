# TrueNAS Incoming quarantine pickup

This worker handles completed inbound-file-request objects stored in the
private Incoming R2 bucket. It is not a Client Delivery sync, does not share
or preview uploads, and does not expose incoming content before the scan
passes.

Uploads remain under the private `quarantine/<request-id>/<upload-id>/object`
staging prefix until the server has completed its checks. That opaque key is
an implementation detail, not a destination hierarchy. Do not configure any
generic server mirror, Cloud Sync task, rclone task, or Windows copy job to
list, copy, or delete `quarantine/`. The repository-owned pickup worker is
the only supported reader of that prefix.

The repository-owned worker is
[`scripts/truenas/incoming-pickup-worker.sh`](../../scripts/truenas/incoming-pickup-worker.sh).
It uses the existing Operations receipt endpoint plus the private pickup-status
callback; no new public list or download endpoint is needed or enabled.
Deploy the corresponding Operations migration
`0199_incoming_upload_pickup_lifecycle.sql` before scheduling this worker.

## Separate verification and pickup rollout

The next worker revision separates verification from moving the file to the
server. Apply `0211_incoming_upload_verification_lifecycle.sql` before using
the new verification callbacks. The existing `--once` pickup path remains
compatible during rollout; it does not create a reusable verification proof
for browser access.

After release acceptance, schedule `--verify-only` frequently with
`INCOMING_PICKUP_MAX_JOBS=1`, and `--pickup-only` at minute zero each hour.
Pickup waits up to `INCOMING_PICKUP_LOCK_WAIT_SECONDS` (default 1,800 seconds,
configurable from 0 to 3,600) for the shared lock rather than silently skipping
an hour. A timeout exits unsuccessfully with a bounded diagnostic. The schedule
starts pickup at the hour; a busy verifier can delay the actual transfer. Do
not run the legacy combined job alongside this two-stage schedule.

The intended two-stage schedule is frequent verification followed by
start-of-hour pickup. Verification must leave the original object in R2.
Pickup must use the original filename and remove the exact source object only
after a durable, integrity-checked local copy exists. Do not enable new script
modes until their end-to-end tests and deployment checks are complete.

Operations distinguishes **awaiting verification**, **verifying**, **verified —
awaiting server pickup**, and **downloaded by server**. A retry is not a malware
verdict. A failed or timed-out scan never authorizes a download.

Authorized staff can explicitly download a verified file while the exact
verified object remains in R2. The download route rechecks object identity and
returns an attachment, not an inline preview or public storage URL. Byte ranges
are supported while that object remains available. Once hourly pickup removes
it, a new browser download or resume cannot read it from R2; use the server copy.
Per-file download alone does not provide ZIP inventory browsing. The separate
inventory increment below requires its own migration, application, and worker
update.

### Verified ZIP inventory increment

After migration `0212_incoming_upload_archive_inventory.sql` and the matching
Operations and TrueNAS updates, a verified ZIP can show folder and file names
inside its upload record. This is a bounded central-directory inventory, not
an extracted preview or a member-download endpoint. The only content download
remains the explicit verified archive attachment.

The verifier generates inventory from the already scanned local file and sends
bounded, sequential pages against the exact verification receipt. Operations
stores its own verified object version, including when S3 metadata does not
provide that version to the worker. A listing must match the current proof and
R2 object; changed objects and completed server pickup make it unavailable.

Unsupported, encrypted, malformed, or over-limit inventories remain unavailable
without blocking verified archive download or pickup. Default inventory limits
are 10,000 rows including inferred folders, 4 MiB of central-directory data,
1 MiB of listing metadata, and depth 32. These are listing limits, not a new
file-transfer size limit. Failed inventory callbacks retain private metadata
receipts in the shared state directory, not another copy of the uploaded file.
Verification runs replay at most `INCOMING_PICKUP_INVENTORY_REPLAY_MAX_JOBS`
(default one) before checking new uploads. Round-robin selection and a bounded
retry delay prevent one failed callback from monopolizing later previews.
Replays do not download or scan the source again. A stale-proof conflict retires
the obsolete receipt; it does not override the current verification decision.
Keep this state directory persistent and private across container updates.

This does not recover a folder hierarchy for ordinary uploads: the existing
upload contract stores basenames rather than source-relative paths. Do not
interpret the opaque R2 quarantine prefix as a user folder tree.

Verification receipts bind the SHA-256 scan result to the server-observed
ETag, size, and object version. Listing metadata, a previous file with the same
name, or a UI status is not authorization to read incoming bytes. Existing
accepted records remain server-only; the migration does not invent successful
scan receipts for old records.

### Release acceptance checklist

The staff Incoming page keeps a short Recent uploads summary. **Browse all
uploads** opens a type-to-search collection for the current incoming link,
with 50 records per page and explicit Load more. Search matches filenames or
contributor names, not private storage keys. Inspecting a row opens the same
verification-aware detail used by Recent uploads; collection browsing never
downloads source bytes. Link rotation resets this collection's scope and old
cursors are rejected. This is not a historical cross-link archive or a folder
upload feature: ordinary uploads still retain basenames only.

- Apply the additive database migration before publishing code that queries
  the new columns. Back up and use the migration ledger; do not recreate tables.
- Deploy the Operations verification, listing, and download routes together.
  A Cloudflare-only update cannot make an older TrueNAS script run the new
  verification phase.
- Update the server script/image before selecting its new modes. Verify the
  existing configured API base works without duplicating path segments.
- Test a synthetic upload through verification while leaving it in R2; its
  staff download should become available without waiting for hourly pickup.
- Run verification again: the unchanged verified upload must not be rescanned.
- Run pickup: verify original filename, matching bytes, durable local receipt,
  exact source removal, and final accepted state. Run again to prove no duplicate.
- Exercise interruption after local promotion and after source removal. A
  retry must recover from its receipt, not lose the copy or claim false success.
- Reject mismatched source identity or digest, unverified staff downloads,
  expired claims, and unauthorized listing. A scan timeout remains a retry.
- Confirm upload notification delivery remains separate from scan completion.
- Verify browser refresh removes unavailable download controls after pickup.
  ZIP inventory browsing and the broader client-folder browsing workflow need
  their own acceptance; metadata and attachment download alone do not prove them.
- For the ZIP increment, apply migration 0212 after 0211, then test nested
  folder navigation, literal name search, and pagination on a verified archive.
  Interrupt a metadata callback and verify that another queued inventory can
  proceed and the interrupted one recovers without another source transfer.
  Confirm pickup still succeeds when ZIP metadata is unsupported or unavailable.

## Legacy combined worker security boundary

Give the TrueNAS service identity only these permissions for the dedicated
Incoming R2 bucket:

- list the `quarantine/` prefix;
- read objects under `quarantine/`;
- delete an exact `quarantine/` object **after** clean, durable local
  promotion.

Do not grant it Client Delivery, account-wide, Worker/Wrangler, Project Alpha,
or thumbnail-renderer credentials. The worker also needs the distinct
`INCOMING_PICKUP_SECRET`; it may call only the authenticated, host-gated
`POST /api/internal/uploads/:uploadId/pickup-status` and
`POST /api/internal/uploads/:uploadId/accepted` endpoints on the approved
Incoming host.
Neither secret appears in logs, local receipts, shell command output, nor
documentation examples.

For each object the worker:

1. Pages through only `quarantine/` using the bucket-scoped R2 S3 API, then
   accepts only server-shaped `quarantine/<request-id>/<upload-id>/object`
   keys. `INCOMING_PICKUP_MAX_JOBS` caps actual source-transfer starts, not
   early listing entries, so a deferred object cannot starve later uploads.
2. Claims the exact upload with a locally persisted UUID token and marks the
   private Operations lifecycle as `scanning` before it transfers bytes. It
   refreshes the 15-minute claim lease every five minutes during transfer and
   scanning, and stops before deletion if that lease cannot be renewed. A
   pre-scan size limit is enforced; no archive extraction, renderer, preview,
   or publication happens here.
3. Runs a time-bounded `clamscan`, calculates SHA-256, re-HEADs the object to
   prove its ETag and byte count did not change, and atomically renames the
   staged payload and minimal receipt into the local Incoming dataset as
   `<request-id>/<upload-id>/payload/<original-name>`, with a receipt sidecar
   at `<request-id>/<upload-id>/receipt.json`. The fixed `payload/` directory
   prevents ordinary names such as `receipt.json` from colliding with pickup
   state. The local name comes only from Worker-written, revalidated metadata;
   never from the R2 staging key. Names are limited to 255 UTF-8 bytes on both
   the upload and pickup boundaries.
4. Deletes the exact R2 key only after the durable local promotion succeeds.
5. Posts the existing idempotent receipt with the verified SHA-256 and same
   private claim token. The Operations Worker itself rejects the receipt while
   the R2 object still exists.

An error at any step leaves the R2 object in quarantine. A crash after local
promotion is recoverable: the next run validates the local payload/receipt,
then retries the delete or receipt without re-scanning or duplicating data.
An archive’s inventory is not enumerated until after scanning; staff should use
the locally promoted file for that purpose.

Transfer, scanner, source-identity, delete, and local-promotion failures report
only a bounded retry category and next attempt time to Operations. The worker
also retains that retry schedule locally against the exact R2 ETag/size, so an
hourly schedule does not repeatedly process the same failing object. A ClamAV
positive is retained in quarantine and deferred for 24 hours; it is never
accepted, downloaded through Operations, or silently deleted.

The claim token and object identity are stored only in the worker's restrictive
state/receipt dataset—not in logs or command lines. A worker restart may replay
the same active claim safely; the API does not increment its attempt count for
that replay. A crash after the R2 delete can use that same persisted token for
the receipt-only recovery path, but a live worker never deletes after losing a
claim or receiving a receipt conflict.

An object over the explicit source-size bound is similarly marked as an
operator-deferred retry without downloading any bytes. It remains visible in
Operations, is not reconsidered on every hourly run, and becomes eligible
immediately after an operator raises the configured bound enough for that
unchanged object. This is intentional: size limits are a capacity control, not
an automatic rejection or deletion policy.

## Required environment

Set these values in the TrueNAS Custom App / scheduled-task secret store, not
in an image, compose file, repository, or shell history:

| Variable | Purpose |
| --- | --- |
| `INCOMING_PICKUP_R2_BUCKET` | Dedicated private Incoming bucket only. |
| `INCOMING_PICKUP_R2_ENDPOINT` | Exact account R2 S3 endpoint, e.g. `https://<account-id>.r2.cloudflarestorage.com`. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Bucket-scoped pickup identity, never the Worker credential. |
| `INCOMING_PICKUP_SECRET` | Receipt-only secret configured in Operations. |
| `INCOMING_PICKUP_DESTINATION_DIR` | Restrictive local ZFS Incoming dataset, not a public/share mount and not a path segment named `quarantine`. Startup rejects a symlinked or non-canonical destination. |
| `INCOMING_PICKUP_STAGING_DIR` | Optional staging directory on the **same filesystem** as destination; defaults beneath it. Startup rejects symlinked or quarantine-resolving paths. |
| `INCOMING_PICKUP_STATE_DIR` | Optional private lock/state directory; defaults beneath destination. Startup rejects symlinked or quarantine-resolving paths. |
| `INCOMING_PICKUP_API_BASE` | Optional; defaults to the LTDS Incoming acceptance origin. It must remain an approved Incoming host. |
| `INCOMING_PICKUP_MAX_SOURCE_BYTES` | Optional bound; defaults to 64 GiB. Raise deliberately for larger trusted capacity, never remove. |
| `INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS` | Optional ClamAV limit; defaults to 900 seconds. |
| `INCOMING_PICKUP_MAX_JOBS` | Optional per-run cap; defaults to 24. |
| `INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS` | Optional over-limit recheck delay; defaults to 86,400 seconds and must be 60–86,400. Raising the byte bound makes the object eligible immediately. |

Install `awscli`, `clamav`, `curl`, `python3`, GNU `coreutils`, and `util-linux`
(`flock`) in the container. Update ClamAV signatures through the normal
TrueNAS/container maintenance process before enabling the hourly task.

## Start-of-hour, non-overlapping schedule

Use one scheduled task, not multiple replicas. `flock` inside the script makes
an overlap a harmless skipped run if a large upload is still scanning.

```cron
0 * * * * /usr/local/libexec/incoming-pickup-worker.sh --once
```

### Two-stage verification and pickup after rollout

To separate ClamAV verification from the later local delivery, create two
TrueNAS scheduled tasks using the same image, destination dataset, staging
directory, state directory, bucket credentials, and claim secret. Set the
verifier cap to one transfer and run it frequently; run pickup at minute zero.
Do not also schedule `--once`, because it would create a competing combined
workflow (the shared flock prevents overlap but does not make the workflows
equivalent).

```cron
# Verify at most one pending object per minute; source remains in R2.
* * * * * INCOMING_PICKUP_MAX_JOBS=1 /usr/local/libexec/incoming-pickup-entrypoint.sh --verify-only
# Download only server-verified objects, then durably promote/delete/accept.
0 * * * * /usr/local/libexec/incoming-pickup-entrypoint.sh --pickup-only
```

These are in-container command examples, not paths available on the TrueNAS
host. Configure the scheduler to run the image with the corresponding mode
argument and mounts; do not rely on `docker exec` into the legacy one-shot
container after it has exited. Keep the image entrypoint so verification
refreshes signatures before scanning; pickup deliberately skips that refresh.

For the verifier task set `INCOMING_PICKUP_MAX_JOBS=1` and retain the bounded
scan timeout. For the pickup task, keep the same state and destination paths;
its candidate listing is server-filtered to verified, due uploads. The two
tasks are an operator scheduling configuration only: this repository does not
update an existing TrueNAS scheduler or deploy credentials.

Build [`scripts/truenas/incoming-pickup.Dockerfile`](../../scripts/truenas/incoming-pickup.Dockerfile)
and start it using the accompanying
[`scripts/truenas/incoming-pickup.compose.example.yaml`](../../scripts/truenas/incoming-pickup.compose.example.yaml).
It refreshes ClamAV signatures before each bounded run and fails closed if that
refresh fails. The worker stores source bytes on the local ZFS Incoming dataset,
not tmpfs; large uploads must not exhaust RAM. Its staging and destination
directories must be on the same ZFS filesystem so the promotion is an atomic
rename.

## Operational checks

- In legacy combined mode, **awaiting server pickup** means Operations has not
  received the receipt yet and there is no separate download proof. In the new
  mode, **verified — awaiting server pickup** can be downloaded by authorized
  staff while the exact verified object remains present.
- If a local directory contains `quarantine/<id>/<id>/object`, stop the
  generic bucket mirror that wrote it. It bypassed the pickup worker and must
  exclude the complete `quarantine/` prefix before it is restarted.
- On healthy pickup, the worker logs only a bounded clean-promotion result; it
  never logs names, keys, local paths, content, signed URLs, or secrets.
- If ClamAV fails, times out, or reports malware, the object remains in R2
  quarantine. Do not bypass that state by manually posting an acceptance
  receipt.
- If an object is over the configured size bound, increase the explicit bound
  only after confirming available local storage and scan capacity. The next
  hourly run will retry it immediately after that bound change.
- The existing lifecycle expiry remains the backstop for unclaimed quarantine;
  it is not evidence that a file was accepted.
