# Directory authority migration: writer inventory and cutover gates

Local implementation checkpoint, September 10, 2026. This supplements M04 in
[the migration plan](api-first-migration-plan.md). It does not enable managed
mode or change either production PA instance.

## Ownership boundary

- Operations owns shared people, organizations, customer organizational units,
  their relationships, addresses, service enrollment and portal membership.
- PA remains independently usable. Optional **Externally managed directory**
  belongs to an explicitly selected application identity, not a token value.
  Enable only after administrator confirmation and proof of a usable,
  authorized, implemented directory writer. A catalog entry or a capabilities
  response alone is not proof of working writes.
- Revoking the final writer credential must not silently unlock local editing.
  Show disconnected management and require an explicit administrator transfer
  or return-to-local action. Token rotation keeps management identity intact.
- PA owns financial-only provider bindings, issued-document snapshots and tax
  documents. Disabling shared-directory edits must not stop payment accounting,
  receipts or authorized financial-document management.
- Customer hierarchy, bill-to entity, staff division and portal visibility are
  separate relationships. A department label is not proof of a billing entity
  or a permission grant. Never merge records by names or email addresses.

## Confirmed PA writer paths

Paths below are relative to the Project Alpha repository. Inventory is source
evidence, not proof that all paths are guarded or every writer has been found.

| Path | Shared write / required treatment |
| --- | --- |
| `src/controllers/client/clients_create.php` | Client and reusable address creation. Enforce managed ownership before mutation. |
| `src/controllers/client/clients_update.php` | Profile and billing address. Local patch places both inside the projection transaction; do not leave address writes after commit. |
| `src/controllers/client/clients_delete.php`, `clients_purge.php`, `clients_restore.php` | Archive/delete/purge/restore are writes, not a read-only-mode escape. Preserve external IDs, history and revocations. |
| `src/services/ClientArchivePortalStateService.php` | Physical restoration in `restoreLockedRow`; guarding only a form is insufficient. |
| `src/controllers/organization/organizations_create.php`, `org_create.php` | Full and quick-create entry points both create shared organizations. |
| `src/controllers/organization/organizations_update.php` | Local candidate now edits only shared profile/address under the ownership guard; private notes and tax-file forms use separate handlers. Authenticated HTTP and all other writers still gate activation. |
| `src/controllers/organization/organizations_delete.php` | Destructive shared mutation; retain dependency/history protections. |
| `src/controllers/organization/organization_add_client.php`, `organization_remove_client.php` | Organization membership changes are shared-directory writes. |
| `src/controllers/organization/organization_departments.php` | Department CRUD, contact assignments and relationship changes require the same owner check. |
| `src/controllers/client/client_onboarding_review.php` | Can create, update and enrich multiple people/organizations plus addresses. Route through the canonical owner; do not bypass using the onboarding approval path. |
| `src/utils/address_book.php` | `address_book_save` updates address and assignment/default rows. It does not own a transaction; the domain service must supply one. Classify entity and purpose instead of globally blocking financial/project addresses. |
| `src/services/PaymentProcessorImportService.php` | `matchOrCreateClient` and `enrichClient` can create/enrich directory records during payment import. In managed mode, queue a review/canonical lookup instead of silently writing; retain the payment/import record. |
| `src/utils/stripe_reconciliation_import.php`, `src/controllers/webhook/stripe_payment_succeeded.php` | Reach processor-import creation/enrichment without the normal client forms. |

Additional mixed paths needing explicit separation include organization internal
notes, tax-document upload/removal, Stripe customer-ID bindings and shared
addresses referenced by financial documents. Existing provider ID writes are
not authority to alter shared customer contact information. The initial inventory
must be extended with tests and call-site searches before activating enforcement.

### September 14 PA managed-directory writer audit

The first PA writer review found shared-directory mutation paths without
`DirectoryManagementPolicyService::assertLocalWriteAllowed`. Managed mode
must remain disabled until every path is fenced and tested:

- `client_onboarding_review.php`: approval can create or update clients,
  organizations and addresses. Check the policy inside its transaction, after
  validating the submission and before match discovery or projection locks.
  Apply the check only to **approval**; rejection changes only onboarding
  state and must remain available while the directory is externally managed.
- `organization_add_client.php` and `organization_remove_client.php`: check
  policy in the shared mutation transaction before `lockedClientScopes`.
- `organization_departments.php`: guard its hierarchy/contact transaction.
  Its created-link transition also writes `organizations` after that
  transaction; move that write into the guarded transaction or give it an
  equivalent transaction-scoped guard. A guard on the main handler alone is
  insufficient.

The local PA working tree now fences approval-only onboarding, organization
membership attach/detach, and department/contact writes. Membership updates
hold the policy lock through projection scope locking and the client update;
both attach and detach reject a stale organization precondition. The first-
department `link_strategy` change moved into the same policy-locked
transaction as department creation, leaving only resolver-link generation
after commit.

Standalone payment import now separates the financial payment from optional
client matching/creation/enrichment. In managed mode it retains the payment
and payer provenance with no client match; in local mode the policy is locked
through the client mutation. A missing policy schema fails closed for that
optional matching path, so the migration must precede code activation for
installations that rely on automatic standalone-client creation. The import
now owns one transaction around ledger claim, existing-payment check, optional
client action, payment insert and ledger link; duplicate insertion re-reads
the existing payment. Schema setup refuses an already-active caller transaction
so MySQL DDL cannot silently commit that caller's work. Verify the provider
payment uniqueness migration before relying on this in production. Lazy schema
setup outside a transaction, concurrent email-based client creation, and a
real two-connection MySQL race remain follow-up acceptance risks.

