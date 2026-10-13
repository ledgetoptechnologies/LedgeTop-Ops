# Native workspace owner staging acceptance

This path prepares an explicitly selected Operations-owned client workspace.
It does not enroll a recipient, share a folder, create a public link, or mutate
Project Alpha. Production registration and production access remain unchanged.

## Configuration

- The staging template provides the private `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION`
  binding to `ledgetop-clients-staging` / `OperationsPortalWorkspacePublicationIngress`.
- Both `OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED` and
  `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED` default to `false`.
- Enable both only on the exact Ops staging host with the existing native
  authority configuration and `OPERATIONS_SESSION_SECRET`. Preserve all other
  deployment variables, bindings and secrets.
- The handler uses the existing reservation, snapshot/publication, invocation
  and dispatch services. It does not insert authority heads directly.
- `scripts/staging-native-workspace-acceptance-profile.mjs` provides a pure,
  validated configuration transformation for paired acceptance: the two Ops
  gates above plus Client `CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED`.
  It changes only those three flags, verifies the private staging destination,
  rejects partial activation and unrelated drift, and performs no file writes
  or deployments. Recipient service-home activation is a separate profile.

## Safe acceptance order

Before step 2, prepare the separate bounded onboarding pair with
`npm run staging:client-onboarding:generate` and validate it with
`npm run staging:client-onboarding:check`. This is a local transformation, not
a deployment or a grant. It requires validated default-off sources, leaves
production untouched, and changes only the three onboarding flag placements
and the exact Ops staging admin origin. It rejects unrelated workspace,
recipient-service-home, resource or origin drift.

Before routing this pair, verify current Ops secret names
`OPERATIONS_SESSION_SECRET`, `CLIENT_ONBOARDING_HANDOFF_KEYRING`,
`AUDIT_IP_SECRET` and `PROJECT_ALPHA_API_V2_CONNECTIONS`, exact migration/drain
state, and rollback versions. The builder does not inspect secret values.
Open Ops first, Client second; close Client first, Ops second. Keep this
window separate from workspace publication and recipient service-home windows.
Use the independently reviewed two-permission native-only authority window
for actual approval, and close it using its exact saved provision artifact;
the configuration profile itself grants no authority and has no automatic
expiry. Do not issue an invitation while browser onboarding navigation remains
blocked. Temporary outputs stay ignored under their fixed per-app staging paths.

Local preparation on 2026-10-02 passed all ten onboarding-profile tests and
42 adjacent profile/scaffold/source-contract tests. The actual ignored pair
was generated and checked successfully. CI and release preparation now include
the profile suite. This is not live onboarding approval or client-access proof:
the in-app Client root renders “Access not provisioned”, while navigation to the
synthetic onboarding path still reports `ERR_BLOCKED_BY_CLIENT`.

1. Verify current native admission/profile versions and deny-aware grants.
   Staging owner role alone does not replace the domain permission checks.
   Never apply an old authority packet against a different current generation.
2. Create/review a synthetic native client using the existing onboarding flow.
   Use explicit source selections; native-only approval uses `sourceIds: []`.
   Approval still requires its current profile-edit and identity-link authority.
3. Open `/administration/client-portal/operations-workspaces` on Ops staging.
   Enter the exact root record ID/version and explicit target, client-authority
   and workspace IDs. An organization root has a null relationship version;
   a standalone client requires its current relationship version.
4. Reserve and publish. Record the non-secret operation IDs and acknowledged
   revision. A `retry`, conflict, or uncertain transport result is not success.
   The UI retains the exact request for replay and pre-fills the publication
   recovery ID. Do not generate a replacement workspace because an observation
   timed out. Recovery uses a new audited invocation for the same publication.
5. Verify the staging Client publication receipt and exact snapshot. In the
   owner page, load the explicitly selected shared project by workspace target
   and external project ID. Confirm its exact destination division/base prefix
   using the returned project version and complete prior association proof.
   The server derives the confirmer and confirmation timestamp; these are not
   editable authority fields. Then reserve only the selected synthetic folder
   (`reserve-folder-and-publish`), supplying workspace/publication revisions,
   selected prefix, reservation ID and client folder binding ID. Project/base
   confirmation fields are read-only, loaded from the authorized server proof.
   The domain service independently rechecks these inputs and current authority.
   Folder revocation (`revoke-folder-and-publish`) checks the exact reservation
   revision and republishes the complete snapshot at the explicit publication
   revision. Neither operation changes a public delivery link or deletes files.
   Retained uncertain requests may replay only while the visible workspace or
   folder selection still exactly matches their original semantic fields.
   If a selection changed, restore it or use publication recovery rather than
   silently submitting the old retained operation under a new project.
