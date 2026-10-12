import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import {
  proposeProjectAlphaInboundProjectEdit,
  readProjectAlphaInboundProjectProposal,
  resolveProjectAlphaInboundProjectEdit,
} from "./project-alpha-project-inbound-reconciliation";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import type { Env, StaffPrincipal } from "./types";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const proposeSchema = z.object({ expectedContextVersion: z.string().regex(/^[0-9a-f]{64}$/u), idempotencyKey: uuid }).strict();
const resolveSchema = z.object({ expectedContextVersion: z.string().regex(/^[0-9a-f]{64}$/u), idempotencyKey: uuid,
  proposalId: uuid, decision: z.enum(["accept_project_alpha", "requires_follow_up"]) }).strict();

function enabled(env: Pick<Env, "PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED">): boolean {
  return env.PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED === "true";
}

async function actor(request: Request, env: Env, principal: StaffPrincipal) {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(request, env.OPS_DB, {
      enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
    });
  } catch {
    throw new HTTPException(403, { message: "Current native staff authority is required" });
  }
  const identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.verifiedAccessSubject !== principal.accessSubject
    || identity.email !== principal.email)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject };
}

function requireContext(env: Env, context: ClientHubCollectionContext, projectId: string, expectedContextVersion: string): void {
  if (!enabled(env)) throw new HTTPException(404, { message: "Project inbound review is not enabled" });
  if (context.root.root_namespace !== "business" || context.root.source_id !== context.canonicalRoot.sourceId
    || context.canonicalRoot.sourceId !== context.root.source_id || context.contextVersion !== expectedContextVersion
    || !projectId || projectId.length > 191 || /\p{C}/u.test(projectId))
    throw new HTTPException(409, { message: "Project context changed. Refresh the workspace to continue" });
}

function requireIdempotency(request: Request, expected: string): void {
  if (request.headers.get("Idempotency-Key") !== expected)
    throw new HTTPException(400, { message: "Idempotency-Key does not match the requested action" });
}

export async function proposeClientHubProjectInboundReview(env: Env, request: Request, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, value: unknown) {
  const input = proposeSchema.safeParse(value);
  if (!input.success) throw new HTTPException(400, { message: "Project inbound review request is invalid" });
  requireContext(env, context, projectId, input.data.expectedContextVersion);
  requireIdempotency(request, input.data.idempotencyKey);
  return proposeProjectAlphaInboundProjectEdit(env, await actor(request, env, principal), {
    idempotencyKey: input.data.idempotencyKey, sourceId: context.canonicalRoot.sourceId, externalProjectId: projectId,
  });
}

export async function readClientHubProjectInboundReview(env: Env, request: Request, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, proposalId: string, expectedContextVersion: string) {
  if (!uuid.safeParse(proposalId).success || !/^[0-9a-f]{64}$/u.test(expectedContextVersion))
    throw new HTTPException(400, { message: "Project inbound review query is invalid" });
  requireContext(env, context, projectId, expectedContextVersion);
  const outcome = await readProjectAlphaInboundProjectProposal(env, await actor(request, env, principal), proposalId);
  if (outcome.status === "available" && (outcome.proposal.sourceId !== context.canonicalRoot.sourceId
    || outcome.proposal.externalProjectId !== projectId))
    throw new HTTPException(404, { message: "Project inbound review is unavailable" });
  return outcome;
}

export async function resolveClientHubProjectInboundReview(env: Env, request: Request, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, value: unknown) {
  const input = resolveSchema.safeParse(value);
  if (!input.success) throw new HTTPException(400, { message: "Project inbound resolution request is invalid" });
  requireContext(env, context, projectId, input.data.expectedContextVersion);
  requireIdempotency(request, input.data.idempotencyKey);
  const review = await readProjectAlphaInboundProjectProposal(env, await actor(request, env, principal), input.data.proposalId);
  if (review.status !== "available" || review.proposal.sourceId !== context.canonicalRoot.sourceId
    || review.proposal.externalProjectId !== projectId)
    throw new HTTPException(409, { message: "Project inbound review changed. Refresh and compare again" });
  return resolveProjectAlphaInboundProjectEdit(env, await actor(request, env, principal), {
    idempotencyKey: input.data.idempotencyKey, proposalId: input.data.proposalId, decision: input.data.decision,
  });
}
