import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_COLLISIONS_QUERY,
  MINIMAL_AUTHORITY_QUERY,
  READBACK_QUERIES,
  assertReadOnlyQuery,
  collectReadback,
  createD1QueryRunner,
  parseArguments,
  resolveOutputPath,
  sanitizedSummary,
  validateStagingConfigDocument,
  writePrivateArtifact,
} from "./staging-recipient-authority-readback.mjs";
import { transformSeed } from "./staging-bootstrap.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staffId = "staging-operations-owner";
const recordId = "staging-recipient-enrollment-organization-v1";
const businessAreaId = "staging-business-area-v1";
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const onboardingId = `staging-onboarding-profile-edit:${sha256(`${staffId}:${businessAreaId}`).slice(0, 32)}`;
const globalId = `staging-directory-profile-edit:${staffId}`;
const projectId = `staging-project-sync:${staffId}`;
const reviewedHistoryGenerations = Object.freeze({
  globalHistoryGeneration: 2,
  onboardingHistoryGenerations: Object.freeze([2, 3, 4]),
});
const canonicalNames = fs.readdirSync(path.join(repositoryRoot, "apps", "operations", "migrations"))
  .filter(name => /^\d{4}_.+\.sql$/.test(name)
    && name !== "0154_operations_portal_native_recipient_authority.sql").sort();
const reviewedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-recipient-readback-"));
const reviewedOperations = path.join(reviewedRoot, "apps", "operations");
fs.mkdirSync(path.join(reviewedOperations, "migrations"), { recursive: true });
fs.copyFileSync(path.join(repositoryRoot, "apps", "operations", "wrangler.staging.json"),
  path.join(reviewedOperations, "wrangler.staging.json"));
for (const name of canonicalNames) fs.copyFileSync(
  path.join(repositoryRoot, "apps", "operations", "migrations", name),
  path.join(reviewedOperations, "migrations", name));
after(() => fs.rmSync(reviewedRoot, { recursive: true, force: true }));
const readbackInput = Object.freeze({
  base: reviewedRoot,
  selection: Object.freeze({ staffId, recordId }),
  expectations: reviewedHistoryGenerations,
});

const grant = (overrides = {}) => ({
  id: globalId, staff_id: staffId, permission: "directory.profile.edit", effect: "allow", scope_kind: "global",
  business_area_id: null, division_id: null, resource_id: null, active: 0, granted_by: staffId,
  created_at: "2026-09-01T00:00:00.000Z", ...overrides,
});

const history = (source, grantVersion, active, grantGeneration) => ({
  grant_id: source.id, grant_version: grantVersion, staff_id: source.staff_id, permission: source.permission,
  effect: source.effect, scope_kind: source.scope_kind, business_area_id: source.business_area_id,
  division_id: source.division_id, resource_id: source.resource_id, active, grant_generation: grantGeneration,
  recorded_at: `2026-09-0${grantVersion}T00:00:00.000Z`,
});

