# New task workflow — implementation plan

Status: implementation authorized on 22 September 2026 after the read-only audit. The focused photo-to-task phase is in progress locally. No real processing jobs launched, upstream watcher scheduled, or Operations code changed for this request. Do not treat this plan as a completed-feature checklist.

## Current focused implementation

- Project toolbar now places New task and Share first, with Rename, Import existing results and Delete in More. Empty projects can open New task.
- New task controller is being integrated with fresh managed datasets, PC photos/recursive folder uploads, copy-preserving server raw selection, queued preparation, explicit submission and health-aware nodes. Task name defaults to project name and local date.
- Browser/controller tests and server copy lifecycle tests are in progress. No release has been made for this phase.
- Photo-location preview is implemented with bounded strict EXIF parsing on PC and server paths, location markers and recorded true heading on hover. It intentionally has no external basemap or inferred flight paths. Browser lifecycle acceptance is in progress. GCP changes, image resizing, a new typed preset editor/import-export and reconstruction-boundary editing are not part of the initial form replacement and remain tracked below. Existing optional preset selection remains usable.
- Existing finished-model importer is preserved. Raw selections use the same configured import mount, including a raw/ subfolder when present, without moving original images.

## Intended experience

Project toolbar: **New task**, **Share**, **More (⋯)**. More contains Rename, Import existing results, and Delete with confirmation. Retain all permission and active-job deletion guards. New task must work on an empty project; Import remains a separate existing-results workflow.

New task form, in order:

1. **Task name**: editable, default `<project name> - <local date>`. Names are display labels, never storage paths. Use unique internal dataset/task identifiers; duplicate names cannot overwrite data.
2. **Photos**: Select from PC or Select from server storage. PC offers individual files or a parent folder, including nested folders. Server storage offers a root-confined folder browser and individual-image selection, not arbitrary container filesystem access. Show discovered count, bytes, skipped formats, duplicates, and missing-location count before transfer/submission.
3. **Photo map**: bounded EXIF extraction, scalable markers, fit-to-photos, and optional heading only when actual metadata exists. Missing GPS must not silently drop a valid photo or invent a location. No connected flight-path assumption across separate flights. Add/remove selected images and inspect selection without uploading an entire image just to plot a marker.
4. **Processing node**: select the sole eligible healthy node automatically; show Ready, Busy/queued, Offline, Disabled or Unknown with freshness. A busy but queue-capable node is not offline. Disabled/offline/unknown must not silently be submitted. Recheck on the server at submission. Investigate the reported missing cluster instead of assuming the form alone explains it.
5. **Preset / options**: choose, edit, save as, import and export. Keep a compact summary and put advanced options behind Edit options. Preserve exact types, false booleans and zero values. Node/version compatibility warnings require acknowledgement or correction, never silently change the tuned preset.
6. **Resize photos**: No by default. Yes reveals a 2,048-pixel longest-edge default and validated dimension. Preserve originals, aspect ratio and metadata needed for processing; no upscaling. Generate derived processing copies as server work. Verify the actual provider/WebODM resize behavior before choosing an adapter field; image resizing is not automatically equivalent to a feature-extraction resolution setting.
7. **Optional processing boundary**: draw/edit/reset a polygon on the map; pass validated GeoJSON through the provider-supported boundary option. This is an output/reconstruction boundary, not an instruction to discard all photographs outside it. Preserve surrounding overlap. No claim of reduced reconstruction workload without verifying provider behavior.
8. **Review → Start processing**: show counts, node, preset overrides, resize and boundary. Finalize the verified source manifest internally and submit once with an idempotency key. Prevent duplicate jobs on double-click, reconnect or retry. Expose understandable upload, preparation, queued, processing and output-ingestion progress.

GCP changes, client processing permissions and Operations edits are out of scope. Existing clients remain limited to their shared data and authorized measurements; this is an authorized staff/admin workflow.

### Import-folder layout (user clarification)

Keep the existing finished-model import behavior. Reuse the configured import mount, with a dedicated `raw/` subfolder for incoming flight photographs. A `processed/` sibling is optional organization for finished models; existing model folders and ZIPs at their current locations remain supported, with no mandatory migration.

Illustrative paths relative to the existing import mount:

```text
raw/
  Hickory-Grove-2026-09-22/
    flight-1/
    flight-2/
processed/                 # optional; existing imports still work
```

New task → Select from server storage should default to `raw/`, select one survey folder, and recursively discover its photos. Import existing results continues its current model/artifact route, while hiding or clearly identifying raw-photo staging directories so they are not mistaken for completed models. Do not automatically scan every survey under `raw/` as one task.

Keep staging outside the application-managed dataset directories. On confirmed ingestion create a uniquely identified managed dataset and copy/verify the chosen originals into it; do not delete or relocate source photos automatically. Explain the extra disk space and leave staging cleanup as a separate explicit action. PC-selected photos enter managed upload staging directly and need not be duplicated into `raw/`. This is a proposed layout, not an already-created server directory or mount change.

## Original read-only audit evidence (before this implementation)

