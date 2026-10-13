# Native portal folder-access implementation checkpoint

September 30, 2026. Staging-only implementation plan, not production acceptance.

## Latest browser and Client acceptance

- Root independently reran owner share UI (16 cases) together with recipient
  consent/review UI (18 cases): all 34 desktop/mobile browser cases passed in
  13.2 seconds. The corrected pending-to-confirming path uses the server-assigned
  binding. Owner and recipient strict parsers each passed 8 tests; Ops type-check
  passed. All use local fixtures, not staging deployment.
- The two UI panels are still not mounted in the regular Ops/client navigation.
  Owner HTTP registration/configuration and staging service bindings are also
  absent. The default-off modules themselves are tested, but end-user access
  cannot be reached on staging until the registered Workers are deployed.
- A display-only recipient label is being added to the signed enrollment flow
  for manager usability. It is not an identity key. Recipient lookup and access
  remain bound solely to issuer plus stable subject.
- Final independent owner/delivery unit cohort passed 45 tests in seven files;
  the separate final recovery-actor race case passed one test. Together these
  eight distinct files cover 46 cases, including manager changes after async
  resource proof and before apply. They do not replace the populated-D1 or live
  acceptance gates.
- Read-only recipient review then exposed a separate real-flow blocker: pending
  redeemed intents have no recipient binding until confirm, while the recipient
  UI parser/fixture required one and its confirmation correlation required the
  binding to stay unchanged. A scoped state-contract/fixture correction is under
  implementation. Do not claim end-to-end enrollment acceptance before that
  real null-to-bound transition is independently exercised.
- Expanded populated D1 acceptance was independently rerun against the current
  label/recovery source: one integration case passed in 94.86 seconds (95.99 s
  total), terminal exit 0. It applies the real prerequisite chains and Ops0159,
  exercises reviewed-candidate CAS, original invocation expiry, fresh-manager
  recovery, eight-reservation bound/exact replay, concurrent loser remaining
  unspent, one audit/apply, immutable invocation/audit, current denial and revoke.
  This supersedes the earlier fixture failure. It uses local Ops/Client D1 and
  synthetic external PA acknowledgment, not deployed Worker transport acceptance.
  Current Ops0159 candidate SHA-256:
  `9858a8da92f7cd96a73197eea499e8a6417aca3da3c0e61fc4062e701806a142`.
- Frozen owner sharing UI independently passed all 16 desktop/mobile browser
  cases in 6.0 seconds. This includes target-scoped authority discovery/paging,
  exact reread before recovery, uncertain identical retries, stale review denial,
  explicit revoke/reissue and access-denial clearing. Ops type-check passed.
  The standalone component remains unmounted and undeployed. Friendly recipient
  display labels remain a model gap: exact enrollment IDs are not human names.
- Latest independent owner-control cohort: three files, 33 tests passed in
  524 ms. This covers strict owner API parsing, closed dispatch envelopes and
  the staging-only HTTP boundary using unit adapters/mocks, not real D1 or
  deployed authorization. Target-scoped sharing discovery is now implemented;
  final browser reruns, useful identity/folder labels and mounting remain gates.
- The standard root release/configuration harness was independently rerun:
  125 passed in 210.67 ms. The following broad monorepo test chain was stopped
  before completion to avoid competing with the isolated database acceptance
  run; do not count it as a full-suite pass.
- The recovery draft now has immutable invocation IDs, latest-command/head/
  outbox checks and a final fresh-invoker check after asynchronous resource
  verification, immediately before private delivery. Its expanded real-D1 run
  reached reservation but failed on a noncanonical staff-revocation transition
  in the fixture. Fixture correction and rerun are pending; Ops0159 is not frozen.
- Current independent rerun: the combined Operations-home and native browser
  boundary cohort passed 62 desktop/mobile cases. Combined-shell placement is
  implemented, not just the standalone native fallback. These are mocked browser
  API tests, not live recipient enrollment or deployed folder-access evidence.
- Current root release/configuration/API harness passed all 125 tests, including
  the migration byte pins and native route/default-off configuration checks.
- Public-link and existing transport compatibility rerun passed 32 cases in five
  files. No production public link was changed by these local checks.
