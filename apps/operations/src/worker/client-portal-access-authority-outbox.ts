import type { Env } from "./types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type ClientPortalAuthorityCommand=Readonly<{protocolVersion:1;operationId:string;idempotencyKey:string;
  clientAuthorityId:string;issuer:string;subject:string;desiredState:"active"|"revoked";expectedRevision:number}>;
export type ClientPortalAuthorityReceipt=Readonly<{ok:true;protocolVersion:1;status:"recorded"|"duplicate";revision:number;state:"active"|"revoked"}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable";retryable:boolean}>;
export interface ClientPortalAuthorityBinding{recordAuthority(input:ClientPortalAuthorityCommand):Promise<unknown>}
export type AuthorityEnv=Pick<Env,"OPS_DB"|"CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED"|"CLIENT_PORTAL_ACCESS_AUTHORITY">;

/** Unmounted producer primitive. A future administrator route must perform its
 * normal live staff/scoped-grant check before calling this function and supply
 * the checked authorization evidence. This module adds no route or scheduler. */
export async function enqueueClientPortalAuthorityIntent(env:Pick<Env,"OPS_DB">,input:Omit<ClientPortalAuthorityCommand,"protocolVersion"|"operationId">&
  Readonly<{authorizedByStaffId:string;authorizationVersion:number}>){
  if(!UUID.test(input.clientAuthorityId)||!IDEMPOTENCY.test(input.idempotencyKey)||!input.issuer||input.issuer.trim()!==input.issuer||input.issuer.length>512
    ||!input.subject||input.subject.trim()!==input.subject||input.subject.length>512||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
    ||(input.desiredState!=="active"&&input.desiredState!=="revoked")||!UUID.test(input.authorizedByStaffId)
    ||!Number.isSafeInteger(input.authorizationVersion)||input.authorizationVersion<1)throw new TypeError("Invalid client portal authority intent");
  const operationId=crypto.randomUUID();
  const db=env.OPS_DB.withSession("first-primary");
  await db.batch([
    db.prepare(`INSERT INTO client_portal_access_authority_outbox
      (operation_id,idempotency_key,client_authority_id,issuer,subject,desired_state,expected_revision,authorized_by_staff_id,authorization_version)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(operationId,input.idempotencyKey,input.clientAuthorityId,input.issuer,input.subject,input.desiredState,
        input.expectedRevision,input.authorizedByStaffId,input.authorizationVersion),
    db.prepare(`INSERT INTO client_portal_access_authority_outbox_audit(operation_id,authorized_by_staff_id,authorization_version,action)
      VALUES(?,?,?,'shadow.intent.enqueued')`).bind(operationId,input.authorizedByStaffId,input.authorizationVersion),
  ]);
  return{operationId};
}

interface OutboxRow{operation_id:string;idempotency_key:string;client_authority_id:string;issuer:string;subject:string;
  desired_state:"active"|"revoked";expected_revision:number;attempt_count:number}
export type AuthorityDispatchResult={status:"disabled"}|{status:"idle"}|{status:"acknowledged";operationId:string}
  |{status:"retry"|"dead";operationId:string;code:string};
function receiptValue(value:unknown):ClientPortalAuthorityReceipt|null{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return null;
  const v=value as Record<string,unknown>;
  if(v.protocolVersion!==1||typeof v.ok!=="boolean")return null;
  if(v.ok===true)return (v.status==="recorded"||v.status==="duplicate")&&Number.isSafeInteger(v.revision)
    &&Number(v.revision)>=1&&(v.state==="active"||v.state==="revoked")&&Object.keys(v).length===5?value as ClientPortalAuthorityReceipt:null;
  return (v.code==="disabled"||v.code==="invalid"||v.code==="conflict"||v.code==="temporarily-unavailable")
    &&typeof v.retryable==="boolean"&&Object.keys(v).length===4?value as ClientPortalAuthorityReceipt:null;
}

/** Dispatches one durable shadow intent. It is deliberately not wired into an
 * HTTP or scheduled handler in this slice. A later control-plane owner may call
 * it after authorization and explicitly schedule further draining. */
export async function dispatchNextClientPortalAuthorityIntent(env:AuthorityEnv):Promise<AuthorityDispatchResult>{
  if(env.CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED!=="true")return{status:"disabled"};
  if(!env.CLIENT_PORTAL_ACCESS_AUTHORITY)return{status:"retry",operationId:"configuration",code:"configuration"};
  const db=env.OPS_DB.withSession("first-primary"),claimToken=crypto.randomUUID();
  await db.prepare(`UPDATE client_portal_access_authority_outbox SET state='dispatching',claim_token=?,claim_until=datetime('now','+2 minutes'),
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=(SELECT operation_id FROM client_portal_access_authority_outbox
      WHERE (state IN ('pending','retry') AND datetime(next_attempt_at)<=datetime('now'))
        OR (state='dispatching' AND datetime(claim_until)<=datetime('now')) ORDER BY created_at,operation_id LIMIT 1)
    AND ((state IN ('pending','retry') AND datetime(next_attempt_at)<=datetime('now')) OR (state='dispatching' AND datetime(claim_until)<=datetime('now')))`)
    .bind(claimToken).run();
  const row=await db.prepare(`SELECT operation_id,idempotency_key,client_authority_id,issuer,subject,desired_state,expected_revision,attempt_count
    FROM client_portal_access_authority_outbox WHERE state='dispatching' AND claim_token=?`).bind(claimToken).first<OutboxRow>();
  if(!row)return{status:"idle"};
  const command:ClientPortalAuthorityCommand={protocolVersion:1,operationId:row.operation_id,idempotencyKey:row.idempotency_key,
    clientAuthorityId:row.client_authority_id,issuer:row.issuer,subject:row.subject,desiredState:row.desired_state,expectedRevision:row.expected_revision};
  let receipt:ClientPortalAuthorityReceipt;
  try{receipt=receiptValue(await env.CLIENT_PORTAL_ACCESS_AUTHORITY.recordAuthority(command))
    ??{ok:false,protocolVersion:1,code:"temporarily-unavailable",retryable:true};}
  catch{receipt={ok:false,protocolVersion:1,code:"temporarily-unavailable",retryable:true};}
  const validSuccess=receipt.ok&&receipt.protocolVersion===1&&(receipt.status==="recorded"||receipt.status==="duplicate")
    &&receipt.revision===row.expected_revision+1&&receipt.state===row.desired_state;
  if(validSuccess){
    await db.batch([
      db.prepare(`UPDATE client_portal_access_authority_outbox SET state='acknowledged',attempt_count=attempt_count+1,last_error_code=NULL,
        claim_token=NULL,claim_until=NULL,acknowledged_claim_token=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND claim_token=?`).bind(claimToken,row.operation_id,claimToken),
      db.prepare(`INSERT OR IGNORE INTO client_portal_access_authority_receipts(operation_id,client_receipt_json)
        SELECT ?,? WHERE EXISTS(SELECT 1 FROM client_portal_access_authority_outbox
          WHERE operation_id=? AND state='acknowledged' AND acknowledged_claim_token=?)`)
        .bind(row.operation_id,JSON.stringify(receipt),row.operation_id,claimToken),
    ]);
    const acknowledged=await db.prepare(`SELECT 1 ok FROM client_portal_access_authority_receipts receipt
      JOIN client_portal_access_authority_outbox outbox ON outbox.operation_id=receipt.operation_id
      WHERE receipt.operation_id=? AND outbox.state='acknowledged' AND outbox.acknowledged_claim_token=?`)
      .bind(row.operation_id,claimToken).first("ok");
    return acknowledged===1?{status:"acknowledged",operationId:row.operation_id}
      :{status:"retry",operationId:row.operation_id,code:"lease-lost"};
  }
  const normalized=!receipt.ok&&receipt.protocolVersion===1&&["disabled","invalid","conflict","temporarily-unavailable"].includes(receipt.code)
    ?receipt:{ok:false as const,protocolVersion:1 as const,code:"temporarily-unavailable" as const,retryable:true};
  const attempts=row.attempt_count+1,dead=!normalized.retryable||attempts>=8,delay=Math.min(3600,2**Math.min(attempts,10)*15);
  await db.prepare(`UPDATE client_portal_access_authority_outbox SET state=?,attempt_count=?,last_error_code=?,
    next_attempt_at=datetime('now',?),claim_token=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=? AND state='dispatching' AND claim_token=?`)
    .bind(dead?"dead":"retry",attempts,normalized.code,`+${delay} seconds`,row.operation_id,claimToken).run();
  return{status:dead?"dead":"retry",operationId:row.operation_id,code:normalized.code};
}
