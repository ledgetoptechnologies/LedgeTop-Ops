import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE, registerProjectAlphaPrivateAdminRoutes } from "../src/worker/project-alpha-private-admin-routes";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";

const sourceId = "project-alpha:primary", source = "10000000-0000-4000-8000-000000000001";
const application = "10000000-0000-4000-8000-000000000002", epoch = "10000000-0000-4000-8000-000000000003";
const recordId = "30000000-0000-4000-8000-000000000001", publicId = "a".repeat(32);
const input = (overrides: Record<string, unknown> = {}) => ({ reviewId: "20000000-0000-4000-8000-000000000001",
  commandId: "20000000-0000-4000-8000-000000000002", sourceId, recordId, externalId: recordId, resourceType: "organization" as const,
  projectAlphaPublicId: publicId, expectedProjectAlphaRevision: "7", expectedAuthorizationGeneration: "4",
  localRecordVersion: 1, reviewer: { staffId: "staff", accessSubject: "access|staff",
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
      CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT);
      INSERT INTO operations_directory_records VALUES('${recordId}','organization',1);
      INSERT INTO native_staff_admissions VALUES('staff','access|staff',1,'owner',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO native_staff_profiles VALUES('staff',1);
      INSERT INTO native_directory_grants VALUES('identity-link','staff','directory.identity.link','allow','global',NULL,NULL,NULL,1,'owner','2026-09-01T00:00:00.000Z');
      INSERT INTO staff_role_assignments VALUES('owner-role','staff','role-owner','global',NULL);
      INSERT INTO role_permissions VALUES('role-owner','integrations.manage');
    `).map(sql => db.prepare(sql)));
    for (const migration of ["0111_project_alpha_existing_directory_binding_review_evidence.sql",
      "0112_project_alpha_existing_directory_binding_acquisition_ledger.sql",
      "0113_project_alpha_existing_directory_binding_acquired_mapping_receipts.sql",
      "0114_project_alpha_existing_directory_binding_acquisition_response_receipts.sql",
      "0115_project_alpha_existing_directory_binding_review_local_revision_fence.sql",
      "0116_project_alpha_acquired_canonical_mapping_activation.sql", "0117_project_alpha_native_owner_epoch_claims.sql",
      "0123_native_directory_authority_history.sql", "0125_project_alpha_existing_directory_binding_activation.sql",
      "0169_project_alpha_existing_directory_binding_generation_evidence.sql"]) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"))
        .map(sql => db.prepare(sql)));
    }
    // Match the post-0170 consumer contract: Operations record IDs remain
    // separate from Project Alpha external IDs for acquired mappings.
    await db.batch([
      db.prepare("DROP VIEW project_alpha_active_directory_mappings"),
      db.prepare(`CREATE VIEW project_alpha_active_directory_mappings AS
        SELECT source_id,resource_type,external_id AS record_id,external_id,project_alpha_public_id,
          source_instance_id,application_id,history_epoch_id,command_id AS provenance_id,
          'legacy' AS mapping_kind,created_at FROM project_alpha_directory_mappings
        UNION ALL
        SELECT source_id,resource_type,record_id,external_id,project_alpha_public_id,source_instance_id,
          application_id,history_epoch_id,activation_id AS provenance_id,'acquired' AS mapping_kind,
          activated_at AS created_at FROM project_alpha_existing_directory_binding_activation_receipts`),
    ]);
  });
  afterEach(async () => { vi.unstubAllGlobals(); await runtime.dispose(); });

  function transport(options: { firstPostUncertain?: boolean; alwaysUncertain?: boolean; conflict?: boolean;
    foreignPost?: boolean; changedProfile?: boolean; kind?: "organization" | "client"; record?: string;
    public?: string; parentPublicId?: string | null; sourceInstance?: string; app?: string; epochId?: string } = {}) {
    let profileReads = 0, bound = false, postCalls = 0, ids = 10;
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
        applicationId: expectedApplication, historyEpoch: expectedEpoch, authorizationGeneration: bound ? "5" : "4", binding: { type: kind,
          externalId: expectedRecord, publicId: expectedPublic, createdAt: "2026-09-22T12:00:00.000Z" }, resource: { revision: "7", present: true } });
      postCalls++;
      if (options.alwaysUncertain || (options.firstPostUncertain && postCalls === 1)) throw new Error("network uncertain");
      if (options.conflict) return json({ code: "COMMAND_CONFLICT" }, 409);
      const sent = JSON.parse(String(init?.body));
      bound = true;
      return json({ replayed: postCalls > 1, result: { binding: { publicId: expectedPublic }, resource: { type: kind,
        id: sent.externalId, revision: "7" }, authorizationGeneration: "5" }, sourceInstanceId: expectedSource,
        applicationId: options.foreignPost ? "90000000-0000-4000-8000-000000000001" : expectedApplication, historyEpoch: expectedEpoch });
    });
  }

  it("materializes exactly one inactive 0111-0117 chain and replays without another POST", async () => {
    const send = transport(), env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    const first = await acquireProjectAlphaExistingDirectoryBinding(env, input(), send);
    expect(first).toMatchObject({ status: "acquired", replayed: false });
    const posted = JSON.parse(String(send.mock.calls.find(call => call[1]?.method === "POST")?.[1]?.body));
    expect(posted).toMatchObject({ expectedRevision: "7", expectedAuthorizationGeneration: "4" });
    expect(await db.prepare(`SELECT expected_authorization_generation,result_authorization_generation
      FROM project_alpha_existing_directory_binding_acquisition_response_receipts`).first())
      .toEqual({ expected_authorization_generation: "4", result_authorization_generation: "5" });
    expect(await db.prepare("SELECT activation_state,native_owner_epoch_id FROM project_alpha_acquired_canonical_mappings").first())
      .toEqual({ activation_state: "inactive", native_owner_epoch_id: null });
    expect(await db.prepare("SELECT state FROM project_alpha_acquired_mapping_activation").first("state")).toBe("inactive");
    const posts = send.mock.calls.filter(call => call[1]?.method === "POST").length;
    expect(await acquireProjectAlphaExistingDirectoryBinding(env, input(), send)).toMatchObject({ status: "acquired", replayed: true });
    expect(send.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(posts);
  });

  it("preserves an authenticated PA external ID distinct from the Operations record and rejects replay retargeting", async () => {
    const externalId = "pa-existing-organization-77", selected = input({ externalId });
    const send = transport({ record: externalId }), env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() };
    const acquired = await acquireProjectAlphaExistingDirectoryBinding(env, selected, send);
    expect(acquired).toMatchObject({ status: "acquired", replayed: false });
    expect(JSON.parse(String(send.mock.calls.find(call => call[1]?.method === "POST")?.[1]?.body)))
      .toMatchObject({ externalId });
    for (const table of ["project_alpha_existing_directory_binding_review_evidence",
      "project_alpha_existing_directory_binding_acquisition_commands",
      "project_alpha_existing_directory_binding_acquired_mapping_receipts",
      "project_alpha_acquired_canonical_mappings", "project_alpha_acquired_native_owner_claims"]) {
      expect(await db.prepare(`SELECT record_id,external_id FROM ${table}`).first()).toEqual({ record_id: recordId, external_id: externalId });
    }
    expect(await db.prepare(`SELECT external_id FROM project_alpha_existing_directory_binding_acquisition_response_receipts`)
      .first("external_id")).toBe(externalId);
    await expect(acquireProjectAlphaExistingDirectoryBinding(env, { ...selected, externalId: "pa-tampered" },
      transport({ record: "pa-tampered" }))).resolves.toEqual({ status: "conflict", reason: "reservation" });
  });

  it("carries the distinct sealed PA external ID through the private route into the real coordinator", async () => {
    const externalId = "pa-existing-organization-route-77", principal: StaffPrincipal = {
      id: "staff", email: "staff@example.test", displayName: "Staff", accessSubject: "access|staff", projectAlphaUserId: null,
    };
    const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
    app.use("/api/*", async (context, next) => {
      context.set("principal", principal);
      context.set("administrator", true);
      await requireMutationSecurity(context.req.raw, context.env, principal);
      await next();
    });
    registerProjectAlphaPrivateAdminRoutes(app);
    const routeEnv = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret(),
      PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED: "true", OPERATIONS_SESSION_SECRET: "operations-session-secret-0123456789abcdef",
      AUDIT_IP_SECRET: "audit-ip-secret-0123456789abcdef", EXPECTED_HOST: "ops.example.test",
      OPERATIONS_ORIGINS: "https://ops.example.test", ENVIRONMENT: "staging" } as unknown as Env;
    const body = { ...input({ externalId }) } as Record<string, unknown>;
    delete body.reviewer;
    const origin = "https://ops.example.test", csrf = await csrfToken(routeEnv, principal), send = transport({ record: externalId });
    vi.stubGlobal("fetch", send);
    const response = await app.request(`${origin}${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/acquire`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": csrf,
        "Idempotency-Key": String(body.commandId) }, body: JSON.stringify(body),
    }, routeEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "acquired", replayed: false });
    expect(JSON.parse(String(send.mock.calls.find(call => call[1]?.method === "POST")?.[1]?.body)))
      .toMatchObject({ externalId });
    expect(await db.prepare("SELECT record_id,external_id FROM project_alpha_existing_directory_binding_acquisition_commands").first())
      .toEqual({ record_id: recordId, external_id: externalId });
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

  it("recovers the same PA bind after its response-receipt D1 batch fails", async () => {
    const send = transport();
    let batchCalls = 0;
    const failsReceiptOnce = new Proxy(db, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        batchCalls++;
        if (batchCalls === 2) throw new Error("injected response-receipt persistence failure");
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    const first = await acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: failsReceiptOnce, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), send,
    );
    expect(first).toEqual({ status: "uncertain", reason: "database" });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_acquisition_response_receipts")
      .first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_acquired_canonical_mappings").first("count")).toBe(0);

    const recovered = await acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), send,
    );
    expect(recovered).toMatchObject({ status: "acquired", replayed: false });
    const bodies = send.mock.calls.filter(call => call[1]?.method === "POST").map(call => String(call[1]!.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await db.prepare("SELECT pa_replayed FROM project_alpha_existing_directory_binding_acquisition_response_receipts")
      .first("pa_replayed")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_acquired_canonical_mappings").first("count")).toBe(1);
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

  it.each([
    ["exact legacy pair", `INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id,created_at)
      VALUES('${sourceId}','organization','${recordId}','${publicId}','${source}','${application}','${epoch}','legacy-exact','2026-09-22T00:00:00.000Z')`],
    ["legacy local record", `INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id,created_at)
      VALUES('${sourceId}','organization','${recordId}','${"b".repeat(32)}','${source}','${application}',NULL,'legacy-local','2026-09-22T00:00:00.000Z')`],
    ["legacy PA public ID", `INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id,created_at)
      VALUES('${sourceId}','organization','other-record','${publicId}','${source}','${application}','${epoch}','legacy-public','2026-09-22T00:00:00.000Z')`],
  ])("rejects %s collision before reserving or posting", async (_name, statement) => {
    await db.prepare(statement).run();
    const send = transport();
    await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), send))
      .resolves.toEqual({ status: "conflict", reason: "collision" });
    expect(send.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_acquisition_commands").first("count")).toBe(0);
  });

  it("rejects a cross-column legacy identity collision before reserving or posting", async () => {
    const selectedExternalId = "b".repeat(32);
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id,created_at)
      VALUES(?,'organization','legacy-cross-column',?,?,?,?,?,'2026-09-22T00:00:00.000Z')`)
      .bind(sourceId, selectedExternalId, source, application, epoch, "legacy-cross-column").run();
    const send = transport({ record: selectedExternalId });

    await expect(acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() },
      input({ externalId: selectedExternalId }), send,
    )).resolves.toEqual({ status: "conflict", reason: "collision" });
    expect(send.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_acquisition_commands")
      .first("count")).toBe(0);
  });

  it("rejects an owner-claim cross-column collision before reserving or posting", async () => {
    await expect(acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), transport(),
    )).resolves.toMatchObject({ status: "acquired" });

    const secondRecordId = "ops-owner-claim-target";
    const selectedExternalId = "c".repeat(32), selectedPublicId = "d".repeat(32);
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(secondRecordId).run();
    // Isolate the defensive owner-claim lookup so the paired canonical row cannot satisfy the preflight.
    await db.prepare("DROP TRIGGER project_alpha_acquired_native_owner_claims_no_update").run();
    await db.prepare("UPDATE project_alpha_acquired_native_owner_claims SET project_alpha_public_id=?")
      .bind(selectedExternalId).run();
    const send = transport({ record: selectedExternalId, public: selectedPublicId });

    await expect(acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() },
      input({ reviewId: "21000000-0000-4000-8000-000000000005",
        commandId: "21000000-0000-4000-8000-000000000006", recordId: secondRecordId,
        externalId: selectedExternalId, projectAlphaPublicId: selectedPublicId }), send,
    )).resolves.toEqual({ status: "conflict", reason: "collision" });
    expect(send.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_acquisition_commands")
      .first("count")).toBe(1);
  });

  it("rejects a legacy mapping of the native record when the acquired PA ID differs", async () => {
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id,created_at)
      VALUES(?,?,?,?,?, ?,NULL,'legacy-native-alias','2026-09-22T00:00:00.000Z')`)
      .bind(sourceId,"organization",recordId,"b".repeat(32),source,application).run();
    const send = transport({ record: "pa/organization/different-canonical-id" });
    await expect(acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() },
      input({ externalId: "pa/organization/different-canonical-id" }), send,
    )).resolves.toEqual({ status: "conflict", reason: "collision" });
    expect(send.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    expect(await db.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_commands")
      .first("count(*)")).toBe(0);
  });

  it("rejects an acquired reservation collision before posting", async () => {
    await expect(acquireProjectAlphaExistingDirectoryBinding(
      { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input(), transport(),
    )).resolves.toMatchObject({ status: "acquired" });
    const send = transport();
    await expect(acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: envSecret() }, input({
      reviewId: "21000000-0000-4000-8000-000000000003", commandId: "21000000-0000-4000-8000-000000000004",
    }), send))
      .resolves.toEqual({ status: "conflict", reason: "collision" });
    expect(send.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
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
      commandId: "22000000-0000-4000-8000-000000000002", recordId: clientRecord, externalId: clientRecord,
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
