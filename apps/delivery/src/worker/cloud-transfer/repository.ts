import type { CloudItemStatus, CloudTransferEnv, CloudTransferItem, CloudTransferJob, TransferSource } from "./types";

export function cloudDb(env: CloudTransferEnv): ReturnType<D1Database["withSession"]> {
  return env.DELIVERY_DB.withSession("first-primary");
}

export async function getCloudJob(env: CloudTransferEnv, jobId: string): Promise<CloudTransferJob | null> {
  return cloudDb(env).prepare("SELECT * FROM cloud_transfer_jobs WHERE id=?").bind(jobId).first<CloudTransferJob>();
}

export interface GooglePickerAuthorizationRow {
  id: string;
  credential_ciphertext: string;
  credential_iv: string;
  key_id: string;
}

export async function getGooglePickerAuthorization(env:CloudTransferEnv,authorizationId:string,shareId:string,shareVersion:number):Promise<GooglePickerAuthorizationRow|null>{
 return cloudDb(env).prepare(`SELECT id,credential_ciphertext,credential_iv,key_id FROM cloud_transfer_authorizations
  WHERE id=? AND share_id=? AND share_version=? AND provider='google' AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
   AND EXISTS(SELECT 1 FROM cloud_transfer_jobs j WHERE j.authorization_id=cloud_transfer_authorizations.id AND j.status='queued'
    AND json_extract(j.destination_json,'$.pendingPicker')=1)`)
  .bind(authorizationId,shareId,shareVersion).first<GooglePickerAuthorizationRow>();
}

export function validGoogleFolderId(value:unknown):value is string{return typeof value==="string"&&/^[A-Za-z0-9_-]{1,256}$/.test(value);}

export async function activatePendingGoogleJob(env:CloudTransferEnv,input:{authorizationId:string;shareId:string;shareVersion:number;folderId:string}):Promise<CloudTransferJob|null>{
 if(!validGoogleFolderId(input.folderId))return null;
 const job=await cloudDb(env).prepare(`SELECT j.* FROM cloud_transfer_jobs j JOIN cloud_transfer_authorizations a ON a.id=j.authorization_id
  WHERE j.authorization_id=? AND j.share_id=? AND j.share_version=? AND j.provider='google' AND j.status='queued'
   AND json_extract(j.destination_json,'$.pendingPicker')=1 AND a.revoked_at IS NULL AND datetime(a.expires_at)>datetime('now')`)
  .bind(input.authorizationId,input.shareId,input.shareVersion).first<CloudTransferJob>();
 if(!job)return null;
 const updated=await cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET destination_json=?,updated_at=datetime('now')
  WHERE id=? AND status='queued' AND json_extract(destination_json,'$.pendingPicker')=1`).bind(JSON.stringify({folderId:input.folderId}),job.id).run();
 return updated.meta.changes?{...job,destination_json:JSON.stringify({folderId:input.folderId})}:null;
}

export async function getAuthorizedCloudJob(
  env: CloudTransferEnv, jobId: string, shareId: string, shareVersion: number,
): Promise<CloudTransferJob | null> {
  return cloudDb(env).prepare("SELECT * FROM cloud_transfer_jobs WHERE id=? AND share_id=? AND share_version=?")
    .bind(jobId, shareId, shareVersion).first<CloudTransferJob>();
}

export async function listCloudItems(env: CloudTransferEnv, jobId: string): Promise<CloudTransferItem[]> {
  return (await cloudDb(env).prepare("SELECT * FROM cloud_transfer_items WHERE job_id=? ORDER BY ordinal").bind(jobId).all<CloudTransferItem>()).results;
}

export async function replaceCloudItems(env: CloudTransferEnv, job: CloudTransferJob, sources: TransferSource[]): Promise<void> {
  const statements: D1PreparedStatement[] = [
    cloudDb(env).prepare("DELETE FROM cloud_transfer_items WHERE job_id=?").bind(job.id),
  ];
  sources.forEach((source, ordinal) => statements.push(
    cloudDb(env).prepare(`INSERT INTO cloud_transfer_items
      (id,job_id,ordinal,source_key,relative_path,source_etag,source_size,destination_path,status)
      VALUES (?,?,?,?,?,?,?,?, 'queued')`)
      .bind(crypto.randomUUID(), job.id, ordinal, source.physicalKey, source.relativePath, source.etag, source.size, source.destinationPath),
  ));
  statements.push(cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET status='running',file_count=?,total_bytes=?,
    processed_files=0,succeeded_files=0,failed_files=0,processed_bytes=0,started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now')
    WHERE id=? AND status='queued'`).bind(sources.length, sources.reduce((sum, source) => sum + source.size, 0), job.id));
  await env.DELIVERY_DB.batch(statements);
}

export async function cloudJobCancelled(env: CloudTransferEnv, jobId: string): Promise<boolean> {
  const row = await cloudDb(env).prepare("SELECT status,cancel_requested_at FROM cloud_transfer_jobs WHERE id=?").bind(jobId)
    .first<{ status: string; cancel_requested_at: string | null }>();
  return !row || row.status === "cancelling" || row.status === "cancelled" || Boolean(row.cancel_requested_at);
}

