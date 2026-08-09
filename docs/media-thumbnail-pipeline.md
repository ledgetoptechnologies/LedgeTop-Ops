# Private thumbnail delivery and upload runbook

## Active production model

LTDS does not depend on Cloudflare Images or Media Transformations for
thumbnails. Originals stay private in the `client-data` R2 bucket and are read
only by an exact-version renderer. Browsers receive same-origin authorized
thumbnail routes; they never receive public R2 URLs, bucket credentials, or an
original-file fallback.

The source lifecycle is:

1. `PutObject`, `CopyObject`, and `CompleteMultipartUpload` events under the
   exact case-sensitive `Jobs/` source boundary enter `ltds-file-events`.
2. Operations updates `file_index`, records an ETag/size-bound D1 job, and
   publishes `image-thumbnail.v1` to `ltds-thumbnail-jobs`. At-least-once event
   and queue delivery converge on the same current-version job.
3. Jobs arriving from raw server/rclone R2 events wait 15 minutes for an
   optional TrueNAS prebuilt artifact to register. Direct browser/staff enqueue
   keeps a 30-second grace. If no valid current prebuilt wins, Operations streams the
   exact private R2 source to the private RPC-only Cloudflare Container.
4. The selected renderer creates one static metadata-stripped WebP, exactly
   `320x240` and at most 128 KiB. Operations stores the fallback result under
   `_ltds/derivatives/thumbnails/v1/managed/<opaque>.webp` or maps the validated
   prebuilt result. D1 activates only the exact current source ETag.
5. Replacement, delete, move, trash, restore, and retention events retire the
   old mapping. Cleanup is exact-key and exact-ETag guarded; scheduled audits
   repair missed registrations and managed orphans.

The Container has no public route or internet access, receives no source key or
credential, runs one job at a time, and uses capped ephemeral storage. It is a
fallback renderer, not a client-facing Worker. The existing private
`ltds-ops` Worker remains the only queue consumer and orchestrator.

## Format and resource matrix

| Source | Active thumbnail behavior |
| --- | --- |
| Still image | libvips thumbnail; source <= 512 MiB and <= 110,000,000 decoded pixels |
| PDF | Poppler page one only; source <= 256 MiB, sandboxed timeout/resource limits |
| Video | Type-specific icon only; no transfer, frame extraction, preview, or transcode |
| Office, text, archive, audio, other | Type-specific icon only |

The renderer uses a 180-second hard timeout. Invalid, encrypted, oversized, or
resource-exhausting inputs finish in an explicit failed/not-applicable state;
they do not retry forever. Pending, failed, and unsupported list items have no
`thumbnailUrl` and must display the local `thumbnailFallbackKind` icon. List or
grid code must never use `sourceUrl`, `previewUrl`, or `downloadUrl` as a
thumbnail. The original is read only after deliberate authorized activation.

Every thumbnail response is `private, no-store`. Every serve request rechecks
the existing client/org/project/folder grant, revocation and tombstone state
before an R2 read. Cross-client, public-share and revoked access cannot use the
internal renderer or registration endpoint.

## TrueNAS prebuilt path

The optional server pre-generator is packaged in
`apps/thumbnail-renderer`. Install it only through the TrueNAS SCALE Custom App
UI using its `compose.truenas.yaml` and README; do not run Compose from the
TrueNAS system shell.

- The decoder mounts the local Jobs dataset read-only, has no network or
  secrets, and renders still images/PDFs into a persistent local `prebuilt/`
  cache.
- A separate TrueNAS UI Cloud Sync/rclone task SYNCs only that local cache to
  `_ltds/derivatives/thumbnails/v1/prebuilt/`. Never sync the parent
  `_ltds/derivatives/` tree or the Cloudflare-owned `managed/` sibling. Target
  a five-minute non-overlapping schedule; the WebP syncs first, then the broker
  writes the exact-Etag manifest for the next pass. No provisional manifest is
  uploaded.
- The broker has no Jobs mount or media tools. A separate bucket-scoped Object
  Read credential permits R2 HEAD only. It waits for a stable exact source and
  a backend-verifiable full-object SHA-256 equal to the decoder's local digest,
  then waits for the synced WebP, finalizes the manifest, waits for that manifest
  to sync, and registers only the manifest/WebP keys and ETags.
- Registration is an outbound HTTPS POST to
  `/api/internal/thumbnail-ingest/v1`, gated by Cloudflare Access service-token
  headers plus `Authorization: Bearer <THUMBNAIL_INGEST_SECRET>`. Operations
  independently GET/HEAD-validates the source, manifest, WebP, D1 index,
  tombstone state, dimensions, metadata absence, hashes and ETags before ready.

Prebuilt keys are deterministic immutable siblings:

```text
_ltds/derivatives/thumbnails/v1/prebuilt/${sourceKey}/${sourceSha256}.webp
_ltds/derivatives/thumbnails/v1/prebuilt/${sourceKey}/${sourceSha256}.json
```

