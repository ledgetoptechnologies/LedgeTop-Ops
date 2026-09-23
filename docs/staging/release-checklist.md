# Staging release gate and command packet

This packet prepares commands; it does not authorize running them. Keep the
client portal, Dropbox, Google, permanent purge, and incoming uploads disabled.
The client-specific sequence is in
[client-portal-rollout.md](client-portal-rollout.md).

## September 17, 2026 staging evidence checkpoint

Operations PR82 (`ecf9d24`) is merged to `main` and adds the private,
default-off Project-v2 pending dispatcher. Its entrypoints remain unmounted;
the dispatcher is transport-capable through its injected sender, but no
deployed production caller can invoke it. It has no mounted public route and
does not currently make production calls or activate Project-v2 authority.
Migration `0122` exists in source; remote application and runtime activation
remain separate gates. The authoritative post-merge workflow
`35291426513` completed successfully at exact head
`ecf9d24ef839793dd32d98435b48686a865b2e14`; all 10 jobs passed.

Operations PR79 (`3f5ec3a`) and PR80 (`2befb68`) are merged to `main`; the
exact combined workflow `35281356118` passed all 10 jobs. PR79's Project v2
command producer remains dormant, unmounted, and non-networked. PR80 adds
conditional access-code handling and centered responsive Incoming upload
controls.

PA PR184 head is `e260abeb`, with generic existing-application key binding
after staging exposed a separate application-identity conflict. SQLite is
**15/64**, disposable MySQL **10/81**, PR smoke/CodeQL/Gitleaks are green, and
Docker publish `35283843624` plus Trivy are green. The exact `e260abe` staging
rebuild is healthy; unauthenticated capabilities are JSON 401 with `no-store`
and no cookie, and the web-log window has no errors or warnings.

At the September 17 checkpoint, the next gate was a temporary Project-only key
created or rebound to the shared Directory application identity
`150cb108-af37-4973-ab6e-f6d991a6e8c8`, followed by live Project acceptance,
then binding/refresh/lifecycle/public-link parity. PA PR184 remains unmerged
at head `e260abeb`; PA `main` is not merged.
Do not record secrets or client data or claim production activation.

## September 18, 2026 Project lifecycle checkpoint

Operations PR93 is merged to `main` at
`ccc32ed31a1781459ecdf8e3719d980eb05c5777`. Exact post-merge workflow
`35366079255` passed all ten jobs. PA PR184 is pinned to
`ff42c3432f39e50e92058b21d7e4942c26f5b355`; CI, CodeQL, and Gitleaks are
green, including the serialized per-key rate-limit admission and disposable
MySQL 8.4 concurrency regression. The exact candidate must be installed on PA
staging before the joined proof; green PR checks alone are not deployment
evidence.

Staging-only Docker workflow `35361793571` passed both Trivy scans and
published the candidate. The documented PA staging rebuild completed
successfully; the healthy web container reports `APP_VERSION=ff42c34`.

The original Project-only application key #6 is bound to the shared staging
application identity, and the base Project acceptance and browser/API conflict
proof have passed. Its one-time secret is unavailable to the current runner.
Replacement lifecycle key #7 was bound to the shared staging application, but
its one-time secret is no longer available. Replacement key #8 has exactly the
eight reviewed lifecycle-acceptance scopes, no legacy broad access, and a
retained one-time secret outside the repository. Key #8 is bound to the same
existing application, and its authenticated capability response advertised
exactly the eight reviewed routes. The checked-in archive/restore artifact
records a successful run on the installed
`ff42c3432f39e50e92058b21d7e4942c26f5b355` candidate. The guarded run used
the verified disposable fixture at revision `7`, advanced archive to `8` and
restore to `9`, proved exact replay and changed-body `409` behavior, and
observed public-link status `200 -> 404 -> 404`. The private URL remains
outside the repository. This exact-candidate lifecycle gate is passed.

After that exact-candidate staging proof, disable the temporary archive
and restore flags, remove those two temporary key scopes, prove a least-
privilege denial, and complete the joined Operations settlement/reconciliation
and rollback rehearsal. PA PR184 remains unmerged until those gates pass.

Operations PR95 is merged at
`a78bc056edcc3a7b559e724bb23b63cf4948dd66`; exact post-merge workflow
`35376769639` passed all ten jobs.

## September 19, 2026 Directory-v2 joined staging evidence

The separately bounded Directory-v2 window completed, without accepting the
Project-v2 route. PA created disposable public ID
`63382355879f38ef7d77e7e97424188e`; command
`4349b923-d993-4022-9dce-50ef62a85d35` proved exact replay and changed-body
`409`, advanced authorization generation `41 -> 42`, and produced acceptance
record `staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f`.
PA and Operations matched the exact configured source/application/history
identity, and Operations retained the durable acknowledgement, mapping, and
audit evidence. The applicable transport/receipt contract fixes are
`e38c61a`; the verified current Operations staging version is
`07a1d7d0-a20d-4122-befa-00ac2cdaae9a`.

The window was closed: no actor command, lease, or Directory write fence
remains; the Directory acceptance route was removed; the PA connection is
disabled; and the reviewed authority-revocation migration was applied. Its
sanitized verification found inactive authority versions, Project-grant
generation `2`, and the immutable revocation receipt. PA `main` merge,
Project-v2 acceptance, production readiness, and full regression remain
separate unproven gates.

## September 19, 2026 current joined-window gate recheck

The Ops staging Cloudflare Access policy **Ledge Top Staging Staff Access**
explicitly includes `beaukoltz@ledgetopdroneservices.com`. A live in-app
session loaded the authenticated administrator view for Beau Koltz. This
confirms the authenticated delivery path only; it is not Project
authority or joined acceptance.

The exact PA staging candidate remains
`ff42c3432f39e50e92058b21d7e4942c26f5b355`. Fresh nonmutating capability
probes with key **#8** returned HTTP `200`, `apiVersion: 2`,
`implementedEndpointCount: 23`, and `grantedCapabilityCount: 1`, proving that
PA is still Directory-only rather than in the required Project-only window.
No Project authority, Ops route, selected connection, or mutation was
activated. Project-v2 acceptance therefore remains open and must not be
recorded as passed.

