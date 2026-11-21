import { HTTPException } from 'hono/http-exception';
import { sha256 } from './crypto';
import { listClientHubRoots, type ClientHubKind } from './client-hub-directory';
import { resolveClientHubDetailContext, verifyClientHubDetailContext } from './client-hub';
import { listClientHubBusinessProjects } from './client-hub-business-projects';
import { base64url, type PilotSession } from './ios-pilot-session';
import type { Env } from './types';

// Proposed Stage One runtime identity, not a registration or grant. The primary
// name is local to the reviewed staging database; no request/environment value
// can select another source. Current source/record visibility and staff ACLs
// remain required, and the deployed origin gate stays closed pending acceptance.
export const PILOT_BUSINESS_SOURCE = 'project-alpha:primary';
const PAGE_SIZE = 20;
export type PilotBusinessRoot = { sourceId: typeof PILOT_BUSINESS_SOURCE; rootNamespace: 'business';
  kind: ClientHubKind; clientHubRootId: string; name: string };
export type PilotBusinessProject = { id: string; origin: 'pa' | 'canonical'; name: string;
  status: string | null; startDate: string | null; endDate: string | null };
export type PilotBusinessPage = { schemaVersion: 1; roots: PilotBusinessRoot[]; nextCursor: string | null }
  | { schemaVersion: 1; projects: PilotBusinessProject[]; nextCursor: string | null };
export type PilotBusinessSelection = { kind: ClientHubKind; id: string };
type Cursor = { v: 1; source: typeof PILOT_BUSINESS_SOURCE; namespace: 'business'; actor: string;
  collection: 'roots' | 'projects'; root: [ClientHubKind, string] | null; after: string };
const validText = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = (): never => { throw new HTTPException(400, { message: 'Invalid business page cursor' }); };
const unavailable = (): never => { throw new HTTPException(503, { message: 'Business data temporarily unavailable' }); };

async function actorProof(session: PilotSession): Promise<string> {
  return sha256(JSON.stringify([session.proof, session.admission]));
}
function decodeCursor(raw: string | null, actor: string, selection?: PilotBusinessSelection): string | undefined {
  if (raw === null) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) return invalid();
    const bytes = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    if (base64url(bytes) !== raw) return invalid();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const cursor = value as Record<string, unknown>;
    if (Object.keys(cursor).sort().join(',') !== 'actor,after,collection,namespace,root,source,v'
      || cursor.v !== 1 || cursor.source !== PILOT_BUSINESS_SOURCE || cursor.namespace !== 'business'
      || cursor.actor !== actor || cursor.collection !== (selection ? 'projects' : 'roots')
      || JSON.stringify(cursor.root) !== JSON.stringify(selection ? [selection.kind, selection.id] : null)
      || !validText(cursor.after, 4096)) return invalid();
    return cursor.after;
  } catch { return invalid(); }
}
function encodeCursor(after: string | null, actor: string, selection?: PilotBusinessSelection): string | null {
  if (after === null) return null;
  if (!validText(after, 4096)) return unavailable();
  const cursor: Cursor = { v: 1, source: PILOT_BUSINESS_SOURCE, namespace: 'business', actor,
    collection: selection ? 'projects' : 'roots', root: selection ? [selection.kind, selection.id] : null, after };
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(cursor)));
  if (encoded.length > 4096) return unavailable();
  return encoded;
}
function text(value: unknown, max: number): string {
  if (!validText(value, max)) return unavailable();
  return value;
}
function optional(value: unknown, max: number): string | null {
  return value === null ? null : text(value, max);
}

/** The caller supplies only an independently verified pilot session and a
 * read-barrier-wrapped Env. Existing Client Hub policy/source/context checks
 * remain authoritative; the caller must validate its barrier before release.
 * Cursors select a page, never grant authority, and the underlying helpers
 * independently bind them to their current source/root/policy epochs. */
export async function readPilotBusiness(env: Env, session: PilotSession,
  options: { cursor: string | null; selection?: PilotBusinessSelection }): Promise<PilotBusinessPage> {
  const actor = await actorProof(session);
  const cursor = decodeCursor(options.cursor, actor, options.selection);
  if (!options.selection) {
    const page = await listClientHubRoots(env, session.principal, { source: PILOT_BUSINESS_SOURCE,
      grouping: 'records', sort: 'name', limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
    const roots: PilotBusinessRoot[] = [];
    for (const root of page.clients) {
      if (root.source_id !== PILOT_BUSINESS_SOURCE) return unavailable();
      // Other directory namespaces are not part of the business pilot. Keep
      // the underlying next cursor even for an authorized empty filtered page.
      if (root.root_namespace !== 'business') continue;
      if (root.kind !== 'organization' && root.kind !== 'standalone_client') return unavailable();
      roots.push({ sourceId: PILOT_BUSINESS_SOURCE, rootNamespace: 'business', kind: root.kind,
        clientHubRootId: text(root.public_id, 512), name: text(root.display_name, 512) });
    }
    if (roots.length > PAGE_SIZE) return unavailable();
    return { schemaVersion: 1, roots, nextCursor: encodeCursor(page.nextCursor, actor) };
  }
  const selection = options.selection;
  if (!validText(selection.id, 512) || !['organization', 'standalone_client'].includes(selection.kind)) return invalid();
  const context = await resolveClientHubDetailContext(env, session.principal, selection.kind, selection.id,
    PILOT_BUSINESS_SOURCE, 'business');
  if (context.root.source_id !== PILOT_BUSINESS_SOURCE || context.root.root_namespace !== 'business'
    || context.root.kind !== selection.kind) return unavailable();
  const page = await listClientHubBusinessProjects(env, session.principal, context,
    { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
  if (!page.page.available || page.items.length > PAGE_SIZE) return unavailable();
  const projects = page.items.map((row): PilotBusinessProject => {
    if (row.origin !== 'pa' && row.origin !== 'canonical') return unavailable();
    return { id: text(row.id, 512), origin: row.origin, name: text(row.name, 512), status: optional(row.status, 128),
      startDate: optional(row.start_date, 64), endDate: optional(row.end_date, 64) };
  });
  await verifyClientHubDetailContext(env, session.principal, context);
  return { schemaVersion: 1, projects, nextCursor: encodeCursor(page.page.nextCursor, actor, selection) };
}
