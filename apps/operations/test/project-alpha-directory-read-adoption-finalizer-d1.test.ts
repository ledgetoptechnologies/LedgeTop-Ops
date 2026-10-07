import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { prepareProjectAlphaDirectoryReadAdoptionFinalization } from "../src/worker/project-alpha-directory-read-adoption-finalizer";
import type { Env } from "../src/worker/types";

const sourceId = "project-alpha:finalizer";
const sourceInstanceId = "10000000-0000-4000-8000-000000000001";
const applicationId = "20000000-0000-4000-8000-000000000002";
const historyEpoch = "30000000-0000-4000-8000-000000000003";
const reviewId = "40000000-0000-4000-8000-000000000004";
const claimId = "50000000-0000-4000-8000-000000000005";
const receiptId = "60000000-0000-4000-8000-000000000006";
const profileRequestId = "70000000-0000-4000-8000-000000000007";
const bindingRequestId = "80000000-0000-4000-8000-000000000008";
const publicId = "a".repeat(32);
const recordId = "ops-customer-1";
const externalId = "pa-client-77";
const actor = { staffId: "staff-owner", accessSubject: "native:staff:owner", admissionVersion: 1, profileVersion: 1, grantGeneration: 1 };
const localProfile = { name: "Local customer", generalEmail: "local@example.test", generalPhone: "",
  addressLine1: "1 Local Way", addressLine2: "", city: "Local", state: "IL", postalCode: "60000", country: "US",
  clientType: "business", organizationPublicId: null };
const remoteProfile = { publicId, name: "Local customer", email: "remote@example.test", phone: null,
  address: { line1: "1 Local Way", line2: null, city: "Local", state: "IL", postalCode: "60000", country: "US" },
  clientType: "business" as const, organizationPublicId: null };

let runtime: Miniflare;
let db: D1Database;

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}