function fixture() {
  const global = grant();
  const onboarding = grant({ id: onboardingId, scope_kind: "business_area", business_area_id: businessAreaId });
  return {
    migrationLedger: canonicalNames.map((name, index) => ({ id: index + 1, name, applied_at: "2026-09-01" })),
    staffUser: [{ id: staffId, email: "owner@staging.example.test", display_name: "Synthetic Staging Owner",
      status: "active", access_subject: "staging-access-subject" }],
    admission: [{ staff_id: staffId, bound_access_subject: "staging-access-subject", active: 0,
      admitted_by: staffId, version: 5, created_at: "2026-09-01", updated_at: "2026-09-02" }],
    profile: [{ staff_id: staffId, login_email: "owner@staging.example.test", display_name: "Synthetic Staging Owner",
      version: 1, created_at: "2026-09-01", updated_at: "2026-09-01" }],
    roles: [{ role_id: "role-owner", scope: "global" }],
    rolePermissions: [{ role_id: "role-owner", scope: "global", permission_key: "integrations.manage" }],
    permissionOverrides: [],
    directoryGeneration: [{ staff_id: staffId, generation: 4, updated_at: "2026-09-04T00:00:00.000Z" }],
    directoryGrants: [global, onboarding],
    directoryHistory: [history(global, 1, 0, 2), history(onboarding, 1, 0, 2),
      history(onboarding, 2, 1, 3), history(onboarding, 3, 0, 4)],
    businessAreas: [{ id: businessAreaId, name: "Synthetic staging area", active: 1 }],
    projectGeneration: [{ staff_id: staffId, generation: 2 }],
    projectGrants: [{ id: projectId, staff_id: staffId, capability: "project.shared.sync", effect: "allow",
      scope_kind: "global", business_area_id: null, division_id: null, external_project_id: null,
      active: 0, version: 2, granted_by: staffId, created_at: "2026-09-01" }],
    record: [{ record_id: recordId, record_kind: "organization", current_version: 1,
      created_at: "2026-09-01", updated_at: "2026-09-01" }],
    recordReviews: [],
    activationReceipts: [],
    staffManagementFences: [], staffAdminFences: [], writeFences: [], projectLiveProofs: [], pendingProjectOutbox: [], pendingDirectoryOutbox: [],
    pendingWorkspaceOutbox: [], pendingAuthorityOutbox: [], nonterminalRecipientIntents: [], foreignKeyCheck: [],
    identityCollisions: [{ staff_users: 0, admissions: 0, profiles: 0 }],
    minimalAuthority: [{ target_memberships: 0, admin_delegations: 0, management_delegations: 0,
      integration_control_grants: 0, integration_management_grants: 0, workforce_authority_grants: 0,
      workforce_grant_manager_delegations: 0, time_selection_delegations: 0,
      time_selection_issuer_delegations: 0, time_selection_lifecycle_delegations: 0 }],
  };
}

function stubRunner(rows, calls = []) {
  return async request => {
    assertReadOnlyQuery(request.sql);
    assert.ok(Array.isArray(request.params));
    calls.push(structuredClone(request));
    if (!Object.hasOwn(rows, request.name)) throw new Error(`missing stub for ${request.name}`);
    return structuredClone(rows[request.name]);
  };
}

function canonicalDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const directory = path.join(repositoryRoot, "apps", "operations", "migrations");
  const owner = { email: "owner@staging.example.test", displayName: "Synthetic Staging Owner",
    clientStaffId: "staging-client-owner", operationsStaffId: staffId };
  for (const name of canonicalNames) {
    const source = fs.readFileSync(path.join(directory, name), "utf8");
    const migration = name === "0002_seed_acl.sql" ? transformSeed("operations", source, owner) : source;
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
      database.close();
      throw error;
    }
  }
  return database;
}

test("captures the exact known inactive two-grant lineage as ready without mutation", async () => {
  const calls = [];
  const times = [new Date("2026-09-28T18:00:00.000Z"), new Date("2026-09-28T18:00:01.000Z")];
  const artifact = await collectReadback({
    ...readbackInput,
    query: stubRunner(fixture(), calls),
    now: () => times.shift(),
  });
  assert.equal(artifact.ready, true);
  assert.equal(artifact.mutationsPerformed, false);
  assert.deepEqual(artifact.capture, {
    startedAt: "2026-09-28T18:00:00.000Z",
    completedAt: "2026-09-28T18:00:01.000Z",
    atomicSnapshot: false,
  });
  assert.deepEqual(artifact.limitations, {
    preflightOnly: true,
    provisioningAuthority: false,
    finalProvisionGuardMustRecheckLiveState: true,
    localMigrationHashesDoNotAttestRemoteAppliedSql: true,
  });
  assert.equal(artifact.observedAt, artifact.capture.completedAt);
  assert.deepEqual(artifact.directory.history.map(row => [row.grant_id, row.grant_version, row.grant_generation]), [
    [globalId, 1, 2], [onboardingId, 1, 2], [onboardingId, 2, 3], [onboardingId, 3, 4],
  ]);
  assert.equal(artifact.source.localCanonicalLedger.finalMigration, "0155_operations_portal_workspace_publication_cancellations.sql");
  assert.equal(artifact.source.localCanonicalLedger.attestsRemoteAppliedSql, false);
  assert.equal(artifact.checks.migrationLedgerNamesMatchCanonical, true);
  assert.deepEqual(artifact.reviewedHistoryGenerations, reviewedHistoryGenerations);
  assert.equal(calls.length, READBACK_QUERIES.length + 2);
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|UPSERT)\b/i);
    if (call.name !== "migrationLedger" && call.name !== "foreignKeyCheck") assert.ok(call.params.length > 0);
  }
  const bound = calls.filter(call => call.params.includes(staffId) || call.params.includes(recordId));
  assert.equal(bound.length, calls.length - 2);
});

