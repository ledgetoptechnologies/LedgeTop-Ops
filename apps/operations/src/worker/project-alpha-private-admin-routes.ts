import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { acquireProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-binding-review-consumer";
import { reserveProjectAlphaProjectAdoptionReview } from "./project-alpha-project-adoption-review-consumer";
import { planProjectAlphaProjectAdoptionBind } from "./project-alpha-project-adoption-bind-consumer";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE = "/api/admin/project-alpha/private";
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const IDEMPOTENCY = UUID;
const SOURCE_ID = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const RECORD_ID = z.string().min(1).max(191).refine(value => !/\p{C}/u.test(value));
const PUBLIC_ID = z.string().regex(/^[0-9a-f]{32}$/);
const positiveInteger = z.number().int().positive();

const acquireSchema = z.object({
  reviewId: UUID,
  commandId: UUID,
  sourceId: SOURCE_ID,
  recordId: RECORD_ID,
  resourceType: z.enum(["client", "organization"]),
  projectAlphaPublicId: PUBLIC_ID,
  localRecordVersion: positiveInteger,
}).strict();
const activationSchema = z.object({ reviewItemId: UUID, idempotencyKey: IDEMPOTENCY }).strict();
const reservationSchema = z.object({ reviewItemId: UUID, idempotencyKey: IDEMPOTENCY }).strict();
const bindSchema = z.object({ reservationId: UUID }).strict();

function enabled(env: Pick<Env, "PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED">): boolean {
  return env.PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED === "true";
}

async function json<T>(request: Request, schema: z.ZodType<T>, label: string): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJson(request, 32 * 1024, label));
  if (!parsed.success) throw new HTTPException(400, { message: `${label} request is invalid` });
  return parsed.data;
}

function requireIdempotency(request: Request, expected: string): void {
  if (request.headers.get("Idempotency-Key") !== expected)
    throw new HTTPException(400, { message: "Idempotency-Key does not match the requested action" });
}

async function currentReviewer(env: Env, principal: StaffPrincipal): Promise<{
  staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number; grantGeneration: number;
}> {
  const row = await env.OPS_DB.prepare(`SELECT admission.version admissionVersion,profile.version profileVersion,
      generation.generation grantGeneration
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(principal.id, principal.accessSubject)
    .first<{ admissionVersion: number; profileVersion: number; grantGeneration: number }>();
  if (!row || !Number.isSafeInteger(row.admissionVersion) || row.admissionVersion < 1
    || !Number.isSafeInteger(row.profileVersion) || row.profileVersion < 1
    || !Number.isSafeInteger(row.grantGeneration) || row.grantGeneration < 1)
    throw new HTTPException(403, { message: "Current directory authority is required" });
  return { staffId: principal.id, accessSubject: principal.accessSubject,
    admissionVersion: row.admissionVersion, profileVersion: row.profileVersion, grantGeneration: row.grantGeneration };
}

function principalActor(principal: StaffPrincipal): { staffId: string; accessSubject: string } {
  return { staffId: principal.id, accessSubject: principal.accessSubject };
}

async function guard(c: AppContext, next: () => Promise<void>): Promise<void> {
  if (!enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
  if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
  const scope = await sqlScope(c.env, c.get("principal"), "integrations.manage");
  if (!scope.global || scope.deniedGlobal)
    throw new HTTPException(403, { message: "Global integrations.manage permission required" });
  c.header("Cache-Control", "no-store");
  await next();
}

/**
 * Private, default-off transport for the already-audited PA consumers. The
 * browser supplies only opaque action identifiers and resource selections;
 * actor identity and all authority versions come from the authenticated
 * Operations session and the current native authority rows.
 */
export function registerProjectAlphaPrivateAdminRoutes(app: App): void {
  app.use(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/*`, guard);

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/acquire`, async c => {
    const input = await json(c.req.raw, acquireSchema, "Directory acquisition");
    requireIdempotency(c.req.raw, input.commandId);
    const actor = await currentReviewer(c.env, c.get("principal"));
    return c.json(await acquireProjectAlphaExistingDirectoryBinding(c.env, {
      ...input,
      reviewer: actor,
    }, fetch));
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/activate`, async c => {
    const input = await json(c.req.raw, activationSchema, "Directory activation");
    requireIdempotency(c.req.raw, input.idempotencyKey);
    await currentReviewer(c.env, c.get("principal"));
    return c.json(await activateProjectAlphaExistingDirectoryBinding(c.env, input,
      principalActor(c.get("principal")), fetch));
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/reserve`, async c => {
    const input = await json(c.req.raw, reservationSchema, "Project adoption reservation");
    requireIdempotency(c.req.raw, input.idempotencyKey);
    await currentReviewer(c.env, c.get("principal"));
    return c.json(await reserveProjectAlphaProjectAdoptionReview(c.env,
      principalActor(c.get("principal")), input));
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/bind`, async c => {
    const input = await json(c.req.raw, bindSchema, "Project adoption bind");
    requireIdempotency(c.req.raw, input.reservationId);
    await currentReviewer(c.env, c.get("principal"));
    return c.json(await planProjectAlphaProjectAdoptionBind(c.env,
      principalActor(c.get("principal")), input));
  });
}
