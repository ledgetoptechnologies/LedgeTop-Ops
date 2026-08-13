import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
  requireMutationSecurity: vi.fn(),
  auditStatement: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  sqlScope: mocks.sqlScope,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  requireMutationSecurity: mocks.requireMutationSecurity,
  auditStatement: mocks.auditStatement,
}));

import worker from "../src/worker/index";

const principal = { id: "staff-area", email: "staff@example.test", displayName: "Staff", accessSubject: "access-area", projectAlphaUserId: "5" };
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function environment(options: { updatedAt?: string; revision?: number; status?: string } = {}) {
  const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
  const db = {
    prepare(sql: string) {
      return {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM client_service_request_area_revisions WHERE request_id=? AND mutation_key=?")) return null;
          if (sql.includes("effective.revision_number effective_revision")) return {
            id: "request-a",
            title: "North site mapping",
            project_id: "project-a",
            project_name: "North Site",
            service_category: "2D mapping",
            location_text: "North parcel",
            latitude: 44.5,
            longitude: -88.1,
            area_geojson: JSON.stringify({ type: "Polygon", coordinates: [[[-88.2, 44.4], [-88.0, 44.4], [-88.0, 44.6], [-88.2, 44.4]]] }),
            poi_points_json: "[]",
            status: options.status || "accepted_linked",
            updated_at: options.updatedAt || "2026-08-01T12:00:00.000Z",
            effective_revision: options.revision || null,
            effective_area_geojson: null,
            effective_poi_points_json: null,
            has_current_pa_artifact: 1,
          };
          if (sql.includes("SELECT updated_at FROM client_service_requests"))
            return { updated_at: "2026-08-13 18:00:00.123" };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
    async batch(statements: Array<{ sql?: string; values?: unknown[] }>) {
      batches.push(statements.map(statement => ({ sql: statement.sql || "audit", values: statement.values || [] })));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
    withSession() { return db; },
  };
  return {
    batches,
    env: {
      ENVIRONMENT: "development",
      EXPECTED_HOST: "ops.example",
      INCOMING_EXPECTED_HOST: "incoming.example",
      OPS_DB: db,
      DELIVERY_DB: db,
    } as any,
  };
}

function workAreaRequest(body: Record<string, unknown>) {
  return new Request("https://ops.example/api/client-service-requests/request-a/work-area", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "staff-work-area-mutation-0001",
      Origin: "https://ops.example",
    },
    body: JSON.stringify(body),
  });
}

describe("staff service-request work-area revisions", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
    mocks.sqlScope.mockReset().mockResolvedValue({ global: true, deniedGlobal: false, divisions: [], deniedDivisions: [] });
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.auditStatement.mockReset().mockResolvedValue({ sql: "ops-audit" });
  });

  it("creates one immutable overlay, reopens review, invalidates scope, and queues a client-safe notice", async () => {
    const state = environment();
    const response = await worker.fetch(workAreaRequest({
      expectedUpdatedAt: "2026-08-01T12:00:00.000Z",
      expectedRevision: 0,
      areaGeoJson: { type: "Polygon", coordinates: [[[-88.2, 44.4], [-87.95, 44.4], [-87.95, 44.65], [-88.2, 44.4]]] },
      poiPoints: [{ longitude: -88.05, latitude: 44.5, label: "Revised launch" }],
      reason: "Client boundary included an adjacent parcel that is outside the approved scope.",
    }), state.env, executionCtx);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      revision: { revisionNumber: 1, changeSummary: "service-area boundary adjusted; 1 point added" },
      projectAlphaScopeMarkedStale: true,
      idempotentReplay: false,
    });
    const sql = state.batches[0]!.map(statement => statement.sql);
    expect(sql).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO client_service_request_area_revisions"),
      expect.stringContaining("SET status='under_review'"),
      expect.stringContaining("request_operational_estimates SET status='superseded'"),
      expect.stringContaining("request_pa_artifacts SET scope_stale_at"),
      expect.stringContaining("request_work_area_changed"),
    ]));
    expect(sql.find(statement => statement.includes("UPDATE client_service_requests"))).not.toMatch(/area_geojson|poi_points_json/);
    const outbox = state.batches[0]!.find(statement => statement.sql.includes("request_work_area_changed"));
    const payload = outbox?.values.find(value => typeof value === "string" && value.startsWith('{"presentationVersion"')) as string;
    expect(JSON.parse(payload)).toMatchObject({ lifecycle: "work_area_changed", changeSummary: "service-area boundary adjusted; 1 point added" });
    expect(payload).not.toMatch(/adjacent parcel|-88\./);
  });

  it("rejects stale concurrency values before writing", async () => {
    const state = environment({ updatedAt: "2026-08-01T13:00:00.000Z" });
    const response = await worker.fetch(workAreaRequest({
      expectedUpdatedAt: "2026-08-01T12:00:00.000Z",
      expectedRevision: 0,
      areaGeoJson: null,
      poiPoints: [{ longitude: -88.05, latitude: 44.5, label: null }],
      reason: "Use the single reviewed capture point.",
    }), state.env, executionCtx);
    expect(response.status).toBe(409);
    expect(state.batches).toEqual([]);
  });

  it("rejects self-intersecting geometry and terminal requests", async () => {
    const invalidState = environment();
    const invalid = await worker.fetch(workAreaRequest({
      expectedUpdatedAt: "2026-08-01T12:00:00.000Z",
      expectedRevision: 0,
      areaGeoJson: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]] },
      poiPoints: [],
      reason: "Invalid crossing boundary test.",
    }), invalidState.env, executionCtx);
    expect(invalid.status).toBe(400);
    expect(invalidState.batches).toEqual([]);

    const terminalState = environment({ status: "completed" });
    const terminal = await worker.fetch(workAreaRequest({
      expectedUpdatedAt: "2026-08-01T12:00:00.000Z",
      expectedRevision: 0,
      areaGeoJson: null,
      poiPoints: [{ longitude: -88.05, latitude: 44.5, label: null }],
      reason: "Attempted terminal revision.",
    }), terminalState.env, executionCtx);
    expect(terminal.status).toBe(409);
    expect(terminalState.batches).toEqual([]);
  });
});
