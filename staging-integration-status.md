# Ledge Top Ops + Project Alpha staging status

Updated: 2026-10-07 (local candidate reassessment; no remote deployment)

## Local continuation (2026-10-07, after owner deferred Wrangler)

- Wrangler, staging deployments, and remote migrations remain on hold until the
  owner returns. No Cloudflare resource or production PA instance was changed.
- Committed only six verified Operations D1 test-fixture updates as
  `74b5b996` (`test: align portal fixtures with current directory mapping`).
  They seed the current Directory revisions/outcome rows and apply the 0170
  mapping-view contract where these focused fixtures intentionally retain an
  older migration lineage. The seven-suite local run passed **45/45** under
  elevated local Workerd; ordinary sandbox execution could not start Workerd
  and is inconclusive. No Worker or D1 deployment was performed.
- Remaining pre-existing candidate test edits and ignored `.tmp-checks`
  artifacts were not staged or cleaned. The candidate is therefore still not
  a clean release artifact.
- The six previously audited PA local branch refs remain intact: Git's
  non-forced delete rejected the first branch as not fully merged by ancestry.
  No force-delete was attempted, and no branch or working file was removed.
- After Wrangler OAuth completed, read-only `d1 migrations list --remote`
  checks using the checked-in staging configs showed Ops staging has exactly
  `0174`–`0180` pending and Client staging has no migrations pending. The
  migration-only config's referenced bootstrap directory does not exist, so it
  was not used. No remote migrations were applied.
- API-v2 monitor control, canonical activation import graph, and Directory
  read-adoption finalizer passed **20/20**; the canonical acquired-ID test and
  live-0173 Worker compatibility passed **3/3**. The finalizer suite overlaps
  with the earlier 45/45 batch, so the distinct selected local evidence is
  **11 files / 59 tests passed** under elevated local Workerd. The acquired-ID
  test took about nine seconds; its cap was tightened to 30 seconds, and the
  live-0173 test's unnecessary timeout override was removed. This remains local
  evidence, not live staging acceptance.

## Continuation refresh (2026-10-07, later)

- A fresh local rerun confirms `npm run staging:check` and
  `npm run staging:native-migrations:check` pass. The native migration-profile
  suite passes **9/9**, with **1 Windows symlink-policy skip**. Its first run
  hit Windows temp-path/Git path-length restrictions; rerunning with a short,
  workspace-owned temp directory passed. The exact temporary directory was
  removed after verifying it was empty.
- The focused API-v2 connection/sync suite passes **94/94** across seven files;
  Operations and Client TypeScript checks pass, and `git diff --check` reports
  no whitespace errors (only the existing LF-to-CRLF notice).
- Recomputed SHA-256 for the local 0172/0173 SQL files; both match the reviewed
  live-lineage pins below. This verifies local file bytes against the recorded
  pins, not a fresh comparison against remote SQL contents.
- Fresh independent review confirms PR #146 head `5d4b880e2813e501f1321d046312d7f12bea01cf`
  has a successful CI run but remains draft. Its checked-in Operations
  migrations stop at 0171 while staging D1 is at 0173. The working candidate
  still has 160 dirty paths (116 tracked modifications and 44 untracked paths),
  so it is not a safe deployment artifact. No migration or Worker was deployed.
- The CLI OAuth flow is still not complete. Wrangler's current consent page
  requests 29 scopes, including Workers and D1 write; approval is pending a
  separate action-time confirmation. No code should be copied into chat. Until
  approved or a narrower credential path is chosen, no Wrangler deployment or
  remote migration can run.
- Branch audits found no Project Alpha branch safe to delete. The Ops read-only
  inventory also found no branch proven free of unique commits, open PRs, and
  worktree dependencies. No branch was deleted.
- Staging remains unchanged: Operations D1 at 0173, Client D1 at 0228, no
  portal workspace/member/folder-binding records, and no live two-PA sync or
  client sign-in acceptance. The next release gate remains exact candidate
  reconciliation and staging acceptance; no production PA or portal changes
  have been made.
- Read-only Cloudflare D1 recheck returned zero rows written and
  `changed_db=false` for both databases. Client staging has zero identities,
  workspaces, memberships, folder bindings, and PA workspace sources. Ops
  staging has zero PA connectors, Client Hub roots, native recipient intents,
  native workspace heads, workspace publication heads, and native delivery
  authorizations.
- Source review confirms Project Alpha inventory is persisted as validated
  evidence and conflict/review candidates, not blindly copied into canonical
  Operations rows. Writes use explicit Operations-to-PA outboxes. A live
  two-source run and one-to-one reconciliation/portal publication acceptance
  are still needed before describing the integration as working end to end.

## Current continuation (2026-10-07)

- Added a canonical, non-secret input-binding SHA-256 to the joined Project-v2
  acceptance report. It binds the PA source/application, authorization
  generation, sorted scopes, and the selected organization/client proof tuples;
  raw proof values and credentials are excluded. The release evidence validator
  now requires a current passing report with this digest and a reference.
- Updated the joined-acceptance and release-evidence documentation/template.
  Focused joined-acceptance and release-evidence tests pass **69/69**, Node
  syntax checks pass, the evidence JSON parses, and `git diff --check` passes.
  The Operations TypeScript check completed without diagnostics.
- Fresh read-only Ops staging D1 checks show the migration ledger remains at
  `0173_operations_directory_intent_acquired_destination_transition.sql`.
  The existing legacy directory/project mappings and shared project are each
  present once; acquired owner claims, canonical acquisition mappings,
  reconciliation actions, and project adoption reservations are zero. The
  `0178` inbound proposal table is not present yet. Queries reported zero rows
  written; none of the `0174`–`0180` migrations or candidate Worker changes have
  been deployed.
- Wrangler `whoami` still reports unauthenticated. Current Cloudflare
  documentation confirms `wrangler login` OAuth is not granular; the bounded
  alternative is an account-owned token with Workers Editor restricted to the
  existing staging Worker and D1 Edit scoped as narrowly as available for the
  Ops staging database. No token was created or used. Awaiting the owner’s
  direction on that credential path.
- Candidate remains heavily modified and uncommitted. No production PA/Ops
  changes, client activation, public-link mutation, or branch deletion occurred.

## Continuation check (2026-10-06)

- Updated the Ops `0178` and `0179` migration hashes after tightening strict
  normalized-scope validation and all-column acquired-identity collision checks.
  Pins now match SHA-256 `eb92d93138a75329003eb18c06d714a6fb8365fcc383982a58939a9ab6969e60`
  (`0178`) and `58a00c5c0c9ddf5892062d17b3e1e7bccd47705c97777454f042cb28cdb922f7`
  (`0179`) in the native migration profile and release checklist. Regenerated
  the ignored migration profile; profile `--check` and `npm run staging:check`
  pass.
- Fresh read-only Ops staging D1 readback confirms exactly one synthetic joined
  project and one mapping. Source, PA instance, API application, public ID, and
  history epoch match exactly; D1 metadata reports `changed_db=false`, zero
  changes, and zero rows written. This is a joined-row integrity check only,
  not evidence of end-to-end API synchronization or client portal readiness.
- The inbound reconciliation guard suite passes **8/8**, including malformed
  and duplicate business-area/division scope rejection at both proposal and
  resolution boundaries, plus rollback of a rejected resolution. Operations
  TypeScript check passes. A separate Node SQLite harness passes the 0179
  cross-column preflight rollback, prior-trigger preservation, migration apply,
  and runtime collision checks. The focused Miniflare 0179 preflight suite and
  native recipient joined suite still cannot start Workerd on this Windows host;
  they terminate before assertions, so these local checks do not substitute for
  D1/Workerd CI or live staging acceptance.
- As an additional SQL-only fallback, applied every sorted Operations migration
  `0001` through `0180` to a fresh in-memory Node SQLite database with foreign
  keys enabled. All 180 files executed; `PRAGMA foreign_key_check` returned zero
  violations. This validates SQLite syntax and FK consistency, not Cloudflare
  D1/Workerd behavior, realistic migration fixtures, or application workflows.
- Wrangler CLI authentication is not established by the signed-in staging
  browser. A direct local `wrangler whoami` returned “not authenticated.” Its
  OAuth consent page requested 29 permissions, including unrelated DNS, Pages,
  AI, and Secrets Store access. I canceled that OAuth attempt rather than grant
  excess authority. No callback code was requested, copied, or replayed, and no
  staging deployment or migration was made. To continue staging deployment,
  use a narrowly scoped Cloudflare authorization limited to account/user read,
  Workers script deployment, and D1 write for staging resources.
- Added a `j9` partition to the joined portal acceptance runner for the existing
  native recipient enrollment → signed-in service-home → revocation suite, and
  extended the runner-list regression. Added the runner regression to the root
  test command and Linux CI repository-contract step. The two runner tests pass
  and `--list` shows `j9`; the Workerd-backed `j9` suite itself has not yet run
  successfully.
- Fresh read-only Cloudflare D1 readback reconfirms Ops staging at migration
  `0173_operations_directory_intent_acquired_destination_transition.sql` and
  Client staging at `0228_operations_portal_native_content_start_audit.sql`;
  both queries report zero rows written. Client staging still shows zero
  `portal_v2_workspaces`, `portal_v2_workspace_memberships`, `portal_v2_identities`,
  and `client_accounts` (zero rows written). No real or synthetic client account
  is active in the portal.
- No staging migration, Worker deployment, client activation, permission grant,
  or public-link change was made. The candidate remains dirty/uncommitted, and
  Wrangler CLI authentication is still required for deployment. Do not run the
  `0174`–`0180` suffix until D1-backed Linux/CI tests, complete chain and rollback
  review, immutable candidate freeze, and compatible-worker/mutation-freeze gates
  all pass.

## Current evidence refresh (2026-10-06)

- Read-only Cloudflare D1 checks reconfirmed Ops staging `ltds-ops-staging`
  applied through `0173_operations_directory_intent_acquired_destination_transition.sql`;
  Client staging `client-data-staging` is applied through
  `0228_operations_portal_native_content_start_audit.sql`. The current Ops
  candidate's later migrations remain unapplied. Both databases remain intact;
  the queried migration and aggregate tables reported zero rows written.
- Aggregate staging counts remain zero for Ops native recipient intents,
  recipient/workspace authority heads, and delivery authorizations. Client
  staging has zero client accounts/members/identity links/folder associations,
  workspace memberships/folder bindings, Viewer native client grants, and
  workspace publication heads. This confirms no client activation or portal
  data grant has occurred; it is not an end-to-end acceptance pass.
- A read-only fetch of the current Cloudflare bundle for `ledgetop-ops-staging`
  did not contain the Project-v2 recovery route or its feature flag. The live
  Ops bundle therefore predates this local candidate, consistent with D1 still
  at 0173. The connected Cloudflare tools expose D1 queries and Worker source
  reads, but no Worker upload/deploy operation; Wrangler remains unauthenticated.
- Re-ran `npm run check` in `apps/operations`: passed. Focused recovery writer,
  authorization-migration, and private-admin route tests passed **40/40**; the
  migration suite alone is **9/9**. These are local candidate checks only. The
  recovery route is implemented but default-off and staging-only. No staging
  migration, deployment, client access, or production change was performed.
- Local release contracts were reconciled to the 180-file Operations chain
  (base 0173; reviewed suffix 0174–0180). `npm run staging:check` passes;
  `npm run staging:native-migrations:test` passes 9/10 with one Windows
  symlink-policy skip using worktree-local TEMP/TMP; profile generate/check
  both pass. Exact-chain authority packet contracts still need review and
  verification against the updated chain before any staging migration run.
- Cloudflare OAuth callback supplied in chat did not match the browser flow's
  port/state, and neither callback port had a listening local process. It was
  not replayed. Wrangler authentication is still expired; no Cloudflare
  configuration was changed.

## Latest continuation note (2026-10-06)

- The broad focused Operations suite has now completed: **30 test files / 291
  tests passed** (20m 7s). This is local-only evidence. A new local D1 regression
  also passes **5/5** for migration 0179: pre-existing collisions across the
  acquired record ID, external ID, public ID, and owner-claim record ID reject
  the migration while retaining the old triggers; a disjoint populated state
  installs the guards. This closes a release-readiness gap in
  0179, which previously guarded future inserts but did not fail closed on a
  collision already in the database. The migration profile, requirements pin,
  and release checklist now carry the new SHA-256
  `8164b3513119b2cd5fcc0eaee9effdc63de552762898879ac5d220b1c3be0cfa`.
- The full candidate is still an uncommitted isolated worktree, not an immutable
  reviewed release revision. Do not apply its migration or deploy from this
  tree until a clean reviewed revision is prepared and verified.
- A read-only release audit confirms that the current `staging:paired-end-to-end-acceptance`
  scripts compose/check Worker configuration only; they do not exercise a live
  PA-to-Ops mapping and signed-in client data journey. The release evidence
  schema also lacks required proof of one-to-one sync, conflict immutability,
  selected-service/folder reads, and matched before/after public-link probes.
  Current Project-v2 live evidence is historical and does not prove UPDATE/BIND,
  stale/revoked denial, or lost-ack recovery. These remain required staging
  gates, not inferred from the green local suites.
- The portal rollout docs previously described Client migrations only through
  `0195`, while the canonical manifest ends at Client `0228`. Both rollout and
  release-checklist docs now call out this discrepancy and stop the migration
  procedure at `0195` until the `0196`-`0228` per-migration barriers are
  documented. No staging migrations have been applied.
- Read-only Cloudflare D1 access is available and was used to refresh the
  staging heads and aggregate empty-state evidence above. The callback most
  recently supplied did not match the OAuth request open in the browser
  (different local port and state), so it was not replayed or treated as a
  successful Wrangler login. No Worker, D1 database, secret, or setting was
  changed.
- Current Ops root branch `codex/3d-processing-control-plane` is dirty and has
  10 unresolved merge-conflict entries. A separate integration candidate exists
  at `5d4b880e` with a large uncommitted patch and 19,420 untracked temporary
  artifacts. Do not stage, commit, push, merge, or deploy from either current
  tree until a clean candidate is prepared; the Ops candidate is 871 commits
  ahead of the dirty root history and is not safe to copy file-by-file.
- Local Client Portal tests now pass **138/138** across nine focused suites
  (portal E2E/routes/repository, recipient enrollment, onboarding recipient,
  service-home, verified delivery authority, and PA portal source). The first
  sandbox run failed before test loading due to a temp rename permission error;
  the exact tests passed when rerun with narrowly elevated local test access.
- Ops candidate checks: Operations TypeScript check passed; joined Project
  acceptance harness **24/24**, Directory harness **52/52**, and joined live
  Directory harness **5/5** passed. The Directory staging runner was corrected
  to include `expectedAuthorizationGeneration` in the explicit rebind request;
  its focused suite passes **52/52**. These are local tests only.
- A fresh cross-repository contract review found and fixed a separate Directory
  capability mismatch: PA advertises `requiresExpectedPublicId` and
  `requiresExpectedRevision` for both Directory bind endpoints, while the Ops
  staging runner previously omitted them. The runner now pins both fields and
  an independent PA capability fixture prevents the mock and expected contract
  from drifting together. The runner suite passes **53/53**; staging-preflight
  suites pass **47/47**; the six focused Ops portal/inbound-project migration
  suites pass **31/31**. Windows temp-file rename restrictions required running
  the local suites with narrowly elevated test access. This is not live staging
  evidence.
- The portal safety acceptance now seeds a real Client `shares` row before
  workspace publication, recipient enrollment, and folder-grant issuance; it
  checks that row after publication, recipient authority dispatch, grant
  dispatch, and both revoke steps. PA inbound-project reconciliation now fails
  its test on non-GET calls or any PA path outside capabilities, mapped-project
  read, and binding-status read. Both strengthened D1 suites passed **4/4**.
  A full Operations test run emitted no results for more than five minutes and
  was stopped; it is inconclusive, not a pass.
- Unified Client routing coverage is now included in that D1 portal acceptance:
  service-home, Delivery content, and generic portal routes are mounted at the
  production path prefixes on one Hono Worker. The test verifies only the
  active service appears, a Delivery grant does not admit generic session or
  service-catalog access, and revoking the folder grant does not revoke
  descriptive home access. The focused suite passes **1/1**, and
  `npm --prefix apps/operations run check` passes. These remain local-only.
- Standalone Client, Operations, Ops Sync, and thumbnail-renderer type/check
  commands pass. The aggregate `npm run check` still stops at Client Wrangler
  runtime type generation because the local `workerd` process terminates on
  startup; this is an environment/runtime failure, not a reported TypeScript
  diagnostic. The portal unit suites remain green at 138/138.
- The stale full-chain assertions that expected 0178 to be the newest
  Operations migration have been updated to the 0179 chain in eight focused
  suites/manifests. The corrected Node staging suites passed **47/47** and the
  focused Operations Vitest run passed **31/31** across six files. Intentional
  migration-specific tests that target 0178 remain unchanged. These are local
  candidate checks only; the full release CI and live staging acceptance are
  still outstanding.
- A read-only `wrangler whoami` probe confirms the cached Wrangler OAuth token
  is expired and could not be refreshed. Read-only D1 tooling remains available,
  but Worker deploy/config mutation still requires a fresh Wrangler credential.
  The latest callback pasted into chat did not match the active browser flow's
  local port/state, and neither port had a listener, so it was not replayed.
  Wrangler's default write scopes are account/product-level, not staging-only;
  do not treat broad OAuth as staging-isolated.
- PA candidate now includes the existing reviewed capability-advertisement
  change (`08b21f34`) on top of the Directory authorization-generation fence.
  Focused capabilities/create/binding tests passed **22/22**; the guarded
  disposable MySQL 8.4 integration runner passed **11/11** (79 assertions) and
  removed only its generated test container/network. This does not constitute
  a staging PA deployment or live Ops↔PA acceptance.
- The separate Ops candidate still needs fresh branch hygiene, full relevant
  CI, and live staging checks. No staging sync, recipient enrollment, client
  sign-in/data-access acceptance, or portal cutover is verified. Production PA
  and production client access remain untouched and gated by the owner update
  checkpoint.
