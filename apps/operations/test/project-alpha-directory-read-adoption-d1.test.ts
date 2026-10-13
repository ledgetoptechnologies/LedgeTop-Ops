import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  reserveProjectAlphaDirectoryReadAdoption,
  type ProjectAlphaDirectoryReadAdoptionDependencies,
} from "../src/worker/project-alpha-directory-read-adoption";
import {
  DIRECTORY_ADOPTION_CLIENT_FIELDS,
  compareProjectAlphaDirectoryReadAdoptionFields,
  sealProjectAlphaDirectoryReadAdoptionFieldReview,
  type DirectoryAdoptionFieldDecision,
} from "../src/worker/project-alpha-directory-read-adoption-field-review";
import type { Env } from "../src/worker/types";

const sourceId = "project-alpha:adoption-test";
const sourceInstanceId = "10000000-0000-4000-8000-000000000001";
const applicationId = "20000000-0000-4000-8000-000000000002";
const historyEpoch = "30000000-0000-4000-8000-000000000003";
const inventoryRequestId = "40000000-0000-4000-8000-000000000004";
const profileRequestId = "50000000-0000-4000-8000-000000000005";
const bindingRequestId = "60000000-0000-4000-8000-000000000006";
const publicId = "a".repeat(32);
const recordId = "ops-customer-1";
const paExternalId = "pa-client-77";
const accessSubject = "native:staff:owner";
const actor = { staffId: "staff-owner", accessSubject, admissionVersion: 1, profileVersion: 1 };

let runtime: Miniflare;
let database: D1Database;
let env: Env;

async function migrate(): Promise<void> {
  const prerequisites = `
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
    CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,mutation_id TEXT,profile_json TEXT,PRIMARY KEY(record_id,version));
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
    CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
    CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT);
    CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
    CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER);
    CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_acquired_canonical_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_project_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,external_project_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE client_portal_accounts(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload BLOB);
    CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT);
  `;
  await database.batch(splitD1MigrationStatements(prerequisites).map(statement => database.prepare(statement)));
  for (const name of [
    "0125_project_alpha_api_v2_inventory_observations.sql",
    "0126_project_alpha_directory_read_adoption_claims.sql",
    "0127_project_alpha_directory_read_adoption_field_review_receipts.sql",
  ]) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
  }
}

async function seed(externalId = paExternalId, selectedPublicId = publicId): Promise<void> {
  await database.batch([
    database.prepare("INSERT INTO operations_directory_records VALUES(?,?,?)").bind(recordId, "client", 1),
    database.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,'mutation-1',?)").bind(recordId, JSON.stringify({
      name: "Selected customer", generalEmail: "local@example.test", generalPhone: "",
      addressLine1: "1 Local Way", addressLine2: "", city: "Local", state: "IL", postalCode: "60000", country: "US",
      clientType: "business", organizationPublicId: null,
    })),
    database.prepare("INSERT INTO native_staff_admissions VALUES(?,?,1,1)").bind(actor.staffId, accessSubject),
    database.prepare("INSERT INTO native_staff_profiles VALUES(?,1)").bind(actor.staffId),
    database.prepare("INSERT INTO native_directory_grants VALUES('grant',?,'directory.identity.link','allow','global',NULL,NULL,NULL,1)").bind(actor.staffId),
    database.prepare("INSERT INTO client_portal_accounts VALUES('portal','keep')"),
    database.prepare("INSERT INTO delivery_records VALUES('delivery',x'00ff80')"),
    database.prepare("INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/keep')"),
    database.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
      source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
      authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
      VALUES(?,?,?,?, 'directory',?,'7',NULL,NULL,?,1)`).bind(
      sourceId, sourceInstanceId, applicationId, historyEpoch, inventoryRequestId, "b".repeat(64)),
    database.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(
      source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
      project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
      binding_external_id,binding_status,binding_resource_revision)
      VALUES(?,?,?,?,?,'client',?,'3',1,'upsert',?,?,'active','3')`).bind(
      sourceId, sourceInstanceId, applicationId, historyEpoch, inventoryRequestId,
      selectedPublicId, "c".repeat(64), externalId),
  ]);
}

