import type { DirectClientFolderReadRequest, DirectClientFolderReadResult } from "@ltds/shared/direct-client-folder-read-authority";
import { DIRECT_CLIENT_FOLDER_READ_MAX_BYTES, hashDirectClientFolderReadRequest,
  parseDirectClientFolderReadRequest } from "@ltds/shared/direct-client-folder-read-authority";
import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";
import { verifyOperationsPortalWorkspacePublication } from "@ltds/shared/operations-portal-workspace-publication";
import type { Env } from "./types";

type ReadEnv = Pick<Env, "OPS_DB" | "DELIVERY_DB" | "ENVIRONMENT" | "EXPECTED_HOST" | "PUBLIC_BASE_URL"
  | "OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED">;
type GrantRow = { grant_id:string;grant_version:number;workspace_id:string;target_id:string;authority_model:string;
  client_authority_id:string;target_revision:number;source_id:string;folder_ref:string;owner_scope_type:string;
  owner_record_id:string;recipient_record_id:string;status:string;expires_at:string|null };
type AuthorityRow = { target_id:string;target_revision:number;client_authority_id:string;workspace_id:string;root_kind:string;
  root_record_id:string;root_profile_version:number;ownership_epoch:number;publication_revision:number;source_sequence:number;snapshot_id:string;
  snapshot_sha256:string;checkpoint_id:string;current_checkpoint_id:string;operation_id:string;snapshot_id_verified:string;
  ack_token:string;outbox_ack_token:string;snapshot_json:string;canonical_publication_json:string };
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH=/^[a-f0-9]{64}$/u;
const B64URL=/^[A-Za-z0-9_-]{2,1400}$/u;
const SOURCE="project-alpha:primary" as const;
const encoder=new TextEncoder();
const failure=(code:"invalid"|"denied"|"unavailable"|"disabled",_requestId?:string):string=>JSON.stringify({ok:false,protocolVersion:1,code});
const positive=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0;

async function currentOpsAuthority(env:ReadEnv,input:DirectClientFolderReadRequest):Promise<AuthorityRow|null>{
  return env.OPS_DB.withSession("first-primary").prepare(`SELECT workspace.target_id,workspace.target_revision,
      workspace.client_authority_id,workspace.workspace_id,workspace.root_kind,workspace.root_record_id,
      root_profile.current_version root_profile_version,workspace.ownership_epoch,
      publication.publication_revision,publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256,
      publication.checkpoint_id,current_checkpoint.checkpoint_id current_checkpoint_id,publication.latest_operation_id operation_id,
      snapshot.snapshot_id snapshot_id_verified,snapshot.snapshot_json,receipt.acknowledged_claim_token ack_token,
      outbox.acknowledged_claim_token outbox_ack_token,command.canonical_publication_json
    FROM operations_portal_native_workspace_authority_heads workspace
    JOIN operations_portal_workspace_reservation_heads reservation ON reservation.target_id=workspace.target_id
      AND reservation.revision=workspace.target_revision AND reservation.client_authority_id=workspace.client_authority_id
      AND reservation.workspace_id=workspace.workspace_id AND reservation.root_kind=workspace.root_kind
      AND reservation.root_record_id=workspace.root_record_id AND reservation.state='active'
    JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
      AND publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
      AND publication.workspace_id=workspace.workspace_id AND publication.root_kind=workspace.root_kind
      AND publication.root_record_id=workspace.root_record_id
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
      AND snapshot.checkpoint_id=publication.checkpoint_id AND snapshot.target_id=publication.target_id
      AND snapshot.source_sequence=publication.source_sequence AND snapshot.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=publication.latest_operation_id
      AND receipt.target_id=publication.target_id AND receipt.resulting_revision=publication.publication_revision
      AND receipt.source_sequence=publication.source_sequence AND receipt.snapshot_id=publication.snapshot_id
      AND receipt.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_commands command ON command.operation_id=receipt.operation_id
      AND command.operation_fingerprint=receipt.operation_fingerprint AND command.target_id=workspace.target_id
      AND command.target_revision=workspace.target_revision AND command.client_authority_id=workspace.client_authority_id
      AND command.workspace_id=workspace.workspace_id AND command.root_kind=workspace.root_kind
      AND command.root_record_id=workspace.root_record_id AND command.resulting_revision=publication.publication_revision
      AND command.snapshot_id=publication.snapshot_id AND command.checkpoint_id=publication.checkpoint_id
      AND command.source_sequence=publication.source_sequence AND command.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=publication.latest_operation_id
      AND outbox.target_id=publication.target_id AND outbox.state='acknowledged'
      AND outbox.acknowledged_claim_token=receipt.acknowledged_claim_token
    JOIN operations_portal_workspace_publication_current_checkpoints current_checkpoint
      ON current_checkpoint.checkpoint_id=publication.checkpoint_id
    JOIN operations_directory_records root_profile ON root_profile.record_id=workspace.root_record_id
      AND root_profile.record_kind=CASE workspace.root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END
    LEFT JOIN operations_directory_lifecycle_state root_lifecycle ON root_lifecycle.record_id=root_profile.record_id
    WHERE workspace.target_id=? AND workspace.workspace_id=? AND workspace.client_authority_id=?
      AND workspace.state='active' AND workspace.ownership_epoch>0 AND workspace.root_kind IN('organization','standalone_client')
      AND root_profile.current_version>0 AND coalesce(root_lifecycle.status,'active')='active'
      AND publication.source_sequence=publication.publication_revision LIMIT 2`)
    .bind(input.targetId,input.workspaceId,input.clientAuthorityId).all<AuthorityRow>().then(result=>{
      if(!result.success)throw new Error("query");
      if(result.results.length>1)throw new Error("ambiguous");
      return result.results[0]??null;
    });
}

