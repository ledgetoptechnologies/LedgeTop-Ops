import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  applicationTableNames,
  assertApplyReady,
  assertAttemptMarker,
  assertExactLedger,
  assertPinnedWranglerVersion,
  assertPreserved,
  normalizedSql,
  quoteSqlIdentifier,
  reviewedSchemaDefinitions,
} from "./staging-native-portal-149-194-migrations.mjs";
import { BOOTSTRAP_APPS } from "./staging-bootstrap.mjs";
import { collectOrderedReadOnlySnapshot } from "./ordered-read-only-snapshot.mjs";
import { readCompleteTableSnapshot } from "./read-complete-table-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/operations/package.json"));
const { unstable_splitSqlQuery: splitSql } = require("wrangler");
const account = "846c924bf17bf4f3dd15c97a4c5d1d51";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const SPEC = Object.freeze({
  application: "operations",
  preservationPolicy: "strict",
  from: 196,
  to: 198,
  database: "78b34173-b168-4e3d-9832-bb9d245cc6b8",
  databaseName: "ltds-ops-staging",
  binding: "OPS_DB",
  priorNamesSha256: "c8f55f7a543d1e51d69abce753c2ce54a4640c35fd93c2769c8e971bb8162106",
  priorContentsSha256: "5dd50102b800eb3b49c9c5f41adb6f1ce44005425118b718ecc544e7f0b49c03",
  suffix: Object.freeze([
    Object.freeze({ name: "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql", sha256: "9cf2194a57cf7888c768d492c78cacf842e3f6c6814d3f395e6fa8f4d0a31a76" }),
    Object.freeze({ name: "0198_native_directory_active_binding_revision_refresh.sql", sha256: "a51026608eb70a0645540cfe12bad51feb7a97f924e0b2c3b83837a3ae2fa7c3" }),
  ]),
});

const safeLabel = value => {
  if (value === undefined) return null;
  assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value), "artifact-set label must be 1-64 safe ASCII characters");
  return value;
};
const locations = (base, label) => {
  const suffix = label ? `-${label}` : "";
  return {
    directory: path.join(base, `apps/operations/.tmp-checks/native-directory-196-198-migrations${suffix}`),
    config: path.join(base, `apps/operations/.tmp-checks/native-directory-196-198-config${suffix}.json`),
    backup: path.join(base, `apps/operations/.backups/native-directory-before-198${suffix}.sql`),
    evidence: path.join(base, `apps/operations/.backups/native-directory-before-198${suffix}.json`),
    // Labels namespace evidence only. A possibly attempted apply is shared across this exact window.
    marker: path.join(base, "apps/operations/.backups/native-directory-196-198-apply-attempt.json"),
  };
};
function regular(file, label) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
}
function restrictPrivate(file) {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    assert.equal(fs.statSync(file).mode & 0o077, 0, "private artifact must not be accessible to group or other users");
    return;
  }
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File",
    path.join(root, "scripts/restrict-private-authority-file.ps1"), "-LiteralFile", file],
  { windowsHide: true, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, "private artifact ACL failed; no remote write attempted");
}
function privateFile(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { flag: "wx", ...(process.platform === "win32" ? {} : { mode: 0o600 }) });
  restrictPrivate(file);
  fs.writeFileSync(file, contents);
}
const canonicalRows = rows => [...rows].map(row => JSON.stringify(row)).sort();
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";

export function buildNativeDirectory196To198Plan(base = root, label) {
  const artifactSet = safeLabel(label);
  const sourceDirectory = path.join(base, "apps/operations/migrations");
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true }).filter(entry => entry.name.endsWith(".sql"));
  assert(entries.every(entry => entry.isFile() && !entry.isSymbolicLink()), "migration chain must contain regular files");
  const sourceNames = entries.map(entry => entry.name).sort();
  const current = BOOTSTRAP_APPS.operations;
  assert.equal(sourceNames.length, current.migrationCount, "exact current Operations bootstrap inventory required");
  assert.equal(sha(sourceNames.join("\n")), current.migrationNamesSha256, "current Operations migration names drifted");
  assert.equal(sha(sourceNames.map(name => `${name}\0${sha(fs.readFileSync(path.join(sourceDirectory, name)))}`).join("\n")),
    current.migrationContentsSha256, "current Operations migration content drifted");

  const priorNames = sourceNames.slice(0, SPEC.from);
  assert.equal(priorNames.length, SPEC.from);
  assert.equal(sha(priorNames.join("\n")), SPEC.priorNamesSha256, "immutable 196 migration names drifted");
  assert.equal(sha(priorNames.map(name => `${name}\0${sha(fs.readFileSync(path.join(sourceDirectory, name)))}`).join("\n")),
    SPEC.priorContentsSha256, "immutable 196 migration contents drifted");
  const suffixNames = sourceNames.slice(SPEC.from, SPEC.to);
  assert.deepEqual(suffixNames, SPEC.suffix.map(item => item.name), "only the reviewed 0197/0198 suffix is allowed");
  const migrations = suffixNames.map((name, index) => {
    const item = { name, sha256: sha(fs.readFileSync(path.join(sourceDirectory, name))) };
    assert.equal(item.sha256, SPEC.suffix[index].sha256, `${name} content hash drifted`);
    return Object.freeze(item);
  });
  assert(sourceNames.length >= SPEC.to, "current chain must include the reviewed migration 0198 prefix");
  return Object.freeze({ spec: SPEC, windowKey: "operations", artifactSet, sourceDirectory,
    priorNames: Object.freeze(priorNames), finalNames: Object.freeze(sourceNames.slice(0, SPEC.to)), migrations: Object.freeze(migrations),
    ...locations(base, artifactSet) });
}

