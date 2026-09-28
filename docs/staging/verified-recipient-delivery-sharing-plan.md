# Verified-recipient delivery sharing plan

This is the implementation plan for connecting an explicitly enrolled
Access principal to one explicitly reviewed delivery resource in the unified
Client portal. This file does not apply a schema migration, enable a Worker
flag, perform a remote read or write, deploy software, or authorize production
use.

## Current authorization and evidence — September 28, 2026

The owner explicitly approved implementing and testing this separate,
default-off, audited recipient-to-folder sharing and revocation workflow in
staging only. The owner also authorized staging migrations and testing. This
supersedes the earlier pending implementation-authorization checkpoint, not the
exact authority, review, backup, migration, or acceptance gates below. Production
rollout and existing public-link changes remain prohibited for this work.

The separate closed command/receipt contract, guarded Client storage, Ops
outbox, and private staging-only RPC wiring are implemented locally. They are
not yet a deployed or full-lineage accepted delivery authority;
no client file access or successful end-to-end acceptance is claimed. Existing
home-only enrollment still does not authorize delivery access.

### Local implementation review checkpoint

- Revocation trace distinguishes initiation from recovery. Client revoke uses
  exact-head CAS and does not require current publication or an unexpired
  original verification timestamp. Once Ops commits the revoked head,
  tombstone and command receipt, dispatch/reconciliation uses that durable
  chain and keeps retrying despite later publication/authority loss. However,
  initiating a new Ops revoke still requires the original reviewer's current
  admission, permission/generation and future verification. Substituting a
  different reviewer fails Client's immutable owner tuple. This remains an
  unresolved revoke-initiation boundary, not complete revocation acceptance;
  changing it requires the separate reviewed approval, not an upsert bypass.
- Fresh aggregate-only Ops staging readback confirms exactly two inactive
  `directory.profile.edit` grants (global and business-area), zero activation
  receipts and zero active native admissions. All queries reported zero writes
  and `changed_db=false`. This is the preserved onboarding-profile lineage for
  schema v7/v8, not the synthetic v5 fixture's durable
  `directory.enrollment.manage` lineage. The latter cannot be relabeled as
  v4/v6 or v7/v8. Use real reviewed onboarding producers to reproduce the
  staging lineage before testing its acquisition and portal-access transition.
  A second read-only history query confirmed global profile history
  version/generation `1/1` inactive, and business-area profile history
  `1/2` inactive, `2/3` active, `3/4` inactive. These are observed per-revision
  generation pins, not inferred from an aggregate generation; no identity was
  queried or logged and no authority was provisioned.
- Draft PR 133 now contains feature checkpoint `2703d4b` and the reviewed
  configuration-invariant correction `4f349b0`. The latter adds explicit
  assertions that recipient writer/status/dispatch flags remain false and that
  production has no recipient-authority binding; it does not relax deployment
  gates. All 116 repository contract tests passed locally. Exact-head CI run
  `36492752233` finished with nine successful jobs. Operations passed 3,079
  tests but failed two configuration tests that depended on private ignored
  staging files absent from CI. Those tests now use committed templates and
  the real generator's non-secret fixtures: all three corrected tests and Ops
  typecheck passed locally. A new exact-head CI run is required.
- The canonical prerequisite test now passes three cases through all
  151 Ops and 140 Client migrations. A normal UUID organization is written via
  the real native writer, its primary PA create is acknowledged by the real
  dispatcher using synthetic PA transport, then reviewed authority artifacts
  permit secondary PA acquisition and activation via the actual producers.
  Independent QA found no fabricated positive receipt/history rows or trigger
  bypass. Activation does not infer portal permission: workspace selection is
  still denied with no selection row. This is bounded schema/prerequisite
  evidence, not real-identity verification or recipient/cutover acceptance;
  exact stored receipt-chain joins also pass. A separate clean v3/v4/v6
  fixture uses reviewed artifacts and real native/PA acquisition, activation
  and selection producers to create an inactive workspace-selection receipt.
  It creates no recipient-delivery command. All three cases passed together;
  these synthetic lineages do not substitute for actual staging v7/v8 history.
  The clean selection case additionally proves identical replay, rejection of
  a different workspace/checkpoint/activation or forged Access subject, and
  rejection after the real reviewed v6 revoke. The saved inactive selection
  remains historical; no delivery-authority command is created. The expanded
  suite passed 3/3 and Operations typecheck passed.