6. Enroll the verified synthetic recipient and test sign-in, selected service
   visibility, selected file access, unauthorized identity denial and revocation.
   Workspace publication alone grants no recipient access.
7. Disable temporary setup flags when acceptance is complete. Preserve audit
   records and document rollback/recovery; do not alter existing public links.

## Evidence boundary

Local adapter and scaffold tests are not live sign-in/data proof. Full PA–Ops
reconciliation, retry/idempotency and portal acceptance remain release gates.
Only after those gates pass should the owner production PA update checkpoint
be requested.

## Local paired configuration checkpoint — 2026-10-02

- Reconstructed the missing default staging configurations with the reviewed
  scaffold and existing validated non-secret values; no existing config was
  overwritten. Full staging preflight passed.
- Generated and checked the paired native recipient service-home profile.
- Rendered the separate workspace profile through its pure builder, wrote the
  pair locally, and revalidated the actual on-disk files against the bases.
- All seven generated staging config files are ignored by Git, including the
  scaffold's separate ops-sync base. No config or private values were published.
- Client local build passed. Wrangler 4.118.0 dry-runs passed for both apps in
  both windows (four bundles). Ops dry-runs also built the existing local
  renderer image; no image upload or remote resource change occurred.
- Workspace profile files are `apps/client/wrangler.staging.native-workspace-acceptance.json`
  and `apps/operations/wrangler.staging.native-workspace-acceptance.json`.
- Recipient profile files are `apps/client/wrangler.staging.native-portal-acceptance.json`
  and `apps/operations/wrangler.staging.native-portal-acceptance.json`.
- These are validated local candidates, not live activation evidence. Before
  deployment, pin the accepted release revision, check actual deployed
  configuration/bindings and migration readback, and retain the exact rollback
  versions. GitHub publication and exact-head remote CI remain separate gates.
- Open the workspace window Client then Ops; close it Ops then Client. Open the
  recipient service-home window Ops then Client; close it Client then Ops. Do
  not hand-combine the independently validated activation windows.
- The synthetic onboarding permission rehearsal left no active grants. Actual
  onboarding acceptance still needs its own reviewed bounded provision/revoke.

## Live pre-window inventory — 2026-10-02

- Read-only deployment inventory confirms Operations version
  `363c9714-bd6f-4eeb-96df-fef681f4a44a` and Client version
  `2512de43-cd37-4118-97d9-d0c241a3fabd`, each at 100 percent traffic.
  These are rollback reference points, not acceptance of the new candidate.
- The generated Operations base differs from the deployed version in five
  PA acceptance/transport flags, onboarding enablement/origin, and notification
  sender/triage settings. The Client invitation sender also differs. Preserving
  the existing PA/onboarding flags fails the default-off base preflight, so
  these differences need an explicit reviewed window plan, not blind copying
  or bypassing the validator.
- The generated workspace configuration also lacks the exact owner-page
  Worker-first route. Fix the canonical staging inventory and add regression
  coverage before rebuilding or uploading a candidate. The existing server
  gates must receive that request even when the feature is disabled.
- No version upload, deployment, gate change, or new grant occurred during
  these inventory checks. Re-read current versions before a later deployment.
- Remote migration-list checks report no pending Operations or Client staging
  migrations. This is a ledger check, not proof of live authorization or content.
- Secret-name inventory confirms both
  `CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET` and
  `CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET` are absent from
  Client staging. Provision fresh staging-only secrets through the reviewed
  secret workflow before enrollment/content acceptance, without printing their
  values. The name check does not validate secret contents or runtime health.

## Subsequent staging preparation — 2026-10-02

- Published candidate `af31f14c6b56300167a50e8a12838fa1a4ae4b85` includes the
  canonical owner-page Worker-first route correction (`625731d4`). Applied only
  that route correction to the ignored Ops base and both acceptance configs.
  Full staging preflight, portal pair validation and workspace pair validation
  now pass on disk. Their earlier dry-run evidence does not cover this correction;
  fresh upload/dry-run gates remain. Focused route/profile tests passed 41/41.
- Bootstrap test pins now match all 165 canonical Ops migrations. Its isolated
  run passed 19 tests with four Windows symlink-permission skips and no failures.
