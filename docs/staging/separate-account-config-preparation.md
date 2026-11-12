# Separate-account Cloudflare staging config preparation

Status: **source preparation only; deployment is blocked**.

The three `wrangler.staging-account.jsonc` files target the separate Staging
account `df3f376bae6ee621f50cf972ebcc9484`. Merger confirmed the Worker names,
Ops/Client/Sync Access applications, Access issuer, Ops/Portal D1 IDs,
Delivery/Incoming R2 bucket names, four queues and seven Workflows on
2026-11-12. The D1 databases were empty at allocation time. Queue readback had
no producers or consumers; the Workflows had zero instances and no schedules.
The Access applications have deny-all policies and Workers.dev remains
disabled. This source preparation does not enable access or migrate D1 data.

The confirmed Access issuer is `https://ledge-top-staging.cloudflareaccess.com`.
The allocated closed-bootstrap applications are:

| Worker | Application ID | Access host | Audience |
| --- | --- | --- | --- |
| `ledge-top-ops-staging` | `37c5049c-a787-49cf-ac43-ba4d340bee70` | `ledge-top-ops-staging.ledge-top-staging.workers.dev` | `ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84` |
| `ledge-top-clients-staging` | `bba2498b-7576-4c4d-84e3-23a62d701778` | `ledge-top-clients-staging.ledge-top-staging.workers.dev` | `dd6be2a400a90ba47a09a692f491738f7fbad090a0240f5a8a0c175db9b36d44` |
| `ledge-top-ops-sync-staging` | `dde6d648-f427-43a3-9fbb-18944555e506` | `ledge-top-ops-sync-staging.ledge-top-staging.workers.dev` | `61e0ecc56176cab2eaa1c007ca262e10dbd91df1cee36abf87d8a3928a720485` |

The Client Worker is `ledge-top-clients-staging`; its D1 retains the distinct
name `ledge-top-portal-staging` and the allocated Portal D1 ID. Do not create a
second Worker to match the database name.

Owner-provided sanitized local receipts:

- `C:\Projects\Ledge Top Operations\_artifacts\cloudflare-staging-target-allocations-20261112.json`
- `C:\Projects\Ledge Top Operations\_artifacts\staging-access-allocations-20261112.json`
- `C:\Projects\Ledge Top Operations\_artifacts\staging-queues-created-20261112.json`
- `C:\Projects\Ledge Top Operations\_artifacts\staging-workflow-allocations-20261112.json`
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
consumers. Every source `_ENABLED` / `_READY` flag is set to `false`. All three
configs use the confirmed Access issuer, audience and expected host for their
closed applications. Sync's Access group ID/name and application key remain
explicit `REQUIRES_ALLOCATION` placeholders.

The staging service binding graph carries the currently observed Ops/Portal
contracts, including the live Ops bindings missing from checked-in production
Wrangler source (`CLIENT_AUTHORITY_WORKSPACE_BINDING`,
`CLIENT_PORTAL_ACCESS_AUTHORITY`, `CLIENT_PORTAL_AUTHORITY_V2`, `OPS_INVENTORY_CATALOG_PROMOTION`,
`OPS_INVENTORY_CATALOG_STAGING`, and
`VERIFIED_RECIPIENT_DELIVERY_AUTHORITY`). It also carries the Client recipient
and onboarding bridge bindings observed in the live staging Worker. The names
for proposed Portal, Sync and UI-assets target Workers are source-contract
identities. The Workers currently exist in closed-bootstrap state, but Merger
must reconcile their actual bindings and routes with source before deployment
or exposure. `OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES` is retained because it is a
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

Merger also allocated seven target Workflows: `ledge-top-r2-crud-staging`,
`ledge-top-incoming-upload-lifecycle-staging`,
`ledge-top-incoming-rclone-promotion-staging`,
`ledge-top-dropbox-import-staging`, `ledge-top-ops-catalog-promotion-staging`,
`ledge-top-bulk-download-staging` and `ledge-top-cloud-transfer-staging`.
These are not declared in the new configs yet. Their zero-instance readback
does not prove old Workflow history or queued work has been reconciled. Keep
schedules, consumers, feature gates and invocation paths closed until the
migration owner reviews the old/new identity mapping and non-replay behavior.

## Deployment holds

The guard currently blocks deployment readiness because these requirements are
not complete:

- Merger's full Worker, binding and route readback against the three actual
  closed-bootstrap Workers.
- Keep the deny-all Access applications closed until separate authorized
  acceptance. Sync's service-only ingress policy, access group ID/name and
  application key remain unresolved.
- Incoming and public-delivery host allocation and exposure review.
- Reconcile legacy queue backlog/event ownership before enabling any target
  consumer; new Queues currently have no consumers at provider readback.
- Reconcile legacy Workflow histories and accepted/queued work before wiring or
  invoking the seven allocated zero-instance Workflows.
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

The guard exits `2` while the current-main principal-inquiry source export is
missing. After that source mismatch is reconciled, it remains nonzero while
manual migration prerequisites are open. No provider action is part of these
checks.
