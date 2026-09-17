import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { applyNativeProjectAlphaApiV2MonitorLifecycle } from "../src/worker/project-alpha-api-v2-monitor-native-control";
import { applyProjectAlphaApiV2MonitorLifecycle } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";
import { readProjectAlphaApiV2MonitorControl,
  ProjectAlphaApiV2MonitorControlReadUnavailableError } from "../src/worker/project-alpha-api-v2-monitor-control-read";

const identity = {
  sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;
const actor: AuthenticatedNativeStaffWithAdmissionVersion = Object.freeze({
  identity: Object.freeze({ kind: "native" as const, staffId: "native-person",
    verifiedAccessSubject: "opaque:Person_1", email: "native@example.test",
    displayName: "Native Person", profileVersion: 1 }),
  admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z",
});
const allowId = "integration-monitor-allow";

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

function grant(): Promise<unknown> {
  return database.prepare(`INSERT INTO native_integration_control_grants
    (id,actor_staff_id,capability,effect,scope_kind,active,version,granted_by)
    VALUES(?,'native-person','integrations.monitor.manage','allow','global',1,1,'native-person')`)
    .bind(allowId).run();
}

describe("native API-v2 monitor control readback", () => {
  it("fails closed without an active native admission and allow grant", async () => {
    await expect(readProjectAlphaApiV2MonitorControl(database, actor)).rejects
      .toThrow("native_monitor_control_read_denied");
    await grant();
    await database.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id=?")
      .bind(actor.identity.staffId).run();
    await expect(readProjectAlphaApiV2MonitorControl(database, actor)).rejects
      .toThrow("native_monitor_control_read_denied");
  });

  it("returns the inactive default with only current native authority and no head", async () => {
    await grant();
    const result = await readProjectAlphaApiV2MonitorControl(database, actor);
    expect(result).toEqual({ revision: 0, enabled: false, attributed: false });
    expect(Object.keys(result)).toEqual(["revision", "enabled", "attributed"]);
  });

  it("reports a primary read failure as unavailable rather than denied or default-disabled", async () => {
    const brokenDatabase = {
      withSession() {
        return { prepare() {
          return { bind() { return { all: async () => { throw new Error("private database detail"); } }; } };
        } };
      },
    } as unknown as D1Database;
    await expect(readProjectAlphaApiV2MonitorControl(brokenDatabase, actor))
      .rejects.toBeInstanceOf(ProjectAlphaApiV2MonitorControlReadUnavailableError);
  });

  it("reads an attributed current head without exposing identities", async () => {
    await grant();
    await applyNativeProjectAlphaApiV2MonitorLifecycle(database, {
      authenticatedNativeStaff: actor, expectedRevision: 0, enabled: true, identities: [identity],
    });
    const attributed = await readProjectAlphaApiV2MonitorControl(database, actor);
    expect(attributed).toEqual({ revision: 1, enabled: true, attributed: true });
    expect(JSON.stringify(attributed)).not.toContain(identity.sourceId);

  });

  it("surfaces a legacy null-attribution head only as an explicit takeover marker", async () => {
    await grant();
    await applyProjectAlphaApiV2MonitorLifecycle(database,
      { expectedRevision: 0, enabled: true, identities: [identity] });
    await expect(readProjectAlphaApiV2MonitorControl(database, actor)).resolves
      .toEqual({ revision: 1, enabled: true, attributed: false });
  });

  it("rejects revoked or stale native authority without writes", async () => {
    await grant();
    const before = await database.prepare("SELECT count(*) AS n FROM project_alpha_api_v2_monitor_operator_audit")
      .first<number>("n");
    const staleSubject = { ...actor, identity: { ...actor.identity, verifiedAccessSubject: "opaque:Someone_Else" } };
    const staleAdmission = { ...actor, admissionVersion: 2 };
    const staleProfile = { ...actor, identity: { ...actor.identity, profileVersion: 2 } };
    for (const stale of [staleSubject, staleAdmission, staleProfile]) {
      await expect(readProjectAlphaApiV2MonitorControl(database, stale)).rejects
        .toThrow("native_monitor_control_read_denied");
    }
    await database.prepare(`INSERT INTO native_integration_control_grants
      (id,actor_staff_id,capability,effect,scope_kind,active,version,granted_by)
      VALUES('integration-monitor-deny','native-person','integrations.monitor.manage','deny','global',1,1,'native-person')`).run();
    await expect(readProjectAlphaApiV2MonitorControl(database, actor)).rejects
      .toThrow("native_monitor_control_read_denied");
    await database.prepare("UPDATE native_integration_control_grants SET active=0,version=2 WHERE id='integration-monitor-deny'").run();
    await expect(readProjectAlphaApiV2MonitorControl(database, actor)).resolves
      .toEqual({ revision: 0, enabled: false, attributed: false });
    await database.prepare("UPDATE native_integration_control_grants SET active=0,version=2 WHERE id=?")
      .bind(allowId).run();
    await expect(readProjectAlphaApiV2MonitorControl(database, actor)).rejects
      .toThrow("native_monitor_control_read_denied");
    const after = await database.prepare("SELECT count(*) AS n FROM project_alpha_api_v2_monitor_operator_audit")
      .first<number>("n");
    expect(after).toBe(before);
  });

  it("rejects a current head whose attribution audit witness is missing", async () => {
    const secondary = { ...identity, sourceId: "project-alpha:secondary",
      applicationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      expectedSourceInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      expectedHistoryEpoch: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    const malformedRow = {
      bound_access_subject: actor.identity.verifiedAccessSubject, admission_active: 1,
      admission_version: 1, profile_version: 1, login_email: actor.identity.email,
      grant_id: allowId, grant_version: 1, grant_capability: "integrations.monitor.manage",
      grant_effect: "allow", grant_scope_kind: "global", grant_active: 1,
      lifecycle_id: 1, revision: 1, enabled: 1,
      identities_json: JSON.stringify([identity, secondary]),
      operator_command_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", audited: 0,
    };
    const malformedDatabase = { withSession: () => ({ prepare: () => ({
      bind: () => ({ all: async () => ({ success: true, results: [malformedRow] }) }),
    }) }) } as unknown as D1Database;
    await expect(readProjectAlphaApiV2MonitorControl(malformedDatabase, actor)).rejects
      .toThrow("native_monitor_control_read_denied");
  });
});
