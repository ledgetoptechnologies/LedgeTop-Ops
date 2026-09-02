# Client portal workspace coverage

Operations automatically reconciles an already exact-linked primary Project
Alpha client account into its portal workspace after a successful Project
Alpha synchronization. Client Hub exposes **Portal workspace coverage** for
status and legacy exceptions. It is not a general identity-matching or
account-creation tool.

The workflow separates four facts which must not be collapsed:

1. **Eligibility** — the legacy account is active and already has a provider-
   verified identity linked through issuer and subject.
2. **Workspace provisioning** — the reconciler accepts only the account's
   already stored primary Project Alpha client and organization IDs. Its active
   parent organization is the root; otherwise the client is a standalone root.
3. **Membership** — only existing, active `client_account_members` joined to an
   unrevoked verified identity are projected. Signing in does not create a
   membership.
4. **Access** — only the existing role and project grants are projected.
   Membership is not file, project, request, billing or Viewer authority.

Automatic reconciliation is bounded and idempotent. It skips unlinked,
inactive, zero-member, ambiguous, partial or conflicting accounts, records
aggregate operational counts, and writes one mandatory system audit record for
each completed projection. It never sends an invitation. The UI reports
verified identity, active-member and manager counts and keeps the existing
reviewed activation control only as recovery for a legacy exception.

The legacy-exception action calls the existing audited
`POST /api/admin/client-account-activation/:accountId` contract with the exact
Project Alpha client and the account's expected version. The backend performs
the root link, workspace, directory baseline, memberships, entitlements and
folder bindings atomically. Stale, secondary-source, duplicate-root, partial or
conflicting states fail closed.

## Default eligibility and revocation

“Eligible by default” applies only to people who already have all of these:

- an exact provider issuer/subject identity link;
- an active membership in this exact client account; and
- an unblocked, unrevoked identity and membership.

It does not mean that any user authenticated by Cloudflare Access becomes a
client member. After reconciliation, staff can use the client workspace's **Portal
logins** section to apply or remove explicit sign-in blocks. Project, folder and
resource grants remain independently revocable.

The legacy reconciler does not create arbitrary accounts from `pa_clients`.
Full default opt-in for a new Project Alpha client requires Project Alpha's
signed workspace, principal and entitlement projection. The receiver must have
the matching source authority, Access audience and HMAC credential before the
hierarchy and first-login eligibility flags are enabled. A business contact
email is never sufficient proof of identity or access.

## Deployment and pilot procedure

1. Apply the Client portal migrations. Do not enable a rollout flag merely to
   make the setup control appear ready.
2. Confirm the primary Project Alpha connector and its directory projection are
   healthy.
3. Confirm the post-sync `client_portal.primary_workspace_reconciliation`
   counts. Any conflict or manual-review count is a blocked exception, not a
   reason to widen matching.
4. Open **Client Hub → Portal workspace coverage** with global
   `operations.manage` authority and review any remaining legacy exceptions.
5. Open the projected client workspace and verify Portal logins, membership, sign-in
   blocks and content grants before inviting the pilot user.
6. Run the signed-in, expiry, revocation, unauthorized and cross-tenant Access
   acceptance checks on both client portal domains before broad rollout.

The automatic path is enabled independently from PA-native first-login
eligibility. It cannot create a membership from an email or display-name guess,
and a workspace with no verified authority remains inaccessible.
