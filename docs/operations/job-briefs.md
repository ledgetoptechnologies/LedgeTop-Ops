# Operational job briefs

Operational job briefs are the LTDS Operations source of truth for pilot execution instructions. They remove the need to recover current scope from email while preserving Project Alpha's authority boundary.

## Authority and data model

Project Alpha remains generic, open-source, and read-only from LTDS. LTDS does not create or mutate Project Alpha operations, projects, quotes, invoices, or contracts. A brief can be created only after its `operation_id` resolves to an active `pa_operations` projection record. Project Alpha continues to own the operation identity, project link, schedule, status, and assignments.

Migration `0017_operational_job_briefs.sql` adds:

- `operational_job_briefs`: one mutable current pointer/snapshot per verified Project Alpha operation, with an integer optimistic-concurrency version.
- `operational_job_brief_revisions`: immutable full snapshots with version, action, author identity, and time. Update/delete triggers protect the history.
- `operational_job_brief_attachments`: immutable private-object identities with source kind, size, MIME type, and pinned R2 ETag. Attachment metadata is never returned with its R2 key.
- the existing `audit_events` log receives each successful scope save or attachment addition. Conflict attempts create neither a revision nor an audit event.

A version-1 snapshot contains ordered items with stable IDs, category, title, instructions, and nullable `presetRef`. `presetRef` is intentionally unused by the current UI; it provides a future extension point for preset-derived items without adding a preset library now.

## API and concurrency

The same-origin contract is:

- `GET /api/operations/:operationId/job-brief`: current items, private attachment URLs, operation destination hint, history, and `canEdit`.
- `PUT /api/operations/:operationId/job-brief`: replaces the ordered scope item snapshot and requires `expectedVersion` (`0` creates the first version).
- `POST .../attachments/upload`: streams a staff file through the Worker to `DATA_BUCKET`, limited to 25 MiB, and requires `X-Expected-Version`.
- `POST .../attachments/reference`: adds an existing indexed client-project file and requires `expectedVersion`.
- `GET|HEAD .../attachments/:attachmentId/content`: reauthorizes the viewer, verifies the pinned ETag, and streams the file with private/no-store behavior.

D1 batches execute the guarded current-version mutation, immutable revision, attachment row when applicable, and general audit event transactionally. If the expected version is stale, the first mutation changes zero rows and the API returns `409` with `currentVersion`; it never silently overwrites. Staff uploads use a random private key below the reserved `Jobs/Operations/_ltds/JobBriefs/` subtree. The generic delivery browser rejects `_ltds` paths even for global delivery browsers, so only the operation-authorized brief route can resolve those bytes. If the D1 write conflicts or fails before committing after R2 accepts the new upload, only that newly generated object is cleaned up; a response-assembly failure after commit never deletes an attachment referenced by D1.

The Operations UI attempts to refresh an open brief every eight seconds and
again on window focus/visibility. Browser timer throttling, a suspended tab, or
network failure can delay that best-effort polling. A dirty editor is not
replaced automatically; it warns that a newer version is available.

## Access policy

- All API calls require the existing human Cloudflare Access identity. Mutations also require the existing same-origin and CSRF checks.
- Read access reuses the Project Alpha operation visibility predicate. Administrators or an explicit all-operations viewer can read; otherwise the staff principal's Project Alpha user must have an active assignment to that exact operation. Inaccessible operations and attachments return `404`.
- Editing requires `operations.manage` in the operation's LTDS resource context. The route is a narrow exception to the global administrator mutation gate so a future explicitly granted Operations manager can edit without receiving unrelated administrator privileges.
- Staff upload does not require delivery browsing. Referencing an existing client-project file additionally requires `delivery.browse` and an active `client_folder_associations` project prefix whose portal project has the same verified Project Alpha project ID as the operation. The key must exist in `file_index`, and its current R2 size/ETag must match.
- The assigned pilot reads or downloads only through the brief route. Brief access never grants `delivery.browse`, delivery sharing, client-workspace, or unrelated file access.
- R2 credentials, presigned R2 URLs, and object keys are never sent to pilots. KML/KMZ uses the authorized same-origin content path.

`project_file` is deliberate provenance wording. The current portal can prove that the object is an authorized file in the client's linked project, but it cannot prove which human originally uploaded it. The UI therefore says “Authorized client project file,” not “client uploaded.”

## External navigation

Authorized request/job viewers receive clearly labelled HTTPS actions for Google Maps and Apple Maps. HTTPS lets each provider open its native app when supported and fall back to its web experience otherwise. Links contain only a destination coordinate and optional human-readable label—never a Mapbox token, private geometry URL, attachment URL, or R2 credential.

Request review derives its destination from the submitted polygon or POIs and
then falls back to the stored request point. The current job-brief route does
not store separate job geometry: it uses the first active projected Project
Alpha service location with valid coordinates, ordered by service-location ID.
If that operation's project has no such location, the job brief exposes no map
action.

The representative coordinate is deterministic:

- Point: the point itself.
- MultiPoint: the submitted point nearest the circular-longitude/latitude center of its valid points.
- Polygon/MultiPolygon: the submitted boundary point nearest that same deterministic center calculation.
- No usable geometry: the stored selected/reverse-geocoded latitude and longitude, when present.

The representative result is always an actual submitted point or boundary coordinate, including for antimeridian and disjoint geometries. The stored location label is display context and an Apple Maps query hint. It is not a claim about a closest road. Rural properties, water, restricted land, and off-road sites can still place the destination away from a drivable or safe launch location. Pilots must confirm access, launch suitability, airspace, and landowner authorization independently.

Geometry and navigation targets are returned only inside the already authorized request or job response, which remains `Cache-Control: no-store` at the API layer.

## Migration and release sequence

1. Back up and verify the Operations D1 database.
2. Apply Operations migration `0017` before deploying code that registers the job-brief routes.
3. Deploy the Worker and client bundle together so the UI does not call routes missing their schema.
4. Smoke-test an administrator create/edit, an assigned-pilot read/download, an unrelated-user denial, a deliberate stale-version conflict, a staff KML upload, and an authorized project-file reference.
5. Monitor structured Worker errors and audit/revision counts. The job-brief
   feature itself emits no email, push notification, or external message and
   does not mutate client files. Direct folder-grant notification behavior in
   the combined release is a separate contract documented in
   [notifications](../notifications.md).

## Current limitations and future extension

- The first release attaches briefs only to verified Project Alpha operations. Standalone LTDS work is not yet exposed; supporting it should add a separate local-operation reference rather than fabricate a Project Alpha identifier.
- Attachments are append-only in this release. There is no remove/replace UI; history and bytes remain auditable.
- Append-only attachment bytes consume private R2 storage until a separately
  reviewed retention or cleanup policy exists.
- Staff uploads are capped at 25 MiB. Large orthomosaics and raw imagery belong in the existing delivery workflow, not a job brief.
- No preset or reusable-item UI exists. A future preset system can populate stable item IDs plus `presetRef` and still save immutable resolved text in each brief revision.
- Job-brief changes emit no emails, push notifications, or external messages.
  Poll/focus refresh is the current prompt-update mechanism.
- Drafts exist only in browser memory. Switching or closing the open brief uses
  a confirmation, but top-level navigation, browser close, or a crash can still
  lose unsaved text.
