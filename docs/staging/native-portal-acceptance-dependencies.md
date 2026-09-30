# Native portal acceptance dependencies

Checkpoint: September 30, 2026 (UTC). These are dependencies for the current
API-first recipient workflow, not a production activation checklist or an
attestation of client access.

## Keep the workflows separate

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

### Reviewed reservation/publication candidate (not staged)

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

### Current CI and producer boundary

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
The full native-resource suite and new exact-head CI acceptance remain separate
gates. No production guards or runtime behavior changed in these corrections.

The actual native publication producer/outbox is being implemented separately
as migration `0153`. Its untracked draft is not included in the committed
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
  Assign the next canonical migration numbers after their explicit disposition.
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

This protocol is planned, not implemented or deployed. It is required for
reliable recovery; do not describe indefinite fencing as the completed solution.

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
