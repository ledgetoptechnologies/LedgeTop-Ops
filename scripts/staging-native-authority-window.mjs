import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";
import {
  STAGING_TARGET,
  applyNativeOnlyAuthorityPacket,
  compileNativeOnlyAuthorityPacket,
  nativeOnlyGrantIds,
} from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  createPrivateEvidenceDirectory,
  recoverStagingNativeAuthority,
  writePrivateEvidence,
} from "./staging-native-authority-packet-rehearsal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAFF = "staff-beau-koltz";
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 240;
const AREA_ID = /^staging-native-only-[a-z0-9-]+$/;
const AREA_KEYS = Object.freeze(["id", "name", "active"]);
const RESERVED_D1_TABLES = Object.freeze(new Set(["_cf_KV"]));
const CHAIN = Object.freeze({
  count: 171,
  final: "0171_project_alpha_active_directory_update_guard.sql",
  names: "bc4590b90cccd1842b2496906986355cfde7522e970ac3ec95039cace437f61d",
  contents: "e3feca1f403a06f15495017fd843ac48173e39be2478f8d6b5060c262c0b1f5c",
});

const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();

const fail = message => {
  throw new Error(`staging-native-authority-window: ${message}`);
};

class PrepareStageError extends Error {
  constructor(code, message, cause) {
    super(`staging-native-authority-window: ${message}`, cause ? { cause } : undefined);
    this.name = "PrepareStageError";
    this.prepareStageCode = code;
  }
}

