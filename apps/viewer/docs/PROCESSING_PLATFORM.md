# LTDS processing platform operations

The processing platform remains feature-flagged but is enabled by default for
this LTDS deployment. An explicit false keeps the always-started worker idle.
Published Viewer models remain available when NodeODM, ClusterODM, or the
durable processing worker is unavailable. Provider health is intentionally
excluded from the public Viewer liveness path.

## TrueNAS layout

Production Compose publishes `viewer-api` directly on the configured LAN bind address and port `8088`; it does not run Nginx. The worker shares the pinned application image but has no published port. Cloudflared and external Nginx are separately managed. Nginx forwards the exact Viewer host; optional proxy-secret/IP enforcement can be enabled later as a coordinated hardening step. The application itself streams authorized byte ranges because `X_ACCEL_REDIRECT_PREFIX` is empty.

Runtime settings and secrets live only in the host path
`/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env` (directory mode `700`,
file mode `600`) and are shared by API and worker through Compose `env_file`.
All managed application bytes live below the fixed host path
`/mnt/Plugins/App_Data/Model-Viewer/Storage`, mounted at `/app/storage` with
Compose `create_host_path: false`. The operator must create the sentinel and
directory skeleton shown in the README as UID/GID `568:568` before first boot;
Docker is not allowed to silently create a root-owned target. This one dataset
contains the database, browser imports, datasets, Terra imports, models, cache,
and trash on one filesystem for journaled atomic renames. The API and worker
run as `568:568`, with all capabilities dropped. Preserve and back up this
entire dataset across image updates or app/project renames.

Run `scripts/truenas-storage.sh diagnose` after first boot. It launches the
pinned Viewer image as UID/GID 568, verifies the exact non-symlink host path,
sentinel, ownership, every managed directory, and a bounded write marker. With
processing admission stopped, the explicit `repair-ownership CONFIRM_UID_568`
command stops the services, repairs only that sentinel-marked fixed path, and
restarts the services that were running.

WebODM media is mounted read-only from
`/mnt/Plugins/App_Data/WebODM/Media`. There is no permanent legacy-derivatives
mount or `DERIVATIVES_MOUNT` production dependency. If a future one-time legacy
derivative migration requires one, use a separately reviewed Compose override
that adds the exact source to both services read-only and sets
`DERIVATIVES_MOUNT` to its container target; remove the override afterward.
WebODM API discovery is disabled and requires no credentials. Release-one
WebODM imports are external references; source media is never moved or deleted.

### Copy-first migration from the former named volume

The guarded updater never migrates storage. If `ltds-viewer-storage` contains
existing Viewer data, pause Ops admission and stop both services before the
first deployment of this bind-mount release. Create only the fixed target and
sentinel, verify the old volume and empty target, then **copy** the bytes with
the currently configured Viewer image:

```bash
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
STORAGE=/mnt/Plugins/App_Data/Model-Viewer/Storage
sudo install -d -o 568 -g 568 -m 0700 "$STORAGE"
sudo install -o 568 -g 568 -m 0600 /dev/null "$STORAGE/.ltds-viewer-storage-root"
docker compose --env-file "$VIEWER_ENV_FILE" stop -t 120 viewer-worker viewer-api
docker volume inspect ltds-viewer-storage
test -z "$(find "$STORAGE" -mindepth 1 ! -name .ltds-viewer-storage-root -print -quit)"
VIEWER_IMAGE="$(docker compose --env-file "$VIEWER_ENV_FILE" config --images | sort -u)"
docker run --rm --read-only --user 0:0 --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges \
  -v ltds-viewer-storage:/source:ro -v "$STORAGE:/target" "$VIEWER_IMAGE" \
  sh -ceu 'test -f /target/.ltds-viewer-storage-root; test -z "$(find /target -mindepth 1 ! -name .ltds-viewer-storage-root -print -quit)"; cp -a /source/. /target/; chown -R 568:568 /target'
VIEWER_ENV_FILE="$VIEWER_ENV_FILE" scripts/truenas-storage.sh diagnose
```

