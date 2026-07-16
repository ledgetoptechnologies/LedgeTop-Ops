# Client Data Server — Ledge Top Drone Services

Cloudflare Worker for delivering drone footage and photos to clients via a branded portal.

## Architecture

```
Client visits delivery.ledgetoptechnologies.com/?token=abc123
       |
       v
  Cloudflare Worker (this repo)
       |
       +-- D1 database (token → client/project mapping)
       |
       +-- R2 bucket (file storage, native binding)
       |
       v
  File streams directly to client browser
```

## Brand

- **Company:** Ledge Top Drone Services
- **Primary color:** #F8CB2E (gold)
- **Secondary color:** #EE5007 (orange-red)
- **Navbar:** #000000 (black)
- **Background:** #f0f8ff (light blue-tinted)
- **Font:** Outfit (Google Fonts)
- **Logo:** DroneLogo01.webp (loaded from ledgetopdroneservices.com)

## Setup (for Codex to complete)

### 1. Create R2 bucket
```bash
npx wrangler r2 bucket create client-data
```

### 2. Create D1 database
```bash
npx wrangler d1 create client-data
# Copy the database_id into wrangler.toml
```

### 3. Set secrets
```bash
npx wrangler secret put ADMIN_SECRET
# Enter a strong secret — used for the /api/admin/token endpoints
```

### 4. Deploy
```bash
npx wrangler deploy
```

### 5. Add custom domain
In Cloudflare dashboard: Workers & Pages → client-data-server → Settings → Triggers → Custom Domain:
`delivery.ledgetoptechnologies.com`

## API

### Create access token (admin only)
```bash
curl -X POST https://delivery.ledgetoptechnologies.com/api/admin/token \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"John Smith","project":"Roof Inspection - June","r2_prefix":"clients/john-smith/"}'
```
Returns: `{"success":true,"token":"abc123...","url":"/?token=abc123..."}`

### Revoke access token (admin only)
```bash
curl -X DELETE https://delivery.ledgetoptechnologies.com/api/admin/token \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"token":"abc123..."}'
```

### Client portal
`GET /?token=abc123` — Branded HTML page listing all files under the token's R2 prefix

### File download
`GET /download?token=abc123&file=clients/john-smith/video.mp4` — Streams file from R2

### Health check
`GET /health` — Returns `{"status":"ok"}`

## R2 file organization
Files are stored in the R2 bucket with prefixes per client/project:
```
clients/
  john-smith/
    roof-inspection-june/
      video_001.mp4
      video_002.mp4
      photos/
        img_001.jpg
        img_002.jpg
  jane-doe/
    construction-progress/
      ...
```

The `r2_prefix` in the access token determines which files the client can see. The prefix acts as a scope — a client can only access files under their prefix.

## Security
- Token-based access (no login screen)
- File downloads verify the requested file path starts with the token's R2 prefix
- Token revocation via admin API
- Optional token expiration (expires_at field)
- Admin endpoints require Bearer token authentication (ADMIN_SECRET)