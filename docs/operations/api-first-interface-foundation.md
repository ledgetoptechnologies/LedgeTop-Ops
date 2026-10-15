# API-first interface foundation

September 10, 2026. Dated implementation design for M02–M03 in the [current migration register](api-first-migration-plan.md), not a deployed API specification. Business decisions are in the [decision record](api-first-decisions-2026-09-10.md). Later checkpoints and current rollout evidence belong in the migration register; route names and schemas must be pinned in executable contract tests before either application depends on them.

## Local scope-policy implementation checkpoint

The initial scope-safety increment is implemented locally in PA, including
migration `0088_api_key_scope_policy.sql`. Policy 1 freezes the historical
capability set; new keys use policy 2 with explicit catalog capabilities and
no future-expanding wildcard. Malformed/unknown policy versions fail closed,
and schema repair normalizes empty scopes only for legacy keys. This does
not grant new API routes or writes, change existing stored permissions, or
complete application identity/resource authorization.

Parent review identified permissive policy parsing and exact-policy alias
handling; those were corrected before an independent review found no blocking
issue. Agent focused validation reported 43 tests, 545 assertions and three
skips. The full PHP suite subsequently completed with 825 total tests,
6,684 assertions, 94 optional/environment skips and zero failures. That run
predates the application-identity increment below; skipped tests are not
acceptance evidence. Source checkpoints below describe the pre-increment
baseline unless noted otherwise.

### Application identity and database rehearsal checkpoint

Local migration `0089_api_application_identity.sql` and its service/authentication
foundation add durable application IDs, hashed exact-scope credentials,
expiration and audit attribution. Generic key administration is now wired locally,
including application selection/creation, expiring issuance, rotation, editing
and revocation. Parent review corrected lifecycle transaction/audit coverage,
disabled-application revocation, expiry parsing and the exact-IP allowlist
contract. The latest focused run passed 70 tests with 562 assertions and three
existing skips. This is service/source evidence, not complete HTTP admin/CSRF
acceptance. No new write API, managed directory mode or production cutover is
complete; neither PA instance has received this increment.

The first real MySQL 8.4 rehearsal rejected `ADD COLUMN IF NOT EXISTS` in
migration 0088. The unsupported column/index syntax was removed from 0088/0089;
file validation then passed for 89 migrations. Metadata-guarded statements now
handle existing columns/indexes without unsupported syntax. Real MySQL 8.4
rehearsal passed four tests with 43 assertions and no skips: legacy preservation,
ledger reruns, runtime repair before ledger, 0088 replay, and interruption at
each durable 0089 DDL boundary. The harness uses PA's actual migration-library
helpers and reconstructs the apply loop; it does not execute the full migration
CLI against a production-shaped database. Full deployment/backup/restore
acceptance remains outstanding. Nothing here has been deployed to either PA
instance.

### Ordered changes and durable commands checkpoint

Local source sequencing now takes a transaction-held singleton lock before
resource/event writes and snapshot watermarks. Three-connection MySQL tests
passed two tests/10 assertions for delayed commit, rollback gaps and replay;
existing sync tests passed eight/138. Every in-scope mutation still needs to
participate, and paginated snapshot convergence and HTTP consumers remain gates.

Local migration 0090 introduces application-scoped durable command receipts.
The initial primitive passed 12 SQLite tests/41 assertions and one real MySQL
test/seven assertions, including current reads after a stale snapshot,
canonical-request conflicts, payload limits and caller-owned transactions.
Token/request/actor attribution is now present locally: a trusted typed context,
current locked token validation, stable first-success attribution and a separate
successful-attempt trail across key rotation. Application-asserted actors never
become PA users or acquire PA privileges. Parent combined foundation selection
passed 64 tests/383 assertions; the updated real MySQL test passed one/eight.
Denied/conflicting attempts still require the future route audit path. This is not
an exposed write API. Authorization must be rechecked before both fresh execution
and replay; trusted callbacks cannot commit independently or perform external
side effects outside a durable outbox. No PA release is authorized without owner
review.

## Generic connection wire checkpoint (local, not cut over)

PA now has an exact early `GET /api/v2/capabilities` route before its browser
session/database bootstrap. It reports the stable installation UUID, granted
exact token capabilities and a separate actually implemented endpoint registry.
It does not advertise unfinished write routes. The real public front controller
was exercised against disposable MySQL over loopback HTTP, including irrelevant
cookies, no session cookie, disabled API with a nonexistent database, and safe
unavailable responses. The strengthened MySQL/HTTP run passed seven tests with
46 assertions, including rollback after usage insertion when `last_used_at`
fails. Legacy route-preservation evidence is source ordering/presence, not a
claim that every legacy endpoint was executed in that harness.

