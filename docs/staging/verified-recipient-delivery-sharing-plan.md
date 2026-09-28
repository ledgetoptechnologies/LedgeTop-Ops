# Verified-recipient delivery sharing plan

This is the implementation plan for connecting an explicitly enrolled
Access principal to one explicitly reviewed delivery resource in the unified
Client portal. This file does not apply a schema migration, enable a Worker
flag, perform a remote read or write, deploy software, or authorize production
use.

## Current authorization and evidence — September 28, 2026

The owner explicitly approved implementing and testing this separate,
default-off, audited recipient-to-folder sharing and revocation workflow in
staging only. The owner also authorized staging migrations and testing. This
supersedes the earlier pending implementation-authorization checkpoint, not the
exact authority, review, backup, migration, or acceptance gates below. Production
rollout and existing public-link changes remain prohibited for this work.

The separate closed command/receipt contract and validation tests are now
implemented locally. It is not yet an integrated or deployed delivery authority;
no client file access or successful end-to-end acceptance is claimed. Existing
home-only enrollment still does not authorize delivery access.

### Local implementation review checkpoint

- Independent review found incompatible native-owner identity, numeric
  generation, access-term expiry, and expected/resulting revision semantics in
  the initial parser. Those are corrected, with explicit package exports,
  native reason-code parity, canonicalized receipts, and no active allows in
  revoke receipts. An independent focused run passed 27 tests, including
  package resolution and hostile-object rejection. This is contract evidence,
  not runtime authority or live access evidence.
- The staging-only readback helper passed an independent local run of 36 tests,
  including execution of every bound query against the complete canonical
  150-migration Operations schema. It has not queried staging or provisioned
  authority. The artifact records the capture interval and explicitly declares
  a non-atomic snapshot. Its readiness output is only preflight evidence, not
  permission to activate an identity or share data; provisioning must recheck
  the live state. An inactive referenced business area fails readiness.
  It requires reviewed per-revision generation inputs, rejects uncancelled
  issued/pending invitations as in-flight work, and labels remote ledger-name
  checks separately from local SQL hashes. Independent review cleared this
  helper for read-only staging capture, not provisioning or activation.
- Remaining implementation includes the audited storage/outbox, exact Client
  acknowledgement and current-identity data-plane checks, coupled revocation,
  owner UI, and live staging acceptance. No production rollout is ready.

## Current boundary and evidence

Recipient enrollment currently produces only descriptive Operations service
home access:

- `apps/operations/src/worker/client-portal-recipient-enrollment-ledger.ts`
  records the exact Access issuer and subject in
  `client_onboarding_recipient_identity_bindings` and enqueues protocol v3 with
  exactly `operations.service_home.read`. Its revoke command sends an empty
  permission set.
- `apps/client/src/worker/client-portal-authority-v2.ts` accepts protocol-v3
  permissions only as `[]` or `["operations.service_home.read"]`.
- `apps/client/migrations/0220_operations_portal_authority_v3_permissions.sql`
  and `apps/operations/migrations/0147_client_portal_authority_v3_permissions.sql`
  preserve the same closed permission vocabulary in storage.
- `apps/client/src/worker/client-portal/operations-service-home.ts` requires the
  exact active v3 grant and reads only service metadata.
- `apps/client/src/worker/client-portal/operations-home-routes.ts` documents that
  the endpoint grants no resource access.

The delivery data plane already exists and should be reused:

- `apps/client/src/worker/client-portal/workspace-v2.ts` resolves a native
  workspace only from an exact active identity and workspace membership. The
  shell requires `workspace.view`; delivery targets require `delivery.view` and
  honor current denies, scope ancestry, source generations, and access terms.
- `apps/client/src/worker/client-portal/authenticated-delivery-grants.ts` reads
  current folder grants and exact recipient snapshots. Existing staff grants
  provide retention evidence but do not independently grant directory access.
