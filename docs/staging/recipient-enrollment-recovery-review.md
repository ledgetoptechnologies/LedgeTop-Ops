# Recipient enrollment recovery review

September 28, 2026. Source review only; no schema, authorization, deployment,
recipient access, production settings, or public links are changed by this file.

## Deployed 0148/0149 baseline, before the unpublished candidate

- `0148_client_portal_recipient_enrollment.sql` allows only issued, pending,
  active, revoking, and revoked states. Operations and commit receipts are
  immutable; there is no cancellation or proof-refresh action.
- Redemption requires an unexpired issued intent and current signed recipient
  proof. Confirmation requires both the intent and recorded recipient proof to
  remain current. Expiry denies confirmation without creating a binding or
  authority command; the row remains pending.
- Owner listing excludes issued rows. The owner page therefore cannot recover
  an abandoned issued link after refresh. Pending rows remain listed but have
  no cancellation control.
- HTTP mutations are confirm, revoke, and reconcile only. Neither browser
  identity fields nor an owner override can extend the recorded proof.

Evidence: `apps/operations/src/worker/client-portal-recipient-enrollment-ledger.ts`
(issue, redeem, inspect, owner listing, confirm);
`apps/operations/src/worker/client-portal-recipient-enrollment-owner-http.ts`;
`apps/operations/src/client/ClientPortalRecipientEnrollment.tsx`;
`apps/operations/test/client-portal-recipient-enrollment-ledger.test.ts`;
Operations migrations `0148` and `0149`.

## Candidate implementation contract

- Add owner-authenticated, same-origin, CSRF-protected cancellation only for
  issued/pending intents. Pin the exact intent, expected revision, operation ID,
  current native owner admission/profile, verified Access subject, Directory
  generation, and applicable portal-manage allow/deny rules.
- Preserve the token digest, target, signed principal, and complete history.
  Cancellation must never create a recipient identity binding, an authority
  command, or access. Active/revoking/revoked intents are not cancellable.
- Preserve applied migrations and existing rows. Evaluate an additive immutable
  cancellation marker with audited CAS/commit evidence rather than rebuilding
  the existing ledger tables. Every read, redeem, confirm, raw-SQL transition,
  and associated command/commit guard must consult the marker; a UI-only filter
  is insufficient. The reviewed candidate is now prepared locally as canonical
  additive migration 0150; the original example is retained locally for comparison
  and is excluded from feature-branch publication.
  Neither source artifact proves application to staging or production.
- Return the recorded outcome on an exact idempotent retry, including after a
  lost response. For new mutations, reject changed digests, stale revisions,
  expired owner proof, changed generations, scoped denies, and
  cancellation/confirmation races. Exact replay may return a full review only
  after rechecking current target authority, including its current generation;
  a recorded cancellation generation is not reusable authority.
  The separately approval-gated minimal
  immutable receipt retry below discloses no target review and performs no mutation.
  Enforce operation-ID uniqueness across the existing enrollment operations and
  the additive cancellation audit, not merely within each table. Historical
  issue/redeem retries after terminal cancellation must deny and require a fresh
  intent; returning the old issued/pending success would misrepresent the current
  state. Preserve the original immutable operations for audit, not as permission
  to resume the cancelled workflow. This supersedes the earlier historical-result
  replay proposal; exact cancellation replay with current target authority is
  supported locally. A minimal receipt after target visibility is lost is a
  separate pending authorization, not implemented server-side.
- List issued intents for authorized owners without revealing their token.
  Show cancellation in the owner UI and preserve the same operation ID on
  uncertain retry. After cancellation, explicitly issue a new intent and obtain
  fresh signed recipient proof; do not refresh or reuse the old opaque token.

## Local evidence and remaining acceptance gates

- Canonical migration 0150 is prepared locally with unchanged reviewed SQL body
  and a corrected provenance header; SHA-256
  `939ecb0d3413070cb9b1f2232993b9e02b0a9dda9538a5e28a95bce5c139d2c3`.
  It has not been applied remotely. Canonical reduced-fixture rerun passed 33/33
  across ledger/HTTP/API/joined suites (`171.16s`, exit 0). Fresh exact-head CI
  remains a separate gate; the earlier
  candidate results below are historical, not deployed acceptance.
