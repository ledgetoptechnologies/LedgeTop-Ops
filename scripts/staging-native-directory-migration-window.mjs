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
import { OPERATIONS_REVIEWED_SOURCE_MIGRATION_CHAIN_204 } from "./staging-bootstrap.mjs";
import { OPERATIONS_SOURCE_CHAIN_204 } from "./staging-operations-source-v204.mjs";
import { OPERATIONS_SOURCE_CHAIN_205 } from "./staging-operations-source-v205.mjs";
import { collectOrderedReadOnlySnapshot } from "./ordered-read-only-snapshot.mjs";
import { readCompleteTableSnapshot } from "./read-complete-table-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "apps/operations/package.json"));
const { unstable_splitSqlQuery: splitSql } = require("wrangler");
const account = "846c924bf17bf4f3dd15c97a4c5d1d51";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
// SQLite stores schema SQL without comments which precede CREATE. Normalize
// each D1 statement the same way, and omit only the foreign_keys preamble, so
// every reviewed object (including each migration's first table) is compared.
export const reviewedNativeDirectorySchemaDefinitions = sql => {
  const statements = splitSql(sql.replace(/\r\n/gu, "\n")).map(raw => {
    const lines = raw.trim().split("\n");
    while (lines.length && (!lines[0].trim() || lines[0].trim().startsWith("--"))) lines.shift();
    return lines.join("\n").trim();
  }).filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/iu.test(statement));
  return reviewedSchemaDefinitions(statements.join(";\n"));
};
// Shared lifecycle; window wrappers provide immutable reviewed specifications.
export function createNativeDirectoryMigrationWindow(SPEC, sourceCiGate = null, reconcile = null, profile = null) {
  assert(SPEC.application === "operations" && SPEC.preservationPolicy === "strict"
    && SPEC.database === "78b34173-b168-4e3d-9832-bb9d245cc6b8" && SPEC.databaseName === "ltds-ops-staging" && SPEC.binding === "OPS_DB",
    "only the pinned Operations staging boundary is allowed");
  const billing205 = SPEC.from === 204 && SPEC.to === 205 && profile !== null;
  if (profile !== null) {
    assert(billing205, "only the explicit reviewed205 profile may override migration artifacts or source inventory");
    assert.deepEqual(profile, { sourceChain: OPERATIONS_SOURCE_CHAIN_205, generatedArtifacts: "ignored-native-billing-205" },
      "exact reviewed205 profile required");
    assert.equal(SPEC.priorNamesSha256, OPERATIONS_SOURCE_CHAIN_204.namesSha256, "frozen204 names required");
    assert.equal(SPEC.priorContentsSha256, OPERATIONS_SOURCE_CHAIN_204.contentsSha256, "frozen204 content required");
    assert.deepEqual(SPEC.suffix, Object.entries(OPERATIONS_SOURCE_CHAIN_205.appendedMigrations)
      .map(([name, sha256]) => ({ name, sha256 })), "exact reviewed205 suffix required");
    assert.equal(reconcile, null, "205 requires unchanged generic strict preservation");
  }
  assert(SPEC.from === 196 && SPEC.to === 198 || SPEC.from === 198 && SPEC.to === 199
    || SPEC.from === 200 && SPEC.to === 203 || SPEC.from === 203 && SPEC.to === 204 || billing205,
    "only reviewed native Directory migration windows are allowed");
  if (SPEC.to === 199 || SPEC.to >= 203)
    assert.equal(typeof sourceCiGate, "function", `${String(SPEC.to).padStart(4, "0")} source CI execution gate required`);
  const window = `${SPEC.from}-${SPEC.to}`;

const safeLabel = value => {
  if (value === undefined) return null;
  assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value), "artifact-set label must be 1-64 safe ASCII characters");
  return value;
};
const locations = (base, label) => {
  const suffix = label ? `-${label}` : "";
  const generated = billing205 ? "apps/operations/.staging-native-authority" : "apps/operations/.tmp-checks";
  return {
    directory: path.join(base, `${generated}/native-directory-${window}-migrations${suffix}`),
    config: path.join(base, `${generated}/native-directory-${window}-config${suffix}.json`),
    backup: path.join(base, `apps/operations/.backups/native-directory-before-${SPEC.to}${suffix}.sql`),
    evidence: path.join(base, `apps/operations/.backups/native-directory-before-${SPEC.to}${suffix}.json`),
    // Labels namespace evidence only. A possibly attempted apply is shared across this exact window.
    marker: path.join(base, `apps/operations/.backups/native-directory-${window}-apply-attempt.json`),
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
function assertPrivate(file) {
  regular(file, "private artifact");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o077, 0, "private artifact permissions widened after creation");
    return;
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$item = Get-Item -LiteralPath $env:CODEX_PRIVATE_ARTIFACT_FILE -Force
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
$acl = Get-Acl -LiteralPath $item.FullName
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($user, 'S-1-5-18', 'S-1-5-32-544')
if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) { exit 1 }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 3) { exit 1 }
$seen = @{}
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Value
  if ($sid -notin $allowed -or $seen.ContainsKey($sid) -or $rule.IsInherited -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or
      $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { exit 1 }
  $seen[$sid] = $true
}
if ($seen.Count -ne 3) { exit 1 }
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout: 30000, env: { ...process.env, CODEX_PRIVATE_ARTIFACT_FILE: file } });
  assert.equal(result.status, 0, "private artifact ACL widened after creation; no remote write attempted");
}
function privateFile(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { flag: "wx", ...(process.platform === "win32" ? {} : { mode: 0o600 }) });
  restrictPrivate(file);
  fs.writeFileSync(file, contents);
}
const canonicalRows = rows => [...rows].map(row => JSON.stringify(row)).sort();
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
function buildNativeDirectoryMigrationWindowPlan(base = root, label) {
  const artifactSet = safeLabel(label);
  const sourceDirectory = path.join(base, "apps/operations/migrations");
  const directoryStat = fs.lstatSync(sourceDirectory);
  assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), "regular migration directory required");
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true }).filter(entry => /\.sql$/i.test(entry.name));
  assert(entries.every(entry => /^\d{4}_.+\.sql$/.test(entry.name)), "canonical migration names required");
  assert(entries.every(entry => entry.isFile() && !entry.isSymbolicLink()), "migration chain must contain regular files");
  const sourceNames = entries.map(entry => entry.name).sort();
  const current = billing205 ? OPERATIONS_SOURCE_CHAIN_205 : OPERATIONS_REVIEWED_SOURCE_MIGRATION_CHAIN_204;
  if (SPEC.to === 199 || SPEC.to >= 203)
    assert(sourceNames.length >= SPEC.to, `reviewed source chain must contain the exact ${String(SPEC.to).padStart(4, "0")} window`);
  assert.equal(sourceNames.length, current.count, "exact current Operations source inventory required");
  assert.equal(sha(sourceNames.join("\n")), current.namesSha256, "current Operations migration names drifted");
  assert.equal(sha(sourceNames.map(name => `${name}\0${sha(fs.readFileSync(path.join(sourceDirectory, name)))}`).join("\n")),
    current.contentsSha256, "current Operations migration content drifted");

  const priorNames = sourceNames.slice(0, SPEC.from);
  assert.equal(priorNames.length, SPEC.from);
  assert.equal(sha(priorNames.join("\n")), SPEC.priorNamesSha256, "immutable prior migration names drifted");
  assert.equal(sha(priorNames.map(name => `${name}\0${sha(fs.readFileSync(path.join(sourceDirectory, name)))}`).join("\n")),
    SPEC.priorContentsSha256, "immutable prior migration contents drifted");
  const suffixNames = sourceNames.slice(SPEC.from, SPEC.to);
  assert.deepEqual(suffixNames, SPEC.suffix.map(item => item.name), "only the reviewed suffix is allowed");
  const migrations = suffixNames.map((name, index) => {
    const item = { name, sha256: sha(fs.readFileSync(path.join(sourceDirectory, name))) };
    assert.equal(item.sha256, SPEC.suffix[index].sha256, `${name} content hash drifted`);
    return Object.freeze(item);
  });
  assert(sourceNames.length >= SPEC.to, "current chain must include the reviewed prefix");
  return Object.freeze({ spec: SPEC, windowKey: "operations", artifactSet, sourceDirectory,
    priorNames: Object.freeze(priorNames), finalNames: Object.freeze(sourceNames.slice(0, SPEC.to)), migrations: Object.freeze(migrations),
    ...locations(base, artifactSet) });
}

