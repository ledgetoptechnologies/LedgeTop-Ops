# Workspace customer and project grouping

This component stores Viewer-owned display metadata. An organization represents
a workspace customer; an optional group categorizes that customer's projects.
Tasks continue to belong to their existing projects. Legacy projects remain
unassigned until an authorized operator assigns them.

These records do not grant model access, change Operations client membership,
or create shares. Identical names do not merge records. Organizations and groups
receive independent UUIDs, and a group can only be assigned within its own
organization.

## API

All requests use the existing staff authentication. Reads require
`viewer.projects.read`; writes require `viewer.projects.write` and the existing
idempotency key. Mutations and audit records commit in the same transaction.

| Operation | Route |
| --- | --- |
| Paginated organizations and groups | `GET /api/v1/processing/hierarchy` |
| Create organization | `POST /api/v1/processing/organizations` |
| Rename or archive organization | `PATCH /api/v1/processing/organizations/:id` |
| Create group | `POST /api/v1/processing/project-groups` |
| Rename or archive group | `PATCH /api/v1/processing/project-groups/:id` |
| Assign or clear a project's grouping | `PATCH /api/v1/projects/:id/hierarchy` |

Creation takes `displayName` and, for a group, `organizationId`. Metadata updates
take `expectedRevision` plus `displayName` or `status`. Assignment takes all three
fields: `organizationId`, `groupId`, and `expectedRevision`. Null identifiers
clear an assignment. A stale revision returns 409. Unknown fields are refused.

Project DTOs add `organizationId`, `groupId`, and `hierarchyRevision`, initially
null, null, and zero. Existing project, dataset, task, model and access records
are preserved. Archiving an organization preserves historical assignments but
prevents new assignment into that archived organization. There is no destructive
hierarchy-delete endpoint.

## Migration and integration

The isolated component uses migration **42**, named `viewer_workspace_hierarchy`.
Version 41 is reserved by the separate GCP work. The migration runner checks each
version individually, so a later lower independent migration is not skipped just
because 42 is present. Final integration must still test the actual GCP migration
and concurrent API/worker startup against the chosen release base.

The repository checks the hierarchy migration identity and table footprint before
its preset initialization. A conflicting version or an old private hierarchy
footprint is refused; it is not silently adopted or renumbered. A schema without
the component retains the legacy unassigned DTO defaults.

This source branch selectively reuses the hierarchy component from `ccb24bef`.
It does not merge the older reference-provider branch. It is prepared on the
upload-fixed main commit `4b4f7075` and has not been deployed.

## Verification and remaining acceptance

The hierarchy and migration suites passed 18 tests, including actual HTTP
authentication, idempotency, revision conflicts, cross-organization rejection,
legacy row preservation and concurrent migrations. Another 69 processing,
sharing, output-retention and workspace lifecycle tests passed.

A separate disposable test used the authenticated API, real SQLite and Claude's
actual `workspace-hierarchy.mjs` module: three one-item pages, two synthetic
customers, two projects and two draft tasks. The assignments survived a second
database connection and access grants were unchanged. This proves API-to-grouping
interoperability, not rendered browser usability.

Current-main reconciliation, actual GCP-schema interoperability, independent
review, the workspace's create/assign controls, desktop/mobile rendering and
operator acceptance remain release gates. TrueNAS installation remains under
Beau's control.

## Migration identity preflight

The combined candidate reserves migration 41 for GCP confirmations and 42 for
workspace hierarchy. Startup checks their recorded names and exact SQLite
creation statements before changing journal mode or applying migrations. It
also refuses unrecorded protected objects and unexpected explicit indexes or
triggers on those tables. An incompatible ledger or schema must be investigated
without automatically rewriting it. The check is deliberately strict: harmless
DDL formatting changes, local extensions, or future intentional schema changes
may require an explicitly reviewed compatibility update. It does not establish
the integrity or correctness of existing rows, backups, or unrelated schema.
