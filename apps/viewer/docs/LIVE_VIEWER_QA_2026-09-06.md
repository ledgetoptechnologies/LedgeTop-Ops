# Live Viewer QA — 2026-09-06

## Scope and disposition

Live user walkthrough of **Testing and Examples / Low-County-Road-D-6-11-2026-backup**, on deployed revision `8981a6ae159205232af4ba9491b49588c284b600` (verified using the public health revision header). Browser skill used for actual clicks, navigation, screenshots, visible status and console inspection. Two independent read-only code reviews investigated session/measurement integration and point-cloud rendering.

The original walkthrough below records the deployed baseline, not the patched release. A subsequent implementation pass addresses the confirmed findings; see the follow-up section at the end. Operations code, repository visibility, production deployment and sharing permissions remain untouched. No secrets or session URLs are included here.

Baseline assessment: access continuity and point-cloud responsiveness take priority over cosmetic polish. Several visual complaints also have concrete functional causes. No real-world survey-accuracy or production-FPS certification is implied by fixture tests.

## Test data and changes left behind

- Original `Polygon 1` preserved; no existing measurement was deleted or edited deliberately.
- Added `QA 2026-09-06 — pad distance` and `QA 2026-09-06 — feed pile` in the signed-in person's private 3D measurement group.
- Distance displayed **100 ft 9.628 in**, and **30.725 m** after unit conversion. This is an internal conversion check, not an independently surveyed distance.
- QA polygon displayed **1,709.863 m²** horizontal area and **194.487 m** perimeter. Its screen-selected boundary is for exercising the workflow, not a certified pile boundary.
- One staff-only native DSM calculation was submitted for the QA polygon. It terminated **failed: measurement source vertical units required**. No processing/import/reconstruction job was launched for the whole model. No running calculation was intentionally left behind.
- EDL was temporarily disabled for comparison and restored. Camera markers were toggled on for map inspection and restored off. Temporary viewport override was reset. The sidebar was reopened using its narrow-layout toggle. QA ended back in 3D view.
- Selected QA distance and activated CSV export; activated Save view PNG. No immediate UI error appeared, but downloaded file bytes/image content were not independently retrieved and verified. These are **not** certified export passes.

## Confirmed findings and implementation acceptance criteria

### P1 — Access interruption hides valid personal work

**Live:** During DSM/orthophoto/DTM navigation, the sidebar displayed `Personal measurements are hidden until access is restored.` The list later returned after switching to the 3D view. Console captured a tileset request failing with HTTP 403 at approximately **16:19:00 UTC**. The original and QA records subsequently displayed as saved. This was temporary access loss, not evidence of deletion. The precise initiating denial was not fully traced.

**Code reproduction:** `main.js:1436–1443` treats a 30-second renewal-controller timeout as unavailable even while the current Viewer capability can still be valid. `setSessionAccessState` invalidates the measurement workspace; its `onAccessLost` callback immediately initiates another renewal before the timeout handler finishes installing backoff. The real callback sequence reproduced cleared records and overlapping renewal/retry state. Existing recovery fixtures stub out that callback and therefore miss the interaction.

Additional risks:

- `measurement-store.mjs:29` invalidates on every 401/403 without an access-generation fence. A request from before renewal can invalidate the newly restored session when its response arrives late.
- Same-person renewal can retain the same bearer, so token-string comparison alone is insufficient.
- `main.js:1407` does not apply its early-authorization guard to the `measurements` reason. The controller rejects requests more than five minutes before expiry silently (`review-session-controller.mjs:273`), which can feed the timeout loop.

**Fix criteria:** Distinguish expired/revoked access from a temporary controller transport failure; retain still-valid, same-identity/scope access while retrying. Do not recursively start renewal from renewal-controller invalidation. Fence old requests by verified access generation. Preserve fail-closed behavior for actual expiry/revocation/identity or version changes. Tests must use real callback interactions and prove recovery without reopening the model.

### P1 — Point cloud remains slow after loading

**Live:** County Road D has **17,502,028 source points**. On entry the cloud HUD showed approximately **7.5M visible / 7.5M effective budget / 15 FPS**; it later showed **1.5M visible / 1.5M effective budget / 5 FPS**. Requested sidebar budget stayed 10M. Camera markers were off. Turning EDL off did not improve the displayed rate in this bounded comparison; EDL was restored. No full GPU/CPU frame trace was available, so these HUD observations do not identify a hardware or renderer root cause.

