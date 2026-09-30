# Native portal acceptance dependencies

Checkpoint: September 30, 2026 (UTC). These are dependencies for the current
API-first recipient workflow, not a production activation checklist or an
attestation of client access.

## Keep the workflows separate

Current summary: draft PR #139 is pushed at
`97178689c2f517fe49d86decd18bb56fdb0e8170`. Exact-head CI `36700393785`
finished with nine successful jobs; Operations failed in two stale full-chain
inventory assertions and one minute-boundary rate-limit assertion. Test-only
corrections are pushed as `93521c0`: independent QA passed
25 migration/helper tests and 28 delivery-intent runtime tests. Their exact
hash-verified inventories exclude stopped drafts, and the rate test verifies
reset without signature bypass or accepted-quota consumption. Fresh exact-head
CI `36704572043` is confirmed in progress; overall green CI is not claimed. Source-invariants
now passes, and the immutable-152 authority-packet correction passed 49 focused
local tests. It does not authorize packets against the newer schema.
Independent current-chain tooling and full-chain rehearsal passed
locally as detailed below. A clean committed-only c2202db checkout independently
matches Client 143/0225 and Ops 154/0155 names/content hashes; stopped 0224/0154
drafts are absent there. No remote migration/deployment or activation occurred.
Root independent verification of the exact failing CI gate passed 47/47 tests
(53.95 seconds), plus 18/18 source-layout checks. Independent read-only review
accepted the immutable-152 separation. Both added appended-0153 rejection
regressions passed independently (2/2, 147 milliseconds). Before any staging
ledger advance, inspect and close temporary authority with its exact current
version's reviewed cleanup artifact. A 151 ledger must be cleaned before 0152;
a 152 ledger must be cleaned before 154. Missing/mismatched cleanup artifacts
are a stop; historical packet versions intentionally cannot operate on 154.
Any authority support on the newer chain requires explicit versioned review.
Fresh Client staging remains 141/0222 with the new tables absent. Configured Ops
staging D1 read failed with Cloudflare 7403; its current ledger is unverified.
No remote migration may follow from the old Ops readback.

Separate service-home transport review found a named-RPC object/disposer mismatch
that mocked helper and joined tests do not cover. A real two-Worker reproduction
and bounded primitive response fix passed independent local QA: 18 Client tests,
three Ops tests and both type-checks. Final independent root sessions 5839/16936
passed 18/3 tests (25.03/10.86 seconds), including exact correlated initial denial,
an authorized summary and stale-tuple rejection by both Ops and Client after an
acknowledged revoke. These use reviewed legacy transport prerequisites, not the
stopped native enrollment replacement. Both final type-checks passed.
The untouched 971 candidate first reproduced the RPC object's `Symbol.dispose`
mismatch. No whole-portal acceptance or deployment is claimed. Permissions,
native authority and current-manager activation stay unchanged.
Later statements below are chronological checkpoints: retain failures and
historical holds as history, and use the newest explicit component acceptance
only for that component. They are not whole-portal acceptance.

### Chronological component history — superseded where Current summary says otherwise

Release observation: exact head `97908298a593b09d044e3619b0d9f241bc7e3932`
is pushed to draft/open PR #139. CI `36697340183` is live, not terminal accepted.
No merge, deployment, remote migration or recipient activation occurred.

Committed-only inventory review found current release-tooling pins are stale:
bootstrap/evidence/readback/preflight fixtures still expect Client 142/0223 and
Ops 152/0152. The candidate contains Client 143 ending 0225 and Ops 154 ending
0155; stopped 0224/0154 are not committed. Update only current-chain requirements
and evidence fixtures; preserve historical 140/151 and reviewed-152 packet
baselines. Do not generate/bootstrap from the dirty physical migration folders.
This is a concrete release gate even when source-invariant CI passes.
The first corrected-tooling Node run (`8d0021`) exited 1: bootstrap passed, but
evidence fixtures admitted physical Client 0224 and the readback fixture correctly
rejected physical Ops 0154. Fixture-only gap-aware copies and suffix-length
corrections are being tested. Runtime inventory rejection remains unchanged;
this initial failure is not accepted full-chain evidence.
Corrected Node tooling tests now passed independently: producer `64832f` and
root `cac7d1` each report 123 tests, 119 passes, zero failures and four Windows
symlink skips (8.16/8.43 seconds). This covers bootstrap, preflight, evidence and
readback, including exact 154-schema query execution and unknown-file rejection.
The Client Miniflare full-chain rehearsal is still live as session 2713; no
terminal migration-rehearsal acceptance is claimed from Node tests alone.
That producer rehearsal subsequently passed as session 2713: preflight 9/9 and
Vitest 1/1 (75.49 seconds), with Client type-check passing. Independent root
full-chain session 66814 is now live; terminal independent acceptance is pending.
CI Client job 109828349810 on head 9790829 failed only the stale bootstrap
inventory gate (expected 142, found 143); 132 other Client files and 1,421 tests
passed. The current ten-file correction is not yet committed/pushed, so that
failed CI does not test it. Ops CI remains live; do not restart unchanged jobs.
Independent root full-chain session 66814 is now terminal passed: one test,
75.59 seconds, plus root Client type-check. Independent read-only review verified
the exact committed name/content hashes, unchanged runtime rejection and
historical baseline preservation. The ten-file tooling correction is locally
committed after these gates; no remote apply or deployment follows from this.

