# Staging Directory owner maintenance adapter

This follow-up is local, default-off and not deployed. It establishes no live approval or grant and changes no production setting, PA record, recipient access or public link.

## Normal owner path

- Page: `/administration/staging/directory-maintenance-authority`.
- Independent switch: `NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED=true`, only on the exact Ops staging origin and staging entrypoint. Billing activation alone cannot enable it.
- API base: `/api/native-client-portal/directory-maintenance-authority`.
- `GET /session` uses normal native Access authentication and issues domain-separated, actor/admission/profile-bound CSRF. It does not grant authority.
- `POST /review` accepts only an empty JSON object. The server derives the protected owner identity, target, command/grant UUIDs, verification event and 15-minute expiry. The read-only compiler checks the existing owner/admission/profile and complete grant/history snapshot. Browser-supplied actors, evidence and targets are rejected.
- The verification event records this Worker's successful normal authentication; it is not independent provider-binding proof. The private plan contains staff details. The UI displays only a summary/hash and offers an explicit private JSON download, never logs the plan or JWT.
- `POST /execute` accepts only the preinstalled approval UUID, command UUID, plan hash and explicit confirmation. It loads the immutable approved plan, reauthenticates the caller and invokes the existing atomic executor. It cannot install approval or select a new target.
- Loading the frozen plan does not recompile today's snapshot: a successful first execution changes that snapshot. The executor's current-authority and immutable receipt checks govern exact replay without restoring revoked access.

## Independent approval procedure

- `scripts/staging-directory-maintenance-approval.mjs` is a module-only out-of-band adapter, not a browser route or an automatic approval service. Its trusted caller must obtain the private artifact from the normally authenticated review and explicitly review it.
- Independently read the exact Cloudflare staging account/Worker deployment and version. Require sole 100% traffic, `ENVIRONMENT=staging`, exactly one `OPS_DB` binding to the pinned staging D1, and unchanged deployment across the read.
- Open that physical D1 through the reviewed binding procedure. Use the actual core compiler to reconstruct the private plan and both hashes against live state. Explicit trusted review is required; an arbitrary caller's owner label or plan hash is not approval.
- Recheck the provider pin and recompile the complete plan after review. Insert only a new approval row, with no overwrite/revival and expiry capped to 15 minutes and the identity evidence. No grant or execution occurs in this adapter.
- Provider responses are bounded and failures sanitized. An uncertain approval insert is not automatically retried; inspect its exact durable row before deciding the next action.
- A callable remote runner, the separately verified 195→196 migration window and a fresh preserved-runtime staging release remain outstanding. Do not claim that a local module or configured label proves a live deployment.

## Acceptance still required

- Local evidence: final combined HTTP/client API/dispatch 16 checks, desktop/mobile browser six checks, canonical real-D1 196-chain lifecycle/frozen-plan load/replay one check (144.97 seconds), independent approval adapter eleven checks, Operations type-check and final build pass. These do not prove live staging execution.
- The actual provider read-only binding helper also passed against staging: sole active deployment `f4c7275f-c63e-4f53-aa58-c9a2c583e038`, version `ea0c4689-e6b8-4e40-89bf-860b6de75196`, exact `ENVIRONMENT=staging` and pinned `OPS_DB`, with unchanged deployment across the read. This confirms the current binding, not deployment of this new adapter or migration 0196. The configured token was used transiently and not printed.
- Fresh exact-source CI and local build/type-check before release.
- Guarded migration and staging-only preserved-runtime deployment; then normal review, independent approval and exact execution/replay under genuine native authentication.
- Normal resource-scoped staff billing delegation, recipient financial reads and same-session revocation remain separate actions and tests. This maintenance grant is broader Directory portal-management authority, not an implicit financial or file grant.
- Production PA owner-update checkpoint remains closed until the full sync/portal prerequisites pass.
