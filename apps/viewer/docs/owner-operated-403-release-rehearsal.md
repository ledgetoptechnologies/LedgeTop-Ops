# Viewer #403: owner-operated release rehearsal (draft, not execution approval)

This is a review checklist for Beau, who controls TrueNAS. It is not a command
script and does not authorize stopping the Viewer, changing TrueNAS, deploying an
image, deleting data, or restoring a backup. Complete the rehearsal on isolated
representative storage first. If any identity, process, file or receipt cannot
be verified, stop the release and preserve the evidence.

## Exact baseline and release artifact

* The last owner-supplied observation in this discussion showed API and worker
  running the same local image ID `sha256:eea9638f5979dc53ee7e4010e917f46bc85225aeebcb30b4b62e69a6c2abf632`
  with revision `c2bba3d589ad0ea4718e94dc72f742b7c0d0e5ff`. Treat that as
  historical, not a current inspection. The observed DB was
  `/app/storage/data/viewer.sqlite`, shared by API and worker with the same
  inode; `/app/storage` mapped to the Model-Viewer Storage dataset. Recheck both
  services and every other replica or scheduled writer before proceeding.
* Draft #403 source head at drafting is
  `655da439317fb5f8edd4e03ab7d61cddf6dc9922`. It is not a deployable image
  identity. Record the reviewed PR commit, final merged source revision, exact
  candidate registry digest, image ID and revision labels for both API and
  worker, platform and build provenance. Confirm the artifact includes that
  exact revision, passed its required checks, and is available by digest.
  Record the old image's exact ID and retrievable immutable digest separately;
  `latest` alone is insufficient for either candidate or recovery. If build
  provenance, digest or retrieval cannot be verified, stop.
* Record current schema version, all active/pending jobs, attempt/lease
  generations, publication intents, receipt presence, staged/unregistered
  outputs, and actual paths, mounts and writer identities. Collect counts and
  IDs only; do not include client data, tokens, environment variables, URLs or
  private paths in shared notes. Inventory all API/worker replicas and any
  importer, cleaner, alternate host, scheduled process or direct user with
  write access to the same SQLite database or model tree.

A previously run synthetic rehearsal demonstrated that old source can renew a
reclaimed same-owner ingest lease despite the newer generation check and accepts
the newer schema. An expired lease, changed image tag, or healthy new worker is
therefore not proof the old writer is fenced. See
[nonempty upgrade and rollback rehearsal](nonempty-upgrade-rollback-rehearsal.md).

## Rehearse quiescence and restart ownership

1. On an isolated test app and copied synthetic data, confirm how the **actual
   installed TrueNAS 25.10.7 app definition** starts, stops, updates and restarts
   both services, including its restart policies, automation, dependency and
   reboot behavior. The TrueNAS Apps screen provides an app-level Stop action,
   but documentation alone does not prove that this particular custom app,
   auxiliary processes or external writers remain stopped through update,
   reconciliation or reboot. Do not rely on stopping one container alone.
2. Establish a tested admission freeze that prevents new Viewer writes and
   submissions; coordinate any in-flight work with the processing owner. Stop all
   Viewer app writers and cleaners through the owner-controlled app lifecycle,
   without deleting the app, its image, datasets or volumes. The app's normal
   Update action can restart an app, so treat an update as a separate start event.
3. Verify every previously inventoried process exited, not merely that its
   lease expired. Record container names, image IDs, stopped state and host PIDs
   where applicable; check for renamed/recreated containers, alternate app
   instances and external writers. Observe that no scheduler or controller
   recreates them throughout the backup window. A single `docker ps` snapshot
   is not proof across time or reboot. If the current app definition cannot
   enforce this fence, do not proceed. Do not change the Docker daemon, reboot,
   or disable unrelated apps to work around an unproven fence.

## Consistent nonempty backup

* With every relevant writer and cleaner demonstrably quiesced, identify the
  actual SQLite file and its `-wal` and `-shm` companions, the dataset boundaries,
  and all source, result, output, spool, receipt, intent and trash trees that
  participate in the workflow. Include separate datasets/mounts where used;
  preserve ACLs, ownership, filesystem properties and the app configuration.
* Use a tested SQLite-consistent backup mechanism, or a verified quiescent,
  coordinated filesystem snapshot procedure that includes the database and WAL
  together. Do not copy only `viewer.sqlite` from a running WAL-mode database.
  Do not assume independently timed snapshots of multiple datasets form one
  atomic snapshot. Confirm snapshot/backup consistency, storage space, retention
  and restore target without writing over the original; keep a separate immutable
  manifest of artifact identities and timestamps. The exact TrueNAS snapshot
  commands and multi-dataset atomicity are not qualified here.
* In a separate isolated restore location, verify SQLite integrity, migration
  versions, pending/leased/terminal job counts, exact publication intents and
  receipts, and representative file identity/hash/size against the backup
  manifest. Test the restore with the exact old image and a representative
  nonempty synthetic database and trees. A successful file copy or screenshot
  alone is not restore proof.

