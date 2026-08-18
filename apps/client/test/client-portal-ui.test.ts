import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPortalChangeRequest,
  createPortalServiceRequest,
  createPortalServiceDraft,
  createPortalViewerSession,
  checkpointPortalAttachmentPart,
  completePortalRequestAttachment,
  initializePortalRequestAttachment,
  invitePortalWorkspaceMember,
  loadPortalBootstrap,
  loadPortalPastDeliveries,
  loadPortalPricingHint,
  loadPortalProjectFolderFiles,
  loadPortalProjectFiles,
  savePortalServiceDraft,
  submitPortalServiceDraft,
  requestPortalAttachmentPartTicket,
  updatePortalServiceRequest,
  type PortalRequest,
  type PortalServiceRequestInput,
} from "../src/client/portal-api";
import { neutralMapLocation } from "../src/client/MapAreaSelector";
import { clientPortalPath, clientProjectPath, clientRequestNewPath, parseClientPortalRoute } from "../src/client/portal-route";
import { isSafeViewerSessionUrl } from "@ltds/ui";

describe("Viewer session navigation", () => {
  it.each([
    ["https://viewer.ledgetopdroneservices.com/session/grant", true],
    ["http://localhost:8080/session/grant", true],
    ["http://127.0.0.1:8080/session/grant", true],
    ["http://viewer.ledgetopdroneservices.com/session/grant", false],
    ["javascript:alert(1)", false],
    ["data:text/html,viewer", false],
    ["file:///session/grant", false],
  ])("classifies %s", (value, expected) => {
    expect(isSafeViewerSessionUrl(value)).toBe(expected);
  });
});

describe("client portal browser routing", () => {
  it.each([
    ["/portal", "dashboard"], ["/portal/", "dashboard"], ["/portal/dashboard", "dashboard"],
    ["/portal/projects", "projects"], ["/portal/deliveries", "deliveries"],
    ["/portal/requests", "requests"], ["/portal/requests/new", "request-new"], ["/portal/account", "account"],
  ])("maps %s to the %s page", (pathname, page) => {
    expect(parseClientPortalRoute(pathname)).toEqual({ isPortal: true, page, projectId: null });
  });

  it("maps a granted project workspace without interpreting nested paths", () => {
    expect(parseClientPortalRoute("/portal/projects/project%20a")).toEqual({ isPortal: true, page: "project", projectId: "project a" });
    expect(parseClientPortalRoute("/portal/projects/project-a/files")).toEqual({ isPortal: true, page: "not-found", projectId: null });
  });

  it("keeps public-share paths outside the portal composition", () => {
    expect(parseClientPortalRoute("/s/public-share-id")).toEqual({ isPortal: false, page: "dashboard", projectId: null });
    expect(parseClientPortalRoute("/")).toEqual({ isPortal: false, page: "dashboard", projectId: null });
  });

  it("builds stable same-origin paths", () => {
    expect(clientPortalPath("dashboard")).toBe("/portal");
    expect(clientPortalPath("requests")).toBe("/portal/requests");
    expect(clientRequestNewPath()).toBe("/portal/requests/new");
    expect(clientProjectPath("project a")).toBe("/portal/projects/project%20a");
  });
});

