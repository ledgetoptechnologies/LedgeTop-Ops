import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { isMovedSourceMarker } from "@ltds/shared";
import type {
  ClientDelegatedShareSignerRequestV1,
  ClientViewerSessionRequestV1,
  ClientViewerShareAuthorizationV1,
  ClientViewerShareCreateRequestV1,
} from "@ltds/shared";
import { z } from "zod";
import { projectAccessTermsInputSchema } from './project-access-terms';
import type { Env } from "../types";
import { clientPortalRequestOriginAllowed, configuredClientPortalOrigins } from "../origin-policy";
import { serveAuthorizedThumbnail } from "../thumbnails";
import { appendAuthenticatedContentStart, authenticatedContentAuditRequired } from "./authenticated-content-audit";
import {
  d1ClientPortalRepository,
  NativeNotificationAuthorizationOverflowError,
} from "./repository";
import { clientFeedbackSchemaAvailable, createClientFeedbackRouter } from "./feedback-routes";
import {createClientNotificationHistoryRouter} from './notification-history';
import type {
  ClientPortalRepository,
  ClientPortalSession,
  ClientPricingHintProvider,
  ResolveClientPrincipal,
  VerifiedClientPrincipal,
} from "./types";
import {
  ClientAccessConfigurationError,
  clientAccessConfiguration,
  resolveCloudflareClientPrincipal,
} from "./access-identity";
import { validateRequestArea } from "./request-area";
import { ServiceCatalogPageError } from "./service-catalog-page";
import { changedAssignedServices, readServiceAssignmentPolicy, serviceAssignmentPolicyProofStillCurrent,
  serviceAssignmentRequestPolicyEnabled, ServiceAssignmentPolicyUnavailableError,
  type ServiceAssignmentPolicyProof } from "./service-assignment-policy";
import {
  abortRequestAttachment,
  canonicalRequestAttachmentEtag,
  checkpointRequestAttachment,
  completeRequestAttachment,
  getAuthorizedRequestAttachmentContext,
  getSubmittedRequestAttachment,
  initializeRequestAttachment,
  listRequestAttachments,
  listSubmittedRequestAttachments,
  issueNativeRequestAttachmentPartLease,
  presignRequestAttachmentPart,
  requestAttachmentCheckpoints,
  requestAttachmentPartLength,
  requestAttachmentsAvailable,
  REQUEST_ATTACHMENT_PART_BYTES,
} from "./request-attachments";
import {
  acceptPortalWorkspaceInvitation,
  authorizePortalWorkspaceCapability,
  authorizeEffectiveWorkspaceDraft,
  authorizeEffectiveWorkspaceNotification,
  authorizeEffectiveWorkspaceProject,
  authorizeEffectiveWorkspaceRequest,
  authorizeEffectiveWorkspaceRoot,
  type EffectivePortalWorkspaceContext,
  listPortalWorkspaceHierarchy,
  listPortalWorkspaces,
  PORTAL_WORKSPACE_HEADER,
  portalHierarchyV2Enabled,
  portalIdentityAccepted,
  resolveEffectivePortalWorkspaceContext,
  resolveNativePortalWorkspaceReadContext,
} from "./workspace-v2";
import { nativeRequestSchemaReady, nativeServiceRequestsEnabled } from "./native-request-authority";
import {
  authorizeClientShareDelegation,
  clientDelegatedShareCreationCapability,
  consumeClientDelegatedShareRate,
  listClientDelegatedShares,
  listClientDelegatedShareTargets,
  revokeClientDelegatedShare,
  verifyAndRecordClientDelegatedShareSignerResult,
} from "./delegated-shares";
import {
  changeWorkspacePeerAdministrator,
  createWorkspaceInvitation,
  listWorkspaceAccess,
  revokeWorkspaceInvitation,
  suspendWorkspaceMember,
  workspaceMembershipManagementEnabled,
  workspacePeerAdminEnabled,
} from "./workspace-memberships";
import { invitationEmailDeliveryEnabled } from "./invitation-email";
import {listOwnWorkspaceInvitationRequests,cancelWorkspaceInvitationRequest} from './workspace-invitation-requests';
import { portalHierarchyRelationsEnabled } from "./hierarchy-relations";
import {
  resolveProjectAlphaPricingAuthorizationContext,
  type ProjectAlphaPricingAuthorizationContextResolver,
} from "./project-alpha-pricing-hint";
import { clientPortalNotificationsAvailable } from "./schema-readiness";
import { notificationMigrationMaintenanceActive, notificationMigrationMaintenanceResponse } from "./notification-migration-maintenance";
import { readClientRequestReadiness } from "./request-readiness";
import { createNativePortalWorkspaceRouter } from "./native-portal-resources";
import {createWorkspaceAddressContact,deleteWorkspaceAddressContact,listWorkspaceAddressContacts,readWorkspaceAddressContact,
  updateWorkspaceAddressContact,workspaceAddressBookAvailable} from './workspace-address-book';

interface ClientPortalDependencies {
  resolvePrincipal?: ResolveClientPrincipal;
  repository?: ClientPortalRepository;
  pricingHintProvider?: ClientPricingHintProvider;
  pricingAuthorizationContextResolver?: ProjectAlphaPricingAuthorizationContextResolver;
  notificationSchemaAvailable?: (env: Env) => Promise<boolean>;
  feedbackSchemaAvailable?: (env: Env) => Promise<boolean>;
}

type ClientPortalVariables = {
  clientSession: ClientPortalSession;
  clientPrincipal: VerifiedClientPrincipal;
  clientWorkspace: EffectivePortalWorkspaceContext | null;
};
type ClientPortalContext = Context<{ Bindings: Env; Variables: ClientPortalVariables }>;

const MAX_SERVICE_REQUEST_BYTES = 16 * 1024;
const MAX_SERVICE_REQUEST_DRAFT_BYTES = 48 * 1024;
const SERVICE_REQUEST_RATE_LIMIT_SECONDS = 60;
const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const catalogSourceVersion = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const serviceRequestBody = z
  .object({
    projectId: opaqueId.nullable().optional(),
    parentRequestId: opaqueId.nullable().optional(),
    requestType: z.enum(["flight", "service"]),
    title: z.string().trim().min(1).max(160),
    details: z.string().trim().min(1).max(5000),
    location: z.string().trim().min(1).max(240).nullable().optional(),
    preferredStartAt: z.iso.datetime({ offset: true }).nullable().optional(),
    serviceCategory: z.string().trim().min(1).max(100).nullable().optional(),
    deliverables: z.string().trim().min(1).max(2000).nullable().optional(),
    siteContactName: z.string().trim().min(1).max(160).nullable().optional(),
    siteContactEmail: z.string().trim().email().max(320).nullable().optional(),
    siteContactPhone: z.string().trim().min(3).max(64).nullable().optional(),
    desiredCompletionAt: z.iso.datetime({ offset: true }).nullable().optional(),
    latitude: z.number().finite().min(-90).max(90).nullable().optional(),
    longitude: z.number().finite().min(-180).max(180).nullable().optional(),
    areaGeoJson: z.unknown().nullable().optional(),
    poiPoints: z
      .array(
        z
          .object({
            longitude: z.number().finite().min(-180).max(180),
            latitude: z.number().finite().min(-90).max(90),
            label: z.string().trim().min(1).max(100).nullable().optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    services: z.array(z.object({
      publicId: opaqueId,
      sourceVersion: catalogSourceVersion,
      answers: z.record(z.string().max(64), z.unknown()),
    }).strict()).max(10).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.latitude === null || value.latitude === undefined) !==
      (value.longitude === null || value.longitude === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Latitude and longitude must be provided together",
      });
    }
    try {
      validateRequestArea(value.areaGeoJson);
    } catch {
      context.addIssue({
        code: "custom",
        message: "The selected map area is invalid",
      });
    }
  });
const invitationBody = z
  .object({
    email: z.string().trim().email().max(320),
    projectIds: z.array(opaqueId).max(100).default([]),
  })
  .strict();
const estimateResponseBody = z
  .object({
    estimateId: opaqueId,
    response: z.enum(["accept", "request_change"]),
    note: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.response === "request_change" && !value.note)
      context.addIssue({
        code: "custom",
        message: "Describe the requested change",
      });
  });
const serviceRequestDraftBody = z
  .object({
    projectId: opaqueId.nullable(),
    requestType: z.enum(["flight", "service"]),
    title: z.string().trim().max(160),
    details: z.string().trim().max(5000),
    location: z.string().trim().min(1).max(240).nullable(),
    preferredStartAt: z.iso.datetime({ offset: true }).nullable(),
    deliverables: z.string().trim().min(1).max(2000).nullable(),
    siteContactName: z.string().trim().min(1).max(160).nullable(),
    siteContactEmail: z.string().trim().email().max(320).nullable(),
    siteContactPhone: z.string().trim().min(3).max(64).nullable(),
    desiredCompletionAt: z.iso.datetime({ offset: true }).nullable(),
    latitude: z.number().finite().min(-90).max(90).nullable(),
    longitude: z.number().finite().min(-180).max(180).nullable(),
    areaGeoJson: z.unknown().nullable(),
    poiPoints: z.array(z.object({
      longitude: z.number().finite().min(-180).max(180),
      latitude: z.number().finite().min(-90).max(90),
      label: z.string().trim().min(1).max(100).nullable(),
    }).strict()).max(20),
    services: z.array(z.object({
      publicId: opaqueId,
      sourceVersion: catalogSourceVersion,
      answers: z.record(z.string().max(64), z.unknown()),
    }).strict()).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.latitude === null) !== (value.longitude === null))
      context.addIssue({ code: "custom", message: "Latitude and longitude must be provided together" });
    if (new Set(value.services.map(service => service.publicId)).size !== value.services.length)
      context.addIssue({ code: "custom", message: "Each service can be selected only once" });
    try { validateRequestArea(value.areaGeoJson); }
    catch { context.addIssue({ code: "custom", message: "The selected map area is invalid" }); }
  });
const draftVersionHeader = z.coerce.number().int().positive();
const delegatedShareCreateBody = z.object({
  delegationId: opaqueId,
  folderTargetId: opaqueId,
  label: z.string().trim().min(1).max(160).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }),
  accessCode: z.string().min(8).max(128).optional(),
}).strict();
const pricingHint = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("starting_at"), currency: z.string().regex(/^[A-Z]{3}$/),
    startingAtMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    disclaimer: z.string().trim().min(1).max(500), basisVersion: z.string().trim().min(1).max(128), validUntil: z.iso.datetime({ offset: true }),
  }).strict(),
  z.object({
    kind: z.literal("typical_range"), currency: z.string().regex(/^[A-Z]{3}$/),
    minimumMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    maximumMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    disclaimer: z.string().trim().min(1).max(500), basisVersion: z.string().trim().min(1).max(128), validUntil: z.iso.datetime({ offset: true }),
  }).strict().refine(value => value.maximumMinor >= value.minimumMinor),
]);
const notificationActionBody = z.object({ action: z.enum(["read", "dismiss"]) }).strict();
const viewerAssociationId = opaqueId;
const viewerShareCreateBody = z.object({
  label: z.string().trim().max(120).nullable().default(null),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  password: z.string().min(8).max(128).optional(),
  displayUnits: z.enum(["imperial", "metric"]),
}).strict();
const attachmentInitBody = z.object({
  clientUploadId: idempotencyKey,
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
}).strict();
const attachmentPartTicketBody = z.object({ partNumber: z.number().int().min(1).max(4) }).strict();
const attachmentCheckpointBody = z.object({ etag: z.string().min(1).max(128), size: z.number().int().positive(),
  ticketNonce: z.string().min(32).max(128).optional() }).strict();