Operations has a local, currently unwired `project-alpha-api-v2.ts` preflight
consumer. It pins the configured installation and application UUIDs, accepts only an HTTPS origin,
does not forward cookies or follow redirects, requires uncacheable bounded JSON,
and distinguishes transport, credential/scope, rate-limit and contract errors.
Independent review corrected a scope-versus-implementation false positive: a
required capability must be granted AND represented in the generic endpoint
registry. This still does not prove resource authorization or enable any writes.
The earlier readiness and command-consumer suites passed 78 synthetic-response
tests; the application-identity increment adds new cases below.
Directory readiness requires method/path/capability tuples and explicit source
and application precondition enforcement for both client and organization commands, not just
any endpoint with a matching scope. It must be joined to
the durable per-instance configuration, retries and outage policy only after
the replacement contract and owner-reviewed PA release are ready.

Directory mutation/ownership work is tracked in the separate
[writer inventory and cutover gates](directory-authority-migration.md).
The old source observations below are baseline evidence; where this checkpoint
supersedes one, do not mistake the baseline for current completion status.

### Command-consumer integration constraints

The current candidate command response is
`{sourceInstanceId,applicationId,replayed,result:{resource,data},requestId}`.
`resource.id` is the caller's exact external ID, while `data.publicId` is PA's
permanent public ID. Do not confuse them or convert revision strings to JavaScript
numbers. Update acknowledgments must agree with the already mapped PA public ID.
The caller persists a command before transmission and retains its exact identity
and payload after uncertainty; the transport must not generate a replacement ID.

A lost response, broken body, malformed success or upstream server failure can
occur after commit. Such outcomes cannot mark the command rejected or invent a
new create request. Conflicts require review; current credential/resource denial
does not erase a pending command or unlock PA local editing. The local transport
is now exercised by a local durable Ops outbox and materializer; it is not
connected to either production instance or a deployed scheduler.

**Source identity is enforced in the local candidate:** directory readiness
requires both endpoints to advertise `requiresSourceInstanceId: true`; missing
or false declarations block before POST. Ops sends the configured canonical
UUID in `X-PA-Source-Instance-ID`. PA compares it through a current locking read
inside the command transaction, after current policy/resource authorization and
before receipt replay or mutation. The sequence/identity lock is held through
commit. Missing, malformed and mismatched headers return 428, 400 and 412
respectively. Successful responses carry the verified identity and Ops checks
it again before acknowledging. Neither probe success nor an old endpoint that
ignores the header is sufficient. This remains unwired and unreleased; the local
joined rehearsal below is verified, while pinned deployment acceptance is still
required.

**Application identity is also required in the current candidate.** Capabilities
must report the authenticated application's public UUID and advertise
`requiresApplicationId: true` on both command endpoints. Ops pins
`expectedApplicationId`, sends `X-PA-Application-ID`, and rejects acknowledgment
from another application even on the correct PA instance. PA must extract this
header in its real front controller, compare it with the authenticated principal
and preserve that identity through transactional credential recheck before receipt
lookup or mutation. Missing, malformed and mismatched values use 428, 400 and 412.
Credentials can rotate within the same application; application transfer requires
explicit reconciliation because PA receipts/bindings use a different namespace.

This addition is not yet covered by the successful historical joined run below.
The first fresh joined run failed all six cases because the front controller did
not forward the newly required application header to the dispatcher, despite
passing dispatcher unit tests. The corrected adapter and expanded joined run
passed seven tests / 173 assertions. The final extension passed seven tests /
181 assertions, with an equally resource-authorized second application's token
denied before replay and same-app credential rotation retaining the receipt.
Production acceptance remains separate from these disposable tests.

**Update target identity is required as well.** Organization and client update
commands require `expectedPublicId`, the exact lowercase 32-hex PA public ID
previously mapped for that customer. Create commands omit this field and reject
it if supplied. This is separate from the app-scoped `externalId` and the
`expectedRevision`: neither of those alone proves the intended target.
PA compares the expected public ID with its transaction-resolved external binding
before mutation or receipt replay, and includes the field in the durable command
fingerprint. A mismatched target returns `409 COMMAND_CONFLICT` without changing
the customer. Invalid/missing update fields return `400 INVALID_COMMAND`.
Ops persists its local `expectedProjectAlphaPublicId` and serializes it as
`expectedPublicId`, preserving it across retries. Both endpoint capabilities must
advertise `requiresUpdatePublicId: true`, otherwise Ops blocks before POST.
The paired local change passed the joined HTTP/MySQL suite with **7 tests / 181
assertions** after updating a managed-owner test fixture to use its own create
response ID. These are local contract results, not production cutover evidence.

