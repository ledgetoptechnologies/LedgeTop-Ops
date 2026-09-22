import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";

const sourceId = "project-alpha:primary", source = "10000000-0000-4000-8000-000000000001";
const application = "10000000-0000-4000-8000-000000000002", epoch = "10000000-0000-4000-8000-000000000003";
const recordId = "30000000-0000-4000-8000-000000000001", publicId = "a".repeat(32);
const input = (overrides: Record<string, unknown> = {}) => ({ reviewId: "20000000-0000-4000-8000-000000000001",
  commandId: "20000000-0000-4000-8000-000000000002", sourceId, recordId, resourceType: "organization" as const,
  projectAlphaPublicId: publicId, localRecordVersion: 1, reviewer: { staffId: "staff", accessSubject: "access|staff",
    admissionVersion: 1, profileVersion: 1, grantGeneration: 1 }, ...overrides });
const envSecret = () => JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true,
  baseUrl: "https://pa.example.test", apiKey: "server-secret", sourceInstanceId: source, applicationId: application,
  historyEpoch: epoch } } });
const secondary = { sourceId: "project-alpha:secondary", source: "11000000-0000-4000-8000-000000000001",
  application: "11000000-0000-4000-8000-000000000002", epoch: "11000000-0000-4000-8000-000000000003" };
const twoSourceSecret = () => JSON.stringify({ version: 1, instances: {
  [sourceId]: { sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "primary-secret",
    sourceInstanceId: source, applicationId: application, historyEpoch: epoch },
  [secondary.sourceId]: { sourceId: secondary.sourceId, enabled: true, baseUrl: "https://pa-secondary.example.test",
    apiKey: "secondary-secret", sourceInstanceId: secondary.source, applicationId: secondary.application,
    historyEpoch: secondary.epoch },
} });

