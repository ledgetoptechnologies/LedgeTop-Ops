import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isBusinessProjectionSource } from "./client-hub-source";
import { listClientHubCollection, type ClientHubCollectionContext } from "./client-hub-collections";
import { readOrganizationOperationalContacts, saveOrganizationOperationalContacts } from "./organization-operational-contacts";
import type { Env, StaffPrincipal } from "./types";

type AppEnv = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
type App = Hono<AppEnv>;
export type ResolveOrganizationOperationalContext = (env: Env, principal: StaffPrincipal, kind: "organization",
  publicId: string, sourceId: string, rootNamespace: "business") => Promise<ClientHubCollectionContext>;
export type VerifyOrganizationOperationalContext = (env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext) => Promise<void>;

function validateRoute(c: { req: { param(name: string): string } }): void {
  if (c.req.param("rootNamespace") !== "business" || c.req.param("kind") !== "organizations"
    || !isBusinessProjectionSource(c.req.param("sourceId")))
    throw new HTTPException(404, { message: "Organization operational contacts are unavailable for this source" });
}

/** All authority and exact source/root state is hydrated server-side. The
 * mutation body contains only a versioned staff operational-role update. */
export function registerOrganizationOperationalContactRoutes(app: App,
  resolveContext: ResolveOrganizationOperationalContext, verifyContext: VerifyOrganizationOperationalContext): void {
  const path = "/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/organization-operational-contacts";
  app.get(path, async c => {
    validateRoute(c);
    const principal = c.get("principal");
    const context = await resolveContext(c.env, principal, "organization", c.req.param("publicId"),
      c.req.param("sourceId"), "business");
    const expected = c.req.query("expectedContextVersion");
    if (expected !== undefined && expected !== context.contextVersion)
      throw new HTTPException(409, { message: "Organization or permissions changed. Refresh the client workspace to continue" });
    const cursor = c.req.query("contactCursor");
    const [workspace, contacts] = await Promise.all([
      readOrganizationOperationalContacts(c.env, principal, context),
      listClientHubCollection(c.env, context, "businessContacts", { limit: 25, ...(cursor ? { cursor } : {}) }),
    ]);
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json({ ...workspace, contactOptions: contacts.items, contactPage: contacts.page });
  });
  app.post(path, async c => {
    validateRoute(c);
    const principal = c.get("principal");
    const context = await resolveContext(c.env, principal, "organization", c.req.param("publicId"),
      c.req.param("sourceId"), "business");
    const result = await saveOrganizationOperationalContacts(c.env, principal, context,
      await c.req.json().catch(() => undefined));
    await verifyContext(c.env, principal, context);
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
}
