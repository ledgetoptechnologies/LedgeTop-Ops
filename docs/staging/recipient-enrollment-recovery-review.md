# Recipient enrollment recovery review

September 28, 2026. Source review only; no schema, authorization, deployment,
recipient access, production settings, or public links are changed by this file.

## Confirmed behavior

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

## Recommended next implementation

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
  is insufficient. This design is not yet implementation or migration evidence.
- Return the recorded outcome on an exact idempotent retry, including after a
  lost response. Reject changed digests, stale revisions, expired owner proof,
  changed generations, scoped denies, and cancellation/confirmation races.
  Enforce operation-ID uniqueness across the existing enrollment operations and
  the additive cancellation audit, not merely within each table. Historical
  issue/redeem retries after terminal cancellation must deny and require a fresh
  intent; returning the old issued/pending success would misrepresent the current
  state. Preserve the original immutable operations for audit, not as permission
  to resume the cancelled workflow. This supersedes the earlier historical-result
  replay proposal; exact cancellation-receipt replay remains supported separately.
- List issued intents for authorized owners without revealing their token.
  Show cancellation in the owner UI and preserve the same operation ID on
  uncertain retry. After cancellation, explicitly issue a new intent and obtain
  fresh signed recipient proof; do not refresh or reuse the old opaque token.

## Acceptance gates

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
  Make the response contract and privacy tests explicit.
- Test issued cancellation, expired pending proof, expired intent, replay,
  stale-revision denial, unauthorized/current-authority denial, direct SQL
  bypass attempts, and cancellation versus confirmation. Assert zero new
  bindings, outbox commands, and grants for all cancelled requests.
- Test HTTP and browser behavior, including issued listing and uncertain retry.
- Rehearse the complete historical migration chain and record preservation.
- Complete independent review of the new cancellation guards and ledger before
  changing migration inventories or enabling a staging acceptance window. The
  current permission-history packet review remains pinned to 149 Ops migrations;
  do not change that inventory underneath its ongoing test run.
- Keep implementation default-off/local and staging only. A positive live
  enrollment/revoke test may proceed with one fresh intent and promptly close
  it; do not describe that as cancellation/recovery acceptance.
- Production readiness remains unproven until recovery is implemented and
  independently tested. Separate emergency access revocation during unresolved
  in-flight work also remains open; normal cancellation is not that mechanism.
