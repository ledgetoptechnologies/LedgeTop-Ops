# Measurement goal completion audit

## Deployment acceptance on 23 September 2026 UTC

This section supersedes the release/deployment blockers in the chronological notes below; it does not supersede remaining live acceptance checks.

- Release run 35808118541 succeeded for `611cd7fe34190c3fd857b9e8a9a5a60ce3d87be4`. The downloaded image attestation identifies digest `sha256:61cf78e2e468123bc44534ec032bb39f7afb05dc21371a6756f958802ea408e4`, schema 33, runtime UID/GID 568:568, and passing repository, pull-by-digest, revision, source-stamp and runtime checks. The exact-container gate passed 122/122 checks.
- At 02:47:48 UTC, the production health HEAD returned HTTP 200 and the same `611cd7f` revision. Deployment is verified, not merely requested.
- Reloaded the workspace and opened a fresh County Road D session through its View button. All five personal records loaded automatically, including saved net volumes 78,542.712 ft³ and 208,355.048 ft³, with View volume actions. No recalculation or geometry edit was performed.
- The fresh 3D tab reported loading complete overview and 0 FPS. Screenshot capture failed and an Orthophoto click timed out in browser control. Reopening the same authorized session directly in Orthophoto restored the five records, but screenshot capture and the report-button click still failed. These failures span both render modes; they do not establish a point-cloud regression or prove an application freeze. The Codex request to show the tab returned queued, not confirmation that the tab was foregrounded.
- Report readiness and natural renewal of an existing live session remain unverified on this deployment. Fresh-session restoration is not renewal proof. No authentication state was inspected or bypassed, and Operations code and saved measurement data were left unchanged.

Follow-up: browser control recovered without an application change. At 02:54:52 UTC, the Orthophoto report opened with all five records and a complete 885×822 measured-view image; Print / Save as PDF was enabled. Its explicit click completed without a browser-control error. The screenshot still showed the report, and no new PDF appeared in Downloads, so native print-dialog/file delivery remains unobserved rather than accepted. The earlier user-supplied PDF remains the evidence for actual export delivery on the previous build.

Loaded point-cloud navigation was then repeated on 611cd7f: before orbit/zoom/pan the visible overlay reported 10.0M points, active/requested 10M/10M, 225 nodes and 144 FPS. After those gestures, the camera visibly rotated and moved closer, with 10.0M points, 250 nodes and 144 FPS. The budget was untouched. These are actual view interaction and refinement observations, not GPU timing or a guarantee for other hardware/datasets. Saved labels and both volumes remained visible. Natural live-session renewal is still outstanding.

The same deployed session also passed the saved Polygon 1 profile interaction: View volume loaded 4,209 native cells automatically at 0°; entering 45° produced 9,148 cells automatically with net volume unchanged at 208,355.048 ft³. Reset returned to 0° and 4,209 cells. The inspector was closed using its accessible Close measurement inspector button. No volume calculation or outline edit was requested. At this point both workspace and existing model session still displayed authorized data; this alone does not prove a renewal event.

Further 3D acceptance: two successive zoom-in gestures at the Polygon 1 ground boundary retained the yellow line, visible short edge label and small orange vertices at close range. Quick Save view image was exercised, but no new measured-view PNG appeared in Downloads; initiated export is not verified file delivery. No model geometry was changed.

## Current acceptance snapshot after e909dde (supersedes older pending notes below)

The entries below this snapshot are chronological evidence, not a claim that every earlier blocker remains open.

