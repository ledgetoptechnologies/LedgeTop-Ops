import { describe, expect, it, vi } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { validateRequestArea } from "../src/worker/client-portal/request-area";
import {
  calculateRequestAreaSquareMeters,
  sanitizeServiceQuestions,
  validateServiceAnswers,
} from "../src/worker/client-portal/request-v2";
import type {
  ClientPortalRepository,
  ClientPortalSession,
  ClientServiceRequestDraft,
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
  services: [{ publicId: "svc-mapping", answers: { resolution: "standard" } }],
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
});