Directory initialization capabilities were added to PA's exact-scope catalog;
legacy full keys still do not inherit them. The focused initialization,
policy/onboarding, organization membership/department and payment-import
selection passed 31 tests / 381 assertions before the later import atomicity
change; its separate processor-import suite passed 14 tests / 139 assertions.
The added scope-policy regression now checks both initialization capabilities
remain unavailable to legacy full/read and unrelated exact writer/binder keys;
the initialization/scope selection passes 17 tests / 203 assertions. The
initialization service is exposed only by the new unreleased authenticated
HTTP routes below; it is not enabled as an Operations bootstrap workflow.
The local PA candidate now includes exact-scoped, source/history/application-
fenced GET readiness preview and POST initialization command routes. The preview
returns only identity, canonical profile hash and advisory state; the command
uses that hash only as an optimistic input, repeating all authority/fence checks
in a transaction and seeding only directory version state. The focused preview
service/dispatcher selection passes 12 tests / 131 assertions; the separate
command route selection passes 4 tests / 36 assertions including seed, replay,
conflict, stale source, transport, legacy-scope denial and rejection-audit
failure. A regression confirms that an exact replay after a later supported
edit returns a historical receipt, not a current-state claim; a fresh command
must pass the current profile-hash check. Joined HTTP/MySQL,
MySQL rejection-audit fault, populated bootstrap and Ops acquisition/binding acceptance
remain open. Neither route is a cutover proof.
The disposable no-database front-controller selection now reaches the source
gate for both initialization resource types and verifies default-off behavior,
no cookies and `no-store` responses: 5 tests / 42 assertions. This does not
replace joined HTTP/MySQL or populated-data acceptance.
Fresh installations intentionally apply the immutable 0.5.0 baseline and then
all forward migrations before web startup: `docker/migrate.sh` invokes
`run_migrations.php`, while Compose holds web behind successful migration.
Migrations 0097/0098 add the history-epoch tables and receipt column. The
99 migration files validate locally; a fresh disposable baseline-plus-migrations
HTTP/MySQL route rehearsal is still missing. Do not patch the immutable baseline
to duplicate those forward migrations.
The existing disposable directory HTTP/MySQL test now includes an unreleased
existing-organization readiness/initialize/current-read/historical-replay case
with source, application and epoch denials and a stale fresh-command conflict.
It passes PHP syntax validation but is skipped
without the isolated MySQL sentinel and was not run against MySQL in this
workspace; it is executable acceptance work, not acceptance evidence yet.
An isolated Operations PA initialization transport candidate now preflights
the exact readiness and command endpoints/capabilities, bounds and validates
responses, pins source/application/history identities, and sends only the
three-field command. It is deliberately unwired: no workflow, persistence,
managed authority or retry dispatcher invokes it. The first draft was corrected
to PA's actual uppercase readiness states, nullable revision and HTTP 200
fresh/replay response. The missing Operations dependencies were restored locally
from the existing lockfile without a package or lockfile change, and the
Operations `tsc --noEmit` check passes. Focused Vitest runs with approved
ancestor-directory access in this Windows nested worktree; these unit results
are not joined runtime acceptance.
An isolated Operations existing-record directory binding transport candidate
now preflights the exact client/organization binding capability and endpoint,
pins the expected source/application/history epoch, sends only the four-field
command, and verifies a bounded receipt against the requested kind, external
ID, permanent PA ID and revision. Its focused unit selection passed 7 tests
in the agent's local run and TypeScript type-check passed. It remains unwired:
the content guard is not durable binding evidence, nor proof of current PA
authority or revision. In particular, a historical replay needs a fresh
authorized directory GET before acquisition can proceed. No automatic match,
create, bind, profile overwrite, or production credential change is enabled.
An additional read-only Operations candidate verifier now accepts an explicit
PA public ID, checks advisory readiness and (only for an already-initialized
record) performs a current authorized directory read. It returns identity,
profile-hash and revision evidence without customer data; changed revisions,
reconciliation and transport uncertainty cannot produce an accepted candidate.
Its focused four-case unit selection passes after correcting endpoint metadata
and failure fixtures. A default-off, same-origin native staff POST route now
exposes this read-only verifier when explicitly enabled. It requires an
explicitly selected local canonical record, current view/edit/identity-link
grants, CSRF and admission, and a matching server-owned PA destination. It
rechecks these conditions after the remote response and returns only bounded
candidate evidence. The PA public ID is never treated as the local record ID;
the caller cannot supply an origin or token. No candidate route is enabled by
default, and it makes no PA write or evidence-store mutation.
Operations migration 0111 adds an immutable, review-only exact-existing-record
attestation table, with a separate D1 store. The focused store suite passes
five cases; the current combined route, verifier, store and existing migration-
chain selection passes 50 tests, and Operations TypeScript checks cleanly. The
table is intentionally not consulted by the materializer: a
review record or hash alone is not a PA binding receipt and grants no authority.
The later authorized bind action, durable response reconciliation and
current-state reacquisition are still required.
The operator review surface is also incomplete: the native local-record panel
shows the Operations profile, while the candidate verifier deliberately returns
only PA IDs, request IDs, hash and revision. A separate default-off,
native-authorized comparison route can now return bounded local and PA profiles
for a revision-matched initialized candidate, including the server-verified
profile hash needed for a later attestation. A local staff reviewer panel now
calls it from the canonical native directory record page, behind a separate
default-off build opt-in; it has not been browser- or staging-accepted.
A separate default-off route now records 0111
attestation only after explicit reviewer confirmation, current PA/local checks,
and an atomic D1 authority/enrollment/version fence. It is not enabled or
end-to-end accepted. A stored hash by itself must not be accepted as human
identity review. The remaining UI must display both sides and record an
explicit reviewer decision tied to current revisions.
For a `READY` candidate, PA readiness has no revision and the verifier returns
before a resource read. It cannot satisfy the existing-record bind command or
0111 evidence; explicit, separately authorized initialization and a fresh PA
read must precede review. Only `ALREADY_INITIALIZED` can proceed through the
current revision-bearing candidate path.
Operations migration 0112 now adds an isolated acquisition command reservation
and append-only event ledger. It pins an exact 0111 review receipt, local record,
opaque external ID, PA public ID/revision and source/application/history
namespace to a retry-stable command UUID. Scoped collision checks allow the
same canonical customer in LTDS and LTT and permit a newly reviewed attempt
for the same exact pair at a newer PA revision, while rejecting partial
retargets. Its focused D1 suite passes five cases; the current combined
candidate, review, acquisition and existing migration selection passes 55
tests. This ledger still has no admitted execution route or materializer
consumer; `pending`, `uncertain` and even locally
recorded `acknowledged` are not binding proof. A future acquisition workflow
must reconcile earlier uncertain commands and validate a fresh PA read before
committing a usable mapping. A mistakenly reviewed identity remains immutable
in 0111; an explicit correction/supersession workflow is still needed before
staff can safely recover from human review error.
Correction cannot be implemented as an update or delete of that evidence. A
replacement review must be appended and linked to an explicit correction case.
Before superseding any pending or uncertain acquisition command, the executor
must prove against the same PA namespace and command identity that the old bind
had **no effect**, and drain/reconcile any outstanding delivery; timeout alone
is not proof. An acknowledged bind requires a separate, PA-confirmed
compensating/unbind incident flow, not local retargeting. The correction route
must recheck current staff authority, admission, grant scope, and both source
and target revisions at execution time. No such route is enabled yet.
An additional disposable full Operations D1 migration-chain regression now
applies migrations 0001–0112 with a populated historical canonical client and
verifies that 0111/0112 leave its records, revisions, audit and intent bytes
unchanged. It passes locally (one test); this is not a remote backup/restore or
production migration rehearsal.
The latest full PA local run passes **1,244 tests / 9,173 assertions / 96
skipped** after the stale-initialization-replay, current-binding-replay, and
generic read-only binding-status corrections. The PA status endpoint and its
three exact read scopes remain default-off and undeployed. Operations has a
read-only status transport, now wired into the internal acquisition coordinator
but not the canonical mapping path. The coordinator requires the reviewed live
profile, current reviewer authority, and exact current binding status before it
returns `binding_proven`; this result makes no local mapping or portal grant.
The human review-attestation route
is also default-off: its external ID and audit time are server-owned, and a
conditional D1 INSERT plus guarded same-hash replay now fences the current
local record/version, enrollment, staff admission/profile and effective grants.
The local interleaving and retry tests pass. Remote PA observation remains
non-atomic with D1, and reviewer UI acceptance, canonical mapping path, and
correction/supersession workflow remain open. The focused five-suite Operations
run passes 65 tests and the Operations TypeScript check passes after restoring
lockfile-pinned local dependencies. Independent QA added an immediate live
profile/reviewer-authority recheck before each binding POST; it reduces a local
stale-decision window but does not make PA and D1 atomic.
The reviewer UI is still default-off and must not be activated on that basis.
Its per-tab, in-memory pending ledger preserves an exact command across an
ordinary record refresh and blocks a second review while a response is
unresolved. It stores no profile, token, or CSRF data. A full tab reload still
loses that volatile command, and a `409` during retry can mean the current
profile changed after the original attestation was stored; it is not proof that
no write occurred. The UI therefore retains an in-tab unresolved state rather
than silently issuing a new review. A separately authorized, exact-receipt
lookup (without bypassing current reviewer authority) is available for
same-tab lost-ack recovery. A default-off read-only Operations
endpoint now accepts the preserved 0111 attestation command shape, matches
its persisted identity fields to the historical reviewer-owned receipt, checks
current native record/global grants, and returns only its receipt ID and
server-authored request hash. It
does not call PA or retry a write. The panel now offers a distinct same-tab
"Check recording status" action for the retained exact command before retry;
it clears pending state only after an exact receipt response and still describes
the result as historical evidence. The attestation now uses the immutable
source/public-ID tuple captured when its displayed comparison was requested,
so editing a form field while that fetch is in flight cannot retarget review
evidence. The focused browser transport and adapter
suites pass 13 tests locally. A full tab reload still loses the in-memory
command, so this is not complete lost-ack recovery and must remain default-off
pending a safe durable command recovery design. This lookup does not establish current
record revision, destination enrollment, or PA binding validity.
This is local verification, not staging or production acceptance.

