import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeCustomerServiceEnrollment } from "../src/worker/ops-customer-service-enrollments";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

describe("0146 Operations customer service enrollments", () => {
  let runtime: Miniflare;
  let db: D1Database;
  const customerA = "ops/client/customer-a";
  const customerB = "ops/client/customer-b";
  const organization = "ops/org/not-a-customer";
  const staff = "staff-enrollment";
  const ltds = "service/ltds/inspection";
  const ltt = "service/ltt/inspection";

  const actor: AuthenticatedNativeStaffWithAdmissionVersion = { identity: { kind: "native", staffId: staff,
    verifiedAccessSubject: "access:staff-enrollment", profileVersion: 1, email: "staff@example.test", displayName: "Staff" },
    admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z" };
  function command(input: { id: string; customer?: string; service?: string; state?: "active" | "revoked"; expected?: number; key?: string }) {
    return { mutationId: input.id, idempotencyKey: input.key ?? `idempotency-${input.id}`, customerRecordId: input.customer ?? customerA,
      serviceId: input.service ?? ltds, desiredState: input.state ?? "active", expectedRevision: input.expected ?? 0 };
  }
  const apply = (input: Parameters<typeof command>[0]) => writeCustomerServiceEnrollment(db, actor, command(input));

  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}", d1Databases: { OPS_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT NOT NULL,current_version INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
      db.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER)"),
      db.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      db.prepare("CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)"),
      db.prepare("CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER)"),
      db.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)"),
      db.prepare("CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER)"),
      db.prepare("CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER)"),
      db.prepare("INSERT INTO native_staff_admissions VALUES(?,?,1,1)").bind(staff, "access:staff-enrollment"),
      db.prepare("INSERT INTO native_staff_profiles VALUES(?,1)").bind(staff),
      db.prepare("INSERT INTO native_directory_grant_generations VALUES(?,1)").bind(staff),
      db.prepare("INSERT INTO native_directory_grants(staff_id,permission,effect,active,scope_kind,resource_id) VALUES(?,'directory.enrollment.manage','allow',1,'resource',?)").bind(staff, customerA),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(customerA),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(customerB),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(organization),
    ]);
    const sql = readFileSync(new URL("../migrations/0146_ops_customer_service_enrollments.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    await db.batch([
      db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
        .bind(ltds, "ltds", "ltds:catalog", "inspection", "Inspection"),
      db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
        .bind(ltt, "ltt", "ltt:catalog", "inspection", "Inspection"),
    ]);
  });
  afterEach(async () => { await runtime.dispose(); });

  it("keeps same-named LTDS and LTT services source-qualified and separately enrolled", async () => {
    await apply({ id: "ltds-active" });
    await apply({ id: "ltt-active", service: ltt });
    expect((await db.prepare("SELECT provider_id,source_id,source_service_id,display_name FROM operations_service_definitions ORDER BY provider_id").all()).results)
      .toEqual([{ provider_id: "ltds", source_id: "ltds:catalog", source_service_id: "inspection", display_name: "Inspection" },
        { provider_id: "ltt", source_id: "ltt:catalog", source_service_id: "inspection", display_name: "Inspection" }]);
    expect((await db.prepare("SELECT service_id,state,revision FROM operations_customer_service_enrollments WHERE customer_record_id=? ORDER BY service_id").bind(customerA).all()).results)
      .toEqual([{ service_id: ltds, state: "active", revision: 1 }, { service_id: ltt, state: "active", revision: 1 }]);
  });

  it("requires canonical provider and source identities", async () => {
    await expect(db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
      .bind(" service/bad-id", "ltds", "ltds:catalog", "bad-id", "Bad").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
      .bind("service/bad", " ltds", "ltds:catalog", "bad", "Bad").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO operations_service_definitions(service_id,provider_id,source_id,source_service_id,display_name) VALUES(?,?,?,?,?)")
      .bind("service/bad-source", "ltds", "ltds:catalog ", "bad", "Bad").run()).rejects.toThrow();
  });

  it("records revoke as a durable exact-revision transition", async () => {
    await apply({ id: "grant" });
    await apply({ id: "revoke", state: "revoked", expected: 1 });
    expect(await db.prepare("SELECT state,revision,last_mutation_id FROM operations_customer_service_enrollments WHERE customer_record_id=? AND service_id=?")
      .bind(customerA, ltds).first()).toEqual({ state: "revoked", revision: 2, last_mutation_id: "revoke" });
    await expect(db.prepare("DELETE FROM operations_customer_service_enrollments WHERE customer_record_id=? AND service_id=?").bind(customerA, ltds).run())
      .rejects.toThrow(/durable/);
  });

  it("rejects stale revisions and retains the current enrollment", async () => {
    await apply({ id: "grant" });
    await apply({ id: "revoke", state: "revoked", expected: 1 });
    await expect(apply({ id: "stale", state: "active", expected: 1 })).rejects.toThrow(/denied/);
    expect(await db.prepare("SELECT state,revision FROM operations_customer_service_enrollments WHERE customer_record_id=? AND service_id=?")
      .bind(customerA, ltds).first()).toEqual({ state: "revoked", revision: 2 });
  });

  it("returns an exact idempotent receipt and rejects idempotency drift", async () => {
    const first = await apply({ id: "grant", key: "idempotency-retry-0001" });
    await expect(apply({ id: "grant", key: "idempotency-retry-0001" })).resolves.toEqual({ ...first, replayed: true });
    await expect(apply({ id: "drift", key: "idempotency-retry-0001", service: ltt })).rejects.toThrow(/denied/);
    await expect(apply({ id: "grant", key: "idempotency-retry-0001", customer: customerB })).rejects.toThrow(/denied/);
    await expect(apply({ id: "grant", key: "idempotency-retry-0001", state: "revoked" })).rejects.toThrow(/denied/);
    await expect(apply({ id: "grant", key: "idempotency-retry-0001", expected: 1 })).rejects.toThrow(/denied/);
    await expect(apply({ id: "grant", key: "idempotency-retry-0001 ", service: ltds })).rejects.toThrow(/denied/);
    expect(await db.prepare("SELECT count(*) count FROM operations_customer_service_enrollment_mutations WHERE actor_staff_id=? AND idempotency_key=?")
      .bind(staff, "idempotency-retry-0001").first<number>("count")).toBe(1);
    expect(await db.prepare("SELECT revision FROM operations_customer_service_enrollments WHERE customer_record_id=? AND service_id=?")
      .bind(customerA, ltds).first<number>("revision")).toBe(1);
  });

  it("replays an exact request after a still-authorized profile and generation rotation", async () => {
    const input = command({ id: "grant", key: "idempotency-rotation-01" });
    const first = await writeCustomerServiceEnrollment(db, actor, input);
    await db.batch([
      db.prepare("UPDATE native_staff_profiles SET version=2 WHERE staff_id=?").bind(staff),
      db.prepare("UPDATE native_directory_grant_generations SET generation=2 WHERE staff_id=?").bind(staff),
    ]);
    const rotated = { ...actor, identity: { ...actor.identity, profileVersion: 2 } };
    await expect(writeCustomerServiceEnrollment(db, rotated, input)).resolves.toEqual({ ...first, replayed: true });
  });

  it("requires an exact customer record and never crosses customer heads", async () => {
    await expect(apply({ id: "organization", customer: organization })).rejects.toThrow(/denied/);
    await apply({ id: "customer-a" });
    await expect(db.prepare(`INSERT INTO operations_customer_service_enrollments
      (customer_record_id,service_id,state,revision,last_mutation_id) VALUES(?,?,?,?,?)`).bind(customerB, ltds, "active", 1, "customer-a").run())
      .rejects.toThrow(/exact initial mutation/);
    expect(await db.prepare("SELECT count(*) count FROM operations_customer_service_enrollments WHERE customer_record_id=?")
      .bind(customerB).first<number>("count")).toBe(0);
  });

  it("rolls back the mutation when the batch head statement is rejected", async () => {
    await db.prepare(`CREATE TRIGGER injected_enrollment_head_failure BEFORE INSERT ON operations_customer_service_enrollments
      BEGIN SELECT RAISE(ABORT,'injected head failure'); END`).run();
    await expect(apply({ id: "rolled-back", key: "idempotency-rollback-01" })).rejects.toThrow(/denied/);
    expect(await db.prepare("SELECT count(*) count FROM operations_customer_service_enrollment_mutations WHERE mutation_id='rolled-back'")
      .first<number>("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM operations_customer_service_enrollments WHERE customer_record_id=?").bind(customerA)
      .first<number>("count")).toBe(0);
  });

  it("fails closed when a scoped allow is denied or the staff authority versions drift", async () => {
    await db.prepare("INSERT INTO native_directory_grants(staff_id,permission,effect,active,scope_kind,resource_id) VALUES(?,'directory.enrollment.manage','deny',1,'resource',?)")
      .bind(staff, customerA).run();
    await expect(apply({ id: "denied" })).rejects.toThrow(/denied/);
    await db.prepare("DELETE FROM native_directory_grants WHERE effect='deny'").run();
    await db.prepare("UPDATE native_staff_profiles SET version=2 WHERE staff_id=?").bind(staff).run();
    await expect(apply({ id: "profile-stale" })).rejects.toThrow(/denied/);
  });

  it("rejects invalid expiry, unsafe revisions, and inactive scope references", async () => {
    await expect(writeCustomerServiceEnrollment(db, { ...actor, verifiedUntil: "not-a-date" }, command({ id: "bad-expiry" })))
      .rejects.toThrow(/denied/);
    await expect(apply({ id: "unsafe", expected: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/denied/);
    await db.prepare("DELETE FROM native_directory_grants WHERE staff_id=?").bind(staff).run();
    await db.batch([
      db.prepare("INSERT INTO native_business_areas VALUES('inactive-area',0)"),
      db.prepare("INSERT INTO native_directory_resource_scopes VALUES(?,1,'inactive-area',NULL)").bind(customerA),
      db.prepare("INSERT INTO native_directory_grants(staff_id,permission,effect,active,scope_kind,business_area_id) VALUES(?,'directory.enrollment.manage','allow',1,'business_area','inactive-area')").bind(staff),
    ]);
    await expect(apply({ id: "inactive-area" })).rejects.toThrow(/denied/);
    await db.batch([
      db.prepare("UPDATE native_business_areas SET active=1 WHERE id='inactive-area'"),
      db.prepare("INSERT INTO native_business_divisions VALUES('inactive-division','inactive-area',0)"),
      db.prepare("UPDATE native_directory_resource_scopes SET division_id='inactive-division' WHERE record_id=?").bind(customerA),
      db.prepare("UPDATE native_directory_grants SET scope_kind='division',business_area_id=NULL,division_id='inactive-division' WHERE staff_id=?").bind(staff),
    ]);
    await expect(apply({ id: "inactive-division" })).rejects.toThrow(/denied/);
    await db.batch([
      db.prepare("DELETE FROM native_directory_grants WHERE staff_id=?").bind(staff),
      db.prepare("INSERT INTO native_directory_assignments VALUES(?,?,0)").bind(customerA, staff),
      db.prepare("INSERT INTO native_directory_grants(staff_id,permission,effect,active,scope_kind) VALUES(?,'directory.enrollment.manage','allow',1,'assigned')").bind(staff),
    ]);
    await expect(apply({ id: "inactive-assignment" })).rejects.toThrow(/denied/);
  });
});
