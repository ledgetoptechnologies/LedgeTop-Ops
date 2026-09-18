import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { auditStatement } from "./request-security";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { resolveProjectAlphaApiV2Connection, withEnabledConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from "./project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "./project-alpha-project-v2-pending-dispatcher";
import { settleProjectAlphaProjectV2Read } from "./project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "./project-alpha-project-canonical-activation-adapter";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const PROJECT_ALPHA_PROJECT_V2_ACCEPTANCE_ROUTE = "/api/admin/project-alpha/projects/v2/commands";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const applicationId = z.string().regex(UUID);
const commandId = z.string().regex(UUID);
const externalId = z.string().min(1).max(191);
const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const hash = z.string().regex(SHA256);
const publicId = z.string().regex(/^[0-9a-f]{32}$/);
const project = z.object({
  name: z.string(), description: z.string().nullable(), estimatedStart: z.string().nullable(), estimatedEnd: z.string().nullable(),
}).strict();
const relation = z.object({
  externalId, expectedPublicId: publicId, expectedRevision: decimal, expectedProjectionSha256: hash,
}).strict();
const scopes = z.array(z.discriminatedUnion("scopeKind", [
  z.object({ scopeKind: z.literal("business_area"), businessAreaId: z.string().min(1), divisionId: z.null() }).strict(),
  z.object({ scopeKind: z.literal("division"), businessAreaId: z.string().min(1), divisionId: z.string().min(1) }).strict(),
])).max(128);
const localExisting = z.object({ expectedLocalVersion: z.number().int().positive(), expectedLocalProjectionSha256: hash }).strict();
const sourceId = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);

const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    sourceId, expectedApplicationId: applicationId, operation: z.literal("create"), scopes,
    local: z.object({ expectedLocalVersion: z.literal(0), expectedLocalProjectionSha256: z.null() }).strict(),
    directory: z.object({ organizationRecordId: externalId, clientRecordId: externalId.nullable() }).strict(),
    command: z.object({
      commandId, externalId, expectedAuthorizationGeneration: decimal, project,
      organization: relation, client: relation.nullable(),
    }).strict(),
  }).strict(),
  z.object({
    sourceId, expectedApplicationId: applicationId, operation: z.literal("update"), scopes, local: localExisting,
    command: z.object({
      commandId, externalId, expectedRevision: decimal, expectedProjectionSha256: hash,
      expectedAuthorizationGeneration: decimal, project,
    }).strict(),
  }).strict(),
  z.object({
    sourceId, expectedApplicationId: applicationId, operation: z.literal("bind"), scopes, local: localExisting,
    command: z.object({
      commandId, externalId, expectedPublicId: publicId, expectedRevision: decimal,
      expectedProjectionSha256: hash, expectedAuthorizationGeneration: decimal,
    }).strict(),
  }).strict(),
]);

function publicOutcome(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "uncertain", reason: "invalid_outcome" };
  const outcome = value as Record<string, unknown>;
  const safe: Record<string, unknown> = { status: typeof outcome.status === "string" ? outcome.status : "uncertain" };
  for (const key of ["reason", "receiptId", "settlementId", "activationId", "commandId", "externalProjectId"])
    if (typeof outcome[key] === "string") safe[key] = outcome[key];
  if (typeof outcome.replayed === "boolean") safe.replayed = outcome.replayed;
  if (typeof outcome.version === "number" && Number.isSafeInteger(outcome.version)) safe.version = outcome.version;
  if (typeof outcome.httpStatus === "number" && Number.isInteger(outcome.httpStatus)) safe.httpStatus = outcome.httpStatus;
  return safe;
}

function requireEnabledSelection(env: Env, requestedSourceId: string, expectedApplicationId: string): void {
  let selected: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try { selected = resolveProjectAlphaApiV2Connection(env, requestedSourceId); }
  catch { throw new HTTPException(503, { message: "Project Alpha API v2 connection is unavailable" }); }
  if (selected.connection.expectedApplicationId !== expectedApplicationId)
    throw new HTTPException(409, { message: "Project Alpha API v2 application selection changed" });
  if (!selected.enabled)
    throw new HTTPException(409, { message: "Project Alpha API v2 connection is not enabled for acceptance" });
}

