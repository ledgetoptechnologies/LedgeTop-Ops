# Native Project Alpha requests and feedback: release contract

Status: implemented and verified locally, August 31, 2026. The schema and
applications have not been migrated, deployed, or activated by this document.
This increment does not change the Viewer.

## Source and authority invariants

Native means a Project Alpha workspace whose authority remains qualified by the
exact source, workspace, verified portal identity, and (when present) project or
delivery target. Upstream public IDs may collide between sources. They are never
global identifiers, never merged, and never resolved through the primary source
as a fallback.

Every native request mutation rechecks, inside the same database write guard:

- the active registered source authority and connector revision;
- the active workspace and complete current directory generation;
- the active identity and membership, including the exact Project Alpha
  principal source version and verified email bound to that membership;
- current allow/deny entitlements for the exact root or project; and
- the exact catalog source and reviewed service versions.

Service assignment is an optional narrowing policy. It never grants
`request.create`, portal membership, catalog access, pricing authority, or a
quote destination. Native feedback uses the same exact source/workspace/identity
boundary and the exact delivery target. A path, email, display name, business
party, or numerically equal upstream ID is not authority.

## Storage-only request owners

Migration `0185_native_service_request_ownership.sql` creates a source-qualified
storage namespace so the established request tables can retain their existing
foreign-key graph. Its synthetic account and identity are persistence details,
not client accounts or authentication bridges. They must never appear in legacy
account administration, activation, account/project listings, folder-grant
pickers, or legacy grant create/revoke routes. The staff request inbox may join
them only to display an already-authorized request.

The binding tuple is permanent. Source, workspace, account, storage identity,
and creation time cannot be updated, deleted, or replaced; only operational
state and update time may change. Do not delete or rewrite these rows during
rollback, account cleanup, or support work.

## Migration-first sequence

The compatible applications require the ordered Client/Delivery migrations
before either final Worker is deployed:

1. Complete the existing `0179` expand-only compatible-writer barrier and apply
   `0180` through `0183` as documented in the staging release checklist.
2. With native request and feedback capabilities still unavailable, apply
   `0184_native_client_feedback.sql`, then
   `0185_native_service_request_ownership.sql`, then
   `0186_delivery_notification_authority_provenance.sql`, then
   `0187_authenticated_content_audit.sql`, then
   `0188_native_feedback_completion_notices.sql`.
3. Apply Operations migration
   `0050_project_alpha_draft_quote_credentials.sql`. It records only
   domain-separated credential fingerprints on connector revisions; it stores
   no credential values.
4. Deploy the paired Client and Operations versions. Confirm
   `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED=false` and
   `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` is empty, and confirm every Project
   Alpha source still advertises native request and feedback capability as unavailable.
5. Verify legacy primary requests, account administration, folder grants, staff
   request inbox, and feedback queue before any capability test.

Do not deploy either final Worker before `0184`-`0186` and `0050` are present.
Operations reads the `0185` ledger to exclude storage-only accounts. Applying
the migrations through raw SQL, out of ledger order, or as a partial copy is not
supported.

## Activation gates

Native requests are a separate default-off flag. Enable
`CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED` only after the ordinary request-v2,
hierarchy, portal projection, and catalog projection gates are already ready and
the release evidence proves:

- colliding IDs remain isolated across two sources;
- suspended, unregistered, stale-revision, and revoked principals fail closed;
- draft save/submit/replay/cancel and attachments remain source-qualified;
- storage-only accounts remain absent from every legacy administration surface;
- the staff inbox keeps the source; and
- quote creation reaches only the exact connector revision and destination.

Project Alpha does not yet publish a separately signed feedback capability.
Until it does, `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` is the deploy-managed,
default-empty stopgap. It accepts at most 32 unique, syntactically valid exact
secondary source IDs, rejects `project-alpha:primary`, and fails closed for the
entire list when malformed, duplicated, or oversized. A listed source still receives no capability unless its current
workspace/principal authority, directory access, feedback schema, and migration
`0188` completion-notice contract all pass. Enable one exact source only after
release evidence proves colliding-target isolation, principal-revision races,
revocation/replay, source-qualified staff triage, and the exact completion
destination. Listing one source never enables another, and primary feedback is
not a fallback. Native completion notices are in-app only; native completion
email remains pending and must not be claimed or inferred from the legacy outbox.

## Connector credential shape

For a registered source that accepts draft quotes, the selected
`PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS` set contains a dedicated `draftQuote`
object with two required secret fields:

| Field | Purpose |
| --- | --- |
| `apiKey` | bearer credential used only for the source's draft-quote endpoint |
| `hmacSecret` | request-signing key used only for the source's draft-quote endpoint |

This document intentionally contains no values. The two secrets must differ
from one another and from snapshot, event, portal, and legacy primary draft
credentials. Provision the secret envelope independently to the required
Workers, then create an audited connector revision whose `0050` fingerprints
match. Never patch a selected secret set in place: fingerprint drift must fail
closed, and a primary scalar credential must never be reinterpreted as a
secondary connector credential.

## Drain, rollback, and recovery

To stop native traffic, first set
`CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED=false` and clear
`CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS`. Wait for capability readback, then
drain in-flight request mutations,
attachment finalization, staff transitions, quote commands, feedback updates,
and native completion-notification writes. Separately drain and record any
primary feedback email leases/outbox state before changing a Worker version;
native completion notices have no email outbox.

Keep migrations `0184`-`0188` and `0050` in place. Do not drop tables, remove
ownership columns, delete storage bindings, reset receipts, or move a row to a
different source. After the first native storage binding exists, an Operations
build that does not exclude storage-only accounts is not a safe rollback target.
After a connector revision enrolls draft-quote fingerprints, a build that does
not enforce those fingerprints is not a safe rollback target. Use the last
compatible version or fix forward.

If a write outcome is uncertain, preserve its idempotency key and exact
source-qualified body. Do not retry against the primary source, a newer
connector revision, or a replacement identity. Resume one source/capability at
a time only after ledger checks, foreign-key checks, legacy-surface isolation,
and exact-destination smoke evidence pass.
