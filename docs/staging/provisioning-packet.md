# Ledge Top Ops staging provisioning packet

Status: the standalone storage resources, file-event queue/DLQ, thumbnail
queue/DLQ, and staging Access applications were provisioned. A live Cloudflare
inventory on 2026-09-16 verified Workers Containers entitlement and a ready
production thumbnail renderer as account-level entitlement evidence only. No
staging Worker, Workflow, or private staging `THUMBNAIL_RENDERER` binding has
been created or read back. Delivery and Operations have one narrow human test
policy each; Ops Sync remains service-auth only. Worker deployment, Workflow
creation, migrations, routes, event subscriptions, secrets, and feature
activation remain deferred.

## Deliberate same-account exception

The initial staging environment uses Cloudflare account
`846c924bf17bf4f3dd15c97a4c5d1d51`. This is a deliberate, temporary exception
to the preferred separate-account boundary. The account ID and Access team
domain are the only production values staging may share. Every Worker name,
hostname, Access application and audience, D1 database ID, R2 bucket name,
queue, Workflow name, rate-limit namespace, secret, route, and provider
application must remain distinct.

This packet is not authorization to deploy Workers, apply migrations, attach
routes or queue consumers, create additional Access policies, or enable a
feature.

## Approved defaults

| Concern | Staging value |
| --- | --- |
| Delivery Worker | `ledgetop-clients-staging` |
| Operations Worker | `ledgetop-ops-staging` |
| Ops Sync Worker | `ledgetop-ops-sync-staging` |
| Delivery rollback/admin host | `delivery-staging.ledgetopdroneservices.com` |
| Client portal/public-share host | `client-staging.ledgetopdroneservices.com` |
| Secondary client portal host | `portal-staging.ledgetoptechnologies.com` |
| Operations host | `ops-staging.ledgetopdroneservices.com` |
| Incoming host | `incoming-staging.ledgetopdroneservices.com` |
| Ops Sync host | `ops-sync-staging.ledgetopdroneservices.com` |
| Delivery D1 | `client-data-staging`, ENAM |
| Operations D1 | `ltds-ops-staging`, ENAM |
| Delivery R2 | `client-data-staging`, WNAM, Standard |
| Incoming R2 | `ltds-incoming-staging`, ENAM, Standard |
| File-events queue | `ltds-file-events-staging` |
| Dead-letter queue | `ltds-file-events-staging-dlq` |
| Thumbnail queue | `ltds-thumbnail-jobs-staging` / `f85e103c23684deeb0bc07c1734191be` |
| Thumbnail DLQ | `ltds-thumbnail-jobs-staging-dlq` / `e4d88e9c1b4948b591356307d2d53f15` |
| Thumbnail renderer | Workers Containers entitlement verified; staging private `ThumbnailRendererContainer` binding pending, with one maximum `standard-1` instance intended |
| R2 retention | Disposable test data; no bucket lock or automatic expiry |
| Provider flags | Dropbox, Google, and Google Picker `false` |
| Direct R2 upload | `false` |
| Incoming rclone promotion | `false`; the Workflow binding remains inert until a separately approved staging acceptance packet |
| Permanent purge | `false` |

Regions mirror the corresponding production resources. The unlocked staging
buckets must contain test-only data. Application soft-delete and restore remain
required. Do not infer a recovery time from an untested source-sync schedule.

## Created standalone resources

| Resource | Identity | Purpose |
| --- | --- | --- |
| D1 | `client-data-staging` / `b6f653ab-9acd-4421-9ad0-207754b59aeb` | Delivery schema and state |
| D1 | `ltds-ops-staging` / `78b34173-b168-4e3d-9832-bb9d245cc6b8` | Operations and Ops Sync state |
| R2 | `client-data-staging` | Delivery test objects |
| R2 | `ltds-incoming-staging` | Incoming test quarantine |
| Queue | `ltds-file-events-staging` / `6ce589b7865e4ed8a2b01a515a247416` | Future staging file events |
| DLQ | `ltds-file-events-staging-dlq` / `b6f9faccbab64c8db7bfd29c483b3708` | Failed staging file events |
| Queue | `ltds-thumbnail-jobs-staging` / `f85e103c23684deeb0bc07c1734191be` | Future staging thumbnail jobs |
| DLQ | `ltds-thumbnail-jobs-staging-dlq` / `e4d88e9c1b4948b591356307d2d53f15` | Failed staging thumbnail jobs |

Both D1 databases are empty. Both R2 buckets are Standard, empty, private, and
unlocked. All four staging queues had zero producers and zero consumers in the
2026-09-16 inventory. No migration, event subscription, route, Workflow,
staging Worker version, or staging Container binding was created by this
provisioning step.

The historical Access inventory in `docs/staging/access-created-inventory.md`
is not current deployment evidence. Recreate and record current staging-only
Access applications before rendering config: distinct Delivery and Operations
human audiences, one shared Ops Sync audience for both the Client catalog call
and Ops Sync service authentication, and a distinct client-portal audience.
Never reuse a production audience, and do not infer an audience ID from the
historical document.

