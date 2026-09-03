# Cloudflare production setup

`DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED` is checked in as `false` for the
Operations Worker. Keep it false until client D1 migration
`0126_delivery_share_recipient_snapshots.sql` is applied in staging and the
signed Project Alpha portal-v2 projection plus exact Operations folder
bindings pass scope/deny tests. Enabling it requires no new browser secret or
CORS rule; Operations reads its existing `DELIVERY_DB` binding server-side.
Rollback is the flag back to `false`, which restores the legacy form without
deleting recipient snapshots.

## 1. Worker Builds

Configure the Git repository `ledgetoptechnologies/LTDS-Ops` three times:

| Setting | Operations | Delivery | Ops Sync |
|---|---|---|---|
| Production branch | `main` | `main` | `main` |
| Root directory | `/apps/operations` | `/apps/client` | `/apps/ops-sync` |
| Build command | `npm run build` | `npm run build` | `npm run build` |
| Deploy command | `npm run deploy` | `npm run deploy` | `npm run deploy` |
| Version command | `npx wrangler versions upload` | `npx wrangler versions upload` | `npx wrangler versions upload` |

### Source-layout transition guard

The Delivery Worker Builds root must change from `/apps/delivery` to
`/apps/client` before the first build from a commit containing the source move.
That separately approved dashboard change is the only Cloudflare configuration
required by the source-layout refactor. It must not rename `ltds-delivery` or
change its routes, custom domains, Access applications, variables, secrets, D1,
R2, Queue, Workflow, Images, Stream, or rate-limit bindings.

The source-layout move is complete. Current domain changes remain a separate,
reversible configuration step: keep the legacy client hostname attached until
fragment-bearing links and host-local public-share sessions have drained.

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

The client portal uses `portal.ledgetopdroneservices.com` as its canonical
origin and `portal.ledgetoptechnologies.com` as an alternate presentation
origin. `client.ledgetopdroneservices.com` is legacy compatibility only. The
three hosts use the same Worker, D1 database, verified principal, memberships,
and grants. Cloudflare's per-application destination limit requires the
canonical Drone Services portal paths to use a second, narrowly scoped Access
application. `CLIENT_ACCESS_AUDS` lists both reviewed client audiences while
`CLIENT_ACCESS_AUD` retains the original audience for compatibility. Never
infer ownership or authorization from the request hostname.

Keep `CLIENT_PORTAL_ORIGIN`, `PUBLIC_SHARE_ORIGIN`, and `PUBLIC_BASE_URL` set to
`https://portal.ledgetopdroneservices.com`. Set `CLIENT_PORTAL_ORIGINS` to the
two `portal.*` origins and `LEGACY_CLIENT_ORIGINS` to the old `client.*` origin.
Fresh fragment-bearing legacy links hand off in the browser before the secret
is consumed. Fragmentless legacy sessions stay on the legacy host because the
`__Host-ltds_delivery` cookie cannot be transferred across hosts.

Public share paths remain outside Access and continue to use their own
revocable-link controls. The service-request API uses the existing
`PUBLIC_BULK_RATE_LIMITER` with a scope-separated, server-derived account key.
Keep the client Access audience, group, and provisioning automation separate
from Operations staff ACL provisioning.