The existing canonical mapping table cannot be used as a shortcut for an
acquired PA binding: its `command_id` is a foreign key to the legacy directory
outbox, and its insert guard requires a leased command and valid PA directory
acknowledgement. The client-to-organization dependency in migration 0082 also
requires that old outbox receipt for `existing_mapping` evidence. Do not make
synthetic outbox rows or fabricate acknowledgements. The acquisition bridge
needs its own immutable, namespace- and epoch-pinned binding receipt backed by
0112 plus a fresh PA binding-status/profile read and current reviewer authority.
Canonical mapping and parent-dependency readers must then accept that new
provenance explicitly, with conflict guards against old mappings; public links,
workspace grants, and historical IDs stay untouched. An `acknowledged` 0112
event or a `binding_proven` coordinator result alone must not make a record
linked or visible to a client.

Migration 0113 adds a separate immutable acquired-mapping receipt table with
exact source instance, application, history epoch, local record, external ID,
PA public ID, and acquisition-command identity. Its insert guard requires an
acknowledged 0112 command and rejects partial collisions with legacy mappings,
including legacy rows whose epoch is null. The local store checks the three
supplied acquisition/profile/binding-status identity shapes against that
command, uses a stable receipt ID for replay, and lets D1 author the timestamp.
This is **inert scaffolding**, not an acquired binding or an authorization
source: D1 cannot authenticate caller-supplied PA response shapes or establish
their freshness. No route, materializer, parent-dependency reader, portal
grant, or public-link path consumes 0113, so it remains inert.

Migration 0114 now adds an append-only acquisition-response receipt. The
strict PA v2 POST transport mints an in-memory, detached attestation only
after bounded response and exact namespace/command validation; injected
JSON-shaped outcomes do not qualify. The coordinator records that response
receipt before advancing 0112 to acknowledged, and a lost D1 write retries
the same PA command ID only after current reviewer/profile/status checks.
The 0113 adapter requires both the exact durable response receipt and fresh
PA profile/binding-status evidence plus current reviewer authority. A new
database insert gate also rejects new 0113 rows without the 0114 receipt;
the recorder rejects replay of pre-0114 rows lacking that receipt. This is
trusted Worker transport provenance, **not a PA-signed response** or a
cross-system atomic transaction. The older status-only acknowledgement cannot
be promoted. These internals are unmounted and do not make any mapping or
client grant. Seven focused acquisition, receipt, migration and browser-transport
suites pass 46 tests, and the review panel passes six desktop/mobile browser tests.
Operations TypeScript checks cleanly, and a disposable migration chain
through 0114 preserves populated canonical history. Neither is a production
D1 backup/restore rehearsal.

A proposed 0115 relational promotion marker was rejected during independent
QA: a D1 writer could copy the stored 0114 response hash and insert an exact
marker without fresh PA profile/binding reads or a current reviewer check.
A SQL trigger alone cannot identify which Worker path wrote it. Do not treat
0113 or 0114 receipts, or a matching D1 hash, as authority-grade acquired
mapping provenance. A future design must establish independently verifiable
writer provenance or revalidate authority at the point of use, reject both
legacy and acquired-to-acquired mapping conflicts, and move the SQL and
TypeScript dependency/materializer readers coherently. No 0082 relationship
dependency, materializer, project, portal, or public-link reader consumes
the current acquired receipts. Never fabricate old outbox entries or turn on
only one reader.

