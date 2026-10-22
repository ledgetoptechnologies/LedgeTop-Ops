# Measurement acceptance follow-up

## September 27: edit map-created outlines in Model and Point Cloud

- The prior cross-view release recovered display placement but deliberately kept an origin-family edit guard. That guard prevented the user's map-created outlines from being edited in Model or Point Cloud, even when visible.
- Map-created outlines now edit in either 3D view once placement is ready and the coordinate reference matches. Drag/insert/delete handles use a transient display-height array; saved vertices remain horizontal E/N/0 with the original collection, source and coordinate reference. True spatial measurements still require a 3D view for editing so map picks cannot erase their measured heights.
- Unchanged Finish performs no write or revision bump and retains the existing result. A changed outline saves once, invalidates its old volume and requires explicit recalculation. No calculation is started by editing. Cancelled gestures, view changes during a drag and sub-threshold click jitter restore both stored-coordinate and display-coordinate previews.
- Verification: 118 focused tests passed with zero skips, including cross-view editing, canonical height separation, result preservation/invalidation, access loss, placement/CRS guards, array synchronization and rollback. The real-browser close-zoom/editor/sidebar suite passed 4/4, including actual mesh ray picks and resident-cloud picks for map-created outline editing. Its initial drag failure was fixture-only root scrolling; constraining the synthetic sidebar kept the drag target in view and retained all behavioral assertions. Production build and diff checks passed with existing dependency/chunk-size warnings.
- No production measurement was edited during testing. Release/deployment and a non-mutating live edit-mode check remain separate from these local results.

## Cross-section follow-up release

Run 36291222027 succeeded for `2559595f22821b8b7bcf5242144d25902fad8534`.
Attestation confirms promoted digest `sha256:eb8a5a8f09e14aa0d147476d4b86063ac765e84c61c197505d0974f1a69cb415`,
schema 33 and all repository/exact-image runtime gates passed. This is release
verification, not deployment or live acceptance of the declared-height profile fix.

## Post-update 6161d11 acceptance

- Public health confirms revision `6161d1147af34f2081fc5ed606e0eac5aa2283fe` after the operator update.
- Fresh Hickory Grove session displays Reports / Measurements report; workspace original-PDF action displays Model report.
- Both saved records restore. Larger Feed Pile remains 36,268.307 ft² with net volume 174,886.944 ft³; opening View volume does not change those values.
- Its staff-authorized cross-section progressed past the former inaccessible-parent error into reading original elevation data, then the browser rejected the returned administrator-declared provenance. This exposed a presentation validator that allowed only encoded vertical units. The follow-up accepts the explicit declared basis without relabelling it and requires exact agreement with the parent source; server permission gates are unchanged.
- Follow-up validation: 52 focused tests, 2 runtime import guards, 9 native-profile browser tests and production build passed. Added regressions cover unchanged saved volume, profile-only creation, cached section reuse, honest CSV provenance and rejection of encoded/declared parent mismatches. Live success still requires deployment of this follow-up; the inspector was closed without a volume recalculation or measurement edit.
- Both legacy map outlines still show missing DSM elevation-unit warnings; the new release does not retroactively supply absent boundary heights. Source evidence remains required.
- A subsequent in-app point-cloud observation on 6161d11 is NOT a navigation/performance pass: requested budget stayed 10M, while reported 1 FPS caused adaptive active budget reductions to 5M then 2.5M. Diagnostics reported low CPU update/render times, but no GPU timing or reliable foreground-throttling evidence was available. No renderer change was justified by this observation. Diagnostics were disabled and the model view restored; do not substitute this reduced-budget observation for the historical full-budget checks.

## Latest release outcome

Corrected release run 36281370710 succeeded for `6161d1147af34f2081fc5ed606e0eac5aa2283fe`.
Attestation confirms promoted digest `sha256:b5ba0e9795feaf4b89f291d0c9152c14fc52b88988f19958ab93f4975e38d4c0`,
schema 33, runtime user 568:568, repository checks, pull-by-digest, revision/source
stamps, runtime schema, Obj2Tiles and Potree checks all passed. Deployment and
legacy Hickory Grove height evidence remain pending. This supersedes earlier
in-progress release notes below; this post-release note is not a new release commit.

## September 26 follow-up (released source; deployment not verified)

