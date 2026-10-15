import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sqlScope } from "./acl";
import { parseDuplicateFreeJson, readBoundedJson } from "./bounded-json";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { auditStatement } from "./request-security";
import { listAuthorizedProjectAlphaProjectAdoptionCandidates } from "./project-alpha-project-adoption-candidates-consumer";
import { produceProjectAlphaProjectAdoptionReview } from "./project-alpha-project-adoption-review-producer";
import { reserveProjectAlphaProjectAdoptionReview } from "./project-alpha-project-adoption-review-consumer";
import { planProjectAlphaProjectAdoptionBind } from "./project-alpha-project-adoption-bind-consumer";
import { finalizeProjectAlphaProjectAdoption } from "./project-alpha-project-adoption-finalizer";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type ClientKind = "organization" | "standalone_client";
type ResolveContext = (env: Env, principal: StaffPrincipal, kind: ClientKind, publicId: string,
  sourceId?: string, rootNamespace?: string) => Promise<ClientHubCollectionContext>;
type VerifyContext = (env: Env, principal: StaffPrincipal, context: ClientHubCollectionContext) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const EXTERNAL_ID = /^[^\u0000-\u001f\u007f]{1,191}$/u;
const MAX_PA_RESPONSE_BYTES = 64 * 1024;

export function projectAlphaProjectOperationalAdoptionEnabled(env: Pick<Env,
  "PROJECT_ALPHA_PROJECT_ADOPTION_OPERATIONAL_ENABLED" | "PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED" |
  "PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED">): boolean {
  return env.PROJECT_ALPHA_PROJECT_ADOPTION_OPERATIONAL_ENABLED === "true"
    && env.PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED === "true"
    && env.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED === "true";
}

function own(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function routeKind(value: string): ClientKind | null {
  return value === "organizations" ? "organization" : value === "standalone" ? "standalone_client" : null;
}
function requireEnabled(env: Env): void {
  if (!projectAlphaProjectOperationalAdoptionEnabled(env)) throw new HTTPException(404, { message: "Not found" });
}
function requireIdempotency(request: Request, expected?: string): string {
  const value = request.headers.get("Idempotency-Key") ?? "";
  if (!UUID.test(value) || expected !== undefined && value !== expected)
    throw new HTTPException(400, { message: "A matching UUID Idempotency-Key is required" });
  return value;
}
async function body(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  const value = await readBoundedJson(request, 16 * 1024, "Project adoption request");
  if (!own(value, keys)) throw new HTTPException(400, { message: "Project adoption request is invalid" });
  return value;
}

type Actor = Readonly<{ staffId: string; accessSubject: string; email: string; admissionVersion: number;
  profileVersion: number; verifiedUntil: string }>;
async function currentActor(c: AppContext): Promise<Actor> {
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
  const [owner, integration] = await Promise.all([
    c.env.OPS_DB.prepare(`SELECT 1 ok FROM staff_role_assignments WHERE staff_id=?
      AND role_id='role-owner' AND scope='global' LIMIT 1`).bind(identity.staffId).first<number>("ok"),
    sqlScope(c.env, principal, "integrations.manage"),
  ]);
  if (owner !== 1 || !integration.global || integration.deniedGlobal)
    throw new HTTPException(403, { message: "Owner and global integrations.manage authority are required" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, email: identity.email,
    admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion,
    verifiedUntil: authenticated.verifiedUntil };
}

async function operationalContext(c: AppContext, resolve: ResolveContext): Promise<ClientHubCollectionContext> {
  requireEnabled(c.env);
  if (c.req.param("rootNamespace") !== "business") throw new HTTPException(404, { message: "Project adoption is unavailable" });
  const kind = routeKind(c.req.param("kind") ?? "");
  if (!kind) throw new HTTPException(404, { message: "Client not found" });
  const sourceId = c.req.param("sourceId") ?? "";
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId))
    throw new HTTPException(404, { message: "Project adoption is unavailable" });
  const context = await resolve(c.env, c.get("principal"), kind, c.req.param("publicId") ?? "", sourceId, "business");
  if (context.root.source_id !== sourceId || context.root.root_namespace !== "business"
    || context.root.kind !== kind || !PUBLIC_ID.test(context.root.pa_public_id ?? ""))
    throw new HTTPException(404, { message: "Project adoption is unavailable" });
  return context;
}
function contextVersion(input: Record<string, unknown>, context: ClientHubCollectionContext): void {
  if (typeof input.expectedContextVersion !== "string" || input.expectedContextVersion !== context.contextVersion)
    throw new HTTPException(409, { message: "Client context changed. Refresh the workspace to continue" });
}
function belongs(context: ClientHubCollectionContext, value: Record<string, unknown>): boolean {
  const publicId = context.root.pa_public_id;
  return context.root.kind === "organization"
    ? value.organizationPublicId === publicId
    : value.clientPublicId === publicId && value.organizationPublicId === null;
}
function filteredProjects(context: ClientHubCollectionContext, projects: readonly unknown[]): readonly Record<string, unknown>[] {
  return projects.filter((value): value is Record<string, unknown> => !!value && typeof value === "object"
    && !Array.isArray(value) && belongs(context, value as Record<string, unknown>))
    .map(({ organizationRecordId: _organizationRecordId, clientRecordId: _clientRecordId, ...safe }) => safe);
}
async function boundedPaResponse(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PA_RESPONSE_BYTES))
    throw new Error("project response limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("project response missing");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PA_RESPONSE_BYTES) {
        void reader.cancel("project_response_too_large");
        throw new Error("project response limit");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function scopedTransport(context: ClientHubCollectionContext, selectedPublicId: string, send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await send(input, init);
    let url: URL;
    try { url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); }
    catch { return response; }
    if (!response.ok || !url.pathname.endsWith(`/api/v2/projects/${selectedPublicId}`)) return response;
    try {
      const value = await boundedPaResponse(response.clone());
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid project response");
      const data = (value as Record<string, unknown>).data;
      if (!data || typeof data !== "object" || Array.isArray(data) || !belongs(context, data as Record<string, unknown>))
        throw new Error("project relationship changed");
      return response;
    } catch {
      return new Response(JSON.stringify({ error: "project relationship changed" }), {
        status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  };
}

async function exactStoredRelationship(db: D1Database, context: ClientHubCollectionContext,
  key: "review" | "reservation" | "command", id: string, pairedId?: string): Promise<boolean> {
  const selector = key === "review" ? "review.review_item_id=?"
    : key === "reservation" ? "reservation.reservation_id=?"
      : "bridge.command_id=? AND bridge.reservation_id=?";
  const joins = key === "review" ? ""
    : `JOIN project_alpha_project_adoption_review_reservations reservation ON reservation.review_item_id=review.review_item_id
      ${key === "command" ? "JOIN project_alpha_project_adoption_bind_receipts bridge ON bridge.reservation_id=reservation.reservation_id" : ""}`;
  const row = await db.prepare(`SELECT review.source_id,review.organization_project_alpha_public_id organizationPublicId,
      review.client_project_alpha_public_id clientPublicId FROM project_alpha_project_adoption_review_evidence review
      ${joins} WHERE ${selector}`).bind(...(pairedId === undefined ? [id] : [id, pairedId])).first<Record<string, unknown>>();
  return !!row && row.source_id === context.root.source_id && belongs(context, row);
}

function publicOutcome(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "uncertain", reason: "invalid_outcome" };
  const raw = value as Record<string, unknown>, safe: Record<string, unknown> = {
    status: typeof raw.status === "string" ? raw.status : "uncertain",
  };
  for (const key of ["reason", "reviewItemId", "requestSha256", "reservationId", "bridgeId", "commandId", "receiptId", "activationId"])
    if (typeof raw[key] === "string") safe[key] = raw[key];
  if (typeof raw.replayed === "boolean") safe.replayed = raw.replayed;
  return safe;
}
async function audit(c: AppContext, event: string, targetId: string, details: Record<string, unknown>): Promise<void> {
  await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"), event,
    "project_alpha_project_adoption", targetId, null, details)]);
}