async function selectedRecipientCurrent(env:ReadEnv,input:DirectClientFolderReadRequest,authority:AuthorityRow,
  grant:GrantRow):Promise<{bindingId:string;grantRevision:number;recipientRecordId:string;currentProfileVersion:number;relationshipVersion:number|null}|null>{
  const row=await env.OPS_DB.withSession("first-primary").prepare(`SELECT recipient.recipient_binding_id,
      recipient.grant_revision,recipient.ownership_epoch,recipient.target_client_record_id,recipient.issuer,recipient.subject,
      recipient.expires_at,intent.target_relationship_version,relation.relationship_version current_relationship_version,
      current_profile.current_version current_profile_version
    FROM operations_portal_native_recipient_authority_heads recipient
    JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=recipient.enrollment_intent_id
      AND intent.state='active' AND intent.recipient_binding_id=recipient.recipient_binding_id
      AND intent.grant_operation_id=recipient.latest_operation_id AND intent.access_issuer=recipient.issuer
      AND intent.access_subject=recipient.subject
    JOIN operations_portal_native_authority_commands command ON command.operation_id=recipient.latest_operation_id
      AND command.action='recipient.grant' AND command.target_id=recipient.target_id
      AND command.target_revision=? AND command.client_authority_id=? AND command.workspace_id=?
      AND command.recipient_binding_id=recipient.recipient_binding_id AND command.enrollment_intent_id=intent.intent_id
      AND command.target_client_record_id=recipient.target_client_record_id AND command.issuer=recipient.issuer
      AND command.subject=recipient.subject AND command.resulting_ownership_epoch=recipient.ownership_epoch
      AND command.resulting_grant_revision=recipient.grant_revision AND command.permission_schema_version=3
      AND command.permissions_json='["operations.service_home.read"]'
    JOIN operations_portal_native_authority_outbox authority_outbox ON authority_outbox.operation_id=command.operation_id
      AND authority_outbox.state='acknowledged'
    JOIN operations_portal_native_authority_receipts authority_receipt ON authority_receipt.operation_id=authority_outbox.operation_id
      AND authority_receipt.request_fingerprint=authority_outbox.request_fingerprint
      AND authority_receipt.target_id=recipient.target_id AND authority_receipt.client_authority_id=?
      AND authority_receipt.workspace_id=? AND authority_receipt.recipient_binding_id=recipient.recipient_binding_id
      AND authority_receipt.enrollment_intent_id=intent.intent_id AND authority_receipt.issuer=recipient.issuer
      AND authority_receipt.subject=recipient.subject AND authority_receipt.ownership_epoch=recipient.ownership_epoch
      AND authority_receipt.grant_revision=recipient.grant_revision AND authority_receipt.resulting_state='active'
      AND authority_receipt.permission_schema_version=3 AND authority_receipt.permissions_json=recipient.permissions_json
    JOIN client_onboarding_recipient_identity_bindings identity ON identity.binding_id=recipient.recipient_binding_id
      AND identity.target_client_record_id=recipient.target_client_record_id AND identity.access_issuer=recipient.issuer
      AND identity.access_subject=recipient.subject
    JOIN operations_directory_records current_profile ON current_profile.record_id=recipient.target_client_record_id
      AND current_profile.record_kind='client'
    JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=current_profile.record_id AND lifecycle.status='active'
    LEFT JOIN operations_directory_client_organizations relation ON relation.client_record_id=current_profile.record_id
    WHERE recipient.target_id=? AND recipient.ownership_epoch=? AND recipient.state='active'
      AND recipient.issuer=? AND recipient.subject=?
      AND recipient.permission_schema_version=3 AND recipient.permissions_json='["operations.service_home.read"]'
      AND (recipient.expires_at IS NULL OR datetime(recipient.expires_at)>datetime('now'))
      AND identity.status='active' AND (identity.expires_at IS NULL OR datetime(identity.expires_at)>datetime('now'))
      AND current_profile.current_version>0
      AND ((?='organization' AND relation.organization_record_id=? AND relation.relationship_version=intent.target_relationship_version)
        OR (?='standalone_client' AND recipient.target_client_record_id=? AND relation.organization_record_id IS NULL))
      AND ((?='organization' AND ?=?) OR recipient.target_client_record_id=?)
    LIMIT 2`).bind(authority.target_revision,authority.client_authority_id,authority.workspace_id,
      authority.client_authority_id,authority.workspace_id,authority.target_id,authority.ownership_epoch,
      input.issuer,input.subject,authority.root_kind,authority.root_record_id,
      authority.root_kind,authority.root_record_id,grant.owner_scope_type,grant.recipient_record_id,
      authority.root_record_id,grant.recipient_record_id).all<Record<string,unknown>>();
  if(!row.success)throw new Error("query");
  if(row.results.length>1)throw new Error("ambiguous");
  const value=row.results[0];
  if(!value||!UUID.test(String(value.recipient_binding_id))||!positive(value.grant_revision)
    ||value.ownership_epoch!==authority.ownership_epoch)return null;
  return {bindingId:String(value.recipient_binding_id),grantRevision:Number(value.grant_revision),
    recipientRecordId:String(value.target_client_record_id),
    currentProfileVersion:Number(value.current_profile_version),
    relationshipVersion:value.current_relationship_version===null?null:Number(value.current_relationship_version)};
}

