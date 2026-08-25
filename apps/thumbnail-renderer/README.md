# LTDS TrueNAS thumbnail app

This package generates private LTDS thumbnails on TrueNAS. It is a
three-container Custom App:

- `decoder` has the Jobs upload dataset mounted read-only and has **no network**.
  It scans supported still images and PDFs, renders exactly one metadata-free
  `320x240` WebP at or below 128 KiB, and maintains immutable versions in the
  private persistent `prebuilt` derivative cache.
- `broker` cannot see the Jobs dataset and contains no media decoders. It uses
  a separate bucket-scoped R2 Object Read credential for **HEAD only**, waits until the
  original uploaded by the existing TrueNAS Cloud Sync task is stable, at least
  as new as the render, and carries an R2 full-object SHA-256 equal to the local
  source hash. After the dedicated prebuilt sync uploads the
  WebP, the broker writes its exact source/derivative identities into the local
  manifest, waits for that manifest to sync, and registers only the two object
  keys/ETags with the authenticated Operations ingest API.
- `queue-renderer` is the primary path for direct browser and other R2-only
  uploads. Four bounded RAM-backed slots claim supported images, PDFs, and
  videos from Operations. Images/PDFs download only the exact leased version
  into tmpfs; videos use bounded HTTP range reads. Cloudflare remains a delayed
  still/PDF fallback.

Operations independently reads and validates that exact current R2 source,
manifest, and WebP, then maps the prebuilt object into durable thumbnail state.
The broker never PUTs an R2 object or uploads source bytes. The decoder never
receives an R2 or Operations credential. Neither service publishes a port.

Office documents, archives, and other unsupported formats are skipped
by this **pre-generation app** without transfer. PDFs render page one only.
The local pre-generator does not decode videos; the repository-owned
`queue-renderer` handles video plus R2-only still/PDF jobs through
`/api/internal/thumbnail-renderer/v1`. The version-controlled queue runtime is
[`truenas/thumbnail-generation/thumbnail-queue-worker.sh`](truenas/thumbnail-generation/thumbnail-queue-worker.sh),
but production must deploy only the immutable, digest-qualified `queue-worker`
image published and canary-tested by this repository. Never copy or layer the
script onto an unrelated image.

## TrueNAS SCALE installation (UI only)

Do not use the TrueNAS system shell. Install through **Apps > Discover Apps >
Custom App > Install via YAML** using `compose.truenas.yaml` (labels vary by
SCALE version).

The YAML expects three prebuilt immutable images. The repository's **Publish
TrueNAS thumbnail renderer images** GitHub workflow builds the `decoder`,
`broker`, and `queue-worker` targets for `linux/amd64` on changes to this package or an authorized
manual dispatch from `main`. It publishes commit tags without overwriting them
and records each digest-qualified reference in the run summary and receipt
artifact. Copy those `ghcr.io/ledgetoptechnologies/ltds-thumbnail-...@sha256:...`
references into the TrueNAS UI; never use `latest`. Configure a private registry
credential in the TrueNAS Apps UI if the packages are not anonymously readable.

Enter these values through the Custom App environment/substitution UI. If the
installed SCALE version does not expose Compose substitutions, replace the
`${NAME:?...}` placeholders in the YAML editor before saving. Never commit the
filled YAML or `.env` file.

| Value | Purpose |
| --- | --- |
| `LTDSTHUMB_DECODER_IMAGE` | Pinned image built from Docker target `decoder` |
| `LTDSTHUMB_BROKER_IMAGE` | Pinned image built from Docker target `broker` |
| `LTDSTHUMB_QUEUE_WORKER_IMAGE` | Pinned image built from Docker target `queue-worker` |
| `LTDSTHUMB_JOBS_HOST_PATH` | Existing local Jobs upload dataset, mounted read-only |
| `LTDSTHUMB_ARTIFACTS_HOST_PATH` | Persistent private prebuilt cache and receipts |
| `LTDSTHUMB_WORK_HOST_PATH` | Quota-limited decoder scratch dataset |
| `LTDSTHUMB_CACHE_HOST_PATH` | Decoder tool cache dataset |
| `LTDSTHUMB_STATE_HOST_PATH` | Health and non-sensitive local receipts |
| `LTDSTHUMB_INGEST_URL` | Exact Operations `/api/internal/thumbnail-ingest/v1` HTTPS URL |
| `THUMBNAIL_INGEST_SECRET` | Dedicated Operations ingest application secret; broker only |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token protecting the internal endpoint |
| `LTDSTHUMB_R2_*` | Separate bucket-scoped Object Read credential/account/bucket; broker signs HEAD only |
| `PUID` / `PGID` | Non-root numeric owner for the private app datasets |

