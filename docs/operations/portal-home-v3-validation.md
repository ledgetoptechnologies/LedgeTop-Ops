# Portal home permission: validation checkpoint

## September 28 owner-action review checkpoint

- A follow-on UI-only candidate now composes the verified service summary with
  independently authorized legacy/native Client dashboards. Client denial
  retains descriptive metadata only, and an explicit recovery action clears
  stale Client workspace selection and reloads the root, rechecking Operations
  before any Client bootstrap. Independent source QA cleared the initial
  invalid-hint reload loop. Implementer Client typecheck/build pass; root's
  focused parser/bootstrap suite passes 15/15 and its desktop/mobile browser
  matrix passes 26/26 (26.5 seconds), including mobile menu open/close and focus
  restoration. No Worker/API/schema/configuration/grant/public-link changes
  are part of this slice. It remains a partial client-experience milestone,
  not new recipient or credentialed staging acceptance.
- The ordered diagnostic prefix confirms the earlier timeout is accumulated
  test work: seven real submissions take about 35 seconds; Client first-page
  verification 18.05 seconds; transition 5.83 seconds; second page 9.16 seconds;
  Operations project histories 22.43/9.41 seconds. Root history starts after
  about 99.4 seconds and exceeds the remaining original 120-second case budget.
  Vitest reports failure despite the npm wrapper's zero exit status; the failure
  is authoritative. A test-only split with one explicit real-POST fixture and
  three focused cases is under review, preserving all original assertions and
  each original 120-second limit. It is not yet validated and does not clear
  the full-file or broader release failure.

- Exact integrated head `213bd576ce56039c39a3d37edbf6a09858e6cde9`
  passed all ten CI jobs in run `36395319220`; the terminal GitHub REST
  readback reports success at September 28 08:24:55 UTC. This verifies that
  committed candidate, not subsequent local UI or diagnostic edits, and is
  not credentialed deployed portal acceptance. The separate complete
  native-resource follow-up finished
  with exit 1: 40/41 tests passed, and the same exact-source/workspace feedback
  collision case timed out at 120,072 ms (full file 856.87 seconds). Its isolated
  pass does not clear this repeated full-file failure. Investigation must retain
  source-isolation, pagination and revocation assertions rather than increasing
  the timeout solely to obtain green evidence.
- The new [unified portal composition gap register](unified-portal-composition-gaps.md)
  records that the successful service home is currently descriptive-only;
  it is not the complete requested client experience. A bounded local UI slice
  may compose existing Client features only after their independent bootstrap
  succeeds. Operations denial/unavailability must still initiate no Client
  fallback, and service labels must never confer resource authority. Financial
  summaries, website reports and governed recipient linking remain separate
  launch gates. No production update checkpoint is ready from these findings.

- Incoming repair from `18ed16a` is now integrated locally into the portal
  review branch, starting at `d23972a`. Independent QA verified all four
  Incoming artifacts are Git-blob identical to the reviewed source; the
  mailer and relevant migrations match too. Target-focused tests passed
  27/27 in 47.99 seconds and Operations typecheck exited zero. No migration,
  configuration, authority, production or public-link changes were added by
  this integration. Its new candidate still requires exact-head CI.
- The broad local release process on clean runtime head `c337d78` is still
  live, but has reported a 120-second timeout in native project-feedback
  history's exact-source/workspace collision case. Do not count that release
  run as passed. A separate unchanged-assertion focused rerun passed that
  case (one passed, 40 unselected; exit zero; 178.17 seconds including setup).
  This does not prove the entire 41-test file or clear the broad failure.
  Keep the original process intact, collect its terminal result, and perform
  the required complete follow-up validation before accepting a release.

- Independent GPT-5.6 focused rerun passed on runtime/test head
  `102ed57aea7cff7e3c2b7929bea843f5a138a6fd` (the checkout moved only for
  documentation commit `76947e9` during execution). Client: 39/39 across
  authority-v2, its entrypoint, service-home and home-route suites, exit 0,
  50.94 seconds. Ops: 34/34 across workspace-binding selection, authority-v3
  owner HTTP and the joined private-RPC suite, exit 0, 111.37 seconds.
  Both used `npm exec -- vitest run --config vitest.config.ts` with those exact
  named test files. The initial sandboxed Client launch failed before tests
  because esbuild could not traverse the worktree; the identical narrowly
  approved local test command passed. These are local tests, not credentialed
  deployed portal acceptance or full release CI. The separate release
  preparation process was not interrupted or restarted.

