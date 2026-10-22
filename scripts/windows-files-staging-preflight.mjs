import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "apps/client/node_modules/wrangler/bin/wrangler.js");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const AUDIENCES = Object.freeze({
  operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b",
  delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc",
});
const PORTAL = "https://portal-staging.ledgetopdroneservices.com";
const OPS = "https://ops-staging.ledgetopdroneservices.com";
// No caller-supplied DB identifier, timestamp, bookmark or command fragment.
const RECOVERY_READS = Object.freeze({
  operations: Object.freeze(["d1", "time-travel", "info", "ltds-ops-staging", "--json"]),
  delivery: Object.freeze(["d1", "time-travel", "info", "client-data-staging", "--json"]),
});
export const WINDOWS_STAGING_READ_QUERIES = Object.freeze({
  ledger: "SELECT name FROM d1_migrations ORDER BY id",
  foreignKeys: "PRAGMA foreign_key_check",
  schema: "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name",
});
const SCHEMA_PAGE = 128, SCHEMA_PAGES = 32;
export function windowsStagingSchemaQuery(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= SCHEMA_PAGE * SCHEMA_PAGES || offset % SCHEMA_PAGE !== 0)
    fail("schema_page_invalid");
  // Only this bounded integer originates in the internal page loop. No
  // metadata, user argument or SQL identifier is interpolated into a query.
  return `${WINDOWS_STAGING_READ_QUERIES.schema} LIMIT ${SCHEMA_PAGE} OFFSET ${offset}`;
}
const MIGRATIONS = Object.freeze({
  operations: { binding: "OPS_DB", baseline: "0221_portal_correspondence_lifecycle_write_guards.sql", suffix: [
    "0222_employee_read_roots.sql", "0223_employee_read_provisioning.sql", "0224_windows_portal_publication_chain_index.sql"] },
  delivery: { binding: "DELIVERY_DB", baseline: "0234_pa_principal_reenrollment.sql", suffix: [
    "0235_windows_portal_successor_candidates.sql", "0236_windows_portal_successor_content_start_audit.sql"] },
});
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
function json(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) fail("wrangler_output_invalid");
  try { return JSON.parse(text); } catch { return fail("wrangler_json_invalid"); }
}
async function installedWrangler(args, options) {
  try {
    const result = await promisify(execFile)(process.execPath, [WRANGLER, ...args], {
      cwd: options.cwd, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" },
      encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false,
    });
    return result.stdout;
  } catch { return fail("wrangler_read_failed"); }
}
function latestDeployment(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail("deployment_list_invalid");
  const sorted = value.map(item => {
    if (!item || !UUID.test(item.id) || typeof item.created_on !== "string" || !Number.isFinite(Date.parse(item.created_on))) fail("deployment_list_invalid");
    return item;
  }).sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  if (sorted.length > 1 && Date.parse(sorted[0].created_on) === Date.parse(sorted[1].created_on)) fail("deployment_latest_ambiguous");
  const latest = sorted[0];
  if (!Array.isArray(latest.versions) || latest.versions.length !== 1 || latest.versions[0]?.percentage !== 100
    || !UUID.test(latest.versions[0]?.version_id)) fail("deployment_not_single_version");
  return { deploymentId: latest.id, createdAt: new Date(latest.created_on).toISOString(), versionId: latest.versions[0].version_id };
}
function versionReceipt(app, detail, deployment) {
  if (!detail || detail.id !== deployment.versionId || !Array.isArray(detail.resources?.bindings) || detail.resources.bindings.length > 1000) fail("version_detail_invalid");
  const bindings = detail.resources.bindings, names = bindings.map(b => b?.name);
  if (names.some(n => typeof n !== "string" || !NAME.test(n)) || new Set(names).size !== names.length) fail("version_bindings_invalid");
  const inventory = STAGING_INVENTORY[app], get = (name, type) => bindings.find(b => b.name === name && b.type === type);
  const vars = Object.fromEntries(bindings.filter(b => b.type === "plain_text").map(b => [b.name, b.text]));
  if (vars.ENVIRONMENT !== "staging" || vars.TEAM_DOMAIN !== ISSUER) fail("version_environment_mismatch");
  if (app === "operations") {
    if (vars.PUBLIC_BASE_URL !== OPS || vars.EXPECTED_HOST !== new URL(OPS).host || vars.OPERATIONS_AUD !== AUDIENCES.operations) fail("version_identity_mismatch");
  } else if (vars.CLIENT_PORTAL_ORIGIN !== PORTAL || vars.CLIENT_ACCESS_TEAM_DOMAIN !== ISSUER || vars.CLIENT_ACCESS_AUD !== AUDIENCES.delivery
    || vars.CLIENT_ACCESS_AUDS !== undefined && vars.CLIENT_ACCESS_AUDS !== AUDIENCES.delivery) fail("version_identity_mismatch");
  for (const [type, expected, field, expectedField] of [["d1", inventory.d1_databases, "id", "database_id"], ["r2_bucket", inventory.r2_buckets, "bucket_name", "bucket_name"]]) {
    const actual = bindings.filter(b => b.type === type);
    if (actual.length !== expected.length || expected.some(b => get(b.binding, type)?.[field] !== b[expectedField])) fail("version_resource_mismatch");
  }
  const services = bindings.filter(b => b.type === "service");
  for (const service of services) {
    const expected = inventory.services.find(b => b.binding === service.name);
    // Cloudflare labels a named Worker's default service environment
    // "production", including Workers whose exact name is staging-only.
    // The service NAME/entrypoint above remain the inventory authority; a
    // non-default named service environment would select a different target.
    if (!expected || service.service !== expected.service || service.entrypoint !== expected.entrypoint
      || ![undefined, "", "production"].includes(service.environment)) fail("version_service_mismatch");
  }
  const required = app === "delivery" ? ["OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"]
    : ["OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY", "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION", "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY"];
  if (required.some(name => !get(name, "service"))) fail("version_service_mismatch");
  return { app, workerName: inventory.name, ...deployment, issuer: ISSUER, audience: AUDIENCES[app],
    origin: app === "operations" ? OPS : PORTAL,
    databases: inventory.d1_databases.map(b => ({ binding: b.binding, name: b.database_name, id: b.database_id })),
    buckets: inventory.r2_buckets.map(b => ({ binding: b.binding, name: b.bucket_name })),
    services: services.map(b => ({ binding: b.name, workerName: b.service, entrypoint: b.entrypoint })).sort((a, b) => a.binding.localeCompare(b.binding)),
    secretSlots: bindings.filter(b => b.type === "secret_text").map(b => b.name).sort() };
}
function queryRows(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0].results) || value[0].results.length > 10_000) fail("database_response_invalid");
  return value[0].results;
}
function ledgerReceipt(app, rows) {
  if (rows.length > 1000 || rows.some(r => !r || Object.keys(r).join() !== "name" || typeof r.name !== "string" || !/^\d{4}_[a-z0-9_]{1,200}\.sql$/.test(r.name))) fail("migration_ledger_invalid");
  const names = rows.map(r => r.name);
  if (new Set(names).size !== names.length) fail("migration_ledger_invalid");
  const rule = MIGRATIONS[app], index = names.indexOf(rule.baseline), applied = names.filter(n => rule.suffix.includes(n));
  let status = "baseline_missing";
  if (index >= 0) {
    const after = names.slice(index + 1);
    status = after.length <= rule.suffix.length && after.every((n, i) => n === rule.suffix[i]) && applied.length === after.length
      ? after.length === rule.suffix.length ? "suffix_applied" : after.length ? "suffix_partially_applied" : "suffix_pending"
      : "ledger_order_requires_review";
  }
  return { status, baseline: rule.baseline, canonicalBaselineVerified: false,
    note: "Complete observed ledger retained; presence of the named baseline and ordered suffix do not verify all earlier migrations against canonical source.",
    names, count: names.length, sha256: hash(names), requiredSuffix: rule.suffix, pending: rule.suffix.filter(n => !names.includes(n)) };
}
function recoveryReceipt(value, startedAt) {
  // Conservative current documented format: unknown provider shapes need
  // review, rather than copying arbitrary provider text into the receipt.
  if (!value || Array.isArray(value) || Object.keys(value).join() !== "bookmark"
    || typeof value.bookmark !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/.test(value.bookmark)) fail("recovery_metadata_invalid");
  return { bookmark: value.bookmark, observationStartedAt: startedAt, observationCompletedAt: new Date().toISOString(),
    restoreVerified: false, crossDatabaseAtomicSnapshot: false,
    note: "Provider-reported current recovery bookmark, observed sequentially per database. Not a backup export, restore test, atomic paired snapshot or readiness approval; retention may expire." };
}

