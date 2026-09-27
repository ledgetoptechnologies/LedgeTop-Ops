import {z} from "zod";
import type {Env} from "./types";

const bounded=z.string().trim().min(1).max(200);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const commandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("claim"),operationId:bounded,clientAuthorityId:uuid,projectionSourceId:bounded,sourceWorkspaceId:bounded,expectedOwnershipEpoch:z.literal(0)}).strict(),
  z.object({action:z.literal("release"),operationId:bounded,clientAuthorityId:uuid,projectionSourceId:bounded,sourceWorkspaceId:bounded,expectedOwnershipEpoch:z.number().int().positive()}).strict(),
]);

export type ClientAuthorityWorkspaceClaimCommand=z.infer<typeof commandSchema>;
export type ClientAuthorityWorkspaceClaimResult={operationId:string;clientAuthorityId:string;workspaceId:string;projectionSourceId:string;sourceWorkspaceId:string;ownershipEpoch:number;state:"active"|"released";checkpoint:{sourceGeneration:string;sourceSequence:number;snapshotGenerationId:string};replayed:boolean};
type SourceCheckpoint={workspace_id:string;projection_source_id:string;source_workspace_id:string;source_generation:string;source_sequence:number;snapshot_generation_id:string};
type Receipt={request_fingerprint:string;client_authority_id:string;workspace_id:string;projection_source_id:string;source_workspace_id:string;ownership_epoch:number;resulting_state:"active"|"released";reconciliation_source_generation:string;reconciliation_source_sequence:number;reconciliation_snapshot_generation_id:string};

