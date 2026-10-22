# LTDS 3D Viewer

Client-facing photogrammetry viewer and optional self-hosted processing
platform. The Three.js app provides Earth-style navigation, verified streamed
LOD with zero-error full-detail leaves, camera-position browsing, measurements,
Potree EPT point clouds, and streamed GeoTIFF layers. It can display legacy
WebODM media in place or manage immutable uploaded/imported datasets and send
them to NodeODM/ClusterODM for native EPT, 3D Tiles, and GLB production.

The Viewer source now lives in the Operations repository under `apps/viewer`. Existing installations keep the same API, worker, storage and configuration; see the [image-only migration guide](docs/OPERATIONS_MONOREPO_MIGRATION.md).

## Architecture

The viewer stability release `ab6bcc7` has passed automated release checks and
received qualitative user acceptance after deployment. See the
[stability release and acceptance record](docs/STABILITY_MEMORY_STORAGE_CANDIDATE.md)
for the known-good baseline, QA evidence and remaining memory/session/storage
measurements. This is not a general security or production-readiness certification.

- **Frontend** (`index.html`, `main.js`, `earth-controls.js`,
  `public/pointcloud.html`) — the three.js/Potree viewer. Loads no
  project-specific data at build time; everything comes from `GET /api/models`
  at runtime.
- **Backend** (`server/`) — a Node/Express API plus a durable worker that:
  - Optionally authenticates to WebODM's REST API and reconciles its catalog
    through mounted task-folder or exported ZIP migration. The processing
    platform do not require WebODM credentials. **It never queries WebODM's
    Postgres database directly.**
  - Verifies which output files actually exist on the read-only WebODM media
    mount and registers canonical models, versions, assets, imports, shares,
    and browser sessions in `data/viewer.sqlite`. Legacy JSON is migrated once
    and retained only for old admin/share route compatibility.
  - Manages immutable dataset manifests, durable upload/import operations,
    processing attempts, native derivatives, review/publish state, lifecycle
    journals, callbacks, shares, and scoped browser sessions in SQLite.
  - Serves the built frontend, versioned `/api/v1` Ops API, legacy
    `/api/models` compatibility routes, and protected assets without exposing
    server paths. Published viewing remains available during provider outages.

See `server/config.js` for all environment variables.

The optional direct-upload and ODM processing subsystem is documented in
[`docs/PROCESSING_PLATFORM.md`](docs/PROCESSING_PLATFORM.md). It is disabled
by default; enabling it does not make provider availability a dependency of
already-published viewing.

## Running with Docker (production)

1. Create the fixed TrueNAS configuration and managed-storage paths. Do this
   before Compose: `create_host_path: false` deliberately prevents Docker from
   silently creating a root-owned bind target. The Storage commands below are
   for a fresh installation. If `ltds-viewer-storage` already contains data,
   use the copy-first migration in the processing runbook instead; its target
   must contain only the sentinel before the copy.
   ```bash
   sudo install -d -m 0700 /mnt/Plugins/App_Data/Model-Viewer/Config
   sudo install -d -o 568 -g 568 -m 0700 \
     /mnt/Plugins/App_Data/Model-Viewer/Storage \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/data \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/datasets \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/models \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/cache \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/trash \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/imports \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/imports/datasets \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/imports/terra
   sudo install -o 568 -g 568 -m 0600 /dev/null \
     /mnt/Plugins/App_Data/Model-Viewer/Storage/.ltds-viewer-storage-root
   ```

   `/mnt/Plugins/App_Data/Model-Viewer/Storage` is mounted at `/app/storage` and
   contains the database, browser imports, adopted datasets, Terra imports,
   models, cache, and trash on one filesystem. API and worker run as `568:568`.
   Neither Compose nor the guarded updater creates the bind root, migrates the
   former volume, deletes managed bytes, or changes host ownership.
2. Copy `.env.example` to the persistent configuration path, restrict it, and
   set independent generated secrets:

   ```bash
   cp .env.example /mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
   chmod 600 /mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
   ```

   `SERVICE_AUTH_SECRET` must exactly equal Ops
   `VIEWER_SERVICE_HMAC_SECRET`; `VIEWER_EVENT_SECRET` must exactly equal Ops
   `VIEWER_EVENT_HMAC_SECRET`. `SESSION_SECRET` is an independent Viewer-only
   secret and must not be reused. `PROXY_SHARED_SECRET` and
   `TRUSTED_PROXY_ADDRESSES` are optional follow-up hardening and should remain
   empty until the matching Nginx changes are ready. WebODM migration uses
   mounted task folders or exported ZIP archives and never needs WebODM API
   credentials or database access. The production Viewer/Ops/client
   hostnames and read-only TrueNAS source paths already have safe defaults in
   `docker-compose.yml`. Back up `Config/viewer.env` securely with the database
   and never copy its populated contents into this repository or logs.
3. Compose uses the fixed
   `ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest` image for guarded TrueNAS
   updates; `viewer.env` does not control the image reference. If the GHCR
   package is private, configure TrueNAS/Docker with a GitHub token
   that has `read:packages`, then run the commands below. This installation
   should set `PROCESSING_PLATFORM_ENABLED=true`, the
   exact NodeODM/ClusterODM `PROCESSING_PROVIDER_ORIGINS`,
   `PROVIDER_CREDENTIALS_KEY`, and
   matching `VIEWER_EVENT_URL`/key/secret in `Config/viewer.env`, then run:

   ```bash
   VIEWER_ENV=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env
   docker compose --env-file "$VIEWER_ENV" pull
   docker compose --env-file "$VIEWER_ENV" up -d
   docker compose --env-file "$VIEWER_ENV" ps
   ```

   For subsequent updates, use `scripts/update-truenas.sh . auto`. It derives
   the processing mode from the persistent environment, pulls the fixed
   official `latest` image, refuses nonterminal work unless
   `VIEWER_UPDATE_ALLOW_ACTIVE=1` is explicitly supplied for an emergency,
   retains the previous image ID locally as
   `ltds-viewer-rollback:previous`, waits for container health, and runs the
   production readiness check.

   The API must receive `PROCESSING_PLATFORM_ENABLED=true` through the shared
   persistent environment; the always-started worker reads the same file and
   idles safely if the flag is explicitly false. The platform is
   not active unless both `viewer-api` and `viewer-worker` are healthy. The
   production Compose profile always pulls the configured registry image;
   local source builds remain explicit with `docker build` and cannot silently
   replace the reviewed production image.

   `PROCESSING_PROVIDER_ORIGINS` contains any fixed exact NodeODM or ClusterODM
   origins; it must not name the WebODM application. The one-time
   `PROCESSING_PROVIDER_ALLOWED_CIDRS` boundary permits IP-literal nodes on the
   two reviewed private LANs. After startup, create a provider and securely
   store or rotate its token in Ops, then probe capabilities and enable it.
   Credentials are encrypted in the Viewer database and never returned to the
   browser; no environment edit or container restart is needed for each node.
