# Hermes preview pipeline

This is the production contract between TrueNAS, Hermes, the preview producer, and LTDS Delivery. Cards and viewers prefer prepared derivatives. Original media is never fetched by a folder grid or filmstrip, but the viewer streams the one original a user deliberately opens when a prepared preview is unavailable.

The canonical executable implementation is
[`preview-gen.sh`](preview-gen.sh). Validate a deployment candidate with
`bash -n docs/truenas/preview-gen.sh` and
`bash docs/truenas/tests/preview-gen-paths.sh`. The fixture covers valid source
trees and the reserved-path boundary without invoking FFmpeg.

## Canonical source layout

The synchronized source root is always:

```text
Jobs/Clients/<client-or-organization>/...
```

`Jobs` and `Clients` use exactly that casing. Every path segment whose name is exactly `Dump`, compared case-insensitively, is excluded from synchronization. Names such as `Dumpsters` are not excluded by this rule. The producer must apply the same rule independently of rclone filters.

For a source such as:

```text
Jobs/Clients/Acme/edited/IMG_0042.JPG
```

the leaf is `IMG_0042.JPG`, normalized to Unicode NFC including its extension before hashing. Derivatives are stored in the containing directory under a reserved `.previews` directory:

```text
Jobs/Clients/Acme/edited/.previews/<sha256-of-NFC-leaf-including-extension>/thumb.webp
Jobs/Clients/Acme/edited/.previews/<sha256-of-NFC-leaf-including-extension>/preview.webp
Jobs/Clients/Acme/edited/.previews/<sha256-of-NFC-leaf-including-extension>/poster.webp
Jobs/Clients/Acme/edited/.previews/<sha256-of-NFC-leaf-including-extension>/manifest.json
```

Never recurse into `.previews` while scanning source files, and never treat a derivative as source media. The dedicated upload phase must still send generated `.previews` artifacts to R2. The hash is lowercase hexadecimal SHA-256 of the NFC leaf filename, including its extension; do not lowercase the filename before hashing.

## Derivative contract

- Images publish `thumb.webp` and `preview.webp`.
- Videos publish `poster.webp`; FFmpeg encodes the poster as WebP. Video playback remains Cloudflare Stream or the original range-enabled object.
- PDFs publish `thumb.webp` and `preview.webp`; Poppler rasterizes the first page before WebP encoding.

Thumbnail output must be no larger than 100 KiB. Viewer preview output has a hard cap of 500 KiB (512000 bytes), with a preferred target of 450 KiB. The producer first iterates WebP quality downward, then reduces dimensions and repeats quality reduction until the target is met or the 512000-byte cap is reached. An output that still exceeds the hard cap is rejected and must not be published as current.

Operations and Delivery independently reject prepared artifacts above those hard caps, so an incorrectly configured producer cannot turn the preview route back into a large-file delivery path.

## Browser fallback behavior

Thumbnail and viewer images use explicit dimensions, asynchronous decoding, and browser-native lazy loading. Thumbnail routes are prepared-artifact-only and return a lightweight branded placeholder when `thumb.webp` is unavailable, so opening a folder or viewer filmstrip never fans out into original-image reads. Once a user deliberately opens one file, the viewer prefers `preview.webp` but streams that single original inline when no valid prepared preview exists.

File size does not block an explicitly opened original. A 200 MiB photo or multi-gigabyte video may take time to become usable, so the viewer displays a loading state and fetches only that selected item. This keeps a folder containing several large drone files responsive while Hermes finishes—or has not yet produced—its artifacts.

Large originals are never requested by the grid or filmstrip. In the viewer, images and PDFs stream only after the explicit open action. Videos prefer adaptive Cloudflare Stream playback and otherwise use the original R2 object with byte-range requests and `preload="metadata"` so the browser does not fetch a multi-gigabyte video before playback. Unsupported browser codecs retain a clear download-original fallback.

The source object is authoritative. Derivatives are disposable read models. The TrueNAS producer writes a bounded provisional manifest with the local source size, `sourceEtag: "pending"`, `finalizationStatus: "pending-r2"`, and exact deterministic derivative keys. R2 create notifications then let the Operations Worker use its `DATA_BUCKET` binding to verify the source and derivative objects and register the exact post-upload R2 ETag in the shared `preview_artifacts` table. The adjacent manifest remains TrueNAS-owned and is not rewritten, avoiding a Cloud Sync overwrite loop. The FFmpeg container does not receive R2 credentials.

The provisional manifest is written locally last, after every referenced derivative has been generated and verified. Cloud Sync uploads the source, WebPs, and manifest. Whichever of those objects arrives last triggers idempotent registration. A provisional manifest contains at least:

```json
{
  "sourceKey": "Jobs/Clients/Acme/edited/IMG_0042.JPG",
  "sourceEtag": "\"the-exact-r2-object-etag\"",
  "sourceSize": 209715200,
  "sourceSha256": "optional-64-hex-audit-value",
  "producerVersion": "ltds-preview/2.0.0",
  "createdAt": "2026-07-24T12:00:00.000Z",
  "finalizationStatus": "pending-r2",
  "derivatives": {
    "thumb": { "key": ".../thumb.webp", "bytes": 98304 },
    "preview": { "key": ".../preview.webp", "bytes": 460800 }
  }
}
```

The manifest is eligible for registration only when each referenced object exists at its deterministic sibling key, has the expected WebP MIME type, dimensions, and byte size, and the manifest's `sourceKey` and `sourceSize` match the R2 source. Manifests are limited to 64 KiB. The Worker rechecks object identities before committing and records the exact R2 source, manifest, and derivative ETags in D1. Preview routes require all relevant registered identities to match live R2 and use a conditional derivative read, so a changed source, manifest, or WebP cannot reuse a stale registration.

## Lifecycle

```text
TrueNAS source -> rclone COPY -> R2 Jobs/Clients/<client-or-organization>/
                                      -> full source scan
                                      -> preview job in local staging
                                      -> derivative verification
                                      -> manifest-last publish
                                      -> Delivery reads derivative metadata
```

The producer must:

1. Claim one source and record a job idempotency key from source identity plus checksum.
2. Read from a read-only source location.
3. Write to a private temporary directory outside the published prefix.
4. Enforce CPU, memory, decoded-pixel, disk, duration, process-count, and concurrency limits.
5. Validate dimensions, MIME, byte size, WebP decodability, and the thumbnail/preview size caps.
6. Upload derivatives to temporary keys in the correct `.previews/<hash>/` directory.
7. Write the provisional `manifest.json` locally last.
8. Let Cloud Sync upload the source and `.previews` tree.
9. Let the Operations queue consumer validate and register the exact R2 identity in D1.
8. Remove superseded derivatives only after the replacement manifest is known-good.

No preview process receives cloud credentials that can delete `Jobs/` source objects. No preview process publishes client-visible paths directly.

## Stale artifact pruning

The producer must never prune from a partial scan. After, and only after, a full successful local source scan, it may identify local `.previews` directories whose source leaf is absent. Those stale artifacts remain eligible for local deletion only after a 24-hour grace period. A failed scan, empty/unavailable source mount, transient rclone error, or partial traversal cancels pruning for that run.

Prune local stale artifacts before the next source-to-R2 COPY can resurrect them. Pruning deletes only `.previews/<hash>/` artifacts and never source originals. R2 reconciliation remains authoritative for R2 cleanup; a single delete notification is not sufficient evidence for destructive R2 action.

## Inbound quarantine

Files from an inbound request are not immediately part of `Jobs/Clients/`. They remain in a private incoming area with a request id and upload id. ClamAV scanning, size/quota validation, checksum verification, and operator acceptance happen before rclone or Hermes moves them into the normal source workflow. Malware, scan errors, incomplete multipart uploads, and policy violations remain quarantined for review or expiry.

## Failure and recovery rules

- A failed preview leaves the source available and marks the derivative job failed.
- A failed upload leaves temporary keys eligible for cleanup; it cannot replace the current manifest.
- A partial rclone run does not prune previews or revoke delivery links.
- Restore source media from TrueNAS/ZFS first; rebuild derivatives from source rather than treating previews as backups.

The same `client-data` bucket is used for source and hidden derivatives. A separate artifact bucket is intentionally not part of this design.

## Optional R2-only upload processing

Operations uploads that did not pass through TrueNAS initially have no card thumbnail or lightweight viewer artifact. Their cards use the branded placeholder, while an explicit viewer open streams the original when the browser supports its format. If automatic processing becomes necessary, use R2 object-create notifications with a Cloudflare Queue configured for HTTP pull. A sandboxed Hermes service on TrueNAS can pull and acknowledge jobs over outbound HTTPS, retrieve the source directly from R2, and publish the normal adjacent `.previews` artifacts. Delivery must not call the TrueNAS server during a client page request.

The consumer must ignore `Dump`, `.previews`, `_ltds`, temporary upload, trash, and recovery paths; deduplicate by source key and R2 identity; acknowledge generated-artifact events without processing them; and periodically reconcile sources lacking valid manifests so an expired or missed event cannot leave permanent gaps.

## Security and sandbox boundary

Treat every synchronized or uploaded media file as untrusted input. The producer must run as a non-root account in a sandbox or isolated service with no network access, a read-only source mount, a separate writable output directory, and explicit limits for input bytes, decoded pixels, CPU time, memory, temporary disk, process count, and concurrency. Reject decompression bombs, malformed containers, unexpected output MIME types, and files that exceed the configured media quota. Never pass source filenames through a shell; use argument arrays and safe path joins.

Inbound files are quarantined and scanned with ClamAV before Hermes or the preview producer can read them. A positive or unavailable scan keeps the object quarantined and alerts staff. Only a clean, checksum-verified object can enter the normal inbound staging queue.
