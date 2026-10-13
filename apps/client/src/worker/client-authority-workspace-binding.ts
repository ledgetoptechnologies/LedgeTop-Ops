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
  rootType:z.enum(["organization","standalone_client"]),
  rootPublicId:z.string().regex(/^[0-9a-f]{32}$/),
  expectedCheckpoint:z.object({
    sourceGeneration:bounded,
    sourceSequence:z.number().int().positive().safe(),
    snapshotGenerationId:bounded,
  }).strict(),
}).strict();

export type ClientAuthorityWorkspaceBindingCommand=z.infer<typeof commandSchema>;
export type ClientAuthorityWorkspaceBindingResult={operationId:string;clientAuthorityId:string;workspaceId:string;
  projectionSourceId:string;sourceWorkspaceId:string;rootType:"organization"|"standalone_client";rootPublicId:string;
  checkpoint:{sourceGeneration:string;sourceSequence:number;snapshotGenerationId:string};
  state:"inactive";revision:1;replayed:boolean};
type Evidence={request_fingerprint:string;client_authority_id:string;workspace_id:string;projection_source_id:string;
  source_workspace_id:string;root_type:"organization"|"standalone_client";root_public_id:string;
  reconciliation_source_generation:string;reconciliation_source_sequence:number;
  reconciliation_snapshot_generation_id:string};

const canonical=(command:ClientAuthorityWorkspaceBindingCommand)=>JSON.stringify({
  operationId:command.operationId,clientAuthorityId:command.clientAuthorityId,workspaceId:command.workspaceId,
  projectionSourceId:command.projectionSourceId,sourceWorkspaceId:command.sourceWorkspaceId,
  rootType:command.rootType,rootPublicId:command.rootPublicId,
  expectedCheckpoint:{sourceGeneration:command.expectedCheckpoint.sourceGeneration,
    sourceSequence:command.expectedCheckpoint.sourceSequence,
    snapshotGenerationId:command.expectedCheckpoint.snapshotGenerationId},
});
async function sha256(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
  .map(byte=>byte.toString(16).padStart(2,"0")).join("");}
const receiptQuery=`SELECT receipt.request_fingerprint,audit.client_authority_id,audit.workspace_id,audit.projection_source_id,
  audit.source_workspace_id,audit.root_type,audit.root_public_id,
  audit.reconciliation_source_generation,audit.reconciliation_source_sequence,
  audit.reconciliation_snapshot_generation_id FROM portal_client_authority_workspace_binding_receipts receipt
  JOIN portal_client_authority_workspace_binding_audit audit ON audit.operation_id=receipt.operation_id
  WHERE receipt.operation_id=?`;
export type ClientAuthorityWorkspaceBindingStatusResult=Omit<ClientAuthorityWorkspaceBindingResult,"replayed">;
const result=(operationId:string,row:Evidence,replayed:boolean):ClientAuthorityWorkspaceBindingResult=>({
  operationId,clientAuthorityId:row.client_authority_id,workspaceId:row.workspace_id,
  projectionSourceId:row.projection_source_id,sourceWorkspaceId:row.source_workspace_id,
  rootType:row.root_type,rootPublicId:row.root_public_id,
  checkpoint:{sourceGeneration:row.reconciliation_source_generation,sourceSequence:row.reconciliation_source_sequence,
    snapshotGenerationId:row.reconciliation_snapshot_generation_id},state:"inactive",revision:1,replayed,
});

/** Read-only recovery evidence for the private RPC boundary. */
export async function readClientAuthorityWorkspaceBindingStatus(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED">,operationId:string,
):Promise<ClientAuthorityWorkspaceBindingStatusResult|null>{
  if(env.CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED!=="true")
    throw new Error("client-authority-workspace-binding-status-disabled");
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(receiptQuery).bind(operationId).first<Evidence>();
  if(!row)return null;
  const {replayed:_replayed,...status}=result(operationId,row,false);
  return status;
}

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
        (client_authority_id,workspace_id,projection_source_id,source_workspace_id,root_type,root_public_id,
          reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,operation_id)
        SELECT ?,source.workspace_id,source.projection_source_id,source.source_workspace_id,
          workspace.root_type,?,checkpoint.source_generation,checkpoint.source_sequence,checkpoint.snapshot_generation_id,?
        FROM pa_portal_workspace_sources source
        JOIN portal_v2_workspaces workspace ON workspace.id=source.workspace_id
        JOIN pa_portal_projection_checkpoints checkpoint ON checkpoint.workspace_id=source.workspace_id
        JOIN pa_portal_projection_generations generation
          ON generation.id=checkpoint.snapshot_generation_id AND generation.workspace_id=checkpoint.workspace_id
        WHERE source.workspace_id=? AND source.projection_source_id=? AND source.source_workspace_id=?
          AND workspace.project_alpha_source_id=source.projection_source_id AND workspace.root_type=?
          AND ((workspace.root_type='organization' AND workspace.pa_organization_public_id=?)
            OR (workspace.root_type='standalone_client' AND workspace.pa_client_public_id=?))
          AND checkpoint.source_generation=? AND checkpoint.source_sequence=? AND checkpoint.snapshot_generation_id=?
          AND generation.source_generation=checkpoint.source_generation
          AND generation.projection_source_id=source.projection_source_id
          AND generation.workspace_root_type=workspace.root_type AND generation.workspace_root_public_id=?
          AND NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims claim
            WHERE claim.client_authority_id=? OR claim.workspace_id=?)`)
        .bind(command.clientAuthorityId,command.rootPublicId,command.operationId,
          command.workspaceId,command.projectionSourceId,command.sourceWorkspaceId,
          command.rootType,command.rootPublicId,command.rootPublicId,
          sourceGeneration,sourceSequence,snapshotGenerationId,command.rootPublicId,
          command.clientAuthorityId,command.workspaceId),
      db.prepare(`INSERT INTO portal_client_authority_workspace_binding_audit
        (operation_id,request_fingerprint,client_authority_id,workspace_id,projection_source_id,source_workspace_id,
          root_type,root_public_id,
          reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(command.operationId,fingerprint,command.clientAuthorityId,command.workspaceId,command.projectionSourceId,
          command.sourceWorkspaceId,command.rootType,command.rootPublicId,
          sourceGeneration,sourceSequence,snapshotGenerationId),
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
    root_type:command.rootType,root_public_id:command.rootPublicId,
    reconciliation_source_generation:sourceGeneration,reconciliation_source_sequence:sourceSequence,
    reconciliation_snapshot_generation_id:snapshotGenerationId,
  },false);
}
