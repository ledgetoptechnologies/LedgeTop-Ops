import { describe, expect, it } from "vitest";
import { runCanonicalPortalResourceAcceptance, type CanonicalPortalAcceptanceContext } from
  "./helpers/operations-native-portal-resource-acceptance-fixture";
import { manageOperationsPortalNativeBillingPermission } from
  "../src/worker/operations-portal-native-billing-permission-issuer";
import { readClientPortalNativeFinancialDocuments } from
  "../src/worker/client-portal-native-financial-reader";
import { resolveTrustedNativeFinancialMapping } from "../src/worker/project-alpha-financial-mapping";
import { persistProjectAlphaProjectInventoryPage } from "../src/worker/project-alpha-v2-sync";
import { readClientPortalNativeFinancialCollections } from
  "../src/worker/client-portal-native-financial-entrypoint";

type Row = Record<string, string | number | null>;
const required = async (db: D1Database, sql: string, ...values: unknown[]) => {
  const row = await db.prepare(sql).bind(...values).first<Row>();
  if (!row) throw new Error(`canonical fixture row missing: ${sql}`);
  return row;
};
const text = (row: Row, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`expected ${key}`);
  return value;
};
const integer = (row: Row, key: string) => {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`expected ${key}`);
  return value;
};
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2, "0")).join("");