- Root added and passed six actual workerd named-service RPC tests without
  mocking `cloudflare:workers` or storage. The actual entrypoint module is
  bundled in-test (no prebuilt artifact dependency). Production, missing
  environment/flags, false flags and wrong-host cases remain disabled without a
  database; malformed input in the exact enabled staging case is rejected.
  Named-entrypoint HTTP access remains 404/no-store. Client typecheck passes.
  This proves transport/default-off boundaries, not a successful resource grant.
- Latest local wiring checkpoint: the named Client RPC entrypoint is now
  exported, with a private service binding only in Operations staging configs.
  Production has no new binding; writer, status and dispatch flags remain false
  in every configuration. Independent review confirmed exact staging host and
  environment gates before parsing/storage, HTTP 404, and no cron caller.
  The staging generator passed five tests and its candidate check; both apps
  passed locked-Wrangler type-generation checks and TypeScript checks. No
  remote deployment, migration apply or access activation occurred.
- After correcting the checked-in staging examples and validator fixtures,
  root reran all 104 staging preflight/evidence/recipient-window/readback-helper
  tests successfully. Both local app builds passed. Another 49 Client
  enrollment/service-home/scoped-delivery tests passed, and the canonical
  bootstrap/native authority-packet checks passed 56 tests with four explicit
  Windows symlink skips and no failures. These results do not establish a
  positive full-lineage recipient grant or live browser acceptance.
- Both apps' dependencies were restored from their existing npm lockfiles
  after an incidental pnpm reconciliation; tracked manifests and lockfiles
  remain unchanged. Root reran 33 public-link/private-RPC tests successfully.
  The minimal joined rerun initially exposed four fixture failures after the
  stricter staging gate. Adding the required staging identity to those test
  environments, without changing the gates, restored all 12 joined tests;
  Ops joined/config/ledger passed 29/29, and Client boundary/resource suites
  passed 23/23 on restored npm dependencies. The complete canonical-lineage
  prerequisite test also passed: all 151 Ops/140 Client migrations are ledgered,
  ungoverned customer insertion is denied, reviewed v3 provision/revoke and v5
  fixture provision commit, and the real native fixture writer creates the
  customer. The earlier v5 rejection was a missing active synthetic business
  area, not missing onboarding lineage. This establishes governed customer
  acquisition only, not selection, home/enrollment grants or recipient delivery.
  Read-only remote migration inventories showed only Ops 0151 and Client 0221
  pending. The release remains unfinalized; these local results do not create a
  production PA update checkpoint.
- Independent review found incompatible native-owner identity, numeric
  generation, access-term expiry, and expected/resulting revision semantics in
  the initial parser. Those are corrected, with explicit package exports,
  native reason-code parity, canonicalized receipts, and no active allows in
  revoke receipts. An independent focused run passed 27 tests, including
  package resolution and hostile-object rejection. This is contract evidence,
  not runtime authority or live access evidence.
- The staging-only readback helper passed an independent local run of 36 tests,
  including execution of every bound query against the complete canonical
  150-migration Operations schema. It has not queried staging or provisioned
  authority. The artifact records the capture interval and explicitly declares
  a non-atomic snapshot. Its readiness output is only preflight evidence, not
  permission to activate an identity or share data; provisioning must recheck
  the live state. An inactive referenced business area fails readiness.
  It requires reviewed per-revision generation inputs, rejects uncancelled
  issued/pending invitations as in-flight work, and labels remote ledger-name
  checks separately from local SQL hashes. Independent review cleared this
  helper for read-only staging capture, not provisioning or activation.
- The audited storage/outbox, exact Client acknowledgement and current-identity
  resource checks are implemented and covered by focused local tests, not live
  acceptance. Remaining integration includes the canonical portal-authority
  lineage, the reviewed API-v2 directory projection/source-authority adapter,
  coupled revocation and owner UI acceptance, and live staging verification.
  Pending authorization-boundary decisions remain prerequisites; no production
  rollout is ready.

### Independent enrollment and home-grant pins