- The next live acceptance prerequisite is a missing application workflow,
  not another migration rehearsal. Independent read-only GPT-5.6 review found
  no runtime creator for `client_onboarding_recipient_identity_bindings`:
  migration 0103 defines explicit issuer/subject evidence, while current
  consumers and local fixtures assume it already exists. Onboarding approval
  alone must not manufacture a verified identity link. The workspace-binding
  and authority-v3 HTTP endpoints are mounted in the Worker, but neither has
  an Operations frontend caller. Implement a governed verified-recipient
  binding lifecycle, a scoped eligible-recipient read, and the owner UI before
  claiming credentialed end-to-end portal acceptance. Keep identity linking
  (`directory.identity.link`) and exact-resource portal management
  (`directory.portal_access.manage`) separately authorized; existing
  `directory.profile.edit` bootstrap authority implies neither. Do not insert
  live bindings or grants through D1 to bypass this gap. Migration 0220's
  authorization does not itself approve a new recipient-linking boundary.
- Exact-head CI run `36390923313` passed all ten jobs for
  `9eea3e6b0803211ccb9ba0f527ec82c5a888fcf9`; the terminal GitHub REST
  readback reports success at September 28 07:31:21 UTC. Earlier run
  `36389712464` was cancelled after a documentation push, not passed.
  Local release preparation remains live: its broad Client suite passed
  119 files / 1,292 tests and advanced to Operations tests. The complete
  release command has not returned its final result. No unavailable check
  was counted as successful, and no credentials were changed.

- Fresh **remote** migration transport is now verified at tooling commit
  `e626e102e976835fb0e3dbf6461ef4e46e161174`, run `home-20260928`.
  New Client target `client-data-staging-rehearsal-home-20260928`
  (`2816ad75-1aab-49f6-98d0-0ff53e20d6d5`) and Ops target
  `ltds-ops-staging-rehearsal-home-20260928`
  (`1f47f5fc-dc4e-4747-a2e6-bfc085614b0a`) were confirmed empty before
  application. Both remote applies exited 0; ordered ledger readbacks match
  every generated filename (139/147), including both Client 0199 files and
  final 0220/0147. Separate second list and apply commands report no migrations
  to apply. Foreign-key checks are empty; each target has exactly its synthetic
  owner, Ops retains the four original roles plus its evolved catalog, and
  Client grant/audit/receipt and Ops outbox/audit/receipt counts are zero.
  Exact manifests, readbacks and scoped references are retained in ignored
  `.backups/remote-rehearsal-home-20260928.json`, with apply logs alongside it.
  Generated-chain check still passes. Canonical staging and production
  databases were not reset, and no Worker was uploaded/deployed. The new
  rehearsal resources are retained; no cleanup deletion is authorized here.
- Exact-head PR133 CI run `36388444179` at e626e10 exposed a new test-only
  Client typecheck failure: missing declarations for the bootstrap module and
  a non-const fixture tuple. A narrow `.d.mts` declaration and const tuple fix
  preserve the test and strict typechecking. Agent and root Client checks now
  exit 0; the agent's focused full-chain run passes 1/1 (69.83s), and root's
  independent repaired-test rerun passes 1/1, exit 0 (69.84s).
  Current CI must be rerun on the repaired pushed head before acceptance.
- Live acceptance still needs a governed synthetic recipient and acknowledged
  inactive workspace binding. The existing joined fixture mocks staff login
  and seeds local recipient state; it cannot substitute for credentialed
  staging owner-action/service-home acceptance. Do not provision live authority
  through raw D1 or mark the broader release contract finalized from migration
  evidence alone.

