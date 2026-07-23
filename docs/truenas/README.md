# TrueNAS Scale to R2 synchronization

TrueNAS remains the source of truth. Start with a non-deleting **Copy** task; do not begin with Sync. The production source root is `Jobs/` with a capital `J`; R2 keys are case-sensitive and must preserve that spelling.

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
- Remote destination: bucket `client-data`, prefix `Jobs` (choose the source/destination pair so the resulting keys are exactly `Jobs/...`, not `Jobs/Jobs/...`).
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
   Jobs/{year}/{client-or-company}/...
   Jobs/recurring/{client-or-organization}/...
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

## Preview and derivative contract

The source media remains in its normal `Jobs/...` path. Preview derivatives are siblings in the same source folder under its reserved, hidden `_ltds/previews/` prefix. There is no artifact bucket and no preview object is eligible for client delivery.

The authoritative derivative identity is:

```text
preview id = sha256(Unicode-NFC source filename, including extension)
```

Do not lowercase the filename unless the source naming contract explicitly becomes case-insensitive. For `Jobs/2026/Acme/edited/IMG_0042.JPG`, publish to `Jobs/2026/Acme/edited/_ltds/previews/<sha256>/`. The hash prevents unsafe characters in derivative keys and keeps a rename from silently reusing an old preview.

The preview producer writes into a private staging directory, verifies outputs, and publishes the final manifest last. A manifest is valid only when every referenced derivative exists and matches its recorded source size, ETag/checksum, producer version, and creation time. A failed or partial job leaves no current manifest; it never replaces the previous known-good manifest.

Recommended outputs:

- `thumb.webp`: libvips, orientation-aware, bounded to 520×340, cover fit, quality around 72.
- `preview.webp`: libvips, orientation-aware, bounded to 2400×1800, scale-down fit, quality around 84. This is for the viewer, never the download source.
- `poster.webp`: ffmpeg video poster frame, bounded to the thumbnail dimensions. Video playback remains Cloudflare Stream or the original range-enabled object.
- `preview.webp`: Poppler first-page PDF preview, bounded to the viewer dimensions.
- `manifest.json`: written last and containing source identity, derivative keys, dimensions, MIME type, producer version, and failure state if applicable.

All derivative keys remain under `_ltds/`; browser and share-root code must continue to treat them as hidden. Original files are never replaced, transcoded in place, or deleted by the preview producer.

### Resource and security boundary

Treat every uploaded or synchronized media file as untrusted input. The producer must run as a non-root account in a sandbox or isolated service with no network access, a read-only source mount, a separate writable output directory, and explicit limits for input bytes, decoded pixels, CPU time, memory, temporary disk, process count, and concurrency. Reject decompression bombs, malformed containers, unexpected output MIME types, and files that exceed the configured media quota. Never pass source filenames through a shell; use argument arrays and safe path joins.

Inbound files are quarantined and scanned with ClamAV before Hermes or the preview producer can read them. A positive or unavailable scan keeps the object quarantined and alerts staff. Only a clean, checksum-verified object can enter the normal inbound staging queue.

### Sync and pruning contract

Use rclone with the R2 S3 endpoint, `COPY` mode, checksums where supported, bounded retries, and no overlapping jobs. Exclude every `**/dump/**` path and every reserved `_ltds` subtree except locally generated `**/_ltds/previews/**`; those preview artifacts and their manifest-last files must reach R2 or no thumbnail can appear. Keep top-level Worker-owned `_ltds/tmp-downloads/**`, `_ltds/audit-archive/**`, and future reserved paths out of the TrueNAS push. A separate read-only backup pull may retrieve only `_ltds/audit-archive/**`. Validate the final rclone filter order in a dry run because an early broad `_ltds` exclude will also suppress previews. Do not interpret an empty source mount, an unavailable NAS, or a failed listing as a deletion instruction. The first cutover requires file-count, byte-count, checksum samples, and ZFS snapshot verification.

Preview pruning is separate from source pruning. A derivative may be removed only after a complete successful source reconciliation confirms that its source no longer exists, followed by the agreed retention grace period. A single delete event, transient rclone error, or partial scan is not sufficient. Pruning may delete nested `**/_ltds/previews/*` objects only; it must never delete `Jobs/*` originals. Keep the last known-good manifest until the replacement manifest is complete.
