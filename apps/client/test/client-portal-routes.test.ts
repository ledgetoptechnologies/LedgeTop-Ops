import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import deliveryWorker from "../src/worker/index";
import { Hono } from "hono";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import type {
  ClientPortalRepository,
  ClientPortalSession,
  ClientServiceRequest,
  ResolveClientPrincipal,
} from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const session: ClientPortalSession = { accountId: "account-a", identityId: "identity-a", displayName: "Acme", role: "manager", canViewBilling: false };
const serviceRequest: ClientServiceRequest = {
  id: "request-1",
  projectId: "project-a",
  requestType: "flight",
  title: "Site flight",
  details: "Capture current site conditions.",
  location: "Chicago",
  preferredStartAt: "2026-08-10T15:00:00.000Z",
  serviceCategory: null,
  deliverables: null,
  siteContactName: null,
  siteContactEmail: null,
  siteContactPhone: null,
  desiredCompletionAt: null,
  latitude: null,
  longitude: null,
  status: "submitted",
  createdAt: "2026-07-31 12:00:00",
  updatedAt: "2026-07-31 12:00:00",
};

function repository(overrides: Partial<ClientPortalRepository> = {}): ClientPortalRepository {
  return {
    resolveSession: vi.fn(async () => session),
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => null),
    listProjectFiles: vi.fn(async () => null),
    listPastDeliveries: vi.fn(async () => ({ files: [], prefix: "", cursor: null })),
    listProjectFileLocations: vi.fn(async () => null),
    listPastDeliveryLocations: vi.fn(async () => ({ points: [], imageCount: 0, truncated: false })),
    getAuthorizedFile: vi.fn(async () => null),
    listDeliveries: vi.fn(async () => []),
    getDeliveryHandoff: vi.fn(async () => null),
    listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0, cursor: null })),
    updateNotification: vi.fn(async () => false),
    listServiceRequests: vi.fn(async () => []),
    getServiceRequest: vi.fn(async () => null),
    createServiceRequest: vi.fn(async () => ({ kind: "created" as const, request: serviceRequest })),
    updateServiceRequest: vi.fn(async () => null),
    createChangeRequest: vi.fn(async () => null),
    listMembers: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []),
    createInvitation: vi.fn(async () => null),
    revokeMember: vi.fn(async () => false),
    revokeInvitation: vi.fn(async () => false),
    ...overrides,
  };
}

function env(
  flag?: string,
  origin = "http://localhost",
  limiter: RateLimit | null = { limit: async () => ({ success: true }) } as RateLimit,
): Env {
  return {
    CLIENT_PORTAL_ENABLED: flag,
    CLIENT_PORTAL_ORIGIN: origin,
    ENVIRONMENT: "development",
    ...(limiter ? { PUBLIC_BULK_RATE_LIMITER: limiter } : {}),
  } as Env;
}

const principal: ResolveClientPrincipal = vi.fn(async () => ({ issuer: "https://identity.example", subject: "client-user-1", email: "client@example.com" }));

describe("client portal feature gate", () => {
  it.each([undefined, "", "false", "TRUE", "1"])("returns a terminal 404 while disabled (%s)", async flag => {
    const resolvePrincipal = vi.fn(async () => ({ issuer: "issuer", subject: "subject", email: "client@example.com" }));
    const repo = repository();
    const response = await createClientPortalRouter({ resolvePrincipal, repository: repo }).request("/session", {}, env(flag));
    expect(response.status).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(repo.resolveSession).not.toHaveBeenCalled();
  });

  it("has no browser-header authentication bypass when enabled without a provider", async () => {
    const response = await createClientPortalRouter().request("/session", {
      headers: {
        "Cf-Access-Authenticated-User-Email": "client@example.com",
        "X-Client-Account-Id": "account-a",
      },
    }, env("true"));
    expect(response.status).toBe(503);
  });

  it("requires an Access assertion after the dedicated client configuration is present", async () => {
    const response = await createClientPortalRouter().request("https://client.example/session", {
      headers: { "Cf-Access-Authenticated-User-Email": "client@example.com" },
    }, {
      ...env("true", "https://client.example"),
      CLIENT_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CLIENT_ACCESS_AUD: "client-portal-audience",
    });
    expect(response.status).toBe(401);
  });

  it("fails closed when a verified identity has no active local account", async () => {
    const response = await createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ resolveSession: vi.fn(async () => null) }),
    }).request("/session", {}, env("true"));
    expect(response.status).toBe(403);
  });
});

