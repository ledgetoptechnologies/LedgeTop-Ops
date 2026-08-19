# 3D processing and delivery release runbook

Status: **source candidates and the immutable Viewer registry image are frozen
and independently signed off; live staging evidence and activation remain
pending**. The staff Viewer integration and processing workspace are already
deliberately enabled for pre-production validation. New Viewer public-share,
Client Viewer, and Project Alpha portal capabilities remain gated until their
corresponding live evidence below is captured.

## Frozen source candidates

- 3D Viewer source: `ad505557ce89c0c6a8aa76777c4a2f7d798e80b5`.
  The reviewed release-candidate image is
  `ghcr.io/ledgetoptechnologies/3d-viewer@sha256:2a37add7d5ffb8486b663c6a0288b800a9b5944313e6eb06aafd447399e4a322`.
  GitHub Actions run `32232338063` published tags `latest` and
  `sha-ad50555`. The
  workflow then pulled that exact digest back from GHCR and verified runtime
  UID/GID `568:568`, OCI revision, and the read-only source-commit stamp.
- LTDS-Ops product code: `f636aab92ff2bfb31577593445dc7d6f81280f56` on
  `codex/3d-processing-control-plane`. This pin moves processing management to
  the dedicated Viewer workspace and leaves Operations as the aggregate Data
  overview; never substitute a mutable branch tip.
- Project Alpha: `e3355875d86250628ad630c1d02baa1ecc127a77` on
  `codex/portal-scope-ci`. Its direct parent is the prior reviewed candidate
  `f646f3b308d993bd90d256975f140eac6ed65e15`; the tip ensures the default-off
  managed-delivery schema is applied by migration 0069 only after its portal
  profile dependency while preserving the mandatory isolated MySQL scope-lock
  CI gate.

The updated source, manifest digest, migrations, fixtures, and activation
policy passed independent cross-repository verification, so the corresponding
constant in `scripts/staging-requirements.mjs` is
`RELEASE_CONTRACT_FINALIZED=false` while the broader workspace completion and live acceptance gates remain under review. Set it to true only after the updated source and image pins are independently verified. Finalization freezes
the candidate contract only; it does not approve deployment, migrations, or
any feature flag. Reset it to `false` before changing a pinned source or
deployment artifact.

The Viewer/Ops signed-processing corpus has SHA-256
`0ed7a7c40ad23583b9e741667b99aecc31cc01f7617c73ab63ad314a7ba344a0`.
The route-response corpus has SHA-256
`0fd00d7dfb6440a04084bc84b27eb2a223081d3f51fca36f1e521144f86a6703`.
The six generic Project Alpha fixtures are byte-pinned by both repositories.
Do not substitute a later commit or hand-edit a fixture during activation.

The candidate also passed the guarded disposable-volume scale rehearsal with
exactly 100,000 one-byte files: full scan/fingerprint, authoritative adoption,
index/accounting, database reopen and re-fingerprint, low-space refusal, and
sentinel-verified cleanup. The exact repinned build-stamped replay completed in
63.152 seconds with peak RSS 587,587,584 bytes. Its pre-generation disk check
required 11,811,260,064 bytes (payload, 10 GiB reserve, and safety margin)
against 923,211,886,592 available bytes. The local source-stamped image ID was
`sha256:799b17aa0795fc17c5e884b70518581c4b1f28cd95556b60fa0841d4f56ca0af`;
it is local scale-rehearsal evidence, not the separately reviewed GHCR
manifest digest pinned above. Production mode
accepts the official `latest` tag for routine internal rollouts while retaining
immutable digest/source-stamp evidence for approval and rollback. It still rejects
unrecognized mutable tags, source-stamp mismatches, and insufficient space
before creating a target.
This is inode/index/recovery evidence only;
the same rehearsal still must run on the disposable TrueNAS storage class with
representative imagery before activation.

The exact candidate passed 270 of 273 repository-owned tests in the Linux
workflow with zero failures and three environment-only skips, then completed the
production build. The suite covers the real symlink-escape gate, UID/GID 568
storage admission, persistent-bind byte/database behavior, project-first
workspace, staff renewal, GCP import/marking/ranking, provider auto-detection
and administration, output/report integrity, model and whole-project public
sharing, lifecycle recovery, and serialized desktop/390/320 Edge flows.
It does not replace the real TrueNAS ACL/mount drill.