SQLite's [WAL documentation](https://www.sqlite.org/wal.html) describes why the
WAL belongs to persistent database state, and the [SQLite backup API](https://www.sqlite.org/backup.html)
describes a supported consistent database backup mechanism. Select and test an
implementation compatible with the installed image and storage; neither source
qualifies a specific TrueNAS workflow.

## Candidate verification and forward recovery

1. On isolated restored copies, prove migration 41 preserves representative
   pending and leased rows, exact intent/receipt state and data trees. Exercise
   candidate workers with intentionally interrupted downloads, stale claims,
   partial publications and unavailable coordinator, including exact recovery
   or an explicit hold. Verify old binaries cannot write because they are
   actually absent/fenced, not because the new schema is assumed to reject them.
2. Rehearse old-to-candidate restart and candidate-to-old recovery under the
   tested owner-controlled lifecycle, including auto-restart races and each
   configured replica. Verify no old API, worker or cleaner can return while
   candidate writers are active. Record the exact service versions, DB identity,
   mount identities, schema, job/intent/receipt inventory and health after start.
   The isolated SQLite test in this branch proves only a narrow nonempty snapshot
   case and explicitly demonstrates old-worker bypass.
3. Before any new candidate write, a tested restore of the quiesced backup to an
   **isolated alternate target** can support a return to the old image if the
   owner has proven the complete old storage/app state and no newer data needs
   preserving. This is a recovery option, not an automatic rollback instruction.
   Never overwrite the live dataset or restore an old snapshot merely because the
   candidate is unhealthy.
4. After candidate writes, retain the upgraded database, WAL, sources, outputs,
   receipts, intents and exact images. Freeze admissions and all writers; inventory
   what changed. Prefer fixing forward on the preserved schema or a separately
   reviewed reconciliation into an isolated copy. A downgrade or old snapshot
   restore requires an explicit reconciliation for **every** newer accepted job,
   output, receipt and intent, plus independently tested storage and process
   fencing. If any state is ambiguous, keep it held and do not delete or overwrite.
5. Resume admissions only after the chosen exact version, one compatible writer
   topology, all pending work, result handoffs, storage headroom, maintenance and
   rollback/forward-recovery route are verified. First use the previously
   authorized small synthetic/20-photo acceptance, then separately qualify queue,
   outage/recovery and larger workloads. A 10,000-photo job is not covered.

References: [TrueNAS 25.10 Apps screens](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/)
and [SQLite WAL](https://www.sqlite.org/wal.html). Exact installed-app behavior,
backup procedure, production writer census and candidate image digest remain
unverified; the TrueNAS owner controls every action.

## Owner-run read-only baseline checks (before any stop)

These are inventory checks, not a request to update or stop anything. Run them
only in Beau's TrueNAS shell or the indicated Viewer API container. The container
names reflect the historical observation; if they differ, stop and identify the
actual app instead of guessing. Review output before sharing; it must not contain
credentials, client names or file inventories.

In the TrueNAS shell, the first command reports the two historically observed
services' actual local image ID, revision label, process status and host PID. The
second shows all container names and statuses so other replicas can be identified.
They do not print environment variables. A missing revision or digest is a
blocking unknown, not an implicit match.

```sh
sudo docker inspect ix-model-viewer-viewer-api-1 ix-model-viewer-viewer-worker-1 \
  --format '{{.Name}} imageId={{.Image}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} status={{.State.Status}} hostPid={{.State.Pid}}'
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

Inside the running Viewer API container shell, this opens the configured SQLite
file read-only and prints schema versions and aggregated job/intent counts. It
makes no checkpoint and does not print path, credentials, job IDs or client data.
It is a point-in-time view; all writers still require the census above.

```sh
node <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const data=process.env.DATA_DIR||path.join(process.cwd(),'data');
let db;
try {
  db=new DatabaseSync(process.env.DATABASE_PATH||path.join(data,'viewer.sqlite'),{readOnly:true});
  const versions=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  const jobs=db.prepare('SELECT status,COUNT(*) AS count FROM processing_jobs GROUP BY status').all();
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingest_publication_intents'").get();
  const intents=exists?db.prepare('SELECT COUNT(*) AS count FROM ingest_publication_intents').get().count:null;
  console.log(JSON.stringify({schemaVersion:versions.version,jobs,intentCount:intents}));
} catch {
  console.error('Read-only Viewer inventory failed; stop and inspect the schema.');
  process.exitCode=1;
} finally { if(db) db.close(); }
NODE
```

These commands do not determine the registry manifest digest, identify all
non-container writers, verify an old-worker fence, create a backup, or authorize
any deployment. Resolve those separately before any operational rehearsal.

After the first inspection, use the actual printed image ID as the argument to
`sudo docker image inspect`, with this format, to inspect its local ID and any
registry digest labels. Repeat for the worker if its ID differs:

```sh
sudo docker image inspect '<IMAGE_ID_FROM_INSPECT>' \
  --format 'id={{.Id}} repoDigests={{json .RepoDigests}}'
```

Replace the placeholder locally. An empty `RepoDigests` value does not identify
a registry manifest; obtain independent registry/build provenance before using
the image as a deployable or rollback artifact. A locally present image ID alone
does not prove the matching package is still retrievable.