### Joined directory consumer/producer rehearsal

The real Ops TypeScript consumer now has an opt-in test against the real PA
front controller and disposable MySQL. The loopback HTTP test server is behind
a loopback HTTPS terminator, and the test-only fetch adapter explicitly trusts
only the fixture certificate at that listener's exact origin. Production HTTPS
validation is unchanged; no disabled TLS verification or live credentials are used.

The joined run verifies readiness, organization/client creation and updates,
source headers, no cookies, and a stale revision conflict. For response-loss
testing the proxy discards the complete upstream create response before closing
the client socket; retrying the same command returns its existing receipt.
PA SQL readback proves one organization, one linked client, two exact external
bindings, four command receipts, five successful attempts and one conflict audit.
External IDs are checked through bindings, never equated to generated PA IDs.

Parent execution of the existing HTTP suite plus this joined case passed
**6 tests, 144 PA assertions, no skips**, exit 0. The default Ops synthetic
selection remains **78 passed**, with the joined case explicitly skipped unless
the disposable sentinel and loopback endpoint are supplied. The disposable
container was removed and label-filtered readback was empty. This tests the
consumer library and producer together, not a deployed Ops scheduler/outbox.

Run from the PA worktree with explicit local tool/checkouts:

```powershell
./tools/run-generic-directory-http-mysql-integration.ps1 `
  -PhpBinary '<local PHP executable>' `
  -OpsRoot '<Ops checkout>/apps/operations' `
  -NodeBinary '<local Node executable>'