Production-main release gate: the actual Vite-emitted Client main module fails
local workerd startup because it exports the numeric
`BULK_CACHE_CLEANUP_MAX_D1_QUERIES`. Build success is not startup success. The
bounded fix moves unchanged cleanup limits to an internal module and updates
the backend-test import. Require emitted-main startup and cleanup regression
tests; never omit/filter main exports to make the test pass. No deployed
production outage is claimed from this candidate-only finding.
The minimal move now passed producer emitted-main QA (two tests, 6.06 seconds)
and independent root emitted-main QA (two tests, 6.08 seconds), plus independent
39-test bulk backend regression and Client type-check. The harness invokes the
checked-in build script in a fresh child process, rather than reusing stale
in-process Vite output; the emitted Worker is not filtered. This is local startup
and default-off/no-storage evidence, not live staging or production acceptance.

The 17-file inert publication/recovery cohort is now locally committed as
`86d30e6a10c31ccca87508050fb9d224048c01d3`, pushed with startup fix
`97908298a593b09d044e3619b0d9f241bc7e3932`, not merged/deployed. Earlier
green CI is for `ee934938526532de923403759972d039a88b0130` and does not cover it.
Stopped 0154/0224/native-authority drafts are outside this commit.

The data-only transport defect below is now resolved in local frozen-byte QA.
Ops producer 67247 passed two files / five tests (216.83 seconds); root 12656
independently passed the same cohort (217.39 seconds). Ops type-check passed
independently in root 19796. The complete two-Worker binding harness passed
producer 350 / session 34409 (two tests, 79.13 seconds) and independent root
45796 (two tests, 79.35 seconds). Normal receipt correlation, lost publication
response recovery without resend, cancellation recovery, race serialization,
cross-database heads/receipts/snapshots and checkpoint digests were verified.
The real-binding fixture has empty project topology; complete project coverage
is separate component evidence, not a full portal/client acceptance claim.

Frozen Ops SHA-256 values: outbox runtime
`a12ca35fd27b1e75787c17f23106ca63d28486462ec80708a3dc2f170b9a7173`;
cancellation runtime `30b6c97ddc5eb36ec0c93418ee99cff6c19b1d44ac4b291286341819d1928e61`;
outbox test `30757a4351ce8fb4ba7afe847a0418df1def3e6c78c11610acbf3907fab1058e`;
cancellation test `efcdbc86bf5b5e7996b963fdadd694ce5cba2fcff35ed9d37fb7e5cff2a6473c`;
two-Worker test `2195cea529c4034b0cc16eb2a495bd9ee2e8a6f18d754046b3886ebb0fa197f2`;
driver `0340af00b81146643fe3b13333f4f2b6b90e2bf7ad3bdf4fdfb6b807eb3e833f`.
Source-layout invariants passed 18/18. SQL bytes remain unchanged. The stopped
0154/0224 drafts are excluded from the tested selection and release staging;
neither publication nor cancellation creates recipient/file authority.
The proposed publisher management route/binding, production-main/config
activation tests, current-invoker audit and live staging remain release gates.

Fresh Client transport QA (September 30): the bounded primitive response wire
passed independent root run 52940, five files / 36 tests, 34.72 seconds; Client
`tsc --noEmit` also passed. This includes the named Worker binding and existing
public-share routes, lifecycle and location regressions. Frozen SHA-256 values:
shared contract `102b12c2cfa5887998322b54148b886f2846721c7a954980ddeed7019b950f58`;
Client ingress `ac2f7fc7328b087d0304db9ed04ca685cdd1ccd4113dea3a98753e16a51a398a`;
ingress test `f2b953af5928a6063bcbb37cfadde770e15eec45b640708bc5f494d4059a6505`;
Client binding test `7fe638826418d2d862eedc6a412a2b8155a20b5bdbf74ea0d04f7816a367693b`.
These supersede the older phase-1 test hash below. Fresh local Ops component
and complete Ops-to-Client binding acceptance are recorded above; this does not
prove live staging, client enrollment or production readiness.

Historical pre-fix phase-2 runtime evidence: producer cell 316 exited 1 (75.61 seconds).
Workspace reservation succeeded, but normal publication and cancellation
recovery returned `retry`; the complete Ops-to-Client gate failed at that point.
Diagnostic cells 328 and 333 also exited 1. Final diagnostic cell 337 exited 1
(75.43 seconds; one intentionally diagnostic case failed, one skipped). The
actual successful named RPC result had own keys `ok`, `receipt` and
`Symbol(Symbol.dispose)`. Ops rejected that envelope and retained
`retry:1:rpc-outcome-ambiguous`. No publication bytes, identity proofs or tokens
were logged. This is a confirmed transport-contract defect, not a migration or
recipient enrollment failure.

