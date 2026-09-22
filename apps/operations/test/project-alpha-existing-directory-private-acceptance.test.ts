import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";

const sourceId = "project-alpha:primary";
const sourceInstanceId = "10000000-0000-4000-8000-000000000001";
const applicationId = "10000000-0000-4000-8000-000000000002";
const historyEpochId = "10000000-0000-4000-8000-000000000003";
const recordId = "30000000-0000-4000-8000-000000000001";
const publicId = "a".repeat(32);
const bindingStatusPath = `/api/v2/bindings/organization/status/${Buffer.from(recordId).toString("base64url")}`;
const reviewer = { staffId: "staff", accessSubject: "access|staff" };
const reviewId = "20000000-0000-4000-8000-000000000001";
const commandId = "20000000-0000-4000-8000-000000000002";
const idempotencyKey = "20000000-0000-4000-8000-000000000003";

const connections = JSON.stringify({ version: 1, instances: { [sourceId]: {
  sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "deployment-only-secret",
  sourceInstanceId, applicationId, historyEpoch: historyEpochId,
} } });

type Remote = {
  revision: string;
  profileGeneration: string;
  bindingGeneration: string;
  bound: boolean;
  bindResponse?: "success" | "malformed_success" | "precondition_conflict";
};

function remote(state: Remote): typeof fetch {
  let request = 10;
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestId = `90000000-0000-4000-8000-${String(request++).padStart(12, "0")}`;
    const reply = (value: Record<string, unknown>) => new Response(JSON.stringify({ ...value, requestId }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
    });
    const headers = new Headers(init?.headers);
    const assertIdentityHeaders = () => {
      if (headers.get("Authorization") !== "Bearer deployment-only-secret"
        || headers.get("X-PA-Source-Instance-ID") !== sourceInstanceId
        || headers.get("X-PA-Application-ID") !== applicationId
        || headers.get("X-PA-History-Epoch") !== historyEpochId)
        throw new Error("PA request did not preserve the configured identity boundary");
    };
    if (path === "/api/v2/capabilities") {
      if (init?.method !== "GET" || headers.get("Authorization") !== "Bearer deployment-only-secret")
        throw new Error("invalid PA capabilities preflight");
      return reply({ apiVersion: "2", sourceInstanceId, applicationId,
      historyEpoch: historyEpochId, grantedCapabilities: ["api.capabilities.read", "directory.organizations.read",
        "directory.organizations.binding_status.read", "directory.organizations.bind"].map(name => ({ name })),
      implementedEndpoints: [
        { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
        { method: "GET", path: "/api/v2/directory/organizations/{publicId}", requiredCapability: "directory.organizations.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "GET", path: "/api/v2/bindings/organization/status/{base64urlExternalId}", requiredCapability: "directory.organizations.binding_status.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
        { method: "POST", path: "/api/v2/directory/organizations/bindings/commands", requiredCapability: "directory.organizations.bind", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true, requiresExpectedPublicId: true, requiresExpectedRevision: true },
      ],
    });
    }
    if (path === `/api/v2/directory/organizations/${publicId}`) {
      if (init?.method !== "GET") throw new Error("invalid PA profile read method");
      assertIdentityHeaders();
      return reply({ apiVersion: "2", sourceInstanceId,
      applicationId, historyEpoch: historyEpochId, authorizationGeneration: state.profileGeneration,
      resource: { type: "organization", id: publicId, revision: state.revision }, data: { publicId,
        name: "Existing customer", email: null, phone: null,
        address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } },
      });
    }
    if (path === bindingStatusPath) {
      if (init?.method !== "GET") throw new Error("invalid PA binding-status read method");
      assertIdentityHeaders();
      return reply({ apiVersion: "2", sourceInstanceId,
      applicationId, historyEpoch: historyEpochId, authorizationGeneration: state.bindingGeneration,
      binding: { type: "organization", externalId: recordId, publicId, createdAt: "2026-09-22T12:00:00.000Z" },
      resource: { revision: state.revision, present: state.bound },
      });
    }
    if (path === "/api/v2/directory/organizations/bindings/commands") {
      if (init?.method !== "POST" || headers.get("Content-Type") !== "application/json; charset=utf-8")
        throw new Error("invalid PA bind request method or media type");
      assertIdentityHeaders();
      const command = JSON.parse(String(init.body));
      const expected = { commandId, externalId: recordId, expectedPublicId: publicId, expectedRevision: state.revision };
      if (JSON.stringify(command) !== JSON.stringify(expected))
        throw new Error("PA bind command did not preserve exact selection preconditions");
      if (state.bindResponse === "precondition_conflict")
        return new Response(JSON.stringify({ code: "PRECONDITION_FAILED", requestId }), {
          status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId },
        });
      if (state.bindResponse === "malformed_success") return reply({ replayed: false, sourceInstanceId, applicationId,
        historyEpoch: historyEpochId, result: { binding: { publicId }, resource: { type: "organization", id: "wrong", revision: state.revision } },
      });
      state.bound = true;
      return reply({ replayed: false, sourceInstanceId, applicationId, historyEpoch: historyEpochId,
        result: { binding: { publicId }, resource: { type: "organization", id: recordId, revision: state.revision } },
      });
    }
    throw new Error(`unexpected PA request: ${init?.method ?? "GET"} ${path}`);
  });
}