const prepareStageFail = (code, message, cause) => {
  throw new PrepareStageError(code, message, cause);
};

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} shape`);
  }
}

function areaSpec(value) {
  exact(value, AREA_KEYS, "business area");
  if (typeof value.id !== "string" || !AREA_ID.test(value.id)
    || typeof value.name !== "string" || !value.name.length || value.name !== value.name.trim()
    || value.name.length > 160 || /[\u0000-\u001f\u007f]/.test(value.name) || value.active !== 1) {
    fail("exact active synthetic business area required");
  }
  return Object.freeze({ ...value });
}

function windowMinutes(value) {
  const minutes = value ?? DEFAULT_WINDOW_MINUTES;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_WINDOW_MINUTES) {
    fail("window minutes must be an integer from 1 through 240");
  }
  return minutes;
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reviewedMigrations(root) {
  const directory = path.join(root, "apps", "operations", "migrations");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const contents = names.map(name => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("regular migration file required");
    return `${name}\0${sha(fs.readFileSync(filename))}`;
  });
  if (names.length !== CHAIN.count || names.at(-1) !== CHAIN.final
    || sha(names.join("\n")) !== CHAIN.names || sha(contents.join("\n")) !== CHAIN.contents) {
    fail("exact reviewed migration names and contents required");
  }
  return names;
}

function quotedIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    prepareStageFail("table-metadata-invalid", "unexpected schema table identifier");
  }
  return `"${value}"`;
}

export async function businessAreaReferenceTables(db) {
  let tables;
  try {
    tables = await all(db,
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_cf_KV' ORDER BY name");
  } catch (error) {
    prepareStageFail("schema-read-failed", "database schema table list could not be read", error);
  }
  if (!Array.isArray(tables)) {
    prepareStageFail("table-metadata-invalid", "database schema table list is invalid");
  }
  const references = [];
  const seen = new Set();
  for (const row of tables) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || typeof row.name !== "string" || seen.has(row.name)) {
      prepareStageFail("table-metadata-invalid", "database schema table metadata is invalid");
    }
    const { name } = row;
    seen.add(name);
    quotedIdentifier(name);
    // Cloudflare D1 owns this internal storage table. It is not application
    // schema and cannot contain an application business_area_id reference.
    if (RESERVED_D1_TABLES.has(name)) continue;
    let columns;
    try {
      columns = (await db.prepare(`PRAGMA table_info(${quotedIdentifier(name)})`).all()).results;
    } catch (error) {
      prepareStageFail("table-info-read-failed", "schema table columns could not be read", error);
    }
    if (!Array.isArray(columns)
      || columns.some(column => !column || typeof column !== "object" || typeof column.name !== "string")) {
      prepareStageFail("table-metadata-invalid", "schema table column metadata is invalid");
    }
    if (columns.some(column => column.name === "business_area_id")) references.push(name);
  }
  return references;
}

export async function referenceCounts(db, tables, areaId) {
  if (!Array.isArray(tables) || new Set(tables).size !== tables.length) {
    prepareStageFail("table-metadata-invalid", "business area reference table list is invalid");
  }
  const counts = [];
  for (const table of tables) {
    let row;
    try {
      row = await first(db,
        `SELECT count(*) AS count FROM ${quotedIdentifier(table)} WHERE business_area_id=?`, areaId);
    } catch (error) {
      if (error instanceof PrepareStageError) throw error;
      prepareStageFail("reference-count-read-failed", "business area reference count could not be read", error);
    }
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0) {
      prepareStageFail("reference-count-invalid", "business area reference count is invalid");
    }
    counts.push({ table, count: row.count });
  }
  return counts;
}

async function readMigrationNames(db) {
  return (await all(db, "SELECT name FROM d1_migrations ORDER BY name")).map(row => row.name);
}

function normalizedMigrationNames(value, label, invalidCode) {
  if (!Array.isArray(value) || !value.length
    || value.some(name => typeof name !== "string" || !/^\d{4}_.+\.sql$/.test(name))
    || new Set(value).size !== value.length) {
    prepareStageFail(invalidCode, `${label} migration ledger is invalid`);
  }
  return [...value].sort();
}

const guard = (condition, params, label) => ({
  sql: `SELECT CASE WHEN (${condition}) THEN 1 ELSE json('native-area-${label}-guard-failed') END AS verified`,
  params,
});

export function prepareSyntheticAreaStatements(area, migrationNames, referenceTables) {
  const names = JSON.stringify(migrationNames);
  return [
    guard(`(SELECT count(*) FROM d1_migrations)=json_array_length(?)
      AND NOT EXISTS(SELECT 1 FROM d1_migrations migration
        WHERE NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE expected.value=migration.name))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected
        WHERE NOT EXISTS(SELECT 1 FROM d1_migrations migration WHERE migration.name=expected.value))`,
    [names, names, names], "migration-ledger"),
    guard("NOT EXISTS(SELECT 1 FROM native_business_areas WHERE id=?)", [area.id], "unused-id"),
    ...referenceTables.map(table => guard(
      `NOT EXISTS(SELECT 1 FROM ${quotedIdentifier(table)} WHERE business_area_id=?)`,
      [area.id], `unused-${table}`)),
    { sql: "INSERT INTO native_business_areas(id,name,active) VALUES(?,?,?)", params: [area.id, area.name, area.active] },
    guard("changes()=1", [], "insert-cas"),
    guard(`(SELECT count(*) FROM native_business_areas WHERE id=? AND name=? AND active=?)=1`,
      [area.id, area.name, area.active], "poststate"),
  ];
}

async function applyBatch(db, statements) {
  return db.batch(statements.map(statement => db.prepare(statement.sql).bind(...statement.params)));
}

async function snapshot(db, areaId) {
  return {
    admission: await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", STAFF),
    profile: await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", STAFF),
    generation: await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", STAFF),
    businessArea: await first(db, "SELECT * FROM native_business_areas WHERE id=?", areaId),
    grants: await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", STAFF),
    history: await all(db,
      "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version", STAFF),
  };
}

async function databaseClock(db) {
  const row = await first(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp");
  if (!row || typeof row.stamp !== "string") fail("database clock unavailable");
  return row.stamp;
}

function operations(dependencies) {
  return {
    root: dependencies.root ?? ROOT,
    withBinding: dependencies.withBinding ?? withStagingAuthorityBinding,
    snapshot: dependencies.snapshot ?? snapshot,
    clock: dependencies.clock ?? databaseClock,
    first: dependencies.first ?? first,
    compile: dependencies.compilePacket ?? compileNativeOnlyAuthorityPacket,
    apply: dependencies.applyPacket ?? applyNativeOnlyAuthorityPacket,
    grantIds: dependencies.grantIds ?? nativeOnlyGrantIds,
    randomUUID: dependencies.randomUUID ?? crypto.randomUUID,
    createEvidence: dependencies.createEvidence ?? createPrivateEvidenceDirectory,
    writeEvidence: dependencies.writeEvidence ?? writePrivateEvidence,
    recover: dependencies.recover ?? recoverStagingNativeAuthority,
    reviewedMigrations: dependencies.reviewedMigrations ?? reviewedMigrations,
    readMigrations: dependencies.readMigrations ?? readMigrationNames,
    referenceTables: dependencies.referenceTables ?? businessAreaReferenceTables,
    referenceCounts: dependencies.referenceCounts ?? referenceCounts,
    batch: dependencies.batch ?? applyBatch,
    windowMinutes: windowMinutes(dependencies.windowMinutes),
  };
}

function recoveryMessage(provisionPath, message) {
  return `${message}; close this exact authority window with --recover ${provisionPath}`;
}

function targetGrantRows(input) {
  return ["directory.profile.edit", "directory.identity.link"].map((permission, index) => ({
    id: input.approval.grantIds[index],
    staff_id: input.admission.staff_id,
    permission,
    effect: "allow",
    scope_kind: "business_area",
    business_area_id: input.businessArea.id,
    division_id: null,
    resource_id: null,
    active: 1,
    granted_by: input.approval.issuedByStaffId,
    created_at: input.approval.executedAt,
  }));
}

function verifyGranted(after, provision) {
  const before = provision.input;
  const ids = before.approval.grantIds;
  assert.deepEqual(after.admission, before.admission, "admission drift after provision");
  assert.deepEqual(after.profile, before.profile, "profile drift after provision");
  assert.deepEqual(after.businessArea, before.businessArea, "business area drift after provision");
  assert.deepEqual(after.grants.filter(row => !ids.includes(row.id)), before.grants,
    "prior grants changed after provision");
  const targets = ids.map(id => after.grants.find(row => row.id === id));
  assert.deepEqual(targets, targetGrantRows(before),
    "exact packet grants not active");
  assert.equal(after.generation.generation, before.generation.generation + 2,
    "unexpected generation after provision");
  assert.deepEqual(after.history.filter(row => row.grant_generation <= before.generation.generation),
    before.history, "prior grant history changed after provision");
  const suffix = after.history.filter(row => row.grant_generation > before.generation.generation);
  assert.equal(suffix.length, 2, "unexpected provision history suffix");
  for (const [index, permission] of ["directory.profile.edit", "directory.identity.link"].entries()) {
    const row = suffix.find(item => item.grant_id === ids[index]);
    assert.deepEqual(Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => key !== "recorded_at")), {
      grant_id: ids[index],
      grant_version: 1,
      staff_id: before.admission.staff_id,
      permission,
      effect: "allow",
      scope_kind: "business_area",
      business_area_id: before.businessArea.id,
      division_id: null,
      resource_id: null,
      active: 1,
      grant_generation: before.generation.generation + index + 1,
    }, "unexpected provision history row");
  }
}

function buildProvisionInput(before, target, issuedAt, ops) {
  const approvalId = ops.randomUUID();
  return {
    schemaVersion: 2,
    staging: target,
    phase: "provision",
    ...before,
    approval: {
      approvalId,
      commandId: ops.randomUUID(),
      revokeApprovalId: ops.randomUUID(),
      revokeCommandId: ops.randomUUID(),
      issuedByStaffId: STAFF,
      issuedByAccessSubject: before.admission?.bound_access_subject,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + ops.windowMinutes * 60_000).toISOString(),
      executedAt: issuedAt,
      grantIds: ops.grantIds(STAFF, before.businessArea.id, approvalId),
    },
    priorProvision: null,
  };
}

function verifyIsolatedArea(counts, phase) {
  for (const { table, count } of counts) {
    const expected = phase === "before" ? 0
      : table === "native_directory_grants" || table === "native_directory_grant_history" ? 2 : 0;
    if (count !== expected) fail(`synthetic business area is not isolated at ${phase} readback`);
  }
}

export async function prepareStagingNativeAuthorityArea(configPath, requestedArea, dependencies = {}) {
  const requested = areaSpec(requestedArea);
  const ops = operations(dependencies);
  try {
    return await ops.withBinding(configPath, async ({ db, target }) => {
      if (!same(target, STAGING_TARGET)) {
        prepareStageFail("target-mismatch", "trusted staging target mismatch");
      }
      let expectedMigrations;
      try {
        expectedMigrations = normalizedMigrationNames(
          ops.reviewedMigrations(ops.root), "local reviewed", "local-chain-mismatch");
      } catch (error) {
        if (error instanceof PrepareStageError) throw error;
        prepareStageFail("local-chain-mismatch", "local reviewed migration chain mismatch", error);
      }
      let actualMigrations;
      try {
        actualMigrations = normalizedMigrationNames(
          await ops.readMigrations(db), "remote", "remote-ledger-invalid");
      } catch (error) {
        if (error instanceof PrepareStageError) throw error;
        prepareStageFail("remote-ledger-read-failed", "remote migration ledger could not be read", error);
      }
      if (!same(actualMigrations, expectedMigrations)) {
        prepareStageFail("remote-ledger-mismatch", "exact reviewed remote migration ledger required");
      }
      let tables;
      let counts;
      let existing;
      try {
        tables = await ops.referenceTables(db);
        counts = await ops.referenceCounts(db, tables, requested.id);
        existing = await ops.first(db, "SELECT * FROM native_business_areas WHERE id=?", requested.id);
      } catch (error) {
        if (error instanceof PrepareStageError) throw error;
        prepareStageFail("reference-read-failed", "synthetic business area references could not be verified", error);
      }
      if (counts.some(row => row.count !== 0)) {
        prepareStageFail("area-referenced", "synthetic business area id is already referenced");
      }
    if (existing) {
      if (!same(existing, requested)) {
        prepareStageFail("area-conflict", "existing synthetic business area differs");
      }
      return {
        status: "already-prepared",
        environment: target.environment,
        businessAreaId: requested.id,
        active: true,
        references: 0,
        mutationsPerformed: false,
      };
    }

    let transportError;
    try {
      await ops.batch(db, prepareSyntheticAreaStatements(requested, expectedMigrations, tables));
    } catch (error) {
      transportError = error;
    }
    let after;
    let afterCounts;
    try {
      after = await ops.first(db, "SELECT * FROM native_business_areas WHERE id=?", requested.id);
      afterCounts = await ops.referenceCounts(db, tables, requested.id);
    } catch (error) {
      prepareStageFail("outcome-unknown",
        "synthetic business area preparation outcome is unknown; re-run prepare with the exact same id and name", error);
    }
    if (!same(after, requested) || afterCounts.some(row => row.count !== 0)) {
      if (!after && afterCounts.every(row => row.count === 0)) {
        prepareStageFail("batch-not-committed", "synthetic business area preparation did not commit", transportError);
      }
      prepareStageFail("outcome-conflict", "synthetic business area preparation was not verified", transportError);
    }
    return {
      status: transportError ? "prepared-after-response-recovery" : "prepared",
      environment: target.environment,
      businessAreaId: requested.id,
      active: true,
      references: 0,
      mutationsPerformed: true,
    };
    }, dependencies.bindingDependencies ?? {});
  } catch (error) {
    if (error instanceof PrepareStageError) throw error;
    prepareStageFail("binding-or-transport-failed", "staging binding could not be opened", error);
  }
}

export async function openStagingNativeAuthorityWindow(configPath, requestedArea, dependencies = {}) {
  const requested = areaSpec(requestedArea);
  const ops = operations(dependencies);
  return ops.withBinding(configPath, async ({ db, target }) => {
    assert.deepEqual(target, STAGING_TARGET, "trusted staging target mismatch");
    const areaReferenceTables = await ops.referenceTables(db);
    verifyIsolatedArea(await ops.referenceCounts(db, areaReferenceTables, requested.id), "before");
    const before = await ops.snapshot(db, requested.id);
    assert.deepEqual(before.businessArea, requested, "reviewed synthetic business area differs or is absent");
    const issuedAt = await ops.clock(db);
    const provision = ops.compile(buildProvisionInput(before, target, issuedAt, ops), { root: ops.root });
    const evidence = ops.createEvidence(ops.root, provision.input.approval.approvalId);

    // Durable, private recovery evidence must exist before the only mutation.
    ops.writeEvidence(ops.root, evidence.evidenceDir, "provision.json", provision);

    let transportError;
    try {
      await ops.apply(db, provision, { target, root: ops.root });
    } catch (error) {
      transportError = error;
    }

    let receipt;
    try {
      receipt = await ops.first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?",
        provision.input.approval.commandId);
    } catch (error) {
      throw new AggregateError([...(transportError ? [transportError] : []), error],
        recoveryMessage(evidence.provisionPath, "provision outcome could not be reconciled"));
    }
    if (!receipt) {
      let current;
      try {
        current = await ops.snapshot(db, requested.id);
      } catch (error) {
        throw new AggregateError([...(transportError ? [transportError] : []), error],
          recoveryMessage(evidence.provisionPath, "provision receipt and current state are unavailable"));
      }
      if (current.grants.some(row => provision.input.approval.grantIds.includes(row.id))) {
        fail(recoveryMessage(evidence.provisionPath, "packet grant exists without its atomic provision receipt"));
      }
      throw new AggregateError(transportError ? [transportError] : [],
        "provision did not commit; no packet authority is active");
    }
    if (!same(receipt, provision.receipt)) {
      fail(recoveryMessage(evidence.provisionPath, "immutable provision receipt mismatch"));
    }

    let granted;
    try {
      granted = await ops.snapshot(db, requested.id);
      verifyGranted(granted, provision);
      verifyIsolatedArea(await ops.referenceCounts(db, areaReferenceTables, requested.id), "after");
    } catch (error) {
      throw new AggregateError([...(transportError ? [transportError] : []), error],
        recoveryMessage(evidence.provisionPath, "provision committed but granted state was not verified"));
    }
    try {
      ops.writeEvidence(ops.root, evidence.evidenceDir, "granted-readback.json", granted);
    } catch (error) {
      throw new AggregateError([...(transportError ? [transportError] : []), error],
        recoveryMessage(evidence.provisionPath, "provision committed but private readback was not saved"));
    }

    return {
      status: transportError ? "opened-after-response-recovery" : "opened",
      environment: target.environment,
      businessAreaId: requested.id,
      provisionedPermissions: 2,
      grantedReadbackVerified: true,
      closeBy: provision.input.approval.expiresAt,
      closeByKind: "operator-deadline-no-auto-revocation",
      automaticRevocation: false,
      closeRequired: true,
      evidencePath: evidence.evidenceDir,
      provisionPath: evidence.provisionPath,
    };
  }, dependencies.bindingDependencies ?? {});
}

export async function closeStagingNativeAuthorityWindow(configPath, provisionPath, dependencies = {}) {
  const ops = operations(dependencies);
  return ops.recover(configPath, provisionPath, dependencies);
}

function parseArguments(argv) {
  const values = [...argv];
  const action = values.shift();
  if (action === "prepare" && values.length === 6 && values[0] === "--config"
    && values[2] === "--area-id" && values[4] === "--area-name"
    && values[1] && values[3] && values[5]) {
    return {
      action,
      configPath: values[1],
      area: { id: values[3], name: values[5], active: 1 },
    };
  }
  if (action === "open" && (values.length === 6 || values.length === 8) && values[0] === "--config"
    && values[2] === "--area-id" && values[4] === "--area-name"
    && values[1] && values[3] && values[5]
    && (values.length === 6 || (values[6] === "--window-minutes" && /^\d+$/.test(values[7])))) {
    return {
      action,
      configPath: values[1],
      area: { id: values[3], name: values[5], active: 1 },
      windowMinutes: values.length === 8 ? Number(values[7]) : DEFAULT_WINDOW_MINUTES,
    };
  }
  if ((action === "close" || action === "recover") && values.length === 4
    && values[0] === "--config" && values[2] === "--recover" && values[1] && values[3]) {
    return { action: "close", configPath: values[1], provisionPath: values[3] };
  }
  fail("usage: prepare --config <exact-staging-binding.json> --area-id <fresh-synthetic-area-id> --area-name <exact-area-name> | open --config <exact-staging-binding.json> --area-id <same-area-id> --area-name <same-area-name> [--window-minutes <1-240>] | close --config <exact-staging-binding.json> --recover <private-provision.json>");
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArguments(argv);
  const result = args.action === "prepare"
    ? await prepareStagingNativeAuthorityArea(args.configPath, args.area, dependencies)
    : args.action === "open"
      ? await openStagingNativeAuthorityWindow(args.configPath, args.area,
        { ...dependencies, windowMinutes: args.windowMinutes })
      : await closeStagingNativeAuthorityWindow(args.configPath, args.provisionPath, dependencies);
  (dependencies.log ?? console.log)(JSON.stringify(result));
  return 0;
}

export function cliFailureMessage(action, error) {
  if (action === "prepare") {
    const messages = {
      "local-chain-mismatch": "local reviewed migration chain mismatch; no remote mutation attempted",
      "remote-ledger-invalid": "remote migration ledger response was invalid; no area mutation attempted",
      "remote-ledger-read-failed": "remote migration ledger read or transport failed; no area mutation attempted",
      "remote-ledger-mismatch": "remote migration ledger set differs from the reviewed chain; no area mutation attempted",
      "target-mismatch": "trusted staging target mismatch; no remote mutation attempted",
      "schema-read-failed": "database schema enumeration failed; no area mutation attempted",
      "table-metadata-invalid": "database table metadata was invalid; no area mutation attempted",
      "table-info-read-failed": "database table column metadata read failed; no area mutation attempted",
      "reference-count-read-failed": "business-area reference count read failed; no area mutation attempted",
      "reference-count-invalid": "business-area reference count response was invalid; no area mutation attempted",
      "reference-read-failed": "business-area reference verification failed; no area mutation attempted",
      "area-referenced": "the selected synthetic area id is already referenced; no area mutation attempted",
      "area-conflict": "the selected synthetic area id already exists with different data; no area mutation attempted",
      "batch-not-committed": "the guarded preparation batch did not commit and the area is absent",
      "outcome-conflict": "post-batch state conflicts with the requested unused area; do not open authority",
      "outcome-unknown": "outcome is unknown; re-run prepare with the exact same area id and name before open",
      "binding-or-transport-failed": "staging binding or transport failed before a verified preparation result",
    };
    const code = error?.prepareStageCode ?? "unclassified";
    const detail = messages[code]
      ?? "failure was not classified; do not open authority and inspect locally before retrying";
    return `Staging synthetic area preparation stopped [${code}]: ${detail}.`;
  }
  return error?.message?.includes("--recover")
    ? error.message
    : "Staging native authority window failed; inspect private evidence before any retry.";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(cliFailureMessage(process.argv[2], error));
    process.exitCode = 1;
  });
}
