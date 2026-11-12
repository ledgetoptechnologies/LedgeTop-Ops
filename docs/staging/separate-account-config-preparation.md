# Separate-account Cloudflare staging config preparation

Status: **source preparation only; deployment is blocked**.

The three `wrangler.staging-account.jsonc` files target the separate Staging
account `df3f376bae6ee621f50cf972ebcc9484`. The target Ops and Portal D1 IDs,
Delivery/Incoming R2 bucket names, four queue names, and Ops Access
application/audience/Workers.dev host were confirmed by read-only account-scoped
Cloudflare API reads on 2026-11-12. The D1 databases were empty at allocation
time. This does not mean these app configs have been deployed or that D1
schemas/data have been migrated. Queue readback showed no producers or
consumers.

The confirmed Ops Access application is `37c5049c-a787-49cf-ac43-ba4d340bee70`
for `ledge-top-ops-staging.ledge-top-staging.workers.dev`, with audience
`ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84`.

Owner-provided sanitized local receipts:

- `C:\Projects\Ledge Top Operations\_artifacts\cloudflare-staging-target-allocations-20261112.json`
- `C:\Projects\Ledge Top Operations\_artifacts\staging-queues-created-20261112.json`
- `C:\Projects\Ledge Top Operations\_artifacts\cloudflare-staging-dependencies-20261112.json`

These receipts are outside Git and are not included in this source change. The
guard checks the checked-in configuration against the confirmed allocation
constants; it does not query Cloudflare or prove the receipts are still current.
Merger must reconcile fresh readbacks before any deploy decision.

## Configs and guard

- `apps/operations/wrangler.staging-account.jsonc`
- `apps/client/wrangler.staging-account.jsonc`
- `apps/ops-sync/wrangler.staging-account.jsonc`
- `scripts/staging-account-wrangler-configs.mjs` renders those configs from the
  current production source configs and the confirmed target allocations.
- `scripts/staging-account-deployment-guard.mjs` verifies account/resource
  identity, closed routes, closed feature gates, and required cross-Worker RPC
  bindings. It prints the unresolved migration blockers and exits nonzero. It
  makes no network or provider calls and never deploys.

Production Wrangler configs remain the production configs. The new staging
configs have no routes, `workers_dev` and previews disabled, no cron triggers,
and no Workflow, mail, Stream, rate-limit, Durable Object or container bindings.
Ops has one producer binding to the allocated thumbnail queue; it has no
consumers. Every source `_ENABLED` / `_READY` flag is set to `false`. The Ops
Access audience is the newly confirmed separate-account audience; the Portal
and Sync Access issuer/audience/group/host values remain explicit
`REQUIRES_ALLOCATION` placeholders.

The staging service binding graph carries the currently observed Ops/Portal
contracts, including the live Ops bindings missing from checked-in production
Wrangler source (`CLIENT_AUTHORITY_WORKSPACE_BINDING`,
`CLIENT_PORTAL_ACCESS_AUTHORITY`, `CLIENT_PORTAL_AUTHORITY_V2`, `OPS_INVENTORY_CATALOG_PROMOTION`,
`OPS_INVENTORY_CATALOG_STAGING`, and
`VERIFIED_RECIPIENT_DELIVERY_AUTHORITY`). It also carries the Client recipient
and onboarding bridge bindings observed in the live staging Worker. The names
for proposed Portal, Sync and UI-assets target Workers are source-contract
identities; Merger must verify the actual Staging Worker bindings before
deployment. `OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES` is retained because it is a
live binding, but `OperationsNativePrincipalInquiryIngress` is not exported by
the current `origin/main` Operations entrypoint. The guard reports this source
error; do not deploy until the source export is restored or Merger resolves the
live binding against the selected source commit.

The target Queues are `ledge-top-file-events-staging`
(`135555ab78f74417917b9af9c0c708f9`), its `-dlq`
(`265c2e906a0c4baaaa5c04c922edc439`), `ledge-top-thumbnail-staging`
(`0925633716464172bb0026f1a30e5cff`), and its `-dlq`
(`4e62d82515b14b3ca63a4951c15d53f7`). The Ops config declares only the
thumbnail producer. Reconcile source queue backlog and event ownership before
enabling any target consumer.

## Deployment holds

The guard currently blocks deployment readiness because these requirements are
not complete:

- Merger's exact Worker, binding and route readback for the three proposed
  Workers.
- Current Staging Access team issuer/domain; Portal Access application,
  audience, host and policy; Sync Access application, audience, service-only
  ingress policy and group.
- Incoming and public-delivery host allocation and exposure review.
- Reconcile legacy queue backlog/event ownership before enabling any target
  consumer; the new Queues currently have no producers or consumers at provider
  readback. No target Workflows are allocated; reconcile old execution
  histories before creating replacements.
- Target thumbnail Durable Object/container namespace and entitlement review.
- Client rate-limit namespace allocation and other account-scoped limiter
  checks.
- Staging UI-assets Worker, catalog, and routing readback; byte-level proof that
  every browser asset served within the last 48 hours remains available.
- Independent staging secrets and provider credentials, Project Alpha staging
  origin/source/scope reconciliation, D1 schema and ledger parity, approved
  staging data-transfer evidence, and R2 object/metadata parity.
- Logs domain/service acceptance and the account-local Ops `FLIGHT_LOGS`
  binding.
- Replacement acceptance and Merger approval before retiring any exact legacy
  staging resource in the Ledge Top production account.

The guard is a readiness gate for coordinated work; Merger owns all Cloudflare
resource writes, deployment, cutover and deletion. Do not deploy these configs
directly with Wrangler while the guard reports blockers.

## Local checks

```powershell
node scripts/staging-account-wrangler-configs.mjs --check
node --test scripts/staging-account-deployment-guard.test.mjs
node scripts/staging-account-deployment-guard.mjs
```

The last command is expected to exit `1` while the listed prerequisites remain
open. No provider action is part of these checks.
