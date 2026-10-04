import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";

const mail = vi.hoisted(() => ({ send: vi.fn(), ready: vi.fn() }));
vi.mock("../src/worker/mailer", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/worker/mailer")>();
  return { ...actual, sendNotificationMail: mail.send, validateNotificationMailTransport: mail.ready };
});

import { runProjectAlphaApiV2MonitorCycle } from "../src/worker/project-alpha-api-v2-monitor-cycle";
import { readProjectAlphaApiV2Incident } from "../src/worker/project-alpha-api-v2-incident-store";
import { applyProjectAlphaApiV2MonitorLifecycle } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";
import type { OutboundMail } from "../src/worker/mailer";
import type { Env } from "../src/worker/types";

const applicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const primary = { sourceId: "project-alpha:primary", applicationId, expectedHistoryEpoch: epoch,
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const secondary = { ...primary, sourceId: "project-alpha:secondary", baseUrl: "https://secondary.example.test",
  expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
const connections = JSON.stringify({ version: 1, connections: [primary, secondary].map(connection =>
  ({ ...connection, apiKey: "synthetic-private-key" })) });

let runtime: Miniflare | undefined;
let database: D1Database;

afterAll(async () => { await runtime?.dispose(); });
beforeAll(async () => {
  // Assign before any migration await so the registered disposer owns a partial fixture too.
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('local-test')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = reviewedOperationsMigrationNames(directory);
  expect(migrations).toEqual(expect.arrayContaining([
    "0087_project_alpha_api_v2_incidents.sql", "0088_project_alpha_api_v2_incident_alerts.sql",
    "0089_project_alpha_api_v2_monitor_lifecycle.sql",
  ]));
  for (const migration of migrations) await database.batch(splitD1MigrationStatements(
    readFileSync(new URL(migration, directory), "utf8")).map(sql => database!.prepare(sql)));
  await applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision: 0, enabled: true,
    identities: [primary, secondary] });
}, 120_000);

function healthy(connection: typeof primary): Response {
  return Response.json({ apiVersion: "2", sourceInstanceId: connection.expectedSourceInstanceId,
    applicationId, historyEpoch: epoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    grantedCapabilities: ["api.capabilities.read", "directory.clients.create", "directory.organizations.create"]
      .map(name => ({ name })),
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      ...["clients", "organizations"].map(resource => ({ method: "POST", path: `/api/v2/directory/${resource}/commands`,
        requiredCapability: `directory.${resource}.create`, requiresSourceInstanceId: true,
        requiresApplicationId: true, requiresUpdatePublicId: true, requiresHistoryEpoch: true }))],
  }, { headers: { "Cache-Control": "no-store", "X-Request-ID": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } });
}

it("joins two per-instance probes with durable first-alert, recovery, and new-incident semantics without writing the directory outbox", async () => {
  let primaryHealthy = false;
  let now = 0;
  const sent: OutboundMail[] = [];
  mail.ready.mockImplementation(() => {});
  mail.send.mockImplementation(async (_env: unknown, message: OutboundMail) => { sent.push(message); });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/v2/capabilities");
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    if (url.origin === primary.baseUrl) {
      if (primaryHealthy) return healthy(primary);
      throw new TypeError("synthetic network unavailable");
    }
    expect(url.origin).toBe(secondary.baseUrl);
    return healthy(secondary);
  };
  const input = { enabled: "true", connections, expectedMonitorRevision: 1, recipient: "owner@example.test" };
  const cycle = () => runProjectAlphaApiV2MonitorCycle(database, {} as Env, input, fetch, () => now);
  const outbox = async () => database.prepare("SELECT count(*) n FROM project_alpha_directory_outbox")
    .first<number>("n");

  expect(await outbox()).toBe(0);
  expect((await cycle()).alerts).toEqual({ not_due: 2 });
  now = 600_000;
  expect((await cycle()).alerts).toEqual({ not_due: 2 });
  expect(sent).toHaveLength(0);
  now = 600_001;
  expect((await cycle()).alerts).toEqual({ sent: 1, not_due: 1 });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: "owner@example.test", subject: expect.stringContaining(primary.sourceId) });
  expect(JSON.stringify(sent[0])).not.toContain("synthetic-private-key");
  expect(await outbox()).toBe(0);

  now = 600_002;
  expect((await cycle()).alerts).toEqual({ not_due: 2 });
  expect(sent).toHaveLength(1);
  expect(await readProjectAlphaApiV2Incident(database, secondary)).toMatchObject({ state: {
    category: "verified", unhealthySince: null, incidentSequence: 0 } });

  primaryHealthy = true;
  now = 700_000;
  expect((await cycle()).health).toMatchObject({ verified: 2, unhealthy: 0 });
  expect(await readProjectAlphaApiV2Incident(database, primary)).toMatchObject({ state: {
    category: "verified", unhealthySince: null, incidentSequence: 1 } });

  primaryHealthy = false;
  now = 800_000;
  await cycle();
  now = 1_400_001;
  const secondAlert = await cycle();
  expect(secondAlert.alerts).toEqual({ sent: 1, not_due: 1 });
  expect(JSON.stringify(secondAlert)).not.toMatch(/synthetic-private-key|owner@example\.test/);
  expect(sent).toHaveLength(2);
  expect(sent[1]?.messageIdKey).not.toBe(sent[0]?.messageIdKey);
  expect(await readProjectAlphaApiV2Incident(database, primary)).toMatchObject({ state: {
    category: "unavailable", reason: "transport", unhealthySince: 800_000, incidentSequence: 2, alertSentAt: 1_400_001 } });
  expect(await outbox()).toBe(0);
  expect(await database.prepare("SELECT incident_sequence,status,attempt_count FROM project_alpha_api_v2_incident_alerts ORDER BY incident_sequence").all())
    .toMatchObject({ results: [{ incident_sequence: 1, status: "sent", attempt_count: 1 },
      { incident_sequence: 2, status: "sent", attempt_count: 1 }] });
}, 30_000);
