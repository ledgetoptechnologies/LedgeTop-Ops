# Stockpile server workflow and point-cloud refinement — in progress

This is a working QA record, not a release or completion attestation.

## User requirements

- Ordinary stockpile workflow: outline the pile, receive volume and an honest
  side-section preview, without routine exposure to server job mechanics.
- All normal stockpile volume calculations use the Viewer server worker, for
  staff and authorized clients, with a separate ephemeral lifecycle needed for
  public/temporary measurements. This does not grant general processing authority.
- Preserve personal ownership and immutable model/version/revision scope.
- Point-cloud movement is now reported smooth by the user. The remaining
  reported problem is insufficient local refinement when zooming closer.
  Preserve the working controls and do not substitute a lower density.

## Local implementation

- The production normal surface inspector selects the server calculator through
  a direct, scoped Viewer-bearer client. Missing/delayed authority or a failed
  request cannot silently select browser volume calculation.
- The signed-in personal raster path is implemented locally. Verified individual
  staff/client sessions can create/list/read/cancel only their own native DSM/DTM
  surface jobs on the authorized immutable model version. They do not receive
  import, reprocessing, reconstruction or general processing permission.
  Advanced methods retain the separate matching-person staff capability.
- Public-link and temporary-identity server calculations are implemented locally
  through the separate schema-33 `ephemeral_measurement_jobs` lifecycle. They
  require valid measurement access, the exact displayed model version and a
  hashed random per-page handle; shared raster sources must be published.
  Same-page recovery uses measurement-scoped lists and geometry hashes with
  fixed-order CRS/unit values. Refresh creates a new handle and restores no old
  public records. No permanent personal row or synthetic individual is created.
- Temporary results/work expire after at most fifteen minutes or earlier grant
  expiry; refresh/close does not promise immediate server cancellation. The
  private and temporary lanes share the global twenty queued/running-job ceiling
  and existing heavy-job admission. Temporary retention additionally caps forty
  rows per grant/version scope. Source-suite checks have passed; deployed
  lifecycle acceptance remains pending.
  No Operations repository changes were made.
- New polygons save first, then open their automatic surface calculation. Opening
  an existing polygon does not submit a new job. Recovery lists existing work
  before creating a job, and an accepted job is observed through its identifier.
- Results must match the source, model version, base and saved geometry/revision.
  The exact completed result already attached to unchanged geometry can also be
  recovered at a later document revision when the server provides matching
  attachment-revision evidence; arbitrary historical results are not reused.
  Switching views, closing or losing access retires the observer; it does not
  falsely claim that an accepted server job was cancelled.
- Normal inspector resume/cancel is implemented locally: before submission, the
  helper checks revision and source/base/unit parameters for queued, running or
  completed work, including the verified attached-result exception above.
  Matching work is observed/retrieved rather than
  deliberately duplicated; a create race triggers another check. Different
  active settings expose cancellation in the ordinary inspector. Closing stops
  observation; reopening and calculating with the same settings resumes it.
- Recognized unit/source/raster/conflict errors survive the broker and channel as
  exact allowlisted codes. Raw server messages and unknown codes are not exposed.
  The ordinary inspector maps common errors to plain-language guidance.
- Explicit nonmetric horizontal units are no longer overridden by a UTM code in
  native server raster validation.
- Missing vertical metadata remains an explicit guard. An ordinary server metre
  assertion is recorded as `requester-declared`, not falsely attributed to an
  administrator. Separate staff authority retains `administrator-declared`.
  Neither declaration is independent proof of the actual source units.

## County Road D: live observation

The deployed ababb06 Viewer normal surface inspector was tested on the existing
`QA 2026-09-06 — feed pile` measurement. It rejected calculation because the raster
does not encode recognized elevation units. The confirmation remained unchecked;
no result or geometry was changed. Running the same raster on the server alone
does not establish its units.

Current import records preserve source hashes and provider labels, but not an
authoritative vertical-unit pipeline contract. Provider name, filename, horizontal
EPSG, or an ODM software tag is insufficient evidence by itself. Original data
must not be silently modified or reprocessed to work around this.

### Read-only source inspection handoff

