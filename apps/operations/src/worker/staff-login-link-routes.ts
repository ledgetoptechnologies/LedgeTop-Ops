import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import { hmac } from "./crypto";
import { requestHostAllowed } from "./host-admission";
import { requireCurrentStaffLogin, verifyStaffLoginClaims } from "./auth";
import { consumeNativeStaffOnboardingRateLimit } from "./native-staff-onboarding-rate-limit";
import {
  StaffLoginBindingError, resolveVerifiedStaffLogin, createStaffLoginBindingIntent,
  claimStaffLoginBindingIntent, previewStaffLoginBindingIntent, revokeStaffLoginBinding, listStaffLoginBindings,
  type StaffLoginProof, type VerifiedStaffLoginClaims,
} from "./staff-login-bindings";
import type { Env, StaffPrincipal } from "./types";

type Bindings = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
type App = Hono<Bindings>;
type Ctx = Context<Bindings>;
export const STAFF_LOGIN_LINKS_PATH = "/api/account/login-links";
const emailInput = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
const claimInput = z.object({ intentId: z.string().uuid(), verificationToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const revokeInput = z.object({ expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1) }).strict();
const messages: Record<StaffLoginBindingError["code"], string> = {
  staff_login_invalid: "Check the sign-in email or verification link.",
  staff_login_denied: "This sign-in cannot complete that link. Use the intended email and sign in again.",
  staff_login_conflict: "The sign-in settings changed. Refresh them before trying again.",
  staff_login_unavailable: "Sign-in settings are temporarily unavailable.",
};

function noStore(c: Ctx) {
  c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
}
function failure(c: Ctx, error: unknown) {
  if (error instanceof StaffLoginBindingError)
    return c.json({ error: messages[error.code], code: error.code }, error.status);
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  return c.json({ error: messages.staff_login_unavailable, code: "staff_login_unavailable" }, 503);
}
function sameOrigin(c: Ctx) {
  if (!requestHostAllowed(c.req.url, c.env) || c.req.header("Origin") !== new URL(c.req.url).origin)
    throw new HTTPException(403, { message: "Request origin was rejected" });
}
async function parse<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJson(c.req.raw, 8192, "Sign-in link request"));
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid sign-in link request" });
  return parsed.data;
}
async function quota(c: Ctx, claims: VerifiedStaffLoginClaims) {
  const digest = await hmac(c.env.OPERATIONS_SESSION_SECRET, `staff-login-link:v1:${claims.issuer}:${claims.subject}`);
  const permitted = await consumeNativeStaffOnboardingRateLimit(c.env.OPS_DB, `subject:${digest}`, 12, 60);
  if (!permitted) {
    c.header("Retry-After", "60");
    throw new HTTPException(429, { message: "Wait a minute before trying another sign-in link." });
  }
}
async function currentLogin(c: Ctx) {
  const claims = await verifyStaffLoginClaims(c.req.raw, c.env);
  const resolved = await resolveVerifiedStaffLogin(c.env.OPS_DB, claims);
  const principal = c.get("principal");
  if (!resolved || resolved.staff.id !== principal.id || resolved.staff.accessSubject !== principal.accessSubject
    || resolved.staff.email !== principal.email) throw new StaffLoginBindingError("staff_login_denied", 403);
  await requireCurrentStaffLogin(c.env, principal);
  return { claims, resolved };
}
function primary(proof: StaffLoginProof) {
  if (proof.kind !== "primary") throw new StaffLoginBindingError("staff_login_denied", 403);
  return proof;
}

/** Register BEFORE ordinary staff authentication. Only these exact POSTs can preview/prove
 * an approved secondary sign-in; it still requires a verified human Access JWT,
 * an exact-target one-time secret, same origin, bounded JSON and quota. */
export function registerStaffLoginClaimRoute(app: App) {
  app.use(STAFF_LOGIN_LINKS_PATH, async (c, next) => { noStore(c); await next(); });
  app.use(`${STAFF_LOGIN_LINKS_PATH}/*`, async (c, next) => { noStore(c); await next(); });
  app.post(`${STAFF_LOGIN_LINKS_PATH}/preview-claim`, async c => {
    try {
      sameOrigin(c);
      const value = await parse(c, claimInput);
      const claims = await verifyStaffLoginClaims(c.req.raw, c.env);
      await quota(c, claims);
      return c.json(await previewStaffLoginBindingIntent(c.env.OPS_DB, claims, value));
    } catch (error) { return failure(c, error); }
  });
  app.post(`${STAFF_LOGIN_LINKS_PATH}/claim`, async c => {
    try {
      sameOrigin(c);
      const value = await parse(c, claimInput);
      const claims = await verifyStaffLoginClaims(c.req.raw, c.env);
      await quota(c, claims);
      return c.json(await claimStaffLoginBindingIntent(c.env.OPS_DB, claims, value));
    } catch (error) { return failure(c, error); }
  });
}

/** Register AFTER staff and mutation-CSRF middleware. Body fields can never pick
 * another staff account, issuer, subject or role. Security management is primary-owner only. */
export function registerStaffLoginOwnerRoutes(app: App) {
  app.get(STAFF_LOGIN_LINKS_PATH, async c => {
    try {
      const { claims, resolved } = await currentLogin(c);
      let canManage = false;
      let bindings: Array<{ id: string; email: string; version: number; status: "active" | "revoked"; createdAt: string; revokedAt: string | null }> = [];
      if (resolved.proof.kind === "primary") {
        try {
          const listed = await listStaffLoginBindings(c.env.OPS_DB, resolved.proof);
          bindings = listed.map(({ bindingId, ...rest }) => ({ id: bindingId, ...rest }));
          canManage = true;
        } catch (error) {
          if (!(error instanceof StaffLoginBindingError && error.code === "staff_login_denied")) throw error;
        }
      }
      return c.json({ canonicalEmail: resolved.staff.email, currentEmail: claims.email, canManage, bindings });
    } catch (error) { return failure(c, error); }
  });
  app.post(`${STAFF_LOGIN_LINKS_PATH}/intents`, async c => {
    try {
      const { claims, resolved } = await currentLogin(c);
      const proof = primary(resolved.proof);
      const value = await parse(c, emailInput);
      await quota(c, claims);
      const intent = await createStaffLoginBindingIntent(c.env.OPS_DB, proof, value.email);
      const url = new URL("/auth/link-login", c.req.url);
      url.hash = new URLSearchParams({ intent: intent.intentId, token: intent.verificationToken }).toString();
      return c.json({ intentId: intent.intentId, targetEmail: value.email, verificationUrl: url.href, expiresAt: intent.expiresAt }, 201);
    } catch (error) { return failure(c, error); }
  });
  app.delete(`${STAFF_LOGIN_LINKS_PATH}/:bindingId`, async c => {
    try {
      const { claims, resolved } = await currentLogin(c);
      const proof = primary(resolved.proof);
      const value = await parse(c, revokeInput);
      await quota(c, claims);
      return c.json(await revokeStaffLoginBinding(c.env.OPS_DB, proof, { bindingId: c.req.param("bindingId"), expectedVersion: value.expectedVersion }));
    } catch (error) { return failure(c, error); }
  });
}