function assertNativeDirectoryExactLedger(rows, names, label) {
  assertExactLedger(rows, names, `Operations ${label}`);
}
function expectedConfig(plan) {
  return {
    name: `migration-only-${SPEC.databaseName}-${window}${plan.artifactSet ? `-${plan.artifactSet}` : ""}`,
    account_id: account,
    d1_databases: [{ binding: SPEC.binding, database_name: SPEC.databaseName, database_id: SPEC.database,
      migrations_dir: path.relative(path.dirname(plan.config), plan.directory).replaceAll("\\", "/") }],
  };
}
function materializeNativeDirectoryMigrationWindow(plan) {
  assert(!fs.existsSync(plan.directory) && !fs.existsSync(plan.config), "migration artifacts already exist; inspect before continuing");
  fs.mkdirSync(plan.directory, { recursive: true });
  for (const item of plan.migrations)
    fs.copyFileSync(path.join(plan.sourceDirectory, item.name), path.join(plan.directory, item.name), fs.constants.COPYFILE_EXCL);
  privateFile(plan.config, `${JSON.stringify(expectedConfig(plan), null, 2)}\n`);
  return plan;
}

async function nativeDirectoryMigrationWindowReadOnlyQueries(token, spec, queries, request = fetch) {
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
    if (SPEC.to >= 203) assert.equal(result.meta.served_by_primary, true, "current window precondition read must be served by D1 primary");
    return result.results;
  });
}
async function select(token, sql, dependencies) {
  return (await nativeDirectoryMigrationWindowReadOnlyQueries(token, SPEC, [sql], dependencies.request))[0];
}
async function remoteState(token, dependencies) {
  const schema = await select(token, schemaSql, dependencies);
  const data = await collectOrderedReadOnlySnapshot(applicationTableNames(schema), async table => canonicalRows(
    await readCompleteTableSnapshot(table, queries => nativeDirectoryMigrationWindowReadOnlyQueries(token, SPEC, queries, dependencies.request))));
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

async function runNativeDirectoryMigrationWindow(argv = process.argv.slice(2), dependencies = {}) {
  assert([1, 2].includes(argv.length), "usage: <preflight|backup|apply|reconcile> [artifact-set]");
  const [mode, label] = argv;
  assert(["dry-run", "preflight", "backup", "apply", "reconcile"].includes(mode), "unsupported migration mode");
  const plan = buildNativeDirectoryMigrationWindowPlan(dependencies.root ?? root, label);
  if (mode === "dry-run") return { application: "operations", mode, account, database: SPEC.database, from: SPEC.from, to: SPEC.to,
    migrations: plan.migrations, mutationsPerformed: false };
  const verifySourceCi = async () => {
    if (!sourceCiGate || !["backup", "apply"].includes(mode)) return null;
    const verified = await sourceCiGate(dependencies.root ?? root, dependencies);
    assert(verified && Object.keys(verified).sort().join(",") === "headSha,runId", "exact source CI verification required");
    assert.match(verified.headSha, /^[0-9a-f]{40}$/u, "verified source HEAD required");
    assert.match(verified.runId, /^[1-9][0-9]{0,19}$/u, "verified source CI run required");
    return verified;
  };
  const sourceCi = await verifySourceCi();
  const token = (dependencies.credential ?? configuredCredential)();
  const read = dependencies.remoteState ?? ((value) => remoteState(value, dependencies));
  const current = await read(token, plan);
  assert.deepEqual(current.foreignKeys, [], "D1 foreign-key violations must be resolved first");
  assertNativeDirectoryExactLedger(current.ledger, mode === "reconcile" ? plan.finalNames : plan.priorNames, mode === "reconcile" ? SPEC.to : SPEC.from);
  if (mode === "preflight") return { application: "operations", mode, pending: plan.migrations, mutationsPerformed: false };

  if (mode === "backup") {
    if (sourceCiGate) assert.deepEqual(await verifySourceCi(), sourceCi, "source CI changed during preflight");
    for (const file of [plan.directory, plan.config, plan.backup, plan.evidence, plan.marker])
      assert(!fs.existsSync(file), "exclusive migration artifact already exists; inspect before continuing");
    materializeNativeDirectoryMigrationWindow(plan);
    privateFile(plan.backup);
    try { (dependencies.wrangler ?? pinnedWrangler)(token, plan, ["export", SPEC.databaseName, "--remote", "--output", plan.backup]); }
    catch (error) { throw Object.assign(Error("provider export outcome unavailable"), { stage: "provider-export", outcomeCode: error?.outcomeCode }); }
    try { restrictPrivate(plan.backup); regular(plan.backup, "backup"); assert(fs.statSync(plan.backup).size > 1000,
      SPEC.to >= 203 ? "nonempty D1 export required; independently verify restorability before apply" : "complete D1 export required"); }
    catch (error) { throw Object.assign(error, { stage: "export-verification" }); }
    privateFile(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database, ...(plan.artifactSet ? { artifactSet: plan.artifactSet } : {}),
      createdAt: new Date().toISOString(), ...(sourceCi ? { sourceCi } : {}), backupSha256: sha(fs.readFileSync(plan.backup)), migrations: plan.migrations, snapshot: current }));
    return { application: "operations", mode, mutationsPerformed: false, backupBytes: fs.statSync(plan.backup).size };
  }

  for (const file of [plan.config, plan.backup, plan.evidence]) {
    regular(file, "private release artifact");
    if (SPEC.to >= 203) (dependencies.assertPrivate ?? assertPrivate)(file);
  }
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
    if (sourceCiGate) assert.deepEqual(saved.sourceCi, sourceCi, "backup source CI must match this exact candidate");
    assertApplyReady(current, saved, fs.existsSync(plan.marker));
    if (sourceCiGate) assert.deepEqual(await verifySourceCi(), sourceCi, "source CI changed during preflight");
    assert.equal(fs.existsSync(plan.marker), false, "existing attempt; reconcile only");
    privateFile(plan.marker, JSON.stringify({ application: "operations", database: SPEC.database, from: SPEC.from, to: SPEC.to,
      ...(plan.artifactSet ? { artifactSet: plan.artifactSet } : {}), migrations: plan.migrations,
      attemptedAt: new Date().toISOString(), ...(sourceCi ? { sourceCi } : {}), retryAllowed: false }));
    (dependencies.wrangler ?? pinnedWrangler)(token, plan, ["migrations", "apply", SPEC.databaseName, "--remote"]);
    return { application: "operations", mode, retryAllowed: false, next: "reconcile" };
  }

  regular(plan.marker, "apply attempt marker");
  if (SPEC.to >= 203) (dependencies.assertPrivate ?? assertPrivate)(plan.marker);
  const marker = JSON.parse(fs.readFileSync(plan.marker, "utf8"));
  if (sourceCiGate) {
    const { sourceCi: attemptCi, ...identity } = marker;
    assertAttemptMarker(identity, plan);
    assert(attemptCi && Object.keys(attemptCi).sort().join(",") === "headSha,runId", "attempt source CI evidence required");
    assert.match(attemptCi.headSha, /^[0-9a-f]{40}$/u, "attempt source HEAD required");
    assert.match(attemptCi.runId, /^[1-9][0-9]{0,19}$/u, "attempt source CI run required");
    assert.deepEqual(attemptCi, saved.sourceCi, "attempt source CI must match backup");
  } else assertAttemptMarker(marker, plan);
  const sql = plan.migrations.map(item => fs.readFileSync(path.join(plan.directory, item.name), "utf8")).join("\n");
  const definitions = SPEC.to >= 203 ? reviewedNativeDirectorySchemaDefinitions(sql) : reviewedSchemaDefinitions(sql);
  if (reconcile) reconcile(saved.snapshot, current, sql);
  else assertPreserved(saved.snapshot, current, definitions, "strict");
  return { application: "operations", mode, applied: SPEC.to, mutationsPerformed: false, retryAllowed: false };
}

const safeNativeDirectoryMigrationWindowFailure = () => JSON.stringify({
  error: "staging migration boundary rejected; inspect private local evidence",
  retryAllowed: false,
});
  return Object.freeze({ assertExactLedger: assertNativeDirectoryExactLedger, assertPrivate,
    buildPlan: buildNativeDirectoryMigrationWindowPlan, materialize: materializeNativeDirectoryMigrationWindow,
    readOnlyQueries: nativeDirectoryMigrationWindowReadOnlyQueries, run: runNativeDirectoryMigrationWindow,
    safeFailure: safeNativeDirectoryMigrationWindowFailure });
}
export { applicationTableNames, assertApplyReady, assertAttemptMarker, assertPreserved, normalizedSql, quoteSqlIdentifier, reviewedSchemaDefinitions };

