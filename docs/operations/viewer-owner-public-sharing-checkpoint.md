# Viewer owner public-sharing checkpoint

## Diagnosis — September 28, 2026

- Read-only Cloudflare deployment/version inspection identified production Ops version `9a2e6997-c8f0-4e7b-ad7a-7d09fff5b4af`, serving 100% of traffic.
- Its non-secret configuration has `VIEWER_INTEGRATION_ENABLED=true`, `VIEWER_PROCESSING_ENABLED=true`, and `VIEWER_PUBLIC_SHARES_ENABLED=false`.
- `viewerAdminPermissions` in `apps/operations/src/worker/viewer-processing.ts` deliberately omits `viewer.shares.create` when the public-sharing feature is disabled. Read/revoke and publication scopes are not suppressed by that flag. This explains publication access coexisting with a missing public-link creation form.
- Canonical migrations 0026 and 0027 already assign explicit supported Viewer management permissions to the global owner role. Individual staff overrides are not required. `sync_protected` protects an account from synchronization changes; it is not a client-supplied authorization bypass.
- Initial workspace issuance, in-place renewal, and reauthorization all request `/api/viewer/admin-grant`; that endpoint recomputes the same server-side permission projection. Viewer should continue enforcing its own explicit permission checks.
- The live permission payload itself was not captured, and no credentials, session tokens, or bearer URLs were logged. The deployed feature-flag check and local regression tests establish the gating cause; they do not replace a fresh deployed dialog acceptance check.

## Verification

- Focused local tests: 31/31 passed across permission projection, administrative browser renewal, public-share route gates, and processing contracts.
- Added canonical owner-role tests using migrations 0026/0027: no individual overrides, consistent repeated projection, sharing kill switch retained, forged attributes ignored, read-only staff/client-like identities restricted, and removed owner assignment no longer authorizes management.
- These are local fixture tests, not live public-link creation or revocation tests.

## Safe next step

- Obtain the owner's explicit approval to enable production public sharing. Do not bypass the feature gate just for an owner or change Viewer to infer missing authority.
- If approved, release only the reviewed production configuration change from an appropriate current production base, preserving unrelated portal work and emergency disable behavior. Keep staging-only recipient enrollment/folder-sharing work out of that release.
- Confirm the deployed non-secret flag, reopen Viewer from Ops with a fresh session, and inspect the Share dialog without submitting it. An existing session does not retroactively acquire new permissions; fresh issuance or successful renewal is required.
- Creating, publishing, or revoking an actual public link still requires explicit approval for the selected resource. Do not expose private measurements by default.

No production settings, grants, public links, role assignments, publication state, or Viewer code were changed for this diagnosis.