The local Operations check and build pass. Focused diagnosis of
`authenticated-delivery-change-notifications` (`batches forty together`)
passes in about 100 seconds because it performs roughly 90 sequential
Miniflare/D1 operations on Windows; it is not a deadlock or functional
regression. The pure-function batch suite passed 11 tests and the access-code
suite passed 2 tests. The broad suite has no trustworthy complete total.
GitHub PR98 checks were rejected in about two seconds by the account
spending/build limit, not by code failures.

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

A live dashboard readback on 2026-09-16 confirmed those first two controls for
Delivery (`ledgetop-clients`), Operations (`ledgetop-ops`), and Ops Sync
(`ledgetop-ops-sync`). All three still use `*` as the build watch include path.

Project Alpha staging uses an existing DNS record attached to a locally
managed Cloudflare Tunnel. Before treating its public origin as ready, verify
the host-local ingress configuration contains
`pa-staging.ledgetoptechnologies.com` -> `http://localhost:1628` before its
final catch-all, then record an HTTPS capabilities response through the
dedicated Access service-auth policy. A successful LAN capabilities response
proves the PA application binding, but does not prove the public tunnel or
Access boundary. Do not move the DNS record to a different tunnel merely to
bypass the locally managed configuration gate.

Do not push a branch merely to test this setting. Historical preview uploads
for Operations and Ops Sync contained production bindings even though they did
not become active deployments.

## Required non-secret values

- approved Project Alpha staging HTTPS origin;
- staging Access group ID and exact group name;
- Ops Sync staging service-auth policy and Project Alpha service-token owner;
- Delivery, Operations, Ops Sync, and self-hosted Viewer staging DNS readiness;
- `client-staging.ledgetopdroneservices.com` and
  `portal-staging.ledgetoptechnologies.com`, their one shared dedicated portal
  Access app/audience/group, and the separately reviewed public Bypass app/policy;
- reviewed commit SHA and current build-control evidence;
- D1 export paths and SHA-256 checksums.
- either origin-restricted staging Mapbox public tokens for both Delivery and
  Operations, or explicit `MAPBOX_STAGING_ACCEPTANCE_DEFERRED="true"` with
  both rendered `MAPBOX_PUBLIC_TOKEN` values empty. Never reuse a production
  token;
- a non-production Operations triage recipient and exact allowed notification
  sender;
- each native test source's immutable source ID, connector revision, credential
  reference name, application key, allowed HTTPS origin, workspace/root/project
  public IDs, projected principal source version, and signed request/feedback
  feature version. Record credential fingerprints and secret names only, never
  `draftQuote.apiKey` or `draftQuote.hmacSecret` values;

`CLIENT_PORTAL_ENABLED` and every feature listed in
`REQUIRED_DISABLED_FEATURE_FLAGS` must be explicitly `false`;
`CLIENT_PORTAL_ORIGIN` and Operations `DELIVERY_BASE_URL` must be the client
staging origin. `PUBLIC_SHARE_ORIGIN` on both Workers and Client
`PUBLIC_BASE_URL` must be the anonymous delivery staging origin.
`CLIENT_PORTAL_ORIGINS` must contain exactly the two approved authenticated
staging origins.
`CLIENT_ACCESS_AUD`
must be the new portal app audience, never `POLICY_AUD`, `OPERATIONS_AUD`, or
`CF_ACCESS_AUD`.

### Project-v2 joined-acceptance window

Run the authenticated Operations-side command acceptance only with the
[joined live harness](ops-project-v2-joined-acceptance.md). It requires the
explicit staging mutation gate, refuses production origins, creates one fresh
prefixed disposable project, verifies exact replay and changed-body conflict,
and records bounded read-settlement/canonical-activation and public-link
status/hash evidence without recording the URL or session cookie.

The route also requires `ENVIRONMENT="staging"` in code and stays hidden in
production even if its mutable flag drifts.
`PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED` is required to be `false` in the
release-preparation configuration. A separately approved staging-only window
may set it to `true` only after Operations migrations `0119`–`0122` are applied
and verified, the disposable PA source/application entry is explicitly enabled,
and the same administrator has current global `integrations.manage` plus a
live native `project.shared.sync` grant. The separately reviewed Directory-v2
bootstrap window also requires that administrator's exact active global
`directory.profile.edit` grant from the same packet; keep
`PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ACCEPTANCE_ENABLED` false outside that
window. Invoke the joined Project route only through
`POST /api/admin/project-alpha/projects/v2/commands` with a command-matching
`Idempotency-Key`; there is no scheduled or public/client invocation path.

Create and revoke that native admission and both grants only with the reviewed
[staging native authority packet](native-authority-packet.md). Provision and
revoke must use their separate generated configs and the dedicated staging-only
migration ledger; raw D1 inserts/updates and a new issuer route are prohibited.
Generate and review revocation before enabling either acceptance window.
Disable both acceptance routes and the selected connection, drain pending/leased
Project and Directory actor commands, require no surviving directory write
fence for the actor, and apply the revoke packet immediately after the bounded
run.

Record exact replay, changed-body conflict, stale/revoked-authority rejection,
create/update/bind settlement, rollback, and before/after public-link bytes.
Then restore both the Operations activation flag and the selected connection's
`enabled` field to false. This staging window does not authorize production.

## Deferred Mapbox production acceptance

If staging uses the explicit Mapbox deferral, record
`infrastructure.mapbox.state="deferred"`, leave both staging token values
empty, and do not treat map-dependent staging workflows as tested. The
deferral is only a staging exception; this candidate is not production-ready
for map-dependent paths until the following production acceptance is recorded.
Use the existing reviewed production configuration for that controlled test;
never copy its token into staging or evidence.

1. An authenticated client can open a drone service request, load the map,
   search/select a location, draw or edit the requested area and points of
   interest, and see the expected acreage and review summary.