On the exact immutable County Road D version, inspect:

1. DSM band unit, VerticalUnits GeoKey and any vertical CRS/WKT declaration.
2. EPT `srs.wkt` vertical axis and retained georeference summary/info metadata.
3. Original WebODM task generation metadata/logs, if available, including engine
   version, alignment/GCP/geolocation settings and the DSM's exact hash.

Return the declared vertical units and the evidence bound to that asset hash.
If absent, report absence instead of confirming meters. Do not edit Operations
code, metadata, source TIFFs, share grants, or processing jobs for this inspection.
Future import work should retain a small verified unit-provenance record bound to
the immutable asset; nontechnical users should not repeatedly configure it.

## Live cloud observations before the new selection patch

One Viewer cloud frame, RGB, fixed size 1, requested budget 10M, EDL initially on;
framebuffer 875 × 822. App diagnostics measure CPU stages, not GPU execution.

| View/sample | Submitted points | Frame mean/max | Update/render | Uploads |
| --- | ---: | --- | --- | --- |
| Initial settled broad view | 7,456,299 | 11.8 / 17.9 ms | 0.3 / 0.6 ms | 0 |
| After orbit | 9,968,515 | 15.6 / 28.3 ms | 0.3 / 0.8 ms | 0 |
| Closer view after adaptation | 4,808,466 | 22.4 / 56.5 ms | 0.4 / 0.8 ms | 0 |
| Temporary EDL-off sample | 5,583,898 average | 25.0 / 55.6 ms | 0.4 / 0.8 ms | 0 |

These are sequential UI observations, not a controlled before/after benchmark.
They do not establish a GPU bottleneck or demonstrate that adaptation fixes the
reported issue. Display defaults were restored and the Viewer returned to DSM.
The diagnostics button was obscured by parent reset/fullscreen controls; it was
activated via keyboard. Local CSS now reserves that top-right control space.

## Selection regression

The installed pinned Potree visibility routine allowed level <=2 nodes to bypass
visibility/budget decisions and broke the entire traversal when one node exceeded
the remaining global budget. An off-screen node could therefore starve local
detail. The build-time patch removes the coarse override and skips an oversized
subtree while continuing eligible siblings. Parent-first additive traversal and
the requested ceiling remain intact.

Actual installed-routine tests reproduce 0 or 50k selected points with the old
code where a visible 60k node should fit a 100k budget; the patch selects 60k.
These tests stub geometry/render I/O and do not prove dense live rendering.
Independent review identifies remaining-frontier traversal CPU cost as a live
verification requirement.

The local patch also reports per-cloud, spatially eligible budget-blocked demand
and whether selected ancestor geometry is actually drawn/settled. The adaptive
budget can make a bounded recovery probe even below 70% population when a whole
eligible additive node cannot fit the remaining budget. Empty/loading scenes or
off-screen nodes do not justify growth. Requested ceilings, overload rollback
and backoff remain in force. This addresses a selector/adaptation deadlock;
installed-routine fixtures are not proof of live dense zoom performance.

## Historical verification: pre-unified b234083 snapshot

- Pre-unified source-bearing isolated Linux image: 1,407 tests, 1,386 passed, zero
  failed, 21 environment-dependent skips; process exited successfully. Log:
  `data/qa/stockpile-server-source-tests.log`. Network disabled, no production
  data mounted. Includes the actual patched Potree bundle and schema 33.
  Skips require Chromium/real tile fixtures or a host-bind environment; they
  are not counted as passing browser/deployment tests.
- Later helper/direct-client/dialog focused tests: 46 passed, zero failed.
- Actual installed-Potree selector/demand tests: 35 passed, zero failed/skipped.
  Geometry/render I/O is isolated; this does not establish real dense GPU timing.
- Production-contract checks: 9 passed, zero failed.
- Separate pre-unified Windows/headless browser regression run: 43 tests, 39 passed,
  zero failed, 4 skipped for the unavailable real tile dataset fixture. Includes
  model detail/foreground retention, camera-photo rendering, history/refresh
  teardown, KTX2/CSP, normal server inspector, public project sharing, session
  renewal and desktop/mobile workspace/download recovery. Log:
  `data/qa/stockpile-final-browser-tests.log`. This is isolated test data, not a
  deployed County Road D performance or volume acceptance test.