function dependencies(overrides: { externalId?: string; publicId?: string; revision?: string; authorizationGeneration?: string } = {}): ProjectAlphaDirectoryReadAdoptionDependencies {
  const selectedExternalId = overrides.externalId ?? paExternalId;
  const selectedPublicId = overrides.publicId ?? publicId;
  const revision = overrides.revision ?? "3";
  const authorizationGeneration = overrides.authorizationGeneration ?? "7";
  return {
    readProfile: vi.fn(async () => ({ status: "observed" as const, observation: {
      authoritative: false as const, sourceId, sourceInstanceId, applicationId, historyEpoch,
      requestId: profileRequestId, authorizationGeneration,
      resource: { type: "client" as const, id: selectedPublicId, revision },
      profile: { publicId: selectedPublicId, name: "Selected customer", email: null, phone: null,
        address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
        clientType: "unknown" as const, organizationPublicId: null },
    } })),
    readBinding: vi.fn(async () => ({ status: "observed" as const, observation: {
      authoritative: false as const, sourceId, sourceInstanceId, applicationId, historyEpoch,
      requestId: bindingRequestId, authorizationGeneration,
      binding: { type: "client" as const, externalId: selectedExternalId, publicId: selectedPublicId,
        createdAt: "2026-10-01T12:00:00.000Z" },
      resource: { revision, present: true as const },
    } })),
  };
}

function input(overrides: Partial<Parameters<typeof reserveProjectAlphaDirectoryReadAdoption>[1]> = {}) {
  return { sourceId, resourceType: "client" as const, recordId, expectedLocalRecordVersion: 1,
    projectAlphaPublicId: publicId, idempotencyKey: "70000000-0000-4000-8000-000000000007", actor,
    ...overrides };
}

