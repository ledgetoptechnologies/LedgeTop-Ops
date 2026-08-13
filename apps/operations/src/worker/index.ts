import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  buildServiceRequestNotificationSnapshot,
  isMovedSourceMarker,
  type Permission,
  type ServiceRequestNotificationLifecycle,
  type ServiceRequestNotificationSnapshot,
} from "@ltds/shared";
import { authenticateStaff } from "./auth";
import {
  airspaceView,
  markAirspaceStaleAndPurge,
  rebuildOperationAirspaceMatches,
  refreshSua,
  refreshTfrs,
} from "./airspace";
import {
  hasLocalGlobalAllow,
  isAdministrator,
  permissionKeys,
  requirePermission,
  sqlScope,
} from "./acl";
import {
  consumeFileEvents,
  reconcileFileIndex,
  refreshStreamStatuses,
  type R2Notification,
} from "./file-events";
import { consumeThumbnailDeadLetters, consumeThumbnailJobs, drainThumbnailCleanup, getThumbnailForAuthorizedSource, reconcileManagedThumbnailOrphans, reconcileThumbnailRegistrations, recoverExpiredThumbnailLeases, recoverTransientThumbnailFailures, thumbnailSourceEligible, type ThumbnailJobMessage } from "./image-thumbnails";
import { processThumbnailBackfills } from "./thumbnail-backfill";
import { enqueueImageLocationBackfill } from "./image-locations";
import { listDeliveryFolderLocations, resolveDeliveryLocationAsset } from "./delivery-locations";
import { dispatchThumbnailIngestRequest } from "./thumbnail-ingest-api";
import { dispatchThumbnailRendererApi } from "./thumbnail-renderer-api";
import {
  authorizeItem,
  createDeliveryShare,
  decodeRef,
  deliveryBrowseRevision,
  encodeRef,
  getActiveDeliveryShare,
  listDeliveryFolder,
  searchDeliveryItems,
  listDeliveryShares,
  mediaKind,
  revokeDeliveryShare,
  thumbnailQueueSummary,
} from "./delivery";
import { syncProjectAlpha } from "./project-alpha";
import { projectAlphaHealthIsStale } from "./integration-health";
import {
  auditStatement,
  csrfToken,
  requireMutationSecurity,
} from "./request-security";
import type { Env, StaffPrincipal } from "./types";
import {
  employeePermissions,
  paCalendarFilter,
  paProjectFilter,
  paResourceFilter,
} from "./visibility";
import { deleteAlias, resolveAliasKey, upsertAlias } from "./aliases";
import { executeSourceDelete, previewSourceDelete } from "./source-delete";
import { runRetention } from "./retention";
import {
  listTrash,
  purgeTrash,
  r2PurgeEnabled,
  restoreTombstone,
} from "./trash";
import {
  cleanupBrowserUploadSessions,
  expireBrowserUploadSessions,
  processR2OperationJobs,
  purgeReplacementRecovery,
  registerR2CrudRoutes,
} from "./r2-crud";
import { requiresAdministratorForMutation } from "./r2-crud-validation";
import {
  enqueueExpiringNotifications,
  processClientPortalRequestNotifications,
  processDeliveryNotifications,
} from "./notifications";
import {
  createIncomingStaffRouter,
  dispatchIncomingPublicRequest,
} from "./incoming";
import { incomingUploadsCapability } from "./incoming-policy";
import { servePdfSourceFile, serveSourceFile } from "./source-file";
import { directDeliveryUploadsCapability } from "./direct-upload-policy";
import { isFrameableOperationsPdfRequest } from "./frame-policy";
import {
  dropboxImportCapability,
  registerDropboxImportRoutes,
} from "./dropbox-import-routes";
import { cleanupDropboxImports } from "./dropbox-import";
import {
  effectiveStaffAccessControls,
  STAFF_ACCESS_CONTROLS,
  staffAccessControlEffect,
  type StaffAccessControl,
} from "./staff-access-controls";
import {
  createClientFolderGrant,
  findClientFolderGrantTargets,
  processClientFolderChangeNotifications,
  processClientFolderGrantNotifications,
  revokeClientFolderGrant,
} from "./client-folder-grants";
import { registerJobBriefRoutes } from "./job-brief";
import { registerSopRoutes } from "./sop";

type Variables = { principal: StaffPrincipal; administrator: boolean };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type RequestNotificationDb = {
  prepare(query: string): D1PreparedStatement;
};

async function requestNotificationSnapshot(
  db: RequestNotificationDb,
  requestId: string,
  lifecycle: ServiceRequestNotificationLifecycle,
  action: ServiceRequestNotificationSnapshot["action"],
): Promise<ServiceRequestNotificationSnapshot> {
  const row = await db
    .prepare(
      `SELECT r.title,r.project_id,r.service_category,r.location_text,r.latitude,r.longitude,p.project_name
       FROM client_service_requests r
       LEFT JOIN projects p ON p.id=r.project_id
       WHERE r.id=?`,
    )
    .bind(requestId)
    .first<{
      title: string;
      project_id: string | null;
      service_category: string | null;
      location_text: string | null;
      latitude: number | null;
      longitude: number | null;
      project_name: string | null;
    }>();
  if (!row) throw new HTTPException(404, { message: "Client request not found" });
  return buildServiceRequestNotificationSnapshot({
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    serviceCategory: row.service_category,
    locationLabel: row.location_text,
    latitude: row.latitude,
    longitude: row.longitude,
    lifecycle,
    action,
  });
}

const lockedSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    imgSrc: [
      "'self'",
      "https://ledgetopdroneservices.com",
      "https://*.mapbox.com",
      "data:",
      "blob:",
    ],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"],
    connectSrc: [
      "'self'",
      "https://*.r2.cloudflarestorage.com",
      "https://api.mapbox.com",
      "https://events.mapbox.com",
    ],
    workerSrc: ["blob:"],
    mediaSrc: ["'self'", "blob:"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    objectSrc: ["'none'"],
    formAction: ["'self'"],
  },
  referrerPolicy: "no-referrer",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "DENY",
  xXssProtection: false,
});
const frameablePdfSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", "https://ledgetopdroneservices.com", "data:"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"],
    connectSrc: ["'self'", "https://*.r2.cloudflarestorage.com"],
    mediaSrc: ["'self'", "blob:"],
    frameAncestors: ["'self'"],
    baseUri: ["'none'"],
    objectSrc: ["'none'"],
    formAction: ["'self'"],
  },
  referrerPolicy: "no-referrer",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "SAMEORIGIN",
  xXssProtection: false,
});
app.use("*", (c, next) =>
  isFrameableOperationsPdfRequest(c.req.method, c.req.path)
    ? frameablePdfSecurityHeaders(c, next)
    : lockedSecurityHeaders(c, next),
);
app.use("*", async (c, next) => {
  if (
    c.env.ENVIRONMENT === "production" &&
    new URL(c.req.url).host !== c.env.EXPECTED_HOST
  )
    return c.json({ error: "Not found" }, 404);
  await next();
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/")) {
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    if (!c.res.headers.has("Cache-Control"))
      c.header("Cache-Control", "no-store");
  }
});
app.use("/api/*", async (c, next) => {
  const principal = await authenticateStaff(c.req.raw, c.env),
    administrator = await isAdministrator(c.env, principal);
  c.set("principal", principal);
  c.set("administrator", administrator);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    if (
      requiresAdministratorForMutation(c.req.method, c.req.path) &&
      !administrator
    )
      throw new HTTPException(403, {
        message: "Administrator access required for this change",
      });
    await requireMutationSecurity(c.req.raw, c.env, principal);
  }
  await next();
});
app.use("/api/admin/*", async (c, next) => {
  if (!c.get("administrator"))
    throw new HTTPException(403, { message: "Administrator access required" });
  await next();
});

async function body<T>(c: any, schema: z.ZodType<T>): Promise<T> {
  const value = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
  return parsed.data;
}
async function requireGlobal(
  env: Env,
  principal: StaffPrincipal,
  permission: Permission,
) {
  const scope = await sqlScope(env, principal, permission);
  if (!scope.global || scope.deniedGlobal)
    throw new HTTPException(403, {
      message: `Global ${permission} permission required`,
    });
}
function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

const staffAccessSchema = z
  .object(
    Object.fromEntries(
      Object.keys(STAFF_ACCESS_CONTROLS).map((key) => [key, z.boolean()]),
    ) as Record<StaffAccessControl, z.ZodBoolean>,
  )
  .strict();
const clientRequestTriageSchema = z
  .object({
    status: z.enum([
      "under_review",
      "accepted_pending_pa_linkage",
      "declined",
      "completed",
    ]),
  })
  .strict();
const portalAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    projectAlphaClientId: z.string().trim().min(1).max(128),
    projectAlphaOrganizationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .nullable()
      .optional(),
    identity: z
      .object({
        issuer: z.string().url().max(512),
        subject: z.string().trim().min(1).max(512),
        email: z.string().email().max(320),
        role: z.enum(["manager", "member"]).default("manager"),
        canViewBilling: z.boolean().default(false),
      })
      .optional(),
  })
  .strict();
const portalProjectLinkSchema = z
  .object({
    accountId: z.string().min(1).max(128),
    projectAlphaProjectId: z.string().min(1).max(128),
    canRequestService: z.boolean().default(true),
  })
  .strict();
const folderAssociationSchema = z
  .object({
    divisionId: z.string().min(1),
    r2Prefix: z.string().min(1).max(1000),
    accountId: z.string().min(1).max(128).optional(),
  })
  .strict();
