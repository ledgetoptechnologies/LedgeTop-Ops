# Staging release gate and command packet

This packet prepares commands; it does not authorize running them. Keep the
client portal, Dropbox, Google, permanent purge, and incoming uploads disabled.
The client-specific sequence is in
[client-portal-rollout.md](client-portal-rollout.md).

## Current credential boundary

Use `& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami` immediately before a release. Record only the
account, authentication method, permission names, and timestamp. Never copy an
OAuth token or API token into the evidence file.

Wrangler OAuth can manage Workers and D1 but does not prove Cloudflare Access
or Workers Builds visibility. Verify Branch control separately for Delivery,
Operations, and Ops Sync:

- production branch is exactly `main`;
- Builds for non-production branches is off;
- the dashboard or Builds API record is attached to the release ticket.

Do not push a branch merely to test this setting. Historical preview uploads
for Operations and Ops Sync contained production bindings even though they did
not become active deployments.

## Required non-secret values

- approved Project Alpha staging HTTPS origin;
- staging Access group ID and exact group name;
- Ops Sync staging service-auth policy and Project Alpha service-token owner;
- Delivery, Operations, and Ops Sync staging DNS readiness;
- `client-staging.ledgetopdroneservices.com`, its dedicated portal Access
  app/audience/group, and its separately reviewed public Bypass app/policy;
- reviewed commit SHA and current build-control evidence;
- D1 export paths and SHA-256 checksums.

`CLIENT_PORTAL_ENABLED` must be `false`; `CLIENT_PORTAL_ORIGIN` and
`PUBLIC_BASE_URL` must both be the client staging origin. `CLIENT_ACCESS_AUD`
must be the new portal app audience, never `POLICY_AUD`, `OPERATIONS_AUD`, or
`CF_ACCESS_AUD`.

Copy `docs/staging/release-evidence.json.example` to the ignored path
`.backups/staging-release-evidence.json`. Record only booleans, identifiers,
timestamps, secret names, hashes, and evidence references. Record SHA-256 for
all three ignored staging configs immediately before each mutation phase;
`staging:evidence:check` rejects any later config drift.

## Required staging secret names

Delivery:

- `DELIVERY_SESSION_SECRET`
- `DELIVERY_ACCESS_CODE_PEPPER`
- `AUDIT_IP_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Operations:

- `OPERATIONS_SESSION_SECRET`
- `DELIVERY_TOKEN_SECRET`
- `DELIVERY_ACCESS_CODE_PEPPER`
- `AUDIT_IP_SECRET`
- `PROJECT_ALPHA_API_KEY`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Ops Sync:

- `CF_ACCESS_GROUP_API_TOKEN`
- `PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY`

Provider, incoming-upload, previous-key, and Stream management secrets are not
required while their corresponding capabilities remain disabled. Never place
secret values in Git, Wrangler `vars`, shell arguments, or release evidence.

## Non-mutating gates

Run from repository root:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:check
npm.cmd run staging:check:test
Get-FileHash -Algorithm SHA256 apps/client/wrangler.staging.json
Get-FileHash -Algorithm SHA256 apps/operations/wrangler.staging.json
Get-FileHash -Algorithm SHA256 apps/ops-sync/wrangler.staging.json
node scripts/staging-evidence.mjs .backups/staging-release-evidence.json
npm.cmd run staging:release:prepare

& '.\apps\client\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/client/wrangler.staging.json --outdir C:\tmp\ltds-delivery-staging-dry-run
& '.\apps\operations\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/operations/wrangler.staging.json --outdir C:\tmp\ltds-ops-staging-dry-run
& '.\apps\ops-sync\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/ops-sync/wrangler.staging.json --outdir C:\tmp\ltds-ops-sync-staging-dry-run
```

The isolated incoming staging hostname is required for quarantine intake testing.
Keep direct browser uploads into client delivery storage disabled with
`DIRECT_DELIVERY_UPLOADS_ENABLED=false`.