The candidate's executable and test tree completed the destructive
compatibility gate against
`opendronemap/nodeodm@sha256:b5260d56e96e24fd70a44f5bd892e6f2e3ee8a7a37b1247c1667b7ffc5758361`
on an isolated Docker network. The official ODMdata `banana` starter corpus was
pinned to commit `2778294e4a73aec8f37747e0d2edfc4cb38b23a6`: 16 images,
15,294,677 bytes, sorted content-manifest SHA-256
`0521a4583c8a9bab746ad5c5f4bf45e82547fa5e9c82e0250407f148f07c4013`.
The capability result was NodeODM API `2.2.3`, ODM engine `3.5.0`, 80 options,
and fingerprint
`7e0410ff352d6bdf286b9f1d22de9d2e7408a6275eec1b5ff6d77cc6160f62fe`.
The processing task completed and streamed a 458,039,578-byte `all.zip` with
SHA-256 `0d9b05f801a4179baf65c56a861ce381e79ceb4bdabf9daad5824d341b9561fc`.
The production ZIP path extracted 265 entries totalling 457,991,174 bytes and
discovered EPT, GLB, native 3D Tiles, OBJ, orthophoto, and point-cloud outputs;
a second uploaded and committed task settled at `cancelled`. Both tasks were
removed and the provider task inventory was empty.

The same exact Viewer candidate then passed the full lifecycle through
`opendronemap/clusterodm@sha256:345cde80cd717cd23b207f99d4b49dac57e969d273861662b56c681f733baa9f`
with a registered NodeODM 2.2.3 node. The immutable ClusterODM 1.5.5 image
reported API package `1.5.3`, ODM engine `3.5.0`, 80 options, and capability
fingerprint
`3fae1aa08a4305ed8fa6820745e9967fc0046391e6dbf44ee2db28e263294cd8`.
It completed the same corpus, streamed a 458,488,913-byte `all.zip` with
SHA-256 `fe7c7a6b55938f57667b3fd5c06bffb0236f33d248a5899d36e1597568acc9bc`.
The production ZIP path extracted 263 entries totalling 458,440,895 bytes and
discovered EPT, GLB, native 3D Tiles, OBJ, orthophoto, and point-cloud outputs.
The harness cancelled a second uploaded and committed task and verified both
scheduler and node task inventories empty after removal. The disposable
providers, network, corpus checkout, and rehearsal volumes were removed. These
results prove the small real NodeODM and ClusterODM baseline workflows and cancellation;
representative TrueNAS imagery, GCP/LOD review, and interruption/restart remain
live gates.

The destructive provider runs were recorded on executable commit
`b03bd66b121eecc16b2b1164add335065d998121`. The later evidence-only commit
`b407a9e86729a34108050eaecbc8d38b38374a4a`, runtime-attestation commit
`1bb6681c4b8b54407433e991a5dfcb860ed262c4`, and exact-readiness commit
`72f3d1a9c36a7d366ca3e129d0516f72eb281091`, published-session revocation
commit `f7ecfe9d91ba9189b9093a4894210be2eeaa4f06`, and subsequent hardening commits
through `ad505557ce89c0c6a8aa76777c4a2f7d798e80b5` retain the reviewed provider adapter,
provider harness, or production ZIP ingestion path. The exact final Linux test
and production images, UID-568 volume gate, health/readiness smoke, and scale
rehearsal were last rebuilt and rerun against
`72f3d1a9c36a7d366ca3e129d0516f72eb281091`. The final revocation candidate has
an immutable registry build whose exact digest was pulled back and
identity-verified by its publishing workflow. Identity-bound deployment and
TrueNAS staging rehearsal remain live gates.

## 1. Back up and prove the disabled baseline

1. Back up both Cloudflare D1 databases and the Project Alpha database before
   applying migrations. Record database IDs, migration ledgers, backup IDs,
   row counts, and restore commands.
2. Back up `/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env` and the complete
   `/mnt/Plugins/App_Data/Model-Viewer/Storage` tree as one consistency unit; its
   SQLite database and managed assets must remain together.
3. Confirm the deliberate pre-production staff activation has
   `VIEWER_INTEGRATION_ENABLED=true` and `VIEWER_PROCESSING_ENABLED=true`, and
   confirm these production variables remain the literal string `false`:
   `VIEWER_PUBLIC_SHARES_ENABLED`, `CLIENT_VIEWER_SESSION_ISSUER_ENABLED`,
   `CLIENT_VIEWER_SHARES_ENABLED`, `CLIENT_VIEWER_ENABLED`,
   `CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED`, and Viewer
   `PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED`.
   With `VIEWER_PUBLIC_SHARES_ENABLED=false`, Operations must omit
   `viewer.shares.create` from newly issued staff workspace grants while
   retaining read/revoke access for cleanup of existing links.
