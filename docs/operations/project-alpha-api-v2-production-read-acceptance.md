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

The reviewed production native-authority packet was provisioned on September
21, 2026 after the canonical `0124` chain, private backup, exact owner binding,
existing permission overrides, empty native state and zero pending actor work
were rechecked. Sanitized readback proves admission/profile version `1`,
Directory and Project grant generation/version `1`, the immutable Directory
history row, approval and receipt. This satisfies the Operations authority
prerequisite only. It does not make this read-acceptance route a write route,
consume a Project-adoption review item, enable either PA connection or retire a
legacy connection.

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

## Production evidence

On September 21, 2026, the bounded route completed once for LTDS primary and
once for LTT secondary. Both capability probes returned `verified` with exact
identity and contract matches. Directory inventory returned `47` LTDS records
and `7` LTT records, with no additional page; both Project inventories returned
an observed empty application-scoped set. The safe audit rows are retained in
Operations D1. The empty Project inventories are an adoption boundary, not
proof that PA has no historical Projects: existing Projects are not silently
bound to the new application and require deliberate review/adoption. The
acceptance made no PA mutation and does not authorize legacy retirement.

## September 22 private adoption checkpoint

The read acceptance above remains historical read-only evidence. Subsequent
Operations commits `3cfbf2b`, `11a467d`, `5a909fe`, `8218ea2`, `4f33361`, and
`41b0f2f` implement private foundations for reviewed adoption without changing
that production result. Directory existing-record binding now has a strict PA
transport, immutable review/reservation/acquisition chain, inactive canonical
mapping materialization, and an activation consumer that requires the exact
authenticated reviewer, fresh PA profile and binding-status observations, and
current native authority. Project adoption now has private reservation and bind
planning consumers and can compose an explicitly activated acquired Directory
mapping in those later workflows.

All of those consumers remain unmounted and default-off. There is no new
authenticated browser or administrator route, no production D1 migration or
write, no PA flag or managed-mode change, and no public-link, Delivery, portal,
or legacy-mapping change. PA managed mode remains off, legacy integrations
remain active, and portal migration/cutover has not started.

Focused verification is bounded to local code. `3cfbf2b` passed `3` files / `36`
tests (`15` adoption D1, `19` Project command, `2` migration-chain); `11a467d`
passed `3` / `16`; `5a909fe` passed `3` / `28`; `8218ea2` passed the adoption
D1 suite `24/24`; and `41b0f2f` passed it `26/26`. Current independent Project
verification passes `3` files / `47` tests. For `4f33361`, current activation
verification passes `18/18` and coordinator plus Directory-read verification
passes `27/27`; an independent combined checkpoint before the final
standalone-client assertion passed `4` files / `52` tests. None of these focused
runs is a production write or cutover proof.

The remaining boundary is explicit. A Project review-evidence producer and
authenticated routes for the private consumers are still absent. Migration
`0122` canonical Project guards still consult only legacy
`project_alpha_directory_mappings`; recognizing acquired active mappings there
requires a separately reviewed forward migration with explicit owner
authorization. Until those gaps, production reconciliation, and a separately
authorized rollout are complete, the new adoption state must not replace the
legacy path or be described as portal migration progress.
