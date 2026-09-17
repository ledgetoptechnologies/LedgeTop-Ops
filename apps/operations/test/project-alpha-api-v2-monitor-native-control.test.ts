import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { applyNativeProjectAlphaApiV2MonitorLifecycle, NativeMonitorControlDenied,
  NativeMonitorControlOutcomeUnknown } from "../src/worker/project-alpha-api-v2-monitor-native-control";
import { applyProjectAlphaApiV2MonitorLifecycle, ProjectAlphaApiV2MonitorLifecycleConflict,
  readProjectAlphaApiV2MonitorLifecycle,
  type ProjectAlphaApiV2MonitorLifecycleIdentity } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";
import { recordProjectAlphaApiV2IncidentObservation } from "../src/worker/project-alpha-api-v2-incident-store";

const identity = {
  sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;
const another = { ...identity, sourceId: "project-alpha:secondary", baseUrl: "https://secondary.example.test",
  expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } as const;
const actor: AuthenticatedNativeStaffWithAdmissionVersion = Object.freeze({
  identity: Object.freeze({ kind: "native", staffId: "native-person",
    verifiedAccessSubject: "opaque:Person_1", email: "native@example.test",
    displayName: "Native Person", profileVersion: 1 }),
  admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z",
});
const allowId = "integration-monitor-allow";
const denyId = "integration-monitor-deny";

let runtime: Miniflare;
let database: D1Database;
beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files).toContain("0091_native_integration_control.sql");
  for (const file of files) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
  }
  await database.batch([
    database.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES('pa-admin','admin@example.test','PA Admin','active')"),
    database.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES('native-person','old@example.test','Old Name','inactive')"),
    database.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('native-person','opaque:Person_1',1,'pa-admin')`),
    database.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('native-person','native@example.test','Native Person')`),
  ]);
}, 120_000);
afterEach(async () => { await runtime.dispose(); });

const apply = (expectedRevision: number, enabled: boolean, identities: readonly ProjectAlphaApiV2MonitorLifecycleIdentity[],
  authenticatedNativeStaff: AuthenticatedNativeStaffWithAdmissionVersion = actor, db = database) =>
  applyNativeProjectAlphaApiV2MonitorLifecycle(db, {
    authenticatedNativeStaff, expectedRevision, enabled, identities,
  });
const count = (table: "native_integration_control_grants" | "native_integration_control_grant_history"
  | "project_alpha_api_v2_monitor_lifecycle_heads" | "project_alpha_api_v2_monitor_lifecycle_history"
  | "project_alpha_api_v2_monitor_operator_audit") =>
  database.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
const grant = (effect: "allow" | "deny", id = effect === "allow" ? allowId : denyId) =>
  database.prepare(`INSERT INTO native_integration_control_grants
    (id,actor_staff_id,capability,effect,scope_kind,active,version,granted_by)
    VALUES(?,'native-person','integrations.monitor.manage',?,'global',1,1,'native-person')`)
    .bind(id,effect).run();

