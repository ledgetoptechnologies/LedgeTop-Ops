# Storage, Viewer and workspace: local integration result

Date: September 5, 2026. This is **local verification, not a deployment or complete end-to-end acceptance claim**.

## Final daily-workspace follow-up

The user requested a final pre-push audit plus task-row simplification. Task rows now
reserve buttons for View/Download/Report/Share; noninteractive streaming notices appear
beside the title only when preparation or attention is needed. Verified available tiles
override retained failed-job status. Settings owns Rename/task removal and streaming
recovery; source removal and project removal are labeled distinctly. One New project
action remains at the page heading. Quick actions retain at least 44px targets.

Ready replaces Published in project/dashboard counts. Source sets count active draft or
finalized collections only, not archived/recycled records. Task list/detail image counts
use indexed input inventory or selected-result registered originals with provenance,
never textures, filesystem scans or retained-version sums. Unknown remains explicit.

The follow-up Linux suite passed **1051 of 1071 tests, zero failures, 20 explicit skips**.
The final status-precedence correction also passed the 16 executed task layout cases.
The in-app browser confirmed rebuilt quick actions, absence of overview deletion,
dedicated Settings with recovery, and the clarified project summary using synthetic data.
The older exact-runtime image described below predates this follow-up; the main-branch
pipeline must verify the final commit's actual production image before promotion.

Operations work is explicitly delegated by the user to their other agent; see
[OPERATIONS_VIEWER_INTEGRATION_HANDOFF.md](OPERATIONS_VIEWER_INTEGRATION_HANDOFF.md).
Neither silent openerless renewal nor private-ready client activation is claimed complete.

## Verified candidate

- Worktree: `.worktrees/storage-diagnostics-cleanup`, branch `codex/storage-diagnostics-cleanup`, based on main `6e900dd7aa3e0b20576542a56fec15c4d1387cbe`.
- Runtime image: `ltds-viewer:storage-workspace-local-candidate`.
- Image config ID: `sha256:14dc2912ad85c5c7e6157b574a3547d6c91a8dc92f4039902a1ad2109b578510`.
- Revision label/file: `storage-workspace-local-candidate`. This deliberately identifies an **uncommitted local candidate**, not a Git commit or published release.
- Original dirty main checkout, production services, real shares and stored models were not changed by these checks. No production bytes were deleted. Greenwood processing remains protected.

## Tests and image checks

The final full suite ran in a fresh build-stage image from the actual production Dockerfile, with copied source, current dependency patches, isolated temporary data and runtime networking disabled:

```text
node --test --test-concurrency=1 --test-reporter=tap 'test/*.test.js' 'test/*.test.mjs'
1062 tests: 1042 passed, 0 failed, 20 skipped
```

The skips are browser/real-model acceptance tests without their executable or dataset, plus the opt-in host-bind test. They are not counted as passed. Separate in-app browser checks below cover selected new UI paths, not every skipped scenario.

The exact runtime image additionally passed:

- Two live production-readiness tests using synthetic secrets/catalogs.
- Atomic, scoped, replay-safe source revocation test; this resolves the earlier cold Windows-bind startup timeout.
- UID/GID 568, read-only revision file, matching revision label, schema 31.
- Pinned Obj2Tiles version/source/patch/binary hash checks.
- Potree EPT routing, module worker, decoded point count, external WASM reference/file checks.
- Real synthetic converter verification: 57 artifacts, 83 compressed textures, schema version 4.

An initial reused QA base lacked the latest tile-loading dependency hook, producing five patch-fixture failures. It was discarded as release evidence. The corrected production-Dockerfile snapshot passes these tests. One obsolete source-shape assertion was aligned with the executed blocked-access regression; no recovery behavior was weakened to satisfy it.

Local detailed logs are retained in ignored `data/qa/`: `integration-audit.log`, `build-runtime.log`, and `build-audit-qa.log`. They are not production telemetry. The audit added three storage tests after the runtime image checks; runtime source was unchanged. They verify cross-category hardlink attribution, unreadable-file partial totals, and recovered original-photo versus mesh-texture classification.

## Browser checks with synthetic data