- `workspace-projects.js:263`: New task is disabled unless a finalized dataset and enabled provider already exist; current toolbar exposes Import/Rename/Delete directly.
- `workspace-projects.js:405`: processing modal starts with Finalized dataset and Enabled provider, ends with task name and sends empty option overrides. This is a submission form, not a photo-first creation workflow.
- `workspace-projects.js:598`: existing browser upload UI limits selection to 128 files, 64 MiB per file and 256 MiB total. It hashes a full file buffer, then uploads chunks. Raising just this client check is not a scalable upload implementation; align server limits, memory, resumability and admission.
- Existing provider, preset, source-browser, dataset and submission APIs should be reused where their semantics match. Completed-results import is not interchangeable with creating a raw-image dataset.
- The existing `server-task-imports` path expects finished supported WebODM outputs. Generic dataset-import preview/adopt can inventory recursive raw folders, but adopted ingestion calls `storage.removeAdoptedSource` after finalization (`server/datasetOperationWorker.js`). Do not wire this into the proposed copy-preserving source selector without changing its explicit lifecycle semantics. External-reference mode retains originals but depends on a mutable mounted source with pre-processing hash checks; it is not the default immutable managed copy described here.
- Backend upload admission supports larger manifests than the current UI (20,000-file default reported in the audit). Verify every per-file/byte/quota setting together instead of replacing limits with an unbounded browser upload.

## Data and safety requirements

- Create a fresh managed draft dataset when source selection is accepted, with durable resumable upload state. Cancelled/abandoned drafts need explicit recovery/cleanup behavior, not orphaned invisible folders.
- Preserve relative paths through discovery. DJI folders can repeat filenames: define deterministic provider-safe unique names plus a provenance mapping; do not flatten and overwrite or equate same filename with duplicate bytes.
- Large PC batches require bounded hashing/concurrency and chunk resume. A browser cannot resume local file reads after restart without renewed user selection/permission; retain the manifest and ask for the same folder when necessary.
- Server selection must resolve only within configured import roots, reject traversal and symlink escape, detect files changing during ingestion, and stage an immutable verified source snapshot. Do not move/delete the original import folder implicitly. Show storage estimate and avoid double-accounting reused files.
- Photo scan and thumbnail/EXIF work must be bounded and cancellable. Reject unsupported/corrupt inputs explicitly; keep originals and source provenance. Validate MIME/content, not extension alone.
- Use NodeODM advertised `/options` and `/info` as capability inputs with the deployed provider/engine version. Capabilities do not authorize arbitrary network addresses, file paths, cluster endpoints or execution flags; retain Viewer server-side restrictions and validate typed values.
- Store immutable effective options/preset revision, node capabilities/version, resize settings, boundary and source manifest on each attempt for reproducibility. A future preset edit must not change an existing attempt.
- Unknown imported flags stay visible as unsupported; do not silently remove them or run them. File-valued options need managed uploaded artifacts, not local Windows paths passed into a Linux container.
- User's pasted WebODM option list is a reference, not an exact preset: every checkbox is rendered as “Enable”, so selected boolean values are unknown. Obtain an actual JSON preset/options export before reconstructing the tuned configuration.

## Delivery sequence and acceptance

### 1. Basic photo-to-task flow

Toolbar cleanup, task-name default, draft dataset creation, recursive PC/server selection, transfer/scan summary, healthy provider selection and one explicit submission. Preserve existing-results Import. Tests: empty project, nested DJI folders, duplicate filenames, interrupted upload, server-file mutation, unavailable node, stale health, expired access, double submission, cancellation and low disk.

### 2. Presets and preprocessing

Capability-driven editor, preset CRUD/import/export/versioning and resize pipeline. Tests: real exported preset round-trip, false/zero preservation, unsupported/deprecated flags, type/range checks, provider version changes, file-valued options, aspect ratio, EXIF preservation and originals unchanged. Never enable all pasted flags; contradictory skip/output options require clear warnings.

### 3. Map and boundary

Photo GPS preview and editable GeoJSON boundary; performance checks with thousands of photos. Tests: no GPS, mixed flights, invalid/self-intersecting polygons, coordinate order/CRS, boundary passed once, photos outside boundary retained, resulting products checked against requested area.

### 4. Hermes end-to-end server rehearsal

Provide the deployed cluster identity, authentication method (no secrets in handoff), `/info` and `/options` responses, configured import mount, filesystem permissions and actual exported tuned preset. After explicit agreement on one small representative job, verify PC and server-folder paths independently, provider handoff, logs/cancellation/retry, generated ortho/DSM/DTM/cloud/model/report ingestion, storage accounting and viewer opening. Then test the full farm dataset. Do not launch a large job merely to investigate the UI.

## Upstream change awareness

Prefer explicit capability refresh and a change summary tied to the installed node version. An optional scheduled upstream watcher can later report additions/removals; it must not modify presets, update dependencies or submit jobs automatically. No recurring automation has been created by this planning pass. Avoid copying WebODM implementation wholesale; consult behavior/API and review licensing before reusing source.

## Primary references

- [NodeODM API: info, options and task submission](https://github.com/OpenDroneMap/NodeODM/blob/master/docs/index.adoc)
- [ODM boundary semantics and GeoJSON](https://docs.opendronemap.org/arguments/boundary/)
- [ODM option reference](https://docs.opendronemap.org/arguments/)
- [WebODM preset API implementation](https://github.com/OpenDroneMap/WebODM/blob/master/app/api/presets.py)

Research checked 22 September 2026. Actual deployed cluster capability/version still needs verification; latest upstream documentation alone is not proof of supported options on that server.