RPC transport review identified the platform difference:
Cloudflare adds a disposer to RPC object results, while the Ops response parsers
reject additional own symbols. The earlier Client-only harness serialized the
result with `Response.json`, masking the defect. The implemented scoped fix is
a bounded primitive JSON response wire at the named ingress only; internal
object APIs, strict nested closure, exact identity/fingerprint pins and every
permission/CAS safeguard remain intact. No symbol exception or callback
invocation was added. Prior component runtime/test hashes are superseded by
the fresh frozen-byte component and actual binding evidence above.

Mounted publisher gap: Ops currently has only unmounted publication/cancellation
helpers, with no corresponding configured staging publication binding or drain.
The real Client ingress test is not proof of that wiring. A reviewed staging-only
owner management boundary, private binding/generated types, and live exact-ID
dispatch/recovery/default-off rollback are separate release prerequisites.

Current-invoker mount prerequisite: 0153 dispatch carries original creator
authority; 0155 cancellation has no human-invoker argument and its audit records
only the exact Client receipt/claim. A route-only preflight SELECT is not an
atomic invocation guard. Before exposing owner POSTs, review a durable current
invoker/claim audit with exact operation/root/target pins and deny-winning checks.
Allowing a current manager to clean up ambiguous attempted work must not allow
republishing a snapshot whose original authorization is no longer current.
Dispatch must preserve current checkpoint and original-creator authority.
Cancellation must instead retain cleanup after source/creator/workspace drift:
prove current invoker scope against the exact immutable command/reservation
identity tuple, without requiring active workspace state or latest revision.
Disposition recovery/tombstoning never calls publish; exact durable Client
receipt and claim-bound cancellation audit are required to release the fence.
No implementation, grant or route activation is claimed for this design finding.

Local configuration correction: the ignored Client staging config now explicitly
sets `CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED` to `"false"`, matching
the reviewed template. Parsed readback confirms the staging Worker/environment
and disabled value. Scaffold and recipient-enrollment configuration regressions
passed 9/9. This edit was not deployed and does not activate publication or access.

Actual Client named-entrypoint binding harness now passes independently:
producer 45217 passed 2/2; root 91002 passed four files / 25 tests including
public-share compatibility, and root Client type-check passed. Exact harness
SHA-256 `04a1f3883f4bf1d040726523899095b35421c441abc2bc0ff711b0004770d865`.
It uses the bundled production ingress and real workerd RPC, not a mock.
Only reviewed Client <=0223 +0225 is applied locally, with no grant side effects.
This supersedes the harness-pending statement below, not live staging,
the actual Ops dispatcher binding integration or recipient sign-in acceptance.

Revised frozen 0153 coverage is independently accepted with paired 0155:
producer session 52175 passed 2/2 (105.92 seconds); independent session 16657
passed two files / five tests (208.27 seconds), and Operations type-check
session 90261 exited 0. Exact 0153 SHA-256 pins:

- SQL: `7eec18defdb2e22593dad0a5cbedc01615285c1b1b8f92cfe46ee945e1f33ad2`
- runtime: `572995a6f7cbc8dec923644e7ff66a71057489ccfa9ec344004e26e7c50ec86d`
- test: `f262b14ec09a367c7f08cb08080b2a34f9be2f1cdd22ee71c83ca2dd44112be9`

Coverage includes complete customer-owned project sets without folders,
standalone clients, cross-owner exclusion, current relationship/version drift
and deny-winning global `projects.view`. It does not resolve delegated native
division/project read semantics. The complete actual Ops dispatcher-to-Client
binding harness is now being implemented; no terminal result is claimed yet.
No remote migration, deployment, recipient grant or production activation ran.

Phase-2 harness remains unaccepted. Its first producer runtime attempt (cell 301)
exited 1 during `beforeAll` (71.67 seconds; two cases skipped) because a fixture
destination referenced a root variable before definition. The fixture was fixed;
earlier response-typing issues were fixed and Ops type-check passed (12.42 seconds).
Review also required distinct legitimate root fixtures (0152 intentionally allows
only one active workspace per root), exact cross-database tuples/audits, binding
call counts proving no resend, terminal race reconciliation and unchanged grants.
Do not count setup-skipped tests as runtime acceptance or weaken reservation
uniqueness to make a fixture pass. Final expanded assertions need a fresh run.

Local data-only migration selection readback: Operations has 154 selected files
(`<=0153` plus exact `0155`); Client has 143 (`<=0223` plus exact `0225`).
Stopped `0154` and `0224` drafts remain present but are **not selected**.
Selected-content fingerprints (SHA-256 of each sorted filename, NUL, raw file
bytes, NUL; exact extra appended after the reviewed prefix):