**Confirmed code behavior:**

- `public/pointcloud.html:245`: budget drops 25% every two seconds below 24 FPS, bottoms out at 1.5M, and takes about 14 seconds to reach that floor from 10M. It cannot respond further if 1.5M is still too slow.
- Potree visibility already prioritizes projected size (radius relative to camera distance); a wholesale nearest-first rewrite is not justified by the available evidence.
- Bundled Potree draws each visible octree node separately with raw WebGL calls. Point count alone does not reveal node/draw overhead; Three.js renderer counters do not count those raw draws.
- `measurement-workspace.mjs:87` calls a GPU point pick on every pointermove during an active draft. Classification hover is delayed and suppressed during navigation, but draft preview picking is not.
- Overlay redraws can project/serialize many vertices and labels at about 30 Hz. This may matter with many annotations, but does not explain all no-draft slowdown by itself.
- Parent mesh rendering is correctly skipped while Potree is active. The preceding release's hidden-marker fix is present.

**Next investigation:** Add narrowly scoped, credential-free timing/node-count diagnostics. Compare the same loaded viewpoint with no draft versus draft, EDL on/off, and smaller effective budgets. Record raw visible node count, points/node, viewport dimensions, WebGL hardware/software renderer and frame-time distribution. Profile unconditional renderer resizing before changing it. Coalesce preview picks while preserving exact click picks. Do not silently degrade precision or assert that changing tile priority fixes this.

### P1 — Measurements from the wrong view remain drawn

**Live:** Orthophoto sidebar said `No measurements in this view group`, but the map visibly contained `Polygon 1`, QA distance and QA feed-pile labels from the 3D group.

**Code reproduction:** `measurement-workspace.mjs:116` removes/rebinds the same SVG and sets `lastSvg=''` without clearing its previous `innerHTML`. An empty destination group produces empty markup matching that cache value, so the old 3D SVG stays on the map. This is a stale overlay, not a desired sharing of the two groups.

**Fix criteria:** Clear SVG content on binding reset or use an invalid cache sentinel forcing the first draw. Test populated 3D → empty map and populated map → empty 3D, as well as normal model/cloud sharing.

### P1 — Fast rename followed by units change conflicts with itself

**Live reproduction:** Create and finish distance; rename with Enter; immediately choose Meters. UI reports `Not saved: This measurement changed or was deleted. Reload saved measurements before editing again.` Reload shows the rename was saved.

**Code reproduction:** Rename and units change each queue a full record snapshot with revision n. Rename succeeds at n+1, then units save rejects its stale n snapshot. This is **not** an Enter-plus-blur duplicate rename; blur does not save the name at all.

**Fix criteria:** Serialize field patches against the latest acknowledged revision, or gate edits while pending with clear feedback. Retain real cross-tab conflict protection. Test rapid sequential UI edits and a genuinely concurrent external edit separately. Add explicit rename Save/Cancel or clearly communicated Enter behavior.

### P2 — Hidden obsolete controls leak into the UI

`index.html:479–480` marks old Volume/Clear Measurements buttons hidden, but `.tool-btn { display:flex }` overrides the browser's hidden styling. Both appear live and in the user's screenshot. Volume currently aliases polygon creation rather than completing volume calculation, adding ambiguity.

**Fix criteria:** Enforce hidden styling explicitly and test computed visibility. Present one clear polygon → saved measurement → surface cut/fill flow, with context-appropriate actions rather than obsolete duplicates.

### P2 — Collapsed tools cannot be reopened at desktop width

**Live:** Sidebar had `class=collapsed`, width about 1 px, and sat off-screen, while Toggle tools had zero-size bounds. Shrinking viewport to 1000 px exposed the toggle; opening it and resetting viewport restored usable controls.

**Cause:** Collapsed state survives a breakpoint change while the toggle is shown only at widths up to 1024 px.

**Fix criteria:** Keep a reopening affordance whenever collapsed, or reconcile collapsed state when entering desktop layout. Test narrow-load → wider window and both collapsed/expanded states.

### P2 — Map camera selector overlaps Reset/Fullscreen

**Live:** Top-right camera selector overlaps floating controls. A mouse click aimed at the camera selector activated Reset camera; focusing the selector and pressing Enter successfully opened the photo.

