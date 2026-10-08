# Portal acceptance checkpoint — 2026-10-08

- Priority remains PA–Operations synchronization, then authenticated client access to explicitly shared data. Workforce and Viewer expansion are not release prerequisites for this checkpoint.
- This isolated patch starts from reviewed candidate `41eb94aa84222067fb8c3aa875a3e15644786db4`. The enrollment/transport tooling is saved locally at `0183b45257eb8ff7ae23ed245cc90e2e668b5399`; it has not been pushed, deployed, or merged.
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
- Native-recipient end-to-end current-chain behavioral coverage remains under investigation. Schema compatibility and current-chain folder behavior do not alone prove the complete recipient flow.

## Remaining live acceptance gate

- The user reports that Operations staging remains signed in. Do not request another login merely because browser control is unavailable.
- The browser-control runtime currently returns a filesystem permission error before page inspection. No live browser acceptance result is claimed.
- Wrangler OAuth was verified separately and is usable for scoped staging server-side checks; do not extract its encrypted credentials or repeat OAuth unnecessarily.
- Restore supported browser-tool access, verify the authenticated actor, then prepare a fresh explicitly selected synthetic area and save paired recovery evidence before opening the client-creation window.
- Run live Directory create/update/replay/conflict and trusted destination readback, then joined Project and recipient enrollment/folder access/revocation acceptance. Close the temporary authority window and verify its receipt/readback.
- Only passing live staging evidence can advance the production owner-update checkpoint. Production PA changes and production client activation remain outside this test window. Existing public links must remain unchanged.

No remote grants, production mutations, public-link changes, dependency upgrades, or deployments were performed by this patch.
