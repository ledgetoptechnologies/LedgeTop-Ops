# Client request draft status verification

## Scope

The Client request list distinguishes a confirmed Project Alpha draft receipt
from an approved request still waiting for handoff. This is a derived read
model, not a request lifecycle transition, quote acceptance, financial approval,
or an additional outbound connection.

Only a non-stale receipt for the exact request source, current request revision,
and current effective area revision sets `projectAlphaDraftCreated`. Existing
primary session joins and native per-row authorization remain required. No
receipt identifiers, document numbers, prices, or editor URLs are added to the
client response. No emails, outbox writes, or production settings change.

Missing receipt schema omits the indicator while preserving current work-area
and stale-quote filtering. Legacy quote/area fallback is reserved for missing
legacy-supported schema, not triggered merely by a missing receipt table.
Terminal lifecycle labels take precedence even if a response includes a receipt.

## Local evidence — September 6, 2026

- Client TypeScript check and production build passed.
- Repository unit tests: 17/17 passed.
- Focused primary/native desktop/mobile request browser cases: 6/6 passed.
- Expanded primary cancelled/declined/completed receipt cases: 2/2 passed on
  desktop/mobile; these overlap the primary cases above, not eight distinct
  end-to-end workflows.
- Writer-contract read-only review found no additional concrete mismatch.
- Full primary/native browser specifications: 184/184 passed after correcting
  old split-notification fixtures to the unified history contract. Original
  run was 172 passed/12 failed; focused corrected notification rerun was 12/12.
- Actual primary/native D1 run: 88 passed/2 failed. The new native combined case
  exceeded its 60-second timeout and the new primary case could not submit its
  fixture. After splitting native cases and correcting primary submission keys,
  the focused rerun passed four cases and failed two: both wrong-source fixtures
  violated composite request/source foreign keys. The fixtures now create valid
  distinct-source requests/receipts, preserving the constraints; both corrected
  focused cases passed. The full three-file rerun then completed 80 passed/14
  failed: the new receipt test left immutable records that the catalog suite's
  per-test cleanup could not delete. Receipt-reader cases now use their own
  migrated database in `service-request-draft-receipt.test.ts`; no immutability
  constraint was removed. The isolated reader and catalog rerun passed 60/60
  (seven receipt cases and 53 catalog cases). Native policy tests (23) and
  repository tests (17) passed in the preceding run: all 100 database cases
  have passed across these runs, not in one combined terminal run.
  The cases cover current,
  stale, wrong-source, revised-request, and revised-area receipts. Do not treat
  mocked SQL assertions or browser fixtures as proof that these queries execute.
- Final review found the pre-0160 receipt schema lacks `source_id`. Both reader
  classifiers now recognize that missing column and omit only the indicator.
  The repository/receipt rerun passed 27/27, including a real database migrated
  through 0159 proving current area data survives and stale quotes remain hidden.
  Client typecheck passed after this correction.

## Release requirements still open

Review the final diff and run the combined release gates
before integrating/publishing. Verify actual PA handoff and client readback in
the deployed authorized workspace. These local results do not establish live
workspace provisioning, dual-domain acceptance, notification delivery, or
completion of the overall Client Portal goal.
