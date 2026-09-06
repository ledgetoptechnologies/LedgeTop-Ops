# Confirmed Project Alpha draft notifications

## Contract

A successful, current draft-quote receipt queues an informational client notice
in the same database transaction as the receipt. This does not accept a quote,
change the request lifecycle, grant access, enroll a new PA instance, or add
another outbound integration endpoint.

Existing historical receipts are not scanned or announced retroactively. Replays
of receipts saved before this writer keep their existing idempotent behavior;
this release does not backfill unsolicited client notices.

Primary recipients use the existing requester notification delivery policy.
Native recipients use an explicit `native_request_owner` intent and in-app
delivery only; no native email fallback is authorized by this change.

The native dispatcher must recheck the exact request, source, workspace,
identity, storage recipient, current receipt and request/area revisions. Active
membership, source authority, generation, root policy, scoped entitlement and
deny rules remain required. A workspace-level request must work without an
invented project grant. Client and Operations share the bounded lineage SQL.

Inbox insertion, sent audit, and outbox completion occur in that order in one
transaction under the current attempt and live lease. An exact existing inbox
record is a successful replay; a conflicting dedupe record is not. Transient
database errors enter bounded retries rather than masquerading as revocation.
Insertions ignore only the explicit deduplication conflict. They must not use
blanket `INSERT OR IGNORE`: a missing enum migration must fail and roll back,
not silently save a receipt without its notification intent.

## Migration 0201

The migration expands existing notification event/recipient constraints without
discarding outbox attempts, leases, terminal state, inbox read/dismissed state,
indexes or foreign keys. Explicit column copies include `rowid`: unified history
cursors use it as their snapshot high-water mark, so compacting row gaps during
the rebuild would change the meaning of an already-issued cursor.

## September 6 local verification

- The mocked notification suite passed 23/23 against the final transactional
  rewrite, including targeted-upsert, primary receipt preflight, stale lease,
  and database-failure retry assertions. The retry fixture now verifies the
  exact simulated database error, not an earlier mail-configuration error.
- Review found and corrected audit-after-sent ordering, pre-read replay proof,
  swallowed database errors, missing current-receipt checks and migration rowid
  preservation. Updated mock and real D1 cases are being run against the changes.
- One interim typecheck found an incomplete test Env fixture; its correction is
  complete. Client and Operations typechecks both pass after the transactional
  rewrite and transaction-time project retention check.
- Populated migration tests: 3/3 passed, including every outbox state, inbox
  read/dismissed combinations, row gaps, constraints/indexes/FKs and post-upgrade
  high-water behavior.
- Real D1 native dispatcher tests: 8/8 passed in one terminal run against the
  current runtime. Coverage includes root delivery/replay, revoked membership,
  stale receipt, request/area changes, conflicting dedupe, root denial and
  revoked entitlement, without native mail.
- Client migrated-D1 history/readback tests: 2/2 passed for existing request
  notices and the new draft event; each is hidden after project access revocation.
  The other 12 cases in that file were not selected in this focused run.
- Native migrated-D1 history/readback: 1/1 joined test passed for intended-owner
  visibility, distinct identity/workspace/source isolation, entitlement revocation
  hiding the notice, and membership revocation denying the request. Its final
  expanded run also passed both cross-workspace denials, actual read/dismiss
  PATCH calls, foreign mutation denial, and history/DB read/dismiss state.
- Producer-route tests: 51/51 passed after targeted duplicate handling. The
  regression rebuilds the actual historical 0118 outbox CHECK, demonstrates
  that blanket ignore silently drops the event, verifies atomic rollback with
  the corrected producer, then applies 0201 and successfully retries.
- Client and Operations production builds passed. Both retain large-chunk
  warnings; build success is not a browser performance acceptance result.
- Follow-up review extended the primary sent/suppression updates with the same
  attempt/live-lease fences; Operations typecheck and focused regressions pass.
  External mail is not atomic
  with D1; stable Message-ID and bounded retries retain the existing policy.

## Required before release

Run the final Operations/Client typechecks, updated notification tests, real D1
dispatcher tests, populated migration tests, producer-route tests and combined
release gates. Verify current/replayed receipts, revoked/expired authority,
changed revision/area/source, stale worker leases, root/project scope, conflicting
inbox dedupe and no native mail. Test actual client history readback as well as
inbox insertion. No live mail, migrations, configuration changes or deployments
have been performed for this isolated implementation branch.
