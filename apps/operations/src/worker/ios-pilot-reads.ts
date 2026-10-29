import { HTTPException } from 'hono/http-exception';
import { hasLocalGlobalAllow, isAdministrator, requirePermission, sqlScope } from './acl';
import { paResourceFilter } from './visibility';
import { localDivisionJoin } from './local-project-division';
import { base64url, recheckPilotSession, type PilotSession } from './ios-pilot-session';
import type { Env } from './types';
import { assertDeploymentConfiguredProjectAlphaConnectorsForRead } from './project-alpha-connectors';

export type PilotOperation = { id: string; title: string; status: string; scheduledStart: string | null;
  scheduledEnd: string | null; location: string | null; projectName: string | null; divisionName: string | null };
async function scope(env: Env, session: PilotSession) {
  const principal = session.principal;
  await requirePermission(env, principal, 'operations.view');
  const administrator = await isAdministrator(env, principal);
  const grants = await sqlScope(env, principal, 'operations.view');
  const all = administrator || await hasLocalGlobalAllow(env, principal, 'operations.view_all');
  return paResourceFilter(administrator ? grants : { ...grants, divisions: [] }, principal, administrator, 'o', 'operation', all);
}
const projection = `SELECT o.id,o.title,o.status,o.scheduled_start_at scheduledStart,o.scheduled_end_at scheduledEnd,
  o.location,p.name projectName,d.name divisionName FROM pa_operations o ${localDivisionJoin('o', 'operation')}
  LEFT JOIN pa_projects p ON p.id=o.project_id AND p.projection_source_id=o.projection_source_id AND p.active=1`;
function cursorValue(cursor: string | null): string | null {
  if (cursor === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw Error();
    const bytes = Uint8Array.from(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!value || value.length > 512 || base64url(bytes) !== cursor) throw Error();
    return value;
  } catch { throw new HTTPException(400, { message: 'Invalid page cursor' }); }
}
export async function readPilotOperations(env: Env, session: PilotSession, options: { cursor?: string | null; id?: string }) {
  await assertDeploymentConfiguredProjectAlphaConnectorsForRead(env);
  const before = await scope(env, session);
  const afterId = cursorValue(options.cursor ?? null);
  if (options.id !== undefined && (!options.id || options.id.length > 512)) throw new HTTPException(404, { message: 'Operation not found' });
  const selector = options.id !== undefined ? 'AND o.id=?' : afterId !== null ? 'AND o.id>?' : '';
  const values = options.id !== undefined ? [options.id] : afterId !== null ? [afterId] : [];
  const result = await env.OPS_DB.withSession('first-primary').prepare(`${projection} WHERE ${before.sql} ${selector} ORDER BY o.id ASC LIMIT 51`)
    .bind(...before.values, ...values).all<PilotOperation>();
  await recheckPilotSession(env, session);
  if (JSON.stringify(before) !== JSON.stringify(await scope(env, session)))
    throw new HTTPException(403, { message: 'Permissions changed; reload the pilot' });
  await assertDeploymentConfiguredProjectAlphaConnectorsForRead(env);
  // Re-evaluate mutable assignments and connector visibility, not just the
  // shape of their SQL filter, after all identity/permission checks above.
  if (result.results.length) {
    const ids = result.results.map(row => row.id);
    const stillVisible = await env.OPS_DB.withSession('first-primary').prepare(`SELECT o.id FROM pa_operations o
      WHERE ${before.sql} AND o.id IN (${ids.map(() => '?').join(',')}) ORDER BY o.id ASC`)
      .bind(...before.values, ...ids).all<{ id: string }>();
    if (JSON.stringify(stillVisible.results.map(row => row.id)) !== JSON.stringify(ids))
      throw new HTTPException(403, { message: 'Operation access changed; reload the pilot' });
  }
  await recheckPilotSession(env, session);
  if (options.id !== undefined) {
    if (result.results.length !== 1) throw new HTTPException(404, { message: 'Operation not found' });
    return { schemaVersion: 1, operation: result.results[0] };
  }
  const operations = result.results.slice(0, 50);
  return { schemaVersion: 1, operations, nextCursor: result.results.length > 50
    ? base64url(new TextEncoder().encode(operations[operations.length - 1]!.id)) : null };
}
