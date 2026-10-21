# Viewer post-deployment follow-up — 2026-09-06

## Observed deployment

The public health response confirmed revision `6e76e32` after the user updated.
County Road D was reopened through the Viewer workspace. Only one active 3D
viewer was used for the following observations; Operations and workspace tabs
were not rendering another 3D scene.

Point-cloud movement remains slow in both the user's regular browser and Codex's
in-app browser. One dense view showed approximately 7.5 million visible points
and 7 FPS, then adapted down to roughly 244,000 points and 23 FPS. Turning EDL
off did not prevent a later collapse to roughly 216,000 points. Display defaults
were restored afterward. These observations do not establish the expensive
rendering stage, and lowering density is not a successful performance fix.

The new optional Diagnostics control reports application CPU timing for update,
render and point submission, frame cadence, submission counts, estimated point
buffer upload bytes, and framebuffer dimensions. It is off by default and
restores the original methods when disabled. It does not measure GPU execution,
identify hardware, send telemetry, or retain a measurement history. It supports
the next controlled dense-cloud comparison; it is not itself a speed fix.

## Measurement source units: WebODM comparison

WebODM's [unit helper](https://github.com/WebODM/WebODM/blob/master/app/geoutils.py)
reads `rasterio_ds.units[0]` and returns a recognized conversion factor. Missing
or unrecognized units fall back to `1.0`. Its
[volume implementation](https://github.com/WebODM/WebODM/blob/master/coreplugins/measure/volume.py)
integrates elevation differences against a reference base and applies the unit
factor cubed. That fallback is not evidence of the units of a particular import.

Viewer previously checked `VerticalUnitsGeoKey` but did not read the GDAL
elevation band's `UNITTYPE` declaration. The shared browser/native resolver now
also supports explicit band units, reconciles declarations, and records their
provenance. It must not infer vertical units from a horizontal EPSG code, an
import's WebODM label, or an unknown-unit fallback.

Independent review caught two additional numerical hazards, now covered by real
TIFF fixtures: nonidentity GDAL scale/offset and duplicate declarations hidden
by dictionary flattening. The reader validates a bounded flat metadata document
before flattening, rejects ambiguous/malformed declarations and unsupported
scale/offset, and only accepts unambiguous physical elevation units. Browser
user confirmations and native administrator confirmations retain distinct
provenance. No WebODM implementation was copied.

County Road D's live calculation stopped at the missing-unit guard. The user
could not confirm the units, so the confirmation box was left unchecked and no
new volume was saved. Its actual band-unit declaration has not yet been verified.
The attempted DSM download did not produce a download event or a local file;
therefore no successful source-file inspection is claimed.

## Compact controls

Live inspection also found that view switching re-exposed the hidden Layers
panel and that the application still started at Detail 20. The follow-up keeps
the advanced panel dormant across view switches, starts the application at
maximum Detail 24 with memory Auto, and keeps camera toggles compact with
explicit accessible names. The lower-level policy's independent default is
unchanged; memory safety limits remain in force.

## Verification

- Final isolated Linux build and suite: 1,317 tests, 1,297 passed, zero failed,
  20 skipped. No networking or production-data mounts in the test container.
  SHA-256 comparison confirmed the final test image included the current unit
  resolver, browser integration and real-TIFF regression test files.
- Independent numerical review and 17 focused raster/browser/native tests pass,
  including real TIFF meter, foot, US-survey-foot, duplicate and scale fixtures.
- Local browser acceptance: 13 passed, zero failed, four skipped because the
  optional real LOD dataset fixture was not configured. Includes max-detail
  startup, explicit developer Detail 20 scenarios, memory limits, history/view
  lifecycle and photo rendering. This is not a live point-cloud FPS benchmark.
- Diagnostics hooks were checked against the installed Potree method signatures,
  geometry counts and buffer-upload implementation. Synthetic tests cover
  aggregation, opt-in activation and restoration when disabled. A subsequent
  actual-Potree smoke in the in-app browser used 64 synthetic points: one node
  and 64 submitted points, 7.0 ms frame cadence, 0.2 ms update, 0.3 ms render,
  and zero settled buffer uploads at 620 by 500 pixels. Disabling removed the
  timing readout while rendering continued. This verifies the hooks, not dense
  cloud performance. The temporary loopback container and tab were cleaned up.
- Ignored QA logs: `data/qa/unit-diagnostics-lod-browser.log`,
  `data/qa/unit-diagnostics-build-final.log` and
  `data/qa/unit-diagnostics-tests-final.log`.

## Saved-result inspector follow-up

The existing loopback-only synthetic fixture returned the expected 572 cubic
meters (20,199.989 cubic feet), zero fill and 100% coverage. Keyboard inspection
reported the actual sampled surface height of 2 meters above its zero base.
The linked chart visibly marks the selected sample in the plan and side views
and explicitly identifies its reduced-sample limitations. This fixture does
not establish County Road D's units or accuracy.

Reopening a saved result had misleadingly said no volume had been calculated.
The inspector now displays the saved totals and status, labels them as not
revalidated against the current source, and explains that recalculation rebuilds
the preview. Valid saved source/base settings are restored, but unit confirmation
is never silently enabled. Reopening does not calculate or save anything.
This follow-up passed 34 targeted dialog, automatic-calculation, lifecycle and
preview tests plus a Vite build; its saved-result state was verified in the
in-app browser against the synthetic fixture. Production records were untouched.

## Release gate readiness race

The `fc56ddf` release stopped on the existing photo-download permission browser
test. The fixture could observe decoded image dimensions and computed opacity
of one before the queued load callback installed the permitted download state.
The image's opacity transition allowed that computed value even while its
inline loading opacity was zero. The staff permission reached the callback
intact; independent review found no production permission override.

A controlled fixture-only delay reproduced the identical assertion failure with
the old readiness predicate. Waiting for both inline and computed opacity one
passed the same delayed-load case, retaining the staff-allowed and public-denied
assertions. Only the test's completion gate and deterministic race fixture changed;
production authorization was not relaxed. Logs are in
`data/qa/photo-readiness-race-before.log` and
`data/qa/photo-readiness-race-after.log`.

## Remaining acceptance

- Verify the exact County Road D band metadata before accepting its volume.
- Compare dense-cloud CPU diagnostics at an identical viewpoint and viewport,
  with the same material, size and EDL settings and one active 3D viewer.
- Establish the dense-render bottleneck before claiming smooth navigation.
- Source tests and synthetic geometry validate implementation behavior, not
  real-world survey accuracy, source datum, or source reconstruction quality.
- Operations code and production processing/import jobs remain untouched.
