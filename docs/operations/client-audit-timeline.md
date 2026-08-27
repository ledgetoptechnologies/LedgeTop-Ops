# Staff Client Hub audit timeline

Status: backend checkpoint implemented locally, not deployed, August 26, 2026.

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
coverage for all six categories; unavailable coverage is not an empty-history
claim.

The AES-GCM cursor is actor-bound and includes the exact source-qualified root,
optional project, normalized filters, current context and scope proofs, an
`asOf` time, bounded producer high-water marks, the last global sort tuple and a
30-minute expiry. A cursor authorizes nothing. Every continuation repeats live
authorization. Items sort by event time descending, producer and immutable
event ID, and each producer query is bounded to `limit + 1`.

The first checkpoint includes:

- source organization/client/project activity for every readable business
  source;
- request revisions for exact current primary/local account/project mappings;
- primary workspace membership and authenticated delivery-grant lifecycle;
- primary/local staff delivery-link lifecycle and its durable notification
  outcomes.

Feedback remains `not_collected` in this endpoint. The existing project
feedback history keeps its stricter per-record scope checks until a bulk adapter
can preserve those checks without weakening privacy. Ordinary authenticated
preview/download events are not inferred from page loads and are not yet
produced. Public share session/manifest/preview events remain excluded because
the meaningful-content and noise policy is unresolved.

## Redaction and retention boundary

Adapters select only allowlisted columns. Responses never include raw
`details_json`, request snapshots or notes, feedback text, identity IDs, email
addresses, IP hashes, user agents, storage paths, item references, bearer URLs,
tokens, legacy account IDs, or authorization proofs. Actor output is only a safe
kind and generic label.

This route searches online D1 rows only. Existing retention archives
`share_events` after 90 days and `audit_log`/`audit_events` after 365 days; other
immutable ledgers still lack one approved common retention policy. The R2 audit
archive is protected backup, not an interactive query source. The UI must not
describe the timeline as a complete lifetime record.

## Verification and release

Focused D1 tests cover local multi-ledger merge, strict redaction, category/
actor/result/date filters, actor/filter/scope-bound continuation and exact
secondary source-only coverage through the real HTTP route. Operations
type-checking must pass with the matching shared contract. Release still needs
the ordinary coordinated Worker/browser gates and authorized live acceptance;
this document is not deployment approval.