- Branch audit refreshed GitHub `main`/`dev` references (Ops `main`
  `bb8422c7`; PA `main` `1513b6a8`, protected `dev` `4c075e99`). The local
  inventory shows 176 Ops and 53 PA branches. Seventeen Ops and eleven PA
  gone-upstream/unattached candidates were checked against the refreshed base;
  all retain commits not reachable from the base, so none is safe to delete.
  The dirty Ops root also contains unresolved merge conflicts and remains
  untouched. No branch or worktree was removed.

## OAuth and migration-chain verification update (2026-10-06)

- The registered Cloudflare Code Mode MCP still has no authorized session. A
  manual OAuth login can now reach Cloudflare, but the consent request includes
  a broad account-wide scope set. I opened the consent page for the owner to
  review and stopped before approval. Cloudflare's current consent UI supports
  editing optional scopes; authorization must remain owner-approved and should
  include only the scopes needed for staging Workers/D1 work. No Cloudflare
  resources, account settings, secrets, or production systems were changed.
- Three candidate migration-chain tests were retried with local elevated
  filesystem access after the sandbox failed its temp-directory rename before
  loading tests. `reviewed-migration-chain.test.ts`,
  `recipient-enrollment-cancellation-migration-chain.test.ts`, and
  `client-portal-workspace-binding-selection.test.ts` passed **25/25**. They
  confirm the reviewed local chain contains 178 migrations ending at 0178;
  this does not resolve the live Ops staging lineage difference or prove a
  staging migration/apply.
- Five focused inbound-project reconciliation suites passed **29/29** after
  the same sandbox-only temp-directory rename issue; the elevated run covered
  D1 guards, route/review behavior, end-to-end persistence, and settlement
  adapter behavior. Operations `npm run check` and `git diff --check` also
  pass for this isolated candidate.
- Revalidated the joined Project-v2 profile and migration-only profile:
  profile/config checks passed; Project profile tests passed **9/9**; migration
  profile tests passed **9/9** with one symlink case skipped because Windows
  denied symlink creation; joined Project acceptance-harness tests passed
  **10/10**; joined Directory acceptance-harness tests passed **5/5**. These
  prove local harness constraints only, not any live staging sync.

## Follow-up verification (2026-10-06)

- The three still-running Project-v2 route/command/read-settlement suites
  completed successfully: **45/45 tests passed**. The joined recipient/project
  D1 acceptance fixture was corrected to apply canonical migration 0170 and
  then passed **1/1**. These are local candidate results, not live staging
  acceptance.
- Read-only Cloudflare D1 queries reconfirmed Ops staging's latest migration
  is `0173_operations_directory_intent_acquired_destination_transition.sql`
  and Client staging's is
  `0228_operations_portal_native_content_start_audit.sql`; each query reported
  `rows_written: 0`. The read-only Cloudflare Worker detail tool also returned
  `ledgetop-ops-staging`. This does not mean the candidate is deployed.
- A fresh `npx wrangler whoami` check still reports the cached Wrangler token
  is expired and cannot be refreshed non-interactively. It also encountered
  a sandbox permission error writing Wrangler's user log. Therefore no staging
  deploy or migration has been performed. Cloudflare's connected MCP read
  access remains usable, but its available Worker tools do not include upload
  or deploy.
- The post-acknowledgement Project-v2 recovery flow has a confirmed local
  correctness gap: if PA success is acknowledged but D1 settlement or
  activation remains unavailable past the original 10-minute authority grant,
  there is no safe retry path. A separate receipt-bound settle/activate-only
  authorization is being implemented and tested locally. Until it passes
  mismatch, expiry, revocation, duplicate, and dispatch-isolation checks, the
  new recovery path is not release-ready.
- No new staging mutation, production change, client activation, or public-link
  change occurred in this follow-up.
- The focused Client portal suite was rerun with elevated local test execution:
  **10 files / 130 tests passed**. The ordinary sandbox run could not start
  Miniflare/workerd for four D1-backed suites and reported 22 runtime-startup
  failures; the elevated rerun passed the same tests. Operations TypeScript
  check also passed after the in-flight recovery work began.
- The joined live acceptance runner now requires exact PA client
  record/public-ID/revision/projection-hash evidence before it will arm a
  project create and emits that exact non-null client relation. Its focused
  runner suite passed **11/11**, syntax checks and `git diff --check` passed.
  The API currently has no safe read-only/dry-run check for an attempted
  second Ops mapping to the same PA target; a second mutating POST may write
  ledger state or dispatch. The acceptance guide correctly treats the
  one-to-one duplicate-target assertion as a hard, still-open release gate.
- Root `npm run check` remains blocked by the Windows workerd runtime startup
  failure during Client Wrangler type generation, before package checks run.
  A `npm run staging:check` invocation concurrent with edits to migration 0180
  observed a temporary reviewed-SHA mismatch; rerun after the recovery patch
  is finalized before relying on the release-profile gate.
- Revalidated the remaining local portal rollout profiles: client-onboarding
  profile tests passed **10/10**; native portal acceptance profile tests passed
  **5/5**; paired end-to-end profile tests passed **6/6**; paired end-to-end
  CLI tests passed **10/10** with one symlink test skipped because Windows
  disallows symlink creation. These tests prove fail-closed profile generation
  and drift protection only, not live recipient enrollment or portal access.
- Client portal/recipient local tests passed **133/133** across nine focused
  suites covering Ops recipient/delivery authority, native enrollment, Client
  enrollment route, portal E2E/routes/repository, service-home, and verified
  delivery authority. They remain synthetic local evidence only.
- The broad all-API Cloudflare Code Mode OAuth callback timed out without
  approval. A narrower Workers Bindings MCP
  (`https://bindings.mcp.cloudflare.com/mcp`) is registered in Codex, but its
  consent callback also timed out without approval. Both connections report
  `Auth: Unknown`; the owner must initiate and complete a fresh consent flow
  before remote staging work. No Cloudflare resources, client access, PA
  binding, or public-link state has been changed.

## Fresh read-only staging recheck (2026-10-06)

- Wrangler CLI auth is currently expired: `wrangler whoami` reports the token
  expired and unable to refresh. `wrangler login` then opened a new Cloudflare
  OAuth request listing account/zone, Worker, and D1 write permissions plus
  unrelated service scopes. I stopped before approval; no new token was
  granted. Do not approve that broad scope solely to continue local migration
  review.
- The Cloudflare skill is installed and the official Cloudflare MCP endpoint
  (`https://mcp.cloudflare.com/mcp`) is registered in Codex, but its auth state
  is `Unknown`; no Cloudflare account tools are currently exposed in this
  session. The raw `agent-setup/prompt.md` endpoint could not be retrieved by
  the documentation fetcher (`text/markdown` unsupported), so I checked the
  official Codex setup guide instead. It recommends installing the Cloudflare
  plugin in the Codex app and completing OAuth there. The plugin directory
  search returned no Cloudflare plugin for this account. No Cloudflare resource
  or account setting was changed in this continuation.
- Client staging D1 passed the exact pinned migration-ledger gate: 147 rows,
  ending at `0228_operations_portal_native_content_start_audit.sql` with the
  expected names digest. The Client staging Worker remains at version
  `8bf70f8c-c3c5-494d-8c4b-474427f86350` (100%, deployed October 3).
- Ops staging is **not** on the migration chain pinned by this local candidate.
  The live read returned 173 rows (names digest
  `46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a`) rather
  than the expected 165-row baseline. Migrations 0001–0171 match the reviewed
  sequence, but live rows 0172–0173 are
  `0172_project_alpha_active_directory_consumer_guards.sql` and
  `0173_operations_directory_intent_acquired_destination_transition.sql`,
  while this candidate expects different files at those numbers. Do not apply
  candidate migrations 0172–0173 or run the migration-only apply until this
  lineage is reconciled with the actual staging schema and the production
  release chain.
- A read-only lineage review recovered the exact live 0172/0173 SQL files in
  a separate, dirty alternate worktree (not a clean/committed source):
  `0172_project_alpha_active_directory_consumer_guards.sql` SHA-256
  `8bff055cd1c2100e4c9bc0d86f471223e9a9f393e3b3396c3e3e2ded78159677`, and
  `0173_operations_directory_intent_acquired_destination_transition.sql`
  SHA-256 `11f1bfcfacd72d8827d9ad0dca96407d0bd1f0d5043119ad88862dd48efa8b57`.
  That worktree also has uncommitted 0174–0176 continuation migrations. The
  current isolated candidate has since copied 0172–0176 byte-for-byte, moved
  inbound-project reconciliation to 0178, and added append-only 0177 to
  preserve 0176 while requiring `operation_kind='update'`. The live-173
  synthetic D1 rehearsal and migration-profile checks now pass locally.
  Independent review of the resulting diff is in progress. This supersedes
  the initial candidate-number collision noted during the first read-only
  recheck; no remote migrations have been applied.
- Ops staging Worker remains at version
  `6709a79f-a5bb-4a19-8bb3-6af02161605f` (100%, deployed October 5). The local
  review candidate is `5d4b880e2813e501f1321d046312d7f12bea01cf`; it is not the
  deployed revision. No joined live write/project settlement or client login
  acceptance has been proven by this recheck.
- Local migration-profile retest: `npm run staging:native-migrations:test`
  passed 9 tests with 1 symlink test skipped because Windows returned `EPERM`;
  the ordinary sandboxed run had failed before assertions because its temporary
  Git fixture was unwritable. `npm run staging:native-migrations:check` also
  passed for the local candidate. Neither result overrides the live staging
  0172–0173 mismatch or constitutes a live migration-ledger gate pass.
- Local runner-contract retest: `npm run staging:ops-project-v2:joined:test`
  passed 10/10 and `npm run staging:ops-directory-v2:joined:test` passed 5/5.
  These validate that the explicit staging mutation gates and public-link
  nonmutation checks are enforced by the harness; they do not prove the live
  PA–Ops staging mutations or recipient portal flow.
- Project Alpha local contract retest: focused `SyncContractV2Test`,
  `ExternalOpsIntegrationTest`, and `ExternalOpsReadinessTest` passed **39/39**
  (356 assertions) under elevated local execution. Sandboxed PHPUnit could
  not open the existing bootstrap before tests started; no staging or
  production PA instance/database was accessed.
- Local Client portal/recipient validation: nine focused Vitest suites passed
  **142/142** under elevated local execution, covering portal authority,
  recipient enrollment, portal routes/repository/E2E, native Ops enrollment,
  service home, and verified-recipient delivery authority. The sandboxed run
  failed during Vitest temp-cache rename before loading tests; the elevated run
  completed in 204.51 seconds. These remain local synthetic tests, not live
  client sign-in/data-access acceptance.
- Local Operations API-v2 retest: seven focused sync, cursor, Directory read,
  profile write, and acquired-binding suites passed **74/74** under elevated
  local execution after the sandboxed Vitest temp-cache rename failed before
  test loading; Operations `npm run check` also passed (`tsc --noEmit`). These
  validate local contract behavior only; live staging sync remains blocked on
  the migration lineage and OAuth/read access.
- Project Alpha ref audit correction: the root checkout at
  `b847852bd33055e71a6dc94f80bdd6d78da5baaa` is on
  `codex/dev-recurring-expenses`, not `main`. Its local `origin/main` tracking
  ref is `1513b6a860a045e1a22e916e282699dea5ce2469` and already contains the
  generic API-v2 Directory/Projects implementation, including its routes,
  migrations, and tests. The clean feature worktree at
  `adfbe8776782039d1e0f5adc825ec59b3539b543` is two commits ahead of that
  tracking ref (`7afb30cf` financial portal summary and `adfbe877` binding
  generation fence); its focused API-v2 suite passed **141/141** (1,261
  assertions). These local refs do not prove the remote branch is current or
  that either revision is deployed to staging/production.

## Local continuation checks (2026-10-06)

- The Operations migration lineage now preserves the byte-exact staging base through authentic `0173_operations_directory_intent_acquired_destination_transition.sql`, followed locally by the reviewed dependent `0174`–`0176` migrations. The append-only `0177_operations_directory_acquired_intent_update_authority.sql` preserves every `0176` predicate and requires `operation_kind='update'` for the acquired-ID exception.
- The isolated inbound-project reconciliation candidate is now `0178_project_alpha_project_inbound_reconciliation.sql` (SHA-256 `04a5e7c9c78dbf5f4c32815b3a9f21b0bade34eaf7d01422e5a03bb72bcc1cb3`). Its route remains disabled by default with `PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED=false`; this local manifest update does not authorize a staging migration, deployment, or activation.
- Operations and Client TypeScript checks and Worker builds passed. Client build emitted the existing large-chunk warning. Focused Ops Directory route/writer/transport/migration suites passed 72/72 with elevated local test execution; the earlier sandboxed Miniflare run failed to start `workerd`, so that failure was environmental, not a passing assertion. Focused Client recipient enrollment/portal authority suites passed 47/47 with elevated local execution. Staging preflight, Directory acceptance-runner, and write-profile suites passed 37/37.
- The staging migration profile pins the exact 173-row remote base (names SHA-256 `46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a`; content-chain SHA-256 `cd35de12e87325fb6de854f4ecba47e5172e115f75830af9f4a908710d10a450`) and emits only `0174`–`0180`. The complete local 180-migration chain is validated separately by the profile generator. This is local fixture evidence only.
- The first post-port migration-profile `--check` found stale ignored generated output from the prior 0166–0173 candidate. That directory was preserved by moving it to `apps/operations/.staging-bootstrap/native-portal-migrations.previous-20261006`; the isolated profile was regenerated and both `staging:native-migrations:generate` and `staging:native-migrations:check` now pass. The old output remains recoverable; no SQL source or remote migration state was overwritten.
- No Cloudflare/PA staging configuration, migration, or Worker deployment was changed in this continuation. Wrangler OAuth was expired; the login attempt was stopped when asked to approve it on the user's PC. Authentication approval must be completed manually by the user before further live staging inspection/deployment. No production system was accessed or changed.
- The local candidate now adds a default-off PA-origin reconciliation workflow for mapped-project edits: it captures a fresh PA read/binding snapshot, exposes a sanitized field diff to the authorized reviewer, and records explicit accept/keep-Operations/follow-up decisions with CAS and audit checks. An inbound owner/client reassignment is forced to follow-up; prior client activation is not carried to a changed owner. This code is not merged or deployed, and no live inbound reconciliation has passed. The Ops-origin joined Project runner still lacks live update/bind and trusted PA CAS acceptance.
- New local validation: the full Operations migration chain through 0178 applies under Miniflare/D1 and executes the final shared-project update guard successfully (1/1); the direct SQL guard suite passes 4/4; the isolated reviewer-reported ownership/authority fix passed TypeScript plus 4 focused suites/25 tests; the reviewer diff/audit routes passed focused tests (21/21 and 28/28 across the reported sets). These are local synthetic fixtures, not staging evidence. Release controls pin the 178-file chain and keep `PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED=false`.
- Follow-up D1 acceptance for the inbound project workflow now passes 3/3 under Miniflare: successful accept plus idempotent replay without mapping/outbox/public-link/financial mutation, stale remote evidence rejection, and reviewer-authority drift rejection. The test pins D1 storage to a worktree-local path to avoid Windows sandbox temp-path failures. The oversized authorization predicate was split into seven independent fail-closed triggers; the direct guard/review suites pass 8/8, the Ops TypeScript check passes, and the staging migration-profile tests pass 9 with one Windows symlink-policy skip. The broader staged-packet test batch still has environment-only Windows junction/Workerd/temp-path failures, and no staging deployment or live acceptance has occurred.
- Latest local rerun: `staging-onboarding-native-only-authority-packet.test.mjs` now passes **33/33** against a fresh synthetic D1 database with the complete 178-migration schema. It covers exact replay/revoke, three-grant onboarding packet shape, malformed packet rejection, deny/expiry/active-work/ledger drift, staff fences, outbox states, post-mutation atomic rollback, and revoke receipt/history drift. The ordinary sandboxed run still terminates inside Workerd; the same test passed when run with narrowly elevated local execution. This is synthetic local evidence only, not a live staging grant or client acceptance.
- Follow-up local rerun: Operations `tsc --noEmit` passed, and the inbound-project reconciliation, guard, review, and acquired-directory-ID D1/Vitest suites passed **12/12** with isolated local D1 fixtures. These results validate the current local candidate only; they do not establish a live PA write, active mapping, recipient sign-in, or client data access.
- Follow-up portal validation: Client `tsc --noEmit` passed; the focused Client portal authority-v2, enrollment route, E2E, routes, repository, and native-recipient Ops authority suites passed **112/112** across 8 Vitest files (the package preflight added 9/9 Node tests). No client-facing staging gate was enabled by these tests.
- Follow-up connection validation: seven focused Operations API-v2 sync, transport, cursor, settlement, and D1 suites passed **66/66**; Operations `tsc --noEmit` passed. These are local synthetic contract tests only. Live staging write/mapping and recipient sign-in acceptance remain outstanding.
- Independent release-review fixes: the direct Directory acquisition route now forwards the explicitly bound PA external ID; profile-update acknowledgements require the exact next revision, including replay; inbound resolution key reuse, missing-local/present-remote relationships, and null-target/snapshot disagreements now fail deterministically. Focused regression suites passed 20 route tests, 18 acquisition tests, 7 profile-outbox tests, 51 inbound tests, and 79 authority/onboarding migration tests; Operations TypeScript passed. The full-chain inventory test passed 2/2. These results are local only; no staging writes or client access were exercised.
- With narrowly elevated local test execution, the cancellation and portal workspace-binding migration/D1 suites now pass **23/23** on the current 178-migration candidate. The ordinary sandbox run had crashed Workerd before assertions; no staging/production services were contacted.
- Final local release pins: 0178 SHA-256 `04a5e7c9c78dbf5f4c32815b3a9f21b0bade34eaf7d01422e5a03bb72bcc1cb3`; 178-migration names SHA-256 `daf71233020892e7caf83c28840aa5035007383fd078c5e7a72462916a5cbda5`; full content-chain SHA-256 `ef2b27a909c5ae7f24c3d744362348dcf3419af7f82912f5bdd3ec3fbb31bf79`. Migration-profile generation and exact-profile check pass. The profile test passes 9 with 1 Windows symlink-policy skip when its temp repository is located on a writable short path; the unadjusted Windows sandbox run fails before assertions at system-temp Git fixture setup.
- Continuation after that summary: regenerated ignored `apps/operations/worker-configuration.d.ts` from the current Wrangler config and preserved its previous bytes in `worker-configuration.before-inbound-flag.d.ts` (both remain ignored local files; prior SHA-256 `40F803B70764B7156A00D765799E87F12F4BD11537DA3F379F2A1D7D1EE0F1FC`). The generated types include `PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED`; Ops `cf-typegen:check` is current. After restoring the missing Ops Sync dependencies with `npm ci --ignore-scripts` from its existing lockfile, the full monorepo `npm run check` passed (Client, Ops, Ops Sync Worker types and TypeScript, plus Thumbnail Renderer syntax checks). Five focused Ops inbound project reconciliation/acquired-ID suites passed **17/17** in 101.51 seconds. This is local candidate evidence only; it does not alter or prove staging.
- Cloudflare follow-up: `codex mcp login cloudflare` was attempted against the already configured MCP entry, but OAuth metadata discovery failed because this session could not reach `https://mcp.cloudflare.com/mcp` (HTTP request/network resolution failure); it did not open an approval flow. The dashboard/Viewer browser sign-in is separate from Codex MCP authorization. Cloudflare's Codex setup guide recommends installing its Cloudflare plugin in the Codex app; plugin discovery surfaced no installable Cloudflare entry through the current tool catalog. No OAuth scopes were approved, and no Cloudflare account changes were made.
- The repository-wide `npm test` run was started locally after the complete `npm run check` passed. Its release/staging harness stage completed with 180 passed and 3 Windows symlink-policy skips; Client preflight passed 9/9. The sequential Windows Client Vitest stage advanced through several Miniflare workers but did not finish in about 31 minutes; I stopped only this locally launched test process to avoid indefinite resource use. No final full Client, Operations, or Ops Sync test result is claimed from that run. Focused integration tests remain the applicable local evidence.
- A fresh PA checkout rerun of `SyncContractV2Test`, `ExternalOpsIntegrationTest`, and `ExternalOpsReadinessTest` passed 39/39 (356 assertions) with `--do-not-cache-result`; the ordinary sandbox first could not open the existing PHPUnit bootstrap, while the same command passed with narrowly elevated local access. Existing unrelated PA dirty files were preserved.
- The joined Project-v2 staging-profile check exposed that the ignored local Ops staging source had not picked up the documented default-off `PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED` field. I added only that explicit `false` to the ignored local source (matching both the checked-in staging template and production default), hardened the acceptance-profile validator so the inbound-reconciliation flag must stay false in source, candidate, and production, added drift regressions, and regenerated only the ignored one-gate Project-v2 candidate. The profile suite passed 9/9, joined profile `--check` passed, the 178-migration profile check and full read-only `npm run staging:check` preflight passed, and the full monorepo `npm run check` passed again. This is local config/profile preparation only; no staging or production Worker was changed.

