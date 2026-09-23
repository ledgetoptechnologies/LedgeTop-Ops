import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { acquireProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-binding-review-consumer";
import { acquireProjectAlphaDirectoryReconciliationFinding,
  listProjectAlphaDirectoryReconciliationFindings,
  listProjectAlphaDirectoryReconciliationRecords,
  readProjectAlphaDirectoryReconciliationFindingContext } from "./project-alpha-directory-reconciliation-review";
import { reserveProjectAlphaProjectAdoptionReview } from "./project-alpha-project-adoption-review-consumer";
import { produceProjectAlphaProjectAdoptionReview } from "./project-alpha-project-adoption-review-producer";
import { planProjectAlphaProjectAdoptionBind } from "./project-alpha-project-adoption-bind-consumer";
import { resolveClientHubDetailContext, verifyClientHubDetailContext } from "./client-hub";
import { clientHubBusinessProjectOwnership } from "./client-hub-business-projects";
import { readClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
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
const clientContextSchema = z.object({
  sourceId: SOURCE_ID,
  rootNamespace: z.literal("business"),
  kind: z.enum(["organization", "standalone_client"]),
  publicId: RECORD_ID,
  expectedContextVersion: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const legacyReviewSchema = z.object({
  idempotencyKey: IDEMPOTENCY,
  externalProjectId: RECORD_ID,
  projectAlphaPublicId: PUBLIC_ID,
}).strict();
const contextualReviewSchema = z.object({
  idempotencyKey: IDEMPOTENCY,
  externalProjectId: RECORD_ID,
  clientContext: clientContextSchema,
}).strict();
const reviewSchema = z.union([legacyReviewSchema, contextualReviewSchema]);
const bindSchema = z.object({ reservationId: UUID }).strict();
const reconciliationAdoptionSchema = z.object({
  findingId: UUID,
  recordId: RECORD_ID,
  expectedRecordVersion: positiveInteger,
  idempotencyKey: IDEMPOTENCY,
}).strict();

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

async function requireGlobalDirectoryProfileView(env: Env, staffId: string): Promise<void> {
  const row = await env.OPS_DB.prepare(`SELECT 1 ok FROM native_directory_grants allowed
    WHERE allowed.staff_id=? AND allowed.permission='directory.profile.view' AND allowed.effect='allow'
      AND allowed.active=1 AND allowed.scope_kind='global'
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants denied WHERE denied.staff_id=allowed.staff_id
        AND denied.permission=allowed.permission AND denied.effect='deny' AND denied.active=1
        AND denied.scope_kind='global') LIMIT 1`).bind(staffId).first<{ ok: number }>();
  if (!row) throw new HTTPException(403, { message: "Global directory profile view permission required" });
}

function principalActor(principal: StaffPrincipal): { staffId: string; accessSubject: string } {
  return { staffId: principal.id, accessSubject: principal.accessSubject };
}

async function projectSource(env: Env, externalProjectId: string): Promise<string | null> {
  const row = await env.OPS_DB.prepare(`SELECT source_id sourceId FROM project_alpha_project_destinations
    WHERE external_project_id=?`).bind(externalProjectId).first<{ sourceId: string }>();
  return row && SOURCE_ID.safeParse(row.sourceId).success ? row.sourceId : null;
}

async function contextualProject(env: Env, principal: StaffPrincipal,
  input: z.infer<typeof contextualReviewSchema>): Promise<{ sourceId: string; projectAlphaPublicId: string }> {
  const selected = input.clientContext;
  const context = await resolveClientHubDetailContext(env, principal, selected.kind, selected.publicId,
    selected.sourceId, selected.rootNamespace);
  if (context.contextVersion !== selected.expectedContextVersion)
    throw new HTTPException(409, { message: "Client mapping or permissions changed. Refresh the client workspace to continue" });
  const policy = await readClientHubBusinessProjectPolicy(env, principal);
  if (!policy.allowed) throw new HTTPException(403, { message: "Project view permission is required" });
  const ownership = clientHubBusinessProjectOwnership(context);
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT p.id,
      CASE WHEN json_valid(p.payload_json) AND json_type(p.payload_json,'$.public_id')='text'
        THEN json_extract(p.payload_json,'$.public_id') END projectAlphaPublicId
    FROM pa_projects p
    LEFT JOIN pa_clients owner ON owner.id=p.client_id
      AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.id=? AND p.projection_source_id=? AND (${ownership.sql}) AND (${policy.filter.sql})
    ORDER BY p.id LIMIT 2`).bind(input.externalProjectId, selected.sourceId, ...ownership.values,
      ...policy.filter.values).all<{ id: string; projectAlphaPublicId: string | null }>();
  if (rows.results.length !== 1 || !PUBLIC_ID.safeParse(rows.results[0]?.projectAlphaPublicId).success)
    throw new HTTPException(409, { message: "The selected Project Alpha project is no longer available for this client" });
  await verifyClientHubDetailContext(env, principal, context);
  return { sourceId: selected.sourceId, projectAlphaPublicId: rows.results[0]!.projectAlphaPublicId! };
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

  app.get(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/reconciliation/findings`, async c => {
    const url = new URL(c.req.url);
    if ([...url.searchParams.keys()].some(key => !["sourceId", "limit", "cursor"].includes(key)))
      throw new HTTPException(400, { message: "Reconciliation finding query is invalid" });
    const sourceIds = url.searchParams.getAll("sourceId");
    const rawLimit = url.searchParams.get("limit") ?? "25";
    if (!/^[1-9][0-9]?$/u.test(rawLimit) || Number(rawLimit) > 50)
      throw new HTTPException(400, { message: "Reconciliation finding query is invalid" });
    const page = await listProjectAlphaDirectoryReconciliationFindings(c.env, {
      sourceIds, limit: Number(rawLimit), ...(url.searchParams.has("cursor")
        ? { cursor: url.searchParams.get("cursor") ?? "" } : {}),
    });
    if (!page) throw new HTTPException(400, { message: "Reconciliation finding query is invalid" });
    return c.json(page);
  });

  app.get(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/reconciliation/records`, async c => {
    const url = new URL(c.req.url);
    if ([...url.searchParams.keys()].some(key => !["resourceType", "limit", "cursor"].includes(key)))
      throw new HTTPException(400, { message: "Reconciliation record query is invalid" });
    const resourceType = url.searchParams.get("resourceType");
    const rawLimit = url.searchParams.get("limit") ?? "25";
    if ((resourceType !== "client" && resourceType !== "organization")
      || !/^[1-9][0-9]?$/u.test(rawLimit) || Number(rawLimit) > 50)
      throw new HTTPException(400, { message: "Reconciliation record query is invalid" });
    const reviewer = await currentReviewer(c.env, c.get("principal"));
    const page = await listProjectAlphaDirectoryReconciliationRecords(c.env, {
      resourceType, reviewerStaffId: reviewer.staffId, limit: Number(rawLimit), ...(url.searchParams.has("cursor")
        ? { cursor: url.searchParams.get("cursor") ?? "" } : {}),
    });
    if (!page) throw new HTTPException(400, { message: "Reconciliation record query is invalid" });
    return c.json(page);
  });

  app.get(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/reconciliation/findings/:findingId/context`, async c => {
    const findingId = c.req.param("findingId");
    if (!UUID.safeParse(findingId).success)
      throw new HTTPException(404, { message: "Reconciliation finding not found" });
    const reviewer = await currentReviewer(c.env, c.get("principal"));
    await requireGlobalDirectoryProfileView(c.env, reviewer.staffId);
    const context = await readProjectAlphaDirectoryReconciliationFindingContext(c.env, findingId, fetch);
    if (!context) throw new HTTPException(409, { message: "Current reconciliation context is unavailable" });
    return c.json(context);
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/directory/reconciliation/acquire`, async c => {
    const input = await json(c.req.raw, reconciliationAdoptionSchema, "Reconciliation acquisition");
    requireIdempotency(c.req.raw, input.idempotencyKey);
    const reviewer = await currentReviewer(c.env, c.get("principal"));
    return c.json(await acquireProjectAlphaDirectoryReconciliationFinding(c.env, input, reviewer));
  });

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

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/review`, async c => {
    const input = await json(c.req.raw, reviewSchema, "Project adoption review");
    requireIdempotency(c.req.raw, input.idempotencyKey);
    await currentReviewer(c.env, c.get("principal"));
    const selection = "clientContext" in input
      ? await contextualProject(c.env, c.get("principal"), input)
      : { sourceId: await projectSource(c.env, input.externalProjectId), projectAlphaPublicId: input.projectAlphaPublicId };
    const sourceId = selection.sourceId;
    if (!sourceId) throw new HTTPException(409, { message: "Project adoption destination is unavailable" });
    return c.json(await produceProjectAlphaProjectAdoptionReview(c.env,
      principalActor(c.get("principal")), { idempotencyKey: input.idempotencyKey,
        externalProjectId: input.externalProjectId, projectAlphaPublicId: selection.projectAlphaPublicId, sourceId }, fetch));
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/bind`, async c => {
    const input = await json(c.req.raw, bindSchema, "Project adoption bind");
    requireIdempotency(c.req.raw, input.reservationId);
    await currentReviewer(c.env, c.get("principal"));
    return c.json(await planProjectAlphaProjectAdoptionBind(c.env,
      principalActor(c.get("principal")), input));
  });
}