const clientFolderGrantSchema = z
  .object({
    divisionId: z.string().trim().min(1).max(128),
    r2Prefix: z.string().trim().min(1).max(1000),
    grantId: z.string().trim().min(1).max(128).optional(),
    recipientIdentityId: z.string().trim().min(1).max(128).nullable().optional(),
    recipientIdentityIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    notificationMode: z.enum(["off", "added", "removed", "both"]).optional(),
  })
  .strict();
const paQuoteLinkSchema = z
  .object({ artifactId: z.coerce.number().int().positive() })
  .strict();
const operationalEstimateSchema = z
  .object({
    version: z.number().int().positive().optional(),
    scope: z.string().trim().min(1).max(5000),
    amount: z
      .number()
      .finite()
      .nonnegative()
      .max(100000000)
      .nullable()
      .optional(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    proposedFields: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.enum(["draft", "ready"]),
  })
  .strict();
const workflowIdempotencyKey = z.string().trim().min(16).max(128);
const paVerifiedArtifactSchema = z
  .object({
    artifact: z
      .object({
        id: z.number().int().positive(),
        type: z.literal("quote"),
        client_id: z.number().int().positive(),
        project_id: z.number().int().positive().nullable(),
        status: z.string().min(1).max(80),
        document_number: z.string().max(120).nullable(),
        total: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
        currency: z.string().length(3),
        updated_at: z.string().nullable(),
      })
      .strict(),
    request_id: z.string(),
  })
  .strict();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function verifyProjectAlphaQuote(
  env: Env,
  input: { artifactId: number; clientId: string; projectId: string | null },
) {
  if (!env.PROJECT_ALPHA_BASE_URL || !env.PROJECT_ALPHA_API_KEY)
    throw new HTTPException(503, {
      message: "Project Alpha artifact verification is not configured",
    });
  const base = new URL(env.PROJECT_ALPHA_BASE_URL),
    local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(local && base.protocol === "http:")) ||
    base.username ||
    base.password
  )
    throw new HTTPException(503, {
      message: "Project Alpha artifact verification is not configured",
    });
  const url = new URL("/api/v1/ops/artifacts/verify", base);
  url.searchParams.set("type", "quote");
  url.searchParams.set("id", String(input.artifactId));
  url.searchParams.set("client_id", input.clientId);
  if (input.projectId) url.searchParams.set("project_id", input.projectId);
  const response = await globalThis.fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.PROJECT_ALPHA_API_KEY}`,
      Accept: "application/json",
    },
  });
  if (response.status === 404)
    throw new HTTPException(404, {
      message:
        "The Project Alpha quote was not found for this client and project",
    });
  if (!response.ok)
    throw new HTTPException(502, {
      message: "Project Alpha could not verify this quote",
    });
  const parsed = paVerifiedArtifactSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new HTTPException(502, {
      message: "Project Alpha returned an invalid artifact response",
    });
  const artifact = parsed.data.artifact;
  if (
    String(artifact.client_id) !== input.clientId ||
    (input.projectId !== null &&
      String(artifact.project_id) !== input.projectId)
  )
    throw new HTTPException(404, {
      message:
        "The Project Alpha quote was not found for this client and project",
    });
  if (artifact.status.trim().toLowerCase() !== "approved")
    throw new HTTPException(409, {
      message: "The Project Alpha quote is not approved",
    });
  return artifact;
}

app.get("/health", (c) => c.json({ status: "ok", service: "ltds-ops" }));
app.get("/api/session", async (c) => {
  const principal = c.get("principal"),
    administrator = c.get("administrator");
  const [permissions, globalScope, deliveryBrowseScope] = await Promise.all([
    permissionKeys(c.env, principal),
    sqlScope(c.env, principal, "dashboard.view"),
    sqlScope(c.env, principal, "delivery.browse"),
  ]);
  const divisions =
    administrator && globalScope.global
      ? await c.env.OPS_DB.prepare(
          "SELECT id,name,code FROM divisions WHERE active=1 ORDER BY name",
        ).all()
      : await c.env.OPS_DB.prepare(
          "SELECT d.id,d.name,d.code FROM divisions d JOIN staff_divisions sd ON sd.division_id=d.id WHERE sd.staff_id=? AND d.active=1 ORDER BY sd.is_primary DESC,d.name",
        )
          .bind(principal.id)
          .all();
  return c.json({
    user: {
      id: principal.id,
      email: principal.email,
      displayName: principal.displayName,
      status: "Active",
      profileType: administrator ? "Administrator" : "Employee",
      isAdministrator: administrator,
      permissions: employeePermissions(permissions, administrator),
      divisions: divisions.results,
    },
    csrfToken: await csrfToken(c.env, principal),
    timezone: c.env.DISPLAY_TIMEZONE,
    mapStyleUrl: c.env.MAP_STYLE_URL || null,
    mapboxPublicToken: c.env.MAPBOX_PUBLIC_TOKEN || null,
    capabilities: {
      dropboxImport: dropboxImportCapability(c.env),
      incomingUploads: incomingUploadsCapability(c.env),
      directDeliveryUploads: directDeliveryUploadsCapability(c.env),
      deliveryJobsRoot: {
        enabled: !deliveryBrowseScope.deniedGlobal && deliveryBrowseScope.global && deliveryBrowseScope.deniedDivisions.length === 0,
      },
    },
  });
});

async function visibilityScope(
  env: Env,
  principal: StaffPrincipal,
  administrator: boolean,
  permission: Permission,
) {
  const scope = await sqlScope(env, principal, permission);
  return administrator ? scope : { ...scope, divisions: [] };
}
async function hasExplicitAllOperations(
  env: Env,
  principal: StaffPrincipal,
  administrator: boolean,
) {
  return (
    administrator ||
    (await hasLocalGlobalAllow(env, principal, "operations.view_all"))
  );
}
async function paScopeWhere(
  env: Env,
  principal: StaffPrincipal,
  administrator: boolean,
  permission: Permission,
  alias: string,
  kind: "operation" | "task",
) {
  const [scope, allOperations] = await Promise.all([
    visibilityScope(env, principal, administrator, permission),
    hasExplicitAllOperations(env, principal, administrator),
  ]);
  return paResourceFilter(
    scope,
    principal,
    administrator,
    alias,
    kind,
    allOperations,
  );
}
function managedInProjectAlpha(): never {
  throw new HTTPException(405, { message: "Managed in Project Alpha" });
}

app.get("/api/dashboard", async (c) => {
  const principal = c.get("principal"),
    administrator = c.get("administrator");
  await requirePermission(c.env, principal, "dashboard.view");
  const op = await paScopeWhere(
      c.env,
      principal,
      administrator,
      "operations.view",
      "o",
      "operation",
    ),
    task = await paScopeWhere(
      c.env,
      principal,
      administrator,
      "tasks.view",
      "t",
      "task",
    );
  const [operations, tasks, airspace, sync, shares] = await Promise.all([
    c.env.OPS_DB.prepare(
      `SELECT o.id,o.title,o.status,o.scheduled_start_at scheduled_start,o.business_unit_id,d.name division_name FROM pa_operations o LEFT JOIN divisions d ON d.project_alpha_business_unit_id=o.business_unit_id WHERE ${op.sql} AND o.status NOT IN ('completed','cancelled') ORDER BY o.scheduled_start_at LIMIT 8`,
    )
      .bind(...op.values)
      .all(),
    c.env.OPS_DB.prepare(
      `SELECT t.id,t.title,t.status,t.due_at,t.business_unit_id FROM pa_tasks t WHERE ${task.sql} AND t.status NOT IN ('completed','cancelled') ORDER BY t.due_at LIMIT 8`,
    )
      .bind(...task.values)
      .all(),
    airspaceView(c.env, op),
    c.env.OPS_DB.prepare(
      `SELECT integration,status,last_success_at,last_error_code,updated_at FROM integration_health ${administrator ? "" : "WHERE integration='project-alpha'"} ORDER BY integration`,
    ).all(),
    administrator
      ? listDeliveryShares(c.env, principal).catch(() => [])
      : Promise.resolve([]),
  ]);
  const now = Date.now();
  const integrations = sync.results.map((row: any) => ({
    ...row,
    stale: projectAlphaHealthIsStale(row, now),
  }));
  return c.json({
    operations: operations.results,
    tasks: tasks.results,
    airspace: {
      sources: airspace.sources,
      activeTfrs: airspace.tfrs.filter((row: any) => row.status === "active")
        .length,
      scheduledTfrs: airspace.tfrs.filter(
        (row: any) => row.status === "scheduled",
      ).length,
      activeSua: airspace.sua.filter((row: any) => row.status === "active")
        .length,
    },
    integrations,
    recentShares: shares.slice(0, 6),
  });
});

app.get("/api/projects", async (c) => {
  const principal = c.get("principal"),
    administrator = c.get("administrator");
  await requirePermission(c.env, principal, "projects.view");
  const [scope, allOperations] = await Promise.all([
    visibilityScope(c.env, principal, administrator, "projects.view"),
    hasExplicitAllOperations(c.env, principal, administrator),
  ]);
  const access = paProjectFilter(
    scope,
    principal,
    administrator,
    allOperations,
  );
  const search = (c.req.query("search") || "").trim();
  let sql = `SELECT p.id,p.name,p.status,p.start_date,p.end_date,p.client_id,p.organization_id,p.manager_user_id,pm.display_name manager_name,COALESCE(c.name,o.name,'Unassigned') customer_name,CASE WHEN ?=1 THEN pf.r2_prefix ELSE NULL END r2_prefix,CASE WHEN ?=1 THEN pf.division_id ELSE NULL END division_id FROM pa_projects p LEFT JOIN pa_clients c ON c.id=p.client_id LEFT JOIN pa_organizations o ON o.id=p.organization_id LEFT JOIN pa_users pm ON pm.id=p.manager_user_id LEFT JOIN project_folders pf ON pf.project_id=p.id WHERE ${access.sql}`;
  const values: unknown[] = [
    administrator ? 1 : 0,
    administrator ? 1 : 0,
    ...access.values,
  ];
  if (search) {
    sql +=
      " AND (p.name LIKE ? OR c.name LIKE ? OR o.name LIKE ? OR pm.display_name LIKE ?)";
    values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += " ORDER BY COALESCE(p.start_date,p.updated_at) DESC LIMIT 200";
  return c.json({
    projects: (
      await c.env.OPS_DB.prepare(sql)
        .bind(...values)
        .all()
    ).results,
  });
});
app.get("/api/projects/:id", async (c) => {
  const principal = c.get("principal"),
    administrator = c.get("administrator");
  await requirePermission(c.env, principal, "projects.view");
  const [scope, allOperations] = await Promise.all([
    visibilityScope(c.env, principal, administrator, "projects.view"),
    hasExplicitAllOperations(c.env, principal, administrator),
  ]);
  const access = paProjectFilter(
    scope,
    principal,
    administrator,
    allOperations,
  );
  const project = await c.env.OPS_DB.prepare(
    `SELECT p.*,pm.display_name manager_name,COALESCE(c.name,o.name,'Unassigned') customer_name,CASE WHEN ?=1 THEN pf.r2_prefix ELSE NULL END r2_prefix,CASE WHEN ?=1 THEN pf.division_id ELSE NULL END division_id FROM pa_projects p LEFT JOIN pa_clients c ON c.id=p.client_id LEFT JOIN pa_organizations o ON o.id=p.organization_id LEFT JOIN pa_users pm ON pm.id=p.manager_user_id LEFT JOIN project_folders pf ON pf.project_id=p.id WHERE p.id=? AND ${access.sql}`,
  )
    .bind(
      administrator ? 1 : 0,
      administrator ? 1 : 0,
      c.req.param("id"),
      ...access.values,
    )
    .first();
  if (!project) throw new HTTPException(404, { message: "Project not found" });
  return c.json({ project });
});
app.get("/api/client-portal/accounts", async (c) => {
  await requireGlobal(c.env, c.get("principal"), "operations.manage");
  const rows = await c.env.DELIVERY_DB.withSession("first-primary")
    .prepare(
      `SELECT a.id,a.display_name,a.status,a.project_alpha_client_id,a.project_alpha_organization_id,COUNT(DISTINCT g.project_id) project_count FROM client_accounts a LEFT JOIN client_project_grants g ON g.account_id=a.id AND g.revoked_at IS NULL GROUP BY a.id ORDER BY a.display_name`,
    )
    .all();
  return c.json({ accounts: rows.results });
});
app.get("/api/client-portal/source-accounts", async (c) => {
  await requireGlobal(c.env, c.get("principal"), "operations.manage");
  const [clients, organizations] = await Promise.all([
    c.env.OPS_DB.prepare(
      "SELECT id,name,organization_id FROM pa_clients WHERE active=1 ORDER BY name",
    ).all(),
    c.env.OPS_DB.prepare(
      "SELECT id,name FROM pa_organizations WHERE active=1 ORDER BY name",
    ).all(),
  ]);
  return c.json({
    clients: clients.results,
    organizations: organizations.results,
  });
});
app.post("/api/client-portal/accounts", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const value = await body(c, portalAccountSchema);
  const projectAlphaClient = await c.env.OPS_DB.prepare(
    "SELECT id,organization_id FROM pa_clients WHERE id=? AND active=1",
  )
    .bind(value.projectAlphaClientId)
    .first<{ id: string; organization_id: string | null }>();
  if (!projectAlphaClient)
    throw new HTTPException(404, { message: "Project Alpha client not found" });
  if (
    value.projectAlphaOrganizationId &&
    !(await c.env.OPS_DB.prepare(
      "SELECT 1 ok FROM pa_organizations WHERE id=? AND active=1",
    )
      .bind(value.projectAlphaOrganizationId)
      .first())
  )
    throw new HTTPException(404, {
      message: "Project Alpha organization not found",
    });
  if (
    value.projectAlphaOrganizationId &&
    projectAlphaClient.organization_id !== value.projectAlphaOrganizationId
  )
    throw new HTTPException(409, {
      message: "The Project Alpha client does not belong to that organization",
    });
  const db = c.env.DELIVERY_DB.withSession("first-primary"),
    accountId = crypto.randomUUID(),
    identityId = crypto.randomUUID(),
    statements = [
      db
        .prepare(
          "INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_organization_id) VALUES (?,?,'active',?,?)",
        )
        .bind(
          accountId,
          value.displayName,
          value.projectAlphaClientId || null,
          value.projectAlphaOrganizationId || null,
        ),
      db
        .prepare(
          "INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,'client.account.provisioned','client_account',?,?)",
        )
        .bind(
          principal.id,
          accountId,
          JSON.stringify({
            projectAlphaClientId: value.projectAlphaClientId || null,
            projectAlphaOrganizationId:
              value.projectAlphaOrganizationId || null,
          }),
        ),
    ];
  if (value.identity) {
    statements.splice(
      1,
      0,
      db
        .prepare(
          "INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES (?,?,?,?,?)",
        )
        .bind(
          identityId,
          accountId,
          value.identity.issuer,
          value.identity.subject,
          value.identity.email.toLowerCase(),
        ),
      db
        .prepare(
          "INSERT INTO client_account_members(account_id,identity_id,role,can_view_billing) VALUES (?,?,?,?)",
        )
        .bind(
          accountId,
          identityId,
          value.identity.role,
          value.identity.canViewBilling ? 1 : 0,
        ),
    );
  }
  await db.batch(statements);
  return c.json({ id: accountId, status: "active" }, 201);
});
app.post("/api/client-portal/accounts/:accountId/folder-grants", async (c) => {
  const value = await body(c, clientFolderGrantSchema);
  const grant = await createClientFolderGrant(
    c.env,
    c.req.raw,
    c.get("principal"),
    { ...value, accountId: c.req.param("accountId") },
    c.req.header("Idempotency-Key") || "",
  );
  return c.json({ grant }, grant.idempotentReplay || grant.unchanged ? 200 : 201);
});
app.get("/api/client-portal/folder-grant-targets", async (c) => {
  const divisionId = c.req.query("divisionId") || "";
  const r2Prefix = c.req.query("r2Prefix") || "";
  const query = c.req.query("q") || "";
  if (!r2Prefix || divisionId.length > 128 || r2Prefix.length > 1000 || query.length > 200)
    throw new HTTPException(400, { message: "Folder and search query are required" });
  return c.json(await findClientFolderGrantTargets(c.env, c.get("principal"), { divisionId, r2Prefix, query }));
});
app.delete("/api/client-portal/accounts/:accountId/folder-grants/:grantId", async (c) => {
  await revokeClientFolderGrant(c.env, c.req.raw, c.get("principal"), c.req.param("accountId"), c.req.param("grantId"));
  return c.json({ success: true });
});
app.post("/api/client-portal/projects", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const value = await body(c, portalProjectLinkSchema),
    project = await c.env.OPS_DB.prepare(
      "SELECT p.id,p.name,p.status,p.client_id,p.organization_id,p.updated_at,COALESCE(client.name,organization.name,'Client') client_name FROM pa_projects p LEFT JOIN pa_clients client ON client.id=p.client_id LEFT JOIN pa_organizations organization ON organization.id=p.organization_id WHERE p.id=? AND p.active=1",
    )
      .bind(value.projectAlphaProjectId)
      .first<any>(),
    account = await c.env.DELIVERY_DB.withSession("first-primary")
      .prepare(
        "SELECT id,project_alpha_client_id,project_alpha_organization_id FROM client_accounts WHERE id=? AND status='active'",
      )
      .bind(value.accountId)
      .first<any>();
  if (!project || !account)
    throw new HTTPException(404, {
      message: "Client account or Project Alpha project not found",
    });
  if (value.canRequestService && !account.project_alpha_client_id)
    throw new HTTPException(409, {
      message: "Service-request access requires a concrete Project Alpha client link",
    });
  const clientMatches =
      project.client_id === account.project_alpha_client_id,
    organizationMatches =
      Boolean(account.project_alpha_organization_id) &&
      project.organization_id === account.project_alpha_organization_id;
  if (
    (value.canRequestService && !clientMatches) ||
    (!value.canRequestService && !clientMatches && !organizationMatches)
  )
    throw new HTTPException(409, {
      message:
        "The Project Alpha project does not belong to this client account",
    });
  const db = c.env.DELIVERY_DB.withSession("first-primary"),
    portalProjectId = `portal-pa-${project.id}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO projects(id,external_ref,client_name,project_name,r2_prefix,active,project_alpha_project_id,status,source_updated_at) VALUES (?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET client_name=excluded.client_name,project_name=excluded.project_name,active=1,status=excluded.status,source_updated_at=excluded.source_updated_at,updated_at=datetime('now')`,
      )
      .bind(
        portalProjectId,
        project.id,
        project.client_name,
        project.name,
        `portal-unassociated/${project.id}/`,
        project.id,
        project.status,
        project.updated_at,
      ),
    db
      .prepare(
        `INSERT INTO client_project_grants(account_id,project_id,can_request_service,granted_by,revoked_at) VALUES (?,?,?,?,NULL) ON CONFLICT(account_id,project_id) DO UPDATE SET can_request_service=excluded.can_request_service,granted_by=excluded.granted_by,granted_at=datetime('now'),revoked_at=NULL`,
      )
      .bind(account.id, portalProjectId, value.canRequestService ? 1 : 0, null),
    db
      .prepare(
        "INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,'client.project.linked','project',?,?)",
      )
      .bind(
        principal.id,
        portalProjectId,
        JSON.stringify({
          accountId: account.id,
          projectAlphaProjectId: project.id,
        }),
      ),
  ]);
  return c.json(
    {
      id: portalProjectId,
      accountId: account.id,
      projectAlphaProjectId: project.id,
    },
    201,
  );
});
app.post("/api/projects/:id/folder", async (c) => {
  const principal = c.get("principal"),
    value = await body(c, folderAssociationSchema);
  await requirePermission(
    c.env,
    principal,
    "delivery.browse",
    { divisionId: value.divisionId },
    true,
  );
  const prefix = value.r2Prefix
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (
    !prefix ||
    prefix
      .split("/")
      .some(
        (part) =>
          !part ||
          part === ".." ||
          ["dump", "_ltds", ".previews"].includes(part.toLowerCase()),
      )
  )
    throw new HTTPException(400, { message: "Folder prefix is invalid" });
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`,
    db = c.env.DELIVERY_DB.withSession("first-primary"),
    links = await db
      .prepare(
        "SELECT g.account_id,p.id project_id FROM projects p JOIN client_project_grants g ON g.project_id=p.id AND g.revoked_at IS NULL WHERE p.project_alpha_project_id=? AND (? IS NULL OR g.account_id=?)",
      )
      .bind(c.req.param("id"), value.accountId || null, value.accountId || null)
      .all<{ account_id: string; project_id: string }>();
  if (links.results.length !== 1)
    throw new HTTPException(409, {
      message: links.results.length
        ? "Select one client account for this project"
        : "Link this Project Alpha project to a client account first",
    });
  const link = links.results[0]!,
    associationId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE scope_type='project' AND account_id=? AND project_id=? AND revoked_at IS NULL",
      )
      .bind(link.account_id, link.project_id),
    db
      .prepare(
        "INSERT INTO client_folder_associations(id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES (?,'project',?,?,?,?)",
      )
      .bind(
        associationId,
        link.project_id,
        link.account_id,
        normalized,
        principal.id,
      ),
    db
      .prepare(
        "INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,'client.folder.associated','project',?,?)",
      )
      .bind(
        principal.id,
        link.project_id,
        JSON.stringify({
          accountId: link.account_id,
          r2Prefix: normalized,
          projectAlphaProjectId: c.req.param("id"),
        }),
      ),
  ]);
  await c.env.OPS_DB.batch([
    c.env.OPS_DB.prepare(
      `INSERT INTO project_folders (project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES (?,?,?,'manual',?) ON CONFLICT(project_id) DO UPDATE SET division_id=excluded.division_id,r2_prefix=excluded.r2_prefix,match_method='manual',confirmed_by=excluded.confirmed_by,confirmed_at=datetime('now')`,
    ).bind(c.req.param("id"), value.divisionId, normalized, principal.id),
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "project.folder.confirmed",
      "project",
      c.req.param("id"),
      value.divisionId,
      { r2Prefix: normalized, accountId: link.account_id },
    ),
  ]);
  return c.json({
    success: true,
    r2Prefix: normalized,
    accountId: link.account_id,
    associationId,
  });
});

