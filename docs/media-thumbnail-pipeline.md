# Private thumbnail delivery and upload runbook

## Active production model

The authenticated TrueNAS `queue-renderer` service is the primary renderer for
every supported still image, first-page PDF, and video job, including direct
browser uploads that never pass through the local Jobs dataset. It claims
exact-version work through `/api/internal/thumbnail-renderer/v1`, reads only the
claimed R2 source, and uploads one bounded WebP through the attempt-bound
Operations URL.

The older two-container pre-generation app in `apps/thumbnail-renderer` remains
an optional optimization for server-owned files already present on the local
Jobs dataset. It can register synchronized still/PDF `prebuilt/` artifacts
through `/api/internal/thumbnail-ingest/v1`, but it is not the primary queue
consumer and cannot cover browser-only R2 uploads. Do not point either component
at the other's endpoint or share their credentials.

The private Cloudflare Container is a delayed still/PDF fallback. It must not be
the accidental primary path: a healthy TrueNAS renderer gets the first bounded
claim window, and the Cloudflare consumer may render only an unclaimed image or
PDF after that window. Video never enters the Cloudflare decoder.

Originals stay private in the `client-data` R2 bucket. Browsers receive
same-origin authorized thumbnail routes; they never receive public R2 URLs,
bucket credentials, or an original-file fallback.

The source lifecycle is:

1. `PutObject`, `CopyObject`, and `CompleteMultipartUpload` events under the exact
   case-sensitive `Jobs/` source boundary enter `ltds-file-events`.
2. Operations updates `file_index`, records an ETag/size-bound D1 job, and
   publishes `image-thumbnail.v1` to `ltds-thumbnail-jobs`. At-least-once event
   and queue delivery converge on the same current-version job. Queue delivery
   starts with a 30-second delay so TrueNAS can claim first. A live TrueNAS lease
   makes the Cloudflare delivery acknowledge without a thumbnail-body or
   Container read; independent bounded image-location/EXIF work may still run.
   Expired lease reconciliation republishes the exact-version job.
3. The `queue-renderer` polls
   `https://incoming.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1/claim?includeKind=all`.
   A claim is bound to the exact source key, source ETag, source size, derivative
   key, and attempt number. Its opaque `leaseId` is required by every subsequent
   source, upload, heartbeat, failure, and completion operation.
4. The queue renderer reads only that claimed source through private RAM-backed
   scratch, verifies its exact identity and applicable byte bounds, and renders
   a metadata-stripped static WebP (exactly `320x240`, at most 128 KiB), uploads it through the
   returned URL, and reports completion. Operations verifies the derivative in
   R2 before marking the D1 job ready.
5. Replacement, delete, move, trash, restore, and retention events retire the
   old mapping. Cleanup is exact-key and exact-ETag guarded; scheduled audits
   repair missed registrations and managed orphans.

## Canonical edge and authentication policy

The two private TrueNAS APIs intentionally use different edge policies:

- `https://ops.ledgetopdroneservices.com/api/internal/thumbnail-ingest/v1`
- `https://incoming.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1/*`

Cloudflare Access covers the prebuilt ingest prefix on Operations with a Service
Auth policy containing only the dedicated TrueNAS service token. Those requests
must pass both Access (`CF-Access-Client-Id` and `CF-Access-Client-Secret`) and
the Worker bearer check (`Authorization: Bearer <THUMBNAIL_INGEST_SECRET>`).

The all-media queue renderer is a machine endpoint on Incoming and must answer
directly, without an Access login redirect. It still requires the independent, at least
32-character Worker bearer before any D1 or R2 operation. Restrict and rate-limit
the exact renderer prefix at the edge; do not expose it on any additional host.
The Access-protected Operations renderer alias is accepted only when
`queue-renderer` is also configured with the paired Access service-token values.

The Worker has no `workers.dev` or preview URL. Keep those routes disabled and
reject any new hostname until its edge policy is reviewed.

## TrueNAS queue-worker protocol

The canonical runtime is the repository-owned `queue-worker` image, deployed as
the TrueNAS `queue-renderer` service. The image bakes the version-controlled
queue worker and all required libvips, Poppler, and FFmpeg tooling into one
immutable artifact. Deploy the exact GHCR digest produced by the repository
workflow; do not copy a script into a floating third-party FFmpeg image.

All renderer requests send the Worker bearer. The Operations alias additionally
sends both Access service-token headers. JSON requests also send
`Content-Type: application/json`. Resolve returned relative URLs against the
configured renderer API origin; do not rewrite their path, query, or opaque
lease token.

