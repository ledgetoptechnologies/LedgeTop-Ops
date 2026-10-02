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

## Portal-preserving candidate follow-up

- PR 144 applies the repair onto staging checkpoint `e2a35675`, rather than
  deploying PR 143's older integration tree over the active portal handlers.
- Combined commit `92cc101a60ad41ca74a06ffe644739fbb6ef21ea` retains
  `staging-native-authority-entrypoint.ts` and newer API-v2 source discovery.
- Operations typecheck/build, 19 focused grant/read/native-staging tests, and
  32 staging scaffold/preflight tests passed. Independent review found no
  source-discovery regression or removed portal handler.
- Live read-only verification on 2026-10-02 returned **Directory 14, Projects 2**
  in the authenticated staging administration page. This was the existing
  deployment `52b6d8d1-f2e4-4904-bf01-953c7aa18a92`, not the new repair.
- PR 143's older tree exposed overlapping field-review controls (514/515 tests
  passed). The combined tree already has committed table containment; its focused
  mobile suite passes all 8 tests without an added stacking workaround.
- Deployed combined staging version `cadcdee9-159b-4f1f-b6c6-9f1e53261556`.
  The owner control returned `already_granted`; exact staging D1 readback confirmed
  one active global allow for `directory.profile.view`, granted by the owner.
  Do not attribute that preexisting grant's creation to this command.
- Disabled the temporary grant flag again in staging version
  `363c9714-bd6f-4eeb-96df-fef681f4a44a`. The approved view grant remains intact.
  The native recipient-enrollment owner page still loads after deployment.
- Full local Operations suite is still running; no full-suite pass is claimed.
  CI run `37037904494` is not green: Operations mobile and both Client browser
  suites passed, but the Client test job failed; its failure is under focused
  investigation. The Operations test job is still pending completion.
- The Client failure was a stale full-chain fixture pin (164 Operations
  migrations instead of the current 165). The fixture now pins migration `0165`
  and its focused complete-bootstrap/idempotency rehearsal passes (1 test).
  No migration, authorization assertion, or runtime behavior was changed by
  this test-only correction. A fresh full CI run remains required.
- Code inspection found that native workspace reservation and publication
  services have test callers but no mounted owner creation route. A separate
  default-off staging owner route is being implemented against those existing
  audited domain services. This is not evidence of a live workspace or recipient
  grant; recovery and authorization acceptance must pass before deployment.
- No PA production update, production client access, or public-link mutation has
  been performed. Positive recipient login/data access still needs an explicitly
  selected synthetic client workspace target and enrollment acceptance.
