# Reviewed customer linking across Project Alpha sources

Status: implemented and verified locally, August 26, 2026; not deployed.
No live source enrollment, customer linking, migration or deployment is included.

## Intended workflow

An administrator opens a source customer, searches for the matching customer in
another Alpha source, reviews both records and the proposed Operations display
name, then explicitly confirms the link. Client Hub shows one customer card and
a dedicated linked-customer workspace. Each contributing source keeps its own
original workspace URL, business history and authoritative actions.

The first implementation accepts organization-to-organization and independent
client-to-independent-client links, with at most one record from each source and
32 sources per party. It does not infer matches from names, email addresses,
public IDs or identical numeric IDs. Adding another record and removing a link
have their own preview and confirmation. Already-linked groups are not silently
merged: the operator must review and unlink the relevant source record first.

## Ownership and recoverability

- An Operations party is a presentation relationship, not an authenticated
  person, a portal workspace, an invoice recipient or a new Alpha customer.
- Membership points to immutable source-qualified local record handles, not the
  rebuildable directory index or an inferred public-ID mapping.
- Mutation requires administrator status plus effective global `team.manage`
  and `team.view`. Source visibility and current ownership are checked again at
  commit. Assignment or directory access alone cannot grant linking authority.
- Linking never writes Alpha records, memberships, grants, staff roles, client
  eligibility, resource access, invoices, delivery destinations or notifications.
- Expected context/version, actor-scoped idempotency receipts, membership
  changes and immutable audit events belong to the same Operations transaction.
- Unlinking restores independent presentation without changing historical source
  data. The party survives with one member; removing the final member archives
  it as an operator-closed record. Retained link and event history is immutable,
  is not deleted, and is never reused for another customer.

## Recoverable presentation lifecycle

`0048_business_party_lifecycle.sql` adds an explicit lifecycle to the existing
`business_parties` presentation umbrella. It does not introduce a second client
system. The compatible storage status remains `active`/`closed`; the API and UI
use `active`/`archived` and record whether a party is source-backed or was
created only in Operations.

- A source-backed active party is automatically archived with cause
  `source_unavailable` only after it has no live exact source-qualified mapping.
  Its links are retained; source deletion or deactivation never rewrites them.
- An Operations-only party is not governed by source availability and is never
  automatically archived because it has no mappings.
- An exact immutable source return reactivates only a `source_unavailable`
  archive and reuses the same party ID. Similar names, email addresses, public
  IDs, or a different source-qualified handle cannot reactivate it.
- An operator-closed party never reopens just because a source returns. It
  requires an administrator to preview and confirm an exact reviewed relink.
  That one-transaction relink fence is removed before commit.
- Every lifecycle transition appends an immutable, versioned lifecycle event.
  The database rejects updates and deletes of this history. Idempotent mutation
  replay returns the original result without changing status or version.

Archived party details are available only to a currently authorized manager for
recovery. Ordinary readers receive the same not-found response as for any
unreadable party. The lifecycle, mapping and grouping data remain
presentation-only: they do not create a login, grant portal/resource access,
assign eligibility, or widen independently authorized source visibility.

## Read, search and pagination contract

The default directory groups matching records before applying page limits.
Search includes a reviewed party name and each independently authorized source
record's existing search fields. Explicit source filters retain their meaning.
The linking picker uses `grouping=records`, which preserves source-specific URLs
and exposes current membership only when the whole party is readable.

Party labels and membership counts appear only when all active contributors are
currently visible, live roots. If any contributor is hidden, deactivated or no
longer an independent client, the directory falls back to authorized source
cards and does not expose the aggregate name, ID, count or hidden search terms.
This is a display restriction, not revocation of independently granted access.

Administrators with the same global read/manage permissions have a repair view
when all contributing sources remain visible but an existing member is no longer
a live root. It exposes the immutable link handle and an unavailable-record
placeholder, not the removed record's business details or workspace. Adding
records is disabled until repair is complete. An explicit preview can unlink
one unavailable member while retaining other unavailable members for subsequent
review; available members still require current ownership and name checks.
Hiding a source suppresses this repair view too. Repair never revives a source,
grants access, or deletes business records.

Party names use the directory's normalized Unicode search representation.
Cursors bind query, type, source, grouping, staff policy and directory/source
revisions. Membership and linked-root lifecycle changes invalidate old pages
immediately instead of silently dropping or duplicating customers across pages,
even before the next directory reconciliation. Source-specific deep links remain
valid when their original records are independently readable.

Requests and audit payloads have a 64 KiB byte limit in addition to the 32-source
limit and bounded identifiers. The HTTP reader checks actual streamed bytes,
not a supplied Content-Length, and has a read deadline. Preview and mutation
responses are not cached. Browser navigation, refresh, and permission-context
invalidation cancel pending reads and prevent late responses from restoring an
outdated review or navigating to a stale customer workspace.