async function count(table: string): Promise<number> {
  return (await database.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
}

beforeEach(async () => {
  await runtime?.dispose();
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('test')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  await migrate();
  env = { ENVIRONMENT: "staging", PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true",
    OPS_DB: database } as Env;
});

afterAll(async () => { await runtime?.dispose(); });

describe("Project Alpha exact Directory read-adoption reservation", () => {
  it("persists only immutable inactive review/claim evidence and replays idempotently", async () => {
    await seed();
    const reads = dependencies();
    const first = await reserveProjectAlphaDirectoryReadAdoption(env, input(), reads);
    expect(first).toMatchObject({ status: "reserved", state: "inactive" });
    expect(reads.readBinding).toHaveBeenCalledWith(
      expect.anything(), sourceId, "client", paExternalId, publicId,
    );
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input(), reads))
      .resolves.toEqual({ ...first, status: "replayed" });
    expect(await count("project_alpha_directory_read_adoption_reviews")).toBe(1);
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(1);
    expect(await database.prepare("SELECT state FROM project_alpha_directory_read_adoption_claims").first<string>("state"))
      .toBe("inactive");
    expect(await database.prepare(`SELECT record_id || ':' || external_id AS pair
      FROM project_alpha_directory_read_adoption_claims`).first<string>("pair"))
      .toBe(`${recordId}:${paExternalId}`);
    expect(await count("project_alpha_directory_mappings")).toBe(0);
    expect(await count("project_alpha_acquired_canonical_mappings")).toBe(0);
    expect(await database.prepare("SELECT payload FROM client_portal_accounts WHERE id='portal'").first<string>("payload")).toBe("keep");
    expect(await database.prepare("SELECT hex(payload) h FROM delivery_records WHERE id='delivery'").first<string>("h")).toBe("00FF80");
    expect(await database.prepare("SELECT url FROM delivery_public_shares WHERE id='share'").first<string>("url"))
      .toBe("https://public.example.test/keep");
  });

  it("rejects idempotency substitution and pair collisions without another claim", async () => {
    await seed();
    const first = await reserveProjectAlphaDirectoryReadAdoption(env, input(), dependencies());
    expect(first.status).toBe("reserved");
    await expect(reserveProjectAlphaDirectoryReadAdoption(env,
      input({ projectAlphaPublicId: "d".repeat(32) }), dependencies({ publicId: "d".repeat(32) })))
      .resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    await database.prepare("INSERT INTO operations_directory_records VALUES('ops-customer-2','client',1)").run();
    const collisionRequest = "90000000-0000-4000-8000-000000000009";
    await database.batch([
      database.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
        authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
        VALUES(?,?,?,?, 'directory',?,'8',NULL,NULL,?,1)`).bind(
        sourceId, sourceInstanceId, applicationId, historyEpoch, collisionRequest, "e".repeat(64)),
      database.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(
        source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
        project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
        binding_external_id,binding_status,binding_resource_revision)
        VALUES(?,?,?,?,?,'client',?,'4',1,'upsert',?,'different-pa-id','active','4')`).bind(
        sourceId, sourceInstanceId, applicationId, historyEpoch, collisionRequest,
        publicId, "f".repeat(64)),
    ]);
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input({
      recordId: "ops-customer-2",
      idempotencyKey: "80000000-0000-4000-8000-000000000008",
    }), dependencies({ externalId: "different-pa-id", revision: "4" })))
      .resolves.toEqual({ status: "blocked", reason: "selection_not_current" });
    expect(await database.prepare(`SELECT count(*) AS n FROM project_alpha_api_v2_inventory_conflicts
      WHERE conflict_kind='public_id_binding_changed'`).first<number>("n")).toBe(1);
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(1);
  });

  it("rejects the older public ID when a newer observation collides on the same PA external ID", async () => {
    await seed();
    const newerPublicId = "d".repeat(32);
    const collisionRequest = "b0000000-0000-4000-8000-00000000000b";
    await database.batch([
      database.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
        authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
        VALUES(?,?,?,?, 'directory',?,'8',NULL,NULL,?,1)`).bind(
        sourceId, sourceInstanceId, applicationId, historyEpoch, collisionRequest, "1".repeat(64)),
      database.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(
        source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
        project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
        binding_external_id,binding_status,binding_resource_revision)
        VALUES(?,?,?,?,?,'client',?,'4',1,'upsert',?,?,'active','4')`).bind(
        sourceId, sourceInstanceId, applicationId, historyEpoch, collisionRequest,
        newerPublicId, "2".repeat(64), paExternalId),
    ]);
    expect(await database.prepare(`SELECT count(*) AS n FROM project_alpha_api_v2_inventory_conflicts
      WHERE conflict_kind='external_id_collision' AND external_id=?`).bind(paExternalId)
      .first<number>("n")).toBe(1);
    expect(await database.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
      WHERE project_alpha_public_id=?`).bind(publicId).first<number>("has_conflict")).toBe(0);
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input(), dependencies()))
      .resolves.toEqual({ status: "blocked", reason: "selection_not_current" });
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(0);
  });

  it("uses only the explicitly selected PA public ID and never auto-matches another record", async () => {
    await seed();
    await expect(reserveProjectAlphaDirectoryReadAdoption(env,
      input({ projectAlphaPublicId: "d".repeat(32) }), dependencies({ publicId: "d".repeat(32) })))
      .resolves.toEqual({ status: "blocked", reason: "selection_not_current" });
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(0);
  });

  it("rejects a selected Ops record already present in a legacy mapping under its local ID", async () => {
    await seed();
    await database.prepare(`INSERT INTO project_alpha_directory_mappings(
      source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?, 'client',?,?)`).bind(
      sourceId, sourceInstanceId, applicationId, historyEpoch, recordId, "e".repeat(32),
    ).run();
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input(), dependencies()))
      .resolves.toEqual({ status: "blocked", reason: "selection_not_current" });
    expect(await count("project_alpha_directory_read_adoption_reviews")).toBe(0);
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(0);
  });

  it("fences the selected local record version", async () => {
    await seed();
    await database.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?").bind(recordId).run();
    await expect(reserveProjectAlphaDirectoryReadAdoption(env,
      input({ expectedLocalRecordVersion: 1 }), dependencies()))
      .resolves.toEqual({ status: "blocked", reason: "selection_not_current" });
  });

  it("requires fresh PA profile and binding identity to agree with the inventory evidence", async () => {
    await seed();
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input(), dependencies({ revision: "4" })))
      .resolves.toEqual({ status: "blocked", reason: "pa_identity_changed" });
    expect(await count("project_alpha_directory_read_adoption_reviews")).toBe(0);
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(0);
  });

  it("rejects a fresh binding read that changes the observed PA external ID", async () => {
    await seed();
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input(),
      dependencies({ externalId: "different-pa-id" })))
      .resolves.toEqual({ status: "blocked", reason: "pa_identity_changed" });
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(0);
  });

  it("fails closed while any source-wide Directory identity conflict is unresolved", async () => {
    await seed();
    await database.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
      source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
      request_id,prior_reference,conflict_kind,details_json)
      VALUES(?,?,?,?, 'directory','source',?,'prior-source','source_identity_changed','{}')`).bind(
      sourceId, sourceInstanceId, applicationId, historyEpoch,
      "a0000000-0000-4000-8000-00000000000a",
    ).run();
    await expect(reserveProjectAlphaDirectoryReadAdoption(env, input(), dependencies()))
      .resolves.toEqual({ status: "blocked", reason: "selection_not_current" });
    expect(await count("project_alpha_directory_read_adoption_reviews")).toBe(0);
    expect(await count("project_alpha_directory_read_adoption_claims")).toBe(0);
  });
});