test("keeps per-grant generations exact without imposing staff-wide uniqueness", async () => {
  const rows = fixture();
  assert.equal(rows.directoryHistory[0].grant_generation, rows.directoryHistory[1].grant_generation);
  const artifact = await collectReadback({ ...readbackInput, query: stubRunner(rows) });
  assert.equal(artifact.checks.exactPerGrantHistory, true);
});

test("wrong positive reviewed generation inputs fail closed even when the rows are otherwise valid", async t => {
  for (const [name, expectations] of [
    ["global", { globalHistoryGeneration: 3, onboardingHistoryGenerations: [2, 3, 4] }],
    ["onboarding intermediate", { globalHistoryGeneration: 2, onboardingHistoryGenerations: [2, 4, 5] }],
  ]) await t.test(name, async () => {
    const artifact = await collectReadback({ ...readbackInput, expectations, query: stubRunner(fixture()) });
    assert.equal(artifact.checks.exactPerGrantHistory, false);
    assert.equal(artifact.ready, false);
  });
});

test("every readback query prepares and executes against the complete canonical 154-migration schema", () => {
  const database = canonicalDatabase();
  try {
    const selection = { staffId, recordId };
    for (const definition of READBACK_QUERIES) {
      assertReadOnlyQuery(definition.sql);
      database.prepare(definition.sql).all(...definition.params(selection));
    }
    for (const [definition, params] of [
      [IDENTITY_COLLISIONS_QUERY, IDENTITY_COLLISIONS_QUERY.params(selection,
        { email: "owner@staging.example.test", access_subject: "staging-access-subject" })],
      [MINIMAL_AUTHORITY_QUERY, MINIMAL_AUTHORITY_QUERY.params(selection)],
    ]) {
      assertReadOnlyQuery(definition.sql);
      database.prepare(definition.sql).all(...params);
    }
  } finally {
    database.close();
  }
});

