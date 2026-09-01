import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isBusinessProjectionSource } from "./client-hub-source";
import { listClientHubCollection, type ClientHubCollectionContext } from "./client-hub-collections";
import { readProjectMemoryRevision, readProjectOperationalWorkspace, saveProjectMemory, saveProjectOperationalContacts } from "./project-operational-memory";
import { serveProjectMemoryAttachment, uploadProjectMemoryAttachment } from "./project-memory-attachments";
import { commitRecurringProjectCopy, previewRecurringProjectCopy } from "./project-recurring-copy-forward";
import type { Env, StaffPrincipal } from "./types";

type AppEnv = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
type App = Hono<AppEnv>;
type ClientKind = "organization" | "standalone_client";
export type ResolveProjectOperationalContext = (env: Env, principal: StaffPrincipal, kind: ClientKind,
  publicId: string, sourceId: string, rootNamespace: "business") => Promise<ClientHubCollectionContext>;
export type VerifyProjectOperationalContext = (env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext) => Promise<void>;

const kind = (value: string): ClientKind | null => value === "organizations" ? "organization"
  : value === "standalone" ? "standalone_client" : null;
function routeKind(c: { req: { param(name: string): string } }, unavailable: string): ClientKind {
  if (c.req.param("rootNamespace") !== "business" || !isBusinessProjectionSource(c.req.param("sourceId")))
    throw new HTTPException(404, { message: unavailable });
  const value = kind(c.req.param("kind"));
  if (!value) throw new HTTPException(404, { message: "Client not found" });
  return value;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function destinationBoundBody(value: unknown, destinationProjectId: string): unknown {
  if (!object(value) || value.destinationProjectId !== destinationProjectId)
    throw new HTTPException(400, { message: "The copy destination must be the open project" });
  return value;
}

/** Routes hydrate all source, root, authority and context state server-side.
 * Request bodies contain only guarded operational mutations and are validated by
 * the project-operational-memory service. */
export function registerProjectOperationalRoutes(app: App, resolveContext: ResolveProjectOperationalContext,
  verifyContext: VerifyProjectOperationalContext): void {
  const base = "/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/business-projects/:projectId";
  app.get(`${base}/operational-workspace`, async c => {
    const clientKind = routeKind(c, "Project operational details are unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const expectedContextVersion = c.req.query("expectedContextVersion");
    if (expectedContextVersion !== undefined && expectedContextVersion !== context.contextVersion)
      throw new HTTPException(409, { message: "Project ownership or permissions changed. Refresh the project workspace to continue" });
    const cursor = c.req.query("contactCursor");
    const [workspace, contacts] = await Promise.all([
      readProjectOperationalWorkspace(c.env, principal, context, c.req.param("projectId")),
      listClientHubCollection(c.env, context, "businessContacts", { limit: 25, ...(cursor ? { cursor } : {}) }),
    ]);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json({ ...workspace, capabilities: {
      canManageContacts: c.get("administrator") && workspace.capabilities.canManageContacts,
      canManageMemory: c.get("administrator") && workspace.capabilities.canManageMemory,
    }, contactOptions: contacts.items, contactPage: contacts.page });
  });
  app.post(`${base}/operational-contacts`, async c => {
    const clientKind = routeKind(c, "Project operational contacts are unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const result = await saveProjectOperationalContacts(c.env, principal, context, c.req.param("projectId"),
      await c.req.json().catch(() => undefined));
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.post(`${base}/operational-memory`, async c => {
    const clientKind = routeKind(c, "Project operational memory is unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const result = await saveProjectMemory(c.env, principal, context, c.req.param("projectId"),
      await c.req.json().catch(() => undefined));
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.get(`${base}/operational-memory/revisions/:version`, async c => {
    const clientKind = routeKind(c, "Project-memory history is unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const expectedContextVersion = c.req.query("expectedContextVersion");
    if (expectedContextVersion === undefined)
      throw new HTTPException(400, { message: "Project-memory history requires the current workspace context" });
    const rawVersion = c.req.param("version");
    if (!/^[1-9]\d{0,9}$/.test(rawVersion))
      throw new HTTPException(400, { message: "Project-memory revision version is invalid" });
    const result = await readProjectMemoryRevision(c.env, principal, context, c.req.param("projectId"), Number(rawVersion), expectedContextVersion);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.post(`${base}/operational-memory/attachments/upload`, async c => {
    const clientKind = routeKind(c, "Project-memory attachments are unavailable for this source"), principal = c.get("principal");
    if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const result = await uploadProjectMemoryAttachment(c.env, principal, context, c.req.param("projectId"), c.req.raw);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.on(["GET", "HEAD"], `${base}/operational-memory/attachments/:attachmentId/content`, async c => {
    const clientKind = routeKind(c, "Project-memory attachments are unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const response = await serveProjectMemoryAttachment(c.env, principal, context, c.req.param("projectId"),
      c.req.param("attachmentId"), c.req.raw);
    await verifyContext(c.env, principal, context);
    return response;
  });
  app.post(`${base}/recurring-copy/preview`, async c => {
    const clientKind = routeKind(c, "Recurring-project copy is unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const body = destinationBoundBody(await c.req.json().catch(() => undefined), c.req.param("projectId"));
    const result = await previewRecurringProjectCopy(c.env, principal, context, body);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  app.post(`${base}/recurring-copy/commit`, async c => {
    const clientKind = routeKind(c, "Recurring-project copy is unavailable for this source"), principal = c.get("principal");
    const context = await resolveContext(c.env, principal, clientKind, c.req.param("publicId"), c.req.param("sourceId"), "business");
    const body = destinationBoundBody(await c.req.json().catch(() => undefined), c.req.param("projectId"));
    const result = await commitRecurringProjectCopy(c.env, principal, context, body);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
}
