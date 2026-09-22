import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { activateProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";

const sourceId = "project-alpha:primary";
const sourceInstanceId = "10000000-0000-4000-8000-000000000001";
const applicationId = "10000000-0000-4000-8000-000000000002";
const historyEpochId = "10000000-0000-4000-8000-000000000003";
const reviewItemId = "20000000-0000-4000-8000-000000000001";
const commandId = "20000000-0000-4000-8000-000000000002";
const acquiredReceiptId = "20000000-0000-4000-8000-000000000003";
const claimId = "20000000-0000-4000-8000-000000000004";
const nativeEpochId = "20000000-0000-4000-8000-000000000005";
const recordId = "30000000-0000-4000-8000-000000000001";
const idempotencyKey = "40000000-0000-4000-8000-000000000001";
const changedIdempotencyKey = "40000000-0000-4000-8000-000000000002";
const reviewer = { staffId: "staff", accessSubject: "access|staff" };
const publicId = "a".repeat(32);
const requestHash = "1".repeat(64);
const bindingHash = "2".repeat(64);
const responseHash = "3".repeat(64);
const profileHash = "4".repeat(64);
const reviewedHash = "5".repeat(64);

const connection = (overrides: Record<string, unknown> = {}) => JSON.stringify({ version: 1, instances: {
  [sourceId]: { sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "test-secret",
    sourceInstanceId, applicationId, historyEpoch: historyEpochId, ...overrides },
} });

describe("private existing Directory binding activation consumer", () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    await db.batch(splitD1MigrationStatements(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
      CREATE TABLE project_alpha_directory_outbox(command_id TEXT PRIMARY KEY);
      CREATE TABLE project_alpha_directory_mappings(
        source_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,
        source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,command_id TEXT UNIQUE,created_at TEXT DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY(source_id,source_instance_id,application_id,resource_type,external_id),
        UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id));
      CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,
        admitted_by TEXT,version INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions
        WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.bound_access_subject IS NOT OLD.bound_access_subject
        OR NEW.admitted_by IS NOT OLD.admitted_by OR NEW.version<>OLD.version+1
        BEGIN SELECT RAISE(ABORT,'native staff admission identity is immutable'); END;
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
      CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,
        business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER,granted_by TEXT,created_at TEXT);
      CREATE TRIGGER native_directory_grants_identity BEFORE UPDATE ON native_directory_grants
        WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.permission IS NOT OLD.permission
          OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind
          OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
          OR NEW.resource_id IS NOT OLD.resource_id OR NEW.granted_by IS NOT OLD.granted_by
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT,'native directory grant identity is immutable'); END;
      CREATE TABLE native_directory_resource_scopes(record_id TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,active INTEGER);
      CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
      CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT);
      CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT,payload BLOB);
      INSERT INTO native_staff_admissions VALUES('staff','access|staff',1,'owner',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO native_staff_profiles VALUES('staff',1);
      INSERT INTO native_directory_grants VALUES('identity-link','staff','directory.identity.link','allow','global',NULL,NULL,NULL,1,'owner','2026-09-01T00:00:00.000Z');
      INSERT INTO staff_role_assignments VALUES('owner-role','staff','role-owner','global');
      INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/s/keep',x'00ff80');
    `).map(sql => db.prepare(sql)));
    for (const migration of ["0111_project_alpha_existing_directory_binding_review_evidence.sql",
      "0112_project_alpha_existing_directory_binding_acquisition_ledger.sql",
      "0113_project_alpha_existing_directory_binding_acquired_mapping_receipts.sql",
      "0114_project_alpha_existing_directory_binding_acquisition_response_receipts.sql",
      "0115_project_alpha_existing_directory_binding_review_local_revision_fence.sql",
      "0116_project_alpha_acquired_canonical_mapping_activation.sql",
      "0117_project_alpha_native_owner_epoch_claims.sql",
      "0123_native_directory_authority_history.sql",
      "0125_project_alpha_existing_directory_binding_activation.sql",
      "0127_project_alpha_existing_directory_binding_activation_evidence_transition.sql",
      "0129_project_alpha_existing_directory_binding_activation_relationship.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
  });

  afterEach(async () => { await runtime.dispose(); });

  async function seed(options: { reviewedAt?: string; bindingHash?: string; acquiredBindingHash?: string; kind?: "organization" | "client";
    relationship?: "unlinked" | "missing" } = {}) {
    const kind = options.kind ?? "organization";
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,?,1)").bind(recordId, kind).run();
    if (kind === "client" && options.relationship !== "missing") {
      await db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,NULL)").bind(recordId).run();
    }
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
      receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
      reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,'7','50000000-0000-4000-8000-000000000001',?,'staff','access|staff',1,1,
        COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')),1)`)
      .bind(reviewItemId,requestHash,recordId,sourceId,sourceInstanceId,applicationId,historyEpochId,kind,recordId,
        publicId,options.bindingHash ?? reviewedHash,options.reviewedAt ?? null).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
      command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,'7',?)`).bind(commandId,requestHash,recordId,sourceId,sourceInstanceId,
        applicationId,historyEpochId,kind,recordId,publicId,reviewItemId).run();
    for (const [version,state,transitionId] of [[1,"pending","60000000-0000-4000-8000-000000000001"],
      [2,"acknowledged","60000000-0000-4000-8000-000000000002"]] as const) {
      await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(
        command_id,state_version,transition_id,request_sha256,state,occurred_at)
        VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .bind(commandId,version,transitionId,requestHash,state).run();
    }
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
      command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
      project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256)
      VALUES(?,?,?,?,?,?,?,'7','https://pa.example.test','70000000-0000-4000-8000-000000000001',0,?)`)
      .bind(commandId,sourceInstanceId,applicationId,historyEpochId,kind,recordId,publicId,responseHash).run();
    await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
      receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,
      acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'7',?,?,?)`).bind(acquiredReceiptId,requestHash,commandId,recordId,sourceId,
        sourceInstanceId,applicationId,historyEpochId,kind,recordId,publicId,responseHash,profileHash,
        options.acquiredBindingHash ?? bindingHash).run();
    await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(
      receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(acquiredReceiptId,recordId,sourceId,sourceInstanceId,applicationId,
        historyEpochId,kind,recordId,publicId).run();
    await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(
      claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,
      history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,
      actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'staff',?)`).bind(claimId,acquiredReceiptId,
        nativeEpochId,recordId,sourceId,sourceInstanceId,applicationId,historyEpochId,kind,recordId,publicId,requestHash).run();
    await db.prepare("INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)")
      .bind(acquiredReceiptId).run();
  }

  function freshReads(options: { profileRevision?: string; bindingRevision?: string; bindingStatus?: number;
    invalidContract?: boolean; transport?: boolean; kind?: "organization" | "client"; parentPublicId?: string | null } = {}) {
    let ids = 10;
    const kind = options.kind ?? "organization", plural = kind === "client" ? "clients" : "organizations";
    return vi.fn<typeof fetch>(async request => {
      if (options.transport) throw new Error("transport");
      const path = new URL(String(request)).pathname;
      const requestId = `91000000-0000-4000-8000-${String(ids++).padStart(12,"0")}`;
      const response = (value: Record<string,unknown>,status=200) => new Response(status === 404 ? null : JSON.stringify({ ...value,requestId }), {
        status,headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
      });
      if (path === "/api/v2/capabilities") return response({ apiVersion: "2",sourceInstanceId,applicationId,
        historyEpoch: historyEpochId,grantedCapabilities: ["api.capabilities.read",`directory.${plural}.read`,
          `directory.${plural}.binding_status.read`].map(name => ({ name })),implementedEndpoints: [
          { method: "GET",path: "/api/v2/capabilities",requiredCapability: "api.capabilities.read" },
          { method: "GET",path: `/api/v2/directory/${plural}/{publicId}`,requiredCapability: `directory.${plural}.read`,requiresSourceInstanceId: true,requiresApplicationId: true,requiresHistoryEpoch: true },
          { method: "GET",path: `/api/v2/bindings/${kind}/status/{base64urlExternalId}`,requiredCapability: `directory.${plural}.binding_status.read`,requiresSourceInstanceId: true,requiresApplicationId: true,requiresHistoryEpoch: true },
        ] });
      if (path.startsWith("/api/v2/directory/")) return response({ apiVersion: "2",sourceInstanceId,applicationId,
        historyEpoch: historyEpochId,authorizationGeneration: "8",resource: { type: kind,id: publicId,revision: options.profileRevision ?? "7" },
        data: { publicId,name: "Current Customer",email: null,phone: null,address: { line1: null,line2: null,city: null,state: null,postalCode: null,country: null },
          ...(kind === "client" ? { clientType: "business",organizationPublicId: options.parentPublicId ?? null } : {}) },
        ...(options.invalidContract ? { unexpected: true } : {}) });
      if (options.bindingStatus === 404 || options.bindingStatus === 409) return response({},options.bindingStatus);
      return response({ apiVersion: "2",sourceInstanceId,applicationId,historyEpoch: historyEpochId,
        authorizationGeneration: "8",binding: { type: kind,externalId: recordId,publicId,createdAt: "2026-09-22T12:00:00.000Z" },
        resource: { revision: options.bindingRevision ?? "7",present: true },
        ...(options.invalidContract ? { unexpected: true } : {}) });
    });
  }

  const call = (key = idempotencyKey, raw: unknown = { reviewItemId, idempotencyKey: key }, rawConnection = connection(),
    actor: unknown = reviewer, send: typeof fetch = freshReads()) =>
    activateProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: rawConnection }, raw, actor, send);

  const directActivation = (hashes: { acquisition?: string; profile?: string; binding?: string } = {}) =>
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
      activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,
      record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
      project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,
      acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,
      activated_by_staff_id,directory_grant_generation)
      VALUES('90000000-0000-4000-8000-000000000001',?,?,?,?,?,?,?,?,?,?,?,?, '7',1,?,?,?,?, 'staff',1)`)
      .bind(reviewItemId,idempotencyKey,acquiredReceiptId,claimId,recordId,sourceId,sourceInstanceId,
        applicationId,historyEpochId,"organization",recordId,publicId,requestHash,
        hashes.acquisition ?? responseHash,hashes.profile ?? profileHash,hashes.binding ?? bindingHash).run();

  it("activates once, replays exactly, and preserves dormant, legacy, and public-link rows", async () => {
    await seed();
    const before = await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_shares WHERE id='share'").first();
    const first = await call();
    expect(first).toMatchObject({ status: "activated", reviewItemId, recordId, resourceType: "organization", replayed: false });
    await expect(call()).resolves.toEqual({ ...first, replayed: true });
    expect(await db.prepare("SELECT state FROM project_alpha_acquired_mapping_activation WHERE receipt_id=?")
      .bind(acquiredReceiptId).first("state")).toBe("inactive");
    expect(await db.prepare("SELECT activation_state FROM project_alpha_acquired_canonical_mappings WHERE receipt_id=?")
      .bind(acquiredReceiptId).first("activation_state")).toBe("inactive");
    expect(await db.prepare("SELECT mapping_kind,external_id FROM project_alpha_active_directory_mappings WHERE external_id=?")
      .bind(recordId).first()).toEqual({ mapping_kind: "acquired", external_id: recordId });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_directory_mappings").first("count")).toBe(0);
    expect(await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_shares WHERE id='share'").first()).toEqual(before);
  });

  it("rejects changed idempotency and cross-review key reuse without adding a receipt", async () => {
    await seed(); await call();
    await expect(call(changedIdempotencyKey)).resolves.toEqual({ status: "conflict", reason: "review_item" });
    await expect(call(idempotencyKey,{ reviewItemId: "20000000-0000-4000-8000-000000000099", idempotencyKey }))
      .resolves.toEqual({ status: "conflict", reason: "idempotency_key" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts")
      .first("count")).toBe(1);
  });

  it("keeps the 0117 reciprocal fence against a later legacy mapping collision", async () => {
    await seed();
    await expect(db.prepare(`INSERT INTO project_alpha_directory_mappings(
      source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,?,?,?,?,?,?,'late-legacy')`).bind(sourceId,"organization",recordId,publicId,
        sourceInstanceId,applicationId,historyEpochId).run()).rejects.toThrow(/acquired reservation/);
    await expect(call()).resolves.toMatchObject({ status: "activated", replayed: false });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE external_id=?")
      .bind(recordId).first("count")).toBe(1);
  });

  it("blocks expired and stale review evidence with no partial activation", async () => {
    await seed({ reviewedAt: "2026-01-01T00:00:00.000Z" });
    await expect(call()).resolves.toEqual({ status: "blocked", reason: "expired" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts")
      .first("count")).toBe(0);
  });

  it("blocks revoked native authority at the atomic boundary", async () => {
    await seed();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='identity-link'").run();
    await expect(call()).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts")
      .first("count")).toBe(0);
  });

  it("blocks a changed local revision and a changed deployment identity", async () => {
    await seed();
    await db.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?").bind(recordId).run();
    await expect(call()).resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    await db.prepare("UPDATE operations_directory_records SET current_version=1 WHERE record_id=?").bind(recordId).run();
    await expect(call(idempotencyKey,{ reviewItemId, idempotencyKey },connection({ historyEpoch: "90000000-0000-4000-8000-000000000009" })))
      .resolves.toEqual({ status: "blocked", reason: "source" });
  });

  it("blocks reused evidence roles", async () => {
    await seed({ acquiredBindingHash: reviewedHash });
    await expect(call()).resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts")
      .first("count")).toBe(0);
  });

  it("rejects swapped and unrelated activation evidence while accepting the exact distinct transition", async () => {
    await seed();
    await expect(directActivation({ profile: bindingHash, binding: profileHash })).rejects.toThrow(/current exact authority and evidence/);
    await expect(directActivation({ acquisition: "9".repeat(64) })).rejects.toThrow(/current exact authority and evidence/);
    await expect(directActivation()).resolves.toBeDefined();
  });

  it("accepts a standalone client only when both PA and native state have no parent", async () => {
    await seed({ kind: "client", relationship: "missing" });
    await expect(call(idempotencyKey,{ reviewItemId,idempotencyKey },connection(),reviewer,
      freshReads({ kind: "client",parentPublicId: null }))).resolves.toMatchObject({ status: "activated" });
  });

  it("blocks a standalone PA client when native state has an unexpected current parent", async () => {
    const parentRecord = "30000000-0000-4000-8000-000000000099", parentPublic = "b".repeat(32);
    await seed({ kind: "client", relationship: "missing" });
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(parentRecord),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(recordId,parentRecord),
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
        source_instance_id,application_id,history_epoch_id,command_id,created_at)
        VALUES(?,'organization',?,?,?,?,?,'parent-command','2026-09-22T00:00:00.000Z')`)
        .bind(sourceId,parentRecord,parentPublic,sourceInstanceId,applicationId,historyEpochId),
    ]);
    await expect(call(idempotencyKey,{ reviewItemId,idempotencyKey },connection(),reviewer,
      freshReads({ kind: "client",parentPublicId: null }))).resolves.toEqual({ status: "blocked",reason: "relationship" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts")
      .first("count")).toBe(0);
  });

  it("rejects malformed or expanded caller input before touching D1", async () => {
    await expect(call(idempotencyKey,{ reviewItemId, idempotencyKey, sourceId })).resolves.toEqual({ status: "rejected", reason: "invalid_action" });
    await expect(call(idempotencyKey,{ reviewItemId: "bad", idempotencyKey })).resolves.toEqual({ status: "rejected", reason: "invalid_action" });
    let accessed = false;
    const accessor = Object.create(Object.prototype, {
      reviewItemId: { enumerable: true, get() { accessed = true; return reviewItemId; } },
      idempotencyKey: { enumerable: true, value: idempotencyKey },
    });
    await expect(call(idempotencyKey,accessor)).resolves.toEqual({ status: "rejected", reason: "invalid_action" });
    expect(accessed).toBe(false);
  });

  it("requires the authenticated server actor to match the immutable reviewer identity", async () => {
    await seed();
    const send = freshReads();
    await expect(call(idempotencyKey,{ reviewItemId,idempotencyKey },connection(),
      { staffId: "other",accessSubject: "access|staff" },send)).resolves.toEqual({ status: "blocked",reason: "actor" });
    await expect(call(idempotencyKey,{ reviewItemId,idempotencyKey },connection(),
      { staffId: "staff",accessSubject: "access|other" },send)).resolves.toEqual({ status: "blocked",reason: "actor" });
    await expect(call(idempotencyKey,{ reviewItemId,idempotencyKey },connection(),
      { staffId: "staff",accessSubject: "access|staff",credential: "forbidden" },send))
      .resolves.toEqual({ status: "rejected",reason: "invalid_actor" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["profile revision",{ profileRevision: "8" },"blocked"],
    ["binding revision",{ bindingRevision: "8" },"blocked"],
    ["unbound",{ bindingStatus: 404 },"blocked"],
    ["retarget conflict",{ bindingStatus: 409 },"blocked"],
    ["invalid contract",{ invalidContract: true },"uncertain"],
    ["transport",{ transport: true },"uncertain"],
  ] as const)("requires a fresh exact PA binding and fails closed for %s", async (_label,options,status) => {
    await seed();
    await expect(call(idempotencyKey,{ reviewItemId,idempotencyKey },connection(),reviewer,freshReads(options)))
      .resolves.toMatchObject({ status,reason: "remote" });
    expect(await db.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_activation_receipts")
      .first("count(*)")).toBe(0);
  });
});