- Isolated real headless-browser inspector tests: 4 passed, zero failed/skipped.
  Shipped helper, direct client, dialog and styles call only a synthetic loopback
  API. Covered queued/completed recovery without duplicate submission, result
  presentation and keyboard-inspectable sampled chart, missing-unit error without
  guessed confirmation or fallback, and cancellation without a new result save.
  This verifies UI/transport behavior, not real raster integration accuracy.
  Screenshot `data/qa/stockpile-server-browser-inspector.png` was visually checked.
  Windows retained locks on disposable browser profiles; cleanup reported those
  locks instead of forcing unrelated deletion.
- These are separate focused snapshots, not additive final-suite totals.
- Private/temporary backend checks: 28 passed, including direct client/helper
  through HTTP and worker result delivery, geometry-hash agreement, exact-version
  rejection and older active-job recovery without personal-row creation.
- The b234083 production image was subsequently published and deployed, as
  recorded in the live follow-up below. Later unified-inspector commits e8db2c3
  and harness correction 1309fb6 were pushed; their source publication is not
  proof that a candidate image passed exact-runtime verification or promotion.
- An initial attempt to run the whole source suite in the production-only image
  lacked test source/dev dependencies. It is invalid QA, not a passing gate; its
  exact disposable container was stopped after the corrected source-image run.
- The Windows full-suite attempt finished unsuccessfully. Observed failures
  included Linux-specific `/proc/self/fdinfo` expectations and browser timeouts;
  not every failure has been classified. Do not conflate it with the Linux run
  or label all failures environmental without evidence. The subsequent isolated
  browser run above passed the previously timed-out lifecycle and KTX2 cases.

## Follow-up live QA on deployed b234083

The root agent tested County Road D after opening a fresh authorized Viewer
session. The cloud contains approximately 17.5 million source points. Only one
3D Viewer was active for these observations: RGB, fixed size 1, EDL on, requested
and active budgets both 10 million, framebuffer 875 × 822.

| View/sample | Submitted points | Selected nodes | Reported FPS | Frame mean/max | Update/render |
| --- | ---: | ---: | ---: | --- | --- |
| Settled baseline | 7,456,299 | 178 | 144 | 6.9 / 7.4 ms | 0.3 / 0.7 ms |
| First closer view | 9,999,463 | 235 | 144 | 6.9 / 7.6 ms | 0.5 / 1.0 ms |
| Second closer view | 9,986,128 | 284 | 144 | 6.9 / 7.6 ms | Not recorded |
| After orbit | 9,551,383 | 276 | 144 | 6.9 / 7.5 ms | Not recorded |

These samples demonstrate selection changing toward finer nodes while zooming
in this live session, with responsive reported frame timing and without reducing
the configured budget. They are sequential UI observations, not a controlled
GPU benchmark or proof of performance on every dataset/device. The diagnostics
measure CPU stages and frame intervals, not GPU execution time. Comparison with
the earlier observations is not a controlled before/after experiment.

The live native-server Calculate action on an existing QA polygon returned a
clear missing-verified-height-units error. The confirmation checkbox stayed
unchecked; no new volume was saved. All five saved measurements remained present
when switching DSM to orthophoto. Thus server routing and honest source-unit
failure were exercised, but a successful County Road D stockpile volume has not
been independently verified.

The live five-record list measured approximately 409 px client height and
1,069 px scroll height. The first two cards measured 247.156 px and 149.172 px;
the custom scrollbar used orange `rgb(238, 80, 7)` on a transparent track. This
checks the actual first-two-card sizing/custom scroll treatment in that session,
not every screen size or accessibility mode.

### Local follow-up: unified Measure inspector and attached-result recovery

The follow-up patch is separate from the deployed b234083 observation above.
Polygon rows have one **Measure** action opening the common inspector. Authorized
staff can expand specialist methods inside it rather than opening a competing
row action or a second modal; clients do not receive those specialist controls.
Opening the inspector or expanding specialist settings must not itself submit
work. Backend method authorization remains independent of this UI presentation.

