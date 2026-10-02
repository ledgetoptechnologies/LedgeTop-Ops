# Native workspace owner staging acceptance

This path prepares an explicitly selected Operations-owned client workspace.
It does not enroll a recipient, share a folder, create a public link, or mutate
Project Alpha. Production registration and production access remain unchanged.

## Configuration

- The staging template provides the private `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION`
  binding to `ledgetop-clients-staging` / `OperationsPortalWorkspacePublicationIngress`.
- Both `OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED` and
  `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED` default to `false`.
- Enable both only on the exact Ops staging host with the existing native
  authority configuration and `OPERATIONS_SESSION_SECRET`. Preserve all other
  deployment variables, bindings and secrets.
- The handler uses the existing reservation, snapshot/publication, invocation
  and dispatch services. It does not insert authority heads directly.
- `scripts/staging-native-workspace-acceptance-profile.mjs` provides a pure,
  validated configuration transformation for paired acceptance: the two Ops
  gates above plus Client `CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED`.
  It changes only those three flags, verifies the private staging destination,
  rejects partial activation and unrelated drift, and performs no file writes
  or deployments. Recipient service-home activation is a separate profile.

## Safe acceptance order

1. Verify current native admission/profile versions and deny-aware grants.
   Staging owner role alone does not replace the domain permission checks.
   Never apply an old authority packet against a different current generation.
2. Create/review a synthetic native client using the existing onboarding flow.
   Use explicit source selections; native-only approval uses `sourceIds: []`.
   Approval still requires its current profile-edit and identity-link authority.
3. Open `/administration/client-portal/operations-workspaces` on Ops staging.
   Enter the exact root record ID/version and explicit target, client-authority
   and workspace IDs. An organization root has a null relationship version;
   a standalone client requires its current relationship version.
4. Reserve and publish. Record the non-secret operation IDs and acknowledged
   revision. A `retry`, conflict, or uncertain transport result is not success.
   The UI retains the exact request for replay and pre-fills the publication
   recovery ID. Do not generate a replacement workspace because an observation
   timed out. Recovery uses a new audited invocation for the same publication.
5. Verify the staging Client publication receipt and exact snapshot. In the
   owner page, load the explicitly selected shared project by workspace target
   and external project ID. Confirm its exact destination division/base prefix
   using the returned project version and complete prior association proof.
   The server derives the confirmer and confirmation timestamp; these are not
   editable authority fields. Then reserve only the selected synthetic folder
   (`reserve-folder-and-publish`), supplying workspace/publication revisions,
   selected prefix, reservation ID and client folder binding ID. Project/base
   confirmation fields are read-only, loaded from the authorized server proof.
   The domain service independently rechecks these inputs and current authority.
   Folder revocation (`revoke-folder-and-publish`) checks the exact reservation
   revision and republishes the complete snapshot at the explicit publication
   revision. Neither operation changes a public delivery link or deletes files.
   Retained uncertain requests may replay only while the visible workspace or
   folder selection still exactly matches their original semantic fields.
   If a selection changed, restore it or use publication recovery rather than
   silently submitting the old retained operation under a new project.
6. Enroll the verified synthetic recipient and test sign-in, selected service
   visibility, selected file access, unauthorized identity denial and revocation.
   Workspace publication alone grants no recipient access.
7. Disable temporary setup flags when acceptance is complete. Preserve audit
   records and document rollback/recovery; do not alter existing public links.

## Evidence boundary

Local adapter and scaffold tests are not live sign-in/data proof. Full PA–Ops
reconciliation, retry/idempotency and portal acceptance remain release gates.
Only after those gates pass should the owner production PA update checkpoint
be requested.

## Local paired configuration checkpoint — 2026-10-02

- Reconstructed the missing default staging configurations with the reviewed
  scaffold and existing validated non-secret values; no existing config was
  overwritten. Full staging preflight passed.
- Generated and checked the paired native recipient service-home profile.
- Rendered the separate workspace profile through its pure builder, wrote the
  pair locally, and revalidated the actual on-disk files against the bases.
- All seven generated staging config files are ignored by Git, including the
  scaffold's separate ops-sync base. No config or private values were published.
- Client local build passed. Wrangler 4.118.0 dry-runs passed for both apps in
  both windows (four bundles). Ops dry-runs also built the existing local
  renderer image; no image upload or remote resource change occurred.
- Workspace profile files are `apps/client/wrangler.staging.native-workspace-acceptance.json`
  and `apps/operations/wrangler.staging.native-workspace-acceptance.json`.
- Recipient profile files are `apps/client/wrangler.staging.native-portal-acceptance.json`
  and `apps/operations/wrangler.staging.native-portal-acceptance.json`.
- These are validated local candidates, not live activation evidence. Before
  deployment, pin the accepted release revision, check actual deployed
  configuration/bindings and migration readback, and retain the exact rollback
  versions. GitHub publication and exact-head remote CI remain separate gates.
- Open the workspace window Client then Ops; close it Ops then Client. Open the
  recipient service-home window Ops then Client; close it Client then Ops. Do
  not hand-combine the independently validated activation windows.
- The synthetic onboarding permission rehearsal left no active grants. Actual
  onboarding acceptance still needs its own reviewed bounded provision/revoke.

Local evidence on 2026-10-02: 14 owner-handler tests passed, including exact
folder reserve/revoke, domain-denial short circuit and replay; Operations
typecheck/build passed, and 35 paired-workspace-profile/scaffold/preflight tests
passed. No live workspace or recipient grant was created by these checks.