/** Read-only observations only. The executable CLI requires --read-only; callers
 * must also opt in explicitly. This never applies migrations or activates routes. */
export async function windowsFilesStagingPreflight({ readOnly = false, recoveryMetadata = false, run = installedWrangler } = {}) {
  if (typeof recoveryMetadata !== "boolean") fail("recovery_opt_in_invalid");
  if (recoveryMetadata && readOnly !== true) fail("recovery_requires_read_only");
  if (readOnly !== true) return { schemaVersion: 1, status: "not_run", requiredFlag: "--read-only" };
  const directory = await mkdtemp(path.join(tmpdir(), "ops-windows-read-preflight-")), configPath = path.join(directory, "wrangler.json");
  const config = { account_id: STAGING_ACCOUNT_ID, name: "windows-files-read-preflight-staging", compatibility_date: "2026-10-01", send_metrics: false,
    d1_databases: [STAGING_INVENTORY.operations.d1_databases.find(b => b.binding === "OPS_DB"), ...STAGING_INVENTORY.delivery.d1_databases]
      .map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id })) };
  try {
    await writeFile(configPath, JSON.stringify(config), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const read = async args => {
      try { return json(await run([...args, "--config", configPath], { cwd: directory })); }
      catch (error) { if (error?.code === "wrangler_json_invalid" || error?.code === "wrangler_output_invalid") throw error; return fail("wrangler_read_failed"); }
    };
    const workers = [];
    // Validate BOTH live versions before any database query can be issued.
    for (const app of ["operations", "delivery"]) {
      const name = STAGING_INVENTORY[app].name;
      const deployment = latestDeployment(await read(["deployments", "list", "--name", name, "--json"]));
      workers.push(versionReceipt(app, await read(["versions", "view", deployment.versionId, "--name", name, "--json"]), deployment));
    }
    // Only after both inventories have matched. Metadata reads never restore,
    // export, mutate or activate anything, and are absent by default.
    if (recoveryMetadata) {
      for (const worker of workers) {
        const target = worker.databases.find(b => b.binding === MIGRATIONS[worker.app].binding);
        if (target.name !== RECOVERY_READS[worker.app][3]) fail("version_resource_mismatch");
        const startedAt = new Date().toISOString();
        worker.recovery = recoveryReceipt(await read(RECOVERY_READS[worker.app]), startedAt);
      }
    }
    for (const worker of workers) {
      const target = worker.databases.find(b => b.binding === MIGRATIONS[worker.app].binding);
      const query = async sql => queryRows(await read(["d1", "execute", target.name, "--remote", "--command", sql, "--json"]));
      worker.migrations = ledgerReceipt(worker.app, await query(WINDOWS_STAGING_READ_QUERIES.ledger));
      worker.foreignKeyViolationCount = (await query(WINDOWS_STAGING_READ_QUERIES.foreignKeys)).length;
      const schema = [], identities = new Set();
      for (let page = 0; page < SCHEMA_PAGES; page++) {
        const rows = await query(windowsStagingSchemaQuery(page * SCHEMA_PAGE));
        if (rows.length > SCHEMA_PAGE || rows.some(r => !r || Object.keys(r).sort().join() !== "name,sql,tbl_name,type" || typeof r.type !== "string" || typeof r.name !== "string"
          || typeof r.tbl_name !== "string" || r.sql !== null && typeof r.sql !== "string")) fail("schema_response_invalid");
        for (const row of rows) {
          const identity = JSON.stringify([row.type, row.name, row.tbl_name]);
          if (identities.has(identity)) fail("schema_response_invalid");
          identities.add(identity); schema.push(row);
        }
        if (rows.length < SCHEMA_PAGE) break;
        if (page === SCHEMA_PAGES - 1) fail("schema_page_limit");
      }
      worker.schemaSha256 = hash(schema.map(r => [r.type, r.name, r.tbl_name, r.sql]));
      worker.schemaObjectCount = schema.length;
      worker.schemaObservation = "Bounded ordered pages, not an atomic schema snapshot; re-read before activation.";
    }
    return { schemaVersion: 1, status: "read_only_observed", accountId: STAGING_ACCOUNT_ID, workers,
      activated: false, migrationsApplied: false, versionBindingsMatchedInventory: true,
      note: "Live version metadata and read-only schema observations; not route activation, authority, desktop or deployment acceptance." };
  } finally {
    // Only this invocation's single owned file and now-empty directory.
    await unlink(configPath).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--read-only", "--recovery-metadata"].includes(arg)) || new Set(args).size !== args.length
    || args.includes("--recovery-metadata") && !args.includes("--read-only")) {
    process.stderr.write("windows_staging_preflight_arguments\n"); process.exitCode = 1;
  } else try { process.stdout.write(JSON.stringify(await windowsFilesStagingPreflight({ readOnly: args.includes("--read-only"), recoveryMetadata: args.includes("--recovery-metadata") }), null, 2) + "\n"); }
  catch (error) {
    const allowed = new Set(["wrangler_read_failed", "wrangler_output_invalid", "wrangler_json_invalid", "deployment_list_invalid", "deployment_latest_ambiguous",
      "deployment_not_single_version", "version_detail_invalid", "version_bindings_invalid", "version_environment_mismatch", "version_identity_mismatch",
      "version_resource_mismatch", "version_service_mismatch", "database_response_invalid", "migration_ledger_invalid", "schema_response_invalid", "schema_page_invalid", "schema_page_limit",
      "recovery_metadata_invalid", "recovery_opt_in_invalid", "recovery_requires_read_only"]);
    process.stderr.write((allowed.has(error?.code) ? error.code : "windows_staging_preflight_failed") + "\n"); process.exitCode = 1;
  }
}
