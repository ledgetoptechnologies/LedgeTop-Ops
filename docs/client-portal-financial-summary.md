# Client portal financial summary

The authenticated Client Worker exposes a read-only Project financial summary at
`GET /api/client/projects/:localProjectId/financial-summary`. The caller must
select an existing portal-v2 workspace in the usual `X-Client-Workspace` header.
The route independently rechecks the signed-in identity, live workspace,
per-person `can_view_billing`, portal-v2 Project entitlement, active account
Project grant, active member Project ACL, source mapping, and canonical PA
Project public ID before and after the PA request.

The integration is off unless `CLIENT_PORTAL_FINANCIAL_SUMMARY_ENABLED=true`.
`CLIENT_PORTAL_FINANCIAL_API_V2_CONNECTIONS` is a server-only JSON secret:

```json
{
  "version": 1,
  "instances": {
    "project-alpha:primary": {
      "sourceId": "project-alpha:primary",
      "enabled": false,
      "baseUrl": "https://project-alpha.example/",
      "apiKey": "dedicated-key-with-api.capabilities.read-and-financial.portal_summary.read",
      "sourceInstanceId": "00000000-0000-4000-8000-000000000000",
      "applicationId": "00000000-0000-4000-8000-000000000000",
      "historyEpoch": "00000000-0000-4000-8000-000000000000"
    }
  }
}
```

Each source has a distinct origin, application-bound bearer, source instance,
application ID, and history epoch. Optional `accessClientId` and
`accessClientSecret` fields may be supplied as a pair for Cloudflare Access.
The bearer must be dedicated to the two named scopes; legacy `full`, pricing,
webhook, and HMAC credentials are not used.

The Worker calls only
`GET /api/v2/financial/summary?projectPublicId=<trusted-canonical-mapping>&limit=50`
(plus a validated cursor). PA must resolve that public ID through the calling
application's active Project-v2 binding; a public ID is never treated as the
binding's distinct external ID. The Worker never accepts client/organization selectors,
never exposes connector credentials, never globally caches a response, and
never sends financial email. PA failures, timeouts, redirects, identity/source
mismatches, stale or revoked mappings, oversized bodies, authenticated staff
action URLs, and malformed/unknown response fields fail closed. Invoice and
payment links are returned only through the nullable PA `invoicePublicUrl` and
`paymentPublicUrl` fields; totals are the explicitly page-bounded
`returnedPageTotals` values.
