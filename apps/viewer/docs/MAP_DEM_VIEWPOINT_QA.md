# Map, elevation and viewpoint refinement QA

Date: 2026-09-05. Local candidate following the working Viewer release.

## Scope completed

- Orthophoto, DSM and DTM camera positions use a shared canvas/sprite overlay instead of one DOM/SVG element per photo. Every source remains selectable; offscreen painting is clipped without substituting representative photos. Default pin size, orientation, geographic anchors and photo-on-selection behavior remain. A keyboard camera selector makes overlapping and offscreen captures accessible.
- Drawing is coalesced to animation frames, geographic projections are cached, and hide/remove releases drawing buffers and handlers. Measurement interaction passes through; measurements and popups remain above the marker pane. Camera visibility and permissions still gate the layer.
- DEM hillshade now uses actual source-cell ground spacing on both axes, including overview levels and padded tile windows. North-up lighting and missing-data neighbors are handled explicitly. No elevations, measurements, palettes, min/max defaults or shading controls are removed or changed.
- The last valid 3D viewpoint is retained in page memory through orthophoto/DSM/DTM detours, in either model/cloud direction. It is captured before renderer teardown. Cloud-first initialization marks its native view transferable; late callbacks cannot overwrite a newer transfer. Leaving before first source framing does not save an uninitialized camera. Reset View remains intentional. Nothing is persisted across page reloads.
- Point-cloud display additions are documented in [Point-cloud display controls](POINT_CLOUD_DISPLAY_CONTROLS.md): reset, fixed sizing mode, RGB/elevation/classification menu, dual-thumb range with typed values, and decoded classification hover readout.

Accepted model LOD, point-cloud orbit/pan/zoom, Operations, storage/data and new measurement tools are outside this batch. No production model was reimported, deleted or mutated. No commit/push/deployment is part of this local implementation handoff.

## Automated verification

- `test/viewpoint-continuity.test.mjs` executes the shipped transfer/mode-switch functions and native cloud framing with renderer seams: 13 checks, including both map detours, startup races, cloud-first entry and stale retry rejection.
- `test/map-camera-overlay.test.mjs`: six checks including 10,000 records, bounded DOM, exact source selection, keyboard access, animated zoom, interaction pass-through and cleanup.
- `test/dem-hillshade.test.mjs`: seven checks covering physical slope invariance, rectangular cells, light direction, nodata, shared-window boundaries, both render paths and actual overview read-window spacing.
- Display/elevation/wiring focused tests cover reset without camera/measurement effects, class codes and missing dimensions, idle picking/cancellation, typed range validation and fixed-only controls.
- Final Linux integration: **1,082 passed, zero failed, 20 skipped (1,102 total)**, including the completed display controls. Log: `data/qa/map-dem-continuity-linux-final.log`. Source is copied from a read-only checkout mount into a disposable QA container; no network or production data mounts. This is a test/build image, not a published production-image attestation.
- An earlier Windows full run hit Linux-only `/proc` storage descriptor checks and Windows file-identity differences. Do not mistake that run for a passing full suite. The equivalent Linux storage/viewpoint smoke run passed 30 checks; the first Linux integration pass passed 1,082 tests, failed none and skipped 20 environment-dependent checks.

## Browser observations

The local actual-Leaflet fixture `test/fixtures/map-camera-overlay-preview.html` compared 10,000 synthetic positions on one site footprint. All were visible at overview. No source photos or production services were used.

| Renderer | Sampled frame interval p95 | Worst sampled frame interval | Long tasks |
| --- | ---: | ---: | ---: |
| Shared canvas | 34.7 ms | 100.4 ms | 0 |
| Previous-style DOM/SVG pins | 180.5 ms | 2,819.4 ms | 8 |

These are single-run local requestAnimationFrame/PerformanceObserver measurements from a scripted pan/zoom sequence, not GPU profiling or a production FPS guarantee. Long stalls can stretch the nominal seven-second test; do not interpret these numbers as an exact throughput multiplier. The specialized DevTools trace connection was unavailable. The performance skill therefore informed source/network separation and a measured local comparison, not a claimed full performance trace.

Browser keyboard selection reached the last of 10,000 source records and selected the exact source; hiding removed the canvas/control and reported zero painted markers. Existing production-style camera browser assertions now check the shared canvas and stable geographic/source identities rather than DOM pin count.

The synthetic DEM browser fixture successfully rendered both DSM and DTM with opaque valid pixels. In the actual Potree material fixture, typed bounds changed the shader's elevation range and keyboard movement changed a bound; display reset restored RGB and automatic bounds. That 64-point fixture retained its loading-health overlay and reported a MutationObserver error, so its material checks are not an end-to-end rendered-cloud/hover acceptance result. No production health/navigation behavior was changed to bypass that limitation.

The isolated display fixture verified both thumbs through actual mouse drags on the shared track, typed/keyboard updates, reset and settled synthetic ground/building readouts without browser errors. Its inputs are synthetic decoded values; it is not classified-EPT GPU acceptance.

## Required production acceptance

1. Rome/Church: camera overlay off/on in ortho, DSM and DTM; pan, wheel zoom and select a photo. Confirm expected default pin size and no interfering measurement clicks. Test a zoomed-out whole-site view as well as a close view.
2. Compare DEM relief at the same ground scale, color palette and min/max bounds. The supplied screenshots used different color minima (roughly 673 versus 712 feet), so color matching alone cannot establish raster/detail parity.
3. Start on cloud, move, visit each map mode, then return to model; reverse the order too. Include rapid switches before first load and during loading. No reload persistence is expected.
4. On a classified cloud, hover known ground/vegetation/building points in Classification mode. Confirm actual class labels/codes, unavailable data and empty-space behavior. Unclassified photogrammetry data cannot acquire semantic labels through this UI.
5. Use both elevation handles with mouse/keyboard and both number fields; reset display after changing size, range, color and shading. Camera viewpoint and measurements must remain intact.

Real Rome shading parity, live classified-EPT picking and representative production-device performance remain user acceptance checks. No claims of complete production parity or zero stutter are made from synthetic fixtures.