Code/schema review identified that Operations enrollment intent revisions and
Client home-grant revisions are distinct counters. The separate command now
requires `homeAuthority.ownershipEpoch`, `homeAuthority.grantRevision`, and
`homeAuthority.grantOperationId`; none is inferred from the enrollment revision.
The producer must pin the intent's acknowledged protocol-v3 home grant receipt.
The consumer must independently join that exact current home head, audit, and
receipt, plus the active resource head. The home permission remains a necessary
enrollment prerequisite, never a file-access permission by itself.

`selection.selectionId` is also the exact Client workspace binding operation ID,
as proven by the existing Operations selection/outbox/receipt lineage.
`resource.currentGenerationId` is the Client directory checkpoint's active
generation ID, not a folder source version or a Project Alpha history epoch.
These definitions must be checked against actual durable rows by both writers;
parser success is not evidence of current authorization.

### Storage review and native publication decision

The additive Operations `0151` and Client `0221` implementations are under
review and are not frozen, applied, or deployed. Focused parser evidence is now
33 passing tests, with Operations type-check passing; that does not attest the
new SQL, outbox, or runtime helpers.

The unexported private RPC boundary now has nine passing isolated unit tests
for default-off behavior, hostile/extra input rejection, exact receipt checking,
full-command read-only recovery, restrictive revoke receipts, sanitized errors
and HTTP denial, including hostile thrown-error objects. These tests mock storage; they do not prove D1 writes or live
authorization. The helper's closed receipt types and D1 session parameters
have been aligned; root independently verified Client type-check success.
Neither the ingress nor a service binding has been added to deployed
configuration. After crash recovery, root reran 33 contract tests, 44
recipient-consent/service-home tests, nine private-RPC tests, and 63 staging
evidence/preflight tests successfully; Client type-check also passed. These are local boundary
tests, not joined resource-storage or live recipient acceptance.

The Client helper's seven earlier Miniflare tests passed, but review found
unresolved transactional proof, renewal and independent-reviewer revoke
requirements. The legacy native grant/event dependency and original-reviewer
revoke restriction remain intact after the safety guard rejected changing
those boundaries. Explicit owner confirmation was requested; no workaround
or retry of the rejected changes is authorized by this document. Restrictive
proof-fence and renewal work continues separately.

The canonical inventories require 140 Client and 151 Operations migrations.
Reviewed SQL bytes are now pinned for the local complete-chain rehearsal:
Client `0221` SHA-256 is
`e497bfc54715248429817a674d8bf68443e69e0da80cbc3935887dac32e6e03f`;
Ops `0151` SHA-256 is
`02334ce63836b054370adda21722c629e848074467baf3912156ca53c38732a9`.
Canonical chain content hashes are respectively
`ab2727c3d4520f1bb8fc59195b0e74ffd9eeb965eff8fdfa198bbaecbebb13e1` and
`c9ca6374a7470a94e7cd3ec9aa047f38a6e841607840f2f8323325013178f9c2`.
Any further SQL edit invalidates this evidence and requires renewed review,
fingerprints and tests. `RELEASE_CONTRACT_FINALIZED` remains false.
Older 139/150-migration evidence cannot attest the changed schema.
No new remote migration, Worker export, service binding or access activation
is claimed.

### Recovered database acceptance and remaining corrections

- The Client-focused Miniflare suite passed ten tests after transactional
  create/renewal fences, root-policy and owner-expiry checks, and mutable-proof
  CAS renewal were added. This includes a real storage-backed private RPC
  apply/status/replay/drift/revoke round trip; only the platform entrypoint
  base class is shimmed. It is not a complete-chain or live acceptance run.
- Independent review then found that a renewal can retain the old immutable
  head target while recording a command/receipt naming another target. The
  update currently compares only authority/revision/state; the audit guard
  correlates only operation/revision/state. Passing those ten tests does not
  clear this mismatch. Add immutable-target CAS predicates, permanent-folder
  target guards, complete command-to-head audit correlation, and negative
  helper/direct-SQL tests before freezing Client migration `0221`.
- That Client correction is now implemented: renewal compares the complete
  immutable target, SQL prevents permanent folder/source/project retargeting,
  and audit JSON plus its Client-record metadata correlate with the post-CAS
  head. Independent QA reran 13 Miniflare tests successfully, including
  mismatched-target and forged-audit atomic rollback. This supersedes the
  specific target/correlation gap above, not the separate pending legacy
  publication and independent-revoker boundaries or full-chain/live gates.
