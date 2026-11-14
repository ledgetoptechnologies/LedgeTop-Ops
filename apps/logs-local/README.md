# Ledge Top flight logs on the NAS (local Logs host)

Flight logs run on the NAS as one container in the existing `lt-ops-workers` stack. Ops shows them through the
Tunnel. Controllers upload through the existing public device hostname, whose Worker forwards to this host. No
Cloudflare D1/R2 is used for this data. Merger owns building, deploying, the Tunnel, Access and every host change.

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
docker build -f apps/logs-local/Dockerfile --target keyless .   # first Stage pilot: no native parser
docker build -f apps/logs-local/Dockerfile --target full .      # adds the reviewed DJI parser build
```
Both run as UID 568. Builds and runs only happen in a window Merger admits.

## Folders
The stack mounts `/mnt/Plugins/App_Data/LedgeTop-Ops-Workers` at `/data`. The container can see the sibling folders
there; this is application-level confinement, not filesystem isolation. Logs only ever uses:

```
/data/flight-logs/
  db/logs.sqlite      ledger (keep on a local dataset; never SMB/NFS)
  objects/            originals (raw/), tracks, and the object index
  config/logs.env     this app's configuration (0600)
```
On first start the app creates these as UID 568. If the parent is not writable by UID 568, it stops with a clear
message. It never changes permissions or ownership and never runs ZFS commands. These are ordinary folders, not
datasets.

## First start and configuration
1. **First start.** The app writes `config/logs.env` once, as a blank template (0600), then stops as **not ready**
   (exit 78). Docker's restart backoff applies. The template is never overwritten.
2. **Machine credentials.** Fill in the values Merger provisions:
   - the ingress host;
   - the Access audience;
   - the two allowed service-token client ids;
   - the Ops directory URL and this host's own directory service token.

   Blank or invalid machine credentials keep the app not ready. Authentication is never switched off.
3. **DJI key.** Leave `DJI_API_KEY` blank to start keyless; uploads, history and the Ops API all work. To start
   decoding later, put the key in the file. Then send `docker kill -s HUP <container>` to apply only the key, or
   restart the container to apply everything.
4. **Check status.** The app logs event codes only, never values. `docker inspect --format '{{.State.Health.Status}}'`
   reports health.

This file is read by the app itself. It is **not** a Compose `.env`: Compose never interpolates it, so values don't
show up in `docker inspect`.

Editing the file over SMB depends on the share user mapping to UID 568. That hasn't been tested yet, and no
permissions are relaxed in advance.

## Operations notes
- **Logs.** Tiny rotated `json-file` logs (1 MiB x 3) with codes only: no keys, payloads, coordinates or tokens. That
  is small, regular write I/O on the Docker data root.
- **Resources.** 1 CPU, 1 GiB, no swap, 64 pids, read-only root, all capabilities dropped, no core dumps. Decoder
  scratch is a 192 MiB RAM tmpfs.
- **Backups.** Nothing is automated here. Before production use, plan ZFS snapshots of the folder above plus an
  offsite copy. Back up SQLite with its online backup or a snapshot, never by copying the file mid-write.