**Cause:** `map-camera-overlay.mjs:91` and `index.html:180` independently claim the top-right corner.

**Fix criteria:** Give controls a shared layout/clearance; assert disjoint clickable bounds at desktop/mobile widths. Preserve keyboard access.

### P2 — Measurement and marker cursor feedback is missing

**Live:** Map camera canvas retained a `grab` cursor; starting Distance also left it `grab`. The camera keyboard selector itself has a pointer cursor, but that does not fix the pins drawn on the canvas.

**Fix criteria:** Crosshair during point placement, grab/grabbing during Shift navigation, appropriate vertex-edit feedback, and pointer only when a clickable camera marker is under the cursor. Restore cursor on finish/cancel/mode change; avoid expensive unbounded hover picking.

### P2 — Volume workflow fails on this dataset before a usable result

**Browser DSM attempt:** Refused with `The source raster has oversized decode blocks for browser measurement. Ask an administrator for a calculation.` The preview remains blank; no volume is established.

**Staff fallback:** Job accepted, then failed because source vertical units are missing. The meters-assumption box was intentionally not checked. A horizontal CRS or a decimal display does not prove vertical units.

**Fix criteria:** Persist verified source units at import, preflight the selected product and browser feasibility, and explain the exact limitation before a calculation. Route oversized-block sources through a safe prepared/windowed path or the existing staff-only calculation workflow. Do not give clients general processing permission as a workaround. Make the preview's empty/loading/error states explicit, center/size its dialog, and distinguish native calculation from reduced preview samples.

### P2/P3 — Layout and measurement presentation

Confirmed/user-requested improvements:

- Consistent button heights, spacing, grouping and hierarchy; auxiliary controls currently look browser-default beside the themed main tools.
- Newest measurement first; approximately three visible rows in an independently scrollable, resizable region. Current additions append below older entries.
- Checkboxes visibly labeled as export selection; visibility uses a separate Hide/Show action.
- Thousands separators in displayed values (e.g. `26,122.202 ft²`, not `26122.202 ft²`), without changing stored precision or machine-readable numeric export semantics.
- Zoom-dependent label decluttering: prioritize selected/hovered measurement, hide or collapse crowded edge labels at overview, preserve full detail on focus/export.
- Clear selection styling and editable descriptive names, rather than many indistinguishable small buttons.
- Surface cut/fill dialog should be centered and responsive with useful preview sizing, status, and base-plane explanation.
- Hidden/inactive renderers must not leave stale FPS/LOD/triangle statistics displayed as if they describe the active map/cloud.

## What worked and what was actually verified

- Workspace project expansion and County Road D launch worked without changing shares.
- Model and point cloud both loaded; the existing personal polygon carried between the two 3D views.
- Two-point distance creation, polygon completion, explicit rename and persisted reload worked, apart from the rapid-edit self-conflict above.
- Unit conversion was internally consistent to the displayed precision.
- Orthophoto and DSM views opened; DTM navigation was exercised but its complete rendering/measurement flow was not certified because the access interruption occurred during that part of the walkthrough.
- Camera keyboard selection opened a source photo.
- **24/24 local focused tests passed, no skips:** native cut/fill mathematics, export-result semantics, private measurement API isolation, staff-only job authority, store lifecycle, and precision handling. These existing passing tests do not cover all live bugs above.
- Numerical tests include known cut/fill signs, fractional cells, sloping bases, concavity, large UTM coordinates, NoData/coverage and windowed/full-read agreement.

## Accuracy and coverage limits

No claim of survey accuracy or actual pile volume is made. The live calculation produced no valid volume; a known real-world reference and verified vertical units remain necessary. Stored precision and three-decimal display are not a substitute for source accuracy or a correct base plane.

No new client/public share was created, and no real client identity was impersonated. Client permission boundaries were checked through the focused API tests, not certified end-to-end in the live Operations client portal. PNG/PDF/download output contents, every vertex-edit gesture, long-duration renewal across actual expiry, and a complete hardware frame trace remain unverified.

## Recommended next implementation order