2. The client can save the request as a draft, reload it, edit the geometry,
   and submit it; malformed, self-intersecting, or oversized geometry is
   rejected server-side.
3. An Operations reviewer can open the submitted request map, edit it where
   authorized, and complete the request workflow without a blank-screen or
   browser-console failure.
4. An authorized client can open an image-location map in shared drone data;
   an unauthorized identity cannot obtain either the map token or locations.
5. Browser developer tools confirm requests use only the reviewed Mapbox
   origins and token; no production token is copied into staging evidence,
   configuration, a non-production hostname, or logs containing private
   coordinates or request geometry.
6. Repeat the origin and console checks from both the client and Operations
   production origins.

Keep the staging deferral recorded after production acceptance. Change it to
`"false"` only if separate origin-restricted staging tokens are later created;
then record `infrastructure.mapbox.state="verified"`,
`originRestrictionsVerified=true`, and the staging restriction evidence.

The receiver-only projection path is infrastructure, not an activation flag:
Client must set `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true`, keep
`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED=false`, and share the exact
`ledgetop_ops_staging` application key with Ops Sync. Ops Sync must bind
`CLIENT_PORTAL_PROJECTION_INGRESS` to the `ledgetop-clients-staging`
`OpsSyncPortalProjectionIngress` named entrypoint. Do not provision a second
Project Alpha catalog/portal Access audience, HMAC key ID, or portal HMAC
secret; the catalog path must use the same Ops Sync audience and application
key.

Deploy the Client staging Worker export before deploying the Operations
staging Worker that binds `OPS_INVENTORY_CATALOG_STAGING` to
`ledgetop-clients-staging`/`OpsInventoryCatalogStagingIngress` and
`OPS_INVENTORY_CATALOG_PROMOTION` to the route-less
`OpsInventoryCatalogPromotionCoordinator`. Keep both
`PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED=false` and
`PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED=false`; bindings alone
do not authorize a catalog run or promotion. A deliberate invocation must pin
the operator-selected registry ID, source ID, and expected Client checkpoint
sequence; it must never discover or advance that authority automatically.
Promotion still does not activate client access, public links, draft quotes,
or portal catalog reads. Use the same Client-before-Operations order for
production.

Client migration `0189_primary_staff_folder_bindings.sql` must be applied and
verified before deploying the Operations build that exposes primary Client
Workspace folder linking. Keep authenticated-grant mutations disabled until
the active-primary-Operations-binding-without-active-receipt query in
`docs/operations/primary-client-workspace-folder-bindings.md` returns zero.
Record the migration hash, the zero-row readback, one coherent legacy backfill
or an explicit staff relink, stale-context suspension, and both grant-versus-
revoke transaction order tests in the release evidence.

The Client staging Worker and the single staging Client Portal Access
application must include both reviewed portal hosts:
`client-staging.ledgetopdroneservices.com` and
`portal-staging.ledgetoptechnologies.com`. Read back one unchanged audience and
policy set across both hosts. Record separate evidence for sign-in, hard
refresh, and same-origin Access logout on each host; authenticated host
switching; session-expiry denial on both hosts; immediate membership/grant
revocation on both hosts; unauthorized identity denial on both hosts;
cross-tenant denial on both hosts; same-origin mutation; and mixed-origin
denial. Canonical public links must remain on the reviewed public host,
reachable without Access, and absent from the secondary portal namespace. A
result from one host cannot be copied or inferred for the other host. Reference
both the exact post-change application/audience/
destination/policy readback and the pre-change Access/custom-domain rollback
snapshot in the evidence packet; a bare boolean is not sufficient readback.

The attachment upload CORS artifact is
`docs/staging/request-attachments-r2-cors.json`. Preflight requires that exact
policy: only the two reviewed client staging origins, only `PUT`, only the `content-type`
request header, only `etag` exposed, and a 300-second preflight cache. After
separate R2 mutation approval, apply it only to `client-data-staging` with
`wrangler r2 bucket cors set client-data-staging --file docs/staging/request-attachments-r2-cors.json`
and verify it with `wrangler r2 bucket cors list client-data-staging`. The
browser evidence must include the exact allowed origin and an out-of-scope
origin denial. Do not apply the production artifact to staging.

The invitation-mail gate also requires an onboarded staging Email Service
domain, `CLIENT_PORTAL_INVITATION_EMAIL` restricted with
`allowed_sender_addresses`, and an exact matching
`CLIENT_PORTAL_INVITATION_FROM`. Keep the email feature flag false during
preflight; enable it only for the controlled acceptance test after the evidence
packet and Access enrollment gate are approved. No local or staging command may
use a remote email binding unintentionally.

`CLIENT_PORTAL_ACCESS_ENROLLMENT_READY` is a separate operator attestation and
must remain false until a dedicated, internal workspace reconciler has proven
dedicated client-group isolation, multi-workspace retention,
last-eligibility revocation, and zero staff-group mutation. The global flag is
not sufficient to release mail: before each outbox lease, migration `0133`
requires a live server-recorded receipt bound to that invitation, workspace,
normalized-email hash, current invitation-token hash, and monotonic enrollment
version. Migration `0135` persists the highest revoked version before or after
the positive receipt arrives; prove both orderings, concurrent delivery, and a
legitimate later-version re-enrollment. Revocation and lease/send race evidence
is mandatory. The
legacy `client_access_sync_outbox` is account-scoped and imperative, and its
processor is not deployed; it cannot safely represent workspace-v2 desired
membership. Manual pre-enrollment may test acceptance mechanics but does not
satisfy the autonomous-invitation release gate.

Copy `docs/staging/release-evidence.json.example` to the ignored path
`.backups/staging-release-evidence.json`. Record only booleans, identifiers,
timestamps, secret names, hashes, and evidence references. Record SHA-256 for
all three ignored staging configs immediately before each mutation phase;
`staging:evidence:check` rejects any later config drift.

After deployment and before enabling any capability window, run the guarded
GET-only collector from `docs/staging/README.md` with the dedicated staging
Access identity. Attach its sanitized report to the release ticket; it does not
replace the independently reviewed evidence packet or any manual/browser gate.