test("canonical 0150 cancellation receipts exclude canceled intents while every uncanceled nonterminal state blocks", () => {
  const database = canonicalDatabase();
  try {
    // This reduced local fixture bypasses write-side guards and foreign keys only
    // to exercise the readback SELECT against the actual canonical 150 schema.
    // The cancellation runtime and its guarded write path are covered elsewhere.
    database.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER client_portal_workspace_binding_selection_guard;
      DROP TRIGGER client_portal_recipient_enrollment_insert_guard;
      DROP TRIGGER client_portal_recipient_enrollment_cancellation_insert_guard;`);
    const selectionId = "00000000-0000-4000-8000-000000000010";
    database.prepare(`INSERT INTO client_portal_workspace_binding_selections(
      selection_id,request_sha256,client_authority_id,record_id,activation_id,record_version,
      source_id,source_instance_id,application_id,history_epoch_id,root_type,root_public_id,
      workspace_id,source_workspace_id,checkpoint_source_generation,checkpoint_source_sequence,
      checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,
      reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation,verified_until,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'inactive')`).run(
        selectionId, "a".repeat(64), "00000000-0000-4000-8000-000000000011", recordId,
        "00000000-0000-4000-8000-000000000012", 1, "project-alpha:staging", "source-instance",
        "application", "history-epoch", "organization", "b".repeat(32), "workspace",
        "source-workspace", "source-generation", 1, "snapshot-generation", staffId,
        "staging-access-subject", 1, 1, 1, "2099-01-01T00:00:00.000Z",
      );
    const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
    const insertIntent = (suffix, state, revision) => {
      const recipient = state === "issued" ? [null, null, null] : ["issuer", `subject-${suffix}`, "2099-01-01T00:00:00.000Z"];
      const binding = ["active", "revoking", "revoked"].includes(state) ? `binding-${suffix}` : null;
      const grantOperation = binding ? id(100 + suffix) : null;
      const revokeOperation = ["revoking", "revoked"].includes(state) ? id(200 + suffix) : null;
      database.prepare(`INSERT INTO client_portal_recipient_enrollment_intents(
        intent_id,selection_id,target_client_record_id,token_sha256,state,revision,
        access_issuer,access_subject,recipient_verified_until,binding_id,grant_operation_id,revoke_operation_id,
        issued_by_staff_id,issued_access_subject,issued_admission_version,issued_profile_version,
        issued_grant_generation,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id(suffix), selectionId, recordId, String(suffix).repeat(64), state, revision,
          ...recipient, binding, grantOperation, revokeOperation, staffId, "staging-access-subject",
          1, 1, 1, "2099-01-01T00:00:00.000Z",
        );
      return id(suffix);
    };
    const uncanceled = [
      insertIntent(1, "issued", 1),
      insertIntent(2, "pending", 2),
      insertIntent(3, "active", 3),
      insertIntent(4, "revoking", 4),
    ];
    const canceled = insertIntent(5, "issued", 1);
    insertIntent(6, "revoked", 5);
    database.prepare(`INSERT INTO client_portal_recipient_enrollment_cancellations(
      intent_id,operation_id,request_sha256,prior_state,prior_revision,resulting_revision,
      actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
      actor_grant_generation,actor_verified_until)
      VALUES(?,?,?,'issued',1,2,?,?,?,?,?,?)`).run(
        canceled, id(95), "f".repeat(64), staffId, "staging-access-subject", 1, 1, 1,
        "2099-01-01T00:00:00.000Z",
      );
    const definition = READBACK_QUERIES.find(query => query.name === "nonterminalRecipientIntents");
    assert.ok(definition);
    const rows = database.prepare(definition.sql).all(...definition.params({ staffId, recordId }));
    assert.deepEqual(rows.map(row => [row.intent_id, row.state]), [
      [uncanceled[0], "issued"], [uncanceled[1], "pending"],
      [uncanceled[2], "active"], [uncanceled[3], "revoking"],
    ]);
  } finally {
    database.close();
  }
});