```

Without the two joined arguments, the runner excludes the joined group and
continues to run its original five HTTP cases. The runner requires disposable
database sentinels, restores environment values, and cleans only its exact
name/label-owned container. PA publishing, durable Ops command persistence,
source reconciliation, authority cutover, and both-instance acceptance remain open.

## Source checkpoints and existing behavior

- PA working tree starts from `a641fadc3742dff3d11eabb86c0e3797f398f989`; fetched `origin/main` at `51e333fb2ca2e26248b3f96588b8c126f4a2832b` had the same committed tree. The in-progress retention patch is additional local work, not a published release.
- Ops working tree starts from `ba56d72a41cc1bfde2836c0e1ea75929f107a675`; PR47 is merged as `6752ee2cf8f69bdb8221f7b02a6a68962eb3f28d`. Preserve unrelated local changes and private temporary backups.
- PA `src/utils/api_auth.php::api_require_key` already accepts a hashed bearer key, enforces revocation, requested scopes and optional exact IP restrictions, and represents the key as a service principal without synthesizing an administrator login. Reuse those boundaries, not an interactive user session.
- PA `src/utils/api_scopes.php` currently maps broad legacy aliases, including `read`, to `full`; `full` may satisfy a requested scope. Its form describes current and future endpoints. `src/utils/api_keys_schema.php` also repairs empty scopes to `full`. These are **legacy compatibility semantics**, not permission to give those keys future write/admin powers.
- The examined PA API key schema/authentication path lacks a separate durable application identity and token-expiration check. A rotating key ID is therefore not an adequate ownership or replay identity for the new contract.
- Creating a service-principal object is not yet sufficient end-to-end: `public/index.php` starts a browser session before routing, and `src/controllers/api/projects_list.php` still calls the browser `scope_clause` with the session user. The client-list API instead builds a directory query without an application-resource predicate. New APIs need explicit service-principal authorization in their handlers, independent of whether the request happens to include a browser cookie; existing read behavior must be audited rather than assumed reusable unchanged.
- `/api/v1/workforce` and `/api/v1/catalog` are currently browser/session controllers, not ordinary token-scoped routes. Preserve their current actor/CSRF semantics while building a separately versioned token path; do not silently reinterpret a session mutation as a service-account operation.
- `SyncContractV2Service` has installation IDs, resource-state versions, event storage and snapshot sessions, but no complete generic changes endpoint. Its snapshot reads `MAX(sequence)`; the existing `docs/reference/sync-contract-v2.md` explicitly gates production on solving late-commit event ordering. Reuse the primitives, not the unproven checkpoint assumption.
- Ops already reads PA snapshots by API key in `apps/operations/src/worker/project-alpha.ts`. The same module still writes PA-owned staff status and identities. Merely changing the signed-event receiver would leave a competing staff authority active.
- The signed receiver in `apps/ops-sync/src/index.ts` handles ordinary projections, staff entitlement events, portal projections and managed delivery intents; it also reconciles the Access group. Each responsibility needs an explicit replacement or retirement, not deletion of only the visible settings page.

## Authentication and ownership design

- Keep one generic API authentication model: an explicit external application has one or more independently revocable, expiring tokens. Rotating a token preserves application identity, command receipts and management ownership. Keep token values hashed at rest and out of logs; show the secret only at creation.
- Add an explicit policy/contract version to distinguish new exact-scope keys from legacy keys. New write endpoints must require the new policy and explicit capabilities. Old `full`, `read` aliases and schema repair must never manufacture new capabilities. Preserve the currently authorized legacy endpoint set during preparation, then deliberately retire obsolete endpoints at cutover.
- Avoid a future-expanding wildcard for new tokens. An administrator may explicitly select all currently defined capabilities; adding a new capability later does not silently add it to existing tokens.
- Keep resource filters separate from action scopes. A token with a client-write capability still needs authority over the selected directory/resources. An Ops-to-PA application does not inherit user administration, payment execution or API-key administration merely because it needs customer and project writes.
- A token-authenticated handler must use only its explicitly resolved application/resource principal. An unrelated signed-in browser must neither expand nor reduce that token's authority, supply its audit actor or change the response dataset. Keep interactive PA routes separately session-authorized.
- Keep separate credentials/application records in each PA instance. PA has no built-in concept of LTDS/LTT or a required second instance. Ops maintains the external instance identifier and routing.
- Generic managed-directory policy belongs to the durable application, not its token. Enabling requires a usable explicitly capable writer and administrator confirmation. Subsequent token expiry/revocation leaves a visible disconnected, read-only directory until an administrator deliberately transfers management; it must not silently unlock forms/imports/onboarding.
- Management policy and ACL checks run on every server-side mutation path, including forms and bulk imports. Hiding create/edit controls is a UX consequence, not the enforcement mechanism.

## Minimal contract families

| Family | PA responsibility | Ops responsibility | Essential constraint |
| --- | --- | --- | --- |
| Capabilities and health | Report supported version and permitted capabilities without secrets | Per-instance compatibility/health checks | Unsupported version is not a transport retry or a healthy connection |
| Customer directory | Generic managed read/write resources and stable IDs | Canonical customers, units, bill-to mappings and onboarding | Explicit management transfer; no matching by name/email alone |
| Projects | Create/read/versioned edit; own financial fields | Create/read/versioned edit; client proposals and operational work | One-to-one mapping; no implicit public/document grants |
| Worker and approved work records | Financial worker references independent of PA login; receive reviewed revisions | Capture, attest and independently review project or internal work | Beneficiary differs from actor; replay cannot duplicate pay-eligible work |
| Catalog, pricing and compensation | Versioned financial rules and authoritative calculations | Service availability and authorized previews/selections | No paid/invoiced state inferred from a preview or approval |
| Documents and public links | Authorized financial reads and existing action links | Scoped portal presentation and activity | No link creation/revival or receipt email on a read |
| Changes and command status | Durable resource revisions, change cursor and request-result lookup | Durable per-instance consumer cursor, retries and conflicts | No lost edits on timestamp ties or response loss |

The exact scope names, request limits and wire schemas remain implementation details to pin and test. The table does not authorize broad new token permissions or client visibility.

## Mutation and change-feed rules

- Use opaque permanent resource IDs and source-qualified mappings. Shared names are mutable; identities are not.
- Each command has a durable caller-generated ID scoped to application, operation and target. Persist its canonical request digest and result with the business mutation. Same ID/same input returns the prior result; same ID/different input is a conflict. Token rotation cannot create a new replay namespace.
- Authenticate and recheck current scope/resource authority before returning a replayed result. A revoked token does not regain access because it knows an old command ID. Record attribution without treating a caller-supplied employee ID as a PA administrator.
- Require an expected revision for shared-field updates; a stale revision produces a conflict, not an overwrite. Create-with-external-ID and command-result lookup prevent duplicate records after an uncertain response. Parent/child creation must preserve mapping order and transaction boundaries.
- Write a change entry in the same PA transaction as every in-scope mutation, including normal PA project forms. Use an ordered database cursor rather than wall-clock timestamps alone. Include resource ID, revision, change kind and origin; do not include bearer URLs or secrets in the general feed.
- Cursor order must reflect a proven committed prefix, not merely the highest visible auto-increment ID. A lower-ID transaction may commit after a higher-ID transaction; a consumer that checkpoints past it could lose a change. Resolve with a consistently ordered transaction-held sequencing lock or another proven mechanism, and exercise two MySQL writers plus a reader through delayed commit, rollback and replay before enabling consumption.
- Ops consumes idempotently and records its cursor only after durable application of the page. An echoed command is recognizable, but a later PA edit is not discarded merely because the object originally came from Ops.
- Define bounded pagination and a consistent snapshot watermark. If a cursor has aged out, report a resnapshot requirement; do not silently omit the gap. Snapshot recovery must preserve revocations and detect records removed while offline.
- Established project deletion is not an Ops API operation. Protect history in PA's normal controller too. Future removal semantics require an explicit durable tombstone and retention policy; archive/personal hide must not delete invoices, grants or files.
- PA outage does not freeze native Ops. Pending commands remain pending; retries never claim success prematurely. Alert once per instance after ten continuous minutes and record recovery. Keep PA financial data timestamped and disable actions that lack current authority.

## Existing consumer retirement map

| Existing responsibility and source | Replacement / disposition |
| --- | --- |
| Staff writes in `apps/operations/src/worker/project-alpha.ts` and `apps/ops-sync/src/projection.ts`; Access reconciliation in `apps/ops-sync/src/access-group.ts` | Ops-local admission/scoped permissions. Fence both snapshot and event writers together before enabling Ops-owned staff changes. Preserve existing owner access. |
| Business snapshots and root grouping in `project-alpha.ts`, `business-parties.ts`, `business-party-workspace.ts` | Canonical directory with preserved source-qualified mappings and explicit reconciliation; grouping alone is not identity ownership. |
| `apps/client/src/worker/project-alpha-portal.ts` and related source/authority/ingress modules | Ops-owned workspace identities, denials and grants after verified migration. Preserve existing IDs or explicit mappings; no default re-enabling of revoked people. |
| `project-alpha-catalog.ts`, `project-alpha-service-assignments.ts` | PA financial catalog reads plus Ops-owned service enrollment/availability. Preserve assignment history until replacement semantics are tested. |
| `apps/operations/src/worker/project-alpha-draft-quote.ts` and Client `project-alpha-pricing-hint.ts` | Generic explicit pricing/draft capabilities with durable replay and separate approval. Keep current financial side effects protected during preparation. |
| `project-alpha-delivery-intents.ts` and its entry point | Preserve existing delivery authority/history; replace the producer mechanism deliberately. API migration must not revoke or republish existing client public links. |
| `project-alpha-project-management.ts` PA navigation action | Both-origin project API synchronization; PA financial editing may still use a normal authorized PA link. A deep link is not evidence of project sync. |
| Existing incoming, feedback and delivery notification producers | Keep unique Ops notifications; remove only duplicate PA financial email producers after an event/recipient/channel inventory. |

This is an initial source-backed map, not a claim that every cron, compatibility endpoint, database trigger and settings field is already inventoried. M02 is incomplete until those remaining paths have owners and executable joined fixtures.

## Next executable acceptance

- Legacy tokens cannot call new writes; explicit new scopes cannot exceed resource filters; unknown scopes fail closed.
- Expired/revoked keys fail; token rotation preserves application management and idempotency; last-token revocation does not unlock PA directory edits.
- Cookie-less and cookie-present requests with the same token resolve the same allowed records; application/resource mismatches fail. Audit stores actual application/token/request/actor attribution and does not silently claim a browser administrator made the API change.
- Lost response, duplicate commands, digest mismatch, stale revision, cursor pagination boundary and resnapshot recovery are tested in both applications against the same fixtures.
- PA forms and API edits publish consistent project changes while issued documents retain their historical data.
- Independent time review survives on-behalf edits and corrections; neither submission nor a duplicated command creates duplicate compensation/invoice allocations.
- Public delivery tokens, hashes, passwords, expiry/revocation and ranged archive downloads survive the rehearsal unchanged. Use synthetic fixtures, never customer bearer links in artifacts.
- Retention review must cover numeric and opaque project references, public links, planning records, finance and immutable work history. Current-record checks alone do not prove safety against non-FK writers; MySQL concurrency and writer fencing remain a release gate.
