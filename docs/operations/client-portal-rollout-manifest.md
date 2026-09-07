# Client portal rollout manifest

This manifest turns the Client Hub and portal acceptance checklist into ordered,
reversible release windows. It is not authorization to deploy, enable a flag,
create a workspace, send mail, or mutate production. Record secret **names and
readiness only**; never write secret values into this repository.

The 3D Viewer is outside this manifest while Hermes owns that work.

## Authoritative boundaries

- Project Alpha instances remain separate systems of record. Operations may
  present explicitly linked business records together, but must not merge
  producer identities, contacts, projects, portal authority, or billing by
  matching names or email addresses.
- Project Alpha's current onboarding, approval, project, contract, and document
  workflows are authoritative. Every Project Alpha outbound event, including
  portal hierarchy and revocation data, composes through the single External
  Operations profile and Ops Sync endpoint. Project Alpha never calls the
  Client Worker or a `portal.*` hostname directly and must not overwrite or fork
  those workflows.
- Contact assignments and service assignments are factual metadata. Neither is
  an access grant, notification policy, billing authority, delivery recipient,
  or request entitlement.
- Cloudflare Access admits an identity to the application boundary. LTDS still
  requires an active, source-qualified workspace, principal, membership or
  explicit grant as appropriate.
- Public links remain a separate bearer-link product. Portal activation and
  revocation must not rewrite, migrate, or invalidate existing public links.

## Baseline to record before every activation window

Record without secrets:

1. Exact LTDS Operations/Client and Project Alpha commit or image identities.
2. Remote migration ledgers, `PRAGMA foreign_key_check`, and a current D1 Time
   Travel bookmark or equivalent recoverable database backup.
3. Current Worker versions, traffic percentages, cron/queue health, and all
   relevant feature-flag values.
4. Exact connector application/source/workspace identifiers, with sensitive
   identifiers redacted or hashed in committed evidence.
5. Cloudflare Access application ID, audience, destinations, policy IDs, and a
   rollback snapshot. Do not export tested identities.
6. One active canonical public link that can be checked before and after the
   window without changing it.
7. Queue, outbox, notification, and reconciliation backlog counts. Do not open
   a new window while a prior backlog is unexplained.

## Current dormant capability map

`CLIENT_PORTAL_ENABLED=true`, `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true`, and
`CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true` are receiver foundations, not
proof that a client has access. Operations also keeps
`CLIENT_PORTAL_PRIMARY_WORKSPACE_RECONCILIATION_ENABLED=true` for the reviewed
primary reconciliation path.

The following capability families remain off or empty in the production
configuration unless a dated evidence record explicitly says otherwise:

| Capability | Client flags | Operations flags | Required schema/dependency |
| --- | --- | --- | --- |
| Portal hierarchy and eligibility | `CLIENT_PORTAL_HIERARCHY_V2_ENABLED`, `CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED`, `CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED`, `CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED` | Matching hierarchy, eligibility, and deny flags | Signed exact-source projection; automatic producer provisioning/backfill; deny state; Client through `0192` plus current lifecycle-fence migration |
| Service and contact metadata | `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED`, `CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED` | `CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED` | Project Alpha producer approved; Client `0168`, `0174`, `0179`–`0181`, `0190`–`0192`; complete selected generation |
| Membership management | `CLIENT_PORTAL_TEAM_ENABLED`, `CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED`, `CLIENT_PORTAL_ACCESS_ENROLLMENT_READY`, `CLIENT_PORTAL_PEER_ADMIN_ENABLED`, `CLIENT_PORTAL_ADDRESS_BOOK_ENABLED`, `CLIENT_PORTAL_INVITATION_EMAIL_ENABLED` | Matching management and deny-policy flags | Client `0164`–`0176`; Operations `0041`; SMTP only for the email window |
| Authority mutation and audit | `PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED`, `CLIENT_PORTAL_CONTENT_AUDIT_ENABLED` | `PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED` | Client `0172` and `0187`; frozen/drained old writers; dedicated audit HMAC secret |
| Authenticated delivery | `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED`, `AUTHENTICATED_DELIVERY_GRANTS_ENABLED`, `PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED`, `AUTHENTICATED_DELIVERY_CREATION_ENABLED` | The same four flags; Project Alpha delivery-intent/guest flags remain off | Client through `0189`; Operations `0040`, `0042`, `0049`; hierarchy-relation parity; unreceipted binding query empty; create/restore/revoke and kill-switch evidence |
| Notifications and expiry | Delivery notification and invitation-email flags | `AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED`, `PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED` | Client `0169`, `0170`, `0175`, `0177`, `0178`, `0182`, `0183`, `0186`; reviewed SMTP and recipient policy |
| Feedback and requests | `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS`, request-v2/native-request, catalog, assignment-policy, and attachment flags | Draft-quote and related exact-source flags | Client `0168`, `0174`, `0179`–`0188`; Operations `0035`, `0050`; scanner/R2/CORS last |
| Delegated links | `CLIENT_DELEGATED_SHARES_ENABLED` | `CLIENT_DELEGATED_SHARE_SIGNER_ENABLED` | Both signer/session secrets, exact issuer, bounded expiry, recovery route |

