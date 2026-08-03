# TrueNAS Scale to R2 synchronization

TrueNAS remains the source of truth. Start with a non-deleting **Copy** task; do not begin with Sync. The production source root and canonical hierarchy are:

```text
Jobs/Clients/<client-or-organization>/...
```

Use exactly `Jobs` and `Clients` casing. Exclude every path segment whose complete name is `Dump`, case-insensitively. This excludes `Dump`, `dump`, and `DUMP`, but not names such as `Dumpsters`. The rule applies in TrueNAS/rclone filters and in Hermes as an independent safety check.

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
- Remote destination: bucket `client-data`, prefix `Jobs/Clients` (choose the source/destination pair so the resulting keys are exactly `Jobs/Clients/<client-or-organization>/...`, not `Jobs/Jobs/...` or `Jobs/Clients/Clients/...`).
- Schedule: every 15 minutes.
- Prevent overlapping executions.
- Follow symlinks: off unless specifically required and reviewed.
- Encryption: rely on TLS in transit and Cloudflare server-side encryption; enable client-side encryption only if its key recovery process is documented.

Configure an exact-segment, case-insensitive `Dump` exclusion and validate it with nested samples. Do not exclude `unedited`.

The portal also denies `Dump` and `.previews` independently, so legacy content cannot be exposed to clients. Hermes must never recurse into or upload `.previews`; new thumbnail objects are Worker-owned under `_ltds`.

## 3. Dry run and verification

1. Test with one small client folder.
2. Confirm R2 keys match:

   ```text
   Jobs/Clients/<client-or-organization>/...
   ```

3. Confirm nested `Dump`, `dump`, and `DUMP` directories are absent while similarly named directories such as `Dumpsters` remain eligible.
4. Confirm `.previews` is not treated as source input or recursively scanned.
5. Compare file counts and total sizes for allowed source files.
6. Compare representative checksums for images, video, PDFs, and uncommon formats.
7. Confirm new, modified, and renamed files appear dynamically in Ops/Delivery.
8. Confirm R2 create events populate `file_index` and Stream ingestion starts for video.
9. Confirm ZFS snapshots can restore an accidentally changed/deleted source file.

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

R2 create/delete notifications feed `ltds-file-events`. Queue processing updates the delivery file index and TrueNAS health timestamp. For supported still images, it records a durable D1 job and sends a second queue message so the Operations Worker can create one fixed WebP thumbnail through its Cloudflare Images binding. TrueNAS does not generate or upload preview derivatives and needs no R2 credentials beyond its existing sync path. A daily live R2 reconciliation repairs missed file-index events. See [the thumbnail-only pipeline](../media-thumbnail-pipeline.md).

The file browser uses live R2 prefix/delimiter listing as the authority, so it updates even if the index temporarily lags. The index exists for search, media state, and thumbnails—not file existence.

## Retired preview and derivative contract

The material below is retained only as rollback history. Do not deploy or run
the former producer. `preview-gen.sh` now exits non-zero when executed. New
uploads sync untouched originals only; Cloudflare creates one small still-image
thumbnail as documented in [the current pipeline](../media-thumbnail-pipeline.md).

The canonical producer script is [`preview-gen.sh`](preview-gen.sh). Deploy
that repository copy into the FFmpeg container rather than maintaining an
independent pasted version. It preserves the `ltds-preview/2.0.0` provisional
manifest contract described below.

Before deployment, validate its syntax and path boundary behavior from a Linux
or container shell:

```bash
bash -n docs/truenas/preview-gen.sh
bash docs/truenas/tests/preview-gen-paths.sh
```

The path fixture explicitly confirms that normal files under `Clients`,
`Demo`, `Edited Vs. Nonedited`, and `Extended` are accepted while reserved,
hidden, and outside-root paths are rejected. A successful full generation run
must finish with `errors=0` before the resulting `.previews` tree is synced.

Source media remains under `Jobs/Clients/<client-or-organization>/...`. For a source leaf, the preview producer normalizes the leaf filename including its extension to Unicode NFC, hashes it with SHA-256, and writes derivatives beside the source in:

```text
<containing-directory>/.previews/<sha256-of-NFC-leaf-including-extension>/
```

The producer never recurses into `.previews`, and `.previews` objects are never eligible for client delivery.

Outputs are:

- Images: `thumb.webp` and `preview.webp`.
- Videos: `poster.webp`, encoded as WebP by FFmpeg.
- PDFs: `thumb.webp` and `preview.webp`; Poppler rasterizes the first page before WebP encoding.
- All derivatives: `manifest.json`, published last.

`thumb.webp` must be at most 100 KiB. `preview.webp` has a hard cap of 500 KiB (`512000` bytes) and a preferred target of 450 KiB. Reduce WebP quality iteratively first; if the target is not met, reduce dimensions and repeat quality reduction. Reject any preview that remains above the hard cap.

Operations and Delivery never load originals for cards or filmstrips. Cards use a real Cloudflare-generated thumbnail when ready or a local generic file-kind icon. When a user deliberately opens an image, the authorized route streams the full-resolution original. No medium or large preview is generated. Videos use Cloudflare Stream when ready and fall back to the range-enabled original with metadata-only preloading.

The local producer writes `sourceEtag: "pending"` and the exact local source size, plus source key, deterministic derivative keys, dimensions, MIME type, producer version, and creation time. After upload, the Operations queue consumer records the exact R2 ETag in D1 only after the source size and all derivative objects validate. Preview routes compare that registered identity with the live source. The exact R2 ETag/size—not a local pre-upload checksum—determines whether a derivative is current.

## Resource and security boundary

Treat every uploaded or synchronized media file as untrusted input. The producer must run as a non-root account in a sandbox or isolated service with no network access, a read-only source mount, a separate writable output directory, and explicit limits for input bytes, decoded pixels, CPU time, memory, temporary disk, process count, duration, and concurrency. Reject decompression bombs, malformed containers, unexpected output MIME types, and files that exceed the configured media quota. Never pass source filenames through a shell; use argument arrays and safe path joins.

Inbound files are quarantined and scanned with ClamAV before Hermes or the preview producer can read them. A positive or unavailable scan keeps the object quarantined and alerts staff. Only a clean, checksum-verified object can enter the normal inbound staging queue.

## Sync and pruning contract

Use rclone with the R2 S3 endpoint, `COPY` mode, checksums where supported, bounded retries, and no overlapping jobs. Exclude every exact path segment named `Dump` case-insensitively and exclude all `.previews` trees. Keep top-level Worker-owned `_ltds/**` paths out of the TrueNAS push. A separate read-only backup pull may retrieve only `_ltds/audit-archive/**`. Validate the final rclone filter order in a dry run.

Do not interpret an empty source mount, an unavailable NAS, a failed listing, or a partial scan as a deletion instruction. The first cutover requires file-count, byte-count, checksum samples, and ZFS snapshot verification.

Local preview pruning is allowed only after a full successful source scan. If a source leaf is absent, its `.previews/<hash>/` directory remains eligible for local deletion only after a 24-hour grace period. A failed scan, transient rclone error, unavailable source mount, or partial traversal cancels pruning for that run. Prune stale local artifacts before the next source-to-R2 COPY so the sync cannot resurrect them.

Pruning deletes only `.previews/<hash>/` artifacts; it must never delete `Jobs/Clients/<client-or-organization>/...` originals. R2 cleanup follows the Worker-controlled reconciliation and retention process, not a single delete notification. Keep the last known-good manifest until its replacement is complete.
