import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { grant, fixture, id, principal } from "./helpers/windows-portal-successor-fixture";
import { consumeOperationsPortalWorkspacePublication } from "../src/worker/operations-portal-workspace-publications";
import { applyOperationsPortalNativeRecipientAuthority } from "../src/worker/operations-portal-native-recipient-authority";
import { applyOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority";
import { sha256OperationsPortalWorkspaceSnapshot, type OperationsPortalWorkspacePublication }
  from "@ltds/shared/operations-portal-workspace-publication";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand, type OperationsPortalNativeDeliveryAuthorityCommand }
  from "@ltds/shared/operations-portal-native-delivery-authority";

function publication(command: OperationsPortalNativeDeliveryAuthorityCommand): OperationsPortalWorkspacePublication {
  const f = command.resource;
  return { protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: command.publication.publicationId, operationId: command.publication.operationId,
    expectedRevision: "0", resultingRevision: "1", target: command.target,
    snapshot: { snapshotId: command.publication.snapshotId, checkpointId: id(401), sourceSequence: "1", complete: true,
      counts: { directoryRecords: 1, projects: 1, folderReservations: 1, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: "0".repeat(64), directoryRecords: [{ recordId: command.target.rootRecordId, kind: "client", version: "1",
        parentRecordId: null, relationshipVersion: "1", displayName: "Synthetic Client", externalFences: [] }],
      projects: [{ externalProjectId: f.externalProjectId, version: f.projectVersion, name: "Synthetic Project", lifecycle: "active",
        plannedStart: null, plannedEnd: null, completedAt: null, archived: false, archivedAt: null, overdueWarning: false,
        published: true, organizationRecordId: null, clientRecordId: command.recipient.targetClientRecordId, externalFence: null }],
      folderReservations: [{ reservationId: f.folderReservationId, externalProjectId: f.externalProjectId,
        opsFolderProjectId: f.opsFolderProjectId, divisionId: f.opsDivisionId, clientFolderBindingId: f.clientFolderBindingId,
        bindingVersion: f.folderReservationRevision, r2Prefix: f.selectedR2Prefix, state: "active" }],
      recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: "synthetic-owner", verifiedAccessSubject: "synthetic-owner-subject", admissionVersion: "1", profileVersion: "1",
      grantGeneration: "1", verifiedUntil: new Date(Date.now() + 3600_000).toISOString() }, observedAt: new Date().toISOString() };
}

// Real Client migrations and authority consumers; Ops remote-reader proof is a
// synthetic fixture, explicitly not a live Ops service-binding acceptance.
export async function transportFixture() {
 const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
  d1Databases: { DB: crypto.randomUUID() }, r2Buckets: { DATA: crypto.randomUUID() } });
 const db = await runtime.getD1Database("DB") as unknown as D1Database;
 const bucket = await runtime.getR2Bucket("DATA") as unknown as R2Bucket;
 try {
 for (const file of ["0001_initial.sql", "0003_delivery_platform.sql", "0008_trash_tombstones.sql",
  "0223_operations_portal_workspace_publications.sql", "0224_operations_portal_native_recipient_authority.sql",
  "0227_operations_portal_native_delivery_authority.sql", "0228_operations_portal_native_content_start_audit.sql",
  "0229_operations_portal_native_delivery_regrant.sql", "0230_operations_portal_native_delivery_terminal_cancellations.sql",
  "0235_windows_portal_successor_candidates.sql", "0236_windows_portal_successor_content_start_audit.sql"]) {
  const sql=readFileSync(new URL(`../migrations/${file}`,import.meta.url),"utf8");
  await db.batch(splitD1MigrationStatements(sql).map(q=>db.prepare(q)));
 }
 let command = { ...grant(), features: ["folder.list", "file.metadata", "file.download"] } as OperationsPortalNativeDeliveryAuthorityCommand;
 let published = publication(command);
 published={...published,snapshot:{...published.snapshot,snapshotSha256:await sha256OperationsPortalWorkspaceSnapshot(published)}};
 const receipt=await consumeOperationsPortalWorkspacePublication(db,published);
 command={...command,publication:{...command.publication,snapshotSha256:published.snapshot.snapshotSha256}};
 const home={protocol:"operations-portal-native-authority",protocolVersion:1,permissionSchemaVersion:3,action:"recipient.grant",operationId:command.recipient.homeGrantOperationId,target:command.target,
  recipient:{recipientBindingId:command.recipient.recipientBindingId,enrollmentIntentId:command.recipient.enrollmentIntentId,targetClientRecordId:command.recipient.targetClientRecordId,...principal},
  expected:{ownershipEpoch:"0",grantRevision:"0"},resulting:{ownershipEpoch:"1",grantRevision:"1"},permissions:["operations.service_home.read"],expiresAt:null,
  publication:{...command.publication,requestFingerprint:receipt.requestFingerprint},actorProof:published.actorProof,observedAt:new Date().toISOString()};
 const homeResult=JSON.parse(await applyOperationsPortalNativeRecipientAuthority({DELIVERY_DB:db,ENVIRONMENT:"staging",EXPECTED_HOST:"client-staging.example.test",CLIENT_PORTAL_ORIGIN:"https://client-staging.example.test",CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED:"true"},JSON.stringify(home)));
 if(!homeResult.ok)throw Error("synthetic home setup failed");
 command={...command,recipient:{...command.recipient,homeRequestFingerprint:homeResult.requestFingerprint}};
 const writer={DELIVERY_DB:db,ENVIRONMENT:"staging",CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED:"true"};
 if(!JSON.parse(await applyOperationsPortalNativeDeliveryAuthority(writer,canonicalOperationsPortalNativeDeliveryAuthorityCommand(command))).ok)throw Error("synthetic delivery setup failed");
 const base=(await fixture()).successor.authorization,p=command.publication;
 const pins={operationId:p.operationId,publicationId:p.publicationId,revision:1,sourceSequence:1,snapshotId:p.snapshotId,snapshotSha256:p.snapshotSha256};
 const successor={authorization:{...base,features:command.features,expiresAt:command.expiresAt,homeRequestFingerprint:command.recipient.homeRequestFingerprint,publicationSnapshotSha256:p.snapshotSha256},
  continuity:{grantOperationId:command.operationId,grantFingerprint:await sha256OperationsPortalNativeDeliveryAuthorityCommand(command),first:pins,current:pins,publicationCount:1,chainSha256:"d".repeat(64)}};
 const bytes=Uint8Array.from({length:2*1024*1024},(_,i)=>(i*31+17)%251);
 const sha=await crypto.subtle.digest("SHA-256",bytes);
 const object=await bucket.put("synthetic/photos/map.bin",bytes,{sha256:sha});
 await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)")
  .bind("synthetic/photos/map.bin",object!.etag,bytes.length,new Date().toISOString(),"application/octet-stream","other").run();
 return {runtime,db,bucket,bytes,sha,successor,
  async revoke(){ const revoke={...command,operationId:id(501),action:"delivery.revoke",authority:{...command.authority,expectedRevision:"1",resultingRevision:"2"},features:[],expiresAt:null};
   const result=JSON.parse(await applyOperationsPortalNativeDeliveryAuthority(writer,canonicalOperationsPortalNativeDeliveryAuthorityCommand(revoke as OperationsPortalNativeDeliveryAuthorityCommand)));
   if(!result.ok)throw Error("synthetic revoke failed"); }
 };
 }catch(error){await runtime.dispose();throw error;}
}