async function nativeActor(c: AppContext) {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
      onboardingAudience: c.env.NATIVE_STAFF_ONBOARDING_AUD ?? "",
    });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const principal = c.get("principal"), identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
    verifiedUntil: authenticated.verifiedUntil };
}

async function audit(c: AppContext, action: string, commandIdValue: string, requestedSourceId: string,
  expectedApplicationId: string, operation: string, stage: string, outcome?: Record<string, unknown>): Promise<void> {
  await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"), action,
    "project_alpha_project_v2_acceptance", commandIdValue, null,
    { sourceId: requestedSourceId, expectedApplicationId, operation, stage,
      ...(outcome ? { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(typeof outcome.replayed === "boolean" ? { replayed: outcome.replayed } : {}) } : {}) })]);
}

async function response(c: AppContext, input: z.infer<typeof requestSchema>, stage: string, raw: unknown) {
  const outcome = publicOutcome(raw);
  await audit(c, "integration.project_v2_acceptance_completed", input.command.commandId,
    input.sourceId, input.expectedApplicationId, input.operation, stage, outcome);
  return c.json({ sourceId: input.sourceId, expectedApplicationId: input.expectedApplicationId, stage, outcome });
}

/** One manually invoked, replayable joined-acceptance command. There is no UI,
 * GET route, scheduler, queue, service binding, or public/client route. */
export function registerProjectAlphaProjectV2AcceptanceRoutes(app: App): void {
  app.post(PROJECT_ALPHA_PROJECT_V2_ACCEPTANCE_ROUTE, async c => {
    if (c.env.PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
    const permission = await sqlScope(c.env, c.get("principal"), "integrations.manage");
    if (!permission.global || permission.deniedGlobal)
      throw new HTTPException(403, { message: "Global integrations.manage permission required" });
    c.header("Cache-Control", "no-store");

    const parsed = requestSchema.safeParse(await readBoundedJson(c.req.raw, 32 * 1024, "Project-v2 acceptance"));
    if (!parsed.success) throw new HTTPException(400, { message: "Project-v2 acceptance request is invalid" });
    const input = parsed.data;
    if (c.req.header("Idempotency-Key") !== input.command.commandId)
      throw new HTTPException(400, { message: "Idempotency-Key must match command.commandId" });
    requireEnabledSelection(c.env, input.sourceId, input.expectedApplicationId);
    const actor = await nativeActor(c);
    await audit(c, "integration.project_v2_acceptance_requested", input.command.commandId,
      input.sourceId, input.expectedApplicationId, input.operation, "requested");

    const { sourceId: requestedSourceId, expectedApplicationId: _expectedApplicationId, ...requested } = input;
    const planned = await planProjectAlphaProjectV2Command(c.env,
      { sourceId: requestedSourceId, actor: { ...actor, scopes: requested.scopes }, ...requested } as ProjectAlphaProjectV2CommandProducerAction);
    if (planned.status !== "queued") return response(c, input, "plan", planned);

    const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(c.env, requestedSourceId, input.command.commandId, fetch);
    if (dispatched.status !== "acknowledged") return response(c, input, "dispatch", dispatched);

    const settledSelection = await withEnabledConfiguredProjectAlphaApiV2Connection(c.env, requestedSourceId,
      connection => settleProjectAlphaProjectV2Read(c.env, dispatched.receiptId, connection, fetch));
    if (settledSelection.status !== "enabled")
      return response(c, input, "settle", { status: "blocked", reason: "configuration" });
    const settled = settledSelection.value;
    if (settled.status !== "settled") return response(c, input, "settle", settled);

    return response(c, input, "activate",
      await activateProjectAlphaProjectV2Canonical(c.env, settled.settlementId));
  });
}
