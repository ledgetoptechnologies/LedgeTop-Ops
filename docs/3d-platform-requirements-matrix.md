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
- **Retired** — an earlier requirement was deliberately removed from the
  operator workflow and is retained only as compatibility code where noted.

All staging processing, Viewer-public-share, client-Viewer, and Project Alpha
adapter flags remain default-off until the staging evidence contract passes.
The existing pre-production staff Viewer/processing installation is a documented
operational exception; it does not authorize a staging or public/client flag.
Existing published-model viewing must remain independent of every processing
provider.

| Locked requirement | Status | Required evidence |
| --- | --- | --- |
| Stable LTDS Project and Task identities; friendly names do not affect URLs, storage, shares, or provider mappings | Proven | Viewer migrations/repository invariants; project/task rename propagation and association tests |
| Dataset upload, resumable chunks, exact finalize, manifest/checksum, EXIF/GPS index, reuse | Proven | Durable upload/finalize tests, hash-bound manifests, GCP image-index tests |
| Managed, adopted, and external-reference ownership from the initial schema | Proven | Dataset/storage schema, immutable reference and lifecycle tests |
| Server import roots without arbitrary host paths | Proven | Project-first UI explicitly queues the durable structured folder/ZIP importer with no false preview claim; generic route plus legacy alias, traversal/symlink/special-file rejection, validation, adoption, receipts and crash recovery are tested |
| Same-filesystem atomic adoption and crash-safe source consumption | Proven | Move/copy selection, durable adoption-intent reconciliation, restart recovery and duplicate-prevention fault tests |
| Existing WebODM mounted-tree scan without requiring API credentials | Retired | The user-facing scan control and permanent WebODM mount were removed; generic managed-folder/ZIP import remains. Compatibility scanner code is not an activation dependency |
| Permanent WebODM mapping to existing or new LTDS Project and friendly Task | Retired | Replaced by explicit import into a selected LTDS Project/Task; no live WebODM API or permanent source mapping is required |
| DJI Terra output discovery/import into the same Project/Task/model catalog | Proven + live gate | Candidate scan, external/adopted ownership, asset registration, review/publish and crash-recovery tests; representative Terra export remains live evidence |
| Local upload and import operations never block normal API requests | Proven | Separate durable operation worker lane, 202 polling, cancellation/restart tests |
| NodeODM/ClusterODM provider abstraction and LTDS admission ahead of upstream scheduling | Proven + live gate | Source contract tests, `/info.maxImages`, LTDS high-water and active-storage reservation enforcement, real isolated NodeODM 2.2.3 and ClusterODM 1.5.5 capability plus 16-image job/download/cancel/verified cleanup; representative TrueNAS job remains live evidence |
| Restart-safe init/upload/auxiliary/commit reconciliation; every retry is a new attempt | Proven | Submission-phase checkpoints, explicit private/provider input roles, ambiguity restart, lease/fencing/fault tests |
| Bounded streamed `all.zip` ingestion without retaining a duplicate archive | Proven + live gate | Safe streaming ZIP tests plus real NodeODM and ClusterODM streamed archives parsed through the production ZIP path; representative large-result interruption test remains live |
| Native EPT, GLB and 3D Tiles requested; missing LOD is generated once and full-detail equivalence fails closed | Proven + live gate | Capability validation, pinned Obj2Tiles runtime, classic-EPT Potree correction, one-attempt/manual-retry policy, bounded existing-model backfill, native-tile audit/quarantine, GLB fallback and LOD-v2 worker/proof tests are proven; exact GHCR attestation, representative deployed EPT render, generated/backfilled close-range model QA and TrueNAS worker restart remain live evidence |
| Provider `/options`, boolean-false preservation, familiar grouped controls, built-in and reusable presets | Proven + live gate | Custom preset CRUD, capability binding and responsive UI tests; real-provider option corpus remains live evidence |
| NodeODM/ClusterODM type is detected from one Add Node form | Proven + live gate | Label, endpoint, and optional token only; `/info` plus `/options` positive evidence, safe ambiguous-endpoint rejection, explicit no-auth mode, and real provider probe remain the live gate |
| Provider credentials, endpoints, probe, enable/disable, rotation and admission managed after bootstrap in Viewer UI | Proven + live gate | Reachable project-first UI covers endpoint/label/admission editing, encrypted write-only token rotation/removal, auto-detect-before-save, probe, enable/disable and capability-bound preset CRUD; live provider mutation remains staging evidence |
| Provider metadata/admission edits and scheduled health refresh remain manageable after bootstrap | Proven + live gate | Backend edit/probe/enable CAS, durable health refresh and desktop/390/320 management workflows are proven; a live provider probe remains evidence |
| Provider outage cannot break health or already-published viewing | Proven + live gate | Separate readiness paths, outage tests, staging provider-loss asset/session check |
| GCP generic CSV/GeoJSON, canonical meters, map/pixel marking, EXIF proximity without visibility claims | Proven + live gate | Parser/conversion, adaptive/radius/nearest ranking, private source-image bearer flow, native-pixel click/numeric create-update-delete marking, immutable attempt snapshots, responsive source tests and real Edge workflow are proven; representative field imagery remains live evidence |
| Emlid all-columns parser | Proven | The user-supplied Rome Dam export locks Name, CS name, Easting, Northing, Elevation, Latitude, Longitude, ellipsoidal height, explicit m/ftUS handling, preview/confirm provenance, mixed-CRS rejection, and tests |
| Processing progress/logs, bounded sanitization/retention, retry/cancel, completion/failure notifications | Proven + live gate | Transaction-owned terminal state, callback/outbox and audit rollback tests; staging in-app and email delivery evidence |
| WebODM-style authoritative task metrics | Proven + live gate | Bounded optional `odm_report/stats.json` and `odm_georeferencing/proj.txt` ingestion persists GSD, area, point count, and CRS on the immutable version; imperial/metric dashboard rendering is tested; representative provider output remains live evidence |
| Task creation plus its first attempt is one recoverable, subject-scoped submission | Proven | Atomic compound submission, subject-durable draft creation for GCP-before-attempt ordering, lost-response replay across session renewal, conflict and orphan-prevention tests |
| Review before publication; only selected derived outputs can become public | Proven + live gate | Short-lived unpublished admin review session, dedicated Viewer-tab state/renewal tests, atomic attempt/model/version/output publication, asset allowlist and raw-input exclusion tests; representative rendered model remains live evidence |
| Model versions and output lifecycle; archive, recoverable trash, restore and explicit purge | Proven + live gate | Project-first permission/status-aware archive and trash actions, confirmations, read-only archived state, fully paged trash, restore, typed purge, failed-mutation details/retry, API fault coverage and desktop/390/320 Edge workflows are proven; real TrueNAS recovery remains live evidence |
| Dataset/output/project/task/cache storage accounting and disk-space preflight | Proven + live gate | Adopted/external tree de-duplication, project/task/output repository and preflight tests, guarded 100,000-file disposable-volume rehearsal, plus real TrueNAS `statfs`, throughput and reserve evidence |
| Imperial default and metric option for distance, elevation, area, volume, GCP and DEM/point-cloud displays | Proven + deployed rendering gate | Central formatters/unit propagation plus local desktop/mobile end-to-end toggling proves preference persistence, session/renewal/share propagation, metric display and canonical-metre GCP writes; representative deployed renderer surfaces remain live evidence |
| LTDS Worker remains identity/control plane; large assets flow Browser → Cloudflare/Nginx → TrueNAS | Proven + live gate | Chunk-bound Range/no-store authorization tests and bounded immutable-integrity verification; production network trace remains live evidence |
| Short-lived sessions, silent renewal, preserved state on retryable refresh failure, live revocation | Proven + live gate | Exact-origin/source new-tab postMessage and desktop/mobile mounted-state renewal tests; deployed tab revocation remains live evidence |
| Staff public shares: expiry, never-expire, access code, revocation, download/units policy | Proven + live gate | Viewer/Ops contract tests and staging expiry/revocation/abuse exercise |
| Whole-project public share | Proven + live gate | A separate hash-only project-share schema dynamically resolves current active-published task versions, authorizes only published public derivatives on every asset request, supports password/expiry/revocation and future publications, keeps task/client grants separate, and passes API plus desktop/390/320 Edge workflows; deployed expiry/revocation/version-switch evidence remains live |
| Client-created Viewer shares are distinct, owner-audited, and cannot outlive their exact source grant | Proven + live gate | Explicit opt-in portal `viewer.share.create` entitlement, bound authorization, maximum-five-second positive lease and revocation tests; staging authorization loss remains live evidence |
| Durable privacy-safe abuse controls around public unlock/assets and grant redemption | Proven + live gate | Shared-SQLite/restart rate-window tests and hash-only token keys; deployed WAF/rate behavior remains live evidence |
| Dedicated Viewer administration: Dashboard, project/task workflow, sharing, Providers, Diagnostics | Proven + live gate | Complete paged catalog/search, shared staff visibility, task metrics/history/live log tail, device/server imports, GCP marking, output/report access, review/share, provider/token/preset administration, typed trash lifecycle and real Edge desktop/390/320 workflows are proven; deployed responsive/provider/model evidence remains live |
| Project Alpha adapter remains generic, profile/workspace isolated, signed, default-off and independently deployable | Proven locally + live gate | Neutral fixtures, exact HMAC/key overlap, MySQL migrations and full PHP suite; staging sender/receiver exercise remains |
| PA authoritative mutations fail closed with audit/outbox in the same transaction | Proven | Injected outbox/audit failure rollback tests and exact-image contract suite |
| PA complete snapshots plus incremental upsert/tombstone events | Proven locally + live gate | Cross-profile/root event ordering, replay and revocation tests; staging interruption/resume remains |
| PA pricing/draft commands: exact scope/HMAC, replay/conflict/rate/stale handling, complete audit/correlation | Proven locally + live gate | Current/previous key tests and exact normative response corpus; staging command exercise remains |
| TrueNAS rootless UID/GID 568, fixed durable host bind, source-attested image, health-gated update/rollback and backup/restore helpers | Proven + live gate | Exact Linux suite (including real symlink semantics), `/mnt/Plugins/App_Data/Model-Viewer/Storage` bind checks, revision/schema health attestation, plus real host ACL and backup/restore drill |
| Cloudflare DNS/Tunnel/Access/CORS/WAF/rate limits and matching secrets/key overlap | Live gate | Staging evidence packet; production stays off while collecting |
| Client and Ops D1 migrations, PA 0066–0075 and Viewer schema migration/replay | Proven locally + live gate | Fresh/replay clone evidence, then backup and remote migration ledgers |
| Representative large drone/GCP corpus through real provider, Viewer, Client Portal and public link | Live gate | Actual processing, callback, publish, range assets, mobile/desktop and revocation evidence |

