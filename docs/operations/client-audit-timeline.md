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

Secondary Project Alpha roots return source-record activity and exact
Operations-owned project activity for their own source-qualified overlays.
Their request, feedback, legacy access, delivery and notification coverage is
labeled `unsupported_source`. The canonical project-access authority adapter is
the exception: it can be available for a secondary root only through that
root's exact workspace/source/project mapping and current portal permission.
Matching public IDs, email addresses, names, or reviewed business-party links
never combine sources, workspaces, identities or grants.

## Query and response contract

Filters are `category`, `actorType`, `result`, optional canonical ISO `from` and
`to`, `limit` from 1 through 100, and an opaque continuation `cursor`.
`expectedContextVersion` binds the initial browser request to the current Client
Hub workspace. The server echoes normalized filters and returns explicit
coverage for all six categories. `projectCoverage` distinguishes source-record
activity from Operations-owned project contacts/memory activity,
`accessCoverage` separately reports every access adapter, while
`notificationCoverage` distinguishes delivery-share,
project-access collaborator, and project-access companion notices. One available ledger therefore
cannot hide permission-required, unsupported, not-applicable, or not-collected
adapters.

The version-seven AES-GCM cursor is actor-bound and includes the exact source-qualified root,
optional project, normalized filters, current context and scope proofs, an
`asOf` time, bounded producer high-water marks, separate collaborator/companion notice schema
readiness, the project-access authority collection start, the last global sort
tuple and a 30-minute expiry. A cursor authorizes
nothing. Every continuation repeats live authorization and schema-readiness
checks. Items sort by event time descending, producer and immutable event ID,
and each producer query is bounded to `limit + 1`.

The checkpoint includes:

- source organization/client/project activity for every readable business
  source;
- Operations-owned project contact saves, project-memory saves/amendments and
  copy-forward outcomes, after exact current source, project ownership,
  workspace-bound Client Hub context, overlay root and immutable revision joins;
- request revisions for exact current primary/local account/project mappings;
- primary workspace membership, invitation-request decisions, peer-administrator
  changes and workspace identity-denial lifecycle;
- authenticated delivery-grant lifecycle, meaningful delegated-share
  authorization lifecycle and Viewer client-grant lifecycle when the exact
  current root/project mapping and the corresponding staff permission are
  both present;
- migration-0172 term-backed invitation-request, invitation and authenticated
  grant authority lifecycle beginning at its immutable collection start;
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

Migration `0172_project_access_authority_history.sql` begins append-only
project-access authority collection. Its immutable singleton records the exact
`collection_started_at`; the migration intentionally does not infer or backfill
events from pre-existing terms, invitations, requests, grants or notice rows.
The timeline UI therefore labels this adapter **available since** that timestamp.
An empty result is never presented as complete lifetime history.

Each authority event is bound to the exact workspace, Project Alpha source,
project public ID and immutable access-terms ID. Invitation-request events must
match the exact request scope; invitation events derive coordinates through the
invitation's term binding; authenticated-delivery events derive them through
the exact project folder binding. The Client Hub adapter repeats the current
root/workspace/source/project and `operations.manage` checks before release.
Matching public IDs in another workspace or source never join the timeline.

`producer_event_key` provides exact replay. Retrying the same event is a no-op;
reusing the key with different coordinates, authority, actor, subject, kind or
expiry timestamp aborts. The bounded expiry reconciler records only accepted or
otherwise live term-backed invitations and authenticated grants whose exact
effective boundary elapsed on or after `collection_started_at`. It preserves
that boundary as `occurred_at`, skips authorities revoked before the boundary,
and can be retried without duplicates. It does not manufacture expired events
for older authorities.

Migration 0169's collaborator and companion notice audits remain separate
notification history and are never presented as proof that access was granted,
revoked, expired or received. Before their respective tables are present,
notification coverage is `not_collected`.