describe("client portal route authorization context", () => {
  it("derives the session and lists only repository-authorized projects", async () => {
    const listProjects = vi.fn(async (_env: Env, activeSession: ClientPortalSession) => {
      expect(activeSession).toEqual(session);
      return [{ id: "project-a", externalRef: "alpha-1", clientName: "Acme", projectName: "Plant", canRequestService: true }];
    });
    const response = await createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ listProjects }) })
      .request("/projects", {}, env("true"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ projects: [{ id: "project-a", canRequestService: true }] });
  });

  it("passes project and delivery selectors through the server-side grant repository", async () => {
    const listDeliveries = vi.fn(async (_env: Env, activeSession: ClientPortalSession, projectId: string) => {
      expect(activeSession).toEqual(session);
      expect(projectId).toBe("project-a");
      return [{ shareId: "share-a", publicId: "public-a", shareVersion: 3, label: "Finals", expiresAt: null, requiresPassword: true, handoffPath: "/api/client/projects/project-a/deliveries/share-a/handoff" }];
    });
    const response = await createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ listDeliveries }) })
      .request("/projects/project-a/deliveries", {}, env("true"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deliveries: [{ publicId: "public-a", requiresPassword: true }] });
  });

  it("returns only repository-authorized project image locations and no asset keys", async () => {
    const listProjectFileLocations = vi.fn(async (_env: Env, activeSession: ClientPortalSession, projectId: string) => {
      expect(activeSession).toEqual(session);
      expect(projectId).toBe("project-a");
      return { points: [{ latitude: 44.5, longitude: -88.1, imageCount: 2 }], imageCount: 2, truncated: false };
    });
    const response = await createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ listProjectFileLocations }),
    }).request("/projects/project-a/file-locations", {}, env("true"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ imageCount: 2, points: [{ imageCount: 2 }] });
    expect(JSON.stringify(body)).not.toMatch(/source|key|etag/i);
  });

  it("uses a non-enumerating 404 for revoked or cross-client project location scopes", async () => {
    const response = await createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ listProjectFileLocations: vi.fn(async () => null) }),
    }).request("/projects/project-b/file-locations", {}, env("true"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Project not found");
  });

  it("rechecks the local delivery grant before redirecting into the existing public-share flow", async () => {
    const getDeliveryHandoff = vi.fn(async (_env: Env, activeSession: ClientPortalSession, projectId: string, shareId: string) => {
      expect(activeSession).toEqual(session);
      expect([projectId, shareId]).toEqual(["project-a", "share-a"]);
      return { publicId: "public-a" };
    });
    const response = await createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ getDeliveryHandoff }) })
      .request("https://client.example/projects/project-a/deliveries/share-a/handoff", {}, env("true", "https://client.example"));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/s/public-a");
  });

  it("never accepts a browser-supplied account identity in a service request", async () => {
    const createServiceRequest = vi.fn(async () => ({ kind: "created" as const, request: serviceRequest }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createServiceRequest }) });
    const response = await app.request("https://client.example/service-requests", {
      method: "POST",
      headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "request-test-0001" },
      body: JSON.stringify({
        accountId: "account-b",
        projectId: "project-a",
        requestType: "flight",
        title: "Site flight",
        details: "Capture current site conditions.",
      }),
    }, env("true", "https://client.example"));
    expect(response.status).toBe(400);
    expect(createServiceRequest).not.toHaveBeenCalled();
  });

  it("requires same-origin mutation and creates from the resolved session", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const createServiceRequest = vi.fn(async (_env: Env, activeSession: ClientPortalSession, input) => {
      expect(activeSession).toEqual(session);
      expect(input).toMatchObject({ projectId: "project-a", requestType: "service" });
      return { kind: "created" as const, request: { ...serviceRequest, requestType: "service" as const } };
    });
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createServiceRequest }) });
    const body = JSON.stringify({ projectId: "project-a", requestType: "service", title: "Model update", details: "Please refresh the site model." });
    const crossOrigin = await app.request("https://client.example/service-requests", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json", "Idempotency-Key": "request-test-0001" },
      body,
    }, env("true", "https://client.example", { limit } as RateLimit));
    expect(crossOrigin.status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
    expect(createServiceRequest).not.toHaveBeenCalled();

    const created = await app.request("https://client.example/service-requests", {
      method: "POST",
      headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "request-test-0001" },
      body,
    }, env("true", "https://client.example", { limit } as RateLimit));
    expect(created.status).toBe(201);
    expect(limit).toHaveBeenCalledWith({ key: "client-service-request:create:account-a" });
    expect(createServiceRequest).toHaveBeenCalledTimes(1);
  });

  it("accepts a same-origin mutation on the reviewed secondary portal domain without accepting mixed-domain requests", async () => {
    const createServiceRequest = vi.fn(async () => ({ kind: "created" as const, request: serviceRequest }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createServiceRequest }) });
    const dualDomainEnv = {
      ...env("true", "https://client.drone.example"),
      CLIENT_PORTAL_ORIGINS: "https://client.drone.example,https://client.technology.example",
    };
    const body = JSON.stringify({ projectId: "project-a", requestType: "flight", title: "Site flight", details: "Capture current site conditions." });
    const mixed = await app.request("https://client.technology.example/service-requests", {
      method: "POST",
      headers: { Origin: "https://client.drone.example", "Content-Type": "application/json", "Idempotency-Key": "request-test-secondary-1" },
      body,
    }, dualDomainEnv);
    expect(mixed.status).toBe(403);
    expect(createServiceRequest).not.toHaveBeenCalled();

    const created = await app.request("https://client.technology.example/service-requests", {
      method: "POST",
      headers: { Origin: "https://client.technology.example", "Content-Type": "application/json", "Idempotency-Key": "request-test-secondary-2" },
      body,
    }, dualDomainEnv);
    expect(created.status).toBe(201);
    expect(createServiceRequest).toHaveBeenCalledTimes(1);
  });

  it("uses non-enumerating 404s for invalid or unauthorized resource selectors", async () => {
    const repo = repository({ getServiceRequest: vi.fn(async () => null) });
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repo });
    expect((await app.request("/projects/%2E%2E/deliveries", {}, env("true"))).status).toBe(404);
    expect((await app.request("/service-requests/request-from-account-b", {}, env("true"))).status).toBe(404);
  });
});

