import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 12_000;

function enabled(env: Env): boolean {
  return env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED === "true" && Boolean(env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE);
}

function requireSameOrigin(request: Request): void {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) throw new HTTPException(403, { message: "This request is not allowed" });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) throw new HTTPException(413, { message: "Request is too large" });
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HTTPException(400, { message: "Invalid request" });
  return value as Record<string, unknown>;
}

export const clientOnboardingRecipientRouter = new Hono<{ Bindings: Env }>();
clientOnboardingRecipientRouter.use("*", async (c, next) => {
  if (!enabled(c.env)) return c.json({ error: "Not found" }, 404);
  requireSameOrigin(c.req.raw);
  const address = c.req.header("CF-Connecting-IP") || "unknown";
  const limited = await c.env.PUBLIC_SESSION_RATE_LIMITER.limit({ key: `client-onboarding:${address}` });
  if (!limited.success) return c.json({ error: "Too many requests" }, 429, { "Retry-After": "60" });
  await next();
});

clientOnboardingRecipientRouter.post("/:invitationId/session", async c => {
  const input = await body(c.req.raw);
  if (typeof input.invitationSecret !== "string" || !SECRET.test(input.invitationSecret)) return c.json({ error: "Unavailable" }, 404);
  const result = await c.env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE!.session({
    protocolVersion: 1, invitationId: c.req.param("invitationId"), invitationSecret: input.invitationSecret,
  });
  return result.ok ? c.json(result) : c.json({ error: "Unavailable" }, 404);
});

clientOnboardingRecipientRouter.post("/:invitationId/submit", async c => {
  const input = await body(c.req.raw);
  if (typeof input.invitationSecret !== "string" || !SECRET.test(input.invitationSecret)
    || typeof input.submissionId !== "string" || !UUID.test(input.submissionId)) return c.json({ error: "Unavailable" }, 404);
  const result = await c.env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE!.submit({ protocolVersion: 1,
    invitationId: c.req.param("invitationId"), invitationSecret: input.invitationSecret,
    submissionId: input.submissionId, fields: input.fields as Record<string, unknown>,
  });
  return result.ok ? c.json(result) : c.json({ error: "Unavailable" }, 404);
});

clientOnboardingRecipientRouter.post("/:invitationId/status", async c => {
  const input = await body(c.req.raw);
  if (typeof input.invitationSecret !== "string" || !SECRET.test(input.invitationSecret)
    || typeof input.submissionId !== "string" || !UUID.test(input.submissionId)) return c.json({ error: "Unavailable" }, 404);
  const result = await c.env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE!.status({ protocolVersion: 1,
    invitationId: c.req.param("invitationId"), invitationSecret: input.invitationSecret, submissionId: input.submissionId,
  });
  return result.ok ? c.json(result) : c.json({ error: "Unavailable" }, 404);
});
