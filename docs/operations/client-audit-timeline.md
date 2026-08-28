# Staff Client Hub audit timeline

Status: scoped access-history increment implemented locally, not deployed,
August 28, 2026.

The staff timeline is a bounded, read-only federation over existing event
ledgers. It does not create a canonical event table, change producer retention,
write Project Alpha, or turn a business-party presentation link into authority.

## Routes and authorization

- `GET /api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/timeline`
- `GET /api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/business-projects/:projectId/timeline`

Both routes first resolve the exact live Client Hub root. `team.view` is
required. The project route also reuses the existing `projects.view`
assignment/manager policy and verifies exact current source ownership. Request,
portal-access, delivery and notification adapters are included only when the
same current root has its exact account/workspace/project mapping and the staff
principal currently holds that adapter's permission. Each proof is checked
again before the response is released; a concurrent ownership or permission
change returns `409`.

Secondary Project Alpha roots deliberately return only source-record activity.
Their request, feedback, access, delivery and notification coverage is labeled
`unsupported_source`. Matching public IDs, email addresses, names, or reviewed
business-party links never combine sources, workspaces, identities or grants.

## Query and response contract

Filters are `category`, `actorType`, `result`, optional canonical ISO `from` and
`to`, `limit` from 1 through 100, and an opaque continuation `cursor`.
`expectedContextVersion` binds the initial browser request to the current Client
Hub workspace. The server echoes normalized filters and returns explicit
coverage for all six categories. `accessCoverage` separately reports every
access adapter, while `notificationCoverage` distinguishes delivery-share,
project-access collaborator, and project-access companion notices. One available ledger therefore
cannot hide permission-required, unsupported, not-applicable, or not-collected
adapters.

The version-five AES-GCM cursor is actor-bound and includes the exact source-qualified root,
optional project, normalized filters, current context and scope proofs, an
`asOf` time, bounded producer high-water marks, separate collaborator/companion notice schema
readiness, the last global sort tuple and a 30-minute expiry. A cursor authorizes
nothing. Every continuation repeats live authorization and schema-readiness
checks. Items sort by event time descending, producer and immutable event ID,
and each producer query is bounded to `limit + 1`.

The checkpoint includes:

- source organization/client/project activity for every readable business
  source;
- request revisions for exact current primary/local account/project mappings;
- primary workspace membership, invitation-request decisions, peer-administrator
  changes and workspace identity-denial lifecycle;
- authenticated delivery-grant lifecycle, meaningful delegated-share
  authorization lifecycle and Viewer client-grant lifecycle when the exact
  current root/project mapping and the corresponding staff permission are
  both present;
- primary/local staff delivery-link lifecycle and its durable notification
  outcomes;
- migration-0169 collaborator, inviter, and access-creator project-access notice
  staging, sending, suppression, retry and terminal failure outcomes for the
  exact current primary workspace and, where selected, exact source-qualified
  project.

Portal workspace access rows require exact current global `operations.manage`;
its SQL-scope proof is cursor-bound and re-read after bounded ledger queries.
Authenticated-delivery and delegated-share audit rows additionally
require current global `delivery.share.audit`; Viewer client-grant audit rows
require current global `viewer.manage`. Those permission proofs are bound into
the encrypted cursor and checked again after each bounded read.

Project adapters never infer ownership from names, emails, event payloads or
display links. Invitation audit rows must match their request workspace.
Identity-denial audit rows must match both denial identity and workspace; at
project scope they also join the authoritative workspace source and exact
active local source/project projection. Authenticated and delegated delivery
events join their immutable
folder binding. Viewer events join the exact local account/project grant.
Workspace membership and peer-administrator events have no project key, so
they appear only at client scope. Folder-target events also remain client-only
because their event row has no project key. Public delegated-share session,
manifest, preview, map and download events are intentionally excluded as noisy
content reads rather than access-authority changes.

`portal_project_access_terms` and deadline tables contain current immutable
terms, but they are current authority rather than an authority-event ledger.
`project_access` therefore remains honestly `not_collected`. Migration 0169's
collaborator and companion notice audits are exposed separately as notification history and never presented
as proof that access was granted, revoked, expired or received. Before the two
collaborator or companion tables are present, their respective notification
coverage is `not_collected`; deploy-before-migration and partially applied
upgrades remain honest and safe.

Feedback remains `not_collected` in this endpoint. The existing project
feedback history keeps its stricter per-record scope checks until a bulk adapter
can preserve those checks without weakening privacy. Ordinary authenticated
preview/download events are not inferred from page loads and are not yet
produced. Public share session/manifest/preview events remain excluded because
the meaningful-content and noise policy is unresolved.

## Redaction and retention boundary

Adapters rejoin each notice audit and outbox row to the exact authoritative
`portal_project_access_terms` workspace/source/project tuple, then select
allowlisted actions, recipient roles, event types and columns only. Project-access
notice resources use the generic label `Project access notice`; results are
limited to succeeded, failed or informational and cannot imply access authority
or delivery receipt. Responses never include raw
`details_json`, request snapshots or notes, feedback text, identity IDs, email
addresses, IP hashes, user agents, storage paths, item references, bearer URLs,
tokens, outbox IDs, errors, reasons, idempotency keys, legacy account IDs, or authorization proofs.
Access resources use generic labels and contain no subject, actor, invitation,
grant, delegation, share or folder IDs. Actor output is only a safe kind and
generic label.

The existing timeline UI provides **View access history**. It applies the
access category immediately. Applied state uses namespaced `audit.active`,
`audit.category`, `audit.actor`, `audit.result`, `audit.from`, and `audit.to`
query parameters. Refresh and browser back/forward restore all non-sensitive
filters while preserving unrelated parameters. No cursor, identity, proof or
authority key is placed in browser history.

This route searches online D1 rows only. Existing retention archives
`share_events` after 90 days and `audit_log`/`audit_events` after 365 days; other
immutable ledgers still lack one approved common retention policy. The R2 audit
archive is protected backup, not an interactive query source. The UI must not
describe the timeline as a complete lifetime record.

## Verification and release

Focused D1 tests cover the seven available access ledgers, both migration-0169
notification ledgers, authoritative-term mismatch rejection, strict redaction,
meaningful-event allowlists, exact project/sibling isolation, stable high-water
pagination, malformed cross-workspace rejection, mid-read permission loss,
per-adapter coverage and pre-migration not-collected behavior, category/actor/result/date filters, actor/filter/scope-bound
continuation and exact secondary source-only coverage. Focused browser tests
cover refresh/back/forward restoration of every applied filter, preservation
of unrelated query parameters, reset behavior, 44-pixel controls and
desktop/mobile overflow. Operations type-checking must pass with the matching
shared contract. Release still needs
the ordinary coordinated Worker/browser gates and authorized live acceptance;
this document is not deployment approval.
