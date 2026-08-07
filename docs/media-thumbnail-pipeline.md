# Cloudflare thumbnail-only media delivery

The same private queue also performs bounded, version-bound GPS extraction for
authenticated photo maps. That metadata has a separate privacy and retention
contract in [Delivery image-location maps](delivery-image-location-maps.md); it
does not change the thumbnail-only or original-file access rules below.

## Contract and trust boundary

Private R2 originals remain authoritative and are never modified. A successful
R2 object-create event is indexed by the Operations Worker, which records a
durable D1 thumbnail job and sends an `image-thumbnail.v1` message to
`ltds-thumbnail-jobs` (the legacy message-kind name is retained for queue
compatibility). The queue consumer streams an image through Cloudflare Images,
or streams an eligible MP4 through the Media Transformations binding in
frame-only mode at `5s` and passes only the resulting JPEG frame to Images. It
stores one current referenced fixed `320x240` WebP for the source key's current
ETag under `_ltds/thumbnails/v2/`. The opaque
object key under `v2/` includes both source path and normalized ETag, so in-flight work for
an old version cannot overwrite or delete a replacement's derivative. It does
not create `preview`, `medium`, `large`, PDF, spritesheet, audio, or video-proxy
derivatives and never submits a full-video output transformation.

The public and staff APIs continue to return opaque same-origin routes. They do
not return R2 URLs, presigned bearer URLs, or credentials. Every original and
thumbnail request re-runs the existing share/client/folder/project authorization
before any R2 access. Responses are `private, no-store`.

Image clicks use the existing `sourceUrl` route and stream the original with
range, HEAD, and ETag semantics. The legacy image `previewUrl` field is retained
as a compatibility alias to that same authorized original route; it no longer
means a generated preview.

The list/grid rendering rule is strict: `thumbnailUrl` is present only when
`thumbnailState === "ready"`. In every other state, the current Hermes UI uses
its existing local file-kind or branded placeholder. It does not yet use
`thumbnailFallbackKind` to select a bundled SVG. List/grid code must not use
`sourceUrl`, `previewUrl`, or `downloadUrl` as an image source. Those routes are
activation actions, not thumbnail fallbacks.

Authorized list items expose:

- `thumbnailState`: `ready`, `pending`, `failed`, or `not_applicable`.
- `thumbnailUrl`: present only when the current source ETag has a ready
  thumbnail.
- `thumbnailFallbackKind`: `image`, `video`, `audio`, `pdf`, `archive`,
  `document`, `spreadsheet`, or `unknown`.
- `sourceUrl`: the authorized full-resolution original route for supported
  inline media.

The fallback enum is coarse and contains no filename or path. A later Hermes UI
change can map it to local accessible SVG assets without a remote icon endpoint.
If a thumbnail is pending or failed, the thumbnail route returns a harmless
status error and never substitutes the original image.

On activation, the current image viewer loads `previewUrl`, which is a
compatibility alias to the same authorized full-resolution `sourceUrl` route;
it is not a derivative. Other supported inline types use their existing
authorized `sourceUrl` representation, and all file kinds retain their
authorized `downloadUrl`. Authorization is rechecked before any R2 read.

## Prerequisites and limits

- The Operations Worker must have `DATA_BUCKET`, `DELIVERY_DB`, `IMAGES`,
  `MEDIA`, and `THUMBNAIL_QUEUE` bindings. The Cloudflare account must allow
  both Images and Media Transformations. Media is enabled per Worker, is in
  public beta, and has no local simulator; validate it with a remote staging
  Worker before rollout.
- R2 object-create notifications for `PutObject`, `CopyObject`, and
  `CompleteMultipartUpload` must feed `ltds-file-events`.
- Create `ltds-thumbnail-jobs` and `ltds-thumbnail-jobs-dlq` before deploying
  the binding configuration. Queue dispatch is fail-closed against the exact
  configured file-event, thumbnail, and DLQ names.
- Still-image input is capped at 20 MiB. Video input is limited to an exact
  `.mp4`/`video/mp4` candidate strictly below 100,000,000 bytes. Cloudflare
  documents MP4/H.264 with AAC or MP3 audio as the reliable input and a maximum
  duration of ten minutes. Codec and duration are validated by Media
  Transformations; rejected or over-duration inputs finish in explicit failed
  fallback state after bounded delivery attempts. Non-MP4 video and oversized
  video remain `not_applicable` or failed and never fall back to the original.
