# Source-bound Project Alpha connections

Status: locally implemented and verified, August 26, 2026; not deployed.
No production registry entries, migrations, deployment secrets, or second-source
activation have been changed. This document is not a release announcement.

## What this increment does

- Operations migration `0035` adds a persistent producer registry, immutable
  configuration revisions, permanent signing-key ownership, audited CAS updates,
  write fences, and a directory visibility revision. It does not infer producers
  or rewrite historical projections.
- A source ID, producer ID, HTTPS origin, base path, application key, and authority
  profile cannot be reassigned. A new producer requires a new source identity.
- New connections are pending; secondary business records start hidden. Existing
  primary records retain their visibility. The primary remains the sole staff
  authority, and secondary activation requires an explicitly enrolled active
  primary. Suspending primary pauses all secondary ingestion. Retiring primary
  is terminal and blocks all connector ingestion; this increment has no supported
  reactivation path.
- Primary enrollment must match the existing deployment's destination,
  application key, and known signing identity. Ops Sync owns the webhook secret
  and records its non-secret signing fingerprint in the shared registry;
  Operations validates enrollment against that attestation instead of receiving
  another copy of the webhook credential. Pending primary enrollment is staged
  and does not interrupt the existing scalar snapshot or event path. Activation
  atomically invalidates the scalar proof and hands synchronization to the
  reviewed connector revision. Suspending or retiring the registered primary
  never falls back. Never enroll a replacement producer over an old primary's
  numeric IDs.
- Credential sets are deploy-managed secret references, not browser-supplied
  secrets or database credentials. Current and previous key fingerprints remain
  source-owned after rotation and retirement. Observed trusted legacy primary
  signing keys are reserved even before enrollment.
- Business snapshots resolve their own destination and credential. Signed events
  use `/v1/project-alpha/sources/:sourceId/events`; the URL only selects a candidate.
  Exact Access issuer/audience and service-token Client ID (`common_name`),
  application, and producer signature still have to verify. The registered
  `accessSubject` field stores that Client ID for schema/API compatibility;
  ingress requires the service-token JWT tuple `type=app`, empty `sub`, and
  matching `common_name`. Secondary sources require Ed25519.
- Existing `/v1/project-alpha/events` remains primary-bound. A registered but
  suspended/misconfigured primary never falls back to legacy scalar credentials.
- Source/revision/profile/version guards share every Operations projection write
  batch. A change stops later chunks. Previously committed chunks are not claimed
  to be rolled back. Primary Delivery and Access updates cross storage/network
  boundaries: fresh authorization checks reduce races but are not cross-system
  transactions. Secondary business sync never mutates those authorities.

## Staff-facing behavior

Administration shows a compact connection list with per-source sync status,
manual sync, explicit activation/suspension, and business visibility. Registration
and credential rotation are collapsed details. All routes require an
administrator and deny-aware global `integrations.manage`; writes also use the
existing same-origin/CSRF controls and bounded JSON bodies. Version conflicts are
visible and require a fresh operator action, not a silent retry.

Client Hub's source selector preserves search/history in the URL. Hidden sources
are excluded before pagination and denied on direct business reads. Visibility
and source-label changes invalidate existing directory/detail continuation
proofs. Suspension stops new ingestion but can retain visible business history.

**Business visibility is not access revocation.** It does not revoke client
workspaces, Viewer grants, public links, or independently authorized storage
folders. Those have their own authority controls. Primary business visibility is
not configurable in this increment.

## Deployment contract and limits

`PROJECT_ALPHA_CONNECTOR_CREDENTIALS` is an optional secret JSON object with
`version: 1` and a `sets` map keyed by credential reference. Each set contains
`snapshotApiKey`, an `eventCurrent` object (`keyId`, `algorithm`, `value`), and an
optional `eventPrevious` of the same shape. Never put live values in this file,
source control, an admin request, or logs. Provision matching references in both
Operations and ops-sync before an audited revision/activation. First primary
enrollment additionally needs the known legacy signing configuration available
to Operations; existing scalar settings alone must not be guessed or copied
from unrelated credentials.

