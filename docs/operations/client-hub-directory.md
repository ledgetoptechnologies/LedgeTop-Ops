# Client Hub directory: rollout and recovery

Status: local implementation, not deployed. See
[the client-workspace roadmap](client-workspace-roadmap.md) for the approved
scope, release evidence, and remaining work. This document does not authorize a
production migration, deployment, invitation, or access change.

## Ownership and identity

The directory is a staff search index, not an authentication or access authority.
It reads existing Operations business projections and Delivery workspace data;
it does not grant memberships, merge identities, or edit Project Alpha records.

A client key is `(source_id, root_namespace, kind, public_id)`:

| Namespace | Meaning of `public_id` | Source |
| --- | --- | --- |
| `business` | Internal Alpha organization or standalone-client ID | Exact registered `project-alpha:*` producer |
| `portal` | Exact portal workspace ID | `project-alpha:primary` |
| `account` | Unlinked local delivery account ID | `delivery:local` |

The separately named `pa_public_id` is the stored 32-lowercase-hex identifier
exported by Alpha. Never derive it from a numeric ID, name, email, or folder path.
Legacy workspace columns named `pa_*_public_id` can contain internal IDs: only
the current account association and selected legacy-generation provenance prove
that association. Native mappings instead require an explicit exported public
ID and a selected, complete native workspace generation/root.

An ambiguous or incomplete association must not select an arbitrary workspace.
Unmapped portal workspaces remain separately addressable; retained portal URLs
can resolve a business alias only through the current verified association.
Each registered producer remains independent. A source field identifies one
producer; it does not authorize business-record linking or combine memberships,
identities, grants, denials, accounts, or staff authority.

## Directory and detail reads

- `GET /api/client-hub` provides bounded search and continuation. Names, current
  business contacts, and authorized project matches are filtered before the
  result limit. Portal-only contact search is explicitly unsupported for now.
- Canonical detail routes include source, namespace, kind, and ID. An old
  unqualified route fails if it has more than one possible source match.
- The directory cursor is tied to search, permissions, and the materialized
  index revision. A changed revision requires refreshing results.
- Detail collections begin with five records per section; continuation defaults
  to 25 and is capped at 100. Each section has its own loading/retry state. These
  are live, bounded queries, not a transaction snapshot across both databases.
  Newly added rows above a continuation position become visible on refresh.
- The canonical detail route adds `/collections/:collection` for business
  contacts, business project history, accounts, shared projects, requests, legacy delivery links, portal
  deliveries, and shared models. Collection keys are not additional permissions.
  Portal logins remain separate from paged business-contact records.
- Source mapping or permission changes invalidate continuation. A successful
  read, a matching email, and portal eligibility are not content grants.
- Continuation also checks current account association and selected projection
  provenance, including after data is read. The current schema uniquely links
  a delivery account to an Alpha root, so association checks are bounded; an
  unexpected duplicate association fails rather than picking an account. A
  context change clears the UI's old sections and requires a full refresh.
- Project access inventory is not full business project history. The latter
  requires its own `projects.view` and assignment-scope checks.

### Portal pagination and business history (locally verified, not deployed)

Portal logins use an independent five-record initial page and server-side
name/email, link-state, sign-in-block and principal-status filters. Subsequent
identity pages default to 25, maximum 50. Access rules, invitations and sign-in
block histories are loaded only when opened, with independent bounded cursors.
Business contacts are not login records and must remain in their own section.
The former eager portal reader and duplicate access panel have been removed;
the global staff client endpoint and scoped Client Hub use the same bounded
reader. This does not enable a second Alpha producer or new access mutations.

Nested reads send the selected summary's `expectedPrincipalContext`, including
on their first request. The server compares this to current identity binding,
source version, membership and eligibility facts before and after reading.
An actor/root/principal-context change returns a refresh-required response;
the browser clears every stale detail section. Ordinary network failures retain
unrelated sections and provide a local retry. These are live pages, not a frozen
snapshot of every unloaded entitlement or invitation.

