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
- origin-restricted staging Mapbox public tokens for both Delivery and
  Operations;
- a non-production Operations triage recipient and exact allowed notification
  sender;

`CLIENT_PORTAL_ENABLED` and every feature listed in
`REQUIRED_DISABLED_FEATURE_FLAGS` must be explicitly `false`;
`CLIENT_PORTAL_ORIGIN` and
`PUBLIC_BASE_URL` must both be the client staging origin. `CLIENT_ACCESS_AUD`
must be the new portal app audience, never `POLICY_AUD`, `OPERATIONS_AUD`, or
`CF_ACCESS_AUD`.

The invitation-mail gate also requires an onboarded staging Email Service
domain, `CLIENT_PORTAL_INVITATION_EMAIL` restricted with
`allowed_sender_addresses`, and an exact matching
`CLIENT_PORTAL_INVITATION_FROM`. Keep the email feature flag false during
preflight; enable it only for the controlled acceptance test after the evidence
packet and Access enrollment gate are approved. No local or staging command may
use a remote email binding unintentionally.

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
- `PROJECT_ALPHA_CATALOG_HMAC_SECRET`
- `PROJECT_ALPHA_PORTAL_HMAC_SECRET`
- `PROJECT_ALPHA_PRICING_HINT_API_KEY`
- `PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET`
- `CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET`
- `CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID`
- `CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY`
- `CLIENT_DELEGATED_SHARE_SESSION_SECRET`

Operations:

- `OPERATIONS_SESSION_SECRET`
- `DELIVERY_TOKEN_SECRET`
- `DELIVERY_ACCESS_CODE_PEPPER`
- `AUDIT_IP_SECRET`
- `PROJECT_ALPHA_API_KEY`
- `PROJECT_ALPHA_DRAFT_QUOTE_API_KEY`
- `PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_DELIVERY_UPLOAD_ACCESS_KEY_ID`
- `R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET`
- `INCOMING_SESSION_SECRET`
- `INCOMING_ACCESS_CODE_PEPPER`
- `INCOMING_PICKUP_SECRET`
- `THUMBNAIL_INGEST_SECRET`

Ops Sync:

- `CF_ACCESS_GROUP_API_TOKEN`
- `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET`

The staging manifest currently requires the complete Operations secret set
even while incoming capability flags remain disabled. This keeps the checked
configuration, evidence packet, and version upload contract identical and
fail-closed. Never place secret values in Git, Wrangler `vars`, shell
arguments, or release evidence.

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

The isolated incoming staging hostname is required for quarantine intake
testing. Keep direct browser uploads into client delivery storage disabled with
`DIRECT_DELIVERY_UPLOADS_ENABLED=false` during baseline deployment. Enable it
only for the separately approved synthetic Operations acceptance run described
in the [thumbnail and upload runbook](../media-thumbnail-pipeline.md), then
return it to the intended reviewed state and record the deployed value. Client
Portal, public-share, and Incoming identities remain denied in either state.

The example evidence intentionally fails until the client Access/public-path
contract, migrations, end-to-end tests, final default-off state, and every
portal-v2 external dependency in `REQUIRED_EXTERNAL_GATES` are recorded. Do not
mark future or inferred results true.

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
`0112_public_share_location_privacy.sql`, then `0114_delivery_share_prefix_lookup.sql`
through `0131_video_thumbnail_recovery_backfill.sql` (`0113` is intentionally
reserved), and Operations
`0014_staff_acl_controls.sql` through
`0022_r2_operation_retries.sql`. Migration `0100` removes
`share_version` from the delivery-grant parent key so existing share
rotation/revocation updates cannot be blocked by a portal grant; the grant
still records the approved version for authorization checks. Reject any
unexpected pending migration. Migration `0105` must be present before the
Operations version that exposes direct authenticated folder grants or runs its
five-minute notification consumer; `0106`/`0107`/`0108` must be present before
thumbnail jobs or cleanup; `0109` must be present before photo location
extraction or map routes run; `0110` must be present before a `Jobs/` backfill
run; `0111` must precede prebuilt registration, Container fallback activation,
or exact-ETag derivative reconciliation. Migrations `0112` and `0114`-`0131`
must precede public location privacy, indexed share lookup, client notification,
request-v2, attachment, workspace hierarchy, membership, delegated-share,
catalog/hierarchy projection, and directory-recipient activation. `0017` must
precede the Operations thumbnail renderer APIs and be present before job-brief
routes; `0018`/`0019` must precede
browser-upload and conflict-resolution routes; `0020` must precede the internal
SOP library; `0021` must precede Project Alpha sync hardening; and `0022` must
precede bounded R2 retry state. Migration `0131` seeds a cutoff-pinned,
video-only recovery pass; confirm it reaches `completed` and that repaired rows
remain pending until the authenticated TrueNAS worker claims them. It must not
publish those rows to the Cloudflare thumbnail queue. Worker
rollback does not undo either database.

Before version upload, verify rather than infer the remaining operator-owned
media prerequisites: the staging thumbnail queue and DLQ exist, Operations has
the exact `THUMBNAIL_QUEUE` producer, main consumer and DLQ consumer; the
private `THUMBNAIL_RENDERER` Container binding resolves with one maximum
instance, internet disabled and no SSH/public route; and the 15-minute and
5-minute crons are both present. Confirm the
existing R2 object-create notification still feeds only the staging file-event
queue; do not add an overlapping notification rule. Confirm the path-specific
Cloudflare Access Service Auth policy and `THUMBNAIL_INGEST_SECRET` before a
TrueNAS registration smoke. The repository examples and passing preflight prove
configuration shape only, not remote resource or Container entitlement.

Staging navigation evidence must show that Delivery initially requests
`Jobs/Clients/`, an authorized global operator can use the `Jobs` breadcrumb to
request the true `Jobs/` root, and a scoped operator cannot activate that root.
Upload synthetic supported media in both `Jobs/Clients/` and another authorized
`Jobs/` folder and verify the same queue lifecycle. Inject one transient
processing failure and prove exactly one bounded second lifecycle; permanent
oversize and invalid/encrypted cases must remain icon-only. Supported PDFs must
render page one. Office, audio, and archive files remain icon-only. A video
queue signal must leave its D1 row pending with zero Cloudflare Container
source reads, then the authenticated TrueNAS `/claim` path must lease, render,
upload, and complete it. Prove that heartbeat/fail/complete echo the claim's
`leaseId`, and that an older attempt cannot mutate a reclaimed row. Prove the
15-minute raw server/rclone prebuilt
grace, the 30-second direct-upload grace, and private Container fallback
independently. Do not enable a delete-authoritative TrueNAS
source sync until browser/team prefixes are disjoint and excluded by path; R2
metadata tags are not a deletion boundary.

Record that end-to-end proof under the mandatory
`trueNasVideoThumbnailRenderer` external gate. The evidence must identify the
deployed TrueNAS renderer version or immutable image digest and show that it
treats `leaseId` as opaque. Repository tests cannot substitute for this check
because the TrueNAS client is maintained outside this repository.

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
service auth, Access group authority, and the exact timestamp/body HMAC contract
are verified. If Ed25519 is added later, prove its precedence and rotation path
separately before configuring a public key.

For the portal, first prove the false flag returns `404`. Temporary activation
requires its own approval and version; after the full client/team/request/share
matrix passes, deploy a reviewed false version again. Evidence passes only
after the false state is restored. The Project Alpha payment/billing contract
must be ready, but it never substitutes for LTDS authorization checks.