The request family includes `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED`; the audit
family includes `CLIENT_PORTAL_CONTENT_AUDIT_ENABLED`. Both remain false. An
empty `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` means no secondary native
feedback source is enrolled.

An omitted optional flag is false. Never treat a UI card, a projected contact,
an Access login, or the presence of a migration as an enabled capability.

## Ordered rollout windows

### R0 — Baseline and recovery

Capture the baseline above and prove both current applications can be restored.
No feature flag changes occur in this window.

Rollback: restore the recorded Worker/config versions. Database restore is an
emergency operation, not the ordinary rollback for additive migrations.

### R1 — Producer and receiver plumbing

1. Keep every consumer capability off.
2. Apply Project Alpha producer migrations only after the Project Alpha branch
   has been approved and rebased on current main. Preserve onboarding,
   approvals, projects, contracts, and documents.
3. For the current default-on release, confirm Client migrations through `0199`
   and Operations through `0052`, plus Project Alpha `0083`. The populated
   `0195` upgrade must prove stale bootstrap authority is invalidated while
   signed native successors and public-link records are preserved. `0197` adds
   the Operations-owned root access overlay. Apply it before either
   Worker enables `CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED`; this lets an
   administrator revoke an organization or standalone-client workspace without
   deleting projected memberships, and later Project Alpha sync cannot clear it.
   `0198` adds the incoming-upload owner-notification outbox required by the
   upload completion transaction. `0199` adds the private Incoming pickup
   lifecycle and its fenced server claim lease. Apply both before deploying the
   dependent Worker so a completed upload cannot fail while recording its
   notification and a pickup server cannot race another claimant.
4. Preserve the exact Project Alpha-to-Ops-Sync connector envelope. Configure
   the private Ops-Sync-to-Client Worker binding and named entrypoint on the
   Operations side only. Do not add another Project Alpha destination, a second
   HMAC, or reuse a read-only Project Alpha API key.
5. Prove signed snapshot, checkpoint selection, recovery, tombstone, replay, and
   root revocation with consumers still off.

Rollback: stop new producer emission only after revocations/tombstones are
acknowledged; retain receiver tables and the producer outbox.

### R2 — Read-only hierarchy and eligibility

Verify the exact hierarchy reader and automatic producer flow in an isolated
fixture first: create an organization client and a standalone client in Project
Alpha, receive their signed workspaces, and bind their verified first logins
without manually creating workspace memberships. Repeat for existing clients
through bounded historical reconciliation. Prove primary and secondary sources
independently, including primary-native resource routing and legacy compatibility.

Activate the five coordinated eligibility/deny/root-policy flags only after unique-email,
duplicate-email, invalid-email, unclassified, administrator-revoked, reparented,
archived, and restored cases pass together. Once the connection is activated,
all eligible clients are default-on; there is no per-client pilot enrollment
requirement. Administrator opt-outs persist. Provisioning/backfill must not send
invitation or announcement emails, and portal eligibility does not grant access
to unshared folders.

The repository-owned deployment gate reads the fixed, committed
`scripts/client-portal-release-profile.json`. The current
`default-on-eligibility` profile explicitly selects the reviewed activation
state with `schemaVersion: 1` and sets the five flags above exactly true in
both Worker configurations. The gate
rejects partial/mixed bundles and keeps invitation, authenticated-delivery, and
project-access-expiry mail disabled. It retains all receiver secret, ingress,
and unrelated Client capability checks. Root Node tests enforce the same
profile rather than silently removing dormant-flag checks.

Authenticated delivery has its own reviewed `primary-authenticated-delivery`
profile. It requires the hierarchy-relations, grant-management, authority-
mutation, and creation switches to match in Client and Operations. Email and
notification flags, Project Alpha delivery intents/guests, membership, peer-
admin, and address-book mutations remain off. Roll back creation first by
selecting `primary-authenticated-delivery-paused`, which requires
`AUTHENTICATED_DELIVERY_CREATION_ENABLED=false` in both Workers while keeping
hierarchy relations, grant enforcement, authority mutations, reads, audits, and
revokes on. Only disable the broader grant-management switch after active grants
have been reviewed or revoked.

This verifies local release intent only: migrations, approved artifact, remote
versions/flags and Operations deny-management readiness require separate
readback before Client activation. See the explicit profile procedure in
[the activation runbook](project-alpha-portal-activation.md). The authenticated-
delivery paused profile only stops new grant, restore, and binding writes; it is
not a general reconciliation pause. Selecting the repository's `receiver-only`
profile is an emergency access-disable rollback, not a promise that reads remain
active.

