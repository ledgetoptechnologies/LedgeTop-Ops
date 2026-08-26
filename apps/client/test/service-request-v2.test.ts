import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { validateRequestArea } from "../src/worker/client-portal/request-area";
import {
  calculateRequestAreaSquareMeters,
  createServiceRequestDraft,
  getServiceRequestDraft,
  saveServiceRequestDraft,
  sanitizeServiceQuestions,
  submitServiceRequestDraft,
  validateServiceAnswers,
} from "../src/worker/client-portal/request-v2";
import type {
  ClientPortalRepository,
  ClientPortalSession,
  ClientServiceRequestDraft,
  ClientServiceRequestDraftInput,
  ResolveClientPrincipal,
} from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const session: ClientPortalSession = {
  accountId: "account-a", identityId: "identity-a", displayName: "Acme",
  role: "manager", canViewBilling: false,
};
const principal: ResolveClientPrincipal = vi.fn(async () => ({
  issuer: "https://identity.example", subject: "client-user-1", email: "client@example.com",
}));
const polygon = {
  type: "Polygon" as const,
  coordinates: [[[-88, 44], [-87.99, 44], [-87.99, 44.01], [-88, 44.01], [-88, 44]]] as [number, number][][],
};
const service = {
  publicId: "svc-mapping", sourceVersion: "v7", name: "2D Mapping", summary: "Orthomosaic mapping",
  category: "Mapping", displayOrder: 10, geometryRequirement: "required" as const,
  questions: [{ id: "resolution", label: "Resolution", type: "select" as const, required: true, helpText: null, options: [{ value: "standard", label: "Standard" }] }],
  answers: { resolution: "standard" },
};
const draft: ClientServiceRequestDraft = {
  id: "draft-a", state: "draft", version: 2, projectId: "project-a", requestType: "service",
  title: "Map the site", details: "Capture the current construction area.", location: null,
  preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
  siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null,
  areaGeoJson: polygon, poiPoints: [], areaSquareMeters: 889_000, areaAcres: 219.7,
  services: [service], submittedRequestId: null, createdAt: "2026-08-13 12:00:00", updatedAt: "2026-08-13 12:01:00",
};

function repository(overrides: Partial<ClientPortalRepository> = {}): ClientPortalRepository {
  return {
    resolveSession: vi.fn(async () => session), listProjects: vi.fn(async () => []), getProject: vi.fn(async () => null),
    listProjectFiles: vi.fn(async () => null), listPastDeliveries: vi.fn(async () => ({ files: [], prefix: "", cursor: null })),
    listProjectFileLocations: vi.fn(async () => null), listPastDeliveryLocations: vi.fn(async () => ({ points: [], imageCount: 0, truncated: false })),
    getAuthorizedFile: vi.fn(async () => null), listDeliveries: vi.fn(async () => []), getDeliveryHandoff: vi.fn(async () => null),
    listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0, cursor: null })), updateNotification: vi.fn(async () => false),
    listServiceRequests: vi.fn(async () => []), getServiceRequest: vi.fn(async () => null), createServiceRequest: vi.fn(async () => null),
    updateServiceRequest: vi.fn(async () => null), createChangeRequest: vi.fn(async () => null), listMembers: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []), createInvitation: vi.fn(async () => null), revokeMember: vi.fn(async () => false), revokeInvitation: vi.fn(async () => false),
    ...overrides,
  };
}

const env = {
  CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_REQUEST_V2_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example", ENVIRONMENT: "development",
} as Env;
const draftBody = {
  projectId: "project-a", requestType: "service", title: "Map the site", details: "Capture the current construction area.",
  location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
  siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: polygon, poiPoints: [],
  services: [{ publicId: "svc-mapping", sourceVersion: "v7", answers: { resolution: "standard" } }],
};

