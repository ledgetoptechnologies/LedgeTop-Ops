# LTDS Ops

## Current pilot status

The client pilot is available canonically at `portal.ledgetopdroneservices.com`
and at `portal.ledgetoptechnologies.com` behind dedicated Cloudflare Access
applications. `client.ledgetopdroneservices.com` remains a compatibility host
for existing links and sessions. The portal is invitation/grant controlled:
Access email authentication is only the front door, while LTDS still enforces
local client, project, delivery, and request permissions. The pilot includes
service-request submission, Operations triage, and durable notifications.

The Operations Worker is the sole notification sender. The current pilot uses
TLS-only Gmail SMTP; the Client Worker never receives SMTP credentials. See
[notification operations](docs/notifications.md) for required variable names,
safe testing, and fallback behavior.

The complete request/revision/estimate/Project Alpha boundary, local evidence,
known limitations, Todd's App UX decision record, and engineering handoff are
in [the client request pilot contract](docs/client-portal.md).

The approved target for the Project Alpha hierarchy, dynamic Service Library,
multi-service requests, Mapbox acreage, non-binding pricing guidance, and
idempotent draft-quote handoff is in the
[client portal v2 compatibility contract](docs/client-portal-v2-architecture.md).
That document is a staged implementation contract and does not supersede the
current production pilot until its release gates pass.
The cross-feature, conversation-level acceptance record is the
[locked release scope](docs/locked-release-scope.md).

LedgeTop Ops is the shared operating and client-delivery platform for Ledge Top's service businesses. It contains three independently deployed Cloudflare Workers in one repository:

- `ledgetop-ops` at `ops.ledgetopdroneservices.com` and `ops.ledgetoptechnologies.com` — private staff operations, projects, tasks, airspace awareness, ACL, delivery administration, and Dropbox import.
- `ledgetop-clients` at `portal.ledgetopdroneservices.com`, `portal.ledgetoptechnologies.com`, and the legacy `client.ledgetopdroneservices.com` compatibility host — Access-protected client workspaces plus grant-controlled public delivery, same-origin media activation, downloads, and cloud transfers to Dropbox or Google Drive.

- `ledgetop-ops-sync` at `ops-sync.ledgetopdroneservices.com` receives signed Project Alpha entitlement webhooks and reconciles the Cloudflare Access group.

Project Alpha is authoritative for explicitly selected users, Project Managers and teams, Business Units as Project metadata, operations, tasks, and calendar data. LTDS Ops keeps a last-known-good read-only projection and owns airspace matching, R2 folder associations, delivery shares, and its protected break-glass Owner.

## Repository

```text
apps/
  operations/  React/Vite staff UI + Hono Worker API
  client/      React/Vite client UI + Hono Worker API
  ops-sync/    Project Alpha webhook + Cloudflare Access reconciliation Worker
packages/
  shared/      permission and API contracts
  ui/          LTDS branding and reusable React UI
docs/
  truenas/     R2 synchronization and media-preview runbook
  operations/  production operations and recovery runbooks
```

Each app intentionally has its own `package.json`, lockfile, `wrangler.jsonc`, migrations, and deploy lifecycle. Cloudflare Builds must use the application directory as its root and run `npm run deploy`.

| Worker | Build root | Deploy command |
|---|---|---|
| `ledgetop-ops` | `/apps/operations` | `npm run deploy` |
| `ledgetop-clients` | `/apps/client` | `npm run deploy` |
| `ledgetop-ops-sync` | `/apps/ops-sync` | `npm run deploy` |

## Local verification

```powershell
npm.cmd --prefix apps/client install
npm.cmd --prefix apps/operations install
npm.cmd --prefix apps/ops-sync install
npm.cmd run check
npm.cmd test
npm.cmd run build
```

Run each app locally with `npm.cmd --prefix apps/<app> run dev`. Copy its `.dev.vars.example` to `.dev.vars` and supply development-only values. Never commit `.dev.vars`.

## Cloudflare resources

- D1 `client-data` (`7f40a7b7-c3ec-470e-a626-e798867f71f8`)
- D1 `ltds-ops` (`6ebf7514-d306-4615-ae56-ad869c874dbd`)
- private R2 bucket `client-data`
- queue `ltds-file-events`, with R2 create and delete notifications
- configured thumbnail queue/DLQ names `ltds-thumbnail-jobs` and
  `ltds-thumbnail-jobs-dlq`; their remote existence must be verified before a
  dependent deployment
- Operations `THUMBNAIL_QUEUE`/DLQ bindings and the private, RPC-only
  `ThumbnailRendererContainer` fallback for one current still-image or
  first-page PDF thumbnail per source ETag
- Stream binding for private, signed video playback
- delivery access-code rate limiter
- cron schedules for FAA, Project Alpha, Stream status, cleanup,
  reconciliation, and the five-minute notification consumer

Both production configurations disable `workers.dev` and version preview URLs and reject unexpected hosts in Worker middleware.

## Before the first production code deployment

Complete [Cloudflare setup](docs/cloudflare-setup.md), including the Operations
Access audience, private thumbnail Queue/DLQ and Container bindings, and Stream
only if its separate playback feature is used. Thumbnail generation does not
use Cloudflare Images or Media Transformations. Then create a scoped Project
Alpha key as described in [Project Alpha integration](docs/project-alpha.md).
Follow the [TrueNAS runbook](docs/truenas/README.md) only after a staging
delivery has passed.

Wrangler configuration declares bindings; it is not evidence that queues,
Container entitlement, event subscriptions, migrations, or cron triggers exist
in the remote account. Verify those operator-owned resources during rollout.

For production operations, use the [operations runbook](docs/operations/README.md),
the [private thumbnail runbook](docs/media-thumbnail-pipeline.md), the current
[TrueNAS synchronization and prebuilt-renderer runbook](docs/truenas/README.md),
and the [inbound request design](docs/inbound-requests.md). These documents
distinguish repository behavior from operator-owned Cloudflare, TrueNAS, Hermes,
and alerting configuration.

See [Cloudflare setup](docs/cloudflare-setup.md), [notification operations](docs/notifications.md), and [future planning proposals](docs/future-plans.md) for the current pilot boundary, mail transport, and deferred work.

The Worker code is production-packaged, but a production deploy should not be performed with `OPERATIONS_AUD` still set to its placeholder or before the Access application protects the Operations hostname.
