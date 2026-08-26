# Connected workspace feature readiness

The native client portal reports a small, read-only feature-readiness map from
`GET /api/client/v2/workspaces/:workspaceId/context`. It answers one question:
what can this exact signed-in identity use in this exact connected workspace
right now?

This is operational readiness, **not** a list of services purchased, assigned or
included in a contract. Service assignment still requires its own authoritative,
versioned Project Alpha contract. Catalog visibility, account eligibility and a
similarly named customer are not service entitlements.

## Authority and state

The context route first resolves the current source authority, active directory
generation and root, exact global identity, active workspace membership, current
grants and current denials. It rechecks the resulting context version after the
delivery-backend readiness check. The response contains no internal grant,
denial, storage-path or connector-secret detail.

Feature states have bounded meanings:

- `available`: the surface is operational. Directory readiness requires a
  bounded current target-lineage proof evaluated with entitlement-deny and
  identity-deny precedence; an allow row by itself is insufficient. Delivery
  readiness means its backend contract is present; each folder and file is
  still authorized individually when read.
- `not_in_access`: the surface is supported, but the current workspace context
  has no qualifying capability.
- `temporarily_unavailable`: the source supports the surface, but its backend
  contract is not ready. Existing records and shares are not deleted.
- `not_supported`: this native Project Alpha source does not implement that
  portal surface.

Service requests, feedback, 3D models, member management and billing remain
`not_supported` for a secondary native source. The client must not probe legacy,
primary-source or Viewer APIs to make them appear available. Existing authorized
request or feedback history is preserved when new creation is unavailable; this
readiness response does not mutate or revoke it.

Readiness is only a navigation and explanation aid. Every directory entity,
delivery folder, file metadata response, preview and download keeps its current
target-specific authorization and source/workspace/context envelope checks.

## Verification

- `apps/client/test/native-workspace-readiness.test.ts` fixes the server-owned
  state contract, proves workspace-deny precedence and expired-only failure,
  preserves an authorized project-only surface, and keeps unsupported secondary
  write surfaces off.
- `apps/client/test/client-portal-ui.test.ts` rejects native context responses
  that do not include the verified readiness shape.
- `apps/client/test/browser/native-portal.spec.ts` verifies the visible meaning,
  fail-closed capability/readiness consistency, no optimistic protected probes,
  responsive layout and no legacy or Viewer requests.

No schema migration or Viewer change is part of this increment.