- Distinct storage category totals arrive automatically after pending measurement, including a second refresh cycle.
- Compact task facts and primary actions are visible without the old nested-panel stack.
- Dedicated Ground control points page supports selecting a source image and saving exact pixel coordinates; the saved correspondence is shown. Backend GCP import and immutable processing-file tests also pass.
- Integrated task rename uses the styled in-app dialog, focuses the current name, and Cancel preserves the original task. Separate dialog checks cover Escape, focus return, nested cancellation and invalid permanent-delete confirmation.
- Ready Share opens without mutation; open/cancel/reopen remains read-only. A synthetic passwordless link is created only by explicit submission, with downloads initially unchecked. Revocation requires a separate in-app confirmation; cancellation does not revoke.
- Whole-project sharing leaves current/future scope unchecked and blocks submission until explicitly approved. Individual client sharing never falls back to an unrelated association or whole project.
- A browser-discovered stale share-result issue was fixed: project/output/share identity bounds the copy result, and matching successful revocation or loaded revoked/expired metadata removes it. Wrong-project and cancellation/failure cases have executed regression tests.
- Point-cloud control fixtures exercise the shipped control logic. A separate real Potree synthetic LAZ fixture verifies live elevation color-range updates without removing points. These are not long-session real-site/GPU soak tests.

## Remaining requirements — do not claim complete

1. **Silent openerless workspace renewal needs Operations support.** Viewer routing persistence and redemption race fixes are implemented; they do not eliminate the sign-in round trip when the Operations opener is absent. Operations edits are not included or deployed here.
2. **Private ready-model client sharing needs the Operations activation/association contract.** Public-link creation works locally, and existing exact client associations are honored. Creating an unwanted public link is not a workaround for client-only access.
3. The user's original aged model/cloud switching denial was not reproduced in the fresh live comparison. Current denial/status, disposed-generation and renewal recovery tests pass, but production token-lifetime, sleep/wake and cross-tab soak testing remains.
4. Rome's retained outputs require real-data preservation proof after deployment. The new code keeps unknown/dependent data protected and preserves recoverability. No storage savings are claimed yet.

### Independent storage safety audit

A second reviewer, separate from the retirement implementation, inspected the
candidate selection, preservation proof, durable mutation replay and final purge
paths. No actionable deletion defect was identified. It verified explicit
same-task successful-recovery lineage, active replacement, session/publication/
shared-path/retry dependencies, registered moved-photo and product closure,
pre-intent and pre-purge revalidation, permanent opt-out after owner restore, and
preserved history/deadlines. Platform-dependent execution is covered by the final
Linux suite above; the review itself is not proof of current Rome eligibility.

Automatic retirement is deliberately limited to proven superseded outputs from
successful recovery. It is **not** a general age-based deletion policy for failed
runs: failed/retryable dependencies and unknown originals remain protected.
Greenwood's active-work guard cooperatively defers maintenance (including checks
during hashing); it is not an exclusive system-wide maintenance lock.

## Release/retest order

- Resolve the two Operations integration boundaries above before calling the entire request complete.
- Once approved code is committed, rebuild using the actual commit revision and rerun image gates. This local label must not be promoted as a commit attestation.
- Deploy only when Greenwood and any other active processing can safely tolerate the release; do not interrupt the import for UI QA.
- In fresh Viewer sessions test close-surface priority, cloud orbit after prolonged navigation, model/cloud pose transfer, live DEM settings and GCP flow.
- Test normal expiry and sleep/wake with and without the Operations opener; confirm pose/content survives valid renewal and genuine revocation remains enforced.
- Inspect Rome cleanup decisions and recoverable trash before any expiry purge. Verify originals, photos and all products remain available. Do not delete merely because an output is old.

Related: [scope checklist](STORAGE_VIEWER_UPDATE_CHECKLIST.md), [renewal contract](WORKSPACE_RENEWAL_CONTINUITY.md), [sharing contract](DIRECT_SHARING_IMPLEMENTATION_REVIEW.md), [storage accounting](STORAGE_DIAGNOSTICS_ACCOUNTING.md).
