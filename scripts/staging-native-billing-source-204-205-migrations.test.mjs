import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SPEC, PROFILE, buildNativeBilling204To205Plan, materializeNativeBilling204To205,
  runNativeBilling204To205, nativeBilling204To205ReadOnlyQueries } from "./staging-native-billing-source-204-205-migrations.mjs";
import { buildNativeProject203To204Plan } from "./staging-native-project-203-204-migrations.mjs";
import { createNativeDirectoryMigrationWindow, applicationTableNames, assertPreserved,
  reviewedNativeDirectorySchemaDefinitions } from "./staging-native-directory-migration-window.mjs";
const root = path.resolve(import.meta.dirname, "..");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "native-billing-204-205-"));
  fs.mkdirSync(path.join(base, "apps/operations"), { recursive: true });
  fs.cpSync(path.join(root, "apps/operations/migrations"), path.join(base, "apps/operations/migrations"), { recursive: true });
  return base;
}
function cleanup(base) {
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
  assert(path.basename(base).startsWith("native-billing-204-205-"));
  fs.rmSync(base, { recursive: true, force: true });
}
test("205 is exact staging204 prefix plus one reviewed migration; frozen204 refuses physical205", async () => {
  const plan = buildNativeBilling204To205Plan(root);
  assert.equal(plan.priorNames.length, 204); assert.equal(plan.finalNames.length, 205);
  assert.deepEqual(plan.migrations, SPEC.suffix);
  assert.throws(() => buildNativeProject203To204Plan(root), /exact current Operations source inventory/);
  assert.throws(() => createNativeDirectoryMigrationWindow(SPEC, async () => ({})), /only reviewed/);
  for (const spec of [{ ...SPEC, database: "production" }, { ...SPEC, priorNamesSha256: "0".repeat(64) },
    { ...SPEC, priorContentsSha256: "0".repeat(64) }, { ...SPEC, suffix: [{ ...SPEC.suffix[0], sha256: "0".repeat(64) }] }])
    assert.throws(() => createNativeDirectoryMigrationWindow(spec, async () => ({}), null, PROFILE));
  assert.throws(() => createNativeDirectoryMigrationWindow(SPEC, async () => ({}), null,
    { ...PROFILE, generatedArtifacts: ".tmp-checks" }), /exact reviewed205 profile/);
  assert.throws(() => createNativeDirectoryMigrationWindow(SPEC, async () => ({}), () => {}, PROFILE), /strict preservation/);
  assert.equal((await runNativeBilling204To205(["dry-run"], { root,
    credential: () => assert.fail("no credential"), remoteState: () => assert.fail("no connection") })).mutationsPerformed, false);
});
test("205 inventory rejects altered prior or suffix bytes and uppercase hidden SQL", () => {
  for (const mutation of ["prefix", "suffix", "uppercase"]) {
    const base = fixture();
    try {
      const directory = path.join(base, "apps/operations/migrations");
      if (mutation === "uppercase") fs.writeFileSync(path.join(directory, "unreviewed.SQL"), "SELECT 1;");
      else fs.appendFileSync(path.join(directory, mutation === "prefix" ? "0204_native_project_archive_restore.sql" : SPEC.suffix[0].name), "\n-- altered bytes\n");
      assert.throws(() => buildNativeBilling204To205Plan(base));
    } finally { cleanup(base); }
  }
});
test("205 materialized artifacts do not dirty an otherwise clean exact source checkout", () => {
  const base = fixture();
  const git = args => {
    const result = spawnSync("git", args, { cwd: base, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, "local fixture git command failed"); return result.stdout.trim();
  };
  try {
    fs.copyFileSync(path.join(root, ".gitignore"), path.join(base, ".gitignore"));
    git(["init", "-q"]); git(["add", "."]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    assert.equal(git(["status", "--porcelain", "--untracked-files=normal"]), "");
    const plan = buildNativeBilling204To205Plan(base, "ignored-artifacts");
    materializeNativeBilling204To205(plan);
    assert(plan.directory.includes(".staging-native-authority")); assert(plan.config.includes(".staging-native-authority"));
    assert.equal(git(["status", "--porcelain", "--untracked-files=normal"]), "");
    assert.deepEqual(fs.readdirSync(plan.directory), [SPEC.suffix[0].name]);
    assert.equal(buildNativeBilling204To205Plan(base, "other").marker, plan.marker);
  } finally { cleanup(base); }
});
test("205 strict reconciliation preserves every old schema and row and requires new tables empty", () => {
  const plan = buildNativeBilling204To205Plan(root), db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)");
    const apply = name => { db.exec(fs.readFileSync(path.join(plan.sourceDirectory, name), "utf8")); db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(name); };
    const capture = () => {
      const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row }));
      const data = Object.fromEntries(applicationTableNames(schema).filter(name => name !== "d1_migrations").map(name => [name,
        db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify({ ...row })).sort()]));
      return { schema, data, foreignKeys: db.prepare("PRAGMA foreign_key_check").all().map(row => ({ ...row })) };
    };
    for (const name of plan.priorNames) apply(name);
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('preserved205','Preserved205',1)").run();
    const before = capture(), sql = fs.readFileSync(path.join(plan.sourceDirectory, SPEC.suffix[0].name), "utf8");
    assert(!/^\s*(ALTER|DROP)\s/im.test(sql), "205 must only add objects");
    db.exec("BEGIN"); db.exec(sql); db.exec("ROLLBACK"); assert.deepEqual(capture(), before);
    apply(SPEC.suffix[0].name); const after = capture(), definitions = reviewedNativeDirectorySchemaDefinitions(sql);
    assert.doesNotThrow(() => assertPreserved(before, after, definitions, "strict"));
    for (const kind of ["data", "schema", "populated"]) {
      const changed = structuredClone(after);
      if (kind === "data") changed.data.native_business_areas = [];
      if (kind === "schema") changed.schema.find(row => row.name === "native_business_areas").sql += " /* changed */";
      if (kind === "populated") changed.data.operations_portal_native_billing_source_commands = ['{"unexpected":true}'];
      assert.throws(() => assertPreserved(before, changed, definitions, "strict"));
    }
    assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map(row => row.name), plan.finalNames);
  } finally { db.close(); }
});
test("205 CI denial precedes credentials and replica/mutating preconditions are rejected", async () => {
  await assert.rejects(runNativeBilling204To205(["apply"], { root,
    sourceCiGate: async () => { throw Error("CI not approved"); }, credential: () => assert.fail("no credential") }), /CI not approved/);
  for (const meta of [{ changed_db: true, served_by_primary: true }, { changed_db: false, served_by_primary: false }])
    await assert.rejects(nativeBilling204To205ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], async () => ({ ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [], meta }] }) })));
});