Current source is `8ea6bb5` on main. Report release `df41184` passed candidate verification and promotion; its image digest is `sha256:412fcc6b1f480b134b7a3072c8dbc997a9d3525692034a32df96eafc808814db`. The subsequent measurement-fix release is run 36280901503; consult its current status rather than treating this note as completion. The Hickory Grove section at the end supersedes the earlier missing-card-status and browser-connection observations below. No current-deployment claim follows from either push.

- Final isolated Linux current-source verification: production build passed; 1,665 tests, 1,625 passed, zero failures, 40 explicit environment/opt-in skips (browser/Potree/native Poisson/host-bind infrastructure). Source was copied from a read-only worktree mount into disposable container storage; no network or production services were used. The full log is retained locally under output/linux-current-source-full-tests.log and is not part of the release. Windows browser evidence above complements Linux's browser skips; the Windows full suite cannot pass Linux descriptor-storage fixtures.
- Updated four-page synthetic report with both images and six measurements was rendered and all pages visually inspected. A discovered orphaned appendix edge-length line was fixed with print grouping; the rerender has no clipped or orphaned details. Renderer tests pass 8/8; isolated report-only browser stress case passes 1/1. This is layout evidence, not customer numerical data.
- Original-PDF workspace actions now consistently read Model report. Focused workspace tests pass 30/30; rebuilt desktop/390px/320px browser suite passes 13/13. Initial browser label failure was the stale pre-change dist build and passed after rebuilding.
- Latest broader measurement and product-download suite: 383 passed, zero failures, two skipped native reconstructed-estimate cases (385 total). Isolated browser checks produced a 96,486-byte PDF, 30,694-byte measured-view PNG, and native profile downloads. These are fixture results, not live Hickory Grove acceptance.
- Latest report capture/ortho/document regression group: 32 passed, zero skipped. Branding now uses Ledge Top Drone Services; orthophoto errors remain visible when current-view capture succeeds, and repeated warnings are deduplicated. Production build passed with existing dependency/chunk-size warnings.
- User supplied actual Bright Side Dairy Farm PDF and measured-view PNG exports, resolving the earlier uncertainty about native download delivery. This does not validate every report layout or browser.
- Report document/orthographic capture/product download tests: 30 passed, zero failures or skips. Original processing PDFs remain unchanged and require the existing download authorization; report availability is not raw-asset publication.
- Cross-view workspace and display-elevation tests: 22 passed, zero failures or skips. These cover shared lists, bounded sampling, cancellation, coordinate matching, and preservation of saved geometry/results.
- User confirmed the Hickory Grove DSM measurement is listed in the 3D saved list but its outline is missing. Live inspection subsequently confirmed the missing-height-unit warning on both saved cards. The reviewed raster fallback registry currently recognizes only the exact County Road D source. No Hickory Grove unit assumption or saved-data change was made.
- Live browser reconnection initially timed out, then succeeded. Do not treat isolated test success as proof that the Hickory Grove overlay issue is resolved.
- Inspected both pages of the existing synthetic report PDF: readable summary and appendix without clipped table text. That artifact predates the latest branding and warning fixes; updated visual acceptance remains required.

Deployed application source: `fae0935`. The post-update section supersedes historical deployment blockers below. Additional local test changes are identified separately; native in-app download/print delivery and overnight recovery are not assumed complete.

## Current requirement ledger

| Requirement | Evidence | Remaining limitation |
| --- | --- | --- |
| Two visible measurement cards, orange overflow, resizable navigation | 39-pass layout/editor/capture/profile browser group; measured deployed two-card height and orange scrollbar in chronological audit | No claim for every viewport or assistive technology |
| Immediate polygon area, explicit Calculate volume; existing result View volume | Latest user direction supersedes original automatic-volume wording; deployed five-record restoration and Polygon 1 View volume | No implicit recomputation is permitted |
| Interactive honest side-section | Deployed 0-degree/45-degree/reset native-cell checks; post-update 4,209-cell section; saved volume unchanged | Vertical datum remains unverified; this is a section, not an independent volume |
| Numerical stockpile consistency and larger outline | Exact original DSM replay within 0.2183 m3 of WebODM; deployed large Polygon 1 succeeded and saved | Numerical agreement does not independently establish field accuracy |
| Point-cloud regression and close refinement | Historical same-generation/default comparison, redundant frame/overlay work fixes, refinement tests and live orbit/pan/zoom at unchanged active/requested 10M | UI frame values are not GPU benchmarks or guarantees for other machines |
| Permission/lifecycle | Focused controller/recovery/contract 44/44; real-browser denied-tile and proactive timer renewal 2/2 | Overnight workspace disappearance/restoration integration still under test |
| Release and preservation | fae0935 release attestation and deployed health revision; no Operations edits or saved-data mutations | Native host PNG/print delivery after readiness fix remains unobserved; isolated actual files passed |