- `apps/client/src/worker/client-portal/native-portal-resources.ts` lists the
  authorized folders and files, uses opaque handles, and repeats current
  context, grant, indexed-object, and R2 metadata checks before returning file
  bytes.
- `apps/client/src/client/native-portal-api.ts` and
  `apps/client/src/client/ClientPortalApp.tsx` already provide the native
  Deliveries browser, preview/download paths, workspace switching, and Viewer
  handoff for an authorized native workspace.
- `apps/client/src/client/PortalBootstrapApp.tsx` and
  `apps/client/src/client/OperationsHomeApp.tsx` already preserve the home-only
  experience when Client workspace resources are unavailable.

Operations already has an explicit folder-sharing workflow:

- `apps/operations/src/worker/native-delivery-bindings.ts` performs exact
  source/workspace/project/folder review, authorization proofs, access-term
  validation, idempotent grant creation, publication, and revocation.
- `apps/operations/src/worker/native-delivery-binding-routes.ts` mounts its
  staff-authenticated and mutation-protected HTTP routes.
- `apps/operations/src/client/NativeDeliveryGrantPanel.tsx` presents the exact
  project, recipient, folder, duration, preview, retry, and revoke workflow. It
  states that no public link or notification is created.

## The concrete mismatch

The existing authenticated delivery exact-recipient contract is Project Alpha
principal-specific, not a generic verified-identity contract:

- `apps/operations/src/worker/native-delivery-bindings.ts` searches
  `pa_portal_principals`, requires its current source version, and writes a
  `portal_v2_authenticated_delivery_grant_recipients` snapshot.
- `apps/operations/src/worker/authenticated-delivery-grants.ts` has the same PA
  principal, membership, entitlement, and exact-recipient requirements for its
  primary grant path.
- `apps/client/migrations/0125_project_alpha_portal_projection.sql` defines a
  PA principal as source-published intent whose identity binding must be
  explicit; an email hint is not authority.
- `apps/client/migrations/0137_authenticated_delivery_grants.sql` restricts an
  exact recipient row to a `(workspace_id, principal_public_id)` foreign key in
  `pa_portal_principals`.
- `apps/client/src/worker/client-portal/authenticated-delivery-grants.ts`
  rejects a principal grant when that current PA principal row and source
  version are absent.

Recipient enrollment deliberately stores only the exact Access issuer and
subject. `apps/client/src/worker/client-portal/recipient-enrollment-http.ts`
does not send browser-provided identity fields or email through its private
bridge, and
`apps/operations/src/worker/client-portal-recipient-enrollment-entrypoint.ts`
accepts only the exact issuer and subject from the signed Access proof. The
current flow creates no `portal_v2_identities` row, workspace membership,
entitlement, PA principal, or delivery grant.

Therefore the existing delivery grant API cannot safely grant an enrolled
recipient access as-is. It would be incorrect to:

- infer delivery access from `operations.service_home.read`;
- infer that a customer or client contact may see a delivery;
- bind an enrolled subject to a PA principal by name or email;
- synthesize a PA principal for Operations-owned enrollment;
- use automatic Project Alpha email eligibility as a fallback; or
- replace authenticated access with a public link.

## Proposed separate default-off authority

Add a distinct verified-recipient delivery resource authority. Do not extend
the home protocol-v3 permission vocabulary.

The Operations command must pin all of the following:

- one active `client_onboarding_recipient_identity_bindings.binding_id`;
- the exact Access issuer and subject recorded by that binding;
- the exact recipient-enrollment intent and active revision;
- the exact workspace selection, Client record, Client authority, and native
  workspace;
- one exact active native folder binding, its binding/source version, and its
  exact project owner and current source generation;
- the independently authorized owner, admission/profile versions, Directory
  grant generation, and resource-scoped portal-management authority;
- reviewed customer/collaborator access terms, expiry policy, reason, and
  optimistic resource-authority revision; and
