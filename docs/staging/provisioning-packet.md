# LTDS staging provisioning packet

Status: standalone storage and queue resources plus three staging Access
applications are provisioned. Delivery and Operations have one narrow human
test policy each; Ops Sync remains default-deny. Worker deployment, Workflow
creation, migrations, routes, additional Access changes, event subscriptions,
secrets, and feature activation remain deferred.

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
| Delivery Worker | `ltds-delivery-staging` |
| Operations Worker | `ltds-ops-staging` |
| Ops Sync Worker | `ltds-ops-sync-staging` |
| Delivery host | `delivery-staging.ledgetopdroneservices.com` |
| Operations host | `ops-staging.ledgetopdroneservices.com` |
| Incoming host | `incoming-staging.ledgetopdroneservices.com` |
| Ops Sync host | `ops-sync-staging.ledgetopdroneservices.com` |
| Delivery D1 | `client-data-staging`, ENAM |
| Operations D1 | `ltds-ops-staging`, ENAM |
| Delivery R2 | `client-data-staging`, WNAM, Standard |
| Incoming R2 | `ltds-incoming-staging`, ENAM, Standard |
| File-events queue | `ltds-file-events-staging` |
| Dead-letter queue | `ltds-file-events-staging-dlq` |
| R2 retention | Disposable test data; no bucket lock or automatic expiry |
| Provider flags | Dropbox, Google, and Google Picker `false` |
| Direct R2 upload | `false` |
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

Both D1 databases are empty. Both R2 buckets are Standard, empty, private, and
unlocked. Both queues have zero producers and zero consumers. No migration,
event subscription, route, Access policy, Workflow, or Worker version was
created by this provisioning step.

The three staging Access applications and their policy state are recorded in
`docs/staging/access-created-inventory.md`. Their audiences are distinct from
production; Access creation did not create DNS records or Worker routes.

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

## Minimal unresolved configuration

Before ignored `apps/*/wrangler.staging.json` files can pass preflight:

- copy the recorded staging Access audiences into `POLICY_AUD`,
  `OPERATIONS_AUD`, and `CF_ACCESS_AUD`;
- the staging Access group ID/name and approved test identities;
- a staging-only Project Alpha origin and service-token policy;
- interactive staging secrets, never committed or placed in shell commands;
- eight unused positive-integer rate-limit namespace values;
- the reviewed commit and build artifact checksum.

Incoming remains outside Access and must not be published until its anti-abuse
controls and the direct-upload capability gate are separately approved.

## Deferred actions

Do not create the three Workers or five Workflows merely to reserve their names.
Deployment would create or update Workflows and activate hourly, 15-minute, and
5-minute cron schedules plus the Operations queue consumer.

Also defer custom-domain routes, DNS, additional Access applications or
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
does not begin until deployment and invocation.
