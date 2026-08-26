import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

/** Fixed SQL identifiers only. A source's ingestion state never decides whether
 * its already-projected business records are visible to authorized staff. */
export function projectAlphaReadVisibleSql(sourceColumn: string): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(sourceColumn))
    throw new Error("invalid-project-alpha-source-column");
  return `(((${sourceColumn}='project-alpha:primary') AND NOT EXISTS (
    SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS (SELECT 1 FROM pa_connectors visible_connector
      WHERE visible_connector.source_id=${sourceColumn} AND visible_connector.read_visible=1))`;
}

export async function readProjectAlphaVisibility(env: Pick<Env, "OPS_DB">, sourceId: string) {
  const result = await env.OPS_DB.withSession("first-primary").prepare(`
    SELECT state.read_revision,
      CASE WHEN ?='delivery:local' THEN 1 WHEN connector.source_id IS NULL AND ?='project-alpha:primary' THEN 1
        ELSE COALESCE(connector.read_visible,0) END visible,
      CASE WHEN ?='delivery:local' THEN 'Local delivery' WHEN connector.source_id IS NULL AND ?='project-alpha:primary'
        THEN 'Project Alpha' ELSE connector.display_name END display_name
    FROM pa_connector_directory_state state LEFT JOIN pa_connectors connector ON connector.source_id=?
    WHERE state.id='directory'`).bind(sourceId, sourceId, sourceId, sourceId, sourceId)
    .first<{ read_revision: number; visible: number; display_name: string | null }>();
  if (!result || !Number.isSafeInteger(result.read_revision) || result.read_revision < 1)
    throw new HTTPException(503, { message: "Client source visibility is not ready. Retry shortly." });
  return result;
}

export async function requireProjectAlphaReadVisibility(env: Pick<Env, "OPS_DB">, sourceId: string) {
  const result = await readProjectAlphaVisibility(env, sourceId);
  if (result.visible !== 1) throw new HTTPException(404, { message: "Client source is unavailable" });
  return result;
}