- A bounded GPT-5.6 implementation adds opt-in disposable remote-rehearsal
  artifacts without resetting populated staging databases. Root reviewed the
  canonical-before-target validation, production/staging identity exclusion,
  input/output path guards and migration-only single-binding configs, then
  independently reran the focused bootstrap/evidence suites: exit 0, 55 passed
  and four Windows file-symlink capability skips. Junction cases execute and
  pass. Current evidence version 2 retains every existing proof requirement;
  no remote resource was created or migrated by these helper tests.

- Additional actual Wrangler 4.118.0 **local-only** rehearsal now passes:
  both databases were confirmed empty before application; Client applied all
  139 files (including both 0199 names and 0220), and Ops applied all 147
  files through 0147. Both commands exited 0. Repeating the identical local
  `migrations apply` commands exited 0 with `No migrations to apply`.
  Readback confirms ledger counts 139/147, empty foreign-key checks, zero
  Client principal grants/audits/receipts and zero Ops outbox/receipts.
  This supplements, but does not replace, a fresh **remote** D1 rehearsal.
  Existing populated staging databases were not reset or used for this run.
- Explicit staging-config bundle dry runs also pass for all three applications
  (Client, Ops and Ops Sync). These compiled locally without version upload or
  deployment; the authority flags remain off. The broader release preparation
  is still running and has not produced a terminal result.
- PR133 now includes local-regression/documentation commit
  `b77a65e57dee4e5bc496c893d21e5401ae7d46a1`; runtime remains the reviewed
  `c337d78` code. The nine-check CI observation below belongs to the older
  c337d78 head and must not be treated as b77a65e's current CI result.

- Current reviewed runtime candidate is `c337d78f4994583c04267bc86cfdb7a6f1b8b006`,
  published as draft PR133 against the bootstrap branch; it is not merged or
  deployed. The owner HTTP repairs are committed in ancestor `a218692` and
  strict current-bootstrap evidence in `c337d78`. Earlier unfinished/uncommitted
  observations below describe the preceding review, not this candidate's state.
- Independent GPT-5.6 read-only cumulative review found no actionable material
  regression in Client 0220, Ops 0147, the owner HTTP handler and service-home
  reads. This is static QA, not an additional executed acceptance suite.
- Read-only Client staging D1 verification on September 28 confirmed migration
  0220 is recorded, no migrations are pending, all three altered tables default
  protocol version to `2` and permissions to `[]`, and all four updated guard
  triggers contain protocol and permission checks. The aggregate count of
  permission-bearing grants is zero. These queries wrote no rows and exposed
  no recipient records. Reviewed local staging writer, status, outbox, owner
  action and service-home flags remain `false`.
- Full local release preparation initially stopped because the isolated
  Ops Sync checkout lacked dependencies. Restoring its existing npm lockfile
  with install scripts disabled resolved that prerequisite without changing
  dependency manifests. The subsequent full preparation is still running;
  a clean typecheck and focused tests do not substitute for its terminal result.
- Exact-candidate PR133 CI run `36384130097` reached nine successful checks;
  the remaining Operations job was still executing its test step at the last
  successful observation. A subsequent GitHub read hit the account API rate
  limit, so polling stopped rather than changing credentials or treating the
  unavailable result as success. Full local preparation and terminal CI status
  remain pending; no release gate has been bypassed.
- Added a portable full-chain local regression in
  `apps/client/test/staging-bootstrap-full-chain.test.ts`. The smaller agent's
  focused run passed, and root independently reran the same test: one file,
  one test passed, exit 0, duration 69.99 seconds. It applies the actual 139/147
  reviewed chains to initially empty local Miniflare databases, including both
  Client 0199 filenames and final 0220/0147. Only the two owner seed derivatives
  differ from canonical migrations. Ordered ledgers, one synthetic owner per
  application, retained ACL catalogs, foreign keys, protocol/permission schema
  guards, and empty portal grant/audit/receipt/outbox tables are verified.
  A ledger-aware synthetic reapply finds no pending files or schema changes.
  This is neither a remote empty-D1 rehearsal nor the checklist's actual
  Wrangler `migrations apply` idempotency proof. Temporary fixture cleanup
  validates its exact owned directory before removal. No remote resource,
  production configuration, canonical migration or public link was changed.