- a unique idempotency operation and immutable audit/receipt lineage.

The command must reject a selection/workspace/client mismatch, a folder outside
that workspace, a stale binding or project version, a different Access subject,
an expired or revoking enrollment, additional browser-supplied permissions,
and ambiguous or replayed bytes under a different operation.

Use a separately named, default-off Operations-to-Client service-binding
method and status receipt, following the durable outbox/CAS/readback pattern in
`apps/operations/src/worker/client-portal-authority-v2-outbox.ts` and
`apps/client/src/worker/client-portal-authority-v2-entrypoint.ts`. Sharing an
implementation helper is acceptable; sharing the home v3 protocol or its
permission column is not.

Client storage should use a parallel exact verified-recipient resource grant
or another explicitly reviewed schema that does not weaken or reinterpret the
PA-principal foreign keys in migration 0137. Its active read proof must bind:

- resource-authority ID and revision;
- issuer, subject, Client identity ID, and native workspace membership;
- exact folder binding and source version;
- grant version, state, access terms, and expiry;
- current native staff publication/binding receipt; and
- the current source/workspace authority and applicable deny state.

The Client projection may use existing `portal_v2_identities`,
`portal_v2_workspace_memberships`, and `portal_v2_entitlements`, whose existing
`operations` source type can represent this origin. The minimum capabilities
are:

- `workspace.view` on only the exact workspace, so the unified portal shell can
  open it; and
- `delivery.view` on only the selected folder.

Do not add `directory.read`, `request.create`, `member.manage`,
`delegated_share.create`, `viewer.share.create`, or any workspace-wide or
other-folder delivery allow.

Because enrollment intentionally does not transport email, identity
materialization should occur only in a current signed Client session. A new
idempotent Client activation POST can match the pre-approved resource authority
by exact issuer and subject, take the verified email only from that same signed
principal, and create or reactivate the existing identity, Operations-sourced
membership, and exact entitlements. It must not search by email. A read-only
status endpoint can let the home-only page show a deliberate **Open shared
delivery** action; no mutation should be hidden in a GET.

## Owner and Client website work

The smallest owner experience is an enrolled-recipient mode alongside the
existing native folder grant panel. It should reuse the existing folder,
project, terms, preview, idempotency, uncertain-result, and revoke controls,
but source recipients only from active exact enrollment bindings constrained
to the selected workspace. The confirmation must show the exact Client,
workspace, project, folder, issuer, subject, access duration, and the statement
that no public link is created.

Likely implementation touch points under the staging-only authorization
recorded above are:

- `apps/operations/src/worker/native-delivery-bindings.ts`
- `apps/operations/src/worker/native-delivery-binding-routes.ts`
- `apps/operations/src/client/NativeDeliveryGrantPanel.tsx`
- `apps/operations/src/worker/client-portal-recipient-enrollment-ledger.ts`
- `apps/operations/src/worker/client-portal-recipient-enrollment-owner-http.ts`
- `apps/operations/src/client/ClientPortalRecipientEnrollment.tsx`
- `apps/operations/src/worker/types.ts` and the relevant Wrangler service
  binding only after configuration review
- a new shared resource-authority contract and the next available, separately
  reviewed Operations and Client migrations
- a new Client private ingress/projector adjacent to
  `client-portal-authority-v2-entrypoint.ts`
- `apps/client/src/worker/client-portal/workspace-v2.ts`
- `apps/client/src/worker/client-portal/authenticated-delivery-grants.ts`
- `apps/client/src/worker/client-portal/routes.ts`
- `apps/client/src/client/PortalBootstrapApp.tsx`
- `apps/client/src/client/OperationsHomeApp.tsx`

Once activation produces the exact workspace and folder authority, the current
native Deliveries UI, file metadata, preview/download, and Viewer routes should
remain unchanged.

## Full-revoke coupling

The current owner button says **Revoke all portal access**, but the current
ledger revokes only the home protocol-v3 grant and then closes the Operations
recipient binding. That remains accurate only while no resource authority
exists.