describe("native attributed API-v2 monitor control", () => {
  it("seeds no authority and applies one exact audited lifecycle revision only with allow", async () => {
    expect(await count("native_integration_control_grants")).toBe(0);
    await expect(apply(0,true,[identity])).rejects.toBeInstanceOf(NativeMonitorControlDenied);
    expect(await count("project_alpha_api_v2_monitor_lifecycle_heads")).toBe(0);
    await grant("allow");
    expect(await apply(0,true,[identity])).toEqual({ revision: 1, enabled: true, identities: [identity] });
    const audit = await database.prepare(`SELECT lifecycle_revision,actor_staff_id,actor_access_subject,
      actor_admission_version,actor_profile_version,actor_email,allow_grant_id,allow_grant_version,
      enabled,identities_json FROM project_alpha_api_v2_monitor_operator_audit`).first<{
      lifecycle_revision: number; actor_staff_id: string; actor_access_subject: string;
      actor_admission_version: number; actor_profile_version: number; actor_email: string;
      allow_grant_id: string; allow_grant_version: number; enabled: number; identities_json: string;
    }>();
    expect(audit).toMatchObject({ lifecycle_revision: 1, actor_staff_id: "native-person",
      actor_access_subject: "opaque:Person_1", actor_admission_version: 1,
      actor_profile_version: 1, actor_email: "native@example.test",
      allow_grant_id: allowId, allow_grant_version: 1, enabled: 1 });
    expect(JSON.parse(audit!.identities_json)).toEqual([identity]);
    expect(await count("project_alpha_api_v2_monitor_lifecycle_history")).toBe(1);
    expect(await apply(1,true,[identity])).toMatchObject({ revision: 1 });
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
  });

  it("honors explicit deny and current grant revocation, including idempotent replay", async () => {
    await grant("allow");
    await grant("deny");
    await expect(apply(0,true,[identity])).rejects.toThrow("native_monitor_control_denied");
    await database.prepare(`UPDATE native_integration_control_grants
      SET active=0,version=2 WHERE id=?`).bind(denyId).run();
    await apply(0,true,[identity]);
    expect(await count("native_integration_control_grant_history")).toBe(3);
    await database.prepare(`UPDATE native_integration_control_grants
      SET active=0,version=2 WHERE id=?`).bind(allowId).run();
    await expect(apply(1,true,[identity])).rejects.toThrow("native_monitor_control_denied");
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
    await expect(database.prepare(`UPDATE native_integration_control_grant_history SET active=1`).run()).rejects.toThrow();
  });

  it("rejects stale subject, admission version, and expired verification before writing", async () => {
    await grant("allow");
    const changedSubject = { ...actor, identity: { ...actor.identity, verifiedAccessSubject: "opaque:Someone_Else" } };
    const staleAdmission = { ...actor, admissionVersion: 2 };
    const expired = { ...actor, verifiedUntil: "2000-01-01T00:00:00.000Z" };
    for (const current of [changedSubject, staleAdmission, expired]) {
      await expect(apply(0,true,[identity],current)).rejects.toThrow("native_monitor_control_denied");
    }
    expect(await count("project_alpha_api_v2_monitor_lifecycle_heads")).toBe(0);
  });

  it("rolls back lifecycle, retirement, and audit together on a late audit fault", async () => {
    await grant("allow");
    await apply(0,true,[identity]);
    await recordProjectAlphaApiV2IncidentObservation(database, { identity, monitorRevision: 1,
      expectedRevision: 0, observation: { kind: "probe", startedAt: 100,
        probe: { status: "unavailable", reason: "transport" } } });
    const beforeIncident = await database.prepare(`SELECT revision,state_json FROM project_alpha_api_v2_incident_heads
      WHERE source_id=?`).bind(identity.sourceId).first<{ revision: number; state_json: string }>();
    const beforeIncidentHistory = await database.prepare(`SELECT count(*) AS n
      FROM project_alpha_api_v2_incident_history`).first<number>("n");
    await database.prepare(`CREATE TRIGGER synthetic_operator_audit_failure BEFORE INSERT
      ON project_alpha_api_v2_monitor_operator_audit WHEN NEW.lifecycle_revision=2
      BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`).run();
    await expect(apply(1,false,[])).rejects.toBeInstanceOf(NativeMonitorControlOutcomeUnknown);
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toMatchObject({ revision: 1, identities: [identity] });
    expect(await count("project_alpha_api_v2_monitor_lifecycle_history")).toBe(1);
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
    expect(await database.prepare(`SELECT revision,state_json FROM project_alpha_api_v2_incident_heads
      WHERE source_id=?`).bind(identity.sourceId).first()).toEqual(beforeIncident);
    expect(await database.prepare(`SELECT count(*) AS n FROM project_alpha_api_v2_incident_history`).first("n"))
      .toBe(beforeIncidentHistory);
  });

  it("does not let the raw unaudited helper modify an attributed lifecycle head", async () => {
    await grant("allow");
    await apply(0,true,[identity]);
    await expect(applyProjectAlphaApiV2MonitorLifecycle(database,
      { expectedRevision: 1, enabled: true, identities: [identity, another] })).rejects.toThrow();
    await expect(database.prepare(`UPDATE project_alpha_api_v2_monitor_lifecycle_heads
      SET revision=2,operator_command_id=? WHERE lifecycle_id=1 AND revision=1`)
      .bind("11111111-1111-4111-8111-111111111111").run()).rejects.toThrow();
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
    expect(await count("project_alpha_api_v2_monitor_lifecycle_history")).toBe(1);
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toMatchObject({ revision: 1 });
  });

  it("cannot reuse an older audited command to satisfy the deferred head foreign key", async () => {
    await grant("allow");
    await apply(0,true,[identity]);
    const oldCommand = await database.prepare(`SELECT command_id FROM project_alpha_api_v2_monitor_operator_audit
      WHERE lifecycle_revision=1`).first<string>("command_id");
    await apply(1,true,[identity,another]);
    await expect(database.prepare(`UPDATE project_alpha_api_v2_monitor_lifecycle_heads
      SET revision=3,operator_command_id=? WHERE lifecycle_id=1 AND revision=2`)
      .bind(oldCommand).run()).rejects.toThrow();
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(2);
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toMatchObject({ revision: 2 });
  });

  it("attributes a same-configuration takeover of a raw legacy head", async () => {
    await applyProjectAlphaApiV2MonitorLifecycle(database,
      { expectedRevision: 0, enabled: true, identities: [identity] });
    await grant("allow");
    expect(await apply(1,true,[identity])).toMatchObject({ revision: 2, enabled: true });
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
    expect(await count("project_alpha_api_v2_monitor_lifecycle_history")).toBe(2);
  });

  it("fences grant revocation immediately before the D1 batch and rolls back", async () => {
    await grant("allow");
    const intercepted = new Proxy(database, { get(target, property, receiver) {
      if (property === "withSession") return (mode: "first-primary" | "first-unconstrained") => {
        const session = target.withSession(mode);
        return new Proxy(session, { get(inner, key) {
          if (key === "batch") return async (statements: D1PreparedStatement[]) => {
            await database.prepare(`UPDATE native_integration_control_grants
              SET active=0,version=2 WHERE id=?`).bind(allowId).run();
            return inner.batch(statements);
          };
          const value = Reflect.get(inner,key);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target,property,receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(apply(0,true,[identity],actor,intercepted)).rejects.toBeInstanceOf(NativeMonitorControlOutcomeUnknown);
    expect(await count("project_alpha_api_v2_monitor_lifecycle_heads")).toBe(0);
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(0);
  });

  it("fences revoke-and-regrant version changes after preflight", async () => {
    await grant("allow");
    const intercepted = new Proxy(database, { get(target, property, receiver) {
      if (property === "withSession") return (mode: "first-primary" | "first-unconstrained") => {
        const session = target.withSession(mode);
        return new Proxy(session, { get(inner, key) {
          if (key === "batch") return async (statements: D1PreparedStatement[]) => {
            await database.prepare(`UPDATE native_integration_control_grants
              SET active=0,version=2 WHERE id=?`).bind(allowId).run();
            await database.prepare(`UPDATE native_integration_control_grants
              SET active=1,version=3 WHERE id=?`).bind(allowId).run();
            return inner.batch(statements);
          };
          const value = Reflect.get(inner,key);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target,property,receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(apply(0,true,[identity],actor,intercepted)).rejects.toBeInstanceOf(NativeMonitorControlOutcomeUnknown);
    expect(await count("project_alpha_api_v2_monitor_lifecycle_heads")).toBe(0);
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(0);
  });

  it("rechecks authority immediately before an attributed no-op response", async () => {
    await grant("allow");
    await apply(0,true,[identity]);
    let interceptedRead = false;
    const intercepted = new Proxy(database, { get(target, property, receiver) {
      if (property === "withSession") return (mode: "first-primary" | "first-unconstrained") => {
        const session = target.withSession(mode);
        return new Proxy(session, { get(inner, key) {
          if (key === "prepare") return (sql: string) => {
            const prepared = inner.prepare(sql);
            if (!sql.includes("SELECT EXISTS(") || !sql.includes("project_alpha_api_v2_monitor_operator_audit"))
              return prepared;
            return new Proxy(prepared, { get(statement, part) {
              if (part === "bind") return (...values: unknown[]) => {
                const bound = statement.bind(...values);
                return new Proxy(bound, { get(item, operation) {
                  if (operation === "first") return async () => {
                    interceptedRead = true;
                    await database.prepare(`UPDATE native_integration_control_grants
                      SET active=0,version=2 WHERE id=?`).bind(allowId).run();
                    return item.first();
                  };
                  const value = Reflect.get(item,operation);
                  return typeof value === "function" ? value.bind(item) : value;
                } });
              };
              const value = Reflect.get(statement,part);
              return typeof value === "function" ? value.bind(statement) : value;
            } });
          };
          const value = Reflect.get(inner,key);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target,property,receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(apply(1,true,[identity],actor,intercepted)).rejects.toThrow("native_monitor_control_denied");
    expect(interceptedRead).toBe(true);
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
  });

  it("reports a sanitized unknown result when D1 commits then loses the acknowledgement", async () => {
    await grant("allow");
    const intercepted = new Proxy(database, { get(target, property, receiver) {
      if (property === "withSession") return (mode: "first-primary" | "first-unconstrained") => {
        const session = target.withSession(mode);
        return new Proxy(session, { get(inner, key) {
          if (key === "batch") return async (statements: D1PreparedStatement[]) => {
            await inner.batch(statements);
            throw Error("synthetic transport failure with sensitive details");
          };
          const value = Reflect.get(inner,key);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target,property,receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(apply(0,true,[identity],actor,intercepted))
      .rejects.toMatchObject({ name: "NativeMonitorControlOutcomeUnknown",
        message: "native_monitor_control_outcome_unknown" });
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toMatchObject({ revision: 1, enabled: true });
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
    await expect(apply(0,true,[identity])).rejects.toBeInstanceOf(ProjectAlphaApiV2MonitorLifecycleConflict);
    expect(await apply(1,true,[identity])).toMatchObject({ revision: 1, enabled: true });
    expect(await count("project_alpha_api_v2_monitor_operator_audit")).toBe(1);
  });
});
