# Native elevation cross-section — implementation and acceptance

Status: implemented locally; release and real County Road D acceptance are not yet established by this document. The close-zoom boundary fix was separately released as `f9f7650`.

## User-facing behavior

- Open the existing **Measure** inspector on a polygon with a saved server surface-volume result.
- Adjust section direction/position and choose **Update profile on server**. Slider movements do not enqueue jobs. Reopening the same line can retrieve or resume its scoped job.
- The plan view shows the polygon and section. Hover or use arrow keys on the graph to inspect distance, source elevation, the saved reference base, and their difference. The inspected position is linked to the plan view.
- CSV preserves full numeric values in meters, including negative heights. PNG includes the chart, plan, units, source hash and datum warning.
- Reading a profile does not change the polygon, its saved volume, or its document revision. A different source/base requires an explicit surface-volume calculation first.

## What the graph measures

The server reads every crossed native raster cell, using a piecewise-constant surface consistent with the volume engine. Reference heights come from the exact effective triangles used by the completed parent volume, including any base offset. It does not reapply that offset or use the placeholder Z coordinates of map vertices.

NoData, outside-raster and outside-polygon intervals remain explicit gaps. Concave polygons may produce disconnected sections; those gaps are not joined. A step between adjacent valid cells is not a smoothed/interpolated elevation. The profile is an elevation-raster section, not a multi-return point-cloud corridor or a measurement of the solid material inside a hollow object. Section area is not volume.

Both crossed cells and output intervals are capped at 20,000. Oversized requests fail explicitly rather than silently downsampling. Reads are confined to bounded windows within a single TIFF tile/strip, with bounded caches, decoded/encoded-block checks, cancellation and existing worker RSS/deadline limits. Large source files are hashed for immutable-source verification; arbitrary TIFF layouts are not promised constant-speed results.

## Scope and lifecycle

The allowlisted `surface-transect` method uses the existing measurement queue, not a general processing endpoint. Authorized clients gain no import, reprocessing, node-control or specialist-calculation privileges.

The server resolves the completed native-raster parent in the caller's private measurement scope or temporary page/grant scope. It validates revision/attachment, geometry, exact model version, source registration/hash, reference base and fresh access before enqueueing and while executing. Parent evidence is copied by the server; client-supplied sources or reference triangles are rejected. Parent volume history is protected from eviction while referenced by the current measurement or active profile job.

Temporary jobs keep the existing page-local handle and expiry; a profile cannot outlive its parent volume. Profiles are not inserted into personal measurement documents. Closing the inspector stops observation, not accepted server work; explicit Cancel requests cancellation. View/access retirement disposes the graph and fences late results and PNG callbacks.

## Local verification

Focused checks cover:

- Native ramps/piles, frozen sloping bases, reverse/diagonal/grid-boundary traversal, concave gaps, NoData, outside-raster intervals, feet conversion, unknown units, cell/interval/block limits, cancellation and source changes.
- Actual GeoTIFF engine output through the shipped frontend validator, station readout and CSV exporter.
- Client parent/revision/source/base/line matching, temporary geometry identity, polling/recovery, no duplicate work, no saved-volume mutation, and access/edit/abort fences.
- Real isolated browser behavior: keyboard inspection, explicit gaps, CSV, cached hover drawing, no automatic slider jobs, cancellation/completion races, failed cancellation recovery, disposal and delayed PNG callbacks, desktop and narrow-screen layout.

The browser tests use synthetic data and a fresh hidden browser profile. They do not alter the user's browser records or prove County Road D's real-world accuracy. The complete Linux source suite and exact runtime image gate must also pass before promotion; the runtime gate now explicitly includes native transect and scoped job tests.

Recorded September 7 local results:

- Full Linux source snapshot: **1,467 tests / 1,444 passed / 0 failed / 23 skipped**, exit 0, 60.5 seconds. Log: `data/qa/native-profile-linux-source-tests.log`.
- Real isolated native-profile browser fixture: **7 passed / 0 failed / 0 skipped**, including responsive backing-canvas/font assertions and cached hover drawing. Desktop/mobile screenshots: `data/qa/native-profile-browser-dialog.png` and `data/qa/native-profile-browser-mobile.png`.
- Backend/numerical focused set: **49 passed / 0 failed**. Actual HTTP admission → shipped worker child → tiny native TIFF is covered, not only mocked queue execution.
- A subsequent source-only HTTP client/store linkage regression also passed with the existing attachment test (**2/2**); it was added after the full Linux snapshot and will run in CI.
- A full Windows run is not a passing server gate: existing storage tests require Linux `/proc/self/fdinfo` and fail on Windows. Linux storage checks passed without weakening those guards.

The release workflow adds the two backend-only transect test files to its exact-container tests-only mount. The frontend contract test remains separate because raw frontend modules are deliberately not shipped in the runtime image.

## Remaining real-data acceptance

1. Verify the exact deployed commit/image after the user updates; do not assume a push restarted the server.
2. Verify County Road D's original DSM height units with the [read-only source handoff](COUNTY_ROAD_D_VERTICAL_UNITS_HANDOFF.md). The user does not know its units; **do not check the meter confirmation without evidence**.
3. On the verified source, calculate a feed-pile polygon, update several section directions/positions, inspect the concrete pad/pile elevations and gaps, and compare the section base with the saved volume settings.
4. Confirm saved volume/geometry/revision remain unchanged after section inspection/export. Test reopen/resume, explicit cancellation, session renewal and revocation on the deployed release.
5. Check the same personal measurement from model/cloud/ortho/DSM/DTM views. Confirm independent clients cannot read each other's records and public refresh does not restore temporary jobs.

The existing source-unit guard remains intentional. Horizontal EPSG, an ODM software tag, plausible display heights, or another product returning a number are not proof of vertical units or datum.
