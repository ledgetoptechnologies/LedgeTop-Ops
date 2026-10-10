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
import { planProjectAlphaProjectAdoptionBind } from "./project-alpha-project-adoption-bind-consumer";
import { finalizeProjectAlphaProjectAdoption } from "./project-alpha-project-adoption-finalizer";
import { listAuthorizedProjectAlphaProjectAdoptionCandidates } from "./project-alpha-project-adoption-candidates-consumer";
import {
  readConfiguredProjectAlphaProjectBindingStatus,
} from "./project-alpha-project-binding-status-api-v2";
import {
  sendConfiguredProjectAlphaProjectBindingRevisionRefreshCommand,
} from "./project-alpha-project-binding-revision-refresh-api-v2";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { withEnabledConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { activateProjectAlphaProjectV2Canonical } from "./project-alpha-project-canonical-activation-adapter";
import { settleProjectAlphaProjectV2Read } from "./project-alpha-project-read-settlement-adapter";
import { dispatchProjectAlphaProjectV2PendingCommand } from "./project-alpha-project-v2-pending-dispatcher";
import {
  prepareProjectAlphaProjectV2Recovery,
  type ProjectAlphaProjectV2RecoveryActor,
} from "./project-alpha-project-v2-recovery";
import { prepareProjectAlphaProjectV2PostAckResume } from "./project-alpha-project-v2-post-ack-resume";
import {
  produceProjectAlphaProjectAdoptionReview,
  type ProjectAlphaProjectAdoptionReviewProducerOutcome,
} from "./project-alpha-project-adoption-review-producer";
import {
  proposeProjectAlphaInboundProjectEdit,
  readProjectAlphaInboundProjectProposal,
  resolveProjectAlphaInboundProjectEdit,
  type InboundProjectProposalOutcome,
  type InboundProjectResolutionOutcome,
} from "./project-alpha-project-inbound-reconciliation";
import { auditStatement } from "./request-security";
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
  externalId: RECORD_ID,
  resourceType: z.enum(["client", "organization"]),
  projectAlphaPublicId: PUBLIC_ID,
  expectedProjectAlphaRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  expectedAuthorizationGeneration: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
  localRecordVersion: positiveInteger,
}).strict();
const activationSchema = z.object({ reviewItemId: UUID, idempotencyKey: IDEMPOTENCY }).strict();
const reservationSchema = z.object({ reviewItemId: UUID, idempotencyKey: IDEMPOTENCY }).strict();
const bindSchema = z.object({ reservationId: UUID }).strict();
const finalizeSchema = z.object({ reservationId: UUID, commandId: UUID }).strict();
const projectAdoptionReviewSchema = z.object({
  sourceId: SOURCE_ID,
  externalProjectId: RECORD_ID,
  projectAlphaPublicId: PUBLIC_ID,
}).strict();
const projectBindingRefreshSchema = z.object({
  sourceId: SOURCE_ID,
  externalProjectId: RECORD_ID,
}).strict();
const inboundProposalSchema = z.object({
  sourceId: SOURCE_ID,
  externalProjectId: RECORD_ID,
}).strict();
const inboundResolutionSchema = z.object({
  proposalId: UUID,
  decision: z.enum(["accept_project_alpha", "keep_operations", "requires_follow_up"]),
}).strict();
const projectV2RecoverySchema = z.object({
  authorizationId: UUID,
  commandId: UUID,
  sourceId: SOURCE_ID,
  expectedApplicationId: UUID,
  expectedEventVersion: positiveInteger,
  reason: z.string().trim().min(1).max(500).refine(value => !value.includes("\0")),
}).strict();
const projectV2PostAckSchema = z.object({
  authorizationId: UUID,
  commandId: UUID,
  sourceId: SOURCE_ID,
  expectedApplicationId: UUID,
  reason: z.string().trim().min(1).max(500).refine(value => !value.includes("\0")),
}).strict();
const reconciliationAdoptionSchema = z.object({
  findingId: UUID,
  recordId: RECORD_ID,
  expectedRecordVersion: positiveInteger,
  idempotencyKey: IDEMPOTENCY,
}).strict();

function enabled(env: Pick<Env, "PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED">): boolean {
  return env.PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED === "true";
}

function projectAdoptionReviewEnabled(env: Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED">): boolean {
  return env.ENVIRONMENT === "staging" && env.PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED === "true";
}

