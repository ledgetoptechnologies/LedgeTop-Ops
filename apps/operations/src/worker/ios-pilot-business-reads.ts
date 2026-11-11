import { HTTPException } from 'hono/http-exception';
import { listClientHubBusinessProjects } from './client-hub-business-projects';
import { resolveClientHubDetailContext, verifyClientHubDetailContext } from './client-hub';
import { listClientHubRoots } from './client-hub-directory';
import { projectPilotBusinessProject, projectPilotBusinessRoot } from './ios-pilot-business-projection';
import { recheckPilotSession, type PilotSession } from './ios-pilot-session';
import type { Env } from './types';

type BusinessRoot = { sourceId: string; kind: 'organization' | 'standalone_client'; publicId: string };

function validCursor(value: string | null): boolean {
  return value === null || /^[A-Za-z0-9_-]{1,4096}$/.test(value);
}

/** The existing directory function enforces and rechecks the user's global
 * team.view scope. Only business roots are projected; other namespaces and
 * all access, contact, portal, and search metadata remain private. */
export async function readPilotBusinessRoots(env: Env, session: PilotSession, cursor?: string) {
  if (!validCursor(cursor ?? null)) throw new HTTPException(400, { message: 'Invalid request' });
  await recheckPilotSession(env, session);
  const result = await listClientHubRoots(env, session.principal,
    { limit: 20, grouping: 'records', sort: 'name', ...(cursor === undefined ? {} : { cursor }) });
  const roots = result.clients.filter(root => root.root_namespace === 'business'
    && root.source_id.startsWith('project-alpha:')).map(projectPilotBusinessRoot);
  if (roots.length > 20 || !validCursor(result.nextCursor)) {
    throw new HTTPException(503, { message: 'Pilot temporarily unavailable' });
  }
  await recheckPilotSession(env, session);
  return { schemaVersion: 1, roots, nextCursor: result.nextCursor };
}

/** Reads only an exact business root using the existing human Client Hub
 * authority. The caller must independently validate the mobile Access token.
 * No additional permissions or source visibility are granted here. */
export async function readPilotBusinessProjects(env: Env, session: PilotSession, root: BusinessRoot,
  cursor?: string) {
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(root.sourceId)
    || !['organization', 'standalone_client'].includes(root.kind)
    || !root.publicId || root.publicId.length > 512 || /[\u0000-\u001f\u007f]/.test(root.publicId)
    || !validCursor(cursor ?? null)) {
    throw new HTTPException(400, { message: 'Invalid request' });
  }
  await recheckPilotSession(env, session);
  const context = await resolveClientHubDetailContext(env, session.principal, root.kind,
    root.publicId, root.sourceId, 'business');
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
  return { schemaVersion: 1, projects, nextCursor };
}