- The Ops-focused atomic enqueue suite currently fails four of six tests with
  SQLite's expression-depth error. The owner separately approved splitting
  oversized `0151` authorization triggers into smaller independently enforced
  guards, preserving every predicate and the atomic `D1.batch` transaction.
  This permits that structural fix only; it does not authorize sequential
  production writes, weakened guards, or the other pending Client boundaries.
- The approved structural split subsequently passed eight Ops Miniflare tests
  and type-check, with independent review confirming exact receipt scopes,
  deny-first revoke retries, and the enrollment drain fence. Root then found an
  uncovered lease-recovery contradiction: a same-state control guard rejects
  the expired `dispatching` claim replacement that dispatch explicitly supports.
  The narrow expired-lease correction subsequently passed ten focused Ops
  Miniflare tests and type-check: a reclaim requires an expired prior lease,
  a new token, a future deadline and exactly one attempt increment, preserving
  acknowledgement/error/schedule fields. Live-lease tampering remains denied.
  Independent review then found that dispatch checks freshness before reading
  an exact historical Client receipt. A lost response followed by proof expiry
  can therefore dead-letter an already committed write. Receipt-first recovery
  is now corrected and independently reviewed: exact historical receipts may
  acknowledge; definitive `not_found` still gates fresh proof before new apply;
  unavailable, malformed or mismatched status retries without apply. The Ops
  suite passed 14 tests, independently rerun, and type-check passed.
- Minimal synthetic joined protocol acceptance passed 12 tests using two real
  Miniflare D1 databases, actual `0151`/`0221`, real Ops enqueue/dispatch and
  Client apply/status helpers. Only the platform entrypoint base is shimmed.
  Exact receipts, replay, lost responses, stale-proof historical recovery,
  revoke acknowledgment/drain and wrong-recipient/folder denial are covered.
  These reduced fixtures are not a populated canonical-schema or live test.
- Root's complete local migration rehearsal passed: both reviewed 140/151
  chains apply to empty databases, repeat idempotently and satisfy foreign-key
  checks. Root's separate release-default/evidence/preflight run passed 97 tests.
  A stale packet test expectation of 150 migrations was corrected to 151;
  the full bootstrap/authority-packet rerun passed 56 tests with four Windows
  symlink-creation cases explicitly skipped (`EPERM`), zero failures. This
  does not attest those skipped cases. No guard was removed.
- Live staging, populated canonical workflow acceptance, data-plane activation,
  UI and remaining authority/source-freshness decisions are still required.
  No resource path is active because of these local results.

- Permit multiple independently reviewed folders under a workspace selection,
  but at most one active resource authority per recipient binding and folder.
  A selection-global unique constraint is incorrect, as is allowing a second
  active authority to survive a single-folder revoke. Preserve revoked history.
- Store the selected Operations Client record ID in immutable Client authority
  evidence even though Client cannot independently resolve that Directory
  record. Revoke and status correlation must preserve the exact target.
- Command-to-head and head-to-receipt database guards must compare the complete
  immutable target, home-grant pins, resource proof, terms, revisions, and
  capability/scope names—not only a proof hash or JSON array length.
- An exact immutable receipt replay precedes freshness checks. A new allow
  requires a current owner proof. A committed restrictive revoke may finish
  after the original review expires, using the exact active head and trusted
  private ingress. A new revoking reviewer need not be the creating reviewer;
  creation evidence stays immutable and the revoke actor is separately audited.
- For a secondary/native folder, the new exact resource authority is the
  explicit recipient-publication decision. Validate its immutable native
  routing, active source authority and active revision, current workspace,
  folder, project/source version and directory generation, plus Operations'
  current resource-scoped share permissions. Do not depend on any old
  `portal_native_staff_grants` recipient or published event. Such a grant is
  PA-principal-specific and cannot supply authority for this new recipient.
- Completing a full enrollment revoke requires exact Client acknowledgments
  for every resource revoke, not just revoked Operations heads or queued work.
  Report pending reconciliation honestly until those acknowledgments exist.

The new canonical migrations also require updated complete-chain inventory
counts, names/content digests, fixtures and readback gates after SQL freeze.
The earlier 150-migration staging readback does not attest migration `0151`.

