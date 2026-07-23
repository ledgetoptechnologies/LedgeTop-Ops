# Hermes preview pipeline

This is the production contract between TrueNAS, Hermes, the preview producer, and LTDS Delivery. Cards and normal viewers use prepared derivatives; originals remain explicit download or opt-in fallback sources.

## Lifecycle

```text
TrueNAS source -> rclone COPY -> R2 Jobs/ -> clean/quarantine decision
                                           -> preview job
                                           -> derivative verification
                                           -> manifest-last publish
                                           -> Delivery reads derivative metadata
```

The source object is authoritative. Derivatives are disposable read models. A preview failure must leave the original downloadable and must not make a healthy source file disappear from the browser. Publish the source to R2 first, obtain that exact R2 object's ETag and size, and only then publish the derivative manifest; a local pre-upload checksum cannot be substituted for the R2 ETag field.

## Identity and layout

For a source key such as `Jobs/2026/Acme/edited/IMG_0042.JPG`, normalize the filename including extension to Unicode NFC, hash that filename with SHA-256, and publish siblings under:

```text
Jobs/2026/Acme/edited/_ltds/previews/<sha256>/thumb.webp
Jobs/2026/Acme/edited/_ltds/previews/<sha256>/preview.webp
Jobs/2026/Acme/edited/_ltds/previews/<sha256>/poster.webp
Jobs/2026/Acme/edited/_ltds/previews/<sha256>/manifest.json
```

Videos use `poster.webp`; PDFs use `preview.webp`. The Worker requires `sourceKey`, the exact post-upload R2 `sourceEtag`, `sourceSize`, a non-empty `producerVersion`, and an ISO-8601 `createdAt`. Store derivative MIME/dimensions and a source SHA-256 as additional producer/audit data. A changed file cannot reuse a stale derivative.

```json
{
  "sourceKey": "Jobs/2026/Acme/edited/IMG_0042.JPG",
  "sourceEtag": "\"the-r2-object-etag\"",
  "sourceSize": 209715200,
  "sourceSha256": "optional-but-recommended-64-hex-value",
  "producerVersion": "ltds-preview/1.0.0",
  "createdAt": "2026-07-23T12:00:00.000Z"
}
```

## Producer behavior

Use libvips for still-image derivatives, ffmpeg for video posters and optional low-resolution proxies, and Poppler for the first PDF page. Preserve EXIF orientation while removing unnecessary metadata from public previews. Derivative MIME types must be checked after production, not inferred only from filenames.

The producer must:

1. Claim one source and record a job idempotency key from source identity plus checksum.
2. Read from a read-only source location.
3. Write to a private temporary directory outside the published prefix.
4. Enforce CPU, memory, decoded-pixel, disk, duration, and concurrency limits.
5. Validate dimensions, MIME, byte size, and image decodability.
6. Upload derivatives to temporary keys.
7. Upload `manifest.json` last.
8. Remove superseded derivatives only after the manifest is known-good.

No preview process receives cloud credentials that can delete `Jobs/` objects. No preview process publishes client-visible paths directly.

## Inbound quarantine

Files from an inbound request are not immediately part of `Jobs/`. They remain in a private incoming area with a request id and upload id. ClamAV scanning, size/quota validation, checksum verification, and operator acceptance happen before rclone or Hermes moves them into the normal source workflow. Malware, scan errors, incomplete multipart uploads, and policy violations remain quarantined for review or expiry.

## Failure and recovery rules

- A failed preview leaves the source available and marks the derivative job failed.
- A failed upload leaves temporary keys eligible for cleanup; it cannot replace the current manifest.
- A partial rclone run does not prune previews or revoke delivery links.
- A complete reconciliation can mark missing derivatives for pruning, but only after the configured grace period.
- Restore source media from TrueNAS/ZFS first; rebuild derivatives from source rather than treating previews as backups.

The same `client-data` bucket is used for source and hidden derivatives. A separate artifact bucket is intentionally not part of this design.
