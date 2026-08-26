# Multiple Alpha sources: isolation before activation

Status: staged implementation sequence; no second connection is enabled. The
first local catalog-provenance increment is described in
[catalog source isolation](catalog-source-isolation.md). The next local business
projection increment is described in [business source isolation](business-source-isolation.md)
and is verified locally but unpublished. Delivery account/project ownership is
covered in [Delivery source provenance](delivery-source-provenance.md); native
workspace ownership and transactional projection replay are covered in
[native portal source ownership](portal-source-ownership.md). These are separate
local increments, not second-source activation. The
original gaps below were audited against local Operations checkpoint
`f055b2c` on August 26, 2026. This document
does not authorize a second connection, change staff roles, or replace the
[client workspace roadmap](client-workspace-roadmap.md).

## Why another connection cannot be enabled yet

The source-qualified Client Hub URLs protect the current directory's identity
namespace. They do not make its upstream stores multi-source. In the current
code, a second producer could collide with the first even when their client
names differ. The following are implementation constraints, not evidence of an
incident or an assertion that a second producer is currently connected.

| Boundary | Current evidence | Required isolation |
| --- | --- | --- |
| Operations snapshot | The audited baseline used global external IDs and coordination keys. Local `0033` and the paired snapshot/event code now carry source context and immutable local handles; populated upgrade and primary compatibility checks passed locally. | Release the paired schema/code safely; bind future calls to an authenticated source registry before activation. |
| Staff authority | The same snapshot rebuilds Project Alpha-managed staff roles/divisions. `apps/ops-sync/src/projection.ts` processes entitlements against the same staff projection. | Preserve the existing authority explicitly. A business-data connection must not gain staff-role, Access-group or identity-management authority. |
| Delivery legacy mapping | Local `0157` source-qualifies Alpha client, organization and project references while retaining local account/project/grant IDs and URLs. | Release paired schema/consumers safely; source-aware outbound routing remains separate. |
| Service catalog | The released schema has one checkpoint and global catalog state. Local migration `0156` now source-qualifies the catalog, saved request parents and selections; public ingress remains primary-only. | Verify and deploy the compatible migration/code together before any registry or second-source activation. |
| Portal projection | Local `0158` reserves source-owned local workspace handles, source-qualifies native roots and replay receipts, and guards authority writes against stale checkpoints. Populated migration and paired primary-consumer checks passed locally. | Release paired schema/code safely; implement the authenticated source registry and remaining delivery-intent/guest receipt boundaries before activation. |
| Client Hub | Local migration `0034` and the paired readers/index extend source-qualified business roots; secondary business roots cannot infer a primary portal/account bridge. Source-pinned backend and browser checks passed locally. | Apply the coordinated release and live acceptance gates. Business display is not portal activation. |

## Identity and authority contract

Maintain separate records for:

1. An immutable local connector identity and its verified producer/configuration.
2. Source records identified by connector, record kind and exact external ID.
3. An Operations business party, with explicitly reviewed links to source records.
4. A verified login identity and its independently authorized memberships/grants.

A display name, URL hostname, email, role label, raw numeric ID or matching public
ID is not sufficient to merge records or confer authority. Connector display
names and endpoints may change only through controlled configuration; changing
the endpoint must not silently reassign existing data to a different producer.
The existing `project-alpha:primary` namespace must keep its existing meaning.

Resolve source identity from the authenticated connection and its configured
scope, not from an untrusted body/header alone. Where the signed wire contract
contains an application/source identifier, require an exact match to the
connection's authorized identity. Preserve independent capability checks for
business projection, catalog, portal eligibility and staff administration even
if the administrator sees one connection form per Alpha instance.

The existing `applicationKey` identifies an application; it is not a durable
Alpha-instance identifier. Current/previous signing keys are a rotation pair for
one authority, not two connector identities. A future source registry must bind
the verified connection to its producer and allowed workspaces explicitly. Do
not reinterpret an existing field or add a body-only `sourceId` and call it
authenticated provenance.

Linking two source customers changes the operational presentation only. It must
not merge portal workspaces, infer issuer/subject equivalence, union staff roles,
copy resource grants, change invoice recipients or enable notifications. Reads
must authorize each contributing source/resource before returning it. A linked
party cannot turn an unauthorized source's project into authorized history.
Preserve the global verified identity key `(issuer, subject)`; adding a business
source must neither duplicate that person per connector nor merge distinct
issuer/subject identities because their email matches.

## Implementation order

### A. Compatibility and migration specification

- Inventory every source-bearing relationship, including operation/task
  assignments, calendar references, private Job Brief/SOP ownership, portal
  bridges, delivery intents, request/catalog snapshots and feedback provenance.
- Define one stable primary-source adoption; do not guess existing provenance
  from emails or names. Ambiguous/missing mappings remain unavailable for review.
- Specify additive staging/backfill and a primary-source compatibility resolver
  before changing existing reader keys. Never rerun a historical migration with
  new SQL or blindly prefix persisted foreign keys.
- Record source ownership on every new receipt/version/lease and preserve old
  receipts for the exact original source. Replay in source A must not suppress
  an unrelated event with the same ID in source B.
- Keep a second producer disabled throughout migration. A partially source-aware
  schema is not a safe activation checkpoint.

### B. Source-scoped ingestion and reconciliation

- Carry source context through both snapshot and event ingestion, including
  deactivation, dependency traversal, health, retry, version ordering and locks.
- A full snapshot for A may deactivate absent A rows only. Replaying A while B
  is syncing must neither block B unnecessarily nor overwrite B's versions.
