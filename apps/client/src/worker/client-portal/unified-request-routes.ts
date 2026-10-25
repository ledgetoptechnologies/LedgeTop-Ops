import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "../types";
import { configuredClientPortalOrigins, clientPortalRequestOriginAllowed } from "../origin-policy";
import { readBoundedClientJson } from "../bounded-json";
import { clientAccessConfiguration } from "./access-identity";
import { listPortalWorkspaces, PORTAL_WORKSPACE_HEADER, type PortalWorkspaceSummary } from "./workspace-v2";
import type { ClientServiceCatalogItem, ResolveClientPrincipal, VerifiedClientPrincipal } from "./types";

const coordinate = z.string().min(1).max(200);
const choiceSchema = z.object({ v: z.literal(1), workspaceId: coordinate, sourceId: coordinate,
  publicId: coordinate, sourceVersion: coordinate }).strict();
const inputSchema = z.object({ serviceChoiceId: z.string().min(1).max(2048), title: z.string().trim().min(1).max(160),
  details: z.string().trim().min(1).max(5000), projectId: z.string().min(1).max(128).nullable().optional(),
  answers: z.record(z.string().max(64), z.unknown()).optional(), location: z.string().nullable().optional(),
  preferredStartAt: z.string().nullable().optional(), desiredCompletionAt: z.string().nullable().optional(),
  deliverables: z.string().nullable().optional(), siteContactName: z.string().nullable().optional(),
  siteContactEmail: z.string().nullable().optional(), siteContactPhone: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(), longitude: z.number().nullable().optional(),
  areaGeoJson: z.unknown().nullable().optional(), poiPoints: z.array(z.unknown()).max(20).optional(),
}).strict();
type Choice = z.infer<typeof choiceSchema>;
type Ctx = Context<{ Bindings: Env }>;
type ScopedFetch = (request: Request, env: Env) => Promise<Response>;
type Dependencies = { resolvePrincipal: ResolveClientPrincipal; checkConfiguration: boolean; scopedFetch: ScopedFetch;
  discover?: typeof listPortalWorkspaces };
const MAX_WORKSPACES = 32, MAX_PAGES = 10, MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SERVICES = 1000;
const encoder = new TextEncoder();
class DiscoveryCapacityError extends HTTPException {
  constructor() { super(503, { message: "Service discovery exceeds the response limit" }); }
}
/** One budget is shared across every concurrent source. Charge wire chunks
 * before retaining them and output DTOs before appending any catalog items. */
class DiscoveryBudget {
  wireBytes = 0;
  outputBytes = encoder.encode(JSON.stringify({ services: [], unavailable: [] })).byteLength;
  items = 0;
  failed = false;
  controller = new AbortController();
  readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  check() { if (this.failed) throw new DiscoveryCapacityError(); }
  exhaust(): never {
    this.failed = true;
    this.controller.abort();
    for (const reader of this.readers) void reader.cancel().catch(() => {});
    throw new DiscoveryCapacityError();
  }
  wire(length: number) {
    this.check();
    if (this.wireBytes + length > MAX_RESPONSE_BYTES) this.exhaust();
    this.wireBytes += length;
  }
  row(value: unknown, service = false) {
    this.check();
    const length = encoder.encode(JSON.stringify(value)).byteLength + 1;
    if (this.outputBytes + length > MAX_RESPONSE_BYTES || service && this.items >= MAX_SERVICES) this.exhaust();
    this.outputBytes += length;
    if (service) this.items++;
  }
}