describe("Project Alpha Directory adoption field-review receipt", () => {
  function fieldDecisions(overrides: Partial<Record<typeof DIRECTORY_ADOPTION_CLIENT_FIELDS[number], DirectoryAdoptionFieldDecision>> = {}) {
    return Object.fromEntries(DIRECTORY_ADOPTION_CLIENT_FIELDS.map(field => [field, field === "name" || field === "organization_public_id" ? "unchanged" : "requires_follow_up"])
      .map(([field, decision]) => [field, overrides[field as typeof DIRECTORY_ADOPTION_CLIENT_FIELDS[number]] ?? decision])) as Record<typeof DIRECTORY_ADOPTION_CLIENT_FIELDS[number], DirectoryAdoptionFieldDecision>;
  }
  async function reserve() {
    await seed();
    const result = await reserveProjectAlphaDirectoryReadAdoption(env, input(), dependencies());
    if (result.status !== "reserved") throw new Error(`reservation failed: ${JSON.stringify(result)}`);
    return result;
  }

  it("compares the exact local revision with a fresh PA profile without persisting raw values", async () => {
    const reserved=await reserve();
    const compared=await compareProjectAlphaDirectoryReadAdoptionFields(env,reserved.reviewId,actor,dependencies().readProfile);
    expect(compared).toMatchObject({status:"compared",reviewId:reserved.reviewId,resourceType:"client"});
    if(compared.status!=="compared") throw new Error("comparison failed");
    expect(compared.fields.map(field=>field.field)).toEqual(DIRECTORY_ADOPTION_CLIENT_FIELDS);
    expect(compared.fields.find(field=>field.field==="name")).toEqual({field:"name",localValue:"Selected customer",projectAlphaValue:"Selected customer",equal:true});
    expect(compared.fields.find(field=>field.field==="email")).toEqual({field:"email",localValue:"local@example.test",projectAlphaValue:null,equal:false});
    expect(await count("project_alpha_directory_read_adoption_field_review_receipts")).toBe(0);
    const stored=JSON.stringify((await database.prepare("SELECT * FROM project_alpha_directory_read_adoption_reviews").all()).results);
    expect(stored).not.toContain("local@example.test");
    expect(stored).not.toContain("Selected customer");
  });

  it("fails comparison closed on reviewer profile or PA authorization-generation drift", async () => {
    const reserved=await reserve();
    await database.prepare("UPDATE native_staff_profiles SET version=2 WHERE staff_id=?").bind(actor.staffId).run();
    await expect(compareProjectAlphaDirectoryReadAdoptionFields(env,reserved.reviewId,actor,dependencies().readProfile))
      .resolves.toEqual({status:"blocked",reason:"reservation_not_current"});
    await database.prepare("UPDATE native_staff_profiles SET version=1 WHERE staff_id=?").bind(actor.staffId).run();
    await expect(compareProjectAlphaDirectoryReadAdoptionFields(env,reserved.reviewId,actor,dependencies({authorizationGeneration:"8"}).readProfile))
      .resolves.toEqual({status:"blocked",reason:"pa_profile_changed"});
    expect(await count("project_alpha_directory_read_adoption_field_review_receipts")).toBe(0);
  });

  it("seals every exact client field as enum-only evidence and preserves all authority and Delivery state", async () => {
    const reserved = await reserve();
    const decisions = fieldDecisions();
    const first = await sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions, actor }, dependencies().readProfile);
    expect(first.status).toBe("sealed");
    await expect(sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions, actor }, dependencies().readProfile))
      .resolves.toEqual({ ...first, status: "replayed" });
    await expect(sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId,
      decisions: fieldDecisions({ email: "retain_local" }), actor }, dependencies().readProfile))
      .resolves.toEqual({ status: "conflict", reason: "review_already_sealed" });
    const persistedDecisions = (await database.prepare("SELECT field_name,decision FROM project_alpha_directory_read_adoption_field_decisions ORDER BY field_name").all()).results;
    expect(persistedDecisions).toHaveLength(DIRECTORY_ADOPTION_CLIENT_FIELDS.length);
    expect(new Set(persistedDecisions.map(row => row.field_name))).toEqual(new Set(DIRECTORY_ADOPTION_CLIENT_FIELDS));
    expect(await database.prepare("SELECT count(*) n FROM project_alpha_directory_read_adoption_field_review_audit").first("n")).toBe(1);
    expect(await database.prepare("SELECT state FROM project_alpha_directory_read_adoption_claims").first("state")).toBe("inactive");
    expect(await count("project_alpha_directory_mappings")).toBe(0);
    expect(await count("project_alpha_acquired_canonical_mappings")).toBe(0);
    expect(await database.prepare("SELECT payload FROM client_portal_accounts WHERE id='portal'").first("payload")).toBe("keep");
    expect(await database.prepare("SELECT url FROM delivery_public_shares WHERE id='share'").first("url")).toBe("https://public.example.test/keep");
    const receipt = await database.prepare(`SELECT source_instance_id,application_id,history_epoch_id,external_id,project_alpha_public_id,
      project_alpha_revision,authorization_generation,local_record_version,length(local_profile_sha256) local_hash,length(project_alpha_profile_sha256) pa_hash
      FROM project_alpha_directory_read_adoption_field_review_receipts`).first();
    expect(receipt).toMatchObject({ source_instance_id: sourceInstanceId, application_id: applicationId, history_epoch_id: historyEpoch,
      external_id: paExternalId, project_alpha_public_id: publicId, project_alpha_revision: "3", authorization_generation: "7",
      local_record_version: 1, local_hash: 64, pa_hash: 64 });
  });

  it("rejects missing fields, false unchanged claims, stale local versions and stale PA revisions", async () => {
    const reserved = await reserve();
    const missing = fieldDecisions(); delete (missing as Partial<typeof missing>).country;
    await expect(sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions: missing, actor }, dependencies().readProfile))
      .resolves.toEqual({ status: "rejected", reason: "invalid_decisions" });
    await expect(sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions: fieldDecisions({ email: "unchanged" }), actor }, dependencies().readProfile))
      .resolves.toEqual({ status: "rejected", reason: "invalid_decisions" });
    await database.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id=?").bind(recordId).run();
    await expect(sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions: fieldDecisions(), actor }, dependencies().readProfile))
      .resolves.toEqual({ status: "blocked", reason: "reservation_not_current" });
    await database.prepare("UPDATE operations_directory_records SET current_version=1 WHERE record_id=?").bind(recordId).run();
    await expect(sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions: fieldDecisions(), actor }, dependencies({ revision: "4" }).readProfile))
      .resolves.toEqual({ status: "blocked", reason: "pa_profile_changed" });
  });

  it("enforces immutable complete decisions and immutable audit at the database boundary", async () => {
    const reserved = await reserve();
    const sealed = await sealProjectAlphaDirectoryReadAdoptionFieldReview(env, { reviewId: reserved.reviewId, decisions: fieldDecisions(), actor }, dependencies().readProfile);
    expect(sealed.status).toBe("sealed");
    await expect(database.prepare("UPDATE project_alpha_directory_read_adoption_field_decisions SET decision='adopt_project_alpha'").run()).rejects.toThrow(/immutable/);
    await expect(database.prepare("DELETE FROM project_alpha_directory_read_adoption_field_review_audit").run()).rejects.toThrow(/durable/);
    await expect(database.prepare(`INSERT INTO project_alpha_directory_read_adoption_field_decisions(receipt_id,field_name,decision)
      SELECT receipt_id,'client_type','retain_local' FROM project_alpha_directory_read_adoption_field_review_receipts`).run()).rejects.toThrow();
  });
});