The two client portal hosts, shared dedicated client portal Access
app/audience/group, and public
Bypass app/policy are not provisioned. Their exact fail-closed contract and
ordered plan are in `docs/staging/client-portal-rollout.md`; none may reuse the
existing Delivery Access audience or tester policy.

## Reproducible commands

Do not re-run a create command when its named resource already exists.

```powershell
npx.cmd wrangler whoami
npx.cmd wrangler d1 list --json
npx.cmd wrangler r2 bucket list
npx.cmd wrangler queues list
npx.cmd wrangler workflows list

npx.cmd wrangler d1 create client-data-staging --location enam
npx.cmd wrangler d1 create ltds-ops-staging --location enam
npx.cmd wrangler r2 bucket create client-data-staging --location wnam
npx.cmd wrangler r2 bucket create ltds-incoming-staging --location enam
npx.cmd wrangler queues create ltds-file-events-staging
npx.cmd wrangler queues create ltds-file-events-staging-dlq
```

The thumbnail queue and DLQ are recorded above. Re-list queues before release
and fail closed if an expected identity is missing or has an unexpected
producer or consumer. Do not re-run a create command for an existing name:

```powershell
npx.cmd wrangler queues list
```

## Minimal unresolved configuration

Before ignored `apps/*/wrangler.staging.json` files can pass preflight:

- create and record current staging-only Delivery, Operations, Ops Sync, and
  client portal audiences; use the one Ops Sync audience in both
  `PROJECT_ALPHA_CATALOG_ACCESS_AUD` and `CF_ACCESS_AUD`;
- create and record the distinct client portal audience and group, assign both
  approved portal hosts to that single application, set `CLIENT_ACCESS_AUD`,
  `CLIENT_ACCESS_TEAM_DOMAIN`, `CLIENT_PORTAL_ORIGIN`, and the exact two-entry
  `CLIENT_PORTAL_ORIGINS`, and keep `CLIENT_PORTAL_ENABLED=false`;
- record the anonymous delivery origin as `PUBLIC_SHARE_ORIGIN` on both
  Workers and Client `PUBLIC_BASE_URL`; keep Operations `DELIVERY_BASE_URL`
  pointed at the authenticated client portal origin;
- the staging Access group ID/name and approved test identities;
- a staging-only Project Alpha origin and service-token policy;
- interactive staging secrets, never committed or placed in shell commands;
- the verified Workers Containers entitlement plus a separately created and
  read-back private staging renderer binding, the recorded thumbnail queue/DLQ
  identities, and one-instance resource cap;
- eight unused positive-integer rate-limit namespace values;
- the reviewed commit and build artifact checksum.

Record those nine non-secret operator choices in an ignored copy of
`docs/staging/staging-config-values.json.example`, then use
`npm run staging:config:check -- --values <ignored-json> --write`. The command
validates all three rendered configs together, refuses placeholders or an
existing target, and performs no remote action. Secrets remain governed by
`staging-secret-manifest.json` and must never be added to the values file.

Incoming remains outside Access and must not be published until its anti-abuse
controls and the direct-upload capability gate are separately approved.

## Deferred actions

Do not create the three Workers or six Workflows merely to reserve their names.
Deployment would create or update Workflows and activate the five reviewed
Operations schedules: consolidated 15-minute work, five-minute request work,
offset five-minute Client Hub indexing, hourly source recovery, and offset
15-minute native-delivery notifications, plus the Operations queue consumers
and thumbnail producer binding. Queue resources themselves must already exist.

Also defer the `client-staging` custom-domain route and DNS, additional Access applications or
policies, D1 migrations, R2 event notifications, Queue/DLQ consumer
attachment, secrets, provider applications, and all feature activation.

## Rollback boundary

A Worker version rollback changes only the Worker code version receiving
traffic. It does not reverse or restore:

- D1 migrations, schema changes, or data;
- R2 objects, metadata, lifecycle configuration, or deletions;
- queued messages, consumers, DLQs, or R2 event subscriptions;
- Workflow definitions, instances, or persisted state;
- secrets, variables, bindings, cron triggers, routes, custom domains, DNS, or
  Access applications and policies.

Each control-plane or data-plane change needs its own recorded restore or
forward-fix procedure. Preserve D1 exports before migrations and prior Worker
version IDs. Deleting unlocked R2 data is irreversible; source synchronization
is not a substitute for a tested restore drill.

## Cost notes

Empty D1 databases scale to zero. Empty R2 buckets incur charges only when
objects or operations are added. Queues are billed by message operations, so
unattached empty queues have no message operations. Worker and Workflow usage
does not begin until deployment and invocation. Once enabled, thumbnails add
Container compute, Queue retries, D1 reads/writes, R2 source reads, derivative
writes/serves, and up to 128 KiB of R2 storage per current ready derivative;
retained obsolete ETag derivatives add storage until reviewed cleanup. Current
pricing and account entitlement must be checked in Cloudflare during rollout.
