# Operations follow-up: Viewer session continuity

This supplements the September 5 Operations measurement handoff. Operations
source and deployment were not changed by the Viewer agent. Reconcile against
your current Operations implementation; do not overwrite concurrent work.

September 7 authority update: normal native DSM/DTM stockpile volume and its
parent-linked elevation profile now use scoped Viewer measurement permission
on the server, including authorized clients and temporary public pages. The
historical staff-only calculation note below applies only to specialist methods.
See [current calculation permissions](MEASUREMENT_CALCULATIONS.md) and the
[updated Operations handoff](OPERATIONS_MEASUREMENTS_RELEASE_HANDOFF_2026-09-05.md).
Do not grant general processing privileges to enable normal measurements.

## Viewer-side fixes in this follow-up

- Valid same-scope access survives controller transport timeout while bounded
  retries run. A separate expiry timer still hides private records at expiry.
- Measurement invalidation initiated by session state does not recursively
  request another renewal.
- An access-generation fence rejects a stale request's 401/403 without revoking
  a freshly verified session, even when renewal keeps the same bearer string.
- A current-access denial occurring more than five minutes before expiry does
  not enter a renewal request that the existing controller deliberately ignores.
  It is treated as an authorization problem, not as evidence to bypass access.
- Specialist point/mesh/reconstruction calculation preflight still requires
  independent same-person staff processing authority. Normal raster volume and
  parent-linked profiles use the narrower measurement scope described above.

## What Operations should verify live

1. Viewer session TTL defaults did not change in the examined recent release:
   1,800 seconds, capped at 3,600. Individual redemption can be bounded earlier
   by the upstream grant's `__authorizedUntil`. Inspect deployed configuration
   and server-derived authorization deadlines rather than assuming a signed-in
   Ops page implies an indefinitely valid Viewer capability.
2. Keep a model open through at least two renewal cycles, including a map/cloud
   switch and private measurement save near renewal. Confirm stable individual
   subject, model/version, audience and permission scope.
3. Check the Ops controller/issuer receives, acknowledges and redeems each
   correlated request without navigating through the sign-in page during normal
   cookie refresh. Retry transient transport failures in place; distinguish
   revoked/rejected access from transport errors.
4. Test a tab that sleeps past the renewal window and then resumes. Reauthorize
   in place where authority still exists; require sign-in when it genuinely does
   not. Do not extend an expired/revoked entitlement based solely on cached state.
5. Test staff and an actual individually identified client separately. Keep
   private records isolated; client access remains scoped to explicitly shared
   task/project and never implies import/processing/admin rights.

Useful diagnostics: source/deployed revisions, configured TTL, issuance time,
Viewer expiration, upstream authorization expiration, request correlation ID,
response status/reason and whether the controller was reachable. Record time
deltas, not raw tokens, cookies, signed asset URLs or private measurement data.

No new endpoint contract or blanket longer TTL is requested here. The prior
handoff's identity and sharing requirements remain subject to your current
implementation and live acceptance tests.
