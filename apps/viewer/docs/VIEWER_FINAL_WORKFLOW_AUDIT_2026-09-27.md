# Viewer workflow audit — September 27, 2026

Scope: Viewer repository only. Operations is being changed by another agent and is not modified here. Existing production measurements, processing jobs and public-link grants are not test fixtures.

## Live acceptance checklist

The items below define post-deployment acceptance. Their runtime changes are implemented and tested locally; boxes remain open until the relevant live checks are performed.

- [ ] Task toolbar: View, Model report, Share, then More for secondary actions. Clear navigation between task details, files and specialized tools.
- [ ] Standalone public link: works without an Operations client association; explicit creation/publication, optional password/expiry, downloads/measure permissions, revoke. No widening access silently.
- [ ] Session continuity: normal renewal stays in place; known expiry pauses requests without navigating away or discarding selected photo files; same-identity sign-in resumes safely. Revoked/changed identity fails closed.
- [ ] Measurement continuity: memory-only draft recovery after known expiry, same authenticated subject/audience/model/version, and unchanged saved revision. No restoration after revoked/scope-changed access.
- [ ] Edit navigation: normal orbit/pan/zoom off handles in all five views; handles own dragging only; clear finish/exit help.
- [ ] Camera: clamp before crossing straight down in Model and Point Cloud, including large/off-centre drags; no inverted/rolling camera.
- [ ] Density: inspect prior fixes and medium/close runtime diagnostics; distinguish budget/LOD selection from source density. Do not lower budget or invent points to hide a problem.
- [ ] Previous volume: retain/display explicitly stale result for previous boundary; never export or label it as current; recalculation remains explicit.
- [ ] Cut section: saved result/profile source and permission handling checked; no recalculation merely to view a result.
- [ ] Height units: server reads encoded units without mandatory blanket confirmation. Provider name or horizontal CRS alone is not proof of height units; retain declaration versus verification distinction.
- [ ] Regression tests, isolated UI tests, build and release pass; deployment/live checks separately recorded.

## Future proposal: shared measurements (not implemented in this change)

Keep personal measurements private by default. Add an explicit **Publish measurements** action producing a read-only project/model-version snapshot with author, capture date, boundary revision, units and calculation provenance. A client can **Copy to my measurements** and edit their copy without modifying the published original. Use clear sidebar groups: **Shared with you** and **My measurements**. Only add collaborative editing later with explicit permissions and conflict handling.

Public bearer links and signed-in accounts are separate identities. A public link must never expose all staff/client personal measurements implicitly. Revocation and expiry apply to shared snapshots, and access checks must run on every read/export. Changing a polygon must keep old results labeled historical; publishing must not imply survey-grade accuracy.

## Height-unit evidence

The current WebODM documentation allows different coordinate/vertical systems, including US survey feet in compound CRS examples. A file being imported from WebODM or returned by a node does not by itself establish meter-valued elevations. Automatic handling should use encoded vertical metadata or retained, immutable-source-bound generation evidence. Previously confirmed staff declarations must remain labeled as declarations, not independently verified accuracy.

Primary references checked:
- https://docs.webodm.net/how-to/use-coordinate-systems/
- https://docs.webodm.net/references/gcp-file-format/
- https://docs.webodm.org/options-flags/

## Verification record

Implementation and verification in progress. This checklist is not a claim of deployment or live acceptance.

- User-provided Hickory Grove close view reports 15,524,495 source points, 375k visible, 0.4M active / 10M requested adaptive budget, 43 FPS and 22 nodes. This establishes an adaptive cap, not exhaustion of native detail or proof of a network stall.
- Orbit/refinement focused verification: 53 passed, zero failed; eight installed-Potree tests explicitly skipped locally pending exact-image verification. The controlled 43-FPS recovery fixture reaches at least 2M points within 12 seconds and 10M within 25 seconds; genuine overload rolls back and retains retry backoff. These are fixture results, not measured production loading times.
- Task workspace browser tests: 13 passed, including desktop, 390px and 320px layouts. Public project-share browser tests: eight passed. Public sharing retains explicit publication and permissions rather than silently exposing private measurements.
- Initial recovery, unit-choice and draft tests: 31 passed. Additional browser upload recovery and expiry-race tests are in progress.
- Production Vite build succeeds. Full Windows test run encounters existing Linux storage initialization requirements (`/proc/self/fdinfo` is unavailable on Windows); do not describe that run as fully passing or bypass the storage guards.
- Live browser connection is unavailable for this pass. Post-deployment Hickory Grove medium/close refinement and continuous orbit/pan/zoom remain required with the requested point budget unchanged.