- Operations: `313621f1d6825de58b5e4d7b93b4fae1e53710249538b93e728439a87d7391b4`
- Client: `432f51f38ad9329ab6acb579ec11b88b4d72d5f75d7969de0ebddee69de5e131`

These pin the harness inputs only. They are not full physical-directory seals,
deployed ledgers, migration attestations or permission to apply stopped drafts.

Optional PA fences are provenance only. Null/empty means no freshness
assertion, not unmapped or authorized. Native metadata must continue through
PA outages. Exact V2 project provenance is traceable, but the existing
directory reconciliation does not establish full native/PA profile congruence.
Do not enable PA-dependent readers on the strength of missing fence values.

Final independent frozen Ops 0155 QA accepted: session 18876 passed 3/3 cases
(102.82 seconds); Operations type-check passed. Exact hashes match producer
97900 below. The receipt/audit release and paired local recovery component are
accepted on those bytes, not deployed or accepted live. A subsequent 0153
coverage edit must obtain fresh component QA and rerun paired recovery.

Producer Ops 0155 session 97900 passed all three cases, including paired real
Ops/Client D1 terminal races and lost responses; Operations type-check passed.
Independent exact-byte QA remains pending. These local in-process RPC tests
are not live staging Worker binding or client sign-in acceptance.

Service-home cutover gap: the current Client authority resolver and Ops metadata
query both require legacy authority-v2/binding/enrollment records. They do not
consume native recipient heads. Both need exact native-proof adapters plus a
versioned private correlation tuple before native enrollment can render the
service-aware home. Do not synthesize legacy authority rows as a shortcut.
Keep descriptive service visibility separate from file and financial authority;
the native adaptation remains behind the existing approval stop.

Final independent Client 0225 component acceptance supersedes the historical
Client review holds below: producer session 14725 and independent session 65211
both passed three files / 20 tests; Client type-check passed. Independent
preflight passed 9/9. Nested closure and full canonical-body matching reject
tampered cancellation evidence. Frozen SQL SHA-256:
`1f878648bd575efa7e281073b9744a19838cc56c4460b48ce4f95d44609a3274`.
This does not accept the final Ops 0155/paired recovery release, enable native
authority, apply migrations or replace live staging workflow acceptance.

Latest local recovery evidence: frozen repaired Ops 0153 passed producer
session 63990 (1/1, 97.82 seconds), independent session 14066 (1/1, 97.51
seconds), and independent Ops type-check. An additive Client missing-table
compatibility failure was reproduced and corrected; it does not permit a
cancellation success without the cancellation table. Root's closed enumerable
receipt regression passes with all nine focused Client endpoint tests.
Ops 0155 historical acknowledgment replay/readback and the complete paired
0155/0225 acceptance remain pending. These results do not replace a current
full migration inventory, CI, live staging acceptance, or the stopped native
0154/0224 approval gate. No remote migration or rollout is claimed.

Independent 0225 review holds cancellation acceptance pending complete nested
JSON validation and raw altered-body regressions. Existing top-level counts and
row pins alone are insufficient. Ops-only mocked disposition tests are not the
required real two-database publish/cancel race and lost-response acceptance.

Latest root endpoint evidence: 10/10 tests plus Client type-check pass after the
exact cancellation-response regression. Full canonical cancellation readback
is now implemented, but final 0225/paired acceptance is still pending.
The earlier pre-coverage revision's folder-backed project selection omitted website,
metadata-only and pre-delivery projects. Full portal acceptance must include
customer-owned projects without folders, service-aware reads and independently
authorized financial summaries; a publication receipt is not proof of those.

- Customer onboarding collects a proposed profile through the private
  `CLIENT_ONBOARDING_RECIPIENT_BRIDGE`. Operations requires its session secret,
  onboarding handoff keyring and audit secret. The recipient bearer proof is
  not an authenticated portal enrollment or a file grant.
- Verified-recipient enrollment uses signed Cloudflare Access identity,
  explicit recipient consent and subsequent owner confirmation. Client requires
  `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET` and the private enrollment
  bridge. Operations uses its own session secret for owner CSRF. These secrets
  are separate; never substitute one for the other.
- Service-home reads use `CLIENT_PORTAL_SERVICE_METADATA_READER` and an
  acknowledged, current `operations.service_home.read` grant. There is no new
  service-home HMAC credential. Home access alone does not authorize files.
- Folder sharing additionally requires the audited recipient-delivery authority
  command, exact home-grant and enrollment pins, current publication/resource
  proof and the private `VERIFIED_RECIPIENT_DELIVERY_AUTHORITY` binding. A
  structured owner proof is not a browser-supplied owner flag or a secret key.
- API-v2 reconciliation requires the exact enabled and scoped
  `PROJECT_ALPHA_API_V2_CONNECTIONS` source/application/history-epoch tuple and
  current durable receipts. A secret name, a cached catalog or a PA login page
  cannot establish that authority.

