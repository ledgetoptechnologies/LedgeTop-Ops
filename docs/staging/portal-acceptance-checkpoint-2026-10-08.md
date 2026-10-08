# Portal acceptance checkpoint — 2026-10-08

- Priority remains PA–Operations synchronization, then authenticated client access to explicitly shared data. Workforce and Viewer expansion are not release prerequisites for this checkpoint.
- This isolated patch starts from reviewed candidate `41eb94aa84222067fb8c3aa875a3e15644786db4`. The three tested follow-up commits are published to draft PR #146 at `b81d1f3bd9b034a7b73b97e2c5475eb6bc04fb9c`. They have not been merged or deployed. Exact-revision CI run `37782110707` started; its final result must be checked rather than inferred from the local tests.
- The staff permissions screen manages legacy overrides, not native enrollment grants. Asking an operator to use that screen to issue `directory.enrollment.manage` does not solve the acceptance prerequisite.
- The existing audited staging authority packet already supports three client-creation permissions. The window/recovery tooling now exposes that mode explicitly with `--client-creation`; default two-permission behavior remains unchanged.
- Recovery uses the exact synthetic business area recorded in the saved provision artifact. Whole-artifact recompilation, immutable receipts, atomic grant changes, and paired revocation remain enforced.
- The Directory acceptance runner now supports an already-authenticated same-origin browser transport, separate unauthenticated public-link probes, and mandatory trusted destination readback. It does not require exporting browser cookies or Cloudflare API credentials.

## Verified local evidence

- Existing authority packet/binding/window/recovery baseline: **93 passed, 0 failed**, including the complete 180-migration local database fixture.
- Updated authority window/recovery suites: **44 passed, 0 failed**, including local database-backed preparation/rollback checks.
- Directory and Project joined-acceptance runner suites: **23 passed, 0 failed**.
- Independent read-only patch review found no correctness blocker. Whitespace validation passed.
- Windows local database runtime tests required narrowly elevated execution. They passed on rerun; the sandbox startup failure was not a failed database assertion.
- Current-schema compatibility plus historical folder/recipient baseline: **8 passed, 0 failed** across three suites. Only the schema-compatibility test in that baseline applies both exact current inventories; do not describe its historical behavioral fixtures as current-chain acceptance.
- Upgraded shared-folder behavioral suite: **6 passed, 0 failed** on the exact byte-reviewed Operations 180-migration inventory, with exact ledger and foreign-key checks. All six original behavior/negative cases are retained; no runtime guards were changed.
- Operations TypeScript validation passed after connecting the isolated worktree to the existing locked Operations and Client dependencies. No packages were installed or upgraded.
- Native-recipient joined behavioral acceptance now passes both variants: **2 passed, 0 failed**, retaining the historical fixture and adding the exact reviewed candidate Operations 180 / Client 147 inventories. The shared assertions cover owner issue, verified recipient consent, durable receipt, service-home access, revocation and reconciliation. Exact migration ledgers and foreign-key checks are asserted for the current-inventory variant. Operations TypeScript validation also passes with this addition.
- These results apply to the candidate lineage identified above, not every other local branch or any deployed Worker. Git ancestry confirms the older local staging head `86d442f8c5ee635c376d5fcf2a881542fb78f3c2` is already included in this candidate. The separate older API-integration branch is not PR #146's head. Preserve any unrelated uncommitted work and verify the actual PR head before release.

## Remaining live acceptance gate

- A local, non-deploying preservation overlay and baseline composition tests pass **12/12**. The overlay pins the exact reviewed staging versions and five observed settings, rejects inversions/stale snapshots/extra data and unrelated candidate drift, and validates the original default-off pair internally. This follow-up is not included in published candidate `b81d1f3b` yet; its CI result must be evaluated separately once published. It does not replace a full live binding/config comparison or authenticated acceptance.
- Read-only deployment inspection found the current Ops staging version is `5f0ad270-0092-4f51-9534-34efc6ee2957` and Client staging version is `8bf70f8c-c3c5-494d-8c4b-474427f86350`. The baseline paired acceptance profile must not be deployed unchanged: it would reset existing authorized Ops Viewer settings. Preserve the exact independently observed non-secret flags, retain Client Viewer flags as currently false, and recheck active versions plus all unrelated settings before deployment. This is deployment safety, not Viewer feature work or permission to enable another feature.
- The user reports that Operations staging remains signed in. Do not request another login merely because browser control is unavailable.
- The browser-control runtime currently returns a filesystem permission error before page inspection. No live browser acceptance result is claimed.
- Wrangler OAuth was verified separately and is usable for scoped staging server-side checks; do not extract its encrypted credentials or repeat OAuth unnecessarily.
- Restore supported browser-tool access, verify the authenticated actor, then prepare a fresh explicitly selected synthetic area and save paired recovery evidence before opening the client-creation window.
- Run live Directory create/update/replay/conflict and trusted destination readback, then joined Project and recipient enrollment/folder access/revocation acceptance. Close the temporary authority window and verify its receipt/readback.
- Only passing live staging evidence can advance the production owner-update checkpoint. Production PA changes and production client activation remain outside this test window. Existing public links must remain unchanged.

No remote grants, production mutations, public-link changes, dependency upgrades, or deployments were performed by this patch.
