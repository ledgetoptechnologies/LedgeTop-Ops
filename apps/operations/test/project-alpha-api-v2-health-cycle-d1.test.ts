import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { runProjectAlphaApiV2HealthCycle } from "../src/worker/project-alpha-api-v2-health-cycle";
import { readProjectAlphaApiV2Incident, recordProjectAlphaApiV2IncidentObservation }
  from "../src/worker/project-alpha-api-v2-incident-store";
import { applyProjectAlphaApiV2MonitorLifecycle } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";
import { projectAlphaApiV2AlertEligible } from "../src/worker/project-alpha-api-v2-incident-policy";

const applicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const expectedHistoryEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const primary = { sourceId: "project-alpha:primary", applicationId, expectedHistoryEpoch,
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const secondary = { ...primary, sourceId: "project-alpha:secondary", baseUrl: "https://secondary.example.test",
  expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
const connections = JSON.stringify({ version: 1,
  connections: [primary, secondary].map(item => ({ ...item, apiKey: "synthetic-private-key" })) });
let runtime: Miniflare;
let database: D1Database;
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('local-test')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files).toContain("0087_project_alpha_api_v2_incidents.sql");
  for (const file of files) {
    const sql = readFileSync(new URL(file, directory), "utf8");
    await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
  }
  await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 0, enabled: true,
    identities: [primary, secondary] });
}, 120000);
afterAll(async () => { await runtime?.dispose(); });

function healthy(selected: typeof primary): Response {
  const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const required = ["directory.clients.create", "directory.organizations.create"];
  return Response.json({ apiVersion: "2", sourceInstanceId: selected.expectedSourceInstanceId,
    applicationId, historyEpoch: expectedHistoryEpoch, requestId,
    grantedCapabilities: ["api.capabilities.read", ...required].map(name => ({ name })),
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      ...["clients", "organizations"].map(resource => ({ method: "POST", path: `/api/v2/directory/${resource}/commands`,
        requiredCapability: `directory.${resource}.create`, requiresSourceInstanceId: true,
        requiresApplicationId: true, requiresUpdatePublicId: true, requiresHistoryEpoch: true }))],
  }, { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
}

it("joins real readiness parsing to durable per-instance incidents without queued writes", async () => {
  const calls: string[] = [];
  let primaryRecovered = false;
  const send: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    calls.push(url.origin);
    expect(url.pathname).toBe("/api/v2/capabilities");
    expect(options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    if (url.origin === primary.baseUrl) return primaryRecovered ? healthy(primary) : new Response("synthetic failure", { status: 503 });
    expect(url.origin).toBe(secondary.baseUrl);
    return healthy(secondary);
  };
  const input = { enabled: "true", connections, expectedMonitorRevision: 1 };
  expect(await runProjectAlphaApiV2HealthCycle(database, input, send, () => 0))
    .toMatchObject({ verified: 1, unhealthy: 1, storageErrors: 0 });
  expect(await runProjectAlphaApiV2HealthCycle(database, input, send, () => 600001))
    .toMatchObject({ verified: 1, unhealthy: 1, storageErrors: 0 });
  const failed = await readProjectAlphaApiV2Incident(database, primary);
  const live = await readProjectAlphaApiV2Incident(database, secondary);
  // A synthetic 503 without the required request ID is an incompatible
  // response contract, not proof of a transport outage. It is still the same
  // continuous unhealthy incident for timing and alert purposes.
  expect(failed).toMatchObject({ revision: 2, state: { unhealthySince: 0, category: "incompatible",
    reason: "invalid_contract" } });
  expect(live).toMatchObject({ revision: 2, state: { category: "verified", unhealthySince: null } });
  expect(projectAlphaApiV2AlertEligible(failed.state!, 600001)).toBe(true);
  expect(projectAlphaApiV2AlertEligible(live.state!, 600001)).toBe(false);
  primaryRecovered = true;
  expect(await runProjectAlphaApiV2HealthCycle(database, input, send, () => 700000))
    .toMatchObject({ verified: 2, unhealthy: 0, storageErrors: 0 });
  expect(await readProjectAlphaApiV2Incident(database, primary))
    .toMatchObject({ revision: 3, state: { category: "verified", unhealthySince: null, lastVerifiedAt: 700000 } });
  expect(calls).toHaveLength(6);
  expect(await database.prepare("SELECT count(*) n FROM project_alpha_directory_outbox").first<number>("n")).toBe(0);
  expect(await database.prepare("SELECT count(*) n FROM project_alpha_api_v2_incident_history").first<number>("n")).toBe(6);
  await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 1, enabled: false, identities: [] });
  await expect(recordProjectAlphaApiV2IncidentObservation(database, { identity: primary,
    expectedRevision: 3, monitorRevision: 1,
    observation: { kind: "probe", startedAt: 800000, probe: { status: "unavailable", reason: "transport" } } }))
    .rejects.toThrow("project_alpha_api_v2_incident_store_conflict");
  expect(await readProjectAlphaApiV2Incident(database, primary)).toMatchObject({ revision: 4,
    state: { category: "disabled", lastProbeStartedAt: 700001 } });
});