Rule history shows explicit allow/deny rules, not effective authorization.
Invitation history is scoped to the exact workspace and current normalized email
and is labelled **Invitations to this email**, not a verified personal history.
Removing a global email sign-in block does not grant workspace or content access.
Creation/removal confirmations must explain the all-workspaces effect. Never
select a removable block from an incomplete first history page; use the exact
effective summary or the explicitly chosen history row.

Invitation delivery recovery remains administrator-only and rollout-gated. Its
receipt format must match migration 0149's 64-character SHA-256 encoding. The
existing base64url fingerprint helper serves other contracts and is not changed.
Recovery only queues an existing valid invitation with intact delivery payload;
it cannot manufacture an identity, membership or content grant.

### External access roster (local follow-on, not deployed)

The exact source client workspace now has a separate, read-only **External
access** roster. Unlike Portal logins, this reader starts from authoritative
workspace memberships and invitations, so an Operations- or legacy-created
membership without an Alpha principal and a pending invitation without a linked
identity remain visible. Records are never combined by email. Business contacts,
login bindings, access rules, content grants and external-access records remain
separate concepts.

The initial client response includes at most five current records; continuation
uses 25-row pages and a maximum of 100. Search is server-side by display name or
email metadata, and lifecycle filters include current, all, active membership,
no assigned access, pending, suspended, blocked, expired and revoked. An active
membership with no current allow rule is explicitly labelled **No assigned
access**; it is never presented as effective access. Project Alpha membership
rows also require a current same-version active principal before they can be
labelled active. A malformed expiry is labelled as
needing review instead of being treated as perpetual access. The opaque cursor
is bound to the exact canonical root, selected workspace, staff/context proof and
filters, and orders by immutable creation time plus record kind and ID. Cursors
never authorize access.

The DTO exposes only safe presentation fields: display name/email, lifecycle
status, membership source, expiry/revocation timestamps and the count of current
allow rules or invitation rules. Assigned rules are an inventory, not proof of
effective resource authorization; denies and resource-specific authority remain
in their existing readers. The roster does not select or return issuer/subject,
invitation hashes, bearer material, storage paths or audit payloads. The roster
has no grant, revoke, block, retry or editing action. Existing Portal login and
delivery-access tools retain their own permissions and workflows.

Ordinary network failures are local to the roster and preserve loaded rows for
an exact retry. A 401, 403, 404 or 409 invalidates the complete client workspace
and cancels late reads. A missing verified portal workspace is shown as
unavailable, never as a false zero. This follow-on adds no migration, access
mutation, Project Alpha write, Viewer change or deployment.

Business-project history is separate from shared-project access. It applies
the existing project-view and assignment policy, current source ownership and
source-qualified client root before pagination. Source-created dates order
history (invalid/missing dates last); synchronization timestamps are not activity.
Project permission changes participate in the shared detail context, and each
page rechecks current ownership and assignments before returning its rows.
Status filters include All, Current, Completed and Cancelled. Unknown legacy
statuses remain visible under All with a neutral label. The `business_status`
and `login_*` URL parameters retain independent filters through refresh and
Back/Forward without discarding the directory search. Missing source-created
dates are not replaced with synchronization dates.

Delivery migration `0152_portal_identity_read_indexes.sql` supports these reads
with normalized-email invitation/block indexes and identity/subject history
indexes. It adds no triggers and changes no identity, grant, invitation or
membership records. A populated upgrade test applies the complete earlier
Delivery migration chain, verifies unchanged data and triggers, then checks
foreign keys/integrity and the actual query plans before and after the upgrade.
The latest-email-invitation read no longer requires a temporary sorting tree.

### Business contact channels and project workspace (local follow-on)

Business contacts now return explicit nullable `email` and `phone` values from
the existing Alpha projection. The query selects only bounded JSON text fields;
malformed, non-scalar, control-bearing and oversized values become unavailable.
The obsolete login/access placeholders are removed. A contact record still
cannot grant access, create an invitation, or select a notification recipient.

Business project names link to a dedicated client-scoped project workspace:

`/clients/sources/:sourceId/business/:kind/:clientId/projects/:projectId`

Its read endpoint is the canonical client API base plus
`/business-projects/:projectId`. It returns a whitelisted project summary and the
current in-root contact referenced by Alpha's `project.client_id`. That is a
**linked contact**, not an inferred site, billing or portal role. An out-of-root
or inactive reference is suppressed. Source, project ownership, assignment and
shared client context are checked before and after hydration. Optional
`expectedContextVersion` lets a caller reject a changed client context.