## Short version

The integration is **not yet proven end-to-end or ready for production cutover**.
Operations staging verified PA API-v2 read access and bounded inventories on
October 6 (Directory 14, Projects 2, no conflicts), but no synthetic write,
mapping settlement, recipient enrollment, or client sign-in has passed.
Read-only Cloudflare checks on October 6 confirm the currently deployed Ops
and Client Workers are older staging versions, the onboarding/portal launch
gates are off, and both staging databases have no Operations-to-PA client
mapping or portal membership/entitlement/folder-grant records. The migration
lineage and reviewed local safety fixes are now reconciled in an isolated
candidate; TypeScript, focused sync/guard suites, the synthetic live-173
rehearsal, and migration-profile checks pass. The remaining blocker is renewed
Cloudflare authorization, followed by staging-only deploy/migration and live
acceptance. Only then should a
synthetic Ops client be seeded and PA write/mapping plus recipient-access
flows be proven. No
production PA updates, production client access, or existing public-link
changes were made.

## Current October 6 checkpoint

- The owner browser at Operations staging completed **Verify read-only API
  connection** for the explicitly configured `project-alpha:staging` source.
  Its current result is `API v2 read connection verified · Directory 14 ·
  Projects 2`. This does not prove all configured production sources, full
  reconciliation, write authority, or client access.
- **Read one bounded inventory page** then completed for the same source:
  Directory 14 observed, 0 conflicts, page complete; Projects 2 observed,
  0 conflicts, page complete. This verifies the live bounded inventory path
  and its reported persistence result; it does not activate mappings, clients,
  recipients, folders, or public links.
- A fresh reconciliation review showed Project Alpha staging records and
  versions, but **Choose existing client record** offered no eligible
  Operations record; acquisition was disabled. Client Hub showed zero
  records, and creating a client showed no permitted Project Alpha
  destinations/business scopes. This is the present blocker for testing the
  write/sync path. No mapping or customer record was created.
- Code review found an existing safe Ops-first seed path: the staff-reviewed
  native client-onboarding approval can create a new unlinked Operations client
  without selecting a PA destination. It records an immutable approval and
  profile/audit history, and deliberately creates no PA outbox work or mapping.
  This is distinct from Client Hub's direct-create path, which requires a PA
  destination. Focused route tests for the staff approval and direct-profile
  admission passed (44 tests); Ops TypeScript check passed. The two D1-backed
  native-only approval/writer suites could not start Miniflare because the
  local `workerd` runtime terminated, so their behavior still needs a working
  D1 test run or staging acceptance. The code path is a candidate for creating
  a synthetic Ops record, not proof that live staging configuration/UI exposes
  it or that a PA mapping/write works.
- The original primary connection is still disabled and marked as using the
  original deployment configuration; last attempt and last success are both
  “Not yet.” Do not enable or rely on this legacy path for the API-v2 cutover.
- PA staging was at its login screen during the latest inspection, so current
  PA staging key scopes and Docker feature flags could not be verified or
  changed. The production PA instances remain outside this checkpoint.
- Local Ops acceptance evidence from the isolated PR `5d4b880e2813e501f1321d046312d7f12bea01cf`:
  14 focused Operations suites passed (208 tests), 8 PA↔Ops/portal contract
  suites passed (108 tests), and the Operations TypeScript check passed. The
  test runs made no source edits. These prove local contracts, not live writes,
  mappings, client sign-in, or data authorization.
- PR #146 is still open and draft at that exact head; all 10 GitHub CI checks
  currently pass. The head has not been deployed to staging, so those checks
  do not close the live write/mapping/recipient gates. This turn also passed
  21 local staging acceptance-profile tests after allowing their disposable
  temporary fixtures to use atomic file rename; the un-elevated attempt had
  four sandbox-only temp-rename failures. No source or staging data changed.
- Staging write acceptance still needs an explicitly scoped Project Alpha
  staging key and matching staging-only POST route flags. Inspect current
  capabilities first, then enable only the routes needed for the synthetic
  client/project create, update, binding, and conflict/replay tests. Do not
  broaden scopes or flags beyond that acceptance window.
- No new candidate was deployed during this read verification.
- Follow-up local release-control work adds a dedicated ignored staging
  acceptance profile for exactly `NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED`
  and `NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED`. Both remain explicitly
  `false` in the checked-in staging example and in default staging
  requirements; production must omit them or keep them `false`. The profile
  clones a validated staging config and rejects any other config delta. Its
  focused profile, staging preflight, onboarding-profile, and paired-profile
  tests passed **58/58**; Operations TypeScript check passed. Local ignored
  staging configs were rendered from canonical templates using prior
  staging-only Access/public metadata; no secrets were read or copied, and no
  Worker was deployed.
  The six Vitest suites covering the D1-backed staff admission and PA outbox
  were not proven in that earlier run because Vitest's `workerd` transform/cache
  operation did not complete. In the 2026-10-06 continuation, the targeted
  Directory route/writer/transport/0172 guard D1 suites passed 72/72 after
  elevated local execution allowed Miniflare to start; the broader staff
  admission and PA-outbox suites remain unverified.
- A separate read-only Ops staging D1 check found the PA directory outbox has
  one `acknowledged` row and zero rows in other states; no command payload was
  read. This makes the current outbox safe from accidental dispatch before a
  synthetic test, but does not prove the client write itself.
- Ops Worker build passed. Wrangler dry-run passed only with
  `--containers-rollout=none` because Docker is unavailable locally; the
  ordinary dry-run fails before validation at the configured thumbnail
  container. The candidate dry-run config carries unrelated Viewer gates as
  `false`, so I did not deploy it and risk resetting shared staging settings.
  The existing local staging configs are stale against the current reviewed
  resource inventory; staging deployment must preserve current live settings
  before the two directory-write gates are activated.
- Both staging migration lists report no pending migrations. The native
  enrollment CSRF and native content-audit secret names are present in the
  Client staging Worker secret inventory (values were not read). The Ops
  staging secret inventory also includes the onboarding handoff keyring and
  PA API-v2 connection secret; no secret values were read. These inventories
  confirm presence only, not correctness or successful use. Ops
  `CLIENT_ONBOARDING_ADMIN_ENABLED` and both Ops/Client onboarding-recipient
  bridge flags are false. Native recipient enrollment and owner flags are true,
  but native service-home flags are false. Client portal service-home and
  client-request flags are also false. No worker flag or secret was changed.
- Latest read-only Cloudflare deployment metadata: Ops staging version
  `6709a79f-a5bb-4a19-8bb3-6af02161605f` (100%, Worker version 115, Oct 5);
  Client staging version `8bf70f8c-c3c5-494d-8c4b-474427f86350` (100%, Oct 3).
  Current isolated source candidate remains `5d4b880e2813e501f1321d046312d7f12bea01cf`;
  it is not the deployed Ops revision. Live D1 migration ledgers for both
  staging databases report no migrations pending.
- Aggregate-only staging D1 queries found Ops `pa_clients=0`, recipient
  enrollment intents `0`, native recipient intents `0`, native delivery
  authorizations `0`, and workspace publications `0`; there were 4 existing
  onboarding invitation rows, which were not inspected or modified. Client
  staging has `0` client accounts, workspaces, memberships, identities,
  entitlements, folder bindings, legacy delivery grants, or folder associations.
  These counts confirm no active test-client portal path is ready.
- The canonical staging workspace owner-page route correction passed 41
  focused tests and is committed locally at `625731d4`. Publication and
  exact-revision CI for that correction are still required. Existing CI on
  the earlier published `f24a60f2` is a separate gate.
- This continuation reran 44 focused staff-onboarding/profile-admission route
  tests successfully and the Operations TypeScript check passed. D1-backed
  local acceptance still cannot start in this Windows environment: a minimal
  standalone Miniflare/D1 binding repro terminates inside `workerd`, while the
  same installed `workerd.exe --version` succeeds. Wrangler 4.118.0 is installed;
  after the user approved the OAuth scopes and completed Cloudflare consent,
  read-only remote staging D1/deployment/secret-inventory queries succeeded.
  No Cloudflare resource, deployment, secret, migration, or staging data was
  changed by those queries.

The following October 2/October 1 details are historical snapshots, not proof
of current deployment or readiness. In particular, do not infer current
staging key scopes, current PA flags, or client-portal readiness from them.

## Historical October 2/October 1 evidence

## Historical verified evidence (October 2/October 1)

- Current staging databases are `client-data-staging` and `ltds-ops-staging`.
- Fresh private full exports were created on 2026-10-01 and are ignored under `.backups/`; checksums and exact target database IDs are in `.backups/staging-native-pre-migration-evidence-20261001.json`. Do not publish or attach those exports.
- Both pre-apply read-only D1 ledger gates passed at the exact pinned baselines. The reviewed suffixes have now been applied in staging: Operations `0152`–`0163` (12 migrations) and Client `0223`–`0228` (6 migrations). Wrangler reports no migrations pending on either D1.
- The migration-only profile checker passed before apply; both profiles pin only their staging D1 database, with no Worker entrypoint, route, variables, secrets, or portal activation. Post-apply `PRAGMA foreign_key_check` returned no rows for either database. Operations workspace, recipient, and delivery authority-head tables each contain zero rows, so these migrations created no client access or delivery grants.
- Focused migration acceptance passes against the current complete chain: Ops binding-selection plus recipient-cancellation migration-chain tests, 23 passed; Client full-bootstrap migration-chain test, 1 passed after removing the obsolete 0224 migration exclusion. The focused Ops 163-migration no-access test also passed earlier (1 passed, 21 skipped). Focused Ops API-v2 Project transport, sync-route, and D1 persistence tests passed (40 tests). This turn's isolated Operations regressions passed: portal workspace-binding selection (22), reviewed migration inventory (2), authenticated delivery notification center (6), and native delivery bindings (40), 70 total. Isolated Client portal end-to-end, route, repository, and UI tests passed (17 + 39 + 19 + 38 = 113). The migration inventory assertion was aligned from 160 to 163 and now ends at `0163_project_alpha_directory_read_adoption_field_review_receipts.sql`; the checksum-backed bootstrap contract already contains that full suffix. A combined serial Operations run stalled without producing results and was stopped; individual runs completed. Client and Operations TypeScript checks passed; both Worker production builds completed successfully. Root release-invariant test for the intentionally staged Ops config hash passes after updating its normalized hash pin. A prior full Client run timed out in `workspace-v2.test.ts`, so Client full-suite status remains unverified; the full-suite checks are not being represented as passing.
- Cloudflare's live Operations staging deployment remains `757133ea-cadb-4392-b331-b69e4e59a2d8` at 100%, labeled “Staging API-v2 read acceptance candidate with preserved disabled portal gates” (observed about 9 hours before this update). Client staging version `03604bf1-ae6f-4d8e-9c25-a82be28e5642` remains at 100%. These deployed revisions are not the current local source candidate.
- Live Ops administration acceptance for source `project-alpha:staging` again observed capabilities and Directory successfully, but Project inventory/status remains `binding_stale`. I used the previously supplied staging credentials to restore the PA staging admin session; the synthetic fixture project remains visible and its existing public project link is live. Ops' read-only verification still reports the stale project binding. The portal `/portal` still says access is not provisioned for the current test identity. No client access was activated. The existing public link was not opened, copied, or changed. The exact current PA binding-status/CAS envelope has not been read back. No binding refresh, sync activation, or PA staging mutation has been attempted.
- The candidate includes an administrator-only API-v2 inventory sync-page route in the main Operations Worker, guarded by `PROJECT_ALPHA_API_V2_SYNC_ENABLED` (default `false`). The separate `apps/ops-sync` Worker is currently a webhook/HMAC-or-Ed25519 receiver, and its staging example enables legacy HMAC. It remains undeployed and must not be deployed as-is for the agreed API-v2 cutover. The API-v2 route is not a replacement for a complete durable PA↔Ops reconciliation flow; neither path has passed end-to-end sync acceptance.
- The main Ops checkout is still dirty/conflicted. A fresh read-only branch audit found 174 local branches, 142 attached to worktrees, and 25 dirty worktrees; it found **no safely removable local branches** after protecting `main`, `dev`, and active worktrees. No branch was deleted by that audit. Earlier remote-branch cleanup evidence is separate from this local-branch inventory.

## Priority order and remaining gates

1. **Unblock the staging write path:** sign into PA staging so current test-key scopes and Docker feature flags can be inspected. Keep reads enabled; enable only the API-v2 create/write/bind capabilities needed for the synthetic client/project acceptance. The actual minimal set must be derived from the live capabilities response, not guessed from historical key IDs or stale screenshots. In parallel, verify whether the already-implemented staff-reviewed native-only onboarding workflow can create one synthetic Ops record; keep it unlinked until the explicit PA acquisition/write path is ready.
2. **Prove the connection:** create or select a synthetic Operations client, write it to its explicitly selected PA destination(s), verify the returned PA IDs and exact mappings, then verify bounded reads in both directions, idempotent replay, changed-body conflict, retry/recovery, and visible discrepancy review. Test project create/link with one-to-one IDs and explicit conflict handling. Keep all writes synthetic and staging-only.
3. **Then prove client access:** verify the dedicated Client staging Access application admits the synthetic test identity, and bind it by trusted issuer+subject (never name/email matching). Confirm the selected workspace root has an effective `directory.portal_access.manage` allow with no applicable deny; publish it and require the Client receipt to be acknowledged. Use the native recipient URL `/portal/operations-recipient-enrollment/<intent>#<one-time-token>`—the old `/onboarding/<uuid>` route is unrelated. Enable only the staging service-home gates needed to show the selected service. Separately publish an exact synthetic project folder and grant that recipient only the selected folder. Test successful and denied sign-in/data reads, replay, revocation/expiry, notifications, and public-link nonmutation. No real client activation until the synthetic acceptance is clean.
4. Finish the focused Client portal tests and rerun affected Operations/Client migration, auth, and portal checks against the exact candidate.
5. Re-run staging migration-ledger, configuration, foreign-key, authority-row, and no-op checks before any staging Worker deploy. Deploy only reviewed staging versions, verify revisions/bindings, and retain rollback evidence.
6. Only after staging sync and real authorized test-client portal acceptance pass should the user update both production PA instances for a separately controlled production acceptance. Production PA, access, and links remain untouched until then.

## Branch cleanup audit (2026-10-06)

- PA ref recheck: `C:\Projects\Project-Alpha` is currently checked out on
  `codex/dev-recurring-expenses`, not `main`. Local `origin/main` is
  `1513b6a860a045e1a22e916e282699dea5ce2469`. `git branch --merged
  origin/main` found only `codex/pa-portal-eligibility-api`, which is still
  checked out in a linked worktree; no safe PA branch deletion was identified.
  The refs merged to `origin/dev` are likewise checked out. No branch changed.
