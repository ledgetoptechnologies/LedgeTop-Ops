# Project Alpha API-v2 production read acceptance

This Operations route is a bounded production-readiness check for a previously
configured Project Alpha API-v2 connection. It is not a synchronizer, source
registration mechanism, migration, or write path.

## Review-ledger boundary

Operations migration `0123` first makes native Directory grant generations and
their immutable history durable, while preventing in-place replacement of a
staff admission's bound Access subject or admitting principal. Migration
`0124` then adds server-owned, short-lived Project-adoption review evidence and
one-time reservations. Neither migration mounts a route, enables a flag,
creates an admission or grant, binds a Project, or changes Delivery/public-link
state. A future browser action may reference only a review-item ID and an
idempotency key; it must recheck current unexpired authority and exact current
Directory mappings before consuming its immutable evidence. Review evidence is
valid for at most four hours, pins the reviewer's exact bound Access subject and
an existing global `role-owner` assignment, and carries a distinct evidence
digest. It does not impose a permanent single-owner invariant.

## Activation and authority

- `PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED` is `false` by default.
- An Operations administrator must hold a current global, non-denied
  `integrations.manage` grant.
- It is a `POST` route behind the normal authenticated `/api` mutation
  middleware, so same-origin and CSRF validation are required.
- The request accepts exactly one canonical `sourceId`. It cannot supply a
  base URL, bearer/API key, Access credential, identity pin, or scope.
- Operations reads that source only from deployment-owned
  `PROJECT_ALPHA_API_V2_CONNECTIONS`, and only if the selected entry is
  explicitly enabled.

## What it verifies

`POST /api/admin/integrations/project-alpha/api-v2/read-acceptance` with
`{"sourceId":"project-alpha:..."}` performs only these upstream GETs:

1. `/api/v2/capabilities`, requiring the exact Directory and Project inventory
   endpoint contracts and configured source/application/history identity pins.
2. `/api/v2/directory/inventory?type=all&limit=200`.
3. `/api/v2/projects/inventory?limit=200`.

The response has no client, organization, project, public-ID, external-ID,
URL, bearer, or Access credential data. It contains only safe statuses,
correlated request IDs, configured identity-match/contract-match results,
authorization generations, page counts, and aggregate SHA-256 metadata.
The local audit event stores the same safe summary.

## Operation and rollback

Enable the route and only the selected connection entry for a bounded window.
Run one source at a time, record the safe result, then set the route gate and
connection entry back to `false`. A successful result does not enable
synchronization, grant any PA write capability, alter client records, or make
legacy connections safe to retire. Preserve public links and complete the
separate legacy entitlement/outbox audit before retirement.
