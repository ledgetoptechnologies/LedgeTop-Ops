# Client portal Project Alpha financial summary

The portal may show a linked Project's current invoice status and already-existing client invoice/payment URLs from Project Alpha. Project Alpha remains authoritative for invoice creation, payment, receipts, contracts, and financial email. Operations must not create, refresh, revoke, or rewrite a PA public link while reading this summary.

## Authorization and transport

- The client route is project-scoped and only accepts the Operations project ID from the URL. It resolves a fresh account/project grant, checks the existing `can_view_billing` capability, then reads that project's explicit `project_alpha_source_id` and canonical Project Alpha public ID. It never maps by name, email, or caller-supplied PA ID.
- The Client Worker calls a private Operations service binding. PA bearer keys and Cloudflare Access service credentials remain in Operations; they never reach the browser.
- Configure a separate `financialApiKey` in the selected entry of the encrypted `PROJECT_ALPHA_API_V2_CONNECTIONS` envelope. It must be bound to the same PA API-v2 application and have only the capability-discovery and `financial.portal_summary.read` scopes required by the endpoint. The financial consumer deliberately does not fall back to the general Directory/Project sync key.
- Enable `PROJECT_ALPHA_FINANCIAL_SUMMARY_ENABLED` in Operations and `CLIENT_PORTAL_PA_FINANCIAL_SUMMARY_ENABLED` in Client only after both service binding and PA scope are tested. Both are default-off. The Client route additionally requires `can_view_billing` for the currently authorized project.
- `PROJECT_ALPHA_FINANCIAL_SUMMARY_PUBLIC_ORIGINS` is a strict comma-separated HTTPS origin allowlist for PA's already-issued links. The API origin is always included. Staging must list only staging link origins; do not include production origins in staging configuration.
- The Client Worker removes PA source/application/history identifiers and internal PA project IDs before returning the projection. It returns no-store page totals, bounded invoice fields, cursor, and eligible existing signed public links only.

## Staging acceptance

1. Deploy the PA financial-summary implementation to PA staging and enable its default-off flag there only. Confirm capability discovery advertises the exact read-only endpoint and dedicated scope.
2. Create a separate staging API key with only capability discovery and `financial.portal_summary.read`; bind it to the same PA staging API-v2 application used by the source. Do not broaden key #5, which remains the project-binding recovery key.
3. Add that key only as `financialApiKey` to the matching Ops staging source entry. Confirm Ops staging service binding and the exact staging public-link origin allowlist.
4. Create or select a synthetic staging Project with an explicit PA binding and an authorized synthetic client workspace with billing visibility. Do not use an unverified real client grant.
5. Verify no access without billing permission; no access across project/workspace; unmapped Project fails closed; PA disabled, unauthorized, stale identity, malformed response, wrong-origin link, timeout, and oversized response return safe errors; valid summary displays in the client's project and opens only PA's existing staging invoice/payment links.
6. Confirm the PA request is GET-only and no public-link, invoice, payment, membership, or entitlement rows change. Confirm no duplicate email or receipt is sent by Operations.
7. Leave both feature flags off until this acceptance passes. Production PA remains at its existing state until the user's separate production-update checkpoint.

## Current limitation

The initial Client route is for the existing account-backed project grants and requires `can_view_billing`. Native workspace-v2 currently advertises billing as unavailable, so those workspaces will fail closed; do not infer billing permission from directory or project visibility. A separate native billing-authority contract and UI/dashboard aggregation are still required before claiming complete portal financial visibility.