The local recovery fix permits retrieving the exact completed job already
attached to unchanged geometry after saving that result advances the private
document revision. Server-provided attachment-revision evidence is required;
an arbitrary older result is not treated as current merely because its ID was
supplied by a browser.

Expanded isolated headless-browser tests passed **6/6, zero failures or skips**
in approximately 4.9 seconds. They retain queue/error/cancel coverage and add
client/staff single-action/common-inspector checks, authorized inline specialist
mount/collapse, and the shipped workspace/store result-attachment sequence:
revision 1 calculation, revision 2 attachment, reopen/retrieve, revision 3
attachment without a second calculation POST. This uses synthetic scoped HTTP
responses; backend authority/source validation is tested separately. No browser
runtime exceptions remained after supplying the complete synthetic map context.
Screenshots: `data/qa/stockpile-measure-unified-browser.png`,
`data/qa/stockpile-measure-unified-browser-client.png` and
`data/qa/stockpile-measure-unified-browser-staff.png`.

Final integrated follow-up verification:

- Source-bearing isolated Linux build succeeded, with networking disabled and
  no production data mounted. The complete source suite exited successfully:
  **1,420 tests, 1,399 passed, zero failed, 21 environment-dependent skips** in
  approximately 55 seconds. The installed Potree selector tests ran without
  skips. Log: `data/qa/measure-unified-source-tests.log`.
- Separate final browser/lifecycle command exited successfully: **31 passed,
  zero failed/skipped**, including six real-browser checks and 25 lifecycle
  checks for measurement storage, capture and specialist dialogs.
- Independent review caught a specialist-collapse/in-flight-save race. The
  parent inspector now reconciles the successful save's revision even after
  that section closes, and a subsequent surface calculation waits for the save.
  Inline specialist history excludes native-raster jobs and never silently
  attaches an unrelated historical result when the section is opened.
- The first focused source-fixture run had six failures because its extracted
  workspace fixture lacked the new specialist capability variable. The fixture
  was updated, authorization/race coverage was expanded, and the complete final
  source run above passed. These failures are not counted as passing tests.

The earlier deployed b234083 observations do not prove deployment of this
follow-up. Its image publication is verified separately by the release workflow.

The first follow-up release check (run 34159211428) stopped before image build:
1,424 tests passed, one browser-harness test failed, and 13 were skipped. Its
initial readiness predicate accessed `document.body.dataset` before Chromium
created the body. The harness now waits for the exact destination URL and a
present, ready DOM, preventing both null-body errors and premature readiness
from the previous fixture page. Three deterministic regressions preserve real
evaluation-error propagation. The corrected browser/lifecycle run passed
**34/34, zero failures/skips**. No production code was changed for this harness
correction, and the failed run did not promote any image tags.

The second follow-up release attempt (run 34159775858) passed its source checks
and built the candidate, then stopped during exact-runtime verification:
**44 passed, one failed, zero skipped**. A newly expanded server integration test
imported raw frontend `measurement-store.mjs` from the production image root,
where frontend modules are bundled rather than retained as raw source files.
The failed test therefore crossed the source-test/runtime-test packaging boundary.
The source-only integration is being separated from runtime-only backend coverage;
the proposed correction does not skip the test or mount raw application source
over the candidate. That correction and its final counts are **not yet verified**
in this record. Source-check success and candidate construction alone do not
establish exact-image acceptance or tag promotion.

### Corrected local production-runtime verification

The container-test packaging correction keeps raw frontend/store integration in
the full source suite and retains backend attachment-revision coverage in the
exact-runtime suite. A source contract now rejects literal imports of unshipped
modules from exact-runtime tests. The locally rebuilt production image passed
**45/45 runtime tests, zero failures/skips**, with networking disabled and only
the read-only test folder mounted. Log:
`data/qa/measure-unified-runtime-tests.log`. Building the image required normal
dependency-download access; an earlier offline build lacked cached dependency
layers. A local pull of the CI candidate was rejected by registry credentials,
so this local rebuild is not an attestation of the registry candidate digest.
The release workflow must still independently verify and promote its own image.

