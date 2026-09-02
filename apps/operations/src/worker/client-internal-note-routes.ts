import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { isClientHubKind, isClientHubRootNamespace, isClientHubSource } from "./client-hub-directory";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { createClientInternalNote, deleteClientInternalNote, readClientInternalNotes, updateClientInternalNote } from "./client-internal-notes";
import { readBoundedJson } from "./bounded-json";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type Resolve = (env: Env, principal: StaffPrincipal, kind: "organization" | "standalone_client", publicId: string,
  sourceId: string, rootNamespace: "business" | "portal" | "account") => Promise<ClientHubCollectionContext>;
type Verify = (env: Env, principal: StaffPrincipal, context: ClientHubCollectionContext) => Promise<void>;
function route(c: { req: { param(name: string): string } }) {
  const sourceId = c.req.param("sourceId"), namespace = c.req.param("rootNamespace"), routeKind = c.req.param("kind");
  const kind: "organization" | "standalone_client" | null = routeKind === "organizations" ? "organization"
    : routeKind === "standalone" ? "standalone_client" : null;
  if (!isClientHubSource(sourceId) || !isClientHubRootNamespace(namespace) || !kind || !isClientHubKind(kind))
    throw new HTTPException(404, { message: "Client notes are unavailable" });
  return { sourceId, namespace, kind };
}
export function registerClientInternalNoteRoutes(app: App, resolve: Resolve, verify: Verify): void {
  const base = "/api/client-hub/sources/:sourceId/:rootNamespace/:kind/:publicId/internal-notes";
  const context = async (c: Context<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>) => {
    const value = route(c), publicId = c.req.param("publicId");
    if (!publicId) throw new HTTPException(404, { message: "Client notes are unavailable" });
    return resolve(c.env, c.get("principal"), value.kind, publicId, value.sourceId, value.namespace);
  };
  app.get(base, async c => { const principal = c.get("principal"), scope = await context(c);
    const result = await readClientInternalNotes(c.env, principal, scope); await verify(c.env, principal, scope);
    c.header("Cache-Control", "no-store"); return c.json(result); });
  app.post(base, async c => { const principal = c.get("principal"), scope = await context(c);
    const result = await createClientInternalNote(c.env, principal, scope, await readBoundedJson(c.req.raw, 16_384, "Client note request"), c.req.header("Idempotency-Key") || "");
    await verify(c.env, principal, scope); c.header("Cache-Control", "no-store"); return c.json(result, result.replayed ? 200 : 201); });
  app.patch(`${base}/:noteId`, async c => { const principal = c.get("principal"), scope = await context(c);
    const result = await updateClientInternalNote(c.env, principal, scope, c.req.param("noteId"), await readBoundedJson(c.req.raw, 16_384, "Client note request"), c.req.header("Idempotency-Key") || "");
    await verify(c.env, principal, scope); c.header("Cache-Control", "no-store"); return c.json(result); });
  app.delete(`${base}/:noteId`, async c => { const principal = c.get("principal"), scope = await context(c);
    const result = await deleteClientInternalNote(c.env, principal, scope, c.req.param("noteId"), await readBoundedJson(c.req.raw, 16_384, "Client note request"), c.req.header("Idempotency-Key") || "");
    await verify(c.env, principal, scope); c.header("Cache-Control", "no-store"); return c.json(result); });
}
