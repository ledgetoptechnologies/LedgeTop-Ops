import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { IncomingEnv } from "./incoming";
import { verifiedObjectAvailable, type VerifiedObjectRow } from "./incoming-verification";

const MAX_ENTRIES = 10_000, MAX_METADATA_BYTES = 1024 * 1024, PAGE_LIMIT = 100;
const reasons = ["not_zip","zip64_invalid","multi_disk","central_directory_too_large","entry_limit","metadata_limit","invalid_path","unsafe_symlink","unsafe_special_file","encrypted_entries","duplicate_path","conflicting_path","malformed_central_directory","io_error"] as const;
const proof = { claimToken: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/i), objectEtag: z.string().regex(/^[a-f0-9-]{1,128}$/i), objectBytes: z.number().int().positive(), objectVersion: z.string().min(1).max(1024).optional() };
const entry = z.object({ path: z.string().min(1).max(2048), name: z.string().min(1).max(255), kind: z.enum(["folder", "file"]), size: z.number().int().min(0).optional() }).strict();
export const archiveInventoryReceiptSchema = z.object({ ...proof, inventoryId: z.string().uuid(), page: z.number().int().min(0).max(100_000), complete: z.boolean(), entries: z.array(entry).max(250) }).strict();
export const archiveInventoryUnavailableSchema = z.object({ ...proof, inventoryId: z.string().uuid(), reason: z.enum(reasons) }).strict();
type Receipt = z.infer<typeof archiveInventoryReceiptSchema>;

