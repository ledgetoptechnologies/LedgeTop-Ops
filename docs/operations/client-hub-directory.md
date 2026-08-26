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
| `business` | Internal Alpha organization or standalone-client ID | `project-alpha:primary` |
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
The existing connector still supports one Alpha producer. The source field does
not enable a second producer or authorize business-record linking.

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
  contacts, accounts, shared projects, requests, legacy delivery links, portal
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

Do not claim every detail list is scalable yet: portal principal, entitlement,
invitation, and eligibility-block listing still needs a separate pagination
change. Raising the existing safety limits is not that change.

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
4. With migration/deployment authority, apply the additive Operations migration
   before releasing its consumer. Do not bypass another pending migration or
   assume an application deploy has applied database changes.
5. Confirm the isolated cron runs and the initial index reaches `ready=1`.
   Read-only acceptance should cover client search, source-qualified details,
   folder-scoped link history, permission restrictions, refresh, and Back/Forward.
6. Record application revisions, migration state, actual gate results, and live
   acceptance separately. Passing local fixtures is not proof of a deployed
   cross-application integration.

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

Rollback restores the previously released application code while retaining the
additive index schema for recovery. It must not roll back authoritative source
or access records. Do not drop/recreate production tables or clear leases merely
because one invocation has not finished. If repair is needed, inspect the exact
state and obtain approval for the bounded repair operation.