Before collecting deployment evidence, replace every `FINAL_*` value in
`scripts/staging-requirements.mjs` with the settled Ops, Viewer, and Project
Alpha commits, the immutable Viewer tag-plus-digest, and all Project Alpha
migration hashes. Set `RELEASE_CONTRACT_FINALIZED=true` only after independent
comparison with those repositories. The verifier intentionally fails while any
release-candidate placeholder remains.

The current candidate inventory extends through Client `0214` (including both
distinct `0199` filenames), Operations `0139`, and Project Alpha `0102`. The
reviewed Operations runtime boundary is commit
`5ca70d4f5ec834bfddf7bff68ffc1d89c6fd32a7`, which adds default-off,
fail-closed Cloudflare Access service-auth support to the PA API-v2 connection
secret. This following contract-only commit pins that exact executable SHA so
the release-packet HEAD is not self-referential. Project Alpha is pinned
independently at PR184 head `31deb85b87b95de27dc9e90a5591e036ae96709e`.
Keep `RELEASE_CONTRACT_FINALIZED=false` until independent cross-repository,
image, migration, and live staging evidence is complete. Any runtime change
after `5ca70d4` requires a newly reviewed non-circular boundary and coordinated
evidence refresh.

The live Project Alpha staging instance reports `v31deb85`. API key ID `1`
is bound to generic API-v2 application
`e4b3b484-ee7c-475f-ad40-46d7f928cff2`; an authenticated LAN capabilities
probe returns HTTP 200. That proves the binding and handshake only. Public
HTTPS remains blocked by the missing locally managed tunnel ingress, and the
current key advertises only `api.capabilities.read`; do not treat the binding
as directory, project, projection, or cutover readiness.

The Viewer evidence is separate from the three Wrangler deployments. Record its
exact image/commit, a SHA-256 of the non-secret `viewer.env` shape, secret names
only, mode `0600`, health/readiness, the exact matching
`X-LTDS-Viewer-Revision` and `X-LTDS-Viewer-Schema-Version` headers from both
public probes, exact `EXPECTED_HOST`, forwarded Host,
narrow LAN bind/firewall boundary, direct-IP/wrong-Host denial, successful
canonical Viewer Host forwarding through the proxy, rootless/capability
state, persistent volume, read-only imports, range/no-store behavior, and a
tested immutable-image rollback. Keep `PROCESSING_PLATFORM_ENABLED`, the
processing Compose profile, WebODM discovery, `PROXY_SHARED_SECRET`, and
`TRUSTED_PROXY_ADDRESSES` off in the baseline. The optional proxy secret is not
part of the required manifest for this release.

Project Alpha evidence must identify its exact commit and immutable web/cron
image digests, the complete migration `0066` through `0102` ledger and source hashes, all eleven
installation settings and profile capabilities/delivery still off, the inert
one-minute outbound sender, non-secret delivery key IDs, encrypted-secret and
redacted-evidence proof, retry/dead-letter/revocation behavior, fresh backup,
and a non-destructive restore/fix-forward drill.

Project Alpha is the rollback-order exception: disable projection authority
first so scoped revocation tombstones are queued, but keep the affected
profile's delivery switch, the sender, and `portal_outbound_delivery_enabled`
on until every tombstone is acknowledged. Only then turn outbound delivery
off. The rollback evidence must prove this drain order; disabling the sender
first can strand stale downstream authority.

## Required staging secret names

The canonical non-secret list is
`docs/staging/staging-secret-manifest.json`. Wrangler configs must not contain a
top-level `secrets` pseudo-field; use the sidecar to review ignored secret-file
keys and remote secret-name listings.

Delivery:

- `DELIVERY_SESSION_SECRET`
- `DELIVERY_ACCESS_CODE_PEPPER`
- `AUDIT_IP_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `PROJECT_ALPHA_CATALOG_HMAC_SECRET`
- `PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET` (rotation-overlap staging proof)
- `PROJECT_ALPHA_PRICING_HINT_API_KEY`
- `PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET`
- `CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET`
- `CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID`
- `CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY`
- `CLIENT_DELEGATED_SHARE_SESSION_SECRET`
- `CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET`
- `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` (portal-purpose values only)

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
- `VIEWER_SERVICE_HMAC_SECRET`
- `VIEWER_EVENT_HMAC_SECRET`
- `PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS`
- `PROJECT_ALPHA_CONNECTOR_SOURCES` (credential-free exact-source manifest)

Ops Sync:

- `CF_ACCESS_GROUP_API_TOKEN`
- `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET`
- `PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS`
- `PROJECT_ALPHA_CONNECTOR_SOURCES` (must exactly match Operations)

Self-hosted Viewer (record names in `viewer.configuration.secretNames`, not in
the Wrangler manifest):

- `SESSION_SECRET`
- `SERVICE_AUTH_SECRET`
- `VIEWER_EVENT_SECRET`
- `PROVIDER_CREDENTIALS_KEY`

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
npm.cmd run staging:release:prepare

& '.\apps\client\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/client/wrangler.staging.json --outdir C:\tmp\ledgetop-clients-staging-dry-run
& '.\apps\operations\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/operations/wrangler.staging.json --outdir C:\tmp\ledgetop-ops-staging-dry-run
& '.\apps\ops-sync\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/ops-sync/wrangler.staging.json --outdir C:\tmp\ledgetop-ops-sync-staging-dry-run
```

The isolated incoming staging hostname is required for quarantine intake
testing. Keep direct browser uploads into client delivery storage disabled with
`DIRECT_DELIVERY_UPLOADS_ENABLED=false` during baseline deployment. Enable it
only for the separately approved synthetic Operations acceptance run described
in the [thumbnail and upload runbook](../media-thumbnail-pipeline.md), then
return it to the intended reviewed state and record the deployed value. Client
Portal, public-share, and Incoming identities remain denied in either state.
Keep `INCOMING_RCLONE_PROMOTION_ENABLED=false`; its binding is inert until the
separate TrueNAS PULL/MOVE and ready-prefix acceptance packet is approved.

