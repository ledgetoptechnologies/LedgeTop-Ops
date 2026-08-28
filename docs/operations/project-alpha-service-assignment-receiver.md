# Project Alpha service-assignment receiver foundation

The Delivery Worker can store Project Alpha service-assignment facts in
`DELIVERY_DB`. This foundation is deliberately non-authorizing: it does not
filter the client catalog, enable requests, create invitations or memberships,
grant file access, infer assignments, or change any Operations policy.

## Ingress contract

The two POST-only routes are:

- `/api/internal/project-alpha/service-assignments-v1` for the reserved primary source.
- `/api/internal/project-alpha/sources/:sourceId/service-assignments-v1` for an active registered source authority.

Both routes are hidden unless `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED`
is exactly `true`. Requests retain the existing Project Alpha Access and HMAC
requirements, including an exact signed path, timestamp, application key,
delivery ID, key ID, body digest, and signature. The body is streamed with a
256 KiB limit and a ten-second read deadline.

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