The original still follows the existing TrueNAS Cloud Sync path. Do not add
`.previews` sidecars. Add a separate TrueNAS UI rclone/Cloud Sync task mapping
only `<artifacts dataset>/prebuilt/` to exactly
`_ltds/derivatives/thumbnails/v1/prebuilt/` in `client-data`. Use SYNC semantics
for this exact subtree. Never target `_ltds/derivatives/`,
`_ltds/derivatives/thumbnails/v1/`, or the sibling `managed/` subtree; those
broader targets could delete Cloudflare-owned fallback objects. The local
prebuilt cache persists after registration and is not a scratch queue.

The broker registers only after the original, immutable WebP, and final JSON
manifest are visible in R2 with stable exact ETags. The source upload task must
send a full-object SHA-256 checksum that both the S3 HEAD response and Workers R2
binding expose; configure and verify that capability before expecting prebuilt
registration. Cloudflare's current S3 contract does not provide full-object
SHA-256 for rclone multipart uploads, so those prebuilt attempts deliberately
fail closed and Operations uses its managed fallback. The broker does not send
the currently undocumented `x-amz-checksum-mode` HeadObject header or treat a
multipart ETag/composite checksum as the local full-file digest. Missing,
composite, or mismatched SHA-256 proof always fails closed. TrueNAS and Cloudflare
clocks must be NTP-synced; the broker refuses a remote source whose R2
`Last-Modified` predates the local render, preventing a same-size older object
from being paired with new pixels.

The first prebuilt sync publishes only the WebP. Once its exact R2 ETag is
known, the broker creates the final manifest locally; the next prebuilt sync
publishes that manifest and registration follows. No provisional or
`sourceEtag:"pending"` manifest is uploaded. Schedule this dedicated task at
the shortest non-overlapping interval supported by the TrueNAS UI (target five
minutes); it is separate from the hourly source mirror.

With the required five-minute non-overlapping derivative sync, this two-pass
ETag handshake fits inside Operations' 15-minute raw server/rclone grace under
healthy conditions. If it misses that window, the private Container may render
first; a later valid prebuilt registration deterministically replaces the
managed mapping and queues exact-ETag cleanup. Direct browser/staff enqueue
uses a 30-second initial queue delay. Fresh unified-worker polls and signed
active-job heartbeats keep unfailed work owned by TrueNAS after that delay;
stale presence or a retryable still/PDF renderer failure enables the bounded
Cloudflare fallback. Never predict an R2 ETag to avoid the race.

Keep the original source task one-way **Push** into the existing `client-data`
bucket; never configure it as bidirectional. Begin that task in COPY mode. Only
after the ownership/filter gate is proven may an explicitly server-owned visible
Jobs prefix move to SYNC so its hourly mirror intentionally propagates source
deletes, moves, and copies. Exclude every browser/team-upload-owned prefix from
that delete-authoritative source scope. Using the same prefix for local mirror
ownership and browser-only R2 objects is unsafe: rclone can delete an R2 object
merely because it is absent locally. Define disjoint path ownership before
enabling source delete propagation. **This is a production rollout safety gate:**
do not enable a delete-authoritative source mirror until a disjoint, visible
browser/team upload prefix has been selected, excluded by path, and tested. R2
metadata or object tags cannot protect an object from an rclone delete.

The source task always excludes `_ltds/**` and never targets a derivative. The
only task allowed to synchronize derivatives is the separate one-way Push/SYNC
mapping from the persistent local `prebuilt/` cache to the exact remote
`_ltds/derivatives/thumbnails/v1/prebuilt/` subtree described above. It may
delete a remote prebuilt object only when that exact local cached object is
retired; it has no authority over originals or `managed/`. Worker R2 source
events independently retire the current exact-version mapping and derivative.
Deleting a local queued thumbnail has no immediate R2 deletion authority. The
local parent path may help define a TrueNAS UI sync root, but is not itself a
security boundary.

The runtime needs:

- decoder: no network (`network_mode: none`);
- broker: DNS and outbound TCP 443 to the R2 S3 hostname and the configured
  Operations hostname;
- queue-renderer: DNS and outbound TCP 443 to the authenticated Operations
  renderer endpoint and its attempt-scoped R2 video-read URL;
- no inbound route, host network, public webhook, Cloudflare Tunnel, or public
  R2 URL.

## Dataset and ACL preflight

Create `artifacts`, `work`, `cache`, and `state` child datasets in **Storage >
Datasets**. The Jobs dataset already exists and is not modified by this app.

- Set the four private datasets' owner user/group to the non-root `PUID`/`PGID`
  used by the app. Grant owner read/write/execute/delete-child and remove write
  from `other/everyone`.
- Mount Jobs read-only. Do not change its ACL recursively and do not mount the
  pool root, client backups, or another unrelated dataset.