describe("client portal service request rate limiting", () => {
  const requestBody = JSON.stringify({
    projectId: "project-a",
    requestType: "service",
    title: "Model update",
    details: "Please refresh the site model.",
  });

  function post(limiter: RateLimit | null, createServiceRequest = vi.fn(async () => ({ kind: "created" as const, request: serviceRequest }))) {
    return {
      response: createClientPortalRouter({
        resolvePrincipal: principal,
        repository: repository({ createServiceRequest }),
      }).request("https://client.example/service-requests", {
        method: "POST",
        headers: {
          Origin: "https://client.example",
          "Content-Type": "application/json",
          "Idempotency-Key": "request-rate-limit-0001",
        },
        body: requestBody,
      }, env("true", "https://client.example", limiter)),
      createServiceRequest,
    };
  }

  it("uses only the resolved account id in a scope-separated limiter key", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const { response, createServiceRequest } = post({ limit } as RateLimit);
    expect((await response).status).toBe(201);
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "client-service-request:create:account-a" });
    expect(createServiceRequest).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable 429 without mutating when the limiter denies the request", async () => {
    const { response, createServiceRequest } = post({ limit: vi.fn(async () => ({ success: false })) } as RateLimit);
    const result = await response;
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("60");
    expect(createServiceRequest).not.toHaveBeenCalled();
  });

  it("fails closed without a usable limiter binding", async () => {
    const missing = post(null);
    expect((await missing.response).status).toBe(503);
    expect(missing.createServiceRequest).not.toHaveBeenCalled();

    const malformed = post({} as RateLimit);
    expect((await malformed.response).status).toBe(503);
    expect(malformed.createServiceRequest).not.toHaveBeenCalled();
  });

  it("fails closed without repository mutation when the limiter errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = post({ limit: vi.fn(async () => { throw new Error("limiter unavailable"); }) } as RateLimit);
    expect((await failed.response).status).toBe(500);
    expect(failed.createServiceRequest).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not consume mutation capacity for authenticated reads", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const response = await createClientPortalRouter({ resolvePrincipal: principal, repository: repository() })
      .request("/service-requests", {}, env("true", "http://localhost", { limit } as RateLimit));
    expect(response.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("client portal service request reads", () => {
  it("lists and gets requests only through the resolved repository session", async () => {
    const listServiceRequests = vi.fn(async (_env: Env, activeSession: ClientPortalSession) => {
      expect(activeSession).toEqual(session);
      return [serviceRequest];
    });
    const getServiceRequest = vi.fn(async (_env: Env, activeSession: ClientPortalSession, requestId: string) => {
      expect(activeSession).toEqual(session);
      expect(requestId).toBe("request-1");
      return serviceRequest;
    });
    const app = createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ listServiceRequests, getServiceRequest }),
    });
    const listed = await app.request("/service-requests", {}, env("true"));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ requests: [{ id: "request-1", projectId: "project-a" }] });
    const fetched = await app.request("/service-requests/request-1", {}, env("true"));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ request: { id: "request-1", status: "submitted" } });
  });
});

