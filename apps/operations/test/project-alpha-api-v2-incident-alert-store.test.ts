import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { ProjectAlphaApiV2IncidentIdentity } from "../src/worker/project-alpha-api-v2-incident-policy";
import { readProjectAlphaApiV2Incident, recordProjectAlphaApiV2IncidentObservation }
  from "../src/worker/project-alpha-api-v2-incident-store";
import { ProjectAlphaApiV2IncidentAlertConflict, transitionProjectAlphaApiV2IncidentAlert }
  from "../src/worker/project-alpha-api-v2-incident-alert-store";
import { applyProjectAlphaApiV2MonitorLifecycle }
  from "../src/worker/project-alpha-api-v2-monitor-lifecycle";

const identity: ProjectAlphaApiV2IncidentIdentity = {
  sourceId: "project-alpha:primary",
  applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://alpha.example.test",
  expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const unavailable = { status: "unavailable", reason: "transport" } as const;
let runtime: Miniflare;
let database: D1Database;
beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files).toContain("0089_project_alpha_api_v2_monitor_lifecycle.sql");
  for (const file of files) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
  }
  await applyProjectAlphaApiV2MonitorLifecycle(database,
    { expectedRevision: 0, enabled: true, identities: [identity] });
}, 120_000);
afterEach(async () => { await runtime.dispose(); });

async function unavailableSince(startedAt = 0) {
  return recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 0, monitorRevision: 1,
    observation: { kind: "probe", startedAt, probe: unavailable } });
}
function claim(expectedRevision: number, at: number) {
  return transitionProjectAlphaApiV2IncidentAlert(database,
    { action: "claim", identity, expectedRevision, monitorRevision: 1, at });
}
function action(action: "attempt" | "failed" | "sent", expectedRevision: number, at: number,
  incidentSequence: number, claimSequence: number, leaseToken: string) {
  return transitionProjectAlphaApiV2IncidentAlert(database,
    { action, identity, expectedRevision, at, incidentSequence, claimSequence, leaseToken,
      ...(action === "attempt" ? { monitorRevision: 1 } : {}) });
}
function count(table: "project_alpha_api_v2_incident_alerts" | "project_alpha_api_v2_incident_alert_events"
  | "project_alpha_api_v2_incident_history") {
  return database.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)");
}