Do not use `mv`, do not remove the old named volume, and do not let an update
script perform the copy. If any validation or copy step fails, leave services
stopped and inspect the fixed target; the read-only source volume remains the
rollback copy. After validation, start the new release and retain the old
volume until a separate reviewed retention decision. A fresh installation
should instead create the full skeleton in the README and has nothing to copy.

Set `PROCESSING_PLATFORM_ENABLED=true`, generate the one-time
`PROVIDER_CREDENTIALS_KEY`, and configure the exact origins and/or private LAN
boundary in `PROCESSING_PROVIDER_ORIGINS` and
`PROCESSING_PROVIDER_ALLOWED_CIDRS`. Start with `docker compose --env-file
/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env up -d`; both API and worker
must read the true flag from that file. Thereafter an
administrator creates nodes, stores or rotates tokens, probes, and enables them
in Ops without editing the environment or restarting containers. Provider
credentials are encrypted at rest and are never returned. Enable a provider
only after its capability probe confirms the required `pc-ept`, `3d-tiles`,
and `gltf` options. NodeODM 2.2.3 and ClusterODM 1.5.5 are tested baselines,
not hard version lockouts; unknown compatible versions produce a warning.

`scripts/update-truenas.sh . auto` derives the processing readiness mode from
`PROCESSING_PLATFORM_ENABLED`; explicit `processing` or `view-only` modes must
match it. Compose fixes the runtime image at
`ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest`; `viewer.env` cannot redirect
the deployment to another image. The helper refuses active
processing/dataset/storage work by default, preserves the prior image ID under
`ltds-viewer-rollback:previous`, waits for health, and runs the read-only
production readiness check. `VIEWER_UPDATE_ALLOW_ACTIVE=1` is an
emergency override: interrupted work remains lease/journal recoverable, but the
normal update path must drain first. Compose grants two minutes after SIGTERM;
do not force-kill a worker merely because a large operation has not exited yet.

`LOCAL_DERIVATIVES_ENABLED` remains false in the stock image, so local Entwine
point-cloud conversion stays disabled. Mesh generation is a separate, automatic
TrueNAS worker stage. The production image pins Obj2Tiles 1.6.2 and Compose
enables `MESH_DERIVATIVES_ENABLED` by default. The worker itself has fixed,
non-overridable ceilings of 16 CPUs and 24 GiB RAM so the 24-core server retains capacity for NodeODM, the Viewer API, and storage work.
No mesh conversion runs on the Hermes host or through an SMB-mounted working
copy.

A newly processed NodeODM result, mounted WebODM task import, or Terra catalog
import does not become `ready_for_review` while a discovered textured mesh still
needs streaming assets. When both textured OBJ and independent companion GLB
are available, the required derivative lane generates ETC1S KTX2 3D Tiles even
if the import also contained legacy JPEG tiles. If generation is impossible but
native tiles and an auditable GLB exist, the native tree must pass its exact
audit. The worker registers the exact verified manifest and only then commits
readiness. Thus "ready" means the model can be opened immediately rather than
merely meaning ODM returned an archive.

Generation writes lease-token-specific `.incomplete` and `.complete` trees
under managed TrueNAS storage. Audit and snapshot verification finish before a
same-filesystem atomic rename and SQLite registration. The job has a persisted
24-hour deadline, a three-claim maximum, one database-backed LOD singleton,
and continuous disk/inode pressure checks. A crash leaves deterministic output
that the next lease re-verifies; old token directories are removed only by the
bounded terminal-job reconciler after its grace period.

Existing controlled Obj2Tiles v3 JPEG output remains accepted, but successful
ready and published versions are immutable. There is no automatic legacy LOD
backfill, in-place asset switch, or manual in-place retry. Upgrading one requires
a new processing attempt/model version so the active version remains the
rollback path. Operators may explicitly set `MESH_DERIVATIVES_ENABLED=false`,
but eligible required OBJ+GLB work then fails closed instead of bypassing mesh
readiness or exposing legacy tiles.

## Dataset lifecycle