- Exact candidate CI run `37052911043` is in progress. The preceding run
  `37051093191` is terminal cancelled: nine jobs succeeded, while the Operations
  job was cancelled. Neither result proves the new candidate's complete CI.
- Prepared only the two missing Client native enrollment/audit secrets using
  cryptographic random values through in-memory stdin to `versions secret bulk`.
  Undeployed version `03934748-73a5-47a3-b280-245afd39e46b` contains both names as
  `secret_text`. No values were printed, written to source, or published.
- Re-read deployed traffic after preparation: Client remains at version
  `2512de43-cd37-4118-97d9-d0c241a3fabd`, 100 percent, deployment
  `ceea1cfc-f581-4a20-b29f-598df0f708bd`. No enrollment or grant was activated.
- Wrangler 4.118.0's latest-version secret listing failed while reading bindings;
  exact-version JSON inspection verified the secret names instead. Comparison
  found all existing bindings unchanged, but the API serialized an explicit
  asset `html_handling=auto-trailing-slash` where the deployed version omitted
  that field, plus deployment provenance metadata. Do not claim byte-identical
  resources or blindly promote this secret-preparation version. Validate the
  final reviewed code/config candidate and exact rollback before traffic changes.

## Refreshed staging drain checks — 2026-10-02

- Preserved exact deployed notification/invitation senders and the Operations
  triage recipient in both ignored bases and their paired profiles. All three
  validators pass after these edits. Fresh Wrangler dry-runs passed for both
  Workers in both windows (four bundles); no version upload or deployment.
- Read-only staging PA counts show zero pending/leased directory, relationship
  and project outboxes; zero directory write fences and active project command
  reservations; zero unresolved acquisition/revision-refresh latest events.
- One historical Project-v2 event remains `uncertain` at version 2, while its
  outbox is `terminal`, has no lease, and has no success receipt. The dispatcher
  explicitly treats uncertainty as terminal and does not retry terminal rows.
  Preserve this evidence unchanged. It is not running work and does not prove
  successful Project-v2 write acceptance.
- Read-only portal counts show zero in-flight legacy/native authority,
  delivery, workspace/publication and cleanup outboxes; zero active recipient,
  delivery, workspace/folder reservation or publication heads; zero unresolved
  native recipient intents, cleanup invocations and onboarding decision fences.
- Two onboarding invitations remain `pending`: one is expired, one remains
  valid until October 9. There are no undecided submissions or active onboarding
  identity bindings. Do not delete or silently revoke those invitations to
  manufacture a clean baseline. Verify their fixture provenance and either
  finish the intended onboarding acceptance or document a bounded temporary
  window closure with exact restoration before new portal deployment.
- The direct query readback returned zero rows written. Wrangler file mode
  returned execution metadata rather than SELECT results; the aggregate results
  were independently obtained through its command query path. No raw invitation
  secrets, handoff payloads, credentials or private client fields were read.

## Secret-only staging activation and invitation classification — 2026-10-02

- Follow-up live-issuance checks show both pending invitations have no current
  issuer authority. Their one-time reveals were already consumed; the future
  expiration alone does not make the October 9 invitation usable. Preserve both
  rows. A fresh bounded synthetic onboarding issuance is still required.
- The secret-version asset serialization difference was reviewed against
  [Cloudflare HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/):
  omitted `html_handling` defaults to `auto-trailing-slash`. A fresh comparison
  normalized only that documented default and deployment provenance, excluded
  only the two added secrets, and found all existing effective resources equal.
  This supersedes the earlier unexplained-drift hold for the secret-only version.
- Rechecked exact Client staging traffic before promotion. Deployed only
  `03934748-73a5-47a3-b280-245afd39e46b` at 100 percent, deployment
  `91798418-7c1b-4cbc-8e73-4c8dcc94131f`. Existing code, versioned flags and bindings
  were preserved. Wrangler also synchronized configured non-versioned logging
  settings; no claim of byte-identical deployment metadata is made.
- Post-deployment readback confirms both native secret names now exist as
  `secret_text`, alongside the four prior secrets. No secret values were read
  or printed. This is prerequisite preparation, not recipient enrollment or
  successful file-access acceptance. No production Worker or public link changed.
- Keep previous Client version `2512de43-cd37-4118-97d9-d0c241a3fabd` as the exact
  pre-secret rollback reference. Future native-window rollback should use a
  freshly verified default-off base retaining the two required secrets.