describe("client portal browser API boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not request account-scoped data before session verification succeeds", async () => {
    let resolveSession!: (value: { account: { id: string; displayName: string }; capabilities: { manageTeam: boolean } }) => void;
    const pendingSession = new Promise<{ account: { id: string; displayName: string }; capabilities: { manageTeam: boolean } }>(resolve => { resolveSession = resolve; });
    const calls: string[] = [];
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      calls.push(url);
      if (url === "/api/client/session") return pendingSession as Promise<T>;
      if (url === "/api/client/projects") return { projects: [] } as T;
      if (url === "/api/client/map-config") return { mapboxPublicToken: null } as T;
      return { requests: [] } as T;
    }) as PortalRequest;

    const bootstrap = loadPortalBootstrap(request);
    await Promise.resolve();
    expect(calls).toEqual(["/api/client/session"]);
    resolveSession({ account: { id: "account-a", displayName: "Acme" }, capabilities: { manageTeam: false } });
    await expect(bootstrap).resolves.toEqual({ account: { id: "account-a", displayName: "Acme" }, capabilities: { manageTeam: false, viewBilling: false, requestV2: false, requestAttachments: false, workspaceHierarchyV2: false, workspaceMembershipManagement: false, hierarchyScopedInvitations: false, invitationEmailDelivery: false, delegatedShares: false, viewer: false, viewerShares: false }, projects: [], requests: [], mapboxPublicToken: null, workspaces: [], selectedWorkspaceId: null, viewerDisplayUnits: "imperial" });
    expect(calls).toEqual(["/api/client/session", "/api/client/projects", "/api/client/service-requests", "/api/client/map-config"]);
  });

  it("defaults team management off when the server omits the pilot capability", async () => {
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      if (url === "/api/client/session") return { account: { id: "a", displayName: "Acme" } } as T;
      if (url === "/api/client/projects") return { projects: [] } as T;
      if (url === "/api/client/map-config") return { mapboxPublicToken: null } as T;
      return { requests: [] } as T;
    }) as PortalRequest;
    await expect(loadPortalBootstrap(request)).resolves.toMatchObject({ capabilities: { manageTeam: false } });
  });

  it("stops at the session boundary when unauthenticated", async () => {
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      if (url === "/api/client/session") throw Object.assign(new Error("Client authentication is required"), { status: 401 });
      throw new Error(`unexpected account data request: ${url}`);
    }) as PortalRequest;
    await expect(loadPortalBootstrap(request)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("loads embedded project and client-level files from separate authorized endpoints", async () => {
    const request = vi.fn(async <T>(url: string): Promise<T> => ({ files: [{ id: url }], prefix: "", cursor: null }) as T) as PortalRequest;
    await expect(loadPortalProjectFiles("project a", "next page", request)).resolves.toMatchObject({ files: [{ id: "/api/client/projects/project%20a/files?cursor=next%20page" }] });
    await expect(loadPortalPastDeliveries(null, request)).resolves.toMatchObject({ files: [{ id: "/api/client/past-deliveries" }] });
  });

  it("addresses project folders with opaque query state and forwards cancellation", async () => {
    const controller = new AbortController();
    const request = vi.fn(async <T>(url: string): Promise<T> => ({ files: [{ id: url }], folders: [], prefix: "", cursor: null }) as T) as PortalRequest;
    await loadPortalProjectFolderFiles("project a", "pf1_opaque", "pc1_next", controller.signal, request);
    expect(request).toHaveBeenCalledWith(
      "/api/client/projects/project%20a/files?folder=pf1_opaque&cursor=pc1_next",
      { signal: controller.signal },
    );
  });

  const input: PortalServiceRequestInput = {
    projectId: null, requestType: "flight", title: "Progress flight", details: "Capture the south elevation.",
    location: "South lot", preferredStartAt: null, poiPoints: [{ longitude: -88.1, latitude: 44.5 }],
  };

  it("creates requests with caller-controlled retry idempotency but no identity fields", async () => {
    const requestMock = vi.fn(async <T>(_url: string, _init?: RequestInit): Promise<T> => ({ request: { id: "request-a", projectId: null, status: "submitted" } }) as T);
    await createPortalServiceRequest(input, "portal-request-retry-key-0001", requestMock as PortalRequest);
    expect(requestMock).toHaveBeenCalledWith("/api/client/service-requests", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "portal-request-retry-key-0001" }) }));
    const submittedBody = JSON.parse((requestMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(submittedBody).not.toHaveProperty("accountId");
    expect(submittedBody).not.toHaveProperty("identityId");
  });

  it("uses PATCH for submitted edits and a parent-scoped endpoint for changes", async () => {
    const request = vi.fn(async <T>(): Promise<T> => ({ request: { id: "request-a", status: "submitted" } }) as T) as PortalRequest;
    await updatePortalServiceRequest("request a", input, "2026-08-01 12:00:00", "edit-key-00000001", request);
    expect(request).toHaveBeenLastCalledWith("/api/client/service-requests/request%20a", expect.objectContaining({ method: "PATCH", headers: expect.objectContaining({ "Idempotency-Key": "edit-key-00000001", "If-Match": "2026-08-01 12:00:00" }) }));
    await createPortalChangeRequest("request a", input, "change-key-0001", request);
    expect(request).toHaveBeenLastCalledWith("/api/client/service-requests/request%20a/change-request", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "change-key-0001" }) }));
    const body = JSON.parse((vi.mocked(request).mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.parentRequestId).toBe("request a");
  });

  it("sends only the selected opaque hierarchy scope when creating an invitation", async () => {
    const request = vi.fn(async <T>(): Promise<T> => undefined as T) as PortalRequest;
    await invitePortalWorkspaceMember("workspace a", {
      email: "contractor@example.test",
      targetScope: { type: "department", publicId: "pa-department-a" },
      capabilities: ["delivery.view"],
    }, request);
    expect(request).toHaveBeenCalledWith(
      "/api/client/v2/workspaces/workspace%20a/invitations",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((vi.mocked(request).mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      email: "contractor@example.test",
      targetScope: { type: "department", publicId: "pa-department-a" },
      capabilities: ["delivery.view"],
    });
    expect(body).not.toHaveProperty("organizationWide");
    expect(body).not.toHaveProperty("projectPublicId");
  });

  it("selects one authorized v2 workspace before loading scoped portal resources", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    vi.stubGlobal("window", { sessionStorage: storage });
    storage.setItem("ltds.client.workspace.v2", "workspace-stale");
    const calls: string[] = [];
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      calls.push(url);
      if (url === "/api/client/session") return { account: { id: "", displayName: "" }, capabilities: { workspaceHierarchyV2: true } } as T;
      if (url === "/api/client/v2/workspaces") return { workspaces: [{ id: "workspace-a", rootType: "organization", rootPublicId: "pa-org-a", displayName: "Alpha" }] } as T;
      if (url === "/api/client/projects") return { projects: [] } as T;
      if (url === "/api/client/service-requests") return { requests: [] } as T;
      return { mapboxPublicToken: null } as T;
    }) as PortalRequest;
    await expect(loadPortalBootstrap(request)).resolves.toMatchObject({ selectedWorkspaceId: "workspace-a", workspaces: [{ id: "workspace-a" }] });
    expect(storage.getItem("ltds.client.workspace.v2")).toBe("workspace-a");
    expect(calls).toEqual(["/api/client/session", "/api/client/v2/workspaces", "/api/client/projects", "/api/client/service-requests", "/api/client/map-config"]);
  });

  it("uses versioned, idempotent draft writes and submission without browser pricing fields", async () => {
    const draftInput = {
      projectId: "project-a", requestType: "service" as const, title: "Map the site", details: "Create an orthomosaic.", location: null,
      preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null, siteContactPhone: null,
      desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
      services: [{ publicId: "svc-map", sourceVersion: "pa-v4", answers: { resolution: "standard" } }],
    };
    const request = vi.fn(async <T>(url: string): Promise<T> => url.endsWith("/submit")
      ? { request: { id: "request-a", status: "submitted" } } as T
      : { draft: { ...draftInput, id: "draft-a", state: "draft", version: 4, areaSquareMeters: null, areaAcres: null, services: [], submittedRequestId: null, createdAt: "", updatedAt: "" } } as T) as PortalRequest;
    await createPortalServiceDraft(draftInput, "create-key", request);
    await savePortalServiceDraft("draft a", 4, draftInput, "save-key", request);
    await submitPortalServiceDraft("draft a", 5, "submit-key", request);
    const controller = new AbortController();
    await loadPortalPricingHint("draft a", request, controller.signal);
    expect(request).toHaveBeenNthCalledWith(1, "/api/client/service-request-drafts", expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": "create-key" }) }));
    expect(request).toHaveBeenNthCalledWith(2, "/api/client/service-request-drafts/draft%20a", expect.objectContaining({ method: "PUT", headers: expect.objectContaining({ "If-Match": "4", "Idempotency-Key": "save-key" }) }));
    expect(request).toHaveBeenNthCalledWith(3, "/api/client/service-request-drafts/draft%20a/submit", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "If-Match": "5", "Idempotency-Key": "submit-key" }) }));
    expect(request).toHaveBeenNthCalledWith(4, "/api/client/service-request-drafts/draft%20a/pricing-hint", { signal: controller.signal });
    const createBody = JSON.parse((vi.mocked(request).mock.calls[0]?.[1] as RequestInit).body as string);
    expect(createBody.services).toEqual([{ publicId: "svc-map", sourceVersion: "pa-v4", answers: { resolution: "standard" } }]);
    expect(createBody).not.toHaveProperty("areaAcres");
    expect(createBody).not.toHaveProperty("price");
  });

  it("keeps attachment source bytes out of the portal API and checkpoints only ETags and sizes", async () => {
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      if (url.endsWith("/part-ticket")) return { url: "https://bucket.r2.cloudflarestorage.com/object", method: "PUT", partNumber: 1, contentLength: 8, contentType: "application/pdf", headers: { "Content-Type": "application/pdf" } } as T;
      if (url.endsWith("/complete")) return { status: "quarantined" } as T;
      if (url.includes("/parts/")) return { partNumber: 1, etag: "a".repeat(32), size: 8 } as T;
      return { attachmentId: "attachment-a", id: "attachment-a", name: "authorization.pdf", contentType: "application/pdf", size: 8, status: "uploading", partSize: 8, completedParts: [] } as T;
    }) as PortalRequest;
    await initializePortalRequestAttachment("draft a", { clientUploadId: "upload-a", name: "authorization.pdf", contentType: "application/pdf", size: 8 }, request);
    await requestPortalAttachmentPartTicket("draft a", "attachment a", 1, request);
    await checkpointPortalAttachmentPart("draft a", "attachment a", { partNumber: 1, etag: "a".repeat(32), size: 8 }, request);
    await completePortalRequestAttachment("draft a", "attachment a", [{ partNumber: 1, etag: "a".repeat(32), size: 8 }], request);
    const bodies = vi.mocked(request).mock.calls.map(call => call[1]?.body).filter(Boolean).map(body => JSON.parse(body as string));
    expect(bodies).toEqual([
      { clientUploadId: "upload-a", name: "authorization.pdf", contentType: "application/pdf", size: 8 },
      { partNumber: 1 },
      { etag: "a".repeat(32), size: 8 },
      { parts: [{ partNumber: 1, etag: "a".repeat(32) }] },
    ]);
  });
});

describe("client Viewer unit preference", () => {
  it.each(["imperial", "metric"] as const)("sends %s in every session request", async displayUnits => {
    const mockRequest = vi.fn(async (_path: string, init?: RequestInit) => ({
      grant: "grant", grantExpiresAt: "2026-08-16T12:01:00Z", sessionTtlSeconds: 900,
      redeemUrl: "https://viewer.example.test/api/v1/sessions/redeem",
      embedUrl: "https://viewer.example.test/session/grant",
    }));
    await createPortalViewerSession("project-one", "association-one", "viewer-session-key-0001", displayUnits, mockRequest as unknown as PortalRequest);
    expect(JSON.parse(String(mockRequest.mock.calls[0]![1]?.body))).toEqual({ displayUnits });
  });
});

describe("request map location", () => {
  it("uses a neutral coordinate label when nearby-place lookup is unavailable", () => {
    expect(neutralMapLocation([-88.071234, 44.501234])).toBe("Near 44.5012, -88.0712");
  });
});