- Ops currently has 176 local branches, 50 feature remotes, 40 open PRs, and 183 registered worktrees (19 dirty). No remote Ops branch is safe to remove: 41 are tied to open PRs/stacked PR bases and the remaining 9 are checked out. Eleven local-only Ops refs are patch-equivalent to `origin/main`, unattached, and have no unique commits; the separate main checkout is outside this task's writable filesystem scope, so those refs were not deleted.
- Project Alpha currently has 53 local branches, 25 feature remotes, 8 open PRs, and 46 worktrees (19 dirty). Six local-only refs are patch-equivalent to `origin/main`, unattached, and have no unique commits. Remote `db-refactor-2026-05-04` is already an ancestor of `origin/main` and has no worktree or PR dependency according to the audit. No branches or worktrees were changed. The current task could not freshly query GitHub's PR API because network access was unavailable; repeat that check immediately before any remote or local deletion.
- Preserve every dirty worktree and `main`, `dev`, `staging`, every open-PR head/base, and all unique commits. Branch deletion remains pending a fresh writable repository context and live PR/worktree recheck.

## Production boundary

No production PA update, production migration, client-access activation, or change to existing public links is included in this staging work. Do not treat staging success as proof that production has been migrated or that clients can sign in yet.

## Estimate

I would not give a reliable calendar estimate until the Client test suite completes and staging migrations/deployments are verified. The remaining work is primarily acceptance and any defects uncovered there; it is not yet a production-ready “one last toggle.”

## Current continuation audit (2026-10-06)

- Read-only subagent review covered every Client migration from `0196` through
  `0228`, including both distinct `0199` migrations. Per-migration compatibility,
  producer-drain, data-preflight, and rollback constraints are now captured in
  `docs/staging/client-portal-migration-barriers-0196-0228.md`. All referenced
  migration filenames were checked against the source tree.
- The review found a staging upload hazard: `apps/client/wrangler.staging.json`
  currently has `CLIENT_PORTAL_ENABLED`, native enrollment/authority/delivery,
  and content-start audit flags set to `true`. The checked-in example release
  evidence still marks the 0215–0228 suffix unapplied and its second migration
  list non-empty. The example is not a live readback; this mismatch is a hard
  stop on uploading that config or enabling any further path until a fresh
  Cloudflare ledger/config readback establishes the real state.
- Historical status notes conflict: one reports Client staging through 0228,
  another says the range is not applied. Therefore neither is accepted as
  current evidence. Before any staging deploy/migration, read exact Client and
  Ops staging database identities, migration ledgers, effective Worker versions
  and vars; then run FK/schema/readiness checks. If authentication is unavailable,
  do not guess or mutate staging.
- Cross-migration hazards requiring a controlled staging window include 0201's
  two-worker notification-table rebuild; 0204–0209's delivery capture/drain;
  0216–0217's durable workspace-ownership claim; 0220 and 0222's writer
  compatibility breaks; and 0223–0228's publication/recipient/folder authority
  and content-audit sequence. Rollback is generally code/flag rollback, not
  deleting migration state, grants, receipts, tombstones, or audit history.
- The current isolated Ops candidate remains dirty and uncommitted at
  `5d4b880e2813e501f1321d046312d7f12bea01cf`; no claim is made that this source
  revision is deployed. Wrangler authentication is still unresolved: the
  callback currently supplied did not match the authorization state/port in the
  open browser flow. No Cloudflare resource or production PA instance was
  changed in this continuation.
- Next safe action: complete a fresh, correctly paired Cloudflare OAuth flow
  (or use a staging-scoped token), then do read-only staging state collection.
  Only after the migration/configuration baseline is reconciled should the
  staged acceptance scripts be run or a Worker version uploaded. Production PA,
  client access, and existing public links remain unchanged.
- Follow-up source review in the dedicated PA worktree confirmed that PA
  serializes exact command replays by application/history/command ID and only
  returns a prior immutable result when type, parsed request hash, and external
  project ID match. Therefore a future lost-ack recovery can avoid adding a
  receipt-read API, provided Ops durably replays the exact original body and
  separately revalidates present authority and PA resource state before local
  settlement. Ops migration 0119 already allows an immutable event sequence
  from uncertain back to pending and then acknowledged, but the dispatcher
  hard-codes state version 2 and does not reopen terminal outbox rows. More
  importantly, the original command proof expires; recovery after expiry needs
  a separate reviewed operator authorization ledger, not implicit proof
  renewal. This remains unimplemented; the Ops dispatcher currently keeps
  uncertain outcomes terminal.
- Additional auth-free validation: `npm run staging:check` passed with no
  remote action. `staging:native-migrations:test` passed 9, skipped 1 because
  Windows denied symlink creation when the test used the default temp path; it
  passed when test temp files were redirected into the existing workspace temp
  directory. `node --test scripts/ops-project-v2-joined-live-acceptance.test.mjs`
  passed 10/10 harness tests, including exact replay, changed-body conflict,
  and public-link stability checks; these use mocked fetches and are not live
  staging acceptance. The first `staging:native-migrations:check` found its
  ignored generated Ops manifest stale; I verified the output paths were
  ignored/untracked, regenerated the isolated local profiles from the pinned
  source chain, and the follow-up check passed. Full D1/Miniflare tests still
  fail to initialize in this sandbox, and the release verifier remains blocked
  by the dirty candidate/missing final evidence. No staging or production
  resources changed.
- This continuation made the dispatcher and its focused test recovery-ready at
  the event-ledger level: failure and acknowledgement inserts now derive the
  next version from the immutable event history rather than hard-coding `2`.
  A new fixture models a separately authorized uncertain→pending retry and
  verifies event versions 1–4 and the acknowledgement foreign key. Operations
  TypeScript check passed. The targeted D1 test could not reach assertions:
  Miniflare's bundled `workerd` aborts at runtime startup (`std::terminate`).
  The test fixture is not evidence that recovery authorization exists; the
  immutable authority ledger, guarded reopen route, and live staging acceptance
  remain outstanding.

### Fresh continuation checks (2026-10-06)

- Direct read-only Cloudflare D1 queries confirmed the live staging migration
  heads: Operations `0173_operations_directory_intent_acquired_destination_transition.sql`;
  Client `0228_operations_portal_native_content_start_audit.sql`. The local
  isolated Operations candidate has pending/unreviewed migrations `0174`–`0180`.
  No remote D1 rows were written.
- Fresh `PRAGMA foreign_key_check` returned no rows for either current staging
  database. Aggregate-only queries found zero Operations recipient intents,
  recipient/workspace authority heads, delivery authorizations, or workspace
  publications, and zero Client accounts, members, identity links, folder
  bindings, or workspace memberships. These checks confirm there is no
  synthetic recipient/client authority to test yet; they do not prove runtime
  routes are working.
- The isolated candidate's `apps/operations` TypeScript check passed. The
  standalone `0180` migration test passed 6/6 when Vitest temp files were
  redirected into the workspace. This does not prove the recovery route or
  dispatcher integration. `npm run staging:native-migrations:check` and
  `npm run staging:check` correctly fail until the new migration suffix and
  reviewed migration pins are reconciled.
- Independent review found `0180` is not yet safe/integrated: the current tests
  bypass the migration when reopening the outbox, no route issues a guarded
  recovery authorization, cross-actor grant generations conflict with the
  established settlement/activation triggers, and expired lease loss lacks an
  immutable `uncertain` event. These are being corrected before any staging
  migration or deployment.
- A fresh branch/worktree audit found no safe local or remote branch deletions:
  all unattached non-protected local Ops and PA branches have unique commits;
  the rest are attached to registered worktrees. No branch or worktree was
  deleted.
- The account-level Cloudflare connector is authenticated and supports
  read-only staging D1 inspection. Wrangler 4.118.0 is installed under
  `apps/operations`, but its CLI token is expired. Its default OAuth flow asks
  for broad account write scopes; it was stopped pending the user's choice
  between that grant and a staging-scoped API token. The unrelated callback
  pasted earlier did not match a live OAuth state/port and was not reused.
- No staging migration, Worker deployment, PA write, client activation, or
  public-link mutation occurred in these checks.

### Fresh continuation checks (2026-10-07)

- The candidate now includes a reviewed, short-lived post-ack resume authority
  for the narrow case where PA accepted a project write but Ops could not finish
  its private read-settlement/local activation. The authorization is immutable
  and receipt/hash/command/source/application/history/destination/mapping/head/
  actor/generation-bound; it is visible only to settlement and canonical
  activation, not command production, dispatch, or another PA write. The route
  is staging-only and default-off.
- Focused recovery/settlement suites passed locally: **41/41**. Operations
  TypeScript and `git diff --check` passed. Earlier isolated Client portal
  Vitest execution passed **130/130** after Windows Miniflare temp permissions
  were granted. These are local tests, not live staging acceptance.
- Reconciled migration `0180` pins without changing its SQL bytes. Its SHA-256
  is `8a20c1cd35729d3a7664aaf382c1af6c7c2cda201bc7da1a99150e7eef8f6de2`; the
  180-name inventory hash is
  `8d7fdaaa7b453b32dd5e67d1a670554bc1c03aedf41c8ecadaddbbccf632e266`; the
  180-file content-chain hash is
  `92e0f44958f65467bb3e369621e801b4060159f27611a605bc24a360bbfe6d2e`.
  `staging:native-migrations:generate`, `staging:native-migrations:check`, and
  `staging:check` passed. Staging packet/window Miniflare tests passed **58/58**;
  related contract tests passed **100**, with 8 symlink-only skips on Windows;
  migration-chain Vitest passed **2/2**. The native migration-profile suite
  passed 9 tests with one Windows symlink test skipped.
- Joined project live acceptance now requires exact client proof and attaches
  every create to that client. Exact replay and changed-body conflict tests
  pass. One-to-one mapping is enforced structurally: Ops project ID is the
  primary key of `operations_shared_projects`, and a unique key covers
  `(source_instance_id, project_alpha_public_id, history_epoch_id)`. Read-only
  staging D1 `PRAGMA table_info('operations_shared_projects')`, `PRAGMA
  index_list(...)`, and `PRAGMA index_info(...)` confirmed both constraints.
  Thus no duplicate-target write is needed to test the invariant. The joined
  live acceptance still needs a postflight readback of the exact synthetic
  mapping row and the staging release must recheck the unique index; the
  harness currently does not perform that D1 postflight itself.
- Fresh read-only D1 checks still show Operations staging at migration `0173`
  and Client staging at `0228`; therefore `0174`–`0180` and the new portal
  workflow are not yet live-tested. Existing aggregate staging data remained
  unactivated, and no D1 rows were written in these checks.
- Cloudflare's account MCP connector continues to answer read-only D1 queries,
  but the separate Wrangler OAuth login timed out at the interactive Cloudflare
  sign-in page. The callback URL previously pasted belongs to a different
  Cloudflare authorization flow and was not replayed. Staging deployment and
  migrations remain blocked until the correct Wrangler OAuth flow is completed
  or a staging-scoped credential is supplied/configured.
- No production PA changes, production portal/client activation, existing
  public-link changes, staging migrations, Worker deployment, or branch/worktree
  deletion occurred in this continuation.
- Refreshed read-only branch audits found no safe deletions in either Ops or
  Project Alpha: all merged topic branches are attached to active worktrees,
  and all unattached branches retain unique commits. Protected `main`/`dev`
  branches and all worktrees remain untouched.

### Additional live staging verification (2026-10-07)

- Read-only Cloudflare D1 verification reconfirmed Ops staging migration head
  `0173_operations_directory_intent_acquired_destination_transition.sql` and
  Client staging head `0228_operations_portal_native_content_start_audit.sql`.
- The configured Ops staging D1 currently contains **0** `pa_connectors`, **0**
  `client_hub_roots`, and **0** active allow grants for
  `directory.enrollment.manage`. The active allow-grant summary contains
  `directory.identity.link`, `directory.portal_access.manage`,
  `directory.profile.edit`, and `directory.profile.view` only. All queries were
  read-only (`changed_db=false`, `rows_written=0`). This is a concrete staging
  blocker: no PA source is available to link, and client onboarding cannot
  select an authorized enrollment scope. No grant, connector, or client record
  was created.
- The Cloudflare account connector OAuth completed and read-only Worker/D1
  inspection now works. A separate Wrangler CLI OAuth is required for staging
  migration/deployment; the prior least-scope Wrangler login (account/user
  read, Workers/D1 write) also timed out while waiting for sign-in. No Wrangler
  token or deployment credential was issued to chat.
- Fresh local checks: Operations and Client TypeScript checks passed;
  `staging:check` and `staging:native-migrations:check` passed; three focused
  Operations integration suites passed **6/6**. The full monorepo check hit a
  `workerd` runtime crash during Client generated-runtime type validation, but
  the isolated Client TypeScript check passed. No remote migrations, Worker
  deploys, PA writes, client activation, or public-link changes occurred.
- Read-only PRAGMA checks confirmed the live Ops unique key on
  `(source_instance_id, project_alpha_public_id, history_epoch_id)` and the
  Project Alpha mapping table's primary key on `external_project_id` plus
  uniqueness on `(source_instance_id, project_alpha_public_id)`. No synthetic
  project mapping has yet been created or read back, and joined live acceptance
  remains incomplete.
- Local connector/bootstrap coverage was expanded by rerunning four focused
  suites: `project-alpha-connectors`, connector sync/admin, and API-v2
  connections passed **95/95**. Source review confirms the durable connector
  registry is materialized from the deployment-owned `PROJECT_ALPHA_CONNECTOR_SOURCES`
  manifest and its separate credential envelope; `PROJECT_ALPHA_API_V2_CONNECTIONS`
  is the API-v2 transport. The live secret values and even secret presence were
  not inspected. The empty-enrollment fixture is intentionally only a
  synthetic Operations organization fixture; it does not provision a PA
  connector or activate a customer portal account.
- Wrangler OAuth expired again while waiting for the user's Cloudflare sign-in.
  The Edge tab may still show a stale login page, but no CLI session is active.
  Wait for the user to confirm they are ready before starting another fresh
  authorization flow.

### Continuation after Wrangler authorization (2026-10-07)

- Wrangler `whoami` now succeeds using the existing account OAuth session for
  `bkoltz@ledgetoptechnologies.com`; the CLI reports account/user read,
  `workers_scripts:write`, and `d1:write`. The user's pasted localhost callback
  URLs were not replayed: their ports had no listening callback process. No
  additional OAuth sign-in is needed for the read-only version/secret inventory
  performed here.
- Read-only Wrangler inventory identifies Operations staging deployment
  `6709a79f-a5bb-4a19-8bb3-6af02161605f` (version 115) and Client staging
  deployment `8bf70f8c-c3c5-494d-8c4b-474427f86350` (version 28). The configured
  Ops secret names include `PROJECT_ALPHA_API_V2_CONNECTIONS`; Client staging
  has the recipient-enrollment CSRF and native-content audit secret names.
  Secret values were not read. This inventory does not prove that the source
  manifest, API-v2 transport envelope, or current D1 connector rows are valid.
- Fresh read-only D1 queries reconfirmed Ops at migration 0173 and Client at
  0228, with 0 PA connectors and 0 client-hub roots. No live mapping or portal
  acceptance rows were written. The deployed candidate remains older than the
  local detached, dirty candidate.
- Code review found the currently configured staging portal cannot reach
  native workspace data: the Client hierarchy and Operations/native
  service-home gates are off. The existing client joined test does not exercise
  the Client router/session/workspace/folder/file path, and no signed-in
  recipient data-read acceptance has passed.
- Additional release blockers: the Directory live harness lacks independent
  PA canonical-resource plus exact Ops D1 mapping/audit readbacks; the Project
  harness likewise lacks automated exact mapping/index postflight. The live
  recovery matrix (CREATE/UPDATE/BIND, uncertain timing, retry/concurrency,
  stale/revoked denial, and public-link/client/financial nonmutation) has no
  staging runner or evidence gate yet. Release-evidence validation does not
  currently enforce these outcomes.
- Fixed a stale Client full-chain test assertion from Ops migration 0171 to the
  candidate's current 0180 head. `npm run check` passes independently for Ops
  and Client. The focused Client+Ops complete migration-chain Vitest passes
  **1/1** after the fix (84 seconds). Staging preflight/profile tests pass
  (**194 passed, 3 skipped for Windows symlink restrictions**). The full root
  `npm test` reached Client Vitest but produced no result for several minutes;
  that test-only process was interrupted. It is not a passing full-suite
  result.
- No staging migration, Worker deployment, live client activation, PA write,
  production operation, existing public-link change, or branch deletion was
  performed. The candidate is still detached/dirty, so it is not suitable for
  deployment until focused D1 tests and live-acceptance tooling are complete,
  then a clean immutable release artifact is reviewed.

### Follow-up local acceptance and OAuth check (2026-10-07)

- The four focused Ops Project inbound-reconciliation/recovery suites passed:
  **4 files, 28 tests** (`project-alpha-project-inbound-reconciliation-e2e-d1`,
  `project-alpha-project-v2-recovery`, recovery authorization migration, and
  inbound reconciliation guards). This improves local evidence only; it does
  not prove a deployed staging sync or live PA mapping.
- Wrangler CLI authentication is **not currently active**. The previous
  `whoami` result in the prior subsection was a point-in-time result, not the
  current state. A fresh `wrangler login` flow was started, but its localhost
  callback listener did not receive a matching authorization before Wrangler
  timed out. The user-pasted callback was from the separate Cloudflare
  bindings MCP OAuth client and was not replayed. No Wrangler deployment or
  Cloudflare resource mutation occurred.
- No staging or production data/configuration was changed; all production PA,
  client activation, public-link, and release boundaries remain in force.

### Current Cloudflare staging recheck (2026-10-07)

- The signed-in Cloudflare bindings connector is available for read-only
  staging verification even though Wrangler CLI OAuth is not. It confirmed the
  Ops staging D1 database `ltds-ops-staging` is still at migration **0173**
  (`0173_operations_directory_intent_acquired_destination_transition.sql`),
  and Client staging `client-data-staging` is still at **0228**
  (`0228_operations_portal_native_content_start_audit.sql`).