1. Access continuity/reentrancy/late-response fencing, plus real integration tests.
2. Stale SVG view-group bug and serialized measurement editing.
3. Point-cloud profiling, adaptive budget behavior and draft-pick coalescing; demonstrate before/after loaded-view navigation, not startup FPS.
4. Source-unit preflight and large-raster volume usability, with known numerical fixtures and a validated pile reference.
5. Unified measurement UI, reliable hidden/sidebar behavior, collision-free map controls, cursors, newest-first list and label decluttering.
6. Repeat this live workflow and test an actual restricted client account with the Operations agent before describing the experience as client-ready.

## Follow-up implementation and extra QA

The follow-up patch implements the access-generation/reentrancy fixes, serialized
field edits, stale-SVG clearing, hidden-button/sidebar fixes, cursor feedback,
newest-first resizable list, explicit export checks, grouped numbers, decluttered
labels and centered volume dialog with empty/loading/error feedback.

The Potree-specific renderer now avoids resetting unchanged canvas dimensions,
while preserving viewport, pixel ratio, CSS sizing and XR behavior. Adaptive
point demand can fall below the old 1.5M floor under sustained overload, retains
a known root within the requested ceiling, ignores hidden views and restores
detail only after sustained headroom in a populated scene. The HUD distinguishes
active/requested budgets and reports visible nodes. Map/cloud modes no longer
show frozen mesh FPS/triangle/LOD counters as their own performance.

**Correction to the original source diagnosis:** the “oversized decode blocks”
message does not establish the actual test raster's block layout. GeoTIFF 3 uses
accessor methods instead of plain `fileDirectory` properties. Reading missing
properties estimated an entire image as one 64-bit block and could falsely
reject a valid striped/tiled source. Browser/native calculations now share the
correct metadata readers. Real TIFF tests cover strips, padded tiles, deferred
byte counts, rotated grids and malicious allocation declarations. Both paths
validate bounded raw first-IFD declarations before invoking the parser. The
browser refuses ignored/malformed Range responses without buffering whole files.

Additional live baseline tests:

- Added two clearly labeled private **map** records: `QA 2026-09-06 — orthophoto
  pad` and `QA 2026-09-06 — orthophoto region`. Original records remain untouched.
- Distance placement/save succeeded (299 ft 1.158 in displayed). Polygon preview,
  undo, final placement and saving succeeded (7,673.310 ft² displayed). These are
  interaction/conversion checks, not surveyed dimensions.
- The map records remained present with the same values when switching through
  Orthophoto → DSM → DTM. No new production native job was started in this pass.
- Visible orthophoto coverage edges were inspected; existing NoData/bilinear mask
  tests passed. This does not certify an external GIS cutline's topology.

Patched local browser fixture, using shipped UI/store/calculation modules:

- A known 22 × 13 m selection, surface 2 m above reference zero, calculated
  **572 m³**, displayed as **20,199.989 ft³**, with 100% coverage and an isolated
  reference-plane preview. No live site data is used by this fixture.
- Source-error simulation removed the preview and clearly reported that no new
  result was saved. It did not present the previous result as the failed one.
- Populated 3D → empty map cleared SVG markup. Rename followed by units change
  saved correctly. Placement cursor became a crosshair. Collapsing the sidebar
  retained a visible 38 × 38 px reopening control at desktop width.

Additional orthophoto-product support is documented in
[ORTHOPHOTO_CUTLINE_DOWNLOAD.md](ORTHOPHOTO_CUTLINE_DOWNLOAD.md). Known cutline
products are registered on supported import/discovery flows; old imports are not
silently reimported or changed.

The user's later screenshot clarified that the intended “cut line” is an
**elevation profile**. Research and a separate proposed implementation are in
[ELEVATION_PROFILE_DESIGN.md](ELEVATION_PROFILE_DESIGN.md); that chart feature is
not part of this completed bug-fix batch.

Release gates: full Linux regression suite, focused real-raster/access/UI tests,
independent review, then normal source and exact-container CI verification.
The final local Linux run passed **1,238 tests**, with **zero failures** and
**20 explicit environment-dependent skips** (1,258 total). Independent final
browser-header/native-raster review reran nine tests with zero failures/skips.
Windows storage tests require Linux `/proc` mount identities and are not the
authoritative runtime suite. Environment-dependent real-model/browser tests
remain explicitly skipped when their prerequisites are absent.

Still requiring post-deployment verification: actual loaded point-cloud FPS on
the user's hardware, long-duration live Operations renewal, actual restricted
client identity, real-file export inspection, and validated site-volume reference
data. No point-budget change or three-decimal display certifies survey accuracy.