describe("client portal team management", () => {
  it("exposes team controls only through the resolved manager session", async () => {
    const listMembers = vi.fn(async () => [{ identityId: "member-a", email: "member@example.com", role: "member" as const, canViewBilling: false }]);
    const listInvitations = vi.fn(async () => [{ id: "invite-a", email: "new@example.com", projectIds: ["project-a"], expiresAt: "2026-08-07T00:00:00.000Z" }]);
    const response = await createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ listMembers, listInvitations }) })
      .request("/team", {}, { ...env("true"), CLIENT_PORTAL_TEAM_ENABLED: "true" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ members: [{ identityId: "member-a" }], invitations: [{ id: "invite-a" }] });
    expect(listMembers).toHaveBeenCalledWith(expect.anything(), session);
  });

  it("requires same-origin, rate limited manager invitation creation", async () => {
    const createInvitation = vi.fn(async () => ({ id: "invite-a", email: "new@example.com", projectIds: ["project-a"], expiresAt: "2026-08-07T00:00:00.000Z" }));
    const limit = vi.fn(async () => ({ success: true }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createInvitation }) });
    const response = await app.request("https://client.example/team/invitations", {
      method: "POST",
      headers: { Origin: "https://client.example", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", projectIds: ["project-a"] }),
    }, { ...env("true", "https://client.example", { limit } as RateLimit), CLIENT_PORTAL_TEAM_ENABLED: "true" });
    expect(response.status).toBe(201);
    expect(limit).toHaveBeenCalledWith({ key: "client-team:invite:account-a" });
    expect(createInvitation).toHaveBeenCalledWith(expect.anything(), session, { email: "new@example.com", projectIds: ["project-a"] });
  });

  it("does not let a non-manager discover or mutate team members", async () => {
    const memberSession: ClientPortalSession = { ...session, role: "member" };
    const repo = repository({
      resolveSession: vi.fn(async () => memberSession),
      listMembers: vi.fn(async () => null),
      listInvitations: vi.fn(async () => null),
      revokeMember: vi.fn(async () => false),
    });
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repo });
    expect((await app.request("https://client.example/team", {}, { ...env("true", "https://client.example"), CLIENT_PORTAL_TEAM_ENABLED: "true" })).status).toBe(403);
    expect((await app.request("https://client.example/team/members/identity-a", {
      method: "DELETE", headers: { Origin: "https://client.example" },
    }, { ...env("true", "https://client.example"), CLIENT_PORTAL_TEAM_ENABLED: "true" })).status).toBe(404);
  });
});

