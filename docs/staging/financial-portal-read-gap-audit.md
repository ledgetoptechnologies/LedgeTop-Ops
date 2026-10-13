# Financial portal read — source audit and proposed next slice

September 28, 2026. Read-only audit; no new endpoint, scope, entitlement,
recipient binding, migration, flag, or deployment is implemented by this file.

## Findings

- Project Alpha is authoritative for financial documents and financial emails.
  Its legacy financial summary is installation-wide revenue/expense/profit,
  not an individually authorized client billing summary. Legacy invoice API
  scopes are insufficient recipient/document authorization.
- API-v2 already binds service credentials to source/application/history, but
  finance is absent from its capabilities. New financial reads must be opt-in;
  the six existing default-on reads do not authorize finance.
- Invoice, contract, and project-invoice models need a reviewed opaque public
  identity and document-currency contract. Unknown historical currency cannot
  silently become USD or be combined into a single balance.
- Client billing readiness is currently `not_supported`. Local membership
  `can_view_billing` is an additional gate, not proof of a PA billing entity or
  financial-document entitlement. Account-wide summaries require an explicit
  billing-entity mapping; customer units may share or have separate billing.
- `pa_public_link_active()` is a pure existing-link lookup. Link status,
  terminalization, link creation/reuse, and email helpers may mutate state and
  must not be called by a summary GET.
- `can_view_invoice_links` and `send_project_invoices` have distinct meanings.
  Viewing must not subscribe a person to financial email or send duplicate mail.

## Evidence locations

PA evidence was checked by the audit agent against the clean cached main
revision `1513b6a8`, not the dirty primary checkout at `b847852b`:

- `src/controllers/api/financial_summary.php`, `invoices_list.php`
- `src/utils/api_auth.php`, `api_v2_directory_read.php`,
  `api_v2_capabilities.php`, `public_links.php`
- `database/baseline.sql` invoice/contract/project-invoice definitions
- migrations `0062_client_portal_foundation.sql`,
  `0066_generic_portal_v2_integration.sql`, `0068_portal_contract_completeness.sql`

Ops/Client evidence:

- `apps/client/src/worker/client-portal/native-workspace-readiness.ts`
- `apps/client/migrations/0097_client_portal_team_acl.sql`
- `apps/client/migrations/0192_contact_assignment_billing_independence.sql`
- `apps/operations/src/worker/project-alpha-project-read-api-v2.ts`
- `docs/operations/api-first-migration-plan.md` financial visibility register

## Proposed first vertical slice — not an approved implementation contract

- Start with an exact project-scoped summary, not an account-wide adapter over
  the legacy financial API. Use a new default-off read flag and exact new
  summary scope; returning bearer action links requires a separate scope.
- Bind the authenticated recipient explicitly to an application-bound PA
  financial identity. Require a current principal/client relationship, current
  allow and no deny, and exact project/client/document relationships. Never
  infer identity or billing authority from email, names, or workspace presence.
- Keep PA credentials server-side in Ops. Client uses a private service bridge,
  never browser-to-PA credentials. Default-off staging tests precede rollout.
- Return finalized document amounts grouped by known currency, due/paid state,
  dates, contract state, and a bounded revision/as-of contract. Avoid counting
  project-aggregate child invoices twice.
- Return an already-existing authorized action link or `null`. Verify current
  link/document state and canonical PA HTTPS origin/path. Never create a token,
  use a stored redirect, send email, or write during a read. Stale/unavailable
  summaries must not show unknown debt as zero or permit stale payment actions.

## Acceptance required before readiness claims

- PA scope/default-off, binding, source/application/epoch, recipient/client/
  project/document, deny/revocation/expiry tests; legacy scopes inherit no access.
- Due/partial/paid/refund/reversal and contract-state cases; separate currencies;
  aggregate-child nonduplication; missing historical currency remains unavailable.
- Database snapshots prove zero document/link/token/notification writes on reads.
- Ops strict response identity, bounds, origin, request correlation and DTO checks;
  local billing allow alone is insufficient; wrong source/project/person denies.
- Revocation and stale-cache tests, with action links disabled when authority
  cannot be revalidated; desktop/mobile billing presentation.
- No Ops duplicate financial email or receipt.

## Questions and recommendations

- Who can create/revoke the recipient-to-PA financial identity binding?
  Recommendation: explicit, audited owner/billing administration, never matching.
- Must project `can_view_invoice_links` also be true for action links?
  Recommendation: yes, in addition to individual entitlement and API scope.
- How should historical document currency be backfilled?
  Recommendation: explicit verified backfill; missing currency stays unavailable.
- Which paid invoices expose a receipt rather than a payment action?
  Recommendation: define and test receipt-specific semantics separately.
- How long can financial data be cached, and how does revocation invalidate it?
  Recommendation: do not treat cached grants as ongoing authority; stale display
  may be read-only and clearly dated, but links require current authorization.
- How do customer units map to shared versus separate billing entities?
  Recommendation: explicit mappings; account-wide rollups follow the project slice.

This audit identifies remaining work; it does not prove financial portal readiness
or authorize a new security boundary. No tests were run for this read-only audit.
