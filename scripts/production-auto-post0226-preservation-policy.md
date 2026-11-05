# Recurring post-0226 preservation policy

`production-auto-post0226-policy.mjs` is a fixed-state policy compiler and
fail-closed loader. The checked-in public policy is derived from the reviewed
read-only observation captured at 2026-11-05T15:33:36.163Z on source commit
`2686c535658398baf746b78a41e8af6b79f04538`. Its policy digest is
`915025b52c29bc69ad8c92e503f4df2c9084f41157d0b148f4430de67dc91e33`; the
observation digest is `7cb6ab22d324caafd86910b6f738a514d45cf37b589087a0e91d886013dcb29d`.
The provenance note contains no staff identities, row contents, or credentials.

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

`compileProductionAutoPost0226PreservationPolicy` remains an offline compiler.
The runtime loader has no environment or path override and checks the exact
source-pinned digest before using the public policy. The original capsule is
offline-only and enables no cutover or alias linking.

## Automatic release integration

- The ordinary one-shot path is in
  `ordinary-frontend-retained-executor.mjs` (`executeOrdinaryFrontendRetainedRelease`
  and `executeOrdinaryFrontendRetainedProduction`). Its
  `POST0226_STAFF_PRESERVATION_CONTRACT` continues to require the existing
  short-lived exact-source review packet. Keep that contract unchanged.
- The automatic release adapter is in `production-auto-runtime.mjs`
  (`createProductionAutoReleaseAdapter`, `post0226Preservation`), the Sync
  adapter is in `production-auto-sync-runtime.mjs`, and repeated Ops phase
  checks are in `production-auto-coordinate.mjs` (`sourceAndCi`). Both adapters
  call the qualified read-only reader and validate the pinned policy at every
  existing source/CI and mutation fence. The old schema2 review remains only in
  explicitly selected historical and coordinator-test paths; production
  automatic releases do not read that review environment variable.
  Each new observation and standalone receipt must be fresh within 60 seconds
  at its mutation fence. Earlier receipts from the same in-process source run
  may be historical, but the sequence is limited to 250 monotonically timestamped
  receipts over at most 45 minutes. The uploader reserves the journal's fixed
  non-bucket mutations under its 256 total-intent cap, leaving at most 243
  asset-bucket intents; seven fixed Ops preservation fences set the receipt bound. The
  sequence requires its latest receipt to be fresh
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

The policy records preservation state only. It does not authorize staff
cutover, migration, schema writes, alias linking, or automatic asset pruning.
