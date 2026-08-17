# 3D processing and model-delivery requirements matrix

This matrix is the completion ledger for the locked processing-platform plan.
It is intentionally stricter than a test summary: a feature is not marked
complete merely because an API route or UI card exists. Each row must have
source, contract, test, and (where applicable) live-environment evidence.

Status meanings:

- **Proven** — implemented with local contract and regression evidence.
- **In progress** — a confirmed source or UI gap is being closed.
- **Live gate** — source is complete, but the real TrueNAS, Cloudflare, or ODM
  environment must supply evidence before activation.
- **Sample gate** — implementation would require inventing a vendor format;
  work waits for a representative user-supplied sample.

All processing, Viewer-public-share, client-Viewer, and Project Alpha adapter
flags remain default-off until the staging evidence contract passes. Existing
published-model viewing must remain independent of every processing provider.

| Locked requirement | Status | Required evidence |
| --- | --- | --- |
| Stable LTDS Project and Task identities; friendly names do not affect URLs, storage, shares, or provider mappings | In progress | Viewer migrations/repository invariants; project/task rename propagation and association tests |
| Dataset upload, resumable chunks, exact finalize, manifest/checksum, EXIF/GPS index, reuse | Proven | Durable upload/finalize tests, hash-bound manifests, GCP image-index tests |
| Managed, adopted, and external-reference ownership from the initial schema | Proven | Dataset/storage schema, immutable reference and lifecycle tests |
| Server import roots without arbitrary host paths | Proven | Alias-only API, traversal/symlink/special-file tests, durable exact-content preview/adopt operations |
| Same-filesystem atomic adoption and crash-safe source consumption | In progress | Move/copy selection, journal/recovery and duplicate-prevention fault tests |
| Existing WebODM mounted-tree scan without requiring API credentials | In progress | Read-only tree scanner, unmapped candidates, repeat-scan duplicate tests |
| Permanent WebODM mapping to existing or new LTDS Project and friendly Task | In progress | Durable mapping operation, stable mapping row, Ops desktop/mobile workflow |
| DJI Terra output discovery/import into the same Project/Task/model catalog | In progress | Candidate scan, external/adopted ownership, asset registration, review/publish tests |
| Local upload and import operations never block normal API requests | Proven | Separate durable operation worker lane, 202 polling, cancellation/restart tests |
| NodeODM/ClusterODM provider abstraction and LTDS admission ahead of upstream scheduling | In progress + live gate | Source contract tests, `/info.maxImages`, LTDS high-water and active-storage reservation enforcement, plus real NodeODM 2.2.3 and ClusterODM 1.5.5 probes/jobs |
| Restart-safe init/upload/auxiliary/commit reconciliation; every retry is a new attempt | Proven | Submission-phase checkpoints, ambiguity restart, lease/fencing/fault tests |
| Bounded streamed `all.zip` ingestion without retaining a duplicate archive | Proven + live gate | Safe streaming ZIP tests and representative large-result interruption test |
| Native EPT, GLB and 3D Tiles requested; full-detail LOD equivalence fails closed | Proven + live gate | Capability validation, LOD-v2 proof tests, representative real model close-range QA |
| Provider `/options`, boolean-false preservation, familiar grouped controls, built-in and reusable presets | In progress | Upstream source evidence, custom preset CRUD, capability binding and responsive UI tests |
| Provider credentials, endpoints, probe, enable/disable, rotation and admission managed after bootstrap in Ops UI | Proven | Encrypted credential storage, private DTO, probe-before-enable and browser tests |
| Provider metadata/admission edits and scheduled health refresh remain manageable from Ops after bootstrap | In progress | Edit/probe/enable CAS tests, durable health refresh, desktop/mobile Settings workflow |
| Provider outage cannot break health or already-published viewing | Proven + live gate | Separate readiness paths, outage tests, staging provider-loss asset/session check |
| GCP generic CSV/GeoJSON, canonical meters, map/pixel marking, EXIF proximity without visibility claims | Proven | Viewer/Operations route, trigger, parser, conversion and responsive browser tests |
| Emlid parser | Sample gate | Representative Emlid export supplied by the user; no schema is guessed |
| Processing progress/logs, bounded sanitization/retention, retry/cancel, completion/failure notifications | Proven + live gate | Durable callback/outbox tests; staging in-app and email delivery evidence |
| Task creation plus its first attempt is one recoverable, subject-scoped submission | In progress | Atomic compound submission, lost-response replay across session renewal, conflict and orphan-prevention tests |
| Review before publication; only selected derived outputs can become public | In progress | Short-lived unpublished admin review session, embedded Viewer state/renewal tests, plus model/asset publication allowlist and raw-input exclusion tests |
| Model versions and output lifecycle; archive, recoverable trash, restore and explicit purge | Proven | Two-phase journal and crash/restart fault suite |
| Dataset/output/project/task/cache storage accounting and disk-space preflight | Proven + live gate | Repository/preflight tests plus real TrueNAS `statfs` and reserve evidence |
| Imperial default and metric option for distance, elevation, area, volume, GCP and DEM/point-cloud displays | Proven + browser live gate | Central formatters/unit propagation plus desktop/mobile end-to-end toggling |
| LTDS Worker remains identity/control plane; large assets flow Browser → Cloudflare/Nginx → TrueNAS | In progress + live gate | Range/no-store authorization tests, bounded immutable-integrity verification without full-file rehash per range, and production network trace |
| Short-lived sessions, silent renewal, preserved state on retryable refresh failure, live revocation | Proven, browser verification in progress | Exact-origin/source postMessage tests and real iframe renewal-state browser tests |
| Staff public shares: expiry, never-expire, access code, revocation, download/units policy | Proven + live gate | Viewer/Ops contract tests and staging expiry/revocation/abuse exercise |
| Client-created Viewer shares are distinct, owner-audited, and cannot outlive their exact source grant | In progress | Explicit opt-in portal `viewer.share.create` entitlement; Client/Operations/Viewer bound authorization flow; coalesced maximum-five-second positive validation lease; revocation tests |
| Durable privacy-safe abuse controls around public unlock/assets and grant redemption | In progress | Shared-SQLite/restart rate-window tests; no raw token in keys/logs |
| Ops administration: Projects, Datasets, Processing, Imports, Models/Tasks, Shares, Providers, Settings | In progress | Complete desktop, tablet, 390 px and 320 px browser workflows |
| Project Alpha adapter remains generic, profile/workspace isolated, signed, default-off and independently deployable | Proven locally + live gate | Neutral fixtures, exact HMAC/key overlap, MySQL migrations and full PHP suite; staging sender/receiver exercise remains |
| PA authoritative mutations fail closed with audit/outbox in the same transaction | Proven | Injected outbox/audit failure rollback tests and exact-image contract suite |
| PA complete snapshots plus incremental upsert/tombstone events | Proven locally + live gate | Cross-profile/root event ordering, replay and revocation tests; staging interruption/resume remains |
| PA pricing/draft commands: exact scope/HMAC, replay/conflict/rate/stale handling, complete audit/correlation | Proven locally + live gate | Current/previous key tests and exact normative response corpus; staging command exercise remains |
| TrueNAS rootless UID/GID 568, one durable volume, immutable image, health-gated update/rollback and backup/restore helpers | Proven + live gate | Exact Linux image/volume tests plus real host backup/restore drill |
| Cloudflare DNS/Tunnel/Access/CORS/WAF/rate limits and matching secrets/key overlap | Live gate | Staging evidence packet; production stays off while collecting |
| Client and Ops D1 migrations, PA 0066/0067/0068 and Viewer schema migration/replay | Proven locally + live gate | Fresh/replay clone evidence, then backup and remote migration ledgers |
| Representative large drone/GCP corpus through real provider, Viewer, Client Portal and public link | Live gate | Actual processing, callback, publish, range assets, mobile/desktop and revocation evidence |

## Upstream contract evidence

The provider adapter follows the primary NodeODM API contract for `GET /info`,
`GET /options`, `POST /task/new/init`, multipart
`POST /task/new/upload/{uuid}`, `POST /task/new/commit/{uuid}`,
`GET /task/{uuid}/info`, `GET /task/{uuid}/output`, cancel/remove, and streamed
`GET /task/{uuid}/download/all.zip`. NodeODM `v2.2.3` and ClusterODM `v1.5.5`
are tested baselines, not hard production lockouts. Runtime capability probes
remain authoritative; a real-provider compatibility run is still required.

## Activation rule

Only an isolated staging deployment may turn on one corresponding staging
gate while collecting its evidence. Production flags remain off. Any candidate
commit, image digest, fixture, migration, or secret-name change invalidates the
frozen release packet and requires a new full matrix run.
