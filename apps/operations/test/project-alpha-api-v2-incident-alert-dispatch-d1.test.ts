import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { dispatchProjectAlphaApiV2IncidentAlert, type ProjectAlphaApiV2AlertDispatchDependencies } from "../src/worker/project-alpha-api-v2-incident-alert-dispatch";
import { readProjectAlphaApiV2Incident, recordProjectAlphaApiV2IncidentObservation } from "../src/worker/project-alpha-api-v2-incident-store";
import { transitionProjectAlphaApiV2IncidentAlert } from "../src/worker/project-alpha-api-v2-incident-alert-store";
import type { OutboundMail } from "../src/worker/mailer";
import { applyProjectAlphaApiV2MonitorLifecycle, isProjectAlphaApiV2MonitorIdentityActive } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";

const identity = { sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const connections = JSON.stringify({ version: 1, connections: [{ ...identity, apiKey: "synthetic-private-key" }] });
let runtime: Miniflare;
let database: D1Database;
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('local-test')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files).toContain("0089_project_alpha_api_v2_monitor_lifecycle.sql");
  for (const file of files) await database.batch(splitD1MigrationStatements(
    readFileSync(new URL(file, directory), "utf8")).map(sql => database.prepare(sql)));
}, 120000);
afterAll(async () => { await runtime?.dispose(); });

it("records a slow accepted send after lease expiry and retries an acknowledgement race without resending", async () => {
  await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 0, enabled: true, identities: [identity] });
  await recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: 0, monitorRevision: 1,
    observation: { kind: "probe", startedAt: 0, probe: { status: "unavailable", reason: "transport" } } });
  const sent: OutboundMail[] = [];
  let raced = false;
  let now = 600003;
  const input = { identity, monitorRevision: 1, recipient: "owner@example.test",
    currentConfiguration: () => ({ enabled: "true", connections }), clock: () => now };
  const dependencies: ProjectAlphaApiV2AlertDispatchDependencies = {
    transportReady: () => {},
    active: (selected, revision) => isProjectAlphaApiV2MonitorIdentityActive(database, revision, selected),
    read: () => readProjectAlphaApiV2Incident(database, identity),
    transition: async (action) => {
      if (action.action === "sent" && !raced) {
        raced = true;
        await recordProjectAlphaApiV2IncidentObservation(database, { identity, expectedRevision: action.expectedRevision, monitorRevision: 1,
          observation: { kind: "probe", startedAt: 600002,
            probe: { status: "unauthorized", reason: "credentials_or_scope" } } });
      }
      return transitionProjectAlphaApiV2IncidentAlert(database, action);
    },
    send: async (mail: OutboundMail) => { sent.push(mail); now += 60001; },
  };
  expect(await dispatchProjectAlphaApiV2IncidentAlert(input, dependencies)).toEqual({ status: "sent" });
  expect(raced).toBe(true);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain("synthetic-private-key");
  expect(await readProjectAlphaApiV2Incident(database, identity)).toMatchObject({ revision: 5,
    state: { category: "unauthorized", alertSentAt: 660004, alertClaimSequence: 1 } });
  expect(await database.prepare("SELECT status,attempt_count FROM project_alpha_api_v2_incident_alerts").first())
    .toEqual({ status: "sent", attempt_count: 1 });
  expect(await dispatchProjectAlphaApiV2IncidentAlert(input, dependencies)).toEqual({ status: "not_due" });
  expect(sent).toHaveLength(1);
});
