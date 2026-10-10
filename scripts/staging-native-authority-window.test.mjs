import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  businessAreaReferenceTables,
  cliFailureMessage,
  closeStagingNativeAuthorityWindow,
  main,
  openStagingNativeAuthorityWindow,
  prepareStagingNativeAuthorityArea,
  prepareSyntheticAreaStatements,
  referenceCounts,
} from "./staging-native-authority-window.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const requireOperations = createRequire(path.join(ROOT, "apps", "operations", "package.json"));
const { Miniflare } = requireOperations("miniflare");

const AREA = Object.freeze({
  id: "staging-native-only-portal-acceptance-20261002-fresh",
  name: "Synthetic portal acceptance — fresh",
  active: 1,
});
const STAFF = "staff-beau-koltz";
const CLOCK = "2026-10-02T20:00:00.000Z";
const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];

const permissions = input => input.schemaVersion === 3
  ? ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"]
  : ["directory.profile.edit", "directory.identity.link"];

function before() {
  const grant = {
    id: "view-grant",
    staff_id: STAFF,
    permission: "directory.profile.view",
    effect: "allow",
    scope_kind: "global",
    business_area_id: null,
    division_id: null,
    resource_id: null,
    active: 1,
    granted_by: STAFF,
    created_at: "2026-10-01T00:00:00.000Z",
  };
  return {
    admission: {
      staff_id: STAFF,
      bound_access_subject: "private|subject",
      active: 1,
      admitted_by: STAFF,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-02T00:00:00.000Z",
      version: 19,
    },
    profile: {
      staff_id: STAFF,
      login_email: "private@example.test",
      display_name: "Private Owner",
      version: 1,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    },
    generation: { staff_id: STAFF, generation: 18, updated_at: "2026-10-02T00:00:00.000Z" },
    businessArea: { ...AREA },
    grants: [grant],
    history: [{
      grant_id: grant.id,
      grant_version: 1,
      staff_id: STAFF,
      permission: grant.permission,
      effect: grant.effect,
      scope_kind: grant.scope_kind,
      business_area_id: null,
      division_id: null,
      resource_id: null,
      active: 1,
      grant_generation: 18,
      recorded_at: "2026-10-02T00:00:00.000Z",
    }],
  };
}

function granted(input) {
  const selectedPermissions = permissions(input);
  const target = selectedPermissions.map((permission, index) => ({
    id: IDS[index],
    staff_id: STAFF,
    permission,
    effect: "allow",
    scope_kind: "business_area",
    business_area_id: AREA.id,
    division_id: null,
    resource_id: null,
    active: 1,
    granted_by: STAFF,
    created_at: CLOCK,
  }));
  const suffix = target.map((row, index) => ({
    grant_id: row.id,
    grant_version: 1,
    staff_id: STAFF,
    permission: row.permission,
    effect: "allow",
    scope_kind: "business_area",
    business_area_id: AREA.id,
    division_id: null,
    resource_id: null,
    active: 1,
    grant_generation: input.generation.generation + index + 1,
    recorded_at: CLOCK,
  }));
  return {
    ...input,
    generation: { ...input.generation, generation: input.generation.generation + selectedPermissions.length, updated_at: CLOCK },
    grants: [...input.grants, ...target],
    history: [...input.history, ...suffix],
  };
}

