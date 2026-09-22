import { readFileSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";

const runtimes: Miniflare[] = [];
afterAll(async () => { for (const runtime of runtimes) await runtime.dispose(); });

const sourceId = "project-alpha:primary";
const sourceInstanceUUID = "11111111-1111-4111-8111-111111111111";
const applicationUUID = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const origin = "https://pa.example.test";
const actor = { staffId: "relationship-migration-actor", accessSubject: "access|relationship-migration-actor", admissionVersion: 1,
  selectedGrantId: "relationship-migration-profile", loginEmail: "relationship-migration@example.test", profileVersion: 1,
  selectedIdentityGrantId: "relationship-migration-identity" } as const;
const scopes = [{ businessAreaId: "area", divisionId: "division" }] as const;
const clientProfile = { name: "Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
const organizationProfile = { name: "Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
let sequence = 1;
function uuid() { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function destination(recordId: string) { return { sourceId, sourceInstanceUUID, applicationUUID, historyEpoch, origin,
  externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" }; }

async function seedAuthority(db: D1Database) {
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
      .bind(actor.staffId, actor.loginEmail, "Relationship Migration Actor", actor.accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')")
      .bind(actor.staffId, actor.accessSubject),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(actor.staffId, actor.loginEmail, "Relationship Migration Actor"),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.profile.edit','allow','global','owner')")
      .bind(actor.selectedGrantId, actor.staffId),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.identity.link','allow','global','owner')")
      .bind(actor.selectedIdentityGrantId, actor.staffId),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),
    db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)"),
  ]);
}

async function create(db: D1Database, kind: "organization" | "client", recordId: string, admit = true) {
  const mutationId = uuid(), createAdmissionId = `admission-${mutationId}`;
  const input = { operation: "create", mutationId, createAdmissionId, recordId, expectedLocalVersion: 0, kind,
    profile: kind === "client" ? clientProfile : organizationProfile, scopes, destinations: [destination(recordId)], actor,
    ...(kind === "client" ? { relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } } : {}) } as NativeDirectoryCreateWrite;
  if (admit) {
    await db.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId, actor.staffId, actor.accessSubject, recordId, kind,
        JSON.stringify(scopes), JSON.stringify(input.profile), JSON.stringify(input.destinations.map(({ expectedAuthorizationGeneration: _, ...value }) => value)), actor.staffId).run();
    if (kind === "client") await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id)
      VALUES(?,?)`).bind(createAdmissionId, recordId).run();
  }
  return writeNativeDirectoryProfile(db, input);
}

describe("0135 canonical Directory relationship IDs", () => {
  it("preserves a guarded populated relationship and admits bounded canonical IDs after upgrade", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime);
    const db = await runtime.getD1Database("OPS_DB") as D1Database, directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0134").sort();
    for (const migration of migrations) await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)));
    await seedAuthority(db);

    const legacyClient = "11111111-1111-4111-8111-111111111111";
    await expect(create(db, "client", legacyClient)).resolves.toMatchObject({ status: "written", version: 1 });
    const before = await db.prepare(`SELECT client_record_id,organization_record_id,relationship_version,created_at,updated_at
      FROM operations_directory_client_organizations WHERE client_record_id=?`).bind(legacyClient).first();
    const historyBefore = await db.prepare("SELECT count(*) n FROM operations_directory_client_organization_history WHERE client_record_id=?")
      .bind(legacyClient).first<number>("n");
    expect(before).toMatchObject({ client_record_id: legacyClient, organization_record_id: null, relationship_version: 1 });
    expect(historyBefore).toBe(1);

    const migration = readFileSync(new URL("../migrations/0135_operations_directory_relationship_canonical_ids.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(migration).map(sql => db.prepare(sql)));
    expect(await db.prepare(`SELECT client_record_id,organization_record_id,relationship_version,created_at,updated_at
      FROM operations_directory_client_organizations WHERE client_record_id=?`).bind(legacyClient).first()).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM operations_directory_client_organization_history WHERE client_record_id=?")
      .bind(legacyClient).first<number>("n")).toBe(historyBefore);
    expect(await db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'operations_directory_client_organizations_%'`).first<number>("n")).toBe(5);
    await expect(db.prepare("SELECT count(*) n FROM operations_directory_live_relationship_fences").first()).resolves.toBeTruthy();
    await expect(db.prepare("SELECT count(*) n FROM project_alpha_directory_live_relationship_commands").first()).resolves.toBeTruthy();

    await expect(create(db, "organization", "ops/org/adopted-2001")).resolves.toMatchObject({ status: "written" });
    await expect(create(db, "client", "ops/client/adopted-2001")).resolves.toMatchObject({ status: "written" });
    expect(await db.prepare("SELECT relationship_version FROM operations_directory_client_organizations WHERE client_record_id='ops/client/adopted-2001'")
      .first<number>("relationship_version")).toBe(1);
    await expect(db.prepare(`UPDATE operations_directory_client_organizations SET relationship_version=2,updated_at=updated_at
      WHERE client_record_id='ops/client/adopted-2001'`).run()).rejects.toThrow(/current native authority/);
    await expect(create(db, "client", "ops/client/control\u0001id", false)).resolves.toEqual({ status: "rejected", reason: "invalid_write" });
    await expect(create(db, "client", "x".repeat(192), false)).resolves.toEqual({ status: "rejected", reason: "invalid_write" });
    await expect(db.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES('overlong-admission',?,?,?,?,?,?,?,?)`).bind(actor.staffId, actor.accessSubject, "x".repeat(192), "client",
        JSON.stringify(scopes), JSON.stringify(clientProfile), "[]", actor.staffId).run()).rejects.toThrow(/length\(record_id\) BETWEEN 1 AND 191/);
  }, 240_000);
});