4. In Project Alpha confirm the installation-wide portal integration,
   relations, catalog, pricing, draft quote, outbound delivery, and
   authoritative-hook flags are all off. New profiles and profile delivery are
   independently disabled as well.

## 2. Start the Viewer without activating processing

Use the reviewed Viewer Compose file. It runs as TrueNAS Apps UID/GID `568:568`,
has no privileged entrypoint or added capabilities, and bind-mounts the exact
pre-created host path `/mnt/Plugins/App_Data/Model-Viewer/Storage` at
`/app/storage` with automatic host-path creation disabled. The path, sentinel,
managed directories, and ownership must pass the guarded updater checks. If an
older named volume contains real data, copy and verify it first and retain the
old volume until the new catalog and bytes are proven; never silently start an
empty catalog over existing data.

Keep `PROCESSING_PLATFORM_ENABLED=false` for the first boot. The API should
be healthy without the worker or any provider. Verify inside the container:

```sh
id
node scripts/container-healthcheck.js
node scripts/production-readiness.mjs --verify-mount-options
```

The readiness command must report build revision
`ad505557ce89c0c6a8aa76777c4a2f7d798e80b5` and schema version `20`. Confirm
both `/api/v1/health` and `/api/v1/ready` return that exact revision in
`X-LTDS-Viewer-Revision`, `20` in `X-LTDS-Viewer-Schema-Version`, and
`Cache-Control: no-store`. A tag, container creation timestamp, or successful
body alone is not deployment-identity evidence.

Expected identity is `568:568`; `CapEff`, `CapBnd`, and the other capability
sets in `/proc/1/status` must be zero. Confirm the SQLite file is under
`/app/storage/data`, every managed directory is writable, the optional WebODM
Media source is read-only when configured, there is no permanent legacy
Derivatives mount, and direct-IP Host requests fail while the
canonical Viewer host succeeds through external Nginx.

Run the symlink-escape test in this Linux image. Its Windows skip is not
acceptable as production evidence.

## 3. Configure independent secrets

Generate independent random values; none is a Cloudflare API key and none may
be reused:

```sh
openssl rand -hex 32  # Viewer SESSION_SECRET
openssl rand -hex 32  # Ops -> Viewer service HMAC
openssl rand -hex 32  # Viewer -> Ops event HMAC
openssl rand -hex 32  # Viewer provider-credential encryption key
```

The exact mappings are:

| Viewer `viewer.env` | Operations secret/config |
| --- | --- |
| `SERVICE_AUTH_KEY_ID=ops-v1` | `VIEWER_SERVICE_KEY_ID=ops-v1` |
| `SERVICE_AUTH_SECRET` | `VIEWER_SERVICE_HMAC_SECRET` |
| `VIEWER_EVENT_KEY_ID=viewer-v1` | `VIEWER_EVENT_KEY_ID=viewer-v1` |
| `VIEWER_EVENT_SECRET` | `VIEWER_EVENT_HMAC_SECRET` |

Before enabling either integration flag, an Operations administrator with
`viewer.manage` must open **Administration → 3D Viewer** and run **Test Viewer
connection**. This read-only probe remains available while Viewer integration
is disabled. It checks public health, public readiness, and a signed catalog
request without returning model identifiers, mount paths, response bodies, or
secret values.

Use the bounded service-auth result as follows:

- `connected`: the signed catalog request passed; record the model counts as
  staging evidence, but do not infer that processing or sharing is enabled.
- `not_configured`: configure the bare HTTPS Viewer origin, key ID, and shared
  secret on Operations. The origin must contain no path, query, credentials, or
  redirect.
- `authentication_failed`: Viewer or its proxy returned 401/403. Confirm the
  two secret values are byte-identical without printing them; confirm both key
  IDs match the environment-specific configured value (`ops-v1` in production
  or `ops-staging-v1` in isolated staging); synchronize both clocks; and verify
  Nginx preserves the `X-LTDS-*` request headers from its trusted forwarder.
  Rotate by generating one new random value and setting that same value on both
  sides, never by copying either value into a ticket, log, evidence file, or
  browser field.
