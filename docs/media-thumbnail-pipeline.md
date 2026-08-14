# Private thumbnail delivery and upload runbook

## Active production model

LTDS has two separate TrueNAS thumbnail paths. Do not combine their deployment
instructions or credentials:

- The repository-owned two-container pre-generation app in
  `apps/thumbnail-renderer` reads the local Jobs dataset and pre-generates still
  image and first-page PDF thumbnails. It does not decode videos and it registers
  only already-synchronized `prebuilt/` artifacts through
  `/api/internal/thumbnail-ingest/v1`.
- A separately maintained TrueNAS queue worker claims pending video jobs through
  `/api/internal/thumbnail-renderer/v1`. Operations proxies or signs the exact R2
  source and accepts the bounded WebP upload. The queue worker must not be pointed
  at the prebuilt ingest endpoint.

Originals stay private in the `client-data` R2 bucket. Browsers receive
same-origin authorized thumbnail routes; they never receive public R2 URLs,
bucket credentials, or an original-file fallback.

The source lifecycle is:

1. `PutObject`, `CopyObject`, and `CompleteMultipartUpload` events under the exact
   case-sensitive `Jobs/` source boundary enter `ltds-file-events`.
2. Operations updates `file_index`, records an ETag/size-bound D1 job, and
   publishes `image-thumbnail.v1` to `ltds-thumbnail-jobs`. At-least-once event
   and queue delivery converge on the same current-version job. The Cloudflare
   queue consumer may render still images and PDFs, but it acknowledges video
   queue signals without claiming the D1 row or reading source bytes. The
   pending video row remains available to the authenticated TrueNAS queue
   worker.
3. The queue worker polls
   `https://ops.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1/claim`.
   A claim is bound to the exact source key, source ETag, source size, derivative
   key, and attempt number. Its opaque `leaseId` is required by every subsequent
   source, upload, heartbeat, failure, and completion operation.
4. The queue worker downloads only that claimed source into private scratch,
   verifies the exact byte count, renders a metadata-stripped
   static WebP (exactly `320x240`, at most 128 KiB), uploads it through the
   returned URL, and reports completion. Operations verifies the derivative in
   R2 before marking the D1 job ready.
5. Replacement, delete, move, trash, restore, and retention events retire the
   old mapping. Cleanup is exact-key and exact-ETag guarded; scheduled audits
   repair missed registrations and managed orphans.

## Canonical edge and authentication policy

Both private TrueNAS APIs use only the Operations origin:

- `https://ops.ledgetopdroneservices.com/api/internal/thumbnail-ingest/v1`
- `https://ops.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1/*`

Cloudflare Access must cover both prefixes with a Service Auth policy containing
only the dedicated TrueNAS service token. Every request must pass the Access
edge check with `CF-Access-Client-Id` and `CF-Access-Client-Secret` and then pass
the Worker application check with `Authorization: Bearer
<THUMBNAIL_INGEST_SECRET>`. A staff browser session, either credential by itself,
or a token used by rclone, Wrangler, Project Alpha, or Incoming is insufficient.

`incoming.ledgetopdroneservices.com` intentionally exposes selected public
incoming-request routes and is not the renderer origin. Because Operations is a
shared Worker and its internal dispatcher recognizes configured Operations and
Incoming hosts, the edge configuration must explicitly block or Access-protect
both internal thumbnail prefixes on `incoming.`. Never rely on the application
bearer alone there, and never configure a TrueNAS client to use `incoming.`.

The Worker has no `workers.dev` or preview URL. Keep those routes disabled and
reject any new hostname until its edge policy is reviewed.

## TrueNAS queue-worker protocol

The queue worker is maintained outside this repository. Its implementation is
acceptable only if it follows this contract exactly.

All Operations-origin requests send the three authentication headers described
above. JSON requests also send `Content-Type: application/json`. Resolve returned
relative URLs against `https://ops.ledgetopdroneservices.com`; do not rewrite
their path, query, or opaque lease token.

