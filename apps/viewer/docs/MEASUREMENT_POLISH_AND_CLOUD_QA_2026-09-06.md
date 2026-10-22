# Measurement polish and point-cloud follow-up — September 6, 2026

## Scope and ownership

Viewer-only changes. Operations remains untouched. Existing Operations renewal
and stable-person identity work stays in
`OPERATIONS_RENEWAL_QA_FOLLOWUP_2026-09-06.md`. No client processing authority,
sharing changes, production import/reprocessing, or production deletion is part
of this batch.

## Delivered behavior

- The saved-measurement region naturally fits zero through two records. Three
  or more use the measured height of the first two cards, including wrapping,
  with a slim orange native scrollbar. Outer sidebar scrolling remains usable
  without an additional visible track; forced-colors accessibility is retained.
- Controls, units, edit actions, exports and record actions are aligned and
  grouped. Export selection and Show/Hide are explicitly different actions.
- A completed polygon saves before automatic surface calculation. Distance
  measurements do not trigger volume. View changes, access loss, new drawing,
  stale saves and dialog closure cannot commit an obsolete calculation.
- The surface inspector is centered, responsive and separates results from
  settings. It presents a reduced-sample corridor cross-section with linked
  plan-view inspection and a lazy, isolated 3D-region preview. See
  `ELEVATION_PROFILE_DESIGN.md` for the remaining full-profile scope.
- Hidden/inactive Potree frames no longer run their update/render loop. Empty
  camera overlays skip their render pass. Picking restores material and bounds
  accumulated timing entries without adding successful-pick GPU resets.
- Stationary measurement overlays skip repeated projection/layout and sorting.
  Empty or entirely hidden collections do no viewport reads or point projection.
  Moving views, edits, units, resize and collection changes invalidate the cache;
  access expiry is checked before caching, and captures force a fresh overlay.
- Density recovery no longer requires sustained >45 FPS. Healthy populated
  frames near 23–30 FPS can probe additional density; failed probes roll back
  and back off. This preserves the requested 10M target without forcing a
  genuinely overloaded device to render all ten million points.

## Browser evidence

Tested the signed-in County Road D WebODM workflow and the current live Viewer,
then the candidate's actual shipped measurement modules in a localhost fixture.
The fixture has synthetic geometry and a mocked private-record API, not a
production accuracy benchmark or client-identity test.

- WebODM Finish automatically produced perimeter, area and volume for one
  temporary polygon. Its default base was Triangulate, with Plane/Average/
  Highest/Lowest options. The manually drawn boundary was not identical to a
  Viewer boundary: comparing the totals would not establish numerical parity.
- Candidate localhost: two saved map distances had equal scroll/client height
  and no inner overflow. A third polygon caused the two-card scroll region;
  computed scrollbar color was the application's orange with transparent track.
- Finishing the polygon opened and calculated the inspector automatically.
  Real chart hover showed station, elevation, base, delta and source coordinates.
  Keyboard stepping also worked. Initial sparse preview selected 11 of 66
  retained samples rather than opening on an empty between-row corridor.
- Simulated missing source/vertical units showed an explicit error, no preview
  and no newly saved volume. No automatic meters confirmation occurred.
- The seeded 22 m by 13 m region, surface 2 m above a custom zero base, displayed
  20,199.989 ft³: the expected 572 m³ converted to the selected display units.
  This checks the browser calculation/formatting path, not real-world accuracy.
- Desktop screenshot checks used 1280 by 720. A requested narrow viewport
  override did not change the observed viewport, so mobile pixel QA is not
  claimed; the temporary override was reset.

## Performance evidence and limits

History comparison against ad67868/4517d53 showed the same Potree generation,
fixed one-pixel sizing, EDL default and 10M requested budget. Those are not newly
introduced defaults. The octree already prioritizes projected visible size;
there is no demonstrated new farthest-first loading policy.

On the existing b38f0c1 deployment, one observed view had about 5M visible points
at approximately 6–11 FPS, then fell to roughly 244k points and 22–24 FPS. That
is evidence of the user's sparse/slow tradeoff, not evidence that this candidate
fixes active dense-cloud rendering. A small EDL on/off comparison at the low
point count only changed the displayed FPS slightly. Concurrent WebODM and
standalone cloud views confounded later samples, so they are not controlled
performance comparisons. Temporary extra 3D tabs were closed/returned to 2D,
and the live Viewer display defaults were restored afterward.

The density recovery defect is reproducible in deterministic tests: the old
policy could remain sparse indefinitely at an otherwise healthy 23–30 FPS.
The candidate probes upward with rollback/backoff. This fixes a proven recovery
problem; it does **not** identify the original active dense-render bottleneck.
Full GPU tracing was unavailable through the permitted browser tooling.

Instrumented overlay tests additionally show that 100 stationary ticks for a
two-point measurement require one viewport read and two point projections, not
100 redraws. Empty/hidden collections require zero viewport reads/projections.
This removes measured redundant work; moving views still redraw their geometry.

## Follow-up acceptance on the deployed candidate

Use the same County Road D viewpoint, viewport, RGB, fixed size and EDL setting
with only one active 3D viewer. Record visible points, active/requested budget,
node count and FPS before/after an identical orbit, pan and zoom sequence. Repeat
in the user's regular browser and the in-app browser. Confirm point density
recovers after transient stalls instead of remaining at the minimum. Do not
claim success merely because the active point budget was reduced.

Long-idle Operations renewal and authenticated client identity should be checked
after the other agent's coordinated changes. A reduced preview does not replace
a native-resolution elevation transect; real-world survey accuracy requires
verified units, datum, source quality and an independently measured reference.

## Verification results

- Final isolated Linux build and full suite: **1,303 tests; 1,283 passed,
  zero failed, 20 skipped**. The container had networking disabled and no
  production data mounts. Build completed successfully.
- The first candidate run caught an inline point-cloud syntax error. Both
  mismatched call delimiters were corrected, its navigation fixture was updated
  to load the actual helper, and the final full rerun above passed.
- A new parse gate covers executable inline scripts in all eight current HTML
  entry/fixture files; Vite alone does not parse copied public-page scripts.
- Independent overlay/lifecycle review: 28 focused tests passed, no remaining
  concrete blocker. A separate review found the asynchronous native-dialog close
  race; synchronous abort plus delayed-close-event tests now cover all close paths.
- Local QA logs (ignored, not shipped):
  `data/qa/measurement-polish-build-final.log` and
  `data/qa/measurement-polish-tests-final.log`.

## Research references

- [OpenDroneMap stockpile-volume workflow](https://docs.opendronemap.org/tutorials/#measuring-stockpile-volume)
- [WebODM volume implementation](https://github.com/WebODM/WebODM/blob/master/coreplugins/measure/volume.py)
- [Nielsen Norman Group scrolling guidance](https://www.nngroup.com/articles/scrolling-and-scrollbars/)

These informed interaction and source/base semantics; no WebODM implementation
was copied into the Viewer.