### Data-plane integration gate

Control-plane storage does not grant file access. Add a separate exact
signed-session activation POST outside the legacy PA-backed router's accepted
identity middleware, following the existing independently mounted enrollment
and service-home routes. Do not add a blanket exception to legacy portal routes:
this separate route must verify its own signed principal and exact current
resource authority before materializing any access. Derive issuer,
subject and verified email from that same signed principal; do not search by
email. GET status remains read-only.

Keep existing claimed-workspace fences intact for all legacy and PA-derived
paths. A parallel verified-recipient resolver must require the current exact
home head and receipt, active resource head, identity and membership, current
denies, folder/source generation, publication authority and access terms.
Workspace lists must include claimed workspaces only through that resolver.
File listing, metadata, preview and download must repeat the live resource
proof, including immediately before R2 access. Stale derived membership or
entitlement rows alone never authorize. Directory hierarchy, service requests,
feedback, team management, delegated shares and Viewer remain separately
gated; the two minimum delivery capabilities do not enable those features.

### API-first source freshness and retirement gate

Source inspection confirms that the existing secondary availability metadata
in `pa_portal_source_authorities` and its revision table was provisioned for the
old connector-purpose portal projection. The new verified-recipient writer
does not read HMAC credentials or create a PA principal, but validating these
existing rows is not proof that the API-first projection replacement is ready.
Migration `0214` defines a dormant staging catalog with explicit source instance,
application and history-epoch identities; that catalog alone is not an active
directory/project projection writer.

Current code review confirms the narrower scope: the Operations
`stageConfiguredProjectAlphaCatalogSnapshot` coordinator reads generic catalog
inventory, and Client `promoteOpsInventoryCatalogSnapshot` promotes it into
`pa_service_catalog_*` rows. Neither function replaces the workspace directory
generation writer or `pa_portal_source_authorities` availability producer.
Reusing catalog readiness as a substitute for that replacement would leave
the old custom integration dependency in the requested final architecture.

The existing projection writer's storage logic is reusable, but its producer
authorization is not an API-first proof. In
`project-alpha-portal-authority.ts`, primary writes are fenced by reserved HMAC
key fingerprints; secondary writes are fenced by connector revision/version.
The replacement must provide a separately reviewed Operations-owned source
proof, pinning the selected API source instance, application and history epoch
plus current explicit workspace ownership. Do not manufacture a signing-key
proof from an API token or leave the old connector permanently enrolled merely
to satisfy those fences. Preserve transactional generation/checkpoint and
entity invariants when introducing the new proof path.

Generic API inventory is paginated observation, not an automatically atomic
snapshot. The adapter must bound page/profile reads, pin authorization
generation and source identity across them, verify each project's revision and
projection hash, and refuse incomplete, stale or mixed-identity activation.
Promote only an explicitly selected workspace/root and mapped projects; do
not infer workspace ownership, membership or portal sharing from the inventory.
Record replay/CAS lineage and test source suspension, epoch/application change,
partial pages and races before retiring either old producer.

Before coordinated production authority cutover and legacy retirement, verify
that current Client directory/project generations and availability are driven
by the generic API-first source identity and current Operations ownership.
Preserve explicit existing workspace/folder mappings and historical receipts;
do not infer identity or ownership from names, email, source labels or old
signing keys. Do not retire the producer and merely leave an indefinitely stale
projection as the permanent replacement. Retain public-link behavior without
restoring legacy enrollment authority. Source suspension, history-epoch change,
new API application identity and generation drift need acceptance coverage on
both business instances. Until this is verified, recipient-sharing tests prove
only that separate workflow, not complete removal of custom integration.

## Current boundary and evidence

Recipient enrollment currently produces only descriptive Operations service
home access:

- `apps/operations/src/worker/client-portal-recipient-enrollment-ledger.ts`
  records the exact Access issuer and subject in
  `client_onboarding_recipient_identity_bindings` and enqueues protocol v3 with
  exactly `operations.service_home.read`. Its revoke command sends an empty
  permission set.
- `apps/client/src/worker/client-portal-authority-v2.ts` accepts protocol-v3
  permissions only as `[]` or `["operations.service_home.read"]`.