- The actual standalone private Ops reader class passed four local Worker RPC
  boundary cases: primitive response serialization, disabled/production/wrong-host
  denial, malformed or forged-owner inputs, and a well-formed request lacking
  current database proof. The test-only bundle does not register the export in
  the deployed Ops entrypoint or prove a positive joined grant.
- Owner folder selection/grant/revoke controls and durable current-manager
  recovery are being implemented in separate owned modules. Additive Ops0159 is
  a draft, not a tested/frozen migration. Independent review requires immutable
  invocation IDs and repeating exact latest-command/head/outbox checks at claim
  and immediately before retry; those corrections and database tests are pending.
- Client content-audit and real delivery-consumer rerun: two files, six tests
  passed in 23.90 seconds after the primary-host correction. These remain local
  D1/R2 fixtures, not deployed proof.
- Native browser desktop/mobile cohort: 14 passed; the complete Operations-home
  browser regression cohort: 48 passed (includes those native cases). Client
  type-check and production build passed. Rotating breadcrumb selectors and
  parent authority-scope changes now have explicit regression coverage.
- Independent browser boundary cohort: eight passed on desktop/mobile, rejecting
  foreign action links, raw storage-prefix DTOs and mismatched folders before
  rendering private labels/actions. A near-500-character filename stayed contained
  without horizontal page overflow and retained usable preview/download actions.
- Combined-shell placement has passed the current 62-case independent browser
  cohort above. Native delivery browsing is available beside the verified summary
  even when independent existing Client bootstrap succeeds; live staging remains
  required before treating the unified client experience as accepted.
- Standard CI now checks exact LF-only byte hashes of Ops0158 and Client0227/0228
  via `scripts/native-delivery-migration-evidence.test.mjs`. The three hash checks
  and six native route/config invariants pass. Hashes identify a tested candidate;
  they do not prove production readiness or authorize deployment.

## Resolved depth failure and remaining release gates

- The populated Operations issuer workflow reached the actual delivery command
  insert and D1 rejected its expanded authorization expression at depth 100.
  The prior Ops0158 freeze is superseded pending correction and acceptance.
  Preserve every authorization predicate, physical-folder join, CAS and atomic
  transaction while splitting/flattening the checks. Rerun populated acceptance
  and the full chain before any deployment; empty-schema success is insufficient.
  The cleaned, split schema/full-chain test subsequently passed (one case,
  43.10 seconds), and Ops type-check passed. Populated end-to-end acceptance
  is still pending; a separate persisted physical-folder fixture now exercises
  literal wildcard escaping without feeding unsupported characters to the
  application folder parser.
- Subsequent populated real-D1 acceptance passed (session 2805, one case,
  87.86 seconds): actual publication/recipient producers, delivery issuance,
  dispatch, acknowledged receipt and hot authorization reader. It checked
  wrong-person/folder/division denial, stale target/home epoch, current division
  deny, raw retarget rejection and revocation blocking proof before Client ack.
  Persisted literal `%_` physical-base containment accepted the exact selection
  and rejected the wildcard-collision sibling. This supersedes the pending
  populated-test status above; remote Worker transport and live staging remain
  unproven. The reconciled final Ops0158 SHA-256 is
  `034c830a00eab4ac259493e4af36d2eab2ab4f91883278fc1cbf578fffefb35b`,
  now enforced by the standard migration-evidence check. Do not modify that
  tested migration for the additive recovery work.
- The staging host mismatch is corrected in the native router: public delivery
  retains EXPECTED_HOST, while native HTTP requires exact primary client-staging
  CLIENT_PORTAL_ORIGIN and request origin. The complete Worker host matrix reaches
  Client Access only on that primary portal; public/secondary/unrelated origins
  deny. Internal authorization and audit configuration now require that same
  exact primary origin; authorization's 44 unit tests and Client type-check pass.
  The audit/consumer real-D1 rerun subsequently passed six cases as recorded above.
- A 104-test local cohort passes across native routes, selectors, real Worker RPC,
  public platform security and the new browser DTO transport. This is not populated
  Ops acceptance or live staging proof.
- The native browser API parser is implemented separately from PA-backed portal
  APIs. Six tests verify opaque selectors, matching same-origin action paths,
  no extra private DTO fields, explicit error status, sign-in HTML rejection,
  bounded response reads, duplicate selector rejection and exact requested folder identity. Its file-browser UI
  integration passed the browser cohort above; this parser alone is not live
  enrollment or deployed portal acceptance.
