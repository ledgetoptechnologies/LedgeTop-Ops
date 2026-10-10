import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AUTHORITY_MIGRATION_CHAIN_185, AUTHORITY_MIGRATION_CHAIN_187 } from "./staging-authority-migration-chain-v185.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const account = "846c924bf17bf4f3dd15c97a4c5d1d51";
const database = "78b34173-b168-4e3d-9832-bb9d245cc6b8";
const migrations = Object.freeze([
  Object.freeze({ name: "0186_project_alpha_directory_conflict_evidence_binding.sql",
    sha256: "6d19b3e6be44382c51681444e95a501845f8f3958e83930c5fba50501951fd92" }),
  Object.freeze({ name: "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
    sha256: "ded89fe037cfb56f9ddf4316a4ddcc67c8ae00e58d66eebec9a8129c6536eb28" }),
]);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const paths = Object.freeze({
  config: path.join(root, "apps/operations/.tmp-checks/operations-0186-0187-config.json"),
  isolated: path.join(root, "apps/operations/.tmp-checks/operations-0186-0187-migrations"),
  backup: path.join(root, "apps/operations/.backups/operations-before-0186-0187-20261010.sql"),
  evidence: path.join(root, "apps/operations/.backups/operations-before-0186-0187-20261010.json"),
  marker: path.join(root, "apps/operations/.backups/operations-0186-0187-apply-attempt.json"),
});
const snapshotQueries = Object.freeze({
  schema: "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('trigger','view') ORDER BY type,name",
  grants: "SELECT * FROM native_directory_grants ORDER BY id",
  workspaceHeads: "SELECT * FROM operations_portal_native_workspace_authority_heads ORDER BY target_id",
  recipientHeads: "SELECT * FROM operations_portal_native_recipient_authority_heads ORDER BY recipient_binding_id",
  deliveryHeads: "SELECT * FROM operations_portal_native_delivery_authority_heads ORDER BY authority_id",
  publicationOutbox: "SELECT * FROM operations_portal_workspace_publication_outbox ORDER BY operation_id",
  recipientOutbox: "SELECT * FROM operations_portal_native_authority_outbox ORDER BY operation_id",
  deliveryOutbox: "SELECT * FROM operations_portal_native_delivery_authority_outbox ORDER BY operation_id",
  conflicts: "SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id",
});

export function buildOperations0186To0187Plan(base = root) {
  const directory = path.join(base, "apps/operations/migrations");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assert.equal(names.length, AUTHORITY_MIGRATION_CHAIN_187.count);
  assert.equal(names.at(-1), AUTHORITY_MIGRATION_CHAIN_187.final);
  assert.equal(sha(names.join("\n")), AUTHORITY_MIGRATION_CHAIN_187.names);
  assert.equal(sha(names.map(name => `${name}\0${sha(fs.readFileSync(path.join(directory, name)))}`).join("\n")),
    AUTHORITY_MIGRATION_CHAIN_187.contents);
  for (const migration of migrations) assert.equal(sha(fs.readFileSync(path.join(directory, migration.name))), migration.sha256);
  return Object.freeze({ priorNames: Object.freeze(names.slice(0, AUTHORITY_MIGRATION_CHAIN_185.count)),
    finalNames: Object.freeze(names), migrations, directory });
}

function privateFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { flag: "wx" });
  restrictPrivateFile(file);
  fs.writeFileSync(file, contents);
}
function restrictPrivateFile(file) {
  const acl = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File",
    path.join(root, "scripts/restrict-private-authority-file.ps1"), "-LiteralFile", file],
  { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(acl.status, 0, "Private artifact ACL failed; no remote write attempted");
}
export function assertSafePrivateArtifactStat(stat) {
  assert(stat.isFile() && !stat.isSymbolicLink(), "Private artifact must be a regular non-symlink file");
}
function assertSafePrivateArtifact(file) {
  assertSafePrivateArtifactStat(fs.lstatSync(file));
}
function credential() {
  const values = fs.readFileSync("C:/Users/fstor/Downloads/prompt.md", "utf8").split(/\r?\n/u)
    .map(value => value.trim()).filter(value => /^cfat_[A-Za-z0-9_-]+$/u.test(value));
  assert.equal(values.length, 1); return values[0];
}
async function query(token, sql) {
  assert.match(sql, /^SELECT\s/u);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
  const body = await response.json();
  assert(response.ok && body.success && body.result?.length === 1 && body.result[0].success);
  assert.equal(body.result[0].meta.changed_db, false); return body.result[0].results;
}
async function snapshot(token) {
  const result = {};
  for (const [key, sql] of Object.entries(snapshotQueries)) result[key] = await query(token, sql);
  return result;
}
function wrangler(token, config, args) {
  const child = spawnSync(process.execPath, [path.join(root, "apps/operations/node_modules/wrangler/bin/wrangler.js"),
    "d1", ...args, "--config", config], { cwd: root, windowsHide: true, timeout: 180000, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account, CI: "true", WRANGLER_SEND_METRICS: "false" } });
  assert.equal(child.status, 0, "Wrangler failed; reconcile read-only and never retry automatically");
}
const normalized = value => value.replaceAll("\r\n", "\n").trim().replace(/;$/u, "");