- `apps/client/migrations/0220_operations_portal_authority_v3_permissions.sql`
  and `apps/operations/migrations/0147_client_portal_authority_v3_permissions.sql`
  preserve the same closed permission vocabulary in storage.
- `apps/client/src/worker/client-portal/operations-service-home.ts` requires the
  exact active v3 grant and reads only service metadata.
- `apps/client/src/worker/client-portal/operations-home-routes.ts` documents that
  the endpoint grants no resource access.

The delivery data plane already exists and should be reused:

- `apps/client/src/worker/client-portal/workspace-v2.ts` resolves a native
  workspace only from an exact active identity and workspace membership. The
  shell requires `workspace.view`; delivery targets require `delivery.view` and
  honor current denies, scope ancestry, source generations, and access terms.
- `apps/client/src/worker/client-portal/authenticated-delivery-grants.ts` reads
  current folder grants and exact recipient snapshots. Existing staff grants
  provide retention evidence but do not independently grant directory access.
- `apps/client/src/worker/client-portal/native-portal-resources.ts` lists the
  authorized folders and files, uses opaque handles, and repeats current
  context, grant, indexed-object, and R2 metadata checks before returning file
  bytes.
- `apps/client/src/client/native-portal-api.ts` and
  `apps/client/src/client/ClientPortalApp.tsx` already provide the native
  Deliveries browser, preview/download paths, workspace switching, and Viewer
  handoff for an authorized native workspace.
- `apps/client/src/client/PortalBootstrapApp.tsx` and
  `apps/client/src/client/OperationsHomeApp.tsx` already preserve the home-only
  experience when Client workspace resources are unavailable.

Operations already has an explicit folder-sharing workflow:

- `apps/operations/src/worker/native-delivery-bindings.ts` performs exact
  source/workspace/project/folder review, authorization proofs, access-term
  validation, idempotent grant creation, publication, and revocation.
- `apps/operations/src/worker/native-delivery-binding-routes.ts` mounts its
  staff-authenticated and mutation-protected HTTP routes.
- `apps/operations/src/client/NativeDeliveryGrantPanel.tsx` presents the exact
  project, recipient, folder, duration, preview, retry, and revoke workflow. It
  states that no public link or notification is created.

## The concrete mismatch

The existing authenticated delivery exact-recipient contract is Project Alpha
principal-specific, not a generic verified-identity contract:

- `apps/operations/src/worker/native-delivery-bindings.ts` searches
  `pa_portal_principals`, requires its current source version, and writes a
  `portal_v2_authenticated_delivery_grant_recipients` snapshot.
- `apps/operations/src/worker/authenticated-delivery-grants.ts` has the same PA
  principal, membership, entitlement, and exact-recipient requirements for its
  primary grant path.
- `apps/client/migrations/0125_project_alpha_portal_projection.sql` defines a
  PA principal as source-published intent whose identity binding must be
  explicit; an email hint is not authority.
- `apps/client/migrations/0137_authenticated_delivery_grants.sql` restricts an
  exact recipient row to a `(workspace_id, principal_public_id)` foreign key in
  `pa_portal_principals`.
- `apps/client/src/worker/client-portal/authenticated-delivery-grants.ts`
  rejects a principal grant when that current PA principal row and source
  version are absent.

Recipient enrollment deliberately stores only the exact Access issuer and
subject. `apps/client/src/worker/client-portal/recipient-enrollment-http.ts`
does not send browser-provided identity fields or email through its private
bridge, and
`apps/operations/src/worker/client-portal-recipient-enrollment-entrypoint.ts`
accepts only the exact issuer and subject from the signed Access proof. The
current flow creates no `portal_v2_identities` row, workspace membership,
entitlement, PA principal, or delivery grant.

Therefore the existing delivery grant API cannot safely grant an enrolled
recipient access as-is. It would be incorrect to:

- infer delivery access from `operations.service_home.read`;
- infer that a customer or client contact may see a delivery;
- bind an enrolled subject to a PA principal by name or email;
- synthesize a PA principal for Operations-owned enrollment;
- use automatic Project Alpha email eligibility as a fallback; or
- replace authenticated access with a public link.

## Proposed separate default-off authority

Add a distinct verified-recipient delivery resource authority. Do not extend
the home protocol-v3 permission vocabulary.

