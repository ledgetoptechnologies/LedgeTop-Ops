import { nativeDeliveryDeploymentEnabled, nativeDeliveryRequestOriginAllowed } from '../operations-native-delivery-deployment';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isMovedSourceMarker } from '@ltds/shared';
import type { Env } from '../types';
import { configuredClientPortalOrigins } from '../origin-policy';
import { clientAccessConfiguration, resolveCloudflareClientPrincipal } from './access-identity';
import { authorizeNativeOperationsDelivery, type NativeOperationsDeliveryContext, type NativeOperationsDeliveryAuthorizationEnv } from './operations-native-delivery-authorization';
import { decodeOperationsNativeDeliveryHandle, encodeOperationsNativeDeliveryHandle, type OperationsNativeDeliveryHandle } from './operations-native-delivery-handles';
import { kindForKey, validateRelativePath, parseRange, safeFileName } from '../files';
import { appendOperationsNativeContentStart, type OperationsNativeContentAuditEnv } from './operations-native-content-audit';
import type { ResolveClientPrincipal, VerifiedClientPrincipal } from './types';
import type { OperationsPortalNativeDeliveryFeature } from '@ltds/shared/operations-portal-native-delivery-authority';

type Bindings = { Bindings: Env & NativeOperationsDeliveryAuthorizationEnv & OperationsNativeContentAuditEnv; Variables: { operationsPrincipal: VerifiedClientPrincipal } };
type Ctx = Context<Bindings>;
type FileRow = { r2_key: string; etag: string; size: number; uploaded_at: string; content_type: string | null; media_kind: string };
const PAGE = 25, TTL = 15 * 60_000;
const visibleSql = `instr(lower('/'||f.r2_key||'/'),'/_ltds/')=0 AND instr(lower('/'||f.r2_key||'/'),'/.previews/')=0
  AND instr(lower('/'||f.r2_key||'/'),'/dump/')=0 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t
    WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key)))`;