The example evidence intentionally fails until the client Access/public-path
contract, migrations, end-to-end tests, final default-off state, and every
Ops-Sync-to-Client private projection dependency in `REQUIRED_EXTERNAL_GATES`
is recorded. Do not mark future or inferred results true.

If both staging D1 databases are confirmed empty, stop before any ordinary
migration command and follow the fresh empty-D1 procedure in `README.md`.
Generate and check the ignored bootstrap configs from the approved synthetic
owner input, then use only those configs for the first full apply. The ordinary
configs would replay the canonical named-human `0002` rows. A populated or
partially migrated database must never use the bootstrap configs. Attach both
generated manifests and complete `migrations.freshBootstrap`; the required
proof includes 133/139 ledger rows, both Client `0199` filenames exactly once,
final `0214`/`0139`, canonical-human absence, the one synthetic owner and its
role, the retained Operations ACL catalog, no pending reapply, and an empty
foreign-key check.

It also requires the pushed source ref, exact deployed version/config hashes,
an ordered remote migration-ledger readback, a pre-migration open-fence and
writer/scheduler-quiescence check, compatible-writer ordering evidence,
second-empty migration lists, foreign-key and reapply checks, live resource and
entitlement inventory, rollback targets/drill, referenced production-unchanged
proof, and the complete disabled-flag set for each deployed Worker. A generic
`ready` statement cannot satisfy an external gate; every named proof in
`REQUIRED_EXTERNAL_GATE_PROOFS` must be current and referenced.

For this checklist, `idempotentReapplyPassed` is specifically a second
`wrangler d1 migrations apply` against the same `d1_migrations` ledger that
returns `No migrations to apply`. Do not execute migration SQL files directly
for this proof: ledger-once historical migrations intentionally contain SQLite
DDL without a safe raw-SQL replay form.

`activationPlan.requestedFlags` is empty for this release preparation. Any
later staging activation is validated against
`FEATURE_FLAG_ACTIVATION_POLICIES`; flags marked prohibited require their own
release packet, and dependent gates must remain current. For the controlled run
that creates a not-yet-available proof, set `phase=evidence-collection`, name
the one `collectingGate`, request exactly one staging flag, retain current
`stagingGates` prerequisite proofs, record the rollback reference, and explicitly
attest `productionFlagsRemainOff=true`. Restore the staging flag to false before
marking the collected gate ready. A later `post-evidence-validation` activation
requires every final gate. Production activation is never authorized by this
packet.

## Read-only backup and migration preflight

After identity, exact config/resource inventory, and branch-control checks pass,
create fresh exports before requesting mutation approval. Bind each export to
its exact staging D1 name/ID, timestamp, byte count, and SHA-256 in evidence.
A very small or intentionally empty export is not release recovery evidence.
Each export must be populated, and the packet must reference a successful,
non-destructive D1 time-travel recovery rehearsal for that exact staging
database before any migration approval:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 export client-data-staging --remote --config apps/client/wrangler.staging.json --output .backups/client-data-staging-pre-release.sql --skip-confirmation
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 export ltds-ops-staging --remote --config apps/operations/wrangler.staging.json --output .backups/ltds-ops-staging-pre-release.sql --skip-confirmation
Get-Item .backups/client-data-staging-pre-release.sql
Get-Item .backups/ltds-ops-staging-pre-release.sql
Get-FileHash -Algorithm SHA256 .backups/client-data-staging-pre-release.sql
Get-FileHash -Algorithm SHA256 .backups/ltds-ops-staging-pre-release.sql
```

Update the evidence file as operator-owned results become available, but do not
claim post-deployment fields before a version exists. Only after local
preparation and separate migration approval pass, rerun identity and config
checks immediately before applying migrations:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:check
```

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations list client-data-staging --remote --config apps/client/wrangler.staging.json
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 migrations list ltds-ops-staging --remote --config apps/operations/wrangler.staging.json
```

These are list-only commands. Do **not** run a generic all-pending Delivery
apply from the combined candidate when `0172` or any of `0179`-`0186` is
pending. Both ranges contain deployment barriers described below. A passing
preflight proves configuration shape; it does not make a combined migration
apply safe.

If the Delivery list includes
`0172_project_access_authority_history.sql`, stop before the generic Delivery
`migrations apply` action. Migration 0172 starts append-only coverage at
apply time and is the explicit exception to this packet's normal
migration-first order. Confirm every predecessor is already applied; otherwise
resolve those predecessors in a separately reviewed release.

For Operations, preserve the full ordered `0054` through `0139` suffix in the
remote Wrangler ledger. Attach the list output that proves every filename is in
the exact checked-in order, with no duplicate, renamed, skipped, or unexpected
row. A local migration-chain run, a directory listing, or a successful raw SQL
parse is not remote-ledger evidence.

Before the first Operations migration action, inspect and record every open
directory/outbox/onboarding/native-integration/reconciliation fence. Stop unless
all are terminal or deliberately cancelled, then close mutation ingress and
drain HTTP requests, queue consumers, leases, schedulers, and reconciliation
batches. The evidence must prove this quiescent state and name the compatible
Operations writer version already handling all traffic. Do not apply `0054`-
`0139` while an old writer, an in-flight fence, or a scheduled/retry worker can
commit a pre-migration assumption. Keep the compatible writer in place through
the final ledger readback; use a compatible fix forward, never a pre-suffix
writer rollback.

Writer-first alone is not a sufficient barrier. Freeze request/invitation
create, approve/publish, accept and revoke; authenticated-grant create/publish,
revoke and restore; and every expiry reconciliation or notification path that
invokes reconciliation. Drain in-flight HTTP requests, leases, queue items,
scheduled jobs and reconciliation batches so no operation that observed
history as absent can commit after activation. Both new versions must have
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false`; this default-false flag is
the post-cutover barrier and cannot replace the external freeze needed for old
versions. Close external mutation ingress/schedulers, upload both compatible
writers, shift **100% of traffic** to the flag-false versions, then drain every
old-version and in-flight request/job. Reads remain live throughout.
Before 0172, verify new explicit-term writes fail `503`, existing
reads/enforcement remain available, and the Client Hub reports project-access
history as `not_collected`. Only after both writers and the drain are proven may
the operator take the final shared-Delivery backup and apply 0172. An old or
already-running pre-history writer must never commit after
`collection_started_at` exists.