The canonical all-feature staging secret manifest remains unchanged. It also
lists credentials for legacy projections, media uploads, pricing hints and
other separately gated features. Do not interpret that complete list as a
request to manufacture obsolete PA integrations, copy production credentials
or enable unrelated features just to test native enrollment.

## Fresh inventory and limits

- Client staging is `e35e9fdc-2beb-4a0e-be1b-fa4c372f6cc0` at 100%.
  Remote secret-name inventory includes its dedicated enrollment CSRF secret,
  Delivery session secret, Delivery code pepper and audit secret. Values were
  not inspected. The modern manifest recognizes the CSRF secret; the older
  onboarding-only manifest does not.
- Operations staging is `f5a07171-cb05-4cf3-9251-afe087550920` at 100%.
  Its six listed secrets include session, audit, onboarding keyring, API-v2
  connections and the two Delivery secrets. Presence is not a credential-health
  or scope test. All inspected native enrollment/home flags and the temporary
  API-v2 read-acceptance flag are false.
- Active Ops bindings include the existing workspace/access/authority-v2 and
  inventory-catalog services. They do **not** include the new
  `VERIFIED_RECIPIENT_DELIVERY_AUTHORITY` service. An applied sharing migration
  is not evidence that its newer runtime or private transport is deployed.
- Client migration 0222 was applied to `client-data-staging` on September 30
  after a private, ignored 579,714-byte SQL export. Backup SHA-256:
  `c9f63a892eaa7b565b72c7bcfe4cdcb472b473b9c5e20a248b37098689b2b7cf`.
  Remote readback confirms 141 Client migrations, final filename 0222, no
  pending migrations, an empty foreign-key check and zero delivery heads/audits.
  All nine recreated/new authorization triggers match the reviewed migration
  exactly after line-ending/terminal-semicolon normalization. Client staging
  runtime remains `e35e9fdc-2beb-4a0e-be1b-fa4c372f6cc0`; recipient writer,
  enrollment and portal flags remain false. This is schema acceptance, not
  positive live revocation or an enabled portal. Last Ops ledger count is 151.
  The full local 141/151 runtime chain, foreign keys and idempotency checks pass.
- The visible Client `/portal` screen says the portal is not enabled. This is
  consistent with default-off configuration, not successful recipient access.
- Ops Sync staging is absent. Its old signed projection pipeline is not a
  prerequisite of the native private home RPC itself. The missing API-first
  publication adapter remains a real file-sharing gate; bypassing it with
  cache-only or legacy-proof assumptions is not an acceptable replacement.

## Next acceptance order

The new historical-lineage case now passes in actual workerd after the v7/v8
generated guard split. The split retains every top-level predicate as its own
CHECK inside the same atomic batch; 47 packet/guard tests pass, including denial
and rollback cases. The final full joined workerd suite passes all four cases. This is
local runtime evidence, not live recipient enrollment or delivery acceptance.

The generic API-v2 publication proof contract is implemented and inert,
with eight focused tests passing. It neither creates nor validates live authority
by itself. The next publication path is Ops-native: Operations owns customer
topology, projects, explicit folder reservations, recipient identity and grants.
PA supplies optional linked-record freshness fences, not portal principals or
entitlements. A complete workspace snapshot is not permission to browse it.
Client readers must still apply current individual enrollment and resource
grants, without falling back to legacy permissions.

The separate Ops-native publication contract now has 25 passing focused tests.
Its committed version passed Ops type-check; the newer reservation candidate
requires its own final type-check and runtime acceptance. Directory records support explicitly linked
mirrors from both PA instances; projects retain one selected financial instance.
Validated arrays and objects are copied from own data descriptors, so hostile
proxy property reads cannot execute during parsing. This contract remains inert:
producer reservations, atomic publication consumption and live readers are still
required before it can support client access.
Opaque native identifiers follow the actual Directory/project writer grammar:
191 Unicode code points / 764 UTF-8 bytes, without trimming or treating slashes
and dots as paths. Portal workspace/binding identifiers retain their 200 / 800
bounds. Folder prefixes have independent traversal/reserved-segment checks.
Standalone clients retain their explicit NULL-parent relationship revision;
only organizations have no client relationship revision. A missing standalone
relationship pin cannot silently become an unlinked-root proof.

### Historical reservation/publication candidate chronology (not staged at that checkpoint)

Ops migration `0152_operations_portal_workspace_reservations.sql` and its
server-side writer are committed on the draft staging branch at
`3c68dbd8628254ca660b2646e498261aaaf707d9`. They reserve exact roots and
selected folders without creating recipients, grants, public links or PA
identities. Current-chain tooling must pin 152 Ops migrations with 0152 as the
tail; historical 151-migration evidence remains historical, not evidence for
this new candidate. Client staging still has the verified 141/0222 ledger.

Acceptance requires current native admission/profile/grant-generation proof,
the existing trusted global-owner policy plus scoped allow/deny checks,
immutable creation provenance and fresh authorization on idempotent replay.
Malformed expiry values must fail closed in both the runtime and raw D1 write
path. Exact folder prefixes must obey the shared publication grammar; an
ancestor reservation cannot implicitly authorize another reservation.

