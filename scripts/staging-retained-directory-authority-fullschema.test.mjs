import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

import {
  RETAINED_DIRECTORY_TARGET as target, REVIEWED_REFERENCE_BASELINE,
  applyRetainedDirectoryAuthority, compileRetainedDirectoryAuthority, verifyReviewedReferenceSchema,
} from "./staging-retained-directory-authority.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const root = path.resolve(import.meta.dirname, "..");
const requireOperations = createRequire(path.join(root, "apps/operations/package.json"));
const { Miniflare } = requireOperations("miniflare");
const { unstable_splitSqlQuery } = requireOperations("wrangler");
const { build } = requireOperations("esbuild");
const migrationDirectory = path.join(root, "apps/operations/migrations");
const migrationNames = fs.readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const grantIds = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"];
const permissions = ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
function nodeSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    sql, params,
    bind(...values) { return wrap(sql, values); },
    async run() {
      try {
        const statement = sqlite.prepare(sql);
        if (statement.columns().length) return { success: true, results: statement.all(...params).map(row => ({ ...row })),
          meta: { changes: 0, last_row_id: 0 } };
        const result = statement.run(...params);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      } catch (error) { throw error; }
    },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...params).map(row => ({ ...row })) }; },
    async first(column) { const row = sqlite.prepare(sql).get(...params); return row === undefined ? null : column ? row[column] : { ...row }; },
  });
  const adapter = { prepare: wrap, withSession() { return adapter; }, async batch(statements) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        try { results.push(await statement.run()); }
        catch (error) { throw new Error(`node:sqlite batch statement ${index} failed: ${error.message}`, { cause: error }); }
      }
      sqlite.exec("COMMIT");
      return results;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }, close() { sqlite.close(); } };
  return adapter;
}
const nowWindow = (offset = 0) => {
  const now = Date.now() + offset;
  return { issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), executedAt: new Date(now).toISOString() };
};
let directoryWriter;
const bundledModules = new Map();
async function loadBundledModule(relativePath) {
  if (bundledModules.has(relativePath)) return bundledModules.get(relativePath);
  const built = await build({ entryPoints: [path.join(root, "apps/operations/src/worker", relativePath)],
    bundle: true, platform: "node", format: "esm", write: false, target: "node22" });
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
  bundledModules.set(relativePath, loaded);
  return loaded;
}
async function loadDirectoryWriter() {
  if (directoryWriter) return directoryWriter;
  directoryWriter = await loadBundledModule("native-directory-profile-writer.ts");
  return directoryWriter;
}

