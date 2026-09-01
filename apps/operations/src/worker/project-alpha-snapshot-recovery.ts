import { ProjectAlphaConnectorError, connectorFenceStatement, resolveProjectAlphaConnector, type ProjectAlphaConnectorProof } from "./project-alpha-connectors";
import { syncProjectAlphaForSource } from "./project-alpha";
import type { Env } from "./types";

type Outcome="success"|"failed"|"deferred";
export interface ProjectAlphaSnapshotRecoveryStatus {
  sourceId:string; lastAttemptAt:string|null; lastSuccessAt:string|null; nextAttemptAt:string|null;
  status:"never"|"running"|Outcome; errorCode:string|null; failureCount:number;
}
interface Candidate {source_id:string;active_revision:number;version:number;primary_revision:number;primary_version:number;failure_count:number}
const INVOCATION_MS=13*60_000,SOURCE_MS=6*60_000,DAY_MS=24*60*60_000;
const databaseNow="unixepoch('now')*1000";
const schedulerGuard="EXISTS(SELECT 1 FROM pa_snapshot_recovery_scheduler WHERE id='secondary' AND lease_token=? AND lease_until>unixepoch('now')*1000)";
const missingTables=["pa_snapshot_recovery_scheduler","pa_snapshot_recovery_sources","pa_snapshot_recovery_attempts","pa_snapshot_recovery_write_guard"];
const safeErrors=new Set(["lease_expired","configuration_changed","connector_invalid","connector_unavailable","connector_conflict",
  "connector_credentials_unavailable","connector_capacity","connector_changed","project-alpha-sync-busy","project-alpha-circuit-open",
  "project-alpha-recovery-configuration-changed","project-alpha-recovery-time-budget","project-alpha-recovery-query-budget","project-alpha-recovery-byte-budget",
  "project-alpha-network-timeout","project-alpha-network-dns","project-alpha-network-tls","project-alpha-network-refused",
  "project-alpha-network-reset","project-alpha-network-redirect","project-alpha-network-error","project-alpha-page-too-large","project-alpha-empty-page","project-alpha-body-timeout",
  "project-alpha-page-invalid-json","project-alpha-record-limit","project-alpha-page-limit","project-alpha-pagination","project-alpha-snapshot-unstable",
  "project-alpha-snapshot-time-regressed","project-alpha-sync-lease-lost","project-alpha-source-record-id-invalid","project-alpha-source-map-incomplete",
  "project-alpha-source-id-conflict","project-alpha-source-reference-unmapped","project-alpha-recovery-failed"]);
