import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "../types";
import { d1ClientPortalRepository } from "./repository";
import type { ClientPortalRepository, ClientPortalSession, ResolveClientPrincipal } from "./types";
import { ClientAccessConfigurationError, clientAccessConfiguration, resolveCloudflareClientPrincipal } from "./access-identity";

interface ClientPortalDependencies {
  resolvePrincipal?: ResolveClientPrincipal;
  repository?: ClientPortalRepository;
}

type ClientPortalVariables = { clientSession: ClientPortalSession };

const MAX_SERVICE_REQUEST_BYTES = 16 * 1024;
const SERVICE_REQUEST_RATE_LIMIT_SECONDS = 60;
const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const serviceRequestBody = z.object({
  projectId: opaqueId,
  requestType: z.enum(["flight", "service"]),
  title: z.string().trim().min(1).max(160),
  details: z.string().trim().min(1).max(5000),
  location: z.string().trim().min(1).max(240).nullable().optional(),
  preferredStartAt: z.iso.datetime({ offset: true }).nullable().optional(),
  serviceCategory: z.string().trim().min(1).max(100).nullable().optional(),
  deliverables: z.string().trim().min(1).max(2000).nullable().optional(),
  siteContactName: z.string().trim().min(1).max(160).nullable().optional(),
  siteContactEmail: z.string().trim().email().max(320).nullable().optional(),
  siteContactPhone: z.string().trim().min(3).max(64).nullable().optional(),
  desiredCompletionAt: z.iso.datetime({ offset: true }).nullable().optional(),
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
}).strict().superRefine((value, context) => {
  if ((value.latitude === null || value.latitude === undefined) !== (value.longitude === null || value.longitude === undefined)) {
    context.addIssue({ code: "custom", message: "Latitude and longitude must be provided together" });
  }
});
const invitationBody = z.object({
  email: z.string().trim().email().max(320),
  projectIds: z.array(opaqueId).max(100).default([]),
}).strict();

const cloudflareClientIdentityProvider: ResolveClientPrincipal = resolveCloudflareClientPrincipal;

function configuredPortalOrigin(env: Env): string {
  if (!env.CLIENT_PORTAL_ORIGIN) throw new HTTPException(503, { message: "Client portal is not configured" });
  try {
    const url = new URL(env.CLIENT_PORTAL_ORIGIN);
    if (url.origin !== env.CLIENT_PORTAL_ORIGIN || (env.ENVIRONMENT === "production" && url.protocol !== "https:")) {
      throw new Error("invalid portal origin");
    }
    return url.origin;
  } catch {
    throw new HTTPException(503, { message: "Client portal is not configured" });
  }
}

function requireSameRequestOrigin(request: Request, expectedOrigin: string): void {
  if (request.headers.get("Origin") !== expectedOrigin || new URL(request.url).origin !== expectedOrigin) {
    throw new HTTPException(403, { message: "This request is not allowed" });
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new HTTPException(400, { message: "Content-Length is invalid" });
    if (length > MAX_SERVICE_REQUEST_BYTES) throw new HTTPException(413, { message: "The service request is too large" });
  }
  if (!request.body) throw new HTTPException(400, { message: "A valid JSON request body is required" });

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SERVICE_REQUEST_BYTES) {
      await reader.cancel();
      throw new HTTPException(413, { message: "The service request is too large" });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HTTPException(400, { message: "A valid JSON request body is required" });
  }
}