- Start `work` at a 4 GiB quota for concurrency one: it may contain renderer
  scratch for one 512 MiB still or 256 MiB PDF. Start `artifacts` at 1 GiB,
  `cache` at 1 GiB, and `state` at 64 MiB.
- Do not solve ACL failures with root UID, privileged mode, broad `0777`, or
  additional Linux capabilities. All services drop all capabilities, use a
  read-only container root, set `no-new-privileges`, and have CPU/memory/PID
  limits.

Secrets belong only in TrueNAS secret/environment fields. Do not include them
in screenshots, app notes, support tickets, logs, source control, or image
layers. Provision the broker its own bucket-scoped Object Read credential; do
not reuse rclone, Worker, Wrangler, or account-wide credentials. Rclone alone
owns writes to the prebuilt subtree.

## Limits and processing behavior

- Local pre-generation remains fixed at one decoder and one broker item. The
  R2 queue renderer defaults to four isolated slots and is configurable from
  one through eight.
- Still input: at most 512 MiB and 110,000,000 decoded pixels.
- PDF input: at most 256 MiB; Poppler rasterizes page one only.
- The local `decoder` includes libvips and Poppler only; it does not install
  FFmpeg or open video media. The isolated `queue-renderer` image also includes
  FFmpeg/FFprobe for range-read video attempts.
- Output: static WebP, exactly 320x240, at most 128 KiB, with no EXIF, XMP, ICC,
  or animation chunks. The broker performs an independent structural check.
- Source paths are argument-array inputs, never shell strings. Symlinks, hidden
  paths, `Dump`, `_ltds`, `.previews`, and traversal segments are skipped.
- A source is hashed and stat-checked before/after rendering. Replacement during
  rendering is retried. No original is copied into the derivative cache.
- Prebuilt R2 keys are
  `_ltds/derivatives/thumbnails/v1/prebuilt/${sourceKey}/${sourceSha256}.webp`
  with a sibling `.json` manifest. The separate `managed/` namespace is never
  mounted, scanned, synced, registered, or deleted by NAS.
- Retry state is local and bounded. `409`, `429`, and `5xx` registration
  responses retry with backoff. Changing the local source identity makes it
  eligible again; a successful registration does not delete the current local
  immutable derivative.
- Native render failures are persisted by source identity. Retryable failures
  receive at most three exponential-backoff attempts; permanent or exhausted
  failures are quarantined without blocking later files. Replacing the source
  clears its quarantine. These records contain only safe codes and local inode/
  time/size identity, never paths, source bytes, thumbnails, or credentials.
- Superseded local WebP/manifest pairs are removed only after the replacement
  version registers successfully. A missing source is pruned only after the
  Jobs mount identity remains stable, two complete scans agree, and the 24-hour
  grace expires. Scan or mount failures never prune. A changed mount identity
  stops the decoder for operator review instead of accepting an empty/wrong
  bind path and deleting cache entries. The prebuilt-only rclone
  SYNC then removes those exact stale remote objects; it still cannot touch
  originals or the Cloudflare-managed derivative subtree.

## UI validation checklist

Use synthetic non-client media only:

1. Confirm both containers are Running/Healthy, no ports are published, Jobs is
   read-only, and only the broker joins the outbound network.
2. Confirm logs contain only fixed events, counts, outcomes, and safe codes—no
   source paths, keys, ETags, URLs, thumbnails, or secrets.
3. Place one synthetic still into the normal server upload path. Confirm the
   existing Cloud Sync uploads the original, then Operations changes from icon/
   pending to a thumbnail. Opening the original must still require an authorized
   user click.
4. Repeat with a synthetic PDF and confirm a first-page thumbnail.
5. Add a video and unsupported document. Confirm the local pre-generator
   decodes or posts neither. Confirm the video becomes ready through the
   authenticated `queue-renderer` while the unsupported document remains a
   type icon.
6. Replace a synthetic still at the same path. Confirm the exact R2 ETag changes
   and only the new version becomes ready. Delete it and confirm Operations
   retires the derivative; no original fallback appears.
7. Stop the broker in the UI, add a synthetic still, and restart it. Confirm the
   persistent prebuilt cache resumes registration without re-rendering or
   duplicate derivatives.

A healthy container proves only its local loop. Production acceptance also
requires Operations ingest authorization/version/race/cleanup tests and the
existing Queue/DLQ checks.

## Development validation

`npm run check` and `npm test` require no npm dependencies. Build both Dockerfile
targets in CI. `bin/synthetic-smoke.mjs` generates its own blank image and PDF
for a decoder image smoke test; it never reads a host or client file. The broker
tests use synthetic fetch responses and never call R2 or Operations.