A **different** additive 0115 migration now closes the local review-revision
gap without promoting any mapping. It adds nullable
`reviewed_local_record_version` to 0111; existing and raw/unfenced review
receipts retain `NULL` and are not eligible for a new 0113 receipt. The
fenced review writer stores the exact checked local version in its conditional
`INSERT ... SELECT`; exact retries require the same persisted version. A
new 0113 insert guard requires that version to equal the current local record
version at the final D1 write. The internal proof adapter also rejects a
missing, stale, or wrong-kind reviewed version before PA calls. This is a
consistency fence under privileged D1, not a new cryptographic proof or an
activated mapping consumer. After these fences, the combined local acquisition
and review selection passes **ten files / 64 tests**; Operations TypeScript
and the production build pass locally. This does not prove staging, a populated remote-D1 migration/restore,
or production acceptance.

The intended promotion trust boundary is a restricted Operations Worker with
the configured PA connection and native staff authority, writing to its
privileged D1 binding. D1 constraints guard consistency and collisions, but
arbitrary D1 write access is equivalent to control-plane authority; no SQL
hash or trigger can prove which Worker path performed a remote check. Keep
direct D1 write credentials narrowly held and audit them before cutover. A
promotion service must recheck the exact selected PA binding, current PA
profile revision/hash, source namespace/epoch, local reviewer's current
admission/grants, and the local record version reviewed by that person, then
claim a unique mapping under a native ownership epoch. The 0113 proof adapter
now requires strict PA readiness/current-read verification both before and
after its fresh profile and binding reads. Each observation must match the
reviewed 0111 profile hash, exact identity and revision; mismatch or
unavailable PA fails closed without a receipt. Independent QA verified that
a same-revision hash change between the first readiness and profile read is
rejected by the final check. The 0115
local version fence covers review changes. A server-only current-reviewer
authority callback factory now rechecks admission/profile versions, effective
record grants, global enrollment authority, local revision, and the exact
enrolled PA namespace; it is not mounted in a production caller. Controlled
canonical promotion remains open. PA and D1 do
not share a transaction, so a remote binding can change after the final PA
read; authorization-sensitive consumers need a documented freshness rule or
another PA-verifiable conditional generation, not an invented atomicity claim.

The additive 0116 table is a prospective acquired canonical-mapping candidate,
not an active mapping. Its only permitted state is `inactive`, and its native
owner epoch is constrained to NULL until a separate native ownership ledger
and conditional activation exist. It requires a current local-version and
exact durable review/command/PA-response/receipt chain and rejects 0054
legacy external/public overlap even if the old mapping's history epoch is
NULL. Populated migration-chain testing confirms old rows remain unchanged and
an exact legacy collision fails. A separate positive D1 fixture stores a
non-colliding candidate but proves it remains inactive and immutable. No
public reader consumes 0116. Future 0054
writes can still collide with a dormant candidate, so activation must recheck
that race and add a bidirectional fence. Do not deploy this table as if it
were a completed acquisition cutover.

The additive 0117 migration now reserves an immutable native owner-epoch
**claim** per exact 0116 receipt, with a distinct unique UUID-v4 epoch, an
auditable actor/request hash, a current local-version fence, a reverse
legacy-insert collision trigger, and a cross-history acquired-identity fence.
Its separate activation table permits only `inactive`; it cannot confer
native authority or affect a public/client reader. SQL cannot authenticate
the reviewer or prove that PA remains current after a remote read. Activation
requires a server-only native-owner control action and a fresh, narrow PA v2
status assertion for the exact selected profile/workspace/root (and selected
principal/identity when applicable). Once Operations owns native portal and
delivery access, ordinary Ops grants must not wait on PA. PA-derived financial
or transitional guest paths remain separately fenced. The 0117 synthetic
tests and both populated negative and positive complete migration-chain
fixtures passed locally. The positive fixture proves the exact
review/command/response/receipt/candidate/claim sequence remains inactive
and leaves prior canonical history unchanged. These are local database
fixtures, not PA-current authority or release acceptance.

An earlier full PA run reached 1,216 tests / 8,805 assertions with one failure:
an old static source-order test mistook a helper definition for a pre-transaction
call. After its post-transaction call-path assertion was corrected, the stable
tree passed the full suite: **1,219 tests / 8,926 assertions / 96 skipped**.
This is not end-to-end managed-mode acceptance:
controller-level managed denial and normal-mode HTTP behavior, full MySQL
payment-import persistence, concurrent policy activation, and populated-data
rollback still need tests. No production route yet exercises the owner-controlled
managed-mode activation/return service; that control needs a reviewed UI/API
path and an actual writer-readiness proof before cutover. Repeat the shared-writer
inventory before enabling it. The PA staging health endpoint returned HTTP 200,
but these uncommitted changes are not running there. No production PA or Ops
configuration changed.

A further activation review found that the policy service selected an API
key's revocation timestamp but did not reject a revoked key when evaluating
historical command evidence. The local service now rejects it under the locked
credential read; the policy suite passes 13 tests / 30 assertions including
the regression. This does not make activation ready: there is still no reviewed
owner-control route, and historical receipts alone do not prove a live capable
writer, completed backfill, or recoverable cutover. The disposable directory
MySQL runner did not start because Windows denied PowerShell script execution;
do not count it as MySQL acceptance or bypass that policy silently.

## Implementation order

### Initial destination evidence: September 12 runtime decision

- A deliberately new PA customer and an imported existing PA customer require
  different evidence. Absence of a local mapping is never permission to create.
- For an explicitly confirmed new customer, reuse the immutable, consumed native
  create admission and its exact mutation/audit/destination binding; do not add
  a second unrelated customer registry. Its issuance must explicitly distinguish
  new remote creation from importing an existing customer. A profile-edit route
  cannot choose that disposition or supply its own proof identifier.
- For an existing PA customer, implement a generic directory binding command
  using PA's existing `ApiExternalResourceBindingService`, current resource
  authorization, idempotent receipts, and source/application/history fences.
  The corresponding project binding endpoint provides an existing pattern.
  Verify the reviewed exact PA public ID and revision; never use name/email or
  broad snapshot coincidence as a substitute. The local PA candidate now
  exposes the exact-scoped binding endpoint and Ops has an isolated matching
  transport, but neither is a released acquisition workflow or persisted
  reviewed-link proof.
- Persist narrow link evidence only after verifying the actual PA binding
  receipt. Materialization must resolve proof identifiers against the consumed
  admission or verified binding evidence, not merely validate their shape.
  Keep current native permissions separate from original mutation identity and
  from PA resource authority. The background dispatcher is not yet wired.
- This is an implementation dependency, not a deployment change or proof that
  existing customer import is complete. Generic PA labels/scopes and the owner
  review/deployment gate still apply.

### Coordinated implementation sequence

1. Preserve existing identifiers and fix profile/address transaction boundaries.
2. Introduce generic directory commands with explicit application/resource
   authorization, strict fields, expected revisions and durable command receipts.
   Recheck authority on retries. Changes and address updates commit atomically.