## Upstream contract evidence

The provider adapter follows the primary NodeODM API contract for `GET /info`,
`GET /options`, `POST /task/new/init`, multipart
`POST /task/new/upload/{uuid}`, `POST /task/new/commit/{uuid}`,
`GET /task/{uuid}/info`, `GET /task/{uuid}/output`, cancel/remove, and streamed
`GET /task/{uuid}/download/all.zip`. NodeODM `v2.2.3` and ClusterODM `v1.5.5`
are declared compatibility baselines, not hard production lockouts. Runtime
capability probes remain authoritative. The pinned NodeODM 2.2.3 baseline and
the ClusterODM 1.5.5 image with a registered NodeODM 2.2.3 node have both passed
the repository's real small-corpus processing, streamed-download,
committed-task cancellation, and verified-removal gate. The ClusterODM image
reports API package 1.5.3 at runtime; the immutable image digest and observed API
version are both retained as evidence. The actual TrueNAS/provider deployment
still requires its own compatibility and representative-corpus evidence.

## Activation rule

Only an isolated staging deployment may turn on one corresponding staging
gate while collecting its evidence. The staff Viewer integration and
processing gates are deliberately enabled for pre-production validation;
new public-share, Client Viewer, and Project Alpha adapter gates remain off.
Any candidate
commit, image digest, fixture, migration, or secret-name change invalidates the
frozen release packet and requires a new full matrix run.