export function registerProjectAlphaProjectOperationalAdoptionRoutes(app: App,
  resolve: ResolveContext, verify: VerifyContext): void {
  const base = "/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/project-adoption";

  app.get(`${base}/candidates`, async c => {
    const context = await operationalContext(c, resolve), actor = await currentActor(c);
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => !["cursor", "limit", "expectedContextVersion"].includes(key))
      || params.getAll("cursor").length > 1 || params.getAll("limit").length > 1
      || params.getAll("expectedContextVersion").length !== 1
      || params.get("expectedContextVersion") !== context.contextVersion)
      throw new HTTPException(400, { message: "Project adoption candidate query is invalid" });
    const rawLimit = params.get("limit");
    if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(rawLimit))
      throw new HTTPException(400, { message: "Project adoption candidate query is invalid" });
    const outcome = await listAuthorizedProjectAlphaProjectAdoptionCandidates(c.env,
      { staffId: actor.staffId, accessSubject: actor.accessSubject }, {
        sourceId: context.root.source_id, cursor: params.get("cursor") ?? undefined,
        limit: rawLimit === null ? undefined : Number(rawLimit),
      }, fetch);
    await verify(c.env, c.get("principal"), context); await currentActor(c);
    c.header("Cache-Control", "no-store");
    return c.json({ canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
      outcome: outcome.status === "observed" ? { ...outcome, projects: filteredProjects(context, outcome.projects) } : outcome });
  });

  app.post(`${base}/review`, async c => {
    const context = await operationalContext(c, resolve), actor = await currentActor(c);
    const input = await body(c.req.raw, ["expectedContextVersion", "externalProjectId", "projectAlphaPublicId"]);
    contextVersion(input, context);
    if (typeof input.externalProjectId !== "string" || !EXTERNAL_ID.test(input.externalProjectId)
      || input.externalProjectId !== input.externalProjectId.trim()
      || typeof input.projectAlphaPublicId !== "string" || !PUBLIC_ID.test(input.projectAlphaPublicId))
      throw new HTTPException(400, { message: "Project adoption request is invalid" });
    const idempotencyKey = requireIdempotency(c.req.raw);
    const outcome = publicOutcome(await produceProjectAlphaProjectAdoptionReview(c.env,
      { staffId: actor.staffId, accessSubject: actor.accessSubject }, {
        idempotencyKey, sourceId: context.root.source_id, externalProjectId: input.externalProjectId,
        projectAlphaPublicId: input.projectAlphaPublicId,
      }, scopedTransport(context, input.projectAlphaPublicId, fetch)));
    await verify(c.env, c.get("principal"), context); await currentActor(c);
    if (outcome.status === "reviewed" && (typeof outcome.reviewItemId !== "string"
      || !await exactStoredRelationship(c.env.OPS_DB, context, "review", outcome.reviewItemId)))
      throw new HTTPException(409, { message: "Project relationship changed. Refresh the workspace to continue" });
    await audit(c, "integration.project_alpha_operational_project_adoption_review_completed", idempotencyKey,
      { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) });
    c.header("Cache-Control", "no-store"); return c.json({ outcome });
  });

  app.post(`${base}/reserve`, async c => {
    const context = await operationalContext(c, resolve), actor = await currentActor(c);
    const input = await body(c.req.raw, ["expectedContextVersion", "reviewItemId", "idempotencyKey"]);
    contextVersion(input, context);
    if (typeof input.reviewItemId !== "string" || !UUID.test(input.reviewItemId)
      || typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey))
      throw new HTTPException(400, { message: "Project adoption request is invalid" });
    requireIdempotency(c.req.raw, input.idempotencyKey);
    if (!await exactStoredRelationship(c.env.OPS_DB, context, "review", input.reviewItemId))
      throw new HTTPException(404, { message: "Project adoption review not found" });
    const outcome = publicOutcome(await reserveProjectAlphaProjectAdoptionReview(c.env,
      { staffId: actor.staffId, accessSubject: actor.accessSubject }, {
        reviewItemId: input.reviewItemId, idempotencyKey: input.idempotencyKey,
      }));
    await verify(c.env, c.get("principal"), context); await currentActor(c);
    await audit(c, "integration.project_alpha_operational_project_adoption_reservation_completed",
      input.idempotencyKey, { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) });
    c.header("Cache-Control", "no-store"); return c.json(outcome);
  });

  app.post(`${base}/bind`, async c => {
    const context = await operationalContext(c, resolve), actor = await currentActor(c);
    const input = await body(c.req.raw, ["expectedContextVersion", "reservationId"]);
    contextVersion(input, context);
    if (typeof input.reservationId !== "string" || !UUID.test(input.reservationId))
      throw new HTTPException(400, { message: "Project adoption request is invalid" });
    requireIdempotency(c.req.raw, input.reservationId);
    if (!await exactStoredRelationship(c.env.OPS_DB, context, "reservation", input.reservationId))
      throw new HTTPException(404, { message: "Project adoption reservation not found" });
    const outcome = publicOutcome(await planProjectAlphaProjectAdoptionBind(c.env,
      { staffId: actor.staffId, accessSubject: actor.accessSubject }, { reservationId: input.reservationId }));
    await verify(c.env, c.get("principal"), context); await currentActor(c);
    await audit(c, "integration.project_alpha_operational_project_adoption_bind_planned", input.reservationId,
      { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) });
    c.header("Cache-Control", "no-store"); return c.json(outcome);
  });

  app.post(`${base}/finalize`, async c => {
    const context = await operationalContext(c, resolve), actor = await currentActor(c);
    const input = await body(c.req.raw, ["expectedContextVersion", "reservationId", "commandId"]);
    contextVersion(input, context);
    if (typeof input.reservationId !== "string" || !UUID.test(input.reservationId)
      || typeof input.commandId !== "string" || !UUID.test(input.commandId))
      throw new HTTPException(400, { message: "Project adoption request is invalid" });
    requireIdempotency(c.req.raw, input.commandId);
    if (!await exactStoredRelationship(c.env.OPS_DB, context, "command", input.commandId, input.reservationId))
      throw new HTTPException(404, { message: "Project adoption bind not found" });
    const result = await finalizeProjectAlphaProjectAdoption(c.env, actor, {
      reservationId: input.reservationId, commandId: input.commandId,
    }, fetch);
    await verify(c.env, c.get("principal"), context); await currentActor(c);
    const outcome = publicOutcome(result.outcome);
    await audit(c, "integration.project_alpha_operational_project_adoption_finalization_completed", input.commandId,
      { reservationId: input.reservationId, stage: result.stage, status: outcome.status,
        ...(outcome.reason ? { reason: outcome.reason } : {}) });
    c.header("Cache-Control", "no-store"); return c.json({ stage: result.stage, outcome });
  });
}