A source that accepts staff-created draft quotes adds a `draftQuote` object to
its selected set with `apiKey` and `hmacSecret`. Both values are dedicated to
`portal.quote-draft.create`: they may not equal the snapshot API key, event or
portal signing material, either primary draft scalar, or each other. Operations
stores only domain-separated fingerprints on the immutable connector revision.
Adding or rotating this purpose therefore requires an audited connector
revision; changing the secret envelope in place fails closed. Primary quote
routing remains on its existing scalar configuration and is not implicitly
migrated to the connector registry.

Operations also reserves both draft-quote credentials permanently to their
source. Reservations survive rotation, suspension, and retirement, so another
source cannot claim an older value. A common ownership fingerprint prevents
moving the same underlying secret between API-key and HMAC purposes, while an
exact same-source rollback to a prior credential remains valid.

The repository documents only those two field names and their purposes; it does
not contain example values. See the migration-first activation and rollback
contract in [native portal requests and feedback](native-portal-requests-feedback.md).
Migration `0050_project_alpha_draft_quote_credentials.sql` must be present before
a registered-source draft-quote capability is enabled.

The initial registry is bounded to 32 lifetime producer identities, including
retired entries. Raising that capacity requires a deliberate migration and query
review; deleting a producer to reuse its IDs is unsupported.

The secret envelope permits 64 credential references so operators can stage a
new reference before rotating each of the 32 connectors. Only the selected
credential set is validated for a request: malformed credentials for B must not
disable a correctly configured A. The envelope itself remains strict and bounded
to 256 KiB. References are not additional producer identities.

The original registry increment kept primary daily reconciliation and secondary
manual snapshots/authenticated events. The subsequent
[secondary snapshot recovery increment](project-alpha-snapshot-recovery.md)
adds an isolated hourly schedule and durable source/attempt accounting. See its
own verification and migration status; the registry gate below predates it and
must not be treated as evidence for its new runtime.

## Verification and release gates

The final local gate covered populated upgrades; primary compatibility;
identical A/B IDs, signatures and credentials; rotation and suspension during a
write batch; source-qualified health/receipts; no secondary staff/Delivery/Access
writes; hidden-source exact/read/pagination behavior; admin authorization, CSRF
and version conflicts; and responsive browser workflows.

- Operations: 1,135 unique tests in all 128 test files passed across serial
  partitions. Two initial partitions exposed outdated thin database fixtures;
  those fixtures were upgraded to the real connector schema/source columns,
  then the affected files and remaining partitions passed. No production
  missing-schema bypass or weaker assertion was introduced.
- ops-sync: all 59 tests in four files passed, including synthetic signed-event
  and Access-token verification, cross-source credentials, revision fences,
  suspension, primary compatibility and Access mutation guards.
- Both applications passed type checking and production builds. The ops-sync
  build used Wrangler's dry run, not a deployment. Operations retains its
  existing large-client-chunk build warning.
- 172 desktop/mobile browser tests passed with local synthetic fixtures, covering
  source administration, Client Hub, requests, Job Brief, navigation, current-view
  folder/file counts, scoped recent links and searchable link history. Desktop
  and mobile screenshots were inspected for count placement, wrapping, search
  spacing, section separation and connection controls.

This is not a clean whole-monorepo gate: the repository source-layout invariant
suite passed six tests and failed one pre-existing thumbnail-runbook assertion.
Its expected direct-URL/protocol wording no longer matches the unchanged
loopback-range-proxy implementation. Neither the thumbnail runtime nor that
assertion was changed in this increment; the separate owner follow-up remains
recorded in [Client Hub verification](client-hub-directory.md).

Release requires paired Operations/ops-sync code and `0035`, completion of the
earlier source-provenance migrations, and explicit approval/provenance review for
actual producer enrollment. Missing schema fails closed; there is no missing-table
compatibility bypass. The unpublished Alpha public-ID export and unresolved
business-party/project-memory policies remain separate gates. This increment
does not modify the Viewer or thumbnail runtime.

After registry enrollment, do not roll back only the application to a build that
ignores the registry: the old scalar-primary receiver does not enforce registered
suspension or revision ownership. Prefer a forward correction. If rollback is
unavoidable, pause ingress and scheduled synchronization first, then restore a
reviewed, compatible code/configuration/database checkpoint together. Preserve
the audit and key-ownership history; never delete registry rows to regain the
legacy fallback. Rehearse this procedure locally before enrolling live producers.