function harness(options = {}) {
  const events = [];
  const state = before();
  let packet;
  let snapshotCount = 0;
  let referenceReadCount = 0;
  const receipt = { immutable: "receipt" };
  const dependencies = {
    root: "C:\\private-root",
    withBinding: async (_config, callback) => callback({ db: {}, target: STAGING_TARGET }),
    snapshot: async () => (++snapshotCount === 1 || options.noReceipt
      ? structuredClone(state)
      : granted(packet.input)),
    referenceTables: async () => ["native_directory_grants", "native_directory_grant_history"],
    referenceCounts: async () => {
      referenceReadCount += 1;
      const after = referenceReadCount > 1;
      const count = options.clientCreation ? 3 : 2;
      return [
        { table: "native_directory_grants", count: after ? count : 0 },
        { table: "native_directory_grant_history", count: after ? count : 0 },
      ];
    },
    clock: async () => CLOCK,
    randomUUID: (() => {
      const values = [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000003",
        "20000000-0000-4000-8000-000000000004",
      ];
      return () => values.shift();
    })(),
    grantIds: () => IDS.slice(0, 2),
    clientCreationGrantIds: () => IDS,
    compilePacket: input => {
      packet = { schemaVersion: 2, input, receipt, statements: [] };
      return packet;
    },
    createEvidence: () => ({
      evidenceDir: "C:\\private-root\\.backups\\staging-native-authority\\approval",
      provisionPath: "C:\\private-root\\.backups\\staging-native-authority\\approval\\provision.json",
    }),
    writeEvidence: (_root, _directory, filename) => {
      events.push(`write:${filename}`);
      if (options.readbackWriteFails && filename === "granted-readback.json") throw new Error("disk full");
    },
    applyPacket: async () => {
      events.push("apply");
      if (options.transportFails) throw new Error("lost response");
    },
    first: async () => options.noReceipt ? null : options.receiptMismatch ? { immutable: "different" } : receipt,
  };
  return { dependencies, events };
}

test("open saves the private recovery artifact before apply and returns only a bounded summary", async () => {
  const { dependencies, events } = harness();
  const result = await openStagingNativeAuthorityWindow("binding.json", AREA, dependencies);
  assert.deepEqual(events, ["write:provision.json", "apply", "write:granted-readback.json"]);
  assert.equal(result.status, "opened");
  assert.equal(result.closeBy, "2026-10-02T21:00:00.000Z");
  assert.equal(result.closeByKind, "operator-deadline-no-auto-revocation");
  assert.equal(result.automaticRevocation, false);
  assert.equal(result.closeRequired, true);
  assert.equal(result.grantedReadbackVerified, true);
  const output = JSON.stringify(result);
  for (const privateValue of ["private|subject", "private@example.test", "Private Owner", "statements"]) {
    assert.equal(output.includes(privateValue), false);
  }
});

test("open reports ordered static progress stages without private payloads", async () => {
  const { dependencies } = harness();
  const stages = [];
  dependencies.progress = stage => { stages.push(stage); };
  await openStagingNativeAuthorityWindow("binding.json", AREA, dependencies);
  assert.deepEqual(stages, [
    "binding-callback-entered",
    "schema-discovery-started",
    "schema-discovery-completed",
    "reference-count-started",
    "reference-count-completed",
    "snapshot-started",
    "snapshot-completed",
    "clock-started",
    "clock-completed",
    "evidence-create-started",
    "evidence-create-completed",
    "evidence-write-started",
    "evidence-write-completed",
    "apply-started",
    "apply-completed",
    "receipt-readback-started",
    "receipt-readback-completed",
    "granted-readback-started",
    "granted-readback-completed",
    "granted-evidence-write-started",
    "granted-evidence-write-completed",
  ]);
  const output = JSON.stringify(stages);
  for (const privateValue of [
    AREA.id,
    AREA.name,
    STAFF,
    "private|subject",
    "private@example.test",
    "Private Owner",
    IDS[0],
    "directory.profile.edit",
    "provision.json",
  ]) assert.equal(output.includes(privateValue), false);
});

test("throwing progress diagnostics cannot affect verified open or recovery evidence", async () => {
  const { dependencies, events } = harness();
  let calls = 0;
  dependencies.progress = () => {
    calls += 1;
    throw new Error("diagnostic sink unavailable");
  };
  const result = await openStagingNativeAuthorityWindow("binding.json", AREA, dependencies);
  assert.equal(result.status, "opened");
  assert.equal(result.grantedReadbackVerified, true);
  assert.ok(calls > 0);
  assert.deepEqual(events, ["write:provision.json", "apply", "write:granted-readback.json"]);
});