Migration `0179_service_assignment_policy_proof_v2.sql` is a second mandatory
split-release barrier. Generate the ignored expand config from the already
validated Client staging config with
`npm run staging:client:expand-0179:generate`, then verify it with
`npm run staging:client:expand-0179:check`. The generator preserves the whole
staging config and exact D1 ID/bindings, and adds the literal Wrangler pattern
`migrations/0179_service_assignment_policy_proof_v2.sql`; it refuses a stale
or broadened output and never copies SQL. Record that derived config as the
immutable expand input, then retain the ordinary staging config as the final
input containing `0180`-`0186`. Never copy files out of the combined tree ad
hoc, edit the migration ledger, or execute these files as raw SQL.

1. Keep `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED` and
   `CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED` false.
2. With explicit `--config apps/client/wrangler.staging.expand-0179.json`, list
   pending migrations and stop unless the only listed migration is `0179`.
   Apply it with the same config; verify the ledger, foreign keys, and additive
   v2 proof columns. A later list with this config must report no migrations.
3. Upload the compatible Client writer, record its immutable version ID, shift
   100% of Client traffic to it, and drain every old Client request/job that can
   write service-request drafts or submissions. Confirm new writes populate
   only the strict v2 proof and include `reviewId`/`reviewRevision`.
4. Only after the drain is evidenced may the final input apply
   `0180_service_assignment_policy_v1_contract.sql`,
   `0181_service_assignment_request_policy_reviews.sql`, and notification
   migrations `0182`/`0183` in order. With native capabilities still unavailable,
   apply `0184_native_client_feedback.sql`,
   `0185_native_service_request_ownership.sql`, and
   `0186_delivery_notification_authority_provenance.sql`, followed by
   `0187_authenticated_content_audit.sql`,
   `0188_native_feedback_completion_notices.sql`, and
   `0189_primary_staff_folder_bindings.sql`, followed by Client `0190` through
   `0195`, in order. Verify the 0187 collection
   state is still unset and its retention-delete gate is closed. Before the
   Operations upload, prove the 0189 unreceipted-active-binding query returns
   zero. Then apply Operations through
   `0052_project_operational_reassignment_recovery.sql`, then
   `0053_project_internal_notes.sql`, and deploy the paired final
   applications with every user-facing portal capability still default-off,
   receiver sync true, direct portal HTTP false, and the private Ops Sync to
   Client binding verified.
5. Record `serviceAssignmentV2ExpandApplied`, the compatible writer version,
   `serviceAssignmentOldWritersDrained`,
   `serviceAssignmentContractMigrationsApplied`, and the barrier evidence
   reference in the release evidence. The second Wrangler list/reapply must
   return `No migrations to apply` only after the final phase.

If no independently reviewed expand-only migration input exists, stop. The
presence of all eight files in one checkout is not permission to apply them in
one command.

Apply Delivery first because Operations binds the Delivery database. Record
every migration result. For this milestone, explicitly confirm Delivery
`0096_client_portal_foundation.sql` through
`0112_public_share_location_privacy.sql`, then `0114_delivery_share_prefix_lookup.sql`
through `0171_secondary_workspace_membership_management.sql` (`0113` is
intentionally reserved), apply `0172_project_access_authority_history.sql`
only at its writer-first barrier, then `0173`-`0179` with `0179` as the final
expand step. Apply `0180`-`0183` only after the compatible-writer drain above,
then apply `0184`-`0195` migration-first before the paired final applications.
Confirm Operations
`0014_staff_acl_controls.sql` through
`0052_project_operational_reassignment_recovery.sql` and
`0053_project_internal_notes.sql`, then Operations `0054` through
`0139_native_directory_staging_empty_enrollment_fixture_guard.sql` in
that exact ledger order. Migration `0100` removes
`share_version` from the delivery-grant parent key so existing share
rotation/revocation updates cannot be blocked by a portal grant; the grant
still records the approved version for authorization checks. Reject any
unexpected pending migration. Migration `0105` must be present before the
Operations version that exposes direct authenticated folder grants or runs its
five-minute notification consumer; `0106`/`0107`/`0108` must be present before
thumbnail jobs or cleanup; `0109` must be present before photo location
extraction or map routes run; `0110` must be present before a `Jobs/` backfill
run; `0111` must precede prebuilt registration, Container fallback activation,
or exact-ETag derivative reconciliation. Migrations `0112` and `0114`-`0150`
must precede public location privacy, indexed share lookup, client notification,
request-v2, attachment, workspace hierarchy, membership, delegated-share,
catalog/hierarchy projection, and directory-recipient activation.
`0132` must be applied before invitation acceptance is enabled: verify a fresh
apply and idempotent reapply, `PRAGMA foreign_key_check`, exact-project guest
file/request access, sibling-project denial, immediate suspension, and two
independent workspace bridges for one verified issuer/subject. Staff manager
recovery must also prove transfer-before-offboarding and reject local removal
of a Project Alpha-managed manager.

`0017` must
precede the Operations thumbnail renderer APIs and be present before job-brief
routes; `0018`/`0019` must precede
browser-upload and conflict-resolution routes; `0020` must precede the internal
SOP library; `0021` must precede Project Alpha sync hardening; `0022` must
precede bounded R2 retry state; and `0023` must precede project/task SOP
revision pinning. Migration `0131` seeds a cutoff-pinned,
video-only recovery pass; confirm it reaches `completed` and that repaired rows
remain pending until the authenticated TrueNAS worker claims them. It must not
publish those rows to the Cloudflare thumbnail queue. Worker
rollback does not undo either database.