const canonical=(value:ClientAuthorityWorkspaceClaimCommand)=>JSON.stringify({action:value.action,operationId:value.operationId,clientAuthorityId:value.clientAuthorityId,projectionSourceId:value.projectionSourceId,sourceWorkspaceId:value.sourceWorkspaceId,expectedOwnershipEpoch:value.expectedOwnershipEpoch});
async function sha256(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
const result=(operationId:string,row:Receipt,replayed:boolean):ClientAuthorityWorkspaceClaimResult=>({operationId,clientAuthorityId:row.client_authority_id,workspaceId:row.workspace_id,projectionSourceId:row.projection_source_id,sourceWorkspaceId:row.source_workspace_id,ownershipEpoch:row.ownership_epoch,state:row.resulting_state,checkpoint:{sourceGeneration:row.reconciliation_source_generation,sourceSequence:row.reconciliation_source_sequence,snapshotGenerationId:row.reconciliation_snapshot_generation_id},replayed});
const receiptColumns="request_fingerprint,client_authority_id,workspace_id,projection_source_id,source_workspace_id,ownership_epoch,resulting_state,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id";

/** Private control-plane writer. It is deliberately not mounted by the Worker router. */
export async function writeClientAuthorityWorkspaceClaim(env:Pick<Env,"DELIVERY_DB"|"CLIENT_AUTHORITY_WORKSPACE_CLAIM_WRITER_ENABLED">,raw:unknown):Promise<ClientAuthorityWorkspaceClaimResult>{
  if(env.CLIENT_AUTHORITY_WORKSPACE_CLAIM_WRITER_ENABLED!=="true")throw new Error("client-authority-workspace-claim-writer-disabled");
  const parsed=commandSchema.safeParse(raw);
  if(!parsed.success)throw new Error("client-authority-workspace-claim-invalid");
  const command=parsed.data,fingerprint=await sha256(canonical(parsed.data)),db=env.DELIVERY_DB.withSession("first-primary");
  const prior=await db.prepare(`SELECT ${receiptColumns} FROM portal_client_authority_workspace_claim_receipts WHERE operation_id=?`)
    .bind(command.operationId).first<Receipt>();
  if(prior){if(prior.request_fingerprint!==fingerprint)throw new Error("client-authority-workspace-claim-operation-conflict");return result(command.operationId,prior,true);}
  const source=await db.prepare(`SELECT source.workspace_id,source.projection_source_id,source.source_workspace_id,checkpoint.source_generation,checkpoint.source_sequence,checkpoint.snapshot_generation_id
    FROM pa_portal_workspace_sources source JOIN pa_portal_projection_checkpoints checkpoint ON checkpoint.workspace_id=source.workspace_id
    JOIN pa_portal_projection_generations generation ON generation.id=checkpoint.snapshot_generation_id AND generation.workspace_id=checkpoint.workspace_id
    WHERE source.projection_source_id=? AND source.source_workspace_id=? AND generation.source_generation=checkpoint.source_generation AND generation.projection_source_id=source.projection_source_id`)
    .bind(command.projectionSourceId,command.sourceWorkspaceId).first<SourceCheckpoint>();
  if(!source)throw new Error("client-authority-workspace-claim-source-missing");
  const epoch=command.expectedOwnershipEpoch+1,state=command.action==="claim"?"active" as const:"released" as const;
  const head=command.action==="claim"
    ? db.prepare(`INSERT INTO portal_client_authority_workspace_claims(client_authority_id,workspace_id,projection_source_id,source_workspace_id,state,ownership_epoch,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,last_operation_id)
      SELECT ?,?,?,?,'active',1,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims WHERE client_authority_id=? OR workspace_id=?)`)
      .bind(command.clientAuthorityId,source.workspace_id,source.projection_source_id,source.source_workspace_id,source.source_generation,source.source_sequence,source.snapshot_generation_id,command.operationId,command.clientAuthorityId,source.workspace_id)
    : db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=?,reconciliation_source_generation=?,reconciliation_source_sequence=?,reconciliation_snapshot_generation_id=?,last_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE client_authority_id=? AND workspace_id=? AND state='active' AND ownership_epoch=?
        AND NOT EXISTS(SELECT 1 FROM portal_v2_workspace_memberships membership
          WHERE membership.workspace_id=? AND membership.source_type='project_alpha' AND membership.status='active')
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
          WHERE entitlement.workspace_id=? AND entitlement.source_type='project_alpha' AND entitlement.status='active')`)
      .bind(epoch,source.source_generation,source.source_sequence,source.snapshot_generation_id,command.operationId,command.clientAuthorityId,
        source.workspace_id,command.expectedOwnershipEpoch,source.workspace_id,source.workspace_id);
  try{
    await db.batch([head,
      db.prepare(`INSERT INTO portal_client_authority_workspace_claim_audit(operation_id,request_fingerprint,action,client_authority_id,workspace_id,projection_source_id,source_workspace_id,ownership_epoch,resulting_state,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(command.operationId,fingerprint,command.action,command.clientAuthorityId,source.workspace_id,source.projection_source_id,source.source_workspace_id,epoch,state,source.source_generation,source.source_sequence,source.snapshot_generation_id),
      db.prepare(`INSERT INTO portal_client_authority_workspace_claim_receipts(operation_id,request_fingerprint,client_authority_id,workspace_id,projection_source_id,source_workspace_id,ownership_epoch,resulting_state,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(command.operationId,fingerprint,command.clientAuthorityId,source.workspace_id,source.projection_source_id,source.source_workspace_id,epoch,state,source.source_generation,source.source_sequence,source.snapshot_generation_id)]);
  }catch(error){
    const raced=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT ${receiptColumns} FROM portal_client_authority_workspace_claim_receipts WHERE operation_id=?`)
      .bind(command.operationId).first<Receipt>();
    if(raced){if(raced.request_fingerprint!==fingerprint)throw new Error("client-authority-workspace-claim-operation-conflict");return result(command.operationId,raced,true);}
    const message=error instanceof Error?error.message:String(error);
    if(command.action==="release"&&/claim audit requires exact post-CAS head/.test(message)){
      const effective=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT
        EXISTS(SELECT 1 FROM portal_v2_workspace_memberships WHERE workspace_id=? AND source_type='project_alpha' AND status='active')
        OR EXISTS(SELECT 1 FROM portal_v2_entitlements WHERE workspace_id=? AND source_type='project_alpha' AND status='active') blocked`)
        .bind(source.workspace_id,source.workspace_id).first<number>("blocked");
      if(effective===1)throw new Error("client-authority-workspace-claim-release-blocked-effective-authorization");
    }
    if(/claim audit requires exact post-CAS head|UNIQUE constraint failed|CAS or reconciliation guard failed/.test(message))throw new Error("client-authority-workspace-claim-cas-conflict");
    throw error;
  }
  return result(command.operationId,{request_fingerprint:fingerprint,client_authority_id:command.clientAuthorityId,workspace_id:source.workspace_id,projection_source_id:source.projection_source_id,source_workspace_id:source.source_workspace_id,ownership_epoch:epoch,resulting_state:state,reconciliation_source_generation:source.source_generation,reconciliation_source_sequence:source.source_sequence,reconciliation_snapshot_generation_id:source.snapshot_generation_id},false);
}