test("open reconciles a lost apply response from the immutable receipt and readback", async () => {
  const { dependencies } = harness({ transportFails: true });
  const result = await openStagingNativeAuthorityWindow("binding.json", AREA, dependencies);
  assert.equal(result.status, "opened-after-response-recovery");
});

test("explicit client-creation open compiles schema 3, verifies three grants, and preserves bounded output", async () => {
  const { dependencies } = harness({ clientCreation: true });
  let compiledInput;
  const originalCompile = dependencies.compilePacket;
  dependencies.compilePacket = input => {
    compiledInput = structuredClone(input);
    return originalCompile(input);
  };
  const result = await openStagingNativeAuthorityWindow("binding.json", AREA,
    { ...dependencies, clientCreation: true });
  assert.equal(compiledInput.schemaVersion, 3);
  assert.deepEqual(compiledInput.approval.grantIds, IDS);
  assert.equal(result.provisionedPermissions, 3);
  assert.equal(result.grantedReadbackVerified, true);
});

test("client-creation open rejects a two-grant readback and non-boolean opt-in", async () => {
  let reads = 0;
  const selected = harness({ clientCreation: true });
  selected.dependencies.referenceCounts = async () => {
    reads += 1;
    return [
      { table: "native_directory_grants", count: reads === 1 ? 0 : 2 },
      { table: "native_directory_grant_history", count: reads === 1 ? 0 : 2 },
    ];
  };
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA,
    { ...selected.dependencies, clientCreation: true }), error => {
    assert.match(error.message, /provision committed but granted state was not verified/);
    assert.match(error.errors[0].message, /not isolated at after readback/);
    return true;
  });
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA,
    { ...selected.dependencies, clientCreation: "yes" }), /explicit boolean/);
});

test("open rejects an immutable receipt mismatch and requires exact close recovery", async () => {
  const { dependencies } = harness({ receiptMismatch: true });
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA, dependencies),
    /immutable provision receipt mismatch.*--recover .*provision\.json/);
});

test("open reports no active authority when apply has no receipt or target grants", async () => {
  const { dependencies } = harness({ noReceipt: true, transportFails: true });
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA, dependencies),
    /provision did not commit; no packet authority is active/);
});

test("open requires paired close when committed readback cannot be privately saved", async () => {
  const { dependencies } = harness({ readbackWriteFails: true });
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA, dependencies),
    /close this exact authority window with --recover .*provision\.json/);
});

test("open rejects a missing or different explicitly reviewed area before evidence or apply", async () => {
  const { dependencies, events } = harness();
  dependencies.snapshot = async () => ({ ...before(), businessArea: null });
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA, dependencies),
    /reviewed synthetic business area differs or is absent/);
  assert.deepEqual(events, []);
});

test("close delegates to exact existing paired recovery", async () => {
  let received;
  const result = await closeStagingNativeAuthorityWindow("binding.json", "private/provision.json", {
    recover: async (...args) => {
      received = args;
      return { status: "recovered-and-revoked", cleanupVerified: true };
    },
  });
  assert.equal(received[0], "binding.json");
  assert.equal(received[1], "private/provision.json");
  assert.equal(result.cleanupVerified, true);
});

