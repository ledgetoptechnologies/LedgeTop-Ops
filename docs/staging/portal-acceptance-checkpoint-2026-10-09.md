# PA–Ops and portal acceptance — October 9

## Priority and boundary

- Finish staging PA–Ops synchronization, then recipient login and selected-data access. Workforce and Viewer are not this release's critical path.
- No production PA update, production client activation, production portal cutover, or existing public-link change is authorized by this checkpoint.
- Do not control the owner's desktop. The currently available tools cannot inspect the signed-in in-app browser. Do not export its session credentials as a workaround.

## Current verified deployment observations

- Earlier October 9 direct Cloudflare readback: Ops staging version `712b6d8c-1b14-4a98-a6d6-d5bdb6555779` and Client staging version `b791f84e-8d29-4479-b565-1ee59455dd65`, each at 100%.
- Ops staging ledger contains 182 migrations, ending in `0182_project_alpha_directory_relationship_recovery_guard.sql`.
- Recipient enrollment/owner/service-home and metadata RPC gates were enabled. Directory outbox drain, Directory profile writes, API-v2 read acceptance and API-v2 sync gates were disabled. Prior acknowledged commands are not evidence that ongoing synchronization is enabled.
- Recipient enrollment tables had no rows. The selected synthetic organization has no related client: the existing client relationship row has a null organization. A nonzero global relationship count is not proof of the required organization linkage.
- These are point-in-time observations, not a production readiness claim. Re-read state before the next write window.

## Credential recovery and transport evidence

- The user-provided private credential file does contain an account-owned Cloudflare API token. Earlier label-based parsing missed unlabeled entries. Only the uniquely identified `cfat_` token was sent to its intended Cloudflare API; unrelated credential values were not used.
- Token verification returned active. No credential value is recorded here or copied to a repository file.
- At approximately 13:59 UTC, the exact staging D1 REST transport passed a bounded rollback probe on database `78b34173-b168-4e3d-9832-bb9d245cc6b8`.
- Preflight confirmed absence of newly generated table `__codex_staging_atomicity_probe_ed2c4aded0574c6d85fd948004ea3b23`. One batch attempted CREATE, valid INSERT, then a CHECK-violating INSERT. It rejected with HTTP 400/code 7500. A separate schema query returned zero tables with that name: both earlier statements rolled back. No cleanup deletion was needed.
- Bound JavaScript number 7 is represented as SQLite `real`, compares equal to 7, and bound null remains null. An earlier read-only probe incorrectly expected `integer` and stopped before any write; that assertion was corrected to require numeric semantics rather than a particular storage type.
- This is evidence for the exact tested staging endpoint/request shape, not a new general guarantee about every Cloudflare API transaction.

## Local transport fixes and verification

- An injected platform proxy now takes precedence over an ambient API token. Explicit `dependencies.token` still selects REST. Mocked tests can no longer silently switch to live staging merely because the parent environment has a token.
- Empty SQL in a batch is rejected before fetch, alongside empty/oversized batches and malformed parameter arrays.
- Focused runner tests: **36/36 passed, zero skips**, in a process explicitly refusing a real API-token environment.
- Regressions cover proxy precedence, explicit REST selection, configuration drift before fetch, sanitized network/JSON/provider failures, malformed input, partial/failed results, exact resource pinning and proxy disposal.
- No staging authority packet was applied during this transport check. No customer, recipient, financial or public-link record changed.

## Subsequent exact-authority rehearsal