The Operations command must pin all of the following:

- one active `client_onboarding_recipient_identity_bindings.binding_id`;
- the exact Access issuer and subject recorded by that binding;
- the exact recipient-enrollment intent and active revision;
- the exact workspace selection, Client record, Client authority, and native
  workspace;
- one exact active native folder binding, its binding/source version, and its
  exact project owner and current source generation;
- the independently authorized owner, admission/profile versions, Directory
  grant generation, and resource-scoped portal-management authority;
- reviewed customer/collaborator access terms, expiry policy, reason, and
  optimistic resource-authority revision; and
- a unique idempotency operation and immutable audit/receipt lineage.

The command must reject a selection/workspace/client mismatch, a folder outside
that workspace, a stale binding or project version, a different Access subject,
an expired or revoking enrollment, additional browser-supplied permissions,
and ambiguous or replayed bytes under a different operation.

Use a separately named, default-off Operations-to-Client service-binding
method and status receipt, following the durable outbox/CAS/readback pattern in
`apps/operations/src/worker/client-portal-authority-v2-outbox.ts` and
`apps/client/src/worker/client-portal-authority-v2-entrypoint.ts`. Sharing an
implementation helper is acceptable; sharing the home v3 protocol or its
permission column is not.

Client storage should use a parallel exact verified-recipient resource grant
or another explicitly reviewed schema that does not weaken or reinterpret the
PA-principal foreign keys in migration 0137. Its active read proof must bind:

- resource-authority ID and revision;
- issuer, subject, Client identity ID, and native workspace membership;
- exact folder binding and source version;
- grant version, state, access terms, and expiry;
- exact primary binding receipt or the separate native recipient-publication
  authority described above; and
- the current source/workspace authority and applicable deny state.

The Client projection may use existing `portal_v2_identities`,
`portal_v2_workspace_memberships`, and `portal_v2_entitlements`, whose existing
`operations` source type can represent this origin. The minimum capabilities
are:

- `workspace.view` on only the exact workspace, so the unified portal shell can
  open it; and
- `delivery.view` on only the selected folder.

Do not add `directory.read`, `request.create`, `member.manage`,
`delegated_share.create`, `viewer.share.create`, or any workspace-wide or
other-folder delivery allow.

Because enrollment intentionally does not transport email, identity
materialization should occur only in a current signed Client session. A new
idempotent Client activation POST can match the pre-approved resource authority
by exact issuer and subject, take the verified email only from that same signed
principal, and create or reactivate the existing identity, Operations-sourced
membership, and exact entitlements. It must not search by email. A read-only
status endpoint can let the home-only page show a deliberate **Open shared
delivery** action; no mutation should be hidden in a GET.

## Owner and Client website work

The smallest owner experience is an enrolled-recipient mode alongside the
existing native folder grant panel. It should reuse the existing folder,
project, terms, preview, idempotency, uncertain-result, and revoke controls,
but source recipients only from active exact enrollment bindings constrained
to the selected workspace. The confirmation must show the exact Client,
workspace, project, folder, issuer, subject, access duration, and the statement
that no public link is created.

Likely implementation touch points under the staging-only authorization
recorded above are:

- `apps/operations/src/worker/native-delivery-bindings.ts`
- `apps/operations/src/worker/native-delivery-binding-routes.ts`
- `apps/operations/src/client/NativeDeliveryGrantPanel.tsx`
- `apps/operations/src/worker/client-portal-recipient-enrollment-ledger.ts`
- `apps/operations/src/worker/client-portal-recipient-enrollment-owner-http.ts`
- `apps/operations/src/client/ClientPortalRecipientEnrollment.tsx`
- `apps/operations/src/worker/types.ts` and the relevant Wrangler service
  binding only after configuration review
- a new shared resource-authority contract and the next available, separately
  reviewed Operations and Client migrations
- a new Client private ingress/projector adjacent to
  `client-portal-authority-v2-entrypoint.ts`
- `apps/client/src/worker/client-portal/workspace-v2.ts`
- `apps/client/src/worker/client-portal/authenticated-delivery-grants.ts`
- `apps/client/src/worker/client-portal/routes.ts`
- `apps/client/src/client/PortalBootstrapApp.tsx`
- `apps/client/src/client/OperationsHomeApp.tsx`