function preparationHarness(options = {}) {
  const batches = [];
  let areaReads = 0;
  const dependencies = {
    root: "C:\\private-root",
    withBinding: async (_config, callback) => callback({ db: {}, target: STAGING_TARGET }),
    reviewedMigrations: () => options.expectedMigrations
      ?? ["0176_operations_directory_acquired_intent_authority.sql", "0177_operations_directory_acquired_intent_update_authority.sql", "0178_project_alpha_project_inbound_reconciliation.sql", "0179_project_alpha_acquired_native_identity_collision.sql", "0180_project_alpha_project_v2_recovery_authorization.sql", "0181_project_alpha_directory_create_generation_recovery.sql", "0182_project_alpha_directory_relationship_recovery_guard.sql", "0183_project_alpha_binding_standalone_relationship_rows.sql"],
    readMigrations: async () => {
      if (options.ledgerReadFails) throw new Error("private transport detail");
      return options.actualMigrations
        ?? ["0176_operations_directory_acquired_intent_authority.sql", "0177_operations_directory_acquired_intent_update_authority.sql", "0178_project_alpha_project_inbound_reconciliation.sql", "0179_project_alpha_acquired_native_identity_collision.sql", "0180_project_alpha_project_v2_recovery_authorization.sql", "0181_project_alpha_directory_create_generation_recovery.sql", "0182_project_alpha_directory_relationship_recovery_guard.sql", "0183_project_alpha_binding_standalone_relationship_rows.sql"];
    },
    referenceTables: async () => ["native_directory_grants", "native_directory_grant_history"],
    referenceCounts: async () => [
      { table: "native_directory_grants", count: options.used ? 1 : 0 },
      { table: "native_directory_grant_history", count: 0 },
    ],
    first: async () => {
      areaReads += 1;
      if (options.existing) return options.existing;
      return areaReads === 1 ? null : { ...AREA };
    },
    batch: async (_db, statements) => {
      batches.push(statements);
      if (options.transportFails) throw new Error("lost response");
    },
  };
  return { dependencies, batches };
}

test("prepare uses one guarded batch and verifies a pristine exact area", async () => {
  const { dependencies, batches } = preparationHarness();
  const result = await prepareStagingNativeAuthorityArea("binding.json", AREA, dependencies);
  assert.equal(result.status, "prepared");
  assert.equal(result.references, 0);
  assert.equal(result.mutationsPerformed, true);
  assert.equal(batches.length, 1);
  const sql = batches[0].map(statement => statement.sql).join("\n");
  assert.match(sql, /d1_migrations/);
  assert.match(sql, /native_directory_grants/);
  assert.match(sql, /native_directory_grant_history/);
  assert.match(sql, /INSERT INTO native_business_areas/);
  assert.match(sql, /changes\(\)=1/);
  assert.match(sql, /native-area-poststate-guard-failed/);
});

test("prepare accepts the exact canonical repository migration chain through 0183", async () => {
  const source = path.join(ROOT, "apps", "operations", "migrations");
  const migrations = fs.readdirSync(source)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0183")
    .sort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-authority-window-reviewed-chain-"));
  const migrationDirectory = path.join(tempRoot, "apps", "operations", "migrations");
  fs.mkdirSync(migrationDirectory, { recursive: true });
  for (const name of migrations) fs.copyFileSync(path.join(source, name), path.join(migrationDirectory, name));
  const { dependencies } = preparationHarness({ actualMigrations: migrations });
  dependencies.root = tempRoot;
  delete dependencies.reviewedMigrations;
  try {
    assert.equal((await prepareStagingNativeAuthorityArea(
      "binding.json", AREA, dependencies,
    )).status, "prepared");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepare rejects the canonical repository migration chain through 0184", async () => {
  const migrationDirectory = path.join(ROOT, "apps", "operations", "migrations");
  const migrations = fs.readdirSync(migrationDirectory)
    .filter(name => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.equal(migrations.at(-1), "0184_project_alpha_directory_relationship_generation_recovery.sql");
  const { dependencies } = preparationHarness({ actualMigrations: migrations });
  dependencies.root = ROOT;
  delete dependencies.reviewedMigrations;
  await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", AREA, dependencies), error => {
    assert.equal(error.prepareStageCode, "local-chain-mismatch");
    return true;
  });
});

