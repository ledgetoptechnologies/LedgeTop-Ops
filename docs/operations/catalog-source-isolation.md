# Catalog provenance: primary-compatible isolation

Local implementation, August 26, 2026. This is one prerequisite for the
[multi-source design](multi-source-client-design.md), not activation of another
Alpha instance. No production migrations, credentials, grants or deployments
are authorized by this document.

## Behavior and boundaries

- Existing catalog data is adopted as `project-alpha:primary`. Migration 0156
  preserves local IDs, saved selection JSON, answers, mutation receipts,
  fingerprints, timestamps and submitted request history.
- Catalog items, current-item uniqueness, generations, pages, checkpoints,
  entity state, receipts and audit have explicit source ownership. Snapshot
  replacement, tombstones and duplicate delivery handling affect only that
  source. Generation IDs remain local opaque IDs.
- A draft and submitted request each have an immutable `catalog_source_id`.
  Saved selection rows have a matching `service_source_id`, enforced by a
  composite foreign key. Empty parents cannot be reassigned to another source.
- Existing browser/catalog/request endpoints remain primary-only. A supplied
  `sourceId` is not an authorization mechanism: the signed receiver chooses the
  primary source after authentication, and browser page queries cannot select
  another source. Public service/request JSON and fingerprint inputs do not gain
  source fields.
- Catalog paging binds continuation to the selected server-side source and its
  checkpoint. A change in source B does not invalidate source A's continuation;
  a cursor from A cannot be used in B. Readiness cannot borrow B's services when
  the primary catalog is empty.
- Client draft/history, legacy request, attachment and pricing-hint paths only
  resolve primary-owned parents. Transaction-time catalog checks use the same
  source as the saved selection. Existing grant, workspace, identity and
  revocation checks still apply independently.
- Operations' globally authorized staff can continue reviewing saved requests
  by unique local request ID. That visibility is not permission to route a
  foreign-source request to the primary Alpha provider. Both private draft quote
  and legacy numeric quote commands reject an unsupported source before any
  upstream call; the quote capability is disabled for such a request.
- Request notifications for an unsupported source are terminally suppressed
  before client email or inbox insertion, with `unsupported-catalog-source` as
  the recorded reason. Staff triage remains available. This does not recall an
  email or notification that was already sent before the change.

`CatalogSourceContext` is an internal provenance value, not evidence of a
verified producer or a grant. The explicit-context reader/ingestion helper
exists for isolation and testability. It must not be exposed as a new endpoint
until a registry binds authenticated producers, capabilities and workspaces.

## Atomic delivery handling

Ingestion captures the source's checkpoint, generation, completeness and
immutable-version conditions. The write batch inserts a source-qualified receipt
whose named CHECK fails if that proof is stale. A failed proof rolls back the
whole batch, including item changes, checkpoint updates and audit records; a
zero-row conditional update must never leave later writes committed. A racing
duplicate rechecks its exact source/delivery/hash on the primary database.

This is not an upstream payload/version change. Existing HMAC application keys
and current/previous rotation keys retain their meaning. A key rotation cannot
create a second connector, and application keys are not producer identities.

## Local acceptance

The focused checks cover a populated upgrade through the actual migration chain,
byte-preserved old records and JSON, foreign keys, indexed source-qualified
queries, rollback, empty-parent immutability, two sources with identical public
IDs/versions/generations/sequences/delivery IDs, source-local replacement and
tombstones, stale proof races, idempotent replay, source-bound paging, saved
request mutation/submit guards, and primary-only outbound provider calls.

Migration tests use the lockfile-pinned D1 SQL parser, retaining trigger bodies
and applying each migration in a single D1 batch. They must not split SQL on
every semicolon or remove transaction-relevant pragmas.

Verified local checkpoint (August 26, 2026):

- Client package: 54 test files, 596 tests passed.
- Operations package: 114 test files, 914 tests passed.
- Both packages: TypeScript checks and production builds passed. Existing large
  bundle warnings remain; a successful build is not a performance certification.
- Local fixture browser regressions: 12 Operations tests (folder counts and
  private quote handoff) and 34 Client service-library tests passed across
  desktop and mobile projects. Folder-count screenshots were also inspected.
- These are package-level and local-browser results, not a full monorepo gate or
  live production acceptance. The unrelated thumbnail-runbook invariant remains
  outside this increment; no thumbnail or Viewer runtime changes were made.

No deployment, remote migration, production email or access mutation was run.

## Deployment gate — not executed

1. Confirm the currently deployed producer really is the existing primary.
   Stop if existing data has mixed or unknown provenance; do not guess ownership.
2. Take and verify a recoverable database backup. Rehearse 0156 on a populated
   staging copy and compare IDs, snapshots, receipts and foreign-key checks.
3. Use a coordinated maintenance window for catalog receiver, request mutations
   and request notification dispatch. **Old application code is not compatible
   with 0156**: it uses singleton checkpoints and obsolete conflict targets.
   Do not migrate underneath an old receiver or leave old writers running.
4. Apply 0156 and deploy matching Client and Operations code before reenabling
   those paths. Do not enable another producer, change source ownership or add
   source-selector headers as part of this rollout.
5. Verify the primary library, old drafts, replay, submission, attachment access,
   pricing hints, quote handoff and request notices. Verify unauthenticated,
   revoked and unsupported-source paths remain denied.
6. Prefer a forward repair. Rolling back only the code is unsafe after the
   schema change; restoring a backup also rolls back newer business writes and
   requires explicit approval and reconciliation.

Saved-request creation still uses the existing account-scoped idempotency keys
and primary-only authorization links. Catalog receipt isolation does not make
those request creation APIs multi-source. Before a second request source is
enabled, define its exact routing and replay contract without invalidating the
old primary receipts. Open catalog pages may need to refresh their continuation
after deployment; saved selection snapshots do not need to be recreated.

The next local increment implements Operations business projection/leases;
see [business source isolation](business-source-isolation.md) for its verification
and coordinated release gates. It does not enable another live connection.
Still outstanding: explicit business-party linking, an authenticated source
registry, source-aware Delivery mappings, portal root/workspace
ownership, scoped producer credentials, multi-source request routing, and the
user's decision about which source owns staff-role authority. Viewer and
thumbnail runtime changes are outside this increment.