test("unexpected authority rows and history drift fail closed as ready false", async t => {
  const cases = [
    ["unexpected grant", rows => rows.directoryGrants.push(grant({ id: "staging-unexpected-grant", permission: "directory.identity.link",
      scope_kind: "resource", resource_id: recordId }))],
    ["missing onboarding history", rows => rows.directoryHistory.splice(2, 1)],
    ["renumbered onboarding history", rows => { rows.directoryHistory[2].grant_version = 9; }],
    ["wrong positive global generation", rows => { rows.directoryHistory[0].grant_generation = 3; }],
    ["wrong positive onboarding lineage", rows => {
      rows.directoryHistory[2].grant_generation = 4;
      rows.directoryHistory[3].grant_generation = 5;
      rows.directoryGeneration[0].generation = 5;
    }],
    ["current Directory generation drift", rows => { rows.directoryGeneration[0].generation = 5; }],
    ["project generation drift", rows => { rows.projectGeneration[0].generation = 3; }],
    ["admission subject drift", rows => { rows.admission[0].bound_access_subject = "another-subject"; }],
    ["scope drift", rows => { rows.directoryGrants[1].scope_kind = "global"; rows.directoryGrants[1].business_area_id = null; }],
    ["effect drift", rows => { rows.directoryGrants[1].effect = "deny"; }],
    ["inactive referenced business area", rows => { rows.businessAreas[0].active = 0; }],
    ["additional authority", rows => { rows.minimalAuthority[0].admin_delegations = 1; }],
    ["activation receipt already exists", rows => { rows.activationReceipts.push({ activation_id: "private-id" }); }],
    ["in-flight work", rows => { rows.pendingWorkspaceOutbox.push({ command_id: "private-id", state: "pending" }); }],
    ["uncanceled issued intent", rows => { rows.nonterminalRecipientIntents.push({ intent_id: "private-id", state: "issued" }); }],
    ["staff management fence", rows => { rows.staffManagementFences.push({ command_id: "private-id" }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const rows = fixture();
    mutate(rows);
    const artifact = await collectReadback({ ...readbackInput, query: stubRunner(rows) });
    assert.equal(artifact.ready, false);
  });
});

test("query failures, malformed results, and ambiguous actor rows are never treated as absence", async t => {
  await t.test("missing reviewed generation expectations", async () => {
    await assert.rejects(collectReadback({ base: repositoryRoot, selection: { staffId, recordId },
      query: stubRunner(fixture()) }), /expectations are required/);
  });
  await t.test("runner failure", async () => {
    const rows = fixture();
    await assert.rejects(collectReadback({ ...readbackInput, query: async request => {
      if (request.name === "recordReviews") throw new Error("remote failure");
      return structuredClone(rows[request.name]);
    } }), /remote failure/);
  });
  await t.test("non-array result", async () => {
    const rows = fixture();
    rows.recordReviews = null;
    await assert.rejects(collectReadback({ ...readbackInput, query: stubRunner(rows) }),
      /did not return rows/);
  });
  await t.test("multiple selected actors", async () => {
    const rows = fixture();
    rows.staffUser.push({ ...rows.staffUser[0] });
    await assert.rejects(collectReadback({ ...readbackInput, query: stubRunner(rows) }),
      /exactly one row/);
  });
  await t.test("colliding identity", async () => {
    const rows = fixture();
    rows.identityCollisions[0].staff_users = 1;
    await assert.rejects(collectReadback({ ...readbackInput, query: stubRunner(rows) }),
      /identity is ambiguous/);
  });
  await t.test("missing selected target", async () => {
    const rows = fixture();
    rows.record = [];
    await assert.rejects(collectReadback({ ...readbackInput, query: stubRunner(rows) }),
      /exactly one row/);
  });
});

test("argument parser requires explicit bounded staging selections and rejects unknown arguments", () => {
  const valid = ["--execute-readback", "--staff-id", staffId, "--record-id", recordId,
    "--expected-global-generation", "2", "--expected-onboarding-generations", "2,3,4", "--output",
    ".backups/staging-recipient-authority-readback/recipient-authority-readback-20260928T180000Z-review01.json"];
  assert.deepEqual(parseArguments(valid).expectations, reviewedHistoryGenerations);
  assert.throws(() => parseArguments(valid.slice(1)), /execute-readback/);
  assert.throws(() => parseArguments([...valid, "--surprise"]), /unknown argument/);
  assert.throws(() => parseArguments([...valid, "--staff-id", staffId]), /duplicate/);
  assert.throws(() => parseArguments(valid.map(value => value === recordId ? "customer-record" : value)), /record id is invalid/);
  assert.throws(() => parseArguments(valid.map(value => value === "2,3,4" ? "2,4" : value)), /exactly three/);
  assert.throws(() => parseArguments(valid.map(value => value === "2,3,4" ? "2,4,3" : value)), /strictly increasing/);
  assert.throws(() => parseArguments(valid.map(value => value === "2,3,4" ? "2,0,4" : value)), /positive safe integer/);
});

test("config validation rejects production or drifted account and database targets", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "apps", "operations", "wrangler.staging.json"), "utf8"));
  assert.equal(validateStagingConfigDocument(config).binding, "OPS_DB");
  assert.throws(() => validateStagingConfigDocument({ ...structuredClone(config), account_id: "production-account" }),
    /exact pinned staging target/);
  const databaseDrift = structuredClone(config);
  databaseDrift.d1_databases.find(database => database.binding === "OPS_DB").database_id = "6ebf7514-d306-4615-ae56-ad869c874dbd";
  assert.throws(() => validateStagingConfigDocument(databaseDrift), /exact pinned staging database/);
  assert.throws(() => validateStagingConfigDocument({ ...structuredClone(config), name: "ledgetop-ops" }),
    /exact pinned staging target/);
});