test("prepare rejects a missing, extra, renamed, or modified 0183 migration", async t => {
  const source = path.join(ROOT, "apps", "operations", "migrations");
  const canonicalNames = fs.readdirSync(source)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0183")
    .sort();
  const cases = [
    ["missing", directory => fs.rmSync(path.join(directory, "0183_project_alpha_binding_standalone_relationship_rows.sql"))],
    ["extra", directory => fs.copyFileSync(
      path.join(source, "0184_project_alpha_directory_relationship_generation_recovery.sql"),
      path.join(directory, "0184_project_alpha_directory_relationship_generation_recovery.sql"))],
    ["renamed", directory => fs.renameSync(path.join(directory, "0183_project_alpha_binding_standalone_relationship_rows.sql"),
      path.join(directory, "0183_wrong_name.sql"))],
    ["modified", directory => fs.appendFileSync(path.join(directory, "0183_project_alpha_binding_standalone_relationship_rows.sql"), "-- drift\n")],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-authority-window-chain-"));
    const directory = path.join(tempRoot, "apps", "operations", "migrations");
    fs.mkdirSync(directory, { recursive: true });
    for (const name of canonicalNames) fs.copyFileSync(path.join(source, name), path.join(directory, name));
    mutate(directory);
    const actualMigrations = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    const { dependencies } = preparationHarness({ actualMigrations });
    dependencies.root = tempRoot;
    delete dependencies.reviewedMigrations;
    try {
      await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", AREA, dependencies), error => {
        assert.equal(error.prepareStageCode, "local-chain-mismatch");
        return true;
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test("prepare reconciles a lost insert response from exact unused readback", async () => {
  const { dependencies } = preparationHarness({ transportFails: true });
  const result = await prepareStagingNativeAuthorityArea("binding.json", AREA, dependencies);
  assert.equal(result.status, "prepared-after-response-recovery");
});

test("prepare is idempotent only for the exact unused area", async () => {
  const exact = preparationHarness({ existing: { ...AREA } });
  const result = await prepareStagingNativeAuthorityArea("binding.json", AREA, exact.dependencies);
  assert.equal(result.status, "already-prepared");
  assert.equal(result.mutationsPerformed, false);
  assert.equal(exact.batches.length, 0);

  const differing = preparationHarness({ existing: { ...AREA, name: "Different" } });
  await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", AREA, differing.dependencies),
    /existing synthetic business area differs/);

  const used = preparationHarness({ existing: { ...AREA }, used: true });
  await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", AREA, used.dependencies),
    /synthetic business area id is already referenced/);
});

test("prepare rejects control characters before opening a binding", async () => {
  let opened = false;
  await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", { ...AREA, name: "bad\nname" }, {
    withBinding: async () => { opened = true; },
  }), /exact active synthetic business area required/);
  assert.equal(opened, false);
});

test("prepare CLI failure guidance is sanitized and names exact id/name replay", () => {
  const error = new Error("private database detail");
  error.prepareStageCode = "outcome-unknown";
  const message = cliFailureMessage("prepare", error);
  assert.match(message, /re-run prepare with the exact same area id and name before open/);
  assert.equal(message.includes("private database detail"), false);
  assert.equal(message.includes("private evidence"), false);
});

test("prepare compares the reviewed and remote migration ledgers as exact sets", async () => {
  const names = ["0001_first.sql", "0002_second.sql"];
  const reordered = preparationHarness({
    expectedMigrations: names,
    actualMigrations: [...names].reverse(),
    existing: { ...AREA },
  });
  assert.equal((await prepareStagingNativeAuthorityArea("binding.json", AREA,
    reordered.dependencies)).status, "already-prepared");

  const missing = preparationHarness({
    expectedMigrations: names,
    actualMigrations: [names[0]],
  });
  await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", AREA, missing.dependencies), error => {
    assert.equal(error.prepareStageCode, "remote-ledger-mismatch");
    assert.match(cliFailureMessage("prepare", error), /\[remote-ledger-mismatch\]/);
    return true;
  });
});

test("prepare reports a safe deterministic ledger read or transport stage", async () => {
  const failed = preparationHarness({ ledgerReadFails: true });
  await assert.rejects(prepareStagingNativeAuthorityArea("binding.json", AREA, failed.dependencies), error => {
    assert.equal(error.prepareStageCode, "remote-ledger-read-failed");
    const output = cliFailureMessage("prepare", error);
    assert.match(output, /\[remote-ledger-read-failed\]/);
    assert.equal(output.includes("private transport detail"), false);
    return true;
  });
});