describe("Project Alpha API-v2 durable owner alert transitions", () => {
  it("requires an exact active monitor revision for claim and attempt, not for final facts", async () => {
    await unavailableSince();
    await expect(transitionProjectAlphaApiV2IncidentAlert(database,
      { action: "claim", identity, expectedRevision: 1, at: 600_001 }))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    await expect(transitionProjectAlphaApiV2IncidentAlert(database,
      { action: "claim", identity, expectedRevision: 1, monitorRevision: 2, at: 600_001 }))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(0);
    const held = await claim(1, 600_001);
    await expect(transitionProjectAlphaApiV2IncidentAlert(database,
      { action: "attempt", identity, expectedRevision: 2, at: 600_002,
        incidentSequence: 1, claimSequence: 1, leaseToken: held.leaseToken! }))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    await applyProjectAlphaApiV2MonitorLifecycle(database,
      { expectedRevision: 1, enabled: false, identities: [] });
    expect(await readProjectAlphaApiV2Incident(database,identity)).toMatchObject({ revision: 3,
      state: { category: "disabled", alertClaimedAt: null } });
    await expect(action("attempt", 3, 600_002, 1, 1, held.leaseToken!))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await count("project_alpha_api_v2_incident_alert_events")).toBe(1);
  });

  it("rolls back a claim if lifecycle changes after its incident head update", async () => {
    await unavailableSince();
    await database.prepare(`CREATE TRIGGER synthetic_monitor_change_during_claim
      BEFORE INSERT ON project_alpha_api_v2_incident_alerts
      BEGIN UPDATE project_alpha_api_v2_monitor_lifecycle_heads
        SET revision=revision+1,enabled=0,identities_json='[]' WHERE lifecycle_id=1; END`).run();
    await expect(claim(1, 600_001)).rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await readProjectAlphaApiV2Incident(database,identity)).toMatchObject({ revision: 1,
      state: { alertClaimedAt: null } });
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(0);
    expect(await database.prepare(`SELECT revision FROM project_alpha_api_v2_monitor_lifecycle_heads`)
      .first("revision")).toBe(1);
  });

  it("rolls back an attempt if lifecycle changes after its incident head update", async () => {
    await unavailableSince();
    const held = await claim(1, 600_001);
    await database.prepare(`CREATE TRIGGER synthetic_monitor_change_during_attempt
      BEFORE UPDATE ON project_alpha_api_v2_incident_alerts
      BEGIN UPDATE project_alpha_api_v2_monitor_lifecycle_heads
        SET revision=revision+1,enabled=0,identities_json='[]' WHERE lifecycle_id=1; END`).run();
    await expect(action("attempt",2,600_002,1,1,held.leaseToken!))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await readProjectAlphaApiV2Incident(database,identity)).toMatchObject({ revision: 2,
      state: { alertAttemptedAt: null } });
    expect(await database.prepare(`SELECT attempt_count FROM project_alpha_api_v2_incident_alerts`)
      .first("attempt_count")).toBe(0);
    expect(await database.prepare(`SELECT revision FROM project_alpha_api_v2_monitor_lifecycle_heads`)
      .first("revision")).toBe(1);
  });

  it("enforces strictly >10 minutes and one logical claim through attempt, failure, retry and sent", async () => {
    await unavailableSince();
    expect(await claim(1, 599_999)).toMatchObject({ status: "not_due", headRevision: 1 });
    expect(await claim(1, 600_000)).toMatchObject({ status: "not_due", headRevision: 1 });
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(0);
    const first = await claim(1, 600_001);
    expect(first).toMatchObject({ status: "claimed", headRevision: 2, incidentSequence: 1, claimSequence: 1,
      nextAttemptAt: 690_001 });
    expect(first.leaseToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await claim(2, 600_002)).toMatchObject({ status: "not_due", headRevision: 2 });
    const attempted = await action("attempt", 2, 600_003, 1, 1, first.leaseToken!);
    expect(attempted).toMatchObject({ status: "attempted", headRevision: 3 });
    const failed = await action("failed", 3, 600_004, 1, 1, first.leaseToken!);
    expect(failed).toMatchObject({ status: "retry", headRevision: 4, nextAttemptAt: 660_004 });
    expect(await claim(4, 660_003)).toMatchObject({ status: "not_due" });
    const retried = await claim(4, 660_004);
    expect(retried).toMatchObject({ status: "claimed", headRevision: 5, incidentSequence: 1, claimSequence: 2 });
    expect(retried.leaseToken).not.toBe(first.leaseToken);
    await expect(action("sent", 5, 660_005, 1, 1, first.leaseToken!))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    const reattempted = await action("attempt", 5, 660_005, 1, 2, retried.leaseToken!);
    expect(reattempted.status).toBe("attempted");
    const sent = await action("sent", 6, 660_006, 1, 2, retried.leaseToken!);
    expect(sent).toMatchObject({ status: "sent", headRevision: 7, state: { alertSentAt: 660_006 } });
    expect(await claim(7, 900_000)).toMatchObject({ status: "not_due" });
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(1);
    expect(await count("project_alpha_api_v2_incident_alert_events")).toBe(6);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(7);
  });

  it("reclaims a crashed pre-attempt lease only after expiry plus bounded backoff", async () => {
    await unavailableSince();
    const old = await claim(1, 600_001);
    expect(await claim(2, 660_001)).toMatchObject({ status: "not_due" });
    expect(await claim(2, 690_000)).toMatchObject({ status: "not_due" });
    const reclaimed = await claim(2, 690_001);
    expect(reclaimed).toMatchObject({ status: "claimed", headRevision: 3, claimSequence: 2,
      state: { alertClaimedAt: 690_001, alertAttemptedAt: null } });
    expect(reclaimed.leaseToken).not.toBe(old.leaseToken);
    await expect(action("attempt", 3, 690_002, 1, 1, old.leaseToken!))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(1);
    expect(await count("project_alpha_api_v2_incident_alert_events")).toBe(2);
  });

  it("requires reconciliation after an attempted lease expires without a recorded outcome", async () => {
    await unavailableSince();
    const held = await claim(1, 600_001);
    await action("attempt", 2, 600_002, 1, 1, held.leaseToken!);
    expect(await claim(3, 660_000)).toMatchObject({ status: "not_due", headRevision: 3 });
    expect(await claim(3, 660_001)).toMatchObject({ status: "reconciliation_required",
      headRevision: 3, claimSequence: 1 });
    expect(await claim(3, 900_000)).toMatchObject({ status: "reconciliation_required",
      headRevision: 3, claimSequence: 1 });
    expect(await count("project_alpha_api_v2_incident_alert_events")).toBe(2);
    expect(await database.prepare(`SELECT revision,claim_sequence,lease_token,attempt_count
      FROM project_alpha_api_v2_incident_alerts`).first()).toMatchObject({
      revision: 2, claim_sequence: 1, lease_token: held.leaseToken, attempt_count: 1 });
    // A late accepted acknowledgement may still settle the exact current claim.
    expect(await action("sent", 3, 900_001, 1, 1, held.leaseToken!))
      .toMatchObject({ status: "sent", headRevision: 4 });
  });

  it("reclaims an unattempted fresh claim even when older failed claims incremented attempt_count", async () => {
    await unavailableSince();
    const first = await claim(1, 600_001);
    await action("attempt", 2, 600_002, 1, 1, first.leaseToken!);
    await action("failed", 3, 600_004, 1, 1, first.leaseToken!);
    const fresh = await claim(4, 660_004);
    expect(fresh).toMatchObject({ status: "claimed", headRevision: 5, claimSequence: 2,
      state: { alertAttemptedAt: null } });
    expect(await claim(5, 720_004)).toMatchObject({ status: "not_due" });
    expect(await claim(5, 750_004)).toMatchObject({ status: "claimed", headRevision: 6,
      claimSequence: 3, state: { alertAttemptedAt: null } });
    expect(await database.prepare(`SELECT attempt_count,claim_sequence
      FROM project_alpha_api_v2_incident_alerts`).first()).toMatchObject({
      attempt_count: 1, claim_sequence: 3 });
  });

  it("uses head revision CAS; concurrent claimants cannot create two alert intents", async () => {
    await unavailableSince();
    const results = await Promise.allSettled([claim(1, 600_001), claim(1, 600_001)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason)
      .toBeInstanceOf(ProjectAlphaApiV2IncidentAlertConflict);
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(1);
    expect(await count("project_alpha_api_v2_incident_alert_events")).toBe(1);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(2);
  });

  it("recovery or disablement leaves an old lease non-actionable without recording sent", async () => {
    await unavailableSince();
    const held = await claim(1, 600_001);
    await recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 2, monitorRevision: 1,
      observation: { kind: "probe", startedAt: 700_000,
        probe: { status: "verified", sourceInstanceId: identity.expectedSourceInstanceId,
          applicationId: identity.applicationId, historyEpoch: identity.expectedHistoryEpoch,
          requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", grantedCapabilities: [] } } });
    await expect(action("attempt", 3, 700_001, 1, 1, held.leaseToken!))
      .rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await claim(3, 800_000)).toMatchObject({ status: "not_due" });
    expect(await database.prepare("SELECT status FROM project_alpha_api_v2_incident_alerts").first("status"))
      .toBe("leased");
    expect(await readProjectAlphaApiV2Incident(database, identity)).toMatchObject({
      revision: 3, state: { category: "verified", alertSentAt: null } });
    await applyProjectAlphaApiV2MonitorLifecycle(database,
      { expectedRevision: 1, enabled: false, identities: [] });
    expect(await readProjectAlphaApiV2Incident(database,identity)).toMatchObject({ revision: 4,
      state: { category: "disabled", alertSentAt: null } });
    expect(await claim(4, 1_600_001)).toMatchObject({ status: "not_due" });
  });

  it("rolls back head/history/outbox if the final assertion event insert fails", async () => {
    await unavailableSince();
    await database.prepare(`CREATE TRIGGER synthetic_alert_event_fault
      BEFORE INSERT ON project_alpha_api_v2_incident_alert_events
      BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END`).run();
    await expect(claim(1, 600_001)).rejects.toThrow("project_alpha_api_v2_incident_alert_denied");
    expect(await readProjectAlphaApiV2Incident(database, identity)).toMatchObject({ revision: 1,
      state: { alertClaimedAt: null } });
    expect(await count("project_alpha_api_v2_incident_alerts")).toBe(0);
    expect(await count("project_alpha_api_v2_incident_alert_events")).toBe(0);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(1);
  });
});
