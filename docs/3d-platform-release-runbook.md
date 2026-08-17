# 3D processing and delivery release runbook

Status: **release remediation is active; live staging evidence and activation
remain pending**. Every
Viewer, Operations, Client, processing, public-share, and Project Alpha portal
feature gate remains off until the corresponding live evidence below is
captured.

## Frozen source candidates

- 3D Viewer: `8f6c4025368f0157bcd1e1c575d2fb4fab56564c` and
  `ghcr.io/ledgetoptechnologies/3d-viewer:sha-8f6c402@sha256:994f6dbba8995e083df0bc1da634fb50ee1e46217a1e3633a1761199f533381a`
- LTDS-Ops product code: `be786b724d13838dc54023e0ee0a194c83fae6a8` on
  `codex/3d-processing-control-plane`. The final pin must contain the desktop
  Administration-menu fix equivalent to `09e3443`; never substitute a mutable
  branch tip.
- Project Alpha: `769df9320dbf4dfc512d364173d5cb7d8ad8a97c` on `main`

The corresponding constants in `scripts/staging-requirements.mjs` intentionally
remain unfrozen with `RELEASE_CONTRACT_FINALIZED=false` while Viewer and Ops
remediation is active. Set it to `true` only after every immutable pin is final
and independent cross-repository verification has been repeated.

The Viewer/Ops signed-processing corpus has SHA-256
`13ab12919e624be6a048c058774ccff2031f865855e64ab3b726e9b31cffab82`.
The route-response corpus has SHA-256
`26ba67c5ecc3a534e3c067a6b4b0cd80e2d3823d766830edc3fe77ce71152b5e`.
The five generic Project Alpha fixtures are byte-pinned by both repositories.
Do not substitute a later commit or hand-edit a fixture during activation.

## 1. Back up and prove the disabled baseline

1. Back up both Cloudflare D1 databases and the Project Alpha database before
   applying migrations. Record database IDs, migration ledgers, backup IDs,
   row counts, and restore commands.
2. Back up `/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env`. After the
   first Viewer start, back up the complete `ltds-viewer-storage` Docker volume
   as one unit; its SQLite database and managed assets must remain consistent.
3. Confirm these production variables remain the literal string `false`:
   `VIEWER_INTEGRATION_ENABLED`, `VIEWER_PROCESSING_ENABLED`,
   `VIEWER_PUBLIC_SHARES_ENABLED`, `CLIENT_VIEWER_SESSION_ISSUER_ENABLED`,
   `CLIENT_VIEWER_SHARES_ENABLED`, and `CLIENT_VIEWER_ENABLED`.
4. In Project Alpha confirm the installation-wide portal integration,
   relations, catalog, pricing, draft quote, outbound delivery, and
   authoritative-hook flags are all off. New profiles and profile delivery are
   independently disabled as well.

## 2. Start the Viewer without activating processing

Use the reviewed Viewer Compose file, not the superseded bind-mount/root
bootstrap version. It runs as TrueNAS Apps UID/GID `568:568`, has no privileged
entrypoint or added capabilities, and lets Docker create the fixed
`ltds-viewer-storage` volume. Do not retain old `/app/data`, `/app/datasets`,
or `/app/models` bind mounts. If they contain real data, stop and migrate it
before switching; never silently start an empty catalog over existing bytes.

Keep `PROCESSING_PLATFORM_ENABLED=false` for the first boot. The API should
be healthy without the worker or any provider. Verify inside the container:

```sh
id
node scripts/container-healthcheck.js
node scripts/production-readiness.mjs --verify-mount-options
```

Expected identity is `568:568`; `CapEff`, `CapBnd`, and the other capability
sets in `/proc/1/status` must be zero. Confirm the SQLite file is under
`/app/storage/data`, every managed directory is writable, WebODM Media and
legacy Derivatives are read-only, and direct-IP Host requests fail while the
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

Administrators can then create a disabled IP-literal node, store or rotate its
token, probe it, and enable it from Ops without another environment edit or
restart. Exact origins remain available for explicitly reviewed DNS providers.

## 4. Apply migrations with flags still off

Apply each repository's normal migration command and every pending migration
in lexical/ledger order; never cherry-pick only a later file.

- Client/delivery D1: apply all pending migrations through `0142`. The Viewer
  dependency begins at `0138_viewer_model_associations.sql`; `0139` and `0140`
  also carry the thumbnail queue/provenance fixes and must not be skipped.
- Operations D1: apply all pending migrations through `0029`. Migration `0026`
  establishes the base
  Viewer permissions.
- Project Alpha: apply `0066`, `0067`, and `0068` through the normal migration
  runner. All are replay-safe but must still be recorded once in the ledger.
- Viewer: startup applies every internal SQLite migration through schema v15;
  verify integrity, foreign keys, and the final schema ledger after restart.

After each database, verify the migration ledger, integrity/foreign-key checks,
new permissions, default-off flag values, and backup restore point. Do not
enable a Client v2 workspace until its existing account has exactly one
operator-selected Project Alpha organization or standalone-client root.

## 5. Live validation in isolated staging

Keep every production gate off while collecting this evidence. Deploy the same
candidate commits and migrations to an isolated staging environment, enable
only the staging gate needed for the current check, and return it to off before
moving to the next boundary. Do not use production data, production provider
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
Client sessions, and public shares last. Project Alpha profile and module
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