- The organization compiler/preflight passed against a fresh 182-migration staging snapshot. The live provision request then rejected with HTTP 400/code 7500.
- Before any retry, the exact saved artifact `a4f60912-07f0-4e5d-999d-d7250b93999f/provision.json` was independently reconciled: **not committed**. Approval, receipt, grants and history remain at their prior state.
- All 13 pre-write SELECT guards pass independently. A separate synthetic CREATE/INSERT/SELECT changes()/DROP batch verified `changes()=1` and removed its exact probe table.
- Read-only exact-resource aggregation found one **inactive** grant for each requested permission. The provision compiler checks only its new grant IDs, whereas the INSERT also rejects any existing grant for the same staff/permission/resource, including inactive grants. Repeated rehearsal therefore reaches a deterministic duplicate guard instead of reusing the existing inactive authority through an audited transition. Do not delete the old rows or weaken duplicate checks to get around this.
- Local organization compiler/window/full-schema tests passed **12/12**, zero skips. Despite the stale test display name saying 181, its migration loader reads and applies the full current 182-file chain. These tests currently cover fresh provisioning, not repeated activation of retained inactive rows.
- The version-2 implementation retains the exact inactive pair's IDs, validates complete chronological/contiguous audit history and current metadata, advances audit versions, and pairs activation with exact revocation. Mixed, active, ambiguous, altered-context and malformed-history states fail closed. New input/artifacts explicitly require version 2; old version-1 artifacts cannot apply. An already-committed old exact receipt can still be recovered read-only by the lower-level immutable-receipt reconciler.
- Root's combined local runner/compiler/window/full-schema run passed **54/54**, zero skips. The database test checks exact full migration-ledger equality, fresh provision/revoke, repeat activation/revoke, unchanged prior history, versions 1/2/3/4, and complete rollback when the second reactivation UPDATE fails.
- Fresh read-only staging compilation selected `reactivate`, next history versions `[3,3]`, without mutations. Independent review found no blocking safeguard gap for the paired rehearsal.
- **Live version-2 round trip passed** at approximately 14:15 UTC: provision artifact directory `fbe19d35-0b27-4062-8000-18fde7f7eda3`, paired revoke directory `a34889cd-1ae8-49ca-aede-c63f076b1d88`. The close completed, and a separate read-only reconciliation returned `reconciled-committed` for its exact receipt.
- Independent final resource aggregation returned exactly one row for each permission, both `active=0`: no duplicate grants and no temporary organization authority left active. Grant/history versions advanced through audited activation and revocation; no customer, recipient, publication, financial record or public link changed.
- Nonblocking tooling follow-up: the window CLI itself compiles before receipt lookup, so its `reconcile` command does not support historical version-1 artifacts even though the lower-level helper can recover an already-committed exact version-1 receipt read-only. Keep apply/close version-2-only; add an explicitly read-only compatibility branch if historical CLI reconciliation is needed. The failed version-1 artifact above was already proved not committed before the version change.

## PA-first project implementation review

- The separate generic adoption-candidate API is the correct discovery mechanism; normal bound-project inventory should not be widened.
- Source review identified a missing first-party destination reservation before review, plus a missing normal adoption finalizer after queuing the bind. Existing successful fixtures pre-create the destination and therefore miss the first gap; a queued bind is not an acknowledged mapping.
- See `pa-first-project-adoption-gap-2026-10-09.md` for precise source evidence and the test-first implementation order. Neither gap is resolved merely by enabling a flag or granting broader access.

## Remaining release gates

### Latest local follow-up (October 9)

