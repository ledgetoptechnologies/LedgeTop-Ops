import { describe, expect, it, vi } from "vitest";
import { createUnifiedRequestRouter, requestServiceCategory } from "../src/worker/client-portal/unified-request-routes";
import type { Env } from "../src/worker/types";
import type { PortalWorkspaceSummary } from "../src/worker/client-portal/workspace-v2";

const origin = "https://client.example";
const env = { CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin } as Env;
const workspace = (id = "one", sourceId = "project-alpha:primary"): PortalWorkspaceSummary => ({ id, sourceId,
  resourceMode: "native", rootType: "standalone_client", rootPublicId: id, displayName: `Client ${id}` });
const service = { publicId: "service-one", sourceVersion: "version-one", name: "Survey", summary: null,
  category: "Catalog category", questions: [], geometryRequirement: "none", displayOrder: 0 };
function fixture(rows = [workspace()]) {
  const discover = vi.fn(async () => rows);
  const scopedFetch = vi.fn(async (request: Request) => request.method === "GET"
    ? Response.json({ services: [service], nextCursor: null })
    : Response.json({ request: { id: "request-one" } }, { status: 201 }));
  const resolvePrincipal = vi.fn(async () => ({ issuer: "issuer", subject: "subject", email: "client@example.com" }));
  const router = createUnifiedRequestRouter({ resolvePrincipal, checkConfiguration: false, discover, scopedFetch,
    resolveAuthority: async () => null });
  const get = () => router.request(`${origin}/request-services`, {}, env);
  const post = (body: unknown, headers: Record<string, string> = {}) => router.request(`${origin}/requests`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "request-idempotency-one", ...headers },
    body: JSON.stringify(body),
  }, env);
  const choice = async () => (await (await get()).json() as any).services[0].serviceChoiceId as string;
  return { discover, scopedFetch, resolvePrincipal, get, post, choice };
}
describe("workspace-free service requests", () => {
  it("discovers all authorized native memberships, keeping ambiguous clients distinct", async () => {
    const f = fixture([workspace(), workspace("two"), workspace("web", "project-alpha:secondary")]);
    const response = await f.get(), value = await response.json() as any;
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(value.services).toHaveLength(3);
    expect(new Set(value.services.map((s: any) => s.serviceChoiceId)).size).toBe(3);
    expect(value.services.map((s: any) => s.clientName)).toEqual(["Client one", "Client two", "Client web"]);
    expect(value.services.map((s: any) => s.category)).toEqual(["drone", "drone", "website"]);
  });
  it("routes direct submission using exact server-resolved workspace and catalog version", async () => {
    const f = fixture([workspace("web", "project-alpha:secondary")]), serviceChoiceId = await f.choice();
    const response = await f.post({ serviceChoiceId, title: "Help", details: "Update the site", answers: { detail: "value" } },
      { "X-LTDS-Workspace-Id": "attacker", "X-Source-Id": "attacker", Cookie: "session=cookie" });
    expect(response.status).toBe(201);
    const request = f.scopedFetch.mock.calls.at(-1)![0];
    expect(new URL(request.url).pathname).toBe("/service-requests");
    expect(request.headers.get("X-LTDS-Workspace-Id")).toBe("web");
    expect(request.headers.get("X-Source-Id")).toBeNull();
    expect(request.headers.get("Cookie")).toBe("session=cookie");
    expect(request.headers.get("Origin")).toBe(origin);
    expect(request.headers.get("Idempotency-Key")).toBe("request-idempotency-one");
    expect(await request.json()).toEqual({ title: "Help", details: "Update the site", requestType: "service",
      services: [{ publicId: service.publicId, sourceVersion: service.sourceVersion, answers: { detail: "value" } }] });
  });
  it("propagates existing scoped idempotency conflicts and replay statuses", async () => {
    const f = fixture(), serviceChoiceId = await f.choice();
    f.scopedFetch.mockImplementation(async request => request.method === "GET"
      ? Response.json({ services: [service], nextCursor: null }) : Response.json({ code: "conflict" }, { status: 409 }));
    expect((await f.post({ serviceChoiceId, title: "Help", details: "Details" })).status).toBe(409);
    f.scopedFetch.mockImplementation(async request => request.method === "GET"
      ? Response.json({ services: [service], nextCursor: null }) : Response.json({ request: { id: "existing" } }));
    expect((await f.post({ serviceChoiceId, title: "Help", details: "Details" })).status).toBe(200);
  });
  it("rejects stale versions without writing", async () => {
    const f = fixture(), serviceChoiceId = await f.choice();
    f.scopedFetch.mockResolvedValue(Response.json({ services: [{ ...service, sourceVersion: "changed" }], nextCursor: null }));
    const response = await f.post({ serviceChoiceId, title: "Help", details: "Details" });
    expect(response.status).toBe(409);
    expect(f.scopedFetch.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  });
  it("rejects revoked and cross-source coordinates", async () => {
    const f = fixture(), serviceChoiceId = await f.choice();
    f.discover.mockResolvedValue([workspace("one", "project-alpha:secondary")]);
    expect((await f.post({ serviceChoiceId, title: "Help", details: "Details" })).status).toBe(404);
    f.discover.mockResolvedValue([]);
    expect((await f.post({ serviceChoiceId, title: "Help", details: "Details" })).status).toBe(404);
  });
  it("removes a membership revoked during catalog discovery", async () => {
    const f = fixture(); f.discover.mockResolvedValueOnce([workspace()]).mockResolvedValueOnce([]);
    expect(await (await f.get()).json()).toEqual({ services: [], inquiryKinds: [], unavailable: [] });
  });
  it("reports unavailable sources explicitly and keeps other authorized services", async () => {
    const f = fixture([workspace(), workspace("two")]);
    f.scopedFetch.mockImplementation(async request => request.headers.get("X-LTDS-Workspace-Id") === "two"
      ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({ services: [service], nextCursor: null }));
    const value = await (await f.get()).json() as any;
    expect(value.services).toHaveLength(1);
    expect(value.unavailable).toEqual([{ clientName: "Client two", code: "service_catalog_unavailable" }]);
  });
  it("rejects malformed choices, untrusted routing fields, and cross-origin mutations", async () => {
    const f = fixture();
    expect((await f.post({ serviceChoiceId: "bad", title: "Help", details: "Details" })).status).toBe(400);
    expect((await f.post({ serviceChoiceId: "bad", title: "Help", details: "Details", sourceId: "other" })).status).toBe(400);
    expect((await f.post({}, { Origin: "https://other.example" })).status).toBe(403);
    expect(f.scopedFetch).not.toHaveBeenCalled();
  });
  it("never infers an unknown source's business from its service name", async () => {
    const f = fixture([workspace("unknown", "project-alpha:unknown")]);
    const value = await (await f.get()).json() as any;
    expect(value.services[0].category).toBe("other");
    expect(requestServiceCategory("project-alpha:staging")).toBe("drone");
    expect(requestServiceCategory("project-alpha:source-2-staging")).toBe("website");
  });
  it("bounds membership and catalog-page fanout without claiming completeness", async () => {
    const capacity = fixture(Array.from({ length: 33 }, (_, n) => workspace(`client-${n}`)));
    expect((await capacity.get()).status).toBe(503);
    expect(capacity.scopedFetch).not.toHaveBeenCalled();
    const pages = fixture();
    pages.scopedFetch.mockImplementation(async () => Response.json({ services: [service], nextCursor: "another-page" }));
    expect(await (await pages.get()).json()).toEqual({ services: [], inquiryKinds: [], unavailable: [
      { clientName: "Client one", code: "service_catalog_unavailable" },
    ] });
    expect(pages.scopedFetch).toHaveBeenCalledTimes(10);
  });
  it("rejects oversized bodies before any scoped dispatch", async () => {
    const f = fixture();
    expect((await f.post({ serviceChoiceId: "bad", title: "Help", details: "x".repeat(17 * 1024) })).status).toBe(413);
    expect(f.scopedFetch).not.toHaveBeenCalled();
  });
  it("shares a wire-byte budget across concurrent collectors and cancels active readers on exhaustion", async () => {
    const f = fixture(Array.from({ length: 12 }, (_, n) => workspace(`client-${n}`)));
    const cancelled = vi.fn();
    const signals: AbortSignal[] = [];
    f.scopedFetch.mockImplementation(async request => {
      signals.push(request.signal);
      // None of these pages exceeds the per-page limit. Their combined wire
      // size exceeds the shared limit while another source's reader is active.
      const bytes = new TextEncoder().encode(JSON.stringify({ services: [{ ...service, summary: "x".repeat(300_000) }], nextCursor: "more" }));
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) { if (!sent) { sent = true; controller.enqueue(bytes); } },
        cancel: cancelled,
      }));
    });
    const response = await f.get();
    expect(response.status).toBe(503);
    expect(cancelled).toHaveBeenCalled();
    expect(f.scopedFetch.mock.calls.length).toBeLessThanOrEqual(4);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
  it("charges transformed choice/metadata bytes before retaining otherwise small catalog pages", async () => {
    const f = fixture([{ ...workspace("client-with-a-long-name".repeat(5)), displayName: "C".repeat(500) }]);
    let page = 0;
    f.scopedFetch.mockImplementation(async () => Response.json({ services: Array.from({ length: 100 }, (_, n) => ({
      ...service, publicId: `service-${page}-${n}-${"s".repeat(100)}`, sourceVersion: "v".repeat(128), questions: [],
    })), nextCursor: ++page < 10 ? `page-${page}` : null }));
    // Raw compact rows fit below 1 MiB, but the exact response DTOs have long
    // client names and encoded coordinates. Capacity is a fatal 503.
    expect((await f.get()).status).toBe(503);
    expect(page).toBeLessThanOrEqual(10);
  });
  it("caps service items across sources even when their compact wire bytes fit", async () => {
    const f = fixture(Array.from({ length: 12 }, (_, n) => workspace(`client-${n}`)));
    f.scopedFetch.mockImplementation(async () => Response.json({ services: Array.from({ length: 100 }, (_, n) => ({
      ...service, publicId: `s-${n}`,
    })), nextCursor: null }));
    expect((await f.get()).status).toBe(503);
  });
});
