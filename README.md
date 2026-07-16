# Client Data Server

Branded, access-controlled delivery portal for Ledge Top Drone Services. This Worker replaces Dropbox share links while keeping bulk file transfer out of the application server.

## System design

```text
TrueNAS SCALE -- rclone/S3 --> private R2 bucket
                                   |
Client -- delivery link --> Cloudflare Worker <-- D1 metadata
                                   |
Staff -- Cloudflare Access --------+
Project Alpha -- scoped API key ----+
```

- **R2** stores the footage, photos, and other large files. The bucket remains private.
- **D1** stores staff authorization, projects, hashed share tokens, optional access-code hashes, Project Alpha API keys, and audit events. It does not store file contents.
- **Cloudflare Access** provides staff identity and sign-in for Beau, Kollins, and future staff. The Worker also validates the signed Access JWT and applies its own D1 role check.
- **Public delivery links** are revocable bearer tokens. A link can additionally require an access code sent through a separate channel.
- **Project Alpha** creates or retrieves delivery links through a narrow API. It never receives R2 credentials.
- **TrueNAS** talks directly to R2's S3-compatible endpoint using `rclone`; the Worker is not a large-file upload proxy.

## Implemented routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /` | Public | Branded landing page |
| `GET /s/:token?prefix=...` | Share token; optional access code | Dynamically browse the shared R2 folder tree |
| `POST /s/:token/unlock` | Public | Unlock a protected share for 12 hours |
| `GET /s/:token/download?key=...` | Unlocked share | Stream a scoped R2 object, including range requests |
| `GET /s/:token/view?key=...` | Unlocked share | Inline image, video, PDF, or text preview with range support |
| `GET /s/:token/thumbnail?key=...` | Unlocked share | Generate a bandwidth-friendly image thumbnail |
| `GET /admin`, `/admin/deliveries`, `/admin/settings` | Cloudflare Access + active D1 staff user | Files, delivery links, and administration workspace |
| `/api/v1/admin/*` | Cloudflare Access + D1 role | Staff, share, and API-key management |
| `/api/v1/integrations/shares` | Scoped API key | Project Alpha share creation/listing |
| `GET /health` | Public | Health response; does not expose dependencies |

The staff Files view browses R2 with folder breadcrumbs, grid/list views, previews, secured downloads, and a Share button on each folder. It is intentionally read-only because TrueNAS and its scheduled sync remain the authoritative source for file changes. Both the staff workspace and every client share list R2 at request time: no year, client, project, or `edited` folder is hard-coded, so later TrueNAS reorganizations appear automatically after sync. A path segment named `dump` is the sole structural exclusion and is rejected at both listing and download time.

Tokens and API keys are only stored as SHA-256 hashes. Access codes use salted PBKDF2-SHA-256 and are limited to 10 attempts per share per minute at each Cloudflare location. Project Alpha creation requires an idempotency key and derives a stable, high-entropy link token, so a safe retry returns the same URL without storing that token in plaintext.

## Local setup

Requirements: Node.js 20+ and a Cloudflare account.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

The Access-protected admin routes require a real Access JWT, so public routes are the easiest local smoke test. Integration routes work locally after inserting an API-key fixture or creating a key through a deployed admin dashboard.

## Cloudflare provisioning

1. Authenticate and create the resources:

   ```powershell
   npx wrangler login
   npx wrangler r2 bucket create client-data
   npx wrangler d1 create client-data
   ```

2. Put the returned D1 UUID in `wrangler.toml`.

3. Generate the application secret and store it as a Worker secret (never in `wrangler.toml`):

   ```powershell
   npx wrangler secret put APP_SECRET
   ```

   Use at least 32 cryptographically random bytes. Changing this secret invalidates Project Alpha's deterministic links and all access-code sessions, so keep a recoverable copy in the business password manager.

4. Set these non-secret values in `wrangler.toml`:

   - `PUBLIC_BASE_URL`: final delivery origin.
   - `TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`.
   - `POLICY_AUD`: Access application's audience tag.
   - `BOOTSTRAP_ADMIN_EMAIL`: Beau's exact login email. It creates the first D1 admin only when the staff table is empty.

