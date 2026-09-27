import {z} from "zod";
import type {Env} from "./types";

const bounded=z.string().trim().min(1).max(200);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const commandSchema=z.object({
  operationId:bounded,
  clientAuthorityId:uuid,
  workspaceId:bounded,
  projectionSourceId:bounded,
  sourceWorkspaceId:bounded,
  expectedCheckpoint:z.object({
    sourceGeneration:bounded,
    sourceSequence:z.number().int().positive().safe(),
    snapshotGenerationId:bounded,
  }).strict(),
}).strict();

export type ClientAuthorityWorkspaceBindingCommand=z.infer<typeof commandSchema>;
export type ClientAuthorityWorkspaceBindingResult={operationId:string;clientAuthorityId:string;workspaceId:string;
  projectionSourceId:string;sourceWorkspaceId:string;checkpoint:{sourceGeneration:string;sourceSequence:number;snapshotGenerationId:string};
  state:"inactive";revision:1;replayed:boolean};
type Evidence={request_fingerprint:string;client_authority_id:string;workspace_id:string;projection_source_id:string;
  source_workspace_id:string;reconciliation_source_generation:string;reconciliation_source_sequence:number;
  reconciliation_snapshot_generation_id:string};

const canonical=(command:ClientAuthorityWorkspaceBindingCommand)=>JSON.stringify({
  operationId:command.operationId,clientAuthorityId:command.clientAuthorityId,workspaceId:command.workspaceId,
  projectionSourceId:command.projectionSourceId,sourceWorkspaceId:command.sourceWorkspaceId,
  expectedCheckpoint:{sourceGeneration:command.expectedCheckpoint.sourceGeneration,
    sourceSequence:command.expectedCheckpoint.sourceSequence,
    snapshotGenerationId:command.expectedCheckpoint.snapshotGenerationId},
});
async function sha256(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
  .map(byte=>byte.toString(16).padStart(2,"0")).join("");}
const receiptQuery=`SELECT receipt.request_fingerprint,audit.client_authority_id,audit.workspace_id,audit.projection_source_id,
  audit.source_workspace_id,audit.reconciliation_source_generation,audit.reconciliation_source_sequence,
  audit.reconciliation_snapshot_generation_id FROM portal_client_authority_workspace_binding_receipts receipt
  JOIN portal_client_authority_workspace_binding_audit audit ON audit.operation_id=receipt.operation_id
  WHERE receipt.operation_id=?`;
const result=(operationId:string,row:Evidence,replayed:boolean):ClientAuthorityWorkspaceBindingResult=>({
  operationId,clientAuthorityId:row.client_authority_id,workspaceId:row.workspace_id,
  projectionSourceId:row.projection_source_id,sourceWorkspaceId:row.source_workspace_id,
  checkpoint:{sourceGeneration:row.reconciliation_source_generation,sourceSequence:row.reconciliation_source_sequence,
    snapshotGenerationId:row.reconciliation_snapshot_generation_id},state:"inactive",revision:1,replayed,
});

/** Private control-plane reservation. Deliberately not mounted by the Worker router or scheduler. */
export async function writeClientAuthorityWorkspaceBinding(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED">,raw:unknown,
):Promise<ClientAuthorityWorkspaceBindingResult>{
  if(env.CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED!=="true")throw new Error("client-authority-workspace-binding-writer-disabled");
  const parsed=commandSchema.safeParse(raw);
  if(!parsed.success)throw new Error("client-authority-workspace-binding-invalid");
  const command=parsed.data,fingerprint=await sha256(canonical(command)),db=env.DELIVERY_DB.withSession("first-primary");
  const prior=await db.prepare(receiptQuery).bind(command.operationId).first<Evidence>();
  if(prior){
    if(prior.request_fingerprint!==fingerprint)throw new Error("client-authority-workspace-binding-operation-conflict");
    return result(command.operationId,prior,true);
  }
  const {sourceGeneration,sourceSequence,snapshotGenerationId}=command.expectedCheckpoint;
  try{
    await db.batch([
      db.prepare(`INSERT INTO portal_client_authority_workspace_bindings
        (client_authority_id,workspace_id,projection_source_id,source_workspace_id,
          reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,operation_id)
        SELECT ?,source.workspace_id,source.projection_source_id,source.source_workspace_id,
          checkpoint.source_generation,checkpoint.source_sequence,checkpoint.snapshot_generation_id,?
        FROM pa_portal_workspace_sources source
        JOIN pa_portal_projection_checkpoints checkpoint ON checkpoint.workspace_id=source.workspace_id
        JOIN pa_portal_projection_generations generation
          ON generation.id=checkpoint.snapshot_generation_id AND generation.workspace_id=checkpoint.workspace_id
        WHERE source.workspace_id=? AND source.projection_source_id=? AND source.source_workspace_id=?
          AND checkpoint.source_generation=? AND checkpoint.source_sequence=? AND checkpoint.snapshot_generation_id=?
          AND generation.source_generation=checkpoint.source_generation
          AND generation.projection_source_id=source.projection_source_id
          AND NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims claim
            WHERE claim.client_authority_id=? OR claim.workspace_id=?)`)
        .bind(command.clientAuthorityId,command.operationId,command.workspaceId,command.projectionSourceId,
          command.sourceWorkspaceId,sourceGeneration,sourceSequence,snapshotGenerationId,command.clientAuthorityId,command.workspaceId),
      db.prepare(`INSERT INTO portal_client_authority_workspace_binding_audit
        (operation_id,request_fingerprint,client_authority_id,workspace_id,projection_source_id,source_workspace_id,
          reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(command.operationId,fingerprint,command.clientAuthorityId,command.workspaceId,command.projectionSourceId,
          command.sourceWorkspaceId,sourceGeneration,sourceSequence,snapshotGenerationId),
      db.prepare(`INSERT INTO portal_client_authority_workspace_binding_receipts
        (operation_id,request_fingerprint,client_authority_id,workspace_id) VALUES(?,?,?,?)`)
        .bind(command.operationId,fingerprint,command.clientAuthorityId,command.workspaceId),
    ]);
  }catch{
    const raced=await env.DELIVERY_DB.withSession("first-primary").prepare(receiptQuery).bind(command.operationId).first<Evidence>();
    if(raced){
      if(raced.request_fingerprint!==fingerprint)throw new Error("client-authority-workspace-binding-operation-conflict");
      return result(command.operationId,raced,true);
    }
    throw new Error("client-authority-workspace-binding-conflict");
  }
  return result(command.operationId,{
    request_fingerprint:fingerprint,client_authority_id:command.clientAuthorityId,workspace_id:command.workspaceId,
    projection_source_id:command.projectionSourceId,source_workspace_id:command.sourceWorkspaceId,
    reconciliation_source_generation:sourceGeneration,reconciliation_source_sequence:sourceSequence,
    reconciliation_snapshot_generation_id:snapshotGenerationId,
  },false);
}
