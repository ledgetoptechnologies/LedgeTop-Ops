# Employee files pilot

Local Nextcloud experiment for Windows files on demand. This is a test harness, not the shared LedgeTop installer or an Ops authentication integration.

Run from this directory:

```powershell
node pilot.mjs init
node pilot.mjs up
node pilot.mjs bootstrap
node pilot.mjs test
node pilot.mjs stop
```

Use only synthetic data at `http://127.0.0.1:18087`. The server stack contains Nextcloud, PostgreSQL, Redis and cron. The source fixture is mounted read-only in both Nextcloud containers. Only two synthetic employee accounts can see it; an unassigned account provides a negative access test. Their personal storage is disposable writable diagnostic space.

**Writable acceptance currently fails.** The pinned Nextcloud release accepts a stale conditional write when successive changes preserve the modification timestamp. `test` must return nonzero until the revision check is fixed. See the [runbook](../../docs/employee-files-pilot.md) and [captured service results](../../docs/employee-files-pilot-results.json).

Runtime state and generated secrets live in ignored `.pilot/`. Images are digest-pinned in `images.lock.json`; initialization never silently upgrades them or rotates existing credentials. Commands reject remote Docker contexts and use an exclusive command lock. No reset or volume-deletion command is provided.

Static checks:

```powershell
npm.cmd run check
npm.cmd test
```

The service tests exercise real WebDAV requests. Windows Explorer placeholders, pinning, offline behavior and application compatibility still require the manual Windows checks. Nothing in this package contacts TrueNAS, R2 or Ops.