Rolling schema behavior is fail-closed and explicit: neither 0172 table means
`project_access` coverage is `not_collected`; exactly one table or an invalid
singleton is an incomplete-schema error; both valid tables enable collection
and bind that start value into continuation cursors. New explicit access-term
writes require the complete history schema. Existing access readers continue
to enforce terms independently of the history UI.

Feedback remains `not_collected` in this endpoint. The existing project
feedback history keeps its stricter per-record scope checks until a bulk adapter
can preserve those checks without weakening privacy. Ordinary authenticated
preview/download events are not inferred from page loads and are not yet
produced. Public share session/manifest/preview events remain excluded because
the meaningful-content and noise policy is unresolved.

## Redaction and retention boundary

Operational project events select only allowlisted event kinds and the boolean
copy-forward marker needed to choose a stable action. They return a generic
staff actor, current project label and one of `project.contacts.saved`,
`project.contacts.copied_forward`, `project.memory.saved`,
`project.memory.copied_forward`, or `project.memory.amended`. The adapter never
selects contact channels, instructions, memory snapshots, amendment reasons,
source project IDs, selected contact IDs, raw counters or `details_json`.
Malformed overlay roots, reassigned projects, wrong-source handles and events
without their exact immutable revision are omitted before pagination.
The adapter additionally requires current `projects.view`; when that policy is
unavailable, `operational_project_activity` is explicitly reported as
`permission_required` and no operational rows are queried or returned.

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

Focused D1 tests cover the two project adapters, eight available access ledgers
including project-access authority history, both migration-0169
notification ledgers, authoritative-term mismatch rejection, strict redaction,
meaningful-event allowlists, exact project/sibling isolation, stable high-water
pagination, malformed cross-workspace rejection, mid-read permission loss,
per-adapter coverage and pre-migration not-collected behavior, category/actor/result/date filters, actor/filter/scope-bound
continuation, operational-event project/source/root isolation, redaction and
stable high-water behavior, and exact secondary source isolation. Focused browser tests
cover refresh/back/forward restoration of every applied filter, preservation
of unrelated query parameters, reset behavior, 44-pixel controls and
desktop/mobile overflow, plus the **available since** coverage label.

For a coordinated release, writer-first is necessary but not sufficient. An
already-running mutation can read `historyReady=false`, migration 0172 can then
establish `collection_started_at`, and that previously built batch can commit
without its canonical event. Before deploying or migrating, freeze **all**
project-access authority mutations: request and invitation create/submit,
approve/publish, accept and revoke; authenticated-grant create/publish, revoke
and restore; and every expiry reconciliation or notification path that invokes
reconciliation. Drain in-flight HTTP requests, leases, queues, scheduled jobs
and reconciliation batches, and prove no old mutation can still commit. Both
new writer builds must default
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false`; it holds the application
barrier after cutover but cannot replace the external freeze for old builds.
Close external mutation ingress/schedulers, shift **100% of traffic** to both
flag-false writers, then drain every old-version and in-flight request/job.
Reads remain live throughout.

While that barrier remains closed, deploy and verify both schema-tolerant Client
and Operations writers. Confirm the pre-migration timeline reports
`not_collected`, protected access reads still work, and new explicit-term writes
fail `503`. Then apply 0172 to the shared Delivery D1 database and verify both
tables, the one immutable singleton, `PRAGMA foreign_key_check`, and the recorded
start timestamp. Before unfreezing, exercise a canonical test invitation or
authenticated-grant lifecycle event, exact replay, expiry reconciliation,
sibling-source/project denial, cursor invalidation on schema/start change, and
the UI's **available since** label. Do not reset or edit the singleton during
rollback; retain the history-aware writers, keep
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false`, and fix forward. Keep
general ingress frozen; after schema verification, enable the flag in both
Workers together, run the isolated canonical test, then reopen
ingress/schedulers only after every check passes.

Operations type-checking must pass with the matching shared contract. Release still needs
the ordinary coordinated Worker/browser gates and authorized live acceptance;
this document is not deployment approval.