The source fingerprint is the lowercase full-file SHA-256. The final manifest
uses schema version 1, provider `ltds-truenas`, profile
`ltds-thumbnail-320x240-webp-v1`, the exact source key/ETag/size/MIME, and the
exact WebP key/ETag/size/SHA-256. The WebP is uploaded before the manifest;
registration happens last.

Size, modification time and ETag stability are not content-equality proof. A
missing, composite or mismatched R2 SHA-256 fails closed and leaves the managed
Container fallback authoritative. Cloudflare's current S3 compatibility does
not provide full-object SHA-256 for rclone multipart uploads or document
`x-amz-checksum-mode` on `HeadObject`; do not enable that header, reinterpret a
multipart ETag, or claim those prebuilt objects are verified. Prebuilt activation
requires a future upload path whose full-object SHA-256 is exposed identically
by S3 HEAD and the Workers R2 binding.

With the required five-minute non-overlapping derivative sync, the two-pass
WebP/manifest handshake fits inside the 15-minute server/rclone grace under
healthy conditions. If it misses that window, the private Container renders;
a later valid prebuilt registration deterministically replaces the managed
mapping and queues exact-ETag cleanup. Never predict an R2 ETag or weaken
current-version validation to force the prebuilt path to win. Direct
browser/staff uploads intentionally use the 30-second fallback path.

Superseded local prebuilt versions are retired only after the replacement
registers. Missing sources require a stable Jobs mount, two complete scans and
a 24-hour grace before exact local cache removal; the prebuilt-only SYNC then
removes those remote objects. The backend cleanup ledger is an independent
safety net.

The local decoder persists failures by immutable local source identity. It uses
three bounded exponential-backoff attempts, quarantines permanent/exhausted and
malformed-output failures, and continues later files. A changed source identity
clears that quarantine. The broker similarly quarantines malformed receipts so
one corrupt local record cannot block the rest of the queue.

### Source-sync ownership gate

The server-managed source mirror may propagate deletes/moves only inside
explicitly server-owned visible Jobs prefixes. Browser/team upload prefixes
must be disjoint and excluded by path from that delete-authoritative rclone
scope. This is a production rollout safety gate: using one prefix for both
owners can make rclone delete an R2-only browser upload because it is absent on
the NAS. R2 metadata or tags do not prevent that deletion. Always exclude
`_ltds/**` from source sync.

## Cloudflare resources and migrations

Before enabling processing, verify rather than infer:

- R2 object notifications feed the existing `ltds-file-events` queue with no
  overlapping duplicate rule.
- `ltds-thumbnail-jobs` and `ltds-thumbnail-jobs-dlq` exist. Operations owns
  the exact producer, main consumer and DLQ consumer; the main consumer uses
  `max_retries: 5` and `max_concurrency: 1`.
- `THUMBNAIL_RENDERER` resolves to `ThumbnailRendererContainer`, with one
  `standard-1` maximum instance, `enableInternet=false`, and no SSH/public
  route.
- `DATA_BUCKET`, `DELIVERY_DB`, both thumbnail queues, the 5-minute and
  15-minute crons, and the existing Access application resolve on the exact
  version being deployed.
- Delivery migrations through `0111_thumbnail_render_provenance.sql` are
  applied in order. `0106` creates jobs, `0107` cleanup state, `0108` resumable
  backfills, `0109` photo locations, `0110` the full `Jobs/` scope, and `0111`
  renderer provenance, exact-ETag cleanup, and reconciliation state.

Do not add an Images binding, Media Transformations binding, public R2 domain,
presigned source URL, or separate public `ltds-thumbnails` Worker. Stream may
remain configured for existing authorized playback, but this thumbnail path
does not submit video to Stream.

## Deployment and synthetic acceptance

1. Record the current Worker versions, D1 Time Travel bookmark, applied
   migrations, queue/DLQ depth, R2 notification rules and Container binding.
2. Apply Delivery migrations through `0111`, then upload the schema-compatible
   Operations version without shifting traffic. Inspect the redirected built
   Wrangler config, including the Container image and queue names.
3. Deploy to isolated staging first. Use only synthetic non-client sources.
4. Verify still-image and first-page PDF `pending -> ready`, exact 320x240 WebP
   <=128 KiB, metadata removal, authorized thumbnail serve, and original only
   after a click. Verify video/Office/audio/archive remain icons with zero
   renderer source read.
5. Verify duplicate events, transient retry, six-delivery DLQ exhaustion,
   replacement during render, delete, move, trash, restore, retention expiry,
   stale prebuilt registration, cross-client/revoked/public denial, and no
   original fallback.
6. For the TrueNAS path, stop the broker, render a synthetic source, restart it,
   and prove persistent resume. Replace and delete it, wait for the scoped
   prebuilt sync, and prove no old registered or unregistered prebuilt remains.