const attachmentCompleteBody = z.object({ parts: z.array(z.object({
  partNumber: z.number().int().min(1).max(4), etag: z.string().min(1).max(128),
}).strict()).min(1).max(4) }).strict();
const workspaceInvitationAcceptanceBody = z.object({
  token: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const addressContactFields=z.object({displayName:z.string().trim().min(1).max(160),email:z.string().trim().email().max(320),
 phone:z.string().trim().min(3).max(64).nullable(),company:z.string().trim().min(1).max(160).nullable(),
 roleOrTrade:z.string().trim().min(1).max(160).nullable()}).strict();
const addressContactUpdate=addressContactFields.extend({expectedVersion:z.number().int().positive()}).strict();
const addressContactDelete=z.object({expectedVersion:z.number().int().positive()}).strict();
const addressContactSearch=z.object({q:z.string().max(100),cursor:z.string().max(4096).nullable()}).strict();
const workspaceInvitationBody = z.object({
  email: z.string().trim().email().max(320),
  addressContact:z.object({id:opaqueId,expectedVersion:z.number().int().positive()}).strict().optional(),
  projectPublicId: opaqueId.optional(),
  targetScope: z.object({
    type: z.enum(["organization", "department", "client", "project"]),
    publicId: opaqueId,
  }).strict().optional(),
  organizationWide: z.boolean().optional(),
  confirmOrganizationWide: z.boolean().optional(),
  accessTerms: projectAccessTermsInputSchema.optional(),
  expectedInvitationPolicyVersion:z.number().int().nonnegative().optional(),
  capabilities: z.array(z.enum(["workspace.view", "delivery.view", "request.create"])).min(1).max(3),
}).strict().superRefine((input, context) => {
  if (input.targetScope?.type === "organization" && input.confirmOrganizationWide !== true) {
    context.addIssue({
      code: "custom",
      path: ["confirmOrganizationWide"],
      message: "Organization-wide invitations require explicit confirmation",
    });
  }
});

const cloudflareClientIdentityProvider: ResolveClientPrincipal =
  resolveCloudflareClientPrincipal;

function requireSameRequestOrigin(
  request: Request,
  env: Env,
): void {
  if (!clientPortalRequestOriginAllowed(request,env)) {
    throw new HTTPException(403, { message: "This request is not allowed" });
  }
}

async function readBoundedJson(request: Request, maximumBytes = MAX_SERVICE_REQUEST_BYTES): Promise<unknown> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new HTTPException(400, { message: "Content-Length is invalid" });
    if (length > maximumBytes)
      throw new HTTPException(413, {
        message: "The service request is too large",
      });
  }
  if (!request.body)
    throw new HTTPException(400, {
      message: "A valid JSON request body is required",
    });

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new HTTPException(413, {
        message: "The service request is too large",
      });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HTTPException(400, {
      message: "A valid JSON request body is required",
    });
  }
}

