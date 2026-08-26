import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID, type CatalogSourceContext } from "@ltds/shared";

/** Server-selected provenance only; this is not an authentication or access grant. */
export type PortalProjectionSource = CatalogSourceContext;
export const PRIMARY_PORTAL_PROJECTION_SOURCE = createCatalogSourceContext(PRIMARY_ALPHA_SOURCE_ID);

export interface PortalWorkspaceSource {
  sourceId: string;
  sourceWorkspaceId: string;
  workspaceId: string;
}

/** Mapping may be reserved while staging, never inferred during activation/events. */
export async function resolvePortalWorkspaceSource(db: Pick<D1Database, "prepare" | "batch">, source: PortalProjectionSource, sourceWorkspaceId: string, reserve: boolean): Promise<PortalWorkspaceSource> {
  const { sourceId } = createCatalogSourceContext(source?.sourceId);
  if (typeof sourceWorkspaceId !== "string" || sourceWorkspaceId !== sourceWorkspaceId.trim()
    || !/^(?=.{1,128}$)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sourceWorkspaceId)) throw new Error("portal-workspace-id-invalid");
  const read = () => db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id=? AND source_workspace_id=?")
    .bind(sourceId, sourceWorkspaceId).first<{ workspace_id: string }>();
  let row = await read();
  if (!row && reserve) {
    const workspaceId = sourceId === PRIMARY_ALPHA_SOURCE_ID ? sourceWorkspaceId : `portal-source-${crypto.randomUUID()}`;
    try {
      await db.batch([db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?) ON CONFLICT(projection_source_id,source_workspace_id) DO NOTHING")
        .bind(workspaceId, sourceId, sourceWorkspaceId)]);
    } catch (error) {
      // The immutable-map trigger can reject a concurrent reservation before
      // ON CONFLICT executes. Reuse only the exact source/external-ID winner.
      row = await read();
      if (!row) throw error;
    }
    row = await read();
  }
  if (!row) throw new Error("portal-workspace-source-generation-missing");
  return { sourceId, sourceWorkspaceId, workspaceId: row.workspace_id };
}
