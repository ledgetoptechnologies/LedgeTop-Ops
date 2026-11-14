# Importing the Cloudflare Logs history into the local Logs host

This is a one-time move of the existing Logs history (Cloudflare D1 rows and R2 objects) into the NAS Logs host. It
only adds: nothing in Cloudflare is changed, and nothing already on the NAS is overwritten or deleted.

Who does what:

- **Export (read-only, Cloudflare):** the infrastructure owner (Merger). These are read-only commands with the
  staging or production read credentials. This repository holds no credentials.
- **Import (NAS):** run inside the Logs container as the app user, ideally with the Logs server stopped.

## What is kept, exactly

- Every flight, aircraft, battery, controller, import record, tag, message and audit event, with its **original id**.
- Owners and attributions as exported. A flight whose owner was unknown stays unassigned. Assigning or reassigning it
  later is admin-only and always audited (a separate change).
- Telemetry tracks and raw logs, byte for byte. Each object's SHA-256 is checked while it is written. Objects are
  stored create-only, before the rows that reference them.
- **DJI keychains as the exact sealed ciphertext and iv.** They were sealed with the Cloudflare Worker's key, which the
  NAS does not have. **A new local `KEYCHAIN_ENCRYPTION_KEY` cannot open them.** The importer never decrypts,
  re-seals or drops them. Each one gets a `keychain_provenance` row (snapshot id, `sealed_by = source-key`, source key
  version), so nothing mistakes them for locally sealed keys. Logs decoding uses the DJI Open API key, not these
  keychains.
- Pending controller sign-in requests (`device_sign_ins`) are **not** imported: they expire within minutes and carry
  poll tokens.

## Controller sign-ins: an explicit choice

`--device-tokens` is required. There is no default:

- `preserve`: devices are imported as exported. When the public host starts forwarding to the NAS, signed-in
  controllers keep uploading without signing in again. Every request is still checked against the controller's Ops
  eligibility revision, which fails closed. Only token hashes exist in the data, never tokens.
- `revoke`: devices are imported revoked (`revoked_by = system:snapshot-import`). Every controller signs in again and
  an admin approves it.

A run that was started with one choice can only be finished with the same choice.

## Snapshot layout

```
manifest.json            written by `pack`; its SHA-256 is the snapshot id
tables/<table>.jsonl     one JSON object per row, exactly as exported
objects.jsonl            one {"key": "...", "file": "objects/..."} per R2 object (pack adds bytes + sha256)
objects/...              the object files
```

Importable tables, in order: aircraft, batteries, controllers, imports, flights, import_items, flight_tags,
flight_messages, keychains, audit_events, devices, raw_logs. Any other table, any unknown column, any path with `..`,
an absolute path or a link is refused.

## Export (read-only; infrastructure owner)

1. For each table, save `wrangler d1 execute <logs-db> --remote --json --command "SELECT * FROM <table> ORDER BY <key>
   LIMIT 5000 OFFSET <n>"` pages as `tables/<table>/0001.json`, `0002.json`, and so on. Also record `SELECT COUNT(*)`
   for each table to compare later.
2. For each `flights.telemetry_key` and `raw_logs.r2_key`, save the object's **original bytes** into `objects/`. List
   it in `objects.jsonl` as `{"key", "file", "sourceBytes", "sourceEtag"}`, where size and ETag come from R2
   head/list metadata. For a multipart object (ETag `<hex>-<parts>`), also give `sourceSha256`.
   **The transport must not transform bodies.** Some readers decompress `.json.gz` or parse JSON, and that is not the
   original. Use a raw byte stream with no automatic decompression: `node:https.request` (no decoding), Python
   `requests` with `stream=True` and `raw.read(decode_content=False)`, or an export Worker that streams `R2.body` as
   `application/octet-stream` with no `Content-Encoding`. Do not use `fetch` or a JSON or connector wrapper.
   `pack` and the import both refuse any file whose size or MD5 ETag (or source SHA-256) differs from the source, and
   any `.gz` key that is no longer gzip. A raw log must also be exactly the `size_bytes` its row records.
3. `node apps/logs-local/src/snapshot-cli.mjs pack --snapshot <dir> --label "cloudflare-production-YYYY-MM-DD"`.
   This joins the pages into `tables/<table>.jsonl`, hashes every file and writes `manifest.json`. It never
   overwrites an existing manifest or table file.

Move the folder to the NAS without changing it. The manifest checks every file's size and SHA-256.

## Import (NAS)

```
node apps/logs-local/src/snapshot-cli.mjs plan   --snapshot /data/flight-logs/import/<dir> --staging-dir /data/flight-logs/import-staging --device-tokens <choice>
node apps/logs-local/src/snapshot-cli.mjs import --snapshot /data/flight-logs/import/<dir> --staging-dir /data/flight-logs/import-staging --device-tokens <choice>
```

- `--staging-dir` is required. Both commands copy each verified table file (and the objects list) into a new 0700
  folder inside it, and read only those copies. A snapshot file edited after it was checked can therefore never be
  imported under the snapshot's id. The copies are removed when the command ends, including after a failure.
  - Use `/data/flight-logs/import-staging`, inside the app's own data folder, created by the operator as the app
    user (UID 568, 0700). Or use a Merger-approved isolated override. The importer never creates a parent or sibling
    folder. **Never** use the
    container's `/tmp` (an 8 MiB RAM disk) or any shared location.
  - It needs free space for all table files plus 64 MiB. The command checks this first and refuses (`staging_space`)
    before copying anything.
  - Object files are not copied; their SHA-256 is enforced while they are stored.
- `plan` writes nothing. It opens the database and object index read-only, creates no folder, runs no migration, and
  refuses a host that has never been started. SQLite may create its usual empty `-wal`/`-shm` coordination files. For each table and for the objects, it reports what would be added, what is already present
  and every conflict, plus referenced objects missing from the snapshot. Exit 0 means importable; exit 3 means
  conflicts.
- `import` re-plans and refuses on any conflict, writing nothing. It then stores the objects, then adds the rows in
  chunks. Each chunk is one transaction, and every row is re-checked inside it.
- If it is interrupted (power cut, container restart), run the same command again. Identical rows and objects are
  counted as present, and the rest is added. A completed snapshot returns its stored receipt.
- Referenced objects that are missing from the snapshot block the import. Only if the owner decides to go ahead
  without them, add `--accept-missing-objects`; the receipt records that.

The output and the `snapshot_imports.receipt` hold **aggregate counts only**: no ids, owners, coordinates, serials,
messages or key material. One `snapshot_imported` audit event is written per completed snapshot.

## After the import

Compare the receipt's row counts with the export's `COUNT(*)` numbers (expected for the current production data: 960
flights, 960 tracks, 97,350 messages and 364 sealed keychains), and check that `keychainsVerified` equals the
keychain count. The Cloudflare data stays untouched as the fallback until the owner retires it.