- Independent rerun against the clean bootstrap checkout passed 28/28 Client
  authority and service-home tests (`client-portal-authority-v2.test.ts` and
  `operations-service-home.test.ts`). These exercise migration 0220, populated
  protocol-2 compatibility, CAS/receipt rollback, permission transitions and
  fail-closed home reads in isolated local databases; they are not live staging
  recipient acceptance.

- Clean bootstrap staging preflight passed, and the local staging-preflight,
  config-scaffold and Client release-profile suites passed 45/45. They cover
  exact staging inventory, default-off capability bundles, distinct Access
  audiences, migration order and activation drift. They do not prove live
  recipient access or the unfinished owner-action HTTP boundary.

- Local Wrangler 4.118.0 `versions upload --dry-run`, with each explicit
  `wrangler.staging.json`, passed for the Client and Ops bootstrap candidate.
  Both configs target staging D1/R2 resources and retain authority/home flags
  off. Nothing was uploaded or deployed by these commands.
- Read-only deployment inspection confirmed unchanged 100% staging versions:
  Client `0497d73c-3435-4fab-8576-86da76fbfb11` and Ops
  `27cf5e58-61dd-4338-b6ae-634ed26ad902`. These are current serving versions,
  not merely historical version-list entries.
- Exact-head PR132 CI run `36379942237` now passes all ten checks, including
  both applications' desktop/mobile browser jobs. The last Operations job
  `108793496035` completed successfully at `2026-09-28T05:16:45Z`.
  This proves the bootstrap candidate's CI gates, not live access issuance.
- Staging-only correctness repairs can proceed without removing the rejected
  staging guard. The production-capable source question remains open and is
  not implicit permission to deploy or enable production.
- Filtered serving-version metadata confirms three Client and six Ops secret
  binding names remain present (values were not retrieved). The current older
  Client version lacks the new metadata-reader binding and current Ops lacks
  the v2 authority ingress binding; those are present in the reviewed local
  staging configs, not remotely deployed yet. New home/v2 flags are absent in
  the older serving versions and therefore cannot be claimed enabled. Existing
  workspace-writer/outbox and project-authority mutation flags read `false`.

- PR132's corrected head is `5168e0faaac37d8b6b2326b67b8b6d3279fd33bf`.
  Do not substitute earlier run results for its successful exact-head run.
- The new native owner handler is unfinished and uncommitted. Review found
  replay actor/intent pinning, exact-workspace latest-receipt lookup, callable
  RPC validation and expiry rechecks. These local repairs compile and the
  focused mock HTTP suite passes 4/4. The real joined database/HTTP suite now
  passes 4/4; root independently reran both suites together (8/8, exit 0).
  It covers grant, exact replay without another revision, permission removal,
  owner-role removal, explicit deny, recipient expiry and exact-operation
  queue isolation. The fixture applies the real authorization migration chains
  to synthetic parent tables and mocks staff authentication; this is not live
  Access-session or staging recipient acceptance.
- Full release preparation at clean PR132 head stopped at the bootstrap test:
  its reviewed migration inventory still pinned Client 133/Ops 140 rather than
  current Client 139/Ops 147. The prior prefixes' content and name digests match
  their old pins exactly. Local repairs update the exact whole-chain digests,
  packet test expectations and current instructions; no canonical migration,
  historical rehearsal evidence or remote state was changed. The remaining
  full release gates still must run against a clean reviewed candidate.
- Bootstrap, native-authority packet, onboarding-authority packet and release
  evidence unit suites now pass together: 78 passed, 0 failed, 2 skipped
  (Windows could not create file symlinks). Directory-junction rejection tests
  did run and pass. Exact-count, filename, one-byte content drift, staging
  identity, isolated-ledger and rollback checks remain enforced.
