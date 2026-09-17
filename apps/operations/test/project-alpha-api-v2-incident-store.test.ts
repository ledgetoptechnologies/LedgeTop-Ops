import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { ProjectAlphaApiV2Probe } from "../src/worker/project-alpha-api-v2";
import type { ProjectAlphaApiV2IncidentIdentity } from "../src/worker/project-alpha-api-v2-incident-policy";
import {
  ProjectAlphaApiV2IncidentStoreConflict,
  readProjectAlphaApiV2Incident,
  recordProjectAlphaApiV2IncidentObservation,
} from "../src/worker/project-alpha-api-v2-incident-store";
import { applyProjectAlphaApiV2MonitorLifecycle } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";

const identity: ProjectAlphaApiV2IncidentIdentity = {
  sourceId: "project-alpha:primary",
  applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://alpha.example.test",
  expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const secondIdentity = { ...identity, sourceId: "project-alpha:secondary", baseUrl: "https://other.example.test",
  expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
const transport = { status: "unavailable", reason: "transport" } as const;
const denied = { status: "unauthorized", reason: "credentials_or_scope", httpStatus: 403 } as const;
const verified: ProjectAlphaApiV2Probe = { status: "verified", sourceInstanceId: identity.expectedSourceInstanceId,
  applicationId: identity.applicationId, historyEpoch: identity.expectedHistoryEpoch,
  requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", grantedCapabilities: ["api.capabilities.read"] };

let runtime: Miniflare;
let database: D1Database;
beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files).toContain("0087_project_alpha_api_v2_incidents.sql");
  for (const file of files) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
  }
  await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 0, enabled: true,
    identities: [identity, secondIdentity] });
}, 120_000);
afterEach(async () => { await runtime.dispose(); });

function record(expectedRevision: number, startedAt: number, probe: ProjectAlphaApiV2Probe = transport,
  selected: ProjectAlphaApiV2IncidentIdentity = identity) {
  return recordProjectAlphaApiV2IncidentObservation(database,
    { identity: selected, expectedRevision, monitorRevision: 1, observation: { kind: "probe", startedAt, probe } });
}
function count(table: "project_alpha_api_v2_incident_heads" | "project_alpha_api_v2_incident_history") {
  return database.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)");
}