const unavailable = (): never => { throw new HTTPException(404, { message: 'Shared data is unavailable' }); };
const temporary = (): never => { throw new HTTPException(503, { message: 'Shared data is temporarily unavailable' }); };
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 500);
const db = (c: Ctx) => c.env.DELIVERY_DB.withSession('first-primary');
const upperBound = (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
function checksumSha256(object: R2Object): string | null {
  const bytes = object.checksums?.sha256;
  return bytes?.byteLength === 32 ? [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('') : null;
}
function pinnedObjectMatches(handle: OperationsNativeDeliveryHandle, object: R2Object): boolean {
  return handle.providerVersion === undefined || object.version === handle.providerVersion && checksumSha256(object) === handle.sha256;
}
async function logicalFileId(c: Ctx, handle: OperationsNativeDeliveryHandle): Promise<string> {
  const secret = c.env.DELIVERY_SESSION_SECRET;
  if (!secret || secret.length < 32) return temporary();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const value = JSON.stringify([handle.issuer, handle.subject, handle.authorityId, handle.targetId, handle.clientFolderBindingId, handle.path]);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`operations-native-desktop-logical-file-v1\0${value}`));
  return `ondf1_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function desktopFileName(key: string): string {
  const bounded = (value: string): string => {
    let result = '';
    for (const character of value) {
      const safe = /^[\uD800-\uDFFF]$/u.test(character) ? '_' : character;
      if (result.length + safe.length > 150) break;
      result += safe;
    }
    return result;
  };
  let name = bounded((key.split('/').at(-1) ?? '').replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').trim()).trim().replace(/[. ]+$/u, '');
  if (!name || name === '.' || name === '..') name = 'download';
  if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name) || name === '.ltds-downloads-v1') name = bounded(`_${name}`);
  return name;
}
async function authorize(c: Ctx, authorityId: string, feature: OperationsPortalNativeDeliveryFeature, handle?: OperationsNativeDeliveryHandle) {
  const result = await authorizeNativeOperationsDelivery(c.env, c.get('operationsPrincipal'), authorityId, feature, handle);
  if (!result.ok) return result.code === 'unavailable' ? temporary() : unavailable();
  return result.context;
}
function proof(context: NativeOperationsDeliveryContext, kind: OperationsNativeDeliveryHandle['kind'], path = ''): OperationsNativeDeliveryHandle {
  const { command } = context;
  return { v: 1, kind, authorityId: command.authority.authorityId, authorityRevision: command.authority.resultingRevision,
    recipientBindingId: command.recipient.recipientBindingId, enrollmentIntentId: command.recipient.enrollmentIntentId,
    targetClientRecordId: command.recipient.targetClientRecordId, issuer: command.recipient.issuer, subject: command.recipient.subject,
    targetId: command.target.targetId, targetRevision: command.target.targetRevision, clientAuthorityId: command.target.clientAuthorityId,
    workspaceId: command.target.workspaceId, homeOwnershipEpoch: command.recipient.homeOwnershipEpoch, homeGrantRevision: command.recipient.homeGrantRevision,
    homeGrantOperationId: command.recipient.homeGrantOperationId, homeRequestFingerprint: command.recipient.homeRequestFingerprint,
    publicationId: command.publication.publicationId, publicationOperationId: command.publication.operationId,
    publicationRevision: command.publication.revision, publicationSourceSequence: command.publication.sourceSequence,
    snapshotId: command.publication.snapshotId, snapshotSha256: command.publication.snapshotSha256,
    folderReservationId: command.resource.folderReservationId, folderReservationRevision: command.resource.folderReservationRevision,
    clientFolderBindingId: command.resource.clientFolderBindingId, externalProjectId: command.resource.externalProjectId, projectVersion: command.resource.projectVersion,
    path, expires: Math.min(Date.now() + TTL, Date.parse(command.expiresAt!)) };
}
async function decode(c: Ctx, raw: string, kind: OperationsNativeDeliveryHandle['kind']) {
  const value = await decodeOperationsNativeDeliveryHandle(c.env, raw);
  if (!value || value.kind !== kind || value.issuer !== c.get('operationsPrincipal').issuer || value.subject !== c.get('operationsPrincipal').subject) return unavailable();
  return value;
}
async function label(c: Ctx, context: NativeOperationsDeliveryContext): Promise<string> {
  const command = context.command;
  const name = await db(c).prepare(`SELECT substr(json_extract(project.value,'$.name'),1,500) name
    FROM operations_portal_workspace_publication_snapshots snapshot,json_each(snapshot.snapshot_json,'$.projects') project
    WHERE snapshot.snapshot_id=? AND json_extract(project.value,'$.externalProjectId')=?
      AND json_extract(project.value,'$.version')=? AND json_extract(project.value,'$.published')=1`)
    .bind(command.publication.snapshotId, command.resource.externalProjectId, command.resource.projectVersion).first<string>('name');
  return typeof name === 'string' ? clean(name) : unavailable();
}
function fileDto(context: NativeOperationsDeliveryContext, row: FileRow, handle: string) {
  const base = `/api/client/operations/data/files/${encodeURIComponent(handle)}`, kind = kindForKey(row.r2_key);
  return { id: handle, name: clean(row.r2_key.split('/').at(-1) ?? 'File'), size: row.size, uploadedAt: row.uploaded_at, contentType: row.content_type,
    kind, previewPath: kind !== 'other' && context.command.features.includes('file.preview') ? `${base}/preview` : null,
    thumbnailPath: null, downloadPath: context.command.features.includes('file.download') ? `${base}/download` : null };
}
async function readFile(c: Ctx, handle: OperationsNativeDeliveryHandle, feature: OperationsPortalNativeDeliveryFeature) {
  const context = await authorize(c, handle.authorityId, feature, handle);
  const key = context.selectedR2Prefix + validateRelativePath(handle.path);
  const row = await db(c).prepare(`SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,f.media_kind
    FROM file_index f WHERE f.r2_key=? AND ${visibleSql}`).bind(key).first<FileRow>();
  if (!row || row.r2_key !== key || row.etag !== handle.etag || !Number.isSafeInteger(row.size) || row.size < 0) return unavailable();
  return { context, row };
}

/** Dedicated native admission: no synthetic PA account, legacy membership or
 * public share is created. The mounted router remains default-off. */
export function createOperationsNativeDeliveryRouter(dependencies: { resolvePrincipal?: ResolveClientPrincipal } = {}) {
  const router = new Hono<Bindings>();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store'); c.header('Cloudflare-CDN-Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    if (c.env.CLIENT_PORTAL_ENABLED !== 'true' || c.env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== 'true'
      || !nativeDeliveryDeploymentEnabled(c.env)) return c.json({ error: 'Not found' }, 404);
    const origins = configuredClientPortalOrigins(c.env);
    if (!origins) return c.json({ error: 'Client portal is not configured' }, 503);
    // Only exact browser origins pinned by the physical profile may reach
    // normal authentication; public host admission alone never grants bytes.
    if (!nativeDeliveryRequestOriginAllowed(c.env, c.req.url)) return c.json({ error: 'Not found' }, 404);
    try {
      if (!dependencies.resolvePrincipal) clientAccessConfiguration(c.env);
      const principal = await (dependencies.resolvePrincipal ?? resolveCloudflareClientPrincipal)(c.req.raw, c.env);
      if (!principal) return c.json({ error: 'Client authentication is required' }, 401);
      c.set('operationsPrincipal', principal);
    } catch { return c.json({ error: 'Client authentication is temporarily unavailable' }, 503); }
    await next();
  });
  router.get('/deliveries', async c => {
    const principal = c.get('operationsPrincipal');
    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor ? await decode(c, rawCursor, 'cursor') : null;
    if (cursor) {
      if (cursor.entryKind !== 'delivery' || cursor.path !== '' || cursor.after !== cursor.authorityId) return unavailable();
      await authorize(c, cursor.authorityId, 'folder.list', cursor);
    }
    const rows = await db(c).prepare(`SELECT authority_id FROM operations_portal_native_delivery_live_heads
      WHERE json_extract(canonical_command_json,'$.recipient.issuer')=? AND json_extract(canonical_command_json,'$.recipient.subject')=?
        AND EXISTS(SELECT 1 FROM json_each(canonical_command_json,'$.features') feature WHERE feature.value='folder.list')
        AND authority_id>?
      ORDER BY authority_id LIMIT ?`).bind(principal.issuer, principal.subject, cursor?.after ?? '', PAGE + 1).all<{ authority_id: string }>();
    if (!rows.success || rows.results.length > PAGE + 1) return temporary();
    const items = [], contexts = [];
    for (const row of rows.results.slice(0, PAGE)) {
      const context = await authorize(c, row.authority_id, 'folder.list'); contexts.push(context);
      items.push({ id: await encodeOperationsNativeDeliveryHandle(c.env, proof(context, 'folder')), displayName: await label(c, context) });
    }
    const last = contexts.at(-1);
    const nextCursor = rows.results.length > PAGE && last ? await encodeOperationsNativeDeliveryHandle(c.env,
      { ...proof(last, 'cursor'), after: last.command.authority.authorityId, entryKind: 'delivery' }) : null;
    for (const context of contexts) await authorize(c, context.command.authority.authorityId, 'folder.list', proof(context, 'folder'));
    if (cursor) await authorize(c, cursor.authorityId, 'folder.list', cursor);
    return c.json({ resourceMode: 'operations_native_delivery', items, page: { nextCursor } });
  });
  router.get('/folders/:folderHandle', async c => {
    const handle = await decode(c, c.req.param('folderHandle'), 'folder'), context = await authorize(c, handle.authorityId, 'folder.list', handle);
    const prefix = context.selectedR2Prefix + handle.path, rawCursor = c.req.query('cursor');
    const cursor = rawCursor ? await decode(c, rawCursor, 'cursor') : null;
    if (cursor) {
      if (cursor.entryKind !== 'folder' && cursor.entryKind !== 'file') return unavailable();
      await authorize(c, handle.authorityId, 'folder.list', cursor);
      if (cursor.path !== handle.path || cursor.authorityId !== handle.authorityId) return unavailable();
    }
    const rows = await db(c).prepare(`WITH candidates AS (
      SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,f.media_kind,substr(f.r2_key,?) relative_key
      FROM file_index f WHERE f.r2_key>=? AND f.r2_key<? AND ${visibleSql}
    ), entries AS (
      SELECT 'folder' entry_kind,substr(relative_key,1,instr(relative_key,'/')-1) entry_name,
        NULL r2_key,NULL etag,NULL size,NULL uploaded_at,NULL content_type,NULL media_kind
      FROM candidates WHERE instr(relative_key,'/')>0 GROUP BY substr(relative_key,1,instr(relative_key,'/')-1)
      UNION ALL SELECT 'file',relative_key,r2_key,etag,size,uploaded_at,content_type,media_kind
      FROM candidates WHERE relative_key<>'' AND instr(relative_key,'/')=0)
      SELECT * FROM entries WHERE (entry_name,entry_kind)>(?,?) ORDER BY entry_name,entry_kind LIMIT ?`)
      .bind(prefix.length + 1, prefix, upperBound(prefix), cursor?.after ?? '', cursor?.entryKind ?? '', PAGE + 1)
      .all<FileRow & { entry_kind: 'folder' | 'file'; entry_name: string }>();
    if (!rows.success || rows.results.length > PAGE + 1) return temporary();
    const page = rows.results.slice(0, PAGE), files = [], folders = [];
    for (const row of page) {
      const path = handle.path + validateRelativePath(row.entry_name);
      if (row.entry_kind === 'folder') folders.push({ id: await encodeOperationsNativeDeliveryHandle(c.env, proof(context, 'folder', `${path}/`)), name: clean(row.entry_name) });
      else {
        if (!context.command.features.includes('file.metadata')) continue;
        if (row.r2_key !== context.selectedR2Prefix + path || !Number.isSafeInteger(row.size) || row.size < 0) return unavailable();
        const id = await encodeOperationsNativeDeliveryHandle(c.env, { ...proof(context, 'file', path), etag: row.etag }); files.push(fileDto(context, row, id));
      }
    }
    const breadcrumbs = [{ id: await encodeOperationsNativeDeliveryHandle(c.env, proof(context, 'folder')), name: await label(c, context) }];
    let accumulated = '';
    for (const part of handle.path.split('/').filter(Boolean)) { accumulated += `${part}/`; breadcrumbs.push({ id: await encodeOperationsNativeDeliveryHandle(c.env,
      proof(context, 'folder', accumulated)), name: clean(part) }); }
    const last = page.at(-1), nextCursor = rows.results.length > PAGE && last ? await encodeOperationsNativeDeliveryHandle(c.env,
      { ...proof(context, 'cursor', handle.path), after: last.entry_name, entryKind: last.entry_kind }) : null;
    await authorize(c, handle.authorityId, 'folder.list', handle);
    if (files.length) await authorize(c, handle.authorityId, 'file.metadata', handle);
    return c.json({ resourceMode: 'operations_native_delivery', files, folders, breadcrumbs, folderId: c.req.param('folderHandle'), prefix: '', cursor: nextCursor });
  });
  router.get('/files/:fileHandle', async c => {
    const handle = await decode(c, c.req.param('fileHandle'), 'file'), { context, row } = await readFile(c, handle, 'file.metadata');
    await authorize(c, handle.authorityId, 'file.metadata', handle);
    return c.json({ resourceMode: 'operations_native_delivery', file: fileDto(context, row, c.req.param('fileHandle')) });
  });
  router.get('/files/:fileHandle/download-manifest', async c => {
    const handle = await decode(c, c.req.param('fileHandle'), 'file');
    const { context, row } = await readFile(c, handle, 'file.download');
    const head = await c.env.DATA_BUCKET.head(row.r2_key);
    if (!head || isMovedSourceMarker(head) || head.httpEtag !== `"${head.etag}"` || head.etag !== row.etag.replace(/^"|"$/gu, '')
      || !/^"[\x21\x23-\x7e]+"$/u.test(head.httpEtag) || head.size !== row.size || !pinnedObjectMatches(handle, head)) return unavailable();
    // HEAD exposes only uploader-verified R2 checksum metadata. Never download
    // or buffer large client content in a Worker merely to mint a descriptor.
    await readFile(c, handle, 'file.download');
    const sha256 = checksumSha256(head);
    if (!sha256) return c.json({ error: 'A verified download checksum is not available', code: 'download-checksum-unavailable' }, 409);
    if (!head.version || head.version.length > 256 || head.version.trim() !== head.version || /[\u0000-\u001f\u007f]/u.test(head.version)) return unavailable();
    const expires = Math.min(handle.expires, Date.now() + TTL, Date.parse(context.command.expiresAt!));
    const expiresAt = Math.floor(expires / 1000);
    if (expiresAt <= Math.floor(Date.now() / 1000)) return unavailable();
    const pinnedClaims = { ...handle, providerVersion: head.version, sha256, expires: expiresAt * 1000 };
    const pinned = await encodeOperationsNativeDeliveryHandle(c.env, pinnedClaims);
    const identity = await logicalFileId(c, handle);
    await authorize(c, handle.authorityId, 'file.download', pinnedClaims);
    return c.json({ schemaVersion: 1, logicalFileId: identity, remoteVersion: head.version, strongETag: head.httpEtag,
      size: head.size, sha256, name: desktopFileName(row.r2_key),
      downloadPath: `/api/client/operations/data/files/${encodeURIComponent(pinned)}/download`, expiresAt });
  });
  async function media(c: Ctx, disposition: 'inline' | 'attachment') {
    const handle = await decode(c, c.req.param('fileHandle') ?? '', 'file'), feature = disposition === 'inline' ? 'file.preview' : 'file.download';
    const { context, row } = await readFile(c, handle, feature), type = (row.content_type ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    if (disposition === 'inline' && !/^(application\/(pdf|json)|text\/(plain|csv)|image\/(avif|gif|jpeg|png|webp)|audio\/(aac|flac|mpeg|ogg|wav|webm)|video\/(mp4|mpeg|ogg|quicktime|webm))$/u.test(type))
      throw new HTTPException(415, { message: 'Preview unavailable' });
    await authorize(c, handle.authorityId, feature, handle);
    const head = await c.env.DATA_BUCKET.head(row.r2_key);
    const etag = (value: string) => value.trim().replace(/^W\//u, '').replace(/^"|"$/gu, '');
    if (!head || isMovedSourceMarker(head) || etag(head.httpEtag) !== etag(row.etag) || head.size !== row.size || !pinnedObjectMatches(handle, head)) return unavailable();
    // Even a 416/HEAD/304 reveals metadata: re-prove the current person/resource
    // after the asynchronous storage read, not just before it.
    await readFile(c, handle, feature);
    let range: ReturnType<typeof parseRange>;
    try { range = parseRange(!c.req.header('If-Range') || c.req.header('If-Range') === head.httpEtag ? c.req.header('Range') : undefined, head.size);
      if (range && head.size === 0) throw new Error('empty-range'); }
    catch { return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${head.size}`,
      'Cache-Control': 'private, no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' } }); }
    const headers = new Headers({ 'Content-Type': disposition === 'inline' && (type.startsWith('text/') || type === 'application/json')
      ? 'text/plain; charset=utf-8' : row.content_type ?? 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${safeFileName(row.r2_key)}"; filename*=UTF-8''${encodeURIComponent(row.r2_key.split('/').at(-1) ?? 'file')}`,
      'Cache-Control': 'private, no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'ETag': head.httpEtag, 'Accept-Ranges': 'bytes', 'Content-Length': String(range?.length ?? head.size) });
    if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    await authorize(c, handle.authorityId, feature, handle);
    if (c.req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    if (!range && c.req.header('If-None-Match') === head.httpEtag) { headers.delete('Content-Length'); return new Response(null, { status: 304, headers }); }
    const object = await c.env.DATA_BUCKET.get(row.r2_key, { ...(range ? { range } : {}), onlyIf: { etagMatches: head.etag } });
    if (!object || !('body' in object)) return unavailable();
    try {
      if (isMovedSourceMarker(object) || object.etag !== head.etag || object.size !== head.size || !pinnedObjectMatches(handle, object)) return unavailable();
      await readFile(c, handle, feature);
      // This independent native audit is mandatory before bytes, not a best-
      // effort background task. It never invents a PA principal/source identity.
      try { await appendOperationsNativeContentStart(c.env, { principal: c.get('operationsPrincipal'), context,
        action: disposition === 'inline' ? 'file.preview_requested' : 'file.download_requested', feature,
        storageKey: row.r2_key, contentVersion: row.etag }); }
      catch { return temporary(); }
      await readFile(c, handle, feature);
      // Streams cannot be recalled once handed off; this is the final fresh
      // authorization boundary. Pass the R2 body through without buffering.
      return new Response(object.body, { status: range ? 206 : 200, headers });
    } catch (error) { await object.body.cancel().catch(() => undefined); throw error; }
  }
  router.on(['GET', 'HEAD'], '/files/:fileHandle/preview', c => media(c, 'inline'));
  router.on(['GET', 'HEAD'], '/files/:fileHandle/download', c => media(c, 'attachment'));
  router.onError((error, c) => c.json({ error: error instanceof HTTPException ? error.message : 'Shared data is temporarily unavailable' },
    error instanceof HTTPException ? error.status : 503));
  return router;
}