test("private output is new, directly contained, non-symlinked, and sanitized on stdout", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-readback-test-"));
  t.after(() => {
    assert.equal(path.dirname(temporary), os.tmpdir());
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const requested = ".backups/staging-recipient-authority-readback/recipient-authority-readback-20260928T180000Z-review01.json";
  const artifact = {
    ready: false, selection: { staffId: "private-staff", recordId: "private-record" },
    directory: { grants: [{ id: "private-grant" }], history: [] },
    target: { activationReceipts: [] }, inFlight: { pending: [] }, checks: { exact: false },
  };
  const written = writePrivateArtifact(temporary, requested, artifact);
  const summary = JSON.stringify(sanitizedSummary(artifact, written));
  assert.doesNotMatch(summary, /private-(?:staff|record|grant)/);
  assert.match(written.relative, /^\.backups\/staging-recipient-authority-readback\//);
  assert.throws(() => writePrivateArtifact(temporary, requested, artifact), /already exists/);
  assert.throws(() => resolveOutputPath(temporary, "outside.json"), /private readback directory/);
  assert.throws(() => resolveOutputPath(temporary,
    ".backups/staging-recipient-authority-readback/private-staff.json"), /private readback directory/);
});

test("private output rejects a symlinked destination directory when supported", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-readback-link-test-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-readback-link-target-"));
  t.after(() => {
    for (const directory of [temporary, elsewhere]) {
      assert.equal(path.dirname(directory), os.tmpdir());
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(path.join(temporary, ".backups"));
  try { fs.symlinkSync(elsewhere, path.join(temporary, ".backups", "staging-recipient-authority-readback"), "junction"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return t.skip("symlink creation is unavailable");
    throw error;
  }
  assert.throws(() => resolveOutputPath(temporary,
    ".backups/staging-recipient-authority-readback/recipient-authority-readback-20260928T180000Z-review01.json"),
  /output ancestor/);
});

test("D1 transport sends bound parameters and rejects mutation metadata or failed result envelopes", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results: [{ count: 1 }],
      meta: { changed_db: false, changes: 0 } }] }) };
  };
  const query = createD1QueryRunner({ fetchImpl, token: "private-token", accountId: "846c924bf17bf4f3dd15c97a4c5d1d51",
    databaseId: "78b34173-b168-4e3d-9832-bb9d245cc6b8" });
  assert.deepEqual(await query({ name: "bound", sql: "SELECT count(*) AS count FROM staff_users WHERE id=?", params: [staffId] }),
    [{ count: 1 }]);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    sql: "SELECT count(*) AS count FROM staff_users WHERE id=?", params: [staffId],
  });
  assert.equal(requests[0].init.headers.authorization, "Bearer private-token");
  assert.throws(() => assertReadOnlyQuery("UPDATE staff_users SET status='active'"), /read-only/);
  const changed = createD1QueryRunner({ fetchImpl: async () => ({ ok: true, json: async () => ({ success: true,
    result: [{ success: true, results: [], meta: { changed_db: true, changes: 1 } }] }) }), token: "private-token",
    accountId: "846c924bf17bf4f3dd15c97a4c5d1d51", databaseId: "78b34173-b168-4e3d-9832-bb9d245cc6b8" });
  await assert.rejects(changed({ name: "changed", sql: "SELECT 1", params: [] }), /query changed failed/);
});