For the dual-domain rollout, retain the original Access application and
audience for the legacy and Technologies portal paths. Use a second application
only for `/portal*` and `/api/client*` on the canonical Drone Services portal,
copying the same current eligibility rule. Public Bypass applications cover
only the explicit `/s/*`, `/client-share/*`, `/api/public/shares/*`,
`/api/public/cloud-transfers/*`, and asset paths. `/api/internal/*` stays on the
legacy compatibility host during the Project Alpha transition and remains
independently signed. Existing IDs, credentials, cookies, and revocation state
are not rewritten. Cloudflare documents path matching and specificity in
[Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

The staging Access application must rehearse the same two-presentation-domain
topology with `client-staging.ledgetopdroneservices.com` and
`portal-staging.ledgetoptechnologies.com` under one staging audience. Record the
Access application and policy readback, both Custom Domain states, DNS/TLS,
hard-refresh and domain-switch behavior, and an exact rollback snapshot before
production mutation. Root requests on either portal origin redirect to that
same origin's `/portal`; public-root requests still redirect to the canonical
portal origin.

Configure `PUBLIC_SHARE_ORIGIN` (and the Client Worker's compatibility
`PUBLIC_BASE_URL`) as the exact public delivery origin. Configure
`CLIENT_PORTAL_ORIGIN` on Client and `DELIVERY_BASE_URL` on Operations as the
exact primary authenticated portal origin. When the primary portal and public
delivery share an origin, namespace routing keeps their authorization products
separate. Additional authenticated portal presentation origins never inherit
the public-share namespace. The Worker admits public paths only on the exact
public origin and explicitly configured legacy compatibility origins, and
rejects them on a secondary portal host. It also rejects portal paths on an
unconfigured host, unknown Worker-first paths, and malformed origins. The
`/portal*` Worker-first prefix covers both normal portal routes and recovery
from a literal Access wildcard, so neither can fall through to the SPA shell.
Session cookies remain host-local (`__Host-` or path-scoped
`__Secure-` cookies with no `Domain` attribute), so no cookie is shared merely
because both hosts use the same Worker or Access audience.

Apply Access protection before attaching each Worker custom domain. Preserve an
exported rollback snapshot and read back Access destinations, policies, R2
CORS, custom-domain state, and both old-link paths after deployment.

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
separately named non-production Worker: never invoke a production package
deploy command for a non-production branch, and never attach its version to a
production route or custom domain.

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

1. Attach `ops.ledgetopdroneservices.com` and `ops.ledgetoptechnologies.com` to Worker `ltds-ops`.
2. Create a Cloudflare Access self-hosted application named **LTDS Operations**.
3. Set both exact Operations hosts as destinations on the same production Access application and retain its audience and policies.
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

## 4. Private thumbnail renderer and Stream

Thumbnail generation does not use Cloudflare Images or Media Transformations.
Do not add either binding or run an Images-dependent backfill. The Operations
Worker owns the existing thumbnail Queue/DLQ and a private RPC-only
`ThumbnailRendererContainer`; the Client Worker only serves an already-ready
private R2 derivative after reauthorization. The Container has no public route,
internet access, or source credentials. It is a delayed still/PDF fallback,
sharded across at most four `standard-1` instances with queue concurrency four;
it renders still images with libvips and the first PDF page with Poppler.
Office/document media remain type-specific icons. It never renders video.

Operations records a durable 15-minute renderer-eligibility boundary for raw
server/rclone R2 events; direct browser/staff enqueue records 30 seconds. The
authenticated TrueNAS queue renderer is primary for image, PDF, and video jobs.
Fresh worker polls and signed active-job heartbeats keep unfailed still/PDF work
owned by TrueNAS beyond the initial boundary. Only when that health becomes
stale, or after a retryable TrueNAS still/PDF failure, does the bounded scheduler
publish the exact pending version to the Cloudflare Container fallback. Prebuilt
artifacts live only under
`_ltds/derivatives/thumbnails/v1/prebuilt/`; Cloudflare fallback objects live
only under the sibling `managed/` namespace. The optional pre-generation broker
can still register exact still/PDF artifacts, but it is not the queue renderer.
Configure these roles exactly as documented in the
[thumbnail runbook](media-thumbnail-pipeline.md).
Current rclone multipart objects do not expose the full-object SHA-256 proof
required for prebuilt registration, so they fail closed to the private Container
fallback. Do not enable an undocumented S3 checksum-mode HEAD header, accept a
composite checksum, or weaken source ETag checks to make prebuilt registration
succeed.
The prebuilt ingest prefix on Operations requires the Cloudflare Access
service-token headers `CF-Access-Client-Id` and `CF-Access-Client-Secret` plus
`THUMBNAIL_INGEST_SECRET` at the Worker. The unified queue renderer uses the
separate Incoming machine endpoint and requires that bearer before any D1 or R2
operation; it must answer directly rather than redirect to an Access login.

The TrueNAS queue worker uses the sibling
`/api/internal/thumbnail-renderer/v1` API on the exact Incoming hostname to
claim pending image, PDF, and video rows with `includeKind=all`, render a bounded
WebP, upload it, and complete the exact version. Images and PDFs use an exact
authenticated full read into per-slot tmpfs with 512 MiB and 256 MiB source
caps. Videos use a loopback range proxy with eight-MiB upstream windows and a
512 MiB aggregate read budget; they are never copied to a full-size scratch
file. A short-lived presigned R2 URL is preferred for video, but the returned
authenticated source URL is the required fallback. Its heartbeat, failure, and
completion calls must
echo the opaque `leaseId` returned by `/claim`; stale attempt tokens are
rejected. It starts the renderer heartbeat immediately after a claim and sends
it every 60 seconds throughout source reads, media decoding, upload, and
completion. A video claim starts with a 15-minute D1 lease; image and PDF claims
start with five minutes. An early
heartbeat never shortens that horizon; once fewer than five minutes remain,
each heartbeat extends it to five minutes from the heartbeat. Those leases are distinct from the longer-lived
signed lease token. See the [authoritative queue-worker protocol](media-thumbnail-pipeline.md#truenas-queue-worker-protocol)
for the payloads and large-video behavior. Use the repository compose defaults:
four isolated worker slots, a five-GiB memory limit, and a four-GiB tmpfs scratch
mount. The ten-GiB video source limit is safe because video stays range-streamed.

Create path-specific self-hosted Access coverage for the ingest prefix on
`ops.ledgetopdroneservices.com`. Keep the renderer prefix on Incoming restricted
to its machine route, bearer check, and edge rate limits. The Access application
needs only this path:

- `/api/internal/thumbnail-ingest/v1*`

Use a Service Auth policy that includes only one dedicated TrueNAS prebuilt
service token; do not broaden coverage to all Operations routes. Enter that
token's client ID/secret only in the prebuilt client. Set a separate random
Operations runtime secret named `THUMBNAIL_INGEST_SECRET` and enter the same
bearer only in the prebuilt and unified queue-renderer clients. Keep
`THUMBNAIL_INGEST_EXPECTED_HOST=ops.ledgetopdroneservices.com` and
`THUMBNAIL_RENDERER_EXPECTED_HOST=incoming.ledgetopdroneservices.com`.

The shared Worker also serves the public Incoming hostname. Explicitly block or
Access-protect the ingest prefix there, but allow the exact renderer prefix to
reach its Worker bearer check without an interactive redirect. Do not reuse
staff Access, Worker/Wrangler, rclone, Project Alpha, or Incoming credentials.
Give only the prebuilt broker a separate bucket-scoped R2 Object Read credential
for HEAD requests; rclone alone owns prebuilt writes. The unified queue worker
receives no R2 S3 credential.

Stream remains available for private playback of existing Stream assets, but
the thumbnail path never sends a source to Stream. The TrueNAS renderer extracts
a frame through bounded range reads for the private R2 thumbnail derivative.

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

For the default-off client request attachment flow, create a separate R2 API
credential with Object Read & Write access scoped only to the private
`client-data` bucket. The Worker uses it only to sign short-lived multipart PUT
tickets for opaque objects under
`_ltds/quarantine/request-attachments/`; do not reuse or broaden the preceding
download-only credential:

```powershell
Set-Location apps/client
npx.cmd wrangler secret put CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID
npx.cmd wrangler secret put CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY
```

Keep `CLIENT_REQUEST_ATTACHMENTS_ENABLED=false` unless these dedicated secrets,
the exact-origin attachment CORS policy, quarantine lifecycle, scanner, and
end-to-end staging validation are all present. Missing dedicated credentials
must return unavailable even when the generic download credential is set.

Create a separate least-privilege R2 credential for the Operations Worker's
public Incoming multipart flow. Scope Object Read & Write to `ltds-incoming`;
do not reuse the TrueNAS, Delivery, or authenticated staff-upload credential:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
```

These credentials sign only short-lived, object-specific Incoming quarantine
parts.

Create another dedicated R2 credential scoped Object Read & Write only to the
private `client-data` bucket for authenticated Operations staff-upload part
tickets. Store it under distinct secret names so compromising or rotating one
upload surface cannot authorize the other:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put R2_DELIVERY_UPLOAD_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY
```

The Worker hardcodes the configured account, `client-data` bucket, opaque
staging key, upload ID, part number, exact length, and content type in each
five-minute SigV4 ticket. It never returns the credential or a bucket-wide
capability.

Set the account S3 endpoint and both bucket names as non-secret Operations
variables. Apply separate exact-origin CORS rules to each private bucket. The
Incoming bucket permits only the production Incoming origin. The `client-data`
bucket permits only the production Operations origin, `PUT`, and
`content-type`, and exposes `ETag`; the browser transport supplies the signed
`Content-Length` automatically. Never permit `*`, never enable `r2.dev`, and do
not combine production and staging origins or buckets.

Apply the checked-in production policy from the Operations directory:

```powershell
npx.cmd wrangler r2 bucket cors set ltds-incoming --file r2-incoming-cors.json
npx.cmd wrangler r2 bucket cors set client-data --file r2-cors.json
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

The optional private draft-quote caller uses two different secrets and remains
disabled until Project Alpha implements and passes the contract in
`docs/project-alpha.md`:

```powershell
npx.cmd wrangler secret put PROJECT_ALPHA_DRAFT_QUOTE_API_KEY --name ltds-ops
npx.cmd wrangler secret put PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET --name ltds-ops
```

The first key must have only `portal.quote-draft.create`; the HMAC secret must
be at least 32 random bytes. Keep `PROJECT_ALPHA_DRAFT_QUOTES_ENABLED=false`
through migration and staging verification. Setting a secret with Wrangler can
create a Worker version, so follow the reviewed release procedure rather than
running these commands during a read-only validation.

Create a separate self-hosted Access application named **LTDS Ops Sync** for `ops-sync.ledgetopdroneservices.com/*`. Add a Service Auth policy whose include rule is the Project Alpha service token. Copy that application's AUD into `CF_ACCESS_AUD` on `ltds-ops-sync`. Its service-token client ID and secret belong only in Project Alpha.

Set `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID`, the exact deployment-specific `CF_ACCESS_GROUP_NAME`, and a deployment-specific `APPLICATION_KEY` (for example, `field_operations`) on the provisioning Worker. Configure the same application key on the Operations snapshot importer and in Project Alpha. The group name lets reconciliation safely recover when a configured group identifier has been replaced. Bind `OPS_DB` to the deployment's Operations D1 database and add these Worker secrets:

The checked-in LTDS production configuration uses `ltds_ops`; this is not a Project Alpha convention or a default for other deployments.

```powershell
npx.cmd wrangler secret put CF_ACCESS_GROUP_API_TOKEN --name ltds-ops-sync
npx.cmd wrangler secret put PROJECT_ALPHA_WEBHOOK_HMAC_SECRET --name ltds-ops-sync
```

The current Project Alpha contract is HMAC-only, so production explicitly sets `PROJECT_ALPHA_ALLOW_LEGACY_HMAC=true`. LTDS verifies `sha256=<hex>` over the exact `${timestamp}.${rawBody}` bytes. Ed25519 remains preferred if its header and public key are introduced later; an invalid Ed25519 signature never falls back to HMAC. Use `PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY` only during a coordinated future rotation. The Access Groups API token belongs only on the sync Worker, never in Project Alpha.

The sanitized Service Library projection uses another dedicated Access service
application targeting only
`client.ledgetopdroneservices.com/api/internal/project-alpha/catalog-v2`. This
legacy machine endpoint remains active during the portal hostname transition;
do not infer the browser portal origin from it.
Copy its issuer and audience to
`PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN` and
`PROJECT_ALPHA_CATALOG_ACCESS_AUD` on `ltds-clients`. Configure the same bounded
application key in Project Alpha and `PROJECT_ALPHA_CATALOG_APPLICATION_KEY`,
then add the dedicated receiver secret:

```powershell
npx.cmd wrangler secret put PROJECT_ALPHA_CATALOG_HMAC_SECRET --name ltds-clients
npx.cmd wrangler secret put PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET --name ltds-clients
```

Set `PROJECT_ALPHA_CATALOG_HMAC_KEY_ID` to the sender's current key ID. During
rotation only, set a distinct `PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID` and
the previous secret above; delete both previous values after old pending rows
drain. An unknown key ID is rejected even if its signature matches another key.

Do not reuse an Access audience, service token, or HMAC secret from Ops Sync or
the draft-quote caller. Keep `PROJECT_ALPHA_CATALOG_SYNC_ENABLED=false` until
migration 0122 is applied in isolated staging and snapshot, replay, sequence
gap, stale-draft, leakage, and Access-denial tests pass. Project Alpha keeps the
service-token client ID/secret; LTDS receives only the Access assertion and
signed request. See `docs/project-alpha.md` for the exact producer envelope.

The portal hierarchy projection uses a path-specific Access service
application targeting only
`portal.ledgetopdroneservices.com/api/internal/project-alpha/*`. Give that
application a Service Auth policy containing the existing Project Alpha
service token used by Ops Sync. This reuses the deployed machine identity; it
does not reuse the Ops Sync Access application or audience, and it does not
broaden human portal access. Configure the portal application's exact
issuer/audience as
`PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN` and
`PROJECT_ALPHA_PORTAL_ACCESS_AUD`, and agree on the bounded
`PROJECT_ALPHA_PORTAL_APPLICATION_KEY`. Add a unique receiver secret:

```powershell
npx.cmd wrangler secret put PROJECT_ALPHA_PORTAL_HMAC_SECRET --name ltds-clients
```

Set `PROJECT_ALPHA_PORTAL_HMAC_KEY_ID` to the sender's current key ID. Use the
distinct `PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID`/previous-secret pair only
for a bounded rotation overlap; do not create the previous secret during first
activation. Remove both previous values only after pending delivery drains.

Project Alpha keeps this behind its single **External operations** connection.
For the LTDS deployment, set its server-only
`EXTERNAL_OPS_CLIENT_PORTAL_BASE_URL` to
`https://portal.ledgetopdroneservices.com`, and configure the same key ID and
HMAC secret through `PORTAL_INTEGRATION_HMAC_SECRETS_JSON` (or the supported
`EXTERNAL_OPS_CLIENT_PORTAL_SIGNING_KEY_ID` and
`EXTERNAL_OPS_CLIENT_PORTAL_SIGNING_SECRET` compatibility variables). The
administrator does not create a second visible integration profile.

The legacy `client.ledgetopdroneservices.com` hostname remains a compatibility
redirect for public share and portal links. Do not use that redirect as the
machine projection route: the canonical service application and audience are
bound to the `portal.*` endpoint above. The Client Worker rejects every
`/api/internal/*` request on a configured legacy origin even if an edge policy
is accidentally broadened; legacy public-share and same-origin session routes
remain admitted.

The reviewed receiver-only production configuration sets
`PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true` and
`CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true` only after additive migrations
0125 and 0129 and the snapshot/activation/replay/gap/tombstone/Access-denial
tests pass. From `apps/client`, `npm run deploy` is the only supported production
release command. Its repository-owned wrapper runs the remote-secret preflight
first and refuses the deploy if `PROJECT_ALPHA_PORTAL_HMAC_SECRET` is not
installed by name. Do not replace the Worker Builds deploy command with a
direct Wrangler invocation, which would bypass this gate. Because Cloudflare
does not expose secret values, an enabled Worker with a malformed value returns
HTTP 503 `portal-receiver-misconfigured`
and logs only a redacted reason. Opening the inbox still does not enable client
hierarchy reads: keep
`CLIENT_PORTAL_HIERARCHY_V2_ENABLED=false` through shadow parity and the
separate authorization cutover. Never reuse the catalog Access application,
application key, audience, or HMAC secret. The existing Project Alpha Ops Sync
service-token identity may be included in the portal-specific Service Auth
policy, but the Access application and audience remain distinct. Project Alpha
keeps the token credentials; LTDS stores only the receiver configuration.

Follow the exact preflight, ingest-only activation, read cutover, and drain-first
rollback in
[`docs/operations/project-alpha-portal-activation.md`](operations/project-alpha-portal-activation.md).

Keep `CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED=false` until the invitation
email outbox has a transactional sender/scrubber, Access enrollment is proven,
and Operations has tested manager-recovery controls. This gate is deliberately
independent from read-only hierarchy activation.

Invitation mail uses Cloudflare Email Service's native Worker binding, not an
API token. Onboard the staging sender domain in Email Service, then configure a
binding restricted to the one reviewed sender:

```jsonc
"send_email": [{
  "name": "CLIENT_PORTAL_INVITATION_EMAIL",
  "allowed_sender_addresses": ["portal@staging.example.com"]
}]
```

Set `CLIENT_PORTAL_INVITATION_FROM` to that exact address and optionally set
`CLIENT_PORTAL_INVITATION_FROM_NAME`. Keep
`CLIENT_PORTAL_INVITATION_EMAIL_ENABLED=false` and
`CLIENT_PORTAL_ACCESS_ENROLLMENT_READY=false` until a controlled staging
invite proves delivery, Access login with the invited email, immediate URL
fragment removal, acceptance, replay denial for another identity, revocation,
lease recovery, transient retry, permanent failure, and token scrubbing. Do
not use `remote: true` during ordinary local development because it sends real
mail. The production config intentionally omits the binding until this gate is
approved; a missing binding always disables the processor.

The readiness flag is not a manual override. It may be true only after a
dedicated internal workspace desired-state reconciler proves enrollment before
mail, preserves enrollment while any workspace remains eligible, removes it
after the last eligibility ends, and never mutates the staff Access group. The
legacy account-scoped `client_access_sync_outbox` and staff Ops Sync processor
do not meet that contract. Until the dedicated reconciler exists, keep the flag
false; a manually enrolled staging tester validates acceptance mechanics only.

The readiness flag alone cannot release an invitation. Migration `0133`
requires the internal reconciler to write a live receipt for the exact
invitation, workspace, normalized-email hash, current invitation-token hash,
and enrollment version before the outbox row can be leased. The receipt must be
revoked when eligibility or the invitation ends, and the staging packet must
prove the revoke-versus-send race. No public or portal route writes receipts;
the provider-side reconciler remains an external release prerequisite.
Migration `0135` adds the required monotonic revocation watermark: a revoke
that arrives before its enrollment receipt must still block that version and
every older version. Staging evidence must include reordered and concurrent
record/revoke cases plus a successful later-version re-enrollment.

The Project Alpha pricing preview is a separate outbound Client Worker
integration. Set `PROJECT_ALPHA_PRICING_HINT_URL` to the exact HTTPS endpoint,
`PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN` to that endpoint's origin,
`PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY` to the agreed deployment ID, and
`PROJECT_ALPHA_PRICING_HINT_CURRENCIES` to the accepted comma-separated ISO
currency codes (normally `USD`). Provision two dedicated secrets:

```powershell
npx.cmd wrangler secret put PROJECT_ALPHA_PRICING_HINT_API_KEY --name ltds-clients
npx.cmd wrangler secret put PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET --name ltds-clients
```

The API key must have only `portal.pricing.preview`; the HMAC secret must be at
least 32 random bytes and neither credential may be reused by catalog sync,
Ops Sync, or draft creation. Keep
`PROJECT_ALPHA_PRICING_HINTS_ENABLED=false` until the PA endpoint passes exact
body signature/timestamp/scope, canonical coverage, response schema, timeout,
currency, expiry, and no-price-degradation contract tests in isolated staging.

## 6. Staging before rollout

Create separate staging Workers for all three services, D1 databases, R2 buckets, Workflows, queue, secrets, hostnames, and Access applications. Never bind staging to production D1/R2. The client portal uses a distinct staging hostname, app/audience/group, and public Bypass policy while remaining default-off. Test Beau, Kollins, an Operator account, provisioned and unprovisioned client identities, cross-account denial, a public share with and without a password, an inbound multipart upload, and successful/failed ZIP jobs before production builds from `main`.

## 7. Incoming requests

Create the private `ltds-incoming` bucket. Route `incoming.ledgetopdroneservices.com` to `ltds-ops`, but keep human Cloudflare Access limited to the two exact `ops.*` hosts. Create a Turnstile widget restricted to the Incoming hostname, set `TURNSTILE_SITE_KEY`, and provision on Operations:

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

Authenticated delivery upload authorization remains on `ltds-ops`; part bytes
go directly from the authorized browser to the private R2 S3 endpoint. A
separate public upload Worker, public bucket, or public hostname is neither
required nor permitted. Keep
`DIRECT_DELIVERY_UPLOADS_ENABLED=false` while applying Operations migration
`0018_browser_upload_intents.sql` followed by Operations migrations through
`0022_r2_operation_retries.sql` and validating the split Operations-control/R2-
data path. The
final reviewed production version may set it to `true` only after migration,
queue/binding verification, and synthetic authorization/lifecycle acceptance;
rollback first returns it to `false` without removing cleanup-capable code. The
feature requires the existing Operations Access application and audience,
`OPS_DB`, private `DATA_BUCKET`, `DELIVERY_DB`, `THUMBNAIL_QUEUE`, both
five-minute and 15-minute Cron Triggers, the two dedicated delivery signing
secrets above, and the reviewed `client-data` CORS rule. It requires no public
bucket domain, route, hostname, queue, or additional Worker.

The active access model is deliberately narrow: an Operations staff principal
must pass the expected-host, Access JWT/session, origin/CSRF, administrator, and
scoped `delivery.files.upload` checks for the selected folder and every resolved
file. Client Portal identities, public-share sessions, and Incoming contributor
sessions have no authority on these routes. See the [thumbnail and upload
runbook](media-thumbnail-pipeline.md#authenticated-operations-browser-uploads)
for limits, collision resolution, lifecycle, acceptance, and rollback.

## 7b. Dropbox import (Operations Worker)

To enable staff Dropbox import, provision these Operations Worker secrets and variables:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put DROPBOX_CLIENT_SECRET
npx.cmd wrangler secret put DROPBOX_IMPORT_TOKEN_SECRET
```

Set `DROPBOX_CLIENT_ID` and `DROPBOX_IMPORT_ENABLED` in `apps/operations/wrangler.jsonc`. Register the callback `https://ops.ledgetopdroneservices.com/api/dropbox-import/oauth/callback` in the Dropbox API application. Apply migration `0013_dropbox_import.sql` to the `ltds-ops` D1 database. The `ltds-dropbox-import` Workflow binding is created on deploy.

## 8. Private 3D Viewer integration

The Client Worker reaches the Viewer only through the private Operations
`ViewerSessionIssuer` service binding. Do not add the Viewer service credential
to Client variables, browser assets, or build variables. Provision the matching
32-byte-or-longer HMAC secret interactively on Operations:

```powershell
Set-Location apps/operations
npx.cmd wrangler secret put VIEWER_SERVICE_HMAC_SECRET --name ltds-ops
npx.cmd wrangler secret put VIEWER_EVENT_HMAC_SECRET --name ltds-ops
```

Set `VIEWER_BASE_URL` to the bare HTTPS Viewer origin and
`VIEWER_SERVICE_KEY_ID` to the matching Viewer key ID. That origin must return
the Viewer service response directly rather than redirecting to another host or
login page; Operations deliberately rejects redirects to protect its HMAC
request headers. The reviewed pre-production staff deployment uses
`VIEWER_INTEGRATION_ENABLED=true` and `VIEWER_PROCESSING_ENABLED=true`; new
environments and staging templates still begin with both false. Keep
`VIEWER_PUBLIC_SHARES_ENABLED=false` and
`CLIENT_VIEWER_SESSION_ISSUER_ENABLED=false`, `CLIENT_VIEWER_SHARES_ENABLED=false`. In Client, bind
`VIEWER_SESSION_ISSUER` to Operations entrypoint `ViewerSessionIssuer` and keep
`CLIENT_VIEWER_ENABLED=false` and `CLIENT_VIEWER_SHARES_ENABLED=false`. Client
model-share creation additionally requires an explicit PA-projected
`viewer.share.create` allow with normal deny precedence; it is never implied by
manager role or `delegated_share.create`. Apply Client migrations
`0138_viewer_model_associations.sql`, `0141_viewer_client_preferences.sql`, and
`0142_client_viewer_shares.sql` through
`0143_viewer_session_revocation_outbox.sql`, plus Operations migrations
`0026_viewer_permissions.sql` through `0029_viewer_machine_rate_limits.sql`,
deploy both Workers, and verify both shared HMAC/route fixtures, reverse callback
key overlap and durable notification outbox, direct browser upload/CORS/CSP,
storage recovery/preflight, provider-outage viewing independence, rate limits,
and resumable upload recovery before enabling processing. Separately verify the
existing internal-session HMAC fixture, model-version pinning, authorization
denial, renewal, and mobile embed
in staging before enabling Operations first, public demo shares only after the
Viewer public-route policy is verified, its client issuer second, and the Client
UI last. Roll back by disabling the Client UI, issuer, and public-share gates;
no model asset is stored or proxied by LTDS.

Viewer-to-Operations automation uses the already-public exact origin
`https://incoming.ledgetopdroneservices.com`, not the Access-protected staff
origin. Only `POST /api/viewer/events` and
`POST /api/viewer/source-authorizations/introspect` are dispatched to the HMAC
machine handlers on that host; those paths return 404 on the staff host and all
other Incoming paths retain the existing Incoming policy. Do not add an Access
Bypass to the staff hostname. Invalid HMAC requests fail before JSON parsing or
D1 authorization work. Successful client-source introspection is cached and
coalesced by Viewer for at most five seconds (negative results for at most one
second), which defines the client-share revocation SLA without serializing
nested tile/range loads.

The scheduled Worker removes replay-safe machine rate windows after ten minutes
and redacts client share revocation response payloads after 90 days while
retaining the compact identity/key/share conflict tombstone. Active source
authorization rows and revoked/pending compact tombstones are retained: they
contain no password, bearer token, or share URL, and preserve the unique
identity/idempotency boundary so cleanup cannot mint a duplicate share.

## 9. Migrations and Workflow rollout

Export both production D1 databases before migration. Apply Delivery migrations
to `client-data` first because the new Operations Worker depends on Delivery
tables from migrations `0105` through `0109`; then apply Operations migrations to `ltds-ops`:

```powershell
Set-Location apps/client
npm.cmd run db:migrate:remote
Set-Location ../operations
npm.cmd run db:migrate:remote
```

Confirm Delivery migrations through `0151_thumbnail_render_not_before.sql`
(`0113` is the reserved production-ledger gap), and Operations migrations
through `0031_project_alpha_delivery_intent_rate_limits.sql`, appear in the
remote migration lists before deploying dependent Workers. Before the
Operations deployment, separately verify the thumbnail queue and DLQ exist;
the producer/main-consumer/DLQ consumer bindings resolve to those exact queues;
the private `THUMBNAIL_RENDERER` Container binding resolves with four maximum
instance, internet disabled and no SSH/public route; the existing R2
object-create notification still feeds `ltds-file-events`; and both the
15-minute and 5-minute crons are present. Apply Delivery `0151` before
uploading the dependent Operations version. The existing private `ltds-ops`
Worker owns the thumbnail consumer; no separate or public `ltds-thumbnails`
Worker is needed. Repository configuration does not prove remote resources or
Container entitlement exist.

The authenticated photo-location map reuses the private thumbnail queue and
adds no public R2 route or Cloudflare binding. Apply Delivery migration `0112`
before Workers that expose the Operations share-map opt-in. Keep
`MAPBOX_PUBLIC_TOKEN` restricted to the exact delivery/client origins. Public
share maps are default-off per share; enabling them discloses validated photo
coordinates to the client and sends the authorized viewport to Mapbox. Its minimal, version-bound
metadata lifecycle is documented in [Delivery image-location maps](delivery-image-location-maps.md).

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

Bulk ZIPs have no descendant file-count cutoff or total-delivery size cutoff.
The service prefers one ZIP. When a selection exceeds the safe 100 GiB
per-archive source boundary, or one Workflow cannot safely prepare it, the
sorted immutable snapshot is deterministically divided into independently
resumable ZIP parts. Small source files
are grouped into bounded 8 MiB/64-object CRC work units, and only the
`ltds-bulk-download` Workflow is configured for 25,000 steps. A 10,626-file,
34.3 GiB WebODM delivery remains one archive under that policy. Each prepared
R2 object is retained for 24 hours and each download route serves a stable
ETag, HEAD, and byte-range responses so browser download managers can resume
individual parts. The client asks the browser to start every part and always
keeps explicit part links visible because browsers may require the user to
allow multiple automatic downloads. A source object larger than the safe
per-archive boundary remains available as an individual resumable download;
it is not copied into an unsafe ZIP.
Do not enable these production limits on a Free-plan account; reduce the
application limits or upgrade first.

## 10. Email alerts

Onboard the sending domain in Cloudflare Email Service, add an `EMAIL` send-email binding to `ltds-ops`, and set non-empty `ALERT_FROM` and `ALERT_TO`. Until all three are present, alerts deliberately remain disabled. Send a staging reconciliation alert and verify delivery before enabling production automation.

## 11. Current provisioned resources

- Ops D1: `ltds-ops` / `6ebf7514-d306-4615-ae56-ad869c874dbd`
- Delivery D1: `client-data` / `7f40a7b7-c3ec-470e-a626-e798867f71f8`
- R2: `client-data`
- Incoming R2: `ltds-incoming` (private; production-origin CORS and quarantine lifecycle configured)
- Queue: `ltds-file-events`
- Thumbnail Queue/DLQ: `ltds-thumbnail-jobs`, `ltds-thumbnail-jobs-dlq`
- R2 notifications: object-create and object-delete to `ltds-file-events`
- Workflows: `ltds-bulk-download`, `ltds-cloud-transfer` (delivery), `ltds-r2-crud`, `ltds-incoming-upload-lifecycle`, `ltds-dropbox-import` (operations)

Do not infer migration or secret readiness from this file; verify the remote resources during each rollout.
