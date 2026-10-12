# Historical Client schema readback — October 12, 2026

Read-only `sqlite_master` capture for four thumbnail tables and their associated indexes/triggers. Schema only; no customer rows or credentials. This does not authorize a production migration.

## index: idx_image_thumbnail_backfill_active_scope

```sql
CREATE UNIQUE INDEX idx_image_thumbnail_backfill_active_scope
  ON image_thumbnail_backfill_runs(scope_prefix)
  WHERE status IN ('queued','running','paused')
```

## index: idx_image_thumbnail_backfill_due

```sql
CREATE INDEX idx_image_thumbnail_backfill_due
  ON image_thumbnail_backfill_runs(status,lease_until,created_at)
```

## index: idx_image_thumbnail_jobs_lease

```sql
CREATE INDEX idx_image_thumbnail_jobs_lease
  ON image_thumbnail_jobs(status, lease_until)
```

## index: idx_image_thumbnail_jobs_pending_queue

```sql
CREATE INDEX idx_image_thumbnail_jobs_pending_queue
  ON image_thumbnail_jobs(queue_published_at, source_key)
  WHERE status = 'pending'
```

## index: idx_image_thumbnail_jobs_pending_render

```sql
CREATE INDEX idx_image_thumbnail_jobs_pending_render
  ON image_thumbnail_jobs(render_not_before, queue_published_at, source_key)
  WHERE status = 'pending'
```

## index: idx_image_thumbnail_jobs_provider

```sql
CREATE INDEX idx_image_thumbnail_jobs_provider
  ON image_thumbnail_jobs(thumbnail_provider,status,updated_at)
```

## index: idx_image_thumbnail_jobs_renderer_lease

```sql
CREATE INDEX idx_image_thumbnail_jobs_renderer_lease
  ON image_thumbnail_jobs(renderer_lease_id,status,lease_until)
```

## index: idx_image_thumbnail_jobs_status

```sql
CREATE INDEX idx_image_thumbnail_jobs_status
  ON image_thumbnail_jobs(status, updated_at)
```

## index: idx_image_thumbnail_renderer_active

```sql
CREATE INDEX idx_image_thumbnail_renderer_active
  ON image_thumbnail_renderer_instances(activated_at,last_heartbeat_at)
```

## index: idx_image_thumbnail_renderer_leases_due

```sql
CREATE INDEX idx_image_thumbnail_renderer_leases_due
  ON image_thumbnail_renderer_leases(status,lease_until,claimed_at)
```

## index: idx_image_thumbnail_renderer_leases_source

```sql
CREATE INDEX idx_image_thumbnail_renderer_leases_source
  ON image_thumbnail_renderer_leases(source_key,source_etag,status)
```

## index: sqlite_autoindex_image_thumbnail_backfill_runs_1

```sql
-- SQLite-generated internal index; SQL is null.
```

## index: sqlite_autoindex_image_thumbnail_jobs_1

```sql
-- SQLite-generated internal index; SQL is null.
```

## index: sqlite_autoindex_image_thumbnail_jobs_2

```sql
-- SQLite-generated internal index; SQL is null.
```

## index: sqlite_autoindex_image_thumbnail_renderer_instances_1

```sql
-- SQLite-generated internal index; SQL is null.
```

## index: sqlite_autoindex_image_thumbnail_renderer_leases_1

```sql
-- SQLite-generated internal index; SQL is null.
```

## table: image_thumbnail_backfill_runs