- The user supplied `measured-view.png`, `measured-view (1).png` and the exported County Road D PDF. Both PNGs visibly contain the model and measurement overlays. Both PDF pages were rendered and inspected: page one contains the captured view and all five records (including Polygon 1's saved 208,355.048 ft³ net volume); page two contains the accuracy note. Actual file delivery is therefore verified for these user-supplied exports. The reported early-print issue prompted a readiness guard in e909dde; native post-fix browser interaction is not yet accepted.
- Latest Windows isolated browser checks passed: 11 New Task tests and 3 measurement/sidebar/editor/capture tests. The latter generated an actual PNG and print-backend PDF. Linux source/build verification passed 1,580 tests, with 31 explicitly skipped browser/native/host-dependent checks (1,611 total). Skips are not live acceptance.
- Fresh current-code numerical replay against the original 556,007,817-byte DSM returned 5,647.271691175985 m³ in 6.301 seconds. This is +0.218291175986 m³ (+0.0038655766%) against WebODM's 5,647.0534 m³, within the documented 1 m³ comparison tolerance, without downsampling. This is numerical compatibility, not independently surveyed field accuracy.
- Fresh list-layout, capture-lifecycle and review-controller suites passed 46/46. They cover two-card overflow, explicit print readiness, revocation/late-response retirement and bounded grant issuance.
- The open live cloud still renders but its personal measurements are hidden; the Operations reauthorization tab is at Cloudflare sign-in. Sign-in/reopening was requested for the remaining renewal soak check. This does not justify bypassing authentication or extending authorization. The displayed cloud currently reports adaptive 4.2M active / 10M requested; this stationary observation is NOT counted as unchanged-full-budget navigation acceptance.
- e909dde is pushed to main. Release run 35807283155 is still in source verification at the time of this snapshot. The prior run 35804280532 was superseded/cancelled; its logs show a New Task browser-test failure followed by a non-exiting runner. Linux browser teardown is being investigated separately. Neither pending build is a verified published container.
- Raw-photo selection/import and task options are now implemented; older statements calling that work planning-only are obsolete. Survey-date comparison, reconstruction-boundary authoring and processing alignment remain separate unfinished features in TASK_WORKFLOW_NEXT_PHASE_2026-09-22.md.

The active measurement goal remains unproven until release verification and authorized live renewal acceptance complete. Operations code and existing measurements/source data remain unchanged by this audit.

Follow-up after the user signed back in: the old model tabs were closed, so this is fresh-session recovery, not proof of renewal in an existing tab. A new County Road D session restored all five records automatically. Polygon 1 retained 208,355.048 ft³ and View volume. Its native profile loaded automatically with 4,209 cells at 0°, updated to 9,148 at 45°, and retained the volume; the section was reset and closed without changing geometry. Another 16 explicit-volume/permission tests and 13 reference/native-profile tests passed.

The test-only build follow-up prefers Google Chrome on Linux before Chromium wrappers, bounds browser startup/discovery/CDP and teardown, closes Vite before HTTP upgraded sockets, and preserves original assertion failures. It passes 11/11 on Windows Edge and 11/11 on Linux Chromium. A deliberately failing `/bin/false` browser executable exits nonzero in 1.25 seconds with startup diagnostics rather than hanging. The historical CI failure's exact cause is still unconfirmed; these checks prove the corrected failure path, not a guessed retrospective diagnosis.

## Live acceptance after deployment of ad6e404

Additional isolated browser export acceptance produced a 30,694-byte measured-view PNG (800×600 with current-frame pixel assertions), a 1,451-byte profile CSV, a 28,901-byte profile PNG, and a 44,652-byte PDF through Chromium's print renderer. Sixteen capture/report/profile tests passed without console errors. Production print CSS hid Viewer controls and retained the report. The test explicitly enables browser downloads; it does not prove the embedded host permits them or exposes a native print dialog. No speculative application export rewrite was made.

Subsequent fresh-session navigation accepted orbit, zoom and pan at unchanged active/requested 10M. Screenshots showed changed camera orientation and framing; visible nodes changed from 159 to 133 to 104 as the view changed. Later on-screen diagnostics reported 4,386,720 submitted points, 104 nodes, 7.8 ms CPU frame average and 17.9 ms maximum, with 0.4 ms update and 0.7 ms render submission. These are UI CPU observations, not GPU timings or a universal smoothness claim.

The same live session repeatedly displayed renewing/retrying access and eventually hid personal measurements until access restoration. This is an unresolved lifecycle acceptance failure; loaded cloud rendering continued. No authentication bypass or Operations edit was made. Report generation before expiry included the measured image and all five rows, including Polygon 1's saved result. PNG reported a download request but no new file appeared in Downloads, and native print/PDF delivery was not observed. Thirteen fresh capture lifecycle/profile-download tests passed, including actual isolated CSV and PNG file delivery; those do not prove native delivery in the in-app browser.

The user confirmed updating, and the public health header independently confirmed `ad6e4043615fd755812c2bbdb0e93d17955118e3`. A fresh County Road D Orthophoto tab restored all five personal measurements automatically; the unnecessary Retry button was absent. The existing QA feed-pile result remained 78,542.712 ft³ with View volume.

The current saved Polygon 1 outline is 25,955.143 ft² (different from the earlier CSV's 26,122.202 ft²). Explicit server calculation succeeded: cut 208,409.265 ft³, fill 54.217 ft³, net 208,355.048 ft³, coverage 100.000%. The card and inspector changed to View volume. This verifies the currently saved outline, not the older CSV geometry or independent field accuracy.

Its native section loaded automatically: 4,209 crossed cells at 0°, then 9,148 at 45° after numeric input, without changing the saved volume. Source displayed DSM, EPSG:32616, reviewed-source-provenance and vertical datum unverified. Reset section was exercised. No original source or measurement geometry was edited. Final PNG/PDF delivery and refreshed loaded-navigation acceptance remain separate checks.

Audited current checkout `be8e853` on 22 September 2026. The separate new-task/import workflow is planning work and is not evidence of completion for this measurement goal.

| Requirement | Evidence inspected | Conclusion |
| --- | --- | --- |
| Two visible records, orange overflow and responsive navigation | Current measurement-list-layout module and CSS assertions; fresh list/sidebar tests cover 0–2 natural height, 3+ measured two-card overflow, wrapping, keyboard and drag lifecycle | Implemented, focused checks pass; latest deployed layout still needs live acceptance |
| Area immediately, volume explicitly requested | User's later instruction supersedes the original automatic-volume wording. Current finish/inspector tests prove area-only save, no implicit volume, unchanged-result retention and geometry invalidation | Implemented; do not restore automatic volume |
| Honest interactive side section | Current profile/dialog tests and usability QA cover native cells, missing-data gaps, saved base, automatic profile updates, numeric/sliding controls and retained volume | Verified in isolated browser; latest deployment interaction pending |
| Numerical stockpile calculation | County reference validation records exact raster/hash, corrected Delaunay comparison, map/spatial agreement and actual worker IPC result. Usability QA records a larger-than-old-limit raster test | Evidence supports calculation consistency, not field accuracy or the exact missing Polygon 1 outline |
| Permission and lifecycle | Fresh capture/auto-volume tests cover revoked access, stale replies, mode changes, report retirement and explicit server transport | 39 total selected list/sidebar/capture/auto-volume tests passed, zero skips or failures |
| Point-cloud history and navigation | Inspected commits b234083, 9e46fdc, 6e76e32 and prior history; refinement QA records full 10M active/requested budget and changing node density during closer views/orbit | Historical live evidence supports the fixes; not a controlled GPU benchmark or proof for every dataset |
| Current live state | Existing County Road D tab still has export checkboxes, Rename buttons, Reload saved measurements and old screenshot/report placement | This tab is not running the latest UI. It cannot accept be8e853. A stale tab does not prove the server itself is outdated |
| Current point-cloud observation | Same tab shows 8.7M visible points, active/requested 10M, 244 nodes and 144 FPS | Stationary UI observation only; not a new loaded-navigation success claim |
| Release | be8e853 is committed; successful release was verified in preceding task turn, including exact candidate gate and publication as sha-be8e853 | Delivered; no new release created by this audit |
| Preserve Operations and user data | Current worktree has only new planning/audit documents beyond be8e853; this audit made no application, Operations, measurement or source-data edits | Preserved |

## Remaining acceptance

Reopen a current Viewer session after deploying/reloading be8e853. Confirm the new controls, actual PNG/PDF behavior, native profile interaction, and the user's exact large Polygon 1 calculation. Repeat orbit/pan/zoom at unchanged budget if navigation has changed. Do not reduce the point budget and call that verification.

Goal is not marked complete because current live acceptance is unproven. No deployment or refresh that could discard an active draft was performed during this audit.

Follow-up at 22:35:47 UTC: a read-only HEAD request to the public `/api/v1/health` endpoint returned HTTP 200, `Cache-Control: no-store` and `X-LTDS-Viewer-Revision: ff502e5fdd355102070953c6bcc1398c6a226ea4`. The server itself is still on the earlier release, so refreshing the tab alone will not load be8e853. Final deployed acceptance requires the operator to update the container to the verified `sha-be8e853` image. No deployment was attempted by this audit.

## Resumed after deployment

The next health check reported be8e853 and the user confirmed updating. A fresh authorized County Road D session opened with the new controls and all five records. The older cloud tab was switched to Orthophoto to avoid concurrent active 3D renderers.

- Sidebar End key resized it to 611 px in the current viewport. Saved-list client height was 339 px, scroll height 908 px, first card heights 182.984375 and 143.984375 px, with orange `rgb(238, 80, 7)` scrollbar and transparent track.
- QA feed-pile saved volume remained 78,542.712 ft³. Its native cross-section loaded automatically with 2,293 crossed cells and reviewed-source-provenance. No volume recalculation was requested for this record.
- Model report opened with a measured-view image and all five saved rows, including Polygon 1's 11 edge lengths. Native PDF output has not been independently inspected. Quick image/JSON export actions were exercised, but no new file appeared in the user's Downloads directory; do not substitute an initiated browser download for verified delivery.
- Exact Polygon 1 (26,122.202 ft²) was explicitly submitted for calculation and still failed with the generic calculation-limit message. Saved geometry is intact. The supplied prior JSON does not contain its vertices; requested a new export from the user.
- Live regressions identified: renderPanel wrongly exposes Retry after successful loading; current-result recognition expects `calculated` although persisted successful server results use `complete`. Both have focused fixes in progress.
- A deterministic concave raster reproduction exposes a second capacity guard: global cell-count multiplied by all clipped reference patches can exceed the work ceiling even though most patch/cell pairs cannot overlap. Exact spatial culling with conservative resource accounting is being implemented and numerically checked; no global safety limits are being removed.
- Map-authored record placement in 3D still reports missing height units while the verified source can calculate native profiles. The placement path is being audited separately without introducing a guessed unit override.

Completion remains unproven because these newly observed failures require fixes and verification.

## Follow-up fixes and export audit

The user supplied `measurements (1).csv`. Read-only inspection found all five records, including Polygon 1, but the CSV contains summary quantities and provenance, not vertex coordinates. Polygon 1 is geometry-only with no saved volume. A JSON export is still required to reproduce that exact outline; its CSV area is not sufficient to reconstruct geometry.

The local follow-up now fixes failed-load retry visibility and recognizes persisted `complete` surface results as current when their job, version, quantities and invalidation checks pass. A fresh combined run of display-elevation, overlay, volume-dialog and spatial-culling tests passed 52/52 without skips.

Native raster calculations now cull reference patches by conservative spatial bounds while keeping exact fractional-cell integration and the existing cell/work limits. A deterministic concave outline on the actual County DSM completed with 30,329,750 bounding cells and 34 patches in 6.89 seconds, approximately 294.5 MB end RSS. The former global cell-by-all-patches estimate was 1,031,211,500 and rejected it. This is a reproduction of the failure class, not the missing exact Polygon 1.

Map-to-3D placement now receives exact authorized reviewed-source evidence from the same registry as calculation. Explicit conflicting units and mismatched source identities are rejected. Large outlines read deduplicated vertex cells instead of a full bounding rectangle. The actual County raster returned 12 native vertex samples in 41 ms, without altering saved geometry.

The requested measurement UI batch has a read-only code/test checklist covering sidebar resizing, two-card overflow, automatic saved loading, floating image capture, separate report, centered volume labels, current/stale result actions, inline rename, visibility/edit controls, vertex insertion/deletion, export-all, accepted-job notice, help text, automatic profiles, numeric/reset controls and staff-only settings below ordinary output. These are implemented; local tests do not replace deployment acceptance. Native download/PDF delivery remains unverified in the user's browser.

The separate new-task/raw-import workflow remains planning-only in `NEW_TASK_WORKFLOW_PLAN_2026-09-22.md`. No raw processing job was launched and no Operations code was edited.

The original exact 12-vertex WebODM reference was rerun with spatial culling against the supplied DSM. At 128-cell windows its net result was 5,647.2716911718235 m³ (identical to the prior baseline), taking 7.69 seconds. At 512-cell windows it was 5,647.271691175985 m³, differing by 4.16e-9 m³ and taking 4.89 seconds. Both visited 22,226,061 bounding cells, counted 20,969,439 valid samples and budgeted 49,097,148 candidate patch visits. This confirms retained reference numerics, not the exact Polygon 1 or field accuracy.

Fresh combined Linux build-stage verification passed Vite and 1,542 source tests (1,572 total, zero failures, 30 skips). Skips were 27 browser-dependent checks, two native Poisson checks and one host-bind lifecycle check. This is source/build verification; exact production-container release verification is a separate gate. No new point-budget reduction or point-cloud renderer change is included in this follow-up.
