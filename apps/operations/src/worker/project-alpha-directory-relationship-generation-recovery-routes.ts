import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  authorizeDirectoryRelationshipRecoveryReview,
  createDirectoryRelationshipRecoveryReview,
} from "./project-alpha-directory-relationship-generation-recovery-service";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const DIRECTORY_RELATIONSHIP_RECOVERY_ROUTE =
  "/api/client-hub/directory/standalone-clients/:recordId/relationship-generation-recovery";
export const DIRECTORY_RELATIONSHIP_RECOVERY_PREFIX =
  "/api/client-hub/directory/standalone-clients/";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const SOURCE_ID = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const RECORD_ID = z.string().min(1).refine(value => Array.from(value).length <= 191 && !/\p{C}/u.test(value)
  && new TextEncoder().encode(value).byteLength <= 764);
const reviewSchema = z.object({ sourceId: SOURCE_ID }).strict();
const authorizeSchema = z.object({ evidenceSha256: SHA256, authorizationId: UUID, successorCommandId: UUID,
  reason: z.string().trim().min(1).max(500).refine(value => !/\p{C}/u.test(value)) }).strict();

export function directoryRelationshipRecoveryEnabled(env: Pick<Env,
  "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED" | "PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED">): boolean {
  return env.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED === "true"
    && env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true";
}

/** Used by the early index gate, before generic API authentication performs DB I/O. */
export function isDirectoryRelationshipRecoveryPath(path: string): boolean {
  return path.startsWith(DIRECTORY_RELATIONSHIP_RECOVERY_PREFIX)
    && path.includes("/relationship-generation-recovery/");
}

async function body<T>(c: AppContext, schema: z.ZodType<T>, label: string): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJson(c.req.raw, 16 * 1024, label));
  if (!parsed.success) throw new HTTPException(400, { message: `${label} request is invalid` });
  return parsed.data;
}

async function actor(c: AppContext) {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
    });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const principal = c.get("principal"), identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, email: identity.email,
    admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion,
    verifiedUntil: authenticated.verifiedUntil };
}

function requireAvailable(c: AppContext): void {
  if (!directoryRelationshipRecoveryEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
  if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
  c.header("Cache-Control", "no-store");
}

function publicOutcome(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "uncertain", reason: "invalid_outcome" };
  const raw = value as Record<string, unknown>;
  if (raw.status === "review" && raw.review && typeof raw.review === "object" && !Array.isArray(raw.review)) {
    const review = raw.review as Record<string, unknown>, safe: Record<string, unknown> = {};
    for (const key of ["reviewId", "recordId", "sourceId", "predecessorCommandId", "evidenceSha256", "clientRevision",
      "organizationRevision", "organizationRecordId", "observedAuthorizationGeneration", "expiresAt"])
      if (typeof review[key] === "string") safe[key] = review[key];
    if (review.remoteParentPublicId === null) safe.remoteParentPublicId = null;
    return { status: "review", review: safe };
  }
  const safe: Record<string, unknown> = { status: typeof raw.status === "string" ? raw.status : "uncertain" };
  for (const key of ["reason", "successorCommandId", "generation"])
    if (typeof raw[key] === "string") safe[key] = raw[key];
  if (typeof raw.replayed === "boolean") safe.replayed = raw.replayed;
  return safe;
}

function outcomeResponse(c: AppContext, result: { status: string }) {
  const value = publicOutcome(result);
  if (result.status === "blocked") return c.json(value, 403);
  if (result.status === "conflict") return c.json(value, 409);
  if (result.status === "uncertain") return c.json(value, 503);
  return c.json(value, 200);
}

export function registerDirectoryRelationshipGenerationRecoveryRoutes(app: App): void {
  app.post(`${DIRECTORY_RELATIONSHIP_RECOVERY_ROUTE}/reviews`, async c => {
    requireAvailable(c);
    const recordId = RECORD_ID.safeParse(c.req.param("recordId"));
    if (!recordId.success) throw new HTTPException(400, { message: "recordId is invalid" });
    const input = await body(c, reviewSchema, "Relationship generation recovery review");
    const result = await createDirectoryRelationshipRecoveryReview(c.env,
      { recordId: recordId.data, sourceId: input.sourceId }, await actor(c), fetch);
    return outcomeResponse(c, result);
  });

  app.post(`${DIRECTORY_RELATIONSHIP_RECOVERY_ROUTE}/reviews/:reviewId/authorize`, async c => {
    requireAvailable(c);
    const recordId = RECORD_ID.safeParse(c.req.param("recordId")), reviewId = UUID.safeParse(c.req.param("reviewId"));
    if (!recordId.success || !reviewId.success) throw new HTTPException(400, { message: "Recovery identifiers are invalid" });
    const input = await body(c, authorizeSchema, "Relationship generation recovery authorization");
    if (c.req.header("Idempotency-Key") !== input.authorizationId)
      throw new HTTPException(400, { message: "Idempotency-Key must match authorizationId" });
    const result = await authorizeDirectoryRelationshipRecoveryReview(c.env,
      { recordId: recordId.data, reviewId: reviewId.data, ...input }, await actor(c));
    return outcomeResponse(c, result);
  });
}
