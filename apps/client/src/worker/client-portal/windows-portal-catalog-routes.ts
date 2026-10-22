import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { queueQuery } from "@ltds/shared/windows-queue-reference";
import type { OperationsPortalNativeDeliveryAuthorityCommand, OperationsPortalNativeDeliveryPublicationContinuity } from "@ltds/shared/operations-portal-native-delivery-authority";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { isHiddenKey, validateRelativePath } from "../files";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";
import { authorizeWindowsPortalCatalog, type WindowsPortalCatalogAuthorizationEnv, type WindowsPortalCatalogContext, type WindowsPortalCatalogFeature } from "./windows-portal-catalog-authorization";
import { encodeWindowsPortalCatalogHandle, decodeWindowsPortalCatalogHandle, windowsPortalCatalogHandleMatchesContext, type WindowsPortalCatalogHandle } from "./windows-portal-catalog-handles";
import { authorizeWindowsPortalSuccessor, type WindowsPortalSuccessorContext } from "./windows-portal-successor-authorization";
import { prepareWindowsPortalSuccessorManifest, type WindowsPortalSuccessorRouteEnv } from "./windows-portal-successor-routes";
import { encodeOperationsNativeDeliveryHandle, operationsNativeDeliveryHandleMatchesCommand, type OperationsNativeDeliveryHandle } from "./operations-native-delivery-handles";
import type { VerifiedClientPrincipal } from "./types";

export type WindowsPortalCatalogRouteEnv = WindowsPortalSuccessorRouteEnv & WindowsPortalCatalogAuthorizationEnv;
type Principal = Pick<VerifiedClientPrincipal, "issuer" | "subject">;
type Human = { principal: VerifiedClientPrincipal; verifiedUntil: string };
type Anchor = { originalRequestFingerprint: string; selectedR2Prefix: string; continuity: OperationsPortalNativeDeliveryPublicationContinuity };
type FileRow = { r2_key: string; etag: string; size: number };
const BASE = "/api/client/operations/data/windows-catalog", PAGE = 25;
const visibleSql = `instr(lower('/'||f.r2_key||'/'),'/_ltds/')=0 AND instr(lower('/'||f.r2_key||'/'),'/.previews/')=0
  AND instr(lower('/'||f.r2_key||'/'),'/dump/')=0 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t
    WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key)))`;