| Operation | Request and required data | Accepted result |
| --- | --- | --- |
| Claim | `POST /api/internal/thumbnail-renderer/v1/claim?includeKind=all` | `200 {"status":"idle"}` or `200` with `status`, `leaseId`, `sourceKey`, `sourceEtag`, `sourceSize`, `mediaKind` (`image`, `pdf`, or `video`), authoritative `sourceContentType`, `thumbnailKey`, `r2SourceUrl`, optional video `r2PresignedUrl`, and `r2UploadUrl` |
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
capacity, reading, decoding, rendering, uploading,
and waiting for the completion response. Stop it only after `complete` or `fail`
has been accepted. A heartbeat transport failure may be retried within the same
60-second period, but any non-`200` response or inability to confirm a heartbeat
before the current D1 lease can expire requires aborting that attempt.

Do not start the heartbeat only when FFmpeg begins. Large videos can consume the
entire lease while waiting for space or reading metadata. Do not call `complete`
or `fail` without the exact claim's `leaseId`.

### Bounded TrueNAS execution

The `queue-renderer` supervisor starts four isolated worker slots by default.
`LTDSTHUMB_WORKER_CONCURRENCY` is the only slot control and accepts 1 through 8;
the released default and configured value must match the image's startup log and
Compose definition. The slots are one shared pool across image, PDF, and video,
so four configured slots permit at most four concurrent jobs of any mixture,
including four videos. Each slot owns one claim, heartbeat loop, per-job
directory, and cleanup lifecycle. The shared `/scratch` and `/cache` mounts are
Docker `tmpfs`, not persistent datasets. An image or PDF source is downloaded in
full only after an exact lease, into that slot's RAM-backed directory, and
removed after the attempt. A video source is never copied in full.

Startup must emit one bounded capability record containing the queue-renderer
version, slot count, supported media kinds, and resource profile. It must not log
source keys, filenames, R2 URLs, ETags, bearer values, Access values, or source
bytes. Every job log uses only its slot number, media kind, safe outcome, and
bounded timing/byte counters.

### Large-video behavior

Video eligibility is at most `10 * 1024 * 1024 * 1024` bytes (10 GiB). A file
above that exact byte limit is unsupported. A near-limit video can run longer
than its 15-minute initial lease and therefore depends on the heartbeat loop;
treating a reclaim as harmless is not an alternative.

When Operations has its dedicated R2 signing credential, a video claim includes
an `r2PresignedUrl` valid for 900 seconds. If it is absent, the renderer uses the
exact authenticated `r2SourceUrl` with the required Access and bearer headers.
The signed URL is a claim-scoped read convenience, not a bucket credential and
not a lease.

Do not pass either remote URL or any authentication header directly to FFmpeg.
The version-controlled worker keeps the validated URL and headers inside a
loopback-only range proxy; FFprobe and FFmpeg see only that loopback endpoint.
The proxy permits the byte ranges needed to locate container metadata and a
usable keyframe, including tail ranges when MP4/MOV metadata is not at the
front. A fixed prefix-only read is not a valid implementation. Redirects,
nested network references, unexpected methods, and out-of-bounds ranges fail
closed. The aggregate bytes served for one video attempt are capped at 512 MiB;
exceeding that budget fails the bounded attempt instead of downloading the full
video. Never fall back to a public R2 URL, a persistent source copy, or a TrueNAS
bucket credential.

## Format and resource matrix

| Source | Active thumbnail behavior |
| --- | --- |
| Still image | Authenticated TrueNAS queue renderer first; exact leased source <= 512 MiB in per-slot tmpfs; optional prebuilt may win for local Jobs files; delayed private Cloudflare fallback |
| PDF | Authenticated TrueNAS queue renderer first; first page only and exact leased source <= 256 MiB in per-slot tmpfs; optional prebuilt may win for local Jobs files; delayed private Cloudflare fallback |
| Video | Authenticated TrueNAS queue renderer; range-aware loopback streaming with a 512 MiB per-attempt read budget; source <= 10 GiB; no Cloudflare decoder fallback |
| Office, text, archive, audio, other | Type-specific icon only |

The Cloudflare Container has a five-minute process timeout. The repository-owned
TrueNAS pre-generator has a separate two-minute local render timeout and does not
open video. The queue renderer's safety boundary is the exact source limit,
per-job timeout, bounded RAM scratch or range reads, continuous heartbeat, and
six-attempt job lifecycle. Do not reuse one component's timeout or scratch-space
settings for another.

Invalid, encrypted, oversized, or resource-exhausting inputs finish in an
explicit failed/not-applicable state. Queue-renderer failures retry until the sixth
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

This app is not the all-media queue renderer. Its `LTDSTHUMB_HEARTBEAT_MS`
setting is a local health-file cadence, not the renderer API heartbeat described above.
Installing or updating it cannot repair a queue renderer that fails to post
`/heartbeat` with the claim's `leaseId`.

## Cloudflare Container fallback

The private RPC-only Cloudflare Container renders still images and first-page
PDFs only when the unified renderer presence is stale or after a retryable
TrueNAS still/PDF failure. The 30-second direct-upload delay is the initial
ownership window, not permission to drain a healthy busy server's backlog. It
does not render video. If TrueNAS owns the work, the Cloudflare consumer
acknowledges without a thumbnail-body/Container read or second claim; independent
bounded image-location/EXIF work may still run. The 15-minute raw/prebuilt grace
remains separate and must not be shortened to the direct-upload value.