That independent release subsequently passed in run **34160705830**, source
commit `366f88e948a4442192c99903ce9d0d64fb789922`. The promoted image was
`ghcr.io/ledgetoptechnologies/3d-viewer:sha-366f88e`, digest
`sha256:cb3570176f0898efaf986ccebb94379fb06faf11faf82fbee5dee395a4c8bb89`.
Its downloaded attestation confirms source checks, pull-by-digest, source stamp,
rootless runtime, schema 33 and native runtime verification. This release
contains the unified Measure/recovery work, not the subsequent close-up fix.

## Close-zoom polygon overlay regression: live reproduction and local check

In a later live County Road D session, the root agent reproduced a display-only
failure while all five saved measurement records remained listed. The initial
close view had no visible boundary. Two zoom-out wheel inputs (+234, then +363)
restored the SVG overlay: 33 children and two polygons, with a yellow boundary
visible in the screenshot. Zooming back in (-507 at screen position 845, 530)
left the overlay with zero children/paths while the five measurement articles
remained. This is not evidence that measurement data was deleted. The root agent
left the live tab at that close view and made no measurement writes.

The local correction clips each original boundary segment in homogeneous camera
space rather than discarding a whole measurement when a corner crosses behind
the camera/near plane. Clipped fill is not stroked: a viewport or near-plane cut
must not become a fabricated measurement edge. Only surviving original vertices
receive point handles. This follow-up is separate from the deployed b234083
point-cloud observations and must not be presented as already verified live.

`test/measurement-closezoom-browser.test.mjs` passed **1/1, zero failures/skips**,
exit 0, in approximately 3.66 seconds. It launches an isolated headless browser
and loads the shipped workspace/projection helper with a real Three.js
perspective camera and synthetic saved polygon. Its sequence verifies:

- Four original edges/handles when fully visible.
- Three original edge segments and two original handles when the other corners
  are behind the camera or inside the near plane.
- Finite, viewport-bounded SVG coordinates; no artificial closing edge; the
  visible front edge matches an independent analytic pinhole projection.
- All-behind geometry clears, then zoom-out restores the complete boundary.
- Canonical store JSON is unchanged and all API requests are reads.

Screenshot `data/qa/measurement-closezoom-boundary.png` was visually inspected.
The initial test fixture had an invalid unparenthesized arrow-return object;
that fixture syntax was corrected before the passing run. No source geometry,
live browser or production data was changed by this isolated test. Final integrated
tests and deployed close-zoom acceptance of the correction remain separate gates.

### Final integrated close-up-fix checks

- Isolated Linux source build and complete suite: **1,436 tests, 1,414 passed,
  zero failed, 22 environment-dependent skips**, exit 0, approximately 56 s.
  Network disabled; no production data mounted. Log:
  `data/qa/measure-closezoom-source-tests-final.log`.
- Separate real-browser/projection/store/capture/specialist lifecycle suite:
  **44 passed, zero failed/skipped**, approximately 8.7 s. This includes the
  new close-up browser case and existing unified-inspector checks.
- The preceding full run caught an extracted adapter fixture missing the new
  projection-helper dependency. It was corrected to use the actual helper, with
  extra boundary visibility and zero-layout-read assertions; no production
  behavior was relaxed to make the test pass.

## Not yet proven

- Actual County Road D stockpile units and independently checked live volume.
- Broader dense-cloud refinement/navigation acceptance beyond the representative
  deployed b234083 County Road D zoom/orbit observations above.
- Live/deployed acceptance of the normal inspector's resume/cancel flow beyond
  the isolated synthetic browser checks.
- Live/deployed public/temporary lifecycle acceptance: refresh reset,
  exact-version and per-measurement scope, expiration/revocation and shared
  admission/resource bounds.
- Native full-resolution cross-section/profile behavior requested for detailed
  stockpile inspection. The current chart is explicitly a reduced-sample preview;
  it must not be described as a complete continuous terrain profile or as proof
  of independent volume accuracy.
- Deployed close-zoom boundary clipping and measurement-handle behavior beyond
  the isolated perspective-camera regression above.

The thread goal remains active.
