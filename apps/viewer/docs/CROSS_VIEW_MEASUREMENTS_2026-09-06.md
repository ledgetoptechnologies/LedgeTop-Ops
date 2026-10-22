# Combined personal measurement workspace

## Accepted scope

The user's September 6 follow-up adds one personal measurement list across the
3D model, point cloud, orthophoto, DSM and DTM of the same model version. This
extends the active measurement-polish/performance goal; it does not supersede
the still-unresolved dense point-cloud performance investigation.

## Behavior and safeguards

- Records, selection, export checkboxes, names, visibility and saved results
  follow the person across all five views. No copying or migration is needed.
- Measurements remain private per authenticated individual and model version.
  Public-link annotations remain temporary. This does not grant client
  processing, project management, sharing or another person's measurements.
- Switching views never recalculates a saved quantity. Horizontal map distances
  and 3D lengths are labeled distinctly; polygon perimeter retains its original
  meaning. JSON/CSV/other exports use original coordinates/results.
- Map-to-3D overlays require real elevations with explicit units and matching
  coordinates. Sampling is display-only: placeholder Z=0 is not overwritten.
  Missing or incompatible data produces an honest unavailable-overlay notice.
- Two concurrent sampling requests at most; decoded blocks and native windows
  are bounded. GeoTIFF decoding uses the existing shared background worker pool.
  Results are cached, not fetched per animation frame. Late responses cannot
  revive revoked, deleted or superseded private data.
- Vertex edits remain in the original map or 3D family. This avoids flattening
  measured heights through a two-dimensional map pick. Other record actions work
  in every view. A capture cannot silently omit an unresolved visible overlay.

## Verification checklist

Automated coverage includes all five views, no switch-triggered writes or volume
jobs, unchanged original geometry and provenance, retained selection/export,
bounded sampling, malformed/shifted coordinates, missing CRS, missing units,
NoData, native raster limits, cancellation and private-state invalidation.

Browser verification uses `test/helpers/measurement-ui-preview.mjs` with synthetic
map and spatial records and display elevations. It is isolated from production
data. Native source tests separately exercise a real generated TIFF with
explicit foot-band units. Neither establishes real-world survey accuracy or
live dense-cloud FPS.

Observed browser checks: five synthetic saved records (three spatial, two map)
remained in every view. The same selected map record and checked export box
survived orthophoto → DSM → DTM → point cloud → model. Its 28.000 m horizontal
length did not change after 3D placement. The two-card region retained the thin
orange scrollbar. The cross-family edit button explained which view to use.
With a simulated source failure, map records stayed listed, false 3D overlays
were omitted, capture showed an explicit unavailable-placement warning, and
switching to orthophoto restored their overlays. No production measurement was
created, altered or deleted for these tests.

Final local Linux suite: 1,339 total, 1,319 passed, zero failures and 20
environment-dependent skips. Implementation SHA-256 hashes matched the isolated
test container. The final test directory was mounted read-only after updating
the session-recovery fixture to execute and assert display-request cancellation.
Focused measurement suite: 163 total, 161 passed, zero failures and two expected
reconstruction-environment skips. Source build passed. These results do not
replace testing the user's deployed native dataset and authenticated client
identity path after the image is updated.

The separate local browser run exposed a pre-existing LOD test-readiness race:
all leaves were loaded and queues empty, but two branches still selected their
coarse parents at the first sampled frame. Seven further traversal frames
selected every fine leaf without a product change. The test wait now checks
stable settled selection; its quality, memory and concurrency
assertions are retained. This is separate from the user's unresolved dense
point-cloud performance report. The focused case passed four consecutive runs
after this readiness-only correction.

Final isolated browser suite rerun: 17 total, 13 passed, zero failures and four
real-dataset-fixture skips. This includes source-photo permissions, view-history
teardown/recreation, production-CSP texture decoding and synthetic LOD selection.

## Deployment and Operations

No Operations changes or new integration contract are needed for combining the
views. The existing stable-person identity and silent-renewal handoffs still
apply. Operations must preserve trusted individual subject and model-version
scope. The user deploys the new Viewer image; no restart or import is initiated
by this change.

County Road D's vertical units have not been confirmed. Do not turn on an
assumed-meters override merely to make its volume or 3D overlay render. A
verified source-unit declaration remains necessary.
