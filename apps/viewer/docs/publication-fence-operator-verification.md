# Viewer publication fence: read-only operator verification

PR #402 is a draft. Do not activate it or remove any files based solely on this checklist. These commands inspect the existing deployment; they do not stop services, start processing, read the database contents, or change TrueNAS configuration. Run them from the TrueNAS host shell only if the operator is comfortable doing so. Output contains infrastructure paths and container identifiers; review it before sharing. Do not print environment files, secret values, or unfiltered container environments.

## 1. Inventory every Viewer instance

On **each** host capable of running a Viewer API or worker, list containers, including stopped containers and independently managed or older instances:

```sh
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Record the host identity and exact names of every Viewer API and worker. A single host's list cannot exclude another host, orchestrator, external filesystem writer, or startup path. Identify scheduled jobs, Apps configurations, manual services, and automation able to restart older images. An enforceable mixed-version and downgrade exclusion plan remains required; this inventory does not enforce one.

## 2. Inspect each running Viewer container

Substitute one exact container name from step 1, then repeat for every running API and worker:

```sh
viewer_container='REPLACE_WITH_EXACT_CONTAINER_NAME'
docker inspect --format 'Name={{.Name}} ImageID={{.Image}} User={{.Config.User}} WorkingDir={{.Config.WorkingDir}} Status={{.State.Status}}{{range .Mounts}}{{printf "\nMount %s -> %s RW=%v type=%s" .Source .Destination .RW .Type}}{{end}}' "$viewer_container"
docker exec -i "$viewer_container" node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const data = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const root = process.env.PROCESSING_ROOT || path.join(data, 'processing');
const targets = {
  database: process.env.DATABASE_PATH || path.join(data, 'viewer.sqlite'),
  models: process.env.MODELS_MOUNT || path.join(root, 'models'),
};
console.log(JSON.stringify({uid:process.getuid?.(), gid:process.getgid?.(), cwd:process.cwd()}, null, 2));
for (const [label, target] of Object.entries(targets)) {
  try {
    const real = fs.realpathSync(target), stat = fs.statSync(real), filesystem = fs.statfsSync(real);
    console.log(JSON.stringify({label, configured:target, real, device:stat.dev, inode:stat.ino,
      owner:stat.uid, group:stat.gid, filesystemType:filesystem.type}));
  } catch (error) {
    console.log(JSON.stringify({label, configured:target, error:error.code || 'unavailable'}));
    process.exitCode = 1;
  }
}
NODE
```

Compare configured database paths, the backing host mounts, real paths, and file identity across API and worker containers **on the same host**. Also record the image IDs, container user and process UID/GID. Matching container paths alone do not establish a shared database; a device/inode comparison across different hosts also does not prove shared identity. If a database is missing, an instance is stopped, a host is unavailable, or any output differs unexpectedly, stop and investigate rather than inferring equivalence.

## 3. Identify backing filesystems

For each exact host-side mount source reported above, substitute that source below. This is read-only metadata; do not run a lock experiment against the live database.

```sh
viewer_host_mount='REPLACE_WITH_EXACT_HOST_MOUNT_SOURCE'
findmnt -T "$viewer_host_mount" -o TARGET,SOURCE,FSTYPE,OPTIONS
```

Record which mounts back the SQLite database and model destinations, including filesystem and mount options. The checked-in Compose file currently specifies `/app/storage/data/viewer.sqlite`, `/app/storage/models`, user `568:568`, and a bind from `/mnt/Plugins/App_Data/Model-Viewer/Storage`, but the running containers' actual configuration is authoritative. The current source opens SQLite in WAL mode with `synchronous=NORMAL`; this alone is not proof of persistence ordering or the behavior of the installed image and its real storage.

## 4. Conditions still requiring qualification

- Verify a single shared SQLite authority for all API and worker instances, including every host and startup path; then qualify locking on the actual filesystem and topology with an isolated scratch database, never the live database.
- Verify and document filesystem and SQLite durability ordering, including fsync and power-loss behavior. Ordinary process-kill tests do not prove it.
- Enforce exclusion of old workers and noncooperating writers, and qualify a safe rollback. Require an independently checked drain and exact-image verification before any activation.
- Qualify the schema 41 migration, exact release image, NodeODM integration and real job, and provide a reviewed manual procedure for any intended but unreceipted destination. Do not delete uncertain spools or archives based on age.