function projectBindingRefreshEnabled(env: Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED">): boolean {
  return env.ENVIRONMENT === "staging" && env.PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED === "true";
}

function projectInboundReconciliationEnabled(env: Pick<Env, "PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED">): boolean {
  // This is a generic, explicitly reviewed feature gate. Keep it default-off in
  // every deployment; environment labels are not an authorization boundary.
  return env.PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED === "true";
}

function projectV2RecoveryEnabled(env: Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_PROJECT_V2_RECOVERY_ENABLED">): boolean {
  return env.ENVIRONMENT === "staging" && env.PROJECT_ALPHA_PROJECT_V2_RECOVERY_ENABLED === "true";
}

function sanitizedProjectAdoptionReviewOutcome(outcome: ProjectAlphaProjectAdoptionReviewProducerOutcome):
  ProjectAlphaProjectAdoptionReviewProducerOutcome {
  switch (outcome.status) {
    case "reviewed":
      return { status: "reviewed", reviewItemId: outcome.reviewItemId, requestSha256: outcome.requestSha256, replayed: outcome.replayed };
    case "rejected":
      return { status: "rejected", reason: outcome.reason };
    case "blocked":
      return { status: "blocked", reason: outcome.reason };
    case "conflict":
      return { status: "conflict", reason: outcome.reason };
    case "uncertain":
      return { status: "uncertain", reason: outcome.reason };
  }
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

async function currentNativeProjectActor(c: AppContext): Promise<ProjectAlphaProjectV2RecoveryActor> {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
    });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const principal = c.get("principal"), identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.verifiedAccessSubject !== principal.accessSubject
    || identity.email !== principal.email)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, email: identity.email,
    admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion,
    verifiedUntil: authenticated.verifiedUntil };
}

function publicProjectV2RecoveryOutcome(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "uncertain", reason: "invalid_outcome" };
  const raw = value as Record<string, unknown>;
  const safe: Record<string, unknown> = { status: typeof raw.status === "string" ? raw.status : "uncertain" };
  for (const key of ["reason", "authorizationId", "commandId", "receiptId", "settlementId", "activationId", "externalProjectId"])
    if (typeof raw[key] === "string") safe[key] = raw[key];
  for (const key of ["replayed"])
    if (typeof raw[key] === "boolean") safe[key] = raw[key];
  for (const key of ["uncertainEventVersion", "version"])
    if (typeof raw[key] === "number" && Number.isSafeInteger(raw[key])) safe[key] = raw[key];
  return safe;
}

async function auditProjectV2Recovery(c: AppContext, input: z.infer<typeof projectV2RecoverySchema>,
  stage: string, raw: unknown): Promise<Record<string, unknown>> {
  const outcome = publicProjectV2RecoveryOutcome(raw);
  await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"),
    "integration.project_v2_recovery_completed", "project_alpha_project_v2_recovery",
    input.authorizationId, null, { commandId: input.commandId, sourceId: input.sourceId,
      expectedApplicationId: input.expectedApplicationId, expectedEventVersion: input.expectedEventVersion,
      stage, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(typeof outcome.replayed === "boolean" ? { replayed: outcome.replayed } : {}) })]);
  return outcome;
}

async function auditProjectV2PostAck(c: AppContext, input: z.infer<typeof projectV2PostAckSchema>,
  stage: string, raw: unknown): Promise<Record<string, unknown>> {
  const outcome = publicProjectV2RecoveryOutcome(raw);
  await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"),
    "integration.project_v2_post_ack_resume_completed", "project_alpha_project_v2_post_ack_resume",
    input.authorizationId, null, { commandId: input.commandId, sourceId: input.sourceId,
      expectedApplicationId: input.expectedApplicationId, stage, status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(typeof outcome.replayed === "boolean" ? { replayed: outcome.replayed } : {}) })]);
  return outcome;
}

function inboundProposalAuditDetails(outcome: InboundProjectProposalOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "proposed": return { status: outcome.status, replayed: outcome.replayed };
    case "unchanged": return { status: outcome.status };
    default: return { status: outcome.status, reason: outcome.reason };
  }
}