- Fresh aggregate queries confirmed Ops staging has **0 `pa_connectors`** and
  **0 `client_hub_roots`**. The queries were read-only (`changed_db=false`,
  `rows_written=0`). This is the immediate integration blocker: there is no
  PA source connector or linked client root against which to run sync and
  portal acceptance.
- No staging migration, deployment, connector creation, client activation,
  production operation, or public-link change occurred. Next safe step is to
  establish the connector through the supported staging configuration/API
  using existing secret references (without reading secret values), then
  deploy/migrate the reviewed candidate and run the end-to-end acceptance.

### Portal acceptance and connector-path follow-up (2026-10-07 UTC)

- Re-ran `operations-native-portal-resource-acceptance.test.ts` against the
  current local candidate: **1 file, 1 test passed**. Together with the
  reconciliation/recovery tests above, this gives useful local synthetic
  evidence for owner enrollment, selected-service visibility, selected-folder
  file reads, revocation, and unchanged pre-existing public-share rows. It is
  not live staging evidence and does not simulate a real Cloudflare Access
  recipient session.
- Read-only inspection of the deployed `ledgetop-ops-staging` Worker bundle
  confirms its code includes the API-v2 source/read-acceptance routes and
  `PROJECT_ALPHA_API_V2_*` gates. The Cloudflare bindings connector does not
  expose effective Worker variable values or deploy controls, so this check
  proves code presence only, not that the gates are enabled at runtime.
- A connector implementation audit confirmed `pa_connectors` is intentionally
  deployment-materialized, not inferred or backfilled. `GET
  /api/admin/integrations/project-alpha/connectors` materializes the exact
  deploy-owned `PROJECT_ALPHA_CONNECTOR_SOURCES` manifest only when the
  separate Operations snapshot credential envelope is valid. The API-v2
  connection secret does not populate this registry. An enabled secondary
  `project-alpha:staging` source also requires a genuine configured primary;
  do not fabricate one or insert D1 rows. If a legitimate primary identity is
  unavailable, validate through the distinct API-v2 read-acceptance flow.
- Expanded `test:portal:joined` with group `j8` to run the local native
  selected-resource/revocation acceptance as part of the joined portal suite.
  Removed two duplicate false-valued Project Alpha keys from the Ops staging
  example and reconciled the Client rollout wording with its detailed
  `0196`–`0228` barrier document. No deployment, migration, portal activation,
  production change, or public-link mutation occurred.

### Joined acceptance rerun (2026-10-07 UTC)

- Raised the `j3` test's per-test timeout from 60 seconds to 120 seconds after
  its measured 73-second runtime exceeded the old cap without an assertion
  failure. The first sandboxed retry was blocked by Windows temp-directory
  permissions; with temporary files directed to an isolated worktree folder,
  the sandboxed Workerd startup still crashed. Running the same local test
  outside the sandbox passed, confirming an execution-environment issue.
- The complete `npm run test:portal:joined` run then passed **all eight groups**:
  j1 identity/tenant isolation; j2 PA metadata non-authority; j3 operational
  memory copy-forward; j4 membership/delegation revocation; j5 delivery and
  notification authorization; j6 feedback/service-request authorization; j7
  dual-domain daily-use/browser boundaries (**16 browser checks passed**); and
  j8 native recipient enrollment, selected-resource access, and revocation.
- These are local synthetic acceptance tests, not live PA↔Ops sync or real
  Cloudflare Access recipient acceptance. Live staging remains at Ops 0173 and
  Client 0228 with zero connector/root rows, so it is **not yet ready** for the
  production PA update checkpoint. No production or staging mutations/public
  link changes occurred in this run.
- The Cloudflare Bindings MCP connector can read staging resources, but that
  OAuth session is separate from Wrangler CLI authorization. Wrangler 4.118.0
  is not authenticated; its device-code option is unavailable in this installed
  version. A fresh localhost login was started with only `account:read`,
  `user:read`, `workers:write`, and `d1:write` scopes, but timed out before
  consent. Wrangler staging queries/deployments remain unavailable until a new
  CLI login is approved.
- Revalidated live staging read-only after the local tests: Ops remains at
  migration 0173 with zero `pa_connectors` and zero `client_hub_roots`; Client
  remains at migration 0228. Both queries reported `changed_db=false` and zero
  rows written.
- Regenerated Client, Ops, and Ops Sync Worker type declarations; repository
  `npm run check` passes. The three-worker `npm run build` also passes. These
  commands built/dry-ran local artifacts only and did not deploy any Worker.
- Staging-config Wrangler dry-runs passed for Client, Ops Sync, and Ops. Ops
  required `--containers-rollout=none` because the local machine has no usable
  Docker CLI; this validates the Ops Worker package/config while deliberately
  excluding the thumbnail container rollout. No Worker was deployed.

### Current focused runner checks (2026-10-07 UTC)

- Re-ran the Project joined-live acceptance runner unit suite: **11/11 passed**.
- Re-ran the Directory joined-live acceptance runner unit suite: **5/5 passed**.
- Staging preflight tests initially hit a Windows sandbox `EPERM` while their
  fixture renamed a directory under the system Temp path. Re-running with
  `TEMP`/`TMP` pointed to the isolated candidate worktree temp directory passed
  **28/28**. This was a test-environment permission issue; no source change was
  needed.
- These checks validate local runner safety/configuration only. Wrangler remains
  unauthenticated: a fresh flow on localhost port 8976 timed out, while the
  callback the user pasted targeted a different port (58300) and was not reused.
  Live staging remains Ops 0173 / Client 0228 with no PA connector or client hub
  root. No staging mutation, production change, client activation, or public-link
  change occurred.
- Earlier sandboxed Wrangler OAuth attempts timed out without receiving their
  callbacks; the in-app browser displayed a state-matched callback URL, but
  `wrangler whoami` remained unauthenticated. A new flow is now running in the
  normal user context on localhost port 8976. It has not yet been verified by
  `whoami`; complete consent in the PC browser where this local CLI runs. No
  OAuth code was replayed and no resources changed.

### Synthetic project-to-portal provenance experiment (2026-10-07 UTC)

- A temporary local-only experiment extended the native portal recipient test
  to build its Project through the real Project-v2 plan/dispatch/settlement/
  canonical-activation path, then assert exact mapping and revision provenance.
  Those assertions passed, but the experiment failed on an incorrect assumed
  `project_alpha_project_v2_events.state='activated'` row; the expected event
  was not present, so the portal-access part did not run. All experimental
  test/runner edits were reverted; the pre-existing j8 test and registration
  remain unchanged.
- Ops `tsc --noEmit` passed after the revert. No experiment changes, evidence
  schema changes, deploys, migrations, or remote writes remain. The missing
  cross-system provenance postflight remains an open acceptance gap.

### Branch cleanup audit (2026-10-07 UTC)

- A live GitHub branch listing now shows **51 Ops** branches and **26 Project
  Alpha** branches (77 total). The Ops list contains `main`; the PA list contains
  both `main` and `dev`.
- Read-only local inventory found 176 Ops local heads / 53 cached remote refs,
  and 53 Project Alpha local heads / 27 cached remote refs. Counts include
  registered worktree branches and a symbolic remote alias; cached refs may be
  stale because the audit did not fetch.
- Ops has 58 local branch tips contained in cached `origin/main`, but every
  non-protected merged candidate is linked to a worktree. Project Alpha has one
  branch contained in `origin/main` and five in `origin/dev`; all six are
  worktree-linked. The active Ops and PA checkouts are also dirty/unique, and
  no PR-state verification was performed.
- Consequently no branch was deleted or pruned: there is no currently verified
  safe candidate under the rule to preserve main/dev, unique commits, and active
  worktree dependencies. Re-audit after those worktrees are archived and after
  refreshing remote/PR state.

### Staging and local verification refresh (2026-10-07 UTC)

- Wrangler OAuth is now confirmed in the local CLI for the Cloudflare account;
  the granted `workers_scripts`, `workers_routes`, and D1 scopes are sufficient
  for the planned staging Worker/D1 tasks. No callback code was reused or
  recorded. The non-elevated sandbox cannot read the encrypted Wrangler profile
  or write Wrangler logs, so Wrangler read-only checks and any future staging
  actions must run outside the sandbox.
- Authoritative remote reads still show Ops staging at migration `0173` and
  Client staging at `0228`, with zero Ops `pa_connectors` and zero
  `client_hub_roots`. Ops staging has the `PROJECT_ALPHA_API_V2_CONNECTIONS`
  secret name configured, but lacks the connector snapshot credential and
  source-manifest secret names. Secret values were not read. Therefore no
  PA-backed source or client portal root is currently materialized.
- The active Ops staging deployment is `6709a79f-a5bb-4a19-8bb3-6af02161605f`
  (deployed 2026-10-05 20:33 UTC). Its bundle does not include the candidate
  inbound-project recovery route. The candidate profile for API-v2 read
  acceptance was generated and validated locally only; it targets
  `ledgetop-ops-staging`/`ltds-ops-staging`, points to PA staging, and enables
  exactly its five documented temporary API-v2 gates. It has not been deployed.
- Local validations after the j8 provenance update: focused j8 passed **1/1**
  outside the sandbox; repository type generation and TypeScript checks passed;
  staging preflight passed; Client, Ops, and Ops Sync explicit staging-config
  dry-runs all exited successfully. The Ops dry-run intentionally omitted the
  thumbnail container rollout. Full repository tests were started and are still
  running in the Client Vitest phase; their final result is not yet known.
- The migration review found Ops migrations `0174`–`0180` pending. Apply only
  with the coordinated sequence recorded in
  [release-checklist.md](docs/staging/release-checklist.md): deploy and verify
  the reviewed default-off compatibility Worker against `0173` first; quiesce
  and drain writers; snapshot and run populated preflights; apply the entire
  suffix; redeploy the exact reviewed artifact; recheck health and default-off
  gates before a bounded acceptance window. No remote migration or deployment
  was run in this audit.
- The Edge Ops staging tab currently shows Cloudflare Access `unauthorized`.
  No sign-in was automated. When live owner acceptance is ready, obtain a fresh
  authenticated Ops staging session before exercising its admin routes.
- No staging or production data, secrets, links, or service configuration were
  changed in this refresh.

### Live Ops staging acceptance refresh (2026-10-07 UTC)

- The user re-authenticated Ops staging. The signed-in Administration page is
  accessible as the protected owner.
- The bounded read-only API-v2 check against the enabled `project-alpha:staging`
  source succeeded: **Directory 14 and Projects 2** were reported by the live
  capability verification. One bounded inventory page then completed for both
  kinds with **0 conflicts**. No records were auto-matched, client access was
  not activated, and no public links were changed.
- The regular legacy “Primary connection” still reports **Sync disabled** and
  “Using the original deployment configuration”; the dashboard also labels PA
  “Not configured.” This is distinct from the verified staging API-v2 read
  source above. The one-page v2 inventory is not proof of full two-instance
  source materialization or portal cutover.
- Live Client portal readiness remains incomplete: feedback, service requests,
  and request attachments are marked unverified in the Client deployment;
  delegated sharing and access-expiry notices are blocked. The Ops companion
  for expiry notices is disabled and its notification transport is unavailable.
- The complete `npm test` process produced no final result during a prolonged
  silent Client Vitest phase and was stopped after no test processes remained;
  do not count the full suite as passed. Earlier focused tests, `npm run check`,
  `npm run build`, and explicit staging dry-runs remain passed.
- Wrangler read-only deployment status confirms Ops staging is still at
  `6709a79f-a5bb-4a19-8bb3-6af02161605f` (2026-10-05) and Client staging at
  `8bf70f8c-c3c5-494d-8c4b-474427f86350` (2026-10-03); neither is this dirty
  candidate. The staged API-v2 source list currently has one source,
  `project-alpha:staging`, not two PA instances.
- A second code/config review confirms the Ops portal-readiness endpoint cannot
  prove Client runtime flags; feedback, requests, attachments, and sharing
  remain “unverified” until separate Client-side acceptance. Candidate client
  and Ops configs keep portal authority/publication gates off. Client D1 at
  `0228` alone does not prove portal access or audit-bound content delivery.
- A targeted local Vitest attempt for connector/source registry tests also
  stalled before assertions and was stopped after no Node test process remained.
  It is not a passing result. The reliable local results remain the focused j8,
  type/check/build and staging dry-run checks already recorded above.
- No Worker deployment, D1 migration, production action, client activation,
  secret read, or public-link mutation occurred.

### Read-only staging and local verification refresh (2026-10-07 UTC)

- Re-read both staging D1 databases through the connected Cloudflare D1 reader.
  Ops remains at migration `0173`; Client remains at `0228`.
- Ops contains one shared-project row and one Project Alpha mapping row. A
  read-only join confirms their external ID, source, PA instance, application,
  PA public ID, and history epoch agree exactly. This is a database-integrity
  spot check, not proof of current live API sync or a complete source inventory.
- Ops reports zero legacy connector rows, zero business-party rows, one
  Directory record, and zero Client portal roots. The inventory tables contain
  prior observation history; those counts do not prove current full-source
  parity.
- Client staging has zero portal workspaces, workspace memberships, portal
  identities, and client accounts. Client sign-in/data access is therefore not
  ready and no client access was activated.
- The targeted local API-v2 and staging acceptance Node test set passed **106**
  tests with **1** Windows symlink-policy skip and no failures. The Ops
  TypeScript check and Ops build passed. The repository-wide `npm run check`
  remains incomplete: Wrangler/Workerd crashed while generating Client runtime
  types on this Windows host.
- An additional pure API-v2 Operations unit file passed **2/2**. The
  D1-backed existing-directory acquisition suite could not execute: Miniflare's
  Workerd process terminates during startup on this Windows host, and all 19
  test failures share that runtime-startup error. Treat that suite as
  unverified, not as a product-code regression or a pass.
- A direct, read-only `wrangler whoami` check reports that the local Wrangler
  profile is not authenticated. Do not deploy or migrate until its own OAuth
  flow has completed on this machine. Do not paste any callback code into chat.
- No staging migration, Worker deployment, production mutation, Client access
  activation, secret read, or public-link change occurred during this refresh.

### Joined-project readback and acceptance follow-up (2026-10-07 UTC)

- Rechecked live Ops staging D1 after the prior refresh: migrations remain at
  `0173`. The read-only join still returns exactly one `operations_shared_projects`
  row and one matching `project_alpha_project_mappings` row; source, instance,
  application, PA public ID, and history epoch agree, and the history epoch is
  non-empty. D1 confirmed `changed_db=false` and zero writes.
- Rechecked Client staging D1: migration `0228`; portal workspaces,
  memberships, identities, and client accounts all remain zero. This is still a
  hard cutover prerequisite, not merely missing UI polish.
- Added a local-only, explicitly opted-in, read-only joined-project D1 postflight
  verifier plus four focused tests. It is pinned to the Ops staging database,
  binds the synthetic project ID as a parameter, checks the exact one-to-one
  identity tuple and uniqueness indexes, requires no-change metadata, and emits
  only counts/hashes. The tests pass **4/4**; the joined protocol suite rerun
  passes **106**, with **1** Windows symlink-policy skip and no failures. The
  staging runbook now documents the helper and the current history-epoch check.
- These files remain in an uncommitted candidate worktree alongside pre-existing
  in-progress changes; no commit, push, deployment, D1 migration, activation,
  secret read, or public-link change was performed.
- Local Wrangler still reports **not authenticated**. Browser OAuth alone did
  not complete this machine's Wrangler login; run Wrangler's own login flow
  locally before any Worker deploy/migration step. Never paste callback codes.
- Branch cleanup remains read-only: both Ops and PA branch audits found **zero
  safe deletion candidates** because every merged candidate is registered to an
  active/retained worktree or has unique commits. No branch was removed.
- A focused Operations Vitest run of project inbound-reconciliation guard and
  recovery-authorization tests passes **19/19**. The paired D1-backed migration
  fixture tests remain unverified on this host: Miniflare/Workerd aborts during
  runtime startup before those assertions execute.
- The candidate is not yet a deployable release artifact: its working tree has
  broad pre-existing modifications and untracked migration/runtime work,
  including the contiguous `0174`–`0180` suffix. The pinned migration-profile
  gate requires reviewing and freezing the exact candidate before staging
  rollout; do not apply those SQL files ad hoc to the older deployed Worker.
- Staging configuration preflight passes. The exact migration-only profile
  generator/check pass; its tests pass **9** with **1** Windows symlink-policy
  skip. Client-onboarding profile tests pass **10/10**, and native portal
  acceptance profile tests pass **5/5**; all three generated candidate profiles
  pass their corresponding drift checks. These are local configuration gates,
  not proof that the profiles have been deployed or that a client is enrolled.
- Both Worker packages now pass their direct TypeScript checks and production
  builds: `apps/operations` and `apps/client`. Client output retains the known
  large-bundle warnings; those are not build failures. This does not replace the
  separate failed root type-generation step or the missing Workerd-backed
  migration acceptance.
- A focused Client portal-route/E2E Vitest run passes **52** assertions in the
  route/routing files. The separate migrated-D1 end-to-end file cannot start its
  fixture because Workerd aborts during startup; its 17 cases were skipped and
  must be rerun on a supported Workerd host before claiming portal D1 acceptance.

### Fresh authenticated acceptance check (2026-10-07 UTC)

- The user re-authenticated the Ops staging browser. The protected-owner
  Administration page is accessible and a fresh **Verify read-only API
  connection** action completed successfully: **Directory 14, Projects 2**.
  This confirms the currently configured single staging PA source is reachable;
  it does not demonstrate full-source parity or writes.
- The same page still reports the legacy primary connection **Sync disabled**,
  only `project-alpha:staging` in the API-v2 source list, and no eligible
  unreserved local Client record on the displayed page. Reconciliation still
  has open extra-record findings requiring explicit review; no exact mapping was
  reserved or changed during this check.
- Client workflow readiness remains blocked/unverified. Live Client D1 is still
  through migration `0228`, with zero portal workspaces, memberships, identities,
  client accounts, and invitation outbox rows. No recipient can yet sign in to
  an activated portal workspace.
