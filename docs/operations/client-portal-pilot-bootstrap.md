# Client portal pilot bootstrap

The Client Hub exposes a staff-only **Client portal setup** workflow for the
first Project Alpha-backed client workspace. It is a narrow bridge for an
existing primary Project Alpha client and an existing legacy client portal
account. It is not a general identity-matching or account-creation tool.

The workflow separates four facts which must not be collapsed:

1. **Eligibility** — the legacy account is active and already has a provider-
   verified identity linked through issuer and subject.
2. **Workspace provisioning** — an operator explicitly selects one active,
   primary Project Alpha client. Its active parent organization is the root;
   otherwise the client is a standalone root.
3. **Membership** — only existing, active `client_account_members` joined to an
   unrevoked verified identity are projected. Signing in does not create a
   membership.
4. **Access** — only the existing role and project grants are projected.
   Membership is not file, project, request, billing or Viewer authority.

The UI reports verified identity, active-member and manager counts before the
operator can review the change. It will not present an empty-member account as
a usable pilot. Equal Project Alpha display names are blocked rather than
exposed as opaque IDs or guessed by name/email. Resolve the duplicate in
Project Alpha, then refresh the setup status.

The final action calls the existing audited
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
client member. After setup, staff can use the client workspace's **Portal
logins** section to apply or remove explicit sign-in blocks. Project, folder and
resource grants remain independently revocable.

## Deployment and pilot procedure

1. Apply the Client portal migrations. Do not enable a rollout flag merely to
   make the setup control appear ready.
2. Confirm the primary Project Alpha connector and its directory projection are
   healthy.
3. Open **Client Hub → Client portal setup** with global
   `operations.manage` authority.
4. Select the existing client portal account and the exact Project Alpha root.
5. Review the member counts and projected-access summary, then create the
   workspace.
6. Open that client workspace and verify Portal logins, membership, sign-in
   blocks and content grants before inviting the pilot user.
7. Run the signed-in, expiry, revocation, unauthorized and cross-tenant Access
   acceptance checks on both client portal domains before broad rollout.

The setup workflow does not mutate live state until the final reviewed action,
does not enable rollout flags and does not create a membership from an email or
display-name guess.