Before verified-recipient delivery sharing can ship, full enrollment revoke
must become deny-first and receipt-coupled:

1. Record the exact revoke-all operation against the active enrollment
   revision.
2. Send a Client resource-authority revocation that immediately changes the
   authority head used by every delivery read from active to revoked.
3. Tombstone or revoke every derived verified-recipient folder grant and its
   `delivery.view` entitlement.
4. Revoke the workspace shell entitlement and Operations-sourced membership
   only when no other independently reviewed active resource authority still
   requires them.
5. Revoke the home v3 authority.
6. Finalize the Operations recipient binding only after exact Client resource
   and home receipts are current and acknowledged.

Physical cleanup may be eventual, but stale membership, entitlement, grant, or
publication rows must not authorize because all data-plane reads also require
the active resource-authority head. Revoking one folder must preserve other
independently reviewed folder grants. Full enrollment revoke must remove all
derived resource authorities for that binding without removing unrelated
identity authority.

## Acceptance requirements

Add focused Operations unit/route/browser coverage adjacent to:

- `apps/operations/test/native-delivery-bindings.test.ts`
- `apps/operations/test/browser/native-delivery-grants.spec.ts`
- `apps/operations/test/client-portal-recipient-enrollment-ledger.test.ts`
- `apps/operations/test/client-portal-recipient-enrollment-owner-http.test.ts`
- a new joined recipient-delivery acceptance test covering both databases and
  the private receipt round trip

Add Client projection, authorization, resource, and UI coverage adjacent to:

- `apps/client/test/workspace-v2.test.ts`
- `apps/client/test/authenticated-delivery-grants.test.ts`
- `apps/client/test/authenticated-delivery-resources.test.ts`
- `apps/client/test/client-portal-ui.test.ts`
- `apps/client/test/browser/native-portal.spec.ts`

The acceptance suite must prove:

- home-only enrollment exposes service labels but no Client workspace, folder,
  file, Viewer model, or R2 bytes;
- a different issuer/subject, Client record, selection, workspace, project,
  folder, binding/source version, grant revision, or receipt is rejected;
- no PA principal, name, email, contact, or customer-status fallback is used;
- exact activation produces only the selected workspace shell and folder;
- sibling folders, other projects, directory hierarchy, requests, team
  management, delegated shares, and Viewer share creation remain denied;
- stale generation, expired terms, deny rows, suspended membership, revoked
  enrollment, revoked resource authority, and publication drift fail before an
  R2 operation;
- ambiguous create/revoke results replay only identical operation bytes and
  require exact status receipts;
- folder revoke preserves independent access while full enrollment revoke
  denies every derived folder and preserves unrelated identity authority; and
- default-off flags and missing schemas/bindings fail closed without changing
  the current home-only experience.

## Public-link invariance

This work must not change anonymous delivery paths, delegated shares, Viewer
public shares, their URLs or cookies, or their permission gates. In particular,
do not alter the behavior covered by:

- `apps/client/test/public-share-routes.test.ts`
- `apps/client/test/public-share-lifecycle.test.ts`
- `apps/client/test/client-delegated-shares.test.ts`
- `apps/client/test/browser/public-delivery.spec.ts`
- `apps/operations/test/viewer-public-share-routes.test.ts`

Authenticated verified-recipient delivery sharing creates no public link. A
public link remains a separate explicit product with separate permissions and
lifecycle.

## Authorization checkpoint

No implementation should begin from this plan alone. The owner's separate
staging-only implementation and testing approval is recorded above. Keep the
resource-authority contract, additive migration approach, default-off flags,
private service binding, signed-session activation, and full-revoke ordering
explicitly reviewed. Obtain fresh private backups and exact schema/source
readback before staging application; keep live test windows narrowly scoped
and close them through the governed revoke procedure. Production authorization
is not included.