function inboundResolutionAuditDetails(outcome: InboundProjectResolutionOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "resolved": return { status: outcome.status, decision: outcome.decision,
      syncStatus: outcome.syncStatus, resultingVersion: outcome.resultingVersion, replayed: outcome.replayed };
    default: return { status: outcome.status, reason: outcome.reason };
  }
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
    if (!projectAdoptionReviewEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, projectAdoptionReviewSchema, "Project adoption review");
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey || !IDEMPOTENCY.safeParse(idempotencyKey).success)
      throw new HTTPException(400, { message: "A UUID Idempotency-Key is required" });
    const reviewer = await currentReviewer(c.env, c.get("principal"));
    const outcome = sanitizedProjectAdoptionReviewOutcome(await produceProjectAlphaProjectAdoptionReview(
      c.env,
      { staffId: reviewer.staffId, accessSubject: reviewer.accessSubject },
      { ...input, idempotencyKey },
      fetch,
    ));
    await c.env.OPS_DB.batch([await auditStatement(
      c.env,
      c.req.raw,
      c.get("principal"),
      "integration.project_alpha_project_adoption_review_completed",
      "project_alpha_project_adoption_review",
      idempotencyKey,
      null,
      {
        status: outcome.status,
        ...(outcome.status === "blocked" || outcome.status === "rejected" || outcome.status === "conflict"
          ? { reason: outcome.reason } : {}),
      },
    )]);
    return c.json({ outcome });
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/inbound/propose`, async c => {
    if (!projectInboundReconciliationEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, inboundProposalSchema, "Project inbound proposal");
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey || !IDEMPOTENCY.safeParse(idempotencyKey).success)
      throw new HTTPException(400, { message: "A UUID Idempotency-Key is required" });
    await currentReviewer(c.env, c.get("principal"));
    const outcome = await proposeProjectAlphaInboundProjectEdit(c.env,
      principalActor(c.get("principal")), { ...input, idempotencyKey }, fetch);
    await c.env.OPS_DB.batch([await auditStatement(
      c.env,
      c.req.raw,
      c.get("principal"),
      "integration.project_alpha_project_inbound_proposal_completed",
      "project_alpha_project_inbound_proposal",
      outcome.status === "proposed" ? outcome.proposalId : idempotencyKey,
      null,
      inboundProposalAuditDetails(outcome),
    )]);
    return c.json({ outcome });
  });

  app.get(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/inbound/proposals/:proposalId`, async c => {
    if (!projectInboundReconciliationEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const proposalId = c.req.param("proposalId");
    if (!UUID.safeParse(proposalId).success) throw new HTTPException(404, { message: "Project inbound proposal not found" });
    await currentReviewer(c.env, c.get("principal"));
    const outcome = await readProjectAlphaInboundProjectProposal(c.env, principalActor(c.get("principal")), proposalId);
    if (outcome.status === "available") return c.json({ proposal: outcome.proposal });
    if (outcome.reason === "not_found" || outcome.reason === "authority")
      throw new HTTPException(404, { message: "Project inbound proposal not found" });
    if (outcome.reason === "database")
      throw new HTTPException(503, { message: "Project inbound proposal is unavailable" });
    throw new HTTPException(409, { message: "Project inbound proposal evidence is unavailable" });
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/inbound/resolve`, async c => {
    if (!projectInboundReconciliationEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, inboundResolutionSchema, "Project inbound resolution");
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey || !IDEMPOTENCY.safeParse(idempotencyKey).success)
      throw new HTTPException(400, { message: "A UUID Idempotency-Key is required" });
    await currentReviewer(c.env, c.get("principal"));
    const outcome = await resolveProjectAlphaInboundProjectEdit(c.env,
      principalActor(c.get("principal")), { ...input, idempotencyKey }, fetch);
    await c.env.OPS_DB.batch([await auditStatement(
      c.env,
      c.req.raw,
      c.get("principal"),
      "integration.project_alpha_project_inbound_resolution_completed",
      "project_alpha_project_inbound_proposal",
      input.proposalId,
      null,
      inboundResolutionAuditDetails(outcome),
    )]);
    return c.json({ outcome });
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/bindings/refresh`, async c => {
    if (!projectBindingRefreshEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, projectBindingRefreshSchema, "Project binding revision refresh");
    const commandId = c.req.header("Idempotency-Key");
    if (!commandId || !IDEMPOTENCY.safeParse(commandId).success)
      throw new HTTPException(400, { message: "A UUID Idempotency-Key is required" });
    const status = await readConfiguredProjectAlphaProjectBindingStatus(c.env, input.sourceId, input.externalProjectId);
    if (status.status !== "binding_stale") {
      // This maintenance route is staging-only. Preserve only the typed,
      // non-sensitive probe reason so operators can distinguish a missing PA
      // feature route from a missing key scope; never expose raw responses.
      const preflightReason = status.status === "blocked" && status.reason === "preflight"
        && status.preflight && status.preflight.status !== "verified" ? status.preflight.reason : undefined;
      return c.json({ outcome: status.status === "observed"
        ? { status: "current", revision: status.response.resource.revision }
        : { status: "not_refreshed", reason: preflightReason ? `preflight_${preflightReason}`
          : status.status === "disabled" ? "source_disabled" : status.status } });
    }
    const stale = status.response;
    const outcome = await sendConfiguredProjectAlphaProjectBindingRevisionRefreshCommand(c.env, input.sourceId, {
      commandId,
      externalId: stale.binding.externalId,
      expectedPublicId: stale.binding.publicId,
      expectedPriorRevision: stale.binding.revision,
      expectedRevision: stale.resource.revision,
      expectedProjectionSha256: stale.resource.projectionSha256,
      expectedAuthorizationGeneration: stale.authorizationGeneration,
    });
    const preflightReason = outcome.status === "blocked" && outcome.reason === "preflight"
      && outcome.preflight && outcome.preflight.status !== "verified" ? outcome.preflight.reason : undefined;
    const sanitized = outcome.status === "acknowledged"
      ? { status: "refreshed", revision: outcome.response.result.resource.revision, replayed: outcome.response.replayed }
      : { status: outcome.status, ...(preflightReason ? { reason: `preflight_${preflightReason}` }
        : "reason" in outcome ? { reason: outcome.reason } : {}) };
    await c.env.OPS_DB.batch([await auditStatement(
      c.env,
      c.req.raw,
      c.get("principal"),
      "integration.project_alpha_project_binding_revision_refresh_completed",
      "project_alpha_project_binding",
      commandId,
      null,
      sanitized,
    )]);
    return c.json({ outcome: sanitized });
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/v2/recover`, async c => {
    if (!projectV2RecoveryEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, projectV2RecoverySchema, "Project-v2 recovery");
    requireIdempotency(c.req.raw, input.authorizationId);
    const actor = await currentNativeProjectActor(c);
    const postAckInput = { authorizationId: input.authorizationId, commandId: input.commandId,
      sourceId: input.sourceId, expectedApplicationId: input.expectedApplicationId, reason: input.reason,
      expectedRecoveryEventVersion: input.expectedEventVersion };
    // A prior acknowledgement/settlement/activation for this exact recovery
    // request wins before the dispatcher is considered. This is both the
    // durable same-request replay path and the fence against a second PA POST.
    let postAck = await prepareProjectAlphaProjectV2PostAckResume(c.env, postAckInput, actor);
    if (postAck.status === "activated")
      return c.json({ stage: "activate",
        outcome: await auditProjectV2Recovery(c, input, "activate", postAck) });
    if (postAck.status !== "prepared" && !(postAck.status === "blocked" && postAck.reason === "stale"))
      return c.json({ stage: "authorize_settlement",
        outcome: await auditProjectV2Recovery(c, input, "authorize_settlement", postAck) });

    if (postAck.status !== "prepared") {
      const prepared = await prepareProjectAlphaProjectV2Recovery(c.env, input, actor);
      if (prepared.status !== "prepared")
        return c.json({ stage: "authorize", outcome: await auditProjectV2Recovery(c, input, "authorize", prepared) });

      const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(c.env, input.sourceId, input.commandId, fetch);
      if (dispatched.status !== "acknowledged")
        return c.json({ stage: "dispatch", outcome: await auditProjectV2Recovery(c, input, "dispatch", dispatched) });

      postAck = await prepareProjectAlphaProjectV2PostAckResume(c.env, postAckInput, actor);
      if (postAck.status === "activated")
        return c.json({ stage: "activate",
          outcome: await auditProjectV2Recovery(c, input, "activate", postAck) });
      if (postAck.status !== "prepared")
        return c.json({ stage: "authorize_settlement",
          outcome: await auditProjectV2Recovery(c, input, "authorize_settlement", postAck) });
    }

    let settlementId = postAck.settlementId;
    if (settlementId === null) {
      const settledSelection = await withEnabledConfiguredProjectAlphaApiV2Connection(c.env, input.sourceId,
        connection => settleProjectAlphaProjectV2Read(c.env, postAck.successReceiptId, connection, fetch));
      const settled = settledSelection.status === "enabled" ? settledSelection.value
        : { status: "blocked" as const, reason: "configuration" as const };
      if (settled.status !== "settled")
        return c.json({ stage: "settle", outcome: await auditProjectV2Recovery(c, input, "settle", settled) });
      settlementId = settled.settlementId;
    }

    const activated = await activateProjectAlphaProjectV2Canonical(c.env, settlementId);
    return c.json({ stage: "activate", outcome: await auditProjectV2Recovery(c, input, "activate", activated) });
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/v2/resume`, async c => {
    if (!projectV2RecoveryEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, projectV2PostAckSchema, "Project-v2 post-ack resume");
    requireIdempotency(c.req.raw, input.authorizationId);
    const actor = await currentNativeProjectActor(c);
    const prepared = await prepareProjectAlphaProjectV2PostAckResume(c.env, input, actor);
    if (prepared.status === "activated")
      return c.json({ stage: "activate",
        outcome: await auditProjectV2PostAck(c, input, "activate", prepared) });
    if (prepared.status !== "prepared")
      return c.json({ stage: "authorize_settlement",
        outcome: await auditProjectV2PostAck(c, input, "authorize_settlement", prepared) });

    let settlementId = prepared.settlementId;
    if (settlementId === null) {
      const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(c.env, input.sourceId,
        connection => settleProjectAlphaProjectV2Read(c.env, prepared.successReceiptId, connection, fetch));
      const settled = selected.status === "enabled" ? selected.value
        : { status: "blocked" as const, reason: "configuration" as const };
      if (settled.status !== "settled")
        return c.json({ stage: "settle", outcome: await auditProjectV2PostAck(c, input, "settle", settled) });
      settlementId = settled.settlementId;
    }

    const activated = await activateProjectAlphaProjectV2Canonical(c.env, settlementId);
    return c.json({ stage: "activate", outcome: await auditProjectV2PostAck(c, input, "activate", activated) });
  });

  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/bind`, async c => {
    const input = await json(c.req.raw, bindSchema, "Project adoption bind");
    requireIdempotency(c.req.raw, input.reservationId);
    await currentReviewer(c.env, c.get("principal"));
    return c.json(await planProjectAlphaProjectAdoptionBind(c.env,
      principalActor(c.get("principal")), input));
  });
  app.post(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/finalize`, async c => {
    if (c.env.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    const input = await json(c.req.raw, finalizeSchema, "Project adoption finalization");
    requireIdempotency(c.req.raw, input.commandId);
    const actor = await currentNativeProjectActor(c);
    const result = await finalizeProjectAlphaProjectAdoption(c.env, actor, input, fetch);
    const outcome = publicProjectV2RecoveryOutcome(result.outcome);
    await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"),
      "integration.project_alpha_project_adoption_finalization_completed", "project_alpha_project_adoption",
      input.commandId, null, { reservationId: input.reservationId, stage: result.stage,
        status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(typeof outcome.replayed === "boolean" ? { replayed: outcome.replayed } : {}) })]);
    return c.json({ stage: result.stage, outcome });
  });
  app.get(`${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}/projects/adoption/candidates`, async c => {
    if (!projectAdoptionReviewEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(key => key !== "sourceId" && key !== "cursor" && key !== "limit")
      || params.getAll("sourceId").length !== 1 || params.getAll("cursor").length > 1
      || params.getAll("limit").length > 1)
      throw new HTTPException(400, { message: "Project adoption candidate query is invalid" });
    const sourceId = params.get("sourceId") ?? "";
    const cursor = params.has("cursor") ? params.get("cursor") : undefined;
    const rawLimit = params.get("limit");
    if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(rawLimit))
      throw new HTTPException(400, { message: "Project adoption candidate query is invalid" });
    const outcome = await listAuthorizedProjectAlphaProjectAdoptionCandidates(c.env,
      principalActor(c.get("principal")), { sourceId, cursor, limit: rawLimit === null ? undefined : Number(rawLimit) }, fetch);
    return c.json({ outcome });
  });
}