Only unused reservation tables are added by schema application. The full-chain
rehearsal additionally checks that these tables start empty. No 0152 remote
apply, runtime deployment or successful reservation acceptance is claimed yet.

### Historical CI and producer chronology

Exact-head CI run `36679697001` has a completed failed `source-invariants`
job. Its two failures are staging packet manifest assertions that still pin
151 Ops migrations, while the committed candidate has 152. The authority
predicate and rollback cases in that job passed; this does not excuse the
manifest failures or establish release readiness. Update and rerun the exact
packet tests, preserving historical 151-chain fixtures where intentional.

The two packet corrections are now committed and pushed as
`9bb78d3212f820c8d2042393e7761c096d906fb0`. They independently verify the
reviewed 152-chain names and content hashes before copying an isolated fixture,
so concurrent uncommitted migrations do not silently change this historical
acceptance window. All 44 focused packet tests passed. Exact-head CI run
`36680957665` now has nine successful jobs, including `source-invariants` and
its staging-packet checks; the Operations job has now failed with five tests
across the native resource audit and canonical joined fixture suites. Terminal
CI acceptance for the complete candidate is contradicted by that failure.
The audit test crossed a legitimate ten-minute dedupe boundary and needs a
test-only fixed Date; joined fixture failures are being diagnosed separately.

Both diagnoses now have test-only corrections and independent QA acceptance.
The focused audit regression passed (1 case, 42 filtered cases), and the joined
suite passed all four cases in 174.56 seconds. The latter now applies the exact
reviewed 152-chain and verifies count/tail/names/content hashes before copying
its isolated producer fixture; immutable 122-chain historical pins remain
unchanged. An initial local rerun failed because the old recursive copy admitted
uncommitted drafts; that failure is retained as setup evidence, not a pass.
The full native-resource suite subsequently passed all 43 cases in 859.23
seconds. New exact-head CI acceptance remains a separate gate. No production
guards or runtime behavior changed in these corrections.

Corrections and the previously inert consent/contract component commit are now
pushed as `ee934938526532de923403759972d039a88b0130`. Remote branch and
draft/open PR #139 readback match that head. New exact-head CI run `36684423126`
is terminal successful with all ten jobs passed;
the complete local native-resource
suite is terminal passed as session 63329. Neither a merge nor a deployment is
implied by this push.

Terminal Operations CI totals are 321 suites / 3,144 tests passed in 1,066.45
seconds, read from job 109786881687. This proves the committed candidate's CI
gate only; later local recovery files and native-authority drafts are outside
that immutable commit and outside this passing evidence.

At that checkpoint, the publication producer/outbox was being implemented
as migration `0153`. Its then-untracked draft was not included in the committed
152-chain digests below and must not be treated as reviewed or staged. Once
stable, independently review the source-currentness guards, actual private
Client RPC round trip, ambiguous-response reconciliation and atomic receipt
acknowledgment before sealing a new 153-chain inventory. Initially empty
recipient/delivery arrays do not replace the native enrollment/access work.

Final independent review accepts the frozen data-only 0153 component. Its
canonical Miniflare test passed independently in 94.46 seconds and Ops
type-check passed. All thrown publish invocations are treated as ambiguous;
fresh exact-not-found/current-source retries resend the same immutable command.
Stale ambiguous calls remain single-flight fenced, not safely cancelled. A
separate Client tombstone/cancellation CAS must serialize publication versus
cancellation before a stale slot can be released. This remains an explicit
recovery implementation gate, not a claim of complete portal readiness.

#### Required ambiguous-publication termination protocol

- Keep this data-only protocol separate from pending Ops 0154 / Client 0224
  recipient authority. Do not overwrite or reorder their incomplete drafts.
  The independent data-only Client draft may use tentative 0225, depending only
  on reviewed 0223. Do not apply pending 0224 as a prerequisite or claim a sealed
  full inventory. Final canonical numbering and complete-chain acceptance remain
  required before any deployment.
- Client stores an immutable cancellation tombstone keyed by the original
  operation ID and exact fingerprint, publication, target/revisions and snapshot
  tuple. Its first-primary cancel-or-status transaction returns an exact existing
  publication receipt, or inserts a tombstone only while the expected head still
  matches (including the absent-head/revision-zero case).
- Publishing and cancelling must serialize through reciprocal raw-database
  guards. Publish wins: cancellation returns the committed receipt. Cancellation
  wins: a delayed publish cannot commit and returns the exact cancelled result.
  Status-not-found, elapsed proof expiry and a local timeout are not cancellation.
- Ops durably records the exact cancellation receipt before releasing the
  single-flight slot. A lost response is reconciled through private disposition
  lookup. Unknown, mismatched or unavailable outcomes stay fenced; an actual
  publication receipt follows normal exact acknowledgment even after local drift.
