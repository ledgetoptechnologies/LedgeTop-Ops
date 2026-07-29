# LTDS Ops

LTDS Ops is the operating and client-delivery platform for Ledge Top Drone Services. It contains three independently deployed Cloudflare Workers in one repository:

- `ltds-ops` at `ops.ledgetopdroneservices.com` — private staff operations, projects, tasks, airspace awareness, ACL, delivery administration, and Dropbox import.
- `ltds-delivery` at `delivery.ledgetopdroneservices.com` — public, tokenized client file browsing, previews, downloads, and cloud transfers to Dropbox or Google Drive.

- `ltds-ops-sync` at `ops-sync.ledgetopdroneservices.com` receives signed Project Alpha entitlement webhooks and reconciles the Cloudflare Access group.

Project Alpha is authoritative for explicitly selected users, Project Managers and teams, Business Units as Project metadata, operations, tasks, and calendar data. LTDS Ops keeps a last-known-good read-only projection and owns airspace matching, R2 folder associations, delivery shares, and its protected break-glass Owner.

## Repository

```text
apps/
  operations/  React/Vite staff UI + Hono Worker API
  delivery/    React/Vite client UI + Hono Worker API
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
| `ltds-ops` | `/apps/operations` | `npm run deploy` |
| `ltds-delivery` | `/apps/delivery` | `npm run deploy` |
| `ltds-ops-sync` | `/apps/ops-sync` | `npm run deploy` |

## Local verification

```powershell
npm.cmd --prefix apps/delivery install
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
- Images binding for R2 thumbnails
- Stream binding for private, signed video playback
- delivery access-code rate limiter
- cron schedules for FAA, Project Alpha, Stream status, cleanup, and reconciliation

Both production configurations disable `workers.dev` and version preview URLs and reject unexpected hosts in Worker middleware.

## Before the first production code deployment

Complete [Cloudflare setup](docs/cloudflare-setup.md), including the Operations Access audience and account activation for Images/Stream. Then create a scoped Project Alpha key as described in [Project Alpha integration](docs/project-alpha.md). Follow the [TrueNAS runbook](docs/truenas/README.md) only after a staging delivery has passed.

For production operations, use the [operations runbook](docs/operations/README.md), the [media-preview contract](docs/truenas/preview-pipeline.md), and the [inbound request design](docs/inbound-requests.md). These documents distinguish repository behavior from operator-owned Cloudflare, TrueNAS, Hermes, and alerting configuration.

The Worker code is production-packaged, but a production deploy should not be performed with `OPERATIONS_AUD` still set to its placeholder or before the Access application protects the Operations hostname.