const response = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Request-ID": typeof body?.requestId === "string" ? body.requestId : crypto.randomUUID() } });
const recoveryEnvironment = db => ({ OPS_DB: db, PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: "true",
  PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [target.sourceId]: { sourceId: target.sourceId,
    enabled: true, baseUrl: "https://pa-staging.ledgetoptechnologies.com", apiKey: "test", sourceInstanceId: "d2f7acb8-375d-4da7-8d37-3f2455a3972b",
    applicationId: "150cb108-af37-4973-ab6e-f6d991a6e8c8", historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998" } } }) });
const capabilities = requestId => ({ apiVersion: "2", sourceInstanceId: "d2f7acb8-375d-4da7-8d37-3f2455a3972b",
  applicationId: "150cb108-af37-4973-ab6e-f6d991a6e8c8", historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998", requestId,
  grantedCapabilities: ["api.capabilities.read", "directory.inventory.read", "directory.clients.create", "directory.clients.write"].map(name => ({ name })),
  implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
    { method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    { method: "POST", path: "/api/v2/directory/clients/commands", requiredCapability: "directory.clients.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }] });
const recoveryTransport = (generation, acknowledge = false) => async (url, init) => {
  const requestId = crypto.randomUUID(), pathname = new URL(String(url)).pathname;
  if (pathname.endsWith("/capabilities")) return response(capabilities(requestId));
  if (pathname.endsWith("/inventory")) return response({ sourceInstanceId: "d2f7acb8-375d-4da7-8d37-3f2455a3972b",
    applicationId: "150cb108-af37-4973-ab6e-f6d991a6e8c8", historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998",
    requestId, authorizationGeneration: generation, resources: [], nextCursor: null });
  if (acknowledge) {
    const body = JSON.parse(String(init?.body));
    return response({ sourceInstanceId: "d2f7acb8-375d-4da7-8d37-3f2455a3972b", applicationId: "150cb108-af37-4973-ab6e-f6d991a6e8c8",
      historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998", requestId, replayed: false,
      result: { resource: { type: "client", id: body.externalId, publicId: "a".repeat(32), revision: "1" }, authorizationGeneration: "54" } }, 201);
  }
  return response({ apiVersion: "2", sourceInstanceId: "d2f7acb8-375d-4da7-8d37-3f2455a3972b",
    applicationId: "150cb108-af37-4973-ab6e-f6d991a6e8c8", historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998", requestId,
    error: { code: "authorization_generation_conflict" } }, 409);
};

function legacyArtifact(phase, sequence, priorProvision) {
  const input = { schemaVersion: 3, staging: STAGING_TARGET, phase,
    admission: { staff_id: target.staffId }, businessArea: { id: target.areaId }, approval: { grantIds }, priorProvision };
  const plan = json(input), approvalId = `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const commandId = `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const verification = json({ phase }), result = json({ phase });
  const approval = { approval_id: approvalId, canonical_plan_json: plan, canonical_plan_sha256: sha(plan),
    approved_operator_staff_id: target.staffId, approved_operator_access_subject: "access|retained",
    independent_binding_verification_json: verification, independent_binding_verification_sha256: sha(verification),
    issued_by_staff_id: target.staffId, issued_by_access_subject: "access|retained",
    issued_at: "2026-10-08T10:00:00.000Z", expires_at: "2026-10-08T11:00:00.000Z", revoked_at: null };
  const receipt = { command_id: commandId, approval_id: approvalId, operator_staff_id: target.staffId,
    operator_access_subject: "access|retained", canonical_plan_json: plan, canonical_plan_sha256: sha(plan),
    independent_binding_verification_json: verification, independent_binding_verification_sha256: sha(verification),
    result_json: result, result_sha256: sha(result), executed_at: "2026-10-08T10:01:00.000Z" };
  return { schemaVersion: 3, input, planHash: sha(plan), approval, receipt, statements: [] };
}

async function migrate(db) {
  assert.equal(migrationNames.length, 181);
  assert.equal(migrationNames.at(-1), "0181_project_alpha_directory_create_generation_recovery.sql");
  await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  for (const name of migrationNames) {
    const source = fs.readFileSync(path.join(migrationDirectory, name), "utf8").replace(/\r\n/g, "\n");
    const statements = unstable_splitSqlQuery(source).map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(sql));
    await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
}

async function seed(db) {
  const canonicalStaff = await first(db, "SELECT id,email,display_name,status FROM staff_users WHERE id=?", target.staffId);
  assert.deepEqual(canonicalStaff, { id: target.staffId, email: "beaukoltz@ledgetopdroneservices.com", display_name: "Beau Koltz", status: "active" });
  await db.prepare("UPDATE staff_users SET access_subject=? WHERE id=? AND access_subject IS NULL")
    .bind("access|retained", target.staffId).run();
  await db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
    .bind(target.staffId, "access|retained", target.staffId).run();
  await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
    .bind(target.staffId, canonicalStaff.email, canonicalStaff.display_name).run();
  await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)").bind(target.areaId, "Retained Area").run();
  for (let index = 0; index < grantIds.length; index++) await db.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,?,'allow','business_area',?,1,?)`)
    .bind(grantIds[index], target.staffId, permissions[index], target.areaId, target.staffId).run();
  const mutationId = target.recordId, admissionId = `admission-${mutationId}`;
  const profile = { name: "Retained client", email: "", phone: "", clientType: "unknown", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" };
  const scopes = [{ businessAreaId: target.areaId, divisionId: null }];
  const destination = { sourceId: target.sourceId, sourceInstanceUUID: "d2f7acb8-375d-4da7-8d37-3f2455a3972b",
    applicationUUID: "150cb108-af37-4973-ab6e-f6d991a6e8c8", historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998",
    origin: "https://pa-staging.ledgetoptechnologies.com", externalCanonicalId: target.recordId, expectedAuthorizationGeneration: "52" };
  await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
    scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?, 'client',?,?,?,?)`)
    .bind(admissionId, target.staffId, "access|retained", target.recordId, JSON.stringify(scopes), JSON.stringify(profile),
      JSON.stringify([{ ...destination, expectedAuthorizationGeneration: undefined }], (_, value) => value), target.staffId).run();
  await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,
    organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)`).bind(admissionId, target.recordId).run();
  const { writeNativeDirectoryProfile } = await loadDirectoryWriter();
  const created = await writeNativeDirectoryProfile(db, { operation: "create", mutationId, createAdmissionId: admissionId,
    recordId: target.recordId, expectedLocalVersion: 0, kind: "client", profile, scopes, destinations: [destination],
    actor: { staffId: target.staffId, accessSubject: "access|retained", admissionVersion: 1,
      selectedGrantId: grantIds[0], loginEmail: canonicalStaff.email, profileVersion: 1, selectedIdentityGrantId: grantIds[1] },
    relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } });
  assert.equal(created.status, "written");
  assert.equal(created.commandIds.length, 1);
  assert.equal(created.commandIds[0], target.predecessorCommandId);
  await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',lease_token='retained-test',
    lease_expires_at=?,attempts=attempts+1 WHERE command_id=? AND state='pending'`).bind(Date.now() + 60_000, target.predecessorCommandId).run();
  await db.prepare(`UPDATE project_alpha_directory_outbox SET state='terminal',outcome_json=?,lease_token=NULL,lease_expires_at=NULL
    WHERE command_id=? AND state='leased' AND lease_token='retained-test'`).bind(JSON.stringify({ directoryProfileDispatcher: "conflict",
      reason: "http_status", httpStatus: 409, requestId: "retained-request" }), target.predecessorCommandId).run();
  for (const id of grantIds) await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(id).run();
  await db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,version,granted_by)
    VALUES('retained-project-grant',?,'project.shared.sync','allow','business_area',?,0,2,?)`).bind(target.staffId, target.areaId, target.staffId).run();
  await db.prepare("UPDATE native_project_grant_generations SET generation=14 WHERE staff_id=?").bind(target.staffId).run();
  const provision = legacyArtifact("provision", 1, null);
  const revoke = legacyArtifact("revoke", 2, { receipt: provision.receipt });
  for (const artifact of [provision, revoke]) {
    const approval = artifact === provision ? { ...artifact.approval, revoked_at: revoke.receipt.executed_at } : artifact.approval;
    await db.prepare(`INSERT INTO native_staff_bootstrap_approvals VALUES(${Array(12).fill("?").join(",")})`).bind(...Object.values(approval)).run();
    await db.prepare(`INSERT INTO native_staff_bootstrap_receipts VALUES(${Array(11).fill("?").join(",")})`).bind(...Object.values(artifact.receipt)).run();
  }
  return { provision, revoke };
}

async function seedUnrelatedGrantHistory(db) {
  const rows = [
    { id: "retained-unrelated-global", permission: "directory.profile.view", scope: "global", area: null },
    { id: "retained-unrelated-other-area", permission: "directory.profile.view", scope: "business_area", area: "retained-unrelated-area" },
  ];
  await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)")
    .bind("retained-unrelated-area", "Unrelated retained area").run();
  for (const row of rows) {
    await db.prepare(`INSERT INTO native_directory_grants
      (id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,?,'allow',?,?,1,?)`)
      .bind(row.id, target.staffId, row.permission, row.scope, row.area, target.staffId).run();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=? AND active=1").bind(row.id).run();
  }
  return rows.map(row => row.id);
}

async function makeInput(db, lineage, phase = "reactivate", approvalSequence = 1, window = nowWindow()) {
  const admission = await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", target.staffId);
  const profile = await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", target.staffId);
  const generation = await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", target.staffId);
  const grants = await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", target.staffId);
  const history = await all(db, "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version", target.staffId);
  const areaHistoryCount = (await first(db, "SELECT count(*) count FROM native_directory_grant_history WHERE business_area_id=?", target.areaId)).count;
  const input = { schemaVersion: 1, staging: STAGING_TARGET, phase, target, migrationNames,
    admission, profile, generation,
    projectGeneration: await first(db, "SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?", target.staffId),
    businessArea: await first(db, "SELECT id,name,active FROM native_business_areas WHERE id=?", target.areaId),
    resourceScope: await first(db, "SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id=?", target.recordId),
    projectGrant: await first(db, `SELECT id,staff_id,capability,effect,scope_kind,business_area_id,division_id,external_project_id,active,version,granted_by,created_at
      FROM native_project_grants WHERE business_area_id=?`, target.areaId), grants, history,
    referenceCounts: { ...REVIEWED_REFERENCE_BASELINE, native_directory_grant_history: areaHistoryCount },
    predecessor: await first(db, "SELECT command_id,source_id,resource_type,external_id,state,outcome_json FROM project_alpha_directory_outbox WHERE command_id=?", target.predecessorCommandId),
    lineage: phase === "reactivate" ? { provisionArtifact: lineage.provision, revokeArtifact: lineage.revoke,
      provisionReceipt: lineage.provision.receipt, revokeReceipt: lineage.revoke.receipt }
      : { provisionArtifact: lineage.provision, revokeArtifact: lineage.revoke, provisionReceipt: lineage.provision.receipt,
        revokeReceipt: lineage.revoke.receipt, reactivationArtifact: lineage.reactivation, reactivationReceipt: lineage.reactivation.receipt },
    approval: { approvalId: `40000000-0000-4000-8000-${String(approvalSequence).padStart(12, "0")}`,
      commandId: `50000000-0000-4000-8000-${String(approvalSequence).padStart(12, "0")}`, ...window } };
  return input;
}

async function makeSchema2Input(db, latestClose, phase, approvalSequence, reactivation) {
  let rootClose = latestClose;
  while (rootClose.input.schemaVersion === 2) rootClose = rootClose.input.lineage.latestCloseArtifact;
  const value = await makeInput(db, { provision: rootClose.input.lineage.provisionArtifact,
    revoke: rootClose.input.lineage.revokeArtifact }, "reactivate", approvalSequence);
  value.schemaVersion = 2;
  value.phase = phase;
  value.lineage = { latestCloseArtifact: latestClose, latestCloseReceipt: latestClose.receipt,
    ...(phase === "revoke" ? { reactivationArtifact: reactivation, reactivationReceipt: reactivation.receipt } : {}) };
  return value;
}

async function recoverAndAcknowledgeRetainedCreate(db) {
  const { readConfiguredProjectAlphaDirectoryInventory } = await loadBundledModule("project-alpha-directory-command-api-v2.ts");
  const { persistProjectAlphaDirectoryInventoryPage } = await loadBundledModule("project-alpha-v2-sync.ts");
  const { prepareDirectoryCreateGenerationRecovery } = await loadBundledModule("project-alpha-directory-create-generation-recovery.ts");
  const { dispatchProjectAlphaDirectoryProfileOutboxCommand } = await loadBundledModule("project-alpha-directory-profile-outbox-dispatcher.ts");
  const environment = recoveryEnvironment(db), inventoryTransport = recoveryTransport("53");
  const probe = await readConfiguredProjectAlphaDirectoryInventory(environment, target.sourceId, { type: "all", limit: 1 }, inventoryTransport);
  assert.equal(probe.status, "observed");
  assert.equal((await persistProjectAlphaDirectoryInventoryPage(db, probe.inventory, null)).status, "persisted");
  const successorCommandId = "80000000-0000-4000-8000-000000000001";
  assert.deepEqual(await prepareDirectoryCreateGenerationRecovery(environment, { authorizationId: "80000000-0000-4000-8000-000000000002",
    predecessorCommandId: target.predecessorCommandId, successorCommandId, sourceId: target.sourceId, reason: "Reviewed retained-window generation recovery" },
  { staffId: target.staffId, accessSubject: "access|retained", email: "beaukoltz@ledgetopdroneservices.com", admissionVersion: 1,
    profileVersion: 1, verifiedUntil: "2999-01-01T00:00:00.000Z" }, recoveryTransport("53")),
  { status: "prepared", successorCommandId, generation: "53", replayed: false });
  const dispatched = await dispatchProjectAlphaDirectoryProfileOutboxCommand(environment, target.sourceId, successorCommandId, recoveryTransport("53", true));
  assert.equal(dispatched.status, "acknowledged");
  assert.equal((await first(db, "SELECT count(*) count FROM project_alpha_directory_unsettled_commands u JOIN project_alpha_directory_outbox o ON o.command_id=u.command_id WHERE json_extract(o.origin_snapshot_json,'$.actorId')=?", target.staffId)).count, 0);
}

async function createCanonicalPendingDirectoryWork(db) {
  const ids = ["pending-edit", "pending-identity", "pending-enroll"];
  for (let index = 0; index < ids.length; index++) {
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,?,'allow','global',1,?)`).bind(ids[index], target.staffId, permissions[index], target.staffId).run();
  }
  const recordId = "90000000-0000-4000-8000-000000000001", admissionId = `admission-${recordId}`;
  const profile = { name: "Pending work", email: "", phone: "", clientType: "unknown", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" };
  const scopes = [{ businessAreaId: target.areaId, divisionId: null }];
  const destination = { sourceId: target.sourceId, sourceInstanceUUID: "d2f7acb8-375d-4da7-8d37-3f2455a3972b",
    applicationUUID: "150cb108-af37-4973-ab6e-f6d991a6e8c8", historyEpoch: "8c194c00-c7dd-4c6c-82ce-d391ef3fa998",
    origin: "https://pa-staging.ledgetoptechnologies.com", externalCanonicalId: recordId, expectedAuthorizationGeneration: "53" };
  await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
    scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?, 'client',?,?,?,?)`)
    .bind(admissionId, target.staffId, "access|retained", recordId, JSON.stringify(scopes), JSON.stringify(profile),
      JSON.stringify([{ ...destination, expectedAuthorizationGeneration: undefined }], (_, value) => value), target.staffId).run();
  await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,
    organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)`).bind(admissionId, recordId).run();
  const { writeNativeDirectoryProfile } = await loadDirectoryWriter();
  const created = await writeNativeDirectoryProfile(db, { operation: "create", mutationId: recordId, createAdmissionId: admissionId,
    recordId, expectedLocalVersion: 0, kind: "client", profile, scopes, destinations: [destination], actor: { staffId: target.staffId,
      accessSubject: "access|retained", admissionVersion: 1, selectedGrantId: ids[0], loginEmail: "beaukoltz@ledgetopdroneservices.com",
      profileVersion: 1, selectedIdentityGrantId: ids[1] }, relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } });
  assert.equal(created.status, "written");
  return created.commandIds[0];
}