- Verify real two-database races in both orders, concurrent terminal outcome
  exclusivity, late commit after timeout, lost cancellation response, stale head,
  exact replay and fingerprint mismatch. Prove a new current snapshot can reserve
  only after an acknowledged terminal outcome. Assert zero recipient/file grants.

At that checkpoint, this protocol was planned, not implemented or deployed. It is required for
reliable recovery; do not describe indefinite fencing as the completed solution.

Later root review found an additional unreleased 0153 gap: a status-response
failure can erase a previous ambiguity diagnostic, while worker death after
claiming can leave it NULL despite an attempted invocation. Diagnostic text
cannot prove non-commit. Any attempted call requires exact durable terminal
evidence before the single-flight slot is released. New regression cases and
the data-only cancellation implementation are in progress; the earlier frozen
0153 QA result is superseded until the corrected bytes pass independent review.
No 0154/0224 grant/enrollment code is authorized by this data-only work.

The replacement durable marker is monotonic: record `remote_attempted=1`
under the current claim before RPC, never reset it on retries, and prohibit raw
terminal release at 1 without exact publication/cancellation evidence. A
nonzero claim count with marker 0 is still pre-invocation and may be superseded
after source/authority drift. Claim-conditioned terminal updates must confirm
one changed row or read back the exact durable terminal result; a racing worker
must not receive a false `dead`/`superseded` success. These additional regression
requirements are under implementation/review, not yet acceptance evidence.

### Native authorization boundary checkpoint

The new separate `operations-portal-native-authority` v1 wire has 20 passing
contract tests, including the independent review's actor-subject alignment
correction. Its permission grammar remains version 3; it must never be
interpreted as the legacy PA workspace authority protocol. The new native
consent HTTP boundary and preserved legacy boundary pass 31 tests together;
Client type-check passes. Independent consent review confirmed the origin,
CSRF, signed proof, expiry and body bounds; its hidden-value-member finding
was corrected with a negative test. Exact native routes also reject fragments.
They capture signed Access issuer/subject server-side,
use a separate CSRF domain and exact target/revision/client consent, and return
pending owner review, not an access grant. No new route is mounted or enabled.

The workspace safety reviewer rejected creation of the native recipient-grant
consumer as an authorization-boundary expansion requiring direct human approval.
That specific authority implementation is stopped pending approval for Ops
0154 / Client 0224 and their default-off local/staging grant/revocation code.
An accepted, uncommitted 0224 schema draft is not tested, applied, or authority
acceptance evidence. Do not route around the denial, use publication as a
substitute for grants, or enable production access. Data-only 0153 publication
review can continue independently.

### Concrete consumer and reader integration boundaries

Read-only reader mapping confirms that `workspace-v2.ts`'s existing native
context is still PA-projection-backed, not Ops-owned. Service-home adapters
must be separately joined to the current exact native recipient/workspace
heads and publication receipt, then revalidated after metadata RPC. The new
wire carries only `operations.service_home.read`: it cannot supply broad
workspace/directory access or unlock file routes. Authenticated delivery needs
its own individually scoped grant, exact folder/project/prefix pins, terms,
deadlines and immutable file-event checks, including post-read revalidation.
Keep `operations-home-routes.ts`/`operations-service-home.ts`, `workspace-v2.ts`,
`authenticated-delivery-grants.ts` and `authenticated-delivery-resources.ts`
as distinct implementation/acceptance gates. Do not seed PA-shaped principals
or `portal_v2` memberships to bridge these real dependencies.

The new Client `0223` publication-data consumer has four passing canonical-chain
tests, including actual private RPC invocation against real local D1. It stores
snapshots, CAS heads and immutable receipts without creating PA principals,
legacy entitlements, membership or recipient grants. Parent review requires
exact-command guards on head inserts/updates as well as receipt insertion, so
an existing historical receipt cannot be reused to manufacture a new head.
Its current local inventory is 142 Client migrations, not a reinterpretation
of the deployed 141/0222 evidence. Final local paired rehearsal passes all
15 tests in 111.72 seconds; exact head-command and snapshot-body guards are
verified, and reservation revision remains independent of publication revision.
Client and Ops type-check pass. Sealed chain content SHA-256 values are
`b6f7434ac3a570c971f6ad74239a7cb20cc4a2381f88bae7a4f8dc139861a27e`
(Client) and `f854aa66e1bb1b3c81feb7a11b18d654b11232d5e3732234ebff12e779f6e3a9`
(Ops). Focused staging/configuration tooling passes 142 tests, with four Windows
symlink skips. Independent Ops reservation QA accepted all current guards,
including commit-time protection against a delayed workspace revoke after
creation of a new active folder. No remote 0223/0152 apply is claimed.

Subsequent Client QA additionally accepted the strict canonical-command JSON
guard and primary-session concurrent exact-retry recovery. Fourteen focused
consumer/RPC tests and Client type-check pass. Private status requires the full
verified publication and exact durable receipt tuple, is read-only, and returns
explicit not-found only for an unseen operation. The Client digest above now
pins those corrected SQL bytes. Their final paired rehearsal passed all 15
tests in 111.72 seconds; the earlier 11-test result has been superseded.

