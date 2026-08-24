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
  runs?: string[];
  outboxPayloads?: string[];
  first?: (kind: "ops" | "delivery", sql: string, values: unknown[]) => unknown;
  all?: (kind: "ops" | "delivery", sql: string, values: unknown[]) => unknown[] | undefined;
  run?: (
    kind: "ops" | "delivery",
    sql: string,
    values: unknown[],
  ) => { meta: { changes: number } } | Promise<{ meta: { changes: number } }> | undefined;
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
        async all() { return { results: state.all?.(kind, sql, this.values) ?? [] }; },
        async run() {
          (state.runs ??= []).push(sql);
          const configured = state.run?.(kind, sql, this.values);
          return configured === undefined ? { meta: { changes: 1 } } : await configured;
        },
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

function environment(state: DbState, overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example",
    PROJECT_ALPHA_BASE_URL: "https://project-alpha.example", PROJECT_ALPHA_API_KEY: "secret-key",
    OPS_DB: database("ops", state), DELIVERY_DB: database("delivery", state),
    ...overrides,
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

  it("returns only allowlisted immutable service review fields and labeled answers", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind === "delivery" && sql.includes("FROM client_service_requests r JOIN client_accounts")) {
          return {
            id: "request-a",
            account_id: "account-a",
            title: "North site mapping",
            status: "submitted",
            area_geojson: null,
            poi_points_json: null,
            account_name: "Acme Surveying",
          };
        }
        return null;
      },
      all(kind, sql) {
        if (kind === "delivery" && sql.includes("FROM request_operational_estimates"))
          return [{
            id: "estimate-a", version: 1, scope_text: "Capture the mapped area.",
            estimate_amount_minor: 999900, currency: "USD", status: "ready",
          }];
        if (kind === "delivery" && sql.includes("FROM request_revisions"))
          return [{
            revision_number: 1, author_type: "staff", action: "staff_proposal",
            snapshot_json: JSON.stringify({ scope: "Capture the mapped area.", amount: 9999, currency: "USD" }),
          }];
        if (kind === "delivery" && sql.includes("FROM client_service_request_services")) {
          return [{
            service_public_id: "svc-2d-mapping",
            service_source_version: "catalog-item-v3",
            service_snapshot_json: JSON.stringify({
              publicId: "svc-2d-mapping",
              sourceVersion: "catalog-item-v3",
              name: "2D Mapping",
              summary: "Orthomosaic mapping for a client-drawn work area.",
              category: "Mapping",
              displayOrder: 10,
              geometryRequirement: "required",
              questions: [{
                id: "deliverable_format",
                label: "Preferred deliverable",
                type: "select",
                required: true,
                options: [{ value: "orthomosaic", label: "Orthomosaic" }],
              }],
              unitPrice: "1000.00",
              privateFormula: "never-forward-this",
            }),
            answers_json: JSON.stringify({ deliverable_format: "orthomosaic" }),
          }];
        }
        return [];
      },
    };

    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.services).toEqual([{
      publicId: "svc-2d-mapping",
      sourceVersion: "catalog-item-v3",
      name: "2D Mapping",
      summary: "Orthomosaic mapping for a client-drawn work area.",
      category: "Mapping",
      geometryRequirement: "required",
      answers: [{ questionId: "deliverable_format", label: "Preferred deliverable", displayValue: "Orthomosaic" }],
      integrity: "verified",
    }]);
    expect(JSON.stringify(payload)).not.toMatch(/unitPrice|privateFormula|never-forward-this|1000\.00/);
    expect(payload.capabilities).toEqual({ legacyPaQuoteLinkEnabled: false });
    expect(payload.estimates[0]).not.toHaveProperty("estimate_amount_minor");
    expect(payload.estimates[0]).not.toHaveProperty("currency");
    expect(JSON.parse(payload.revisions[0].snapshot_json)).toEqual({ scope: "Capture the mapped area." });
    expect(JSON.stringify(payload)).not.toMatch(/9999|USD/);
  });

  it("suppresses legacy numeric quote fields from the v2 request queue", async () => {
    const state: DbState = {
      batches: [],
      all(kind, sql) {
        if (kind !== "delivery" || !sql.includes("uses_catalog_v2")) return [];
        return [{
          id: "request-v2", title: "Catalog-backed request", uses_catalog_v2: 1,
          quote_id: 42, quote_document_number: "Q-0042", quote_status: "approved",
          quote_total_minor: 125000, quote_currency: "USD",
          quote_verified_at: "2026-08-01T12:00:00Z",
        }];
      },
    };
    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.requests[0]).toMatchObject({
      id: "request-v2", quote_id: null, quote_document_number: null,
      quote_status: null, quote_total_minor: null, quote_currency: null,
      quote_verified_at: null,
    });
    expect(JSON.stringify(payload)).not.toMatch(/Q-0042|125000|USD|"quote_id":42/);
  });

  it("orders the submitted review queue by creation time for first-come-first-served handling", async () => {
    let queueSql = "";
    const state: DbState = {
      batches: [],
      all(kind, sql) {
        if (kind === "delivery" && sql.includes("FROM client_service_requests r JOIN client_accounts")) {
          queueSql = sql;
          return [];
        }
        return [];
      },
    };
    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(200);
    expect(queueSql).toContain("WHEN 'submitted' THEN 0");
    expect(queueSql).toContain("END,r.created_at ASC,r.id ASC");
    expect(queueSql).not.toContain("desired_completion_at ASC");
  });

  it("keeps the request queue available while the additive v2 table migration is pending", async () => {
    const state: DbState = {
      batches: [],
      all(kind, sql) {
        if (kind !== "delivery") return [];
        if (sql.includes("client_service_request_services"))
          throw new Error("D1_ERROR: no such table: client_service_request_services: SQLITE_ERROR");
        if (sql.includes("0 uses_catalog_v2"))
          return [{ id: "request-legacy", title: "Legacy request", status: "submitted", uses_catalog_v2: 0 }];
        return [];
      },
    };

    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requests: [{ id: "request-legacy", title: "Legacy request", status: "submitted" }],
    });
  });

  it("reports a stable schema-readiness error when the core request schema is unavailable", async () => {
    const state: DbState = {
      batches: [],
      all(kind) {
        if (kind === "delivery")
          throw new Error("D1_ERROR: no such table: client_service_requests: SQLITE_ERROR");
        return [];
      },
    };
    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Client request data is temporarily unavailable while its database update finishes.",
      code: "CLIENT_REQUEST_SCHEMA_OUTDATED",
    });
  });

  it("opens a legacy request without optional catalog or staff-area tables", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery" || !sql.includes("FROM client_service_requests r JOIN client_accounts")) return null;
        if (sql.includes("quote.scope_stale_at"))
          throw new Error("D1_ERROR: no such column: quote.scope_stale_at: SQLITE_ERROR");
        return {
          id: "request-legacy",
          account_id: "account-a",
          title: "Legacy request",
          status: "submitted",
          area_geojson: null,
          poi_points_json: "[]",
          account_name: "Acme Surveying",
        };
      },
      all(kind, sql) {
        if (kind !== "delivery") return [];
        if (sql.includes("client_service_request_area_revisions"))
          throw new Error("D1_ERROR: no such table: client_service_request_area_revisions: SQLITE_ERROR");
        if (sql.includes("client_service_request_services"))
          throw new Error("D1_ERROR: no such table: client_service_request_services: SQLITE_ERROR");
        return [];
      },
    };

    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-legacy"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: { id: "request-legacy", title: "Legacy request", status: "submitted" },
      services: [],
      areaRevisions: [],
      effectiveWorkArea: { revisionNumber: 0, areaGeoJson: null, poiPointsJson: "[]" },
    });
  });

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
    }), environment(state, {
      LEGACY_CLIENT_REQUEST_PA_QUOTE_LINK_ENABLED: "true",
    }) as any, executionCtx);
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
        if (sql.includes("uses_catalog_v2") && sql.includes("FROM client_service_requests"))
          return { id: "request-a", project_id: "portal-pa-9", status: "submitted", uses_catalog_v2: 0 };
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

  it("rejects local amount or currency fields for v2 service requests", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind === "delivery" && sql.includes("uses_catalog_v2"))
          return { id: "request-a", project_id: "portal-pa-9", status: "submitted", uses_catalog_v2: 1 };
        return null;
      },
    };
    const response = await worker.fetch(new Request(
      "https://ops.example/api/client-service-requests/request-a/estimate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "staff-estimate-route-v2-0001",
          Origin: "https://ops.example",
        },
        body: JSON.stringify({
          scope: "Capture the approved site area.",
          amount: 1,
          currency: "USD",
          status: "ready",
        }),
      },
    ), environment(state) as any, executionCtx);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("pricing is created in Project Alpha");
    expect(state.batches).toEqual([]);
  });

  it("accepts a scope-only v2 proposal without amount fields", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery") return null;
        if (sql.includes("uses_catalog_v2"))
          return { id: "request-a", project_id: "portal-pa-9", status: "submitted", uses_catalog_v2: 1 };
        if (sql.includes("status IN ('draft','ready','accepted','change_requested')")) return null;
        return null;
      },
    };
    const response = await worker.fetch(new Request(
      "https://ops.example/api/client-service-requests/request-a/estimate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "staff-estimate-route-v2-0002",
          Origin: "https://ops.example",
        },
        body: JSON.stringify({ scope: "Capture the approved site area.", status: "draft" }),
      },
    ), environment(state) as any, executionCtx);
    expect(response.status).toBe(201);
    expect(state.batches.flat()).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO request_operational_estimates"),
      expect.stringContaining("request_revisions"),
    ]));
  });

  it("fails closed when PA returns an artifact for another client", async () => {
    const state = { batches: [] as string[][] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ artifact: { id: 42, type: "quote", client_id: 99, project_id: 9, status: "approved", document_number: "Q-0042", total: "10.00", currency: "USD", updated_at: null }, request_id: "trace-b" })));
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-quote", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ops.example" }, body: JSON.stringify({ artifactId: 42 }),
    }), environment(state, {
      LEGACY_CLIENT_REQUEST_PA_QUOTE_LINK_ENABLED: "true",
    }) as any, executionCtx);
    expect(response.status).toBe(404);
    expect(state.batches.some(batch => batch.some(sql => sql.includes("request_pa_artifacts")))).toBe(false);
  });

  it("keeps manual numeric quote linkage off by default without an upstream call", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request(
      "https://ops.example/api/client-service-requests/request-a/pa-quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://ops.example" },
        body: JSON.stringify({ artifactId: 42 }),
      },
    ), environment({ batches: [] }) as any, executionCtx);
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects manual numeric quote linkage for v2 even when the legacy gate is on", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind === "delivery" && sql.includes("uses_catalog_v2"))
          return {
            id: "request-a", status: "accepted_pending_pa_linkage",
            project_id: "portal-pa-9", project_alpha_client_id: "21",
            project_alpha_project_id: "9", uses_catalog_v2: 1,
          };
        return null;
      },
    };
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request(
      "https://ops.example/api/client-service-requests/request-a/pa-quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://ops.example" },
        body: JSON.stringify({ artifactId: 42 }),
      },
    ), environment(state, {
      LEGACY_CLIENT_REQUEST_PA_QUOTE_LINK_ENABLED: "true",
    }) as any, executionCtx);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("draft public-ID handoff");
    expect(upstream).not.toHaveBeenCalled();
    expect(state.batches).toEqual([]);
  });

  it("creates only a private PA draft from server-derived immutable request evidence", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery") return null;
        if (sql.includes("request_revision") && sql.includes("FROM client_service_requests"))
          return {
            id: "request-a",
            status: "under_review",
            title: "North site mapping",
            details: "Capture the reviewed site.",
            deliverables_text: "Orthomosaic",
            project_alpha_client_id: "client-public-a",
            project_alpha_organization_id: "org-public-a",
            project_alpha_project_id: "project-public-a",
            portal_project_id: "portal-pa-9",
            project_authorized: 1,
            area_geojson: JSON.stringify({ type: "Polygon", coordinates: [[[-88, 44], [-87.99, 44], [-87.99, 44.01], [-88, 44]]] }),
            poi_points_json: "[]",
            effective_area_geojson: null,
            effective_poi_points_json: null,
            area_revision: null,
            request_revision: 3,
            scope_text: "Capture the reviewed site and deliver an orthomosaic.",
          };
        return null;
      },
      all(kind, sql) {
        if (kind !== "delivery") return undefined;
        if (sql.includes("FROM client_service_request_services"))
          return [{ service_public_id: "svc-ortho", service_source_version: "catalog-7", answers_json: '{"resolution":"standard"}' }];
        if (sql.includes("FROM client_service_request_attachments"))
          return [{ original_name: "authorization.pdf", content_type: "application/pdf", actual_size: 2048, verified_sha256: "b".repeat(64), object_key: "must-not-leave-ltds" }];
        return undefined;
      },
    };
    const env = {
      ...environment(state),
      APPLICATION_KEY: "ltds_ops",
      PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "true",
      PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "draft-only-key",
      PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/api/v2/integrations/ltds_ops/draft-quotes");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer draft-only-key");
      expect(headers.get("Idempotency-Key")).toBe("ltds-pa-draft:request-a:r3:a0");
      expect(headers.get("X-Portal-Integration-Signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
      const command = JSON.parse(String(init?.body));
      expect(command).toMatchObject({
        request: { publicId: "request-a", revision: 3 },
        authorization: { clientPublicId: "client-public-a", projectPublicId: "project-public-a" },
        services: [{ publicId: "svc-ortho", catalogVersion: "catalog-7", answers: { resolution: "standard" } }],
        workArea: { revision: 0 },
        attachments: [{ name: "authorization.pdf", sizeBytes: 2048, sha256: "b".repeat(64) }],
      });
      expect(JSON.stringify(command)).not.toMatch(/object_key|must-not-leave|amount|currency|total_minor/i);
      return Response.json({
        receiptId: "receipt-public-a",
        draftQuote: {
          publicId: "quote-public-a",
          documentNumber: "Q-DRAFT-7",
          status: "draft",
          version: 1,
          editorPath: "/quotes/quote-public-a/edit",
        },
      });
    }));
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-draft", {
      method: "POST",
      headers: { Origin: "https://ops.example" },
    }), env as any, executionCtx);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      requestRevision: 3,
      areaRevision: 0,
      editorUrl: "https://project-alpha.example/quotes/quote-public-a/edit",
      draftQuote: { status: "draft" },
      idempotentReplay: false,
    });
    expect(state.runs).toEqual(expect.arrayContaining([
      expect.stringContaining("request_pa_draft_quote_receipts"),
    ]));
    expect(state.batches).toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.stringContaining("pa_draft_quote_created")]),
    ]));
  });

  it("denies PA draft creation before configuration or upstream access", async () => {
    mocks.sqlScope.mockResolvedValueOnce({ global: false, deniedGlobal: false, divisions: [], deniedDivisions: [] });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-draft", {
      method: "POST", headers: { Origin: "https://ops.example" },
    }), environment({ batches: [] }) as any, executionCtx);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not degrade a revoked project request into a client-level PA draft", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind === "delivery" && sql.includes("request_revision") && sql.includes("FROM client_service_requests"))
          return {
            id: "request-a", status: "under_review", title: "North site", details: "Capture site.",
            deliverables_text: null, project_alpha_client_id: "client-public-a",
            project_alpha_organization_id: null, project_alpha_project_id: "project-public-a",
            portal_project_id: "portal-pa-9", project_authorized: 0,
            area_geojson: null, poi_points_json: "[]", effective_area_geojson: null,
            effective_poi_points_json: null, area_revision: null, request_revision: 3, scope_text: null,
          };
        return null;
      },
      all(kind, sql) {
        return kind === "delivery" && sql.includes("FROM client_service_request_services")
          ? [{ service_public_id: "svc-ortho", service_source_version: "catalog-7", answers_json: "{}" }]
          : [];
      },
    };
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-draft", {
      method: "POST", headers: { Origin: "https://ops.example" },
    }), {
      ...environment(state), APPLICATION_KEY: "ltds_ops",
      PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "true",
      PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "draft-only-key",
      PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    } as any, executionCtx);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("no longer linked to an authorized Project Alpha project");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("replays the immutable local PA receipt without a second upstream command", async () => {
    const requestRow = {
      id: "request-a", status: "under_review", title: "North site mapping",
      details: "Capture site.", deliverables_text: null,
      project_alpha_client_id: "client-public-a", project_alpha_organization_id: null,
      project_alpha_project_id: "project-public-a", area_geojson: null,
      portal_project_id: "portal-pa-9", project_authorized: 1,
      poi_points_json: "[]", effective_area_geojson: null, effective_poi_points_json: null,
      area_revision: null, request_revision: 3, scope_text: "Capture site.",
    };
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery") return null;
        if (sql.includes("request_revision") && sql.includes("FROM client_service_requests")) return requestRow;
        if (sql.includes("WHERE request_id=? AND request_revision=? AND area_revision=?"))
          return {
            request_revision: 3, area_revision: 0,
            idempotency_key: "ltds-pa-draft:request-a:r3:a0",
            payload_hash: replayPayloadHash,
            project_alpha_receipt_id: "receipt-public-a",
            project_alpha_artifact_public_id: "quote-public-a",
            document_number: "Q-DRAFT-7", artifact_status: "draft", artifact_version: 1,
            editor_path: "/quotes/quote-public-a/edit", created_at: "2026-08-13T12:00:00Z",
          };
        return null;
      },
      all(kind, sql) {
        if (kind !== "delivery") return undefined;
        if (sql.includes("FROM client_service_request_services"))
          return [{ service_public_id: "svc-ortho", service_source_version: "catalog-7", answers_json: "{}" }];
        if (sql.includes("FROM client_service_request_attachments")) return [];
        return undefined;
      },
    };
    const env = {
      ...environment(state), APPLICATION_KEY: "ltds_ops",
      PROJECT_ALPHA_DRAFT_QUOTES_ENABLED: "true",
      PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: "draft-only-key",
      PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    };
    const { canonicalProjectAlphaJson, sha256Hex } = await import("../src/worker/project-alpha-draft-quote");
    const areaHash = await sha256Hex(canonicalProjectAlphaJson({ areaGeoJson: null, poiPoints: [] }));
    const replayPayloadHash = await sha256Hex(canonicalProjectAlphaJson({
      schemaVersion: 1,
      source: "ltds-operations",
      request: { publicId: "request-a", revision: 3, title: "North site mapping", scopeSummary: "Capture site.", deliverablesSummary: null },
      authorization: { organizationPublicId: null, clientPublicId: "client-public-a", projectPublicId: "project-public-a" },
      services: [{ publicId: "svc-ortho", catalogVersion: "catalog-7", answers: {} }],
      workArea: { revision: 0, hash: areaHash, squareMeters: null, acres: null },
      attachments: [],
    }));
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-draft", {
      method: "POST", headers: { Origin: "https://ops.example" },
    }), env as any, executionCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receiptId: "receipt-public-a", idempotentReplay: true });
    expect(upstream).not.toHaveBeenCalled();
    expect(state.batches).toEqual([]);
  });

  it("exports only the authorized stored request geometry as KML", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery") return null;
        if (sql.includes("JOIN client_accounts"))
          return {
            title: "North site / mapping",
            area_geojson: JSON.stringify({ type: "Polygon", coordinates: [[[-88, 44], [-87.9, 44], [-87.9, 44.1], [-88, 44]]] }),
            poi_points_json: JSON.stringify([{ longitude: -87.95, latitude: 44.05, label: "Gate" }]),
          };
        return null;
      },
    };
    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/area.kml?revision=effective"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/vnd.google-earth.kml+xml");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="North-site-mapping-effective-work-area.kml"');
    const body = await response.text();
    expect(body).toContain("<name>Gate</name>");
    expect(body).toContain("-88,44,0 -87.9,44,0 -87.9,44.1,0 -88,44,0");
    expect(body).not.toContain("project_alpha_client_id");
    expect(state.runs).toEqual([
      expect.stringContaining("work_area_kml_exported"),
    ]);
  });

  it("uses the immutable client revision for original KML and rejects invalid selectors", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind !== "delivery") return null;
        if (sql.includes("JOIN client_accounts"))
          return { title: "Changed area", area_geojson: null, poi_points_json: "[]" };
        if (sql.includes("FROM request_revisions"))
          return { snapshot_json: JSON.stringify({
            areaGeoJson: { type: "Polygon", coordinates: [[[-89, 43], [-88.8, 43], [-88.8, 43.2], [-89, 43]]] },
            poiPoints: [],
          }) };
        return null;
      },
    };
    const original = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/area.kml?revision=original"),
      environment(state) as any,
      executionCtx,
    );
    expect(original.status).toBe(200);
    expect(await original.text()).toContain("-89,43,0 -88.8,43,0 -88.8,43.2,0 -89,43,0");
    expect(state.runs).toEqual([
      expect.stringContaining("work_area_kml_exported"),
    ]);

    const invalid = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/area.kml?revision=other"),
      environment(state) as any,
      executionCtx,
    );
    expect(invalid.status).toBe(400);
  });

  it("returns no KML bytes when the durable export audit fails", async () => {
    const state: DbState = {
      batches: [],
      first(kind, sql) {
        if (kind === "delivery" && sql.includes("JOIN client_accounts"))
          return {
            title: "North site mapping",
            area_geojson: JSON.stringify({
              type: "Polygon",
              coordinates: [[[-88, 44], [-87.9, 44], [-87.9, 44.1], [-88, 44]]],
            }),
            poi_points_json: "[]",
          };
        return null;
      },
      run(kind, sql) {
        if (kind === "delivery" && sql.includes("work_area_kml_exported"))
          throw new Error("simulated D1 audit outage");
        return undefined;
      },
    };
    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/area.kml?revision=effective"),
      environment(state) as any,
      executionCtx,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).not.toContain(
      "application/vnd.google-earth.kml+xml",
    );
    const body = await response.text();
    expect(body).toContain("An unexpected error occurred");
    expect(body).not.toContain("<kml");
    expect(body).not.toContain("-88,44,0");
  });
});