```sql
CREATE TABLE image_thumbnail_backfill_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run','enqueue')),
  scope_prefix TEXT NOT NULL CHECK (
    length(scope_prefix) BETWEEN 5 AND 1024
    AND substr(scope_prefix,1,5)='Jobs/'
    AND substr(scope_prefix,-1)='/'
    AND instr(scope_prefix,'\')=0
    AND instr(scope_prefix,char(0))=0
    AND lower(scope_prefix) NOT LIKE 'jobs/incoming/%'
  ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','paused','cancelled','completed','failed')),
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 10
    CHECK (rate_limit_per_minute BETWEEN 1 AND 60),
  cursor TEXT,
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  ready_count INTEGER NOT NULL DEFAULT 0 CHECK (ready_count >= 0),
  failed_dlq_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_dlq_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  lease_until TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

## table: image_thumbnail_jobs

```sql
CREATE TABLE image_thumbnail_jobs (
  source_key TEXT PRIMARY KEY,
  source_etag TEXT NOT NULL,
  
  source_size INTEGER NOT NULL CHECK (source_size >= 0),
  thumbnail_key TEXT NOT NULL UNIQUE,
  thumbnail_etag TEXT,
  thumbnail_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','ready','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  lease_until TEXT,
  last_event_at TEXT,
  ready_at TEXT,
  failed_at TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, queue_published_at TEXT, thumbnail_provider TEXT
  CHECK (thumbnail_provider IS NULL OR thumbnail_provider IN ('ltds-truenas','cloudflare-container')), thumbnail_profile TEXT, thumbnail_manifest_key TEXT, thumbnail_manifest_etag TEXT, renderer_lease_id TEXT, renderer_id TEXT, render_not_before TEXT)
```

## table: image_thumbnail_renderer_instances

```sql
CREATE TABLE image_thumbnail_renderer_instances (
  renderer_id TEXT PRIMARY KEY,
  renderer_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  capacity_json TEXT NOT NULL,
  activated_at TEXT,
  last_claim_at TEXT,
  last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

## table: image_thumbnail_renderer_leases

```sql
CREATE TABLE image_thumbnail_renderer_leases (
  lease_id TEXT PRIMARY KEY,
  renderer_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  source_size INTEGER NOT NULL CHECK (source_size > 0),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image','pdf','video')),
  thumbnail_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','failed','expired','cancelled')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  lease_until TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  failed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

## trigger: trg_image_thumbnail_retire_delete

```sql
CREATE TRIGGER trg_image_thumbnail_retire_delete
BEFORE DELETE ON image_thumbnail_jobs
BEGIN
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  VALUES(OLD.thumbnail_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_etag,'source_removed')
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  SELECT OLD.thumbnail_manifest_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_manifest_etag,'source_removed'
  WHERE OLD.thumbnail_manifest_key IS NOT NULL
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
END
```

## trigger: trg_image_thumbnail_retire_manifest_update

```sql
CREATE TRIGGER trg_image_thumbnail_retire_manifest_update
BEFORE UPDATE OF thumbnail_manifest_key ON image_thumbnail_jobs
WHEN OLD.thumbnail_manifest_key IS NOT NULL AND OLD.thumbnail_manifest_key <> COALESCE(NEW.thumbnail_manifest_key,'')
BEGIN
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  VALUES(OLD.thumbnail_manifest_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_manifest_etag,'manifest_replaced')
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
END
```

## trigger: trg_image_thumbnail_retire_update

```sql
CREATE TRIGGER trg_image_thumbnail_retire_update
BEFORE UPDATE OF thumbnail_key ON image_thumbnail_jobs
WHEN OLD.thumbnail_key <> NEW.thumbnail_key
BEGIN
  INSERT INTO image_thumbnail_cleanup_jobs
    (thumbnail_key,source_key,source_etag,artifact_etag,reason)
  VALUES(OLD.thumbnail_key,OLD.source_key,OLD.source_etag,OLD.thumbnail_etag,'source_replaced')
  ON CONFLICT(thumbnail_key) DO UPDATE SET
    source_key=excluded.source_key,source_etag=excluded.source_etag,
    artifact_etag=excluded.artifact_etag,reason=excluded.reason,status='pending',
    attempt_count=0,next_attempt_at=datetime('now'),lease_until=NULL,
    error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=datetime('now');
END
```

