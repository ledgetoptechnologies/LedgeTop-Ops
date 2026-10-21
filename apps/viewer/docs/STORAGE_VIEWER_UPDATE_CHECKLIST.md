# Storage and Viewer consistency update

This is an integration checklist, not a release-completion claim. Production has not been changed by this worktree. Protect the active Greenwood import; do not restart services or run unproven cleanup against it.

## Release scope decision and final task-row audit

The user explicitly requested release of Viewer-owned fixes, with the remaining
Operations work handed to their separate Operations agent. That work is documented
in [OPERATIONS_VIEWER_INTEGRATION_HANDOFF.md](OPERATIONS_VIEWER_INTEGRATION_HANDOFF.md).
The unchecked integrated-renewal and private-ready client activation items below
remain real limitations; they are not silently classified as completed for release.
No Operations source edits, live grants, imports, deletions or restarts are part of
this release.

- [x] Task rows contain View, Download, Report and Share when authorized and available;
  streaming preparation/failure appears as a small title-side notice, not a disabled
  quick-action button. Completed streaming is quiet; recovery controls remain in Settings.
- [x] Overview removes duplicate Rename/Delete controls. Task Settings owns task lifecycle;
  source and project removal have explicit, distinct labels and existing confirmation gates.
- [x] Project and dashboard summaries say Ready instead of Published. Project source sets
  count only draft/finalized collections, excluding archived/recycled sources; this is
  independent from task count and does not imply duplicate storage.
- [x] Task list and detail both expose registered image counts. Dataset inputs take precedence;
  older archive imports can use the selected result's registered camera originals, with
  provenance. Unknown counts say Not recorded rather than inventing zero. No filesystem
  scans or summing retained versions are introduced.
- [x] Final focused UI/inventory checks: 54 passed, no failures. Full Linux/browser/container
  release gates are recorded separately; this count is not a production acceptance claim.

## Implemented locally

- [x] Separate measured Viewer-managed file categories from shared filesystem capacity; expose partial results and accounting exclusions.
- [x] Preserve exact cleanup-blocking reasons in diagnostics.
- [x] Verify recovery preservation by registered artifact mappings, file hashes, descendants, chunks, and photo associations; retain unproven files.
- [x] Seven-day recoverable retention for newly automatically retired outputs only; preserve run history, manual retention, and existing deadlines.
- [x] Pause heavy cleanup proof work while processing is active; recheck dependencies before retirement and purge.
- [x] Fix point-cloud stale focal-distance navigation without changing mesh controls.
- [x] DSM/DTM automatic color controls, reset to defaults, and camera markers across map modes.
- [x] Keep surface/reference measurement controls available within the Volume tool only.

## Remaining integration and investigation

- [x] Verify true 100% DEM pixel opacity in both rendering paths (execution-level pixel tests).
- [x] Validate DSM/DTM elevation min/max live color remapping and units against the supplied Rock Robotic references; this changes color mapping, not visibility clipping. No GPS-time controls requested.
- [x] Add point-cloud live elevation min/max, paired sliders, and automatic-range reset; preserve visibility and synchronize units/state across iframe recreation.
- [x] Narrowly improve closest-visible model request priority without changing selection, screen-space-error targets, cache budgets, or retained coverage.
- [ ] Reproduce model → cloud → model access-unavailable/renewing warning. Existing switching disposes the mesh renderer and cloud iframe and transfers camera pose; do not add speculative cache eviction.
- [ ] Distinguish stale loader-generation failures from valid current-session authorization denials. Preserve revocation and scope enforcement.
- [ ] Verify routine long-lived model renewal completes in the background without refresh/reopen; the status-label repair alone does not meet this requirement. Preserve pose and loaded coverage during valid renewal, and recover interrupted loaders safely.
- [ ] Investigate and remove the routine idle-workspace navigation through Operations sign-in when authorization can be silently renewed. Preserve the current project/task/subpage and unsaved work. Genuine expired/revoked Operations authentication still requires an honest reauthorization boundary, not hidden denial or unconditional extension.
- [x] Run combined integration tests, selected in-app browser regression checks, and exact runtime-container checks. Final audit suite: 1042 passed, zero failed, 20 skipped; browser/real-data skips remain explicit.
- [x] Record the local diff scope, test evidence, unresolved live-data limitations, and deployment/retest instructions in `STORAGE_VIEWER_LOCAL_QA.md`. No release is claimed.
- [ ] Verify Rome cleanup on real retained outputs after deployment; do not assume all duplicate-looking outputs are disposable.

## Added scope: production workspace usability

The user approved this expansion after supplying three references: the native task-name prompt, the current expanded Church task, and WebODM's compact Rome task. This checklist extends the active storage/viewer goal; it does not replace unfinished safety and integration gates above.

- [x] Replace browser-native prompts/confirmations in Viewer-owned workflows with accessible in-application dialogs, including rename and destructive-action confirmation. Preserve cancellation, validation, keyboard focus, and clear confirmation for deletion/revocation. Do not change unrelated Operations applications.
- [x] Simplify the expanded task into a compact summary with visible primary actions rather than stacked nested sections. Preserve View, Download, Report, Rename, Delete, Share, and a Ground control points entry where authorized/available.
- [x] Remove the duplicate task-output and processing-history panels from the task overview; keep recorded runs, failures, and troubleshooting details accessible through Background work/Diagnostics. This is navigation cleanup, not history deletion.
- [x] Reconcile the task header and summary status against the intended active result; a failed later attempt must remain visible in history without making a usable result misleadingly appear failed. Preserve genuinely unavailable metrics rather than inventing values from screenshots.
- [x] Replace the user-facing Review/Publish ceremony with an explicit Share action for eligible ready results. Retain artifact validation, authorization, and private-by-default behavior. Do not automatically create public access when processing finishes.
- [ ] Support granting/revoking authenticated client access through the existing Operations/client-workspace integration, and explicit passwordless public-link creation/revocation. Keep public and authenticated sharing clearly distinct and honor configured permissions and expiry.
- [x] Move ground-control interaction into a dedicated in-app workspace opened by a clear task action. Reuse working upload/validation capabilities, image correspondences, and immutable processing control-file generation.
- [x] Audit ground-control backend scope: existing import, image matching and NodeODM control-file serialization/submission tests pass. No replacement backend is needed for this UI reorganization; real surveyed-data validation remains useful.
- [x] Add task-dialog, compact-layout, status-selection, sharing permission/revocation, and GCP-navigation regression tests plus selected synthetic in-app browser QA. Actual site acceptance remains separate.

