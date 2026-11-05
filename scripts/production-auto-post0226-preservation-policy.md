# Recurring post-0226 preservation policy

`production-auto-post0226-policy.mjs` is an offline policy compiler and
fail-closed loader. It does not create an exact-source human review packet and
does not grant release authority. The checked-in production pin is deliberately
`UNPROVISIONED`; the production policy JSON is absent until the root owner
supplies a real post-release read-only capsule and reviews the resulting public
digest/count policy in source.

## Policy boundary

The compiler accepts only the sanitized observation shape emitted by
`qualifyPost0226Snapshot` / `readPost0226StaffPreservationObservation`. It
requires the invocation's exact main source commit, fixed Operations account
and D1 identifiers, and an observation no older than 60 seconds. The fixed
policy records the base snapshot digest and table counts, login schema digest,
per-table login row digest/counts, bridge mismatch and legacy-active counts,
and preservation-only constraints. Every future observation must match that
baseline. Only `observedAt` and the current invocation source commit may vary;
the current source commit must match the independently source-fenced main CI
release. Native control must remain disabled, and alias linking and full staff
cutover readiness must remain false. Any schema, cohort/control snapshot,
login data, count, flag, target, or freshness drift holds the release.

`compileProductionAutoPost0226PreservationPolicy` returns a reviewable artifact
marked `offlineOnly:true` and `activationEnabled:false`. It does not install or
pin the artifact. `loadPinnedProductionAutoPost0226PreservationPolicy` has no
environment or path override and refuses before reading a file while the
source digest remains unprovisioned. Do not replace the sentinel using a
synthetic fixture or a `verified`/`approved` boolean.

## Integration seams for a later reviewed change

- The ordinary one-shot path is in
  `ordinary-frontend-retained-executor.mjs` (`executeOrdinaryFrontendRetainedRelease`
  and `executeOrdinaryFrontendRetainedProduction`). Its
  `POST0226_STAFF_PRESERVATION_CONTRACT` continues to require the existing
  short-lived exact-source review packet. Keep that contract unchanged.
- The automatic release adapter is in `production-auto-runtime.mjs`
  (`createProductionAutoReleaseAdapter`, `staffReadiness`) and the repeated
  phase checks are in `production-auto-coordinate.mjs`
  (`sourceAndCi`). A later, separately reviewed integration can add a distinct
  preservation-policy adapter that calls the qualified read-only reader and
  validates the pinned public policy at every existing staff-readiness fence.
  Each new observation and standalone receipt must be fresh within 60 seconds
  at its mutation fence. Earlier receipts from the same in-process source run
  may be historical, but the sequence is limited to 32 monotonically timestamped
  receipts over at most 45 minutes, requires its latest receipt to be fresh
  within 60 seconds, and compares every field except `observedAt`. The 45-minute
  bound matches the existing per-worker automatic job timeout; main CI finishes
  before that release job begins. Receipt sequence checks accept only objects
  previously returned by this process's observation or standalone receipt
  validator, then recompute each state digest and compare its baseline fields.
  Native full-cutover readiness and its explicit permissions remain separate.
- The source main/CI fence remains in `runProductionAutoRelease`,
  `ProductionMainCI`, and `coordinateProductionAutoRelease`. Do not bypass the
  current source, account, migration, recipient, or journal checks.
- Migration admission and schema-drift behavior remain held by
  `production-auto-migration-readiness.mjs` and the existing migration gates.
  This policy grants no migration, schema-write, admission, or alias-linking
  permission.
- Preserve the coordinator's old/new asset union verification and 48-hour
  retention floor (`production-auto-coordinate.mjs` and
  `production-auto-runtime.mjs`). Keep `automaticPruning:false`; a profile
  policy does not qualify old asset bytes or authorize pruning.

No automatic runtime integration or production activation is included in this
change. A real reviewed post-release capsule and a separate source review are
required before provisioning the policy digest or enabling the adapter.