test("retained directory authority executes against the complete 181-migration D1 schema", async t => {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: `retained-${crypto.randomUUID()}` } });
  try {
    const db = await mf.getD1Database("DB");
    await migrate(db);
    const lineage = await seed(db);

    await t.test("discovers the exact reviewed schema without introspecting protected Cloudflare metadata", async () => {
      assert.deepEqual(await first(db, "SELECT name FROM sqlite_schema WHERE name='_cf_METADATA'"), { name: "_cf_METADATA" });
      assert.deepEqual((await verifyReviewedReferenceSchema(db)).sort(), Object.keys(REVIEWED_REFERENCE_BASELINE).sort());
    });

    await t.test("rolls back a raced grant CAS without leaving approval or history", async () => {
      const artifact = compileRetainedDirectoryAuthority(await makeInput(db, lineage), { root });
      const beforeGeneration = (await first(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", target.staffId)).generation;
      await db.prepare(`CREATE TRIGGER retained_test_race BEFORE UPDATE ON native_directory_grants
        WHEN OLD.id='10000000-0000-4000-8000-000000000002' BEGIN SELECT RAISE(ABORT,'retained test race'); END`).run();
      await assert.rejects(applyRetainedDirectoryAuthority(db, artifact, { target: STAGING_TARGET }), /retained test race/);
      assert.equal(await first(db, "SELECT command_id FROM native_staff_bootstrap_receipts WHERE command_id=?", artifact.receipt.command_id), null);
      assert.equal(await first(db, "SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.approval.approval_id), null);
      assert.deepEqual((await all(db, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [0, 0, 0]);
      assert.equal((await first(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", target.staffId)).generation, beforeGeneration);
      await db.prepare("DROP TRIGGER retained_test_race").run();
    });

    await t.test("rejects an unrelated business-area reference table before mutation", async () => {
      const artifact = compileRetainedDirectoryAuthority(await makeInput(db, lineage, "reactivate", 2), { root });
      await db.prepare("CREATE TABLE unrelated_area_reference(id TEXT PRIMARY KEY,business_area_id TEXT)").run();
      await assert.rejects(applyRetainedDirectoryAuthority(db, artifact, { target: STAGING_TARGET }), /reference schema changed/);
      assert.equal(await first(db, "SELECT command_id FROM native_staff_bootstrap_receipts WHERE command_id=?", artifact.receipt.command_id), null);
      await db.prepare("DROP TABLE unrelated_area_reference").run();
    });

    await t.test("rejects tampered historical-receipt SQL before any authority mutation", async () => {
      const value = await makeInput(db, lineage, "reactivate", 3);
      const artifact = compileRetainedDirectoryAuthority(value, { root });
      const expected = json([value.lineage.revokeReceipt]);
      const forged = json([{ ...value.lineage.revokeReceipt, result_sha256: "f".repeat(64) }]);
      const receiptGuard = artifact.statements.find(statement => statement.sql.includes("FROM native_staff_bootstrap_receipts")
        && statement.params.includes(value.lineage.revokeReceipt.command_id));
      assert.ok(receiptGuard?.params.includes(expected), "the exact receipt guard parameter must be changed");
      receiptGuard.params = receiptGuard.params.map(param => param === expected ? forged : param);
      await assert.rejects(applyRetainedDirectoryAuthority(db, artifact, { target: STAGING_TARGET }), /compiled artifact changed/);
      assert.equal(await first(db, "SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.approval.approval_id), null);
    });

    await t.test("rejects an active targeted deny atomically", async () => {
      await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('retained-deny',?,'directory.profile.view','deny','global',1,?)`).bind(target.staffId, target.staffId).run();
      const artifact = compileRetainedDirectoryAuthority(await makeInput(db, lineage, "reactivate", 8), { root });
      await assert.rejects(applyRetainedDirectoryAuthority(db, artifact, { target: STAGING_TARGET }));
      assert.equal(await first(db, "SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.approval.approval_id), null);
      await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='retained-deny' AND active=1").run();
    });

    await t.test("reactivates the exact retained grants and paired revoke remains valid after activation approval expiry", async () => {
      const activationInput = await makeInput(db, lineage, "reactivate", 6);
      activationInput.approval.expiresAt = new Date(Date.now() + 20_000).toISOString();
      const activation = compileRetainedDirectoryAuthority(activationInput, { root });
      for (const [index, statement] of activation.statements.entries()) {
        if (!/^\s*SELECT\b/i.test(statement.sql)) break;
        try { await db.prepare(statement.sql).bind(...statement.params).first(); }
        catch (error) { throw new Error(`readonly activation preflight statement ${index} failed`, { cause: error }); }
      }
      await applyRetainedDirectoryAuthority(db, activation, { target: STAGING_TARGET });
      assert.deepEqual((await all(db, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [1, 1, 1]);
      await recoverAndAcknowledgeRetainedCreate(db);
      const untilExpired = Math.max(0, Date.parse(activationInput.approval.expiresAt) - Date.now() + 25);
      assert.ok(untilExpired <= 20_025, "expiry wait must remain bounded");
      await new Promise(resolve => setTimeout(resolve, untilExpired));
      lineage.reactivation = activation;
      const revoke = compileRetainedDirectoryAuthority(await makeInput(db, lineage, "revoke", 7), { root });
      await applyRetainedDirectoryAuthority(db, revoke, { target: STAGING_TARGET });
      assert.deepEqual((await all(db, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [0, 0, 0]);
      assert.equal((await first(db, "SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?", activation.approval.approval_id)).revoked_at, revoke.input.approval.executedAt);
      assert.deepEqual(await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", revoke.receipt.command_id), revoke.receipt);
    });

  } finally { await mf.dispose(); }
});

test("a canonical extra pending Directory command rejects reactivation in an isolated 181-schema fixture", async () => {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: `retained-unsettled-${crypto.randomUUID()}` } });
  try {
    const db = await mf.getD1Database("DB");
    await migrate(db);
    const lineage = await seed(db);
    await createCanonicalPendingDirectoryWork(db);
    const artifact = compileRetainedDirectoryAuthority(await makeInput(db, lineage, "reactivate", 9), { root });
    await assert.rejects(applyRetainedDirectoryAuthority(db, artifact, { target: STAGING_TARGET }));
    assert.equal(await first(db, "SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.approval.approval_id), null);
  } finally { await mf.dispose(); }
}, 120_000);

test("node:sqlite executes canonical 181 authority batches atomically when workerd is unavailable", async () => {
  const db = nodeSqliteD1();
  try {
    await migrate(db);
    const lineage = await seed(db);
    const unrelatedIds = await seedUnrelatedGrantHistory(db);
    const unrelatedBefore = await all(db, `SELECT * FROM native_directory_grants WHERE id IN (?,?) ORDER BY id`, ...unrelatedIds);
    const unrelatedHistoryBefore = await all(db, `SELECT * FROM native_directory_grant_history WHERE grant_id IN (?,?) ORDER BY grant_id,grant_version`, ...unrelatedIds);
    assert.equal(unrelatedHistoryBefore.length, 4);
    assert.equal((await first(db, "SELECT count(*) count FROM native_directory_grant_history WHERE business_area_id=?", target.areaId)).count, 6);
    const activation = compileRetainedDirectoryAuthority(await makeInput(db, lineage, "reactivate", 20), { root });
    await applyRetainedDirectoryAuthority(db, activation, { target: STAGING_TARGET });
    assert.deepEqual((await all(db, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [1, 1, 1]);
    const receiptCount = (await first(db, "SELECT count(*) count FROM native_staff_bootstrap_receipts WHERE command_id=?", activation.receipt.command_id)).count;
    assert.equal(receiptCount, 1);

    await recoverAndAcknowledgeRetainedCreate(db);
    lineage.reactivation = activation;
    const initialClose = compileRetainedDirectoryAuthority(await makeInput(db, lineage, "revoke", 21), { root });
    await applyRetainedDirectoryAuthority(db, initialClose, { target: STAGING_TARGET });
    assert.deepEqual((await all(db, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [0, 0, 0]);
    assert.equal((await first(db, "SELECT count(*) count FROM native_directory_grant_history WHERE business_area_id=?", target.areaId)).count, 12);

    const reopened = compileRetainedDirectoryAuthority(await makeSchema2Input(db, initialClose, "reactivate", 22), { root });
    await applyRetainedDirectoryAuthority(db, reopened, { target: STAGING_TARGET });
    assert.deepEqual((await all(db, "SELECT grant_version,active FROM native_directory_grant_history WHERE grant_id=? ORDER BY grant_version", grantIds[0])),
      [{ grant_version: 1, active: 1 }, { grant_version: 2, active: 0 }, { grant_version: 3, active: 1 },
        { grant_version: 4, active: 0 }, { grant_version: 5, active: 1 }]);
    assert.equal((await first(db, "SELECT count(*) count FROM native_directory_grant_history WHERE business_area_id=?", target.areaId)).count, 15);

    const repeatedClose = compileRetainedDirectoryAuthority(await makeSchema2Input(db, initialClose, "revoke", 23, reopened), { root });
    await applyRetainedDirectoryAuthority(db, repeatedClose, { target: STAGING_TARGET });
    assert.deepEqual((await all(db, "SELECT grant_version,active FROM native_directory_grant_history WHERE grant_id=? ORDER BY grant_version", grantIds[0])),
      [{ grant_version: 1, active: 1 }, { grant_version: 2, active: 0 }, { grant_version: 3, active: 1 },
        { grant_version: 4, active: 0 }, { grant_version: 5, active: 1 }, { grant_version: 6, active: 0 }]);
    assert.equal((await first(db, "SELECT count(*) count FROM native_directory_grant_history WHERE business_area_id=?", target.areaId)).count, 18);
    assert.equal((await first(db, "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?", target.staffId)).generation,
      repeatedClose.input.generation.generation + 3);
    assert.equal((await first(db, "SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?", lineage.provision.approval.approval_id)).revoked_at,
      lineage.revoke.receipt.executed_at);
    assert.equal((await first(db, "SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?", activation.approval.approval_id)).revoked_at,
      initialClose.input.approval.executedAt);
    assert.equal((await first(db, "SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?", reopened.approval.approval_id)).revoked_at,
      repeatedClose.input.approval.executedAt);
    for (const artifact of [lineage.provision, lineage.revoke, activation, initialClose, reopened, repeatedClose]) {
      assert.deepEqual(await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", artifact.receipt.command_id), artifact.receipt);
    }
    assert.deepEqual(await all(db, `SELECT * FROM native_directory_grants WHERE id IN (?,?) ORDER BY id`, ...unrelatedIds), unrelatedBefore);
    assert.deepEqual(await all(db, `SELECT * FROM native_directory_grant_history WHERE grant_id IN (?,?) ORDER BY grant_id,grant_version`, ...unrelatedIds), unrelatedHistoryBefore);

    const nextOpen = compileRetainedDirectoryAuthority(await makeSchema2Input(db, repeatedClose, "reactivate", 24), { root });
    await applyRetainedDirectoryAuthority(db, nextOpen, { target: STAGING_TARGET });
    const racedClose = compileRetainedDirectoryAuthority(await makeSchema2Input(db, repeatedClose, "revoke", 25, nextOpen), { root });
    await db.prepare("UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL")
      .bind(new Date(Date.now()).toISOString(), nextOpen.approval.approval_id).run();
    await assert.rejects(applyRetainedDirectoryAuthority(db, racedClose, { target: STAGING_TARGET }));
    assert.equal(await first(db, "SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?", racedClose.approval.approval_id), null);
    assert.equal(await first(db, "SELECT command_id FROM native_staff_bootstrap_receipts WHERE command_id=?", racedClose.receipt.command_id), null);
    assert.deepEqual((await all(db, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [1, 1, 1]);
  } finally { db.close(); }

  const racedDb = nodeSqliteD1();
  try {
    await migrate(racedDb);
    const lineage = await seed(racedDb);
    const raced = compileRetainedDirectoryAuthority(await makeInput(racedDb, lineage, "reactivate", 21), { root });
    await racedDb.prepare(`CREATE TRIGGER retained_node_sqlite_race BEFORE UPDATE ON native_directory_grants
      WHEN OLD.id='10000000-0000-4000-8000-000000000002' BEGIN SELECT RAISE(ABORT,'retained node sqlite race'); END`).run();
    await assert.rejects(applyRetainedDirectoryAuthority(racedDb, raced, { target: STAGING_TARGET }), /retained node sqlite race/);
    assert.equal(await first(racedDb, "SELECT command_id FROM native_staff_bootstrap_receipts WHERE command_id=?", raced.receipt.command_id), null);
    assert.equal(await first(racedDb, "SELECT approval_id FROM native_staff_bootstrap_approvals WHERE approval_id=?", raced.approval.approval_id), null);
    assert.deepEqual((await all(racedDb, "SELECT active FROM native_directory_grants WHERE id IN (?,?,?) ORDER BY id", ...grantIds)).map(row => row.active), [0, 0, 0]);
  } finally { racedDb.close(); }
}, 120_000);