Uploads are chunked, checksum-bound, subject-bound, resumable, and finalized by the durable worker. Import preview and adoption also run as durable operations. A preview fingerprint binds every sorted relative path and byte size to a streaming SHA-256 of the complete file, so same-size rewrites cannot hide behind coarse or preserved filesystem timestamps. The preview request returns `202` immediately; fixed-memory hashing happens in the dataset-operation worker, never in the API request, and is proportional to source bytes without loading complete files into RAM. Poll the origin-relative `Location` every `Retry-After: 2` seconds. A successful preview operation embeds the prior preview response unchanged in `operation.result`; operation success, token creation, and preview persistence commit atomically, and the subject/session-bound token begins its ten-minute lifetime at that commit. Operation polling is `Cache-Control: no-store`; preview tokens and operation results must never be logged. Queued or leased preview work can be cancelled through `POST /api/v1/operations/:id/cancel`; cancellation is observed within two seconds, aborts the active file stream, and cannot leave a usable preview token behind. An expired lease or restart rehashes from the beginning. The durable adoption worker rechecks the exact fingerprint, retains the verified per-file hashes, and verifies every copied byte before finalization. Operation state survives an API restart and leased work is reclaimed after lease expiry. The worker uses separate lanes for dataset operations, ODM processing, derivative work, and callback delivery, so a large preview or copy cannot starve notifications.

Managed and adopted datasets are immutable after finalization. Every file is re-hashed before each ODM submission. External references retain their original location and are also re-hashed. Raw images, GCP files, logs, provider archives, and processing inputs are created unpublished and cannot be selected for a public share.

Native ZIP ingestion locates the validated end record with a bounded backward
scan, then anchors the directory parser to that exact record and its comment.
This avoids a ZIP64 locator error when the search spans filesystem read chunks.
Entry limits, path and local-header validation, streamed size/CRC checks, and
the complete response digest and file inventory remain required before publication.

Each dataset manifest file has an explicit processing role. Omitted/`auto`
roles fail closed: supported photographs become `image`, CSV becomes private
`gcp_source`, and other files become private `administrative`. Only an explicit
`provider_input` on the bounded auxiliary allowlist is uploaded to ODM. The
immutable `gcp_list.txt` generated from a processing attempt's saved GCP
correspondences replaces any legacy input with that name; source CSV/GCP files
remain administrative bytes and are never sent upstream.

Draft creation is recoverable across an admin-session renewal. Persist the
`submissionId` UUID, exact normalized body, and `Idempotency-Key` before `POST
/api/v1/tasks`. The first commit returns `201`; the same subject and exact
submission replay returns the same task with `200`, while a changed request
with that submission ID returns `409`. Historical attempts are immutable and
available newest-first through bounded `GET
/api/v1/tasks/:id/attempts?limit=&cursor=` pagination, including provider,
options, capability fingerprint, result version IDs, submission phase, and all
lifecycle timestamps.

An administrator with `viewer.processing.publish` may inspect an unpublished `ready_for_review` result through `POST /api/v1/attempts/:id/review-sessions` using an exact `{}` body and an `Idempotency-Key`. The one-use grant is bound to the authenticated subject, attempt, model, and immutable model version, and it exposes only reviewable derived kinds (`glb`, `tiles`, `ept`, `ortho`, `dsm`, `dtm`) whose integrity metadata is complete. It neither publishes the version nor creates a public share. Redemption and every model, nested asset, and range request revalidate that the exact attempt is still `ready_for_review`; publishing, cancellation, version replacement, expiry, or explicit subject-scoped `DELETE /api/v1/attempts/:id/review-sessions` fails closed immediately. A renewed grant for the same subject and target renews the existing browser token/session so camera, layer, and measurement state remain in place.

Adopted catalog moves are journaled before filesystem mutation. If a same-filesystem Terra rename succeeds but later catalog registration fails, maintenance restores the deterministic destination to its original import path (or removes a duplicate copy) before clearing the intent. This reconciliation survives restart and prevents unaccounted dataset bytes even when the failed operation is never manually retried.

## Existing-model catalog migration

Durable mounted-tree scans discover WebODM outputs without API credentials and
Terra output drops. Candidate rows retain scan generation, last-seen time, full
source fingerprint, mapping identity, and `source_changed` versus `not_seen`
staleness. Repeat scans are duplicate-safe. An unchanged mapped candidate is a
no-op; a changed source must be explicitly reviewed and mapped again. A remap
keeps its LTDS Project, Task, and model IDs but creates a new immutable Dataset,
Attempt, and model Version. It cannot be moved to a different project. A
missing candidate is non-actionable until it is seen again.