The named private publication ingress has six passing boundary tests and Client
type-check passes. Its dedicated switch is default-off; runtime environment and
exact staging host are checked before parsing or storage. Successful responses
require a closed durable receipt matching the complete publication fingerprint.
HTTP returns 404, and publication is data only—not recipient or file authority.

- `operations-service-home.ts` and `operations-portal-enrollment-status.ts`
  currently depend on exact workspace authority, protocol-v3 principal grant,
  binding and receipt coordinates. Native publication must not replace these
  with descriptive service rows or manufacture enrollment.
- Ops `client-portal-service-metadata.ts` currently resolves the customer via
  acknowledged authority and binding outboxes/selections. Replace that lineage
  with exact current native reservation/publication and recipient proof, keeping
  service definitions/enrollments, expiry and revocation checks.
- Client `workspace-v2.ts` still reads PA source/principal/eligibility/directory
  projections. Implement a separately fenced Ops-native context adapter; do not
  forge PA-shaped principals or cache-only entitlements to unlock the old path.
- `authenticated-delivery-grants.ts` still joins legacy folder publication and
  PA/native-staff authority. Native file reads require explicit individual
  delivery heads, exact folder reservation and publication receipts, current
  enrollment/home pins, terms/denials, and post-read revalidation. A topology
  snapshot or service-home permission alone is insufficient.
- Keep the Access/CSRF recipient redemption boundary separate. Neither
  publication nor customer synchronization implies consent or portal membership.

Implement and verify the replacement end to end:

### Native identity dependency confirmed from current source

The existing enrollment workflow is not ready to authorize an Ops-native
workspace merely by replacing its publication adapter. Ops migration 0148
requires `selection_id` from `client_portal_workspace_binding_selections`;
its insert guard requires the acknowledged inactive legacy binding receipt.
The private `client-portal-recipient-enrollment-entrypoint.ts` and recipient
HTTP consent flow carry that selection ID. Client service-home discovery joins
the legacy authority/binding chain and an active `portal_v2_workspaces` row.
Those are real enforced dependencies, not optional cache metadata.

The native replacement must bind the same consent and owner-review decisions
directly to the exact 0152 target, target revision, client authority, workspace
and explicitly selected client record. An authenticated Access issuer/subject
is captured only at the Client server boundary; never match it by email/name.
Confirmation must atomically recheck current customer relationship, owner
authority and reservation state. Revocation must become locally effective
before transport reconciliation, so a delayed remote acknowledgement cannot
keep granting access. Historical creation provenance remains immutable and
cross-manager cleanup uses the current authorized revoker.

Publication and native enrollment remain separate protocols: topology receipt
alone grants no home or file access. Selected-folder authority must additionally
pin its exact native folder reservation and the current individual home grant.
The producer initially emits empty recipient/delivery arrays rather than
inventing native authority from legacy rows. Real portal readers must join
the new current heads and receipts, then revalidate after asynchronous reads.
No fake PA principal, permissive legacy fallback or automatic activation is a
replacement for this work. Default-on eligible service enrollment and no
unsolicited invitations remain production cutover requirements, not reasons to
skip individual identity verification.

- Reserve an explicit Ops workspace root and exact project-to-folder targets;
  never infer them from names, addresses, email or a PA-shaped cache.
- Publish a bounded, immutable root/direct-client/project topology snapshot
  with canonical hashes, counts, versions and exact authority-head references.
- Atomically consume the snapshot into Client publication records and receipts;
  do not write PA principals, entitlements or legacy projection grants.
- Join real hierarchy and file readers to that publication receipt and live
  recipient/delivery authority heads. Service-home access alone cannot expose
  all customer details, projects or files in the workspace.
- Verify retries, duplicate receipt replay, stale-version rejection, partial
  write rollback, revocation without republishing and customer isolation.

1. Reproduce the preserved historical pre-0123 bootstrap and onboarding
   generations through real producers; rehearse v7 acquisition and v8 selection.
   Do not seed approvals, grants, histories or activation receipts directly.
2. Complete Ops-native workspace publication and independent-manager revocation
   across Ops, the private contract, Client atomic guards and actual readers.
   Preserve native identity/version, recipient, project, folder and prefix pins,
   plus source/application/epoch fences where a record is linked to PA.
3. Check current-schema remote readback and private backups, then prepare exact
   current-lineage default-off versions with their new private binding. Never
   deploy the older onboarding-only candidate over the newer staged portal.
4. Use the generated bounded enrollment window for real owner/recipient consent,
   confirmation, service-home, full revoke and acknowledgement/reconciliation.
   Test folder browsing separately under its exact reviewed grant; repeat denial,
   replay, transport recovery and public-link compatibility checks.
5. Restore staging flags and confirm cleanup. Only successful joined evidence
   can create the owner checkpoint for both production PA updates and the
   coordinated production cutover. No production links or grants change here.
