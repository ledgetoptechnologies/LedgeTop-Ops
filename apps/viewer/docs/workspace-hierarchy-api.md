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
| Create a project for an active organization | `POST /api/v1/processing/organizations/:organizationId/projects` |
| Rename or archive organization | `PATCH /api/v1/processing/organizations/:id` |
| Create group | `POST /api/v1/processing/project-groups` |
| Rename or archive group | `PATCH /api/v1/processing/project-groups/:id` |
| Assign or clear a project's grouping | `PATCH /api/v1/projects/:id/hierarchy` |

Customer-bound project creation uses the normal project-write permission and
required idempotency key. Its closed body accepts `displayName`, optional
`description`, and optional `defaultUnits`. Project insertion, assignment to
the selected customer with no group, and the audit event commit in one database
transaction. The response includes the project with its exact organization ID
and hierarchy revision.

The project ID is deterministic for the authenticated admin session, request
subject, request key, and request hash. The exact 201 response receipt commits
in the same transaction as project insertion, customer assignment, and audit.
It remains available across admin-session renewal and project rename/archive,
so a retry replays the original response instead of inferring it from mutable
project state. After the normal seven-day response retention, the receipt is
redacted to a small `410 idempotency_result_expired` tombstone, preventing a
late retry from creating a duplicate without retaining the old project
details; after that response, the caller must locate the project in the
workspace. The UI derives the key from the customer ID and request body, so
the same request can recover without tab-session storage. A changed request
using the same key conflicts. Archived or missing organizations fail without
leaving a project, assignment, or audit record.

Active project names are unique within a customer, regardless of group. The
same name may be used under another customer. Legacy unassigned projects keep
their own uniqueness scope, and customer assignment, rename, and restore all
enforce the destination scope.

The list accepts `limit` from 1 to 100 and returns an opaque `nextCursor` when
more records remain. The workspace requests 100 per page and follows cursors,
with a hard stop at 100 pages (up to 10,000 combined organization and group
records). If the bound is reached, grouping reports an error instead of showing
a silently incomplete hierarchy.

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

This customer-project creation candidate is based on draft PR #406's hierarchy
head `b489c4bf738befcad4c7867869117c9cab41b5e3`; it does not merge the older
reference-provider branch. It is an isolated candidate and has not been
deployed.

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
review and operator acceptance remain release gates. The direct
customer-bound project creation flow and its browser rendering passed focused
synthetic checks in this candidate. TrueNAS installation remains under Beau's
control.