## Exact-revision CI and next live acceptance — 2026-10-02

- GitHub Actions run `37052911043` completed successfully for published revision
  `af31f14c6b56300167a50e8a12838fa1a4ae4b85`; all ten jobs passed. The Operations
  test step ran from `19:17:52Z` to `19:38:01Z`: all 356 test files and 3,387
  tests passed, then its build passed. Earlier
  polling did not establish a hang, and no restart was needed.
- The signed-in staging `/administration/client-onboarding` form rendered with
  bounded invitation issuance and authorized submission review. This read-only
  inspection did not issue an invitation, create a customer, or activate access.
- The previous synthetic area's inactive allow rows deliberately prevent another
  fresh provision there. Preserve that conflict guard and retained audit history;
  review a fresh isolated synthetic area instead of reactivating old authority.
  A reviewed open/paired-close driver and live onboarding, recipient enrollment,
  selected-folder browsing and revocation acceptance remain required.

## Fresh fixture preparation diagnosis — 2026-10-02

- Two failed preparation attempts created no synthetic area and issued no
  grants. Independent read-only D1 checks showed 165 migrations, zero migration
  insertion-order mismatches and zero rows for the exact window-2 area ID.
- Sanitized diagnostics isolated failure to reference discovery. D1 schema
  enumeration includes its provider-reserved `_cf_KV` table. The corrected driver
  excludes exactly that documented internal table while dynamically checking
  every other table; no application authorization predicate was relaxed.
  See [D1 reserved-table guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
- Independent root rerun passed all 25 focused driver tests, including real
  Miniflare discovery, reserved-table no-introspection and atomic rollback cases.
  The subsequent live preparation retry completed successfully, exit 0, with
  `status=prepared`, `references=0` and verified staging target. It created only
  `staging-native-only-portal-acceptance-20261002-window-2`; no authority window
  was opened, grants issued, customer created or portal access activated.
- Bounded staging reads found one synthetic shared-project head with one current
  immutable revision, organization ownership and no physical folder association.
  The owner's existing exact-resource portal-management allow covers that
  organization. This is a candidate, not an acknowledged publication or file
  access. No project/customer ownership was changed.
- Staging has zero service definitions and zero customer-service enrollment
  heads. The enrollment writer is currently unmounted; a real authenticated
  owner workflow and reviewed service catalog provisioning remain prerequisites
  for selected-service acceptance, not conditions to bypass with direct data
  seeding or a valid empty dashboard.

## Historical joined-fixture recheck — 2026-10-02

- The long-lived full Operations run started at 12:02, before the historical
  authority-producer pin correction committed at 12:59 as `17b532b9`. It later
  reported four failures in the canonical joined recipient/delivery suite.
- An independent isolated rerun of that exact suite against clean current
  commit `5a524c48` passed all four tests, exit 0, in 175.09 seconds. No source
  or authorization guard changes were required.
- The current-revision result supports the corrected historical fixture; it
  does not turn the earlier mixed-time full run into current-head acceptance,
  nor establish live PA sync, recipient sign-in or file-access readiness.
- Preserve the original full run and its diagnostic result independently;
  do not restart it solely because it is quiet or overwrite its failure evidence.

## Native recipient fixture selection and remaining gates — 2026-10-02

- Published tooling revision `809dbfca3d73db7b0e4d200508261c9cb738f144`
  passed all 74 local governed-packet tests. Exact-revision CI run `37057812050`
  passed `source-invariants`, including the locked Operations dependency install
  and new authority-window tests; the overall run remained in progress.
- The same run's desktop Client browser job subsequently failed one of 252
  tests: `client-portal.spec.ts:840`, progressive rendering of 1,200 immediate
  children. Its exact request-count/concurrency assertion at line 878 differed
  from expectation; 251 tests passed and the dual-domain follow-up was skipped.
  Preserve the failure evidence and diagnose it before calling this revision
  release-ready. A local rerun alone must not erase this exact-revision result.
- Follow-up diagnosis found a stale pagination callback could replay a consumed
  cursor after prefetch completed but before React committed continuation state.
  The fix synchronously fences the authoritative generation/folder/cursor and
  releases only matching failed requests for retry. The original 1,200-item
  browser test and its exact eight-request assertion remain unchanged.
  A separate deterministic stale-observer regression requires the observer to
  exist and proves pages remain `[0,1,2]` after its outdated callback fires.
  Both cases passed 20 repeated desktop checks and two mobile checks; Client
  typecheck and build passed. These are local follow-up results, not a green
  result for run `37057812050` or completed live recipient acceptance.
- Published follow-up `949b0e6f94ed912026eaad2cbdd861bf44a15113` started
  exact-revision CI run `37059753833`. The older run `37057812050` is terminal
  cancelled (Operations cancelled; the desktop browser failure remains recorded).
  Fresh source-invariants, ops-sync, incoming-pickup and thumbnail jobs passed;
  remaining app/browser jobs were still live at this checkpoint.
- Additional focused recovery coverage passed: five FileBrowser cases on desktop
  and the same five on mobile, plus seven neighboring native delivery cases.
  The added tests prove a 503 continuation can retry the identical cursor and a
  403 clears private rows and prevents a captured stale observer from reissuing.
  Existing folder-change/late-response and exact eight-page checks remain intact.
  Client typecheck passed. This adds test coverage only, not new access authority.
- Exact-revision run `37059753833` subsequently passed both Client browser jobs:
  desktop 253/253 and eight dual-domain checks; mobile 245 passed, eight skipped,
  plus eight dual-domain checks. The desktop failure from the prior revision is
  therefore resolved in CI, not merely in local reruns. The Operations and other
  remaining application jobs were still live; this is not yet a full CI pass.
- Refreshed live deployment inspection selected the newest timestamp, not the
  first item in Wrangler's chronological list: Client remains
  `03934748-73a5-47a3-b280-245afd39e46b` and Ops remains
  `363c9714-bd6f-4eeb-96df-fef681f4a44a`, both at 100 percent. Exact-version
  secret-name inspection confirms the Client native enrollment/audit secrets
  remain present; no values were retrieved or printed. Ops' existing five PA
  acceptance/transport flags and onboarding-admin flag are still true; the
  validated baseline explicitly disables them. Do not describe that baseline
  transition as preserving these temporary acceptance flags.
- Fresh explicit-config `versions upload --strict --dry-run` checks passed for
  both default-off staging candidates. These performed no upload or traffic
  change. Read-only Ops staging drain checks found zero pending/leased Directory,
  relationship and Project outboxes, zero Directory/onboarding decision fences,
  zero pending/claimed native-recipient outboxes and zero pending/retry/dispatching
  workspace publications. Migration count remains 165 with final migration 0165;
  `PRAGMA foreign_key_check` returned no rows. Every successful diagnostic reported
  `changes=0`, `rows_written=0`, `changed_db=false`. A compound SELECT diagnostic
  was rejected before execution; independent SELECTs produced the recorded
  results without changing guards or schema. Recheck remaining authority/delivery
  ledgers and current pins immediately before an actual activation transition.
- Final result for `37059753833`: all ten jobs passed at exact published revision
  `949b0e6f94ed912026eaad2cbdd861bf44a15113`. Operations completed 356 test
  files and 3,387 tests, followed by a successful build. This satisfies that
  revision's CI gate; it does not prove live recipient sign-in, selected file
  access, service enrollment, production readiness or the owner PA checkpoint.
- The subsequent full non-deploying preparation gate at exact revision
  `949b0e6f` passed preflight tests and bootstrap tests (19 passed, four Windows
  symlink skips), but stopped at the evidence-verifier suite. Its synthetic
  example/test fixtures and verifier tail still described Ops 0163/163 rather
  than the canonical 0165/165 chain; four existing default-off flags also lacked
  fail-closed activation-policy inventory entries. No upload or deployment was
  attempted. CI's green result did not cover this evidence suite. The follow-up
  adds the four non-deploying preparation suites to CI and repairs only stale
  pins/examples and explicit prohibitions, without relaxing verifier predicates
  or granting activation authority. Full preparation must pass again before
  treating any candidate as upload-ready.
- The bounded tooling repair passed the four preparation suites locally:
  118 passed, zero failed, four Windows symlink skips (122 total). Companion
  source/profile suites passed 137 tests with one Windows symlink skip. The
  existing suffix assertion remains unchanged; complete canonical-chain checks
  still reject missing, extra or modified migrations. These are local test
  results, not a successful full preparation run or live acceptance evidence.
- Published tooling candidate `6fbcc6dd` exposed a clean-runner setup defect in
  the newly covered evidence test: ignored local staging config files were not
  available in GitHub CI. The test-only follow-up renders checked-in templates
  with synthetic values in an isolated temporary fixture, copies the reviewed
  migration/config/manifest inputs, verifies missing files are rejected, and
  retains full preflight and evidence assertions. Focused evidence tests passed
  55/55. Actual local staging configs are still checked by release preparation;
  this fixture does not prove deployment or live authorization.
- Use `/administration/client-portal/operations-recipients` and its native
  Operations issuer. Legacy `client_portal_recipient_enrollment_*` ledgers and
  legacy workspace-selection IDs are not prerequisites for this route.
- An organization-root recipient needs one active
  `operations_portal_workspace_reservation_heads` target and an actual client-kind
  Directory record explicitly related to that organization. A shared-project
  head with `client_record_id=NULL` is neither the target nor a client identity.
- Owner permission is checked against the workspace root: effective
  `directory.portal_access.manage` allow, no applicable deny, and current trusted
  admission/profile/grant generation and qualifying role. Global profile-view
  permission alone cannot authorize recipient issuance.
- Before grant dispatch, the current acknowledged workspace publication must
  contain the exact client member under that organization. The issuer rechecks
  the target revision and relationship version through issue, redeem and confirm.
  A successful issue alone is not successful materialization or recipient access.
- Native recipient enrollment grants service-home authority only. Actual file
  access additionally requires acknowledged native folder reservation and
  independently reviewed delivery authority; an empty service dashboard does
  not prove selected-service or file acceptance.
- Direct read-only staging D1 count diagnostics returned zero active native
  workspace reservations and zero client-kind relationships under the selected
  synthetic organization. Both queries reported `changes=0`, `rows_written=0`
  and `changed_db=false`. Therefore that existing project/organization is not
  currently a ready recipient fixture; reserve/publish an explicitly authorized
  workspace and establish a reviewed actual client relationship before issuance.
- The Ops onboarding form was accessible in the signed-in browser. Navigation
  to the synthetic Client staging onboarding path was rejected by that browser
  with `ERR_BLOCKED_BY_CLIENT`. No invitation was issued or authority window
  opened while that recipient UI gate could not be tested. Do not bypass the
  browser rejection or infer that the server returned an application error.
- The authenticated customer-service enrollment route remains unimplemented:
  authorization review stopped that new mutation surface, and direct human
  approval was requested. Existing writer authorization must remain unchanged;
  neither direct enrollment-table seeds nor broad grants are a substitute.
- Service-definition provisioning is also missing, but PA's financial catalog
  is not the authority for these definitions. Migration 0146 and the migration
  plan explicitly separate Ops-owned service enrollment/availability from PA
  prices, products and assignments. Model broad provider-qualified service lines
  such as drone services and website hosting, not one entitlement per invoice
  item. Creating a definition must never enroll a customer or grant portal/data
  access. Customer-scoped `directory.enrollment.manage` must not imply global
  definition-administration authority. Current immutable definitions also need
  an explicit rename/retirement policy before claiming ongoing administration.

Evidence anchors: `operations-portal-native-recipient-authority.ts`,
`operations-portal-native-recipient-authority-dispatch.ts:81` and migration
`0152_operations_portal_workspace_reservations.sql`. This section records source
prerequisites and observed browser behavior, not a completed live portal test.

## Branch cleanup eligibility — 2026-10-02

- Read-only Ops remote audit found 49 heads. All 48 topic heads are covered by
  active-worktree or open-PR exclusions; no eligible deletion remains.
  Remote `main`: `bb8422c77bbcad9093662e8da9d235c40d27282d`.
- Read-only PA audit verified `C:/Projects/Project-Alpha` against the configured
  `ledgetoptechnologies/Project-Alpha` remote and found 26 heads. Protecting
  `main`, `dev`, active worktrees and open PRs left seven graph candidates;
  every one contained commits not in remote `main`, so none is eligible.
  Remote `main`: `1513b6a860a045e1a22e916e282699dea5ce2469`;
  protected `dev`: `4c075e999d51ac2d1e5de64c55133b126ff9bb28`.
- Open-PR head SHAs matched current remote refs in both audits. No squash-merge
  assumption, fetch, prune, branch deletion or worktree archival was used.

Local evidence on 2026-10-02: 14 owner-handler tests passed, including exact
folder reserve/revoke, domain-denial short circuit and replay; Operations
typecheck/build passed, and 35 paired-workspace-profile/scaffold/preflight tests
passed. No live workspace or recipient grant was created by these checks.