- Independent owner-handler review found three local gaps:
  acknowledged replay bypasses fresh owner/recipient checks, dead replay is
  reported as pending, and enqueue/dispatch storage errors are classified as
  denial. Repairs now pass root's independent final rerun: 12/12, exit 0.
  Pinned dead replay returns 409 without enqueue/dispatch; unexpected storage
  errors return 503 while known writer denial remains 403. Acknowledged replay
  rechecks current owner/recipient authority and applicable global, resource,
  business-area and division denies, then returns historical acknowledgement
  without reissuing access. The joined business-area-deny regression passes.
  Replaying a grant after later removal leaves Client revision 2 with empty
  permissions and exactly two audit rows. TypeScript and generated-type checks
  pass; the new route wiring uses a typed Hono Context. This remains local,
  mocked-login evidence, not live staging or full-portal acceptance.
- The release evidence verifier still describes the older fresh-bootstrap
  rehearsal (Client 133/Ops 139), separately from the current ordered migration
  suffix. Its historical proof must not be relabeled as a new 139/147 empty-D1
  rehearsal. Current-generator/evidence-contract reconciliation remains an
  explicit release follow-up. The strict version-2 current-chain contract is
  now implemented and tested: old version-1 rehearsal proof cannot satisfy the
  new candidate. Root independently reran the combined bootstrap, evidence and
  two authority-packet suites: 80 passed, 0 failed, 2 Windows file-symlink skips.
  No new remote empty-D1 rehearsal has been performed by these local tests.
  Immutable release pins and finalization remain deliberately unchanged
  pending candidate review.
- Independent configuration-suite rerun found and then verified the repair of
  a default-off origin mismatch. Blank owner origin is allowed only when its
  flag is exactly `false`; enabled validation requires the exact canonical Ops
  HTTPS staging origin. Inventory, example and generated-type wiring are
  updated. Root independently reran staging preflight, config scaffold, Client
  release profile and source-layout invariants: 63/63 passed, exit 0. This
  replaces the earlier failing owner-candidate gate, not live access acceptance.
- Removing its hardcoded staging restriction was explicitly denied by the
  approval reviewer as exceeding the staging-only authorization. That change
  was not made or worked around. Clarify whether reusable production-capable
  source is authorized while all flags stay off and deployments remain
  staging-only; no production rollout is implied.
- Existing migration 0220 staging evidence remains valid, but does not prove
  the new owner HTTP action or the full client portal is accepted.

## September 27 historical local verification

- Re-ran the authority writer, entrypoint and service-home suites: 31/31
  passed, including populated protocol-2 migration/replay and protocol-3
  permission removal, stale CAS, immutable evidence and transactional rollback.
- PR132 CI exposed an additional stale J7 denial expectation on both business
  domains. Updated only the test's exact request sequence to include the
  disabled home discovery 404 before the legacy session denial. It still
  forbids account and cross-tenant resource requests after denial.
- Full J7 browser coverage passed 16/16 locally across drone/technology
  desktop/mobile. Fresh exact-head CI remains required; these local fixtures
  are not credentialed live staging acceptance.
- Client migration 0220 and companion Ops migration 0147 were already applied
  to staging after private backups, with guard readback and no access issuance.
  No production deployment, public-link change or client activation occurred.
- The normal owner-action path remains a separate, default-off work in
  progress. Do not declare the full portal or migration production-ready from
  these schema and fixture results.

## Scope and authorization

- Owner approved Client migration `0220` changing the three existing grant,
  audit and receipt tables and their CAS guards for protocol version 3 and the
  explicit `operations.service_home.read` permission.
- Implementation and testing are limited to local fixtures and staging.
  Production deployment, public-link changes and production client activation
  are not authorized by this checkpoint.
- The home permission allows descriptive service labels only. It does not
  authorize files, Viewer access, financial documents or service mutations.

## Completed evidence

- Draft Ops PR131, source head
  `919e5ff01edbd5eebfb67d95b39189878d021678`, contains Client `0220`,
  companion Ops `0147`, shared-stream protocol handling and explicit permission
  checks. All ten CI checks passed in run `36376711586`. No merge or
  production deployment occurred.
- Full private staging D1 backups preceded application of Client `0219`–`0220`
  and Ops `0145`–`0147`. Both remote migration ledgers returned no pending
  entries. Readback confirmed the updated guards and zero new grant/receipt
  and outbox/receipt rows. Applying schema did not issue access.