The example evidence intentionally fails until the client Access/public-path
contract, migrations, end-to-end tests, and final default-off state are
recorded. Do not mark future or inferred results true.

## Read-only backup and migration preflight

After identity, exact config/resource inventory, and branch-control checks pass,
create fresh exports before requesting mutation approval. Bind each export to
its exact staging D1 name/ID, timestamp, byte count, and SHA-256 in evidence.
A very small export is not useful recovery evidence unless the database is
reviewed and explicitly confirmed intentionally empty:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 export client-data-staging --remote --config apps/client/wrangler.staging.json --output .backups/client-data-staging-pre-release.sql --skip-confirmation
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 export ltds-ops-staging --remote --config apps/operations/wrangler.staging.json --output .backups/ltds-ops-staging-pre-release.sql --skip-confirmation
Get-Item .backups/client-data-staging-pre-release.sql
Get-Item .backups/ltds-ops-staging-pre-release.sql
Get-FileHash -Algorithm SHA256 .backups/client-data-staging-pre-release.sql
Get-FileHash -Algorithm SHA256 .backups/ltds-ops-staging-pre-release.sql
```

Then complete the evidence file and run `staging:evidence:check`. Only after
all evidence gates and separate migration approval pass, rerun identity and
evidence checks immediately before applying migrations:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:evidence:check
```

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations list client-data-staging --remote --config apps/client/wrangler.staging.json
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 migrations list ltds-ops-staging --remote --config apps/operations/wrangler.staging.json
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations apply client-data-staging --remote --config apps/client/wrangler.staging.json
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 migrations apply ltds-ops-staging --remote --config apps/operations/wrangler.staging.json
```

Apply Delivery first because Operations binds the Delivery database. Record
every migration result. For this milestone, explicitly confirm Delivery
`0096_client_portal_foundation.sql` through
`0100_client_portal_release_hardening.sql` and Operations
`0014_staff_acl_controls.sql` through
`0015_staff_acl_explicit_controls.sql`. Migration `0100` removes
`share_version` from the delivery-grant parent key so existing share
rotation/revocation updates cannot be blocked by a portal grant; the grant
still records the approved version for authorization checks. Reject any
unexpected pending migration. Worker rollback does not undo either database.

## Separately approved version and deployment sequence

Do not use `wrangler secret put`: it deploys a new version immediately.
Prepare ignored per-app secret files and use `versions upload --secrets-file`
to create reviewable staging versions without routing traffic. Immediately
before this mutation phase, rerun identity and evidence checks:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:evidence:check
```

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' versions upload --strict --config apps/client/wrangler.staging.json --secrets-file '.backups\delivery-staging.secrets.json'
& '.\apps\operations\node_modules\.bin\wrangler.cmd' versions upload --strict --config apps/operations/wrangler.staging.json --secrets-file '.backups\operations-staging.secrets.json'
& '.\apps\ops-sync\node_modules\.bin\wrangler.cmd' versions upload --strict --config apps/ops-sync/wrangler.staging.json --secrets-file '.backups\ops-sync-staging.secrets.json'
```

Before upload, compare only the secret key names in each ignored file to the exact manifest. For an existing staging Worker, also record `wrangler secret list --config <explicit staging config>` and reject or explicitly approve every unexpected name. Record version IDs and inspect bindings before any deployment. Deploy only the
reviewed staging version through an explicitly approved version deployment.
Do not run package `deploy` scripts, which target the default production
configuration.

After deployment, verify Access rejection, host rejection, health, role and
object authorization, fault handling, recycle/restore, audit logs, queue/DLQ,
and rollback. Ops Sync stays undeployed and default-deny until Project Alpha
service auth, Access group authority, and Ed25519 verification are ready.

For the portal, first prove the false flag returns `404`. Temporary activation
requires its own approval and version; after the full client/team/request/share
matrix passes, deploy a reviewed false version again. Evidence passes only
after the false state is restored. The Project Alpha payment/billing contract
must be ready, but it never substitutes for LTDS authorization checks.