- Queue delivery is at-least-once. D1 source-ETag state and a lease make
  generation idempotent. Six total delivery attempts are aligned with
  `max_retries: 5`; exhausted messages move to the DLQ and its consumer records
  `dead_lettered_at` before acknowledging them.
- Migration `0107_thumbnail_cleanup_jobs.sql` adds the bounded-retry deletion
  ledger and retirement triggers used by replacement and removal cleanup.
- Migration `0108_thumbnail_backfill_runs.sql` records queue publication on the
  current source version and adds the resumable one-time backfill ledger. It is
  required before deploying code that publishes thumbnail work.
- Each current ready derivative is capped at 128 KiB. Account for one source
  read and Images transformation, plus one Media frame extraction for video,
  the derivative write and authorized serves,
  Queue operations including retries, Worker CPU, D1 operations, and cleanup
  retries for retired source versions. Check current
  pricing and limits during rollout; this repository does not verify the
  account's current entitlement or bill:
  <https://developers.cloudflare.com/images/pricing/>,
  <https://developers.cloudflare.com/queues/platform/pricing/>, and
  <https://developers.cloudflare.com/r2/pricing/>.

## Deployment sequence

1. Disable the TrueNAS preview cron/container. The checked-in
   `docs/truenas/preview-gen.sh` now exits with a retirement message when run.
2. Record a D1 Time Travel bookmark and apply `0106_image_thumbnail_jobs.sql`,
   `0107_thumbnail_cleanup_jobs.sql`, and `0108_thumbnail_backfill_runs.sql`, in
   that order after `0105_internal_folder_grants.sql`.
3. Create the staging thumbnail queue and DLQ; attach the main queue producer,
   main consumer, and DLQ consumer bindings shown in the staging config example.
4. Confirm the existing R2 object-create notification still targets the file
   event queue. Do not add overlapping R2 notification rules.
5. Deploy Operations, then Client, to staging. Upload a synthetic image and
   verify `pending -> ready`, one thumbnail object, and authorized original
   streaming. Also test a synthetic invalid image, an image over 20 MiB, a
   short H.264 MP4, a corrupt/non-H.264 MP4, and a video at the 100 MB boundary.
6. Review Workers structured logs, failed/dead-letter rows, and cleanup-ledger
   failures before production rollout.

## One-time existing-original backfill

The backfill is an explicit operational run, not a recurring full-bucket scan.
It inventories only the exact, case-sensitive `Jobs/Clients/` R2 prefix. R2
listing reads object metadata, not source bodies. The run skips folder markers,
zero-byte and over-limit objects, unsupported media, unindexed or stale-index
objects, active exact/prefix tombstones, and every path rejected by the normal
canonical-source check (including `_ltds`, `.previews`, and `Dump` segments).
PDFs, non-MP4 videos, archives, office documents, and other unsupported files
are not queued. Eligible still-image extensions are AVIF, GIF, HEIC/HEIF,
JPEG/JPG, PNG, and WebP when the extension or stored content type is supported.
Eligible video requires both an `.mp4` extension and `video/mp4` stored content
type and must be strictly below 100 MB. Checking
an already-ready job may issue a metadata-only HEAD for its version-scoped
derivative; it never opens the original during inventory.

Each run is durable in `image_thumbnail_backfill_runs`. Its opaque R2 cursor,
page count, retry count, lease, timestamps, safe error code, and aggregate
`discovered`, `eligible`, `queued`, `skipped`, `ready`, `failed/DLQ`, and
`pending` counts survive Worker restarts. The unique active-scope constraint
permits only one queued/running `Jobs/Clients/` run. A dry run processes at most
ten 100-object pages per scheduled turn; an enqueue run processes at most three.
The five-minute scheduler resumes the cursor. A run retries a failed page at
most eight times and then remains visibly failed. Never edit a cursor or reset
counts to make a run appear complete. A quota-recovery probe is the exception
to normal enqueue paging: it publishes at most one 100-object page total, then
persists its cursor and aggregate counts in failed `quota_probe_pending` state.

Use this order for the one-time operation:

1. Record the current Operations and Client Worker versions, R2 notification
   rules, Queue backlog/DLQ depth, Images entitlement/usage, D1 migration list,
   and a D1 Time Travel bookmark. Do not proceed while a deployment is failed
   or its exact cause is unknown.
2. Insert one `dry_run` row with a generated non-sensitive ID, exact
   `scope_prefix='Jobs/Clients/'`, and `status='queued'`. Do not include object
   keys or filenames in an operator ticket or report.

   ```sql
   INSERT INTO image_thumbnail_backfill_runs(id,mode,scope_prefix,status)
   VALUES ('<generated-run-id>','dry_run','Jobs/Clients/','queued');
   ```