- Cloudflare Wrangler OAuth remained separate from the signed-in Ops browser.
  Its pending consent screen requested broad, unrelated permissions; I canceled
  instead of granting them. No callback code was requested or pasted. No
  deployment, migration, access activation, or public-link change occurred.
- Read-only D1 aggregates confirm Ops staging has **0** business-party rows,
  **0** Client Hub roots, **0** `pa_clients` compatibility rows, and exactly one
  `operations_directory_records` row—and that row is an organization, not a
  client. The live exact-record review therefore cannot currently pair any PA
  client finding with an existing Ops client. The owner-view grant is active,
  so this is missing staged client data rather than a missing profile-view grant.
- Opened one synthetic PA-client finding's review dialog without submitting it.
  Its fresh PA profile context returned unavailable; the inactive-acquisition
  action stayed disabled and no mapping/claim row was created. This isolates a
  second acceptance gap: the displayed inventory/read check succeeds, but the
  exact profile-detail reread required for safe reconciliation does not yet
  produce verifiable context. No client data was selected or changed.
- Re-ran the migration profile tests with the temporary directory contained in
  the candidate worktree: **9 passed, 1 Windows symlink-policy skip**. The
  joined acceptance-runner registration/config tests passed **13/13** and list
  J1–J9. These are local checks only; the Workerd-backed and deployed joined
  portal scenarios remain unverified.

### Wrangler reauthorization retry and focused checks (2026-10-07 UTC)

- A fresh Wrangler 4.118.0 OAuth login was attempted with the explicit scopes
  `account:read`, `user:read`, `workers_scripts:write`, and `d1:write`, with
  credential storage requested through Windows Credential Manager. It timed
  out before Cloudflare returned an authorization callback. No callback code
  was requested or copied. Until `wrangler whoami` succeeds, no deployment or
  staging migration can run through Wrangler; a new login must be completed
  interactively in the user's Cloudflare session.
- Fresh local checks: Operations TypeScript check passed; Client TypeScript
  check passed; the three joined portal/Project/Directory runner test files
  passed **18/18**. These verify local type safety and runner guards, not the
  live API sync, migrations, or Client portal login.
- Fresh read-only staging D1 recheck: Operations latest applied migration is
  `0173`; Client latest is `0228`. Operations still has zero business-party
  rows and zero Client Hub roots, with one directory record (an organization).
  Client still has zero workspaces, memberships, identities, client accounts,
  and invitation-outbox rows. The Directory type-count query used an outdated
  column name and failed read-only; existing row-level evidence still identifies
  the only Operations directory record as an organization.
- Ops branch audit found 57 locally merged Ops branches, all checked out in
  registered worktrees; there are no safe branch-deletion candidates. No branch
  was deleted. `main` remains protected and no `dev` branch was present in the
  accessible Ops refs.

### Recipient authentication acceptance update

- The native recipient acceptance test now signs a local Cloudflare Access
  assertion and exercises enrollment and service-home through their production
  authentication resolvers. It also checks wrong-issuer `401` and valid-but-
  ungranted-subject `403` outcomes, including revocation through the HTTP
  router. The delegated focused Vitest run passed **1/1**; a repeat in this
  sandbox could not start because Windows denied Vitest's temporary cache
  rename (`EPERM`). This is stronger local auth-path evidence, but not live
  staging proof.
- A second fresh Wrangler login process was started and remained waiting for
  browser authorization, then timed out without receiving a callback. The
  corresponding `wrangler whoami` check remains unauthenticated. No deployment
  or staging mutation occurred. Complete a fresh interactive Wrangler OAuth
  flow in a browser on this same PC while the CLI process is waiting; do not
  paste or forward its callback URL/code.
- Re-read both staging D1 databases directly through read-only Cloudflare
  queries. Ops is still at migration `0173`, with **0** `pa_connectors`, **0**
  `business_parties`, **0** Client Hub roots, and **1** Operations directory
  record. Client is still at migration `0228`, with **0** `portal_v2_workspaces`,
  memberships, identities, client accounts, and invitation-email outbox rows.
  The Client query used the actual deployed `portal_v2_*` table names after a
  schema read; no rows were written. Thus staging still has no enrolled portal
  recipient and cannot demonstrate client sign-in yet.
- The provisioning-path audit confirms no existing ignored-profile generator or
  bootstrap script creates the synthetic connector, Hub root, or recipient.
  The connector is materialized only from a deployment-owned source manifest
  and credential envelope; the Hub root must come from trusted PA source
  indexing, and workspace/recipient authority must use the supported native
  lifecycle (never direct D1 inserts). The staging rollout doc incorrectly
  named Operations `0179` as the candidate endpoint; it is corrected to
  candidate `0180` while preserving live baseline `0173` and the unapplied
  `0174`–`0180` suffix. This candidate doc edit is local and uncommitted.
- The first fresh-bootstrap run exposed that the candidate's recorded
  180-file content-chain digest was stale. Recomputed against the present exact
  180-file name inventory, the unchanged former 171-migration prefix still
  hashes to its prior reviewed digest (`e3feca…1b5c`), all 22 migration files
  explicitly covered by the staging per-file checksum map match, and the
  resulting full-chain digest is `92e0f449…bbfe6d2e`. Updated all candidate
  bootstrap/authority packet pins and tests to that value without changing SQL.
  The first re-run was still needed after the stale-pin correction; the latest
  local rerun now passes 16 tests with 7 Windows symlink-policy skips and no
  failures (recorded below).

### Fresh staging readback and joined Directory acceptance strengthening (2026-10-07 UTC)

- Requeried both staging D1 databases read-only through the configured Cloudflare
  connector. Ops is still at migration `0173`; `pa_connectors`,
  `business_parties`, `client_hub_roots`, and native recipient intents each have
  **0** rows. Client is still at migration `0228`; `portal_v2_workspaces`,
  `portal_v2_workspace_memberships`, `portal_v2_identities`,
  `portal_v2_invitations`, and `portal_v2_invitation_email_outbox` each have
  **0** rows. Both queries reported zero database writes.
- The joined Directory live-acceptance harness was strengthened locally to
  verify the exact one-to-one Ops/PA identity mapping, duplicate/collision and
  missing-row failures, PA binding revision/readback acknowledgement, and an
  unchanged public-link sentinel across the test. The script and its unit tests
  pass **19/19**; source-layout invariants pass **20/20**; `node --check` and
  `git diff --check` pass. These checks did not invoke the live runner or mutate
  staging.
- Wrangler remains unauthenticated. A fresh login process with scopes limited
  to `account:read`, `user:read`, `workers_scripts:write`, and `d1:write`
  timed out without receiving its OAuth callback. The browser session is not
  sufficient evidence that Wrangler itself authenticated. Do not paste
  callback codes. No staging deploy, migration, activation, invitation, or
  public-link change has occurred.
- Production remains untouched. The candidate remains an uncommitted, broad
  review worktree at the recorded base SHA; it is not a release artifact.

### Local gate rerun (2026-10-07 UTC)

- Fresh Directory joined-runner tests plus source-layout invariants pass
  **28/28** (Directory harness **8/8**, source-layout **20/20**), including
  identity mismatch/collision and public-link-sentinel rejection cases.
- Fresh bootstrap tests complete with **16 passed, 7 skipped, 0 failed**. The
  skipped cases require Windows symlink/junction creation, which this host
  denies; all migration inventory/content pinning and disposable-fixture
  safety cases executed successfully. Test-generated fresh-bootstrap outputs
  are ignored local artifacts; no canonical migration or remote state changed.
- Direct Worker deployment remains unavailable until Wrangler's own OAuth
  login completes. The Cloudflare binding connector remains read-only for the
  remote evidence gathered in this check.
- Fresh root `npm run check` attempt stopped during Client Wrangler typegen:
  `workerd` aborted at runtime startup (`std::terminate`) before package checks
  completed. This is an environment/runtime blocker; do not report the root
  check as passing. The prior isolated Client/Operations type checks and builds
  remain valid only for the candidate state at their recorded run time.
- A fresh `git diff --check` passes; Git reports only existing LF-to-CRLF
  notices on the three generated Worker configuration declaration files.
- A read-only code trace confirms `ltds_ops` is not used by API-v2 source
  selection or sync; those use explicit per-source API keys and immutable
  source/application/history identities. The static key remains active in
  legacy event/snapshot and primary delivery-intent compatibility paths, so a
  global rename to `ltt_ops` would not repair v2 and could break LTDS legacy
  behavior. Updated `docs/project-alpha.md` to separate the legacy v1 key from
  the new v2 source contract; no runtime configuration changed.
- Direct TypeScript checks pass for Client, Operations, and Ops Sync. The full
  root `npm run check` still stops in Wrangler type generation when Workerd
  aborts.
- Client and Operations full Vitest suites were attempted with their temporary
  directories redirected into the candidate worktree. Workerd then repeatedly
  terminated with `std::terminate()` while D1-backed tests were starting; the
  suites were stopped before completion. This is not a passing full-suite
  result and leaves D1-backed local integration coverage unavailable on this
  Windows host. The narrow Node-based runner/profile/bootstrap suites above do
  pass independently.

### Authenticated Wrangler and fresh live staging checks (2026-10-07 UTC)

- Wrangler authentication is now verified. A read-only `wrangler whoami`
  succeeded using the user's existing OAuth credential in Windows Credential
  Manager. The token has account/user read, Worker script/route write, and D1
  write scopes. No callback code was requested or copied. A sandboxed attempt
  initially reported unauthenticated because it could not read
  `C:\Users\fstor\.wrangler`; the approved out-of-sandbox check confirmed the
  credential was already present. Do not request a broader OAuth grant unless
  an exact staging operation requires a missing scope.
- The staging preflight passes, and generated migration-only profiles validate.
  Read-only live migration ledger gates both pass against exact pinned history:
  Operations **173** migrations through `0173_operations_directory_intent_acquired_destination_transition.sql`
  (names hash `46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a`),
  Client **147** migrations through `0228_operations_portal_native_content_start_audit.sql`
  (names hash `1adce32fb9cad385417f3f058664ecb105559c31a5efd8c87e9f642f97a45db9`).
  Neither gate applied a migration.
- Fresh read-only Worker deployment history shows Operations staging currently
  serves version `6709a79f-a5bb-4a19-8bb3-6af02161605f` and Client staging
  serves `8bf70f8c-c3c5-494d-8c4b-474427f86350`; these predate the current dirty
  candidate. No Worker was deployed in this check.
- In the signed-in Ops staging Administration UI, `project-alpha:staging` read
  verification succeeded with Directory **14** and Projects **2**. One
  explicitly bounded inventory-page request then completed: Directory **14
  observed, 0 conflicts, page complete**; Projects **2 observed, 0 conflicts,
  page complete**. This confirms authenticated read/inventory ingestion only;
  it does not prove write, binding settlement, canonical Client Hub projection,
  conflict resolution, or portal enrollment.
- The Client Hub UI still reports **0 clients**, and Add client profile reports
  no permitted Project Alpha destinations/business scopes. Exact-record review
  likewise has no eligible unreserved local client records. Read-only D1
  aggregates show `pa_connectors=0`, `business_parties=0`, `client_hub_roots=0`,
  `operations_directory_records=1`, and
  `operations_directory_materializations=1`; the one local directory record
  is an organization. The Client D1 still has zero workspaces, memberships,
  identities, invitations, and invitation outbox rows. The inventory snapshot
  tables contain historical observations but no active project/client
  projection or portal recipient is thereby implied.
- The two remote migration gates prove the recorded staging baselines are
  current, but they do not authorize applying the candidate suffix. The
  candidate is still detached at `5d4b880e` with 134 dirty status entries,
  `RELEASE_CONTRACT_FINALIZED=false`, Operations release SHA pending, and
  `.backups/staging-release-evidence.json` missing. Per the release tooling and
  safety review, do not deploy or migrate from this tree. First create a
  human-reviewed clean file manifest and exact immutable commit; run complete
  supported CI and populated migration rehearsal; capture/verify required
  private staging backup/evidence; then repeat both live ledger gates before
  separately authorized staging migration and deployment.
- Production PA, production Ops, client access, and all existing public links
  remain unchanged.

### Directory create-path diagnosis and focused checks (2026-10-07)

- A read-only `wrangler secret list` for the Operations staging Worker confirms
  `PROJECT_ALPHA_API_V2_CONNECTIONS` is present, while
  `PROJECT_ALPHA_CONNECTOR_SOURCES`,
  `PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS`, and
  `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` are absent. Secret values were not
  retrieved or printed.
- Code tracing explains the empty Client Hub create options: the create path
  requires both an API-v2 connection and an active/read-visible legacy
  `pa_connectors` row, then a common-scope allow for
  `directory.profile.edit`, `directory.enrollment.manage`, and (for clients)
  `directory.identity.link`. Staging has no connector rows and no enrollment
  allow. This is an explicit authority/source-registry gap, not a failed API-v2
  read. Do not work around it with direct D1 inserts or by reusing legacy
  snapshot/HMAC credentials; reconcile the source-of-truth design so the
  API-v2 source configuration is sufficient for the intended API-v2 write path.
- The repository's directory-write staging profile was run in an isolated
  fixture: all **4/4** profile tests pass and prove it enables exactly
  `NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED` plus
  `NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED` on a validated staging clone. This
  test does not change live flags or deploy anything.
- Operations TypeScript check passes. A focused D1-backed Vitest run failed to
  initialize Workerd (`std::terminate`) in the normal sandbox; an elevated
  retry stalled without test output and was interrupted. Therefore none of the
  D1-backed create/write suites can yet be counted as passing on this Windows
  host. The Node-only directory-write profile suite passed; full acceptance
  still requires a supported Linux/CI or working staging test path.
- No connector secret was added, no staging authority grant was issued, and no
  PA write capability or Operations outbox gate was enabled. Staging and
  production data and existing public links remain unchanged.

### API-v2 source-registry correction (2026-10-07)

- Implemented a local, migration-free correction in the dirty review candidate:
  native Directory create/admission now derives eligible PA destinations from
  the validated, enabled `PROJECT_ALPHA_API_V2_CONNECTIONS` envelope rather
  than requiring a legacy `pa_connectors` row. UI labels are generic and
  display-only; source IDs and the validated source-instance, application,
  history-epoch, and HTTPS-origin tuple remain the authority coordinates.
- Existing-organization choices now query the active Directory mapping view
  directly and key by its canonical Operations `record_id`, not the PA
  `external_id`. The exact-one-match guard fails closed for zero or duplicate
  mappings, supporting acquired records whose two IDs differ.
- Authorization is unchanged: authenticated native staff, scoped allow grants
  for profile edit/enrollment management/client identity link, applicable deny
  precedence, immutable admission/enrollment tuples, live inventory generation,
  and dispatch-time exact PA capability checks remain required. The change
  creates no client account/access, public link, or financial record.
- Focused local checks: native Directory route tests **32/32 passed**; editor
  mapping tests **5/5 passed** (one unrelated Miniflare-backed test skipped for
  this run); Operations TypeScript check and `git diff --check` passed. Running
  the Miniflare-backed editor test still crashes Workerd on this Windows host,
  so that integration behavior remains unverified here.
- Independent read-only review agreed with the source-registry and
  `record_id` approach and found no need for a new D1 migration. It flagged the
  older invitation-review authority as a separate legacy dependency to audit
  before portal cutover; that boundary was not changed here.
- This is uncommitted local code in the existing dirty candidate. No staging
  deployment, migration, grant, PA write, or production operation occurred.
  The candidate release gate remains closed pending a clean immutable manifest,
  complete CI/migration rehearsal, and private staging release evidence.

### Acquired-ID follow-up and portal boundary audit (2026-10-07)

- An independent review found that the first fix still left an acquired-ID
  mismatch in update resolution and two Client Hub editor queries. Corrected
  the durable-head resolver to find exactly one active mapping by the full
  source tuple and Ops `record_id`, then permit the immutable Ops enrollment ID
  only for acquired-map resolution. It returns the proven PA `external_id` for
  the fresh binding read and queued update. Legacy mappings still require an
  exact external-ID match. Client Hub editor/root/child lookups now use Ops
  `record_id`, with uniqueness checks for parent and child mappings.
- Focused tests now pass: native Directory route plus durable remote-head tests
  **35/35**; acquired/editor mapping checks **5/5** (the unrelated Miniflare
  test skipped in this focused run); Ops TypeScript check and whitespace check
  pass. The Operations Worker and client assets production build also passes
  locally. The Windows Workerd crash still prevents counting the
  Miniflare-backed integration test as passed.
- A separate read-only caller trace confirms the legacy
  `invitation-review-authority.ts` path is workspace policy-review, not native
  portal onboarding/sign-in. The new portal onboarding path uses native staff
  authority and API-v2 connection configuration. Keep the legacy review path
  for compatibility; it does not block the native onboarding cutover.
- Release-profile regression suites now pass with temp storage redirected into
  the isolated worktree: staging preflight **28/28**, staging evidence
  **55/55**, native client-onboarding profile **10/10**, directory-write profile
  **4/4**, and joined Operations Directory-v2 harness **8/8**. This validates
  local guard/profile logic only; it does not imply staging flags, grants,
  migrations, secrets, Worker deployment, or client access changed.
- No staging deploy/migration or authority grant was performed. Staging still
  has read/inventory only, zero canonical client portal workspaces, and the
  release-candidate cleanliness/evidence gate remains unsatisfied.

### Windows Workerd test recovery and current portal readiness (2026-10-07)

- Reproduced the Workerd failure outside the application assertions: the
  filesystem sandbox denies `GetFinalPathNameByHandleW`. Running the test with
  normal Windows `TEMP`/`TMP` under the approved local test elevation allows
  Workerd and D1 to start. Redirecting TEMP into the worktree is not a valid
  workaround.
- Once Workerd started, the linked-client visibility regression exposed a
  stale test fixture: its simulated active-mapping view omitted `record_id`,
  and it omitted the parent organization record. Updated only that fixture to
  represent the current mapping view and organization/client records. The
  complete editor-coordinate suite now passes **6/6**, and the focused Ops
  Directory route, acquired-ID remote-head, and editor suites pass **41/41**.