- `route_not_found`: confirm the reviewed Viewer image is running and Nginx
  forwards `/api/v1/models` unchanged instead of serving an older image or
  rewriting the path.
- `invalid_response`: compare the running Viewer revision/schema headers with
  the frozen candidate and reject the deployment if they differ.
- `unavailable`: confirm DNS/Tunnel/Nginx reachability, no redirect or Access
  interstitial is inserted, and the proxy preserves signed headers. If public
  health and readiness pass but the signed request produces no Viewer access
  log and Operations records `viewer.service.request_failed` at stage `fetch`,
  verify the shared Viewer client invokes a stored native Cloudflare `fetch`
  as an unbound function. Calling it as an object method supplies the wrong
  receiver and Workers throws before dispatching any HTTP request; this is not
  an HMAC mismatch. Inspect only the bounded event, failure kind, stage, and
  upstream status fields; do not add URLs, request headers, response bodies,
  or secret values to logs.

After a Viewer environment change, restart both Viewer services against the
same persistent volume. After an Operations Worker secret change, wait for the
new Worker version to become active. Rerun the preflight and require
`connected`; do not enable a feature flag merely because public health and
readiness pass.

Any change to the shared Viewer service client must pass the focused
`viewer-service.test.ts` suite before deployment. Its native-style fetch
regression requires the injected function to be called without a
`ViewerServiceClient` receiver. After deployment, require this exact preflight
relationship: both public probes are healthy, `serviceAuthReachable` is true,
`serviceAuthStatus` is `connected`, and both model counts are nonnegative
integers (zero is valid for an empty catalog).

`SESSION_SECRET` stays Viewer-only. Set
`PROVIDER_CREDENTIALS_KEY_ID=provider-v1` and the 64-hex
`PROVIDER_CREDENTIALS_KEY`; losing it makes stored provider tokens
unrecoverable. Back it up separately from the database. Use the documented
old-key maps only during a bounded rotation overlap.

For UI-managed on-premises nodes, set the one-time admission boundary:

```env
PROCESSING_PROVIDER_ALLOWED_CIDRS=192.168.50.0/24,192.168.10.0/24
PROCESSING_PROVIDER_TOKENS_JSON={}
```

Administrators can then enter a label, endpoint, and optional token. Viewer
probes `/info` and `/options` before storing the node, detects the supported
NodeODM-compatible direct-node or ClusterODM proxy behavior, and records its
API/engine versions, queue, limits, and processing options. Unsupported or
ambiguous endpoints create nothing. Tokens remain write-only; an endpoint that
successfully probes without authentication stores an explicit no-auth mode.
The detected node is created disabled and can be enabled without another
environment edit or restart. Exact origins remain available for explicitly
reviewed DNS providers.

## 4. Apply migrations with flags still off

Apply each repository's normal migration command and every pending migration
in lexical/ledger order; never cherry-pick only a later file.

- Client/delivery D1: apply all pending migrations through `0147`. The Viewer
  dependency begins at `0138_viewer_model_associations.sql`; `0139` and `0140`
  also carry the thumbnail queue/provenance fixes and must not be skipped.
  `0143` adds the durable association-session revocation outbox and must be
  present before live Viewer session issuance is enabled.
  `0144` adds explicit project/task Viewer grants. `0145` adds the separately
  default-off Project Alpha email-eligibility shell and blacklist records;
  neither migration grants project, delivery, or Viewer data access by itself.
- Operations D1: apply all pending migrations through `0031`. Migration `0026`
  establishes the base
  Viewer permissions.

The Project Alpha delivery-intent wire fixture is LF-pinned at
`packages/shared/fixtures/project-alpha-delivery-intent-v1.json`; its frozen
SHA-256 is `f16d540bcfbcf4c77c356fc37e2c046a23a473ebec701d526e3b8d45f38c90e8`.
- Project Alpha: apply `0066`, `0067`, `0068`, and `0069` through the normal migration
  runner. All are replay-safe but must still be recorded once in the ledger.
- Viewer: startup applies every internal SQLite migration through schema v19;
  verify integrity, foreign keys, and the final schema ledger after restart.

After each database, verify the migration ledger, integrity/foreign-key checks,
new permissions, default-off flag values, and backup restore point. Do not
enable a Client v2 workspace until its existing account has exactly one
operator-selected Project Alpha organization or standalone-client root.

## 5. Live validation in isolated staging