app.get("/api/operations", async (c) => {
  const principal = c.get("principal");
  await requirePermission(c.env, principal, "operations.view");
  const where = await paScopeWhere(
    c.env,
    principal,
    c.get("administrator"),
    "operations.view",
    "o",
    "operation",
  );
  const result = await c.env.OPS_DB.prepare(
    `SELECT o.*,o.scheduled_start_at scheduled_start,o.scheduled_end_at scheduled_end,d.name division_name,p.name project_name FROM pa_operations o LEFT JOIN divisions d ON d.project_alpha_business_unit_id=o.business_unit_id LEFT JOIN pa_projects p ON p.id=o.project_id WHERE ${where.sql} ORDER BY COALESCE(o.scheduled_start_at,o.updated_at) DESC LIMIT 250`,
  )
    .bind(...where.values)
    .all();
  return c.json({ operations: result.results });
});
app.post("/api/operations", () => managedInProjectAlpha());
app.patch("/api/operations/:id", () => managedInProjectAlpha());
registerJobBriefRoutes(app);
registerSopRoutes(app);

app.get("/api/tasks", async (c) => {
  const principal = c.get("principal");
  await requirePermission(c.env, principal, "tasks.view");
  const where = await paScopeWhere(
    c.env,
    principal,
    c.get("administrator"),
    "tasks.view",
    "t",
    "task",
  );
  const result = await c.env.OPS_DB.prepare(
    `SELECT t.*,t.notes description,d.name division_name,o.title operation_title,p.name project_name,(SELECT GROUP_CONCAT(s.display_name, ', ') FROM pa_task_assignments ta JOIN staff_users s ON s.project_alpha_user_id=ta.user_id WHERE ta.task_id=t.id AND ta.active=1) assigned_name FROM pa_tasks t LEFT JOIN divisions d ON d.project_alpha_business_unit_id=t.business_unit_id LEFT JOIN pa_operations o ON o.id=t.operation_id LEFT JOIN pa_projects p ON p.id=t.project_id WHERE ${where.sql} ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,t.due_at LIMIT 300`,
  )
    .bind(...where.values)
    .all();
  return c.json({ tasks: result.results });
});