- The Client portal migrated-D1 end-to-end, route, and routing suites now pass
  **69/69** with the same normal-TEMP workaround. Client and Operations
  TypeScript checks pass. These results are local test evidence; they do not
  substitute for live staging migration/deployment and recipient acceptance.
- The authenticated staging browser remains on the pre-candidate Worker. Ops
  continues to verify PA-v2 reads/inventory, Directory **14** and Projects
  **2**, but Client Hub has no canonical client eligible for pairing. The
  staging Client portal currently returns “Access not provisioned” for the
  signed-in operator, as no client identity/workspace/membership has been
  created. No synthetic client, recipient grant, staging migration, or Worker
  deployment was created in this check.
- The release gate remains closed: the candidate is dirty/detached, its
  Operations SHA is pending, release evidence/backups are absent, and staging
  runs older Ops/Client Worker versions. Next safe sequence remains: freeze a
  clean reviewed manifest, complete full supported CI and populated migration
  rehearsal, prepare private backup/evidence, then perform the separately
  authorized staging migration/deployment and synthetic client acceptance.
- Follow-up local verification in this session: native Directory route,
  acquired project inbound-reconciliation end-to-end, and project read
  settlement suites passed **52/52** when run with normal Windows `TEMP`/`TMP`
  under the approved test elevation. Both Operations and Client TypeScript
  checks passed. A larger 11-suite run produced no results and was interrupted;
  it is inconclusive and is not counted as a pass.
- A read-only GitHub ref audit confirms clean base `5d4b880e2813e501f1321d046312d7f12bea01cf`
  is the live tip of `codex/staging-portal-acceptance-tooling`, and `main`
  (`bb8422c77bbcad9093662e8da9d235c40d27282d`) is its ancestor. The dirty
  isolated review clone has a stale local `origin` pointing at the parent
  checkout; its copied remote refs must not be used as release evidence. Keep
  that review snapshot intact while preparing a clean worktree from the exact
  live candidate SHA.
- Fresh Cloudflare read-only verification (2026-10-07): `ledgetop-ops-staging`
  and `ledgetop-clients-staging` are present. Their D1 ledgers show the Ops
  staging database has 173 applied migrations through
  `0173_operations_directory_intent_acquired_destination_transition.sql`,
  while this candidate requires `0174`–`0180`; the Client staging database has
  147 applied migrations through
  `0228_operations_portal_native_content_start_audit.sql`, matching the
  candidate's latest Client migration. Aggregate row counts show zero Ops
  Client Hub roots, recipient-enrollment intents, native-recipient intents, or
  delivery-authority heads, and zero Client workspaces, memberships, identity
  links, or invitations. No D1 rows were written.
- The read-only Cloudflare MCP connection is authorized, but the local Wrangler
  CLI still reports “not authenticated.” Therefore the new Worker code/config
  has not been deployed; production and staging settings were not changed. A
  fresh Wrangler CLI login in the same local environment is still required for
  staging deployment, and its authorization code should not be pasted into
  chat.
- Focused local Operations migration verification in this session passed
  **22/22** across the reviewed migration-chain, live-0173 upgrade, acquired-ID
  collision-preflight, and project-recovery authorization suites. This tests
  the local candidate chain; it does not apply migrations to Cloudflare.
- Current staging release-profile/acceptance-tool tests passed **206/206**
  (two symlink-specific tests skipped because Windows policy disallows creating
  symlinks) across the preflight, evidence, migration profile, paired config,
  joined portal, Project-v2, Directory-v2, and PA API acceptance harnesses.
  These are local harness tests; the explicit live-rehearsal, backups, clean
  release pin, and staging deployment/acceptance gates remain open.

## 2026-10-07 continuation

- Reconfirmed the live staging Ops Worker and Client Worker are present. Read-only
  Cloudflare D1 checks still show Ops applied through migration `0173` and Client
  through `0228`; the candidate Ops suffix `0174`–`0180` remains unapplied.
- The signed-in Ops staging page completed one bounded API-v2 inventory read:
  **14 Directory** and **2 Projects** observed, zero conflicts, both pages
  complete. This confirms staging read connectivity only, not write settlement
  or portal access.
- Client staging `/portal` remains inaccessible to the signed-in staff identity
  (“Access not provisioned”). No client workspace, membership, identity link,
  recipient grant, or public-link change was created.
- The inbound-project safety change now normalizes `keep_operations` to
  `requires_follow_up`, explicitly marks it divergent, and preserves the local
  project version/head/outbox rather than falsely reporting synchronization.
  The exact D1 end-to-end suite passed **4/4** outside the Windows AppContainer;
  the route and guard suites passed **34/34** in total, and Operations
  TypeScript check passed. The AppContainer failure was independently
  reproduced with a minimal Miniflare instance and is environmental, not a
  project assertion failure.
- Wrangler remains unauthenticated until its OAuth consent is approved. The
  current request is narrowed to User Read, Background Access, Account Read,
  Workers Scripts Write, and D1 Write; these are account-scoped capabilities,
  so no deployment/migration will occur until the consent is explicitly
  approved. If approved, use them only for staging. No production PA change,
  production client activation, or public-link mutation has occurred.
- Staging deployment remains gated on consent, clean candidate assembly/review,
  release preflight, Ops migrations `0174`–`0180`, compatible staging Worker
  deploy, then synthetic end-to-end sync/portal acceptance and rollback checks.
- Full local Client verification completed outside the Windows AppContainer:
  `npm test -- --reporter=dot` passed the 9-test receiver preflight and all
  **1,536 Vitest tests across 143 files** (exit code 0; 5,922.56 seconds).
  This is local test evidence only; no Worker deployment or staging D1 mutation
  occurred during the run.
- Read-only branch audit found no safe deletion candidates. Ops had 176 local
  heads and 184 worktree paths; all locally merged non-protected branches were
  still checked out, and cached `origin/dev` was absent. Project Alpha had 53
  local heads and 46 worktree paths; the six branches merged into cached
  `origin/main` or `origin/dev` were all checked out, while 47 other local tips
  were not contained in either protected ref. No refs were deleted or fetched;
  PR status remains unverified, so preserve all branches for now.

## 2026-10-07 staging runtime configuration readback

- Read-only Cloudflare dashboard inspection confirmed the deployed Client Worker
  `ledgetop-clients-staging` has `CLIENT_PORTAL_ENABLED=true`, but the
  client-facing service-home and request paths remain off:
  `CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED=false`,
  `CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED=false`,
  `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED=false`,
  `CLIENT_PORTAL_REQUEST_V2_ENABLED=false`, and
  `CLIENT_REQUEST_ATTACHMENTS_ENABLED=false`.
- Recipient delegated-sharing is not enabled, and the Client invitation email
  service binding is absent. These runtime settings explain why the deployed
  portal does not yet provide the intended client sign-in/data experience;
  no client identity, workspace membership, grant, or public link was created.
- Read-only inspection of `ledgetop-ops-staging` confirmed API-v2 read and sync
  are enabled, while the native project/client authority dispatch and portal
  service-home companion are not yet enabled. Its D1 migration ledger remains
  at `0173`; the candidate migrations `0174`–`0180` were not applied.
- The Client staging D1 migration ledger is at `0228`. No Worker configuration,
  D1 data, production PA state, or public links were changed during this
  verification. Staging deployment remains gated on Wrangler consent, then
  candidate assembly/review, the required Ops migrations and compatible Worker
  deployment, followed by synthetic-only end-to-end acceptance.

## 2026-10-07 fresh authenticated staging check

- After the owner confirmed the Ops staging session was signed in, the live
  administration page again verified the Project Alpha API-v2 read connection:
  14 Directory records and 2 Projects. The page also showed a complete bounded
  inventory with zero conflicts. This is positive read-path evidence only.
- Refreshing the deployment-owned client workflow readiness panel still reports
  Client feedback, service requests, and attachments as unverified; delegated
  sharing/signing is blocked because its Operations companion is disabled; and
  access-expiry notices are blocked because notification transport is
  unavailable. No end-to-end client login/data-access acceptance has passed.
- The Ops staging migration ledger remains at `0173`; the candidate suffix
  `0174`–`0180` is not deployed. No client grant, identity link, public link,
  production setting, or PA production state was changed by this check.
- Local verification after this check: Operations TypeScript check passed;
  joined portal, joined Project-v2, joined Directory-v2, staging evidence, and
  native migration-profile harnesses passed **88/88**, with one platform skip
  because Windows disallows creating the test symlink. The full monorepo type
  check and Miniflare-backed migration tests could not complete because the
  Windows `workerd` runtime terminates during startup; the latter run reported
  8 failures and 23 skips from that runtime startup failure, not successful
  migration execution. These are not staging D1 migration attestations.
- Separate no-emit checks for Client and Ops Sync TypeScript and the
  Thumbnail Renderer syntax suite passed. The Operations TypeScript check also
  passed; only Wrangler/Workerd-generated runtime type generation remains
  unavailable in this Windows environment.
- A fresh local Wrangler `whoami` still reports unauthenticated. Ops browser
  sign-in does not authorize local CLI deployment; a staging-scoped
  `CLOUDFLARE_API_TOKEN` is still required before staging Worker/D1 changes.
- A separate Node built-in SQLite replay applied the current 180-file
  Operations migration chain to an empty in-memory database with the existing
  synthetic seed transformation. The final ledger contained all 180 entries,
  `PRAGMA foreign_key_check` returned zero violations, and the acquired-intent
  update guard plus inbound-project table were present. This validates local
  SQL syntax/schema ordering, not D1 runtime behavior or populated-row gates.
- Read-only Ops staging D1 preflight at the live `0173` baseline found zero
  prepared Directory finalizations, zero unresolved reconciliation actions,
  zero acquired canonical mappings, and zero acquired owner claims. Thus the
  currently known `0174` legacy in-flight-row and `0179` existing-acquisition
  collision preconditions are clear for this staging snapshot; it does not
  authorize applying the suffix or substitute for a D1 rehearsal.

## 2026-10-07 local release-gate continuation

- Hardened migration `0174_project_alpha_directory_preserved_external_identity.sql`
  with an atomic preflight assertion that refuses to proceed if prepared
  Directory read-adoption finalizations or unresolved reconciliation actions
  exist. Added four SQLite tests covering the clean path, both refusal paths
  with DDL rollback, and an already-completed action. All **4/4** passed.
- Recomputed the exact Operations release-chain digest from the current
  migration files and updated the bootstrap/authority packet pins to
  `8b3e78d54d9aaddd97f56e6d096af13b52ce7ba199e11b6617876cf7ee3d4dbf`.
  The updated chain has 180 ordered migrations; its first 173 filenames and
  content digest still match the live staging baseline pins. Migration 0174's
  pinned SHA-256 is
  `9e794a73b75e025edc04967888631b9336931eb16113f42d855bea3fcb30a158`.
- Local checks passed: Operations typecheck; staging release-evidence tests
  **57/57**; bootstrap tests **16 passed, 7 platform skips**; reviewed native
  authority/migration-profile tests **56 passed, 1 platform skip**; and the
  focused 0174 preflight tests **4/4**. The skipped cases require Windows
  symlink/junction creation, which this environment denies. These remain local
  results, not a D1 rehearsal or staging deployment.
- Re-ran the joined client-portal, Directory-v2, Project-v2, and PA API
  acceptance harnesses after the release-pin update: **99/99 passed**. These
  validate runner safeguards and protocol contracts; they do not create live
  client portal records or substitute for staging acceptance.
- A fresh local `wrangler whoami` still reports unauthenticated. Ops web
  sign-in does not supply Wrangler CLI credentials. No staging deployment or
  migration was attempted, and no production or public-link state changed.

## 2026-10-07 joined portal data preflight

- Read-only staging D1 counts confirm that the Ops legacy connector table has
  **0** rows and Client Hub has **0** roots. Ops has **1** native directory
  enrollment row, so do not treat the database as a pristine empty fixture or
  create another enrollment until that row is reviewed. The current grants
  include **0 active** `directory.enrollment.manage` grants. No row contents or
  personal client details were read for this count.
- Read-only Client D1 counts show **0** client accounts, account members,
  identity links, portal workspaces, workspace memberships, and portal
  identities. Thus client login/data access is not yet provisioned or
  acceptance-tested, even though the API-v2 inventory read works.
- Local Wrangler login was attempted with the narrow OAuth scopes
  `user:read`, `account:read`, `workers_scripts:write`, and `d1:write`. The
  installed Wrangler 4.118 does not support its newer `--device` flow; its
  supported localhost callback flow then timed out before approval. The CLI
  remains unauthenticated. No Cloudflare resource or database was changed.
- The safe next sequence remains: restart Wrangler OAuth when the owner is
  ready to approve in the browser while the CLI callback is active; verify
  `wrangler whoami`; inspect
  the existing single enrollment through an approved, redacted review path;
  then deploy/apply only the reviewed staging suffix and run the synthetic
  one-record projection and recipient acceptance. Production remains untouched.

## 2026-10-07 follow-up: staging session and Client Hub projection gate

- The owner confirmed Ops staging is signed in. This is the web/Access session;
  a local Wrangler check still reports **not authenticated**, so it does not
  authorize Worker deployment or D1 migration. Do not paste OAuth callback
  codes into chat.
- Fresh read-only D1 queries reconfirmed Ops `pa_connectors=0`,
  `client_hub_roots=0`, one existing native Directory enrollment, ten Directory
  grants (including zero active `directory.enrollment.manage` grants), and one
  Project grant. Client staging still has zero accounts, memberships, identity
  links, portal workspaces, workspace memberships, and portal identities.
- A focused source review found the most direct remaining data-path gap:
  reviewed API-v2 Directory adoption can establish a canonical Ops mapping,
  but Client Hub's business-root index, live-list/detail authorization, and
  exact-root lookup still require a legacy `pa_organizations`/`pa_clients` row.
  The next implementation must project from the canonical Ops record/revision
  plus the unique active PA mapping, without synthesizing legacy PA rows or
  treating inventory alone as authority. Add D1 tests for exactly-once roots,
  no root before activation, stale/ambiguous mapping denial, and preservation
  of all client-access/Delivery/folder/public-link tables.
- The focused Miniflare suite could not validate this path on this Windows host:
  `workerd` terminated at runtime startup. The TypeScript check passed, but the
  affected runtime suites are **not accepted as passing** and still require a
  supported Workerd/D1 environment or staging validation.
- No staging rows, Worker configuration, PA state, public links, or production
  systems were changed during this follow-up.

## 2026-10-07 Wrangler OAuth retry

- The owner confirmed the Ops staging web session is signed in; that session is
  separate from Wrangler CLI authorization.
- `npm exec -- wrangler whoami` still reported unauthenticated. A new
  `wrangler login` opened Cloudflare consent in Edge, but it timed out before
  consent completed. No OAuth callback code was shared in chat and no staging
  deployment or migration occurred.
- The Operations TypeScript check passed after the in-progress canonical Client
  Hub and acquired-ID project-adoption edits became visible in the shared
  candidate worktree. This is a compile check, not runtime acceptance.
- Next gate: complete Cloudflare consent while a fresh Wrangler login is
  actively waiting, then verify `wrangler whoami`. Review and run the focused
  regression tests before considering any staging deploy.
- A second login was started with a smaller scope set:
  `user:read`, `account:read`, `workers_scripts:write`, and `d1:write`.
  Cloudflare’s consent page is open in Edge. The selected set avoids Wrangler’s
  default request for every available OAuth scope. It also timed out before
  Cloudflare consent was completed; no deploy/migration has run. A fresh login
  must be started when the owner is ready to approve the consent page.

## 2026-10-07 canonical Hub and acquired-ID regressions

- Added a canonical Client Hub root/detail/search path for mapped API-v2
  directory records. It requires an active, current, unique PA mapping and the
  current Operations profile revision, routes by Operations record ID, and
  keeps PA external/public IDs as linkage. It supports native org/client
  relationships and does not synthesize legacy PA rows or issue client grants.
- Fixed three project-adoption stages to resolve Operations `record_id` rather
  than confusing it with the PA `external_id`; added a producer-to-reservation-
  to-bind/replay test with intentionally unequal IDs.
- Local verification: Operations TypeScript check passed; source-layout
  invariants passed 20/20; the implementation agent reported the acquired-ID
  regression passing 1/1; and `git diff --check` passed.

### 2026-10-07 follow-up: portal and release-gate evidence

- The signed-in Ops staging session completed a read-only API-v2 capability
  check for `project-alpha:staging`: Directory 14 and Projects 2. One bounded
  inventory page for each returned zero conflicts. This proves the read
  transport is live, not complete two-instance synchronization, client access,
  or portal cutover. No client grant or public link was changed.
- Independent review found that acquired-Directory collision checks had not
  mirrored migration `0179` across the full cross-column identity intersections.
  The candidate preflight now checks record, PA external, and PA public IDs
  against every corresponding legacy/acquired identity and owner claim before
  reserving or POSTing a PA bind. Regression tests are reported 21/21 by the
  implementation agent; this Windows shell's direct Vitest rerun could not
  start Workerd (`ERR_RUNTIME_FAILURE`), so CI or staging runtime validation is
  still required.
- Portal acceptance now covers the verified-but-unenrolled denial, exact
  subject enrollment to one intended workspace, and cross-issuer isolation.
  The implementation agent reports its focused test 1/1 and Operations type
  check passed; the Windows Workerd failure above means this remains pending
  independent CI/staging runtime evidence.
- Candidate release docs now specify a compatibility-Worker-first,
  writer-quiesce, backup, populated-preflight, complete-suffix, same-artifact
  redeploy sequence, and release preparation checks the generated default-off
  onboarding activation profile. The onboarding-authority runbook is corrected
  to the 180-migration chain. Synthetic-area preparation now requires an
  explicit staging mutation confirmation argument.
- Local preflight, pinned native migration profile, client/operations/ops-sync
  TypeScript checks, and all 10 native client-onboarding profile tests passed.
  Wrangler login is still pending user approval; no candidate deployment or
  remote migration has occurred. Production PA, production portal access, and
  all existing public links remain unchanged.
