# Cloudflare production setup

## 1. Worker Builds

Configure the Git repository `ledgetoptechnologies/LTDS-Ops` twice:

| Setting | Operations | Delivery |
|---|---|---|
| Production branch | `main` | `main` |
| Root directory | `/apps/operations` | `/apps/delivery` |
| Build command | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy` |
| Version command | `npx wrangler versions upload` | `npx wrangler versions upload` |

Do not add runtime secrets to Build variables. The application secrets are Worker runtime secrets.

## 2. Operations hostname and Access

1. Attach `ops.ledgetopdroneservices.com` to Worker `ltds-ops`.
2. Create a Cloudflare Access self-hosted application named **LTDS Operations**.
3. Set its only production destination to `ops.ledgetopdroneservices.com/*`.
4. Create an Allow policy with explicit emails:
   - `beaukoltz@ledgetopdroneservices.com`
   - `kstirn@ledgetopdroneservices.com`
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

## 6. Staging before rollout

Create separate `ltds-ops-staging` and `ltds-delivery-staging` Workers, D1 databases, R2 bucket, queue, secrets, hostnames, and Access applications. Never bind staging to production D1/R2. Test Beau, Kollins, an Operator account, and a public client flow before the production Workers build from `main`.

## 7. Current provisioned resources

- Ops D1: `ltds-ops` / `6ebf7514-d306-4615-ae56-ad869c874dbd`
- Delivery D1: `client-data` / `7f40a7b7-c3ec-470e-a626-e798867f71f8`
- R2: `client-data`
- Queue: `ltds-file-events`
- R2 notifications: object-create and object-delete to `ltds-file-events`

The Ops schema and delivery schema migrations have been applied. An ignored pre-migration Delivery export is stored locally under `.backups/`.
