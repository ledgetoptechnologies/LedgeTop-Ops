# Project Alpha service-assignment receiver foundation

The Delivery Worker can store Project Alpha service-assignment facts in
`DELIVERY_DB`. This foundation is deliberately non-authorizing: it does not
filter the client catalog, enable requests, create invitations or memberships,
grant file access, infer assignments, or change any Operations policy.

## Ingress contract

Project Alpha sends service assignments only as
`projection_kind: "service_assignments"` inside the existing signed Ops Sync
`portal.projection` envelope. Ops Sync binds the authenticated source, records
the outer receipt, and privately dispatches the exact inner v1 body to Client.
The Client Worker exposes no public service-assignment write route.

Private dispatch is hidden unless
`PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED` is exactly `true`. The inner
body retains its 256 KiB limit and strict delivery ID, application key, source,
and schema checks.

The shared v1 item is intentionally identical to the producer contract. It has
`assignmentPublicId`, `sourceVersion`, `subjectType`, `subjectPublicId`,
`servicePublicId`, `serviceSourceVersion`, `active`, `effectiveFrom`, and
`effectiveUntil`. There is no workspace field on the wire. The checked-in
fixture at `packages/shared/fixtures/project-alpha-service-assignments-v1.json`
is the semantically identical, exact contract fixture from the verified PA
producer (repository line-ending normalization may change its raw file hash).

## Independent receiver admission

Migration `0168_project_alpha_service_assignments.sql` creates no grant or
workspace rows. A delivery requires all of these independent controls:

1. The global receiver flag is enabled.
2. The existing portal source authority is current and active.
3. `pa_service_assignment_receiver_grants` contains an active, exact
   `portal.service-assignments.publish` contract-v1 grant for the source.
4. `pa_service_assignment_receiver_workspaces` contains at least one active
   workspace for that source, backed by the immutable
   `pa_portal_workspace_sources` ownership reservation.
5. Every item subject exists in the complete active directory generation of
   exactly one active allowed workspace for that source.

Zero matching workspaces, multiple matching workspaces, inactive directory
state, missing schema, or partial proof all fail closed. Empty snapshots still
require an active receiver workspace. Snapshot activation re-resolves every
staged subject. The last statement in each D1 batch rechecks the source
authority, receiver grant, workspace allowlist, active directory checkpoint,
generation, and entity, causing the batch to roll back if admission changed.

Observed producer support is stored separately in
`pa_service_assignment_source_capabilities`; it is diagnostic evidence only
and never substitutes for a receiver grant.

## Storage and replay guarantees

Snapshots are page-, count-, and ordered-hash verified before an atomic
activation. At most eight incomplete staging generations may exist per source.
Events must advance the active source checkpoint by exactly one sequence.
Receipts are source-qualified and immutable: an exact replay is idempotent,
while the same source and delivery ID with different bytes is rejected.
Assignment source versions cannot be reused for different content. Tombstones
must match a previously stored current entity version; a never-seen tombstone
is rejected because its subject containment cannot be proven.

## Coordinated enrollment and rollback

Applying migration 0168 alone remains inert. A later, separately reviewed
release must enroll an exact source grant and its exact source-owned workspace
allowlist, verify producer/receiver fixture parity in isolated staging, and
only then enable the runtime flag. Do not infer allowlist rows from observed
capabilities or directory data.

Rollback the receiver by setting the flag back to `false`. Suspending the
source grant or individual receiver workspace is an additional fail-closed
control. Retain stored facts and immutable receipts/audit records for diagnosis;
this foundation defines no production cleanup or downstream policy behavior.

A separately reviewed, default-off downstream consumer can now narrow service-
request choices from these facts. It is not implied by the v1 wire contract and
does not change this receiver's non-authorizing boundary. See
[Project Alpha service assignments as request availability](client-service-assignment-request-policy.md).

## Staff Client Hub read model (local follow-on, not deployed)

The prepared Operations follow-on adds a read-only **Project Alpha service
assignments** card to an exact Client Hub business record. It requires both a
global `team.view` scope and a global `operations.manage` scope. The card is
informational: an assignment does not grant portal access, enable a service
request, create delivery or Viewer access, or expose pricing.

The read is deliberately narrower than the receiver workspace. An organization
card selects only `subject_type='organization'` and that exact exported public
ID; a standalone-client card selects only `subject_type='standalone_client'`
and that exact exported public ID. It never rolls up projects, departments,
children, parents, linked business-party records, email addresses, names, or
the rest of a workspace. A project workspace may later expose its own exact
project assignment, but the client card does not do so.

Before returning facts, the Worker verifies all of the following in
`DELIVERY_DB`:

- migration 0168's required tables exist;
- the exact source receiver grant and exact source/workspace enrollment are
  active;
- the workspace ownership reservation still matches the source;
- the current, complete directory generation contains the exact active root
  subject; and
- the assignment checkpoint identifies a complete active generation.

Missing schema, enrollment, mapping, workspace, directory proof, or projection
checkpoint is returned as a factual unavailable state rather than an empty
history or a crash. The source-capability observation remains diagnostic and
does not authorize the read. If the same-source active catalog item still has
the assignment's exact service source version, its current name is shown;
otherwise only the opaque service ID is shown.

Initial detail returns at most five rows; continuation returns at most 25.
Opaque cursors bind the staff actor through a one-way selection proof plus the
source, exact root, null project scope, Client Hub context, filters, and active
assignment checkpoint. Raw staff IDs are not serialized into cursors. After
the assignment read, Operations rechecks the receiver enrollment, workspace
ownership, current directory generation and root version, source observation,
and assignment checkpoint. It then rechecks the independent live Client Hub
context after the cross-D1 read. Any change invalidates the whole client
workspace instead of releasing a mixed-authority result.