3. Add management ownership configuration and a server-side guard used by all
   shared writers, including restores, imports and onboarding. Do not enable it
   until a complete directory command route exists and is verified.
4. Route Operations onboarding/profile updates through its canonical records and
   a durable per-instance outbox. Preserve mappings across LTDS and LTT without
   conflating numeric IDs. Record conflicts instead of overwriting unseen edits.
5. Rehearse normal mode, managed mode, last-token revocation, application transfer,
   payment import, client restoration, concurrent edits and rollback on populated
   synthetic databases. Confirm issued financial documents do not change.
6. At the coordinated cutover, stop all legacy competing writers together,
   activate the selected authority and retire the old custom-integration code.

## Ops durable ownership boundary: implementation constraints

Source inspection confirms that `pa_clients` and `pa_organizations` are still
populated by `project-alpha.ts`, and `client-hub-directory.ts` uses those live
projection rows to determine business-root eligibility. Migration 0036 explicitly
defines `business_parties` as presentation grouping, not shared-profile authority.
Neither adding an outbound queue nor renaming these tables completes M04.

- Introduce canonical Ops customer/person/organization identities independently
  of PA availability. Preserve existing source-qualified routes and historical
  mapping IDs as aliases; do not regenerate public delivery links during import.
- Import exact existing identities with provenance and a reviewable snapshot.
  Existing deliberate business-party links can supply grouping evidence, but
  must not silently authorize contact merging, billing visibility, or workspace
  membership. Unlinked records remain distinct even when names/emails match.
- Save a canonical profile revision, its actor/audit record, and all selected
  destination intents in the same `OPS_DB` transaction. A user-visible successful
  edit means local persistence succeeded, not that both PA instances responded.
  Do not write an Ops edit into a legacy PA projection while its importer can
  overwrite it. The eventual profile route must enforce current staff/client
  authority, expected local revision and allowed fields inside this boundary.
- Serialize pending changes for each exact destination/resource. A later edit
  may be saved locally during an outage, but its PA expected revision is derived
  only after the predecessor is acknowledged. Never rewrite an attempted command
  to accommodate a newer local edit or a conflicting remote revision.
- Distinguish an immutable local revision/intention from a remote wire command.
  An intention awaiting a predecessor or an organization binding has not yet
  been sent. Once materialized, its command ID, fields, PA revision and destination
  identity are immutable across every retry, including a lost success response.
- For two destinations, preserve separate delivery states. One PA acknowledgment
  cannot mark the other synchronized. Report partial synchronization without
  undoing the accepted local edit or reissuing the first command with a new ID.
- Persist the receipt and its exact external-to-PA binding atomically under the
  current lease fence. Remote success followed by a local database failure stays
  uncertain and retries the original command; it is not a new create request.
- Backfill, native directory reads, enrollment and scoped portal membership need
  their own acceptance tests. A command receipt or mapped PA ID grants no portal,
  financial, file, organization-member or staff access by itself.

### Application identity is part of retry identity

At the start of this increment, PA `GenericApiAuthService` authenticated an application public
ID, but `GenericApiDispatcher` did not return it in capabilities. Ops readiness
validated only the PA source-instance UUID and capabilities. PA command
receipts and external bindings are application-scoped. Consequently a credential
from a different application on the same PA instance could pass that readiness
check and interpret the same command ID in a different receipt namespace.

Before enabling durable dispatch, add authenticated application identity to the
generic protocol and require it to match the saved destination. PA must also
check the expected application on the actual command before mutation or receipt
replay; a preflight-only comparison leaves a credentials/configuration race.
Return the authoritative application identity with the receipt and test wrong-app
tokens against an existing successful command. Rotating credentials within the
same application is supported; transferring ownership to another application is
an explicit reconciliation operation, never an automatic retry fallback.

The current local candidate adds these identity checks to both applications,
including the PA front-controller header adapter. Ops transport unit coverage and
the joined disposable HTTP/MySQL rehearsal now exercise the contract, including
wrong-application-token replay with equivalent resource grants (7 tests / 181
assertions). The detailed evidence is tracked in the migration register.
This is not deployed acceptance. No production authority or credentials changed.

## Canonical directory route authorization: integration checklist

Current source evidence: `business-party-routes.ts` mounts behind authenticated
Ops middleware, but its store uses `team.view`/`team.manage` and administrator
checks for presentation linking. `invitation-review-authority.ts` also includes
legacy PA connector visibility/state in its proof. Neither is the correct
authorization contract for editing native customers during a PA outage. Shared
`PERMISSIONS` currently contains no distinct canonical customer-edit capability.

- Give directory viewing, shared-profile editing, cross-instance identity linking,
  service enrollment and portal-access administration distinct permissions.
  Viewing a staff roster or managing a delivery link must not grant these actions.
  Introducing a permission must not silently give it to every existing role.
- Resolve staff identity and current effective allow/deny scope from Ops. Support
  the agreed business-area/division/exact-resource boundaries; do not implement
  the final customer editor as an owner-only or global-team-admin-only shortcut.
  An absent/inactive actor, changed bound Access subject, or explicit applicable
  denial must prevent the mutation even when the browser still has a valid JWT.
- Check current authority in the same database transaction as canonical revision,
  audit and destination-intent insertion. A preflight boolean or a previously
  captured principal alone does not fence an access revocation during a write.
- Client self-service is a separate actor path. Resolve the signed-in individual
  and active workspace membership, enforce the editable shared-field allowlist,
  and preserve explicit revocation. It must not accept a staff actor ID or a list
  of PA destinations from browser input as authority.
- The server derives destination selection from deliberately enrolled canonical
  links. A profile edit may update that same shared profile in both enrolled PA
  instances, but it must not enroll a new service, link another customer, change
  billing visibility or expand delivery scope. Those are separate audited actions.
- Keep financial/provider/tax fields out of generic shared-profile mutations.
  A division manager's ability to edit a shared phone number does not imply access
  to the customer's other business area's documents, website or compensation.
- Keep native profile writes available when PA is unreachable. Retain destination
  intents and show synchronization state; enforce remote authorization at send
  time without using PA availability as the native staff-login switch.
- Before route activation, test revocation between request read and commit,
  denied cross-division/resource writes, client impersonation, changed destination
  configuration, an offline local edit and an existing public-link read. The
  persistence helper remains internal until these route-level checks are wired.

### Native staff authority: confirmed cutover dependency