4. Compose publishes `viewer-api` directly on the configured LAN bind address
   and port `8088`; it does not run Nginx. Route Cloudflare/cloudflared through
   the separately managed Nginx, then proxy to that LAN address. Adapt
   `deploy/nginx-viewer.conf.example`: preserve request/body limits, streaming
   and range headers, rate/connection limits, disabled caching/access logging
   for capability paths and exact Host rewriting. Direct LAN requests using an
   IP Host are rejected. Optional proxy-secret/IP enforcement is documented for
   a later coordinated rollout. The bare authenticated Viewer URL redirects to LTDS Ops; there is
   no local password-admin login in production.

   For Nginx Proxy Manager, follow the paste-ready GUI instructions and
   verification matrix in [`deploy/NGINX_PROXY_MANAGER.md`](deploy/NGINX_PROXY_MANAGER.md).

Mounted WebODM task trees can be rescanned through the authenticated catalog
API; exported task ZIPs can be imported through the durable task-import API.
`GET /api/v1/health` is liveness and `GET /api/v1/ready` verifies the
database and required mounts. The authenticated
`GET /api/v1/processing/ready` separately reports the durable worker and
lifecycle journal, so provider failure never makes published viewing unhealthy.

The API and worker run directly as the TrueNAS Apps service identity
`568:568`; there is no privileged entrypoint or runtime ownership repair.
Every Linux capability is dropped, privilege escalation is disabled, process
creation is limited, and the container root is read-only. The fixed
`/mnt/Plugins/App_Data/Model-Viewer/Storage` bind is persistent and writable;
`/tmp` is bounded in-memory storage. WebODM Media remains a read-only host
mount. There is no permanent legacy-derivatives mount. An `adopted` import
consumes its verified source after durable
promotion, while `external_reference` never moves or deletes external bytes.
The Viewer API is the only Compose service published on port `8088`; the worker
has no published port. Container JSON logs rotate at 10 MiB with three files.
`X_ACCEL_REDIRECT_PREFIX` is empty, so the application performs authorized,
range-capable asset delivery itself.

Client-origin shares are separately gated by
`CLIENT_VIEWER_SHARES_ENABLED=false`. When enabled, the Viewer calls the exact
HMAC-only automation origin `https://incoming.ledgetopdroneservices.com` to
revalidate the bound client grant at bootstrap, unlock, and every asset/range
authorization. Positive decisions are Promise-coalesced for at most five
seconds (negative decisions for one second), then timeout, redirect, mismatch,
revocation, or Ops failure fails that client share closed. Staff-created shares
bypass this check, so published staff viewing never depends on Ops or an ODM
provider. The event-direction HMAC key is reused only under the distinct
source-introspection canonical path/body; it is never the Ops-to-Viewer service
key.

Published Ops/client session revocation is separately gated by
`PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED=false`. Schema migration v17 adds
an immutable `{type:"model_association",id,version}` authorization descriptor
to published grants and sessions. The v16-to-v17 upgrade deliberately deletes
unredeemed legacy published grants and revokes active legacy published sessions
whose association cannot be proven; operators should expect those browsers to
reauthorize. It does not guess or backfill an association, and review sessions
are unaffected. Roll out with the flag off, deploy Ops support that sends the
descriptor on every new session and revokes the exact prior association version
on every refresh/reactivation/revoke transition, then enable the flag. Once
enabled, startup atomically removes/revokes any unbound state created during the
compatibility window, and descriptor-less session creation fails closed.

After manually creating or migrating the fixed Storage skeleton, confirm its
sentinel, ownership, managed directories, and UID/GID 568 write access:

```bash
VIEWER_ENV_FILE=/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env \
  scripts/truenas-storage.sh diagnose
```

If this bounded check reports incorrectly owned files under the exact approved
Storage path, stop admission, inspect the target, and run
`scripts/truenas-storage.sh repair-ownership CONFIRM_UID_568`. The command
requires the fixed non-symlink path and sentinel, stops the Viewer services,
changes ownership only inside it, and restores previously running services.
Do not use a generic host-path recursive `chown`. See the processing runbook
for the copy-first migration from the former named volume; the old volume is
never moved or deleted automatically.

After the container is healthy, run the production readiness check inside it:

```bash
docker compose exec -T viewer-api \
  node scripts/production-readiness.mjs \
  --verify-mount-options --require-models --require-point-cloud
```

The command validates production configuration without printing secret values,
checks that WebODM/derivatives are read-only and Viewer data is writable, checks
the public health/ready probes, exact host redirect, disabled legacy admin API,
and the HMAC-authenticated model catalog. It prints only counts and mount paths.
Add `--model webodm-PROJECTID-TASKID` to require one exact registered model. Add
`--require-lod` only after its derivative directory contains `tileset.json`, a
    full `model.glb`, and audit-generated `lod-provenance.json`; this makes the
deployment check fail closed when full-quality LOD provenance is absent.
`--require-point-cloud` accepts either streamed EPT or a whole-file LAS/LAZ/PLY
fallback. For a browser-scalable production cloud, also pass `--require-ept`.

After configuring and enabling a provider in Ops, verify the processing mounts,
worker heartbeat, provider capability fingerprint/native outputs, disk reserve,
dataset-operation leases, and lifecycle-journal reconciliation:

```bash
docker compose exec -T viewer-api \
  node scripts/production-readiness.mjs \
  --verify-mount-options --require-processing
```

Do not submit a production dataset until this check is green. Provider health
is deliberately excluded from public `/api/v1/health`, so already-published
models remain viewable if NodeODM/ClusterODM later becomes unavailable.
Both public `/api/v1/health` and `/api/v1/ready` explicitly return
`Cache-Control: no-store` so proxy configuration cannot cache readiness state.
They also return matching `X-LTDS-Viewer-Revision` and
`X-LTDS-Viewer-Schema-Version` headers. The revision is read from the
root-owned source identity baked into the immutable image, while the schema
version is read after migrations complete. `production-readiness.mjs` verifies
both routes agree and that the served revision matches the baked identity; the
JSON bodies remain backwards-compatible.

The three readiness levels are intentionally different: container/public
`/api/v1/ready` proves the database and required local mounts only;
`--require-processing` additionally proves the worker heartbeat, disk/journal
state, enabled-provider outputs, and that every enabled credential decrypts;
`--live-capability` exercises an exact protected browser asset path. A green
public probe does not claim that an upstream processing provider is online.

After the Tunnel is live, exercise that exact model's real protected browser
path as well:

```bash
docker compose exec -T viewer-api \
  node scripts/production-readiness.mjs \
  --base-url https://viewer.ledgetopdroneservices.com \
  --model webodm-PROJECTID-TASKID \
  --verify-mount-options --require-models --require-ept --require-lod \
  --live-capability
```

`--live-capability` is deliberately opt-in and requires `--model`. It creates
one short-lived Ops grant/session (120 seconds by default), repeats the signed
creation with the same idempotency key, redeems the grant once, checks the
current session, and downloads only representative one-byte ranges. When
present, it also reads the protected 3D Tiles manifest/child and EPT manifest,
nested JSON hierarchy, and root data node. Unsigned creation, missing browser
authorization, grant reuse, an unscoped asset path, cross-model use, and a
tampered capability must all fail closed. It does not create, alter, or revoke
a model or public share; normal audit/idempotency rows and the expiring
grant/session are the only writes. Override the lifetime, if necessary, with
`--capability-ttl-seconds 30` through `600`. Output and errors redact the
service/session credentials, one-use grant, and browser capability.

The Viewer receives only the explicitly configured provider network access and
storage mounts. WebODM media is always **read-only**. It never mounts WebODM's
Postgres data, Redis/broker data, application source, worker configuration, or
the Docker socket.

### Read-only WebODM access

The Viewer uses the fixed host path
`/mnt/Plugins/App_Data/WebODM/Media`, mounted read-only inside the container as
`/imports/webodm`. It must contain WebODM's Django media tree
`project/{id}/task/{id}/assets/...` and must not be the WebODM Postgres path.

WebODM's own application must use that same dataset as its media
  root:
  ```yaml
  webapp:
    volumes:
      - ${WO_MEDIA_DIR}:/webodm/app/media:z
  worker:
    volumes:
      - ${WO_MEDIA_DIR}:/webodm/app/media:z
  ```
  (If that compose file also declares an `appmedia:`/`dbdata:` named volume
  under top-level `volumes:`, it's unused — every service overrides it with
  the bind mount above via `WO_MEDIA_DIR`/`WO_DB_DIR` env vars.)

The Viewer catalog scanner walks only this media tree. The Viewer never mounts
`WO_DB_DIR`, Redis, WebODM secrets, application source, or the Docker socket.

## Multi-project support

Nothing in the frontend is hardcoded to a specific project any more. In admin
mode, `main.js` calls `GET /api/models`, picks the project from `?project=` in
the URL (or the first available one), and fetches its full config from
`GET /api/models/:id`. A project switcher appears in the top bar whenever
more than one project is available.