describe("Project Alpha API-v2 durable incident observations", () => {
  it("records sanitized observations and immutable versioned history, while stale starts do not write", async () => {
    expect(await readProjectAlphaApiV2Incident(database, identity)).toEqual({ revision: 0, state: null });
    expect(await record(0, 100)).toMatchObject({ status: "recorded", revision: 1,
      state: { category: "unavailable", unhealthySince: 100 } });
    expect(await record(1, 200, denied)).toMatchObject({ status: "recorded", revision: 2,
      state: { category: "unauthorized", reason: "credentials_or_scope", unhealthySince: 100 } });
    expect(await record(2, 150, verified)).toMatchObject({ status: "stale", revision: 2,
      state: { category: "unauthorized" } });
    expect(await count("project_alpha_api_v2_incident_heads")).toBe(1);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(2);
    const history = (await database.prepare(`SELECT revision,last_probe_started_at,state_json
      FROM project_alpha_api_v2_incident_history ORDER BY revision`).all<{
        revision: number; last_probe_started_at: number; state_json: string;
      }>()).results;
    expect(history.map(row => [row.revision, row.last_probe_started_at])).toEqual([[1, 100], [2, 200]]);
    expect(JSON.stringify(history)).not.toMatch(/api.?key|access.?token|secret|httpStatus|requestId/i);
    await expect(database.prepare(`UPDATE project_alpha_api_v2_incident_history SET state_json='{}'
      WHERE revision=1`).run()).rejects.toThrow();
    await expect(database.prepare("DELETE FROM project_alpha_api_v2_incident_history WHERE revision=1").run()).rejects.toThrow();
  });

  it("uses revision CAS for concurrent observations and does not last-write-win", async () => {
    const attempts = await Promise.allSettled([record(0, 100), record(0, 200, denied)]);
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(item => item.status === "rejected")).toHaveLength(1);
    expect((attempts.find(item => item.status === "rejected") as PromiseRejectedResult).reason)
      .toBeInstanceOf(ProjectAlphaApiV2IncidentStoreConflict);
    expect(await count("project_alpha_api_v2_incident_heads")).toBe(1);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(1);
    const current = await readProjectAlphaApiV2Incident(database, identity);
    await expect(record(0, 300)).rejects.toBeInstanceOf(ProjectAlphaApiV2IncidentStoreConflict);
    expect((await readProjectAlphaApiV2Incident(database, identity)).revision).toBe(current.revision);
  });

  it("keeps independent connection identities separate and only verified response recovers its own row", async () => {
    const second = secondIdentity;
    await record(0, 0);
    await record(0, 0, denied, second);
    expect(await count("project_alpha_api_v2_incident_heads")).toBe(2);
    expect(await record(1, 600_001, verified)).toMatchObject({ state: { category: "verified",
      unhealthySince: null, lastVerifiedAt: 600_001 } });
    expect(await readProjectAlphaApiV2Incident(database, second)).toMatchObject({ revision: 1,
      state: { category: "unauthorized", unhealthySince: 0 } });
  });

  it("rolls back the head when its append-only history write fails", async () => {
    await record(0, 0);
    await database.prepare(`CREATE TRIGGER synthetic_incident_history_failure
      BEFORE INSERT ON project_alpha_api_v2_incident_history
      WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END`).run();
    await expect(record(1, 10, denied)).rejects.toThrow("project_alpha_api_v2_incident_store_denied");
    expect(await readProjectAlphaApiV2Incident(database, identity)).toMatchObject({ revision: 1,
      state: { category: "unavailable", lastProbeStartedAt: 0 } });
    expect(await count("project_alpha_api_v2_incident_history")).toBe(1);
  });

  it("rejects unknown probe fields and corrupted persisted snapshots without leaking diagnostics", async () => {
    await expect(recordProjectAlphaApiV2IncidentObservation(database,
      { identity, expectedRevision: 0, monitorRevision: 1, observation: { kind: "probe", startedAt: 0,
        probe: { ...transport, apiKey: "synthetic-private-key" } } }))
      .rejects.toThrow("project_alpha_api_v2_incident_store_denied");
    expect(await count("project_alpha_api_v2_incident_heads")).toBe(0);
    await record(0, 0);
    await database.prepare(`UPDATE project_alpha_api_v2_incident_heads SET state_json=json_set(state_json,
      '$.unexpected','synthetic-private-key','$.lastProbeStartedAt',1),revision=2,last_probe_started_at=1`).run();
    await expect(readProjectAlphaApiV2Incident(database, identity))
      .rejects.toThrow("project_alpha_api_v2_incident_store_denied");
  });

  it("rejects an old monitor fence after retirement without resurrecting the head or history", async () => {
    await record(0, 100);
    await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 1, enabled: false, identities: [] });
    const retired = await readProjectAlphaApiV2Incident(database, identity);
    expect(retired).toMatchObject({ revision: 2, state: { category: "disabled", lastProbeStartedAt: 101 } });
    await expect(recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 2,
      monitorRevision: 1, observation: { kind: "probe", startedAt: 200, probe: transport } }))
      .rejects.toBeInstanceOf(ProjectAlphaApiV2IncidentStoreConflict);
    expect(await readProjectAlphaApiV2Incident(database, identity)).toEqual(retired);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(2);
  });

  it("rejects the pre-reenable fence, then accepts only the current lifecycle revision", async () => {
    await record(0, 100);
    await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 1, enabled: false, identities: [] });
    await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 2, enabled: true,
      identities: [identity, secondIdentity] });
    const reenabled = await readProjectAlphaApiV2Incident(database, identity);
    expect(reenabled).toMatchObject({ revision: 3, state: { category: "disabled" } });
    await expect(recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 3,
      monitorRevision: 2, observation: { kind: "probe", startedAt: 300, probe: transport } }))
      .rejects.toBeInstanceOf(ProjectAlphaApiV2IncidentStoreConflict);
    expect(await readProjectAlphaApiV2Incident(database, identity)).toEqual(reenabled);
    expect(await recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 3,
      monitorRevision: 3, observation: { kind: "probe", startedAt: 300, probe: transport } }))
      .toMatchObject({ status: "recorded", revision: 4, state: { category: "unavailable" } });
  });

  it("cannot use a current active monitor fence to write a disabled observation", async () => {
    await record(0, 100);
    const before = await readProjectAlphaApiV2Incident(database, identity);
    await expect(recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 1,
      monitorRevision: 1, observation: { kind: "disabled", startedAt: 200 } }))
      .rejects.toBeInstanceOf(ProjectAlphaApiV2IncidentStoreConflict);
    expect(await readProjectAlphaApiV2Incident(database, identity)).toEqual(before);
    expect(await count("project_alpha_api_v2_incident_history")).toBe(1);
  });
});
