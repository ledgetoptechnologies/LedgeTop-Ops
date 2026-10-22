# Measurement workspace: implementation and acceptance

Latest read-only Operations assessment and follow-up verification: [Operations measurement release handoff](OPERATIONS_MEASUREMENTS_RELEASE_HANDOFF_2026-09-05.md). Its final addendum records the subsequent 1,221-test run (1,201 passed, 0 failed, 20 skipped), migration/restart rehearsal and exact integration gaps.

This document covers the current local measurement/project/download candidate. It is a release checklist, not a production acceptance certificate. No production push, deployment, import, reconstruction run, or client access was performed. Native reconstruction is implemented and exercised in the actual runtime against synthetic numerical fixtures; real survey-data accuracy and performance still require acceptance testing.

## Intended authority model

| Identity | Model access | Personal measurements | Processing/admin actions |
| --- | --- | --- | --- |
| Authorized administrator | Explicitly authorized Viewer workspace and model session | Own records only | Separate live Operations capability, same subject, and `viewer.processing.write` required for calculation jobs |
| Another staff member, including Kollin | Whatever role/access is actually granted; the name alone grants nothing | That individual's own records | Only when independently granted the required administrative permission |
| Signed-in client | Only the shared task, or accessible tasks within the shared project | Own records when `measure: true` and a verified individual identity is supplied | No import, run/retry, node configuration, workspace administration, or server calculation jobs |
| Public link | Only its live scoped model/project permission | In-memory only; page refresh resets changes | None |

The API scopes ownership to **model ID + immutable model version + audience + subject**. It does not use one shared company/client identity for multiple people. An administrator does not see a client's personal records just because the administrator owns the model. A client token without `personalMeasurements: true` receives an explicit temporary-mode response instead of putting unrelated clients into a shared personal bucket. Operations must supply a verified, stable individual subject before persistent client acceptance can pass.

`server/measurementApi.js` requires an explicit Viewer bearer, live session, matching ready model/version, and positive view/measure permissions. Calculation endpoints additionally require a separately issued same-person Operations bearer and `ops` audience. A shared model token is never processing authority. Worker admission and liveness checks repeat these gates. The admin request broker keeps this separate capability in its workspace; the Viewer iframe does not receive the broad administrative bearer.

Public measurement changes use browser memory, not localStorage or a server record. Revoking permission disarms an active drawing and restores ordinary navigation. Revocation of an external Operations grant also depends on the existing Operations-to-Viewer session/revocation integration; local tests are not proof that an external identity provider has deployed that contract.

## Project and sidebar changes

- A project expands inside its existing card. Its name/description are not duplicated in a second heading, and there is no redundant “All projects” action. Click the header again to collapse it.
- Existing collapsed task appearance, quick actions, permission gates, filter, and project/task URL history remain intact. Expanded projects contain the project actions and task list.
- Navigation appears first, followed by compact camera controls, through the sidebar's CSS ordering. DOM order is deliberately retained to preserve existing bindings. Confirm computed visual order in a real browser.
- **Superseded request:** the earlier proposal to hide Layers, force maximum detail, and force Auto was revised. Keep the existing Detail and Viewer Memory controls and their bounded runtime behavior; remove explanatory copy. Do not “fix” this by removing controls or overriding the existing memory policy.
- Camera positions retain a toggle and compact presentation. Existing camera-overlay performance work is not an authorization to redesign working point-cloud navigation.

## Measurement document and interaction contract

| Collection | Shared views | Coordinate interpretation |
| --- | --- | --- |
| `spatial3d` | 3D model and point cloud | Canonical easting/northing/elevation in meters, converted at each renderer boundary |
| `map` | Orthophoto, DSM, DTM | Shared projected XY boundary; current map vertex geometry is horizontal, not terrain-following 3D distance |

A detour through a map does not erase a 3D measurement or replace its coordinates with map coordinates. The two collections remain distinct. Records are version-bound and are not automatically migrated to a newly processed or replaced model. Missing georeference metadata remains `LOCAL:unverified`; the Viewer must not invent a UTM zone and produce plausible but incorrect geographic exports.

The workspace supports multiple named distance/polygon records, selected and visible records, individual deletion, renaming, edit mode, and per-record display units. Saving/renaming/hiding a measurement does not move the viewpoint or remove another person's records. Browser requests are serialized; optimistic revisions reject stale edits instead of silently winning against another tab. Failed saves remain visibly unsaved. Deleted records cannot be resurrected by an old calculation response. Result attachment changes results only when the source geometry and revision still match.

Drawing and editing acceptance:

- [ ] Click to place vertices; the moving cursor previews the next edge and polygon closure without committing that point.
- [ ] Hold Shift to navigate while drawing. Navigation does not place a point or consume a map-control button.
- [ ] Backspace removes the previous point, but does not steal Backspace from a text/number field.
- [ ] Space-drag moves a nearby existing vertex; Edit selected also permits vertex dragging.
- [ ] Enter, Escape, right-click, and Finish retain only committed vertices when enough exist; fewer than two distance/three polygon vertices cancel the incomplete record.
- [ ] A mode change finishes/cancels the active draft consistently and closes its local calculation dialog.
- [ ] Vertex markers remain small screen-space dots when zoomed in; each committed polygon side has a length label.
- [ ] Loss of measure permission clears overlays/disarms drafts without trapping pointer navigation.

## Geometry, units, and accuracy

Coordinates and numerical results are stored/exported at their available floating-point precision. Three decimal places apply to presentation, not to the stored geometry. Feet/inches is the default length presentation; default area/volume are square/cubic feet. Decimal feet, yards, meters, and centimeters are explicit options; yards are imperial, not metric. Unit changes convert values and inputs, not source coordinates.

Vertex geometry provides segment lengths, perimeter, horizontal footprint area, elevation difference, and planar area when planarity is within the implemented tolerance. A nonplanar polygon does not masquerade as a known planar area. Degenerate/repeated adjacent points and crossing/overlapping polygons are rejected. A polygon alone produces **geometry-only** results, not an invented volume.

Map boundary Z is sampled from the selected elevation raster for surface integration; spatial3d boundary Z comes from picked source geometry. A horizontal map distance is not a terrain-following path. Neither three decimal places nor “complete” computation establishes survey accuracy, photogrammetric accuracy, or solid-material volume. There is no automatic segmentation that can infer the inside of a car from its roof.

## Calculation methods and provenance

| Method | Execution and source | Meaning and safeguards |
| --- | --- | --- |
| Local surface cut/fill | Browser worker; existing authorized DSM/DTM native window | Space between observed elevation cells and the selected reference; bounded native window, no server job or reconstruction |
| Administrative native raster | Background worker; exact registered hashed DSM/DTM | Native-cell surface integration with source/CRS/unit checks, missing coverage reporting, cancellation/liveness limits |
| Administrative point-surface cut/fill | Background worker; registered EPT with indexed hashed files | Explicit cell-sized topmost-point surface using intersecting hierarchy data; all/ground filter; missing cells remain missing |
| Administrative closed mesh | Background worker; registered original OBJ and explicit object selection | Enclosed volume of observed selected closed geometry; rejects invalid/open/clipped/nonmanifold/self-intersecting geometry, not a bounding-box proxy |

Surface references include triangulated boundary, fitted plane, lowest/highest/average boundary, and custom elevation plus offset. Reference elevation/offset inputs use the displayed unit and convert to meters. Missing vertical units require explicit confirmation rather than an assumed conversion. Unsupported/mismatched CRS and source units fail clearly. A source window beyond the browser's 1.5-million-cell limit fails rather than silently substituting a lower-resolution surface.

Surface outputs keep cut, fill, net (`cut - fill`), footprint/valid/missing area, coverage, reference, numerical model, and warnings. Closed-object outputs use `volumeM3`, with source identity, geometry checks, selection and warnings; they do not fabricate cut/fill or coverage. The isolated preview must identify above-base, below-base, and reference geometry. Preview decimation is for display only, not a claim that the displayed subset is the full numerical source.

Server work is bounded, uses a separately supervised child, checks source integrity and live authorization, and preserves job status/error summaries. Accepted admin jobs are not cancelled just by closing a dialog; use Cancel job. Changed/deleted measurement revisions cannot accept an old result. Source reconstruction/repair, if offered in subsequent work, needs its own accepted contract and end-to-end test; it is not implicitly authorized for clients by these measurement controls.

Personal document writes cannot attest themselves: the API marks submitted result snapshots as browser-origin/unverified, even if they contain a claimed server label. Authoritative administrative provenance is the protected calculation-job result; the personal snapshot can retain its calculation job ID for correlation. Exports must not reinterpret an unverified saved snapshot as an independently certified server calculation.

## Export, screenshots, and individual products