Once activation produces the exact workspace and folder authority, the current
native Deliveries UI can be reused. File metadata, preview and download must
use the new parallel live-authority resolver. Viewer access requires its own
explicit authorization and is not implied by these delivery grants.

## Full-revoke coupling

The current owner button says **Revoke all portal access**, but the current
ledger revokes only the home protocol-v3 grant and then closes the Operations
recipient binding. That remains accurate only while no resource authority
exists.

Before verified-recipient delivery sharing can ship, full enrollment revoke
must become deny-first and receipt-coupled:

1. Record the exact revoke-all operation against the active enrollment
   revision.
2. Send a Client resource-authority revocation that immediately changes the
   authority head used by every delivery read from active to revoked.
3. Tombstone or revoke every derived verified-recipient folder grant and its
   `delivery.view` entitlement.
4. Revoke the workspace shell entitlement and Operations-sourced membership
   only when no other independently reviewed active resource authority still
   requires them.
5. Revoke the home v3 authority.
6. Finalize the Operations recipient binding only after exact Client resource
   and home receipts are current and acknowledged.

Physical cleanup may be eventual, but stale membership, entitlement, grant, or
publication rows must not authorize because all data-plane reads also require
the active resource-authority head. Revoking one folder must preserve other
independently reviewed folder grants. Full enrollment revoke must remove all
derived resource authorities for that binding without removing unrelated
identity authority.

## Acceptance requirements

Add focused Operations unit/route/browser coverage adjacent to:

- `apps/operations/test/native-delivery-bindings.test.ts`
- `apps/operations/test/browser/native-delivery-grants.spec.ts`
- `apps/operations/test/client-portal-recipient-enrollment-ledger.test.ts`
- `apps/operations/test/client-portal-recipient-enrollment-owner-http.test.ts`
- a new joined recipient-delivery acceptance test covering both databases and
  the private receipt round trip

Add Client projection, authorization, resource, and UI coverage adjacent to:

- `apps/client/test/workspace-v2.test.ts`
- `apps/client/test/authenticated-delivery-grants.test.ts`
- `apps/client/test/authenticated-delivery-resources.test.ts`
- `apps/client/test/client-portal-ui.test.ts`
- `apps/client/test/browser/native-portal.spec.ts`

The acceptance suite must prove:

- home-only enrollment exposes service labels but no Client workspace, folder,
  file, Viewer model, or R2 bytes;
- a different issuer/subject, Client record, selection, workspace, project,
  folder, binding/source version, grant revision, or receipt is rejected;
- no PA principal, name, email, contact, or customer-status fallback is used;
- exact activation produces only the selected workspace shell and folder;
- sibling folders, other projects, directory hierarchy, requests, team
  management, delegated shares, and Viewer share creation remain denied;
- stale generation, expired terms, deny rows, suspended membership, revoked
  enrollment, revoked resource authority, and publication drift fail before an
  R2 operation;
- ambiguous create/revoke results replay only identical operation bytes and
  require exact status receipts;
- folder revoke preserves independent access while full enrollment revoke
  denies every derived folder and preserves unrelated identity authority; and
- default-off flags and missing schemas/bindings fail closed without changing
  the current home-only experience.

## Public-link invariance

This work must not change anonymous delivery paths, delegated shares, Viewer
public shares, their URLs or cookies, or their permission gates. In particular,
do not alter the behavior covered by:

- `apps/client/test/public-share-routes.test.ts`
- `apps/client/test/public-share-lifecycle.test.ts`
- `apps/client/test/client-delegated-shares.test.ts`
- `apps/client/test/browser/public-delivery.spec.ts`
- `apps/operations/test/viewer-public-share-routes.test.ts`

Authenticated verified-recipient delivery sharing creates no public link. A
public link remains a separate explicit product with separate permissions and
lifecycle.

## Authorization checkpoint

No implementation should begin from this plan alone. The owner's separate
staging-only implementation and testing approval is recorded above. Keep the
resource-authority contract, additive migration approach, default-off flags,
private service binding, signed-session activation, and full-revoke ordering
explicitly reviewed. Obtain fresh private backups and exact schema/source
readback before staging application; keep live test windows narrowly scoped
and close them through the governed revoke procedure. Production authorization
is not included.