- Local tests include populated pre-migration receipts, unchanged v2
  fingerprints/replay, v3 permission removal, cross-version conflicts,
  immutable evidence, exact receipt acknowledgments and lost-response retries.

## Pending portal bootstrap source

- A separate candidate probes `/api/client/v2/operations/home` before creating
  the legacy PA portal session at `/portal`.
- Only HTTP 404 permits the default-off legacy path. Authentication denial,
  authorization denial, unavailable transport, malformed data and network errors
  remain closed; they do not enter legacy PA routes.
- Discovery accepts at most twenty explicitly permitted homes and rechecks the
  entire authority snapshot after bounded private metadata calls. A concurrent
  revoke or permission/revision change discards the response.
- This first home renders labels, not actionable file/billing/project links.
  Existing public-share routes and legacy non-root portal pages are unchanged.
- Final focused helper, HTTP and authority-writer selection passed 36/36,
  including multi-home snapshot loss; separate UI unit coverage passed 15/15.
  Client TypeScript checking and production build passed. Mocked local Edge
  browser coverage passed 9/9 desktop and 9/9 mobile. Independent review found
  and prompted a browser/server identifier-limit mismatch fix; accepted and
  rejected boundaries now match the server, including opaque slash-containing
  IDs. These are not live
  credentialed staging acceptance results.

## Remaining acceptance gates

- Complete exact-head CI and independent UI review.
- Preserve the local discovery, multi-home revocation and desktop/mobile
  browser evidence; complete credentialed live acceptance separately.
- Deploy reviewed runtime versions to staging only with all authority/home
  flags off, preserving staging secrets and rollback version IDs.
- Use a reviewed, explicit synthetic authority provisioning workflow for
  positive, denied, revoke/regrant, replay and rollback live acceptance. Do not
  forge grants by bypassing ledger guards or infer membership from email.
- Verify real recipient onboarding and subsequent service-specific capability
  boundaries before declaring the unified portal production-ready.
- Retain the production PA owner-update checkpoint and existing public links.

## Next normal owner action

- The private v3 outbox exists, but no normal owner HTTP action issues its
  intent yet. Add a dedicated default-off native-owner boundary, separate from
  the intentionally staging-only workspace-binding route.
- Derive authority/workspace/principal IDs from the selected acknowledged
  inactive binding and explicit recipient binding. Derive revisions only on
  first enqueue; exact-operation retries must recover the original intent,
  not silently use a newer revision.
- Keep an explicit origin and CSRF admission, current owner and directory
  manage allow/no-deny checks, bounded input and exact-operation dispatch.
  Do not drain unrelated commands or turn permission removal into revocation.
- Staging config generation was attempted with the prior approved values file,
  but its two newer PA source/origin keys are absent. Generation failed closed;
  no configuration was overwritten or deployed. Verify those values against
  current staging before producing a release configuration.

September 27 continuation: independent review confirmed the corrected browser
contract, and the bootstrap candidate is published as draft PR132 at
`6794aac15d6e1a1185a9a36b059f8dcb37f8eb75`. Its CI run `36378679635` is live;
it must complete before release. The prior schema/permission PR131 is fully
green. Read-only staging D1 inspection verified source `project-alpha:staging`;
the existing rendered staging config identifies the PA staging HTTPS origin.
An ignored values overlay preserving the original approved file now passes
the staging scaffold's validation without writes. This clears the renderer
input gap, not the runtime/live-acceptance gates. No remote resource, authority
grant or production deployment changed during these continuation checks.

PR132's initial full desktop/mobile browser jobs each failed one legacy denial
test: the exact request-order assertion did not yet include the new home
discovery 404 before the legacy session 404. The desktop run otherwise passed
220/221 cases. The test correction preserves the assertion that no account or
resource reads follow either denial; it does not relax the runtime's fallback.
Corrected two-viewport denial tests passed 2/2 and home browser coverage passed
18/18. Draft PR132 now points to
`cd384aa4352205f9d8bcc7783522e16f9ee665a6`; a fresh exact-head CI gate is
required. A clean separate checkout was built/typechecked at the prior reviewed
runtime commit, with validated ignored staging configs and every new authority
flag off. No runtime upload or deployment was performed.