- A fresh least-scope Wrangler flow was started with `user:read`,
  `account:read`, `workers:write`, and `d1:write`; it timed out before consent.
  No callback code was requested or pasted. Start a new flow when the owner is
  present to approve in-browser, then confirm with `wrangler whoami`.
- A direct sandbox rerun of the acquisition-collision and native-authority
  Miniflare suites failed before fixture/assertion execution because Workerd
  aborted at startup (`ERR_RUNTIME_FAILURE` / `std::terminate`) on this Windows
  host. Focused CI or a supported staging runtime is still required.
- These edits are still uncommitted in the pre-existing dirty release-candidate
  worktree. They have not been deployed to staging. Live Ops/Client staging
  counts remain unchanged; no portal access, Delivery records, or public links
  were created or altered.
- Branch review found no safe branch deletions in either repository: all
  unattached non-protected branches have commits absent from both current local
  and cached remote `main` refs, while many others are attached to registered
  worktrees. No branches were deleted. A fresh authoritative fetch would be
  needed before judging remote-tracking refs stale.

## 2026-10-07 resumed verification

- Read-only staging recheck confirms Ops migration ledger still ends at
  `0173_operations_directory_intent_acquired_destination_transition.sql`;
  Ops has zero connectors and zero Client Hub roots, one existing native
  Directory enrollment, ten Directory grants, and one Project grant. Client
  staging still has zero accounts, memberships, identity links, portal
  workspaces, workspace memberships, and portal identities. D1 responses
  confirmed zero rows written / unchanged databases.
- `wrangler whoami` still reports unauthenticated. The scoped login flow expired
  without owner consent. Wrangler auth outside this runtime has not occurred.
- Independent package checks passed for Client, Operations, Ops Sync, and the
  thumbnail renderer. Staging harnesses passed: Client Portal joined-runner
  contract 2/2; paired E2E profile 6/6; Project v2 live-acceptance guard tests
  12/12; Directory v2 live-acceptance guard tests 8/8; source-layout invariants
  20/20. These are local contract/profile tests, not live staging acceptance.
- The root monorepo check is blocked during Wrangler runtime type generation by
  the same Workerd startup abort. Focused Miniflare test rerun also failed
  before assertions with `ERR_RUNTIME_FAILURE`; no code assertion failed. No
  Worker deployment or staging migration was performed.

## 2026-10-07 candidate hardening follow-up

- Recomputed the full 180-file Operations migration chain after the reviewed
  `0180` recovery migration update. Corrected the stale staging-only content
  digest from `8b3e78d...` to
  `d882f902ca308667acaf4a902fa7e2c1aa5d6423b8e961b4687cfac2b58d88a1` in the
  bootstrap, staging authority packet, onboarding packet, and their tests.
  Migration count (180), filename digest, and individual `0172`–`0180` pins
  were independently verified; production packet pins were not changed.
- Updated the release checklist to reflect that the prior recovery-actor and
  durable post-ack replay gaps have regression coverage now. The focused `0180`
  migration suite passed 16/16, recovery writer suite passed 6/6, and the new
  public-link migration/replay preservation checks passed 18/18 in an isolated
  Miniflare run. Operations TypeScript passed. These results do not replace
  Linux CI or populated staging acceptance.
- Local staging validation passed: `npm run staging:native-migrations:check`,
  `npm run staging:check`, and `git diff --check`. The bootstrap packet suite
  passed 16 tests with 7 environment-dependent symlink tests skipped. A
  separate authority-packet suite did not produce test output before its
  Windows process stalled; it was stopped and is not counted as a pass.
- Re-ran the joined Ops Directory/Project, Client Portal runner, and native
  migration-profile contracts with Git long-path support scoped to that process:
  31 passed, 0 failed, 1 symlink test skipped because Windows denied symlink
  creation. The first run's only failure was the Windows path-length fixture;
  no product assertion failed.
- Live staging remains unchanged: Ops ledger at `0173`, Client ledger at
  `0228`; Client Hub roots, portal accounts, identity links, memberships, and
  workspace publication remain zero. No staging migration/deployment or public
  link mutation occurred.
- GitHub branch audit found no branch safe to delete: open PR heads, branches
  with unique commits, and worktree-attached branches must remain. The local
  release candidate is still an uncommitted worktree with generated test
  artifacts; it is not yet an immutable deployable revision. Only the two
  verified test-temp directories `.codex-local-test-temp` and `.vitest-temp`
  were removed from that candidate.
- Wrangler remains unauthenticated. A least-scope OAuth attempt timed out while
  Cloudflare requested account sign-in, so staging release tooling still needs
  a completed fresh consent followed by `wrangler whoami` verification.

### Continuation update (2026-10-07 14:19 UTC)

- Re-ran the local acquired-collision and project-recovery suites: 81/81 passed.
  The Operations TypeScript check also passed.
- Added a D1-backed regression for replay after the same post-ack authorization
  expires while the actor session remains current. The test file could not be
  validated on this Windows host: Miniflare/Workerd terminated during startup
  before assertions. Treat the new case as pending Linux CI, not a test pass.
- Independent read-only staging recheck is unchanged: Ops `0173`, Client `0228`,
  no staging deployment since the prior check, and native portal identities,
  workspaces, memberships, folder bindings, PA sources, and delivery grants are
  still zero. The current counts do not constitute client-portal acceptance.
- The Wrangler consent page is still pending its **Authorize** action. No
  callback code is needed or should be pasted into chat; without the completed
  consent and a successful `wrangler whoami`, no staging deploy or migration
  has been performed.
- Expanded and re-ran the acquired-collision suite after the prior status note:
  **121/121** passed, including every legacy/acquired and acquired/acquired
  cross-field preflight case, same-receipt identity mismatch, rollback guard
  preservation, and both insertion directions. The separate post-ack expiry
  regression still awaits Linux/Workerd execution because this host crashed
  before assertions.
- Rechecked `wrangler whoami` from the candidate's installed Wrangler: it still
  reports **not authenticated**. The call also hit a sandbox `EPERM` writing
  Wrangler's user log; the result remains unauthenticated. A current Cloudflare
  consent tab still exposes an **Authorize** action, so authorization has not
  completed. WSL enumeration and Docker engine access are also denied by this
  execution sandbox; neither was used to change state.
- Rechecked `npm run staging:check` and
  `npm run staging:native-migrations:check`: both passed and explicitly
  performed no remote action. Retrying the focused expiry case again reproduced
  the Workerd startup crash before test assertions; it is not counted as pass or
  product failure.
- Re-ran the joined Ops↔PA Project/Directory, client-portal runner, and staging
  acceptance-profile contracts with the candidate-local temp directory: **52/52
  passed**. The first attempt failed only because Windows redirected test temp
  files into a sandbox-restricted system temp directory; the successful rerun
  generated only ignored local acceptance configs and performed no remote
  action.

### Continuation update (2026-10-07, latest local and read-only remote checks)

- The focused post-ack resume replay regression now passes **3/3**. Separate
  Operations, Client, and Ops Sync TypeScript checks pass.
- The root `npm run check` is still not green: Wrangler runtime type generation
  aborts inside Workerd on this Windows host. A broader `npm test` run passed
  its 200 root profile/contract tests (196 passed, 4 environment skips), then
  Client Vitest suites hit the same Workerd startup termination before their
  D1-backed assertions. It was stopped and is not a full-suite pass. Linux CI
  remains required for those runtime-backed tests.
- Read-only Cloudflare D1 queries confirm staging ledgers at Ops `0173` and
  Client `0228`. Ops contains one existing Project mapping, one Directory
  mapping, zero acquired mappings, six Project-v2 events, and 280 Directory
  observations. Client's PA portal workspace sources, source authorities,
  principals, projection generations, and entitlements are all zero. These
  queries wrote no rows; this is not live API sync or client sign-in acceptance.
- The latest Wrangler login timed out without authorization. A prior consent
  view was narrowed to required User Read/Background Access plus Workers Routes
  Write, Workers Scripts Write, and D1 Write, but no OAuth credential was
  issued. Those additional scopes are account-level, not staging-resource
  scoped; obtain owner authorization or use a staging-resource-scoped token
  before deploying. No migration or Worker deployment occurred.

### Continuation update (2026-10-07, authenticated staging UI verification)

- The signed-in Ops staging UI was confirmed under the protected owner/Admin
  account. The API-v2 operator panel verified the staging PA connection
  successfully: Directory 14 records and Projects 2 records. One bounded
  inventory page completed for both types with 0 conflicts. These are staging
  read/observation checks only; no PA writes, client activations, grants, or
  public-link changes were made.
- The same UI still reports the legacy primary business-record sync as
  disabled/not migrated to the exact-source registry. Client Hub shows 0
  clients and no permitted Project Alpha destinations/business scopes for
  creating a client. Read-only D1 counts in `client-data-staging` remain zero
  for portal workspace sources, source authorities, principals, projection
  generations, entitlements, folder bindings, and portal identities. So the
  staging API read path is alive, but this is not yet full client-list sync or
  client sign-in readiness.
- The browser's Ops session is separate from Wrangler/Cloudflare CLI OAuth.
  No OAuth callback code should be pasted into chat; current Wrangler
  authorization must be confirmed independently before any staging migration
  or deployment.

### Continuation update (2026-10-07, portal root and access gap)

- Read-only source review confirms API-v2 inventory is intentionally
  observation-only. Staging's single active canonical Directory mapping is an
  organization, not a client; there is no canonical client root. That explains
  the zero-client Hub without implying the PA read API failed.
- The candidate fixes Hub indexing to use exact active mappings and canonical
  Operations Directory records (no legacy `pa_clients`/`pa_organizations`
  dependency) and derives create destinations from enabled
  `PROJECT_ALPHA_API_V2_CONNECTIONS`. Those changes are not yet deployed.
- Staging has scoped `directory.profile.edit` and
  `directory.identity.link` allows, but no active `directory.enrollment.manage`
  allow. The candidate's server-derived create options correctly require all
  three grants, with deny precedence, so no create scope is available. Do not
  add a legacy connector manifest to bypass this API-v2 grant/configuration
  requirement.
- Ops-native portal publication heads/snapshots, recipient intents/operations,
  and native delivery authorizations are all zero. This is the actual portal
  acceptance gap. Empty PA portal projection tables are expected for the
  selected Operations-native portal path and must not be populated as a
  workaround.
- GitHub CI for release-candidate PR #146 head
  `5d4b880e2813e501f1321d046312d7f12bea01cf` completed successfully. The PR
  remains draft and is not a staging deployment. The initial root-level
  `npm exec -- wrangler whoami` attempt missed the package-local Wrangler and
  tried a registry lookup, which failed because this host could not resolve
  `registry.npmjs.org`. A later package-local check found Wrangler installed but
  unauthenticated. No deployment or migration was attempted.

### Continuation update (2026-10-07, verified after the note above)

- Rechecked the exact staging D1 migration heads through Cloudflare's read-only
  D1 connector: Ops staging remains at `0173_operations_directory_intent_acquired_destination_transition.sql`;
  Client staging remains at `0228_operations_portal_native_content_start_audit.sql`.
  Both queries reported `changed_db: false` and zero rows written.
- GitHub PR #146 is still open and draft at
  `5d4b880e2813e501f1321d046312d7f12bea01cf`; its pull-request CI run #516 is
  successful. This verifies the pushed commit only, not the current dirty local
  worktree.
- The Operations package-local Wrangler binary is present. `wrangler whoami`
  reports unauthenticated. A new OAuth consent request is pending; its default
  grant is account-wide, so the final authorization action remains with the
  owner. Do not paste its callback code into chat. Staging app login is separate
  from CLI authorization.
- The local Operations TypeScript check exits 0, and both Worker and Client
  production builds complete. The focused route suite passes 32 tests; the
  D1-backed Client Hub tests cannot be counted as passing on this Windows host
  because Workerd terminates during runtime startup, including on the attempted
  elevated run. PR CI is green at its committed SHA, but does not cover the
  uncommitted local changes.
- Branch cleanup audit found no safe deletions: merged topic refs are tied to
  active worktrees; unattached refs have unique commits; protected branches
  remain untouched. No branch or worktree was deleted.
- No Cloudflare migration, Worker deploy, PA mutation, client activation, or
  public-link change occurred. Staging acceptance is still incomplete; the next
  required staging step is a narrowly scoped deployment credential/authorization
  followed by reviewed Ops migrations `0174`–`0180`, then the synthetic client
  and recipient acceptance flow.

### Continuation update (2026-10-07, acceptance-profile regression checks)

- Re-ran the local acceptance-profile tests with a workspace-local Windows temp
  directory. The paired end-to-end profile passed 6/6; native portal profile
  passed 5/5; client-onboarding profile passed 10/10; native-workspace CLI
  passed 7 tests with 3 symlink-specific cases skipped because Windows policy
  forbids symlink creation. These tests validate guarded staging configs and
  scripts only; they did not call Cloudflare or alter staging.
- Rechecked staging D1 heads with read-only SELECT queries: Ops remains at
  migration 0173 and Client remains at 0228; both queries report
  `changed_db: false` and zero rows written. Operations candidate migrations
  0174–0180 remain unapplied; Client remains at its current 0228 schema while
  portal publication, recipient, and delivery-authorization state is still
  unseeded.
- Rechecked package-local Wrangler after the owner completed the browser OAuth
  flow: `wrangler whoami` still reports unauthenticated. The command also
  reported a Windows permission error writing its default log under
  `%USERPROFILE%\.wrangler\logs`; this does not change the unauthenticated
  result. No callback code was requested or exposed. Wrangler authorization
  must be completed in the local CLI callback flow before any staging deployment.
- Repository type-checks for Client, Operations, Ops Sync, and Thumbnail Renderer
  passed individually. The aggregate `npm run check` stops at Cloudflare type
  generation because Workerd terminates during startup on this Windows host;
  no source type errors were reported by the direct package checks.
- Release-path review confirmed PR #146 remains open/draft, clean, and green at
  `5d4b880e2813e501f1321d046312d7f12bea01cf` (CI run 37411683191). That pushed
  revision does **not** contain the current dirty project-adoption candidate,
  and CI has no Cloudflare staging deploy or D1 migration job. A manual staging
  release requires a clean pushed revision, the documented backup/barriered
  migration and version-upload flow, and separate least-privilege staging
  credentials; broad Wrangler OAuth is not necessary if the staging-specific
  credentials described in the release checklist are provisioned.
- No staging Worker deploy, migration, PA mutation, client activation, or
  public-link change occurred. Production PA and Ops remain untouched. Branch
  audits found no safe deletions; no branch/worktree was deleted.

### Continuation update (2026-10-07, API-v2 regression suite)

- Operations API-v2 connection, config, and route suites passed 56/56 tests
  after setting the test temp directory inside the workspace.
- The acquisition migration-chain suite could not execute its four D1 cases:
  Miniflare/Workerd terminates during runtime startup on this Windows host
  (`std::terminate()`), before assertions run. This is an environment/runtime
  failure, not a passing migration test; the migration chain still needs CI or
  staging D1 execution evidence.
- No source code changed during this continuation. Candidate implementation
  remains uncommitted and unstaged; do not deploy or infer that PR #146 covers
  it. Wrangler remains unauthenticated, and staging migration heads remain 0173
  (Ops) and 0228 (Client).

### Continuation update (2026-10-07, release-gate and production-readiness corrections)

- Fixed a candidate-only design mismatch: PA-origin project conflict review is
  now governed by its existing explicit `PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED`
  flag in every environment instead of an `ENVIRONMENT === "staging"` code
  restriction. The flag stays false by default, including production; private
  administrator, current-grant, review-evidence, and conflict checks are
  unchanged. A regression verifies production-default denial and explicit-flag
  behavior under the production environment label. This does not enable the
  route in any deployed environment.
- Added the Directory-write acceptance-profile suite and live Directory joined
  runner to the CI source-contract command. Both suites pass locally (4/4 and
  8/8). The private Project Alpha admin route suite passes 27/27; Operations
  type-check and production build also pass after the change.
- Updated the architecture and staging release checklist to distinguish the
  generic default-off feature flag from the separately approved staging and
  later production rollout windows.
- All changes remain uncommitted and unstaged in the candidate. No Worker
  deploy, D1 migration, real-client access change, production setting, or
  existing public-link mutation occurred. Exact staging D1 heads remain Ops
  0173 and Client 0228; Wrangler is still unauthenticated.
- Verified the locally present 0172 and 0173 SQL file SHA-256 values against
  the repository's pinned staging requirements: both match exactly. These
  files are still untracked locally, so they must be included byte-for-byte in
  the eventual reviewed release commit before a reproducible migration suffix
  can be prepared.

### Continuation update (2026-10-07, credential and live baseline verification)

- A read-only Wrangler identity check, run with the local Windows credential
  store available, confirms the Cloudflare OAuth is valid. The earlier
  sandboxed check could not access that credential store and was not an accurate
  authentication result. The authorized OAuth token includes account-level
  write scopes; this continuation used it only for the repository's two
  read-only migration-ledger queries. Do not use it for unrestricted deploys.
- Generated and checked the repository's isolated migration-only profiles. The
  Operations staging ledger exactly matches the pinned 173-migration prefix
  ending at 0173; Client staging exactly matches its pinned 147-entry prefix
  ending at 0228. Both live checks used `SELECT name FROM d1_migrations`; neither
  applied SQL or wrote data.
- The migration-profile regression suite passed 9/10; its single skipped case
  requires symlink creation, which this Windows policy blocks. The Operations
  and Client profiles are local ignored files and contain only the exact D1
  binding/migration scope for the read-only baseline checks.
- Source-layout/invariant contracts passed 20/20 after the CI and route-gate
  updates; `git diff --check` also remains clean.
- No code change was deployed. The candidate remains dirty/uncommitted and PR
  #146 still does not contain it. The next release work is to curate a clean
  exact candidate commit (excluding temp/cache artifacts and the chronological
  status journal), pass full Linux CI on that SHA, then use the reviewed manual
  staging version-upload and barriered migration sequence before any live
  mutation acceptance.
