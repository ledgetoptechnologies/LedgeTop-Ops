# Client peer administrators

## Purpose

An existing organization member can be given local team-management authority without creating another identity, changing Project Alpha, or changing the person's ordinary workspace access. This is a client-side convenience overlay for a verified member of the exact workspace.

The workflow is default-off behind `CLIENT_PORTAL_PEER_ADMIN_ENABLED`. It also requires the existing hierarchy and membership-management flags.

## Authority boundary

- The initiating person must currently hold deny-aware, non-expiring `workspace.view` and `member.manage` authority at the exact workspace root.
- The workspace must be an active primary Project Alpha organization workspace.
- The target must already be an active, non-expiring local member of that workspace with non-expiring workspace viewing access.
- Project Alpha-managed memberships and manager entitlements remain read-only in the Client Portal.
- Promotion adds only a versioned, local `member.manage` entitlement. It does not create a membership, identity, Project Alpha user, delivery grant, or billing permission.
- Demotion revokes only local Operations-owned manager entitlements. Membership and all unrelated capabilities remain unchanged.
- A manager cannot remove the last effective manager. Project-scoped or finite authority cannot be used to appoint an organization administrator.

## Write safety

The API requires an idempotency key and the manager version shown by the access read. A D1 batch rechecks the actor, target, canonical primary-source ownership, active projected organization root, expected version, entitlement and identity deny state, bounded policy capacity, and last-usable-manager invariant at transaction time. Commands and audit records are append-only. A timeout may be retried with the same key and exact body; a different payload with that key is rejected.

## Rollout

1. Apply migration `0167_workspace_peer_administrators.sql`.
2. Keep `CLIENT_PORTAL_PEER_ADMIN_ENABLED=false` while schema and access data are checked.
3. Verify that each intended organization has at least one current Project Alpha or staff-recoverable manager and that local members have the expected non-expiring workspace membership.
4. Enable the flag for the Client Worker deployment.
5. Exercise promotion, replay, demotion, and last-manager rejection in the target environment before announcing the feature.

Turning the flag off hides and rejects new peer-administrator changes without revoking authority already granted. Existing local manager authority can still be recovered by staff tooling.

## UI behavior

Eligible members show **Make administrator**. Eligible local administrators show **Remove administrator** only when another effective administrator exists with both workspace viewing and management authority. Every change has a review step explaining its scope. Project Alpha-owned administrators are labelled as managed there. Removing administrator access never removes the person from the workspace; suspension remains a separate action. An ambiguous network result locks other team mutations and offers an operation-specific safe retry that reuses the original idempotency key and body.