describe("service request v2 validation", () => {
  it("computes authoritative square meters from the validated Mapbox polygon", () => {
    const area = calculateRequestAreaSquareMeters(polygon);
    expect(area).toBeGreaterThan(880_000);
    expect(area).toBeLessThan(900_000);
    expect(calculateRequestAreaSquareMeters(null)).toBeNull();
  });

  it.each([
    { latitude: 0, expectedSquareMeters: 12_363_718_145 },
    { latitude: 45, expectedSquareMeters: 8_666_174_571 },
    { latitude: 80, expectedSquareMeters: 2_040_679_782 },
  ])("matches the spherical area of a one-degree bounded rectangle at $latitude degrees", ({ latitude, expectedSquareMeters }) => {
    const rectangle = {
      type: "Polygon" as const,
      coordinates: [[[0, latitude], [1, latitude], [1, latitude + 1], [0, latitude + 1], [0, latitude]]] as [number, number][][],
    };
    expect(calculateRequestAreaSquareMeters(validateRequestArea(rectangle))).toBeCloseTo(expectedSquareMeters, -3);
  });

  it("accepts only sanitized catalog questions and schema-conforming answers", () => {
    const questions = sanitizeServiceQuestions(service.questions)!;
    expect(validateServiceAnswers(questions, { resolution: "standard" })).toEqual({ resolution: "standard" });
    expect(validateServiceAnswers(questions, {}, true)).toEqual({});
    expect(validateServiceAnswers(questions, {})).toBeNull();
    expect(validateServiceAnswers(questions, { resolution: "premium" })).toBeNull();
    expect(validateServiceAnswers(questions, { resolution: "standard", injected: "value" })).toBeNull();
    expect(sanitizeServiceQuestions([{ ...service.questions[0], label: "unsafe\u0000label" }])).toBeNull();
  });
});