/** Fresh Operations-side proof. No write, folder/project reservation, PA fallback, or identity inference. */
export async function readDirectClientFolderAuthorization(env:ReadEnv,raw:unknown):Promise<string>{
  const input=parseDirectClientFolderReadRequest(raw);
  if(!input)return failure("invalid");
  if(env.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED!=="true"
    ||!configuredDeploymentOrigin({environment:env.ENVIRONMENT??"",origin:env.PUBLIC_BASE_URL,expectedHost:env.EXPECTED_HOST}))
    return failure("disabled",input.requestId);
  try{
    const grant=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT grant_id,grant_version,workspace_id,target_id,
        authority_model,client_authority_id,target_revision,source_id,folder_ref,owner_scope_type,owner_record_id,
        recipient_record_id,status,expires_at FROM operations_portal_direct_folder_grants
      WHERE grant_id=? LIMIT 2`).bind(input.grantId).all<GrantRow>();
    if(!grant.success)throw new Error("query");
    if(grant.results.length!==1) return failure("denied",input.requestId);
    const g=grant.results[0]!;
    if(g.status!=="active"||g.authority_model!=="operations_native"||g.grant_version!==input.grantVersion
      ||g.workspace_id!==input.workspaceId||g.target_id!==input.targetId||g.client_authority_id!==input.clientAuthorityId
      ||g.source_id!==SOURCE||g.folder_ref!==input.folderRef
      ||!B64URL.test(g.folder_ref)||!UUID.test(g.target_id)||!UUID.test(g.client_authority_id)
      ||!(["organization","client"].includes(g.owner_scope_type))||!g.owner_record_id
      ||g.recipient_record_id!==input.recipientRecordId
      ||g.expires_at!==null&&(!Number.isFinite(Date.parse(g.expires_at))||Date.parse(g.expires_at)<=Date.now()))return failure("denied",input.requestId);
    const authority=await currentOpsAuthority(env,input);
    if(!authority)return failure("denied",input.requestId);
    if(!positive(authority.target_revision)||!positive(authority.root_profile_version)||!positive(authority.ownership_epoch)||!positive(authority.publication_revision)
      ||!positive(authority.source_sequence)||authority.target_id!==input.targetId||authority.workspace_id!==input.workspaceId
      ||authority.client_authority_id!==input.clientAuthorityId||g.target_revision!==authority.target_revision
      ||authority.snapshot_id_verified!==authority.snapshot_id
      ||authority.checkpoint_id!==authority.current_checkpoint_id||authority.source_sequence!==authority.publication_revision
      ||!HASH.test(authority.snapshot_sha256)||!authority.operation_id||!authority.ack_token
      ||authority.ack_token!==authority.outbox_ack_token)return failure("denied",input.requestId);
    let canonical:unknown;
    let storedSnapshot:unknown;
    try{canonical=JSON.parse(authority.canonical_publication_json);storedSnapshot=JSON.parse(authority.snapshot_json);}
    catch{return failure("unavailable",input.requestId);}
    const publication=await verifyOperationsPortalWorkspacePublication(canonical);
    if(!publication||JSON.stringify(publication.snapshot)!==JSON.stringify(storedSnapshot)
      ||publication.target.targetId!==input.targetId||publication.target.workspaceId!==input.workspaceId
      ||publication.target.clientAuthorityId!==input.clientAuthorityId
      ||publication.resultingRevision!==String(authority.publication_revision)
      ||publication.snapshot.snapshotId!==authority.snapshot_id||publication.snapshot.snapshotSha256!==authority.snapshot_sha256)
      return failure("denied",input.requestId);
    const directory=publication.snapshot.directoryRecords;
    const rootId=authority.root_record_id;
    const currentRecipient=await selectedRecipientCurrent(env,input,authority,g);
    const publishedRoot=directory.find(record=>record.recordId===rootId);
    if(!publishedRoot||publishedRoot.parentRecordId!==null
      ||publishedRoot.kind!==(authority.root_kind==="organization"?"organization":"client")
      ||publishedRoot.version!==String(authority.root_profile_version)
      ||g.owner_record_id!==rootId
      ||(authority.root_kind==="organization"?g.owner_scope_type!=="organization"
        :g.owner_scope_type!=="client")
      ||!currentRecipient)
      return failure("denied",input.requestId);
    const selected=directory.find(record=>record.recordId===currentRecipient.recipientRecordId);
    if(!selected||selected.kind!=="client"||selected.version!==String(currentRecipient.currentProfileVersion)
      ||(authority.root_kind==="organization"?(selected.parentRecordId!==rootId
        ||selected.relationshipVersion!==String(currentRecipient.relationshipVersion))
        :(selected.recordId!==rootId||selected.parentRecordId!==null||selected.relationshipVersion!==null)))
      return failure("denied",input.requestId);
    const requestSha256=await hashDirectClientFolderReadRequest(input);
    // Workspace/recipient checks involve asynchronous Ops reads. Confirm the
    // Client grant is still active immediately before emitting this proof.
    const finalGrant=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT 1 present
      FROM operations_portal_direct_folder_grants WHERE grant_id=? AND grant_version=? AND status='active'
        AND revoked_at IS NULL AND authority_model='operations_native' AND workspace_id=? AND target_id=?
        AND client_authority_id=? AND source_id=? AND folder_ref=? AND recipient_record_id=?
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`)
      .bind(input.grantId,input.grantVersion,input.workspaceId,input.targetId,input.clientAuthorityId,input.sourceId,
        input.folderRef,input.recipientRecordId).first();
    if(!finalGrant)return failure('denied',input.requestId);
    const result:DirectClientFolderReadResult={ok:true,protocolVersion:1,requestId:input.requestId,requestSha256,
      observedAt:new Date().toISOString(),authorization:{workspaceId:input.workspaceId,targetId:input.targetId,
        targetRevision:authority.target_revision,clientAuthorityId:input.clientAuthorityId,sourceId:SOURCE,
        recipientRecordId:input.recipientRecordId,grantId:input.grantId,grantVersion:input.grantVersion,
        folderRef:input.folderRef,publicationRevision:authority.publication_revision,snapshotId:authority.snapshot_id,
        snapshotSha256:authority.snapshot_sha256,currentRecipientRecordId:currentRecipient.recipientRecordId,
        currentRecipientProfileVersion:currentRecipient.currentProfileVersion,
        currentRecipientRelationshipVersion:currentRecipient.relationshipVersion}};
    const wire=JSON.stringify(result);
    return encoder.encode(wire).byteLength<=DIRECT_CLIENT_FOLDER_READ_MAX_BYTES?wire:failure("unavailable",input.requestId);
  }catch{return failure("unavailable",input.requestId);}
}