export function assertNativeDirectoryExactLedger(rows, names, label) {
  assertExactLedger(rows, names, `Operations ${label}`);
}
function expectedConfig(plan) {
  return {
    name: `migration-only-${SPEC.databaseName}-196-198${plan.artifactSet ? `-${plan.artifactSet}` : ""}`,
    account_id: account,
    d1_databases: [{ binding: SPEC.binding, database_name: SPEC.databaseName, database_id: SPEC.database,
      migrations_dir: path.relative(path.dirname(plan.config), plan.directory).replaceAll("\\", "/") }],
  };
}
export function materializeNativeDirectory196To198(plan) {
  assert(!fs.existsSync(plan.directory) && !fs.existsSync(plan.config), "migration artifacts already exist; inspect before continuing");
  fs.mkdirSync(plan.directory, { recursive: true });
  for (const item of plan.migrations)
    fs.copyFileSync(path.join(plan.sourceDirectory, item.name), path.join(plan.directory, item.name), fs.constants.COPYFILE_EXCL);
  privateFile(plan.config, `${JSON.stringify(expectedConfig(plan), null, 2)}\n`);
  return plan;
}

export async function nativeDirectory196To198ReadOnlyQueries(token, spec, queries, request = fetch) {
  assert.deepEqual(spec, SPEC, "only the pinned Operations staging database is allowed");
  assert(Array.isArray(queries) && queries.length >= 1 && queries.length <= 2, "bounded read-only query batch required");
  for (const sql of queries) {
    assert.match(sql, /^SELECT\s/u, "read-only SELECT required");
    const statements = splitSql(sql.replace(/\r\n/gu, "\n")).map(statement => statement.trim()).filter(Boolean);
    assert.equal(statements.length, 1, "exactly one read-only statement required per query");
    assert.match(statements[0], /^SELECT\s/u, "read-only SELECT required");
  }
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${SPEC.database}/query`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(queries.length === 1 ? { sql: queries[0] } : { batch: queries.map(sql => ({ sql })) }),
  });
  const body = await response.json();
  assert(response.ok && body.success && body.result?.length === queries.length, "read-only D1 query failed");
  return body.result.map(result => {
    assert(result.success && Array.isArray(result.results), "read-only D1 result failed");
    assert.equal(result.meta.changed_db, false, "read query unexpectedly changed D1");
    return result.results;
  });
}
async function select(token, sql, dependencies) {
  return (await nativeDirectory196To198ReadOnlyQueries(token, SPEC, [sql], dependencies.request))[0];
}
async function remoteState(token, dependencies) {
  const schema = await select(token, schemaSql, dependencies);
  const data = await collectOrderedReadOnlySnapshot(applicationTableNames(schema), async table => canonicalRows(
    await readCompleteTableSnapshot(table, queries => nativeDirectory196To198ReadOnlyQueries(token, SPEC, queries, dependencies.request))));
  return {
    ledger: await select(token, "SELECT name FROM d1_migrations ORDER BY name", dependencies),
    foreignKeys: await select(token, 'SELECT * FROM pragma_foreign_key_check ORDER BY "table", rowid, parent, fkid', dependencies),
    schema,
    data,
  };
}
function configuredCredential() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert(typeof token === "string" && token.length > 0, "explicit configured provider credential required");
  return token;
}
const wranglerFailure = outcomeCode => Object.assign(Error("provider command outcome unavailable; reconcile before any retry"), { outcomeCode });
function pinnedWrangler(token, plan, args) {
  const appDirectory = path.join(root, "apps/operations");
  const launcher = path.join(appDirectory, "node_modules/wrangler/bin/wrangler.js");
  try {
    const lockfile = path.join(appDirectory, "package-lock.json");
    const installed = path.join(appDirectory, "node_modules/wrangler/package.json");
    regular(lockfile, "application lockfile");
    regular(installed, "installed Wrangler package metadata");
    assertPinnedWranglerVersion(JSON.parse(fs.readFileSync(lockfile, "utf8")), JSON.parse(fs.readFileSync(installed, "utf8")));
  } catch { throw wranglerFailure("dependency-mismatch"); }
  try { regular(launcher, "Wrangler launcher"); } catch { throw wranglerFailure("launcher-invalid"); }
  const child = spawnSync(process.execPath, [launcher, "d1", ...args, "--config", plan.config], {
    cwd: root, windowsHide: true, timeout: 180000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  if (child.error) throw wranglerFailure(child.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed");
  if (child.status === null) throw wranglerFailure("timeout-or-signal");
  if (child.status !== 0) throw wranglerFailure("exit-nonzero");
}

export async function runNativeDirectory196To198(argv = process.argv.slice(2), dependencies = {}) {
  assert([1, 2].includes(argv.length), "usage: <preflight|backup|apply|reconcile> [artifact-set]");
  const [mode, label] = argv;
  assert(["dry-run", "preflight", "backup", "apply", "reconcile"].includes(mode), "unsupported migration mode");
  const plan = buildNativeDirectory196To198Plan(dependencies.root ?? root, label);
  if (mode === "dry-run") return { application: "operations", mode, account, database: SPEC.database, from: 196, to: 198,
    migrations: plan.migrations, mutationsPerformed: false };
  const token = (dependencies.credential ?? configuredCredential)();
  const read = dependencies.remoteState ?? ((value) => remoteState(value, dependencies));
  const current = await read(token, plan);
  assert.deepEqual(current.foreignKeys, [], "D1 foreign-key violations must be resolved first");
  assertNativeDirectoryExactLedger(current.ledger, mode === "reconcile" ? plan.finalNames : plan.priorNames, mode === "reconcile" ? 198 : 196);
  if (mode === "preflight") return { application: "operations", mode, pending: plan.migrations, mutationsPerformed: false };

  if (mode === "backup") {
    for (const file of [plan.directory, plan.config, plan.backup, plan.evidence, plan.marker])
      assert(!fs.existsSync(file), "exclusive migration artifact already exists; inspect before continuing");
    materializeNativeDirectory196To198(plan);
    privateFile(plan.backup);
    try { (dependencies.wrangler ?? pinnedWrangler)(token, plan, ["export", SPEC.databaseName, "--remote", "--output", plan.backup]); }
    catch (error) { throw Object.assign(Error("provider export outcome unavailable"), { stage: "provider-export", outcomeCode: error?.outcomeCode }); }
    try { restrictPrivate(plan.backup); regular(plan.backup, "backup"); assert(fs.statSync(plan.backup).size > 1000, "complete D1 export required"); }
    catch (error) { throw Object.assign(error, { stage: "export-verification" }); }
    privateFile(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database, ...(plan.artifactSet ? { artifactSet: plan.artifactSet } : {}),
      createdAt: new Date().toISOString(), backupSha256: sha(fs.readFileSync(plan.backup)), migrations: plan.migrations, snapshot: current }));
    return { application: "operations", mode, mutationsPerformed: false, backupBytes: fs.statSync(plan.backup).size };
  }

  for (const file of [plan.config, plan.backup, plan.evidence]) regular(file, "private release artifact");
  const saved = JSON.parse(fs.readFileSync(plan.evidence, "utf8"));
  assert.equal(saved.application, "operations");
  assert.equal(saved.database, SPEC.database);
  assert.equal(saved.artifactSet ?? null, plan.artifactSet);
  assert.equal(saved.backupSha256, sha(fs.readFileSync(plan.backup)));
  assert.deepEqual(saved.migrations, plan.migrations);
  assert.deepEqual(JSON.parse(fs.readFileSync(plan.config, "utf8")), expectedConfig(plan));
  assert.deepEqual(fs.readdirSync(plan.directory).sort(), plan.migrations.map(item => item.name));
  for (const item of plan.migrations)
    assert.equal(sha(fs.readFileSync(path.join(plan.directory, item.name))), item.sha256, `${item.name} artifact changed`);

  if (mode === "apply") {
    assertApplyReady(current, saved, fs.existsSync(plan.marker));
    assert.equal(fs.existsSync(plan.marker), false, "existing attempt; reconcile only");
    privateFile(plan.marker, JSON.stringify({ application: "operations", database: SPEC.database, from: 196, to: 198,
      ...(plan.artifactSet ? { artifactSet: plan.artifactSet } : {}), migrations: plan.migrations,
      attemptedAt: new Date().toISOString(), retryAllowed: false }));
    (dependencies.wrangler ?? pinnedWrangler)(token, plan, ["migrations", "apply", SPEC.databaseName, "--remote"]);
    return { application: "operations", mode, retryAllowed: false, next: "reconcile" };
  }

  regular(plan.marker, "apply attempt marker");
  assertAttemptMarker(JSON.parse(fs.readFileSync(plan.marker, "utf8")), plan);
  const sql = plan.migrations.map(item => fs.readFileSync(path.join(plan.directory, item.name), "utf8")).join("\n");
  assertPreserved(saved.snapshot, current, reviewedSchemaDefinitions(sql), "strict");
  return { application: "operations", mode, applied: 198, mutationsPerformed: false, retryAllowed: false };
}

export const safeNativeDirectory196To198Failure = () => JSON.stringify({
  error: "staging migration boundary rejected; inspect private local evidence",
  retryAllowed: false,
});
export { applicationTableNames, assertApplyReady, assertAttemptMarker, assertPreserved, normalizedSql, quoteSqlIdentifier, reviewedSchemaDefinitions, SPEC };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeDirectory196To198().then(value => console.log(JSON.stringify(value))).catch(() => {
    console.error(safeNativeDirectory196To198Failure());
    process.exitCode = 1;
  });