## Additional local regression evidence

The real-browser renewal suite now includes a proactive scenario with initial expiry five minutes plus fifteen seconds. The ordinary scheduled timer triggers BroadcastChannel issuance and redemption without a 401/403 response. Exactly one grant is issued/redeemed, access stays active, and renderer, resident shell and camera are preserved. Both scenarios also retain loaded geometry when subsequent authorization is denied. `node --test test/session-renewal-browser.test.mjs`: 2 passed, zero skipped, 33.3 seconds. This test does not contain a real personal-record API fixture; measurement preservation is covered separately by the actual-function VM tests and live saved-record observations.

### Expired-viewer controller restoration

The expanded browser suite passed 3/3 with zero skips or failures in 55.29 seconds. The new case suspends the original controller and navigates its document away, advances the existing Viewer past expiry, and waits for the real unanswered-controller timeout. A fresh document authenticates the same fixture subject, restores only persisted routing hints, and recovers the existing Viewer over BroadcastChannel with exactly one issuance/redemption. Renderer, resident geometry, and camera remain unchanged. Persisted descriptors are asserted to exclude credentials. A first run exposed mismatched fixture clocks; synchronizing the fresh controller clock before initialization corrected the fixture and the complete rerun passed. This closes the isolated restoration-integration gap, not observation of a production overnight renewal or real personal-record persistence in that fixture. No application source change was needed.

## Fresh checks

- `node --test test/session-renewal-browser.test.mjs`: 1 passed, no skips. A real isolated browser forces a tile denial, redeems one grant, rejects late redundant renewal, preserves renderer/loaded geometry/camera, and retains the view when authorization ends. This is controlled lifecycle evidence, not observation of a production renewal event.
- Combined close-zoom, native-profile, profile-download, capture-lifecycle, list-layout and sidebar-resize suites: 39 passed, no skips. Real-browser editor checks insert/move/delete vertices across view adapters. List checks cover two natural-height cards and measured overflow for three or more. Capture guards reject late access/view changes.
- That browser run produced an actual 30,694-byte 800×600 measured-view PNG, 44,653-byte print-renderer PDF, 1,451-byte native-profile CSV and 28,901-byte profile PNG. Native host print-dialog delivery remains a separate check.
- The existing production County Road D tab still showed all five records. Reopening Polygon 1's View volume invoked fresh capability/parent-result/job-list requests (the current server-profile implementation has no cross-inspector result cache) and displayed 4,209 crossed native cells at 0°. Saved net volume stayed 208,355.048 ft³. The inspector was closed without editing geometry or recalculating volume.

## Scope and remaining gates

- Later user instructions explicitly replaced automatic volume submission with immediate area plus a Calculate volume button. Do not restore automatic volume merely to match the old goal wording.
- Numerical reference evidence remains in `MEASUREMENT_GOAL_AUDIT_2026-09-22.md`: exact County DSM result 5,647.271691175985 m³ versus WebODM 5,647.0534 m³, without downsampling. This is consistency, not independent survey accuracy.
- Previously observed deployed full-budget cloud orbit/pan/zoom and close-view refinement used unchanged requested/active 10M; see the same audit. No point-budget reduction or renderer change was made in this follow-up.
- GitHub release 35816769694 for fae0935 was still running source checks when these observations were recorded. Production was last verified on 611cd7f. Do not claim fae0935 is deployed from a successful push.
- A fresh protected profile response in the long-lived tab is stronger evidence than cached labels, but does not reveal exactly when production renewed authorization. Natural renewal and native in-app export delivery should remain clearly qualified.
- Operations code, saved measurement geometry/results, original photos, and running provider jobs were not changed by these checks.