let realD1Counter = 700;
async function withMinimalRealD1(callback) {
  realD1Counter += 1;
  const suffix = String(realD1Counter).padStart(12, "0");
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: `00000000-0000-4000-8000-${suffix}` },
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.batch([
      db.prepare(`CREATE TABLE d1_migrations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      )`),
      db.prepare(`CREATE TABLE native_business_areas(
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE native_directory_grants(
        id TEXT PRIMARY KEY NOT NULL,
        business_area_id TEXT
      )`),
    ]);
    return await callback(db);
  } finally {
    await mf.dispose();
  }
}

const executePreparation = (db, statements) => db.batch(
  statements.map(statement => db.prepare(statement.sql).bind(...statement.params)),
);
const areaCount = async db => (await db.prepare(
  "SELECT count(*) AS count FROM native_business_areas WHERE id=?",
).bind(AREA.id).first()).count;

test("real D1 prepare guards, insert CAS and exact poststate succeed together", async () => {
  await withMinimalRealD1(async db => {
    const migration = "0001_reviewed.sql";
    await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration).run();
    await executePreparation(db,
      prepareSyntheticAreaStatements(AREA, [migration], ["native_directory_grants"]));
    assert.deepEqual(await db.prepare("SELECT * FROM native_business_areas WHERE id=?")
      .bind(AREA.id).first(), AREA);
  });
});

function withoutMiniflareOnlyMetadata(db) {
  return {
    prepare: sql => db.prepare(sql.includes("FROM sqlite_schema")
      ? sql.replace(" ORDER BY name", " AND name<>'_cf_METADATA' ORDER BY name")
      : sql),
    batch: statements => db.batch(statements),
  };
}

test("real Miniflare schema discovery finds application business-area references", async () => {
  await withMinimalRealD1(async db => {
    const schema = (await db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
    ).all()).results.map(row => row.name);
    assert.ok(schema.includes("_cf_METADATA"), "Miniflare exposes its emulator-only metadata table");
    const pragmaBatch = await db.batch([
      db.prepare('PRAGMA table_info("native_business_areas")'),
      db.prepare('PRAGMA table_info("native_directory_grants")'),
    ]);
    assert.equal(pragmaBatch.length, 2);
    assert.equal(pragmaBatch.every(result => result.success && Array.isArray(result.results)), true);
    const references = await businessAreaReferenceTables(withoutMiniflareOnlyMetadata(db));
    assert.equal(references.includes("_cf_KV"), false);
    assert.ok(references.includes("native_directory_grants"));
    assert.deepEqual(await referenceCounts(db, references, AREA.id), [
      { table: "native_directory_grants", count: 0 },
    ]);
  });
});

test("discovery never introspects D1's exact reserved _cf_KV table", async () => {
  const prepared = [];
  const fake = {
    prepare: sql => {
      prepared.push(sql);
      return {
        bind() { return this; },
        async all() { return { results: [{ name: "_cf_KV" }, { name: "application_table" }] }; },
      };
    },
    batch: async statements => statements.map(() => ({
      success: true,
      results: [{ name: "id" }, { name: "business_area_id" }],
    })),
  };
  assert.deepEqual(await businessAreaReferenceTables(fake), ["application_table"]);
  assert.equal(prepared.some(sql => sql.includes("table_info(\"_cf_KV\")")), false);
  assert.match(prepared[0], /name<>'_cf_KV'/);
});

test("schema discovery batches every validated table in ordered groups of at most 25", async () => {
  const names = Array.from({ length: 57 }, (_, index) => `application_table_${String(index).padStart(2, "0")}`);
  const batches = [];
  const fake = {
    prepare: sql => ({
      sql,
      bind() { return this; },
      async all() { return { results: names.map(name => ({ name })) }; },
    }),
    batch: async statements => {
      batches.push(statements.map(statement => statement.sql));
      return statements.map(statement => ({
        success: true,
        results: [{ name: "id" }, ...(statement.sql.includes('table_26"') ? [{ name: "business_area_id" }] : [])],
      }));
    },
  };
  assert.deepEqual(await businessAreaReferenceTables(fake), ["application_table_26"]);
  assert.deepEqual(batches.map(batch => batch.length), [25, 25, 7]);
  assert.deepEqual(batches.flat(), names.map(name => `PRAGMA table_info("${name}")`));
});

