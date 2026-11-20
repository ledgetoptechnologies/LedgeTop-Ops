# Ledge Top flight logs on the NAS (local Logs host)

Flight logs run on the NAS as one container in the existing `lt-ops-workers` stack. Ops shows them through the
Tunnel. Controllers upload through the existing public device hostname, whose Worker forwards to this host. No
Cloudflare D1/R2 is used for this data. Merger handles the backend release and Access setup; Beau handles the NAS
tunnel connection. The Compose addition publishes no host ports; connect the tunnel through the NAS networking
configuration before activation.

## What runs
- **Node 24 only**, with no npm packages. It uses `node:sqlite` (WAL, synchronous FULL) for the ledger and a local
  object store for originals and tracks.
- **Originals are kept forever.** Nothing is ever evicted. Near a full disk, uploads pause with 503 + Retry-After and
  the controller keeps its queue.
- **Every request is authorised at this host.** It must carry a Cloudflare Access service token: the Ops server's
  identity, or the device proxy's. Anything else gets a 404. There is no public health route; health is only on
  `127.0.0.1:8081` inside the container.
- **The decoder runs in the same process, one log at a time, with RAM-only scratch.**
  - With no DJI key it waits (`waiting_for_key`) and touches no queued log.
  - The `keyless` image has no native parser at all (`parser_unavailable`).
  - Decoded logs are never given to the uploader. They are unassigned until an administrator assigns them, linked to
    a matching flight of the same owner, or flagged as a conflict.

## Images
```
docker build -f apps/logs-local/Dockerfile --target keyless .   # first Stage pilot: no native parser (dev / admitted builds only)
docker build -f apps/logs-local/Dockerfile --target full .      # adds the reviewed DJI parser build
```
Both run as UID 568, on the base image pinned by digest in the Dockerfile. Builds only happen in a window Merger admits.

On the NAS, nothing is built: `compose.service.yaml` runs the image published by the main-only publisher, pinned by
digest (`pull_policy: missing`). `compose.dev.yaml` is a development/pilot build example only.