describe("private existing Directory acquisition-to-activation acceptance harness", () => {
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
      CREATE TABLE project_alpha_directory_mappings(source_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,command_id TEXT UNIQUE,created_at TEXT,PRIMARY KEY(source_id,source_instance_id,application_id,resource_type,external_id),UNIQUE(source_id,source_instance_id,application_id,resource_type,project_alpha_public_id));
      CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,admitted_by TEXT,version INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
      CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER,granted_by TEXT,created_at TEXT);
      CREATE TRIGGER native_directory_grants_identity BEFORE UPDATE ON native_directory_grants WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.permission IS NOT OLD.permission OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id OR NEW.resource_id IS NOT OLD.resource_id OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE native_directory_resource_scopes(record_id TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,active INTEGER);
      CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
      CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT);
      CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT,payload BLOB);
      CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload BLOB);
      INSERT INTO native_staff_admissions VALUES('staff','access|staff',1,'owner',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO native_staff_profiles VALUES('staff',1);
      INSERT INTO native_directory_grants VALUES('identity-link','staff','directory.identity.link','allow','business_area','area',NULL,NULL,1,'owner','2026-09-01T00:00:00.000Z');
      INSERT INTO staff_role_assignments VALUES('owner-role','staff','role-owner','global');
      INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/s/keep',x'00ff80');
      INSERT INTO delivery_records VALUES('delivery',x'ff0001');
    `).map(sql => db.prepare(sql)));
    for (const migration of ["0111_project_alpha_existing_directory_binding_review_evidence.sql",
      "0112_project_alpha_existing_directory_binding_acquisition_ledger.sql",
      "0113_project_alpha_existing_directory_binding_acquired_mapping_receipts.sql",
      "0114_project_alpha_existing_directory_binding_acquisition_response_receipts.sql",
      "0115_project_alpha_existing_directory_binding_review_local_revision_fence.sql",
      "0116_project_alpha_acquired_canonical_mapping_activation.sql",
      "0117_project_alpha_native_owner_epoch_claims.sql", "0123_native_directory_authority_history.sql",
      "0125_project_alpha_existing_directory_binding_activation.sql",
      "0127_project_alpha_existing_directory_binding_activation_evidence_transition.sql",
      "0129_project_alpha_existing_directory_binding_activation_relationship.sql"]) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"))
        .map(sql => db.prepare(sql)));
    }
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(recordId).run();
    await db.prepare("INSERT INTO native_directory_resource_scopes VALUES(?,'business_area','area',NULL,1)").bind(recordId).run();
  });
  afterEach(async () => { await runtime.dispose(); });

  async function acquire(fetcher: typeof fetch, generation = 1) {
    return acquireProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections }, {
      reviewId, commandId, sourceId, recordId, resourceType: "organization", projectAlphaPublicId: publicId,
      localRecordVersion: 1, reviewer: { ...reviewer, admissionVersion: 1, profileVersion: 1, grantGeneration: generation },
    }, fetcher);
  }
  async function activate(fetcher: typeof fetch, actor: unknown = reviewer) {
    return activateProjectAlphaExistingDirectoryBinding({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections },
      { reviewItemId: (await db.prepare("SELECT receipt_id FROM project_alpha_existing_directory_binding_review_evidence").first<string>("receipt_id"))!, idempotencyKey }, actor, fetcher);
  }
  async function activationCount() { return db.prepare("SELECT count(*) count FROM project_alpha_existing_directory_binding_activation_receipts").first<number>("count"); }
  async function mappingCount() { return db.prepare("SELECT count(*) count FROM project_alpha_acquired_canonical_mappings").first<number>("count"); }
  async function deliveryBytes() {
    return {
      share: await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_shares WHERE id='share'").first(),
      delivery: await db.prepare("SELECT hex(payload) payload FROM delivery_records WHERE id='delivery'").first(),
    };
  }

  it("is unmounted by default: no route imports either private consumer", () => {
    const index = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("project-alpha-existing-directory-acquisition-coordinator");
    expect(index).not.toContain("project-alpha-existing-directory-binding-review-consumer");
  });

  it("acquires, activates, and exactly replays without changing Delivery or public-link bytes", async () => {
    const state: Remote = { revision: "7", profileGeneration: "8", bindingGeneration: "8", bound: false };
    const fetcher = remote(state), before = await deliveryBytes();
    await expect(acquire(fetcher)).resolves.toMatchObject({ status: "acquired", replayed: false });
    const first = await activate(fetcher);
    expect(first).toMatchObject({ status: "activated", replayed: false, recordId });
    await expect(acquire(fetcher)).resolves.toMatchObject({ status: "acquired", replayed: true });
    await expect(activate(fetcher)).resolves.toEqual({ ...first, replayed: true });
    expect(await activationCount()).toBe(1);
    expect(await deliveryBytes()).toEqual(before);
  });

  it("keeps an acquired review inactive for a different authenticated actor", async () => {
    const fetcher = remote({ revision: "7", profileGeneration: "8", bindingGeneration: "8", bound: false });
    await expect(acquire(fetcher)).resolves.toMatchObject({ status: "acquired" });
    await expect(activate(fetcher, { staffId: "other", accessSubject: "access|other" }))
      .resolves.toEqual({ status: "blocked", reason: "actor" });
    expect(await activationCount()).toBe(0);
  });

  it.each(["malformed_success", "precondition_conflict"] as const)("does not materialize a mapping on PA %s", async bindResponse => {
    const fetcher = remote({ revision: "7", profileGeneration: "8", bindingGeneration: "8", bound: false, bindResponse });
    const before = await deliveryBytes();
    await expect(acquire(fetcher)).resolves.toMatchObject(bindResponse === "precondition_conflict"
      ? { status: "conflict", reason: "remote" } : { status: "uncertain", reason: "transport" });
    expect(await mappingCount()).toBe(0);
    expect(await activationCount()).toBe(0);
    expect(await deliveryBytes()).toEqual(before);
  });

  it("keeps the chain inactive when PA revision or its paired authorization generation changes", async () => {
    const state: Remote = { revision: "7", profileGeneration: "8", bindingGeneration: "8", bound: false };
    const fetcher = remote(state);
    await expect(acquire(fetcher)).resolves.toMatchObject({ status: "acquired" });
    state.revision = "8";
    await expect(activate(fetcher)).resolves.toEqual({ status: "blocked", reason: "remote" });
    expect(await activationCount()).toBe(0);
    state.revision = "7"; state.profileGeneration = "9";
    await expect(activate(fetcher)).resolves.toEqual({ status: "blocked", reason: "remote" });
    expect(await activationCount()).toBe(0);
  });

  it("fails closed when the active directory scope or native admission is revoked", async () => {
    const fetcher = remote({ revision: "7", profileGeneration: "8", bindingGeneration: "8", bound: false });
    await expect(acquire(fetcher)).resolves.toMatchObject({ status: "acquired" });
    await db.prepare("UPDATE native_directory_resource_scopes SET active=0 WHERE record_id=?").bind(recordId).run();
    await expect(activate(fetcher)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await activationCount()).toBe(0);

    await db.prepare("UPDATE native_directory_resource_scopes SET active=1 WHERE record_id=?").bind(recordId).run();
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id='staff'").run();
    await expect(activate(fetcher)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await activationCount()).toBe(0);
  });
});