function safeError(value:string|null):string|null{
  return value===null?null:safeErrors.has(value)||/^project-alpha-http-[45][0-9]{2}$/.test(value)?value:"project-alpha-recovery-failed";
}
function migrationMissing(error:unknown):boolean {
  const message=error instanceof Error?error.message:String(error);
  return missingTables.some(table=>new RegExp(`no such table: (?:main\\.)?${table}(?:\\b|$)`,"i").test(message));
}
function iso(value:number|null):string|null{return value===null?null:new Date(value).toISOString();}
/** Missing schema is unavailable, not an empty/successful scheduler. */
export async function getProjectAlphaSnapshotRecoveryStatus(db:D1Database):Promise<ProjectAlphaSnapshotRecoveryStatus[]|null>{
  try{
    const session=db.withSession("first-primary");
    // Check the whole migration, including tables not referenced by the DTO query.
    if(!await session.prepare("SELECT id FROM pa_snapshot_recovery_scheduler WHERE id='secondary'").first())
      throw new Error("snapshot-recovery-accounting-unavailable");
    await session.prepare("SELECT id FROM pa_snapshot_recovery_attempts LIMIT 1").first();
    await session.prepare("SELECT id FROM pa_snapshot_recovery_write_guard LIMIT 1").first();
    const rows=(await session.prepare(`SELECT connector.source_id,source.source_id present,source.last_attempt_at,source.last_success_at,
      source.next_attempt_at,source.status,source.error_code,source.failure_count FROM pa_connectors connector
      LEFT JOIN pa_snapshot_recovery_sources source ON source.source_id=connector.source_id
      WHERE connector.profile='business_data' ORDER BY connector.source_id LIMIT 33`).all<{
        source_id:string;present:string|null;last_attempt_at:number|null;last_success_at:number|null;next_attempt_at:number;
        status:ProjectAlphaSnapshotRecoveryStatus["status"];error_code:string|null;failure_count:number;
      }>()).results;
    if(rows.length>32 || rows.some(row=>row.present===null))throw new Error("snapshot-recovery-accounting-unavailable");
    return rows.map(row=>({sourceId:row.source_id,lastAttemptAt:iso(row.last_attempt_at),lastSuccessAt:iso(row.last_success_at),
      nextAttemptAt:row.next_attempt_at?iso(row.next_attempt_at):null,status:row.status,errorCode:safeError(row.error_code),failureCount:row.failure_count}));
  }catch(error){if(migrationMissing(error))return null;throw error;}
}
function errorCode(error:unknown):string{
  if(error instanceof ProjectAlphaConnectorError)return `connector_${error.code}`;
  const message=error instanceof Error?error.message:"";
  if(/pa_connector_active_revision_guard|pa_snapshot_recovery_claim_guard/.test(message))return "configuration_changed";
  return safeError(message)??"project-alpha-recovery-failed";
}
function claimFence(db:D1Database,token:string,candidate:Candidate){
  return db.prepare(`INSERT INTO pa_snapshot_recovery_write_guard(id,write_guard) VALUES('secondary',CASE WHEN ${schedulerGuard}
    AND EXISTS(SELECT 1 FROM pa_connectors WHERE source_id=? AND state='active' AND profile='business_data' AND active_revision=? AND version=?)
    AND EXISTS(SELECT 1 FROM pa_connectors WHERE source_id='project-alpha:primary' AND state='active' AND active_revision=? AND version=?)
    THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET write_guard=excluded.write_guard`)
    .bind(token,candidate.source_id,candidate.active_revision,candidate.version,candidate.primary_revision,candidate.primary_version);
}
function schedulerFence(db:D1Database,token:string){
  return db.prepare(`INSERT INTO pa_snapshot_recovery_write_guard(id,write_guard)
    VALUES('secondary',CASE WHEN ${schedulerGuard} THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET write_guard=excluded.write_guard`).bind(token);
}
async function finish(db:D1Database,proof:ProjectAlphaConnectorProof,outcome:Outcome,code:string|null,failures:number){
  const claim=proof.scheduledRecovery!;
  const nextDelay=outcome==="success"?DAY_MS:outcome==="deferred"?60*60_000:Math.min(DAY_MS,60*60_000*2**Math.min(failures,5));
  // Attempt history may record an obsolete proof's failure. It must not change
  // a newer attempt/source health, or release a replacement scheduler lease.
  await db.batch([
    ...(outcome==="success"?[connectorFenceStatement(db,proof)]:[]),
    db.prepare(`UPDATE pa_snapshot_recovery_attempts SET status=?,error_code=?,completed_at=${databaseNow}
      WHERE id=? AND source_id=? AND lease_token=? AND status='running'`)
      .bind(outcome,code,claim.attemptId,proof.sourceId,claim.leaseToken),
    db.prepare(`UPDATE pa_snapshot_recovery_sources SET status=?,error_code=?,last_success_at=CASE WHEN ?='success' THEN ${databaseNow} ELSE last_success_at END,
      failure_count=CASE WHEN ?='success' THEN 0 WHEN ?='deferred' THEN failure_count ELSE min(failure_count+1,32) END,
      next_attempt_at=${databaseNow}+?,lease_token=NULL,lease_until=NULL
      WHERE source_id=? AND attempt_id=? AND lease_token=? AND status='running' AND changes()=1`)
      .bind(outcome,code,outcome,outcome,outcome,nextDelay,proof.sourceId,claim.attemptId,claim.leaseToken),
  ]);
}
export async function runProjectAlphaSnapshotRecovery(env:Env,scheduledTime:number):Promise<{
  status:"idle"|"busy"|"completed";attempted:number;succeeded:number;failed:number;deferred:number;
}>{
  if(!Number.isSafeInteger(scheduledTime)||scheduledTime<=0||scheduledTime>Date.now()+5*60_000)
    throw new Error("snapshot-recovery-scheduled-time-invalid");
  const db=env.OPS_DB,token=crypto.randomUUID(),deadlineAt=Date.now()+INVOCATION_MS;
  const result={status:"idle" as "idle"|"busy"|"completed",attempted:0,succeeded:0,failed:0,deferred:0};
  const acquired=await db.prepare(`UPDATE pa_snapshot_recovery_scheduler SET lease_token=?,lease_until=? ,last_scheduled_at=?
    WHERE id='secondary' AND last_scheduled_at<? AND (lease_until IS NULL OR lease_until<=${databaseNow}) RETURNING id`)
    .bind(token,deadlineAt,scheduledTime,scheduledTime).first();
  if(!acquired){
    if(!await db.withSession("first-primary").prepare("SELECT id FROM pa_snapshot_recovery_scheduler WHERE id='secondary'").first())
      throw new Error("snapshot-recovery-accounting-unavailable");
    return {...result,status:"busy"};
  }
  try{
    // A crashed invocation's claim remains evidence, not perpetual running state.
    await db.batch([
      schedulerFence(db,token),
      db.prepare(`UPDATE pa_snapshot_recovery_attempts SET status='failed',error_code='lease_expired',completed_at=${databaseNow}
        WHERE status='running' AND deadline_at<=${databaseNow}`),
      db.prepare(`UPDATE pa_snapshot_recovery_sources SET status='failed',error_code='lease_expired',failure_count=min(failure_count+1,32),
        next_attempt_at=${databaseNow}+3600000,lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=${databaseNow}`),
    ]);
    // Leave two minutes after normal work for checked cleanup, final accounting
    // and lease release. D1 calls already in flight are awaited, not detached.
    for(let index=0;index<2 && Date.now()<deadlineAt-2*60_000;index++){
      if(!await db.withSession("first-primary").prepare(`SELECT 1 ok WHERE ${schedulerGuard}`).bind(token).first())break;
      const candidate=await db.withSession("first-primary").prepare(`SELECT source.source_id,connector.active_revision,connector.version,
        primary_source.active_revision primary_revision,primary_source.version primary_version,source.failure_count
        FROM pa_snapshot_recovery_sources source JOIN pa_connectors connector ON connector.source_id=source.source_id
        JOIN pa_connectors primary_source ON primary_source.source_id='project-alpha:primary' AND primary_source.state='active'
        WHERE connector.state='active' AND connector.profile='business_data' AND source.status<>'running'
          AND source.next_attempt_at<=${databaseNow}
        ORDER BY source.last_attempt_at IS NOT NULL,source.last_attempt_at,source.source_id LIMIT 1`).first<Candidate>();
      if(!candidate||Date.now()>=deadlineAt-2*60_000)break;
      const attemptId=crypto.randomUUID(),leaseToken=crypto.randomUUID(),sourceDeadline=Math.min(Date.now()+SOURCE_MS,deadlineAt-2*60_000);
      const proof:ProjectAlphaConnectorProof=Object.freeze({mode:"registry",sourceId:candidate.source_id,profile:"business_data",
        revision:candidate.active_revision,version:candidate.version,scheduledRecovery:Object.freeze({attemptId,schedulerToken:token,leaseToken,
          primaryRevision:candidate.primary_revision,primaryVersion:candidate.primary_version,deadlineAt:sourceDeadline})});
      const claimed=await db.batch([
        claimFence(db,token,candidate),
        db.prepare(`UPDATE pa_snapshot_recovery_sources SET status='running',attempt_id=?,lease_token=?,lease_until=?,
          last_attempt_at=${databaseNow},next_attempt_at=${databaseNow}+86400000,error_code=NULL
          WHERE source_id=? AND status<>'running' AND next_attempt_at<=${databaseNow} RETURNING source_id`)
          .bind(attemptId,leaseToken,sourceDeadline,candidate.source_id),
        db.prepare(`INSERT INTO pa_snapshot_recovery_attempts(id,source_id,scheduled_at,scheduler_token,lease_token,
          source_revision,source_version,primary_revision,primary_version,started_at,deadline_at,status)
          SELECT ?,?,?,?,?,?,?,?,?,${databaseNow},?,'running' WHERE changes()=1`)
          .bind(attemptId,candidate.source_id,scheduledTime,token,leaseToken,candidate.active_revision,candidate.version,
            candidate.primary_revision,candidate.primary_version,sourceDeadline),
      ]);
      if(!claimed[1]?.results.length)continue;
      result.attempted++;result.status="completed";
      try{
        // Credential parsing happens only after durable accounting and is never
        // used to decide which candidate gets a turn.
        const resolved=await resolveProjectAlphaConnector(env,candidate.source_id,"snapshot");
        if(resolved.proof.mode!=="registry"||resolved.proof.revision!==proof.revision||resolved.proof.version!==proof.version||!resolved.snapshot)
          throw new Error("project-alpha-recovery-configuration-changed");
        await syncProjectAlphaForSource(env,resolved.source,resolved.snapshot,proof);
        await finish(db,proof,"success",null,candidate.failure_count);result.succeeded++;
      }catch(error){
        const code=errorCode(error),deferred=code==="project-alpha-sync-busy"||code==="project-alpha-circuit-open";
        await finish(db,proof,deferred?"deferred":"failed",code,candidate.failure_count);
        if(deferred)result.deferred++;else result.failed++;
      }
    }
    return result;
  }finally{
    await db.prepare("UPDATE pa_snapshot_recovery_scheduler SET lease_token=NULL,lease_until=NULL WHERE id='secondary' AND lease_token=?").bind(token).run();
  }
}
