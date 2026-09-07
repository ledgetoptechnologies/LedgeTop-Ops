# TrueNAS Incoming quarantine pickup

This worker handles **only** completed inbound-file-request objects stored in
the private Incoming R2 bucket. It is not a Client Delivery sync, does not
share or preview uploads, and does not expose incoming content before the scan
passes.

The repository-owned worker is
[`scripts/truenas/incoming-pickup-worker.sh`](../../scripts/truenas/incoming-pickup-worker.sh).
It uses the existing Operations receipt endpoint plus the private pickup-status
callback; no new public list or download endpoint is needed or enabled.
Deploy the corresponding Operations migration
`0199_incoming_upload_pickup_lifecycle.sql` before scheduling this worker.

## Security boundary

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
   staged payload and minimal receipt into the local Incoming dataset.
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
| `INCOMING_PICKUP_DESTINATION_DIR` | Restrictive local ZFS Incoming dataset, not a public/share mount. |
| `INCOMING_PICKUP_STAGING_DIR` | Optional staging directory on the **same filesystem** as destination; defaults beneath it. |
| `INCOMING_PICKUP_STATE_DIR` | Optional private lock/state directory; defaults beneath destination. |
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

Build [`scripts/truenas/incoming-pickup.Dockerfile`](../../scripts/truenas/incoming-pickup.Dockerfile)
and start it using the accompanying
[`scripts/truenas/incoming-pickup.compose.example.yaml`](../../scripts/truenas/incoming-pickup.compose.example.yaml).
It refreshes ClamAV signatures before each bounded run and fails closed if that
refresh fails. The worker stores source bytes on the local ZFS Incoming dataset,
not tmpfs; large uploads must not exhaust RAM. Its staging and destination
directories must be on the same ZFS filesystem so the promotion is an atomic
rename.

## Operational checks

- A **pending verification** upload means Operations has not received the
  receipt yet. It is intentionally not downloadable.
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