- The six route/configuration invariants now run in the standard root npm test
  command. Independent UI review identified rotating encrypted breadcrumb
  selectors as unsuitable for page identity comparisons, and requires private
  state clearing when the parent home authority scope changes. Browser acceptance
  must cover both before the UI is treated as verified.
- All 122 root source-layout, rollout-profile and API acceptance-harness tests
  pass after reviewing the exact non-secret default-off config additions and
  updating their byte pins. Explicit assertions separately retain disabled
  native flags, absent production reader/writer bindings and absent audit secret.
- Shared Ops reader export/environment registration remains unimplemented:
  the approval guard rejected it as deployment-facing shared-source expansion.
  An explicit owner checkpoint has been requested for registration with default-off
  flags and staging-only bindings; this is not a request to deploy production.
  Populated local acceptance and UI validation continue independently.

## Confirmed gap

- The Operations-native service home authorizes descriptive service labels only.
  It creates no folder permission, legacy workspace membership or financial access.
- `operations-portal-workspace-publication-outbox.ts` currently publishes zero
  recipient/delivery heads. Its folder reservations are topology, not live grants.
- `operations-portal-workspace-publications.ts` intentionally persists inert
  snapshots. Making their prefixes directly browseable would bypass explicit
  individual consent and folder authorization.
- The existing `native-portal-resources.ts` storage engine already provides
  bounded folder queries, signed handles, index/ETag checks, ranged streams,
  content-start auditing and repeated authorization before handing off bytes.
  Its current authorization depends on legacy/PA workspace membership and
  authenticated delivery grants, which the new native home does not create.

## Required connection

- Issue one independent delivery authority per exact recipient binding and
  exact folder reservation. Bind the verified issuer/subject, enrollment intent,
  target/workspace/customer identity, current home epoch/revision/receipt,
  reservation/binding revision, project/version/division and selected prefix.
- Validate current owner admission and deny-winning resource permissions at
  issuance and dispatch. Re-prove the actual `project_folders` row, base-prefix
  confirmation and containment; an old topology snapshot is not sufficient.
- Client acceptance must atomically verify the same current publication,
  recipient home and folder/resource proof before recording its authority head.
  Use exact operation replay and revision CAS; no email/name matching.
- Add an independent native authorization adapter to the existing storage
  engine, or factor its streaming implementation behind a typed authorization
  provider. Do not synthesize PA principals, memberships or broad entitlements.
- Signed folder/file handles must pin recipient/home/delivery authority,
  publication/snapshot, folder reservation/binding, relative path and file ETag.
  Recheck before index access, R2 head/get and final response handoff. Cancel
  an acquired body if permission changes before handoff.
- Individual delivery revocation must block access without waiting for workspace
  republishing. Workspace cleanup must also invalidate every descendant handle.
  Recovery reconciles exact stored commands; it must not recreate revoked grants.

## Acceptance evidence required

- Positive consent → owner confirmation → explicit folder share → folder list,
  metadata, preview, ranged download and content audit using real ledgers.
- Wrong person, customer, workspace, folder or handle fails without R2 access.
- Expired access, deny overrides, changed publication/project/folder/home/authority
  versions fail; revoke during an asynchronous lookup prevents byte handoff.
- Same-operation retry is exact; stale CAS and modified bodies are rejected;
  partial writes roll back and uncertain transport remains recoverable.
- Existing anonymous `/api/public/shares/...` routes, tokens, passwords,
  expiry, revocation, caching and resumable downloads remain unchanged.

## Scope and current evidence

- A smaller implementation agent inspected the folder path read-only; the root
  independently confirmed inert publication and the existing storage safeguards.
- The root implemented a separate `ond1_` encrypted selector module and exact
  selector-to-command comparison. Eighteen local tests and Client type-check
  passed: nonce uniqueness, key rotation, protocol separation, tampering,
  fifteen-minute expiry, unsafe paths, exact fields and all authority pins.
  Handles contain no storage prefix and are not grants. The native folder/file
  router uses them and is mounted before historical PA admission, default-off;
  no existing public or production route was changed.