async function proveProjectBillingLifecycle(context: CanonicalPortalAcceptanceContext) {
  const { operations: db, workspace, recipient, externalProject, id, owner } = context;
  if (!recipient.recipientBindingId) throw new Error("canonical recipient binding missing");
  const bindingId = recipient.recipientBindingId;
  const workspaceHead = await required(db,
    "SELECT * FROM operations_portal_native_workspace_authority_heads WHERE target_id=?", workspace.targetId);
  const recipientHead = await required(db,
    "SELECT * FROM operations_portal_native_recipient_authority_heads WHERE recipient_binding_id=?", bindingId);
  const recipientReceipt = await required(db,
    "SELECT * FROM operations_portal_native_authority_receipts WHERE operation_id=?", text(recipientHead, "latest_operation_id"));
  const publicationHead = await required(db,
    "SELECT * FROM operations_portal_workspace_publication_heads WHERE target_id=?", workspace.targetId);
  const publicationReceipt = await required(db,
    "SELECT * FROM operations_portal_workspace_publication_receipts WHERE operation_id=?", text(publicationHead, "latest_operation_id"));
  const permissionOperationId=id(),permissionGrantId=id(),permissionInput={operationId:permissionOperationId,
    expectedGeneration:0,action:"issue" as const,grantId:permissionGrantId,staffId:owner.identity.staffId,
    effect:"allow" as const,scope:{kind:"resource" as const,resourceId:text(workspaceHead,"root_record_id")}};
  await expect(manageOperationsPortalNativeBillingPermission(db,owner,permissionInput))
    .resolves.toEqual({status:"applied",operationId:permissionOperationId,grantId:permissionGrantId,generation:1});
  await expect(manageOperationsPortalNativeBillingPermission(db,owner,permissionInput))
    .resolves.toEqual({status:"replayed",operationId:permissionOperationId,grantId:permissionGrantId,generation:1});
  await expect(manageOperationsPortalNativeBillingPermission(db,owner,{...permissionInput,effect:"deny"}))
    .resolves.toEqual({status:"conflict",reason:"request"});
  await expect(manageOperationsPortalNativeBillingPermission(db,owner,{...permissionInput,operationId:id(),grantId:id()}))
    .resolves.toEqual({status:"conflict",reason:"generation"});
  const deniedActor={...owner,identity:{...owner.identity,staffId:"billing-denied-owner",
    verifiedAccessSubject:"access|billing-denied-owner",email:"billing-denied@example.test"}};
  await expect(manageOperationsPortalNativeBillingPermission(db,deniedActor,{...permissionInput,operationId:id(),grantId:id(),expectedGeneration:1}))
    .resolves.toEqual({status:"conflict",reason:"authority"});
  await expect(manageOperationsPortalNativeBillingPermission(db,owner,{...permissionInput,operationId:id(),grantId:id(),
    expectedGeneration:Number.MAX_SAFE_INTEGER})).resolves.toEqual({status:"conflict",reason:"request"});
  const actor = await required(db, `SELECT admission.version admission_version,profile.version profile_version,generation.generation grant_generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id WHERE admission.staff_id=?`, owner.identity.staffId);

  const grantId = id(), operationId = id(), finalizationId = id();
  const observedAt = new Date().toISOString(), verifiedUntil = owner.verifiedUntil;
  const command = {
    protocol: "operations-portal-native-billing-authority", protocolVersion: 1, action: "billing.grant", operationId,
    authority: { grantId, expectedRevision: "0", resultingRevision: "1" },
    workspace: { targetId: workspace.targetId, targetRevision: String(integer(workspaceHead, "target_revision")),
      clientAuthorityId: text(workspaceHead, "client_authority_id"), workspaceId: text(workspaceHead, "workspace_id"),
      rootKind: text(workspaceHead, "root_kind"), rootRecordId: text(workspaceHead, "root_record_id") },
    recipient: { recipientBindingId: bindingId, enrollmentIntentId: text(recipientHead, "enrollment_intent_id"),
      targetClientRecordId: text(recipientHead, "target_client_record_id"), issuer: text(recipientHead, "issuer"),
      subject: text(recipientHead, "subject"), ownershipEpoch: String(integer(recipientHead, "ownership_epoch")),
      grantRevision: String(integer(recipientHead, "grant_revision")),
      grantOperationId: text(recipientHead, "latest_operation_id"),
      requestFingerprint: text(recipientReceipt, "request_fingerprint") },
    publication: { operationId: text(publicationHead, "latest_operation_id"),
      publicationId: text(publicationReceipt, "publication_id"),
      revision: String(integer(publicationHead, "publication_revision")),
      sourceSequence: String(integer(publicationHead, "source_sequence")), snapshotId: text(publicationHead, "snapshot_id"),
      snapshotSha256: text(publicationHead, "snapshot_sha256"),
      requestFingerprint: text(publicationReceipt, "operation_fingerprint") },
    entity: { kind: "project", nativeId: externalProject },
    actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
      admissionVersion: String(integer(actor, "admission_version")), profileVersion: String(integer(actor, "profile_version")),
      grantGeneration: String(integer(actor, "grant_generation")), verifiedUntil },
    expiresAt: null, observedAt,
  };
  const wire = JSON.stringify(command), requestSha = await sha256(wire);
  const insertCommand = (nativeEntityId = externalProject) => {
    const candidate = { ...command, operationId: nativeEntityId === externalProject ? operationId : id(),
      entity: { kind: "project", nativeId: nativeEntityId } };
    const candidateWire = JSON.stringify(candidate);
    return sha256(candidateWire).then(candidateSha => db.prepare(`INSERT INTO operations_portal_native_billing_authority_commands
      (operation_id,request_sha256,canonical_command_json,action,grant_id,expected_revision,resulting_revision,
       target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,
       enrollment_intent_id,target_client_record_id,issuer,subject,ownership_epoch,recipient_grant_revision,
       recipient_grant_operation_id,recipient_request_fingerprint,publication_operation_id,publication_id,
       publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
       publication_request_fingerprint,entity_kind,native_entity_id,actor_staff_id,actor_access_subject,
       actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,expires_at,observed_at)
      VALUES(?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,NULL,?)`)
      .bind(candidate.operationId,candidateSha,candidateWire,candidate.action,grantId,0,1,
        candidate.workspace.targetId,Number(candidate.workspace.targetRevision),candidate.workspace.clientAuthorityId,
        candidate.workspace.workspaceId,candidate.workspace.rootKind,candidate.workspace.rootRecordId,
        candidate.recipient.recipientBindingId,candidate.recipient.enrollmentIntentId,candidate.recipient.targetClientRecordId,
        candidate.recipient.issuer,candidate.recipient.subject,Number(candidate.recipient.ownershipEpoch),
        Number(candidate.recipient.grantRevision),candidate.recipient.grantOperationId,candidate.recipient.requestFingerprint,
        candidate.publication.operationId,candidate.publication.publicationId,Number(candidate.publication.revision),
        Number(candidate.publication.sourceSequence),candidate.publication.snapshotId,candidate.publication.snapshotSha256,
        candidate.publication.requestFingerprint,candidate.entity.kind,candidate.entity.nativeId,candidate.actorProof.staffId,
        candidate.actorProof.verifiedAccessSubject,Number(candidate.actorProof.admissionVersion),Number(candidate.actorProof.profileVersion),
        Number(candidate.actorProof.grantGeneration),candidate.actorProof.verifiedUntil,candidate.observedAt).run());
  };

  await expect(insertCommand(`${externalProject}/not-published`)).rejects.toThrow(/entity is not current and exact/u);
  await insertCommand();
  await db.prepare(`INSERT INTO operations_portal_native_billing_authority_outbox(operation_id,request_sha256,canonical_wire_json)
    VALUES(?,?,?)`).bind(operationId, requestSha, wire).run();
  const claim = `claim-${id()}`;
  await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='claimed',attempts=1,
    lease_token=?,lease_expires_at=unixepoch()*1000+60000 WHERE operation_id=?`).bind(claim, operationId).run();
  await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='acknowledged',lease_token=NULL,
    lease_expires_at=NULL,acknowledged_claim_token=? WHERE operation_id=?`).bind(claim, operationId).run();
  await db.prepare(`INSERT INTO operations_portal_native_billing_authority_receipts
    (operation_id,request_sha256,grant_id,resulting_revision,resulting_state,acknowledged_claim_token)
    VALUES(?,?,?,1,'active',?)`).bind(operationId, requestSha, grantId, claim).run();
  await db.prepare(`INSERT INTO operations_portal_native_billing_grant_finalizations
    (finalization_id,operation_id,request_sha256,grant_id,current_target_revision,current_ownership_epoch,
     current_recipient_grant_revision,current_recipient_grant_operation_id,current_publication_operation_id,
     current_publication_revision,current_publication_source_sequence,current_publication_snapshot_id,
     current_publication_snapshot_sha256,actor_staff_id,actor_access_subject,actor_admission_version,
     actor_profile_version,actor_grant_generation,actor_verified_until,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(finalizationId,operationId,requestSha,grantId,integer(workspaceHead,"target_revision"),
      integer(workspaceHead,"ownership_epoch"),integer(recipientHead,"grant_revision"),text(recipientHead,"latest_operation_id"),
      text(publicationHead,"latest_operation_id"),integer(publicationHead,"publication_revision"),
      integer(publicationHead,"source_sequence"),text(publicationHead,"snapshot_id"),text(publicationHead,"snapshot_sha256"),
      owner.identity.staffId,owner.identity.verifiedAccessSubject,integer(actor,"admission_version"),integer(actor,"profile_version"),
      integer(actor,"grant_generation"),verifiedUntil,observedAt).run();
  await db.prepare(`INSERT INTO operations_portal_native_billing_authority_heads
    (grant_id,recipient_binding_id,entity_kind,native_entity_id,revision,state,expires_at,latest_grant_finalization_id,
     creation_operation_id,latest_operation_id) VALUES(?,?,'project',?,1,'active',NULL,?,?,?)`)
    .bind(grantId,bindingId,externalProject,finalizationId,operationId,operationId).run();
  expect(await db.prepare(`SELECT native_entity_id FROM operations_portal_native_billing_live_authority
    WHERE grant_id=?`).bind(grantId).first("native_entity_id")).toBe(externalProject);
  const financialRequest={protocolVersion:1 as const,authorityId:workspace.clientAuthorityId,
    workspaceId:workspace.workspaceId,ownershipEpoch:integer(workspaceHead,"ownership_epoch"),
    grantRevision:integer(recipientHead,"grant_revision"),issuer:context.issuer,subject:context.subject,grantId};
  const financialEnv={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:context.projectAlphaConnections,
    CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED:"true"};
  const currentProject=await required(db,`SELECT project_alpha_public_id,pa_revision,canonical_projection_sha256,archived
    FROM operations_shared_projects WHERE external_project_id=?`,externalProject);
  const observationRequest=id();
  await expect(persistProjectAlphaProjectInventoryPage(db,context.sourceId,{apiVersion:"2",sourceInstanceId:context.sourceInstanceId,
    applicationId:context.applicationId,historyEpoch:context.historyEpochId,requestId:observationRequest,
    authorizationGeneration:"11",projects:[{externalId:externalProject,
      publicId:text(currentProject,"project_alpha_public_id"),revision:text(currentProject,"pa_revision"),
      projectionSha256:text(currentProject,"canonical_projection_sha256"),status:"active",
      archived:integer(currentProject,"archived")===1}],nextCursor:null},null)).resolves.toMatchObject({status:"persisted"});
  const financialMapping=await resolveTrustedNativeFinancialMapping(financialEnv,
    {kind:"project",externalProjectId:externalProject});
  expect(financialMapping).not.toBeNull();
  if(!financialMapping) throw new Error("canonical project financial mapping missing");
  let financialCalls=0;
  const financialRemote=async(input:RequestInfo|URL,init?:RequestInit)=>{
    financialCalls+=1;
    const url=new URL(String(input)),headers=new Headers(init?.headers);
    expect(url.pathname).toBe("/api/v2/financial-documents");
    expect(headers.get("Authorization")).toBe("Bearer acceptance-private-key");
    const requestId=`a1000000-0000-4000-8000-${String(financialCalls).padStart(12,"0")}`;
    const selector={kind:financialMapping.kind,externalId:financialMapping.externalId,publicId:financialMapping.publicId,
      revision:financialMapping.revision,projectionSha256:financialMapping.projectionSha256,
      authorizationGeneration:financialMapping.authorizationGeneration};
    return new Response(JSON.stringify({apiVersion:"2",sourceInstanceId:context.sourceInstanceId,
      applicationId:context.applicationId,historyEpoch:context.historyEpochId,requestId,selector,
      snapshot:{sha256:"b".repeat(64),documentCount:1},documents:[{publicId:"80000000000000000000000000000001",
        kind:"contract",status:"pending",currency:"USD",total:"0.00",amountPaid:null,balanceDue:null,
        documentUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",
        actionUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop"}],nextCursor:null}),
      {headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId}});
  };
  const financial=await readClientPortalNativeFinancialDocuments(financialEnv,financialRequest,financialRemote as typeof fetch);
  expect(financial.status).toBe("ok");
  if(financial.status==="ok") expect(financial.value.documents).toEqual([expect.objectContaining({kind:"contract",status:"pending"})]);
  expect(financialCalls).toBe(1);
  const collection=await readClientPortalNativeFinancialCollections(financialEnv,financialRequest,financialRemote as typeof fetch);
  expect(collection).toMatchObject({ok:true,authorityId:workspace.clientAuthorityId,
    collections:[{status:"ok",grantId,revision:1,value:{documents:[{kind:"contract",status:"pending"}]}}]});
  expect(financialCalls).toBe(2);
  await context.advanceProject();
  await expect(readClientPortalNativeFinancialCollections(financialEnv,financialRequest,financialRemote as typeof fetch))
    .resolves.toEqual({ok:false,protocolVersion:1,code:"denied"});
  expect(financialCalls).toBe(2);
  expect(await db.prepare(`SELECT native_entity_id FROM operations_portal_native_billing_live_authority
    WHERE grant_id=?`).bind(grantId).first("native_entity_id")).toBeNull();

  const insertRevoke=async(nativeEntityId:string,actualOperationId=id())=>{
    const revokeCommand={...command,action:"billing.revoke",operationId:actualOperationId,
      authority:{grantId,expectedRevision:"1",resultingRevision:"2"},entity:{kind:"project",nativeId:nativeEntityId},observedAt:new Date().toISOString()};
    const revokeWire=JSON.stringify(revokeCommand),revokeSha=await sha256(revokeWire);
    await db.prepare(`INSERT INTO operations_portal_native_billing_authority_commands
      (operation_id,request_sha256,canonical_command_json,action,grant_id,expected_revision,resulting_revision,
       target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,
       enrollment_intent_id,target_client_record_id,issuer,subject,ownership_epoch,recipient_grant_revision,
       recipient_grant_operation_id,recipient_request_fingerprint,publication_operation_id,publication_id,
       publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
       publication_request_fingerprint,entity_kind,native_entity_id,actor_staff_id,actor_access_subject,
       actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,expires_at,observed_at)
      SELECT ?,?,?, 'billing.revoke',grant_id,1,2,target_id,target_revision,client_authority_id,workspace_id,root_kind,
       root_record_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,ownership_epoch,
       recipient_grant_revision,recipient_grant_operation_id,recipient_request_fingerprint,publication_operation_id,
       publication_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,
       publication_request_fingerprint,'project',?,actor_staff_id,actor_access_subject,actor_admission_version,
       actor_profile_version,actor_grant_generation,actor_verified_until,NULL,?
      FROM operations_portal_native_billing_authority_commands WHERE operation_id=?`)
      .bind(actualOperationId,revokeSha,revokeWire,nativeEntityId,revokeCommand.observedAt,operationId).run();
    return{operationId:actualOperationId,wire:revokeWire,sha:revokeSha};
  };
  await expect(insertRevoke(`${externalProject}/mismatch`)).rejects.toThrow(/revision is stale|lineage is not current and exact/u);
  const revoked=await insertRevoke(externalProject);
  await db.prepare(`INSERT INTO operations_portal_native_billing_authority_outbox(operation_id,request_sha256,canonical_wire_json)
    VALUES(?,?,?)`).bind(revoked.operationId,revoked.sha,revoked.wire).run();
  const revokeClaim=`claim-${id()}`;
  await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='claimed',attempts=1,
    lease_token=?,lease_expires_at=unixepoch()*1000+60000 WHERE operation_id=?`).bind(revokeClaim,revoked.operationId).run();
  await db.prepare(`UPDATE operations_portal_native_billing_authority_outbox SET state='acknowledged',lease_token=NULL,
    lease_expires_at=NULL,acknowledged_claim_token=? WHERE operation_id=?`).bind(revokeClaim,revoked.operationId).run();
  await db.prepare(`INSERT INTO operations_portal_native_billing_authority_receipts
    (operation_id,request_sha256,grant_id,resulting_revision,resulting_state,acknowledged_claim_token)
    VALUES(?,?,?,2,'revoked',?)`).bind(revoked.operationId,revoked.sha,grantId,revokeClaim).run();
  await db.prepare(`UPDATE operations_portal_native_billing_authority_heads
    SET revision=2,state='revoked',latest_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE grant_id=?`)
    .bind(revoked.operationId,grantId).run();
  expect(await db.prepare("SELECT state FROM operations_portal_native_billing_authority_heads WHERE grant_id=?")
    .bind(grantId).first("state")).toBe("revoked");
  const secondOwnerId="billing-second-owner",secondOwnerSubject="access|billing-second-owner";
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES(?,?,?,?,'active')`).bind(secondOwnerId,"billing-second-owner@example.test","Billing Second Owner",secondOwnerSubject),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES(?,?,1,?)`).bind(secondOwnerId,secondOwnerSubject,owner.identity.staffId),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES(?,?,?)`).bind(secondOwnerId,"billing-second-owner@example.test","Billing Second Owner"),
    db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES(?,?,'role-owner','global',NULL,'global',?)`).bind(id(),secondOwnerId,owner.identity.staffId),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
      VALUES(?,?,'directory.portal_access.manage','allow','global',1,?)`).bind(id(),secondOwnerId,owner.identity.staffId),
  ]);
  const secondOwner={identity:{kind:"native" as const,staffId:secondOwnerId,verifiedAccessSubject:secondOwnerSubject,
    email:"billing-second-owner@example.test",displayName:"Billing Second Owner",profileVersion:1},
    admissionVersion:1,verifiedUntil:new Date(Date.now()+3_600_000).toISOString()};
  const permissionRevoke={operationId:id(),expectedGeneration:1,action:"revoke" as const,grantId:permissionGrantId};
  await expect(manageOperationsPortalNativeBillingPermission(db,secondOwner,permissionRevoke))
    .resolves.toEqual({status:"applied",operationId:permissionRevoke.operationId,grantId:permissionGrantId,generation:2});
  await expect(manageOperationsPortalNativeBillingPermission(db,secondOwner,permissionRevoke))
    .resolves.toEqual({status:"replayed",operationId:permissionRevoke.operationId,grantId:permissionGrantId,generation:2});
  await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(secondOwnerId).run();
  await expect(manageOperationsPortalNativeBillingPermission(db,secondOwner,permissionRevoke))
    .resolves.toEqual({status:"conflict",reason:"authority"});
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}

describe("native billing authority on the canonical 0001-0203 portal lifecycle", { timeout: 300_000 }, () => {
  it("grants an exact published project, denies it after canonical drift, and permits only frozen-lineage cleanup", async () => {
    await runCanonicalPortalResourceAcceptance(proveProjectBillingLifecycle,{stopAfterReady:true,operationsThroughMigration:"0203_effective_native_directory_enrollment_consumers.sql"});
  });
});