/** Display metadata only. The exact source and workspace below always decide routing. */
export function requestServiceCategory(source: string): "drone" | "website" | "other" {
  if (source === "project-alpha:primary" || source === "project-alpha:staging") return "drone";
  if (source === "project-alpha:secondary" || source === "project-alpha:source-2-staging") return "website";
  return "other";
}
function encodeChoice(value: Choice): string {
  let raw = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) raw += String.fromCharCode(byte);
  return `svc1_${btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}
function decodeChoice(value: string): Choice | null {
  try {
    if (!value.startsWith("svc1_")) return null;
    const raw = atob(value.slice(5).replace(/-/g, "+").replace(/_/g, "/"));
    return choiceSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, c => c.charCodeAt(0)))));
  } catch { return null; }
}
function scopedRequest(c: Ctx, workspaceId: string, path: string, body?: unknown, signal?: AbortSignal): Request {
  // Only these two hardcoded, same-app destinations are permitted. Browser
  // scope headers never select the delegated call's workspace or source.
  if (path !== "/service-requests" && !path.startsWith("/service-catalog/page?")) throw Error("invalid-scoped-route");
  const headers = new Headers();
  for (const name of ["Cookie", "Authorization", "Cf-Access-Jwt-Assertion", "Origin", "Idempotency-Key"])
    if (c.req.header(name)) headers.set(name, c.req.header(name)!);
  headers.set(PORTAL_WORKSPACE_HEADER, workspaceId);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(new URL(path, c.req.url), { method: body === undefined ? "GET" : "POST", headers, signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function boundedResponse(response: Response, budget: DiscoveryBudget): Promise<unknown> {
  if (budget.failed) { await response.body?.cancel(); budget.check(); }
  const reader = response.body?.getReader();
  if (!reader) throw new HTTPException(503);
  budget.readers.add(reader);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      budget.check();
      const { done, value } = await reader.read();
      budget.check();
      if (done) break;
      budget.wire(value.byteLength);
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new HTTPException(503); }
      chunks.push(value);
    }
  } finally { budget.readers.delete(reader); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function serviceDto(workspace: PortalWorkspaceSummary, service: ClientServiceCatalogItem) {
  return {
    serviceChoiceId: encodeChoice({ v: 1, workspaceId: workspace.id, sourceId: workspace.sourceId!, publicId: service.publicId,
      sourceVersion: service.sourceVersion }), name: service.name, summary: service.summary,
    category: requestServiceCategory(workspace.sourceId!), catalogCategory: service.category, clientName: workspace.displayName,
    questions: service.questions, geometryRequirement: service.geometryRequirement,
  };
}

/** These routes are mounted before ambient workspace admission. Every catalog
 * and mutation dispatch still passes through the normal scoped router. A
 * serviceChoiceId is an untrusted locator, never a capability or membership. */
export function createUnifiedRequestRouter(dependencies: Dependencies) {
  const router = new Hono<{ Bindings: Env }>();
  const discover = dependencies.discover ?? listPortalWorkspaces;
  async function actor(c: Ctx): Promise<VerifiedClientPrincipal> {
    c.header("Cache-Control", "private, no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    if (c.env.CLIENT_PORTAL_ENABLED !== "true" || c.env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED !== "true")
      throw new HTTPException(404);
    const origins = configuredClientPortalOrigins(c.env);
    if (!origins) throw new HTTPException(503);
    if (!origins.includes(new URL(c.req.url).origin)) throw new HTTPException(404);
    if (dependencies.checkConfiguration) clientAccessConfiguration(c.env);
    const principal = await dependencies.resolvePrincipal(c.req.raw, c.env);
    if (!principal) throw new HTTPException(401);
    return principal;
  }
  async function memberships(c: Ctx, principal: VerifiedClientPrincipal) {
    const workspaces = (await discover(c.env, principal, { strictCapacity: true })).filter(w => w.resourceMode === "native" && w.sourceId);
    if (workspaces.length > MAX_WORKSPACES) throw new HTTPException(503, { message: "Service discovery is temporarily unavailable" });
    return workspaces;
  }
  async function catalog(c: Ctx, workspace: PortalWorkspaceSummary, projectId?: string | null, budget = new DiscoveryBudget()) {
    const services: ClientServiceCatalogItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      budget.check();
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      if (projectId) query.set("projectId", projectId);
      const response = await dependencies.scopedFetch(scopedRequest(c, workspace.id, `/service-catalog/page?${query}`, undefined,
        budget.controller.signal), c.env);
      if (!response.ok) {
        await response.body?.cancel(); budget.check();
        throw new HTTPException(response.status as 400, { message: "Service catalog is unavailable" });
      }
      const value = await boundedResponse(response, budget) as { services: ClientServiceCatalogItem[]; nextCursor: string | null };
      if (!Array.isArray(value.services) || value.services.length > 100 || !(value.nextCursor === null || typeof value.nextCursor === "string"))
        throw new HTTPException(503);
      for (const service of value.services) budget.row(serviceDto(workspace, service), true);
      services.push(...value.services);
      cursor = value.nextCursor;
      if (!cursor) return services;
    }
    throw new HTTPException(503, { message: "Service catalog exceeds the discovery limit" });
  }
  router.get("/request-services", async c => {
    const principal = await actor(c), before = await memberships(c, principal);
    const results: { workspace: PortalWorkspaceSummary; services: ClientServiceCatalogItem[] | null }[] = [];
    const budget = new DiscoveryBudget();
    const queue = [...before];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let workspace = queue.shift(); workspace; workspace = queue.shift()) {
        budget.check();
        try { results.push({ workspace, services: await catalog(c, workspace, undefined, budget) }); }
        catch (error) {
          if (error instanceof DiscoveryCapacityError || budget.failed) throw new DiscoveryCapacityError();
          budget.row({ clientName: workspace.displayName, code: "service_catalog_unavailable" });
          results.push({ workspace, services: null });
        }
      }
    }));
    // Do not return an earlier account's catalog after its membership was
    // revoked while another catalog was loading.
    const after = await memberships(c, principal);
    const current = results.filter(result => after.some(w => w.id === result.workspace.id && w.sourceId === result.workspace.sourceId));
    current.sort((a, b) => a.workspace.id.localeCompare(b.workspace.id));
    const payload = { services: current.flatMap(({ workspace, services }) => (services ?? []).map(service => serviceDto(workspace, service))),
      unavailable: current.filter(row => row.services === null).map(({ workspace }) => ({ clientName: workspace.displayName,
      code: "service_catalog_unavailable" as const })) };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_RESPONSE_BYTES)
      throw new HTTPException(503, { message: "Service discovery exceeds the response limit" });
    return c.json(payload);
  });
  router.post("/requests", async c => {
    const principal = await actor(c);
    if (!clientPortalRequestOriginAllowed(c.req.raw, c.env)) throw new HTTPException(403);
    const parsed = inputSchema.safeParse(await readBoundedClientJson(c.req.raw, 16 * 1024));
    if (!parsed.success) throw new HTTPException(400, { message: "The service request is invalid" });
    const choice = decodeChoice(parsed.data.serviceChoiceId);
    if (!choice) throw new HTTPException(400, { message: "The selected service is invalid" });
    const workspace = (await memberships(c, principal)).find(w => w.id === choice.workspaceId && w.sourceId === choice.sourceId);
    if (!workspace) throw new HTTPException(404, { message: "The selected service is unavailable" });
    const services = await catalog(c, workspace, parsed.data.projectId);
    const service = services.find(s => s.publicId === choice.publicId && s.sourceVersion === choice.sourceVersion);
    if (!service) return c.json({ error: "The selected service changed. Refresh the available services.", code: "catalog_changed" }, 409);
    const { serviceChoiceId: _choice, answers, ...input } = parsed.data;
    const response = await dependencies.scopedFetch(scopedRequest(c, workspace.id, "/service-requests", {
      ...input, requestType: requestServiceCategory(workspace.sourceId!) === "drone" ? "flight" : "service",
      services: [{ publicId: service.publicId, sourceVersion: service.sourceVersion, answers: answers ?? {} }],
    }), c.env);
    return response;
  });
  return router;
}
