import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  reserveProjectAlphaDirectoryReadAdoption,
  type ProjectAlphaDirectoryReadAdoptionActor,
} from "./project-alpha-directory-read-adoption";
import {
  compareProjectAlphaDirectoryReadAdoptionFields,
  sealProjectAlphaDirectoryReadAdoptionFieldReview,
} from "./project-alpha-directory-read-adoption-field-review";
import { auditStatement } from "./request-security";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_ROUTE =
  "/api/admin/integrations/project-alpha/api-v2/directory/read-adoptions";
export const PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_COMPARE_ROUTE =
  `${PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_ROUTE}/:reviewId/field-comparison`;
export const PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_FIELD_REVIEW_ROUTE =
  `${PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_ROUTE}/:reviewId/field-review`;

const requestSchema = z.object({
  sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  resourceType: z.enum(["client", "organization"]),
  recordId: z.string().min(1).max(191).refine(value => !/\p{C}/u.test(value)),
  expectedLocalRecordVersion: z.number().int().min(1),
  projectAlphaPublicId: z.string().regex(/^[0-9a-f]{32}$/),
}).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fieldDecision = z.enum(["unchanged", "retain_local", "adopt_project_alpha", "requires_follow_up"]);
const commonDecisions = {
  name: fieldDecision, email: fieldDecision, phone: fieldDecision, address_line1: fieldDecision,
  address_line2: fieldDecision, city: fieldDecision, state: fieldDecision, postal_code: fieldDecision, country: fieldDecision,
};
const fieldReviewSchema = z.union([
  z.object({ decisions: z.object(commonDecisions).strict() }).strict(),
  z.object({ decisions: z.object({ ...commonDecisions, client_type: fieldDecision, organization_public_id: fieldDecision }).strict() }).strict(),
]);
const comparisonSchema = z.object({}).strict();

export function projectAlphaDirectoryReadAdoptionEnabled(
  env: Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED">,
): boolean {
  return env.ENVIRONMENT === "staging"
    && env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED === "true";
}

async function nativeActor(c: AppContext): Promise<ProjectAlphaDirectoryReadAdoptionActor> {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true,
      issuer: c.env.TEAM_DOMAIN ?? "",
      staffAudience: c.env.OPERATIONS_AUD,
    });
  } catch {
    throw new HTTPException(403, { message: "Current native staff authority is required" });
  }
  const principal = c.get("principal");
  const identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject) {
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  }
  return Object.freeze({
    staffId: identity.staffId,
    accessSubject: identity.verifiedAccessSubject,
    admissionVersion: authenticated.admissionVersion,
    profileVersion: identity.profileVersion,
  });
}

async function requireReviewAdministrator(c: AppContext): Promise<ProjectAlphaDirectoryReadAdoptionActor> {
  if (!projectAlphaDirectoryReadAdoptionEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
  c.header("Cache-Control", "no-store");
  if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
  const permission = await sqlScope(c.env, c.get("principal"), "integrations.manage");
  if (!permission.global || permission.deniedGlobal)
    throw new HTTPException(403, { message: "Global integrations.manage permission required" });
  return nativeActor(c);
}

/** Mounted after Operations' authenticated mutation middleware, which supplies
 * same-origin and CSRF enforcement. This route adds staging, administrator,
 * global integrations.manage, and current native-identity gates. */
export function registerProjectAlphaDirectoryReadAdoptionRoutes(app: App): void {
  app.post(PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_COMPARE_ROUTE, async c => {
    const actor = await requireReviewAdministrator(c);
    const reviewId = c.req.param("reviewId");
    if (!UUID.test(reviewId)) throw new HTTPException(400, { message: "Review ID is invalid" });
    const parsed = comparisonSchema.safeParse(await readBoundedJson(c.req.raw, 128, "Project Alpha Directory field comparison"));
    if (!parsed.success) throw new HTTPException(400, { message: "Directory field-comparison request is invalid" });
    return c.json({ outcome: await compareProjectAlphaDirectoryReadAdoptionFields(c.env, reviewId, actor) });
  });

  app.post(PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_FIELD_REVIEW_ROUTE, async c => {
    const actor = await requireReviewAdministrator(c);
    const reviewId = c.req.param("reviewId");
    if (!UUID.test(reviewId)) throw new HTTPException(400, { message: "Review ID is invalid" });
    const parsed = fieldReviewSchema.safeParse(await readBoundedJson(c.req.raw, 2_048, "Project Alpha Directory field review"));
    if (!parsed.success) throw new HTTPException(400, { message: "Directory field-review request is invalid" });
    const outcome = await sealProjectAlphaDirectoryReadAdoptionFieldReview(c.env, { reviewId, decisions: parsed.data.decisions, actor });
    await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,c.get("principal"),
      "integration.project_alpha_directory_read_adoption_field_review_completed","project_alpha_directory_read_adoption_field_review",
      reviewId,null,{status:outcome.status,...("reason" in outcome?{reason:outcome.reason}:{})})]);
    return c.json({ outcome });
  });

  app.post(PROJECT_ALPHA_DIRECTORY_READ_ADOPTION_ROUTE, async c => {
    const actor = await requireReviewAdministrator(c);

    const parsed = requestSchema.safeParse(await readBoundedJson(
      c.req.raw,
      2_048,
      "Project Alpha exact Directory read adoption",
    ));
    if (!parsed.success)
      throw new HTTPException(400, { message: "Directory read-adoption request is invalid" });
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey || !UUID.test(idempotencyKey))
      throw new HTTPException(400, { message: "A UUID Idempotency-Key is required" });

    const outcome = await reserveProjectAlphaDirectoryReadAdoption(c.env, {
      ...parsed.data,
      idempotencyKey,
      actor,
    });
    await c.env.OPS_DB.batch([await auditStatement(
      c.env,
      c.req.raw,
      c.get("principal"),
      "integration.project_alpha_directory_read_adoption_completed",
      "project_alpha_directory_read_adoption",
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
}