test("schema discovery rejects missing, extra, and unsuccessful metadata results", async () => {
  const candidate = resultFactory => ({
    prepare: sql => ({
      bind() { return this; },
      async all() { return { results: [{ name: "application_table" }] }; },
      sql,
    }),
    batch: async statements => resultFactory(statements),
  });
  for (const results of [
    [],
    [{ success: true, results: [] }, { success: true, results: [] }],
  ]) await assert.rejects(businessAreaReferenceTables(candidate(() => results)), error => {
    assert.equal(error.prepareStageCode, "table-metadata-invalid");
    return true;
  });
  await assert.rejects(businessAreaReferenceTables(candidate(() => [{ success: false, results: [] }])), error => {
    assert.equal(error.prepareStageCode, "table-info-read-failed");
    return true;
  });
});

test("schema discovery validates the complete table list before issuing metadata batches", async () => {
  for (const rows of [
    [{ name: "valid_table" }, { name: "invalid-table" }],
    [{ name: "duplicate" }, { name: "duplicate" }],
  ]) {
    let batches = 0;
    await assert.rejects(businessAreaReferenceTables({
      prepare: () => ({ bind() { return this; }, async all() { return { results: rows }; } }),
      batch: async () => { batches += 1; return []; },
    }), error => {
      assert.equal(error.prepareStageCode, "table-metadata-invalid");
      return true;
    });
    assert.equal(batches, 0);
  }
});

test("schema discovery reports separate privacy-safe schema and table-info stages", async () => {
  await assert.rejects(businessAreaReferenceTables({
    prepare: () => { throw new Error("private schema transport detail"); },
  }), error => {
    assert.equal(error.prepareStageCode, "schema-read-failed");
    assert.match(cliFailureMessage("prepare", error), /\[schema-read-failed\]/);
    return true;
  });

  let calls = 0;
  await assert.rejects(businessAreaReferenceTables({
    prepare: () => ({ bind() { return this; }, all: async () => ({ results: [{ name: "application_table" }] }) }),
    batch: async () => { calls += 1; throw new Error("private pragma detail"); },
  }), error => {
    assert.equal(error.prepareStageCode, "table-info-read-failed");
    assert.match(cliFailureMessage("prepare", error), /\[table-info-read-failed\]/);
    return true;
  });
  assert.equal(calls, 1);
});

test("real Miniflare rejects invalid table metadata and classifies reference-count disappearance", async () => {
  await withMinimalRealD1(async db => {
    await db.prepare('CREATE TABLE "invalid-table-name"(business_area_id TEXT)').run();
    await assert.rejects(businessAreaReferenceTables(withoutMiniflareOnlyMetadata(db)), error => {
      assert.equal(error.prepareStageCode, "table-metadata-invalid");
      return true;
    });
  });

  await withMinimalRealD1(async db => {
    const references = await businessAreaReferenceTables(withoutMiniflareOnlyMetadata(db));
    await db.prepare("DROP TABLE native_directory_grants").run();
    await assert.rejects(referenceCounts(db, references, AREA.id), error => {
      assert.equal(error.prepareStageCode, "reference-count-read-failed");
      assert.match(cliFailureMessage("prepare", error), /\[reference-count-read-failed\]/);
      return true;
    });
  });
});

test("real D1 raced area reference fails its evaluated guard and rolls back", async () => {
  await withMinimalRealD1(async db => {
    const migration = "0001_reviewed.sql";
    await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration).run();
    await db.prepare("INSERT INTO native_directory_grants(id,business_area_id) VALUES('raced',?)")
      .bind(AREA.id).run();
    await assert.rejects(executePreparation(db,
      prepareSyntheticAreaStatements(AREA, [migration], ["native_directory_grants"])));
    assert.equal(await areaCount(db), 0);
  });
});

