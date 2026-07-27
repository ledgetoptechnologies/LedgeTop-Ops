# Public Delivery cloud transfers

Cloud transfers copy original Delivery objects directly to a recipient's Dropbox
or Google Drive. They do not build ZIP files and do not route file bodies through
the recipient's browser.

Both providers are disabled by default. Do not enable a provider until its
console application, callback, public client configuration, and Worker secrets
are all present.

## Required Worker configuration

The provider flags default to `false`. Keep `DROPBOX_CLIENT_SECRET`,
`GOOGLE_CLIENT_SECRET`, and `CLOUD_TRANSFER_TOKEN_SECRET` out of Wrangler
configuration and provision them with `wrangler secret put`. The token secret
must be 32 random bytes encoded as unpadded base64url.

The application advertises a provider only when its flag is `true` and all
required configuration exists. Missing configuration fails closed.

## Dropbox console

1. Create one scoped Dropbox API application owned by LTDS.
2. Choose **Full Dropbox** only if recipients must browse arbitrary existing
   folders. App Folder is safer but provides only an app-managed destination.
3. Enable `files.content.write`; add `files.metadata.read` only for a Full
   Dropbox destination browser.
4. Register:
   `https://delivery.ledgetopdroneservices.com/api/public/cloud-transfers/oauth/dropbox/callback`
5. Set `DROPBOX_CLIENT_ID` and store `DROPBOX_CLIENT_SECRET` as a Worker secret.
6. Leave implicit grant disabled. LTDS uses authorization code, PKCE, state,
   short-lived access tokens, and offline refresh tokens.

Dropbox transfers use add/autorename semantics and never silently overwrite.
Large-file fallback uses upload sessions.

## Google Cloud console

1. Enable Google Drive API and Google Picker API in an LTDS-owned project.
2. Configure the consent screen and create a Web application OAuth client.
3. Request only `https://www.googleapis.com/auth/drive.file`.
4. Register origin `https://delivery.ledgetopdroneservices.com`.
5. Register:
   `https://delivery.ledgetopdroneservices.com/api/public/cloud-transfers/oauth/google/callback`
6. Set `GOOGLE_CLIENT_ID`, `GOOGLE_PICKER_API_KEY`, and
   `GOOGLE_CLOUD_PROJECT_NUMBER`; store `GOOGLE_CLIENT_SECRET` as a Worker secret.
7. Restrict the Picker key by the production HTTPS origin and Picker API.

Google has no remote-URL import endpoint. The Workflow conditionally reads R2
ranges and relays them into resumable Drive sessions. Session URLs are encrypted
credentials and must never be returned to the browser or logged.

## Deployment

Apply the Delivery D1 migration before enabling a provider:

```powershell
cd apps/delivery
npx wrangler d1 migrations apply client-data --remote
```

Deploy first with both flags false and verify no cloud buttons render. Configure
and enable one provider at a time, then use an authorized share to test small
files before a large resumable upload.

Never enable a provider merely because its public client ID exists. A complete
setup also requires exact callbacks, approved scopes, encryption/client secrets,
the D1 migration, Workflow binding, and scheduled cleanup.

Verify OAuth denial/stale state, share revocation, source ETag mutation,
autorename conflicts, cancellation, Retry-After/429/5xx recovery, and cleanup.
Confirm logs never contain tokens, provider session URLs, or source grants.

Provider application creation, consent verification, credentials, and billing
changes are manual owner actions and are intentionally outside deployment.