- Complete empty-database bootstrap and idempotent reapplication passed 1/1
  (`71.05s`, exit 0) for all 139 Client and 150 Ops migrations, with 9/9 Client
  preflight checks. Node inventory/preflight/evidence/authority preparation suites
  passed 119 with four Windows symlink skips and no failures (`57.918s`).
  Independent review cleared canonical SQL equivalence and the new pins;
  populated-history preservation is separately verified below; real signed-in
  acceptance remains unproven.
- Workspace selection checks passed 22/22 (`75.57s`, exit 0). The first run
  passed 21/22 and timed out only while applying the full migration chain.
  Only that full-chain fixture received a 120-second timeout; authorization
  assertions and other test timeouts were not relaxed. It also asserts exactly
  150 migration filenames and the final 0150 filename.
- The candidate currently has owner issued/pending cancellation, immutable
  cancellation markers, action-specific acknowledgement, cancelled audit reads,
  and actionable listing that excludes cancelled history. It preserves 0148/0149
  rows and constraints rather than rewriting those migrations.
- Root focused ledger/HTTP/API/joined lifecycle run passed 28/28 after correcting
  two observed failures. The expanded ledger plus full-chain compatibility run
  passed 14/14, but independent QA identified some SQL assertions that can be
  rejected by older constraints. Those were replaced with otherwise-valid
  candidate-specific controls. The final frozen five-suite run passed 34/34
  (`202.68s`, exit 0), and independent QA cleared the bounded local candidate.
  Standalone Operations typecheck exited 0. The SQL candidate SHA-256 is
  `39f59ba1e2da27eb5adee080ef98a34df129f722c560950aa655ebaba11e8f04`.
- The frozen populated-history fixture passed 1/1 in the root rerun (`35.22s`,
  exit 0) and implementer run (`35.28s`, exit 0); typecheck exited 0.
  SHA-256 `3c4540fa7667269bdf38f9488ccfa8e0c89700d220967a1e4d77454aa48313ff`.
  Independent review cleared predecessor application through 0149, separate
  valid issued/pending intents, immutable issue/redeem operations and commits,
  and exact history/staff/role/schema snapshots after both failed and successful
  additive 0150 batches. Existing guards were not weakened; the earlier setup
  failure was corrected using valid grant-generation history. This test is
  included in feature publication. It proves local fixture preservation, not
  preservation of actual remote records or a live owner/recipient flow.
- Owner browser matrix passed 14/14 desktop/mobile cases, including known-denial
  reset and uncertain-cancel exact retry; four visual checks passed. Strict client
  API validation passed 10/10. No live or production acceptance is implied.
  Fresh exact-head CI, private staging
  backup/apply/readback, and deployed default-off acceptance
  remain before activation. Local canonical source preparation is not remote
  application or deployment.

- In-progress candidate review found three additional requirements: pending
  requests need an explicit cancel control; destructive cancel acknowledgement
  must be separate from confirm acknowledgement; and durable cancelled history
  must not exhaust the actionable-list bound. Test at least 101 cancelled
  historical intents alongside a fresh pending request without deleting history.
- Exact historical cancellation retries may return a minimal immutable receipt
  to the same currently authenticated actor without repeating a mutation. Keep
  current signed-staff authentication/admission mandatory, and return full
  customer/principal review only if current target visibility still permits it.
  Deny revoked sessions/admissions; do not restore access using old authority.
  Make the response contract and privacy tests explicit. This path is currently
  pending separate authorization and is not implemented server-side.
- Test issued cancellation, expired pending proof, expired intent, replay,
  stale-revision denial, unauthorized/current-authority denial, direct SQL
  bypass attempts, and cancellation versus confirmation. Assert zero new
  bindings, outbox commands, and grants for all cancelled requests.
- Test HTTP and browser behavior, including issued listing and uncertain retry.
- Rehearse the complete historical migration chain and record preservation.
- Independent review cleared the bounded local cancellation guards and ledger,
  canonical SQL equivalence, and inventory pins. This is not clearance to merge,
  apply migrations, or enable a staging acceptance window. The
  permission-history packet inventories were updated coherently to 150 only
  after the prior 149 preparation run was terminal and canonical SQL equivalence
  was reviewed. Generate new run-scoped manifests; retain historical 149 evidence.
- Keep implementation default-off/local and staging only. A positive live
  enrollment/revoke test may proceed with one fresh intent and promptly close
  it; do not describe that as cancellation/recovery acceptance.
- Production readiness remains unproven until recovery is implemented and
  independently tested. Separate emergency access revocation during unresolved
  in-flight work also remains open; normal cancellation is not that mechanism.