describe("private existing Directory acquisition coordinator", () => {
  let runtime: Miniflare, db: D1Database;
  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    await db.batch(splitD1MigrationStatements(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
      CREATE TABLE project_alpha_directory_outbox(command_id TEXT PRIMARY KEY);
      CREATE TABLE project_alpha_directory_mappings(source_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,
        source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,command_id TEXT UNIQUE,created_at TEXT,
        PRIMARY KEY(source_id,source_instance_id,application_id,resource_type,external_id),
        UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id));
      CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,admitted_by TEXT,version INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
      CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER,granted_by TEXT,created_at TEXT);
      CREATE TRIGGER native_directory_grants_identity BEFORE UPDATE ON native_directory_grants
        WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.permission IS NOT OLD.permission OR NEW.effect IS NOT OLD.effect
          OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
          OR NEW.resource_id IS NOT OLD.resource_id OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE native_directory_resource_scopes(record_id TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,active INTEGER);
      CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
      CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT);
      INSERT INTO operations_directory_records VALUES('${recordId}','organization',1);
      INSERT INTO native_staff_admissions VALUES('staff','access|staff',1,'owner',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO native_staff_profiles VALUES('staff',1);
      INSERT INTO native_directory_grants VALUES('identity-link','staff','directory.identity.link','allow','global',NULL,NULL,NULL,1,'owner','2026-09-01T00:00:00.000Z');
      INSERT INTO staff_role_assignments VALUES('owner-role','staff','role-owner','global');
    `).map(sql => db.prepare(sql)));
    for (const migration of ["0111_project_alpha_existing_directory_binding_review_evidence.sql",
      "0112_project_alpha_existing_directory_binding_acquisition_ledger.sql",
      "0113_project_alpha_existing_directory_binding_acquired_mapping_receipts.sql",
      "0114_project_alpha_existing_directory_binding_acquisition_response_receipts.sql",
      "0115_project_alpha_existing_directory_binding_review_local_revision_fence.sql",
      "0116_project_alpha_acquired_canonical_mapping_activation.sql", "0117_project_alpha_native_owner_epoch_claims.sql",
      "0123_native_directory_authority_history.sql", "0125_project_alpha_existing_directory_binding_activation.sql"]) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"))
        .map(sql => db.prepare(sql)));
    }
  });
  afterEach(async () => { await runtime.dispose(); });

  function transport(options: { firstPostUncertain?: boolean; alwaysUncertain?: boolean; conflict?: boolean;
    foreignPost?: boolean; changedProfile?: boolean; kind?: "organization" | "client"; record?: string;
    public?: string; parentPublicId?: string | null; sourceInstance?: string; app?: string; epochId?: string } = {}) {
    let profileReads = 0, postCalls = 0, ids = 10;
    const kind = options.kind ?? "organization", plural = kind === "client" ? "clients" : "organizations";
    const expectedRecord = options.record ?? recordId, expectedPublic = options.public ?? publicId;
    const expectedSource = options.sourceInstance ?? source, expectedApplication = options.app ?? application;
    const expectedEpoch = options.epochId ?? epoch;
    const requestId = () => `10000000-0000-4000-8000-${String(ids++).padStart(12, "0")}`;
    return vi.fn<typeof fetch>(async (request, init) => {
      const path = new URL(String(request)).pathname, id = requestId();
      const json = (value: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ ...value, requestId: id }), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": id },
      });
      if (path === "/api/v2/capabilities") return json({ apiVersion: "2", sourceInstanceId: expectedSource, applicationId: expectedApplication,
        historyEpoch: expectedEpoch, grantedCapabilities: ["api.capabilities.read", `directory.${plural}.read`,
          `directory.${plural}.binding_status.read`, `directory.${plural}.bind`].map(name => ({ name })),
        implementedEndpoints: [
          { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
          { method: "GET", path: `/api/v2/directory/${plural}/{publicId}`, requiredCapability: `directory.${plural}.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
          { method: "GET", path: `/api/v2/bindings/${kind}/status/{base64urlExternalId}`, requiredCapability: `directory.${plural}.binding_status.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
          { method: "POST", path: `/api/v2/directory/${plural}/bindings/commands`, requiredCapability: `directory.${plural}.bind`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true, requiresExpectedPublicId: true, requiresExpectedRevision: true },
        ] });
      if (path === `/api/v2/directory/${plural}/${expectedPublic}`) {
        profileReads++;
        const data = { publicId: expectedPublic, name: options.changedProfile && profileReads > 1 ? "Changed" : "Reviewed Customer", email: null,
          phone: null, address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
          ...(kind === "client" ? { clientType: "business", organizationPublicId: options.parentPublicId ?? null } : {}) };
        return json({ apiVersion: "2", sourceInstanceId: expectedSource, applicationId: expectedApplication, historyEpoch: expectedEpoch,
          authorizationGeneration: profileReads === 1 ? "4" : "5", resource: { type: kind, id: expectedPublic, revision: "7" }, data });
      }
      if (path.startsWith(`/api/v2/bindings/${kind}/status/`)) return json({ apiVersion: "2", sourceInstanceId: expectedSource,
        applicationId: expectedApplication, historyEpoch: expectedEpoch, authorizationGeneration: "5", binding: { type: kind,
          externalId: expectedRecord, publicId: expectedPublic, createdAt: "2026-09-22T12:00:00.000Z" }, resource: { revision: "7", present: true } });
      postCalls++;
      if (options.alwaysUncertain || (options.firstPostUncertain && postCalls === 1)) throw new Error("network uncertain");
      if (options.conflict) return json({ code: "COMMAND_CONFLICT" }, 409);
      const sent = JSON.parse(String(init?.body));
      return json({ replayed: postCalls > 1, result: { binding: { publicId: expectedPublic }, resource: { type: kind,
        id: sent.externalId, revision: "7" } }, sourceInstanceId: expectedSource,
        applicationId: options.foreignPost ? "90000000-0000-4000-8000-000000000001" : expectedApplication, historyEpoch: expectedEpoch });
    });
  }

  it("materializes exactly one inactive 0111-0117 chain and replays without another POST", async () => {
    const send = transport(), env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    const first = await acquireProjectAlphaExistingDirectoryBinding(env, input(), send);
    expect(first).toMatchObject({ status: "acquired", replayed: false });
    expect(await db.prepare("SELECT activation_state,native_owner_epoch_id FROM project_alpha_acquired_canonical_mappings").first())
      .toEqual({ activation_state: "inactive", native_owner_epoch_id: null });
    expect(await db.prepare("SELECT state FROM project_alpha_acquired_mapping_activation").first("state")).toBe("inactive");
    const posts = send.mock.calls.filter(call => call[1]?.method === "POST").length;
    expect(await acquireProjectAlphaExistingDirectoryBinding(env, input(), send)).toMatchObject({ status: "acquired", replayed: true });
    expect(send.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(posts);
  });

  it("persists uncertainty then retries the exact reserved command", async () => {
    const send = transport({ firstPostUncertain: true }), env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    expect(await acquireProjectAlphaExistingDirectoryBinding(env, input(), send)).toMatchObject({ status: "uncertain" });
    expect(await db.prepare("SELECT group_concat(state,',') states FROM project_alpha_existing_directory_binding_acquisition_events").first("states")).toBe("pending,uncertain");
    expect(await db.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings").first("count(*)")).toBe(0);
    expect(await acquireProjectAlphaExistingDirectoryBinding(env, input(), send)).toMatchObject({ status: "acquired" });
    const bodies = send.mock.calls.filter(call => call[1]?.method === "POST").map(call => String(call[1]!.body));
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("keeps permanent repeated uncertainty inactive without duplicating transitions", async () => {
    const send = transport({ alwaysUncertain: true }), env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, input(), send)).resolves.toMatchObject({ status: "uncertain" });
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, input(), send)).resolves.toMatchObject({ status: "uncertain" });
    expect(await db.prepare("SELECT group_concat(state,',') states FROM project_alpha_existing_directory_binding_acquisition_events").first("states")).toBe("pending,uncertain");
    expect(await db.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings").first("count(*)")).toBe(0);
  });

  it("records a valid PA conflict as non-authoritative and creates no mapping", async () => {
    const result = await acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), transport({ conflict: true }));
    expect(result).toEqual({ status: "conflict", reason: "remote" });
    expect(await db.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings").first("count(*)")).toBe(0);
  });

  it("acquires the same native customer independently in two deployment-owned PA sources", async () => {
    const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: twoSourceSecret() };
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, input(), transport())).resolves.toMatchObject({ status: "acquired" });
    const second = input({ reviewId: "21000000-0000-4000-8000-000000000001",
      commandId: "21000000-0000-4000-8000-000000000002", sourceId: secondary.sourceId });
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, second,
      transport({ sourceInstance: secondary.source, app: secondary.application, epochId: secondary.epoch })))
      .resolves.toMatchObject({ status: "acquired" });
    expect(await db.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings WHERE record_id=?")
      .bind(recordId).first("count(*)")).toBe(2);
  });

  it("requires the client's exact current parent mapping in the same PA namespace", async () => {
    const clientRecord = "31000000-0000-4000-8000-000000000001", clientPublic = "c".repeat(32);
    const parentRecord = "32000000-0000-4000-8000-000000000001", parentPublic = "b".repeat(32);
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(clientRecord),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(parentRecord),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(clientRecord,parentRecord),
    ]);
    const selected = input({ reviewId: "22000000-0000-4000-8000-000000000001",
      commandId: "22000000-0000-4000-8000-000000000002", recordId: clientRecord,
      resourceType: "client", projectAlphaPublicId: clientPublic });
    const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    const firstSend = transport({ kind: "client", record: clientRecord, public: clientPublic, parentPublicId: parentPublic });
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, selected, firstSend))
      .resolves.toEqual({ status: "blocked", reason: "relationship" });
    expect(firstSend.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id,created_at)
      VALUES(?,'organization',?,?,?,?,?,?,'2026-09-22T00:00:00.000Z')`)
      .bind(sourceId,parentRecord,parentPublic,source,application,epoch,"parent-legacy").run();
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, selected,
      transport({ kind: "client", record: clientRecord, public: clientPublic, parentPublicId: parentPublic })))
      .resolves.toMatchObject({ status: "acquired" });
  });

  it.each(["authority", "local", "identity", "digest"]) ("fails closed on %s drift without a partial mapping", async drift => {
    if (drift === "authority") await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='identity-link'").run();
    if (drift === "local") await db.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?").bind(recordId).run();
    const send = transport({ foreignPost: drift === "identity", changedProfile: drift === "digest" });
    const result = await acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), send);
    expect(result.status).not.toBe("acquired");
    expect(await db.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings").first("count(*)")).toBe(0);
    expect(await db.prepare("SELECT count(*) FROM project_alpha_acquired_native_owner_claims").first("count(*)")).toBe(0);
  });

  it("rejects caller-supplied authority fields and accessors", async () => {
    const send = transport(), env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    expect(await acquireProjectAlphaExistingDirectoryBinding(env, { ...input(), url: "https://evil.test" }, send))
      .toEqual({ status: "rejected", reason: "invalid_input" });
    const getter = { ...input() } as Record<string, unknown>;
    Object.defineProperty(getter, "recordId", { enumerable: true, get: () => recordId });
    expect(await acquireProjectAlphaExistingDirectoryBinding(env, getter, send)).toEqual({ status: "rejected", reason: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });
});