## Operations API contract

| Route | Purpose |
| --- | --- |
| `GET /api/client-hub?grouping=records` | Authorized, paginated source records for the linking picker. Default `grouping=customers` returns reviewed groups. |
| `POST /api/business-parties/preview` | Validate the explicit `create`, `add`, or `unlink` operation and return current members plus a context fingerprint. |
| `POST /api/business-parties` | Commit `{ operation, previewContextVersion, idempotencyKey }` after current-authority and version checks. |
| `GET /api/business-parties/:partyId` | Read a fully authorized linked customer or an administrator's bounded repair/archive recovery view. |

`add` and `unlink` require `expectedVersion`. A retry after an uncertain result
must reuse the same operation and idempotency key. Conflicts require a refreshed
preview and explicit confirmation; they must not trigger a silent new operation.
The actor is the authenticated staff principal, never an accepted request field.
Existing Operations origin and CSRF protections cover both POST routes.

## Verification required before release

- Populated upgrade preserves all pre-existing business, staff and portal state.
- Explicit create/add/unlink, uncertain retry, duplicate click and concurrent
  editors produce one audited result or a clear conflict, never a partial link.
- Same IDs in two sources remain separate until explicitly selected. Wrong kind,
  same-source duplicate, already-linked record and untrusted namespaces fail.
- Current permission removal, source visibility changes, deactivation and owner
  moves cannot leak hidden data or commit a stale preview.
- Search by either source or reviewed name returns one grouped customer; page
  boundaries, refresh and source-record mode preserve stable navigation.
- Desktop/mobile UI covers preview/cancel/confirm, loading/error/retry/conflict,
  long names, keyboard use and unlink warnings. No live clients are test data.

### Local verification evidence

The final single-worker backend run passed all **114 tests in five files**:
`business-parties.test.ts`, `business-party-routes.test.ts`,
`client-hub-directory.test.ts`, `client-hub.test.ts`, and
`client-hub-source-error-route.test.ts`. This includes the actual populated
Operations migration chain, real D1 transactional guards, actual Worker
origin/CSRF middleware, and delayed-hydration link/unlink regressions.
Operations type checking and the final production build also passed.

The final single-worker browser run passed **194 desktop/mobile cases in seven
files**, including all **38 new business-party cases**. The same run covered
Client Hub directory/detail/business-project workflows, delivery navigation,
the current-view folder/file counts and responsive top-level navigation.

The regression work corrected missing audit fields in a new test fixture and
computed-display expectations for flex/grid items. No failing case is skipped
to make this increment pass. Responsive screenshots at 375 and 1280 pixels were
visually inspected after correcting the source-workspace button styling; the
browser suite also covers 640 and 3440 pixels and mobile navigation.

These are scoped local checks, not a new whole-monorepo or live acceptance
claim. The preceding connector checkpoint's full-suite results remain separately
recorded. Its pre-existing thumbnail-runbook source-layout invariant is not
changed by this increment, and the existing bundle-size warning remains.

The recoverable-lifecycle increment was verified against the populated
Operations migration chain through `0047` and then `0048`: all **27 lifecycle
domain tests** passed. The combined lifecycle/route run passed **40 tests**, the
three linked Client Hub suites passed **104 tests**, and the focused
business-party browser spec passed **40 desktop/mobile cases** at bounded
concurrency. Operations type checking and production build passed. All **9
source-layout invariants** passed, including the LF-only D1 trigger migration
guard. These checks remain local and do not authorize a migration or deploy.

## Remaining boundaries

### Coordinated release and rollback

Apply the approved preceding provenance/registry migrations, Operations
`0036_business_parties.sql`, and then `0048_business_party_lifecycle.sql` before
publishing the paired Worker and browser bundle. Operations migration SQL is
forced to LF by `.gitattributes`; preserve that rule because CRLF inside D1
trigger bodies can fail Cloudflare's migration parser. The new directory query
requires these tables even when no customers are linked. Do not publish this UI
independently against an older API.

The migration is additive and does not create inferred links or change source
records. Check populated-upgrade evidence and take the normal database backup
before an approved production migration. Verify a synthetic authorized workflow
after release before linking real customers. No source enrollment or credentials
are created by this slice.

Application rollback to the preceding connector-registry checkpoint can retain
the new lifecycle columns, tables, and audit history. The old directory will
show source records separately; it cannot manage grouping or recover archived
parties. Do not reverse the migration by deleting parties, links, lifecycle
events, or immutable receipts. Re-enable the paired application only after the
failed acceptance check is understood.

### Deferred functionality

This does not complete unified client-portal authorization or service-capability
assignment. Existing independently verified portal scopes stay separate. The
unpublished Alpha public-ID export, paired source-provenance migrations and live
producer enrollment remain release gates. Project-memory write/copy policy is
still a separate unresolved decision. Viewer and thumbnail runtimes are frozen.