- Client migration 0227 and the default-off private apply/status consumer are
  implemented locally. Three real-D1 cases now use the actual 0223–0228 forward
  schemas and publication/recipient producers, without publication/home table
  stubs. Grant and exact receipt replay, wrong-person/folder/project/snapshot
  denial, transaction rollback, retarget rejection and historical revoke after
  publication drift passed. Explicitly published archived projects remain
  eligible for an independent current delivery grant; archival is not revocation.
- The Client private read adapter pins every supported Ops proof coordinate,
  validates canonical JSON and the local command fingerprint, bounds transport
  to 1.5 seconds, and rereads the primary live head after the RPC. Its 44 local
  tests cover denial, every proof-field mutation, transport failure and races.
- The default-off authenticated native router supports discovery, paged folder
  traversal, metadata and streamed preview/download. Nineteen HTTP tests cover
  identity/origin/default-off admission, opaque DTOs, range/If-Range/HEAD/304/416,
  MIME restrictions, revocation at each media phase and body cancellation.
- Discovery now also pages beyond 25 current delivery grants with opaque,
  person/authority-pinned cursors. Cursor use requires fresh authority before
  listing and after the page lookup; discovery versus folder cursor purposes are
  checked explicitly. The expanded route/selector cohort passes 40/40, including
  modified-boundary, wrong-person and revoked-cursor denials before index access.
- Client 0228 adds a separate mandatory native content-start audit. It retains
  HMAC fingerprints rather than raw principal, prefix, key or content version;
  exact live-head/index/tombstone checks guard insert and replay. Three real-D1
  audit cases passed, including revocation, content/tombstone races and durability.
- The complete local Client cohort passed **87/87 tests in five files** and
  Client type-check passed. Its joined producer test covers the real publication,
  home, delivery and audit ledgers, encrypted discovery/list/metadata, actual R2
  full/ranged streams, missing-audit-key denial and denial after publication drift.
  The private Ops read response in this Client test is a transport stand-in;
  it does not prove the Ops physical-folder SQL joins or deployed RPC binding.
- A full ordered compatibility rehearsal previously passed across **158 Operations
  and 147 Client migrations**. The populated Ops fixture then exposed SQLite's
  expression-depth limit in the original 0158 resource guard. The unreleased
  migration was corrected by splitting the same deny-first conjunction into
  atomic current-home, current-publication and current-physical-folder guards.
  The current 0158 SHA-256 is
  `034c830a00eab4ac259493e4af36d2eab2ab4f91883278fc1cbf578fffefb35b`.
  The complete ordered Operations chain through this exact 0158 passed its schema
  guard fixture; the combined Operations/Client rehearsal must be rerun against
  this new hash before release inventory is frozen.
- Ops issuer/reader/dispatcher and its private Reader class are implemented
  locally. The populated real-D1 workflow passed through actual publication and
  native-recipient producers, delivery issue/dispatch/acknowledgment and the hot
  private reader. It also passed wrong-person/folder/division and stale target/home
  denials, a live division deny, raw historical retarget rejection, and local
  revoke denial before Client acknowledgment. An actual physical base containing
  literal `%` and `_` accepted its exact descendant and rejected a wildcard sibling.
  Final ingress/binding wiring, release inventory, CI and live staging acceptance
  remain required. No new folder authority is deployed.
- The complete Client Worker bundle now starts in a real local two-Worker RPC
  fixture. The exported private delivery grant/status entrypoint returns primitive
  JSON strings and respects both independent default-off gates. The mounted
  native HTTP path denies before historical PA admission while disabled.
  These two transport/startup tests and the 23 existing public-link regression
  tests passed together (25/25). Six route/configuration invariants also passed.
  This does not replace positive grant/download acceptance across both databases.
- Client runtime flags and generated configuration types are wired and checked;
  the new reader binding exists only in the ignored staging scaffold. Production
  retains all four new flags as false, no new reader binding, and no audit secret
  value in configuration. The current scaffold's delivery-staging host remains
  unchanged; the native client-staging host profile must be selected and verified
  before enabling reads. No remote migration or deployment has occurred.
- Native recipient UI and HTTP adapter greens do not satisfy these file-access
  acceptance requirements. Production PA checkpoint remains pending.