### Final focused checks

- Measurement changes: initial 99/99 including all four real-browser editor tests; follow-up recovery review 120/120, including Viewer session recovery, pre-invalidation capture, temporary-load retry, conflict refusal, and no restoration on revoked access.
- Workspace/sharing: 67/67 focused checks; new-task browser 16/16 including stacked recovery dialog, unchanged URL, original File identity and original upload resumption. These use isolated synthetic auth endpoints, not the production Operations sign-in service.
- Authenticated downloads, private source images and legacy upload chunks now share the bounded same-envelope recovery wrapper. Stale request denials cannot erase a newer session. Final recovery/request tests: 22/22.
- The first complete Linux diagnostic snapshot had 1,689 passes, 18 test-harness failures and 42 explicit environment skips. All 18 harness issues were corrected and passed locally; final consolidated Linux verification is recorded below when complete.
- Final consolidated Linux build/check: **1,712 passed, zero failed, 42 explicit environment-dependent skips** (1,754 total). Complete local log: `output/linux-workflow-final.log` (not committed). This includes the final store/draft recovery changes. Separate Windows real-browser suites cover the browser paths skipped in the isolated Linux test image; bundled Potree/native-tool checks remain release-image gates.
- Point-budget recovery timing depends on node size and loading. The filled-frontier fixture timing is not a guarantee: an artificial indivisible 6M-point child still waits longer under bounded probing. Diagnostics must distinguish pending detail from budget-limited selection during the live check.

### September 28 sharing follow-up

- Public health response confirms deployment of `32fe6f8a4d2160ee9d9639cac17da0040a0eed31`. Its release-image checks passed; this does not establish live workflow acceptance.
- The user reports no way to generate a public link. The exact missing-control location is not yet confirmed. The model viewer has no Share control; the existing creation path is Workspace → project/task → Share. No live permission or link changes were made during this investigation.
- Fixed a confirmed independent issue: optional Operations client-access lookup no longer blocks public-link preflight/form rendering. Its late completion updates only its own panel, preserving entered public-link fields. Context, token and identity checks reject stale responses. Existing creation/publication permissions remain unchanged.
- Follow-up verification: 71/71 focused unit/API/layout tests; 21/21 real-browser sharing/workspace tests including desktop, 390px and 320px layouts; production build passed. Browser tests explicitly hold the optional lookup pending, verify the Create public link button is hittable, then verify late completion preserves the same form and entered label/password.
- Full isolated Linux build/check: 1,727 passed, zero failed, 42 environment-dependent skips (1,769 total); log `output/linux-public-share-independent-check.log` (not committed). Production browser automation remains unavailable. The missing-button report and live checklist remain open.

### Remaining live checks

1. Verify deployed revision matches the released commit.
2. At Hickory Grove, keep the requested point budget unchanged; compare medium/close detail after settling and during continuous movement, recording active budget, visible points, pending work and LOD levels.
3. Confirm straight-down clamp and off-handle navigation in Model and Point Cloud.
4. Exercise real Operations reauthorization without closing the working tab; confirm camera, selected photos and unfinished measurement remain intact for the same identity. Do not deliberately interrupt a production processing job.
5. Create/revoke a deliberately authorized public test link, verify its configured report-download permission, and confirm private measurements are not implicitly disclosed.
6. Open an existing authorized saved cut section and stale-volume summary without starting a new calculation.