- Treat Operations and Delivery databases as separate commit boundaries. Use
  resumable, idempotent adoption/reconciliation with readiness checks; do not
  claim a D1 batch is atomic across both databases.
- Preserve last-known-good source state on incomplete/unstable snapshots.
- Reconcile staff roles/Access membership only for an explicitly authorized
  staff authority. No second source receives that capability by default.

### C. Portal, service and business-party consumers

- Bind native and legacy portal roots, eligibility proofs and source public-ID
  mappings to the same verified connector identity.
- Preserve the exact workspace/identity/account intersection of migrations
  `0132_portal_v2_legacy_member_bridges.sql` and
  `0145_portal_identity_eligibility.sql`, including invitation-owned bridge
  restrictions. Eligibility still supplies no content permission; business
  linking must not create or transfer a compatibility bridge.
- Make catalog activation and immutable request selections source-qualified;
  retain the original source/version on saved drafts, feedback and business
  history. Route a new request back to its owning source, not the first available
  connector or whichever catalog was activated last.
- Include migration `0117_service_request_v2.sql` in the catalog adoption plan:
  catalog rows use `(public_id, source_version)` and one active row per public ID;
  draft/submitted service snapshots have no connector identity. Adopt explicit
  primary-source provenance without rewriting their service IDs or historical
  snapshot content. These snapshots do not have catalog foreign keys, so changing
  catalog keys alone cannot repair their provenance.
- Pin outbound pricing/quote commands and delivery provisioning to the verified
  source too. Existing `project-alpha-draft-quote.ts`,
  `project-alpha-pricing-hint.ts` and `project-alpha-delivery-intents.ts` use one
  configured authority. Never send a source B request, customer reference or
  credential to source A because a scalar configuration remains as a fallback.
- Add explicit business-party linking/unlinking with preview, authorization over
  both records, optimistic concurrency, idempotency and immutable audit events.
- Keep service capability visibility distinct from content permission. Missing
  authoritative per-client service assignments must be labeled unavailable, not
  inferred from a customer name, folder or broad catalog membership.
- Update bounded directory/detail reads and URL/cursor state together. Preserve
  primary-source deep links and reject ambiguous legacy identifiers rather than
  selecting a source implicitly.

### D. Acceptance and controlled activation

Use populated local migrations and independent synthetic sources first:

- Same internal ID, public ID, email, role label, event ID, generation and sequence
  in A and B remain separate throughout ingestion, pagination and replay.
- A tombstone, missing-row sweep, service activation or grant revocation in A
  leaves B's records, active catalog and access unchanged.
- A data-only source cannot create a staff administrator, reassign a primary
  source staff identity or modify the Access group.
- Linking/unlinking changes no access, invoice, subscription or invitation;
  unauthorized source content stays hidden before pagination and hydration.
- Existing primary-source account/project/asset URLs, grants, drafts, Job Briefs,
  feedback history and receipt retries continue to work after migration.
- Interrupted backfills, two-source concurrent ingestion, stale cursors, source
  unavailability and rollback preserve authoritative data and report clear state.
- Browser acceptance covers onboarding, find/open, source labels, link preview,
  cancel/retry/conflict, request routing, refresh and Back/Forward at narrow and
  wide layouts. No live invitations, messages or access mutations for QA.

Only after all producer/consumer contracts and authorization gates are accepted
should a second source be configured and tested with separately authorized live
data. No Viewer or thumbnail runtime change is needed for this design.

### First bounded implementation candidate

After settling authority/provenance policy, catalog isolation is a smaller
complete vertical slice than converting every Operations relationship at once.
Keep all existing public endpoints server-bound to `project-alpha:primary` and
keep a second receiver disabled. Migrate catalog keys/checkpoints/receipts and
draft/submitted selection provenance together, then update every catalog reader,
activation, tombstone, page proof and transaction-time request guard. Test two
synthetic sources at the storage/consumer boundary without exposing a new source
selector or changing existing primary API behavior.

Extend `project-alpha-catalog-projection.test.ts`,
`service-catalog-page.test.ts` and `service-request-v2.test.ts` with populated
upgrades, source collisions, independent activation, source-pinned cursors and
submission, immutable old requests and key-rotation preservation. This would
complete catalog isolation only. It would not authorize second-source activation
before the other ingestion, staff, portal and Delivery boundaries are verified.

## Decisions and release prerequisites

- **Staff authority decision pending:** should the existing Drone Services Alpha
  remain the only staff-role authority, with Technologies supplying business,
  client and service data? The question was sent to the user August 26. No answer
  has been assumed. Multiple staff authorities require a separate conflict,
  deny-precedence and ownership policy, not a union of role labels.
- **Alpha publication remains approval-blocked:** the additive v1 public-ID
  export is local commit `38dc6c81` on `codex/client-source-public-ids`. Do not
  retry its rejected publication without renewed approval. After an approved
  release, verify normal sync carries public IDs before claiming production
  business-to-portal mapping. This is a prerequisite for the current directory,
  not proof that the multi-source design is implemented.
- **Project-memory write policy remains separate and unresolved:** see
  [project-memory-design.md](project-memory-design.md). Do not treat assignment
  as implicit permission to edit plans, contacts or another person's notes.
- **Current local release bundle:** directory/detail, contacts, folder counts,
  notification batching, service-request UX and generic feedback are committed
  locally through `f055b2c`, but are not deployed. Preserve the documented
  migration/backfill/rollback gates and do not bypass the Alpha prerequisite by
  labeling synthetic browser tests as live acceptance.

The design audit does not complete the broader goal. Subsequent implementation
and verification evidence is recorded in the linked increment documents; no
production verification or second-connection activation is claimed here.