- CSV: stable original summary columns plus `volume_m3`, `coverage`, `source_json`, `reference_json`, `provenance_json`. Numbers retain available precision; missing quantities stay empty, zero stays zero, and formula-like text is escaped. Coverage is a fraction, not an already multiplied percentage. Negative cells retain the existing spreadsheet-safety apostrophe convention. Machine integrations should prefer JSON for exact typed numeric values.
- JSON: full document geometry, metrics, results, source and display-unit context. No image/tile payloads are stored in a measurement record.
- GeoJSON: requires a verified geographic transform, exports geographic XY, and retains source vertices/CRS and vertical-datum caveat in properties. It does not silently claim source Z is WGS84 ellipsoidal altitude.
- DXF: 3D polyline vertices and labels in meters with drawing-unit header. It is not a complete CAD surface or measurement-result database.
- Selected records export when checked; otherwise visible records in the current collection export. Screenshot captures the currently visible measurement overlay, not only checked export rows.
- Save view PNG composites the active renderer and overlay. Print/PDF report uses the current screenshot plus selected/visible record summaries/results. Cross-origin-tainted map canvas capture produces a clear error instead of an empty image. Browser print behavior, legends, clipping and real map pane blending still require visual acceptance.
- Product Download opens a native in-application chooser with registered label/format/byte size. Original EPT/3D Tiles manifests are not mislabeled as a downloadable complete point cloud/model. An OBJ without textures says so.
- Staff can download allowed registered original outputs. Client/public download requires explicit download permission and is restricted to the published derivative allowlist; original point clouds, OBJ and reports are not newly exposed to clients by this batch. Extending that policy requires an explicit permission/product decision.
- Multi-gigabyte products stream to the browser's download manager via narrow, short-lived tickets, not a JavaScript Blob. Every new request/range rechecks current source permissions, and integrity verification is followed by another authorization check. An already admitted transfer can finish; a later resume after ticket expiry needs a new ticket. See [product download contract](PROJECT_PRODUCT_DOWNLOADS.md).

## Acceptance matrix

The following are **required live acceptance checks**, not checkmarks inferred from unit-test success:

| Scenario | Expected outcome |
| --- | --- |
| Admin A, staff B, clients C/D open same shared version | Four separate personal collections; no cross-user list/read/update/delete access |
| Client has project share vs task-only share | Only allowed tasks appear; sibling project/task and admin endpoints deny access |
| Public reload | Measurements reset; no personal persistence request and no server job capability |
| Client identity not yet integrated | Temporary notice, not false “Saved” and not cross-client persistence |
| New authenticated session for same individual/version | Saved records and per-record units return without copying another user's records |
| Two tabs edit/delete one record | Revision conflict is explicit; unsaved data is not silently overwritten; late result cannot resurrect deletion |
| Model → cloud → DSM → model | Viewpoint continuity remains intact; correct collection/list and overlays reappear |
| Polygon around roof/car and surrounding ground | Reference preview makes air-space vs observed closed-object interpretation clear |
| Sloping base, holes/nodata, boundary partially outside raster | Correct reference method and incomplete coverage; missing values never counted as zero ground |
| Real original EPT and OBJ | Method eligibility, source frame/units, bounds, limits and deliberate failure cases verified on production-like files |
| Admin token/session/share revoked during work | New API calls deny; worker stops after liveness loss; result cannot be attached to a stale record |
| Large real download / HEAD / pause-resume / revoked share | Scoped bytes, no page-heap-sized Blob, documented ticket expiry and revocation behavior |
| Desktop/narrow project cards and keyboard dialogs | One project header, preserved collapsed rows, usable actions/focus/close, no accidental task expansion |
| Screenshot and browser Print/PDF in each view | Correct measurement position/labels, opacity/legend expectations and useful error handling |

## Evidence and remaining verification

Automated focused checks executed during this review pass include:

- `test/measurement-document.test.mjs`: geometry, units, exports and private-store races/conflicts/deletion/result attachment.
- `test/measurement-viewer-integration.test.mjs`: nine actual-source/VM renderer-seam regressions for collection switching, input, permission loss, canonical coordinates and screenshot transparency/security errors. These are not real pixel/browser tests.
- `test/measurement-export-results.test.mjs`: closed-mesh volume, cut/fill/coverage, browser source identification, CSV precision and provenance.
- `test/product-downloads.test.js`, `test/viewer-product-downloads.test.mjs`, `test/output-access.test.js`: real HTTP ticket/range/HEAD/revocation/integrity contracts and UI helper seams.
- `test/workspace-task-layout.test.mjs`, `test/workspace-project-dashboard.test.js`, `test/workspace-admin-controls.test.js`: integrated card markup, task behavior, permissions and stream-based download wiring.
- `test/point-cloud-wiring.test.js`, `test/viewer-runtime-wiring.test.js`, `test/viewpoint-continuity.test.mjs`: 37 checks passed after updating missing measurement-lifecycle VM seams and obsolete help-text expectations; no production behavior was changed for those test fixes.

