# Private thumbnail delivery and upload runbook

## Active production model

LTDS uses a TrueNAS-hosted Docker container as the primary thumbnail
renderer. Originals stay private in the `client-data` R2 bucket. Browsers
receive same-origin authorized thumbnail routes; they never receive public
R2 URLs, bucket credentials, or an original-file fallback.

The source lifecycle is:

1. `PutObject`, `CopyObject`, and `CompleteMultipartUpload` events under the
   exact case-sensitive `Jobs/` source boundary enter `ltds-file-events`.
2. Operations updates `file_index`, records an ETag/size-bound D1 job, and
   publishes `image-thumbnail.v1` to `ltds-thumbnail-jobs`. At-least-once event
   and queue delivery converge on the same current-version job.
3. The TrueNAS thumbnail queue worker polls the Operations renderer API
   (`/api/internal/thumbnail-renderer/v1/claim`) over HTTPS. The Worker proxies
   all R2 reads and writes through its binding; the TrueNAS container needs no
   R2 S3 credentials. The claim API uses the `incoming.` subdomain which
   bypasses Cloudflare Access.
4. The worker downloads the source through the Worker's R2 proxy, renders a
   metadata-stripped WebP (exactly `320x240`, at most 128 KiB), uploads it
   back through the Worker's R2 proxy, and reports completion. The Worker
   verifies the thumbnail in R2 and marks the D1 job ready.
5. Replacement, delete, move, trash, restore, and retention events retire the
   old mapping. Cleanup is exact-key and exact-ETag guarded; scheduled audits
   repair missed registrations and managed orphans.

The TrueNAS container has no inbound port, no R2 S3 credentials, and no
persistent datasets. It uses a tmpfs scratch space (10 GiB). A file-based
space reservation system prevents parallel workers from overfilling tmpfs.
The Worker remains the only queue consumer and orchestrator.

## Format and resource matrix

| Source | Active thumbnail behavior |
| --- | --- |
| Still image | vipsthumbnail (libvips) with ffmpeg fallback for unusual ICC profiles; source <= 512 MiB |
| PDF | Poppler page one, then libvips resize; source <= 256 MiB |
| Video | ffmpeg frame extraction at 10% of duration (5-30s seek); source <= 10 GiB. Full file downloaded to tmpfs, ffmpeg seeks locally (DJI videos have moov atom at end, no faststart) |
| Office, text, archive, audio, other | Type-specific icon only |

The renderer uses a 240-second timeout per job. Invalid, encrypted, oversized,
or resource-exhausting inputs finish in an explicit failed/not-applicable
state; they retry up to 6 times then stay failed. Pending, failed, and
unsupported list items have no `thumbnailUrl` and display the local
`thumbnailFallbackKind` icon.

Every thumbnail response is `private, no-store`. Every serve request rechecks
the existing client/org/project/folder grant, revocation and tombstone state
before an R2 read.

## TrueNAS queue worker deployment

Files are in `Hermes/truenas-scripts/thumbnail-gen/` on the SMB share:

- `docker-compose.yml` - jrottenberg/ffmpeg:latest, inline apt-get for
  ca-certificates libvips-tools poppler-utils curl python3 bc, 10 GiB RAM cap,
  12 concurrent workers, tmpfs scratch (10 GiB), no Dockerfile, no datasets
- `thumbnail-queue-worker.sh` - the main worker script
- `README.md` - deployment instructions

Deploy on TrueNAS:

1. Copy the folder to `/mnt/Plugins/Scripts/ffmpeg/ltds-thumbnail-queue/`
2. In TrueNAS UI: Apps > Custom App > Install via YAML
3. Paste `docker-compose.yml`
4. Set `LTDSTHUMB_API_TOKEN` to the `THUMBNAIL_INGEST_SECRET` value (non-expiring)
5. Start the container

No datasets, no Cloud Sync tasks, no R2 S3 keys, no runtime Dockerfile.

### Concurrency and space management

The worker runs up to 12 jobs in parallel. Each background worker:
1. Claims a job from the API (atomic, no two workers get the same job)
2. Reserves its source size in a file-based reservation system (BASHPID)
3. Waits for tmpfs space if other workers are using it (heartbeat extends lease)
4. Downloads the source, renders, uploads, reports completion
5. Releases the reservation

Videos and images run side by side. If 11 photos are running and a 1.5 GiB
video is next, the video waits for space to free up before downloading.

### Critical: sourceEtag in R2 customMetadata

The thumbnail upload endpoint stores `sourceEtag` in the R2 object's
`customMetadata`. `getThumbnailForAuthorizedSource` requires this field to
match the source file's etag. Without it, thumbnails are treated as "pending"
instead of "ready" and never display on the delivery page.

## Cloudflare Container fallback

The private RPC-only Cloudflare Container remains available as a fallback for
small images and PDFs (source <= 220 MiB). It cannot handle large videos
because the Worker streams the full source to the Container's ephemeral disk,
which has a 180-second timeout. The TrueNAS worker is the primary renderer;
the Container is a secondary path for files that arrive directly in R2 without
going through TrueNAS.

## Worker auto-deployment

`.github/workflows/deploy-workers.yml` auto-deploys both Workers
(`ltds-ops` and `ltds-clients`) on every push to main that touches
`apps/operations`, `apps/client`, or `packages/shared`. Requires
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repository
secrets.

## Cloudflare resources

- R2 object notifications feed `ltds-file-events` queue
- `ltds-thumbnail-jobs` and `ltds-thumbnail-jobs-dlq` queues exist
- `THUMBNAIL_RENDERER` resolves to `ThumbnailRendererContainer`
- `DATA_BUCKET` (client-data R2 bucket) and `DELIVERY_DB` (client-data D1)
- `THUMBNAIL_INGEST_SECRET` Worker secret (renderer API token, non-expiring)
- Delivery Worker migrations through `0111_thumbnail_render_provenance.sql`
- `videoThumbnailSourceDisabled()` returns false (video thumbnails enabled)
- Client delivery Worker includes "video" in thumbnail lookups

## Failure, rollback and cost

Transient R2/D1 errors retry with bounded delay. Permanent format, size,
pixel, encryption and metadata failures stay visible and use an icon. Six
total queue deliveries align with `max_retries: 5`; exhausted work is
recorded by the DLQ consumer.

The TrueNAS worker costs nothing in Cloudflare - all processing is local on
the NAS. R2 operations (reads, writes) are billed at standard rates but are
negligible for thumbnail-sized objects (~20 KiB each). The Worker proxy adds
no measurable cost since it uses the existing binding.

Costs include Queue operations/retries, R2 LIST/HEAD/GET/PUT/delete and
stored derivatives, and D1 operations. TrueNAS processing shifts decode CPU
and source reads to existing NAS infrastructure.