3. Wait until that row is `completed` with a null cursor. Record only its
   aggregate counters and page count. In dry-run mode, `queued_count` means
   “would queue”; it does not represent published messages. A non-null cursor,
   queued/running state, terminal error, unexpected eligible volume, or an
   Images quota below the proposed work is a stop condition.

   ```sql
   SELECT id,mode,status,cursor,page_count,attempt_count,
          discovered_count,eligible_count,queued_count,skipped_count,
          ready_count,failed_dlq_count,pending_count,error_code,
          started_at,completed_at,updated_at
   FROM image_thumbnail_backfill_runs WHERE id='<generated-run-id>';
   ```

4. After reviewing the dry-run scope and capacity, insert a new `enqueue` run.
   Monitor its aggregate row, `ltds-thumbnail-jobs`, Worker safe-error logs,
   `image_thumbnail_jobs`, and `ltds-thumbnail-jobs-dlq` until the cursor is
   null and the run is completed. Queue drain can continue after inventory has
   completed; stable completion also requires no increasing backlog and a
   known terminal state for failed/DLQ work.

   ```sql
   INSERT INTO image_thumbnail_backfill_runs(id,mode,scope_prefix,status)
   VALUES ('<new-generated-run-id>','enqueue','Jobs/Clients/','queued');
   ```

5. Re-run a dry run after the queue is stable. Its would-queue count must be
   zero, apart from explicitly understood work that arrived or changed during
   the run. Rerunning is safe: source key plus normalized current ETag and the
   queue-publication marker prevent already-published current work from being
   republished.
6. Use only non-client synthetic objects for deployed sampling. Verify upload
   to `pending -> ready`, authorized thumbnail serve, deliberate original
   activation, source deletion, derivative/ledger cleanup, and zero residual
   synthetic source, staging, recovery, thumbnail, or active job objects.

Tombstone lookup binds only the current at-most-100-key page and returns at most
one match per listed object; it never materializes the full tenant tombstone
history. The enqueue backfill never deletes, renames, copies, or rewrites an original.
If it sees a ready row whose derivative metadata is stale or absent, it resets
only that derivative job and republishes current-version work. Replacement,
deletion, trash, or source ETag changes racing the consumer are handled by the
same version checks and cleanup ledger as future uploads.

## Authenticated Operations browser uploads

Direct browser uploads into delivery storage are a private Operations feature;
they are not a public R2 upload surface. `DIRECT_DELIVERY_UPLOADS_ENABLED` must
remain `false` through migration, deployment, and staging validation. When it
is enabled, the browser talks only to same-origin `/api/delivery/uploads*`
routes. The Worker uses its private `DATA_BUCKET` binding for multipart writes;
it does not return an R2 hostname, presigned URL, API credential, bucket name,
or unrestricted object key to the browser.

Every request requires a current Cloudflare Access-backed staff session, the
normal expected-host and mutation origin/CSRF checks, administrator status, and
the scoped `delivery.files.upload` permission for both the selected root and
every resolved destination. Revoked, inactive, cross-client, cross-project,
out-of-prefix, public-share, and client-portal-only identities are denied before
an R2 write. Incoming-request links remain a separate contributor-session,
Turnstile, quota, quarantine-bucket, and malware-scan flow; they cannot call or
substitute for authenticated delivery upload routes.

The browser first creates an upload intent with a 16-128 character
`Idempotency-Key`, one root prefix, and the full single-file or folder manifest.
There is no preselected or always-visible collision policy. The application limits an
intent to 100 non-empty files, 500 GiB per file, 500 GiB aggregate, and ten
active multipart sessions per staff identity. Intents and their sessions expire
after 24 hours. Paths are normalized to Unicode NFC and must be relative
descendants of the authorized case-sensitive
`Jobs/Clients/` root. Absolute paths, backslashes, controls, empty/dot/dot-dot
segments, repeated separators, and case-insensitive `Dump`, `_ltds`, or
`.previews` segments are rejected. HTML, SVG, XHTML, and JavaScript content
types are rejected as active web content.

