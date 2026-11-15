# Closed replacement iOS staging configuration

These dedicated Wrangler files replace the retired pilot configuration. They are
source candidates, not deployment or activation receipts. Root owns actual
configuration, source registration, credentials, import and release.

## Verified resources

Read-only Cloudflare API checks on November 15, 2026, at 20:27–20:30 UTC verified
the account and actual resource ownership, rather than inferring it from names.

| Resource | Verified value |
| --- | --- |
| Account | Staging, `df3f376bae6ee621f50cf972ebcc9484` |
| Edge Worker | `ledge-top-ios-edge-staging` |
| Reader Worker | `ledge-top-ios-read-staging` |
| `OPS_DB` | `ledge-top-ops-staging`, `a58ea102-f04d-417a-bfd1-b0654cfeb503` |
| `DELIVERY_DB` | `ledge-top-portal-staging`, `15d02028-8c52-40b2-9979-d67abf7d5bbf` |
| Workers subdomain | `ledge-top-staging` |
| Proposed pilot origin | `https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev` |
| Ordinary Ops origin | `https://ledge-top-ops-staging.ledge-top-staging.workers.dev` |
| Access issuer | `https://ledge-top-staging.cloudflareaccess.com` |
| Pilot Access app | `3ebfae1c-321b-46c6-ba56-6be95f95c50f` |
| Ordinary Ops Access app | `37c5049c-a787-49cf-ac43-ba4d340bee70` |

The pilot audience is
`17f32ab9f964a3e4c64864e06d3d0e1b128604192b9a7e457db1f8f88b8f5707`;
the distinct ordinary Ops audience is
`ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84`.
Both Access destinations match their corresponding origins. Both dedicated
Workers had workers.dev and previews disabled and no custom domains. Resource
metadata does not prove policy admission, OAuth registration, deployed code,
source eligibility or actual reads. Reverify current ownership, bindings and
routes before writes; these observations are not a deployment lock.

Compatibility date `2026-07-22` and `nodejs_compat` match the existing Workers.
This change does not combine a compatibility-date upgrade with replacement setup.

## Closed composition

Both configs keep workers.dev and previews false, `routes: []`, `keep_vars: false`,
and `IOS_MANAGED_PILOT_ENABLED`, `IOS_PILOT_BUSINESS_ENABLED` and
`IOS_OAUTH_PROBE_ENABLED` false. Public origin/audience values do not populate
empty source-reviewed allowlists or native pins, enable a URL/probe/read, or add
a web-session fallback.

The reader selects the separately reviewed `ios-pilot-private-entrypoint.ts`.
Only `IosPilotReadService` and `IosPilotBusinessReadService` are named exports;
the default HTTP handler always returns 404. Do not substitute the broader
`staging-ios-pilot-entrypoint.ts`, which reexports the ordinary staging HTTP
router and unrelated entrypoints. Existing Ops/staging-native-authority modules
remain unchanged.

The edge uses `ios-pilot-edge-bridge.ts` and binds only:

| Binding | Worker | Named entrypoint |
| --- | --- | --- |
| `IOS_PILOT_READ` | `ledge-top-ios-read-staging` | `IosPilotReadService` |
| `IOS_PILOT_BUSINESS_READ` | `ledge-top-ios-read-staging` | `IosPilotBusinessReadService` |

The edge has no D1 or credential binding. The reader binds only the two verified
D1s. Migration directories are `migrations` for Ops and `../client/migrations`
for Delivery, so the wrong chain is not selected by a default. No migration is
applied here; Root must separately verify both installed schemas.

## Owner-provisioned inputs and order

Credentials and source identities are deliberately absent. Required externally
managed reader input names are:

- `PROJECT_ALPHA_CONNECTOR_SOURCES`: the reviewed manifest, retaining
  `PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED=true`.
- `PROJECT_ALPHA_API_V2_CONNECTIONS`: the server-only deployment secret with the
  actual API-v2 identity tuple and Directory-only key. Keep this separate from
  the legacy snapshot identity and credential.

Do not use invented identities, placeholder keys, fabricated observations or a
borrowed machine MCP identity. The private mobile facade does not need snapshot,
quote/write credentials or the ordinary `OPERATIONS_SESSION_SECRET`; do not copy
those into it or the edge. The separate Ops import/admin route retains its own
existing authentication and secrets outside these dedicated configs.

`keep_vars: false` preserves the configured closed switches. Omitted plain-text
dashboard variables may be removed on deployment. Root must inventory and verify
separately provisioned inputs afterward; do not switch to true to retain
unreviewed dashboard state. No secret value belongs in config, logs, command
arguments, Git or the native client.

The future owner-reviewed order is:

1. Verify current resources, immutable code, schema, manifests and custody.
   Qualify the private wrapper's exact exports and unchanged RPC guards.
2. Deploy the reader closed, then verify named exports, both D1 bindings,
   default HTTP denial and separately provisioned inputs. This does not authorize
   exposing the worker or activating a source.
3. Deploy the edge closed after the reader is ready. Verify both named service
   bindings and that no public, custom or preview route was enabled.
4. Use supported existing operators for actual legacy projection, current API-v2
   Directory inventory and Client Hub index reconciliation. Preserve
   `project-alpha:primary` and normal visibility/identity/ACL rules. Do not
   fabricate mappings, observations, ready roots or human principals.
5. Independently verify a nonempty permitted root through the composed private
   path. Review current human admission, signed identity, separate audiences,
   Access request context and OAuth registration. Review exact edge, RPC and
   native pins and all runtime gates together before any activation.
6. Verify actual session/list/detail/pagination, denial, expiry/revocation and
   app/device restart behavior on the approved native build. Synthetic probes,
   fixtures and empty pages do not replace acceptance.

Public OAuth metadata/pin proposals are references. No OAuth client secret,
policy grant, event verifier, source registration or deployment attestation is
supplied here. Root must review actual inputs where required; no guard is relaxed.

## Asset retention and release boundary

These configs have no asset namespace and must not replace ordinary Ops or Client
configuration. If integration also releases either frontend, preserve actual
bytes at every asset path served during the previous 48 hours in its active
namespace, including carry-forward releases. Record the real cutover and earliest
permitted pruning time. A rollback version or route alone does not prove old URLs
work; no automatic pruning is set up.

This candidate changes no provider resource, secret, database row, Access policy,
production route or native pin. Main changes require a PR; Actions remain
main-only. Local validation is not deployment approval.
