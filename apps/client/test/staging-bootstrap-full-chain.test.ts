import { Miniflare } from "miniflare";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildArtifacts } from "../../../scripts/staging-bootstrap.mjs";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const owner = Object.freeze({
  email: "full-chain-owner@staging.example.test",
  displayName: "Full Chain Synthetic Staging Owner",
  clientStaffId: "staging-full-chain-client-owner",
  operationsStaffId: "staging-full-chain-operations-owner",
});

function portableFixture(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-local-full-bootstrap-"));
  for (const [source, example] of [
    ["client", "delivery.wrangler.json.example"],
    ["operations", "operations.wrangler.json.example"],
  ] as const) {
    const directory = path.join(base, "apps", source);
    fs.mkdirSync(directory, { recursive: true });
    const sourceMigrations = path.join(repositoryRoot, "apps", source, "migrations");
    const destinationMigrations = path.join(directory, "migrations");
    fs.mkdirSync(destinationMigrations);
    for (const name of fs.readdirSync(sourceMigrations).filter(name => name.endsWith(".sql")))
      fs.copyFileSync(path.join(sourceMigrations, name), path.join(destinationMigrations, name));
    fs.copyFileSync(path.join(repositoryRoot, "docs", "staging", example), path.join(directory, "wrangler.staging.json"));
  }
  return base;
}

function removePortableFixture(base: string): void {
  const resolved = path.resolve(base), temporaryRoot = path.resolve(os.tmpdir());
  const stat = fs.lstatSync(resolved);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("ltds-local-full-bootstrap-")
    || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refusing to remove an unowned bootstrap fixture");
  fs.rmSync(resolved, { recursive: true, force: true });
}

type BootstrapArtifact = ReturnType<typeof buildArtifacts>[string];

async function rows<T>(database: D1Database, sql: string, ...values: unknown[]): Promise<T[]> {
  const result = await database.prepare(sql).bind(...values).all<T>();
  expect(result.success).toBe(true);
  return result.results;
}

async function applyPending(database: D1Database, artifact: BootstrapArtifact): Promise<string[]> {
  await database.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const applied = new Set((await rows<{ name: string }>(database,
    "SELECT name FROM d1_migrations ORDER BY id")).map(row => row.name));
  const pending = artifact.files.filter(file => !applied.has(file.name));
  for (const file of pending) {
    const statements = splitD1MigrationStatements(file.generated).map(sql => database.prepare(sql));
    statements.push(database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(file.name));
    await database.batch(statements);
  }
  return pending.map(file => file.name);
}

async function count(database: D1Database, table: string): Promise<number> {
  const result = await database.prepare(`SELECT COUNT(*) count FROM ${table}`).first<number>("count");
  expect(Number.isSafeInteger(result)).toBe(true);
  return result!;
}

