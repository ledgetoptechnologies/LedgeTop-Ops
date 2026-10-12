import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = path.join(repositoryRoot, "apps/client/migrations");
const historyDirectory = path.join(repositoryRoot, "apps/client/test/fixtures/production-history");
const ledgerDocument = path.join(repositoryRoot, "docs/staging/production-migration-ledger-order-2026-10-12.md");
const schemaDocument = path.join(repositoryRoot, "docs/staging/production-client-historical-schema-2026-10-12.md");

const historicalBlobs = new Map([
  ["0112_thumbnail_renderer_coordination.sql", "80ecf28c8f58b8eb4d881c2aa9dec43fb5972496"],
  ["0113_thumbnail_backfill_controls.sql", "cb4eed7bb3a772f7c0bfa79180c2e18b7a912001"],
]);

function gitBlobId(contents: Buffer): string {
  return createHash("sha1").update(`blob ${contents.byteLength}\0`).update(contents).digest("hex");
}

function capturedClientLedger(): string[] {
  const clientSection = fs.readFileSync(ledgerDocument, "utf8").split(/## Client\r?\n/)[1];
  if (!clientSection) throw new Error("captured Client ledger section is missing");
  const rows = [...clientSection.matchAll(/^\| (\d+) \| `([^`]+)` \|$/gm)]
    .map(match => ({ id: Number(match[1]), name: match[2]! }));
  expect(rows.map(row => row.id)).toEqual(Array.from({ length: 134 }, (_, index) => index + 1));
  return rows.map(row => row.name);
}

type CapturedSchema = { type: string; name: string; sql: string | null };

function capturedThumbnailSchema(): CapturedSchema[] {
  const markdown = fs.readFileSync(schemaDocument, "utf8");
  return [...markdown.matchAll(/^## (index|table|trigger): ([^\r\n]+)\r?\n\r?\n```sql\r?\n([\s\S]*?)\r?\n```/gm)]
    .map(match => ({
      type: match[1]!,
      name: match[2]!,
      sql: match[3]!.startsWith("-- SQLite-generated") ? null : match[3]!,
    }));
}

function migrationContents(name: string): Buffer {
  const location = historicalBlobs.has(name)
    ? path.join(historyDirectory, name)
    : path.join(migrationsDirectory, name);
  return fs.readFileSync(location);
}

async function rows<T>(database: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  const result = await database.prepare(sql).bind(...bindings).all<T>();
  expect(result.success).toBe(true);
  return result.results;
}

async function applyMigration(database: D1Database, name: string): Promise<void> {
  const statements = splitD1MigrationStatements(migrationContents(name).toString("utf8"))
    .map(sql => database.prepare(sql));
  statements.push(database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name));
  await database.batch(statements);
}

async function seedPreHistoricalRows(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`INSERT INTO image_thumbnail_jobs (
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,attempt_count,
      queue_published_at,thumbnail_provider,thumbnail_profile,thumbnail_manifest_key,thumbnail_manifest_etag,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      "Jobs/Clients/synthetic/source.jpg", "source-etag", 4096,
      "Jobs/Clients/synthetic/.thumb/source.webp", "thumb-etag", 512, "ready", 1,
      "2026-10-01T01:02:03Z", "ltds-truenas", "portal-v1",
      "Jobs/Clients/synthetic/.thumb/source.json", "manifest-etag",
      "2026-10-01T01:00:00Z", "2026-10-01T01:02:03Z",
    ),
    database.prepare(`INSERT INTO image_thumbnail_backfill_runs (
      id,mode,scope_prefix,status,cursor,page_count,attempt_count,discovered_count,eligible_count,
      queued_count,skipped_count,ready_count,failed_dlq_count,pending_count,lease_until,started_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      "synthetic-backfill", "enqueue", "Jobs/Clients/", "running", "cursor-1", 2, 1, 8, 7,
      6, 1, 4, 1, 1, "2026-10-01T01:10:00Z", "2026-10-01T01:00:00Z",
      "2026-10-01T01:00:00Z", "2026-10-01T01:02:03Z",
    ),
  ]);
}

async function seedHistoricalRows(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`INSERT INTO image_thumbnail_renderer_instances (
      renderer_id,renderer_version,capabilities_json,capacity_json,activated_at,last_claim_at,last_heartbeat_at,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      "synthetic-renderer", "1.2.3", '["image"]', '{"slots":2}', "2026-10-01T01:00:00Z",
      "2026-10-01T01:01:00Z", "2026-10-01T01:02:00Z", "2026-10-01T01:00:00Z", "2026-10-01T01:02:00Z",
    ),
    database.prepare(`INSERT INTO image_thumbnail_renderer_leases (
      lease_id,renderer_id,source_key,source_etag,source_size,media_kind,thumbnail_key,status,attempt_count,
      lease_until,claimed_at,heartbeat_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      "synthetic-lease", "synthetic-renderer", "Jobs/Clients/synthetic/source.jpg", "source-etag", 4096,
      "image", "Jobs/Clients/synthetic/.thumb/source.webp", "active", 1, "2026-10-01T01:10:00Z",
      "2026-10-01T01:01:00Z", "2026-10-01T01:02:00Z", "2026-10-01T01:01:00Z", "2026-10-01T01:02:00Z",
    ),
    database.prepare(`UPDATE image_thumbnail_jobs SET renderer_lease_id=?,renderer_id=? WHERE source_key=?`)
      .bind("synthetic-lease", "synthetic-renderer", "Jobs/Clients/synthetic/source.jpg"),
  ]);
}

async function syntheticState(database: D1Database): Promise<Record<string, unknown[]>> {
  return {
    jobs: await rows(database, "SELECT * FROM image_thumbnail_jobs WHERE source_key='Jobs/Clients/synthetic/source.jpg'"),
    backfills: await rows(database, "SELECT * FROM image_thumbnail_backfill_runs WHERE id='synthetic-backfill'"),
    renderers: await rows(database, "SELECT * FROM image_thumbnail_renderer_instances WHERE renderer_id='synthetic-renderer'"),
    leases: await rows(database, "SELECT * FROM image_thumbnail_renderer_leases WHERE lease_id='synthetic-lease'"),
  };
}

async function assertCapturedSchema(database: D1Database): Promise<void> {
  const captured = capturedThumbnailSchema();
  expect(captured).toHaveLength(23);
  const actual = await rows<{ type: string; name: string; sql: string | null }>(database,
    `SELECT type,name,sql FROM sqlite_master WHERE name IN (${captured.map(() => "?").join(",")}) ORDER BY type,name`,
    ...captured.map(item => item.name));
  const normalize = (sql: string | null) => sql?.replace(/\s+/g, " ").trim() ?? null;
  expect(actual.map(item => ({ ...item, sql: normalize(item.sql) }))).toEqual(
    [...captured].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      .map(item => ({ ...item, sql: normalize(item.sql) })),
  );
}

describe("local-only production Client migration upgrade rehearsal", () => {
  let runtime: Miniflare;
  let database: D1Database;

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('local-client-upgrade-rehearsal')}}",
      d1Databases: ["DB"],
    });
    database = await runtime.getD1Database("DB") as unknown as D1Database;
  }, 30_000);

  afterAll(async () => runtime?.dispose());

  it("replays the exact 134-entry captured ledger then preserves synthetic state across 17 pending migrations", async () => {
    const baseline = capturedClientLedger();
    expect(baseline.slice(29, 34)).toEqual([
      "0111_thumbnail_render_provenance.sql",
      "0112_thumbnail_renderer_coordination.sql",
      "0113_thumbnail_backfill_controls.sql",
      "0112_public_share_location_privacy.sql",
      "0114_delivery_share_prefix_lookup.sql",
    ]);
    expect(baseline.slice(118, 120)).toEqual([
      "0199_native_viewer_grants.sql", "0199_incoming_upload_pickup_lifecycle.sql",
    ]);
    for (const [name, expected] of historicalBlobs) {
      expect(gitBlobId(migrationContents(name))).toBe(expected);
      expect(fs.existsSync(path.join(migrationsDirectory, name))).toBe(false);
    }

    await database.prepare(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
    for (const [index, name] of baseline.entries()) {
      await applyMigration(database, name);
      if (index === 29) await seedPreHistoricalRows(database);
      if (index === 31) await seedHistoricalRows(database);
    }

    expect((await rows<{ id: number; name: string }>(database,
      "SELECT id,name FROM d1_migrations ORDER BY id")).map(row => row.name)).toEqual(baseline);
    expect(await rows(database, "PRAGMA foreign_key_check")).toEqual([]);
    await assertCapturedSchema(database);
    const beforeUpgrade = await syntheticState(database);
    expect((beforeUpgrade.backfills![0] as { rate_limit_per_minute: number }).rate_limit_per_minute).toBe(10);

    const pending = fs.readdirSync(migrationsDirectory)
      .filter(name => /^(021[4-9]|022\d|0230)_.*\.sql$/.test(name)).sort();
    expect(pending).toHaveLength(17);
    expect(pending[0]).toBe("0214_ops_inventory_catalog_staging.sql");
    expect(pending.at(-1)).toBe("0230_operations_portal_native_delivery_terminal_cancellations.sql");
    for (const name of pending) await applyMigration(database, name);

    const finalLedger = await rows<{ id: number; name: string }>(database,
      "SELECT id,name FROM d1_migrations ORDER BY id");
    expect(finalLedger).toEqual([...baseline, ...pending].map((name, index) => ({ id: index + 1, name })));
    expect(finalLedger.slice(30, 32)).toEqual([
      { id: 31, name: "0112_thumbnail_renderer_coordination.sql" },
      { id: 32, name: "0113_thumbnail_backfill_controls.sql" },
    ]);
    expect(await syntheticState(database)).toEqual(beforeUpgrade);
    expect(await rows(database, "PRAGMA foreign_key_check")).toEqual([]);
    await assertCapturedSchema(database);
  }, 300_000);
});