The fallback currently uses four deterministic `ThumbnailRendererContainer`
shards, a Cloudflare Queue batch size of one, and maximum queue concurrency four.
That is failover capacity, not permission to route healthy primary traffic to
Cloudflare. A source-transfer failure is transient and eligible for bounded
recovery; it must not be persisted as permanent invalid input.

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

`.github/workflows/publish-thumbnail-renderer.yml` publishes the immutable
`decoder`, `broker`, and `queue-worker` targets. The TrueNAS `queue-renderer`
service must use the exact `queue-worker` digest from the release receipt; never
deploy `latest`, a mutable tag, or a locally copied script layered onto an
unrelated FFmpeg image. Before it writes that receipt, the workflow reads the
commit tag back from the registry, compares the resolved digest with the build
result, and runs the all-media canary against that exact published digest. The
workflow does not deploy `ltds-ops`, `ltds-clients`, or `ltds-ops-sync`.

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
- Focused tests prove `includeKind=all` leases exact current image, PDF, and video
  rows to TrueNAS; a live lease prevents Cloudflare thumbnail-body and
  Container reads (independent bounded image-location/EXIF work may still read
  source metadata); and the
  delayed fallback can claim only an unleased image/PDF after its grace.

## Release regression and production canary gates

The following are release-blocking invariants, not optional diagnostics:

1. API contract tests seed current image, PDF, and video rows and prove the
   authenticated `includeKind=all` claim returns each kind, binds every callback
   to the opaque lease, rejects unsupported kinds, and cannot mutate a replaced
   or reclaimed source version.
2. The built `queue-worker` image runs synthetic JPEG, PNG, first-page PDF, and
   short and seekable video cases through claim, source read, heartbeat, WebP
   upload, and completion. Outputs are static metadata-free `320x240` WebPs no
   larger than 128 KiB. The smoke must use the same image digest deployed to
   TrueNAS, not host-installed media tools.
3. Source-transport tests prove images and PDFs use exact leased full reads into
   per-slot tmpfs, while videos use the loopback proxy, request HTTP ranges, can
   read required tail metadata, obey the 512 MiB aggregate budget, and never
   create a persistent or full-size source copy.
4. Ownership tests prove the production queue renderer calls
   `claim?includeKind=all`; no release may narrow that runtime call to
   `includeKind=video`. The 30-second delay is only the first delivery window:
   fresh unified-worker polls and signed active-job heartbeats keep an unfailed
   still/PDF backlog owned by TrueNAS even while every slot is busy. Cloudflare
   then performs zero thumbnail-body/Container reads, although independent
   bounded location/EXIF work may run. When that presence signal becomes stale,
   a bounded scheduler republishes exact pending work; Cloudflare renders only
   a still or PDF and leaves video pending. A retryable TrueNAS still/PDF failure
   also hands that exact attempt to the Cloudflare fallback without waiting for
   server health to become stale.
5. Configuration tests prove `queue-renderer` uses the digest-pinned
   `queue-worker` image, `/scratch` and `/cache` are tmpfs, worker concurrency is
   in the 1-through-8 contract, and the private Cloudflare fallback remains
   bounded to four shards/instances rather than becoming the primary pool.
6. Log tests and live inspection prove startup reports the expected all-media
   capabilities and slot count, while startup/job logs contain no source keys,
   filenames, ETags, remote URLs, credentials, or source bytes.

After rollout, upload one non-client synthetic source of each supported kind and
watch each exact D1 job reach ready through provider `ltds-truenas`. Record the
oldest pending age, claim/completion counts by media kind, retry/failure codes,
and provider split. Alert on a growing oldest-pending age, repeated lease expiry,
loss of the startup heartbeat/capability record, or sustained Cloudflare
fallback use while TrueNAS is healthy. Provider split is a routing canary: an
unexpected rise in `cloudflare-container` results is evidence that primary
claims are late or unavailable, not successful scale-out.

## Failure, rollback, and cost

Transient R2/D1 errors retry with bounded delay. Permanent format, size, pixel,
encryption, and metadata failures stay visible and use an icon. Six total queue
deliveries align with `max_retries: 5`; exhausted queue work is recorded by the
DLQ consumer. Attempt-bound leases prevent an older renderer from completing or
failing a reclaimed row.

Rollback the queue renderer by pinning its last verified immutable `queue-worker`
image digest, not by disabling source recognition, narrowing claims to video, or
deleting the renderer API. If the queue renderer is unhealthy, leave video jobs
pending and allow only the documented delayed still/PDF Cloudflare fallback.

Costs include Queue operations/retries, R2 LIST/HEAD/GET/PUT/delete and stored
derivatives, Workers/D1 operations, and exact R2 source reads. TrueNAS shifts
supported media decode CPU away from Cloudflare; it does not remove the need to
monitor lease expiry, retries, R2 operations, or derivative retention.
