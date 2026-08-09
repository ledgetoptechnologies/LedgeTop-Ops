import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const principal = { id: "staff-admin", email: "admin@example.com", displayName: "Admin", accessSubject: "access-admin", projectAlphaUserId: "3" };
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type DbState = {
  batches: string[][];
  outboxPayloads?: string[];
  first?: (kind: "ops" | "delivery", sql: string, values: unknown[]) => unknown;
};

function database(kind: "ops" | "delivery", state: DbState) {
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        async first() {
          const configured = state.first?.(kind, sql, this.values);
          if (configured !== undefined) return configured;
          if (kind === "delivery" && sql.includes("project_alpha_client_id")) {
            return { id: "request-a", status: "accepted_pending_pa_linkage", project_id: "portal-pa-9", project_alpha_client_id: "21", project_alpha_project_id: "9" };
          }
          if (kind === "delivery" && sql.includes("SELECT r.title,r.project_id,r.service_category")) {
            return { title: "North site progress imagery", project_id: "portal-pa-9", service_category: "Progress mapping", location_text: "Broadway, Green Bay, Wisconsin", latitude: 44.5132, longitude: -88.0831, project_name: "North Distribution Center" };
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements: Array<{ sql?: string; values?: unknown[] }>) {
      state.batches.push(statements.map(statement => statement.sql || "audit"));
      for (const statement of statements) {
        if (statement.sql?.includes("client_portal_notification_outbox")) {
          const payload = [...(statement.values ?? [])].reverse().find((value: unknown) => typeof value === "string" && value.startsWith('{"presentationVersion"'));
          if (typeof payload === "string") (state.outboxPayloads ??= []).push(payload);
        }
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
    withSession() { return db; },
  };
  return db;
}

function environment(state: DbState) {
  return {
    ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example",
    PROJECT_ALPHA_BASE_URL: "https://project-alpha.example", PROJECT_ALPHA_API_KEY: "secret-key",
    OPS_DB: database("ops", state), DELIVERY_DB: database("delivery", state),
  };
}

describe("verified Project Alpha quote linkage", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
    mocks.sqlScope.mockReset().mockResolvedValue({ global: true, deniedGlobal: false, divisions: [], deniedDivisions: [] });
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.auditStatement.mockReset().mockResolvedValue({ sql: "ops-audit" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("verifies exact client/project ownership before atomically linking an approved quote", async () => {
    const state: DbState = { batches: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/ops/artifacts/verify");
      expect(Object.fromEntries(url.searchParams)).toEqual({ type: "quote", id: "42", client_id: "21", project_id: "9" });
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-key");
      return Response.json({ artifact: { id: 42, type: "quote", client_id: 21, project_id: 9, status: "approved", document_number: "Q-0042", total: "1250.00", currency: "USD", updated_at: "2026-08-01T12:00:00Z" }, request_id: "trace-a" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-quote", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ops.example" }, body: JSON.stringify({ artifactId: 42 }),
    }), environment(state) as any, executionCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "accepted_linked", quote: { documentNumber: "Q-0042", total: 1250 } });
    const deliveryBatch = state.batches.find(batch => batch.some(sql => sql.includes("request_pa_artifacts")));
    expect(deliveryBatch).toEqual(expect.arrayContaining([
      expect.stringContaining("status='accepted_linked'"),
      expect.stringContaining("INSERT INTO request_pa_artifacts"),
      expect.stringContaining("client_portal_notification_outbox"),
      expect.stringContaining("request_admin_audit"),
    ]));
    const notification = JSON.parse(state.outboxPayloads?.[0] || "null");
    expect(notification).toMatchObject({
      presentationVersion: 1,
      title: "North site progress imagery",
      lifecycle: "accepted_linked",
      action: "open_client_portal",
    });
    expect(JSON.stringify(notification)).not.toContain("Q-0042");
    expect(JSON.stringify(notification)).not.toContain("1250");
  });

  it("creates an immutable estimate version once and replays the same idempotency key", async () => {
    let replay = false;
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery") return null;
        if (sql.includes("WHERE mutation_key=?"))
          return replay
            ? {
                id: "estimate-a",
                request_id: "request-a",
                version: 1,
                status: "ready",
                mutation_fingerprint: thisFingerprint,
              }
            : null;
        if (sql.includes("SELECT id,project_id,status FROM client_service_requests"))
          return { id: "request-a", project_id: "portal-pa-9", status: "submitted" };
        if (sql.includes("status IN ('draft','ready','accepted','change_requested')"))
          return null;
        if (sql.includes("SELECT r.title,r.project_id,r.service_category"))
          return { title: "North site progress imagery", project_id: "portal-pa-9", service_category: "Progress mapping", location_text: "Broadway, Green Bay, Wisconsin", latitude: 44.5132, longitude: -88.0831, project_name: "North Distribution Center" };
        return null;
      },
    };
    const payload = {
      scope: "Capture the approved site area and deliver an orthomosaic.",
      amount: 1250,
      currency: "USD",
      proposedFields: null,
      status: "ready",
    };
    const encoded = JSON.stringify({ requestId: "request-a", ...payload });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
    const thisFingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const request = () => worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "staff-estimate-route-0001", Origin: "https://ops.example" },
      body: JSON.stringify(payload),
    }), environment(state) as any, executionCtx);
    const created = await request();
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ version: 1, status: "ready", idempotentReplay: false });
    expect(state.batches.at(-1)).toEqual(expect.arrayContaining([
      expect.stringContaining("mutation_fingerprint"),
      expect.stringContaining("request_revisions"),
      expect.stringContaining("request_confirmation_requested"),
    ]));
    const notification = JSON.parse(state.outboxPayloads?.[0] || "null");
    expect(notification).toMatchObject({
      presentationVersion: 1,
      projectContext: { kind: "existing_project", label: "North Distribution Center" },
      lifecycle: "estimate_ready",
      action: "open_client_portal",
    });
    expect(JSON.stringify(notification)).not.toMatch(/1250|USD|amount|currency|quote|billing/i);
    const batchCount = state.batches.length;
    replay = true;
    const replayed = await request();
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ id: "estimate-a", version: 1, idempotentReplay: true });
    expect(state.batches).toHaveLength(batchCount);
  });

  it("fails closed when PA returns an artifact for another client", async () => {
    const state = { batches: [] as string[][] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ artifact: { id: 42, type: "quote", client_id: 99, project_id: 9, status: "approved", document_number: "Q-0042", total: "10.00", currency: "USD", updated_at: null }, request_id: "trace-b" })));
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-quote", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ops.example" }, body: JSON.stringify({ artifactId: 42 }),
    }), environment(state) as any, executionCtx);
    expect(response.status).toBe(404);
    expect(state.batches.some(batch => batch.some(sql => sql.includes("request_pa_artifacts")))).toBe(false);
  });
});
