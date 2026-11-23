# Content chunk backfill

The worker builds 1 MiB chunk hashes for registered files of at least 4 MiB that
have none yet: rasters, camera photos, point clouds, meshes and large EPT or
3D Tiles children. Delivery does not read them yet.

## Trust rule

- The only source of truth is the whole-file SHA-256 and size recorded when the
  file was imported. Nothing is ever taken from disk.
- One read pass feeds the whole-file hash and the chunk hashes from the same
  buffer. A set is stored only if that pass reproduces the recorded hash and
  size exactly, so a changed file never gets one.
- EPT and 3D Tiles children also need their tree digest to follow from the
  registered file rows.
- A file with no recorded hash is never hashed. It is counted under `skipped`.
- A mismatch stores no set, adds one `content_chunks.verification_failed` audit
  event and is retried daily. A missing file is retried after 1, 2, 4 … 24 hours.

`model_asset_chunks` is never written: LOD recovery and supersession compare
those rows byte for byte with saved plans.

## Table (schema 87)

`content_chunk_sets` has one immutable row per file content:

- `content_sha256` is the recorded whole-file hash and `byte_size` its size.
- `digests` holds 32 bytes per chunk. Digest `i` is `digests[32*i .. 32*i+31]`
  and covers file bytes from `i * 1048576`, up to 1 MiB.

A reader must use a set only when its key and `byte_size` equal the registered
values and `length(digests) = 32 * ceil(byte_size / 1048576)`. 2 GiB of file is
a 64 KB row. `content_chunk_failures` is the retry list.

## Running

It is always on in the processing worker: one file at a time, 1 MiB sequential
reads, at most 50 MiB/s, read-only. It waits while an import, processing step,
conversion or measurement runs. A stop or crash loses at most the current file's
progress; nothing partial is stored.

    node scripts/content-chunk-backfill.js status
    node scripts/content-chunk-backfill.js pause
    node scripts/content-chunk-backfill.js resume

The worker heartbeat carries the same progress as `contentChunks`.

## Rollback

Nothing reads the tables, so an older release ignores them. To remove them, stop
the worker, then:

    DROP TABLE content_chunk_sets;
    DROP TABLE content_chunk_failures;
    DELETE FROM schema_migrations WHERE version=87 AND name='content_chunk_sets';

A release that has migration 87 creates them again and rebuilds the sets.

## Inventory (read-only)

Counts only; run by the operator, before and after. `sqlite3 -readonly` or any
read-only connection.

```sql
-- Registered files with a recorded hash and no chunk rows.
SELECT m.provider,a.kind,a.storage_mode,a.published,COUNT(*) files,
       ROUND(SUM(a.byte_size)/1048576.0) mib,ROUND(MAX(a.byte_size)/1048576.0) max_mib
FROM model_assets a JOIN model_versions v ON v.id=a.version_id JOIN models m ON m.id=v.model_id
WHERE a.kind NOT IN('ept','tiles') AND a.sha256 IS NOT NULL AND a.byte_size>=4194304
  AND NOT EXISTS(SELECT 1 FROM model_asset_chunks c WHERE c.asset_id=a.id AND c.relative_path='')
GROUP BY 1,2,3,4 ORDER BY mib DESC;

-- EPT and 3D Tiles children with no chunk rows.
SELECT a.kind,a.published,COUNT(*) files,
       ROUND(SUM(f.byte_size)/1048576.0) mib,ROUND(MAX(f.byte_size)/1048576.0) max_mib
FROM model_asset_files f JOIN model_assets a ON a.id=f.asset_id
WHERE f.byte_size>=4194304
  AND NOT EXISTS(SELECT 1 FROM model_asset_chunks c WHERE c.asset_id=f.asset_id AND c.relative_path=f.relative_path)
GROUP BY 1,2;

-- Camera photos (never have chunk rows).
SELECT COUNT(*) photos,COUNT(DISTINCT sha256) distinct_photos,SUM(byte_size>=4194304) over_4mib,
       ROUND(SUM(byte_size)/1048576.0) mib FROM model_camera_photos;

-- No recorded hash: never eligible.
SELECT kind,COUNT(*) FROM model_assets WHERE sha256 IS NULL GROUP BY 1;

-- Sizes the separate per-tile audit query problem.
SELECT entity_type,COUNT(*) FROM audit_events GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
```
