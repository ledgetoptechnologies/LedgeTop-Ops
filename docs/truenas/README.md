# TrueNAS SCALE to private R2 synchronization

TrueNAS is authoritative only for the server-owned visible Jobs prefixes that
are explicitly assigned to its mirror. Originals remain private in the
`client-data` bucket. The supported source tree is:

```text
Jobs/<server-owned folders>/...
Jobs/Clients/<client-or-organization>/...
```

Use exact `Jobs` casing. Exclude complete path segments named `Dump`
case-insensitively, hidden legacy `.previews`, and top-level `_ltds/**` from the
source mirror. Do not exclude ordinary names such as `Dumpsters`.

## Source sync credential and task

Create a dedicated R2 S3 credential restricted to Object Read/Write for the
`client-data` bucket. Do not reuse Worker/Wrangler, thumbnail-broker, Stream,
Incoming or account-wide credentials. Store it only in the TrueNAS credential
UI, using the account R2 S3 endpoint and region `auto`.

Create the source task in the TrueNAS Data Protection/Cloud Sync UI:

- direction: Push;
- local root: the server's Jobs dataset;
- remote prefix: `Jobs/` (choose the path pair so keys do not become
  `Jobs/Jobs/...`);
- schedule: hourly, without overlaps;
- symlink following: disabled;
- filter: exclude exact-segment `Dump`, `.previews`, and `_ltds` paths.

Begin with COPY and validate one synthetic folder. Confirm key paths, counts,
byte totals and checksum samples; nested `Dump` exclusions; R2 index events;
and optional image/PDF pre-generation jobs. The checked-in unified TrueNAS
`/api/internal/thumbnail-renderer/v1` queue renderer is primary for supported
images, PDFs, and videos; the pre-generator remains an optional exact-artifact
optimization and intentionally does not decode video. Confirm the queue renderer
produces each supported thumbnail kind and that unsupported documents remain
icons. See the [media thumbnail runbook](../media-thumbnail-pipeline.md). Take
a ZFS snapshot and export the task configuration before switching an approved
server-owned prefix to SYNC.

SYNC is intentionally delete-authoritative inside that explicit source prefix:
local deletes, moves and renames propagate to R2 and the Worker event lifecycle
retires exact-version thumbnails. It must never be bidirectional.

## Browser/team ownership gate

Do not place browser/team-upload-owned R2 objects inside a delete-authoritative
server mirror unless those visible paths also exist on the NAS. Prefer disjoint
visible prefixes and exclude every browser/team prefix by path from the source
rclone task. This is a production rollout safety gate: rclone can delete an
R2-only browser upload because it is absent locally. R2 metadata or tags do not
protect it. Prove the filters with synthetic remote-only objects before
enabling source delete propagation.

## Thumbnail pre-generation Custom App

The supported pre-generator is the two-service TrueNAS Custom App in
[`apps/thumbnail-renderer`](../../apps/thumbnail-renderer/README.md). Install it
through the TrueNAS Apps UI; do not run Docker Compose in the system shell.

- `decoder`: non-root, read-only Jobs mount, no network and no secrets;
  libvips still images and Poppler PDF page one only.
- `broker`: no Jobs mount or decoder tools; outbound HTTPS only; a separate
  bucket-scoped R2 Object Read credential performs HEAD requests; Cloudflare
  Access service-token headers plus `THUMBNAIL_INGEST_SECRET` register exact
  synced artifact identities with Operations.
- output: one metadata-stripped static WebP, exactly 320x240 and <=128 KiB;
  image sources <=512 MiB and <=110 MP; PDFs <=256 MiB; video/Office/audio/
  archives are not opened and remain icons.

The persistent local cache maps through a second, independent TrueNAS UI Cloud
Sync/rclone task:

```text
local:  <thumbnail-artifacts-dataset>/prebuilt/
remote: _ltds/derivatives/thumbnails/v1/prebuilt/
mode:   SYNC
```

Sync only that exact `prebuilt/` subtree. Never select
`_ltds/derivatives/`, `_ltds/derivatives/thumbnails/v1/`, or the sibling
`managed/` subtree; `managed/` belongs exclusively to Cloudflare fallback
cleanup. The broker itself never PUTs or deletes R2 objects.

Target a five-minute non-overlapping schedule for this derivative-only task.
The first pass uploads the WebP; the broker then observes its exact R2 ETag and
writes the final manifest; the next pass uploads that manifest. No provisional
or `sourceEtag:"pending"` manifest is uploaded. This task is intentionally
separate from the hourly source mirror.

The required five-minute non-overlapping schedule lets the two-pass handshake
fit inside the Worker's 15-minute raw server/rclone grace under healthy
conditions. Missing that prebuilt window does not transfer healthy-primary work
to Cloudflare: fresh unified-worker polls and signed active-job heartbeats keep
the backlog on TrueNAS. Only stale presence or a retryable still/PDF failure
activates the bounded Container fallback; a later valid prebuilt registration
safely replaces the managed mapping and queues exact-ETag cleanup. Do not
predict an R2 ETag or weaken validation. Direct browser/staff uploads use a
30-second initial queue delay.

The decoder removes an older local immutable WebP/manifest only after its
replacement registers. For missing sources it requires the same stable Jobs
mount identity, two complete scans and a 24-hour grace. Scan/mount failure
cannot prune. The exact prebuilt-only SYNC then removes stale remote prebuilt
objects without touching originals or Cloudflare-managed derivatives.

## Monitoring and recovery

R2 create/delete notifications feed `ltds-file-events`; Operations indexes the
source and records exact-version image, PDF, and video work. The unified TrueNAS
renderer claims that durable backlog directly. Operations records a 15-minute
prebuilt boundary for raw server/rclone events and 30 seconds for direct
browser/staff enqueue, then resolves fallback ownership from the unified
renderer presence signal. A daily reconciliation repairs missed
file-index/thumbnail lifecycle events. See the
[thumbnail runbook](../media-thumbnail-pipeline.md).

Before source SYNC cutover, record a ZFS snapshot, task/filter export, R2 object
count/size and synthetic checksum evidence. If delete behavior is unexpected,
stop the task, return to COPY, restore from ZFS if necessary, and reconcile R2
before retrying. Never interpret an unavailable/changed source mount, failed
listing, partial traversal or rclone error as deletion authority.

The old `preview-gen.sh`, `.previews/<hash>/`, `ltds-preview/2.0.0`, FFmpeg
poster and `sourceEtag:"pending"` contract are retired compatibility fixtures.
Do not deploy or sync them. They are not accepted by the current prebuilt
registration endpoint.
