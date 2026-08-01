import { describe, expect, it, vi } from "vitest";
import {
  createPortalServiceRequest,
  loadPortalBootstrap,
  loadPortalDeliveries,
  type PortalRequest,
} from "../src/client/portal-api";
import { clientPortalPath, parseClientPortalRoute } from "../src/client/portal-route";

describe("client portal browser routing", () => {
  it.each([
    ["/portal", "dashboard"],
    ["/portal/", "dashboard"],
    ["/portal/dashboard", "dashboard"],
    ["/portal/projects", "projects"],
    ["/portal/deliveries", "deliveries"],
    ["/portal/requests", "requests"],
    ["/portal/account", "account"],
  ])("maps %s to the %s page", (pathname, page) => {
    expect(parseClientPortalRoute(pathname)).toEqual({ isPortal: true, page });
  });

  it("keeps existing public-share paths outside the portal composition", () => {
    expect(parseClientPortalRoute("/s/public-share-id")).toEqual({ isPortal: false, page: "dashboard" });
    expect(parseClientPortalRoute("/")).toEqual({ isPortal: false, page: "dashboard" });
  });

  it("treats unknown or nested portal paths as authenticated not-found pages", () => {
    expect(parseClientPortalRoute("/portal/settings")).toEqual({ isPortal: true, page: "not-found" });
    expect(parseClientPortalRoute("/portal/projects/project-a")).toEqual({ isPortal: true, page: "not-found" });
  });

  it("builds stable same-origin portal paths", () => {
    expect(clientPortalPath("dashboard")).toBe("/portal");
    expect(clientPortalPath("requests")).toBe("/portal/requests");
  });
});

describe("client portal browser API boundary", () => {
  it("does not request any account-scoped data before session verification succeeds", async () => {
    let resolveSession!: (value: { account: { id: string; displayName: string } }) => void;
    const pendingSession = new Promise<{ account: { id: string; displayName: string } }>(resolve => { resolveSession = resolve; });
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
    resolveSession({ account: { id: "account-a", displayName: "Acme" } });
    await expect(bootstrap).resolves.toEqual({
      account: { id: "account-a", displayName: "Acme" },
      projects: [],
      requests: [],
      mapboxPublicToken: null,
    });
    expect(calls).toEqual(["/api/client/session", "/api/client/projects", "/api/client/service-requests", "/api/client/map-config"]);
  });

  it("stops at the session boundary when the browser is unauthenticated", async () => {
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      if (url === "/api/client/session") throw Object.assign(new Error("Client authentication is required"), { status: 401 });
      throw new Error(`unexpected account data request: ${url}`);
    }) as PortalRequest;
    await expect(loadPortalBootstrap(request)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/client/session");
  });

  it("loads deliveries only through the server-side project grant endpoint", async () => {
    const request = vi.fn(async <T>(url: string): Promise<T> => {
      expect(url).toBe("/api/client/projects/project-a/deliveries");
      return { deliveries: [{ shareId: "share-a", publicId: "public-a" }] } as T;
    }) as PortalRequest;
    await expect(loadPortalDeliveries("project-a", request)).resolves.toMatchObject([{ shareId: "share-a" }]);
  });

  it("submits only request fields and preserves the caller's retry idempotency key", async () => {
    const requestMock = vi.fn(async <T>(_url: string, _init?: RequestInit): Promise<T> => ({
      request: { id: "request-a", projectId: "project-a", status: "submitted" },
    }) as T);
    const request = requestMock as PortalRequest;
    const input = {
      projectId: "project-a",
      requestType: "flight" as const,
      title: "Progress flight",
      details: "Capture the south elevation.",
      location: "South lot",
      preferredStartAt: null,
    };

    await expect(createPortalServiceRequest(input, "portal-request-retry-key-0001", request)).resolves.toMatchObject({ id: "request-a" });
    expect(request).toHaveBeenCalledWith("/api/client/service-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "portal-request-retry-key-0001",
      },
      body: JSON.stringify(input),
    });
    const submittedBody = JSON.parse((requestMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(submittedBody).not.toHaveProperty("accountId");
    expect(submittedBody).not.toHaveProperty("identityId");
  });
});