async function schema(): Promise<void> {
  const prerequisites = `
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
    CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,mutation_id TEXT,profile_json TEXT,PRIMARY KEY(record_id,version));
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
    CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
    CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER);
    CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT);
    CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
    CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER);
    CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_acquired_canonical_mappings(receipt_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_api_v2_directory_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,project_alpha_public_id TEXT,resource_revision TEXT,binding_external_id TEXT,binding_status TEXT,binding_resource_revision TEXT,present INTEGER,last_action TEXT,has_conflict INTEGER);
    CREATE TABLE project_alpha_api_v2_inventory_conflicts(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,inventory_kind TEXT,resource_type TEXT,project_alpha_public_id TEXT,external_id TEXT);
    CREATE TABLE project_alpha_directory_read_adoption_reviews(review_id TEXT PRIMARY KEY);
    CREATE TABLE project_alpha_directory_read_adoption_claims(claim_id TEXT PRIMARY KEY,review_id TEXT,state TEXT,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_directory_read_adoption_field_review_receipts(receipt_id TEXT PRIMARY KEY,review_id TEXT,claim_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,project_alpha_revision TEXT,authorization_generation TEXT,local_record_version INTEGER,local_profile_sha256 TEXT,project_alpha_profile_sha256 TEXT,reviewer_staff_id TEXT,reviewer_access_subject TEXT,reviewer_admission_version INTEGER,reviewer_profile_version INTEGER,decision_count INTEGER);
    CREATE TABLE project_alpha_directory_read_adoption_field_decisions(receipt_id TEXT,field_name TEXT,decision TEXT,PRIMARY KEY(receipt_id,field_name));
    CREATE TABLE project_alpha_directory_read_adoption_field_review_audit(audit_id TEXT PRIMARY KEY,receipt_id TEXT,actor_staff_id TEXT);
    CREATE TABLE client_portal_accounts(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload TEXT);
    CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT);
    CREATE TABLE project_alpha_directory_reconciliation_actions(action_id TEXT PRIMARY KEY);
  `;
  await db.batch(splitD1MigrationStatements(prerequisites).map(statement => db.prepare(statement)));
  const migration = readFileSync(new URL("../migrations/0167_project_alpha_directory_read_adoption_finalizations.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));
  const preservedIdentity = readFileSync(new URL("../migrations/0174_project_alpha_directory_preserved_external_identity.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(preservedIdentity).map(statement => db.prepare(statement)));
}

async function seed(decision: "retain_local" | "adopt_project_alpha" | "requires_follow_up" = "retain_local"): Promise<void> {
  const localHash = await hash(localProfile), remoteHash = await hash(remoteProfile);
  const fields = ["name","email","phone","address_line1","address_line2","city","state","postal_code","country","client_type","organization_public_id"];
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES(?,?,1)").bind(recordId,"client"),
    db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,'mutation-1',?)").bind(recordId,JSON.stringify(localProfile)),
    db.prepare("INSERT INTO native_staff_admissions VALUES(?,?,1,1)").bind(actor.staffId,actor.accessSubject),
    db.prepare("INSERT INTO native_staff_profiles VALUES(?,1)").bind(actor.staffId),
    db.prepare("INSERT INTO native_directory_grant_generations VALUES(?,1)").bind(actor.staffId),
    db.prepare("INSERT INTO native_directory_grants VALUES('link',?,'directory.identity.link','allow','global',NULL,NULL,NULL,1)").bind(actor.staffId),
    db.prepare("INSERT INTO project_alpha_directory_read_adoption_reviews VALUES(?)").bind(reviewId),
    db.prepare(`INSERT INTO project_alpha_directory_read_adoption_claims(
      claim_id,review_id,state,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id) VALUES(?,?,'inactive',?,?,?,?,?,?,?,?)`)
      .bind(claimId,reviewId,recordId,sourceId,sourceInstanceId,applicationId,historyEpoch,"client",externalId,publicId),
    db.prepare(`INSERT INTO project_alpha_directory_read_adoption_field_review_receipts(
      receipt_id,review_id,claim_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,
      record_id,external_id,project_alpha_public_id,project_alpha_revision,authorization_generation,local_record_version,
      local_profile_sha256,project_alpha_profile_sha256,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,decision_count)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receiptId,reviewId,claimId,sourceId,sourceInstanceId,applicationId,
      historyEpoch,"client",recordId,externalId,publicId,"3","7",1,localHash,remoteHash,actor.staffId,actor.accessSubject,1,1,11),
    ...fields.map((field,index)=>db.prepare("INSERT INTO project_alpha_directory_read_adoption_field_decisions VALUES(?,?,?)")
      .bind(receiptId,field,index===1?decision:"retain_local")),
    db.prepare("INSERT INTO project_alpha_directory_read_adoption_field_review_audit VALUES('audit',?,?)").bind(receiptId,actor.staffId),
    db.prepare("INSERT INTO project_alpha_api_v2_directory_observations_current VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(sourceId,sourceInstanceId,applicationId,historyEpoch,"client",publicId,"3",externalId,"active","3",1,"upsert",0),
    db.prepare("INSERT INTO client_portal_accounts VALUES('portal','keep')"),
    db.prepare("INSERT INTO delivery_records VALUES('delivery','keep')"),
    db.prepare("INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/keep')"),
  ]);
}

function reads(overrides: { revision?: string; externalId?: string; generation?: string; profile?: typeof remoteProfile } = {}) {
  const selectedProfile = overrides.profile ?? remoteProfile;
  return {
    readProfile: vi.fn(async () => ({ status: "observed" as const, observation: {
      authoritative: false as const, sourceId, sourceInstanceId, applicationId, historyEpoch,
      requestId: profileRequestId, authorizationGeneration: overrides.generation ?? "7",
      resource: { type: "client" as const, id: publicId, revision: overrides.revision ?? "3" }, profile: selectedProfile,
    } })),
    readBinding: vi.fn(async () => ({ status: "observed" as const, observation: {
      authoritative: false as const, sourceId, sourceInstanceId, applicationId, historyEpoch,
      requestId: bindingRequestId, authorizationGeneration: overrides.generation ?? "7",
      binding: { type: "client" as const, externalId: overrides.externalId ?? externalId, publicId,
        createdAt: "2026-10-03T12:00:00.000Z" }, resource: { revision: overrides.revision ?? "3", present: true as const },
    } })),
  };
}

function input(key = "90000000-0000-4000-8000-000000000009") {
  return { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor };
}

function env(): Pick<Env,"ENVIRONMENT"|"PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED"|"OPS_DB"> {
  return { ENVIRONMENT:"staging",PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED:"true",OPS_DB:db };
}

async function count(table: string): Promise<number> { return (await db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n")) ?? -1; }

beforeEach(async()=>{
  await runtime?.dispose();
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('test')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;
  await schema();
});
afterAll(async()=>{await runtime?.dispose();});

describe("Project Alpha Directory read-adoption finalization preparation",()=>{
  it("prepares one append-only rebind handoff and replays without touching mapping or access data",async()=>{
    await seed();
    const first=await prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads());
    expect(first).toMatchObject({status:"prepared",fieldReviewReceiptId:receiptId,rebindRequired:true,adoptedFieldCount:0,state:"prepared"});
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads()))
      .resolves.toEqual({...first,status:"replayed"});
    expect(await count("project_alpha_directory_read_adoption_finalizations")).toBe(1);
    expect(await count("project_alpha_directory_read_adoption_finalization_events")).toBe(1);
    expect(await count("project_alpha_directory_mappings")).toBe(0);
    expect(await count("project_alpha_acquired_canonical_mappings")).toBe(0);
    expect(await db.prepare(`SELECT target_external_id,acquisition_external_id,acquisition_identity_mode
      FROM project_alpha_directory_read_adoption_finalizations`).first()).toEqual({ target_external_id: recordId,
      acquisition_external_id: externalId, acquisition_identity_mode: "preserve_reviewed" });
    expect(await db.prepare("SELECT payload FROM client_portal_accounts").first("payload")).toBe("keep");
    expect(await db.prepare("SELECT payload FROM delivery_records").first("payload")).toBe("keep");
    expect(await db.prepare("SELECT url FROM delivery_public_shares").first("url")).toBe("https://public.example.test/keep");
  });

  it("requires profile-edit authority only when an adopted field is present",async()=>{
    await seed("adopt_project_alpha");
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads()))
      .resolves.toEqual({status:"blocked",reason:"authority"});
    await db.prepare("INSERT INTO native_directory_grants VALUES('edit',?,'directory.profile.edit','allow','resource',NULL,NULL,?,1)")
      .bind(actor.staffId,recordId).run();
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads()))
      .resolves.toMatchObject({status:"prepared",adoptedFieldCount:1});
  });

  it("rejects follow-up dispositions before any durable finalization",async()=>{
    await seed("requires_follow_up");
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads()))
      .resolves.toEqual({status:"blocked",reason:"follow_up"});
    expect(await count("project_alpha_directory_read_adoption_finalizations")).toBe(0);
  });

  it.each([
    ["local version",async()=>{await db.prepare("UPDATE operations_directory_records SET current_version=2").run();},"sealed_review"],
    ["grant generation",async()=>{await db.prepare("UPDATE native_directory_grant_generations SET generation=2").run();},"authority"],
    ["identity-link deny",async()=>{await db.prepare("INSERT INTO native_directory_grants VALUES('deny',?,'directory.identity.link','deny','resource',NULL,NULL,?,1)").bind(actor.staffId,recordId).run();},"authority"],
    ["mapping collision",async()=>{await db.prepare("INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?,?)").bind(sourceId,sourceInstanceId,applicationId,historyEpoch,"client",recordId,publicId).run();},"collision"],
  ] as const)("fails closed on %s drift",async(_label,mutate,reason)=>{
    await seed(); await mutate();
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads()))
      .resolves.toEqual({status:"blocked",reason});
    expect(await count("project_alpha_directory_read_adoption_finalizations")).toBe(0);
  });

  it("rejects fresh PA profile, binding, revision, and generation drift",async()=>{
    for(const altered of [reads({revision:"4"}),reads({externalId:"other"}),reads({generation:"8"}),
      reads({profile:{...remoteProfile,email:"changed@example.test"}})]){
      await runtime.dispose();
      runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('test')}}",d1Databases:["OPS_DB"]});
      db=await runtime.getD1Database("OPS_DB") as D1Database; await schema(); await seed();
      await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),altered))
        .resolves.toEqual({status:"blocked",reason:"remote"});
    }
  });

  it("rejects receipt or idempotency substitution",async()=>{
    await seed();
    const first=await prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input(),reads());
    expect(first.status).toBe("prepared");
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),input("91000000-0000-4000-8000-000000000009"),reads()))
      .resolves.toEqual({status:"conflict",reason:"review_already_finalized"});
    await expect(prepareProjectAlphaDirectoryReadAdoptionFinalization(env(),{...input(),actor:{...actor,grantGeneration:2}},reads()))
      .resolves.toEqual({status:"blocked",reason:"authority"});
  });
});