The native request and feedback release contract is
[native portal requests and feedback](../operations/native-portal-requests-feedback.md).
At final upload, `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED` must remain false and
every exact Project Alpha source must continue to advertise native request and
feedback features as unavailable. Do not enable either source feature merely
because primary request-v2 or primary feedback is available. Before any later
activation, prove exact source/workspace/identity/project or target authority,
colliding-ID isolation, current principal source revision, revocation races,
storage-only account exclusion, and exact outbound destination.

For rollback, first disable `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED`, withdraw the
two native source features, confirm signed capability readback, and drain request
mutations, attachment finalization, quote commands, feedback transitions, and
completion-notification leases. Retain migrations `0184`-`0195` and Operations
`0050`-`0052`.
After the first native storage binding or registered draft-quote fingerprint is
created, do not roll back to code that lacks storage-account exclusion or
connector-fingerprint enforcement; use the last compatible version or fix
forward.

Before version upload, verify rather than infer the remaining operator-owned
media prerequisites: the staging thumbnail queue and DLQ exist, Operations has
the exact `THUMBNAIL_QUEUE` producer, main consumer and DLQ consumer; the
private `THUMBNAIL_RENDERER` Container binding resolves with one maximum
`standard-1` instance, internet disabled and no SSH/public route; and all five Operations
crons are present: consolidated 15-minute work, five-minute request processing,
Client Hub indexing, hourly source recovery, and the offset native-delivery
notification scheduler. Confirm the
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
render page one. Office, audio, and archive files remain icon-only. The
digest-pinned TrueNAS `queue-renderer` must use `includeKind=all` to lease,
render, upload, and complete one synthetic JPEG, PNG, PDF, and video. Prove a
live TrueNAS image/PDF/video lease causes zero Cloudflare thumbnail-body or
Container source reads; bounded best-effort image-location/EXIF reads remain an
independent metadata path. Prove signed heartbeats keep the TrueNAS backlog
primary while every slot is busy, then stop TrueNAS and prove stale-presence
reconciliation lets Cloudflare handle only an unleased image/PDF. Prove that
heartbeat/fail/complete echo the claim's
`leaseId`, and that an older attempt cannot mutate a reclaimed row. Prove the
15-minute raw server/rclone prebuilt
grace, the 30-second direct-upload grace, and private Container fallback
independently. Do not enable a delete-authoritative TrueNAS
source sync until browser/team prefixes are disjoint and excluded by path; R2
metadata tags are not a deletion boundary.

Record that end-to-end proof under the mandatory
`trueNasThumbnailQueueRenderer` external gate. The evidence must identify the
deployed `queue-worker` image digest, startup capability record, configured
`LTDSTHUMB_WORKER_CONCURRENCY`, RAM-backed `/scratch` and `/cache`, and show that
it treats `leaseId` as opaque. Repository tests cannot substitute for this live
TrueNAS-to-Cloudflare check.

After applying 0172, record both authority-history tables, exactly one immutable
state row, canonical UTC `collection_started_at`, and an empty
`PRAGMA foreign_key_check`. Prove exact invitation and authenticated-grant
lifecycle events, exact replay and conflicting replay rejection, bounded expiry
reconciliation, sibling workspace/source/project exclusion, and the Client Hub
**available since** label. Record at least one canonical test lifecycle event
after the collection start. After schema verification, enable
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED` in both Workers together while
general mutation ingress remains frozen; run the isolated test, then reopen
ingress/schedulers only after the event and coverage evidence pass. A partial schema is a
hard failure. Retain the new writers, immutable start row and
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false` during rollback; fix forward
instead of restoring an older writer or guessing a backfill.

After applying 0187, verify all three authenticated-content tables, both
timeline indexes, and all four immutability/delete-guard triggers exist. The
singleton history row must have `collection_started_at=NULL`, and the retention
control row must have `delete_enabled=0,delete_before=NULL`. Upload and deploy
the compatible Client and Operations versions with
`CLIENT_PORTAL_CONTENT_AUDIT_ENABLED=false`; the Client version must already
carry the independently provisioned `CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET`.
Only a separately approved activation version may turn the flag on and establish
the immutable collection boundary. After that boundary exists, rollback keeps
0187 and compatible code in place: returning the flag to false deliberately
fails body-bearing authenticated preview/download requests rather than creating
an unaudited gap.

## Separately approved version and deployment sequence