Intent retries with the same principal, idempotency key, and manifest return
the existing intent; reusing that key for another manifest fails. Each file is
uploaded in bounded parts to `_ltds/browser-uploads/` staging, with D1
checkpoints exposed only through its owning same-origin session. Completion
validates every part and the declared byte count, then conditionally publishes
the final key. When the Worker observes an actual conflict, either before staging
or during the final conditional publication, it returns the structured
`upload_destination_conflict` response and preserves any staged bytes. Only then
does the UI warn the staff member and offer **Keep old** (skip), **Keep new**
(ETag-CAS replace), or **Keep both** (safe conditional auto-rename). The selected
resolution resumes the same intent/session idempotently; it is never an
unconditional overwrite. Completion returns another structured conflict if the
chosen baseline changes again. Only the verified baseline version can be copied
to a seven-day private recovery object and conditionally replaced. Completion,
cancel, and expiry first record durable staging cleanup work. The scheduler
reclaims stale completion leases and retries multipart abort/object deletion
eight times with bounded backoff; exhausted cleanup remains visible and can be
explicitly retried. Do not manually delete staging objects while their D1
sessions are active.

Each user-visible replacement recovery records the exact ETag of the version
that replaced it. Listing and restore recheck the administrator's current
global or key-scoped delete authority. Restore uses `If-Match` against that
replacement ETag, so a newer writer is never overwritten; conflicts retain the
private recovery. A successful restore refreshes `file_index` and runs the same
supported-thumbnail enqueue or unsupported-thumbnail cleanup lifecycle before
the recovery is retired. Internal derived-artifact copies are not exposed as
user-restorable recovery rows.

Successful browser publication updates the same file index and sends the same
ETag-scoped thumbnail job used by R2 create events and server-side uploads.
Duplicate object-create delivery therefore converges on the same job. Folder
uploads do not create a different indexing or thumbnail path. Replacement and
later copy/move/rename/delete/trash/restore use the standard derivative
retirement, cleanup, and conditional current-source rules. Trash immediately
retires the derivative while retaining the hidden original; restore republishes
only an eligible still image or MP4; retention purge cannot resurrect stale state. An
old event or consumer can never make a replaced/deleted source version current.

All other delivery writers converge through the existing private
`client-data` object-create notification to `ltds-file-events`: TrueNAS/rclone,
Dropbox multipart import, and any authorized server-side write. Copy, move, and
browser publication additionally index/enqueue synchronously, so a duplicate
notification is harmless. Preserve exactly one overlapping object-create rule;
removing it would break Dropbox/TrueNAS automatic indexing and thumbnail work.
Uploaders must preserve authoritative MIME metadata. In particular, MP4 must be
stored as `video/mp4`; the Dropbox importer derives this from the final key, and
TrueNAS/rclone must not replace it with `application/octet-stream`.

Before enabling the flag, staging acceptance must cover a valid single file and
folder; per-file/overall progress and partial error display; retry/resume;
duplicate completion; all collision policies; malicious relative paths; size,
type, file-count, and active-session limits; Access reauthentication and
revocation; cross-client/project and public/share denial; expired/cancelled
staging cleanup; `pending -> ready`; replacement; delete/trash/restore/expiry;
and absence of original fallback. Include a destination-created-during-completion
race to prove the same staged parts resume without a second byte upload. Use
synthetic content only.

### Cloudflare limits and cost gate