export function assertApplyReady(current, saved, markerExists, now = Date.now()) {
  assert.deepEqual(current, saved.snapshot);
  assert(now - Date.parse(saved.createdAt) < 30 * 60 * 1000, "Fresh backup required before apply");
  assert(!markerExists, "Existing apply attempt; never retry automatically");
}

export function assertNoForeignKeyViolations(rows) {
  assert.deepEqual(rows, [], "Foreign-key violations present; no migration action allowed");
}

export function assertPostflightPreserved(current, savedSnapshot, expectedSqlByName) {
  for (const [name, sql] of expectedSqlByName) {
    assert(sql); const found = current.schema.filter(row => row.name === name); assert.equal(found.length, 1);
    assert.equal(normalized(found[0].sql), normalized(sql));
  }
  const changed = new Set(expectedSqlByName.keys());
  assert.deepEqual(current.schema.filter(row => !changed.has(row.name)),
    savedSnapshot.schema.filter(row => !changed.has(row.name)));
  for (const key of Object.keys(snapshotQueries).filter(key => key !== "schema"))
    assert.deepEqual(current[key], savedSnapshot[key]);
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? "preflight";
  assert(["preflight", "backup", "apply", "readback"].includes(mode)); assert(argv.length <= 1);
  const plan = buildOperations0186To0187Plan(), token = credential();
  const applied = (await query(token, "SELECT name FROM d1_migrations ORDER BY name")).map(row => row.name);
  assert.deepEqual(applied, mode === "readback" ? plan.finalNames : plan.priorNames);
  assertNoForeignKeyViolations(await query(token,
    'SELECT * FROM pragma_foreign_key_check ORDER BY "table", rowid, parent, fkid'));
  const current = await snapshot(token);
  if (mode === "preflight") return { mode, applied: applied.length, pending: migrations.map(row => row.name),
    snapshotSha256: sha(JSON.stringify(current)), mutationsPerformed: false };
  const expectedConfig = { name: "ledgetop-ops-staging", account_id: account, compatibility_date: "2026-08-06",
    vars: { ENVIRONMENT: "staging" }, d1_databases: [{ binding: "OPS_DB", database_name: "ltds-ops-staging",
      database_id: database, migrations_dir: paths.isolated.replaceAll("\\", "/") }] };
  if (mode === "backup") {
    for (const file of [paths.backup, paths.evidence, paths.marker]) assert(!fs.existsSync(file));
    fs.mkdirSync(paths.isolated, { recursive: true }); assert.deepEqual(fs.readdirSync(paths.isolated), []);
    for (const migration of migrations) fs.copyFileSync(path.join(plan.directory, migration.name),
      path.join(paths.isolated, migration.name), fs.constants.COPYFILE_EXCL);
    privateFile(paths.config, JSON.stringify(expectedConfig)); privateFile(paths.backup, "");
    wrangler(token, paths.config, ["export", "ltds-ops-staging", "--remote", "--output", paths.backup]);
    // Wrangler uses writeFile on the existing file. Re-apply and verify the reviewed ACL after download so a
    // future implementation change cannot silently leave the complete export with inherited permissions.
    restrictPrivateFile(paths.backup);
    assert(fs.statSync(paths.backup).size > 1000);
    privateFile(paths.evidence, JSON.stringify({ database, createdAt: new Date().toISOString(),
      backupSha256: sha(fs.readFileSync(paths.backup)), migrationSha256: migrations, snapshot: current }));
    return { mode, backupBytes: fs.statSync(paths.backup).size, migrationApplied: false };
  }
  assertSafePrivateArtifact(paths.config); assertSafePrivateArtifact(paths.evidence);
  const saved = JSON.parse(fs.readFileSync(paths.evidence, "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config, "utf8")), expectedConfig);
  assert.deepEqual(fs.readdirSync(paths.isolated).sort(), migrations.map(row => row.name));
  assert.equal(saved.database, database); assert.equal(saved.backupSha256, sha(fs.readFileSync(paths.backup)));
  assert.deepEqual(saved.migrationSha256, migrations);
  if (mode === "apply") {
    assertApplyReady(current, saved, fs.existsSync(paths.marker));
    privateFile(paths.marker, JSON.stringify({ database, migrations, attemptAt: new Date().toISOString() }));
    wrangler(token, paths.config, ["migrations", "apply", "ltds-ops-staging", "--remote"]);
    assert.deepEqual((await query(token, "SELECT name FROM d1_migrations ORDER BY name")).map(row => row.name), plan.finalNames);
    return { mode, applied: migrations.map(row => row.name), next: "readback" };
  }
  assert(fs.existsSync(paths.marker));
  const sql186 = fs.readFileSync(path.join(plan.directory, migrations[0].name), "utf8");
  const sql187 = fs.readFileSync(path.join(plan.directory, migrations[1].name), "utf8");
  const expected = new Map([
    ["project_alpha_api_v2_directory_observations_current", sql186.match(/CREATE VIEW[\s\S]*?;\s*$/u)?.[0]],
    ["operations_portal_native_delivery_grant_folder_guard", sql187.match(/CREATE TRIGGER[\s\S]*?END;/u)?.[0]],
  ]);
  assertPostflightPreserved(current, saved.snapshot, expected);
  return { mode, applied: applied.length, exactChangedSchema: true, unrelatedStatePreserved: true, mutationsPerformed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : "failed", retryAllowed: false }));
    process.exitCode = 1;
  });
}