Per-project config includes resolved asset URLs (mesh/tiles/point
cloud/orthophoto/DSM/DTM/camera shots — each `null` if that project doesn't
have it, which hides the corresponding tab/layer button) and georeferencing
(UTM zone + RTC origin, parsed from WebODM's `coords.txt`).

## Authentication & share links

The Viewer deliberately has no duplicate LTDS user database. LTDS Ops remains
the identity/ACL source of truth and calls the versioned API with signed HMAC
requests. The production Compose profile disables the legacy password admin.

- **Ops/client sessions**: Ops calls `POST /api/v1/models/:id/sessions` with
  the authorized subject, audience, active model-version ID, permission set,
  required future authorization expiry, and the immutable source authorization
  `{ "type": "model_association", "id": "<opaque association id>", "version": 1 }`.
  The descriptor is optional only during the flag-off rollout window. The browser redeems the returned one-use
  grant for a random, model-and-version-scoped capability; only its SHA-256
  hash is stored. Capability asset paths work when third-party cookies are
blocked and do not collide across simultaneous embeds. Renewal extends the
  same database session in place, so active 3D Tiles/EPT loaders retain stable
  URLs. A suspended tab may recover the same expired-but-unrevoked session only
  by presenting a fresh, exactly matching one-time grant; the expired bearer
  alone remains unusable. Iframe renewal messages are accepted only from exact
  configured embed origins. The Viewer catches up on focus, visibility, and
  pageshow, and retries authenticated tile failures after renewal without
  discarding its camera or decoded LOD cache.
  Capability paths must be excluded/redacted from reverse-proxy and Cloudflare
  URL logs; `deploy/nginx-viewer.conf.example` disables Nginx access logging
  for those routes.

- **Administration**: staff use LTDS Ops. The bare Viewer origin redirects to
  Ops, which lists models and uses the signed `/api/v1` service API to create
  staff/client sessions, project associations, provider rescans, and public
  demo links. Legacy `/api/admin` and password-protected catalog routes return
  `404` while emergency administration is disabled.
- **Share links**: created by Ops through
  `POST /api/v1/models/:id/shares`, each one gets a random
  256-bit token (only its SHA-256 hash is ever stored — the raw token is
  returned once, at creation time, and cannot be retrieved again). A link can
  optionally have a password (scrypt-hashed) and/or an expiry, and can disable
  the measuring tools and/or camera-position layer for that link specifically
  via `permissions: { measure, cameras }`. Revoking a link
  (`DELETE /api/v1/shares/:id`) is a soft-delete that takes effect
  immediately — asset requests re-check the live share record on every
  request rather than trusting a cached session.
- **`/view/:token`** opens the full toolbar (measurements, camera photos,
  layer switching) for that one project; **`/embed/:token`** is the same
  model with the sidebar/topbar hidden for an explicitly embedded public-share
  surface. Authenticated LTDS `/session/:grant` routes open the full Viewer in
  a dedicated tab and use an exact-origin/source opener channel for silent
  one-time-grant renewal. The grant is redeemed immediately and removed from
  the active URL.
- **`/workspace/:grant`** renews its staff session in the background five minutes
  before expiry and again when a due tab becomes visible, focused, or returns
  through pageshow. It first requests an authority-validated, one-use grant from
  the exact `controllerOrigin` returned by its own admin-session response. This
  credentialed request uses the existing Ops sign-in and keeps working if the
  original Ops tab was closed or reloaded. If browser privacy restrictions or a
  temporary network error block that request, it silently tries the existing
  captured opener through the separate version-1 workspace protocol. It does
  not open a popup for renewal. Both paths redeem with the existing bearer and
  require the same session ID and subject. Retryable
  failures retain the current token and workspace state even when a browser
  timer wakes after the recorded expiry; only an authoritative `401` locks the
  attached workspace. An expired Ops sign-in still requires the user to sign in;
  background renewal never bypasses that authentication boundary. This does not
  affect client portal or public-share sessions.
- **Cross-origin session control requires HTTPS.** Session/asset authorization
  does not depend on third-party cookies. Put this app behind TLS in production.
- **Not implemented**: annotations and source-file download controls.
  Integrity-checked original flight photos are available to authorized camera
  markers when an exact imported JPEG link exists; positions remain visible
  with an explicit unavailable-photo state otherwise. Pinned-version public
  shares are rejected until pinned-version asset resolution is implemented;
  `latest` works now.

### Cloudflare edge layout

Cloudflare Access authenticates staff on
`ops.ledgetopdroneservices.com` and authenticated customers on
`client.ledgetopdroneservices.com`. Do **not** put a blanket employee-login
Access policy over `viewer.ledgetopdroneservices.com`: an anonymous demo link
must also load the Viewer shell, hashed static bundles, public-share API, and
capability-protected model assets. Instead:

1. Publish external Nginx only through Cloudflare Tunnel; do not port-forward
   Viewer port `8088` from the Internet. Bind it to one reviewed LAN address
   with `VIEWER_BIND_ADDRESS` (or deliberately to all LAN interfaces only when
   host firewall rules require traffic to originate from Nginx).
2. Keep the Viewer hostname Cloudflare-proxied and apply normal zone WAF/rate
   limiting. There is no public administrator UI at that hostname.
3. Staff authorization flows from Access-protected Ops through HMAC-signed
   service requests. Authenticated staff/client tabs use Ops-issued short
   Viewer sessions; large assets still stream directly from Viewer/Nginx.
4. Demo viewers use an unguessable, revocable, optionally password-protected
   public-share token. Every API and asset request rechecks the live share or
   Viewer session.

If account-wide Access protection is enabled, create a narrowly scoped Viewer
exception/application for the public Viewer surface. Cloudflare documents that
path-specific Bypass disables Access enforcement and Access logging, so the
Viewer's own session/share checks remain mandatory. A separate public Viewer
hostname is preferable to a growing list of bypassed asset paths.

The supported production chain is Cloudflare/cloudflared → external Nginx →
Viewer. Nginx resolves the trusted Cloudflare client address, overwrites
`X-Forwarded-For`; therefore Viewer uses `TRUST_PROXY_HOPS=1`. Do not append
inbound forwarding headers. Exact Host enforcement is enabled immediately.
As a later coordinated hardening step, configure `PROXY_SHARED_SECRET` in both
Viewer and Nginx and optionally set `TRUSTED_PROXY_ADDRESSES` to Nginx's exact
socket-source IP/CIDR when Docker preserves it. `X_ACCEL_REDIRECT_PREFIX` stays
empty.

## Known limitations (by design, for this iteration)

- **Processing remains explicitly controllable.** This Compose deployment
  defaults `PROCESSING_PLATFORM_ENABLED` to true and always starts the durable
  worker. An explicit false override leaves the worker healthy but idle. Processing
  requires the writable managed storage
  volume, disk reserve, and an explicitly allowlisted NodeODM or ClusterODM
  provider. NodeODM API 2.2.3 is the direct-node baseline. ClusterODM is
  accepted only when its 1.x API response includes the official proxy resource
  sentinels; a merely API-compatible 1.x response is ambiguous and rejected.
- **Production point clouds use ODM's native EPT; new textured meshes use the
  Viewer-local KTX2 lane.** Provider capabilities currently request `pc-ept`,
  `3d-tiles`, and `gltf`, but a new provider result is accepted only when it
  contains EPT plus one textured OBJ, every referenced MTL and texture, and an
  independent companion GLB. The Viewer hashes that immutable mesh closure and
  generates current ETC1S KTX2 tiles with its pinned Obj2Tiles 1.6.2 worker;
  bundled ODM JPEG mesh tiles do not satisfy a required new derivative. Native
  tiles are retained only for the separate legacy exact-audit lane. The
  original GLB remains available as an authenticated Operations download,
  never an interactive Viewer layer, when generation or proof fails.
  Migration 23 also gives pre-fix terminal LOD jobs one durable, audited
  compare-and-swap recovery per explicitly shipped recovery revision. Current
  jobs are stamped before execution, so this upgrade recovery cannot become an
  infinite retry loop or reset the manual retry allowance.
  Generated Obj2Tiles output retriangulates partition boundaries and repacks
  texture atlases, so it uses a separate schema-v3 proof bound to the exact
  pinned executable and command, GLB and OBJ digests, artifact digests,
  aggregate surface invariants, and deterministic bidirectional BVH samples.
  OBJ-only or GLB-only models remain
  downloadable but unavailable in 3D mode; the Viewer never claims streaming
  LOD that it cannot validate or decodes the complete source mesh.
- **Native and generated 3D Tiles have separate proof lanes.** The native-tile
  schema-v2 LOD audit binds the exact full GLB, leaf geometry, material
  state, and texture bytes. If upstream tiling decimates, retriangulates, or
  repacks textures, the LOD claim fails closed and the full GLB remains an
  authenticated download rather than a published close-range layer. Only the
  locally generated, executable-allowlisted Obj2Tiles lane may use schema v3;
  imported tiles cannot opt into that controlled-converter proof.
- **WebODM migration is file-based.** Direct WebODM media import reads the
  mounted tree without credentials and never moves or deletes it. Exported
  task ZIPs and task folders can be adopted into Viewer-managed storage.
  The durable catalog scanner also discovers supported models under the
  approved Terra drop root. Administrators map each candidate to an existing
  or new LTDS project and either keep an explicit external reference or adopt
  the verified tree into managed storage. Repeat scans are fingerprinted and
  do not duplicate an unchanged mapping.
- **Existing published legacy models remain deliverable.** Removing live
  WebODM synchronization does not delete registry rows or mounted assets.
  Newly migrated outputs use immutable manifests and publication rules.
- **Original flight photos** are linked to imported `shots.geojson` positions
  when an exact, integrity-checked source JPG exists. Camera positions remain
  visible when no image is available, and the marker dialog says so explicitly.
- Raw imagery, GCP files, provider archives, logs, and processing internals are
  administrative assets and are never client-shareable by default.
- Annotations and source-file download controls are not implemented. Legacy
  JSON and legacy Viewer routes remain only for compatibility while SQLite is
  the canonical registry.

## Versioned LTDS Ops API

Service routes require HMAC over method, exact path/query, timestamp, nonce,
and SHA-256 of the exact body bytes. Nonces are single-use. Configure one
`SERVICE_AUTH_KEY_ID` + `SERVICE_AUTH_SECRET`, or `SERVICE_AUTH_KEYS_JSON` as
a JSON object containing both current and previous keys during rotation.
For a simple two-key rollout, set the complete
`SERVICE_AUTH_PREVIOUS_KEY_ID`/`SERVICE_AUTH_PREVIOUS_SECRET` pair, deploy the
Viewer first, switch Ops to the new current key, then remove the previous pair.
Service mutations require `Idempotency-Key` (`428` when absent). Retries must
reuse that key with a fresh HMAC
nonce. The Viewer returns the original status/body for an identical retry and
returns `409` if the key is reused with a different method, path, or body.
Credential-bearing replay bodies are encrypted at rest and pruned after 24h.

- `GET /api/v1/models`; `GET /api/v1/models/:id`
- `POST /api/v1/models/:id/sessions`
- `DELETE /api/v1/published-sessions/source-authorization` requires
  `PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED=true` and the exact body
  `{ "sourceAuthorization": { "type": "model_association", "id": "<opaque>", "version": 1 } }`.
  It atomically tombstones that exact version, removes its unredeemed published
  grants, revokes its active published sessions, and writes a bounded audit.
  The `200` response is exactly `{ sourceAuthorization, revokedGrants,
  revokedSessions }`; a same-key/same-body retry replays that result, while a
  reused key with different bytes returns `409`. Raw grants and session tokens
  are never returned or audited by this route.
- `GET|POST /api/v1/models/:id/shares`; `DELETE /api/v1/shares/:id`
- Admin sessions: `POST /api/v1/admin-grants`; `POST
  /api/v1/admin-sessions/redeem`; `GET /api/v1/admin-sessions/current`
- Catalog: `/api/v1/projects`, `/api/v1/datasets`, and `/api/v1/tasks`
- Resumable upload/finalize: `/api/v1/admin/uploads/...`; durable operation
  polling: `GET /api/v1/operations/:id`; preview cancellation:
  `POST /api/v1/operations/:id/cancel`
- Server import: durable `/api/v1/dataset-imports/preview` and
  `/api/v1/dataset-imports/adopt` operations
- WebODM task migration: durable `POST /api/v1/processing/webodm-task-imports`
  accepts a task folder or exported ZIP and reports detected asset capabilities
- Processing: `/api/v1/processing/providers`, `/presets`, task/attempt detail,
  cancel, retry, and publish routes
- Storage accounting/recovery: `/api/v1/storage`, `/storage/trash/...`, and
  `/storage/mutations/...`
- Browser: `POST /api/v1/sessions/redeem`; `GET /api/v1/sessions/current`
- Unpublished admin review: `POST /api/v1/attempts/:id/review-sessions` and
  subject-scoped `DELETE /api/v1/attempts/:id/review-sessions` require
  `viewer.processing.publish`. Review grants are short-lived, bind the exact
  review-ready attempt/model version, expose only integrity-checked derived
  assets, and never publish or create a public share.
- Public probes: `GET /api/v1/health`; `GET /api/v1/ready`

Session-grant responses are `Cache-Control: no-store`; the service secret is
never exposed to browser code. Required `authorizationExpiresAt` only shortens the
configured Viewer TTL, and `modelVersionId` prevents an authorization for one
version silently following a newly activated version. Iframe messages use
`version: 1` and the `ltds-viewer:ready`, `session-expiring`, `renew-session`,
`session-renewed`, and `session-renewal-failed` event types.
The staff workspace uses the separately named `ltds-viewer:workspace-ready`,
`workspace-session-expiring`, `renew-workspace-session`,
`workspace-session-renewed`, and `workspace-session-renewal-failed` messages;
all are exact-key, opener/source, origin, version, session, and request bound.

## Local development

Run the backend and the Vite dev server side by side:

```bash
# terminal 1 — backend (reads server/config.js env vars)
WEBODM_MEDIA_MOUNT=/path/to/webodm/media \
EMERGENCY_ADMIN_ENABLED=true ADMIN_PASSWORD=dev-only-password \
PORT=8090 npm run server

# terminal 2 — frontend, proxies /api and /assets to :8090 (see vite.config.js)
npm run dev
```

This legacy password shell is only a local-development harness; the production
Compose profile fixes `EMERGENCY_ADMIN_ENABLED=false`. `npm run dev` uses
Vite's own dev server for `/`, so it does not run the Express login gate.
`/view/:token` and `/embed/:token` behave the same in both, since their auth
is token-based via the API, not the login page.

`npm run build && npm run server` reproduces the production single-process
setup locally (serves the built `dist/` from the same Express server).

`serve-all.sh` is a legacy fallback from before the backend existed (four raw
`http-server` processes with hardcoded paths for one project) — prefer the
Docker/backend setup above for anything beyond quick local Draco/tileset
debugging.

## Files

- `main.js` — app: bootstrap/project config, tabs, layers, measurements,
  cameras, GeoTIFF streaming
- `earth-controls.js` — `EarthLikeControls`: LEFT-drag orbits around the surface
  point under the cursor (pivot stays in the scene, camera never recenters),
  RIGHT-drag pans along the ground plane, wheel zooms toward the cursor,
  touch: 1-finger orbit / 2-finger pan+pinch. Polar angle clamped, zero-roll.
- `public/pointcloud.html` — isolated Potree 1.8 iframe (EPT, EarthControls with
  the same left/right swap, EDL, budget/size/color toolbar); config (EPT URL,
  title, point count) comes from its query string, set by `main.js`.
- `server/` — API and durable worker: mounted/exported WebODM migration, dataset/import
  manifests, NodeODM/ClusterODM processing, derivative/review publication,
  lifecycle recovery, SQLite migrations, signed v1/legacy compatibility,
  session/share authorization, protected asset delivery, and auth primitives.
  See `server/config.js` for environment variables.
- `public/admin-login.html` — legacy local-development login shell; production
  redirects standalone administration to LTDS Ops.
- `serve-all.sh` — legacy local-dev-only asset server startup (see above).

## Georeferencing

Legacy published records may retain the per-project UTM origin (RTC) and zone
previously parsed from WebODM's `coords.txt` (`odm_georeferencing/coords.txt`), e.g.:

```
WGS84 UTM 16N
367257 4759982 0
```

- GLB/OBJ: parent rotated `-π/2` X (Z-up→Y-up), child offset `-C` (model bbox
  center). WebODM imports read their bounded model origin from
  `odm_georeferencing_model_geo.txt` (with `coords.txt` as a fallback) and
  derive `C` from authoritative summary, info, or EPT bounds.
- 3D Tiles: `3d-tiles-renderer` already applies its own up-axis fix; parent is
  rotated `π` X with offset `(-C.x, -C.z, C.y)` so tiles land exactly on the GLB
- Cameras (`shots.geojson` translations are absolute UTM): position − RTC, then
  the same GLB frame; rotation = axis-angle negated (WebODM convention).
  Worker maintenance repairs missing RTC/bounds metadata on existing adopted
  WebODM versions in bounded, idempotent batches, so reimport is unnecessary.
- Statusbar `worldToUtm()` converts back for live E/N/elevation readout

## Feature notes

- **LOD mesh** (when verified tile derivatives exist): hierarchical B3DM tiles,
  REPLACE refinement (root → intermediate LODs → LOD-0 full res as you zoom).
  Detail `2..24` maps exponentially to the raw camera screen-space-error target
  from 512 down to 2; the default Detail 20 target is exactly `5.481` and is not
  multiplied by bootstrap geometry. Startup displays the renderable whole-model
  root, then performs a depth-2 prefetch of the direct-child shell. The root is
  retired only after every renderable direct child is decoded and ready for two
  frames, so strict REPLACE refinement never exposes a hole. A shell that is
  structurally unusable or cannot fit beside at least 1.625 GiB of focal-detail
  reserve stays honestly root-only instead of promoting an incomplete cut.
  Clients reporting 4 GiB or less retain that root and are capped at Detail 13.

  After shell promotion the renderer immediately uses the requested raw SSE at
  unlimited traversal depth. Selection remains camera-distance driven. A
  camera-centered focus pass changes download/parse ordering, not visibility:
  while the camera moves, peripheral work receives a 1–4× queue penalty, then
  decays to neutral after 250 ms idle over the following 500 ms. Tile bounds are
  transformed through the real `TilesRenderer.group.matrixWorld` before focus
  projection; otherwise the Viewer's rotated/translated tiles frame makes the
  chosen foreground branch depend on camera angle. The focused REPLACE owner is
  retained across tiny motion and changes only after a cumulative 3-degree turn
  or 5% camera-to-owner translation. Recently decoded detail is retained only as
  complete replacement cuts, preventing a one-pixel move from briefly restoring
  a blurry parent.

  Viewer memory is an explicit `Auto`, `Balanced`, or `High` policy rather than
  a raw-RAM slider. Auto uses the browser's coarse device-memory hint: capable
  desktops use a 3 GiB soft / 3.75 GiB hard cache, and an unavailable hint uses
  the Balanced 2.5 GiB / 3.125 GiB profile. High uses 4 GiB / 5 GiB. A known
  ≤4-GiB client always uses the constrained 768 MiB / 1 GiB profile even when a
  stale High preference exists. These limits describe decoded tile residency,
  not total browser or GPU memory. At pressure, bounded synchronous admission
  recovery evicts stale peripheral content first. Persistent pressure may relax
  only fully peripheral selection up to 4×; the locked foreground branch keeps
  the requested raw SSE and automatically converges when headroom returns.

  Completed Viewer tiles release the GLTF parser reference and its source-buffer
  caches after parsing; scene metadata, attribution, feature tables, textures,
  and geometry remain available. Eviction disposes the unlit materials used for
  rendering and cancels pending BVH work. These cleanup rules reduce unnecessary
  retention but do not establish a measured browser-heap reduction or a total
  process-memory ceiling.

  `LOD: full-detail` is shown only when every visible tile is on the declared
  zero-error frontier. Invalid hierarchy, provenance, or tile-load failures stay
  unavailable until a verified streaming derivative exists; original GLB/OBJ
  files are authenticated downloads and are never decoded automatically in the
  browser. Resize and orientation changes refresh the render resolution used by
  the screen-space-error calculation.

  Zero geometric error verifies renderer convergence, not conversion provenance:
  the tiles match the full mesh only if the derivative pipeline generated every
  LOD-0 leaf from that exact source without decimation or reduced textures. Keep
  the source fingerprint and triangle/texture audit produced by the conversion
  job with the derivative set; mounted project assets are not stored in this repo,
  so filename conventions alone cannot prove equivalence.

  Production LOD sets therefore require `lod-provenance.json` beside
  `tileset.json`. Without a valid record, the Viewer keeps the invalid LOD
  layer unavailable. The original GLB/OBJ remains an authenticated download
  and is not decoded as an interactive browser fallback:

  Generate the record with the offline equivalence audit; never hand-author it:

  ```bash
  npm run audit:lod -- /path/to/derivatives/project-task /path/to/derivatives/project-task/model.glb
  npm run validate:lod -- /path/to/derivatives/project-task /path/to/derivatives/project-task/model.glb
  ```

  The generated evidence has this versioned shape (artifact list abbreviated):

  ```json
  {
    "schemaVersion": 2,
    "sourceAsset": "model.glb",
    "sourceSha256": "<64 lowercase hex characters>",
    "geometry": "bounded-triangle-equivalence",
    "textures": "byte-identical-material-equivalence",
    "leafGeometricError": 0,
    "audit": {
      "algorithm": "ltds-glb-leaf-equivalence-v2",
      "coordinateTolerance": 0.000001,
      "maxNumericDelta": 0,
      "triangleCount": 123456,
      "equivalenceSha256": "<64 lowercase hex characters>",
      "artifacts": ["<tileset, leaf, and external-texture digest records>"]
    }
  }
  ```

  The generator parses the source GLB and all zero-error GLB/B3DM leaves,
  applies node/tile/JSON-RTC transforms, and compares winding-preserving
  triangles, vertex attributes, render material state, samplers, and exact
  texture bytes. It binds every tileset, leaf, and external texture by digest.
  During import validation the Viewer re-hashes the selected full GLB and every
  bound artifact before exposing the evidence. See
  [docs/LOD_PIPELINE.md](docs/LOD_PIPELINE.md)
  for the intentionally fail-closed supported subset and why a tiler that clips
  or retriangulates partition boundaries cannot receive an exact v2 proof. The
  locally reproduced runtime diagnosis, measured working sets, real-browser
  verification, and safe diagnostic procedure are recorded in
  [docs/VIEWER_LOD_CAMERA_HANDOFF.md](docs/VIEWER_LOD_CAMERA_HANDOFF.md).
- **Camera positions**: a shared four-part glyph uses a neutral frustum body,
  amber image plane/front cues, and an LTDS-orange top-edge tab, making both
  forward direction and image-up readable from either side. Model and direct
  point-cloud views use synchronized instanced meshes; Potree draws the same
  components in its post-EDL overlay; the orthophoto uses a matching rotated
  Leaflet marker. Markers retain source-index picking, density decluttering,
  tooltip, photo opening, and size controls. Camera permission governs every
  view, and the map representation is bounded to 1,200 markers.
- **Camera photos**: selecting a marker opens a non-blocking top-right preview
  so model/map navigation remains usable. The image keeps its natural aspect
  ratio and can expand to the full viewer. Fit-to-window images cannot pan;
  zoomed images clamp translation so empty space cannot be dragged on screen.
  Resize and image-load changes reapply the same bounds.
- **Measurements**: distance / area / volume with CSS2D labels pinned to the
  geometry. Imperial is the default; project/session/share state can select
  metric, and distance, elevation, area, and volume use one consistent unit
  formatter. Esc cancels, right-click or Enter or double-click finishes
  polygons, the tool auto-disarms, and finished measurements persist until
  Clear.
- **Ortho/DSM/DTM**: `GeoTIFF.fromUrl` HTTP range reads against the BigTIFF
  overview pyramid. A Leaflet `GridLayer` subclass reads windows per tile at
  the right overview level. Map auto-fits to the raster bounds over Esri World
  Imagery. DSM/DTM get viridis + hillshade, legend in ft, hover elevation
  readout.
- **Point cloud**: Potree in an iframe when an EPT dataset exists (its bundled
  Three r124 can't share the page with npm Three); otherwise a direct
  LAZ/LAS (via `@loaders.gl/las`) or PLY point cloud in the main three.js
  scene. Potree camera markers render from a dedicated perspective-overlay
  scene after the EDL composite so dense points cannot overwrite or hide them.

## Operations workspace

The staff workspace is project-first. **Dashboard** loads the complete permission-visible project, dataset, task, and output catalogs through cursor pagination, then filters project names instantly in the browser. The catalog is shared by authorized Viewer staff; creator identity remains audit and notification ownership and does not filter project visibility.

Open a project to manage its datasets and tasks, start or restart processing, import data, work with GCPs, review/publish outputs, and create authenticated client access, task-specific public links, or one whole-project public link. A whole-project link dynamically lists only each task's current active published output, automatically includes tasks published later, and stops serving a task when its publication is replaced, archived, or removed. Project links have their own password, expiry, revocation, audit, and rate-limit boundary; they do not create client grants or child model shares. Public project sessions and asset capabilities expose only published GLB, tiles, EPT, ortho, DSM, and DTM derivatives. Processing reports, raw inputs, logs, datasets, provider paths, OBJ sources, and unpublished assets remain staff-only. Disabling download controls is a UI choice rather than DRM because a browser must receive renderable model bytes.

The import dialog separates bounded browser uploads (**This device**) from the managed server import folder; there is no live WebODM scan control. The server option provides a root-confined browser over `/app/storage/imports/datasets`, so staff open folders and explicitly select a folder or ZIP without typing or seeing a host path. ZIP and ZIP64 WebODM backups are read from their bounded central directory, which supports large task backups without weakening traversal, symlink, duplicate-path, entry-count, or expanded-size checks. The API and worker revalidate the selected source, then copy and validate it before creating the task. An operator may intentionally import identical WebODM content more than once; each operation receives independent task, dataset, model, and version identities, while retrying one operation remains idempotent. The original source remains untouched until a separate recoverable cleanup action is requested. Emlid all-columns GCP files use a separate preview-first flow, with the exact `CS name`, vertical provenance, units, coordinate mapping, and warnings returned by the server; GCP import requires explicit confirmation and never substitutes a guessed coordinate system.

Expanded tasks show only authoritative API metrics: processing status/duration, source-image count, reconstructed points, georeferencing CRS, output availability, and task disk usage. Average GSD or surveyed area display **Unavailable** unless the imported or completed ODM task supplies the authoritative statistics. The task also exposes the latest 100 immutable processing attempts, with retry available only for failed or cancelled attempts. Output actions appear only for reported derivative kinds and usable URLs; reviewable map/3D derivatives open through an isolated review session. While an attempt is active, the workspace refreshes its sanitized API log tail every five seconds; the UI keeps the latest 100 entries and offers bounded log-tail download and fullscreen views.

Output DTOs expose bounded staff URLs rather than storage paths. `GET /api/v1/processing/outputs/:id/assets/:kind` requires an admin bearer with `viewer.processing.read` and serves only an exact registered derivative or PDF processing report after size and SHA-256 verification. Raw provider inputs, OBJ sources, point clouds, logs, and other private files are not downloadable through this route. `POST /api/v1/processing/outputs/:id/view-sessions` creates a short-lived audited session for an already-published output; it includes only the existing public derivative allowlist. Processing reports remain staff-only and are never added to client or public sessions.

Provider endpoints, hidden credential state, concurrency, probes, enable/disable controls, and capability-bound processing presets live in the **Providers & nodes** master-detail dialog. Adding a node asks only for a label, endpoint, and an API token when the endpoint requires one. Viewer probes `/info` and `/options` before storing the provider, classifies direct NodeODM 2.x versus the ClusterODM 1.x proxy signature, and rejects unsupported or ambiguous responses. A successful no-token probe is persisted as an explicit no-auth mode, distinct from a missing or cleared credential. Staff can later edit the label, endpoint, and Viewer admission limit; rotate or clear the write-only token; re-probe capabilities; and create or edit JSON option presets that are validated against the exact current capability fingerprint. The detail pane shows the detected provider type, API and processing-engine versions, queue/slot values, and the bounded provider-options catalog.

The normal project/task workflow provides Rename and a recoverable Delete instead of asking staff to archive first. Delete moves a project or task and its exclusively owned datasets/outputs into one 30-day trash container; shared datasets remain active. Restore returns every member to its exact usable pre-delete state. Typed permanent deletion removes owned bytes, scrubs user metadata from the retained referential-integrity tombstones, and makes the project/task unavailable through direct and list APIs. Dataset and output controls retain their journaled 14-day lifecycle. **Background Work** searches and cursor-paginates the complete import and derivative history rather than only a recent window. **Diagnostics** paginates the complete recoverable-trash inventory, provides restore and typed-confirmation purge, and lists failed storage mutations with their bounded error details and a guarded Retry action. Worker readiness, queue lifecycle, storage accounting, and provider health live there as well.

## Verification

Run `npm run check` before building an image. The suite covers direct LAS
Float64 decoding before UTM rebasing, point-cloud-only initialization, protected
EPT metadata/nodes with HTTP range and HEAD behavior, live share revocation,
LOD hierarchy/provenance/fallback policy, production health/readiness, the
model registry migration, service-request replay protection, resumable durable
dataset operations, provider fencing, asset manifests, and crash-consistent
trash/restore/purge recovery. The Docker build additionally asserts the exact
Potree, jQuery, Three.js, and LAS/LAZ runtime files requested by
`pointcloud.html`.

Before promoting a new project, stage it with the real mounted assets and
verify both the EPT view and close-range LOD frontier on representative desktop
and mobile hardware. Raw LAS/LAZ fallback is intentionally limited to LAS 1.3
and below and loads the whole file; large field clouds should use EPT.

## Direct sharing

Ready models remain private until an explicit Share action creates a public
link. That action atomically activates verified derivatives and creates a
revocable link; a separate Review/Publish ceremony is not required. Passwords
are optional and download controls default off. Existing-access updates require
confirmation. Model links follow the latest activated version; whole-project
links include future activated tasks and require an explicit scope opt-in.

Authenticated Operations client access remains separate from public links. An
individual model grant requires an exact existing Operations model association,
uses task scope, and never includes future tasks implicitly. **Direct client
sharing of a private ready output is not yet integrated:** activating it and
creating its Operations association/grant needs the Operations contract. The UI
explains this gap rather than creating a public link as a workaround or granting
an entire client project. See [the implementation contract](docs/DIRECT_SHARING_IMPLEMENTATION_REVIEW.md).

## Pitfalls learned

- `3d-tiles-renderer@0.5.x`: use `addEventListener('load-tileset'|'load-model')`,
  NOT the removed `onLoadTileSet`/`onLoadModel` callbacks. Event `ev.scene`.
- Three r180+: `Vector3.subScaledVector` does not exist — use
  `addScaledVector(v, -s)`.
- Raycast picking on 8k-instance meshes / big tiles needs `three-mesh-bvh`
  (`firstHitOnly = true`); BVH build is queued one mesh per frame.
- BigTIFF + geotiff.js works with `fromUrl` range requests; DEM nodata is
  `-9999` (also guard `< -1000`).
- Point-cloud orbit/zoom must mirror `EarthLikeControls`' sign conventions
  exactly (negated drag deltas; wheel-zoom must dolly the camera position
  without ever calling `view.lookAt()`) — Potree's own `View.getSide()`
  confirms the `(cos(yaw), sin(yaw), 0)` right-vector approximation used in
  `pointcloud.html` is otherwise correct.
- When direct PLY/LAS positions are replaced after RTC localization, recompute
  both geometry bounds. PLYLoader's old absolute-UTM bounding sphere otherwise
  stays millions of metres away and Three.js frustum-culls the entire cloud,
  producing a black canvas even though decoding completed successfully.
- Headless CDP verification: connect websocket with `suppress_origin=True`,
  drive with Input.dispatchMouseEvent; vite HMR means always hard-navigate
  after editing main.js before measuring behavior.