describe("service request v2 transaction-time catalog contract", () => {
  let miniflare: Miniflare;
  let database: D1Database;
  let repositoryEnv: Env;
  const input: ClientServiceRequestDraftInput = { ...draftBody, requestType: "service" };
  const tables = ["client_service_request_drafts", "client_service_request_draft_services",
    "client_service_request_draft_mutations", "client_service_requests", "client_service_request_services",
    "request_revisions", "client_portal_notification_outbox", "audit_log"] as const;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "request-v2-catalog-races" } });
    database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    // Use the deployed constraints, indexes and attachment triggers, not a
    // permissive mock schema that could hide partial submission side effects.
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(name, directory), "utf8").replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "");
      if (/\bCREATE\s+TRIGGER\b/i.test(sql)) {
        await database.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
      } else {
        const statements = sql.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(value => value && !/^PRAGMA/i.test(value));
        if (name === "0103_client_portal_workspace.sql") await database.batch(statements.map(statement => database.prepare(statement)));
        else for (const statement of statements) await database.prepare(statement).run();
      }
    }
    await database.batch([
      database.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES('account-a','Acme','active')"),
      database.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('identity-a','account-a','https://issuer.test','subject-a','client@example.test')"),
      database.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account-a','identity-a','manager')"),
      database.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix,active) VALUES('project-a','Acme','Site mapping','Clients/Acme/Mapping/',1)"),
      database.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES('account-a','project-a',1)"),
    ]);
    repositoryEnv = { DELIVERY_DB: database } as Env;
  }, 60_000);

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await database.batch([
      database.prepare("DELETE FROM client_service_request_drafts"),
      database.prepare("DELETE FROM client_service_requests"),
      database.prepare("DELETE FROM audit_log"),
      database.prepare("DELETE FROM pa_service_catalog_items"),
      database.prepare("UPDATE client_project_grants SET can_request_service=1,revoked_at=NULL"),
      database.prepare(`INSERT INTO pa_service_catalog_items
        (public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,'2026-08-25T12:00:00Z')`)
        .bind(service.publicId, service.sourceVersion, service.name, service.summary, service.category, service.displayOrder,
          service.geometryRequirement, JSON.stringify(service.questions)),
    ]);
  });

  function beforeTransaction(action: () => Promise<unknown>): Env {
    let pending = true;
    const wrapped = new Proxy(database, {
      get(target, property) {
        if (property === "withSession") return () => wrapped;
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          if (pending) { pending = false; await action(); }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...repositoryEnv, DELIVERY_DB: wrapped };
  }

  async function createdDraft(): Promise<ClientServiceRequestDraft> {
    const result = await createServiceRequestDraft(repositoryEnv, session, input, "initial-draft-key-0001");
    expect(result?.kind).toBe("created");
    if (!result || !("draft" in result)) throw new Error("Expected a created draft");
    return result.draft;
  }

  async function requestState() {
    const results = await database.batch(tables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
    return results.map(result => result.results);
  }

  async function changeCatalog(kind: "deactivated" | "version_changed", publicId = service.publicId) {
    await database.prepare("UPDATE pa_service_catalog_items SET active=0 WHERE public_id=?").bind(publicId).run();
    if (kind === "version_changed") {
      await database.prepare(`INSERT INTO pa_service_catalog_items
        (public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        SELECT public_id,'v8',name,summary,category,display_order,geometry_requirement,question_schema_json,1,'2026-08-25T13:00:00Z'
        FROM pa_service_catalog_items WHERE public_id=? AND source_version='v7'`).bind(publicId).run();
    }
  }

  for (const operation of ["create", "save", "submit"] as const) {
    it.each(["deactivated", "version_changed"] as const)(`rejects a %s service changed between ${operation} review and transaction without partial writes`, async change => {
      const original = operation === "create" ? null : await createdDraft();
      const before = await requestState();
      const mutationKey = `catalog-${operation}-race-0001`;
      const changedInput = { ...input, title: "Updated mapping request" };
      const raceEnv = beforeTransaction(() => changeCatalog(change));
      const mutate = (target: Env) => operation === "create"
        ? createServiceRequestDraft(target, session, input, mutationKey)
        : operation === "save"
          ? saveServiceRequestDraft(target, session, original!.id, original!.version, changedInput, mutationKey)
          : submitServiceRequestDraft(target, session, original!.id, original!.version, mutationKey);
      expect(await mutate(raceEnv)).toEqual(operation === "submit"
        ? { kind: "incomplete", reason: "catalog_changed", servicePublicIds: [service.publicId] }
        : { kind: "catalog_changed", servicePublicIds: [service.publicId] });
      expect(await requestState()).toEqual(before);
      // A rejected transaction consumes neither the optimistic version nor the
      // idempotency key. The exact reviewed version can still be retried safely.
      await database.batch([
        database.prepare("DELETE FROM pa_service_catalog_items WHERE source_version='v8'"),
        database.prepare("UPDATE pa_service_catalog_items SET active=1 WHERE source_version='v7'"),
      ]);
      expect((await mutate(repositoryEnv))?.kind).toBe(operation === "create" ? "created" : operation === "save" ? "updated" : "submitted");
      const after = await requestState();
      await changeCatalog(change);
      expect((await mutate(repositoryEnv))?.kind).toBe("replayed");
      expect(await requestState()).toEqual(after);
      expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    });
  }

  it("checks every reviewed service at the ten-selection boundary, not just the first", async () => {
    const services = Array.from({ length: 10 }, (_, index) => ({ ...input.services[0]!, publicId: `svc-mapping-${index}` }));
    await database.batch(services.map(selected => database.prepare(`INSERT INTO pa_service_catalog_items
      (public_id,source_version,name,category,geometry_requirement,question_schema_json,active,source_updated_at)
      VALUES(?,'v7','Mapping','Mapping','required',?,1,'2026-08-25T12:00:00Z')`).bind(selected.publicId, JSON.stringify(service.questions))));
    const boundedInput = { ...input, services };
    const before = await requestState();
    expect(await createServiceRequestDraft(beforeTransaction(() => changeCatalog("version_changed", services[9]!.publicId)), session,
      boundedInput, "catalog-ten-services-0001")).toEqual({ kind: "catalog_changed", servicePublicIds: [services[9]!.publicId] });
    expect(await requestState()).toEqual(before);
  });

  it("allows an empty autosave but keeps submission incomplete", async () => {
    const result = await createServiceRequestDraft(repositoryEnv, session, { ...input, services: [] }, "empty-draft-create-0001");
    expect(result?.kind).toBe("created");
    if (!result || !("draft" in result)) throw new Error("Expected draft");
    expect(await submitServiceRequestDraft(repositoryEnv, session, result.draft.id, result.draft.version, "empty-draft-submit-0001"))
      .toEqual({ kind: "incomplete", reason: "answers_incomplete", servicePublicIds: [] });
  });

  it("does not turn a current catalog into permission to submit after the project grant changes", async () => {
    const original = await createdDraft();
    const before = await requestState();
    const result = await submitServiceRequestDraft(beforeTransaction(() => database.prepare("UPDATE client_project_grants SET can_request_service=0").run()),
      session, original.id, original.version, "catalog-grant-submit-0001");
    expect(result).toEqual({ kind: "conflict" });
    expect(await requestState()).toEqual(before);
    expect((await getServiceRequestDraft(repositoryEnv, session, original.id))?.state).toBe("draft");
  });

  it("preserves the optimistic version conflict with an unchanged reviewed catalog", async () => {
    const original = await createdDraft();
    expect((await saveServiceRequestDraft(repositoryEnv, session, original.id, original.version, { ...input, title: "Saved first" }, "catalog-first-save-0001"))?.kind).toBe("updated");
    const before = await requestState();
    expect(await saveServiceRequestDraft(repositoryEnv, session, original.id, original.version, { ...input, title: "Stale save" }, "catalog-stale-save-0001"))
      .toEqual({ kind: "conflict" });
    expect(await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, "catalog-stale-submit-0001"))
      .toEqual({ kind: "conflict" });
    expect(await requestState()).toEqual(before);
  });
});