5. Apply the migration and deploy:

   ```powershell
   npm run db:migrate:remote
   npm run deploy
   ```

6. Add `delivery.ledgetopdroneservices.com` as the Worker's custom domain.

7. In **Images > Transformations**, enable transformations for the zone. The portal uses one 520-by-340 transformation per image for grid thumbnails and falls back to file artwork if a source exceeds Cloudflare's remote-image limits. The original R2 objects remain private.

8. In Cloudflare Zero Trust, create a self-hosted Access application for both paths:

   - `delivery.ledgetopdroneservices.com/admin*`
   - `delivery.ledgetopdroneservices.com/api/v1/admin*`

   Allow only `beaukoltz@ledgetopdroneservices.com` and `kstirn@ledgetopdroneservices.com` (or a tightly controlled company identity group). Do **not** put the public `/s/*` or `/api/v1/integrations/*` paths behind that application. The integration route has its own scoped key authentication.

9. Visit `/admin` as Beau, then create the Project Alpha API key. The migrations seed Beau as `admin` and Kollins as `staff`; the raw integration key is shown once.

The configuration disables `workers.dev` and preview URLs so they cannot bypass path-based Access policy on the custom domain.

## TrueNAS SCALE to R2

Use an R2 API token restricted to **Object Read & Write** on only the `client-data` bucket. Do not reuse a Cloudflare account API token.

Create an `rclone` S3 remote (rclone 1.59 or newer):

```ini
[ltds-r2]
type = s3
provider = Cloudflare
access_key_id = REPLACE
secret_access_key = REPLACE
endpoint = https://REPLACE_ACCOUNT_ID.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
```

Recommended scheduled command:

```bash
rclone sync /mnt/POOL/jobs ltds-r2:client-data/jobs \
  --exclude "dump/**" \
  --exclude "**/dump/**" \
  --fast-list \
  --transfers 4 \
  --checkers 8 \
  --s3-upload-cutoff 100M \
  --s3-chunk-size 100M \
  --log-file /var/log/rclone-client-data.log \
  --log-level INFO
```

`sync` makes R2 mirror the source, including remote deletions. Start with `--dry-run`; if remote deletion is not desired, use `copy` instead. The two excludes skip a folder named `dump` at the root or at any nested level. Schedule it with a TrueNAS cron job or init/service wrapper after confirming the exact dataset path.

The portal does not require a fixed schema, but this mirrors the current server layout:

```text
jobs/<year>/<client-or-company>/<any-subfolders>/...
jobs/recurring/<client-or-organization>/<any-subfolders>/...
```

Folders named exactly `dump` at any depth are excluded from sync and independently blocked by the Worker. A folder named `unedited` is treated normally and can be shared. Any browsable folder can be the root of a delivery link; for example, `jobs/2026/Acme Construction/edited/`. Files added beneath that prefix later appear through the existing link automatically.

## Project Alpha contract

Create a delivery link:

```http
POST /api/v1/integrations/shares
Authorization: Bearer ltds_...
Content-Type: application/json

{
  "client_name": "Acme Construction",
  "project_name": "Roof inspection - July",
  "r2_prefix": "jobs/2026/Acme Construction/edited/",
  "external_ref": "project-alpha:project:1234",
  "idempotency_key": "delivery-link:project:1234:v1",
  "generate_access_code": true,
  "expires_at": "2026-08-16T00:00:00Z"
}
```

The response includes `share.share_url` and, only on first creation, an optional generated `share.access_code`. Project Alpha should store the URL. Repeating the same API key and `idempotency_key` yields the same link.

Project Alpha changes are intentionally limited to:

1. Store the integration API key as a server-side secret.
2. Replace Dropbox link creation with this POST request.
3. Persist `share_url` against its client/project record.
4. Send an access code separately when one was requested.

## Important operating decisions

- R2 object encryption protects data at rest, but a delivery link still grants access. Use access codes and expiration for confidential projects.
- Send the URL and access code through different channels when confidentiality matters.
- R2 is not a backup by itself. Retain TrueNAS snapshots and configure an R2 lifecycle policy appropriate to the business retention policy.
- This MVP lists up to 250 objects per page and streams individual downloads. Server-side ZIP creation is deliberately excluded because drone projects can exceed Worker memory/time limits.
