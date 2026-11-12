import { HTTPException } from 'hono/http-exception';
import { sqlScope, type SqlScope } from './acl';
import { listClientHubBusinessProjects } from './client-hub-business-projects';
import { resolveClientHubDetailContext, verifyClientHubDetailContext } from './client-hub';
import { listClientHubRoots } from './client-hub-directory';
import { readClientHubBusinessProjectPolicy } from './client-hub-project-policy';
import { projectPilotBusinessProject, projectPilotBusinessRoot } from './ios-pilot-business-projection';
import { recheckPilotSession, type PilotSession } from './ios-pilot-session';
import type { Env } from './types';

type BusinessRoot = { sourceId: string; kind: 'organization' | 'standalone_client'; clientHubRootId: string };
const STAGING_SOURCE = 'project-alpha:staging';

function validCursor(value: string | null): boolean {
  return value === null || /^[A-Za-z0-9_-]{1,4096}$/.test(value);
}
function directoryScopeProof(scope: SqlScope): string {
  return JSON.stringify([scope.global, scope.deniedGlobal, scope.assigned, scope.own,
    [...scope.divisions].sort(), [...scope.deniedDivisions].sort()]);
}

/** The existing directory function enforces and rechecks the user's global
 * team.view scope. Only business roots are projected; other namespaces and
 * all access, contact, portal, and search metadata remain private. */
export async function readPilotBusinessRoots(env: Env, session: PilotSession, cursor?: string) {
  if (env.ENVIRONMENT !== 'staging') throw new HTTPException(404, { message: 'Not found' });
  if (!validCursor(cursor ?? null)) throw new HTTPException(400, { message: 'Invalid request' });
  await recheckPilotSession(env, session);
  const scope = await sqlScope(env, session.principal, 'team.view');
  if (!scope.global || scope.deniedGlobal) throw new HTTPException(403, { message: 'Access denied' });
  const result = await listClientHubRoots(env, session.principal,
    { limit: 20, source: STAGING_SOURCE, grouping: 'records', sort: 'name', ...(cursor === undefined ? {} : { cursor }) });
  const roots = result.clients.filter(root => root.root_namespace === 'business'
    && root.source_id === STAGING_SOURCE).map(projectPilotBusinessRoot);
  if (roots.length > 20 || !validCursor(result.nextCursor)) {
    throw new HTTPException(503, { message: 'Pilot temporarily unavailable' });
  }
  await recheckPilotSession(env, session);
  const currentScope = await sqlScope(env, session.principal, 'team.view');
  if (!currentScope.global || currentScope.deniedGlobal || directoryScopeProof(currentScope) !== directoryScopeProof(scope)) {
    throw new HTTPException(403, { message: 'Access changed' });
  }
  return { schemaVersion: 1, roots, nextCursor: result.nextCursor };
}

/** Reads only an exact business root using the existing human Client Hub
 * authority. The caller must independently validate the mobile Access token.
 * No additional permissions or source visibility are granted here. */
export async function readPilotBusinessProjects(env: Env, session: PilotSession, root: BusinessRoot,
  cursor?: string) {
  if (env.ENVIRONMENT !== 'staging') throw new HTTPException(404, { message: 'Not found' });
  if (root.sourceId !== STAGING_SOURCE
    || !['organization', 'standalone_client'].includes(root.kind)
    || !root.clientHubRootId || root.clientHubRootId.length > 512 || /[\u0000-\u001f\u007f]/.test(root.clientHubRootId)
    || !validCursor(cursor ?? null)) {
    throw new HTTPException(400, { message: 'Invalid request' });
  }
  await recheckPilotSession(env, session);
  const context = await resolveClientHubDetailContext(env, session.principal, root.kind,
    root.clientHubRootId, root.sourceId, 'business');
  const policy = await readClientHubBusinessProjectPolicy(env, session.principal);
  if (!policy.allowed) throw new HTTPException(403, { message: 'Access denied' });
  const result = await listClientHubBusinessProjects(env, session.principal, context,
    { limit: 20, ...(cursor === undefined ? {} : { cursor }) });
  if (!result.page.available) throw new HTTPException(403, { message: 'Access denied' });
  const projects = result.items.map(projectPilotBusinessProject);
  const nextCursor = result.page.nextCursor;
  if (projects.length > 20 || !validCursor(nextCursor)) {
    throw new HTTPException(503, { message: 'Pilot temporarily unavailable' });
  }
  await verifyClientHubDetailContext(env, session.principal, context);
  await recheckPilotSession(env, session);
  const currentPolicy = await readClientHubBusinessProjectPolicy(env, session.principal);
  if (!currentPolicy.allowed || currentPolicy.proof !== policy.proof) {
    throw new HTTPException(403, { message: 'Access changed' });
  }
  return { schemaVersion: 1, projects, nextCursor };
}