// Client requests live with their portal grants in DELIVERY_DB. PA remains the
// authority for quotes/contracts/invoices; LTDS only stores a verified summary.
app.get("/api/client-service-requests", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const result = await c.env.DELIVERY_DB.withSession("first-primary")
    .prepare(
      `SELECT r.id,r.account_id,r.project_id,r.parent_request_id,r.request_type,r.title,r.details,r.location_text,r.preferred_start_at,r.service_category,r.deliverables_text,r.site_contact_name,r.site_contact_email,r.site_contact_phone,r.desired_completion_at,r.latitude,r.longitude,r.area_geojson,r.poi_points_json,r.status,r.created_at,r.updated_at,a.display_name account_name,p.project_name,p.client_name,quote.project_alpha_artifact_id quote_id,quote.document_number quote_document_number,quote.artifact_status quote_status,quote.total_minor quote_total_minor,quote.currency quote_currency,quote.verified_at quote_verified_at FROM client_service_requests r JOIN client_accounts a ON a.id=r.account_id LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN request_pa_artifacts quote ON quote.request_id=r.id AND quote.artifact_type='quote' AND quote.superseded_at IS NULL WHERE a.status='active' ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 WHEN 'accepted_pending_pa_linkage' THEN 2 WHEN 'accepted_linked' THEN 3 ELSE 4 END,CASE WHEN r.desired_completion_at IS NULL THEN 1 ELSE 0 END,r.desired_completion_at ASC,r.created_at ASC,r.id ASC LIMIT 200`,
    )
    .all();
  return c.json({ requests: result.results });
});
app.get("/api/client-service-requests/pending-count", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const row = await c.env.DELIVERY_DB.withSession("first-primary")
    .prepare(
      "SELECT COUNT(*) count FROM client_service_requests r JOIN client_accounts a ON a.id=r.account_id AND a.status='active' WHERE r.status='submitted'",
    )
    .first<{ count: number }>();
  return c.json({ count: Number(row?.count || 0) });
});
app.get("/api/client-service-requests/:id", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const db = c.env.DELIVERY_DB.withSession("first-primary"),
    id = c.req.param("id"),
    request = await db
      .prepare(
        `SELECT r.*,a.display_name account_name,p.project_name,p.client_name,quote.document_number quote_document_number,quote.artifact_status quote_status,quote.total_minor quote_total_minor,quote.currency quote_currency,quote.verified_at quote_verified_at FROM client_service_requests r JOIN client_accounts a ON a.id=r.account_id LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN request_pa_artifacts quote ON quote.request_id=r.id AND quote.artifact_type='quote' AND quote.superseded_at IS NULL WHERE r.id=? AND a.status='active'`,
      )
      .bind(id)
      .first();
  if (!request)
    throw new HTTPException(404, { message: "Client request not found" });
  const [revisions, estimates, history, children] = await Promise.all([
    db
      .prepare(
        "SELECT revision_number,author_type,author_id,action,snapshot_json,note,created_at FROM request_revisions WHERE request_id=? ORDER BY revision_number DESC",
      )
      .bind(id)
      .all(),
    db
      .prepare(
        "SELECT id,version,scope_text,estimate_amount_minor,currency,proposed_fields_json,status,client_response_note,created_at,updated_at,responded_at FROM request_operational_estimates WHERE request_id=? ORDER BY version DESC",
      )
      .bind(id)
      .all(),
    db
      .prepare(
        "SELECT actor_id,action,details_json,created_at FROM request_admin_audit WHERE request_id=? ORDER BY created_at DESC,id DESC",
      )
      .bind(id)
      .all(),
    db
      .prepare(
        "SELECT id,title,status,created_at FROM client_service_requests WHERE parent_request_id=? ORDER BY created_at DESC",
      )
      .bind(id)
      .all(),
  ]);
  return c.json({
    request,
    revisions: revisions.results,
    estimates: estimates.results,
    history: history.results,
    children: children.results,
  });
});
app.post("/api/client-service-requests/:id/estimate", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const parsedMutationKey = workflowIdempotencyKey.safeParse(
    c.req.header("Idempotency-Key"),
  );
  if (!parsedMutationKey.success)
    throw new HTTPException(400, {
      message: "A valid Idempotency-Key header is required",
    });
  const value = await body(c, operationalEstimateSchema),
    db = c.env.DELIVERY_DB.withSession("first-primary"),
    id = c.req.param("id"),
    mutationKey = parsedMutationKey.data,
    mutationFingerprint = await sha256Hex(
      JSON.stringify({ requestId: id, ...value }),
    ),
    replay = await db
      .prepare(
        "SELECT id,request_id,version,status,mutation_fingerprint FROM request_operational_estimates WHERE mutation_key=?",
      )
      .bind(mutationKey)
      .first<{
        id: string;
        request_id: string;
        version: number;
        status: string;
        mutation_fingerprint: string;
      }>(),
    request = await db
      .prepare(
        "SELECT id,project_id,status FROM client_service_requests WHERE id=?",
      )
      .bind(id)
      .first<{ id: string; project_id: string | null; status: string }>();
  if (replay) {
    if (
      replay.request_id !== id ||
      replay.mutation_fingerprint !== mutationFingerprint
    )
      throw new HTTPException(409, {
        message: "This Idempotency-Key was already used for another estimate",
      });
    return c.json({
      id: replay.id,
      version: replay.version,
      status: replay.status,
      idempotentReplay: true,
    });
  }
  if (!request)
    throw new HTTPException(404, { message: "Client request not found" });
  if (!["submitted", "under_review"].includes(request.status))
    throw new HTTPException(409, {
      message: "This request is no longer open for an operational estimate",
    });
  const current = await db
    .prepare(
      "SELECT id,version,status FROM request_operational_estimates WHERE request_id=? AND status IN ('draft','ready','accepted','change_requested')",
    )
    .bind(id)
    .first<{ id: string; version: number; status: string }>();
  if (current && !["draft", "change_requested"].includes(current.status))
    throw new HTTPException(409, {
      message:
        "The current estimate already requires a client or staff response",
    });
  if (
    value.version !== undefined &&
    current &&
    value.version !== current.version
  )
    throw new HTTPException(409, {
      message: "This estimate changed. Refresh and try again.",
    });
  const readyNotificationPayload =
    value.status === "ready"
      ? await requestNotificationSnapshot(
          db,
          id,
          "estimate_ready",
          "open_client_portal",
        )
      : null;
  const estimateId = crypto.randomUUID(),
    version = current ? current.version + 1 : 1,
    previousVersion = current?.version || 0,
    amountMinor = value.amount == null ? null : Math.round(value.amount * 100),
    proposed = value.proposedFields
      ? JSON.stringify(value.proposedFields)
      : null,
    guard = `EXISTS (SELECT 1 FROM request_operational_estimates WHERE id=? AND mutation_key=?)`,
    statements = [
      current
        ? db
            .prepare(
              "UPDATE request_operational_estimates SET status='superseded',updated_at=datetime('now') WHERE id=? AND status IN ('draft','change_requested') AND version=?",
            )
            .bind(current.id, previousVersion)
        : db
            .prepare(
              "INSERT INTO request_operational_estimates(id,request_id,version,scope_text,estimate_amount_minor,currency,proposed_fields_json,status,created_by,mutation_key,mutation_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              estimateId,
              id,
              version,
              value.scope,
              amountMinor,
              value.currency || null,
              proposed,
              value.status,
              principal.id,
              mutationKey,
              mutationFingerprint,
            ),
      ...(current
        ? [
            db
              .prepare(
                "INSERT INTO request_operational_estimates(id,request_id,version,scope_text,estimate_amount_minor,currency,proposed_fields_json,status,created_by,mutation_key,mutation_fingerprint) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1",
              )
              .bind(
                estimateId,
                id,
                version,
                value.scope,
                amountMinor,
                value.currency || null,
                proposed,
                value.status,
                principal.id,
                mutationKey,
                mutationFingerprint,
              ),
          ]
        : []),
      db
        .prepare(
          `UPDATE client_service_requests SET status='under_review',updated_at=datetime('now') WHERE id=? AND status='submitted' AND ${guard}`,
        )
        .bind(id, estimateId, mutationKey),
      db
        .prepare(
          `INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json,note,mutation_key,mutation_fingerprint) SELECT ?,?,COALESCE((SELECT MAX(revision_number)+1 FROM request_revisions WHERE request_id=?),1),'staff',?,'staff_proposal',?,?,?,? WHERE ${guard}`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          id,
          principal.id,
          JSON.stringify({
            estimateId,
            version,
            status: value.status,
            scope: value.scope,
            amount: value.amount ?? null,
            currency: value.currency ?? null,
            proposedFields: value.proposedFields ?? null,
          }),
          value.scope,
          mutationKey,
          mutationFingerprint,
          estimateId,
          mutationKey,
        ),
      db
        .prepare(
          `INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) SELECT 'staff',?,'client.service_request.estimate_proposed','client_service_request',?,? WHERE ${guard}`,
        )
        .bind(
          principal.id,
          id,
          JSON.stringify({ estimateId, version, status: value.status }),
          estimateId,
          mutationKey,
        ),
      db
        .prepare(
          `INSERT INTO request_admin_audit(request_id,actor_id,action,details_json) SELECT ?,?,'estimate_proposed',? WHERE ${guard}`,
        )
        .bind(
          id,
          principal.id,
          JSON.stringify({ estimateId, version, status: value.status }),
          estimateId,
          mutationKey,
        ),
      ...(value.status === "ready"
        ? [
            db
              .prepare(
                `INSERT OR IGNORE INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) SELECT ?,?,'request_confirmation_requested',NULL,'client_requester',?,? WHERE ${guard}`,
              )
              .bind(
                crypto.randomUUID(),
                id,
                `request_confirmation_requested:${estimateId}:client_requester`,
                JSON.stringify(readyNotificationPayload),
                estimateId,
                mutationKey,
              ),
          ]
        : []),
    ];
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch {
    const raced = await db
      .prepare(
        "SELECT id,request_id,version,status,mutation_fingerprint FROM request_operational_estimates WHERE mutation_key=?",
      )
      .bind(mutationKey)
      .first<{
        id: string;
        request_id: string;
        version: number;
        status: string;
        mutation_fingerprint: string;
      }>();
    if (
      raced?.request_id === id &&
      raced.mutation_fingerprint === mutationFingerprint
    )
      return c.json({
        id: raced.id,
        version: raced.version,
        status: raced.status,
        idempotentReplay: true,
      });
    throw new HTTPException(409, {
      message: "This estimate changed. Refresh and try again.",
    });
  }
  if (!results[0]?.meta.changes)
    throw new HTTPException(409, {
      message: "This estimate changed. Refresh and try again.",
    });
  return c.json(
    { id: estimateId, version, status: value.status, idempotentReplay: false },
    201,
  );
});
app.patch("/api/client-service-requests/:id", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const value = await body(c, clientRequestTriageSchema),
    id = c.req.param("id"),
    db = c.env.DELIVERY_DB.withSession("first-primary"),
    request = await db
      .prepare(
        "SELECT id,account_id,project_id,parent_request_id,status FROM client_service_requests WHERE id=?",
      )
      .bind(id)
      .first<{
        id: string;
        account_id: string;
        project_id: string | null;
        parent_request_id: string | null;
        status: string;
      }>();
  if (!request)
    throw new HTTPException(404, { message: "Client request not found" });
  const allowed =
    request.status === "submitted"
      ? ["under_review", "declined"]
      : request.status === "under_review"
        ? ["accepted_pending_pa_linkage", "declined"]
        : request.status === "accepted_linked"
          ? ["completed"]
          : [];
  if (!allowed.includes(value.status))
    throw new HTTPException(409, {
      message: "This client request cannot transition to that status",
    });
  if (
    value.status === "accepted_pending_pa_linkage" &&
    !(await db
      .prepare(
        "SELECT 1 ok FROM request_operational_estimates WHERE request_id=? AND status='accepted'",
      )
      .bind(id)
      .first())
  )
    throw new HTTPException(409, {
      message:
        "The client must accept the current operational estimate before final approval",
    });
  const statusNotificationPayload = await requestNotificationSnapshot(
    db,
    id,
    value.status as ServiceRequestNotificationLifecycle,
    "open_client_portal",
  );
  const transitionKey = crypto.randomUUID(),
    parentHasQuote =
      value.status === "accepted_pending_pa_linkage" &&
      request.parent_request_id
        ? Boolean(
            await db
              .prepare(
                "SELECT 1 ok FROM request_pa_artifacts WHERE request_id=? AND artifact_type='quote' AND superseded_at IS NULL",
              )
              .bind(request.parent_request_id)
              .first(),
          )
        : false,
    guard =
      "EXISTS (SELECT 1 FROM audit_log WHERE actor_id=? AND action='client.service_request.transition_guard' AND entity_id=? AND details_json=?)",
    guardJson = JSON.stringify({ transitionKey }),
    results = await db.batch([
      db
        .prepare(
          "INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) SELECT 'staff',?,'client.service_request.transition_guard','client_service_request',?,? WHERE EXISTS (SELECT 1 FROM client_service_requests WHERE id=? AND status=?)",
        )
        .bind(principal.id, id, guardJson, id, request.status),
      db
        .prepare(
          `UPDATE client_service_requests SET status=?,updated_at=datetime('now') WHERE id=? AND status=? AND ${guard}`,
        )
        .bind(value.status, id, request.status, principal.id, id, guardJson),
      ...(parentHasQuote
        ? [
            db
              .prepare(
                `UPDATE request_pa_artifacts SET superseded_at=datetime('now') WHERE request_id=? AND artifact_type='quote' AND superseded_at IS NULL AND ${guard}`,
              )
              .bind(request.parent_request_id, principal.id, id, guardJson),
          ]
        : []),
      db
        .prepare(
          `INSERT OR IGNORE INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) SELECT ?,?,'request_status_changed',?,'client_requester',?,? WHERE ${guard}`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          value.status,
          `request_status_changed:${value.status}:client_requester`,
          JSON.stringify(statusNotificationPayload),
          principal.id,
          id,
          guardJson,
        ),
      db
        .prepare(
          `INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) SELECT 'staff',?,'client.service_request.status_changed','client_service_request',?,? WHERE ${guard}`,
        )
        .bind(
          principal.id,
          id,
          JSON.stringify({
            from: request.status,
            to: value.status,
            parentQuoteSuperseded: parentHasQuote,
          }),
          principal.id,
          id,
          guardJson,
        ),
      db
        .prepare(
          `INSERT INTO request_admin_audit(request_id,actor_id,action,details_json) SELECT ?,?,'status_changed',? WHERE ${guard}`,
        )
        .bind(
          id,
          principal.id,
          JSON.stringify({
            from: request.status,
            to: value.status,
            parentQuoteSuperseded: parentHasQuote,
          }),
          principal.id,
          id,
          guardJson,
        ),
      db
        .prepare(
          `INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json) SELECT ?,?,COALESCE((SELECT MAX(revision_number)+1 FROM request_revisions WHERE request_id=?),1),'staff',?,'status_changed',? WHERE ${guard}`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          id,
          principal.id,
          JSON.stringify({
            from: request.status,
            to: value.status,
            parentQuoteSuperseded: parentHasQuote,
          }),
          principal.id,
          id,
          guardJson,
        ),
    ]);
  if (!results[1]?.meta.changes)
    throw new HTTPException(409, {
      message: "This client request changed. Refresh and try again.",
    });
  c.executionCtx.waitUntil(
    (async () => c.env.OPS_DB.batch([
      await auditStatement(
        c.env,
        c.req.raw,
        principal,
        "client.service_request.status_changed",
        "client_service_request",
        id,
        null,
        { from: request.status, to: value.status },
      ),
    ]))().catch((error) =>
      console.error(
        JSON.stringify({
          event: "secondary_ops_audit_failed",
          requestId: id,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
    ),
  );
  return c.json({ id, status: value.status });
});
app.post("/api/client-service-requests/:id/pa-quote", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "operations.manage");
  const value = await body(c, paQuoteLinkSchema),
    id = c.req.param("id"),
    db = c.env.DELIVERY_DB.withSession("first-primary"),
    request = await db
      .prepare(
        `SELECT r.id,r.status,r.project_id,a.project_alpha_client_id,p.project_alpha_project_id FROM client_service_requests r JOIN client_accounts a ON a.id=r.account_id LEFT JOIN projects p ON p.id=r.project_id WHERE r.id=?`,
      )
      .bind(id)
      .first<{
        id: string;
        status: string;
        project_id: string | null;
        project_alpha_client_id: string | null;
        project_alpha_project_id: string | null;
      }>();
  if (!request)
    throw new HTTPException(404, { message: "Client request not found" });
  if (request.status !== "accepted_pending_pa_linkage")
    throw new HTTPException(409, {
      message: "Accept the client request before linking a Project Alpha quote",
    });
  if (!request.project_alpha_client_id)
    throw new HTTPException(409, {
      message: "This client account is not linked to a Project Alpha client",
    });
  const artifact = await verifyProjectAlphaQuote(c.env, {
    artifactId: value.artifactId,
    clientId: request.project_alpha_client_id,
    projectId: request.project_alpha_project_id,
  });
  const totalMinor = Math.round(Number(artifact.total) * 100);
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0)
    throw new HTTPException(502, {
      message: "Project Alpha returned an invalid quote total",
    });
  const fingerprint = await sha256Hex(
      JSON.stringify([
        artifact.id,
        artifact.client_id,
        artifact.project_id,
        artifact.status,
        artifact.document_number,
        artifact.total,
        artifact.currency,
        artifact.updated_at,
      ]),
    ),
    artifactRecordId = crypto.randomUUID(),
    verifiedAt = new Date().toISOString();
  const acceptedNotificationPayload = await requestNotificationSnapshot(
    db,
    id,
    "accepted_linked",
    "open_client_portal",
  );
  const results = await db.batch([
    db
      .prepare(
        "UPDATE client_service_requests SET status='accepted_linked',updated_at=datetime('now') WHERE id=? AND status='accepted_pending_pa_linkage'",
      )
      .bind(id),
    db
      .prepare(
        `INSERT INTO request_pa_artifacts(id,request_id,artifact_type,project_alpha_artifact_id,document_number,artifact_status,total_minor,currency,verification_fingerprint,verified_at,verified_by) SELECT ?,?,'quote',?,?,?,?,?,?,?,? WHERE changes()=1`,
      )
      .bind(
        artifactRecordId,
        id,
        String(artifact.id),
        artifact.document_number,
        artifact.status,
        totalMinor,
        artifact.currency.toUpperCase(),
        fingerprint,
        verifiedAt,
        principal.id,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) SELECT ?,?,'request_status_changed','accepted_linked','client_requester','request_status_changed:accepted_linked:client_requester',? WHERE changes()=1",
      )
      .bind(
        crypto.randomUUID(),
        id,
        JSON.stringify(acceptedNotificationPayload),
      ),
    db
      .prepare(
        "INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) SELECT 'staff',?,'client.service_request.pa_quote_verified','client_service_request',?,? WHERE changes()=1",
      )
      .bind(
        principal.id,
        id,
        JSON.stringify({
          projectAlphaQuoteId: artifact.id,
          documentNumber: artifact.document_number,
          fingerprint,
        }),
      ),
    db
      .prepare(
        "INSERT INTO request_admin_audit(request_id,actor_id,action,details_json) SELECT ?,?,'pa_quote_verified',? WHERE changes()=1",
      )
      .bind(
        id,
        principal.id,
        JSON.stringify({ projectAlphaQuoteId: artifact.id, fingerprint }),
      ),
    db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
      SELECT ?,?,COALESCE((SELECT MAX(revision_number)+1 FROM request_revisions WHERE request_id=?),1),'staff',?,'pa_quote_linked',? WHERE changes()=1`)
      .bind(crypto.randomUUID(),id,id,principal.id,JSON.stringify({projectAlphaQuoteId:artifact.id,documentNumber:artifact.document_number,status:artifact.status})),
  ]);
  if (!results[0]?.meta.changes)
    throw new HTTPException(409, {
      message: "This client request changed. Refresh and try again.",
    });
  c.executionCtx.waitUntil((async()=>c.env.OPS_DB.batch([
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "client.service_request.pa_quote_verified",
      "client_service_request",
      id,
      null,
      {
        projectAlphaQuoteId: artifact.id,
        documentNumber: artifact.document_number,
      },
    ),
  ]))().catch(error=>console.error(JSON.stringify({event:"secondary_ops_audit_failed",requestId:id,error:error instanceof Error?error.message:"unknown"}))));
  return c.json({
    id,
    status: "accepted_linked",
    quote: {
      documentNumber: artifact.document_number,
      total: Number(artifact.total),
      currency: artifact.currency,
      verifiedAt,
    },
  });
});
app.post("/api/tasks", () => managedInProjectAlpha());
app.patch("/api/tasks/:id", () => managedInProjectAlpha());

app.get("/api/calendar", async (c) => {
  const principal = c.get("principal"),
    administrator = c.get("administrator");
  await requirePermission(c.env, principal, "operations.view");
  const [scope, allOperations] = await Promise.all([
    visibilityScope(c.env, principal, administrator, "operations.view"),
    hasExplicitAllOperations(c.env, principal, administrator),
  ]);
  const where = paCalendarFilter(
    scope,
    principal,
    administrator,
    "e",
    allOperations,
  );
  const result = await c.env.OPS_DB.prepare(
    `SELECT e.*,p.name project_name FROM pa_calendar_events e LEFT JOIN pa_projects p ON p.id=e.project_id WHERE ${where.sql} ORDER BY e.start_at LIMIT 500`,
  )
    .bind(...where.values)
    .all();
  return c.json({ events: result.results });
});

app.get("/api/airspace/tfrs", async (c) => {
  const principal = c.get("principal");
  await requirePermission(c.env, principal, "airspace.view");
  const operationFilter = await paScopeWhere(
    c.env,
    principal,
    c.get("administrator"),
    "operations.view",
    "o",
    "operation",
  );
  return c.json(await airspaceView(c.env, operationFilter));
});
app.get("/api/delivery/folders", async (c) =>
  c.json(
    await listDeliveryFolder(
      c.env,
      c.get("principal"),
      c.req.query("prefix") || "",
      c.req.query("cursor"),
    ),
  ),
);
app.get("/api/delivery/search", async (c) =>
  c.json(await searchDeliveryItems(
    c.env,
    c.get("principal"),
    c.req.query("q") || "",
    c.req.query("cursor"),
  )),
);
app.get("/api/delivery/access-revision", async (c) =>
  c.json({ revision: await deliveryBrowseRevision(c.env, c.get("principal")) }),
);
app.get("/api/delivery/thumbnail-queue", async (c) => {
  // The aggregate is operational telemetry, so keep it restricted to global
  // Operations administrators rather than exposing work volume across scopes.
  if (!c.get("administrator")) throw new HTTPException(404, { message: "Not found" });
  return c.json(await thumbnailQueueSummary(c.env, c.get("principal")));
});
app.get("/api/delivery/folders/locations", async (c) =>
  c.json(await listDeliveryFolderLocations(
    c.env,
    c.get("principal"),
    c.req.query("prefix") || "",
  )),
);
app.get("/api/delivery/folders/location-assets/:assetRef", async (c) =>
  c.json(await resolveDeliveryLocationAsset(
    c.env,
    c.get("principal"),
    c.req.query("prefix") || "",
    c.req.param("assetRef"),
  )),
);
app.get("/api/delivery/shares", async (c) =>
  c.json({ shares: await listDeliveryShares(c.env, c.get("principal")) }),
);
app.get("/api/delivery/trash", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "delivery.delete");
  return c.json({ items: await listTrash(c.env) });
});
app.post("/api/delivery/trash/:id/restore", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "delivery.delete");
  await restoreTombstone(c.env, principal, c.req.param("id"));
  return c.json({ success: true });
});
app.get("/api/delivery/shares/active", async (c) => {
  const prefix = c.req.query("prefix");
  if (!prefix) throw new HTTPException(400, { message: "prefix is required" });
  return c.json({
    share: await getActiveDeliveryShare(c.env, c.get("principal"), prefix),
  });
});
app.post("/api/delivery/shares", async (c) => {
  const value = await c.req.json();
  return c.json(
    {
      share: await createDeliveryShare(
        c.env,
        c.req.raw,
        c.get("principal"),
        value,
        c.req.header("Idempotency-Key") || "",
      ),
    },
    201,
  );
});
app.delete("/api/delivery/shares/:id", async (c) => {
  await revokeDeliveryShare(
    c.env,
    c.req.raw,
    c.get("principal"),
    c.req.param("id"),
  );
  return c.json({ success: true });
});
app.patch("/api/delivery/items/:itemRef/display-name", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "delivery.rename");
  const key = await authorizeItem(c.env, principal, c.req.param("itemRef"));
  const value = await body(
    c,
    z.object({ displayName: z.string().min(1).max(160) }),
  );
  const alias = await upsertAlias(c.env, principal, key, value.displayName);
  await c.env.OPS_DB.batch([
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "delivery.alias.updated",
      "file",
      alias.physical_key,
      null,
      { displayName: alias.display_name },
    ),
  ]);
  return c.json({ alias });
});
app.delete("/api/delivery/items/:itemRef/display-name", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "delivery.rename");
  const authorized = await authorizeItem(
    c.env,
    principal,
    c.req.param("itemRef"),
  );
  const key = await resolveAliasKey(c.env, authorized);
  await deleteAlias(c.env, key);
  await c.env.OPS_DB.batch([
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "delivery.alias.deleted",
      "file",
      key,
      null,
    ),
  ]);
  return c.json({ success: true });
});
app.post("/api/delivery/items/:itemRef/source/delete-preview", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "delivery.delete");
  await authorizeItem(c.env, principal, c.req.param("itemRef"));
  return c.json(await previewSourceDelete(c.env, c.req.param("itemRef")));
});
app.delete("/api/delivery/items/:itemRef/source", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "delivery.delete");
  await authorizeItem(c.env, principal, c.req.param("itemRef"));
  const value = await body(
    c,
    z.object({ confirmation: z.string().min(1).max(160) }),
  );
  return c.json({
    deleted: await executeSourceDelete(
      c.env,
      principal,
      c.req.param("itemRef"),
      value.confirmation,
    ),
  });
});

async function opsFile(
  c: any,
  disposition: "inline" | "attachment",
  raw = false,
): Promise<Response> {
  const key = await authorizeItem(
    c.env,
    c.get("principal"),
    c.req.param("itemRef"),
  );
  const kind = mediaKind(key);
  if (
    disposition === "inline" &&
    !["image", "video", "audio", "pdf", "text"].includes(kind)
  )
    throw new HTTPException(415, { message: "Preview unavailable" });
  if (!raw && disposition === "inline" && kind === "pdf")
    return servePdfSourceFile(c.env.DATA_BUCKET, key, c.req);
  if (!raw && disposition === "inline" && kind === "video")
    throw new HTTPException(409, {
      message: "Video preview uses Stream or the original source",
    });
  return serveSourceFile(c.env.DATA_BUCKET, key, c.req, disposition);
}
app.on(["GET", "HEAD"], "/api/delivery/items/:itemRef/preview", (c) =>
  opsFile(c, "inline"),
);
app.on(["GET", "HEAD"], "/api/delivery/items/:itemRef/download", (c) =>
  opsFile(c, "attachment"),
);
app.on(["GET", "HEAD"], "/api/delivery/items/:itemRef/source", (c) =>
  opsFile(c, "inline", true),
);
app.on(["GET", "HEAD"], "/api/delivery/items/:itemRef/pdf", async (c) =>
  servePdfSourceFile(
    c.env.DATA_BUCKET,
    await authorizeItem(c.env, c.get("principal"), c.req.param("itemRef")),
    c.req,
  ),
);
app.on(["GET", "HEAD"], "/api/delivery/items/:itemRef/thumbnail", async (c) => {
  const key = await authorizeItem(
    c.env,
    c.get("principal"),
    c.req.param("itemRef"),
  );
  const source = await c.env.DATA_BUCKET.head(key);
  if (!source||isMovedSourceMarker(source)) throw new HTTPException(404,{message:"File not found"});
  if (!thumbnailSourceEligible(key, source.size, source.httpMetadata?.contentType)) {
    return c.json({ state: "not_applicable" }, 409);
  }
  const thumbnail = await getThumbnailForAuthorizedSource(c.env, key, source);
  if (thumbnail.state !== "ready") return c.json({ state: thumbnail.state, errorCode: thumbnail.errorCode }, 409);
  const headers = new Headers({
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    "Content-Length": String(thumbnail.object.size),
    "Cache-Control": "private, no-store",
    "ETag": thumbnail.object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(c.req.method === "HEAD" ? null : thumbnail.object.body, { headers });
});
registerR2CrudRoutes(app);
registerDropboxImportRoutes(app);
app.route("/api/delivery/incoming-link", createIncomingStaffRouter());
app.post("/api/delivery/items/:itemRef/stream-ticket", async (c) => {
  const key = await authorizeItem(
    c.env,
    c.get("principal"),
    c.req.param("itemRef"),
  );
  if (mediaKind(key) !== "video")
    throw new HTTPException(415, { message: "Stream preview unavailable" });
  const row = await c.env.DELIVERY_DB.withSession("first-primary")
    .prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?")
    .bind(key)
    .first<{ stream_uid: string | null; stream_status: string | null }>();
  if (
    row?.stream_status !== "ready" ||
    !row.stream_uid ||
    !c.env.STREAM_CUSTOMER_CODE
  )
    throw new HTTPException(404, { message: "Video preview unavailable" });
  const token = await c.env.STREAM.video(row.stream_uid).generateToken();
  return c.json({
    url: `https://customer-${c.env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/iframe`,
    expiresIn: 3600,
  });
});