WebODM is always `external_reference`. Terra may be reference-only or adopted;
same-filesystem adoption is an atomic rename and cross-filesystem adoption is
copy-verify-promote followed by a durable source-cleanup journal. The approved
scan fingerprint is rechecked at worker start and during adoption. Operation-
owned project/dataset/task/attempt/model rows are rolled back on a failed map,
while the same deterministic IDs are reused on retry after restart. Pre-existing
projects and prior model versions are never removed. EPT and 3D Tiles imports
register an immutable hash allowlist for every nested child.

All catalog scan/map and upload/import mutations use subject-scoped client
operation keys. Acceptance atomically links the receipt to the durable
operation. If every `202` response is lost, retrying the same method/path/body
and key—after session renewal included—returns the same operation and canonical
`Location`; `GET /api/v1/operation-receipts/:key` provides recovery. Completed
response bodies are redacted after seven days, but the compact subject/key/body
fingerprint and operation identity remain as a duplicate-prevention tombstone
for the operation lifecycle.

## Presets, capabilities, and health

Admins manage custom processing presets through the API/UI. A preset binds to
the probed provider type and static capability fingerprint and is revalidated
at task submission. Structured option domains receive local type/range checks;
NodeODM descriptive string domains are retained as help text and the provider
remains the final compatibility authority. Required browser outputs cannot be
disabled, including by the orthophoto-focused preset. Scheduled provider health
refresh records fresh runtime status and sanitized errors with endpoint and
credential-revision fencing, but does not disable a provider after one transient
failure and never changes public readiness or published viewing.

The built-in **Large 3D**, **High-Res 2D WITH 3D**, and **High-Res 3D** presets
contain only the explicitly supplied processing overrides. Numeric values from
WebODM exports are stored as numbers and checkbox flags as booleans. All omitted
options use the selected processing node's defaults; selecting these presets
does not inherit Standard, High Quality, or the previously selected preset.
Task-specific edits still override the selected preset. The three required
Viewer outputs (`pc-ept`, `gltf`, and `3d-tiles`) remain enabled at submission.
Existing saved presets and attempts are unchanged when the new built-ins seed.