## Release outcome

Run 35816769694 subsequently completed successfully. Its downloaded attestation identifies commit `fae0935aeb45f5ac7d8d8c8158f303fb742437b9`, image digest `sha256:9ced4e2698facfbda95e6bc79302f5090a2a14617fada08a42e83cea154b0f02`, schema 33 and runtime user 568:568. Repository checks, pull-by-digest, revision/source stamp, runtime schema and component gates all passed. The verified image was promoted.

At 04:12:46 UTC the public production health response was HTTP 200 but still reported `611cd7fe34190c3fd857b9e8a9a5a60ce3d87be4`. Therefore publication is complete and deployment of fae0935 still requires the operator's container update. Do not refresh away an active upload to perform acceptance. This local follow-up note has not been pushed as a second release-triggering commit.

## Post-update live acceptance

- After the operator reported updated, the public health header at 11:13:23 UTC confirmed `fae0935aeb45f5ac7d8d8c8158f303fb742437b9` (HTTP 200).
- Refreshed the idle workspace. Visually confirmed the node list on the left and inline details on the right. Cluster reports healthy, API 1.5.3, ODM 3.5.6, zero queued, cluster-managed capacity, and 81 detected options.
- Opened New task without submitting: separate Choose files / Choose folder buttons, automatically selected Cluster — Ready, project/date name, preset dropdown, Edit task options and Save as preset, followed by alignment. Closed without uploading or creating a job. Prior-survey alignment remains explicitly unavailable.
- The old overnight model session was unavailable after reload. Opening View from the authenticated workspace successfully created a fresh session; this is not proof of seamless overnight session renewal.
- Fresh County Road D session automatically restored five measurements, including saved volumes 78,542.712 and 208,355.048 ft³. Polygon 1 View volume loaded its original 4,209-cell cross-section without recalculating or changing the saved volume. Model reached full-detail (256 tiles). Closed inspector and left fresh model tab open.
- No processing task was submitted, restarted, cancelled, or deleted. Production upload-through-completion and cancellation attribution remain unverified; no active Viewer processing tasks were present for live log testing.

## September 26: Hickory Grove cross-view follow-up

- Live 3D Saved measurements contains Used Feed Pile and Larger Feed Pile, both with the missing raster elevation-unit warning. This is a height-placement failure, not a missing saved record. Larger Feed Pile retains its saved point-surface volume of 174,886.944 ft³.
- New sampled point-surface results retain boundary elevations with point-grid provenance. Display reuse requires matching model version, CRS, exact horizontal vertices, source identity/hashes and normalized metre units. Administrator-declared units remain attributed as such; no DSM unit assumption is introduced.
- HTTP save/reload intentionally marks stored results as browser-supplied. Display recovery therefore reads the original attached job through the authorized calculation transport, checks its attachment revision and measurement binding, and uses a transient display-only copy. It does not trust stored provenance labels, edit the document, or start a calculation.
- Declared-unit point cross-sections use verified staff transport where available, with access checks throughout and no elevated retry. Ordinary client permissions are unchanged. Missing-calculation guidance no longer incorrectly asserts expiry.
- Final combined focused verification: 157 tests passed, zero failed or skipped, including actual worker/HTTP save/reload, private-job authority, display recovery, overlay caching and lifecycle checks. Production Vite build and diff whitespace checks passed with existing dependency/chunk-size warnings.
- Existing results lacking retained boundary elevations are NOT repaired by this patch. No live outlines or saved volumes were edited or recalculated. Uncalculated DSM outlines with unknown units still require verified source evidence or a separately validated display-height recovery path.
- After pushing `8ea6bb5`, isolated close-zoom and native-profile browser suites passed 12/12 tests. Coverage includes sidebar drag/keyboard/mobile layout, vertex insert/move/delete, native section lifecycle, cancellation, NoData, CSV, actual PNG download and browser-backend PDF generation. These synthetic browser tests do not establish native host print UI or production deployment. Release run 36280901503 was still in progress at this check; live Hickory Grove retained the older report labels and its two unchanged saved records.
- Release run 36280901503 subsequently failed two runtime-import guard assertions before image construction. A server-image test had imported the browser display module. Removed that duplicate browser assertion/import from the runtime entrypoint; server boundary assertions remain, and browser reuse remains covered by the display suite and real HTTP save/reload integration. Both runtime import guards now pass locally. No application behavior or packaging allowlist was weakened.