| Operation | Request and required data | Accepted result |
| --- | --- | --- |
| Claim | `POST /api/internal/thumbnail-renderer/v1/claim` | `200 {"status":"idle"}` or `200` with `status`, `leaseId`, `sourceKey`, `sourceEtag`, `sourceSize`, `mediaKind`, `thumbnailKey`, `r2SourceUrl`, optional `r2PresignedUrl`, and `r2UploadUrl` |
| Source | `GET` the returned `r2SourceUrl`; Range is supported | `200` full body or `206` for one valid byte range |
| Upload | `PUT` the returned `r2UploadUrl` with one static WebP no larger than 128 KiB | `200` with the stored clean `etag` and `size` |
| Heartbeat | `POST .../heartbeat` with `{"sourceKey":"<exact claim value>","leaseId":"<opaque claim value>"}` | `200 {"status":"ok"}` |
| Complete | `POST .../complete` with `leaseId`, `thumbnailKey`, the upload response's `thumbnailEtag`, and numeric `thumbnailSize` | `200 {"status":"ready"}` or `200 {"status":"already_ready"}` |
| Fail | `POST .../fail` with `sourceKey`, `leaseId`, a stable safe `errorCode`, and a message of at most 240 characters | `200 {"status":"retrying"}` or `200 {"status":"failed"}` |

Treat `leaseId` as an opaque, case-sensitive string. Never decode it, synthesize
it, persist it for another job, or substitute an attempt counter. A stale or
reclaimed attempt receives `404`; it must immediately stop source reads,
rendering, upload, and terminal callbacks. `401` means the application secret is
wrong. An Access redirect or Access `401`/`403` means the Service Auth headers or
edge policy are wrong; the client must not follow an interactive login redirect.

### Lease and heartbeat requirement

A successful video claim starts with a 15-minute D1 processing lease, matching
the optional presigned source URL lifetime. Non-video claims start with five
minutes. An early heartbeat never shortens the initial video lease; once fewer
than five minutes remain, each successful heartbeat extends the expiry to five
minutes from that heartbeat. The signed opaque token may remain cryptographically
valid for up to 24 hours, but that does not extend the D1 lease and is not
permission to continue after a missed heartbeat or reclaim.

Start a dedicated heartbeat loop immediately after every successful claim and
send a heartbeat every **60 seconds**. Keep it running while waiting for local
capacity, downloading, decoding, rendering, uploading,
and waiting for the completion response. Stop it only after `complete` or `fail`
has been accepted. A heartbeat transport failure may be retried within the same
60-second period, but any non-`200` response or inability to confirm a heartbeat
before the current D1 lease can expire requires aborting that attempt.

Do not start the heartbeat only when FFmpeg begins. Large videos can consume the
entire lease while waiting for space or reading metadata. Do not call `complete`
or `fail` without the exact claim's `leaseId`.

### Large-video behavior

Video eligibility is at most `10 * 1024 * 1024 * 1024` bytes (10 GiB). A file
above that exact byte limit is unsupported. A near-limit video can run longer
than its 15-minute initial lease and therefore depends on the heartbeat loop;
treating a reclaim as harmless is not an alternative.

When Operations has its dedicated R2 signing credential, a video claim includes
an `r2PresignedUrl` valid for 900 seconds. The worker may use it only in a
redirect-disabled, HTTPS-only `curl` download. If it is absent, the worker uses
the exact authenticated `r2SourceUrl` with the Access and bearer headers under
the same redirect-disabled rule. The signed URL is a claim-scoped read
convenience, not a bucket credential and not a lease.

Do not pass either network URL or any authentication header to FFmpeg. Media
containers and disguised playlists can reference nested network resources, and
FFmpeg can follow those references independently of HTTP redirect settings. The
version-controlled worker therefore downloads the one claimed object first,
verifies its byte count, and runs FFmpeg against a local file with only
`file,pipe` protocols enabled. Give the container at least 12 GiB of private
scratch; it checks space before downloading and deletes every source copy after
the attempt. Never fall back to a public R2 URL or a TrueNAS bucket credential.

## Format and resource matrix

| Source | Active thumbnail behavior |
| --- | --- |
| Still image | Optional TrueNAS prebuilt path or private Cloudflare Container; source <= 512 MiB |
| PDF | Optional TrueNAS prebuilt first page or private Cloudflare Container; source <= 256 MiB |
| Video | Authenticated TrueNAS queue worker only; exact local scratch copy, then network-disabled FFmpeg; source <= 10 GiB |
| Office, text, archive, audio, other | Type-specific icon only |

The Cloudflare Container has a five-minute process timeout. The repository-owned
TrueNAS pre-generator has a separate two-minute local render timeout and does not
open video. The external video queue worker has no documentation-defined render
timeout; its safety boundary is the exact source limit, bounded extraction,
continuous heartbeat, and six-attempt job lifecycle. Do not reuse one
component's timeout or scratch-space settings for another.