describe("service request v2 routes", () => {
  it("lists only the repository's authorized resumable drafts", async () => {
    const summaries = [{
      id: "draft-a", projectId: "project-a", title: "Map the site",
      serviceNames: ["2D Mapping"], areaAcres: 219.7, updatedAt: "2026-08-13 12:01:00",
    }];
    const list = vi.fn(async () => summaries);
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ listServiceRequestDrafts: list }) });
    const response = await app.request("https://client.example/service-request-drafts", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drafts: summaries });
    expect(list).toHaveBeenCalledWith(expect.anything(), session);
  });

  it("autosaves with optimistic versioning and rejects browser-computed money or area", async () => {
    const save = vi.fn(async () => ({ kind: "updated" as const, draft: { ...draft, version: 3 } }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ saveServiceRequestDraft: save }) });
    const response = await app.request("https://client.example/service-request-drafts/draft-a", {
      method: "PUT", headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-save-00000001", "If-Match": "2" },
      body: JSON.stringify(draftBody),
    }, env);
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(expect.anything(), session, "draft-a", 2, expect.objectContaining({ areaGeoJson: polygon }), "draft-save-00000001");

    const injected = await app.request("https://client.example/service-request-drafts/draft-a", {
      method: "PUT", headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-save-00000002", "If-Match": "2" },
      body: JSON.stringify({ ...draftBody, areaAcres: 1, priceMinor: 1 }),
    }, env);
    expect(injected.status).toBe(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("returns a typed catalog drift response for create and save", async () => {
    const catalogChanged = {
      kind: "catalog_changed" as const,
      servicePublicIds: ["svc-mapping"],
    };
    const create = vi.fn(async () => catalogChanged);
    const save = vi.fn(async () => catalogChanged);
    const app = createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ createServiceRequestDraft: create, saveServiceRequestDraft: save }),
    });
    const createResponse = await app.request("https://client.example/service-request-drafts", {
      method: "POST",
      headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-create-drift-0001" },
      body: JSON.stringify(draftBody),
    }, env);
    expect(createResponse.status).toBe(409);
    expect(await createResponse.json()).toEqual({
      error: expect.any(String),
      code: "catalog_changed",
      servicePublicIds: ["svc-mapping"],
    });

    const saveResponse = await app.request("https://client.example/service-request-drafts/draft-a", {
      method: "PUT",
      headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-save-drift-0001", "If-Match": "2" },
      body: JSON.stringify(draftBody),
    }, env);
    expect(saveResponse.status).toBe(409);
    expect(await saveResponse.json()).toMatchObject({ code: "catalog_changed", servicePublicIds: ["svc-mapping"] });
  });

  it("enforces at most ten unique Project Alpha service ids", async () => {
    const create = vi.fn();
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createServiceRequestDraft: create }) });
    const response = await app.request("https://client.example/service-request-drafts", {
      method: "POST", headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-create-000001" },
      body: JSON.stringify({ ...draftBody, services: [draftBody.services[0], draftBody.services[0]] }),
    }, env);
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps pricing unavailable without an authorized v2 workspace/project context", async () => {
    const getServiceRequestDraft = vi.fn(async () => draft);
    const provider = vi.fn(async () => ({ kind: "starting_at" as const, currency: "USD", startingAtMinor: 150_000, disclaimer: "Final quote after review.", basisVersion: "pricing-v3", validUntil: "2026-08-13T13:00:00.000Z" }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ getServiceRequestDraft }), pricingHintProvider: provider });
    const response = await app.request("https://client.example/service-request-drafts/draft-a/pricing-hint", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, hint: null });
    expect(provider).not.toHaveBeenCalled();
  });

  it("submits with version and idempotency headers and preserves replay status", async () => {
    const request = {
      id: "request-a", projectId: "project-a", requestType: "service" as const, title: draft.title, details: draft.details,
      location: null, preferredStartAt: null, serviceCategory: "2D Mapping", deliverables: null, siteContactName: null,
      siteContactEmail: null, siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null,
      status: "submitted" as const, createdAt: "2026-08-13 12:02:00", updatedAt: "2026-08-13 12:02:00",
    };
    const submit = vi.fn(async () => ({ kind: "replayed" as const, request }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ submitServiceRequestDraft: submit }) });
    const response = await app.request("https://client.example/service-request-drafts/draft-a/submit", {
      method: "POST", headers: { Origin: "https://client.example", "Idempotency-Key": "draft-submit-000001", "If-Match": "2" },
    }, env);
    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledWith(expect.anything(), session, "draft-a", 2, "draft-submit-000001");
  });

  it.each([
    ["answers_incomplete", { servicePublicIds: ["svc-mapping"] as string[] }],
    ["geometry_required", { servicePublicIds: ["svc-mapping"] as string[] }],
    ["catalog_changed", { servicePublicIds: ["svc-mapping"] as string[] }],
    ["attachments_pending", { attachmentCount: 2 }],
    ["attachments_rejected", { attachmentCount: 1 }],
    ["attachments_expired", { attachmentCount: 1 }],
  ] as const)("returns a safe typed %s submit block", async (reason, details) => {
    const submit = vi.fn(async () => ({ kind: "incomplete" as const, reason, ...details }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ submitServiceRequestDraft: submit }) });
    const response = await app.request("https://client.example/service-request-drafts/draft-a/submit", {
      method: "POST",
      headers: { Origin: "https://client.example", "Idempotency-Key": `draft-submit-${reason}-0001`, "If-Match": "2" },
    }, env);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.any(String), code: reason, ...details });
  });
});