## September 26: fresh-session reproduction after 2559595

- Production health identified `2559595f22821b8b7bcf5242144d25902fad8534`. Opened a genuinely new Hickory Grove session from the idle workspace rather than relying on same-URL navigation of an existing document.
- Both Used Feed Pile and Larger Feed Pile loaded automatically, but both 3D overlays remained blocked by absent raster elevation units. This contradicts complete cross-view acceptance, including for an outline without volume. Saved Larger Feed Pile net volume remained 174,886.944 ft³; no volume recalculation or geometry edit was requested.
- In the fresh session, View volume passed point-source provenance validation but failed with `The section contains invalid or missing station intervals.` The old tab's earlier provenance error was stale-document evidence, not evidence that 2559595 failed that specific check.
- A deterministic UTM section reproduces distinct parametric breakpoints that round to the same metric station, yielding a zero-length interval. Positive-length intervals and missing-data gaps must still be validated; fixing this must not recalculate the saved volume.
- New isolated browser regression initially fails with no rendered map outline when raster metadata is unavailable. It exercises the shipped workspace and synthetic actual mesh/point geometry, not production data or the user's browser profile. Pending implementation and passing results are not yet release/deployment evidence.

### Display recovery and section correction

- Added ephemeral placement against currently displayed mesh geometry or resident cloud points when verified retained/native elevations are unavailable. Original E/N coordinates, saved zero-height map vertices, volume results, exports and calculation requests are unchanged. Approximate cloud placement is explicitly described as display-only; it does not establish raster units or survey accuracy.
- The Potree adapter reconstructs node-local bounds before applying the scene transform. The supplied WebODM decoder subtracts node minima from point positions, while its scene node applies that minimum; transforming the loader's untranslated bounding box again would double the offset. A regression exercises the actual shared adapter, not a duplicate test transform.
- Visible finer mesh descendants supersede overlapping coarse parents. Cloud lookup yields cooperatively, shares in-flight node builds, caches unchanged buffers/transforms, and skips remembered oversized indexes. The retained cache is limited to 262,144 cells; up to two workspace requests can have additional bounded in-flight builds. Point budget and rendering detail policy are untouched.
- Eleven rendered-surface unit tests passed. Thirteen isolated browser tests passed, including the same map outline across all five view modes, unchanged saved heights, access loss, close-zoom clipping, editor actions, report/capture output and native profile interactions. Production build passed (538 modules), with existing dependency/chunk-size warnings.
- New point sections omit only contacts whose two represented metric stations are identical. Existing cached sections receive a validated, cloned presentation result excluding those zero-extent contacts; stored sections and saved volumes are unchanged. Thirty-three focused numerical/API/profile tests passed, including an actual EPT UTM reproduction and cached recovery without a create request.
- Full Windows `npm test` is not a passing gate: the catalog-import example fails in unchanged storage initialization at `C:\\proc\\self\\fdinfo\\3`, a Linux `/proc` dependency. Do not weaken that storage guard or treat this as a measurement success. Linux repository and exact-image CI gates remain required before declaring the release verified.
- Live Hickory Grove overlay, saved-section reopening and loaded-cloud navigation still require post-deployment acceptance of these changes. Synthetic browser tests do not prove production performance.
- Final combined focused suite passed 96/96 with zero skips; the final isolated browser rerun passed 13/13. Both production-image import guards passed after keeping the new server numerical regression independent of the browser presentation module. Two extracted-main test fixtures now explicitly wire the new lazy hooks and fail if ordinary picking/projection invokes them eagerly. Final build and whitespace checks passed.
- Final lifecycle review added regressions for two signal-ignoring old requests releasing their slots on a view switch and for a stale surface-generation reply being rejected and retried. The last complete outline remains available while current surface coverage loads; neither case changes saved geometry or creates calculations.
- The broad Windows run completed with 1,754 tests: 1,433 passed, 270 failed, 51 skipped. It includes Linux-only storage failures plus the four fixture/import-guard failures corrected and rerun above; it is not a release acceptance pass. The Linux CI result must be checked separately.
