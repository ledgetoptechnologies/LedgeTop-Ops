import { describe, expect, it, vi } from "vitest";
import {
  createPortalChangeRequest,
  createPortalServiceRequest,
  loadPortalBootstrap,
  loadPortalPastDeliveries,
  loadPortalProjectFiles,
  updatePortalServiceRequest,
  type PortalRequest,
  type PortalServiceRequestInput,
} from "../src/client/portal-api";
import { neutralMapLocation, requestMapKml } from "../src/client/MapAreaSelector";
import { clientPortalPath, clientProjectPath, clientRequestNewPath, parseClientPortalRoute } from "../src/client/portal-route";

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
    await expect(bootstrap).resolves.toEqual({ account: { id: "account-a", displayName: "Acme" }, capabilities: { manageTeam: false, viewBilling: false }, projects: [], requests: [], mapboxPublicToken: null });
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
});

describe("request map export", () => {
  it("uses a neutral coordinate label when nearby-place lookup is unavailable", () => {
    expect(neutralMapLocation([-88.071234, 44.501234])).toBe("Near 44.5012, -88.0712");
  });
  it("exports points and a polygon as portable KML", () => {
    const kml = requestMapKml({ type: "Polygon", coordinates: [[[-88, 44], [-87, 44], [-87, 45], [-88, 44]]] }, [{ longitude: -88.1, latitude: 44.5 }]);
    expect(kml).toContain("<name>Point 1</name>");
    expect(kml).toContain("-88.1,44.5,0");
    expect(kml).toContain("<name>Requested area</name>");
  });
});