export function createClientPortalRouter(dependencies: ClientPortalDependencies = {}) {
  const resolvePrincipal = dependencies.resolvePrincipal ?? cloudflareClientIdentityProvider;
  const repository = dependencies.repository ?? d1ClientPortalRepository;
  const router = new Hono<{ Bindings: Env; Variables: ClientPortalVariables }>();

  router.use("*", async (c, next) => {
    if (c.env.CLIENT_PORTAL_ENABLED !== "true") return c.json({ error: "Not found" }, 404);
    const portalOrigin = configuredPortalOrigin(c.env);
    if (new URL(c.req.url).origin !== portalOrigin) return c.json({ error: "Not found" }, 404);
    // The production adapter is configuration-gated before it looks at any
    // client header. Tests can inject an adapter without needing Cloudflare.
    try {
      if (!dependencies.resolvePrincipal) clientAccessConfiguration(c.env);
    } catch (error) {
      if (error instanceof ClientAccessConfigurationError) throw new HTTPException(503, { message: "Client portal authentication is not configured" });
      throw error;
    }
    const principal = await resolvePrincipal(c.req.raw, c.env);
    if (!principal) throw new HTTPException(401, { message: "Client authentication is required" });
    const session = await repository.resolveSession(c.env, principal);
    if (!session) throw new HTTPException(403, { message: "Client access is not provisioned" });
    c.set("clientSession", session);
    await next();
  });

  router.get("/session", c => {
    const session = c.get("clientSession");
    return c.json({ account: { id: session.accountId, displayName: session.displayName }, capabilities: {
      manageTeam: session.role === "manager",
      viewBilling: session.canViewBilling,
    } });
  });

  router.get("/projects", async c => c.json({ projects: await repository.listProjects(c.env, c.get("clientSession")) }));

  router.get("/projects/:projectId/deliveries", async c => {
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    if (!projectId.success) throw new HTTPException(404, { message: "Project not found" });
    return c.json({ deliveries: await repository.listDeliveries(c.env, c.get("clientSession"), projectId.data) });
  });

  // This is deliberately only a local-grant recheck and a same-origin redirect
  // into the existing public-share workflow. It never converts an Access
  // session into a public-share session or bypasses a share password.
  router.get("/projects/:projectId/deliveries/:shareId/handoff", async c => {
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    const shareId = opaqueId.safeParse(c.req.param("shareId"));
    if (!projectId.success || !shareId.success) throw new HTTPException(404, { message: "Delivery not found" });
    const handoff = await repository.getDeliveryHandoff(c.env, c.get("clientSession"), projectId.data, shareId.data);
    if (!handoff) throw new HTTPException(404, { message: "Delivery not found" });
    return c.redirect(`/s/${encodeURIComponent(handoff.publicId)}`, 302);
  });

  router.get("/service-requests", async c => c.json({ requests: await repository.listServiceRequests(c.env, c.get("clientSession")) }));

  router.get("/service-requests/:requestId", async c => {
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    if (!requestId.success) throw new HTTPException(404, { message: "Service request not found" });
    const request = await repository.getServiceRequest(c.env, c.get("clientSession"), requestId.data);
    if (!request) throw new HTTPException(404, { message: "Service request not found" });
    return c.json({ request });
  });

  router.get("/team", async c => {
    const session = c.get("clientSession");
    const [members, invitations] = await Promise.all([
      repository.listMembers(c.env, session),
      repository.listInvitations(c.env, session),
    ]);
    if (!members || !invitations) throw new HTTPException(403, { message: "Team management is not permitted" });
    return c.json({ members, invitations });
  });

  router.post("/team/invitations", async c => {
    const portalOrigin = configuredPortalOrigin(c.env);
    requireSameRequestOrigin(c.req.raw, portalOrigin);
    const limiter = c.env.PUBLIC_BULK_RATE_LIMITER;
    if (!limiter || typeof limiter.limit !== "function") throw new HTTPException(503, { message: "Client invitation submission is not configured" });
    const rateLimit = await limiter.limit({ key: `client-team:invite:${c.get("clientSession").accountId}` });
    if (!rateLimit.success) {
      c.header("Retry-After", String(SERVICE_REQUEST_RATE_LIMIT_SECONDS));
      throw new HTTPException(429, { message: "Too many invitation requests. Please try again shortly." });
    }
    const parsed = invitationBody.safeParse(await readBoundedJson(c.req.raw));
    if (!parsed.success) throw new HTTPException(400, { message: "The invitation is invalid" });
    const invitation = await repository.createInvitation(c.env, c.get("clientSession"), parsed.data);
    if (!invitation) throw new HTTPException(403, { message: "The invitation could not be created for this account" });
    return c.json({ invitation }, 201);
  });

  router.delete("/team/members/:identityId", async c => {
    const portalOrigin = configuredPortalOrigin(c.env);
    requireSameRequestOrigin(c.req.raw, portalOrigin);
    const identityId = opaqueId.safeParse(c.req.param("identityId"));
    if (!identityId.success) throw new HTTPException(404, { message: "Team member not found" });
    const revoked = await repository.revokeMember(c.env, c.get("clientSession"), identityId.data);
    if (!revoked) throw new HTTPException(404, { message: "Team member not found" });
    return c.body(null, 204);
  });

  router.delete("/team/invitations/:invitationId", async c => {
    const portalOrigin = configuredPortalOrigin(c.env);
    requireSameRequestOrigin(c.req.raw, portalOrigin);
    const invitationId = opaqueId.safeParse(c.req.param("invitationId"));
    if (!invitationId.success) throw new HTTPException(404, { message: "Invitation not found" });
    const revoked = await repository.revokeInvitation(c.env, c.get("clientSession"), invitationId.data);
    if (!revoked) throw new HTTPException(404, { message: "Invitation not found" });
    return c.body(null, 204);
  });

  router.post("/service-requests", async c => {
    const portalOrigin = configuredPortalOrigin(c.env);
    requireSameRequestOrigin(c.req.raw, portalOrigin);
    const limiter = c.env.PUBLIC_BULK_RATE_LIMITER;
    if (!limiter || typeof limiter.limit !== "function") {
      throw new HTTPException(503, { message: "Client request submission is not configured" });
    }
    const rateLimit = await limiter.limit({
      key: `client-service-request:create:${c.get("clientSession").accountId}`,
    });
    if (!rateLimit.success) {
      c.header("Retry-After", String(SERVICE_REQUEST_RATE_LIMIT_SECONDS));
      throw new HTTPException(429, { message: "Too many service requests. Please try again shortly." });
    }
    const parsedIdempotencyKey = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!parsedIdempotencyKey.success) throw new HTTPException(400, { message: "A valid Idempotency-Key header is required" });
    const parsed = serviceRequestBody.safeParse(await readBoundedJson(c.req.raw));
    if (!parsed.success) throw new HTTPException(400, { message: "The service request is invalid" });
    const result = await repository.createServiceRequest(c.env, c.get("clientSession"), {
      ...parsed.data,
      idempotencyKey: parsedIdempotencyKey.data,
      location: parsed.data.location ?? null,
      preferredStartAt: parsed.data.preferredStartAt ?? null,
      serviceCategory: parsed.data.serviceCategory ?? null,
      deliverables: parsed.data.deliverables ?? null,
      siteContactName: parsed.data.siteContactName ?? null,
      siteContactEmail: parsed.data.siteContactEmail ?? null,
      siteContactPhone: parsed.data.siteContactPhone ?? null,
      desiredCompletionAt: parsed.data.desiredCompletionAt ?? null,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
    });
    if (!result) throw new HTTPException(404, { message: "Project not found or service requests are not permitted" });
    if (result.kind === "conflict") throw new HTTPException(409, { message: "This Idempotency-Key was already used for a different request" });
    return c.json({ request: result.request }, result.kind === "created" ? 201 : 200);
  });

  return router;
}