describe("client portal full Worker isolation", () => {
  const executionContext = {
    waitUntil(_promise: Promise<unknown>) {},
    passThroughOnException() {},
  } as ExecutionContext;

  function fullWorkerEnv(flag?: string, origin?: string): Env {
    const database = {
      prepare() {
        throw new Error("D1 must not be touched at this boundary");
      },
      withSession() {
        return database;
      },
    };
    return {
      ENVIRONMENT: "development",
      EXPECTED_HOST: "delivery.example",
      CLIENT_PORTAL_ENABLED: flag,
      CLIENT_PORTAL_ORIGIN: origin,
      DELIVERY_DB: database,
      ASSETS: { fetch: vi.fn(async () => new Response("public app shell")) },
      SESSION_KEY_ID: "v1",
      DELIVERY_SESSION_SECRET: "s".repeat(48),
    } as unknown as Env;
  }

  it.each([undefined, "false"])("mounts /api/client as a terminal default-off 404 (%s)", async flag => {
    const response = await deliveryWorker.fetch(
      new Request("https://delivery.example/api/client/session"),
      fullWorkerEnv(flag),
      executionContext,
    );
    expect(response.status).toBe(404);
  });

  it("keeps an accidentally enabled composition fail-closed when its portal origin is absent", async () => {
    const response = await deliveryWorker.fetch(
      new Request("https://delivery.example/api/client/session"),
      fullWorkerEnv("true"),
      executionContext,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "An unexpected error occurred" });
  });

  it("does not intercept the existing public shell, public API, or health contract when the flag is true", async () => {
    const portalEnabled = fullWorkerEnv("true");
    const shell = await deliveryWorker.fetch(
      new Request("https://delivery.example/s/public-id"),
      portalEnabled,
      executionContext,
    );
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe("public app shell");

    const publicApi = await deliveryWorker.fetch(
      new Request("https://delivery.example/api/public/shares/public-id/manifest"),
      portalEnabled,
      executionContext,
    );
    expect(publicApi.status).toBe(401);
    expect(await publicApi.json()).toEqual({ error: "Delivery session expired", code: "DELIVERY_SESSION_EXPIRED" });

    const health = await deliveryWorker.fetch(
      new Request("https://delivery.example/health"),
      portalEnabled,
      executionContext,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "ltds-delivery" });
  });
});

