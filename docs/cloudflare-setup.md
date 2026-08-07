# Cloudflare production setup

## 1. Worker Builds

Configure the Git repository `ledgetoptechnologies/LTDS-Ops` three times:

| Setting | Operations | Delivery | Ops Sync |
|---|---|---|---|
| Production branch | `main` | `main` | `main` |
| Root directory | `/apps/operations` | `/apps/client` | `/apps/ops-sync` |
| Build command | `npm run build` | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy` | `npm run deploy` |
| Version command | `npx wrangler versions upload` | `npx wrangler versions upload` | `npx wrangler versions upload` |

### Source-layout transition guard

The Delivery Worker Builds root must change from `/apps/delivery` to
`/apps/client` before the first build from a commit containing the source move.
That separately approved dashboard change is the only Cloudflare configuration
required by the source-layout refactor. It must not rename `ltds-delivery` or
change its routes, custom domains, Access applications, variables, secrets, D1,
R2, Queue, Workflow, Images, Stream, or rate-limit bindings.

Do not attach `client.ledgetopdroneservices.com` or remove `delivery.` as part
of the source-layout change. The later client-host-aware release uses the
ordered clean cutover and rollback in [future planning](future-plans.md#ordered-hostname-cutover).

### Client portal authentication and pilot boundary

The client portal has a default-off Cloudflare Access adapter. It accepts only
a signed `Cf-Access-Jwt-Assertion` from a **separate Client Portal** Access
application, validating its HTTPS issuer, exact client audience, `RS256`
signature, `type=app`, expiry, a syntactically valid email claim, and nonempty
subject. Cloudflare Access and its configured identity provider verify the
human email before issuing the application token; the token contract does not
require a separate `email_verified` claim. The Worker
then independently resolves the issuer/subject against a local active
membership and grant; an Access login alone never grants a client account,
project, delivery, or billing access.

Set `CLIENT_ACCESS_TEAM_DOMAIN` and `CLIENT_ACCESS_AUD` only for that dedicated
app. Do not reuse the Operations, Ops Sync, or historic Delivery audience. The
future internal Access-group reconciler consumes the client membership outbox;
its `CLIENT_ACCESS_GROUP_API_TOKEN` secret belongs on that internal worker only,
never on the public client/delivery Worker. It uses a separate client group and
must not mix staff ACL provisioning with client invitations.

The approved pilot is attached at `client.ledgetopdroneservices.com`. It uses a
dedicated Client Portal Access application and current-policy API, with an
email one-time-passcode login and a short-lived pilot allow group. It is not a
host-wide Allow policy and it does not turn every Project Alpha contact into a
portal user. A successful Access login still requires a local active
membership and grant in LTDS.

Public share paths remain outside Access and continue to use their own
revocable-link controls. The service-request API uses the existing
`PUBLIC_BULK_RATE_LIMITER` with a scope-separated, server-derived account key.
Keep the client Access audience, group, and provisioning automation separate
from Operations staff ACL provisioning.

For the separately authorized rollout, the production Client Portal Access app
must target only `client.ledgetopdroneservices.com/portal`, `/portal/*`,
`/api/client`, and `/api/client/*`. Use a dedicated client group and audience.
Define a separate root client-host application with a narrowly reviewed Bypass
Everyone policy so public shares do not require Access. The more-specific
portal paths retain the portal Allow policy. Release-critical public path
families include `/`, `/s/*`, `/api/public/*`, `/health`, and `/assets/*`; they
remain under the Worker's own routing and authorization controls.
Never use a host-wide client Allow policy, and verify no
`Cf-Access-Jwt-Assertion` reaches a public share request. Cloudflare documents
path matching and specificity in
[Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

The pilot must retain an exported rollback configuration. Before expanding
beyond the pilot, prove authenticated portal access, unprovisioned denial,
cross-account denial, public-share isolation, request submission, Operations
triage, and notification delivery. Full isolated-staging guidance remains in
[the staging rollout packet](staging/client-portal-rollout.md).

### Branch-control release gate

The production trigger for all three integrations must be `main` only, after
review and required checks. Until isolated staging Workers and hostnames exist,
disable non-production branch builds. If non-production builds are retained for
artifact validation, their command must stop at `wrangler versions upload` to a
separately named non-production Worker: never run `wrangler deploy` for a
non-production branch, and never attach its version to a production route or
custom domain.

Changing Worker Builds settings is a Cloudflare dashboard mutation and requires
explicit operator approval. Before changing anything, record the production
branch, include/exclude rules, root/build/deploy commands, Worker target, routes,
custom domains, variable mappings, and token scope. After an approved change,
use a no-op documentation branch and verify both that the build has no
production route and that production deployment history and traffic allocation
did not change. A successful build alone is not evidence of isolation.

Accepted evidence for commit `fea54be` on 2026-07-30:

- Delivery version `93d188ff-9586-4755-9a3d-63b0f8f5d8fa` was promoted to 100%
  production traffic and has been accepted; no rollback is requested.
- Operations build `83eb8d31-a0fc-486d-884c-ac413b3d7dc5` was not promoted;
  production remained on `a246a403-9030-4153-a7f4-3f271c64b331`.
- Ops Sync build `1208a40c-ca8f-4687-8e5c-e5953c92a1c0` was not promoted;
  production remained on `6492215d-e3b9-4c26-b02c-4a8da3e3099b`.

No dashboard configuration change is authorized by this documentation.

Do not add runtime secrets to Build variables. The application secrets are Worker runtime secrets.

Delivery access codes use a shared HMAC pepper. Generate one cryptographically random value of at least 32 bytes and store the exact same value as the `DELIVERY_ACCESS_CODE_PEPPER` runtime secret on both `ltds-ops` and `ltds-delivery`. The value must never be committed, printed in logs, or placed in build variables. Ops hashes new codes and Delivery verifies them; neither Worker stores a plaintext code.

`DELIVERY_TOKEN_SECRET` remains an Ops-only runtime secret. It encrypts recoverable link fragments for authorized staff; the public Delivery Worker authenticates only the link hash and does not receive this secret.

## 2. Operations hostname and Access

1. Attach `ops.ledgetopdroneservices.com` to Worker `ltds-ops`.
2. Create a Cloudflare Access self-hosted application named **LTDS Operations**.
3. Set its only production destination to `ops.ledgetopdroneservices.com/*`.
4. Under **Access controls > Policies > Rule groups**, create the dedicated automation-owned **LTDS Ops Users** rule group. Create an Allow policy whose Include rule references that group, and keep the protected Owner in the group.
5. Keep One-time PIN enabled, or select the intended identity provider. Enable instant authentication when only one provider is available.
6. Optionally enable Cloudflare One Client authentication for enrolled WARP devices. WARP reduces prompts but does not bypass LTDS ACL.
7. Copy the application **Audience (AUD) tag** from the application Overview/Settings page into `OPERATIONS_AUD` in `apps/operations/wrangler.jsonc`.
8. Confirm the Access application protects the custom hostname before deploying Ops code.

The old Delivery Access audience does not belong in the Operations configuration. Delivery is public at the network layer and authorizes every client share in the Worker.

## 3. Alternate routes

Both `wrangler.jsonc` files set:

```json
"workers_dev": false,
"preview_urls": false
```

After deployment, verify the Worker dashboard has not re-enabled a `workers.dev` route. Both Workers also reject unexpected `Host` headers.

## 4. Images and Stream

Activate Cloudflare Images Transformations for the Operations Worker. The Client
Worker deliberately has no Images binding: it serves only an already-generated
private R2 thumbnail after reauthorization. Stream remains available for private
playback of previously processed videos, but this release does not submit new
videos for thumbnailing or transcoding.

Delivery uses the Stream binding to generate one-hour signed tokens for existing
Stream assets. Original R2 objects remain the authorized download source.

After Stream activation, create a Stream Write API token and set these Ops runtime secrets/settings:

```powershell
npx.cmd wrangler secret put STREAM_API_TOKEN --name ltds-ops
```

Set `STREAM_ACCOUNT_ID` and `STREAM_CUSTOMER_CODE` as non-secret runtime variables. Do not give the Delivery Worker the Stream management token.

Create a dedicated R2 API credential with read-only access to `client-data` for short-lived original-file and ZIP tickets. Do not reuse the TrueNAS write credential:

```powershell
Set-Location apps/client
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
```

These credentials sign direct browser download URLs only. Delivery's normal R2 reads use the `DATA_BUCKET` binding, and preview SHA identities do not use these secrets.

Create a separate least-privilege R2 credential for the Operations Worker's
public Incoming multipart flow. Scope Object Read & Write to `ltds-incoming`;
do not reuse the TrueNAS or Delivery credential:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
```

These credentials sign only short-lived, object-specific Incoming quarantine
parts. Authenticated staff delivery uploads do not use them: the browser sends
parts to same-origin Operations routes and the Worker writes through its private
`DATA_BUCKET` binding. The staff route never returns a public/presigned R2 URL.

Set the account S3 endpoint and Incoming bucket name as non-secret Operations
variables. Apply CORS only to the private Incoming bucket for its direct
quarantine-part flow. Permit only the production Incoming origin and dedicated
staging Incoming origin, allow only the signed headers, and expose `ETag`.
Never permit `*`. The `client-data` bucket needs no browser-upload CORS rule for
the same-origin staff flow; do not add one for this feature.

Apply the checked-in production policy from the Operations directory:

```powershell
npx.cmd wrangler r2 bucket cors set ltds-incoming --file r2-incoming-cors.json
```

For isolated staging, use a separately reviewed policy containing only the
exact staging Incoming origin and apply it to the separately named staging
bucket. Do not edit the production policy to include a temporary origin or
apply the production policy to staging.

## 5. Project Alpha

Set the Ops runtime secret:

```powershell
npx.cmd wrangler secret put PROJECT_ALPHA_API_KEY --name ltds-ops
```

Set `PROJECT_ALPHA_BASE_URL` to the production Project Alpha origin. The key must have only `ops.sync.read`.

Create a separate self-hosted Access application named **LTDS Ops Sync** for `ops-sync.ledgetopdroneservices.com/*`. Add a Service Auth policy whose include rule is the Project Alpha service token. Copy that application's AUD into `CF_ACCESS_AUD` on `ltds-ops-sync`. Its service-token client ID and secret belong only in Project Alpha.

Set `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID`, the exact deployment-specific `CF_ACCESS_GROUP_NAME`, and a deployment-specific `APPLICATION_KEY` (for example, `field_operations`) on the provisioning Worker. Configure the same application key on the Operations snapshot importer and in Project Alpha. The group name lets reconciliation safely recover when a configured group identifier has been replaced. Bind `OPS_DB` to the deployment's Operations D1 database and add these Worker secrets:

The checked-in LTDS production configuration uses `ltds_ops`; this is not a Project Alpha convention or a default for other deployments.

```powershell
npx.cmd wrangler secret put CF_ACCESS_GROUP_API_TOKEN --name ltds-ops-sync
npx.cmd wrangler secret put PROJECT_ALPHA_WEBHOOK_HMAC_SECRET --name ltds-ops-sync
npx.cmd wrangler secret put PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY --name ltds-ops-sync
```

Use `PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY` only during rotation. The Access Groups API token belongs only on the sync Worker, never in Project Alpha. Production has legacy HMAC disabled; verify Ed25519 in staging before that configuration is deployed.

## 6. Staging before rollout

Create separate staging Workers for all three services, D1 databases, R2 buckets, Workflows, queue, secrets, hostnames, and Access applications. Never bind staging to production D1/R2. The client portal uses a distinct staging hostname, app/audience/group, and public Bypass policy while remaining default-off. Test Beau, Kollins, an Operator account, provisioned and unprovisioned client identities, cross-account denial, a public share with and without a password, an inbound multipart upload, and successful/failed ZIP jobs before production builds from `main`.

## 7. Incoming requests

Create the private `ltds-incoming` bucket. Route `incoming.ledgetopdroneservices.com` to `ltds-ops`, but keep Cloudflare Access limited to `ops.ledgetopdroneservices.com/*`. Create a Turnstile widget restricted to the Incoming hostname, set `TURNSTILE_SITE_KEY`, and provision on Operations:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put TURNSTILE_SECRET
npx.cmd wrangler secret put TURNSTILE_SITE_KEY
npx.cmd wrangler secret put INCOMING_SESSION_SECRET
npx.cmd wrangler secret put INCOMING_ACCESS_CODE_PEPPER
npx.cmd wrangler secret put INCOMING_PICKUP_SECRET
```

Apply `apps/operations/r2-incoming-cors.json`, expose `ETag`, and configure a 14-day lifecycle backstop for quarantine objects and abandoned multipart uploads. Operations deployment creates the `ltds-incoming-upload-lifecycle` Workflow, which aborts incomplete uploads after 24 hours and expires unclaimed quarantine after 14 days. TrueNAS calls the authenticated pickup endpoint only after ClamAV, checksum verification, durable local copy, and removal of the quarantine object.

## 7a. Authenticated staff delivery uploads

Authenticated delivery uploads remain on `ltds-ops`; a separate public upload
Worker or endpoint is neither required nor permitted. Keep
`DIRECT_DELIVERY_UPLOADS_ENABLED=false` while applying Operations migration
`0018_browser_upload_intents.sql` and validating the same-origin route. The
final reviewed production version may set it to `true` only after migration,
queue/binding verification, and synthetic authorization/lifecycle acceptance;
rollback first returns it to `false` without removing cleanup-capable code. The
feature requires the existing Operations Access application and audience,
`OPS_DB`, private `DATA_BUCKET`, `DELIVERY_DB`, `THUMBNAIL_QUEUE`, and both
five-minute and 15-minute Cron Triggers. It requires no new R2 API credential,
CORS rule, public bucket domain, route, hostname, queue, or Worker.

The active access model is deliberately narrow: an Operations staff principal
must pass the expected-host, Access JWT/session, origin/CSRF, administrator, and
scoped `delivery.files.upload` checks for the selected folder and every resolved
file. Client Portal identities, public-share sessions, and Incoming contributor
sessions have no authority on these routes. See the [thumbnail and upload
runbook](media-thumbnail-pipeline.md#authenticated-operations-browser-uploads)
for limits, collision policy, lifecycle, acceptance, and rollback.

## 7b. Dropbox import (Operations Worker)

To enable staff Dropbox import, provision these Operations Worker secrets and variables:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put DROPBOX_CLIENT_SECRET
npx.cmd wrangler secret put DROPBOX_IMPORT_TOKEN_SECRET
```

Set `DROPBOX_CLIENT_ID` and `DROPBOX_IMPORT_ENABLED` in `apps/operations/wrangler.jsonc`. Register the callback `https://ops.ledgetopdroneservices.com/api/dropbox-import/oauth/callback` in the Dropbox API application. Apply migration `0013_dropbox_import.sql` to the `ltds-ops` D1 database. The `ltds-dropbox-import` Workflow binding is created on deploy.

## 8. Migrations and Workflow rollout

Export both production D1 databases before migration. Apply Delivery migrations
to `client-data` first because the new Operations Worker depends on Delivery
tables from migrations `0105` through `0108`; then apply Operations migrations to `ltds-ops`:

```powershell
Set-Location apps/client
npm.cmd run db:migrate:remote
Set-Location ../operations
npm.cmd run db:migrate:remote
```

Confirm Delivery migrations through `0108_thumbnail_backfill_runs.sql` and
Operations migrations through `0018_browser_upload_intents.sql` appear in the
remote migration lists before deploying dependent Workers. Before the
Operations deployment, separately verify that Images transformations are
enabled, the thumbnail queue and DLQ exist, the producer/main-consumer/DLQ
consumer bindings resolve to those exact queues, the existing R2 object-create
notification still feeds `ltds-file-events`, and both the 15-minute and
5-minute crons are present. The existing private `ltds-ops` Worker owns the
thumbnail consumer; no separate or public `ltds-thumbnails` Worker is needed.
Repository configuration does not prove those remote resources exist.

Delivery deployment creates/updates the `ltds-bulk-download` Workflow binding,
the `ltds-cloud-transfer` Workflow binding, and the hourly cleanup Cron Trigger.
Operations deployment creates/updates its file-operation Workflow binding, the
`ltds-dropbox-import` Workflow binding, the
`ltds-incoming-upload-lifecycle` Workflow binding, and the thumbnail Queue
producer/consumers. Follow the separate [thumbnail deployment
sequence](media-thumbnail-pipeline.md) before enabling that producer. Each
successful ZIP job sleeps for its 24-hour retention and deletes its own archive;
the hourly Delivery cleanup is the recovery path for expired or interrupted
jobs and also prunes old quota rows. Verify one completed job, one intentionally
failed job, multipart cleanup, the 24-hour archive expiry, the three-per-hour
exact quota, one copy/move job with an injected retry, and one Dropbox import
job before production rollout.

The 20 GB ZIP limit and 10,000-object R2 CRUD limit require the Workers Paid Workflow step allowance. Do not enable those production limits on a Free-plan account; reduce the application limits or upgrade first.

## 9. Email alerts

Onboard the sending domain in Cloudflare Email Service, add an `EMAIL` send-email binding to `ltds-ops`, and set non-empty `ALERT_FROM` and `ALERT_TO`. Until all three are present, alerts deliberately remain disabled. Send a staging reconciliation alert and verify delivery before enabling production automation.

## 10. Current provisioned resources

- Ops D1: `ltds-ops` / `6ebf7514-d306-4615-ae56-ad869c874dbd`
- Delivery D1: `client-data` / `7f40a7b7-c3ec-470e-a626-e798867f71f8`
- R2: `client-data`
- Incoming R2: `ltds-incoming` (private; production-origin CORS and quarantine lifecycle configured)
- Queue: `ltds-file-events`
- Thumbnail Queue/DLQ: `ltds-thumbnail-jobs`, `ltds-thumbnail-jobs-dlq`
- R2 notifications: object-create and object-delete to `ltds-file-events`
- Workflows: `ltds-bulk-download`, `ltds-cloud-transfer` (delivery), `ltds-r2-crud`, `ltds-incoming-upload-lifecycle`, `ltds-dropbox-import` (operations)

Do not infer migration or secret readiness from this file; verify the remote resources during each rollout.