- `staff_users` currently mixes local and PA-managed profiles. Migration 0004
  provides `provisioning_source` and `sync_protected`, but local provenance alone
  does not prevent adoption by a later PA sync. `project-alpha.ts` can adopt an
  unprotected matching email with no PA user ID, then synchronize status/roles.
  Native admission needs a durable protection/ownership invariant, not just a
  new account form. Do not retrospectively protect every imported staff row or
  grant privileges as part of this preparation.
- Existing scopes are global/division/assigned/own. Neither the shared permission
  catalog nor canonical record schema yet defines the required customer edit,
  business-area and exact-resource authority. Local role sidecars alone do not
  supply that missing scope model. PA-backed write-fence views also cannot serve
  as the outage-independent authorization source.
- Parent inspection found the old login adapter selected a staff row, attempted
  first identity binding, then returned that earlier row without checking whether
  its conditional update won. The local replacement returns only the result of
  one active-email/subject-qualified `UPDATE ... RETURNING`. Competing identities
  cannot both receive a principal from a first-bind race. Existing bindings only
  refresh last-seen time; initial binding additionally updates profile metadata.
- Eight focused local Miniflare tests cover the binding and login adapter,
  including mocked JWT-verification failures, non-human claims, current profile
  fields and conflicting bound subjects. These do not prove real Cloudflare
  login or native staff/permission cutover. Current authority still must be
  checked again inside each canonical write transaction.

### Intent materialization is still a separate required gate

Canonical `ready`/`waiting` intent states describe local ordering, not permission
to create a remote customer. Before making a wire command, the materializer must:

- Resolve an exact existing PA mapping and last acknowledged PA revision, or an
  explicitly authorized create disposition. Absence of a local receipt alone is
  not proof that the customer does not already exist in PA after migration.
- Require the preceding intent for that exact destination/resource to be fully
  acknowledged. An uncertain, denied or conflicting predecessor remains a block;
  do not skip it or guess the next PA revision from an Ops revision number.
- Resolve client-to-organization relationships against that destination's PA
  public IDs; do not send a canonical Ops organization UUID in a PA public-ID
  field. Detect incompatible field limits without truncating shared information.
- In one transaction, reserve the immutable wire command and link the intent to
  that reservation. A crash between those operations must not leave an unowned
  command or allow a second wire ID. Retry the same wire bytes once attempted.
- Persist acknowledgment linkage before unblocking successors. Independent PA
  destinations can progress separately, but command IDs, external IDs, application
  IDs and source-instance IDs must never be substituted across their histories.

The canonical store and existing outbox are local foundations for this path.
Neither a unit-tested storage helper nor an automatically selected `ready` state
means the production authority switch or user-facing customer editor is complete.

### Canonical transaction: implemented local boundary

- Migration 0055 and `operations-directory-store.ts` now persist the canonical
  record, immutable full-profile revision, actor audit and selected destination
  intents in one primary-session D1 batch. No imported PA projection, portal
  grant, credential or external request is written by this helper.
- Identical concurrent mutation retries return the original receipt; competing
  edits at one expected version have one winner. Failed audit/intent writes roll
  back both creation and updates. Caller-owned values are detached before the
  first database await. These are local database guarantees, not route authority.
- A canonical record has at most one destination for each selected
  source/instance/application tuple. Origin and external canonical ID are pinned
  attributes, not alternate stream selectors. A database trigger rejects an
  ordinary edit that changes either value, rolling the entire edit back.
  Remapping or origin transfer needs an explicit reconciliation workflow.
- Full profiles deliberately exclude financial, credential, private-note,
  membership and relationship fields. Native records may exist without a PA
  destination. Destination lists must eventually come from authorized server
  enrollment links, never directly from a client's form.
- The parent combined API/transport/outbox/store run initially passed 111 tests;
  additional parent tests cover input mutation, competing updates, wrong-kind
  and missing-record updates, and destination pinning. Final counts are recorded
  in the migration plan. No migration in this increment was applied remotely.

## Evidence still needed

### Current local foundations

- PA 0091 separates explicit application resource authority from token scopes;
  exact grants and all-of-type grants use case-sensitive stable public IDs.
  Create requires all-of-type authority, not a guessed future ID.
- PA 0092 provides immutable application-scoped external-ID mappings, independent
  of access grants. Bindings must keep current credentials, target authorization,
  durable provenance and rollback behavior together.
- The generic directory cannot reuse legacy snapshot hashes unchanged: the old
  organization projection excludes general email and phone. The replacement
  uses `directory_client` and `directory_organization` metadata keyed by PA
  public ID, with the complete allowed shared profile. Existing legacy feed
  names/IDs/hashes are preserved until coordinated retirement. This is a
  preparation boundary, not a permanent competing authority.
- Private PA notes and financial/provider fields are not in shared profile
  commands. Keep existing values intact; do not import them into the client
  portal as if they were shared customer information.
- Root-added mutation sequencing/revision assertions passed 13 SQLite tests
  (159 assertions) and four disposable MySQL tests (16 assertions), including
  stale repeatable-read rejection and blocked concurrent observation. New
  directory projections and permanent-project-link retention checks bring the
  combined focused SQLite run to 31 tests / 298 assertions. These are local
  primitive tests, not public command-route or deployed acceptance.

### Remaining acceptance

- Default-off organization and client create/update HTTP adapters are now local,
  using separate exact capabilities, resource grants and atomic command receipts.
  Parent expanded client MySQL/HTTP acceptance passed 3 tests / 61 assertions;
  the subsequent 0094 policy/HTTP selection passed 4 / 76 on disposable MySQL.
  Current-credential, scoped-replay, archived-client, private-field and revision
  cases have focused runtime coverage. These do not prove a complete cutover.
- Parent review found organization reassignment could orphan department-contact
  records. Changed-parent commands now require old/new organization authority
  and reject nonempty department assignments without deleting them. A dedicated
  hierarchy reconciliation workflow and all concurrent writer fences remain
  required before enabling authority in production.
- Generic read/change routes, resource filters, grant-administration UI and
  backfill/reconciliation consumer wiring remain required.
- Every listed writer denied or routed correctly in managed mode, with PA normal
  mode still usable and financial-only actions preserved.
- Existing and new address/default assignment rollback, not merely a helper
  called with synthetic SQL; tests must fail against the previous controller
  ordering and distinguish address failure from projection failure.
- Whole migration/backup/restore rehearsal and owner-reviewed PA deployment.
- Both-instance reconciliation, default portal eligibility, explicit revocation,
  and existing public-link acceptance after the final authority switch.

### Policy and writer-audit follow-up

- Migration 0094 now provides a default-local, audited policy. Both generic
  command services check selected application ownership; client create/update
  controllers check local ownership inside their mutation transaction.
  The feature remains off and unreleased until the full writer list is covered.