export async function requestCloudCancellation(env: CloudTransferEnv, jobId: string, shareId: string, shareVersion: number): Promise<boolean> {
  const result = await cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET status='cancelling',cancel_requested_at=COALESCE(cancel_requested_at,datetime('now')),updated_at=datetime('now')
    WHERE id=? AND share_id=? AND share_version=? AND status IN ('queued','running','cancelling')`).bind(jobId, shareId, shareVersion).run();
  return result.meta.changes > 0;
}

export async function markCloudItemRunning(env: CloudTransferEnv, itemId: string): Promise<void> {
  await cloudDb(env).prepare(`UPDATE cloud_transfer_items SET status='running',attempts=attempts+1,error_code=NULL,error_message=NULL,updated_at=datetime('now')
    WHERE id=? AND status IN ('queued','retrying')`).bind(itemId).run();
}

export async function markCloudItemResult(
  env: CloudTransferEnv,
  item: CloudTransferItem,
  result: { status: Extract<CloudItemStatus, "completed" | "skipped">; uploadedBytes: number; providerFileId?: string; providerJobId?: string },
): Promise<void> {
  await env.DELIVERY_DB.batch([
    cloudDb(env).prepare(`UPDATE cloud_transfer_items SET status=?,uploaded_bytes=?,provider_file_id=?,provider_job_id=?,error_code=NULL,error_message=NULL,
      upload_state_ciphertext=NULL,upload_state_iv=NULL,source_grant_hash=NULL,source_grant_ciphertext=NULL,source_grant_iv=NULL,source_grant_expires_at=NULL,
      completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .bind(result.status, result.uploadedBytes, result.providerFileId || null, result.providerJobId || null, item.id),
    cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET processed_files=processed_files+1,succeeded_files=succeeded_files+1,
      processed_bytes=MIN(total_bytes,processed_bytes+?),updated_at=datetime('now') WHERE id=? AND status IN ('running','cancelling')`)
      .bind(item.source_size, item.job_id),
  ]);
}

export async function markCloudItemFailure(
  env: CloudTransferEnv, item: CloudTransferItem, failure: { code: string; message: string; retryable: boolean },
): Promise<void> {
  const status = failure.retryable && item.attempts < 4 ? "retrying" : "failed";
  const retryAt = status === "retrying" ? new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** Math.max(0, item.attempts))).toISOString() : null;
  await env.DELIVERY_DB.batch([
    cloudDb(env).prepare(`UPDATE cloud_transfer_items SET status=?,error_code=?,error_message=?,retry_at=?,updated_at=datetime('now') WHERE id=?`)
      .bind(status, failure.code, failure.message, retryAt, item.id),
    ...(status === "failed" ? [cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET processed_files=processed_files+1,failed_files=failed_files+1,
      updated_at=datetime('now') WHERE id=? AND status IN ('running','cancelling')`).bind(item.job_id)] : []),
  ]);
}

export async function retryFailedCloudItems(env: CloudTransferEnv, jobId: string, shareId: string, shareVersion: number): Promise<number> {
  const job = await getAuthorizedCloudJob(env, jobId, shareId, shareVersion);
  if (!job || !["partial", "failed"].includes(job.status)) return 0;
  const result = await cloudDb(env).prepare(`UPDATE cloud_transfer_items SET status='retrying',retry_at=NULL,error_code=NULL,error_message=NULL,updated_at=datetime('now')
    WHERE job_id=? AND status='failed'`).bind(jobId).run();
  if (result.meta.changes) await cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET status='running',processed_files=succeeded_files,failed_files=0,error_code=NULL,error_message=NULL,
    completed_at=NULL,updated_at=datetime('now') WHERE id=?`).bind(jobId).run();
  return result.meta.changes;
}

export async function finalizeCloudJob(env: CloudTransferEnv, jobId: string): Promise<CloudTransferJob | null> {
  const job = await getCloudJob(env, jobId); if (!job) return null;
  const cancelled = await cloudJobCancelled(env, jobId);
  const status = cancelled ? "cancelled" : job.failed_files > 0 ? (job.succeeded_files > 0 ? "partial" : "failed") : "completed";
  await env.DELIVERY_DB.batch([
    cloudDb(env).prepare(`UPDATE cloud_transfer_items SET status='cancelled',error_code='cancelled',error_message='The remaining files were cancelled.',
      upload_state_ciphertext=NULL,upload_state_iv=NULL,source_grant_hash=NULL,source_grant_ciphertext=NULL,source_grant_iv=NULL,source_grant_expires_at=NULL,
      updated_at=datetime('now') WHERE job_id=? AND status IN ('queued','running','retrying')`).bind(jobId),
    cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET status=?,processed_files=(SELECT COUNT(*) FROM cloud_transfer_items WHERE job_id=? AND status IN ('completed','skipped','failed','cancelled')),
      completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','running','cancelling')`).bind(status, jobId, jobId),
    cloudDb(env).prepare(`UPDATE cloud_transfer_authorizations SET credential_ciphertext='',credential_iv='',revoked_at=COALESCE(revoked_at,datetime('now'))
      WHERE id=(SELECT authorization_id FROM cloud_transfer_jobs WHERE id=?)`).bind(jobId),
  ]);
  return getCloudJob(env, jobId);
}