export function createClientPortalRouter(
  dependencies: ClientPortalDependencies = {},
) {
  const resolvePrincipal =
    dependencies.resolvePrincipal ?? cloudflareClientIdentityProvider;
  const repository = dependencies.repository ?? d1ClientPortalRepository;
  const notificationSchemaAvailable = dependencies.notificationSchemaAvailable ??
    (dependencies.repository ? async () => true : clientPortalNotificationsAvailable);
  const feedbackSchemaAvailable = dependencies.feedbackSchemaAvailable ??
    (dependencies.repository ? async () => false : clientFeedbackSchemaAvailable);
  const router = new Hono<{
    Bindings: Env;
    Variables: ClientPortalVariables;
  }>();

  router.use("*", async (c, next) => {
    if (c.env.CLIENT_PORTAL_ENABLED !== "true")
      return c.json({ error: "Not found" }, 404);
    const portalOrigins = configuredClientPortalOrigins(c.env);
    if (!portalOrigins)
      throw new HTTPException(503, { message: "Client portal is not configured" });
    if (!portalOrigins.includes(new URL(c.req.url).origin))
      return c.json({ error: "Not found" }, 404);
    // The production adapter is configuration-gated before it looks at any
    // client header. Tests can inject an adapter without needing Cloudflare.
    try {
      if (!dependencies.resolvePrincipal) clientAccessConfiguration(c.env);
    } catch (error) {
      if (error instanceof ClientAccessConfigurationError)
        throw new HTTPException(503, {
          message: "Client portal authentication is not configured",
        });
      throw error;
    }
    const principal = await resolvePrincipal(c.req.raw, c.env);
    if (!principal)
      throw new HTTPException(401, {
        message: "Client authentication is required",
      });
    const invitationRequest = /\/v2\/invitations(?:\/|$)/.test(c.req.path);
    if (portalHierarchyV2Enabled(c.env) && !invitationRequest && !(await portalIdentityAccepted(c.env, principal)))
      throw new HTTPException(403, { message: "Client access is not provisioned" });
    let session = await repository.resolveSession(c.env, principal);
    const workspaceV2Request = /\/v2\/(?:workspaces|invitations)(?:\/|$)/.test(c.req.path);
    let workspace: EffectivePortalWorkspaceContext | null = null;
    if (portalHierarchyV2Enabled(c.env) && !workspaceV2Request) {
      const selectedWorkspace = c.req.header(PORTAL_WORKSPACE_HEADER);
      const sessionBootstrap = c.req.path.endsWith("/session") && !selectedWorkspace;
      if (!sessionBootstrap) {
        workspace = selectedWorkspace
          ? await resolveEffectivePortalWorkspaceContext(c.env, principal, selectedWorkspace)
          : null;
        if (workspace) {
          session = {
            accountId: workspace.legacyAccountId,
            identityId: workspace.legacyIdentityId,
            workspaceId: workspace.workspaceId,
            principalIssuer: principal.issuer,
            principalSubject: principal.subject,
            principalEmail: principal.email,
            displayName: workspace.displayName,
            role: workspace.role,
            canViewBilling: workspace.canViewBilling,
          };
        } else {
          const nativeRequestPath = /^\/(?:request-readiness|service-catalog(?:\/page)?|service-request-drafts|service-requests|notifications|notification-history)(?:\/|$)/
            .test(c.req.path);
          const notificationHistoryRequest=c.req.path==='/notification-history';
          const native = selectedWorkspace && nativeRequestPath && (notificationHistoryRequest||nativeServiceRequestsEnabled(c.env))
            ? await resolveNativePortalWorkspaceReadContext(c.env, principal, selectedWorkspace)
            : null;
          if (!native) throw new HTTPException(403, { message: "Select an authorized client workspace" });
          if (!notificationHistoryRequest&&!await nativeRequestSchemaReady(c.env) && !c.req.path.endsWith("/request-readiness"))
            throw new HTTPException(503, { res: Response.json({
              error: "Native service requests are temporarily unavailable until storage migration is ready.",
              code: "request_unavailable",
            }, { status: 503 }) });
          session = {
            accountId: "",
            identityId: "",
            workspaceId: native.workspaceId,
            principalIssuer: principal.issuer,
            principalSubject: principal.subject,
            principalEmail: principal.email,
            nativeSourceId: native.sourceId,
            nativePortalIdentityId: native.identityId,
            displayName: native.displayName,
            role: "member",
            canViewBilling: false,
          };
        }
      }
    }
    if (!session && !(portalHierarchyV2Enabled(c.env) && (workspaceV2Request || c.req.path.endsWith("/session"))))
      throw new HTTPException(403, { message: "Client access is not provisioned" });
    // Workspace-v2 can resolve a global identity that deliberately has no
    // single legacy account. The sentinel is unreachable from legacy routes.
    c.set("clientSession", session ?? {
      accountId: "",
      identityId: "",
      displayName: "",
      role: "member",
      canViewBilling: false,
    });
    c.set("clientPrincipal", principal);
    c.set("clientWorkspace", workspace);
    if (notificationMigrationMaintenanceActive(c.env) && ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
      (/^\/(?:service-request-drafts|service-requests)(?:\/|$)/.test(c.req.path) || /^\/notifications\//.test(c.req.path)))
      return notificationMigrationMaintenanceResponse();
    await next();
  });

  // Native resources use the verified global principal and their own exact
  // workspace context. They must never manufacture a legacy account session.
  router.route("/v2/workspaces", createNativePortalWorkspaceRouter());

  router.get("/session", async (c) => {
    const session = c.get("clientSession");
    const workspace = selectedWorkspace(c);
    let viewerDisplayUnits: "imperial" | "metric" = "imperial";
    if (workspace) {
      try {
        const stored = await c.env.DELIVERY_DB.withSession("first-primary").prepare(
          "SELECT display_units FROM viewer_client_preferences WHERE identity_id=?",
        ).bind(workspace.identityId).first<string>("display_units");
        viewerDisplayUnits = stored === "metric" ? "metric" : "imperial";
      } catch (error) {
        if (!/no such table: viewer_client_preferences/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    return c.json({
      account: { id: session.accountId, displayName: session.displayName },
      viewerDisplayUnits,
      capabilities: {
        feedback: await feedbackSchemaAvailable(c.env),
        manageTeam:
          c.env.CLIENT_PORTAL_TEAM_ENABLED === "true" &&
          !portalHierarchyV2Enabled(c.env) &&
          session.role === "manager",
        requestV2: c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED === "true",
        requestAttachments:
          c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED === "true" &&
          requestAttachmentsAvailable(c.env),
        workspaceHierarchyV2: portalHierarchyV2Enabled(c.env),
        workspaceMembershipManagement: workspaceMembershipManagementEnabled(c.env),
        hierarchyScopedInvitations:
          workspaceMembershipManagementEnabled(c.env) &&
          portalHierarchyRelationsEnabled(c.env),
        invitationEmailDelivery: invitationEmailDeliveryEnabled(c.env),
        delegatedShares: clientDelegatedShareCreationCapability(c.env).enabled,
        viewer: c.env.CLIENT_VIEWER_ENABLED === "true" &&
          portalHierarchyV2Enabled(c.env) && Boolean(c.env.VIEWER_SESSION_ISSUER),
        viewerShares: c.env.CLIENT_VIEWER_SHARES_ENABLED === "true" &&
          portalHierarchyV2Enabled(c.env) && Boolean(c.env.VIEWER_SESSION_ISSUER),
        viewBilling: session.canViewBilling,
      },
    });
  });
  router.get("/map-config", (c) =>
    c.json({ mapboxPublicToken: c.env.MAPBOX_PUBLIC_TOKEN || null }),
  );

  router.get("/request-readiness", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const projectIds = c.req.queries("projectId");
    const parsedProject = projectIds === undefined ? null : opaqueId.safeParse(projectIds[0]);
    if ((projectIds && projectIds.length !== 1) || (parsedProject && !parsedProject.success))
      throw new HTTPException(400, { message: "Request project target is invalid" });
    const projectId = parsedProject?.success ? parsedProject.data : null;
    const backendConfigured = c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED === "true"
      ? Boolean(repository.listServiceCatalog && repository.createServiceRequestDraft &&
        repository.saveServiceRequestDraft && repository.submitServiceRequestDraft)
      : typeof repository.createServiceRequest === "function" && typeof c.env.PUBLIC_BULK_RATE_LIMITER?.limit === "function";
    return c.json(await readClientRequestReadiness(
      c.env, c.get("clientPrincipal"), c.get("clientSession"), selectedWorkspace(c), projectId, backendConfigured,
    ));
  });

  router.get("/v2/workspaces", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    return c.json({ workspaces: await listPortalWorkspaces(c.env, c.get("clientPrincipal")) });
  });
  router.patch("/viewer/preferences", async c => {
    if (c.env.CLIENT_VIEWER_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspace = selectedWorkspace(c);
    const value = z.object({ displayUnits: z.enum(["imperial", "metric"]) }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!workspace || !value.success) throw new HTTPException(400, { message: "Viewer preference is invalid" });
    await c.env.DELIVERY_DB.prepare(`INSERT INTO viewer_client_preferences(identity_id,display_units,updated_at)
      VALUES(?,?,datetime('now')) ON CONFLICT(identity_id) DO UPDATE SET
      display_units=excluded.display_units,updated_at=excluded.updated_at`)
      .bind(workspace.identityId, value.data.displayUnits).run();
    return c.json({ displayUnits: value.data.displayUnits });
  });

  function selectedWorkspace(c: { get(name: "clientWorkspace"): EffectivePortalWorkspaceContext | null }): EffectivePortalWorkspaceContext | null {
    return c.get("clientWorkspace");
  }

  function rejectUnsupportedNativeRequestMutation(c: ClientPortalContext, operation: string): void {
    if (!c.get("clientSession").nativeSourceId) return;
    throw new HTTPException(501, { res: Response.json({
      error: `${operation} is not yet available for this Project Alpha workspace.`,
      code: "native_operation_unavailable",
    }, { status: 501 }) });
  }

  async function requireLegacyTeamManagement(c: ClientPortalContext): Promise<void> {
    if (!portalHierarchyV2Enabled(c.env)) return;
    const workspace = selectedWorkspace(c);
    if (!workspace || !workspaceMembershipManagementEnabled(c.env) ||
      !(await authorizePortalWorkspaceCapability(
        c.env,
        c.get("clientPrincipal"),
        workspace.workspaceId,
        "member.manage",
        { scopeType: "workspace", publicId: workspace.workspaceId },
      ))) {
      throw new HTTPException(403, { message: "Team management is not permitted" });
    }
  }

  async function authorizeProject(
    c: ClientPortalContext,
    capability: "delivery.view" | "request.create" | "viewer.share.create",
    projectId: string,
  ): Promise<boolean> {
    const workspace = selectedWorkspace(c);
    return !workspace || authorizeEffectiveWorkspaceProject(
      c.env, c.get("clientPrincipal"), workspace, capability, projectId,
    );
  }

  async function authorizeRoot(
    c: ClientPortalContext,
    capability: "delivery.view" | "request.create",
  ): Promise<boolean> {
    const workspace = selectedWorkspace(c);
    return !workspace || authorizeEffectiveWorkspaceRoot(
      c.env, c.get("clientPrincipal"), workspace, capability,
    );
  }

  router.post("/v2/workspaces/:workspaceId/activate", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    if (!workspaceId.success) throw new HTTPException(404, { message: "Workspace not found" });
    const workspace = (await listPortalWorkspaces(c.env, c.get("clientPrincipal")))
      .find(candidate => candidate.id === workspaceId.data);
    if (!workspace) throw new HTTPException(404, { message: "Workspace not found" });
    // Selection is client-held; every later request still reauthorizes the
    // workspace. This endpoint intentionally creates no durable ambient scope.
    return c.json({ workspace });
  });

  router.get("/v2/workspaces/:workspaceId/hierarchy", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    const search = c.req.query("q") ?? null;
    if (!workspaceId.success || (search !== null && search.length > 100))
      throw new HTTPException(400, { message: "Hierarchy query is invalid" });
    const entries = await listPortalWorkspaceHierarchy(
      c.env,
      c.get("clientPrincipal"),
      workspaceId.data,
      search,
    );
    if (!entries) throw new HTTPException(404, { message: "Workspace not found" });
    return c.json({ entries });
  });

  router.get("/v2/workspaces/:workspaceId/delegated-shares", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    if (!workspaceId.success) throw new HTTPException(404, { message: "Workspace not found" });
    const shares = await listClientDelegatedShares(c.env, c.get("clientPrincipal"), workspaceId.data);
    if (!shares) throw new HTTPException(404, { message: "Workspace not found" });
    return c.json({ shares, creation: clientDelegatedShareCreationCapability(c.env) });
  });

  router.get("/v2/workspaces/:workspaceId/delegated-share-targets", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    if (!workspaceId.success) throw new HTTPException(404, { message: "Workspace not found" });
    const targets = await listClientDelegatedShareTargets(c.env, c.get("clientPrincipal"), workspaceId.data);
    if (!targets) throw new HTTPException(404, { message: "Workspace not found" });
    return c.json({ targets, creation: clientDelegatedShareCreationCapability(c.env) });
  });

  router.post("/v2/workspaces/:workspaceId/delegated-shares", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const input = delegatedShareCreateBody.safeParse(await readBoundedJson(c.req.raw, 4096));
    if (!workspaceId.success || !key.success || !input.success)
      throw new HTTPException(400, { message: "Delegated share request is invalid" });
    // Check rollout and the named Operations binding before authorization or
    // durable rate accounting. An unavailable signer creates no partial row.
    const creation = clientDelegatedShareCreationCapability(c.env);
    if (!creation.enabled)
      throw new HTTPException(503, { message: "Client share creation is not configured" });
    const delegation = await authorizeClientShareDelegation(
      c.env, c.get("clientPrincipal"), workspaceId.data,
      input.data.delegationId, input.data.folderTargetId,
    );
    if (!delegation) throw new HTTPException(404, { message: "Share delegation not found" });
    if (!(await consumeClientDelegatedShareRate(c.env, workspaceId.data, delegation.identityId, "create")))
      throw new HTTPException(429, { message: "Too many share requests" });
    const signerRequest: ClientDelegatedShareSignerRequestV1 = {
      protocolVersion: 1,
      workspaceId: workspaceId.data,
      delegationId: delegation.delegationId,
      expectedDelegationVersion: delegation.delegationVersion,
      createdByIdentityId: delegation.identityId,
      entitlementId: delegation.entitlementId,
      expectedEntitlementVersion: delegation.entitlementVersion,
      folderBindingId: delegation.folderBindingId,
      expectedBindingSourceVersion: delegation.folderBindingSourceVersion,
      folderTargetId: delegation.folderTargetId,
      label: input.data.label?.trim() ?? null,
      expiresAt: new Date(input.data.expiresAt).toISOString(),
      ...(input.data.accessCode ? { accessCode: input.data.accessCode } : {}),
      idempotencyKey: key.data,
    };
    let signerResult: unknown;
    try {
      signerResult = await c.env.CLIENT_DELEGATED_SHARE_SIGNER!.createClientDelegatedShare(signerRequest);
    } catch {
      throw new HTTPException(503, { message: "Client share creation is temporarily unavailable" });
    }
    if (!signerResult || typeof signerResult !== "object" || !("ok" in signerResult))
      throw new HTTPException(503, { message: "Client share creation is temporarily unavailable" });
    if (signerResult.ok !== true) {
      const code = "code" in signerResult ? signerResult.code : null;
      if (code === "invalid_request") throw new HTTPException(400, { message: "Delegated share request is invalid" });
      if (code === "idempotency_conflict") throw new HTTPException(409, { message: "Idempotency-Key was already used for a different share request" });
      if (code === "denied") throw new HTTPException(404, { message: "Share delegation not found" });
      throw new HTTPException(503, { message: "Client share creation is temporarily unavailable" });
    }
    const verified = await verifyAndRecordClientDelegatedShareSignerResult(
      c.env, delegation, signerRequest, signerResult,
    );
    if (!verified)
      throw new HTTPException(503, { message: "Client share creation is temporarily unavailable" });
    return c.json({
      share: verified.share,
      replayed: verified.replayed,
    }, 201);
  });

  router.delete("/v2/workspaces/:workspaceId/delegated-shares/:shareId", async (c) => {
    if (!portalHierarchyV2Enabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    const shareId = opaqueId.safeParse(c.req.param("shareId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!workspaceId.success || !shareId.success || !key.success)
      throw new HTTPException(400, { message: "Share revocation is invalid" });
    const outcome = await revokeClientDelegatedShare(
      c.env, c.get("clientPrincipal"), workspaceId.data, shareId.data, key.data,
    );
    if (outcome === "denied") throw new HTTPException(404, { message: "Share not found" });
    return c.json({ revoked: true, replayed: outcome === "replayed" });
  });

  router.get("/v2/workspaces/:workspaceId/access", async (c) => {
    if (!workspaceMembershipManagementEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    if (!workspaceId.success) throw new HTTPException(404, { message: "Workspace not found" });
    const access = await listWorkspaceAccess(c.env, c.get("clientPrincipal"), workspaceId.data);
    if (!access) throw new HTTPException(404, { message: "Workspace not found" });
    return c.json(access);
  });

  router.post("/v2/workspaces/:workspaceId/invitations", async (c) => {
    if (!workspaceMembershipManagementEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const input = workspaceInvitationBody.safeParse(await readBoundedJson(c.req.raw, 4096));
    if (!workspaceId.success || !key.success || !input.success) throw new HTTPException(400, { message: "Invitation is invalid" });
    const result = await createWorkspaceInvitation(c.env, c.get("clientPrincipal"), workspaceId.data, input.data, key.data,
      {emailDeliveryAvailable:invitationEmailDeliveryEnabled(c.env)});
    if (result.outcome === "denied") throw new HTTPException(404, { message: "Workspace not found" });
    if (result.outcome === "invalid") throw new HTTPException(400, { message: "Invitation is invalid" });
    if (result.outcome === "conflict") throw new HTTPException(409, { message: "Idempotency key was already used" });
    if (result.outcome === "rate_limited") throw new HTTPException(429, { message: "Too many invitations. Try again later." });
    if (result.outcome === "policy_disabled") throw new HTTPException(403, { message: "invitation_policy_disabled" });
    if (result.outcome === "approval_required") throw new HTTPException(409, { message: "invitation_approval_required" });
    if (result.outcome === 'secondary_approval_unsupported') throw new HTTPException(409,{message:'secondary_invitation_approval_unsupported'});
    if (result.outcome === 'mail_unavailable') throw new HTTPException(503,{message:'Invitation email is not configured'});
    return c.json(result, result.outcome === "created" ? 201 : result.outcome==='approval_requested'?202:200);
  });

  router.post('/v2/workspaces/:workspaceId/address-book/contacts/search',async(c)=>{
    if(!await workspaceAddressBookAvailable(c.env))throw new HTTPException(404,{message:'Not found'});requireSameRequestOrigin(c.req.raw,c.env);
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId')),body=addressContactSearch.safeParse(await readBoundedJson(c.req.raw,8192));
    if(!workspaceId.success||!body.success)throw new HTTPException(400,{message:'address_book_query_invalid'});
    return c.json(await listWorkspaceAddressContacts(c.env,c.get('clientPrincipal'),workspaceId.data,{q:body.data.q,cursor:body.data.cursor??undefined}));
  });
  router.get('/v2/workspaces/:workspaceId/address-book/contacts/:contactId',async(c)=>{
    if(!await workspaceAddressBookAvailable(c.env))throw new HTTPException(404,{message:'Not found'});
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId')),contactId=opaqueId.safeParse(c.req.param('contactId'));
    if(!workspaceId.success||!contactId.success)throw new HTTPException(404,{message:'Address contact not found'});
    return c.json(await readWorkspaceAddressContact(c.env,c.get('clientPrincipal'),workspaceId.data,contactId.data));
  });
  router.post('/v2/workspaces/:workspaceId/address-book/contacts',async(c)=>{
    if(!await workspaceAddressBookAvailable(c.env))throw new HTTPException(404,{message:'Not found'});requireSameRequestOrigin(c.req.raw,c.env);
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId')),key=idempotencyKey.safeParse(c.req.header('Idempotency-Key')),
      body=addressContactFields.safeParse(await readBoundedJson(c.req.raw,4096));
    if(!workspaceId.success||!key.success||!body.success)throw new HTTPException(400,{message:'address_contact_invalid'});
    const result=await createWorkspaceAddressContact(c.env,c.get('clientPrincipal'),workspaceId.data,body.data,key.data);return c.json(result,result.replayed?200:201);
  });
  router.patch('/v2/workspaces/:workspaceId/address-book/contacts/:contactId',async(c)=>{
    if(!await workspaceAddressBookAvailable(c.env))throw new HTTPException(404,{message:'Not found'});requireSameRequestOrigin(c.req.raw,c.env);
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId')),contactId=opaqueId.safeParse(c.req.param('contactId')),
      key=idempotencyKey.safeParse(c.req.header('Idempotency-Key')),body=addressContactUpdate.safeParse(await readBoundedJson(c.req.raw,4096));
    if(!workspaceId.success||!contactId.success||!key.success||!body.success)throw new HTTPException(400,{message:'address_contact_invalid'});
    return c.json(await updateWorkspaceAddressContact(c.env,c.get('clientPrincipal'),workspaceId.data,contactId.data,body.data,key.data));
  });
  router.delete('/v2/workspaces/:workspaceId/address-book/contacts/:contactId',async(c)=>{
    if(!await workspaceAddressBookAvailable(c.env))throw new HTTPException(404,{message:'Not found'});requireSameRequestOrigin(c.req.raw,c.env);
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId')),contactId=opaqueId.safeParse(c.req.param('contactId')),
      key=idempotencyKey.safeParse(c.req.header('Idempotency-Key')),body=addressContactDelete.safeParse(await readBoundedJson(c.req.raw,1024));
    if(!workspaceId.success||!contactId.success||!key.success||!body.success)throw new HTTPException(400,{message:'address_contact_invalid'});
    return c.json(await deleteWorkspaceAddressContact(c.env,c.get('clientPrincipal'),workspaceId.data,contactId.data,body.data.expectedVersion,key.data));
  });

  router.get('/v2/workspaces/:workspaceId/invitation-requests',async(c)=>{
    if(!workspaceMembershipManagementEnabled(c.env))throw new HTTPException(404,{message:'Not found'});
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId'));if(!workspaceId.success)throw new HTTPException(404,{message:'Workspace not found'});
    return c.json(await listOwnWorkspaceInvitationRequests(c.env,c.get('clientPrincipal'),workspaceId.data,c.req.query('cursor')));
  });
  router.post('/v2/workspaces/:workspaceId/invitation-requests/:requestId/cancel',async(c)=>{
    if(!workspaceMembershipManagementEnabled(c.env))throw new HTTPException(404,{message:'Not found'});
    requireSameRequestOrigin(c.req.raw,c.env);
    const workspaceId=opaqueId.safeParse(c.req.param('workspaceId')),requestId=opaqueId.safeParse(c.req.param('requestId')),
      key=idempotencyKey.safeParse(c.req.header('Idempotency-Key')),
      body=z.object({expectedVersion:z.number().int().positive()}).strict().safeParse(await readBoundedJson(c.req.raw,1024));
    if(!workspaceId.success||!requestId.success||!key.success||!body.success)throw new HTTPException(400,{message:'invitation_request_invalid'});
    return c.json(await cancelWorkspaceInvitationRequest(c.env,c.get('clientPrincipal'),{workspaceId:workspaceId.data,requestId:requestId.data,expectedVersion:body.data.expectedVersion,idempotencyKey:key.data}));
  });

  router.delete("/v2/workspaces/:workspaceId/invitations/:invitationId", async (c) => {
    if (!workspaceMembershipManagementEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    const invitationId = opaqueId.safeParse(c.req.param("invitationId"));
    if (!workspaceId.success || !invitationId.success || !(await revokeWorkspaceInvitation(c.env, c.get("clientPrincipal"), workspaceId.data, invitationId.data)))
      throw new HTTPException(404, { message: "Invitation not found" });
    return c.body(null, 204);
  });

  router.delete("/v2/workspaces/:workspaceId/members/:identityId", async (c) => {
    if (!workspaceMembershipManagementEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId = opaqueId.safeParse(c.req.param("workspaceId"));
    const identityId = opaqueId.safeParse(c.req.param("identityId"));
    if (!workspaceId.success || !identityId.success) throw new HTTPException(404, { message: "Member not found" });
    const outcome = await suspendWorkspaceMember(c.env, c.get("clientPrincipal"), workspaceId.data, identityId.data);
    if (outcome === "last_manager") throw new HTTPException(409, { message: "Transfer manager access before suspending the last manager" });
    if (outcome === "managed_source") throw new HTTPException(409, { message: "This member is managed in Project Alpha and must be removed there" });
    if (outcome !== "suspended") throw new HTTPException(404, { message: "Member not found" });
    return c.body(null, 204);
  });

  router.put("/v2/workspaces/:workspaceId/members/:identityId/manager", async (c) => {
    if (!workspacePeerAdminEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const workspaceId=opaqueId.safeParse(c.req.param("workspaceId")),identityId=opaqueId.safeParse(c.req.param("identityId"));
    const key=idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const body=z.object({manager:z.boolean(),expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict()
      .safeParse(await readBoundedJson(c.req.raw,1024));
    if(!workspaceId.success||!identityId.success||!key.success||!body.success)
      throw new HTTPException(400,{message:"Peer administrator change is invalid"});
    const result=await changeWorkspacePeerAdministrator(c.env,c.get("clientPrincipal"),workspaceId.data,identityId.data,body.data,key.data);
    if(result.outcome==='disabled'||result.outcome==='not_found'||result.outcome==='denied')throw new HTTPException(404,{message:"Workspace member not found"});
    if(result.outcome==='invalid')throw new HTTPException(400,{message:"Peer administrator change is invalid"});
    if(result.outcome==='managed_source')throw new HTTPException(409,{message:"This administrator is managed in Project Alpha and must be changed there"});
    if(result.outcome==='last_manager')throw new HTTPException(409,{message:"Appoint another administrator before removing the last administrator"});
    if(result.outcome==='ineligible')throw new HTTPException(409,{message:"This person is not eligible for organization administrator access"});
    if(result.outcome==='changed'||result.outcome==='conflict')throw new HTTPException(409,{message:"Team access changed. Refresh before trying again"});
    return c.json(result);
  });

  router.post("/v2/invitations/accept", async (c) => {
    if (!workspaceMembershipManagementEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const input = workspaceInvitationAcceptanceBody.safeParse(await readBoundedJson(c.req.raw, 1024));
    if (!input.success) throw new HTTPException(400, { message: "Invitation is invalid" });
    const outcome = await acceptPortalWorkspaceInvitation(c.env, c.get("clientPrincipal"), input.data.token);
    if (outcome === "denied") throw new HTTPException(404, { message: "Invitation not found" });
    return c.json({ accepted: true, replayed: outcome === "replayed" });
  });

  router.get("/notifications", async (c) => {
    const cursor = c.req.query("cursor") || null;
    if (cursor && !opaqueId.safeParse(cursor).success)
      throw new HTTPException(400, { message: "Cursor is invalid" });
    if (!(await notificationSchemaAvailable(c.env)))
      return c.json({ notifications: [], unreadCount: 0, cursor: null });
    let page;
    try {
      page = await repository.listNotifications(c.env, c.get("clientSession"), cursor);
    } catch (error) {
      if (error instanceof NativeNotificationAuthorizationOverflowError)
        return c.json({
          error: "Notifications are temporarily unavailable while access is reconciled.",
          code: "notification_authorization_unavailable",
        }, 503);
      throw error;
    }
    const workspace = selectedWorkspace(c);
    if (!workspace) return c.json(page);
    const authorized = (await Promise.all(page.notifications.map(async notification => ({
      notification,
      allowed: await authorizeEffectiveWorkspaceNotification(
        c.env, c.get("clientPrincipal"), workspace, notification.id,
      ),
    })))).filter(result => result.allowed).map(result => result.notification);
    // The legacy repository has already enforced recipient/account ownership;
    // v2 adds the selected-workspace entitlement intersection. Never report a
    // broader unread count than this authorized page.
    return c.json({ notifications: authorized, unreadCount: authorized.filter(item => !item.readAt).length, cursor: page.cursor });
  });

  router.patch("/notifications/:notificationId", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const notificationId = opaqueId.safeParse(c.req.param("notificationId"));
    const value = notificationActionBody.safeParse(await readBoundedJson(c.req.raw));
    if (!notificationId.success || !value.success)
      throw new HTTPException(400, { message: "Notification update is invalid" });
    if (!(await notificationSchemaAvailable(c.env)))
      return c.json({
        error: "Client notifications are temporarily unavailable",
        code: "capability_unavailable",
      }, 503);
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceNotification(
      c.env, c.get("clientPrincipal"), workspace, notificationId.data,
    ))) throw new HTTPException(404, { message: "Notification not found" });
    if (!(await repository.updateNotification(c.env, c.get("clientSession"), notificationId.data, value.data.action)))
      throw new HTTPException(404, { message: "Notification not found" });
    return c.json({ success: true });
  });

  router.get("/projects", async (c) => {
    const projects = await repository.listProjects(c.env, c.get("clientSession"));
    if (!selectedWorkspace(c)) return c.json({ projects });
    const authorized = await Promise.all(projects.map(async project => {
      const [delivery, request] = await Promise.all([
        authorizeProject(c, "delivery.view", project.id),
        authorizeProject(c, "request.create", project.id),
      ]);
      return { project: { ...project, canRequestService: project.canRequestService && request }, visible: delivery || request };
    }));
    return c.json({ projects: authorized.filter(item => item.visible).map(item => item.project) });
  });

  router.get("/projects/:projectId", async (c) => {
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    if (!projectId.success)
      throw new HTTPException(404, { message: "Project not found" });
    const [delivery, request] = await Promise.all([
      authorizeProject(c, "delivery.view", projectId.data),
      authorizeProject(c, "request.create", projectId.data),
    ]);
    if (!delivery && !request) throw new HTTPException(404, { message: "Project not found" });
    const project = await repository.getProject(
      c.env,
      c.get("clientSession"),
      projectId.data,
    );
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    return c.json({ project: { ...project, canRequestService: project.canRequestService && request } });
  });

  router.get("/projects/:projectId/files", async (c) => {
    const authStarted = performance.now();
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    if (!projectId.success)
      throw new HTTPException(404, { message: "Project not found" });
    if (!(await authorizeProject(c, "delivery.view", projectId.data)))
      throw new HTTPException(404, { message: "Project not found" });
    const authDuration = performance.now() - authStarted;
    const cursor = c.req.query("cursor") || null;
    if (cursor && cursor.length > 4096)
      throw new HTTPException(400, { message: "Cursor is invalid" });
    const folder = c.req.query("folder") || null;
    if (folder && folder.length > 4096)
      throw new HTTPException(400, { message: "Folder is invalid" });
    const listStarted = performance.now();
    const page = await repository.listProjectFiles(
      c.env,
      c.get("clientSession"),
      projectId.data,
      cursor,
      folder,
    );
    if (!page) throw new HTTPException(404, { message: "Project not found" });
    c.header("Server-Timing", `auth;dur=${authDuration.toFixed(1)}, list;dur=${(performance.now() - listStarted).toFixed(1)}`);
    return c.json(page);
  });

  router.get("/projects/:projectId/file-locations", async (c) => {
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    if (!projectId.success)
      throw new HTTPException(404, { message: "Project not found" });
    if (!(await authorizeProject(c, "delivery.view", projectId.data)))
      throw new HTTPException(404, { message: "Project not found" });
    const locations = await repository.listProjectFileLocations(
      c.env,
      c.get("clientSession"),
      projectId.data,
    );
    if (!locations)
      throw new HTTPException(404, { message: "Project not found" });
    return c.json(locations);
  });

  router.get("/past-deliveries", async (c) => {
    const authStarted = performance.now();
    if (!(await authorizeRoot(c, "delivery.view")))
      throw new HTTPException(404, { message: "Delivery archive not found" });
    const authDuration = performance.now() - authStarted;
    const cursor = c.req.query("cursor") || null;
    if (cursor && cursor.length > 1000)
      throw new HTTPException(400, { message: "Cursor is invalid" });
    const listStarted = performance.now();
    const page = await repository.listPastDeliveries(
        c.env,
        c.get("clientSession"),
        cursor,
      );
    c.header("Server-Timing", `auth;dur=${authDuration.toFixed(1)}, list;dur=${(performance.now() - listStarted).toFixed(1)}`);
    return c.json(page);
  });

  router.get("/past-delivery-locations", async (c) => {
    if (!(await authorizeRoot(c, "delivery.view")))
      throw new HTTPException(404, { message: "Delivery archive not found" });
    return c.json(await repository.listPastDeliveryLocations(c.env, c.get("clientSession")));
  });

  router.get("/projects/:projectId/models", async (c) => {
    if (c.env.CLIENT_VIEWER_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    if (!projectId.success || !(await authorizeProject(c, "delivery.view", projectId.data)))
      throw new HTTPException(404, { message: "Project not found" });
    const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT
      association.id,association.model_title,association.model_provider,
      association.viewer_model_id,association.viewer_model_version_id,association.updated_at
      FROM viewer_model_associations association
      JOIN projects project ON project.id=association.project_id AND project.active=1
        AND project.project_alpha_project_id=association.project_alpha_project_id
        AND project.source_updated_at=association.project_source_version
      WHERE association.project_id=? AND association.state='active' AND association.revoked_at IS NULL
        AND association.model_status='ready'
        AND EXISTS (SELECT 1 FROM viewer_client_grants viewer_grant
          WHERE viewer_grant.account_id=? AND viewer_grant.project_id=project.id
            AND viewer_grant.status='active' AND viewer_grant.revoked_at IS NULL
            AND (viewer_grant.authorization_expires_at IS NULL OR datetime(viewer_grant.authorization_expires_at)>datetime('now'))
            AND ((viewer_grant.scope_type='project' AND viewer_grant.include_future_published=1)
              OR (viewer_grant.scope_type='task' AND viewer_grant.association_id=association.id)))
      ORDER BY association.model_title COLLATE NOCASE,association.id LIMIT 101`)
      .bind(projectId.data, c.get("clientSession").accountId).all<{
        id: string; model_title: string; model_provider: string; viewer_model_id: string;
        viewer_model_version_id: string; updated_at: string;
      }>();
    if (rows.results.length > 100) throw new HTTPException(503, { message: "Too many 3D models are associated with this project" });
    const canShare = c.env.CLIENT_VIEWER_SHARES_ENABLED === "true" && Boolean(c.env.VIEWER_SESSION_ISSUER) &&
      await authorizeProject(c, "viewer.share.create", projectId.data);
    return c.json({ models: rows.results.map(row => ({
      associationId: row.id,
      title: row.model_title,
      provider: row.model_provider,
      modelId: row.viewer_model_id,
      modelVersionId: row.viewer_model_version_id,
      updatedAt: row.updated_at,
      canShare,
    })) });
  });

  function viewerShareAuthorization(
    c: ClientPortalContext,
    projectId: string,
    associationId: string,
  ): ClientViewerShareAuthorizationV1 | null {
    const workspace = selectedWorkspace(c);
    if (!workspace) return null;
    const principal = c.get("clientPrincipal");
    return {
      protocolVersion: 1,
      workspaceId: workspace.workspaceId,
      identityId: workspace.identityId,
      legacyAccountId: workspace.legacyAccountId,
      legacyIdentityId: workspace.legacyIdentityId,
      principalIssuer: principal.issuer,
      principalSubject: principal.subject,
      projectId,
      associationId,
    };
  }

  function viewerShareFailure(code: string): never {
    if (code === "invalid_request") throw new HTTPException(400, { message: "Viewer share request is invalid" });
    if (code === "idempotency_conflict") throw new HTTPException(409, { message: "Idempotency-Key was already used" });
    if (code === "denied" || code === "not_found") throw new HTTPException(404, { message: "Viewer share not found" });
    throw new HTTPException(503, { message: "Viewer sharing is temporarily unavailable" });
  }

  router.get("/projects/:projectId/models/:associationId/shares", async c => {
    if (c.env.CLIENT_VIEWER_ENABLED !== "true" || c.env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !c.env.VIEWER_SESSION_ISSUER)
      throw new HTTPException(404, { message: "Not found" });
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    const associationId = viewerAssociationId.safeParse(c.req.param("associationId"));
    if (!projectId.success || !associationId.success || !(await authorizeProject(c, "delivery.view", projectId.data)) ||
      !(await authorizeProject(c, "viewer.share.create", projectId.data)))
      throw new HTTPException(404, { message: "3D model not found" });
    const authorization = viewerShareAuthorization(c, projectId.data, associationId.data);
    if (!authorization) throw new HTTPException(404, { message: "3D model not found" });
    const result = await c.env.VIEWER_SESSION_ISSUER.listClientViewerShares(authorization);
    if (!result.ok) viewerShareFailure(result.code);
    return c.json({ shares: result.shares });
  });

  router.post("/projects/:projectId/models/:associationId/shares", async c => {
    if (c.env.CLIENT_VIEWER_ENABLED !== "true" || c.env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !c.env.VIEWER_SESSION_ISSUER)
      throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    const associationId = viewerAssociationId.safeParse(c.req.param("associationId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const input = viewerShareCreateBody.safeParse(await readBoundedJson(c.req.raw, 4096));
    if (!projectId.success || !associationId.success || !key.success || !input.success ||
      !(await authorizeProject(c, "delivery.view", projectId.data)) ||
      !(await authorizeProject(c, "viewer.share.create", projectId.data)))
      throw new HTTPException(404, { message: "3D model not found" });
    const authorization = viewerShareAuthorization(c, projectId.data, associationId.data);
    if (!authorization) throw new HTTPException(404, { message: "3D model not found" });
    const request: ClientViewerShareCreateRequestV1 = {
      ...authorization,
      idempotencyKey: key.data,
      label: input.data.label,
      expiresAt: input.data.expiresAt,
      displayUnits: input.data.displayUnits,
      ...(input.data.password ? { password: input.data.password } : {}),
    };
    const result = await c.env.VIEWER_SESSION_ISSUER.createClientViewerShare(request);
    if (!result.ok) viewerShareFailure(result.code);
    return c.json({ ...result.creation, replayed: result.replayed }, result.replayed ? 200 : 201);
  });

  router.delete("/projects/:projectId/models/:associationId/shares/:shareId", async c => {
    if (c.env.CLIENT_VIEWER_ENABLED !== "true" || c.env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !c.env.VIEWER_SESSION_ISSUER)
      throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    const associationId = viewerAssociationId.safeParse(c.req.param("associationId"));
    const shareId = opaqueId.safeParse(c.req.param("shareId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!projectId.success || !associationId.success || !shareId.success || !key.success)
      throw new HTTPException(400, { message: "Viewer share revocation is invalid" });
    const authorization = viewerShareAuthorization(c, projectId.data, associationId.data);
    if (!authorization) throw new HTTPException(404, { message: "Viewer share not found" });
    const result = await c.env.VIEWER_SESSION_ISSUER.revokeClientViewerShare({
      ...authorization, shareId: shareId.data, idempotencyKey: key.data,
    });
    if (!result.ok) viewerShareFailure(result.code);
    return c.json({ share: result.share, replayed: result.replayed });
  });

  router.post("/projects/:projectId/models/:associationId/session", async (c) => {
    if (c.env.CLIENT_VIEWER_ENABLED !== "true" || !c.env.VIEWER_SESSION_ISSUER)
      throw new HTTPException(404, { message: "Not found" });
    requireSameRequestOrigin(c.req.raw, c.env);
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    const associationId = viewerAssociationId.safeParse(c.req.param("associationId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const sessionPreference = z.object({ displayUnits: z.enum(["imperial", "metric"]).default("imperial") })
      .strict().safeParse(await c.req.json().catch(() => ({})));
    const workspace = selectedWorkspace(c);
    if (!projectId.success || !associationId.success || !key.success || !sessionPreference.success || !workspace ||
      !(await authorizeProject(c, "delivery.view", projectId.data)))
      throw new HTTPException(404, { message: "3D model not found" });
    const principal = c.get("clientPrincipal");
    const request: ClientViewerSessionRequestV1 = {
      protocolVersion: 1,
      workspaceId: workspace.workspaceId,
      identityId: workspace.identityId,
      legacyAccountId: workspace.legacyAccountId,
      legacyIdentityId: workspace.legacyIdentityId,
      principalIssuer: principal.issuer,
      principalSubject: principal.subject,
      projectId: projectId.data,
      associationId: associationId.data,
      idempotencyKey: key.data,
      displayUnits: sessionPreference.data.displayUnits,
    };
    const result = await c.env.VIEWER_SESSION_ISSUER.issueClientViewerSession(request);
    if (!result.ok) {
      if (result.code === "invalid_request") throw new HTTPException(400, { message: "Viewer session request is invalid" });
      if (result.code === "denied" || result.code === "not_found")
        throw new HTTPException(404, { message: "3D model not found" });
      throw new HTTPException(503, { message: "3D Viewer is temporarily unavailable" });
    }
    return c.json({
      modelId: result.modelId,
      grant: result.grant,
      grantExpiresAt: result.grantExpiresAt,
      sessionTtlSeconds: result.sessionTtlSeconds,
      redeemUrl: result.redeemUrl,
      embedUrl: result.embedUrl,
    }, 201);
  });

  async function resolveAuthorizedFile(c: any) {
    const fileId = c.req.param("fileId");
    const projectValue = c.req.query("projectId") || null;
    const projectId = projectValue ? opaqueId.safeParse(projectValue) : null;
    if (projectId && !projectId.success)
      throw new HTTPException(404, { message: "File not found" });
    if (projectId?.success) {
      if (!(await authorizeProject(c, "delivery.view", projectId.data)))
        throw new HTTPException(404, { message: "File not found" });
    } else if (!(await authorizeRoot(c, "delivery.view"))) {
      throw new HTTPException(404, { message: "File not found" });
    }
    const file = await repository.getAuthorizedFile(
      c.env,
      c.get("clientSession"),
      fileId,
      projectId?.data || null,
    );
    if (!file) throw new HTTPException(404, { message: "File not found" });
    return file;
  }

  async function recheckAuthorizedFile(c: any, expected: Awaited<ReturnType<typeof resolveAuthorizedFile>>) {
    const current = await resolveAuthorizedFile(c);
    const unchanged = current.storageKey === expected.storageKey
      && current.id === expected.id
      && current.name === expected.name
      && current.size === expected.size
      && current.contentType === expected.contentType
      && current.kind === expected.kind
      && current.previewPath === expected.previewPath
      && current.downloadPath === expected.downloadPath;
    const sameAuthority = current.etag === expected.etag
      && JSON.stringify(current.authority) === JSON.stringify(expected.authority);
    if (!unchanged || !sameAuthority) throw new HTTPException(404, { message: "File not found" });
  }

  async function authorizedFile(c: any, disposition: "inline" | "attachment") {
    const file = await resolveAuthorizedFile(c);
    const contentType = (file.contentType || "application/octet-stream")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    const safeInline =
      contentType === "application/pdf" ||
      contentType === "application/json" ||
      contentType === "text/plain" ||
      contentType === "text/csv" ||
      /^image\/(?:avif|gif|jpeg|png|webp)$/.test(contentType) ||
      /^audio\/(?:aac|flac|mpeg|ogg|wav|webm)$/.test(contentType) ||
      /^video\/(?:mp4|mpeg|ogg|quicktime|webm)$/.test(contentType);
    if (disposition === "inline" && (!file.previewPath || !safeInline))
      throw new HTTPException(415, { message: "Preview unavailable" });
    // Match the native portal's authorization fencing. No storage metadata,
    // object body, or access event may cross a revocation or replacement that
    // races the initial file lookup.
    await recheckAuthorizedFile(c, file);
    const head = await c.env.DATA_BUCKET.head(file.storageKey);
    if (!head || isMovedSourceMarker(head) || clientFileCanonicalEtag(head.httpEtag) !== clientFileCanonicalEtag(file.etag))
      throw new HTTPException(404, { message: "File not found" });
    const rangeHeader = c.req.header("Range");
    const ifRange = c.req.header("If-Range");
    let requestedRange: ClientFileRange | undefined;
    try {
      requestedRange = clientFileRange(
        !ifRange || clientFileStrongEtagMatches(ifRange, head.httpEtag) ? rangeHeader : undefined,
        head.size,
      );
    } catch {
      return new Response(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${head.size}`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    const safeName =
      file.name.replace(/[\r\n"\\]/g, "_").slice(0, 200) || "download";
    const headers = new Headers();
    head.writeHttpMetadata(headers);
    headers.set(
      "Content-Type",
      disposition === "inline" &&
        (contentType.startsWith("text/") || contentType === "application/json")
        ? "text/plain; charset=utf-8"
        : file.contentType ||
            headers.get("Content-Type") ||
            "application/octet-stream",
    );
    headers.set(
      "Content-Disposition",
      `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    headers.set("Cache-Control", "private, no-store");
    headers.set("ETag", head.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Length", String(requestedRange?.length ?? head.size));
    if (requestedRange) {
      headers.set(
        "Content-Range",
        `bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${head.size}`,
      );
    }
    await recheckAuthorizedFile(c, file);
    if (!requestedRange && disposition === "inline" && clientFileEtagMatches(c.req.header("If-None-Match"), head.httpEtag)) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (c.req.method === "HEAD") return new Response(null, { status: requestedRange ? 206 : 200, headers });
    const object = await c.env.DATA_BUCKET.get(
      file.storageKey,
      { ...(requestedRange ? { range: requestedRange } : {}), onlyIf: { etagMatches: head.etag } },
    );
    if (!object || !("body" in object) || isMovedSourceMarker(object) || object.etag !== head.etag)
      throw new HTTPException(404, { message: "File not found" });
    try {
      await recheckAuthorizedFile(c, file);
    } catch (error) {
      void object.body.cancel().catch(() => {});
      throw error;
    }
    const authorizedAt = new Date();
    let auditRequired = false;
    try {
      auditRequired = await authenticatedContentAuditRequired(c.env);
    } catch {
      void object.body.cancel().catch(() => {});
      throw new HTTPException(503, { message: "File access auditing is temporarily unavailable" });
    }
    if (auditRequired) {
      try {
        const workspace = selectedWorkspace(c);
        await appendAuthenticatedContentStart(c.env, {
          authorityMode: "legacy_delivery",
          sourceId: file.authority.sourceId,
          workspaceId: workspace?.workspaceId ?? null,
          accountId: file.authority.accountId,
          identityId: file.authority.identityId,
          projectId: file.authority.projectId,
          associationId: file.authority.associationId,
          action: disposition === "inline" ? "file.preview_requested" : "file.download_requested",
          storageKey: file.storageKey,
          contentVersion: file.etag,
        }, authorizedAt);
      } catch {
        void object.body.cancel().catch(() => {});
        throw new HTTPException(503, { message: "File access auditing is temporarily unavailable" });
      }
      try {
        await recheckAuthorizedFile(c, file);
      } catch (error) {
        void object.body.cancel().catch(() => {});
        throw error;
      }
    }
    return new Response(object.body, { status: requestedRange ? 206 : 200, headers });
  }

  router.on(["GET", "HEAD"], "/files/:fileId/preview", (c) => authorizedFile(c, "inline"));
  router.on(["GET", "HEAD"], "/files/:fileId/download", (c) => authorizedFile(c, "attachment"));
  router.on(["GET", "HEAD"], "/files/:fileId/thumbnail", async (c) => {
    const file = await resolveAuthorizedFile(c);
    if (!["image", "pdf", "video"].includes(file.kind))
      throw new HTTPException(415, { message: "Thumbnail unavailable" });
    return serveAuthorizedThumbnail(c.env, file.storageKey, {
      method: c.req.method,
      ifNoneMatch: c.req.header("If-None-Match"),
      kind: file.kind as "image" | "pdf" | "video",
    });
  });

  router.get("/projects/:projectId/deliveries", async (c) => {
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    if (!projectId.success)
      throw new HTTPException(404, { message: "Project not found" });
    if (!(await authorizeProject(c, "delivery.view", projectId.data)))
      throw new HTTPException(404, { message: "Project not found" });
    return c.json({
      deliveries: await repository.listDeliveries(
        c.env,
        c.get("clientSession"),
        projectId.data,
      ),
    });
  });

  // This is deliberately only a local-grant recheck and a same-origin redirect
  // into the existing public-share workflow. It never converts an Access
  // session into a public-share session or bypasses a share password.
  router.get("/projects/:projectId/deliveries/:shareId/handoff", async (c) => {
    const projectId = opaqueId.safeParse(c.req.param("projectId"));
    const shareId = opaqueId.safeParse(c.req.param("shareId"));
    if (!projectId.success || !shareId.success)
      throw new HTTPException(404, { message: "Delivery not found" });
    if (!(await authorizeProject(c, "delivery.view", projectId.data)))
      throw new HTTPException(404, { message: "Delivery not found" });
    const handoff = await repository.getDeliveryHandoff(
      c.env,
      c.get("clientSession"),
      projectId.data,
      shareId.data,
    );
    if (!handoff)
      throw new HTTPException(404, { message: "Delivery not found" });
    return c.redirect(`/s/${encodeURIComponent(handoff.publicId)}`, 302);
  });

  router.get("/service-requests", async (c) => {
    const requests = await repository.listServiceRequests(c.env, c.get("clientSession"));
    if (!selectedWorkspace(c)) return c.json({ requests });
    const authorized = await Promise.all(requests.map(async request => ({
      request,
      allowed: request.projectId
        ? await authorizeProject(c, "request.create", request.projectId)
        : await authorizeRoot(c, "request.create"),
    })));
    return c.json({ requests: authorized.filter(item => item.allowed).map(item => item.request) });
  });

  router.get("/service-requests/:requestId", async (c) => {
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    if (!requestId.success)
      throw new HTTPException(404, { message: "Service request not found" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(
      c.env, c.get("clientPrincipal"), workspace, requestId.data,
    ))) throw new HTTPException(404, { message: "Service request not found" });
    const request = await repository.getServiceRequest(
      c.env,
      c.get("clientSession"),
      requestId.data,
    );
    if (!request)
      throw new HTTPException(404, { message: "Service request not found" });
    return c.json({ request });
  });

  router.get("/service-requests/:requestId/attachments", async (c) => {
    if (c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    if (!requestId.success) throw new HTTPException(404, { message: "Service request not found" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(c.env, c.get("clientPrincipal"), workspace, requestId.data)))
      throw new HTTPException(404, { message: "Service request not found" });
    const rows = await listSubmittedRequestAttachments(c.env, c.get("clientSession"), requestId.data);
    if (!rows) throw new HTTPException(404, { message: "Service request not found" });
    return c.json({ attachments: rows.map(row => ({ id: row.id, name: row.original_name,
      contentType: row.content_type, size: row.actual_size ?? row.declared_size,
      downloadPath: `/api/client/service-requests/${encodeURIComponent(requestId.data)}/attachments/${encodeURIComponent(row.id)}/download`,
    })) });
  });

  router.get("/service-requests/:requestId/attachments/:attachmentId/download", async (c) => {
    if (c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    const attachmentId = opaqueId.safeParse(c.req.param("attachmentId"));
    if (!requestId.success || !attachmentId.success) throw new HTTPException(404, { message: "Attachment not found" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(c.env, c.get("clientPrincipal"), workspace, requestId.data)))
      throw new HTTPException(404, { message: "Attachment not found" });
    const row = await getSubmittedRequestAttachment(c.env, c.get("clientSession"), requestId.data, attachmentId.data);
    if (!row) throw new HTTPException(404, { message: "Attachment not found" });
    const object = await c.env.DATA_BUCKET.get(row.object_key);
    if (!object || object.size !== row.actual_size) throw new HTTPException(404, { message: "Attachment not found" });
    const safeName = row.original_name.replace(/[\r\n"\\]/g, "_").slice(0, 200) || "attachment";
    const headers = new Headers({
      "Content-Type": row.content_type,
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "ETag": object.httpEtag,
    });
    return new Response(object.body, { headers });
  });

  router.use("/service-catalog", async (c, next) => {
    if (c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    await next();
  });
  router.use("/service-catalog/*", async (c, next) => {
    if (c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    await next();
  });
  router.use("/service-request-drafts", async (c, next) => {
    if (c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    await next();
  });
  router.use("/service-request-drafts/*", async (c, next) => {
    if (c.env.CLIENT_PORTAL_REQUEST_V2_ENABLED !== "true") throw new HTTPException(404, { message: "Not found" });
    const workspace = selectedWorkspace(c);
    const relative = c.req.path.split("/service-request-drafts/", 2)[1] ?? "";
    const draftId = opaqueId.safeParse(relative.split("/", 1)[0]);
    if (workspace && (!draftId.success || !(await authorizeEffectiveWorkspaceDraft(
      c.env, c.get("clientPrincipal"), workspace, draftId.data,
    )))) throw new HTTPException(404, { message: "Service request draft not found" });
    await next();
  });

  router.get("/service-catalog", async (c) => {
    if (!repository.listServiceCatalog)
      throw new HTTPException(503, { message: "The service catalog is not configured" });
    const projectIds = c.req.queries("projectId");
    const parsedProject = projectIds === undefined ? null : opaqueId.safeParse(projectIds[0]);
    if ([...new URL(c.req.url).searchParams.keys()].some(key => key !== "projectId")
      || (projectIds && projectIds.length !== 1) || (parsedProject && !parsedProject.success))
      throw new HTTPException(400, { message: "Request project target is invalid" });
    const projectId = parsedProject?.success ? parsedProject.data : null;
    if (serviceAssignmentRequestPolicyEnabled(c.env) && (projectId
      ? !(await authorizeProject(c, "request.create", projectId))
      : !(await authorizeRoot(c, "request.create")))) throw new HTTPException(404, { message: "Project not found" });
    try {
      return c.json({ services: await repository.listServiceCatalog(c.env, c.get("clientSession"), { projectId }) });
    } catch (error) {
      if (error instanceof ServiceAssignmentPolicyUnavailableError)
        return c.json({ error: "Assigned services are temporarily unavailable.", code: "service_assignments_unavailable" }, 503);
      throw error;
    }
  });

  router.get("/service-catalog/page", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const parameters = new URL(c.req.url).searchParams;
    const limit = parameters.get("limit");
    if ([...parameters.keys()].some(key => key !== "cursor" && key !== "limit" && key !== "projectId") ||
      parameters.getAll("limit").length > 1 || parameters.getAll("cursor").length > 1 ||
      (limit !== null && !/^(?:[1-9][0-9]?|100)$/.test(limit))) {
      return c.json({ error: "The service library page is invalid.", code: "catalog_cursor_invalid" }, 400);
    }
    if (!repository.listServiceCatalogPage) {
      return c.json({ error: "Versioned service library browsing is not ready.", code: "catalog_not_ready" }, 503);
    }
    const projectValues = parameters.getAll("projectId");
    const parsedProject = projectValues.length ? opaqueId.safeParse(projectValues[0]) : null;
    if (projectValues.length > 1 || (parsedProject && !parsedProject.success))
      return c.json({ error: "Request project target is invalid.", code: "catalog_cursor_invalid" }, 400);
    const projectId = parsedProject?.success ? parsedProject.data : null;
    if (serviceAssignmentRequestPolicyEnabled(c.env) && (projectId
      ? !(await authorizeProject(c, "request.create", projectId))
      : !(await authorizeRoot(c, "request.create")))) throw new HTTPException(404, { message: "Project not found" });
    try {
      return c.json(await repository.listServiceCatalogPage(c.env, c.get("clientSession"), {
        ...(parameters.has("cursor") ? { cursor: parameters.get("cursor")! } : {}),
        ...(limit !== null ? { limit: Number(limit) } : {}),
        projectId,
      }));
    } catch (error) {
      if (error instanceof ServiceCatalogPageError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });

  router.get("/service-request-drafts", async (c) => {
    if (!repository.listServiceRequestDrafts)
      throw new HTTPException(503, { message: "Service request drafts are not configured" });
    const drafts = await repository.listServiceRequestDrafts(c.env, c.get("clientSession"));
    const workspace = selectedWorkspace(c);
    if (!workspace) return c.json({ drafts });
    const authorized: typeof drafts = [];
    for (const draft of drafts) {
      if (await authorizeEffectiveWorkspaceDraft(c.env, c.get("clientPrincipal"), workspace, draft.id)) authorized.push(draft);
    }
    return c.json({ drafts: authorized });
  });

  router.post("/service-request-drafts", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const parsed = serviceRequestDraftBody.safeParse(await readBoundedJson(c.req.raw, MAX_SERVICE_REQUEST_DRAFT_BYTES));
    if (!key.success || !parsed.success)
      throw new HTTPException(400, { message: "A valid draft and Idempotency-Key header are required" });
    if (!repository.createServiceRequestDraft)
      throw new HTTPException(503, { message: "Service request drafts are not configured" });
    if (parsed.data.projectId
      ? !(await authorizeProject(c, "request.create", parsed.data.projectId))
      : !(await authorizeRoot(c, "request.create")))
      throw new HTTPException(404, { message: "Project not found" });
    const result = await repository.createServiceRequestDraft(c.env, c.get("clientSession"), {
      ...parsed.data,
      areaGeoJson: validateRequestArea(parsed.data.areaGeoJson),
    }, key.data);
    if (!result)
      throw new HTTPException(404, { message: "Project or service catalog item not found" });
    if (result.kind === "conflict")
      throw new HTTPException(409, { message: "This Idempotency-Key was already used for different draft content" });
    if (result.kind === "catalog_changed")
      return c.json({
        error: "One or more selected services changed in the Project Alpha service library. Review and reselect them before continuing.",
        code: "catalog_changed" as const,
        servicePublicIds: result.servicePublicIds,
      }, 409);
    if (result.kind === "service_assignments_changed")
      return c.json({
        error: "One or more selected services are no longer assigned to this exact request context. Refresh and review the available services.",
        code: "service_assignments_changed" as const,
        servicePublicIds: result.servicePublicIds,
      }, 409);
    return c.json({ draft: result.draft }, result.kind === "created" ? 201 : 200);
  });

  router.get("/service-request-drafts/:draftId", async (c) => {
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    if (!draftId.success || !repository.getServiceRequestDraft)
      throw new HTTPException(404, { message: "Service request draft not found" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceDraft(c.env, c.get("clientPrincipal"), workspace, draftId.data)))
      throw new HTTPException(404, { message: "Service request draft not found" });
    const draft = await repository.getServiceRequestDraft(c.env, c.get("clientSession"), draftId.data);
    if (!draft) throw new HTTPException(404, { message: "Service request draft not found" });
    return c.json({ draft });
  });

  router.get("/service-request-drafts/:draftId/attachments", async (c) => {
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    if (!draftId.success) throw new HTTPException(404, { message: "Service request draft not found" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceDraft(c.env, c.get("clientPrincipal"), workspace, draftId.data)))
      throw new HTTPException(404, { message: "Service request draft not found" });
    const rows = await listRequestAttachments(c.env, c.get("clientSession"), draftId.data);
    if (!rows) throw new HTTPException(404, { message: "Service request draft not found" });
    return c.json({ attachments: rows.map(row => ({
      id: row.id, name: row.original_name, contentType: row.content_type, size: row.declared_size,
      status: row.status, submitted: row.submitted_request_id !== null,
    })) });
  });

  router.post("/service-request-drafts/:draftId/attachments", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const input = attachmentInitBody.safeParse(await readBoundedJson(c.req.raw));
    if (!draftId.success) throw new HTTPException(404, { message: "Service request draft not found" });
    if (!input.success) throw new HTTPException(400, { message: "The attachment upload is invalid" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceDraft(c.env, c.get("clientPrincipal"), workspace, draftId.data)))
      throw new HTTPException(404, { message: "Service request draft not found" });
    const initialized = await initializeRequestAttachment(c.env, c.get("clientSession"), draftId.data, input.data);
    return c.json({ attachmentId: initialized.row.id, name: initialized.row.original_name,
      contentType: initialized.row.content_type, size: initialized.row.declared_size,
      status: initialized.row.status, partSize: REQUEST_ATTACHMENT_PART_BYTES,
      completedParts: await requestAttachmentCheckpoints(c.env, initialized.row.id), resumed: initialized.resumed }, initialized.resumed ? 200 : 201);
  });

  router.get("/service-request-drafts/:draftId/attachments/:attachmentId", async (c) => {
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const attachmentId = opaqueId.safeParse(c.req.param("attachmentId"));
    if (!draftId.success || !attachmentId.success) throw new HTTPException(404, { message: "Attachment not found" });
    const authorized = await getAuthorizedRequestAttachmentContext(c.env, c.get("clientSession"), draftId.data, attachmentId.data);
    const row = authorized?.row;
    if (!row) throw new HTTPException(404, { message: "Attachment not found" });
    return c.json({ attachmentId: row.id, name: row.original_name, contentType: row.content_type,
      size: row.declared_size, status: row.status, partSize: REQUEST_ATTACHMENT_PART_BYTES,
      completedParts: await requestAttachmentCheckpoints(c.env, row.id) });
  });

  router.post("/service-request-drafts/:draftId/attachments/:attachmentId/part-ticket", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const attachmentId = opaqueId.safeParse(c.req.param("attachmentId"));
    const input = attachmentPartTicketBody.safeParse(await readBoundedJson(c.req.raw));
    if (!draftId.success || !attachmentId.success) throw new HTTPException(404, { message: "Attachment not found" });
    if (!input.success) throw new HTTPException(400, { message: "The attachment part is invalid" });
    const authorized = await getAuthorizedRequestAttachmentContext(c.env, c.get("clientSession"), draftId.data, attachmentId.data);
    const row = authorized?.row;
    if (!row) throw new HTTPException(404, { message: "Attachment not found" });
    if (Date.parse(row.expires_at) <= Date.now()) throw new HTTPException(410, { message: "The attachment upload expired" });
    if (row.status !== "uploading" || row.multipart_upload_id.startsWith("pending:")) throw new HTTPException(409, { message: "The attachment is not accepting parts" });
    const contentLength = requestAttachmentPartLength(row.declared_size, input.data.partNumber);
    const lease = authorized?.nativeProof
      ? await issueNativeRequestAttachmentPartLease(c.env, row, authorized.nativeProof, input.data.partNumber)
      : null;
    if (authorized?.nativeProof && !lease)
      throw new HTTPException(409, { message: "Attachment access changed before the upload ticket was issued" });
    const ticket = await presignRequestAttachmentPart({ env: c.env, key: row.object_key, uploadId: row.multipart_upload_id,
      partNumber: input.data.partNumber, contentLength, contentType: row.content_type,
      ...(lease ? { now: new Date(lease.issuedAt) } : {}) });
    return c.json({ ...ticket, method: "PUT", partNumber: input.data.partNumber, contentLength,
      headers: { "Content-Type": row.content_type }, contentType: row.content_type,
      ...(lease ? { ticketNonce: lease.nonce } : {}) });
  });

  router.put("/service-request-drafts/:draftId/attachments/:attachmentId/parts/:partNumber", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const attachmentId = opaqueId.safeParse(c.req.param("attachmentId"));
    const partNumber = z.coerce.number().int().min(1).max(4).safeParse(c.req.param("partNumber"));
    const input = attachmentCheckpointBody.safeParse(await readBoundedJson(c.req.raw));
    if (!draftId.success || !attachmentId.success) throw new HTTPException(404, { message: "Attachment not found" });
    if (!partNumber.success || !input.success) throw new HTTPException(400, { message: "The attachment checkpoint is invalid" });
    const authorized = await getAuthorizedRequestAttachmentContext(c.env, c.get("clientSession"), draftId.data, attachmentId.data);
    const row = authorized?.row;
    if (!row) throw new HTTPException(404, { message: "Attachment not found" });
    if (Date.parse(row.expires_at) <= Date.now()) throw new HTTPException(410, { message: "The attachment upload expired" });
    if (authorized?.nativeProof && !input.data.ticketNonce)
      throw new HTTPException(400, { message: "The native attachment ticket nonce is required" });
    return c.json(await checkpointRequestAttachment(c.env, row, partNumber.data, input.data.etag, input.data.size,
      authorized?.nativeProof ? { proof: authorized.nativeProof, ticketNonce: input.data.ticketNonce! } : undefined));
  });

  router.post("/service-request-drafts/:draftId/attachments/:attachmentId/complete", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const attachmentId = opaqueId.safeParse(c.req.param("attachmentId"));
    const input = attachmentCompleteBody.safeParse(await readBoundedJson(c.req.raw));
    if (!draftId.success || !attachmentId.success) throw new HTTPException(404, { message: "Attachment not found" });
    if (!input.success) throw new HTTPException(400, { message: "The attachment completion request is invalid" });
    const authorized = await getAuthorizedRequestAttachmentContext(c.env, c.get("clientSession"), draftId.data, attachmentId.data);
    const row = authorized?.row;
    if (!row) throw new HTTPException(404, { message: "Attachment not found" });
    if (Date.parse(row.expires_at) <= Date.now()) throw new HTTPException(410, { message: "The attachment upload expired" });
    const parts = input.data.parts.map(part => ({ partNumber: part.partNumber, etag: canonicalRequestAttachmentEtag(part.etag) }))
      .map(part => { if (!part.etag) throw new HTTPException(400, { message: "The attachment ETag is invalid" }); return { partNumber: part.partNumber, etag: part.etag }; })
      .sort((left, right) => left.partNumber - right.partNumber);
    return c.json(await completeRequestAttachment(c.env, row, parts, authorized?.nativeProof ?? undefined));
  });

  router.delete("/service-request-drafts/:draftId/attachments/:attachmentId", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const attachmentId = opaqueId.safeParse(c.req.param("attachmentId"));
    if (!draftId.success || !attachmentId.success) throw new HTTPException(404, { message: "Attachment not found" });
    const authorized = await getAuthorizedRequestAttachmentContext(c.env, c.get("clientSession"), draftId.data, attachmentId.data);
    const row = authorized?.row;
    if (!row) throw new HTTPException(404, { message: "Attachment not found" });
    return c.json({ ok: true, status: "aborted", ...await abortRequestAttachment(c.env, row, authorized?.nativeProof ?? undefined) });
  });

  router.put("/service-request-drafts/:draftId", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const version = draftVersionHeader.safeParse(c.req.header("If-Match"));
    const parsed = serviceRequestDraftBody.safeParse(await readBoundedJson(c.req.raw, MAX_SERVICE_REQUEST_DRAFT_BYTES));
    if (!draftId.success)
      throw new HTTPException(404, { message: "Service request draft not found" });
    if (!key.success || !version.success || !parsed.success)
      throw new HTTPException(400, { message: "A valid draft, Idempotency-Key, and numeric If-Match header are required" });
    if (!repository.saveServiceRequestDraft)
      throw new HTTPException(503, { message: "Service request drafts are not configured" });
    if (parsed.data.projectId
      ? !(await authorizeProject(c, "request.create", parsed.data.projectId))
      : !(await authorizeRoot(c, "request.create")))
      throw new HTTPException(404, { message: "Project not found" });
    const result = await repository.saveServiceRequestDraft(c.env, c.get("clientSession"), draftId.data, version.data, {
      ...parsed.data,
      areaGeoJson: validateRequestArea(parsed.data.areaGeoJson),
    }, key.data);
    if (!result)
      throw new HTTPException(404, { message: "Service request draft not found" });
    if (result.kind === "conflict")
      throw new HTTPException(409, { message: "The draft changed or this Idempotency-Key was reused" });
    if (result.kind === "catalog_changed")
      return c.json({
        error: "One or more selected services changed in the Project Alpha service library. Review and reselect them before continuing.",
        code: "catalog_changed" as const,
        servicePublicIds: result.servicePublicIds,
      }, 409);
    if (result.kind === "service_assignments_changed")
      return c.json({
        error: "One or more selected services are no longer assigned to this exact request context. Refresh and review the available services.",
        code: "service_assignments_changed" as const,
        servicePublicIds: result.servicePublicIds,
      }, 409);
    return c.json({ draft: result.draft });
  });

  // Pricing hints never accept browser-supplied area or money. A provider sees
  // only the authorized stored draft and failures deliberately do not block a
  // client from continuing to review or submit the request.
  router.get("/service-request-drafts/:draftId/pricing-hint", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    if (!draftId.success || !repository.getServiceRequestDraft)
      throw new HTTPException(404, { message: "Service request draft not found" });
    const draft = await repository.getServiceRequestDraft(c.env, c.get("clientSession"), draftId.data);
    if (!draft) throw new HTTPException(404, { message: "Service request draft not found" });
    if (!dependencies.pricingHintProvider)
      return c.json({ available: false, hint: null });
    try {
      const workspace = selectedWorkspace(c);
      if (!workspace || !draft.projectId || !(await authorizeProject(c, "request.create", draft.projectId)))
        return c.json({ available: false, hint: null });
      let assignmentProof: ServiceAssignmentPolicyProof | null = null;
      if (serviceAssignmentRequestPolicyEnabled(c.env)) {
        const assignment = await readServiceAssignmentPolicy(c.env, c.get("clientSession"), draft.projectId);
        if (assignment.state !== "ready" || (await changedAssignedServices(c.env, assignment.proof, draft.services)).length)
          return c.json({ available: false, hint: null });
        assignmentProof = assignment.proof;
      }
      const resolvePricingContext = dependencies.pricingAuthorizationContextResolver ?? resolveProjectAlphaPricingAuthorizationContext;
      const pricingContext = await resolvePricingContext(c.env, workspace, draft.projectId, draft);
      if (!pricingContext) return c.json({ available: false, hint: null });
      const provided = await dependencies.pricingHintProvider({
        services: draft.services,
        areaSquareMeters: draft.areaSquareMeters,
        areaAcres: draft.areaAcres,
        ...pricingContext,
      }, c.env);
      const validated = pricingHint.safeParse(provided);
      if (!validated.success) return c.json({ available: false, hint: null });
      // The upstream await must not publish a result for a changed draft or a
      // relationship whose source/authorization was revoked while in flight.
      const currentDraft = await repository.getServiceRequestDraft(c.env, c.get("clientSession"), draftId.data);
      if (!currentDraft || currentDraft.version !== draft.version || currentDraft.projectId !== draft.projectId
        || !(await authorizeProject(c, "request.create", draft.projectId))) return c.json({ available: false, hint: null });
      if (assignmentProof && (!await serviceAssignmentPolicyProofStillCurrent(c.env, assignmentProof)
        || (await changedAssignedServices(c.env, assignmentProof, currentDraft.services)).length))
        return c.json({ available: false, hint: null });
      const currentContext = await resolvePricingContext(c.env, workspace, draft.projectId, draft);
      if (!currentContext || currentContext.catalogSource.sourceId !== pricingContext.catalogSource.sourceId
        || currentContext.authorizationContext.sourceId !== pricingContext.authorizationContext.sourceId
        || currentContext.authorizationContext.projectPublicId !== pricingContext.authorizationContext.projectPublicId
        || currentContext.authorizationContext.workspaceRoot.type !== pricingContext.authorizationContext.workspaceRoot.type
        || currentContext.authorizationContext.workspaceRoot.publicId !== pricingContext.authorizationContext.workspaceRoot.publicId)
        return c.json({ available: false, hint: null });
      return c.json({ available: true, hint: validated.data });
    } catch {
      return c.json({ available: false, hint: null });
    }
  });

  router.post("/service-request-drafts/:draftId/submit", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const draftId = opaqueId.safeParse(c.req.param("draftId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const version = draftVersionHeader.safeParse(c.req.header("If-Match"));
    if (!draftId.success)
      throw new HTTPException(404, { message: "Service request draft not found" });
    if (!key.success || !version.success)
      throw new HTTPException(400, { message: "Valid Idempotency-Key and numeric If-Match headers are required" });
    if (!repository.submitServiceRequestDraft)
      throw new HTTPException(503, { message: "Service request drafts are not configured" });
    const result = await repository.submitServiceRequestDraft(c.env, c.get("clientSession"), draftId.data, version.data, key.data);
    if (!result) throw new HTTPException(404, { message: "Service request draft not found" });
    if (result.kind === "incomplete") {
      const messages = {
        request_fields_incomplete: "Add the required request title and description before submitting.",
        answers_incomplete: "Answer every required question for the selected services before submitting.",
        geometry_required: "Draw the required work area before submitting.",
        catalog_changed: "One or more selected services changed in the Project Alpha service library. Review and reselect them before submitting.",
        service_assignments_changed: "One or more selected services are no longer assigned to this exact request context. Refresh and review the available services before submitting.",
        attachments_pending: "Wait for every supporting file to finish its security scan, or remove it, before submitting.",
        attachments_rejected: "Remove every rejected supporting file and upload a safe replacement before submitting.",
        attachments_expired: "Remove every expired supporting file and upload it again before submitting.",
      } as const;
      return c.json({
        error: messages[result.reason],
        code: result.reason,
        ...(result.servicePublicIds ? { servicePublicIds: result.servicePublicIds } : {}),
        ...(result.attachmentCount !== undefined ? { attachmentCount: result.attachmentCount } : {}),
      }, 422);
    }
    if (result.kind === "conflict")
      throw new HTTPException(409, { message: "The draft changed or was already submitted" });
    return c.json({ request: result.request }, result.kind === "submitted" ? 201 : 200);
  });

  router.get("/team", async (c) => {
    if (c.env.CLIENT_PORTAL_TEAM_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    await requireLegacyTeamManagement(c);
    const session = c.get("clientSession");
    const [members, invitations] = await Promise.all([
      repository.listMembers(c.env, session),
      repository.listInvitations(c.env, session),
    ]);
    if (!members || !invitations)
      throw new HTTPException(403, {
        message: "Team management is not permitted",
      });
    return c.json({ members, invitations });
  });

  router.post("/team/invitations", async (c) => {
    if (c.env.CLIENT_PORTAL_TEAM_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    await requireLegacyTeamManagement(c);
    requireSameRequestOrigin(c.req.raw, c.env);
    const limiter = c.env.PUBLIC_BULK_RATE_LIMITER;
    if (!limiter || typeof limiter.limit !== "function")
      throw new HTTPException(503, {
        message: "Client invitation submission is not configured",
      });
    const rateLimit = await limiter.limit({
      key: `client-team:invite:${c.get("clientSession").accountId}`,
    });
    if (!rateLimit.success) {
      c.header("Retry-After", String(SERVICE_REQUEST_RATE_LIMIT_SECONDS));
      throw new HTTPException(429, {
        message: "Too many invitation requests. Please try again shortly.",
      });
    }
    const parsed = invitationBody.safeParse(await readBoundedJson(c.req.raw));
    if (!parsed.success)
      throw new HTTPException(400, { message: "The invitation is invalid" });
    const invitation = await repository.createInvitation(
      c.env,
      c.get("clientSession"),
      parsed.data,
    );
    if (!invitation)
      throw new HTTPException(403, {
        message: "The invitation could not be created for this account",
      });
    return c.json({ invitation }, 201);
  });

  router.delete("/team/members/:identityId", async (c) => {
    if (c.env.CLIENT_PORTAL_TEAM_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    await requireLegacyTeamManagement(c);
    requireSameRequestOrigin(c.req.raw, c.env);
    const identityId = opaqueId.safeParse(c.req.param("identityId"));
    if (!identityId.success)
      throw new HTTPException(404, { message: "Team member not found" });
    const revoked = await repository.revokeMember(
      c.env,
      c.get("clientSession"),
      identityId.data,
    );
    if (!revoked)
      throw new HTTPException(404, { message: "Team member not found" });
    return c.body(null, 204);
  });

  router.delete("/team/invitations/:invitationId", async (c) => {
    if (c.env.CLIENT_PORTAL_TEAM_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    await requireLegacyTeamManagement(c);
    requireSameRequestOrigin(c.req.raw, c.env);
    const invitationId = opaqueId.safeParse(c.req.param("invitationId"));
    if (!invitationId.success)
      throw new HTTPException(404, { message: "Invitation not found" });
    const revoked = await repository.revokeInvitation(
      c.env,
      c.get("clientSession"),
      invitationId.data,
    );
    if (!revoked)
      throw new HTTPException(404, { message: "Invitation not found" });
    return c.body(null, 204);
  });

  router.post("/service-requests", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const activeSession = c.get("clientSession");
    const limiter = c.env.PUBLIC_BULK_RATE_LIMITER;
    if (!limiter || typeof limiter.limit !== "function") {
      throw new HTTPException(503, {
        message: "Client request submission is not configured",
      });
    }
    const rateLimit = await limiter.limit({
      key: `client-service-request:create:${activeSession.nativeSourceId
        ? `native:${activeSession.nativeSourceId}:${activeSession.workspaceId}:${activeSession.nativePortalIdentityId}`
        : activeSession.accountId}`,
    });
    if (!rateLimit.success) {
      c.header("Retry-After", String(SERVICE_REQUEST_RATE_LIMIT_SECONDS));
      throw new HTTPException(429, {
        message: "Too many service requests. Please try again shortly.",
      });
    }
    const parsedIdempotencyKey = idempotencyKey.safeParse(
      c.req.header("Idempotency-Key"),
    );
    if (!parsedIdempotencyKey.success)
      throw new HTTPException(400, {
        message: "A valid Idempotency-Key header is required",
      });
    const parsed = serviceRequestBody.safeParse(
      await readBoundedJson(c.req.raw),
    );
    if (!parsed.success)
      throw new HTTPException(400, {
        message: "The service request is invalid",
      });
    if (!activeSession.nativeSourceId && parsed.data.services !== undefined)
      throw new HTTPException(400, { res: Response.json({
        error: "Service selections require an exact Project Alpha workspace.",
        code: "native_workspace_required",
      }, { status: 400 }) });
    if (activeSession.nativeSourceId && !parsed.data.services?.length)
      throw new HTTPException(422, { res: Response.json({
        error: "Select at least one service from this Project Alpha workspace before submitting.",
        code: "native_services_required",
      }, { status: 422 }) });
    if (parsed.data.projectId
      ? !(await authorizeProject(c, "request.create", parsed.data.projectId))
      : !(await authorizeRoot(c, "request.create")))
      throw new HTTPException(404, { message: "Project not found or service requests are not permitted" });
    const result = await repository.createServiceRequest(
      c.env,
      activeSession,
      {
        ...parsed.data,
        projectId: parsed.data.projectId ?? null,
        parentRequestId: null,
        idempotencyKey: parsedIdempotencyKey.data,
        location: parsed.data.location ?? null,
        preferredStartAt: parsed.data.preferredStartAt ?? null,
        serviceCategory: parsed.data.serviceCategory ?? null,
        deliverables: parsed.data.deliverables ?? null,
        siteContactName: parsed.data.siteContactName ?? null,
        siteContactEmail: parsed.data.siteContactEmail ?? null,
        siteContactPhone: parsed.data.siteContactPhone ?? null,
        desiredCompletionAt: parsed.data.desiredCompletionAt ?? null,
        latitude: parsed.data.latitude ?? null,
        longitude: parsed.data.longitude ?? null,
        areaGeoJson: validateRequestArea(parsed.data.areaGeoJson),
        poiPoints:
          parsed.data.poiPoints?.map((point) => ({
            ...point,
            label: point.label ?? null,
          })) ?? [],
      },
    );
    if (!result)
      throw new HTTPException(404, {
        message: "Project not found or service requests are not permitted",
      });
    if (result.kind === "conflict")
      throw new HTTPException(409, {
        message:
          "This Idempotency-Key was already used for a different request",
      });
    if (result.kind === "blocked") {
      const messages = {
        request_fields_incomplete: "Complete the required request details before submitting.",
        answers_incomplete: "Complete the required service questions before submitting.",
        geometry_required: "Draw the required work area before submitting.",
        catalog_changed: "The service catalog changed. Refresh the request before submitting.",
        service_assignments_changed: "The available services changed. Refresh the request before submitting.",
        attachments_pending: "Wait for request attachments to finish processing before submitting.",
        attachments_rejected: "Remove rejected request attachments before submitting.",
        attachments_expired: "Remove expired request attachments before submitting.",
      } as const;
      const status = result.reason === "catalog_changed" || result.reason === "service_assignments_changed" ? 409 : 422;
      return c.json({
        error: messages[result.reason],
        code: result.reason,
        servicePublicIds: result.servicePublicIds,
        attachmentCount: result.attachmentCount,
        draftId: result.draftId,
      }, status);
    }
    return c.json(
      { request: result.request },
      result.kind === "created" ? 201 : 200,
    );
  });

  router.patch("/service-requests/:requestId", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    const parsedKey = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    const expectedUpdatedAt = z
      .string()
      .min(1)
      .max(100)
      .safeParse(c.req.header("If-Match"));
    if (!requestId.success)
      throw new HTTPException(404, { message: "Service request not found" });
    rejectUnsupportedNativeRequestMutation(c, "Editing a submitted request");
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(
      c.env, c.get("clientPrincipal"), workspace, requestId.data,
    ))) throw new HTTPException(404, { message: "Service request not found" });
    if (!parsedKey.success || !expectedUpdatedAt.success)
      throw new HTTPException(400, {
        message: "Valid Idempotency-Key and If-Match headers are required",
      });
    const parsed = serviceRequestBody.safeParse(
      await readBoundedJson(c.req.raw),
    );
    if (!parsed.success)
      throw new HTTPException(400, {
        message: "The service request is invalid",
      });
    if (parsed.data.projectId
      ? !(await authorizeProject(c, "request.create", parsed.data.projectId))
      : !(await authorizeRoot(c, "request.create")))
      throw new HTTPException(404, { message: "Project not found" });
    const request = await repository.updateServiceRequest(
      c.env,
      c.get("clientSession"),
      requestId.data,
      {
        ...parsed.data,
        idempotencyKey: parsedKey.data,
        expectedUpdatedAt: expectedUpdatedAt.data,
        projectId: parsed.data.projectId ?? null,
        location: parsed.data.location ?? null,
        preferredStartAt: parsed.data.preferredStartAt ?? null,
        areaGeoJson: validateRequestArea(parsed.data.areaGeoJson),
        poiPoints:
          parsed.data.poiPoints?.map((point) => ({
            ...point,
            label: point.label ?? null,
          })) ?? [],
      },
    );
    if (!request)
      throw new HTTPException(409, {
        message: "Only a submitted request can be edited",
      });
    return c.json({ request });
  });

  router.post("/service-requests/:requestId/cancel", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    const parsedKey = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!requestId.success)
      throw new HTTPException(404, { message: "Service request not found" });
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(
      c.env, c.get("clientPrincipal"), workspace, requestId.data,
    ))) throw new HTTPException(404, { message: "Service request not found" });
    if (!parsedKey.success)
      throw new HTTPException(400, {
        message: "A valid Idempotency-Key header is required",
      });
    if (!repository.cancelServiceRequest)
      throw new HTTPException(503, { message: "Request cancellation is not configured" });
    const result = await repository.cancelServiceRequest(
      c.env,
      c.get("clientSession"),
      requestId.data,
      parsedKey.data,
    );
    if (!result)
      throw new HTTPException(404, { message: "Service request not found" });
    if (result.kind === "conflict") {
      const messages = {
        idempotency_key_reused: "This Idempotency-Key was already used for a different mutation",
        status_not_cancellable: "This request can no longer be cancelled because work has begun or the request is already closed",
        reconciliation_required: "This request is being reconciled with Project Alpha and cannot be cancelled yet",
        catalog_changed: "The service catalog changed. Refresh the request before trying again",
        service_assignments_changed: "The service assignment changed. Refresh the request before trying again",
      } as const;
      return c.json({ error: messages[result.reason], code: result.reason }, 409);
    }
    return c.json({ request: result.request });
  });

  router.post("/service-requests/:requestId/change-request", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const parentId = opaqueId.safeParse(c.req.param("requestId"));
    const parsedKey = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!parentId.success)
      throw new HTTPException(404, { message: "Service request not found" });
    rejectUnsupportedNativeRequestMutation(c, "Creating a change request");
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(c.env, c.get("clientPrincipal"), workspace, parentId.data)))
      throw new HTTPException(404, { message: "Service request not found" });
    if (!parsedKey.success)
      throw new HTTPException(400, {
        message: "A valid Idempotency-Key header is required",
      });
    const parsed = serviceRequestBody.safeParse(
      await readBoundedJson(c.req.raw),
    );
    if (!parsed.success)
      throw new HTTPException(400, {
        message: "The change request is invalid",
      });
    if (parsed.data.projectId
      ? !(await authorizeProject(c, "request.create", parsed.data.projectId))
      : !(await authorizeRoot(c, "request.create")))
      throw new HTTPException(404, { message: "Project not found" });
    const result = await repository.createChangeRequest(
      c.env,
      c.get("clientSession"),
      parentId.data,
      {
        ...parsed.data,
        idempotencyKey: parsedKey.data,
        parentRequestId: parentId.data,
        projectId: parsed.data.projectId ?? null,
        location: parsed.data.location ?? null,
        preferredStartAt: parsed.data.preferredStartAt ?? null,
        areaGeoJson: validateRequestArea(parsed.data.areaGeoJson),
        poiPoints:
          parsed.data.poiPoints?.map((point) => ({
            ...point,
            label: point.label ?? null,
          })) ?? [],
      },
    );
    if (!result)
      throw new HTTPException(409, {
        message: "A change request cannot be created from this request",
      });
    if (result.kind === "conflict")
      throw new HTTPException(409, {
        message: "This Idempotency-Key was already used for different content",
      });
    return c.json(
      { request: result.request },
      result.kind === "created" ? 201 : 200,
    );
  });

  router.post("/service-requests/:requestId/estimate-response", async (c) => {
    requireSameRequestOrigin(c.req.raw, c.env);
    const requestId = opaqueId.safeParse(c.req.param("requestId"));
    const parsedKey = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!requestId.success)
      throw new HTTPException(404, { message: "Service request not found" });
    rejectUnsupportedNativeRequestMutation(c, "Responding to an estimate");
    const workspace = selectedWorkspace(c);
    if (workspace && !(await authorizeEffectiveWorkspaceRequest(
      c.env, c.get("clientPrincipal"), workspace, requestId.data,
    ))) throw new HTTPException(404, { message: "Service request not found" });
    if (!parsedKey.success)
      throw new HTTPException(400, {
        message: "A valid Idempotency-Key header is required",
      });
    const parsed = estimateResponseBody.safeParse(
      await readBoundedJson(c.req.raw),
    );
    if (!parsed.success)
      throw new HTTPException(400, {
        message: "The estimate response is invalid",
      });
    if (!repository.respondToOperationalEstimate) throw new HTTPException(503, { message: "Estimate responses are not configured" });
    const request = await repository.respondToOperationalEstimate(
      c.env,
      c.get("clientSession"),
      requestId.data,
      parsed.data.estimateId,
      parsed.data.response,
      parsed.data.note ?? null,
      parsedKey.data,
    );
    if (!request)
      throw new HTTPException(409, {
        message: "This estimate is no longer awaiting your response",
      });
    return c.json({ request });
  });

  router.route("/",createClientFeedbackRouter(feedbackSchemaAvailable));
  router.route("/",createClientNotificationHistoryRouter({notificationSchemaAvailable,feedbackSchemaAvailable}));
  return router;
}
type ClientFileRange = { offset: number; length: number };

function clientFileRange(value: string | undefined, size: number): ClientFileRange | undefined {
  if (!value) return undefined;
  if (!Number.isSafeInteger(size) || size <= 0) throw new HTTPException(416);
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || value.includes(",") || (!match[1] && !match[2])) throw new HTTPException(416);
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HTTPException(416);
    return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
    throw new HTTPException(416);
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

function clientFileEtagMatches(value: string | undefined, current: string): boolean {
  if (!value) return false;
  const expected = clientFileCanonicalEtag(current);
  return value.split(",").some(candidate => candidate.trim() === "*" || clientFileCanonicalEtag(candidate) === expected);
}

function clientFileCanonicalEtag(value: string): string {
  return value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

function clientFileStrongEtagMatches(value: string, current: string): boolean {
  const candidate = value.trim();
  return !candidate.startsWith("W/") && !current.trim().startsWith("W/") && candidate === current.trim();
}