Tags: every qualifying merge to main publishes immutable tags only: `sha-<commit>-<target>` and
`candidate-<commit>-<run>-<attempt>-<target>`, plus a deployment receipt. `latest` (what the server stack in
`apps/media-generation` pulls) moves **only** by the hand-run `promote-logs-local.yml`, to one verified full candidate,
with a rollback receipt recorded first (Beau's decision, the same rule as the Viewer). The first promotion sets
`initialize_latest`, because `latest` does not exist yet. Rollback is a promotion of an older candidate.
The full native parser image requires an **amd64 NAS**. Verify the NAS architecture before activation; the service
declares `platform: linux/amd64`, and emulated execution has not been qualified.

Beau approved public, code-only GHCR runtime images for now. The main-only publisher verifies the package is
`public`, owned by the expected organization and linked to this repository before it records a receipt or writes a
candidate tag. It only observes visibility; it does not change package permissions or visibility. The image contains the
runtime source, migrations and (for `full`) native parser; application data, filled configuration and keys belong
only in runtime mounts and secrets, never in the build context's copied inputs or image layers.

Making this repository private later does not make the runtime package private or remove public images, source
layers, provenance or copies already downloaded. Revisit the package policy explicitly before any future change
that assumes runtime code is private. A package visibility mismatch stops this publisher instead of changing it.

## Folders
The stack mounts `/mnt/Plugins/App_Data/LedgeTop-Ops-Workers` at `/app-data` (the same mount the other worker services use). The container can see the sibling folders
there; this is application-level confinement, not filesystem isolation. Logs only ever uses:

```
/app-data/flight-logs/
  db/logs.sqlite      ledger (keep on a local dataset; never SMB/NFS)
  objects/            originals (raw/), tracks, and the object index
  config/logs.env     this app's configuration (0600)
```
The parent dataset must already exist: the Compose bind uses `create_host_path: false` so a missing path fails
instead of silently creating a directory on the Docker host. On first start the app creates its own child folders
as UID 568. If the parent is not writable by UID 568, it stops with a clear
message. It never changes permissions or ownership and never runs ZFS commands. These are ordinary folders, not
datasets.

## First start and configuration
1. **First start.** The app creates its folders, writes `config/logs.env` once as a blank template (0600), and stays
   up **closed**: every request gets 404, health reports `unconfigured`, and one log line (`settings_incomplete`) says
   the settings are incomplete. The template is never overwritten. After filling it, restart the container (or send
   `docker kill -s HUP <container>`); any missing security value keeps it closed, and `/healthz` and the log line
   name the REQUIRED keys that are still blank (names only, never values).
2. **Required lines.** `LOGS_INGRESS_HOST`, `ACCESS_AUDIENCE`, `OPS_DIRECTORY_CLIENT_ID`, `OPS_DIRECTORY_CLIENT_SECRET`, plus
   the token profile, plus `DJI_API_KEY` to decode:
   - `ACCESS_TOKEN_PROFILE=single` is the operator's explicit choice of **one Access service token for everything**: the
     directory token's client id is also the id accepted from Ops (staff routes, actor required) and the device proxy
     (device routes, no actor). The proxy id lines must then be blank or equal to it. Trade-off: one credential works in
     both directions, and rotating it means replacing it everywhere at once.
   - Blank or `separate` (the default) keeps the earlier rule exactly: `ACCESS_STAFF_PROXY_CLIENT_ID` and
     `ACCESS_DEVICE_PROXY_CLIENT_ID` are both required, distinct, and different from the directory token. Blank lines
     never widen scope, so an upgraded file keeps its effective scope until the operator sets `single`.
   - `ACCESS_ISSUER` has a built-in default. `OPS_DIRECTORY_BASE_URL` defaults to **production** (`https://ops.ledgetop.app/`):
     **staging must set its own Ops origin.** The closed and ready reports (`/healthz`, the log lines) show the
     effective `directoryOrigin` and `tokenProfile` (never a secret); check them before any connected test.

   - **Shared NAS link file (recommended).** The stack passes one `env_file` (see
     `apps/media-generation/nas-link.env.example`) to every networked container. `NAS_LINK_CLIENT_ID` /
     `NAS_LINK_CLIENT_SECRET` (the one token), `NAS_LINK_AUDIENCE`, `OPS_BASE_URL` and the Compose `LOGS_INGRESS_HOST`
     fill the matching blank lines here, so `logs.env` usually needs only `DJI_API_KEY`. Setting `NAS_LINK_CLIENT_ID` is
     the explicit choice of the single profile. A different non-blank value in `logs.env`, or
     `ACCESS_TOKEN_PROFILE=separate`, is a conflict and keeps Logs closed; an existing file without the link keeps its
     prior scope. The reports show `nasLink: true|false`.

   Blank or invalid machine credentials keep the app closed. Authentication is never switched off.
   **Upgrades never touch a value:** on start, an existing file only gains the keys it lacks, appended at the end with
   their comments (written beside it and renamed over it, same mode; a failed write leaves it as it was).
   `KEYCHAIN_ENCRYPTION_KEY` is no longer generated but is still honoured if present.
3. **Upload concurrency.** The application default is 4. For a 1 CPU / 1 GiB profile set `UPLOAD_CONCURRENCY=1`.
4. **DJI key.** Leave `DJI_API_KEY` blank to start keyless; uploads, history and the Ops API all work. To start
   decoding later, put the key in the file. Then send `docker kill -s HUP <container>` to apply only the key, or
   restart the container to apply everything.
5. **Check status.** The app logs event codes only, never values. `docker inspect --format '{{.State.Health.Status}}'`
   reports liveness only: a closed (unconfigured) host is alive and healthy. Readiness is separate: inside the
   container `/readyz` on 127.0.0.1:8081 answers 200 only when the settings are complete and the host is serving
   (503 while closed), and `/healthz` reports `"configured": true|false`. Check readiness with
   `docker exec <container> node -e "fetch('http://127.0.0.1:8081/readyz').then(r => process.exit(r.ok ? 0 : 1))"`.

## Moving from the pilot profile
The pilot profile mounted the same App_Data parent at `/data` and published `127.0.0.1:18087 -> 8080`. The data
lives in the **host** folder `<App_Data parent>/flight-logs/` either way; only the path inside the container changes.
1. Stop the pilot container (nothing is deleted).
2. Mount the same host parent at `/app-data` instead of `/data`. The ledger, originals and `config/logs.env` are found
   in place: object keys are stored relative to the folder, and a pilot `logs.env` that names
   `LOGS_DATA_DIR=/data/flight-logs` is read as the new `/app-data/flight-logs`. Nothing is copied or rewritten.
3. Ports: keep `127.0.0.1:18087` if the tunnel connector runs on the same host network; use the LAN-bound port of the
   stack (`<LAN address>:8090`) if the connector runs elsewhere. Point the tunnel origin at whichever you publish.
   Only one container may use the folder at a time.
4. Start, then check `/readyz` as above.

This file is read by the app itself. It is **not** a Compose `.env`: Compose never interpolates it, so values don't
show up in `docker inspect`.

Editing the file over SMB depends on the share user mapping to UID 568. That hasn't been tested yet, and no
permissions are relaxed in advance.

Imported flight history and retained raw uploads are separate. The staging pilot imported 960 historical flights
and their tracks, with no raw originals in that source snapshot. Keeping future raw uploads forever does not
reconstruct originals absent from an earlier history import.

## Operations notes
- **Logs.** Tiny rotated `json-file` logs (1 MiB x 3) with codes only: no keys, payloads, coordinates or tokens. That
  is small, regular write I/O on the Docker data root.
- **Resources.** 1 CPU, 1 GiB, no swap, 64 pids, read-only root, all capabilities dropped, no core dumps. Decoder
  scratch is a 192 MiB RAM tmpfs.
- **Backups.** Nothing is automated here. Before production use, plan ZFS snapshots of the folder above plus an
  offsite copy. Back up SQLite with its online backup or a snapshot, never by copying the file mid-write.
