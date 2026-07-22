# Cloudflare production setup

## 1. Worker Builds

Configure the Git repository `ledgetoptechnologies/LTDS-Ops` three times:

| Setting | Operations | Delivery | Ops Sync |
|---|---|---|---|
| Production branch | `main` | `main` | `main` |
| Root directory | `/apps/operations` | `/apps/delivery` | `/apps/ops-sync` |
| Build command | `npm run build` | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy` | `npm run deploy` |
| Version command | `npx wrangler versions upload` | `npx wrangler versions upload` | `npx wrangler versions upload` |

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

## 5. Project Alpha

Set the Ops runtime secret:

```powershell
npx.cmd wrangler secret put PROJECT_ALPHA_API_KEY --name ltds-ops
```

Set `PROJECT_ALPHA_BASE_URL` to the production Project Alpha origin. The key must have only `ops.sync.read`.

Create a separate self-hosted Access application named **LTDS Ops Sync** for `ops-sync.ledgetopdroneservices.com/*`. Add a Service Auth policy whose include rule is the Project Alpha service token. Copy that application's AUD into `CF_ACCESS_AUD` on `ltds-ops-sync`. Its service-token client ID and secret belong only in Project Alpha.

Set `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID`, and a deployment-specific `APPLICATION_KEY` (for example, `field_operations`) on the provisioning Worker. Configure the same key on the Operations snapshot importer and in Project Alpha. Bind `OPS_DB` to the deployment's Operations D1 database and add these Worker secrets:

The checked-in LTDS production configuration uses `ltds_ops`; this is not a Project Alpha convention or a default for other deployments.

```powershell
npx.cmd wrangler secret put CF_ACCESS_GROUP_API_TOKEN --name ltds-ops-sync
npx.cmd wrangler secret put PROJECT_ALPHA_WEBHOOK_HMAC_SECRET --name ltds-ops-sync
```

The Access Groups API token belongs only on the sync Worker, never in Project Alpha. The exact same generated HMAC value must be entered on both sides.

## 6. Staging before rollout

Create separate `ltds-ops-staging` and `ltds-delivery-staging` Workers, D1 databases, R2 bucket, queue, secrets, hostnames, and Access applications. Never bind staging to production D1/R2. Test Beau, Kollins, an Operator account, and a public client flow before the production Workers build from `main`.

## 7. Current provisioned resources

- Ops D1: `ltds-ops` / `6ebf7514-d306-4615-ae56-ad869c874dbd`
- Delivery D1: `client-data` / `7f40a7b7-c3ec-470e-a626-e798867f71f8`
- R2: `client-data`
- Queue: `ltds-file-events`
- R2 notifications: object-create and object-delete to `ltds-file-events`

The Ops schema and delivery schema migrations have been applied. An ignored pre-migration Delivery export is stored locally under `.backups/`.