app.get("/api/team/staff", async (c) => {
  const principal = c.get("principal"),
    administrator = c.get("administrator");
  await requirePermission(c.env, principal, "team.view");
  const scope = await sqlScope(c.env, principal, "team.view"),
    conditions: string[] = [],
    values: unknown[] = [];
  if (!scope.global) {
    const divisions = scope.divisions.filter(
      (id) => !scope.deniedDivisions.includes(id),
    );
    if (!divisions.length) return c.json({ staff: [] });
    conditions.push(
      `EXISTS (SELECT 1 FROM staff_divisions visible_staff_division WHERE visible_staff_division.staff_id=s.id AND visible_staff_division.division_id IN (${placeholders(divisions)}))`,
    );
    values.push(...divisions);
  }
  if (scope.deniedDivisions.length) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM staff_divisions denied_staff_division WHERE denied_staff_division.staff_id=s.id AND denied_staff_division.division_id IN (${placeholders(scope.deniedDivisions)}))`,
    );
    values.push(...scope.deniedDivisions);
  }
  const where = conditions.length ? conditions.join(" AND ") : "1=1";
  const result = await c.env.OPS_DB.prepare(
    `SELECT s.id,s.email,s.display_name,s.status,s.last_seen_at,s.provisioning_source,s.sync_protected,GROUP_CONCAT(DISTINCT d.name) divisions,GROUP_CONCAT(DISTINCT r.name) roles,(SELECT GROUP_CONCAT(permission_key) FROM (SELECT rp.permission_key FROM staff_role_assignments inherited_assignment JOIN role_permissions rp ON rp.role_id=inherited_assignment.role_id WHERE inherited_assignment.staff_id=s.id UNION SELECT rp.permission_key FROM local_staff_role_assignments local_assignment JOIN role_permissions rp ON rp.role_id=local_assignment.role_id WHERE local_assignment.staff_id=s.id)) inherited_permissions,GROUP_CONCAT(DISTINCT CASE WHEN po.effect='allow' AND po.scope='global' THEN po.permission_key END) direct_allows,GROUP_CONCAT(DISTINCT CASE WHEN po.effect='deny' AND po.scope='global' THEN po.permission_key END) global_denies FROM staff_users s LEFT JOIN staff_divisions sd ON sd.staff_id=s.id LEFT JOIN divisions d ON d.id=sd.division_id LEFT JOIN staff_role_assignments a ON a.staff_id=s.id LEFT JOIN roles r ON r.id=a.role_id LEFT JOIN staff_permission_overrides po ON po.staff_id=s.id WHERE ${where} GROUP BY s.id ORDER BY s.display_name`,
  )
    .bind(...values)
    .all<any>();
  return c.json({
    staff: result.results.map((row) => {
      const { inherited_permissions, direct_allows, global_denies, ...roster } =
        row;
      return administrator
        ? {
            ...roster,
            localControls: effectiveStaffAccessControls({
              inheritedPermissions: inherited_permissions,
              directAllows: direct_allows,
              globalDenies: global_denies,
            }),
          }
        : roster;
    }),
  });
});

app.put("/api/admin/staff/:id/access-controls", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "roles.manage");
  const value = await body(c, staffAccessSchema);
  const target = await c.env.OPS_DB.prepare(
    "SELECT id,email,status,sync_protected FROM staff_users WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{
      id: string;
      email: string;
      status: string;
      sync_protected: number;
    }>();
  if (!target || !["active", "inactive"].includes(target.status))
    throw new HTTPException(404, { message: "Staff member not found" });
  if (target.id === principal.id)
    throw new HTTPException(409, {
      message: "Administrators cannot change their own access controls",
    });
  if (target.sync_protected || target.id === "staff-beau-koltz")
    throw new HTTPException(409, {
      message: "Protected staff access controls cannot be changed",
    });
  const statements = [] as ReturnType<Env["OPS_DB"]["prepare"]>[];
  for (const [control, permissions] of Object.entries(
    STAFF_ACCESS_CONTROLS,
  ) as [StaffAccessControl, readonly Permission[]][]) {
    for (const permission of permissions) {
      const effect = staffAccessControlEffect(value[control]);
      statements.push(
        c.env.OPS_DB.prepare(
          "DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key=? AND scope='global'",
        ).bind(target.id, permission),
      );
      statements.push(
        c.env.OPS_DB.prepare(
          "INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?, 'global',NULL,'global',?)",
        ).bind(
          `staff-control-${target.id}-${permission}`,
          target.id,
          permission,
          effect,
          principal.id,
        ),
      );
    }
  }
  statements.push(
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "staff.access_controls.updated",
      "staff",
      target.id,
      null,
      { controls: value, email: target.email },
    ),
  );
  await c.env.OPS_DB.batch(statements);
  return c.json({ success: true, controls: value });
});
app.post("/api/admin/staff", () => managedInProjectAlpha());
app.patch("/api/admin/staff/:id", () => managedInProjectAlpha());
app.get("/api/admin/roles", async (c) => {
  await requireGlobal(c.env, c.get("principal"), "roles.manage");
  const [roles, permissions] = await Promise.all([
    c.env.OPS_DB.prepare(
      "SELECT r.id,r.name,r.description,r.immutable,GROUP_CONCAT(rp.permission_key) permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.name",
    ).all(),
    c.env.OPS_DB.prepare(
      "SELECT key,description FROM permissions ORDER BY key",
    ).all(),
  ]);
  return c.json({ roles: roles.results, permissions: permissions.results });
});
app.put("/api/admin/roles/:id", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "roles.manage");
  const id = c.req.param("id"),
    role = await c.env.OPS_DB.prepare("SELECT immutable FROM roles WHERE id=?")
      .bind(id)
      .first<{ immutable: number }>();
  if (!role) throw new HTTPException(404, { message: "Role not found" });
  if (role.immutable)
    throw new HTTPException(409, { message: "Built-in roles are immutable" });
  const value = await body(
    c,
    z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500),
      permissions: z.array(z.string()).max(100),
    }),
  );
  await c.env.OPS_DB.batch([
    c.env.OPS_DB.prepare(
      "UPDATE roles SET name=?,description=?,updated_at=datetime('now') WHERE id=?",
    ).bind(value.name, value.description, id),
    c.env.OPS_DB.prepare("DELETE FROM role_permissions WHERE role_id=?").bind(
      id,
    ),
    ...value.permissions.map((permission) =>
      c.env.OPS_DB.prepare(
        "INSERT INTO role_permissions (role_id,permission_key) VALUES (?,?)",
      ).bind(id, permission),
    ),
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "role.updated",
      "role",
      id,
      null,
      { permissions: value.permissions },
    ),
  ]);
  return c.json({ success: true });
});
app.get("/api/admin/audit", async (c) => {
  await requireGlobal(c.env, c.get("principal"), "audit.view");
  return c.json({
    events: (
      await c.env.OPS_DB.prepare(
        "SELECT id,actor_type,actor_email,actor_display_name,action,entity_type,entity_id,division_id,details_json,created_at FROM audit_events ORDER BY created_at DESC LIMIT 500",
      ).all()
    ).results,
  });
});
app.post("/api/admin/integrations/project-alpha/sync", async (c) => {
  const principal = c.get("principal");
  await requireGlobal(c.env, principal, "integrations.manage");
  const result = await syncProjectAlpha(c.env);
  if (
    result.changedCollections.some(
      (collection) =>
        collection === "operations" || collection === "service_locations",
    )
  )
    await rebuildOperationAirspaceMatches(c.env);
  await c.env.OPS_DB.batch([
    await auditStatement(
      c.env,
      c.req.raw,
      principal,
      "integration.sync",
      "integration",
      "project-alpha",
      null,
      result,
    ),
  ]);
  return c.json(result);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status >= 500)
    console.error(
      JSON.stringify({
        event: "ops.error",
        status,
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
  return c.json(
    { error: status >= 500 ? "An unexpected error occurred" : error.message },
    status,
  );
});

const CONSOLIDATED_CRON = "*/15 * * * *";
const CLIENT_REQUEST_NOTIFICATION_CRON = "*/5 * * * *";

async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) {
  if (event.cron === CLIENT_REQUEST_NOTIFICATION_CRON) {
    ctx.waitUntil(processThumbnailBackfills(env));
    try {
      await Promise.all([
        processClientPortalRequestNotifications(env),
        processClientFolderGrantNotifications(env),
        processClientFolderChangeNotifications(env),
      ]);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "client_request_notifications.error",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
    return;
  }
  if (event.cron !== CONSOLIDATED_CRON) return;

  ctx.waitUntil(refreshStreamStatuses(env));
  const scheduledAt = new Date(event.scheduledTime);
  const minute = scheduledAt.getUTCMinutes();
  const hour = scheduledAt.getUTCHours();

  if (minute === 0 && hour % 2 === 0)
    ctx.waitUntil(
      (async () => {
        const [tfrs, sua] = await Promise.all([
          refreshTfrs(env),
          refreshSua(env),
        ]);
        if (tfrs.changed || sua.changed)
          await rebuildOperationAirspaceMatches(env);
        await markAirspaceStaleAndPurge(env);
      })(),
    );

  // Keep the former daily syncs on the same trigger. They run at 08:15 and
  // 08:30 UTC, preserving their order while using one account-level trigger.
  if (hour === 8 && minute === 15)
    ctx.waitUntil(
      (async () => {
        const result = await syncProjectAlpha(env);
        if (
          result.changedCollections.some(
            (collection) =>
              collection === "operations" || collection === "service_locations",
          )
        )
          await rebuildOperationAirspaceMatches(env);
      })(),
    );
  if (hour === 8 && minute === 30) ctx.waitUntil(reconcileFileIndex(env));
  if (hour === 8 && minute === 45) ctx.waitUntil(runRetention(env));
  if (r2PurgeEnabled(env)) ctx.waitUntil(purgeTrash(env));
  ctx.waitUntil(processR2OperationJobs(env));
  ctx.waitUntil(purgeReplacementRecovery(env));
  ctx.waitUntil(expireBrowserUploadSessions(env));
  ctx.waitUntil(cleanupBrowserUploadSessions(env));
  ctx.waitUntil(drainThumbnailCleanup(env));
  ctx.waitUntil(reconcileThumbnailRegistrations(env));
  ctx.waitUntil(reconcileManagedThumbnailOrphans(env));
  ctx.waitUntil(recoverExpiredThumbnailLeases(env));
  ctx.waitUntil(recoverTransientThumbnailFailures(env));
  ctx.waitUntil(processThumbnailBackfills(env));
  ctx.waitUntil(enqueueImageLocationBackfill(env));
  ctx.waitUntil(
    enqueueExpiringNotifications(env).then(() =>
      processDeliveryNotifications(env),
    ),
  );
  if (env.DROPBOX_IMPORT_TOKEN_SECRET)
    ctx.waitUntil(cleanupDropboxImports(env));
}
async function fetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const thumbnailIngest = await dispatchThumbnailIngestRequest(request, env);
  if (thumbnailIngest) return thumbnailIngest;
  const rendererApi = await dispatchThumbnailRendererApi(request, env);
  if (rendererApi) return rendererApi;
  const incoming = dispatchIncomingPublicRequest(request, env, ctx);
  if (incoming) return await incoming;
  return app.fetch(request, env, ctx);
}
async function queue(batch: MessageBatch<R2Notification | ThumbnailJobMessage>, env: Env): Promise<void> {
  if (batch.queue === env.THUMBNAIL_DLQ_NAME) return consumeThumbnailDeadLetters(batch, env);
  if (batch.queue === env.THUMBNAIL_QUEUE_NAME) return consumeThumbnailJobs(batch, env);
  if (batch.queue === env.FILE_EVENTS_QUEUE_NAME) return consumeFileEvents(batch as MessageBatch<R2Notification>, env);
  throw new Error("Unrecognized queue binding");
}
export default {
  fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<Env, R2Notification | ThumbnailJobMessage>;
export { R2CrudWorkflow } from "./r2-crud";
export { IncomingUploadLifecycleWorkflow } from "./incoming";
export { DropboxImportWorkflow } from "./dropbox-import";
export { ThumbnailRendererContainer } from "./thumbnail-renderer-container";
export { dispatchThumbnailRendererApi } from "./thumbnail-renderer-api";