function validPath(path: string, name: string): { parent: string; bytes: number } {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || /(^|\/)(?:\.|\.\.)(?:\/|$)/.test(path) || /(^|\/)\//.test(path)) throw new HTTPException(400, { message: "Invalid archive entry" });
  const parts = path.split("/");
  if (parts.length > 32 || parts.at(-1) !== name || !parts.every(part => part.length && !/[\x00-\x1f]/.test(part))) throw new HTTPException(400, { message: "Invalid archive entry" });
  return { parent: parts.slice(0, -1).join("/"), bytes: new TextEncoder().encode(JSON.stringify({ path, name })).byteLength + 32 };
}
async function digest(value: unknown) { const bytes = new TextEncoder().encode(JSON.stringify(value)); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join(""); }
function proofBinds(uploadId:string,input:Pick<Receipt,"claimToken"|"sha256"|"objectEtag"|"objectBytes"|"objectVersion">) { return [uploadId,input.claimToken,input.sha256.toLowerCase(),input.objectEtag.toLowerCase(),input.objectBytes,input.objectVersion??null,input.objectVersion??null]; }
const proofFence = `EXISTS (SELECT 1 FROM file_request_uploads u WHERE u.id=? AND u.status='quarantined' AND u.verification_state='verified' AND u.verification_receipt_token=? AND u.verified_sha256=? AND lower(u.verified_object_etag)=? AND u.verified_object_bytes=? AND (? IS NULL OR u.verified_object_version=?))`;
async function verified(env: IncomingEnv, id: string, input: z.infer<typeof archiveInventoryReceiptSchema> | z.infer<typeof archiveInventoryUnavailableSchema>) {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,object_key objectKey,original_name originalName,content_type contentType,status,verification_state verificationState,verified_object_etag verifiedObjectEtag,verified_object_bytes verifiedObjectBytes,verified_object_version verifiedObjectVersion,verified_sha256 verifiedSha256,verification_receipt_token receiptToken FROM file_request_uploads WHERE id=?`).bind(id).first<VerifiedObjectRow & { verifiedSha256: string | null; receiptToken: string | null }>();
  if (!row || row.status !== "quarantined" || row.verificationState !== "verified" || row.receiptToken !== input.claimToken || row.verifiedSha256 !== input.sha256.toLowerCase() || row.verifiedObjectEtag?.toLowerCase() !== input.objectEtag.toLowerCase() || row.verifiedObjectBytes !== input.objectBytes || (input.objectVersion && row.verifiedObjectVersion !== input.objectVersion)) throw new HTTPException(409, { message: "Verification proof is no longer current" });
  return row;
}
export async function recordArchiveInventory(env: IncomingEnv, uploadId: string, input: Receipt): Promise<Record<string, unknown>> {
  const verifiedRow=await verified(env, uploadId, input);
  const normalized = input.entries.map(value => ({ ...value, ...validPath(value.path, value.name) }));
  if (new Set(normalized.map(value => value.path)).size !== normalized.length) throw new HTTPException(400, { message: "Invalid archive entry" });
  const contentHash = await digest({ complete: input.complete, entries: input.entries });
  const db = env.DELIVERY_DB;
  let existing = await db.prepare("SELECT inventory_id inventoryId,status,next_page nextPage,entry_count entryCount,metadata_bytes metadataBytes,receipt_token receiptToken,proof_sha256 sha256,proof_etag etag,proof_bytes bytes,proof_version version FROM file_request_upload_archive_inventory WHERE upload_id=?").bind(uploadId).first<{ inventoryId:string;status:string;nextPage:number;entryCount:number;metadataBytes:number;receiptToken:string;sha256:string;etag:string;bytes:number;version:string|null }>();
  if(existing && (existing.receiptToken!==input.claimToken||existing.sha256!==input.sha256.toLowerCase()||existing.etag.toLowerCase()!==input.objectEtag.toLowerCase()||existing.bytes!==input.objectBytes||existing.version!==verifiedRow.verifiedObjectVersion)) {
    const supersededId = existing.inventoryId;
    const removed=await db.prepare(`DELETE FROM file_request_upload_archive_inventory WHERE upload_id=? AND inventory_id=? AND receipt_token<>? AND ${proofFence}`).bind(uploadId,supersededId,input.claimToken,...proofBinds(uploadId,input)).run();
    if(removed.meta.changes!==1) throw new HTTPException(409,{message:"Inventory receipt is no longer active"});
    // A concurrent callback may already be staging the replacement. Retire only
    // the superseded generation, never all metadata for this upload.
    await db.batch([db.prepare("DELETE FROM file_request_upload_archive_inventory_entries WHERE upload_id=? AND inventory_id=?").bind(uploadId,supersededId),db.prepare("DELETE FROM file_request_upload_archive_inventory_pages WHERE upload_id=? AND inventory_id=?").bind(uploadId,supersededId)]);
    existing=await db.prepare("SELECT inventory_id inventoryId,status,next_page nextPage,entry_count entryCount,metadata_bytes metadataBytes,receipt_token receiptToken,proof_sha256 sha256,proof_etag etag,proof_bytes bytes,proof_version version FROM file_request_upload_archive_inventory WHERE upload_id=?").bind(uploadId).first<typeof existing>();
  }
  if (!existing) {
    if (input.page !== 0) throw new HTTPException(409, { message: "Inventory must start at page zero" });
    const created=await db.prepare(`INSERT INTO file_request_upload_archive_inventory(upload_id,inventory_id,status,receipt_token,proof_sha256,proof_etag,proof_bytes,proof_version) SELECT ?,?,'pending',u.verification_receipt_token,u.verified_sha256,lower(u.verified_object_etag),u.verified_object_bytes,u.verified_object_version FROM file_request_uploads u WHERE u.id=? AND ${proofFence}`).bind(uploadId,input.inventoryId,uploadId,...proofBinds(uploadId,input)).run();
    if(created.meta.changes!==1) throw new HTTPException(409,{message:"Verification proof is no longer current"});
  } else if (existing.inventoryId !== input.inventoryId) throw new HTTPException(409, { message: "Inventory receipt is no longer active" });
  const page = await db.prepare("SELECT content_hash contentHash FROM file_request_upload_archive_inventory_pages WHERE upload_id=? AND inventory_id=? AND page=?").bind(uploadId,input.inventoryId,input.page).first<{contentHash:string}>();
  if (page) { if (page.contentHash !== contentHash) throw new HTTPException(409,{message:"Inventory page replay differs"}); return { ok:true, status:existing?.status ?? "pending", replayed:true }; }
  if (existing && existing.status !== "pending") throw new HTTPException(409, { message: "Inventory receipt is no longer active" });
  const state = await db.prepare("SELECT next_page nextPage,entry_count entryCount,metadata_bytes metadataBytes FROM file_request_upload_archive_inventory WHERE upload_id=? AND inventory_id=? AND status='pending'").bind(uploadId,input.inventoryId).first<{nextPage:number;entryCount:number;metadataBytes:number}>();
  if (!state || state.nextPage !== input.page) throw new HTTPException(409,{message:"Inventory pages must be sequential"});
  const bytes = normalized.reduce((sum,value)=>sum+value.bytes,0); if (state.entryCount + normalized.length > MAX_ENTRIES || state.metadataBytes + bytes > MAX_METADATA_BYTES) throw new HTTPException(413,{message:"Inventory exceeds limits"});
  const occupied=new Map<string,"folder"|"file">((await db.prepare("SELECT path,kind FROM file_request_upload_archive_inventory_entries WHERE upload_id=? AND inventory_id=?").bind(uploadId,input.inventoryId).all<{path:string;kind:"folder"|"file"}>()).results.map(value=>[value.path,value.kind]));
  for(const value of normalized){ if(occupied.has(value.path) || (value.kind==="file" && [...occupied.keys()].some(path=>path.startsWith(`${value.path}/`)))) throw new HTTPException(409,{message:"Invalid or conflicting archive inventory"}); for(const parent of value.path.split("/").slice(0,-1).map((_,index,parts)=>parts.slice(0,index+1).join("/")))if(occupied.get(parent)==="file")throw new HTTPException(409,{message:"Invalid or conflicting archive inventory"}); occupied.set(value.path,value.kind); }
  const activeWhere=`WHERE i.upload_id=? AND i.inventory_id=? AND i.status='pending' AND i.next_page=? AND ${proofFence}`, active=`FROM file_request_upload_archive_inventory i ${activeWhere}`;
  const guard=db.prepare(`UPDATE file_request_upload_archive_inventory AS i SET updated_at=updated_at ${activeWhere}`).bind(uploadId,input.inventoryId,input.page,...proofBinds(uploadId,input));
  const statements: D1PreparedStatement[] = [guard, ...normalized.map(value => db.prepare(`INSERT INTO file_request_upload_archive_inventory_entries(upload_id,inventory_id,path,parent_path,name,name_folded,kind,size) SELECT ?,?,?,?,?,?,?,? ${active}`).bind(uploadId,input.inventoryId,value.path,value.parent,value.name,value.name.toLowerCase(),value.kind,value.kind === "file" ? value.size ?? 0 : null,uploadId,input.inventoryId,input.page,...proofBinds(uploadId,input)))];
  statements.push(db.prepare(`INSERT INTO file_request_upload_archive_inventory_pages(upload_id,inventory_id,page,content_hash) SELECT ?,?,?,? ${active}`).bind(uploadId,input.inventoryId,input.page,contentHash,uploadId,input.inventoryId,input.page,...proofBinds(uploadId,input)));
  statements.push(db.prepare(`UPDATE file_request_upload_archive_inventory SET next_page=next_page+1,entry_count=entry_count+?,metadata_bytes=metadata_bytes+?,status=CASE WHEN ? THEN 'ready' ELSE status END,updated_at=datetime('now') WHERE upload_id=? AND inventory_id=? AND status='pending' AND next_page=? AND ${proofFence}`).bind(normalized.length,bytes,input.complete?1:0,uploadId,input.inventoryId,input.page,...proofBinds(uploadId,input)));
  try { const results=await db.batch(statements); if(results[0]?.meta.changes!==1 || results.at(-1)?.meta.changes!==1) throw new Error("stale"); } catch { throw new HTTPException(409,{message:"Invalid or conflicting archive inventory"}); }
  return { ok:true,status:input.complete?"ready":"pending",replayed:false };
}
export async function markArchiveInventoryUnavailable(env: IncomingEnv, uploadId:string, input:z.infer<typeof archiveInventoryUnavailableSchema>) {
  await verified(env,uploadId,input);
  const inserted=await env.DELIVERY_DB.prepare(`INSERT INTO file_request_upload_archive_inventory(upload_id,inventory_id,status,receipt_token,proof_sha256,proof_etag,proof_bytes,proof_version,unavailable_reason) SELECT ?,?,'unavailable',u.verification_receipt_token,u.verified_sha256,lower(u.verified_object_etag),u.verified_object_bytes,u.verified_object_version,? FROM file_request_uploads u WHERE u.id=? AND ${proofFence} ON CONFLICT(upload_id) DO NOTHING`).bind(uploadId,input.inventoryId,input.reason,uploadId,...proofBinds(uploadId,input)).run();
  if(!inserted.meta.changes){const current=await env.DELIVERY_DB.prepare("SELECT inventory_id inventoryId,status,unavailable_reason reason FROM file_request_upload_archive_inventory WHERE upload_id=?").bind(uploadId).first<{inventoryId:string;status:string;reason:string|null}>();if(current?.inventoryId!==input.inventoryId||current.status!=="unavailable"||current.reason!==input.reason)throw new HTTPException(409,{message:"Inventory receipt is no longer active"});}
  return {ok:true,status:"unavailable"};
}
function encodeCursor(value:unknown){const bytes=new TextEncoder().encode(JSON.stringify(value));let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function cursor(value: string | null, scope: string, path: string): string | null {
  if (!value) return null;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const base = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base + "=".repeat((4 - base.length % 4) % 4));
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    if (raw.scope !== scope || typeof raw.last !== "string" || !raw.last || raw.last.length > 255 || raw.last.includes("/")) throw new Error();
    const last = path ? `${path}/${raw.last}` : raw.last;
    validPath(last, raw.last);
    return last;
  } catch { throw new HTTPException(400, { message: "Invalid inventory cursor" }); }
}
function next(scope: string, last: string) { return encodeCursor({ scope, last: last.split("/").at(-1) }); }
export async function listArchiveInventory(env:IncomingEnv, uploadId:string, pathValue:string|null, qValue:string|null, cursorValue:string|null) {
  const path=pathValue||"", q=(qValue||"").toLowerCase(); if(path.length>2048||q.length>128)throw new HTTPException(400,{message:"Invalid inventory query"}); if(path && validPath(`${path}/x`,"x").parent !== path) throw new HTTPException(400,{message:"Invalid inventory query"});
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT u.id,u.object_key objectKey,u.original_name originalName,u.content_type contentType,u.status,u.verification_state verificationState,u.verified_object_etag verifiedObjectEtag,u.verified_object_bytes verifiedObjectBytes,u.verified_object_version verifiedObjectVersion,i.inventory_id inventoryId,i.status inventoryStatus FROM file_request_uploads u LEFT JOIN file_request_upload_archive_inventory i ON i.upload_id=u.id AND i.receipt_token=u.verification_receipt_token AND i.proof_sha256=u.verified_sha256 AND lower(i.proof_etag)=lower(u.verified_object_etag) AND i.proof_bytes=u.verified_object_bytes AND i.proof_version=u.verified_object_version WHERE u.id=?`).bind(uploadId).first<(VerifiedObjectRow & {inventoryId:string|null;inventoryStatus:string|null})>();
  if(!row)throw new HTTPException(404,{message:"Archive inventory unavailable"}); const object=await env.INCOMING_BUCKET.head(row.objectKey); if(!verifiedObjectAvailable(row,object)||!row.inventoryId||row.inventoryStatus!=="ready") return {status:"unavailable",items:[],nextCursor:null};
  const scope = await digest({ uploadId, inventoryId: row.inventoryId, path, q });
  const last=cursor(cursorValue,scope,path); const literalQ=q.replace(/[\\%_]/g,"\\$&");
  const rows=await env.DELIVERY_DB.prepare(`SELECT path,name,kind,size FROM file_request_upload_archive_inventory_entries WHERE upload_id=? AND inventory_id=? AND parent_path=? AND (?='' OR name_folded LIKE '%' || ? || '%' ESCAPE '\\') AND (? IS NULL OR path>?) ORDER BY path LIMIT ?`).bind(uploadId,row.inventoryId,path,q,literalQ,last,last,PAGE_LIMIT+1).all<{path:string;name:string;kind:"folder"|"file";size:number|null}>(); const page=rows.results.slice(0,PAGE_LIMIT),more=rows.results[PAGE_LIMIT]; return {status:"ready",items:page.map(v=>v.kind==="file"?v:{path:v.path,name:v.name,kind:v.kind}),nextCursor:more?next(scope,page.at(-1)!.path):null};
}