Every override must be supported by the selected node's current `/options`
capabilities. **High-Res 3D** omits the unsupported
`depthmap-resolution` override and leaves `pc-quality` unset. ODM uses its own
defaults; this is not an equivalent fixed 1280-pixel setting. [ODM 3.5.6 marks the old flag deprecated](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/config.py#L801-L808)
and [computes depthmap resolution from image dimensions and point-cloud quality](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/utils.py#L18-L43).
Startup updates an existing High-Res 3D built-in only if its complete options
match the known old seed, including numeric `depthmap-resolution=1280`. Its
enabled state is retained. Custom/modified presets and historical attempts
remain unchanged. Explicit unsupported task options still fail validation;
other flags are never automatically discarded.
**High-Res 2D WITH 3D** retains [`rerun-from=dataset`](https://docs.opendronemap.org/arguments/),
which restarts ODM processing from its dataset stage. This does not request
`rerun-all`, delete the Viewer's retained source photos, or reuse a previous
Viewer task UUID: each new attempt still receives its own provider task UUID.

Large immutable assets store 4 MiB chunk hashes at ingest/import. A Range
response verifies only intersecting chunks with bounded memory, while a full
response verifies complete contiguous chunk coverage. Legacy assets without
chunk rows use exact whole-file SHA-256 as a safe fallback. Nested EPT/3D Tiles
children remain constrained by their exact manifest allowlist.

Friendly project and dataset names, descriptions, tags, and arbitrary bounded
catalog metadata remain editable. Dataset reassociation changes only the stable
project ID association; it never moves files or changes a manifest. It is
rejected while the dataset has an active operation, lifecycle mutation, or
non-archived processing task, and duplicate names in the target project fail
closed.

ODM submission persists initialization, photo-upload, auxiliary-upload, and
commit phases. A restart resumes photo batches from the provider's documented
image count. Auxiliary inputs such as GCP text cannot be inferred from that
count, so an ambiguous auxiliary response removes the assigned upstream task
and deterministically restarts it instead of risking a duplicate or missing
input. Commit ambiguity is reconciled from provider state. Before any provider
side effect, admission verifies the immutable source hashes and combines the
peak Dataset, Cache, and Model requirements for mounts that share one storage
pool.

Deleting a dataset moves Viewer-owned bytes to recoverable trash for 14 days. Trash, restore, manual purge, and retention purge use a durable two-phase journal: the database records intent before any rename/delete, the worker applies an idempotent filesystem effect, and a single database transaction finalizes metadata afterward. Startup and hourly maintenance reconcile interrupted intents, including a move that completed before its journal update. A source/destination conflict fails closed and makes processing readiness fail until an operator removes the conflicting path and retries the failed mutation through `POST /api/v1/storage/mutations/:id/retry`; failed mutations can be inspected with the bounded `GET /api/v1/storage/mutations?status=failed` route.

External-reference deletion changes Viewer metadata only and never creates a byte-mutation journal, moves, or deletes external bytes. Archive/delete refuse datasets with tasks or active finalize/import/lifecycle operations. Permanent purge requires the dedicated `viewer.storage.purge` permission and typed confirmation. Empty draft datasets use a metadata-only journal entry and remain restorable during the retention window.

Projects and tasks use a 30-day container lifecycle. The normal staff surface
offers Rename and Delete; archive remains an internal compatibility state, not
the required workflow. Deleting a project or task groups its exclusively owned
datasets and outputs beneath one trash record while preserving datasets shared
by another live task. Each member records its original status. Restore moves
managed bytes back and atomically restores the project, tasks, datasets, and
outputs to those exact usable states. Permanent or retention purge processes
members before the container root, removes owned bytes and asset rows, scrubs
user-facing project/task metadata, and leaves only the minimum internal
tombstone needed by foreign keys and audit history. Purged projects and tasks
are excluded from both direct lookups and catalogs.

Managed model outputs have the same 14-day recoverable lifecycle. The bounded
output catalog and project/task storage routes report actual ingested output
bytes separately from immutable dataset bytes. Archiving first unpublishes the
selected version and is rejected while a live share/session or processing job
still depends on it. Trash, restore, manual purge, and retention purge reuse
the two-phase storage journal; permanent purge removes asset rows and bytes but
retains the zero-byte output record as an audit tombstone.

Archiving one historical output never archives its parent Task. Adopted and
external-reference outputs use the same 14-day metadata lifecycle without
moving or deleting provider-owned bytes. Catalog imports whose Dataset and
Output describe the same external/adopted tree count those physical bytes once
in project/task totals. Native ingest keeps an output `staged` until all
required outputs and derivatives pass; readiness, callback outbox, and audit
commit together. Publication similarly commits selected assets, active
version, attempt/task/output state, and its audit row in one transaction.

Catalog and accounting routes used by Ops are:

- `PATCH /api/v1/projects/:id` and `PATCH /api/v1/datasets/:id`
- `GET /api/v1/projects/:id/storage` and `GET /api/v1/tasks/:id/storage`
- `GET /api/v1/tasks/:id/attempts?limit=&cursor=`
- `GET /api/v1/processing/outputs`
- `POST /api/v1/processing/outputs/:id/archive` and
  `DELETE /api/v1/processing/outputs/:id`
- `POST /api/v1/storage/trash/:id/restore` and
  `DELETE /api/v1/storage/trash/:id` with typed confirmation for purge

All list routes use capped keyset pagination, and every mutation requires an
admin bearer permission plus `Idempotency-Key`.

The staff workspace applies those same permission and state checks before it
renders project, task, dataset, output, trash, or mutation-retry controls.
Background Work cursor-paginates and searches the complete import and
derivative history. Diagnostics paginates all recoverable trash and all failed
storage mutations rather than showing only the first page. Maintenance emits a
bounded step name and stable error code for failures; retention audit actions
use the actual project, task, dataset, or output entity type.

Whole-project public links use a separate `public_project_shares` record and
`/project/:token` flow; they do not reuse the single-model `public_shares`,
authenticated client grants, or staff review sessions. Each catalog, selected
task, and asset request revalidates the active project and the task's current
published model/output version. A publication replacement invalidates the old
asset capability immediately. Only published public derivatives (GLB, tiles,
EPT, ortho, DSM, and DTM) can cross this boundary; reports, raw inputs, logs,
datasets, provider paths, and unpublished assets cannot. Project-link expiry,
revocation, and project archive are also checked on every asset request.

## Backups and recovery

Back up `Config/viewer.env` through a secret-capable backup path together with
the entire `/mnt/Plugins/App_Data/Model-Viewer/Storage` dataset, or take a
SQLite online backup
of `/app/storage/data/viewer.sqlite` after `PRAGMA wal_checkpoint(PASSIVE)` and
then capture the matching managed bytes. Never put the populated environment
file in source control or ordinary logs. Do not copy only the main database
while the API or worker is writing. Dataset/model files and the database must
be captured as one consistent backup.

The supported fixed-bind backup path stops API and worker before archiving so
the SQLite WAL and managed bytes form one snapshot, writes a SHA-256 sidecar,
then restores only the services that were previously running:

```bash
mkdir -p /mnt/Plugins/App_Data/Model-Viewer/Backups
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env \
  scripts/truenas-storage.sh backup \
  /mnt/Plugins/App_Data/Model-Viewer/Backups/viewer-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
```

Test restoration on a non-production copy first. Production restore verifies
the sidecar and archive paths, requires the exact non-symlink host path and
sentinel, stops services, replaces only that bind's contents while preserving
the sentinel, restores ownership to 568, and restarts prior services:

```bash
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env \
  scripts/truenas-storage.sh restore \
  /mnt/Plugins/App_Data/Model-Viewer/Backups/viewer-TIMESTAMP.tar.gz \
  CONFIRM_RESTORE
```

If extraction fails, services remain stopped for inspection. Restore is the
only helper operation that deletes existing managed bytes, and it requires the
explicit `CONFIRM_RESTORE` argument. Never restore an archive from an untrusted
source.

Before maintenance:

1. Stop new processing admission in Ops and keep it paused for the entire update; wait for active operations or attempts to settle. The updater pulls the fixed official `latest` image first, then rechecks durable work immediately before replacement, but the paused admission boundary is what prevents new work from entering that final interval.
2. Stop the worker, then the API.
3. Run `PRAGMA wal_checkpoint(TRUNCATE)` through a SQLite client, then back up
   the complete `/mnt/Plugins/App_Data/Model-Viewer/Storage` dataset before
   either service restarts.
4. Restart the API and worker. Confirm `/api/v1/health`, `/api/v1/ready`, and the authenticated `/api/v1/processing/ready` response. Processing readiness reports pending and failed lifecycle journal rows; do not resume admission while a failed row remains.

Never restore only `models` without the matching database snapshot: published asset rows contain immutable SHA-256 manifests for every GLB, EPT child, and 3D Tiles child. Serving fails closed when files are missing, added, or modified.

After activation, run `node scripts/production-readiness.mjs --verify-mount-options --require-processing`. This opt-in check is read-only: it verifies all processing mounts, the datasets/trash same-filesystem invariant, configured disk reserve, fresh worker heartbeat, enabled provider credential decryption, capability fingerprints and required native outputs, and absence of stale operation leases. It does not probe, enable, or mutate a provider.

## Logs and callbacks

Processing logs are sanitized, capped per attempt, and retained for a bounded number of days. Client-facing errors never contain credentials, query tokens, absolute server paths, or multiline provider stderr. Terminal callbacks are delivered from a durable outbox with an exact-body HMAC, stable event ID, redirect rejection, bounded responses, and exponential retry. The callback URL must be exactly the configured Ops origin plus `/api/viewer/events` with no credentials, query, or fragment.

See [ODM_PROVIDER_COMPATIBILITY.md](ODM_PROVIDER_COMPATIBILITY.md) for upstream route evidence and option behavior.
