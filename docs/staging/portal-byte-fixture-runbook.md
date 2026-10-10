# Synthetic portal file acceptance

Use `scripts/staging-portal-byte-fixture.mjs` only with its exact minimal
single-binding configuration for `client-data-staging`. It cannot deploy a
Worker, change permissions, list the bucket, delete objects, or modify public
links. Four tiny text fixtures exercise selected direct/nested files and denied
sibling/cross-customer files for the existing synthetic workspace.

```powershell
node scripts/staging-portal-byte-fixture.mjs prepare --config <minimal-r2-config.json>
node scripts/staging-portal-byte-fixture.mjs apply --config <minimal-r2-config.json>
node scripts/staging-portal-byte-fixture.mjs resume --config <minimal-r2-config.json> --manifest <saved-provision.json>
node scripts/staging-portal-byte-fixture.mjs verify --config <minimal-r2-config.json> --manifest <saved-provision.json>
node --test scripts/staging-portal-byte-fixture.test.mjs
```

- Prepare is read-only and checks four exact fresh keys. Apply creates a fresh
  run; it is not an application of the prepare output.
- Apply saves its exact manifest privately before the first write. Record the
  returned manifest path. For a partial or uncertain run, resume that same saved
  manifest rather than calling apply again.
- Every write is conditional on absence. Existing objects are accepted only
  when their exact fixture metadata, size, SHA-256 and bytes match. Foreign
  collisions stop execution without overwriting.
- Resume validates the bounded, non-symlink private manifest path and exact
  recompiled content; it never rewrites the saved manifest.
- Verify is read-only: exact HEAD/GET checks return synthetic key, ETag, provider
  version, size, upload time, content type and SHA-256 observations. Compare all
  four exact keys against Client D1 `file_index` after real event processing.
- Staging requires an ObjectCreated notification subscription to its existing
  file-events queue. The acceptance subscription is restricted to
  `staging/portal-acceptance/`, not the whole bucket. Do not directly insert
  synthetic index rows to bypass testing this path.
- Credentials stay in the approved process environment, never command arguments
  or committed files. Generated manifests/configuration stay ignored.
- Successful direct R2 reads prove fixture integrity, **not client access**.
  Complete actual recipient sign-in, selected-folder browse/preview/download,
  excluded-file denial and same-session revocation acceptance separately.