7. Review structured logs and D1 aggregates only. Do not include object keys,
   filenames, ETags, source bytes, thumbnails, or secrets in evidence.

## One-time reconciliation/backfill

The resumable backfill lists metadata only under exact `Jobs/`; inventory does
not read source bodies. It skips folder markers, zero-byte, unsupported,
oversized, unindexed, stale-index, tombstoned, trashed and reserved paths. The
cursor, page/retry counts, safe error and aggregate discovered/eligible/queued/
skipped/ready/failed-DLQ/pending counters persist in
`image_thumbnail_backfill_runs`.

Run a `dry_run` first. Proceed with a separate `enqueue` run only if scope and
counts are expected and the Container/queue capacity is accepted. A rerun is
idempotent by source key plus current ETag. Do not enqueue video or unsupported
documents, and do not retry permanent oversize/decoder failures endlessly.
Monitor the queue, DLQ, job table and backfill row until the cursor is null and
the queue has reached a stable ready or explicit terminal state. Use a final
dry run to prove no unexplained current eligible work remains. The backfill
never deletes, renames, copies, rewrites, or downloads originals during
inventory.

## Authenticated Operations browser uploads

Direct delivery uploads are private same-origin Operations routes, not public
R2 uploads. Every request requires the expected host, current Access-backed
staff session, origin/CSRF validation, administrator status, and scoped
`delivery.files.upload` authority for every destination. Client Portal users,
public shares, Incoming contributor sessions, revoked users and cross-client or
cross-project requests are denied before an R2 write.

The browser creates a 24-hour idempotent intent for at most 100 non-empty files
with a 500 GiB per-file and aggregate cap and at most ten active multipart
sessions per staff identity. Paths are NFC-normalized relative descendants of
an authorized `Jobs/Clients/` root. Absolute/backslash/control/dot/dot-dot,
repeated separators, and case-insensitive `Dump`, `_ltds`, or `.previews`
segments are rejected. HTML/SVG/XHTML/JavaScript active content types are
rejected.

There is no silent collision policy. On an actual conflict the UI warns and
offers **Keep old**, **Keep new** (ETag-CAS replacement), or **Keep both**
(conditional safe rename). A changed baseline returns another conflict; it is
never an unconditional overwrite. Retries reuse the same intent and staged
parts. Completion/cancel/expiry record durable cleanup, and exhausted cleanup
remains visible. Replacement recovery is private, seven-day and exact-ETag
guarded.

Successful browser, folder, Dropbox, TrueNAS/rclone and authorized server
uploads converge through the same index, source-event, queue and thumbnail
lifecycle. Copy/move/browser publication may also index synchronously; the
later duplicate event is harmless. Server uploaders must preserve useful MIME
metadata. Incoming-request links retain their separate contributor session,
Turnstile, quarantine and malware-scan flow and cannot call these routes.

Enable `DIRECT_DELIVERY_UPLOADS_ENABLED` only after staging proves single and
folder uploads, progress/partial errors, resume/duplicates, all three collision
choices, malicious paths, limits, Access reauthorization/revocation,
cross-scope/public denial, staging cleanup, thumbnail readiness, replacement,
delete/trash/restore/expiry and no original fallback. The selected browser/team
destination prefix must also pass the rclone ownership gate above.

## Failure, rollback and cost

Transient R2/D1/Container errors retry with bounded delay. Permanent decoder,
format, size, pixel, encryption and metadata failures stay visible and use an
icon. Six total queue deliveries align with `max_retries: 5`; exhausted work is
recorded by the DLQ consumer. A bounded scheduler recovery may replay only an
exact current ETag after its cooldown and attempt ceiling. Never purge a queue,
reset permanent failures, or expose R2 credentials to recover work.

Replacement/removal writes exact artifact ETags into the cleanup ledger before
deletion. Cleanup retries eight times with bounded backoff. A renderer that
loses a version race cannot activate and schedules its own managed output for
cleanup. Reconciliation audits registrations and the backend-owned managed
namespace without enumerating or deleting originals.

Rollback disables new browser uploads first, lets active multipart cleanup
finish, and then routes traffic to the recorded prior compatible Worker.
Already-published queue messages must reach a stable ready/failed/DLQ state;
do not purge them. Additive migrations may remain. Never remove the shared
`ltds-file-events` notification during thumbnail rollback because it also owns
the file index.

Costs include Queue operations/retries, R2 LIST/HEAD/GET/PUT/delete and stored
derivatives, D1 operations, and Cloudflare Container active duration plus any
minimum-instance charges on the chosen plan. TrueNAS pre-generation shifts
decode CPU and the source read to existing NAS infrastructure but adds the
prebuilt sync and broker HEADs. It does not eliminate transfer of the original
from local storage to R2 through the existing source sync. Record current
Cloudflare limits/pricing before production; this repository cannot prove an
account entitlement or bill.