The combined isolated Linux suite, including private API, jobs, broker, native raster, point-surface, closed-mesh, browser worker and volume suites, passed 1,191 tests with no failures and 20 explicitly skipped checks (1,211 total) before the final report/dialog lifecycle hardening. The final run is recorded below. Earlier fixture failures were rerun and resolved, not waived. The exact non-root runtime also passed 36 native/private-API tests with zero skips, including actual Poisson reconstruction. The native dependency compiles and executes its usage smoke on amd64 and ARM64; numerical ARM64 parity has not been established.

Local browser QA used shipped measurement modules with a synthetic projected canvas and native raster, plus actual workspace render functions/CSS with synthetic project data. Verified polygon cursor preview, finishing committed points, Backspace undo, dragging an existing vertex, updated quantities, shared model/cloud records and separate map records, repeat native cut/fill with a changed base offset, isolated rotatable surface/base preview, and report screenshot/edge labels/readable quantities. Verified one integrated expanded project card, preserved task quick actions, and an in-application chooser listing actual registered product types with sizes and honest OBJ/EPT limitations. The chooser fixture never transferred real files. Shift navigation is covered by actual-source event tests; the browser automation modifier attempt was inconclusive and is not counted as a live pass. Narrow layouts and the real Three/Potree/Leaflet combinations remain in the live acceptance matrix.

Privacy lifecycle checks cover capture/PNG encoding after access or view changes, report image/markup removal on invalidation/disposal, and late administrative dialog initialization. Revocation cannot leave these Viewer-controlled private dialogs visible or printable. This does not revoke files already explicitly downloaded or a print dialog already handed to the browser.

### Final local candidate verification — September 5, 2026 (America/Chicago)

- Final combined tree: **1,220 tests; 1,200 passed; 0 failed; 20 skipped**, using the isolated native QA container. No failing tests were waived.
- Exact final non-root runtime: **36 passed, 0 failed, 0 skipped**, with only tests mounted and no replacement application sources.
- Production Vite bundle and native Docker runtime built successfully. Existing large-chunk/CommonJS dependency warnings remain; they are not a performance acceptance result.
- Local image: `ltds-viewer:measurement-runtime-candidate`, image ID `sha256:ac61e0bacb1c7e7d00172c78717927718e17ec993e1a140cac7581c4a49143ab`. This is a local tag, not a published registry pull reference.
- `git diff --check` passed. Source remains uncommitted/unpushed in `codex/storage-diagnostics-cleanup`; the original dirty checkout was not changed. Temporary local QA servers were stopped.
- Final PNG action and report open/close were exercised in the browser after lifecycle hardening. The report removes private image/markup synchronously; administrative dialogs register their close handle before attachment, so invalidation does not wait for a slow initial request.
- Deployment, cross-account Operations acceptance and original-data accuracy/performance checks are outstanding acceptance tasks, not claims made by this local completion.

Still not established by this document: production rollout, Operations identity readiness, real client/public cross-account browser acceptance, sustained multi-gigabyte transfers, real survey accuracy, complete map screenshot composition, or a benchmark against the user's original Rome/Church files. A failure caused by missing source metadata is an explicit limitation, not evidence of a numeric zero or a usable volume. Operations' required stable individual client subject and service-only identity attestation are specified in [the integration handoff](PRIVATE_MEASUREMENT_API.md#operations-handoff-individual-client-identity); legacy clients remain temporary-only until that external contract is satisfied.

## Research rationale (verified primary pages)

WebODM's workflow uses a user-drawn boundary and explicitly discusses how base-plane choice affects stockpile volumes, including sloping/irregular bases. This supports exposing the reference method and preview rather than presenting a generic box volume. Its expected-accuracy discussion is not a guarantee for imported data or this Viewer. [WebODM: Measuring Stockpiles](https://docs.webodm.org/tutorials/measuring-stockpile-volume/).

Drone2Map documents DSM/DTM surface selection, cut/fill relative to a base surface, named saved measurements, configurable units, and exports retaining measurement fields. Those are useful interaction precedents, not proof of algorithm parity. Its total-volume convention (`cut + fill`) differs from this Viewer's explicitly labeled signed net (`cut - fill`); do not compare those columns as if they were the same quantity. [Esri: Perform measurements](https://doc.arcgis.com/en/drone2map/2024.2/help/measure.htm).