const fail = (status: 400 | 401 | 403 | 404 | 503): never => { throw new HTTPException(status, { message: "Windows files are unavailable" }); };
function live(until: number, signal?: AbortSignal) { if (!Number.isSafeInteger(until) || until <= Date.now()) fail(401); if (signal?.aborted) fail(404); }
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 500);
async function boundedMap<T, R>(values: readonly T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < values.length; offset += 4) {
    // Drain every admitted operation even when one fails. A page never leaves
    // unobserved authorization RPCs running after returning an error.
    const batch = await Promise.allSettled(values.slice(offset, offset + 4).map(operation));
    for (const result of batch) { if (result.status === "rejected") throw result.reason; output.push(result.value); }
  }
  return output;
}
function sameAnchor(a: Anchor, b: Anchor) {
  const x = a.continuity, y = b.continuity;
  const pins = (p: typeof x.first, q: typeof x.first) => p.operationId === q.operationId && p.publicationId === q.publicationId
    && p.revision === q.revision && p.sourceSequence === q.sourceSequence && p.snapshotId === q.snapshotId && p.snapshotSha256 === q.snapshotSha256;
  return a.originalRequestFingerprint === b.originalRequestFingerprint && a.selectedR2Prefix === b.selectedR2Prefix
    && x.grantOperationId === y.grantOperationId && x.grantFingerprint === y.grantFingerprint && x.chainSha256 === y.chainSha256
    && x.publicationCount === y.publicationCount && pins(x.first, y.first) && pins(x.current, y.current);
}
async function authorize(env: WindowsPortalCatalogRouteEnv, person: Principal, until: number, authorityId: string,
  feature: WindowsPortalCatalogFeature, expected?: Anchor, handle?: WindowsPortalCatalogHandle, signal?: AbortSignal) {
  live(until, signal);
  const result = await authorizeWindowsPortalCatalog(env, person, authorityId, feature);
  if (!result.ok) return fail(result.code === "unavailable" ? 503 : 404);
  if (expected && !sameAnchor(expected, result.catalogContext)
    || handle && !await windowsPortalCatalogHandleMatchesContext(handle, result.catalogContext, person, until)) return fail(404);
  live(until, signal); return result.catalogContext;
}
async function decode(env: WindowsPortalCatalogRouteEnv, raw: string, person: Principal, kind: WindowsPortalCatalogHandle["kind"]) {
  const value = await decodeWindowsPortalCatalogHandle(env, raw);
  if (!value || value.kind !== kind || value.issuer !== person.issuer || value.subject !== person.subject) return fail(404);
  return value;
}
async function label(env: WindowsPortalCatalogRouteEnv, context: WindowsPortalCatalogContext) {
  const g = context.originalGrant;
  const name = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT substr(json_extract(project.value,'$.name'),1,500) name
    FROM operations_portal_workspace_publication_snapshots snapshot,json_each(snapshot.snapshot_json,'$.projects') project
    WHERE snapshot.snapshot_id=? AND json_extract(project.value,'$.externalProjectId')=?
      AND json_extract(project.value,'$.version')=? AND json_extract(project.value,'$.published')=1`)
    .bind(context.continuity.current.snapshotId, g.resource.externalProjectId, g.resource.projectVersion).first<string>("name");
  return typeof name === "string" ? clean(name) : fail(404);
}
function selector(g: OperationsPortalNativeDeliveryAuthorityCommand, path: string, expires: number): OperationsNativeDeliveryHandle {
  return { v: 1, kind: "file", authorityId: g.authority.authorityId, authorityRevision: g.authority.resultingRevision,
    ...g.recipient, targetId: g.target.targetId, targetRevision: g.target.targetRevision, clientAuthorityId: g.target.clientAuthorityId, workspaceId: g.target.workspaceId,
    publicationId: g.publication.publicationId, publicationOperationId: g.publication.operationId, publicationRevision: g.publication.revision,
    publicationSourceSequence: g.publication.sourceSequence, snapshotId: g.publication.snapshotId, snapshotSha256: g.publication.snapshotSha256,
    folderReservationId: g.resource.folderReservationId, folderReservationRevision: g.resource.folderReservationRevision,
    clientFolderBindingId: g.resource.clientFolderBindingId, externalProjectId: g.resource.externalProjectId, projectVersion: g.resource.projectVersion,
    path, etag: "pending", expires };
}
/** A metadata ticket never grants download permission. Reference/manifest callers
 * independently prove download authority with the same original/current anchor.
 * This lightweight conversion does not read file_index, R2 or audit content. */
export async function selectWindowsPortalCatalogDownload(env: WindowsPortalCatalogRouteEnv, raw: string, person: Principal,
  until: number, signal?: AbortSignal): Promise<{ catalogContext: WindowsPortalCatalogContext; downloadContext: WindowsPortalSuccessorContext; originalSelector: OperationsNativeDeliveryHandle }> {
  const handle = await decode(env, raw, person, "file"); if (handle.kind !== "file") return fail(404);
  const metadata = await authorize(env, person, until, handle.authorityId, "file.metadata", undefined, handle, signal);
  if (!metadata.originalGrant.features.includes("file.download")) return fail(404);
  const result = await authorizeWindowsPortalSuccessor(env, person, handle.authorityId);
  if (!result.ok) return fail(result.code === "unavailable" ? 503 : 404);
  if (!sameAnchor(metadata, result.successorContext)) return fail(404);
  const originalSelector = selector(result.successorContext.originalGrant, handle.path,
    Math.min(handle.expires, until, Date.parse(result.successorContext.originalGrant.expiresAt!)));
  await encodeOperationsNativeDeliveryHandle(env, originalSelector);
  if (!operationsNativeDeliveryHandleMatchesCommand(originalSelector, result.successorContext.originalGrant)) return fail(404);
  live(until, signal);
  return { catalogContext: metadata, downloadContext: result.successorContext, originalSelector };
}

/** New source-only Windows catalog. No production index mounts this factory;
 * ordinary browser catalogs and byte protocols keep their original semantics. */
export function createWindowsPortalCatalogRouter(input: Readonly<{ enabled: boolean; portalOrigin: string; issuer: string; audience: string }>) {
  const config = Object.freeze({ ...input });
  const router = new Hono<{ Bindings: WindowsPortalCatalogRouteEnv; Variables: { human: Human } }>().basePath(BASE);
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    if (config.enabled !== true || c.env.CLIENT_PORTAL_ENABLED !== "true" || !nativeDeliveryDeploymentEnabled(c.env)
      || c.env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== "true" || c.env.CLIENT_PORTAL_ORIGIN !== config.portalOrigin
      || c.env.CLIENT_ACCESS_TEAM_DOMAIN?.replace(/\/$/u, "") !== config.issuer) return fail(503);
    if (new URL(c.req.url).origin !== config.portalOrigin || c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.portalOrigin
      || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return fail(403);
    if (c.req.method !== "GET") return c.body(null, 405);
    const human = await resolveCloudflareRecipientEnrollmentProof(c.req.raw, { ...c.env, CLIENT_ACCESS_AUD: config.audience, CLIENT_ACCESS_AUDS: config.audience });
    if (!human) return fail(401); live(Date.parse(human.verifiedUntil), c.req.raw.signal); c.set("human", human); return next();
  });
  router.get("/deliveries", async c => {
    const q = queueQuery(c.req.url, c.req.query("cursor") === undefined ? [] : ["cursor"]);
    const { principal, verifiedUntil } = c.get("human"), until = Date.parse(verifiedUntil), signal = c.req.raw.signal;
    const raw = q.get("cursor"), cursor = raw ? await decode(c.env, raw, principal, "cursor") : null;
    if (cursor && (cursor.kind !== "cursor" || cursor.scope !== "deliveries" || cursor.path !== "" || cursor.entryKind !== "delivery" || cursor.after !== cursor.authorityId)) return fail(404);
    if (cursor) await authorize(c.env, principal, until, cursor.authorityId, "folder.list", undefined, cursor, signal);
    const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT authority_id
      FROM operations_portal_native_delivery_successor_candidates
      WHERE issuer=? AND subject=? AND authority_id>?
        AND EXISTS(SELECT 1 FROM json_each(canonical_command_json,'$.features') feature WHERE feature.value='folder.list')
      ORDER BY authority_id LIMIT ?`).bind(principal.issuer, principal.subject, cursor?.kind === "cursor" ? cursor.after : "", PAGE + 1).all<{ authority_id: string }>();
    if (!rows.success || rows.results.length > PAGE + 1) return fail(503);
    const built = await boundedMap(rows.results.slice(0, PAGE), async row => {
      const context = await authorize(c.env, principal, until, row.authority_id, "folder.list", undefined, undefined, signal);
      return { context, item: { id: await encodeWindowsPortalCatalogHandle(c.env, context, principal, until, { kind: "folder", path: "" }), displayName: await label(c.env, context) } };
    });
    const items = built.map(value => value.item), contexts = built.map(value => value.context);
    const last = contexts.at(-1), nextCursor = rows.results.length > PAGE && last
      ? await encodeWindowsPortalCatalogHandle(c.env, last, principal, until, { kind: "cursor", scope: "deliveries", path: "", after: last.originalGrant.authority.authorityId, entryKind: "delivery" }) : null;
    await boundedMap(contexts, context => authorize(c.env, principal, until, context.originalGrant.authority.authorityId, "folder.list", context, undefined, signal));
    if (cursor) await authorize(c.env, principal, until, cursor.authorityId, "folder.list", undefined, cursor, signal);
    live(until, signal); return c.json({ schemaVersion: 1, resourceMode: "windows_portal_catalog", items, page: { nextCursor } });
  });
  router.get("/folders/:folderHandle", async c => {
    const q = queueQuery(c.req.url, c.req.query("cursor") === undefined ? [] : ["cursor"]);
    const { principal, verifiedUntil } = c.get("human"), until = Date.parse(verifiedUntil), signal = c.req.raw.signal;
    const raw = c.req.param("folderHandle"); if (new URL(c.req.url).pathname !== BASE + "/folders/" + raw) return fail(404);
    const handle = await decode(c.env, raw, principal, "folder"); if (handle.kind !== "folder") return fail(404);
    const context = await authorize(c.env, principal, until, handle.authorityId, "folder.list", undefined, handle, signal);
    const metadata = context.originalGrant.features.includes("file.metadata") ? await authorize(c.env, principal, until, handle.authorityId, "file.metadata", context, undefined, signal) : null;
    const cursor = q.get("cursor") ? await decode(c.env, q.get("cursor")!, principal, "cursor") : null;
    if (cursor) {
      if (cursor.kind !== "cursor" || cursor.scope !== "folder" || cursor.path !== handle.path || cursor.authorityId !== handle.authorityId) return fail(404);
      await authorize(c.env, principal, until, handle.authorityId, "folder.list", context, cursor, signal);
    }
    const prefix = context.selectedR2Prefix + handle.path, upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`WITH candidates AS (
      SELECT f.r2_key,f.etag,f.size,substr(f.r2_key,?) relative_key FROM file_index f WHERE f.r2_key>=? AND f.r2_key<? AND ${visibleSql}
    ), entries AS (
      SELECT 'folder' entry_kind,substr(relative_key,1,instr(relative_key,'/')-1) entry_name,NULL r2_key,NULL etag,NULL size
      FROM candidates WHERE instr(relative_key,'/')>0 GROUP BY substr(relative_key,1,instr(relative_key,'/')-1)
      UNION ALL SELECT 'file',relative_key,r2_key,etag,size FROM candidates WHERE relative_key<>'' AND instr(relative_key,'/')=0)
      SELECT * FROM entries WHERE (entry_name,entry_kind)>(?,?) AND (?=1 OR entry_kind='folder') ORDER BY entry_name,entry_kind LIMIT ?`)
      .bind(Array.from(prefix).length + 1, prefix, upper, cursor?.kind === "cursor" ? cursor.after : "", cursor?.kind === "cursor" ? cursor.entryKind : "", metadata ? 1 : 0, PAGE + 1)
      .all<FileRow & { entry_kind: "folder" | "file"; entry_name: string }>();
    if (!rows.success || rows.results.length > PAGE + 1) return fail(503);
    const page = rows.results.slice(0, PAGE), folders = [], files = [];
    for (const row of page) {
      const path = handle.path + validateRelativePath(row.entry_name); if (isHiddenKey(path)) return fail(404);
      if (row.entry_kind === "folder") folders.push({ id: await encodeWindowsPortalCatalogHandle(c.env, context, principal, until, { kind: "folder", path: path + "/" }), name: clean(row.entry_name) });
      else if (metadata) {
        if (row.r2_key !== context.selectedR2Prefix + path || !Number.isSafeInteger(row.size) || row.size < 0) return fail(404);
        files.push({ id: await encodeWindowsPortalCatalogHandle(c.env, metadata, principal, until, { kind: "file", path, indexedETag: row.etag, size: row.size }),
          name: clean(row.entry_name), size: row.size, downloadAvailable: metadata.originalGrant.features.includes("file.download") });
      }
    }
    const breadcrumbs = [{ id: await encodeWindowsPortalCatalogHandle(c.env, context, principal, until, { kind: "folder", path: "" }), name: await label(c.env, context) }];
    let path = "";
    for (const part of handle.path.split("/").filter(Boolean)) { path += part + "/"; breadcrumbs.push({ id: await encodeWindowsPortalCatalogHandle(c.env, context, principal, until, { kind: "folder", path }), name: clean(part) }); }
    const last = page.at(-1), next = rows.results.length > PAGE && last ? await encodeWindowsPortalCatalogHandle(c.env, context, principal, until,
      { kind: "cursor", scope: "folder", path: handle.path, after: last.entry_name, entryKind: last.entry_kind }) : null;
    await authorize(c.env, principal, until, handle.authorityId, "folder.list", context, handle, signal);
    if (metadata) await authorize(c.env, principal, until, handle.authorityId, "file.metadata", metadata, undefined, signal);
    if (cursor) await authorize(c.env, principal, until, handle.authorityId, "folder.list", context, cursor, signal);
    live(until, signal); return c.json({ schemaVersion: 1, resourceMode: "windows_portal_catalog", folderId: raw, prefix: "", files, folders, breadcrumbs, cursor: next });
  });
  router.get("/files/:fileHandle", async c => {
    queueQuery(c.req.url, []); const raw = c.req.param("fileHandle"); if (new URL(c.req.url).pathname !== BASE + "/files/" + raw) return fail(404);
    const { principal, verifiedUntil } = c.get("human"), until = Date.parse(verifiedUntil), signal = c.req.raw.signal;
    const handle = await decode(c.env, raw, principal, "file"); if (handle.kind !== "file") return fail(404);
    const context = await authorize(c.env, principal, until, handle.authorityId, "file.metadata", undefined, handle, signal);
    const row = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT f.r2_key,f.etag,f.size FROM file_index f WHERE f.r2_key=? AND ${visibleSql}`)
      .bind(context.selectedR2Prefix + handle.path).first<FileRow>();
    if (!row || row.r2_key !== context.selectedR2Prefix + handle.path || row.etag !== handle.indexedETag || row.size !== handle.size) return fail(404);
    await authorize(c.env, principal, until, handle.authorityId, "file.metadata", context, handle, signal);
    return c.json({ schemaVersion: 1, resourceMode: "windows_portal_catalog", file: { id: raw, name: clean(handle.path.split("/").at(-1)!), size: row.size,
      downloadAvailable: context.originalGrant.features.includes("file.download") } });
  });
  router.get("/files/:fileHandle/download-manifest", async c => {
    queueQuery(c.req.url, []); const raw = c.req.param("fileHandle"); if (new URL(c.req.url).pathname !== BASE + "/files/" + raw + "/download-manifest") return fail(404);
    const { principal, verifiedUntil } = c.get("human"), until = Date.parse(verifiedUntil), signal = c.req.raw.signal;
    const selected = await selectWindowsPortalCatalogDownload(c.env, raw, principal, until, signal);
    return prepareWindowsPortalSuccessorManifest(c.env, selected.downloadContext, principal, until, selected.originalSelector.path, signal);
  });
  router.onError((error, c) => c.json({ error: "Windows files are unavailable" }, error instanceof HTTPException ? error.status : 503));
  return router;
}