Keep every production gate off while collecting this evidence. Deploy the same
candidate commits and migrations to an isolated staging environment, enable
only the staging capability window needed for the current check, and return
every flag in that window to off before moving to the next boundary. Most
windows contain one flag. Processing and Viewer session/share checks instead
use only the exact dependency sets in `FEATURE_FLAG_DEPENDENCY_WINDOWS`; those
dependencies do not authorize collecting a second evidence gate. Processing
also requires the staging Viewer processing profile and worker for the same
bounded window. Client session/share windows additionally require Viewer
`PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED=true`, so association version
changes immediately revoke older grants and redeemed sessions; migration v17
fails closed on unbound legacy live authorization instead of inventing a
source descriptor. Do not silently add another flag, carry a dependency into the
next check, or interpret a multi-flag staging window as production activation
approval. Do not use production data, production provider
credentials, or production share recipients for these checks. If staging
cannot reproduce a production-only network boundary, use a documented,
time-bounded, one-gate-at-a-time production canary with an assigned operator
and tested rollback; never enable the next production gate merely to unblock
validation of the current one.

Capture request IDs, timestamps, bounded logs, screenshots, and rollback
results for each item:

1. Signed Ops grant, one-time redemption, scoped Viewer session, silent
   renewal, retryable renewal state preservation, expiry, and live revocation.
2. Provider creation through Ops, encrypted credential status (never the
   token), capability probe, probe-before-enable enforcement, worker heartbeat,
   admission/backpressure, cancellation, and a provider restart mid-attempt.
3. A representative large drone dataset upload/finalize/reselect/resume,
   actual disk preflight, immutable manifest/EXIF-GPS index, a new attempt for
   every retry, native ODM EPT/3D Tiles/GLB ingestion, and sanitized bounded
   logs/callback retries.
4. GCP CSV or GeoJSON import, private source image reads, pixel
   correspondences, immutable attempt snapshot, NodeODM `gcp_list.txt`, and
   cross-dataset denial. Keep canonical elevations in metres while proving both
   imperial-default and metric UI editing.
5. Review the exact unpublished attempt/version through the admin-only embedded
   review session, including transient renewal without camera-state loss and
   immediate invalidation on publish/cancel/version change. Then publish
   selected derived outputs only. Prove review creates no public share and raw
   imagery, GCP files, provider archives, logs, and processing internals cannot
   be reviewed or shared.
6. Real point-cloud and mesh viewing on desktop and mobile: protected range
   requests, nested EPT/3D Tiles children, close-range full-detail LOD evidence,
   zoom-out quality reduction, and point-cloud camera framing.
7. Public share expiry, never-expire, password attempts/rate limits,
   revocation, hash-only storage/abuse keys, large byte ranges, and no cache of
   capability URLs.
8. Stop every processing provider and prove already-published Ops, Client, and
   public viewing remain usable.
9. Kill API/worker processes at upload promotion, provider submission, result
   ingestion, callback, trash, restore, and purge boundaries. Restart and prove
   lease/journal reconciliation without duplicate upstream tasks or lost
   bytes.
10. Project Alpha two-profile isolation, signed exact-body delivery, retry and
    dead-letter behavior, disable/unlink revocation priority, ordinary
    hierarchy mutation fan-out, and concurrent reparent serialization.

## 6. Activation and rollback

Enable only one boundary at a time after its evidence is accepted. Start with
staff Viewer integration, then processing administration, then authenticated
Client sessions, and public shares last. Enable Viewer published-session source
revocation before any session/share issuer window and keep its Delivery D1
revocation outbox draining until every prior association version is
acknowledged; disabling issuance must not strand pending revocations. Project Alpha profile and module
switches remain independently scoped per integration profile.

Rollback is flag-first for Viewer, Operations, and Client: disable the affected
gate without deleting catalogs, associations, sessions, outbox rows, migration
ledgers, or storage. Stop processing admission before the worker, preserve the
Viewer volume, and allow already-published viewing to continue. Investigate
and reconcile durable operations before retrying activation; never repair by
deleting an in-flight journal row.

Project Alpha delivery is the ordering exception. First disable the affected
profile's projection authority so it transactionally queues scoped unlink or
profile tombstones. Keep that profile's delivery and the global
`portal_outbound_delivery_enabled` gate on until every revocation tombstone is
acknowledged downstream. Only then disable profile/global outbound delivery.
Turning delivery off first can strand stale downstream authority.