The 500 GiB application file cap is below R2's multipart object limit. The
server chooses a minimum 32 MiB part size and increases it as needed to remain
within R2's 10,000-part maximum; non-final R2 parts must be at least 5 MiB, no
part may exceed 5 GiB, and all non-final parts must have the same size. Each
part also passes through a Worker request, so the deployed Cloudflare account's
request-body limit must be at least the computed part size. Current limits are
plan-dependent; verify them before rollout rather than raising application
limits from this runbook. See [R2 multipart uploads](https://developers.cloudflare.com/r2/objects/upload-objects/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/), and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The thumbnail consumer is configured for batches of ten, five retries, and a
DLQ, within Cloudflare's current Queue limits of 100 messages per consumer batch
and 15 minutes per consumer invocation. Backfill rate is additionally bounded
by the page limits above. Queue delivery and retries are billed per message,
not per consumer batch. Before dry-run approval, record current Queue backlog
and retention, Images transformations entitlement/remaining allowance, D1
rows/operations, and R2 Class A/Class B operations and storage. Expected costs
include R2 LIST/HEAD, D1 reads/writes, one Queue write/read/delete sequence per
new job plus retries/DLQ, one original R2 read and Images transform per processed
image, one derivative write, and later authorized derivative reads. See
[Queue limits](https://developers.cloudflare.com/queues/platform/limits/),
[Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/),
and the Images/R2 pricing links above.

## Failure handling and replay

`error_code`, a bounded `error_message`, `attempt_count`, `failed_at`, and
`dead_lettered_at` provide failure visibility without client content in logs.
Empty images are recorded as `empty_source` failures without publishing queue
work. Invalid images, unsupported formats, and oversized inputs fail permanently.
Transient Images/R2/D1 errors retry with bounded exponential delay. Images
quota error `9422` stops normal enqueue backfills without a retry storm and
remains visible as `images_quota_exceeded`. After entitlement is confirmed
restored, an operator may create a new enqueue run with
`error_code='resume_images_quota'`; that explicit run resets only same-version
quota failures, publishes at most one 100-object page total, and then stops in
failed `quota_probe_pending` state even when that page succeeds. It never
auto-clears the marker, resumes its cursor, or expands into normal three-page
turns. Review the persisted cursor/counts and wait for the published probe jobs
to reach an accepted ready/failed result. Only after entitlement and results
are confirmed may the operator create a separate normal enqueue run without a
resume marker. That run scans from the beginning; current job state and queue
publication markers make the rescan idempotent. Prior-month quota failures are
automatically eligible on a later normal run.

Replacement and removal retire the exact version-scoped thumbnail in D1 before
private R2 deletion. Database triggers atomically create a cleanup-ledger entry
whenever a current job changes version or is deleted. The Operations scheduler
retries idempotent deletes eight times with bounded exponential backoff and
keeps exhausted failures visible. Processors require a canonical client source,
an exact pre-existing D1 job, and an exact ETag before any R2 read; a worker that
loses the completion race schedules its own output for deletion. Trash removes
derivatives immediately while retaining the original, restore requeues only
supported still images, and daily reconciliation repairs missed create events.

After fixing a transient root cause, an operator may set the exact current job
back to `pending` and replay its `image-thumbnail.v1` message through an
authorized operational procedure. Confirm the R2 source ETag still matches
first. Never replay by exposing R2 credentials to a browser. Permanent failures
should remain failed and use `thumbnailFallbackKind`. Do not use the quota
resume marker for invalid/unsupported/oversized content failures.

## Rollout and rollback

Roll out browser upload and backfill capabilities independently. Deploy the
schema-compatible Workers with direct uploads still disabled, prove queue and
thumbnail behavior, complete the reviewed dry run, and only then execute the
enqueue backfill. Enable authenticated browser uploads only after their own
staging evidence is accepted. Changing a flag is a deployment and must use the
same reviewed, pinned commit and binding inventory.

For browser-upload rollback, first set `DIRECT_DELIVERY_UPLOADS_ENABLED=false`
while leaving the current cleanup-capable Worker deployed. Let active sessions
complete or expire, confirm multipart staging is empty, and then roll back the
Worker version if required. The additive upload-intent schema can remain.

For an in-progress backfill, do not create another run. Stop new inventory work
by marking the exact active run failed with an operator reason or deploying the
recorded prior Worker, then let already-published queue messages reach a stable
ready/failed/DLQ state. Do not purge the queue or delete originals. Preserve the
run row and counters as evidence.

For a pipeline rollback, roll back the Worker versions only after the queue is
stable; detach the thumbnail producer/consumers only if the prior version lacks
their bindings. Additive D1 tables and columns can remain. Existing originals
and legacy derivatives are untouched, so rollback does not risk client files.
Do not remove the `ltds-file-events` notification because it also maintains the
file index. After the rollback window, legacy `.previews` content and
`_ltds/thumbnails/v2/` objects may be removed only through a separately
reviewed, recoverable cleanup plan that proves source ownership and version.

## Known limitations

- Supported still images and eligible MP4 videos receive real thumbnails. PDF,
  non-MP4 video, archives, office documents, and unknown files use local generic
  icons. MP4 files that are not H.264 or exceed ten minutes are expected to be
  rejected by Cloudflare and end in failed icon fallback.
- Frame extraction requests `5s`. Cloudflare does not document an error code
  that distinguishes a short clip from entitlement, quota, decoder, or service
  failures, so the Worker does not broadly retry failures at `0s`. Short clips
  succeed if the service clamps the requested time; otherwise bounded queue
  retries end in failed fallback. Add an early-frame retry only after Cloudflare
  publishes a stable, testable out-of-range signal.
- Queue, Images, and Media unit tests use synthetic mocks; a non-production
  remote Cloudflare staging smoke test is still required to validate binding
  entitlement, short-clip behavior, and real decoder behavior.
- Pending, failed, and unsupported items render a local file-type placeholder;
  a failed thumbnail request never switches to the original or a public asset.
- Legacy prepared-artifact tables and readers are retained for rollback and
  cleanup compatibility, but new manifests and image routes do not use them.