Rollback: disable new reconciliation, retain identities and denial state, and
keep revocation/recovery reads available. Do not delete a workspace to simulate
rollback.

### R3 — Service and contact metadata

Enable service assignment and schema-v4 contact-assignment producers and
consumers one at a time. Exercise unavailable, not-published, verified-empty,
populated, tombstone, and revoked states. Run J2 before continuing.

Rollback: publish an authoritative empty generation or revocation and wait for
its checkpoint before disabling the consumer. Never infer removal from silence.

### R4 — Membership and access lifecycle

Enable hierarchy/deny reads before membership mutations. Then activate, in
separate windows: membership management, authority mutations, invitation email,
peer administration, and address book. Run J4 after every mutation family.

Rollback: block new mutations first, drain in-flight work, and retain current
reads, revocations, denials, audit, and staff manager recovery.

### R5 — Native delivery

Verify the `0189` unreceipted-active-binding query is empty and explicitly
relink any unprovable legacy binding. Enable authenticated grants, then exact
Project Alpha delivery intents, then primary reconciliation. Run J5 and recheck
the preserved public link.

Rollback: block new grants/intents, revoke or drain accepted work in order, and
retain public links and immutable receipts.

### R6 — Notifications

Enable batching only after exact-recipient policies, SMTP, lease recovery, and
suppression are ready. Observe five-minute coalescing, Send Now, Cancel,
transient retry, and permanent failure independently.

Rollback: stop new batching, let safe leases drain or cancel them explicitly,
and do not reinterpret legacy notification subscriptions.

### R7 — Feedback

Start with `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` empty. Enroll one reviewed
source, run the feedback half of J6, and verify revocation during an active
read. Expanding the source list is a separate window.

Rollback: remove the source from new native authority while preserving existing
feedback history, notices, and audit receipts.

### R8 — Service requests

Enable catalog sync, request v2/native request authority for one source, then
the service-assignment policy only after assignments are active. Attachments are
last and require the pinned scanner, restricted receipt secret, least-privilege
R2 credentials, and consolidated two-origin CORS readback. Run all of J6.

Rollback: stop new draft/submission mutations first; preserve existing request
reads, review state, attachment receipts, and exact quote handoff receipts.

### R9 — Delegated links, expiry, and content audit

Enable the Operations signer and Client delegated-link consumer together. Add
expiry email only after SMTP acceptance. Activate authority/content audit only
inside the writer-freeze and drain sequence in the staging release checklist.

Rollback: disable new creation and producers while keeping revocation,
readback, recovery, and immutable audit data. Do not roll back to an old writer
after an audit collection boundary exists.

### R10 — Joined live acceptance and expansion

Run J1–J7 against the pilot source on both protected domains. Expand to another
source only after all failures are understood and rollback evidence is current.
Never enable every capability globally in one change.

## Local execution partitions

Use pinned dependencies. Run these baseline gates first:

```text
npm run check:worker-types
npm run check
npm run build
node --test scripts/source-layout-invariants.test.mjs
```

Apply Client and Operations migrations to fresh and populated local snapshots,
then run migration-specific tests. On Windows, run Vitest feature partitions in
fresh processes with one worker: identity/Hub; portal projection/services/
contacts; memory/copy-forward; access/expiry/audit; delivery/notifications; and
feedback/requests. Build once, then run the corresponding Playwright partitions
at 375 and 1280 pixels with one worker. Preserve traces/screenshots for failures
and reviewed states.

The currently implemented joined partitions can be run with
`npm run test:portal:joined`, or individually as
`npm run test:portal:joined -- j1` through
`npm run test:portal:joined -- j7`.
The runner starts a fresh single-worker Vitest process for each group. J7 also
runs a four-project Edge matrix against local aliases for both portal hosts at
1280 and 375 pixels. It covers direct links, refresh and browser history,
keyboard logout, session expiry, unauthorized and cross-tenant denial,
revocation during an active read, overflow, exact-origin mutations, and the
canonical public-share boundary. This fixture does not prove Cloudflare Access
configuration, initial identity-provider sign-in, real cookie expiry, or
post-change Access policy readback; those still require the separate authorized
live Access exercise.

Run the full packages in Linux CI before release. The known Windows loopback
exhaustion can produce Miniflare `EADDRINUSE`; it is not permission to omit the
Linux gate or to retry application mutations automatically.

## Live evidence packet

For every rollout window, record:

- exact post-change versions, migration readback, flag values, timestamps, and
  queue/outbox status;
- one idempotent replay, one stale-context conflict, one revocation, and the
  window's rollback proof;
- both portal domains using the same Access application, audience, and policy,
  plus sign-in, refresh, logout, expiry, denial, and cross-tenant evidence;
- canonical public-link behavior before and after access-related changes; and
- desktop/mobile evidence for the affected staff and portal workflows.

Write actual results to the dated production-evidence record. Fixtures and
local tests remain local evidence and must not be labeled live accepted.