test("real D1 migration-ledger mismatch fails before area insert", async () => {
  await withMinimalRealD1(async db => {
    await db.prepare("INSERT INTO d1_migrations(name) VALUES('0001_other.sql')").run();
    await assert.rejects(executePreparation(db,
      prepareSyntheticAreaStatements(AREA, ["0001_reviewed.sql"], ["native_directory_grants"])));
    assert.equal(await areaCount(db), 0);
  });
});

test("real D1 changes guard rejects an ignored insert", async () => {
  await withMinimalRealD1(async db => {
    const migration = "0001_reviewed.sql";
    await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration).run();
    await db.prepare(`CREATE TRIGGER ignore_synthetic_area BEFORE INSERT ON native_business_areas
      BEGIN SELECT RAISE(IGNORE); END`).run();
    await assert.rejects(executePreparation(db,
      prepareSyntheticAreaStatements(AREA, [migration], ["native_directory_grants"])));
    assert.equal(await areaCount(db), 0);
  });
});

test("real D1 poststate failure rolls the successful insert back atomically", async () => {
  await withMinimalRealD1(async db => {
    const migration = "0001_reviewed.sql";
    await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration).run();
    await db.prepare(`CREATE TRIGGER drift_synthetic_area AFTER INSERT ON native_business_areas
      BEGIN UPDATE native_business_areas SET name='drifted' WHERE id=NEW.id; END`).run();
    await assert.rejects(executePreparation(db,
      prepareSyntheticAreaStatements(AREA, [migration], ["native_directory_grants"])));
    assert.equal(await areaCount(db), 0);
  });
});

test("open accepts an explicit window up to four hours and rejects a longer one", async () => {
  const selected = harness();
  const result = await openStagingNativeAuthorityWindow("binding.json", AREA,
    { ...selected.dependencies, windowMinutes: 240 });
  assert.equal(result.closeBy, "2026-10-03T00:00:00.000Z");
  await assert.rejects(openStagingNativeAuthorityWindow("binding.json", AREA,
    { ...harness().dependencies, windowMinutes: 241 }), /window minutes/);
});

test("CLI output contains summary only for open and supports close alias", async () => {
  const { dependencies } = harness();
  let logged;
  dependencies.log = value => { logged = value; };
  assert.equal(await main([
    "open", "--config", "binding.json", "--area-id", AREA.id, "--area-name", AREA.name,
    "--window-minutes", "60",
  ], dependencies), 0);
  assert.equal(JSON.parse(logged).status, "opened");

  const closeDependencies = {
    recover: async () => ({ status: "already-revoked", cleanupVerified: true }),
    log: value => { logged = value; },
  };
  assert.equal(await main([
    "close", "--config", "binding.json", "--recover", "private/provision.json",
  ], closeDependencies), 0);
  assert.equal(JSON.parse(logged).cleanupVerified, true);
});

test("CLI client-creation flag is explicit and selects schema 3", async () => {
  const { dependencies } = harness({ clientCreation: true });
  let logged;
  let schemaVersion;
  const compile = dependencies.compilePacket;
  dependencies.compilePacket = input => { schemaVersion = input.schemaVersion; return compile(input); };
  dependencies.log = value => { logged = value; };
  assert.equal(await main([
    "open", "--config", "binding.json", "--area-id", AREA.id, "--area-name", AREA.name,
    "--window-minutes", "60", "--client-creation",
  ], dependencies), 0);
  assert.equal(schemaVersion, 3);
  assert.equal(JSON.parse(logged).provisionedPermissions, 3);
});

test("CLI refuses remote synthetic-area preparation without its explicit mutation confirmation", async () => {
  await assert.rejects(main([
    "prepare", "--config", "binding.json", "--area-id", AREA.id, "--area-name", AREA.name,
  ], {}), /usage: prepare/);
});