Invalid, encrypted, oversized, or resource-exhausting inputs finish in an
explicit failed/not-applicable state. Queue-worker failures retry until the sixth
claimed attempt, then stay failed. Pending, failed, and unsupported list items
have no `thumbnailUrl` and display the local `thumbnailFallbackKind` icon.

Every thumbnail response is `private, no-store`. Every serve request rechecks
the existing client/org/project/folder grant, revocation, and tombstone state
before an R2 read.

## Repository-owned TrueNAS pre-generation app

Install the two-service Custom App from `apps/thumbnail-renderer` exactly as its
README documents. It uses immutable digest-pinned decoder and broker images,
read-only Jobs access for the decoder, no network for the decoder, HEAD-only R2
authority for the broker, and a dedicated one-way sync restricted to the exact
`_ltds/derivatives/thumbnails/v1/prebuilt/` subtree.

This app is not the video queue worker. Its `LTDSTHUMB_HEARTBEAT_MS` setting is a
local health-file cadence, not the renderer API heartbeat described above.
Installing or updating it cannot repair a queue worker that fails to post
`/heartbeat` with the claim's `leaseId`.

## Cloudflare Container fallback

The private RPC-only Cloudflare Container renders still images and first-page
PDFs. It does not render video. The queue consumer acknowledges video messages
without claiming or failing the D1 row, leaving them pending for TrueNAS.
Managed fallback objects live only under
`_ltds/derivatives/thumbnails/v1/managed/`; prebuilt objects live only under the
sibling `prebuilt/` namespace.

## Deployment ownership

This repository has no `.github/workflows/deploy-workers.yml`. Production Worker
auto-builds are owned by the configured Cloudflare Workers Git integration and
must be restricted to reviewed `main` commits as described in
`production-readiness.md`. Inspect and record the integration's branch controls,
root directories, build commands, deploy commands, Worker names, and production
routes before a release; source files alone do not prove those dashboard
settings.

`.github/workflows/publish-thumbnail-renderer.yml` publishes the two immutable
container images for the repository-owned pre-generation app. It does not deploy
`ltds-ops`, `ltds-clients`, or `ltds-ops-sync`, and it does not publish the
external video queue worker.

## Cloudflare resources

- R2 object notifications feed the `ltds-file-events` queue.
- `ltds-thumbnail-jobs` and `ltds-thumbnail-jobs-dlq` exist.
- `THUMBNAIL_RENDERER` resolves to `ThumbnailRendererContainer`.
- `DATA_BUCKET` is the private `client-data` R2 bucket and `DELIVERY_DB` is its D1
  state database.
- `THUMBNAIL_INGEST_SECRET` is a dedicated Operations Worker secret shared only
  with the two TrueNAS clients.
- `THUMBNAIL_INGEST_EXPECTED_HOST` is
  `ops.ledgetopdroneservices.com` in production.
- Operations has dedicated R2 signing values only when video claims should
  receive `r2PresignedUrl`; TrueNAS receives no R2 S3 secret for this path.
- Delivery Worker migrations include the current thumbnail job, attempt-bound
  lease, and video recovery schema.
- `videoThumbnailSourceDisabled()` returns false and video remains in the
  supported source-kind contract.
- Focused tests prove the Cloudflare consumer leaves video pending while the
  authenticated `/claim` endpoint leases it as `mediaKind: video`.

## Failure, rollback, and cost

Transient R2/D1 errors retry with bounded delay. Permanent format, size, pixel,
encryption, and metadata failures stay visible and use an icon. Six total queue
deliveries align with `max_retries: 5`; exhausted queue work is recorded by the
DLQ consumer. Attempt-bound leases prevent an older renderer from completing or
failing a reclaimed row.

Rollback the queue worker by pinning its last verified immutable image or script
version, not by disabling video source recognition or deleting the renderer API.
If the queue worker is unhealthy, leave video jobs pending and keep the
Cloudflare still/PDF path active.

Costs include Queue operations/retries, R2 LIST/HEAD/GET/PUT/delete and stored
derivatives, Workers/D1 operations, and exact R2 source downloads. TrueNAS shifts
video decode CPU away from Cloudflare; it does not remove the need to monitor
lease expiry, retries, R2 operations, or derivative retention.
