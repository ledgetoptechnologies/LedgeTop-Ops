# Cloudflare production setup

## 1. Worker Builds

Configure the Git repository `ledgetoptechnologies/LTDS-Ops` four times:

| Setting | Operations | Delivery | Ops Sync | Incoming |
|---|---|---|---|---|
| Production branch | `main` | `main` | `main` | `main` |
| Root directory | `/apps/operations` | `/apps/delivery` | `/apps/ops-sync` | `/apps/incoming` |
| Build command | `npm run build` | `npm run build` | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy` | `npm run deploy` | `npm run deploy` |
| Version command | `npx wrangler versions upload` | `npx wrangler versions upload` | `npx wrangler versions upload` | `npx wrangler versions upload` |

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

Activate Cloudflare Images Transformations and Stream billing in the Cloudflare dashboard. Both apps use an Images binding; Stream is used for private video previews.

Ops ingests R2 videos with the resumable TUS protocol in streamed 50 MB ranges. It supports Stream's large-file path and never reads a whole video into Worker memory. Delivery uses the Stream binding to generate one-hour signed tokens. Original R2 objects remain the download source.

After Stream activation, create a Stream Write API token and set these Ops runtime secrets/settings:

```powershell
npx.cmd wrangler secret put STREAM_API_TOKEN --name ltds-ops
```

Set `STREAM_ACCOUNT_ID` and `STREAM_CUSTOMER_CODE` as non-secret runtime variables. Do not give the Delivery Worker the Stream management token.

Create a dedicated R2 API credential with read-only access to `client-data` for short-lived original-file and ZIP tickets. Do not reuse the TrueNAS write credential:

```powershell
Set-Location apps/delivery
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
```

These credentials sign direct browser download URLs only. Delivery's normal R2 reads use the `DATA_BUCKET` binding, and preview SHA identities do not use these secrets.

Create a separate least-privilege R2 credential for the Operations Worker. It may authorize writes only to `client-data`; do not reuse the TrueNAS or Delivery credential:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
```

These credentials sign direct multipart browser uploads only. Operations CRUD, preview validation, and post-upload manifest finalization use the `DATA_BUCKET` binding.

Set the account S3 endpoint and bucket name as non-secret Operations variables. Apply an R2 CORS policy that permits only the production Operations origin and the dedicated staging Operations origin, allows the headers signed by the upload flow, and exposes `ETag`. Never permit `*` origins with credentialed staff uploads. Presigned upload authorization must remain short-lived and object-specific.

After replacing the staging hostname in `apps/operations/r2-cors.json` with the deployed staging hostname, apply it from the Operations directory:

```powershell
npx.cmd wrangler r2 bucket cors set client-data --file r2-cors.json
```

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

Create separate staging Workers for all four services, D1 databases, R2 buckets, Workflow, queue, secrets, hostnames, and Access applications. Never bind staging to production D1/R2. Test Beau, Kollins, an Operator account, a public client flow, an inbound multipart upload, and successful/failed ZIP jobs before production builds from `main`.

## 7. Incoming requests

Create the private `ltds-incoming` bucket, attach `incoming.ledgetopdroneservices.com`, create a Turnstile widget restricted to that hostname, set `TURNSTILE_SITE_KEY`, and provision:

```powershell
Set-Location apps/incoming
npx.cmd wrangler secret put TURNSTILE_SECRET
npx.cmd wrangler secret put INCOMING_SESSION_SECRET
npx.cmd wrangler secret put INCOMING_ACCESS_CODE_PEPPER
npx.cmd wrangler secret put AUDIT_IP_SECRET
npx.cmd wrangler secret put R2_INCOMING_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_INCOMING_SECRET_ACCESS_KEY
npx.cmd wrangler secret put INCOMING_PICKUP_SECRET
```

The R2 credential is scoped only to multipart writes in `ltds-incoming`. Apply the browser CORS policy from `docs/inbound-requests.md`, expose `ETag`, and configure a 14-day lifecycle backstop for quarantine objects and abandoned multipart uploads. Deployment creates the `ltds-incoming-upload-lifecycle` Workflow, which aborts incomplete uploads after 24 hours and expires unclaimed quarantine after 14 days without consuming an account Cron Trigger. TrueNAS calls the authenticated pickup-receipt endpoint only after ClamAV, checksum verification, durable local promotion, and removal of the quarantine object.

## 8. Migrations and Workflow rollout

Export both production D1 databases before migration. Then apply Operations migrations to `ltds-ops` and Delivery migrations to `client-data`:

```powershell
Set-Location apps/operations
npm.cmd run db:migrate:remote
Set-Location ../delivery
npm.cmd run db:migrate:remote
```

Confirm Delivery `0006`, `0007`, `0008`, `0090`, `0091`, `0092`, and all Operations delivery-CRUD migrations appear in the remote migration list before deploying dependent Workers. Delivery deployment creates/updates the `ltds-bulk-download` Workflow binding. Operations deployment creates/updates its file-operation Workflow binding. Each successful ZIP job sleeps for its 24-hour retention and then deletes its own archive, so Delivery does not require a Cron Trigger. Verify one completed job, one intentionally failed job, multipart cleanup, the 24-hour archive expiry, the three-per-hour exact quota, and one copy/move job with an injected retry before production rollout.

The 20 GB ZIP limit and 10,000-object R2 CRUD limit require the Workers Paid Workflow step allowance. Do not enable those production limits on a Free-plan account; reduce the application limits or upgrade first.

## 9. Email alerts

Onboard the sending domain in Cloudflare Email Service, add an `EMAIL` send-email binding to `ltds-ops`, and set non-empty `ALERT_FROM` and `ALERT_TO`. Until all three are present, alerts deliberately remain disabled. Send a staging reconciliation alert and verify delivery before enabling production automation.

## 10. Current provisioned resources

- Ops D1: `ltds-ops` / `6ebf7514-d306-4615-ae56-ad869c874dbd`
- Delivery D1: `client-data` / `7f40a7b7-c3ec-470e-a626-e798867f71f8`
- R2: `client-data`
- Incoming R2: `ltds-incoming` (private; production-origin CORS and quarantine lifecycle configured)
- Queue: `ltds-file-events`
- R2 notifications: object-create and object-delete to `ltds-file-events`

Do not infer migration or secret readiness from this file; verify the remote resources during each rollout.
