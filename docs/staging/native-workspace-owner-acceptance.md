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
5. Verify the staging Client publication receipt and exact snapshot, then add
   only the explicitly selected synthetic folder through its audited workflow.
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

Local evidence on 2026-10-02: 11 owner-handler tests passed, Operations
typecheck/build passed, and 35 paired-workspace-profile/scaffold/preflight tests
passed. No live workspace or recipient grant was created by these checks.