- After independent review, the authority compiler now also requires exact admission/profile/generation snapshot shapes and distinct, fresh UUIDv4 approval identifiers. Root reran the combined runner/compiler/window/full-schema suites: **55/55 passed, zero skips**. This supersedes the earlier 54-test local count; it is not an additional live authority rehearsal.
- Ops build and TypeScript check passed. The isolated headless Edge adoption UI regression passed on desktop and mobile (**2/2**), including frozen retry payloads and an explicit confirmation that review durably reserves the destination. No signed-in browser session or desktop input was used.
- The missing-destination producer fix and normal bind finalizer are being implemented and independently reviewed in separate files. The UI checks use mocked API responses; they do not prove live destination creation, remote binding acknowledgement, or client access.
- At **14:29 UTC**, fresh read-only Cloudflare observations still show Ops staging version `712b6d8c-1b14-4a98-a6d6-d5bdb6555779` at 100% and the same 182-file migration ledger. API-v2 sync, Directory profile writes/drain, adoption review and recipient enrollment/owner gates currently read **false**; the new finalization flag is absent. This later read supersedes earlier recipient-gate observations. No runtime flag or deployment was changed by the read.
- The new private finalization route accepts only reservation/command UUIDs, requires a matching command idempotency key and a fresh server-authenticated native identity, and returns only whitelisted stage outcomes. Default-off base configuration and generated Worker types are updated locally. Route/coordinator unit tests initially passed **40/40**; import-boundary/UI-contract tests passed **7/7** and generated-types verification passed. The finalizer is still under review: exact current Directory relationship and active-scope checks plus real-D1 chain coverage are release blockers, not satisfied by the mocked unit sequence.
- The destination producer fix is now independently reviewed and its full real-D1 suite passed **57/57** (294.82 seconds), with TypeScript checking also passing. A genuinely absent destination now gets pinned from the server-configured source in the same atomic batch as review evidence/receipt. Existing exact destinations are preserved; conflicting preexisting/racing destinations fail closed; failed final statements or revoked authority roll back new rows. Lost-response/concurrent-winner replay re-reads current actor, grants, local state and Directory relationships before accepting the immutable receipt. This proves local D1 behavior with synthetic remote responses, not live PA synchronization.
- The isolated default-off finalization configuration/profile is committed locally as `3f3c06f6`. Baseline plumbing regressions passed **83/83**, and the new plus unchanged acceptance-profile regressions passed **31/31**. No current acceptance profile was widened and no remote configuration was changed.
- The finalizer now reuses the bind consumer's exact durable replay checks before dispatch, post-ack settlement, activation and successful replay, including active scope and Directory relationship state. Focused route/coordinator/UI/import tests passed **49/49**. Its real-D1 composition suite passed **2/2**, including persisted acknowledgement followed by failed canonical GET and successful retry without a second command POST, exact mapping identity/name and eight unchanged portal/public-control row snapshots. Independent review identified a test gap in the raw local inventory join. The corrected stateful transport test also passed **2/2**: the real configured PA inventory reader sees no bound project before POST and exactly one matching external/public identity afterward. Remote PA responses remain synthetic.
- The actual ignored finalization staging candidate was generated and validated against the default-off baseline. Installed Wrangler `4.118.0` bundled it with `deploy --dry-run` successfully (6638.09 KiB uncompressed, 1208.10 KiB gzip); the command explicitly exited without deployment. No secret/configuration values were printed by the wrapper.
- Visible recovery references now survive error/status-message changes within the operator flow. The rebuilt isolated desktop/mobile browser tests passed **2/2**, and Operations typecheck passed. Browser responses remain mocked and do not prove staging login, real PA writes, or portal access.
- Independent static review of the corrected coordinator and stateful inventory fixture returned **GO for staging-only/default-off release**, not full release. The ignored candidate's generation/check and bundling are local evidence only.
- A preliminary portal path review missed the separate native data component and incorrectly concluded that the portal was actionless. Current source inspection confirms `OperationsHomeApp.tsx` imports and renders `OperationsNativeDataBrowser`; `operations-native-data-api.ts` calls the native deliveries/folders/file endpoints with strict opaque-ID path validation. Do not implement a duplicate browser. Focused rendering, file-access denial/revocation and navigation tests are being revalidated; live recipient sign-in/click-through remains unproven. Service-summary permission must not be treated as file permission or require legacy generic Client membership.
- Local finalizer implementation is committed as `5e6d04fb`. Author's final combined coordinator unit/full-schema run passed **12/12**, with Operations TypeScript checking also passing. No remote deployment or client access change was performed.
- The native portal browser follow-up is verified locally with no source changes: Client build passed; strict API/UI/server-route focused tests passed **46/46**; isolated desktop/mobile `operations-home.spec.ts` passed **54/54**. These cover the Operations-only shell without legacy membership, home-only file-access denial, opaque selected-folder discovery/actions, revoked/denied private-state clearing, stale-response suppression and authority revalidation. They do not replace live recipient/access acceptance.
- Candidate `d444d08280f5e89344fbe2823de4845e2026d2e2` was pushed as a fast-forward to existing staging PR #146, with a non-deploying CI step for the new exact profile. GitHub REST readback confirmed exact-revision CI run `37947387617` is in progress. Main and production were not changed.
- Fresh Cloudflare staging readback after publication still shows version `712b6d8c-1b14-4a98-a6d6-d5bdb6555779` at 100%, API sync/adoption review/Directory writes/drain/recipient enrollment and owner flags false, and finalization absent. The GitHub push did not deploy the candidate.
- Exact candidate CI found an omitted new flag in the checked-in release-evidence template, not a runtime authorization failure. The template now records finalization among default-off flags. The exact six-suite non-deploying release-gate command passed locally: **141 passed, zero failed, four Windows symlink-policy skips**. The successor revision still requires its own CI result; the prior run's other checks are not successor evidence.

- Complete the normal authorized synthetic organization/client relationship flow; do not seed around the application authorization path or reuse expired authority packets.
- Prove current Directory create/update/relationship settlement, exact replay and changed-body conflict, with independent PA readback and paired temporary-grant cleanup.
- Resolve the PA-first project discovery/adoption path. Inventory of already-bound projects alone does not satisfy project creation in either application.
- Complete live verified-recipient enrollment, service home, explicitly selected folder list/file access, cross-recipient denial and revocation.
- Run exact-revision CI, deployment/config comparisons, outage/recovery checks and rollback rehearsal before requesting the owner's production PA update checkpoint.
- Keep production update and client activation unready until these gates have actual evidence.
