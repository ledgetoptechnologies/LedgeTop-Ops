# Retired TrueNAS preview pipeline

The TrueNAS preview producer is retired. Do not run the former FFmpeg cron or
container and do not generate `.previews/*/preview.webp`, `poster.webp`, or
`manifest.json` artifacts.

Original files continue to sync untouched into private R2. R2 object-create
events feed Cloudflare Queues, and the Operations Worker creates only one small
still-image thumbnail through the Cloudflare Images binding. Clicking an image
uses the existing authorized same-origin route to stream the full-resolution
original.

The current contract, prerequisites, deployment order, rollback, retry/DLQ
handling, and limitations are documented in
[Cloudflare thumbnail-only media delivery](../media-thumbnail-pipeline.md).

Legacy `.previews` objects may remain during the rollback window. They are not
advertised by new manifests and must not be deleted without a separately
reviewed cleanup plan.
