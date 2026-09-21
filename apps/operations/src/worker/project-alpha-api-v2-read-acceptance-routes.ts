import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { auditStatement } from "./request-security";
import { probeProjectAlphaApiV2, type ProjectAlphaApiV2Probe } from "./project-alpha-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import {
  PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT,
  readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities,
  type ProjectAlphaDirectoryInventoryOutcome,
} from "./project-alpha-directory-command-api-v2";
import {
  PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT,
  readProjectAlphaProjectInventoryAfterVerifiedCapabilities,
  type ProjectAlphaProjectInventoryOutcome,
} from "./project-alpha-project-inventory-api-v2";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;

/**
 * A deliberately small, operator-triggered production readiness check. It is
 * not a synchronization path: it accepts only a source selector and makes
 * capabilities plus inventory GET requests with the deployment-owned key.
 */
export const PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ROUTE =
  "/api/admin/integrations/project-alpha/api-v2/read-acceptance";

const sourceId = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const requestSchema = z.object({ sourceId }).strict();

export function projectAlphaApiV2ReadAcceptanceEnabled(
  env: Pick<Env, "PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED">,
): boolean {
  return env.PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED === "true";
}

function safeProbe(probe: ProjectAlphaApiV2Probe): Record<string, unknown> {
  if (probe.status === "verified") {
    return {
      status: probe.status,
      requestId: probe.requestId,
      sourceInstanceId: probe.sourceInstanceId,
      applicationId: probe.applicationId,
      historyEpoch: probe.historyEpoch,
      capabilityCount: probe.grantedCapabilities.length,
      exactIdentityMatch: true,
      exactContractMatch: true,
    };
  }
  return {
    status: probe.status,
    reason: probe.reason,
    ...(probe.httpStatus === undefined ? {} : { httpStatus: probe.httpStatus }),
    ...(probe.requestId === undefined ? {} : { requestId: probe.requestId }),
    exactIdentityMatch: false,
    exactContractMatch: false,
  };
}

function outcomeFailure(outcome: { status: string; reason?: string; httpStatus?: number }): Record<string, unknown> {
  return {
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
  };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function safeDirectory(outcome: ProjectAlphaDirectoryInventoryOutcome): Promise<Record<string, unknown>> {
  if (outcome.status !== "observed") return outcomeFailure(outcome);
  const inventory = outcome.inventory;
  return {
    status: "observed",
    requestId: inventory.requestId,
    authorizationGeneration: inventory.authorizationGeneration,
    count: inventory.resources.length,
    hasMore: inventory.nextCursor !== null,
    // Deliberately excludes public IDs, external IDs, and all profile fields.
    metadataSha256: await sha256(inventory.resources.map(resource => ({
      type: resource.type,
      revision: resource.revision,
      present: resource.present,
      lastAction: resource.lastAction,
      projectionSha256: resource.projectionSha256,
      binding: resource.binding === null ? null : {
        status: resource.binding.status,
        resourceRevision: resource.binding.resourceRevision,
      },
    }))),
  };
}

async function safeProject(outcome: ProjectAlphaProjectInventoryOutcome): Promise<Record<string, unknown>> {
  if (outcome.status === "binding_stale") {
    return {
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      requestId: outcome.response.requestId,
    };
  }
  if (outcome.status !== "observed") return outcomeFailure(outcome);
  const inventory = outcome.response;
  return {
    status: "observed",
    requestId: inventory.requestId,
    authorizationGeneration: inventory.authorizationGeneration,
    count: inventory.projects.length,
    hasMore: inventory.nextCursor !== null,
    // Deliberately excludes external IDs and PA public IDs.
    metadataSha256: await sha256(inventory.projects.map(project => ({
      revision: project.revision,
      projectionSha256: project.projectionSha256,
      status: project.status,
      archived: project.archived,
    }))),
  };
}

function acceptanceSummary(
  sourceIdValue: string,
  capabilities: Record<string, unknown>,
  directory: Record<string, unknown>,
  projects: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sourceId: sourceIdValue,
    readOnly: true,
    capabilities,
    directory,
    projects,
  };
}

/** Mounted after Operations' authenticated /api mutation middleware. That
 * middleware supplies same-origin and CSRF protection before this route runs. */
export function registerProjectAlphaApiV2ReadAcceptanceRoutes(app: App): void {
  app.post(PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ROUTE, async c => {
    if (!projectAlphaApiV2ReadAcceptanceEnabled(c.env))
      throw new HTTPException(404, { message: "Not found" });
    if (!c.get("administrator"))
      throw new HTTPException(403, { message: "Administrator access required" });
    const permission = await sqlScope(c.env, c.get("principal"), "integrations.manage");
    if (!permission.global || permission.deniedGlobal)
      throw new HTTPException(403, { message: "Global integrations.manage permission required" });

    const parsed = requestSchema.safeParse(await readBoundedJson(c.req.raw, 1_024,
      "Project Alpha API v2 read acceptance"));
    if (!parsed.success)
      throw new HTTPException(400, { message: "Project Alpha API v2 read acceptance request is invalid" });
    const requestedSourceId = parsed.data.sourceId;
    c.header("Cache-Control", "no-store");

    const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(c.env, requestedSourceId,
      async connection => {
        const probe = await probeProjectAlphaApiV2(connection, [], fetch, [
          PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT,
          PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT,
        ]);
        if (probe.status !== "verified") {
          const unavailable = { status: "not_attempted", reason: "capabilities" };
          return acceptanceSummary(requestedSourceId, safeProbe(probe), unavailable, unavailable);
        }
        const directory = await readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities(connection, requestedSourceId,
          { type: "all", limit: 200 }, fetch);
        const projects = await readProjectAlphaProjectInventoryAfterVerifiedCapabilities(connection, { limit: 200 }, fetch);
        return acceptanceSummary(requestedSourceId, safeProbe(probe), await safeDirectory(directory),
          await safeProject(projects));
      });
    const result = selected.status === "enabled" ? selected.value : acceptanceSummary(requestedSourceId,
      { status: selected.status, exactIdentityMatch: false, exactContractMatch: false },
      { status: "not_attempted", reason: "connection" },
      { status: "not_attempted", reason: "connection" });

    // This intentionally writes only a safe local audit event. It contains no
    // PA bearer value, URL, record identifier, profile field, or raw response.
    await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"),
      "integration.project_alpha_api_v2_read_acceptance_completed",
      "project_alpha_api_v2_read_acceptance", requestedSourceId, null, result)]);
    return c.json(result);
  });
}
