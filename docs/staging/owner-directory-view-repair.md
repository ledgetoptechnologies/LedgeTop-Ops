# Staging owner Directory view repair

This temporary repair unblocks exact-record Directory review for the protected
Operations owner. It is not client enrollment, a PA write, or a production change.

- Default off: `STAGING_DIRECTORY_PROFILE_VIEW_GRANT_ENABLED=false`.
- Enable only in the existing isolated Ops staging configuration, preserving its
  current bindings, secrets, and acceptance flags.
- Required environment and host: `staging` and
  `https://ops-staging.ledgetopdroneservices.com`.
- The connection panel's **Grant owner profile view** action requires explicit
  confirmation and submits only the authenticated owner's own grant.
- Server checks the protected owner, global owner role, `integrations.manage`,
  verified Access identity, active native admission, and current profile version.
  The atomic insert repeats authority checks and rejects an active global deny.
- The only permitted grant is global `directory.profile.view`. No other identity,
  permission, or scope can be supplied by the caller.
- Grant insertion and the audit command share one D1 batch. The audit describes
  an `ensure` attempt, not an unconditionally successful grant. Concurrent retries
  cannot create duplicate grants or reactivate an inactive historic grant.
- After successful grant/readback, disable this temporary flag again. Retain the
  grant/history for the authorized exact-record review.

Local evidence on 2026-10-02: 17 focused route, real-D1 SQL, and read-acceptance
tests pass, including concurrent replay and audit-failure rollback. Operations
typecheck and 28 staging scaffold/preflight tests pass. These results do not prove
live staging enrollment, folder sharing, or the production-update checkpoint.

Remaining acceptance: deploy the reviewed immutable candidate to staging; verify
owner identity and the exact grant; complete exact-record PA/Operations review;
then verify recipient enrollment, scoped folder access, denial and revocation.
Existing public links and all production client access must remain unchanged.