The page preserves directory/project/login filters when returning to the client;
only approved filter keys are carried, never an arbitrary return URL or token.
Refresh clears stale data while loading, and cancelled/late results cannot restore
the prior project. Account/portal aliases are not project-detail routes in this
increment; existing client-detail aliases remain supported.

This business-project increment is read-only. It does not implement
site assignments, field-note editing, copy-forward, or Alpha project creation.
Their authority and remaining decisions are recorded in
[the project-memory design](project-memory-design.md). The existing directory
release prerequisites below still apply; this follow-on is not deployed.

### Secondary portal visibility (local follow-on, not deployed)

An exact secondary business root may now display its source-owned native portal
workspace and current portal principals in Client Hub. Resolution requires all
of the following: the same source ID on the business projection and workspace,
the exported unambiguous Alpha public ID, the selected complete native root
generation, the immutable `pa_portal_workspace_sources` reservation, and an
active portal-purpose authority with its selected revision. A missing,
suspended, retired, stale or conflicting proof leaves the workspace unavailable.

This visibility does not use a legacy account bridge and does not expose
secondary invitation, sign-in-block, nested identity-history, finance, service,
mail, feedback, Viewer, or delivery-management actions. The same verified
global `(issuer, subject)` may be visible in two workspaces, but each membership,
entitlement and denial remains independently scoped. Business-party links remain
presentation-only and never union access.

Operations migration `0042_client_hub_secondary_portal_visibility.sql` rebuilds
only the disposable directory cache tables so a secondary root can retain its
exact `workspace_id`. It preserves every existing root/search row, indexes and
revision trigger. The constraint continues to require secondary
`legacy_account_id IS NULL` and zero account, project and request counts; portal
namespaces remain primary-only. A populated upgrade test verifies preservation,
foreign keys, integrity, allowed workspace storage and rejected legacy/count
writes. The migration resets the bounded reconciliation cursor; it creates no
identity, membership, grant, invitation or source authority.

## Index lifecycle

Migration 0032 creates rebuildable roots, scalar search values, revision
triggers, maintenance state, and supporting source lookup indexes. Source JSON
is not rewritten. Existing malformed JSON stays unmapped instead of preventing
the guarded indexes from being created.

The dedicated `2-57/5 * * * *` cron invokes `reconcileClientHubIndex`. It is
separate from thumbnail and notification schedules. Each invocation has page,
elapsed-time, statement, and lease bounds. The persisted phase/cursor resumes
partial work; a subsequent invocation can reclaim an expired lease. Only
effective indexed changes advance the directory revision.

The initial directory responds with a retryable preparation error until a full
cycle sets `ready=1`. Do not replace this with an empty customer list. Subsequent
reads include the last successful index timestamp. A completion cooldown means
the schedule is not a guarantee of five-minute freshness.

The final sweep removes stale *search index* entries and marks stale directory
roots inactive. It does not delete business records, source media, memberships,
delivery links, or Viewer data.

## Release gate

Baseline acceptance at `537310f`, completed August 25, 2026:

- Operations: 796 unit/integration tests across 108 files, zero failures; 290
  desktop/mobile browser tests, zero failures. The final runs were serial.
- Client Portal: 13 full-migration-chain end-to-end and eligibility tests passed
  with migration 0152 included. No production identities or grants were changed.
- Operations generated Worker types, both application TypeScript checks and the
  Operations production build passed. Responsive captures were visually reviewed
  at 375, 640, 1280 and 3440 pixels.
- Repository-level source-layout verification is **not** fully green; the
  pre-existing thumbnail documentation failure is detailed below.

Read-only contact/project follow-on acceptance, August 25, 2026:

- The final serial focused backend run passed **56 tests across three files**
  in 160.12 seconds: Client Hub routes/contacts (32), business history (10), and
  project detail (14). Coverage includes actual Hono routing and real local D1
  ownership, reassignment, permission and malformed-data cases. Domain-write
  abort triggers verify that project-detail reads do not mutate business data.