Do not use `wrangler secret put`: it deploys a new version immediately.
Prepare ignored per-app secret files and use `versions upload --secrets-file`
to create reviewable staging versions without routing traffic. Immediately
before this mutation phase, rerun identity and local preparation checks. Full
evidence verification is post-deployment so it can bind real version IDs:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:release:prepare
```

`versions upload` cannot create a Worker that does not exist. If an exact
staging Worker name is absent, stop and obtain separate approval for its one-time
baseline creation. Only after migrations, Access, bindings, secrets, remote
resource inventory, the complete default-false flag set, and the checks above
are verified, run the explicit-config dry-run and then one explicit-config
baseline deployment:

```powershell
& '.\apps\operations\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/operations/wrangler.staging.json
& '.\apps\operations\node_modules\.bin\wrangler.cmd' deploy --strict --config apps/operations/wrangler.staging.json --secrets-file '.backups\operations-staging.secrets.json'
```

This exception immediately creates and deploys routes and triggers; it is not a
reviewable upload and must never use a default or production config. Record the
created baseline version ID, verify the disabled endpoint returns `404`, and use
the normal `versions upload` plus explicitly approved version deployment flow
for every subsequent version. Do not repeat the creation exception once the
Worker exists.

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

After all controlled tests, deploy the reviewed all-false version again, record
its immutable version IDs and binding/config hashes, complete every structured
evidence field, and run:

```powershell
npm.cmd run staging:release:verify
```

That command reruns local preparation and validates the complete current
post-deployment packet. It performs no remote action.

### September 21 — typed Project conflict checkpoint and cleanup

- The corrected Ops PR98 harness and evidence checkpoint at
  `0ada2ab2213e4d25c5a804b0ba4a1226521fa601` passed all ten jobs in exact
  workflow `35564563048`. PA PR184 head is
  `3b43e1275e3b248979876ace56ca38e6e383f52c` with green required checks.
  A supported `cloudflared` human Access login succeeded for staging.
- The first joined run was stopped before mutation because the harness omitted
  the canonical PA staging host. The harness now accepts
  `STAGING_PROJECT_ALPHA_ORIGIN`; its unit suite is 10/10. Fresh command
  `3b785ca6-96a8-4103-b2e5-4a60ce5cae41` made one Project attempt and ended in
  terminal typed `relationship_proof_conflict` HTTP `409`, request
  `fcd6627d-405d-477b-8486-d51140a2d6bf`. No success receipt or activation was
  produced. PA's authoritative Project generation was `5`.
- The independently observed stale binding is external ID
  `pa-acceptance-p184fix-20260917a:33b8e6f6-8beb-4190-a24f-abdd7b401112`,
  revision `2` versus live revision `10`, reporting generation `5`. It proves
  the generation without guessing but is separate from the relationship-proof
  conflict. Do not retry the terminal command.
- Public-link preservation is proven. The first harness failure stopped before
  its public probe/command, and the second run performed one pre-command probe
  before attempting Project creation. A separate post-attempt probe returned
  `200 text/html`, `3266` bytes, and the unchanged SHA-256
  `5632e883d6fe3ca72c68e900e8e6b76561c07d454605e728c4a765d07a383464`.
- Cleanup is complete: the connection secret is empty; default-off version
  `de550f0c-f5ec-452c-a4db-3c61bc7cffc2` is deployed; the revoke migration was
  applied; admission, Project grant, and Project generation are inactive at
  version `10`; Directory grant is inactive; Project/Directory pending and
  leased rows, actor fences, and live proofs are all zero; and one immutable
  revoke receipt exists.
- The remaining-gate wording above is superseded by the passing checkpoint below.

### September 21 — passing joined Project-v2 staging acceptance

- The exact PA Directory proof is source
  `d2f7acb8-375d-4da7-8d37-3f2455a3972b`, application
  `150cb108-af37-4973-ab6e-f6d991a6e8c8`, epoch
  `8c194c00-c7dd-4c6c-82ce-d391ef3fa998`, organization external ID
  `staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f`, public
  ID `63382355879f38ef7d77e7e97424188e`, revision `1`, projection SHA-256
  `7a45cf37ea099868f82f459ed2c8cab9dcabf6348ca35f6439734cd08b9f9bef`, and
  Directory generation `42`. Project generation was authoritatively re-read as
  `5` from typed `binding_stale` request
  `e9dd5105-dd0e-401f-a0dc-265798c7d13b`, pinned revision `2`, live revision
  `10`.
- Passing command `9b60e1de-3926-48fc-a049-ca8af9ec36db` used external ID
  `ops-joined-acceptance-20260921d:project:9b60e1de-3926-48fc-a049-ca8af9ec36db`.
  Settlement `bacd6769-34ed-4d2f-b00a-131f34c1ecb3` activated
  `3d862f3f-3bb3-4ef8-a854-6522bf5e0cf0`, version `1`, `replay=false`; the
  exact replay returned the same IDs/version with `replay=true`; the changed
  body conflicted at `plan` for `command_id`.
- The existing PA staging public link stayed `200 text/html`, `3266` bytes,
  and SHA-256
  `5632e883d6fe3ca72c68e900e8e6b76561c07d454605e728c4a765d07a383464` before
  and after. The temporary browser bridge was removed before the default-off
  deploy. Default-off version is `ed0bc4ba-5e98-448a-8819-319424aa04db`, the
  connection secret is empty, activation is false, revoke migration `9001` is
  applied, and no migrations are pending.
- Final D1 readback: admission inactive v12, profile v1, Project grant inactive
  v12/generation 12, Directory grant inactive, zero pending/leased Project or
  Directory rows, zero Directory fences, zero live proofs, and one revoke
  receipt. Joined staging acceptance passes and is merge-ready subject to exact
  CI and normal owner approval; production cutover remains unauthorized.

### September 21 — production pre-cutover checkpoint

- Both production Project Alpha instances render `vc3f2ad5`. The Operations
  production Worker is active at 100% on version
  `89a5d07d-ff58-4793-a374-51162dc00177`.
- Project Alpha's `main` Docker Compose keeps every API-v2 flag explicitly
  `false`. The owner did not change the deployed Compose, so generic API-v2
  routes remain off. Existing custom integrations remain enabled pending their
  reviewed replacement.
- Fresh pre-cutover encrypted full backups completed successfully on both PA
  instances: LTT at `2026-09-21 13:42:43` and LTDS at
  `2026-09-21 13:46:09` (16 retained backups on each instance). Both pages
  show cron backup success, no backup failure, and writable directories.
  External directory policy is unconfigured/local changes are available on
  both instances.
- The web reports Ready, but cron preflight is not ready. Terminal
  `external-operations-delivery-unavailable` rows remain: LTT has 8 total
  records across 3 workspaces (portal plus service assignments), and LTDS has
  49 portal records across 25 workspaces. Recreate cron from the current
  release while preserving the shared config, then verify prerequisites before
  retrying.
- With explicit owner approval, one new dedicated API-v2 key was created in
  each instance without changing any existing token: LTT key ID `3` and LTDS
  key ID `4`. Each key is active, has exactly the 34 approved Directory and
  Project API-v2 scopes (including `api.capabilities.read`), and does not have
  legacy `full` access. The one-time values were retained only in a local
  Windows DPAPI-protected secret file; no plaintext value entered source
  control, command output, or this record.
- Both keys remain unbound and all production API-v2 flags remain `false`.
  The next gate is instance-local migration validation/application through
  `0102`, application binding for the instance's own key ID, bounded Directory
  and Project backfills, current attestations, and web/worker/cron recreation
  with the existing shared config and encryption key preserved. No Operations
  connection secret or authority policy changes before those gates pass.
