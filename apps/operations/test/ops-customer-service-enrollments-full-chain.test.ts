import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeCustomerServiceEnrollment } from "../src/worker/ops-customer-service-enrollments";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

describe("0146 customer service enrollment writer on the full Operations schema", () => {
  let runtime: Miniflare;
  let db: D1Database;
  const owner = "service-enrollment-owner";
  const staff = "service-enrollment-staff";
  const customer = "ops/client/service-enrollment-full-chain";
  const area = "service-enrollment-area";
  const division = "service-enrollment-division";
  const ltds = "service/ltds/full-chain";
  const ltt = "service/ltt/full-chain";
  const actor: AuthenticatedNativeStaffWithAdmissionVersion = { identity: {
    kind: "native", staffId: staff, verifiedAccessSubject: "access:service-enrollment-staff",
    email: "service-enrollment-staff@example.test", displayName: "Service Enrollment Staff", profileVersion: 1,
  }, admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z" };
  const command = (mutationId: string, key: string, serviceId: string, desiredState: "active" | "revoked", expectedRevision: number) =>
    ({ mutationId, idempotencyKey: key, customerRecordId: customer, serviceId, desiredState, expectedRevision });

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(fileURLToPath(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    const statements = migrations.flatMap(migration => splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")))
      .map(sql => db.prepare(sql));
    for (let start = 0; start < statements.length; start += 100) await db.batch(statements.slice(start, start + 100));

    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
        .bind(owner, "service-enrollment-owner@example.test", "Owner", "access:service-enrollment-owner"),
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')")
        .bind(staff, actor.identity.email, actor.identity.displayName, actor.identity.verifiedAccessSubject),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
        .bind(staff, actor.identity.verifiedAccessSubject, owner),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
        .bind(staff, actor.identity.email, actor.identity.displayName),
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)").bind(area, "Service enrollment area"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES(?,?,?,1)")
        .bind(division, area, "Service enrollment division"),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,'service-enrollment-staff','directory.profile.edit','allow','global',1,?)`).bind("service-enrollment-profile-grant", owner),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,'service-enrollment-staff','directory.identity.link','allow','global',1,?)`).bind("service-enrollment-identity-grant", owner),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?,'service-enrollment-staff','directory.enrollment.manage','allow','global',1,?)`).bind("service-enrollment-bootstrap-enrollment-grant", owner),
    ]);
    const directoryActor = { staffId: staff, accessSubject: actor.identity.verifiedAccessSubject, admissionVersion: 1,
      selectedGrantId: "service-enrollment-profile-grant", loginEmail: actor.identity.email, profileVersion: 1,
      selectedIdentityGrantId: "service-enrollment-identity-grant" } as const;
    const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
      applicationUUID: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333",
      origin: "https://pa.example.test", externalCanonicalId: customer, expectedAuthorizationGeneration: "0" } as const;
    const directoryInput: NativeDirectoryCreateWrite = { operation: "create", mutationId: "44444444-4444-4444-8444-444444444444",
      createAdmissionId: "full-chain-directory-admission", recordId: customer, expectedLocalVersion: 0, kind: "client",
      profile: { name: "Full chain customer", email: "full-chain-customer@example.test", phone: "512-555-0101", clientType: "business",
        addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      scopes: [{ businessAreaId: area, divisionId: division }], destinations: [destination], actor: directoryActor,
      relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } };
    await db.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(directoryInput.createAdmissionId, staff, actor.identity.verifiedAccessSubject, customer, "client",
        JSON.stringify(directoryInput.scopes), JSON.stringify(directoryInput.profile), JSON.stringify([{
          sourceId: destination.sourceId, sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
          historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: destination.externalCanonicalId,
        }]), owner).run();
    await db.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)`)
      .bind(directoryInput.createAdmissionId, customer).run();
    const created = await writeNativeDirectoryProfile(db, directoryInput);
    if (created.status !== "written") throw Error(`full-chain Directory bootstrap failed: ${created.reason}`);
    await db.batch([
      db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='service-enrollment-bootstrap-enrollment-grant'"),
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,division_id,active,granted_by)
        VALUES(?,'service-enrollment-staff','directory.enrollment.manage','allow','division',?,1,?)`)
        .bind("service-enrollment-grant", division, owner),
      db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
        .bind(ltds, "ltds", "ltds:catalog", "full-chain", "Inspection"),
      db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
        .bind(ltt, "ltt", "ltt:catalog", "full-chain", "Inspection"),
    ]);
  }, 240_000);
  afterAll(async () => { await runtime.dispose(); });

  it("creates, replays through a legitimate generation change, and revokes", async () => {
    const create = command("full-chain-create", "full-chain-key-create", ltds, "active", 0);
    const first = await writeCustomerServiceEnrollment(db, actor, create);
    expect(first).toMatchObject({ state: "active", revision: 1, replayed: false });
    const before = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(staff).first<number>("generation");
    await db.batch([
      db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='service-enrollment-grant'"),
      db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='service-enrollment-grant'"),
    ]);
    const after = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
      .bind(staff).first<number>("generation");
    expect(after).toBeGreaterThan(before ?? 0);
    await expect(writeCustomerServiceEnrollment(db, actor, create)).resolves.toEqual({ ...first, replayed: true });
    await expect(writeCustomerServiceEnrollment(db, actor, command("full-chain-revoke", "full-chain-key-revoke", ltds, "revoked", 1)))
      .resolves.toMatchObject({ state: "revoked", revision: 2, replayed: false });
  });

  it("denies new enrollment when the live customer area or division is inactive", async () => {
    await db.prepare("UPDATE native_business_areas SET active=0 WHERE id=?").bind(area).run();
    await expect(writeCustomerServiceEnrollment(db, actor, command("full-chain-area-off", "full-chain-key-area-off", ltt, "active", 0)))
      .rejects.toThrow(/denied/);
    await db.prepare("UPDATE native_business_areas SET active=1 WHERE id=?").bind(area).run();
    await db.prepare("UPDATE native_business_divisions SET active=0 WHERE id=?").bind(division).run();
    await expect(writeCustomerServiceEnrollment(db, actor, command("full-chain-division-off", "full-chain-key-division-off", ltt, "active", 0)))
      .rejects.toThrow(/denied/);
    expect(await db.prepare("SELECT count(*) count FROM operations_customer_service_enrollments WHERE service_id=?").bind(ltt)
      .first<number>("count")).toBe(0);
  });
});