- The final complete browser run passed **322 desktop/mobile tests** in 4.3
  minutes with one worker, including the final contact-label spacing correction.
  The preceding focused run passed 78 tests. Production build and TypeScript
  checking passed; final 375, 640, 1280 and 3440 pixel layouts were visually
  reviewed, including long names/emails, keyboard controls and error recovery.
- The 796-case full unit gate above belongs to the baseline, not this follow-on;
  only the three affected backend suites were rerun on these final sources.
  Repeat the complete release gate before publication.
- This increment adds no migration and changes no Viewer or thumbnail runtime.
  It remains local and unpublished. The earlier directory/index migrations,
  Alpha publication prerequisite and repository-level failure still apply.

Run local acceptance from `apps/operations` using the committed lockfile:

```sh
npm ci --no-audit --no-fund
npm run cf-typegen:check
npm run check
npm run test -- --maxWorkers=1
npm run test:browser -- --workers=1
```

The browser command includes the production build. Serial local execution avoids
competing Miniflare/browser processes exhausting Windows loopback ports. A
transport failure such as `EADDRINUSE` is not a passing test: preserve its output,
rerun the affected suite in isolation, and distinguish that retry from a clean
full-suite run. Do not weaken assertions or change production behavior to hide
a local test-server failure.

1. Obtain publication approval for the additive Alpha v1 public-ID export,
   complete its normal PR/check workflow, and confirm the deployed producer.
   V2 event/fingerprint migration is a separate deferred change.
2. Verify the normal sync retains the explicit public-ID field and maps the
   intended root. Never perform production invitations or grants as a test.
3. Run the pinned Operations dependency, generated-type, build, unit, migration,
   and browser gates. Include the populated upgrade test, not only empty schema
   creation or mocked UI responses.
4. With migration/deployment authority, apply the Operations migrations through
   0042 and Delivery migrations through the corresponding portal-authority and
   read-index revisions before releasing their consumers.
   Do not bypass another pending migration or
   assume an application deploy has applied database changes.
5. Confirm the isolated cron runs and the initial index reaches `ready=1`.
   Read-only acceptance should cover client search, source-qualified details,
   folder-scoped link history, permission restrictions, refresh, and Back/Forward.
6. Record application revisions, migration state, actual gate results, and live
   acceptance separately. Passing local fixtures is not proof of a deployed
   cross-application integration.

An additional repository-level check on August 25 found a pre-existing failure
in `scripts/source-layout-invariants.test.mjs`: six of seven checks pass, but its
thumbnail-runbook assertion still expects the old direct-scratch wording and
`file,pipe` protocol contract. The unchanged runbook now documents a loopback
range proxy. The test and referenced thumbnail files are identical to released
`28827c4`; this Client Hub slice does not modify them. Do not report the entire
monorepo gate as green or weaken the assertion here. Have the thumbnail owner
reconcile that contract before a release requiring the root test gate.

## Diagnostics and rollback

The maintenance events are `client_hub.index.tick`,
`client_hub.index.complete`, and `client_hub.index.error`. They intentionally
exclude contacts, SQL payloads, capability URLs, and secrets. A `busy` tick can
mean a lease or completion cooldown is still active; it does not by itself
indicate failure.

An authorized read-only database check can inspect:

```sql
SELECT ready, revision, generation, backfill_phase, backfill_cursor,
       lease_until, next_run_at, last_success_at
FROM client_hub_directory_state WHERE id = 'directory';
```

For a preparation error, check migration application, scheduled invocations,
lease expiry, and whether the phase/cursor advances. For a mapping problem,
inspect the exact source-qualified root and its current source/projection
provenance; do not repair it by matching names or replacing IDs manually.

Before migration 0042, take the normal D1 recovery point and record the current
directory state. Rollback restores the previously released application code
while retaining the forward-compatible cache schema. If a migration-time copy
or integrity check fails, stop the deployment and restore the whole Operations
database from that recovery point; never reconstruct authoritative rows by hand.
After a committed migration, prefer a forward fix or bounded index rebuild.
It must not roll back authoritative source or access records. Do not drop or
recreate production tables, clear leases, or remove source ownership/authority
records merely because one invocation has not finished.