- `organization_departments.php` also has a post-commit
  `organization_department_created_link_transition()` path that changes
  `organizations.link_strategy` and link state. Guarding only the initial
  department transaction would leave this continuation outside the boundary.
- `PaymentProcessorImportService` matches by email before its creation
  transaction and may enrich an existing client. Guarding just INSERT would
  miss that path. Managed mode needs a canonical lookup/review disposition
  without losing the imported payment; preserve standalone behavior separately.
- `organization-update-notes.php`, `organizations_upload.php`,
  `organization_document_upload.php` and Stripe provider-ID binding are
  financial/private paths, not reasons to broaden directory commands.
  The mileage profile address handler also needs explicit purpose classification
  rather than a blanket lock in `address_book_save`.
- Onboarding approval can change several shared records and addresses. Acquire
  ownership before approval matching/mutation; rejection should remain usable.
  Archive restoration must enforce in its service, not only its controller.
- Local fences now also cover client archive/purge/restore (including the restore
  service) and both organization creation forms. Creation uses read-only address
  schema preflight rather than an implicit-commit DDL helper. These additions
  remain local, with runtime guard tests plus source-order checks; the full
  authenticated workflow and every remaining writer still gate activation.

### Organization increment: local separation and remaining acceptance

- The former organization update form posted a complete profile/address along
  with optional tax-file upload/removal. Its three branches rewrote
  that shared snapshot. The local candidate now separates those forms and
  handlers. Do not exempt a request from managed-mode enforcement
  merely because a tax flag is present, or infer intent by comparing stale form
  fields with current values.
- The shared-profile action is guarded locally; tax upload/removal and PA-private
  notes use distinct actions and forms. `organizations_upload.php` now has an
  explicit removal action with confirmation and expected current filename,
  changing only tax metadata. Preserve existing staff capability
  checks and verify exact organization authority, including route aliases.
  Parent confirmed the notes route has `organizations.manage` middleware; lack
  of a controller-local ACL call alone is not proof of unauthenticated access.
- Financial file changes need explicit rollback/cleanup: retain the old file
  until the database transaction succeeds, and clean a newly staged file if
  persistence fails. Do not trigger shared-profile projections or address
  changes from a financial-only action.
- Membership attach/detach must re-read the current client, parent organization
  and staff authority under the policy-first transaction, not trust pre-lock
  snapshots. Preserve service-assignment reconciliation and reject unresolved
  department-contact relationships before reparenting. Generic application
  resource grants do not substitute for staff/session ACLs.
- The render-only form has a disabled shared-profile fieldset in managed mode,
  separate notes/tax forms, and removal actions at the bottom. Parent synthetic
  browser checks confirmed mobile fit and corrected the medium-width layout to
  stack notes/tax beside the tall profile, using container width rather than
  assuming the entire viewport is available. These are component checks, not
  production branding or authenticated submission acceptance.
- A full-suite failure exposed a stale source assertion after form extraction.
  The regression now follows the included component and keeps address-line-two
  coverage. Rendered tests additionally verify a suite value is retained and a
  blank state is not replaced with an installation default. Parent focused
  selection passed **71 tests, 1,223 assertions**. Full rerun is tracked separately.
- Independent review found private attachments still use the legacy login-only
  serving handler, without current organization/attachment lookup. Best-effort
  deletion can leave retired files available, and the mutation callback can use
  cached role state. Fix these and test current per-resource authority, retired
  URL denial and cleanup failures before release. Passing form tests do not
  remediate these findings.
- Remaining acceptance must distinguish local/managed profile behavior, managed-mode
  financial-only success, unchanged shared fields, rollback without old-file
  deletion, stale parent/ACL refusal and department reconciliation. These are
  required runtime cases, not all implemented coverage.

### Native staff authorization: September 11 implementation boundary

- Canonical directory authorization must not read PA-owned
  `staff_role_assignments` or infer permission from `isAdministrator`. Current
  `project-alpha.ts` reconciliation rewrites those assignments and can change
  `staff_users.status`. Independent grants alone therefore do not complete
  independent Operations accounts: explicit native admission and a protected
  identity/status owner are also required before exposing canonical write routes.
- Use native-owned explicit grants with global, business-area, division,
  assigned and exact-resource scopes. Do not automatically migrate grants from
  PA roles, local role sidecars or existing delivery permissions. A separate
  reviewed transition must establish the first native administrators.
- Shared customers can have multiple business-area and division associations.
  Those associations are authorization context, not billing entities and not
  automatic service enrollment. A profile edit targets the single common
  customer record, including when both PA destinations receive the update.
- For that common record, any applicable explicit deny wins across all matching
  associations. A caller cannot select an alternative business area to evade a
  deny. A deny on an unrelated area/division is not applicable. Service-specific
  data and financial documents require their own separately scoped permissions.
- Keep profile viewing/editing, identity linking, service enrollment and portal
  access administration distinct. No permission implies any of the others.
- The first implementation slice is a pure effective-permission evaluator and
  focused tests. It must require complete resource context, explicit native
  admission, an active staff identity and the current bound Access subject.
  This is not a transactional write authorization gate or an exposed route.
- Database integration must revalidate current admission, subject, grants,
  denies, assignments and scope in the same batch as the canonical revision,
  audit and outbox intents. Replays also require current authorization. Native
  writes must not depend on PA availability, and failed authorization must leave
  no revision or downstream intent. System/import actors require a separate
  explicit authority path, not an arbitrary caller-supplied `system` label.
- Source inspection confirms two distinct legacy writers to remove/fence at
  cutover: `project-alpha.ts` user projection adopts unprotected local users by
  matching email when no PA ID is present (around lines 405-413), while entitlement
  reconciliation changes status and rebuilds assignments (around lines 697-718).
  Merely adding a native grant table would leave account activation under PA
  control. The transition must explicitly preserve each admitted native staff
  identity and disable these PA ownership paths; do not silently adopt identities
  by matching email in the replacement.

### Transactional write integration checkpoint and remaining route gates

- The native snapshot reader remains preflight/display evidence only. The local
  0058/store implementation now rechecks native admission, exact verified Access
  subject, applicable grants/denies and resource associations within the same
  batch as protected record/revision/audit/intent writes. Do not replace that
  fence with a caller-provided `allowed` boolean when wiring HTTP routes.
- Native admission is the intended status authority; using the PA-reconciled
  `staff_users.status` in this new fence would restore the dependency being
  removed. Existing login handling still needs a coordinated ownership change.
