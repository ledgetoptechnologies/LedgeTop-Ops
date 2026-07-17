# TrueNAS Scale to R2 synchronization

TrueNAS remains the source of truth. Start with a non-deleting **Copy** task; do not begin with Sync.

## 1. Dedicated R2 credentials

Create an R2 S3 API token restricted to the `client-data` bucket with object read/write permissions. Do not reuse a Worker build token, Wrangler OAuth token, or Stream token.

In TrueNAS, create an Amazon S3 cloud credential using:

- Access key and secret from the dedicated R2 token.
- Endpoint: the account-specific R2 S3 endpoint shown in Cloudflare.
- Region: `auto`.

Never place the credential in this repository.

## 2. Initial Cloud Sync task

Create a scheduled Cloud Sync **Push** task:

- Transfer mode: `COPY`.
- Local source: the server's jobs directory.
- Remote destination: bucket `client-data`, prefix `jobs` (choose the source/destination pair so the resulting keys are exactly `jobs/...`, not `jobs/jobs/...`).
- Schedule: every 15 minutes.
- Prevent overlapping executions.
- Follow symlinks: off unless specifically required and reviewed.
- Encryption: rely on TLS in transit and Cloudflare server-side encryption; enable client-side encryption only if its key recovery process is documented.

Add both excludes and validate them with nested samples:

```text
**/dump
**/dump/**
```

Do not exclude `unedited`. The portal also denies `dump` and `_ltds` independently, so a filter mistake does not publish raw content.

## 3. Dry run and verification

1. Test with one small client folder.
2. Confirm R2 keys match the existing hierarchy:

   ```text
   jobs/{year}/{client-or-company}/...
   jobs/recurring/{client-or-organization}/...
   ```

3. Confirm a nested `dump` directory is absent and an `unedited` directory is present.
4. Compare file counts and total sizes.
5. Compare representative checksums for images, video, PDFs, and uncommon formats.
6. Confirm new, modified, and renamed files appear dynamically in Ops/Delivery.
7. Confirm R2 create events populate `file_index` and Stream ingestion starts for video.
8. Confirm ZFS snapshots can restore an accidentally changed/deleted source file.

## 4. Copy-to-Sync cutover

Keep COPY for at least one complete verification window. Only after counts, checksums, excludes, snapshots, and portal behavior pass should the task switch to `SYNC`, allowing server deletions to mirror to R2.

Before cutover:

- Take a ZFS snapshot.
- Export the task configuration.
- Record R2 object count and size.
- Schedule the first Sync while someone can monitor it.
- Verify no overlapping task is running.

If deletion behavior is unexpected, stop the task, return to Copy, restore from ZFS if necessary, and reconcile R2 before retrying.

## 5. Monitoring

R2 create/delete notifications feed `ltds-file-events`. Queue processing updates the delivery file index and TrueNAS health timestamp. A daily live R2 reconciliation repairs missed events. Ops should show a stale sync warning when the last successful source activity/reconciliation is outside the agreed window.

The file browser uses live R2 prefix/delimiter listing as the authority, so it updates even if the index temporarily lags. The index exists for search, media state, and thumbnails—not file existence.
