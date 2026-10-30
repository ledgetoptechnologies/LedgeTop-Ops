# Read-only pilot rollout

October 29, 2026. This is a source and local-test checkpoint, not deployment approval or evidence of live sign-in.

## Scope

The Access-protected `/api/mobile-pilot/authorize` issues a short-lived, single-use PKCE code for the fixed native callback. `/mobile-pilot/v1/token` exchanges it for a hashed-at-rest opaque session lasting no more than fifteen minutes or the originating Access expiry. The separate facade exposes session, paginated operations, operation details, and logout. Existing staff, assignment, source, and native-admission cutover rules remain authoritative. Mobile tokens cannot authenticate to the general API. Authentication bookkeeping is allowed; business mutations and connector reconciliation are not.

`IOS_PILOT_ENABLED` is absent/off in deployment configuration. The client also ships with `LTOpsLiveEnabled=false`. Neither switch has been enabled remotely.

## Activation gates

1. Recheck current release ownership, deployed schema, source revision, and provider settings. The last Hub note reported ledger 225; source migration 0232 is not permission to apply intervening migrations. Review prerequisite tables and the actual migration plan first.
2. Verify the approved synthetic staging connector manifest and staff/source permissions. Resolve configuration mismatches through the existing configuration process; mobile reads deliberately cannot repair them.
3. Keep the browser authorization endpoint behind Access. Review ingress for only the exact native facade paths, where opaque sessions are validated by the Worker. Do not bypass Access on the general API. Confirm worker-first routing reaches the facade instead of SPA fallback.
4. Deploy the reviewed staging revision and migration through the established release process, then explicitly enable the backend and client for that approved staging origin. Keep production unchanged until separately qualified.
5. Build against a real Apple SDK and install on the iPad. Complete the device checklist in README.md: browser callback, cancellation, logout races, expiry/revocation, scope filtering, pagination, and network errors. Local syntax parsing is insufficient.
6. For rollback, disable the pilot flag and revoke pilot sessions as appropriate. Preserve existing web assets under the established retention policy; do not prune shared release resources.

The current worktree preflight reports missing generated staging configs and an
outdated ordered migration inventory: 11 Delivery and 32 Operations filenames
are newer than the checked-in contract; none named in that contract are missing.
This is not evidence of the remote staging ledger. Migration 0232 itself creates
only pilot credential tables and indexes, but the running authentication code also
depends on the staff login binding schema introduced in 0226. Applying 0232 in
isolation would therefore not prove that the pilot can safely authenticate. Review
the actual staging ledger and the complete dependency chain with the release owner.

## Local evidence

- 15 real-D1 mobile integration tests passed, including atomic redemption, scope and revocation races.
- One focused connector regression passed, confirming no registry or audit writes during validation.
- 15 Worker-mount, native-auth and visibility tests passed.
- 43 staging scaffold/preflight tests passed.
- Final full Operations TypeScript check passed after mount-test additions.
- Root checks: 14 workflow-policy tests, 18 visibility/host-admission tests and 56 deployment-guard tests passed. Some coverage overlaps the agent runs above.
- Independent source review found no remaining blocking source issue. Runtime ingress, deployment and device tests remain outstanding.
- An earlier D1 run hit a Windows 30-second timeout; the bounded rerun with a 120-second test budget passed. This is recorded separately from assertion results.

No feature-branch Actions, production deployment, migration, account policy change, or live business-data mutation was performed for this checkpoint. Private-repository branch protection was unavailable on the current GitHub plan; PR-only changes remain a working convention.