- Store replay now uses a fresh authorized receipt query, including the
  admission-consumption race path. An old command receipt does not authorize a
  revoked employee. Focused D1 evidence is recorded in the migration plan.
- Scoped creation needs an audited server-owned proposed-record admission with
  approved initial scope and enrollment context, consumed atomically at creation.
  Do not infer authority from browser-selected scope/destination arrays, use a
  caller's `system` label as a bypass, or restrict the final workflow to global
  administrators as a shortcut around scoped creation.
- Local database guards and real D1 tests now cover direct canonical writes,
  revocation, subject/scope changes, replay, concurrent creation and rollback.
  These do not activate login, grant administration, admission issuance or routes.

### Next application-wiring sequence (September 11)

- The local authorized canonical-profile read service now uses one atomic policy
  and current-profile snapshot. Fixed `directory.profile.view` authority is
  required in both the public service and its shared snapshot helper; an edit
  grant is not a read grant. Denied snapshots discard profile data, SQL bounds
  returned profile bytes, and exact profile validation rejects unexpected fields.
  This remains an internal service, not an enabled HTTP route.
- Add an explicit native account/bootstrap transition before enabling native
  routes. Preserve real Access JWT verification, but replace PA-owned status as
  the login authority at the coordinated cutover. Fence both PA matching-email
  adoption and legacy status/role/division rebuilds; no automatic identity merge.
  The [native staff authority checkpoint](native-staff-authority.md) records the
  separate Ops Sync webhook writer, legacy ACL/direct-SQL consumers and the
  chosen single-authority profile/admission split. Changing login alone is not
  sufficient to complete this transition.
- Add a server-owned create-admission issuer. Scope selections are requests,
  not authority: resolve current native context and applicable denies. Profile
  editing must not implicitly grant service enrollment or identity linking.
  Initial target enrollment needs its own authorized policy decision. "Approved"
  here means server-authorized context; it does not impose an unrequested manual
  owner review on every customer created by an authorized division manager.
- Define deployment-owned directory targets with exact source/application UUIDs
  and credential references. Existing legacy application keys are not these
  UUIDs. Never infer LTT identity from the LTDS key or accept an arbitrary browser
  origin as an outbound destination. No new secrets have been configured yet.
- Add the bounded materialize/dispatch/reconcile driver only after persisted
  create or existing-binding proofs are available. A missing receipt never
  authorizes a create. Keep per-destination progress independent, causally order
  successive revisions, and retain uncertain retries without rewriting commands.
- Route-level CSRF, individual identity, expected revisions, safe error mapping,
  outage operation, public-link compatibility and both-instance acceptance remain
  required before the single production authority switch.

### Existing-directory bootstrap prerequisite (September 12)

- Existing legacy snapshot revisions are **not** generic directory revisions.
  `OpsSnapshotV2Service` observes `client` / `organization`; the full shared
  profiles use `directory_client` / `directory_organization`, keyed by permanent
  PA public ID. In particular, legacy organization projections omit shared
  email/phone. Do not substitute their hashes, versions or numeric identifiers.
- A strict directory binding endpoint alone therefore does not complete legacy
  import. Unchanged legacy rows generally lack the required directory state.
  Missing state must remain a reconciliation outcome, not permission to create
  another customer, initialize state during binding, or infer a match.
- Add bounded single-resource generic directory reads, independently scoped per
  kind. Recheck current application/key/resource authority (including a client's
  linked organization), source identity and history epoch in one transaction;
  return only the shared profile when present directory state has the exact
  canonical projection hash and supported positive revision. GET must not call
  `observeResource()` or `recordEvent()`.
- Existing records need a separate, explicitly authorized and audited bootstrap
  operation. Repeat validation under sequence/domain locks; initialize only
  absent directory state, allow exact matching retry, and reject divergent
  existing state. Persist actor, permanent identity and projection hash with the
  bootstrap receipt. An advisory readiness report is not authority to bootstrap.
- `observeResource()` emits no change event. Initial acquisition must explicitly
  read and verify the newly established directory state; never claim that a
  consumer received an event merely because the baseline now exists. Binding
  still rechecks current state independently, and a historical binding receipt
  is not a claim that its returned revision remains current.

### Initialization contract and review sequence

- A one-resource initialization command contains exactly `commandId`,
  `expectedPublicId`, and `expectedProfileSha256`; it accepts no external ID,
  customer fields, enrollment selection or identity-matching hints. Dedicated
  exact `directory.clients.initialize` / `directory.organizations.initialize`
  capabilities do not imply profile writing, binding or management authority.
- Obtain the candidate hash from a separate authorized readiness preview which
  returns permanent IDs, a canonical shared-profile hash and blocking codes, not
  historical/private profile contents. The preview is advisory and performs no
  observation. Normal directory GET still requires already consistent state.
- Initialization repeats current key/application/resource/linked-organization
  checks and source/history fences under transaction locks. Compare the expected
  hash with the locked current profile only for a fresh command, after receipt
  lookup. This allows a lost-response retry to recover an earlier receipt after
  a later legitimate edit, without granting access to historical profile data.
- Absent directory state becomes revision 1. Existing present state with an
  exact hash and supported canonical revision is verified without rewriting it.
  Tombstones, malformed state and divergent hashes require reconciliation; never
  erase history or reset a revision to make a command succeed.
- Persist only identity, revision and confirmed profile hash in the existing
  command receipt, alongside its existing actor/key/application/history evidence.
  No separate customer registry or new event is needed. Initial acquisition is
  explicitly preview, initialize, current authorized read, then bind; the final
  binding still independently verifies current state and identity.

### Directory GET consumer boundaries

- Operations needs an exact client/organization GET adapter for the existing PA
  read endpoints. Require the corresponding read capability and advertised
  source/application/history fences; a write or binding capability is not a
  substitute for read authority.
- A successful read describes current shared fields at one permanent PA ID and
  revision. It is not binding evidence, permission to adopt an existing customer,
  portal membership, or permission to overwrite the canonical Operations record.
  Preserve the original reviewed mapping and reconcile revisions explicitly.
- Keep source instance, application, history epoch, resource ID, revision and
  authorization generation intact. Treat revisions as decimal strings, not JS
  numbers. Do not return foreign fields or raw provider error bodies to callers.
- A missing/inconsistent PA baseline (409) stays a reconciliation result. Never
  initialize state, create a replacement customer, retry a write, or discard a
  local record as a side effect of this read. Authentication failures and
  transport outages remain distinguishable from a successful empty record.
- This adapter does not activate the pending initialization workflow, change
  current source ownership, or replace the durable admission/binding proof still
  required before materialization and dispatch can be wired safely.
