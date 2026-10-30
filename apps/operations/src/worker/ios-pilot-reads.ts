import { HTTPException } from 'hono/http-exception';
import { evaluatePermission, hasLocalGlobalAllow, isAdministrator, prepareAclAdministratorRead, prepareAclGrantRead, prepareAclLocalGlobalAllowRead, requirePermission, scopeFromAclGrantSnapshot, sqlScope } from './acl';
import { paResourceFilter } from './visibility';
import { localDivisionJoin } from './local-project-division';
import { base64url, type PilotSession } from './ios-pilot-session';
import type { Env, GrantRow } from './types';
import { assertProjectAlphaReadSnapshot, prepareProjectAlphaReadSnapshot, projectAlphaReadSnapshotStatements } from './project-alpha-connectors';
import { preparePilotStaffSnapshot } from './ios-pilot-staff-snapshot';

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
  const connectorPlan = await prepareProjectAlphaReadSnapshot(env);
  const before = await scope(env, session);
  const afterId = cursorValue(options.cursor ?? null);
  if (options.id !== undefined && (!options.id || options.id.length > 512)) throw new HTTPException(404, { message: 'Operation not found' });
  const selector = options.id !== undefined ? 'AND o.id=?' : afterId !== null ? 'AND o.id>?' : '';
  const values = options.id !== undefined ? [options.id] : afterId !== null ? [afterId] : [];
  const db = env.OPS_DB.withSession('first-primary');
  const staff = await preparePilotStaffSnapshot(env, db, session);
  if (!staff) throw new HTTPException(403, { message: 'Session changed; sign in again' });
  const connectorStatements = projectAlphaReadSnapshotStatements(db, connectorPlan);
  const staffCount = staff.statements.length;
  const batches = await db.batch([...staff.statements,
    prepareAclGrantRead(db, session.principal.id),
    prepareAclAdministratorRead(db, session.principal.id),
    prepareAclLocalGlobalAllowRead(db, session.principal.id, 'operations.view_all'),
    ...connectorStatements,
    db.prepare(`${projection} WHERE ${before.sql} ${selector} ORDER BY o.id ASC LIMIT 51`).bind(...before.values, ...values),
  ]);
  if (batches.some(batch => !batch.success || !Array.isArray(batch.results)) ||
      !staff.verify(batches.slice(0, staffCount), Math.floor(Date.now() / 1000)))
    throw new HTTPException(403, { message: 'Session changed; sign in again' });
  const grants = batches[staffCount]!.results as GrantRow[];
  const administrator = batches[staffCount + 1]!.results.length > 0;
  const all = administrator || batches[staffCount + 2]!.results.length > 0;
  const finalGrants = scopeFromAclGrantSnapshot(grants, 'operations.view');
  const finalScope = paResourceFilter(administrator ? finalGrants : { ...finalGrants, divisions: [] }, session.principal, administrator, 'o', 'operation', all);
  if (!evaluatePermission(grants, session.principal, 'operations.view') || JSON.stringify(before) !== JSON.stringify(finalScope))
    throw new HTTPException(403, { message: 'Permissions changed; reload the pilot' });
  const connectorRows = batches.slice(staffCount + 3, staffCount + 3 + connectorStatements.length);
  assertProjectAlphaReadSnapshot(connectorPlan,
    (connectorRows[0]?.results ?? []) as Parameters<typeof assertProjectAlphaReadSnapshot>[1],
    (connectorRows[1]?.results ?? []) as Parameters<typeof assertProjectAlphaReadSnapshot>[2]);
  const result = batches[batches.length - 1]! as D1Result<PilotOperation>;
  if (options.id !== undefined) {
    if (result.results.length !== 1) throw new HTTPException(404, { message: 'Operation not found' });
    return { schemaVersion: 1, operation: result.results[0] };
  }
  const operations = result.results.slice(0, 50);
  return { schemaVersion: 1, operations, nextCursor: result.results.length > 50
    ? base64url(new TextEncoder().encode(operations[operations.length - 1]!.id)) : null };
}