describe("client portal activation hardening", () => {
  it("rejects an enabled request on any origin other than the configured portal origin", async () => {
    const resolvePrincipal = vi.fn(async () => ({ issuer: "issuer", subject: "subject", email: "client@example.com" }));
    const response = await createClientPortalRouter({ resolvePrincipal, repository: repository() }).request(
      "https://delivery.example/session",
      {},
      env("true", "https://client.example"),
    );
    expect(response.status).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it("bounds service-request bodies before JSON parsing or repository mutation", async () => {
    const createServiceRequest = vi.fn(async () => ({ kind: "created" as const, request: serviceRequest }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createServiceRequest }) });
    const response = await app.request("https://client.example/service-requests", {
      method: "POST",
      headers: {
        Origin: "https://client.example",
        "Content-Type": "application/json",
        "Content-Length": "20000",
        "Idempotency-Key": "request-test-0001",
      },
      body: "{}",
    }, env("true", "https://client.example"));
    expect(response.status).toBe(413);
    expect(createServiceRequest).not.toHaveBeenCalled();

    const streamed = await app.request("https://client.example/service-requests", {
      method: "POST",
      headers: {
        Origin: "https://client.example",
        "Content-Type": "application/json",
        "Idempotency-Key": "request-test-0002",
      },
      body: JSON.stringify({ projectId: "project-a", requestType: "service", title: "Large", details: "x".repeat(17000) }),
    }, env("true", "https://client.example"));
    expect(streamed.status).toBe(413);
    expect(createServiceRequest).not.toHaveBeenCalled();
  });

  it("requires idempotency and distinguishes replay from conflicting reuse", async () => {
    const body = JSON.stringify({ projectId: "project-a", requestType: "service", title: "Model", details: "Refresh the model." });
    const headers = { Origin: "https://client.example", "Content-Type": "application/json" };
    const missing = await createClientPortalRouter({ resolvePrincipal: principal, repository: repository() }).request(
      "https://client.example/service-requests",
      { method: "POST", headers, body },
      env("true", "https://client.example"),
    );
    expect(missing.status).toBe(400);

    const replay = await createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ createServiceRequest: vi.fn(async () => ({ kind: "replayed" as const, request: serviceRequest })) }),
    }).request("https://client.example/service-requests", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": "request-test-0001" },
      body,
    }, env("true", "https://client.example"));
    expect(replay.status).toBe(200);

    const conflict = await createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ createServiceRequest: vi.fn(async () => ({ kind: "conflict" as const })) }),
    }).request("https://client.example/service-requests", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": "request-test-0001" },
      body,
    }, env("true", "https://client.example"));
    expect(conflict.status).toBe(409);
  });

  it("passes only opaque folder and cursor selectors into the authorized project repository", async () => {
    const listProjectFiles = vi.fn(async () => ({ files: [], folders: [], breadcrumbs: [], folderId: "pf1_folder", prefix: "", cursor: null }));
    const response = await createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ listProjectFiles }),
    }).request("/projects/project-a/files?folder=pf1_folder&cursor=pc1_cursor", {}, env("true"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Server-Timing")).toMatch(/^auth;dur=\d+\.\d, list;dur=\d+\.\d$/);
    expect(listProjectFiles).toHaveBeenCalledWith(expect.anything(), session, "project-a", "pc1_cursor", "pf1_folder");
  });

  it("lists only repository-authorized notifications and origin-protects read/dismiss mutations", async () => {
    const listNotifications = vi.fn(async () => ({ notifications: [{ id: "notice-1", eventType: "files_added" as const, title: "New files", body: "Files are available.", actionPath: "/portal/deliveries", readAt: null, createdAt: "2026-08-13 12:00:00" }], unreadCount: 1, cursor: null }));
    const updateNotification = vi.fn(async () => true);
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ listNotifications, updateNotification }) });
    const listed = await app.request("https://client.example/notifications", {}, env("true", "https://client.example"));
    expect(listed.status).toBe(200);
    expect((await listed.json() as any).notifications[0]).not.toHaveProperty("r2Key");
    expect(listNotifications).toHaveBeenCalledWith(expect.anything(), session, null);

    const denied = await app.request("https://client.example/notifications/notice-1", { method: "PATCH", headers: { Origin: "https://other.example", "Content-Type": "application/json" }, body: JSON.stringify({ action: "read" }) }, env("true", "https://client.example"));
    expect(denied.status).toBe(403);
    expect(updateNotification).not.toHaveBeenCalled();
    const allowed = await app.request("https://client.example/notifications/notice-1", { method: "PATCH", headers: { Origin: "https://client.example", "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) }, env("true", "https://client.example"));
    expect(allowed.status).toBe(200);
    expect(updateNotification).toHaveBeenCalledWith(expect.anything(), session, "notice-1", "dismiss", undefined);
  });

  it("pauses notification-table writers without blocking notification reads", async () => {
    const updateNotification = vi.fn(async () => true);
    const app = new Hono().route("/api/client", createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ updateNotification }) }));
    const maintenance = { ...env("true", "https://client.example"), CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE: "true" };
    const read = await app.request("https://client.example/api/client/notifications", {}, maintenance);
    expect(read.status).toBe(200);
    const paused = await app.request("https://client.example/api/client/notifications/notice-1", {
      method: "PATCH",
      headers: { Origin: "https://client.example", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    }, maintenance);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("900");
    expect(await paused.json()).toMatchObject({ code: "notification_migration_maintenance" });
    expect(updateNotification).not.toHaveBeenCalled();
  });

  it("keeps the portal usable before the additive notification schema is migrated", async () => {
    const listNotifications = vi.fn();
    const updateNotification = vi.fn();
    const notificationSchemaAvailable = vi.fn(async () => false);
    const app = createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ listNotifications, updateNotification }),
      notificationSchemaAvailable,
    });

    const listed = await app.request(
      "https://client.example/notifications",
      {},
      env("true", "https://client.example"),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ notifications: [], unreadCount: 0, cursor: null });
    expect(listNotifications).not.toHaveBeenCalled();

    const updated = await app.request("https://client.example/notifications/notice-1", {
      method: "PATCH",
      headers: { Origin: "https://client.example", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    }, env("true", "https://client.example"));
    expect(updated.status).toBe(503);
    expect(await updated.json()).toEqual({
      error: "Client notifications are temporarily unavailable",
      code: "capability_unavailable",
    });
    expect(updateNotification).not.toHaveBeenCalled();
    expect(notificationSchemaAvailable).toHaveBeenCalledTimes(2);
  });

  it("reaches the null identity-provider boundary only after origin configuration is valid", async () => {
    const response = await deliveryWorker.fetch(
      new Request("https://delivery.example/api/client/session"),
      {
        ENVIRONMENT: "development",
        CLIENT_PORTAL_ENABLED: "true",
        CLIENT_PORTAL_ORIGIN: "https://delivery.example",
      } as unknown as Env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "An unexpected error occurred" });
  });
});
