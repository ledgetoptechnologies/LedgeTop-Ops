import { Hono } from "hono";
import type { Env } from "../types";
import { configuredClientPortalOrigins } from "../origin-policy";
import { clientAccessConfiguration, resolveCloudflareClientPrincipal } from "./access-identity";
import type { ResolveClientPrincipal, VerifiedClientPrincipal } from "./types";
import { readOperationsServiceHome, readOperationsServiceHomes } from "./operations-service-home";

/** Independent of legacy PA session/membership admission. This endpoint grants
 * no resource access: its explicit permission permits descriptive service labels only. */
export function createOperationsHomeRouter(dependencies: { resolvePrincipal?: ResolveClientPrincipal } = {}) {
  const router = new Hono<{ Bindings: Env; Variables: { operationsPrincipal: VerifiedClientPrincipal } }>();
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    await next();
  });
  router.use("*", async (c, next) => {
    if (c.env.CLIENT_PORTAL_ENABLED !== "true" || c.env.CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED !== "true")
      return c.json({ error: "Not found" }, 404);
    const origins = configuredClientPortalOrigins(c.env);
    if (!origins) return c.json({ error: "Client portal is not configured" }, 503);
    if (!origins.includes(new URL(c.req.url).origin)) return c.json({ error: "Not found" }, 404);
    try {
      // Production always verifies the configured client Access audience. The
      // optional adapter exists solely for deterministic isolated route tests.
      if (!dependencies.resolvePrincipal) clientAccessConfiguration(c.env);
      const principal = await (dependencies.resolvePrincipal ?? resolveCloudflareClientPrincipal)(c.req.raw, c.env);
      if (!principal) return c.json({ error: "Client authentication is required" }, 401);
      c.set("operationsPrincipal", principal);
      await next();
    } catch {
      return c.json({ error: "Client services are temporarily unavailable" }, 503);
    }
  });
  router.get("/home", async c => {
    const result = await readOperationsServiceHomes(c.env, c.get("operationsPrincipal"));
    if (!result.ok) return result.code === "denied"
      ? c.json({ error: "Client access is not provisioned" }, 403)
      : c.json({ error: "Client services are temporarily unavailable" }, 503);
    return c.json({ resourceMode: "operations_home", homes: result.homes });
  });
  router.get("/home/:authorityId", async c => {
    try {
      const principal = c.get("operationsPrincipal");
      const result = await readOperationsServiceHome(c.env, principal, c.req.param("authorityId"));
      if (!result.ok) {
        if (result.code === "disabled") return c.json({ error: "Not found" }, 404);
        if (result.code === "denied") return c.json({ error: "Client access is not provisioned" }, 403);
        return c.json({ error: "Client services are temporarily unavailable" }, 503);
      }
      return c.json({ resourceMode: "operations_home", authorityId: result.authorityId,
        workspaceId: result.workspaceId, ownershipEpoch: result.ownershipEpoch,
        grantRevision: result.grantRevision, services: result.services });
    } catch {
      return c.json({ error: "Client services are temporarily unavailable" }, 503);
    }
  });
  return router;
}