describe("local-only complete staging bootstrap migration rehearsal", () => {
  let runtime: Miniflare;
  let delivery: D1Database;
  let operations: D1Database;
  let artifacts: ReturnType<typeof buildArtifacts>;
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = portableFixture();
    artifacts = buildArtifacts(fixtureRoot, owner);
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('local-bootstrap-rehearsal')}}",
      d1Databases: ["DELIVERY_DB", "OPS_DB"],
    });
    delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    operations = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (fixtureRoot) removePortableFixture(fixtureRoot);
  });

  it("applies both reviewed chains to empty local D1 databases and stays idempotent", async () => {
    expect(artifacts.delivery.files).toHaveLength(147);
    expect(artifacts.operations.files).toHaveLength(169);
    expect(artifacts.delivery.files.at(-1)?.name).toBe("0228_operations_portal_native_content_start_audit.sql");
    expect(artifacts.operations.files.at(-1)?.name).toBe("0169_project_alpha_existing_directory_binding_generation_evidence.sql");
    expect(artifacts.delivery.files.filter(file => file.name.startsWith("0199_")).map(file => file.name)).toEqual([
      "0199_incoming_upload_pickup_lifecycle.sql", "0199_native_viewer_grants.sql",
    ]);
    for (const artifact of Object.values(artifacts)) {
      expect(artifact.manifest.transformedFiles).toEqual([artifact.entry.seed]);
      expect(artifact.files.filter(file => file.transformed).map(file => file.name)).toEqual([artifact.entry.seed]);
    }

    expect(await rows(delivery, "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")).toEqual([]);
    expect(await rows(operations, "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")).toEqual([]);
    expect(await applyPending(delivery, artifacts.delivery)).toEqual(artifacts.delivery.files.map(file => file.name));
    expect(await applyPending(operations, artifacts.operations)).toEqual(artifacts.operations.files.map(file => file.name));
    expect((await rows<{ name: string }>(delivery, "SELECT name FROM d1_migrations ORDER BY id")).map(row => row.name))
      .toEqual(artifacts.delivery.files.map(file => file.name));
    expect((await rows<{ name: string }>(operations, "SELECT name FROM d1_migrations ORDER BY id")).map(row => row.name))
      .toEqual(artifacts.operations.files.map(file => file.name));

    expect(await rows(delivery, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(operations, "PRAGMA foreign_key_check")).toEqual([]);
    for (const table of ["operations_portal_workspace_publication_commands",
      "operations_portal_workspace_publication_heads", "operations_portal_workspace_publication_snapshots",
      "operations_portal_workspace_publication_history", "operations_portal_workspace_publication_receipts"]) {
      expect(await count(delivery, table)).toBe(0);
    }
    for (const table of ["operations_portal_workspace_reservation_commands",
      "operations_portal_workspace_reservation_heads", "operations_portal_folder_reservation_heads"]) {
      expect(await count(operations, table)).toBe(0);
    }
    expect(await rows<{ id: string; email: string }>(delivery, "SELECT id,email FROM staff_users ORDER BY id"))
      .toEqual([{ id: owner.clientStaffId, email: owner.email }]);
    expect(await rows<{ role: string }>(delivery, "SELECT role FROM staff_users WHERE id=?", owner.clientStaffId))
      .toEqual([{ role: "admin" }]);
    expect(await rows<{ id: string; email: string }>(operations, "SELECT id,email FROM staff_users ORDER BY id"))
      .toEqual([{ id: owner.operationsStaffId, email: owner.email }]);
    expect(await rows(operations, `SELECT role_id,scope FROM staff_role_assignments WHERE staff_id=?`, owner.operationsStaffId))
      .toEqual([{ role_id: "role-owner", scope: "global" }]);
    expect(await count(operations, "permissions")).toBeGreaterThan(0);
    expect((await rows<{ id: string }>(operations,
      "SELECT id FROM roles WHERE id IN ('role-owner','role-division-manager','role-operator','role-delivery-coordinator') ORDER BY id"))
      .map(row => row.id)).toEqual(["role-delivery-coordinator", "role-division-manager", "role-operator", "role-owner"]);
    expect(await count(operations, "role_permissions")).toBeGreaterThan(0);
    for (const canonical of ["initial-beau-koltz", "initial-kollins-stirn", "staff-beau-koltz", "staff-kollins-stirn"]) {
      expect(await rows(delivery, "SELECT 1 FROM staff_users WHERE id=?", canonical)).toEqual([]);
      expect(await rows(operations, "SELECT 1 FROM staff_users WHERE id=?", canonical)).toEqual([]);
    }

    for (const table of ["portal_operations_workspace_authority_heads", "portal_operations_principal_grant_heads",
      "portal_operations_authority_v2_audit", "portal_operations_authority_v2_receipts"]) expect(await count(delivery, table)).toBe(0);
    for (const table of ["client_portal_authority_v2_outbox", "client_portal_authority_v2_outbox_audit",
      "client_portal_authority_v2_outbox_receipts"]) expect(await count(operations, table)).toBe(0);

    for (const table of ["portal_operations_principal_grant_heads", "portal_operations_authority_v2_audit",
      "portal_operations_authority_v2_receipts"]) {
      const columns = await rows<{ name: string }>(delivery, `PRAGMA table_info(${table})`);
      expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(["protocol_version", "permissions_json"]));
      const defaults = await rows<{ name: string; dflt_value: string }>(delivery,
        `SELECT name,dflt_value FROM pragma_table_info('${table}') WHERE name IN ('protocol_version','permissions_json') ORDER BY name`);
      expect(defaults).toEqual([{ name: "permissions_json", dflt_value: "'[]'" }, { name: "protocol_version", dflt_value: "2" }]);
    }
    for (const table of ["client_portal_authority_v2_outbox", "client_portal_authority_v2_outbox_receipts"]) {
      const columns = await rows<{ name: string }>(operations, `PRAGMA table_info(${table})`);
      expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(["protocol_version", "permissions_json"]));
      const defaults = await rows<{ name: string; dflt_value: string }>(operations,
        `SELECT name,dflt_value FROM pragma_table_info('${table}') WHERE name IN ('protocol_version','permissions_json') ORDER BY name`);
      expect(defaults).toEqual([{ name: "permissions_json", dflt_value: "'[]'" }, { name: "protocol_version", dflt_value: "2" }]);
    }
    const clientGuards = await rows<{ name: string; sql: string }>(delivery,
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('portal_operations_principal_grant_insert_guard','portal_operations_principal_grant_update_guard','portal_operations_authority_v2_audit_guard','portal_operations_authority_v2_receipt_guard') ORDER BY name");
    expect(clientGuards).toHaveLength(4);
    expect(clientGuards.every(row => row.sql.includes("permissions_json") && row.sql.includes("protocol_version"))).toBe(true);
    const clientTables = await rows<{ sql: string }>(delivery,
      "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('portal_operations_principal_grant_heads','portal_operations_authority_v2_audit','portal_operations_authority_v2_receipts')");
    expect(clientTables).toHaveLength(3);
    expect(clientTables.every(row => row.sql.includes("operations.service_home.read") && row.sql.includes("DEFAULT '[]'") && row.sql.includes("DEFAULT 2"))).toBe(true);
    const opsGuards = await rows<{ name: string; sql: string }>(operations,
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'client_portal_authority_v2_outbox%v3%' ORDER BY name");
    expect(opsGuards).toHaveLength(3);
    expect(opsGuards.every(row => row.sql.includes("permissions_json") && row.sql.includes("protocol_version"))).toBe(true);

    const resourceHeadColumns = await rows<{ name: string }>(delivery,
      "PRAGMA table_info(portal_verified_recipient_delivery_authority_heads)");
    expect(resourceHeadColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      "created_operation_id", "created_request_fingerprint", "created_by_staff_id",
      "created_by_access_subject", "created_by_admission_version", "created_by_profile_version",
      "created_by_grant_generation", "created_by_verified_until",
    ]));
    const resourceAuditColumns = await rows<{ name: string }>(delivery,
      "PRAGMA table_info(portal_verified_recipient_delivery_authority_audit)");
    expect(resourceAuditColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      "actor_staff_id", "actor_access_subject", "actor_admission_version",
      "actor_profile_version", "actor_grant_generation", "actor_verified_until",
    ]));
    for (const table of ["portal_verified_recipient_delivery_authority_heads",
      "portal_verified_recipient_delivery_authority_audit", "portal_verified_recipient_delivery_authority_receipts"])
      expect(await count(delivery, table)).toBe(0);
    const resourceGuards = await rows<{ name: string }>(delivery,
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'verified_recipient_delivery_%'");
    expect(resourceGuards.map(guard => guard.name)).toEqual(expect.arrayContaining([
      "verified_recipient_delivery_head_renewal_current_proof_guard",
      "verified_recipient_delivery_head_creation_provenance_guard",
      "verified_recipient_delivery_head_creation_provenance_update_guard",
      "verified_recipient_delivery_head_revoke_exact_guard",
      "verified_recipient_delivery_audit_actor_shape_guard",
      "verified_recipient_delivery_audit_actor_guard",
      "verified_recipient_delivery_audit_no_update",
    ]));

    const before = [await count(delivery, "sqlite_schema"), await count(operations, "sqlite_schema")];
    expect(await applyPending(delivery, artifacts.delivery)).toEqual([]);
    expect(await applyPending(operations, artifacts.operations)).toEqual([]);
    expect([await count(delivery, "sqlite_schema"), await count(operations, "sqlite_schema")]).toEqual(before);
    expect(await rows(delivery, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(operations, "PRAGMA foreign_key_check")).toEqual([]);
  }, 120_000);
});
