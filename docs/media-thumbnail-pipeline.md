# Cloudflare thumbnail-only media delivery

## Contract and trust boundary

Private R2 originals remain authoritative and are never modified. A successful
R2 object-create event is indexed by the Operations Worker, which records a
durable D1 thumbnail job and sends an `image-thumbnail.v1` message to
`ltds-thumbnail-jobs`. The queue consumer streams the original through the
Cloudflare Images binding and stores exactly one fixed `320x240` WebP under
`_ltds/thumbnails/v1/`. It does not create `preview`, `medium`, `large`, PDF, or
video-poster derivatives.

The public and staff APIs continue to return opaque same-origin routes. They do
not return R2 URLs, presigned bearer URLs, or credentials. Every original and
thumbnail request re-runs the existing share/client/folder/project authorization
before any R2 access. Responses are `private, no-store`.

Image clicks use the existing `sourceUrl` route and stream the original with
range, HEAD, and ETag semantics. The legacy image `previewUrl` field is retained
as a compatibility alias to that same authorized original route; it no longer
means a generated preview.

The list/grid rendering rule is strict: use `thumbnailUrl` only when
`thumbnailState === "ready"`. In every other state, render an LTDS-branded
fallback or a client-bundled accessible SVG selected by
`thumbnailFallbackKind`. List/grid code must not use `sourceUrl`, `previewUrl`,
or `downloadUrl` as an image source. Those routes are activation actions, not
thumbnail fallbacks.

Authorized list items expose:

- `thumbnailState`: `ready`, `pending`, `failed`, or `not_applicable`.
- `thumbnailUrl`: present only when the current source ETag has a ready
  thumbnail.
- `thumbnailFallbackKind`: `image`, `video`, `audio`, `pdf`, `archive`,
  `document`, `spreadsheet`, or `unknown`.
- `sourceUrl`: the authorized full-resolution original route for supported
  inline media.

The fallback enum is coarse and contains no filename or path. Hermes can map it
to local accessible SVG assets (for example, `archive -> archive.svg`,
`spreadsheet -> spreadsheet.svg`, and `unknown -> file.svg`). No remote icon
endpoint is needed. If a thumbnail is pending or failed, the thumbnail route
returns a harmless status error and never substitutes the original image.

On activation, images use `sourceUrl` to load the untouched full-resolution
original for zoom/pan. Other supported inline types use their existing
authorized `sourceUrl` representation, and all file kinds retain their
authorized `downloadUrl`. Authorization is rechecked before any R2 read.

## Prerequisites and limits

- The Operations Worker must have `DATA_BUCKET`, `DELIVERY_DB`, `IMAGES`, and
  `THUMBNAIL_QUEUE` bindings. The repository already declares the Images
  binding, but the Cloudflare account must have Images transformations enabled.
- R2 object-create notifications for `PutObject`, `CopyObject`, and
  `CompleteMultipartUpload` must feed `ltds-file-events`.
- Create `ltds-thumbnail-jobs` and `ltds-thumbnail-jobs-dlq` before deploying
  the binding configuration.
- Cloudflare Images binding input is limited to 20 MB. Larger originals remain
  downloadable and zoomable, but their thumbnail job is visibly failed until a
  future large-input transform path is approved.
- Queue delivery is at-least-once. D1 source-ETag state and a lease make
  generation idempotent. Six total delivery attempts are aligned with
  `max_retries: 5`; exhausted messages move to the DLQ and its consumer records
  `dead_lettered_at` before acknowledging them.
- Account for Images transformations, Queue operations (including retries), R2
  reads/writes, Worker CPU, and D1 operations. Check current pricing and limits:
  <https://developers.cloudflare.com/images/pricing/>,
  <https://developers.cloudflare.com/queues/platform/pricing/>, and
  <https://developers.cloudflare.com/r2/pricing/>.

## Deployment sequence

1. Disable the TrueNAS preview cron/container. The checked-in
   `docs/truenas/preview-gen.sh` now exits with a retirement message when run.
2. Back up Delivery D1 and apply `0106_image_thumbnail_jobs.sql` in staging, after `0105_internal_folder_grants.sql`.
3. Create the staging thumbnail queue and DLQ; attach the main queue producer,
   main consumer, and DLQ consumer bindings shown in the staging config example.
4. Confirm the existing R2 object-create notification still targets the file
   event queue. Do not add overlapping R2 notification rules.
5. Deploy Operations, then Client, to staging. Upload a synthetic image and
   verify `pending -> ready`, one thumbnail object, and authorized original
   streaming. Also test a synthetic invalid image and an input over 20 MB.
6. Review Workers structured logs and D1 failed/dead-letter rows before a
   production rollout. Production resource creation and deployment are outside
   this repository change.

## Failure handling and replay

`error_code`, a bounded `error_message`, `attempt_count`, `failed_at`, and
`dead_lettered_at` provide failure visibility without client content in logs.
Invalid images, unsupported formats, and oversized inputs fail permanently.
Transient Images/R2/D1 errors retry with bounded exponential delay.

After fixing a transient root cause, an operator may set the exact current job
back to `pending` and replay its `image-thumbnail.v1` message through an
authorized operational procedure. Confirm the R2 source ETag still matches
first. Never replay by exposing R2 credentials to a browser. Permanent failures
should remain failed and use `thumbnailFallbackKind`.

## Rollback

Roll back the Worker versions and detach the thumbnail queue producer/consumers.
The additive D1 table can remain in place. Existing originals and legacy
derivatives are untouched, so rollback does not risk client files. Do not remove
the `ltds-file-events` notification because it also maintains the file index.
After the rollback window, orphaned legacy `.previews` content and the new
`_ltds/thumbnails/v1/` objects may be removed only through a separately reviewed,
recoverable cleanup plan.

## Known limitations

- Only supported still-image inputs at or below the Images binding input limit
  receive real thumbnails. PDF, video, archives, office documents, and unknown
  files use local generic icons.
- Video thumbnails, poster extraction, transcoding, and adaptive streaming are
  not part of this pipeline. `thumbnailFallbackKind: "video"` deliberately
  remains presentation-only so a future separately authorized adaptive-video
  contract can be added without changing the fallback enum. This change does
  not create or expand any video processing path.
- Queue and Images unit tests use synthetic mocks; a non-production Cloudflare
  staging smoke test is still required to validate account entitlement and real
  decoder behavior.
- Legacy prepared-artifact tables and readers are retained for rollback and
  cleanup compatibility, but new manifests and image routes do not use them.