No actual public links, client grants, production publications, or production deletions are authorized merely by this UI implementation request. Existing Greenwood processing remains protected.

## Evidence and limits

Additional local checks on September 5:

- The task status API regression and dashboard tests passed (11 tests). Task detail now selects the same active attempt as the list, retains later failed history, and does not invent missing metrics.
- Compact task layout and dedicated task/GCP routes passed 33 related tests, including 12 executed render/navigation cases. GCP read-only users do not get import/edit/delete controls; missing linked datasets do not get upload forms.
- Existing GCP import, API, repository, ODM serialization/submission and marking checks passed 19 tests. The backend already snapshots saved correspondences into an immutable private `gcp_list.txt` for processing. Reorganize this working capability rather than describing it as an unimplemented backend.
- The local candidate image passed both exact-runtime readiness tests and `verify-obj2tiles-runtime.mjs` (57 artifacts, 83 compressed textures). That image predates subsequent workspace/sharing/session edits and is not the final release gate.
- The in-app browser verified pending storage measurement advances automatically to distinct synthetic category totals without manual refresh, including a second reset/measurement cycle.
- The in-app browser exercised the shipped dialog module under a local self-only script/style policy: rename starts in the name field; Escape cancels and restores opener focus; a nested confirmation preserves its parent and returns focus; a wrong permanent-deletion identifier remains in the dialog with an inline error. This synthetic harness makes no service calls and deletes no files.
- Direct-sharing backend changes passed 56 focused Linux sharing/publication/access tests. UI integration and focused handler tests now pass. See `DIRECT_SHARING_IMPLEMENTATION_REVIEW.md` for exact public-link and Operations boundaries.
- Routine silent renewal is NOT verified complete. Viewer-side continuity now restores same-subject non-secret model routing after reauthorization and handles bounded single-flight redemption, late responses, storage failures, and channel failures. Forty-three focused renewal/recovery/API tests pass. A workspace without its Operations opener still lacks a supported silent transport; that cross-application change needs separate authorization. See `WORKSPACE_RENEWAL_CONTINUITY.md`.

The combined Linux storage suite passed 130 tests without failures or skips after the diagnostics allowlist integration. Point-controller browser checks used the shipped control implementation with synthetic decoded hits; they are not proof of full real-data Potree/GPU behavior. Production Rome currently exposes three retained ready outputs and a blocked safety-proof warning. No production bytes have been removed.

The preintegration Linux baseline completed 970 tests: 950 passed, zero failed,
20 skipped (including browser-dependent tests where no browser executable was
available). This is not the final image gate.

Access-status regression: a second denied tile replaced a blocked-access message
with "renewing access" even though no renewal had started. The regression failed
before the local status-only repair and passes after it. Twenty-two focused
tile/cloud/session recovery tests pass. Current-generation denials still fail
closed; revoked access is not silently reissued. Diagnostics now retain one
credential-free last-failure record with mode, renderer mode epoch, access
generation, status where known, and renewal state.

A fresh production Rome review session switched model → point cloud → Fit to
Screen → model and resumed Detail 20 with 52 tiles. Its visible heap reading
dropped from approximately 1,314 MiB in cloud mode to 795 MiB after returning,
then rose as the new mesh loaded. This establishes that this particular fresh
session did not reproduce the user's access denial, not that expiry is fixed
or all underlying browser/GPU allocations were freed. The original denial still
needs failure-time attribution; the user had already refreshed that session.

User acceptance: textured-model behavior is otherwise satisfactory. Preserve it. Prioritize consistency among model, point cloud, orthophoto, DSM, and DTM while retaining controls specific to each product.

## Direct sharing follow-through

- [x] Ready-model public sharing is an explicit action; open/cancel only reads.
- [x] Verified activation/link/audits/receipt are atomic; replacement exposure
  requires consent; password optional and downloads off.
- [x] Individual client sharing requires an exact Operations model association,
  task scope, and future=false. Whole-project/future access are explicit opt-ins.
- [x] Creation success is separate from clipboard success; same-form uncertain
  retries retain the original idempotency key and consent payload.
- [x] Executed UI-handler/layout/dialog regressions: 61/61 passed; focused Linux
  backend/access regressions: 56/56 passed. These are not the final browser/image gate.
- [ ] Direct authenticated-client sharing of a private ready model still needs
  the Operations activation/association/grant contract. Do not claim this path
  is complete or create an unwanted public link as a workaround.
- [x] Selected synthetic in-app browser QA and exact local runtime-image gates passed; full production browser soak and deployment remain pending. See `STORAGE_VIEWER_LOCAL_QA.md`.

Detailed contract: [DIRECT_SHARING_IMPLEMENTATION_REVIEW.md](DIRECT_SHARING_IMPLEMENTATION_REVIEW.md).
