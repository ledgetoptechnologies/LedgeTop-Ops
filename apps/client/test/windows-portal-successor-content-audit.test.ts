import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grant, fixture, id, principal } from "./helpers/windows-portal-successor-fixture";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { consumeOperationsPortalWorkspacePublication } from "../src/worker/operations-portal-workspace-publications";
import { applyOperationsPortalNativeRecipientAuthority } from "../src/worker/operations-portal-native-recipient-authority";
import { applyOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority";
import { sha256OperationsPortalWorkspaceSnapshot, type OperationsPortalWorkspacePublication } from "@ltds/shared/operations-portal-workspace-publication";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { authorizeWindowsPortalSuccessor, type WindowsPortalSuccessorContext } from "../src/worker/client-portal/windows-portal-successor-authorization";
import { appendWindowsPortalSuccessorContentStart as append, WindowsPortalSuccessorAuditUnavailableError,
  type WindowsPortalSuccessorContentStartInput } from "../src/worker/client-portal/windows-portal-successor-content-audit";
const TABLE="windows_portal_successor_content_start_events";
async function apply(db:D1Database,file:string){await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${file}`,import.meta.url),"utf8")).map(sql=>db.prepare(sql)));}
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

describe("successor content-start audit against real Client schemas and consumers",()=>{
 let runtime:Miniflare,db:D1Database,empty:D1Database,command:OperationsPortalNativeDeliveryAuthorityCommand,published:OperationsPortalWorkspacePublication;
 let context:WindowsPortalSuccessorContext;
 const rpc=vi.fn<(_:string)=>Promise<string>>();
 const env=()=>({DELIVERY_DB:db,ENVIRONMENT:"staging",CLIENT_PORTAL_ORIGIN:"https://client-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED:"true",CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED:"true",
  CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET:"synthetic-successor-audit-secret-at-least32bytes",
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER:{readNativeDeliveryAuthorization:async()=>{throw new Error("no ordinary fallback");},readWindowsDeliverySuccessorAuthorization:rpc}});
 const input=():WindowsPortalSuccessorContentStartInput=>({principal,context,storageKey:"synthetic/photos/map.tif",indexedETag:"trusted-index-etag",
  strongETag:'"trusted-index-etag"',providerVersion:"provider-sensitive-one",sha256:"e".repeat(64),size:42});
 async function reply(){
  const base=(await fixture()).successor.authorization,p=command.publication,c=published;
  return JSON.stringify({ok:true,protocolVersion:1,successor:{authorization:{...base,expiresAt:command.expiresAt,
   homeRequestFingerprint:command.recipient.homeRequestFingerprint,publicationSnapshotSha256:p.snapshotSha256},continuity:{
    grantOperationId:command.operationId,grantFingerprint:await sha256OperationsPortalNativeDeliveryAuthorityCommand(command),
    first:{operationId:p.operationId,publicationId:p.publicationId,revision:Number(p.revision),sourceSequence:Number(p.sourceSequence),snapshotId:p.snapshotId,snapshotSha256:p.snapshotSha256},
    current:{operationId:c.operationId,publicationId:c.publicationId,revision:Number(c.resultingRevision),sourceSequence:Number(c.snapshot.sourceSequence),snapshotId:c.snapshot.snapshotId,snapshotSha256:c.snapshot.snapshotSha256},
    publicationCount:Number(c.snapshot.sourceSequence)-Number(p.sourceSequence)+1,chainSha256:"d".repeat(64)}}});
 }
 async function authorized(){const result=await authorizeWindowsPortalSuccessor(env(),principal,command.authority.authorityId);expect(result.ok).toBe(true);if(!result.ok)throw new Error("synthetic proof missing");return result.successorContext;}
 const count=()=>db.prepare(`SELECT count(*) n FROM ${TABLE}`).first<number>("n");
 beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:{DB:crypto.randomUUID(),EMPTY:crypto.randomUUID()}});
  db=await runtime.getD1Database("DB") as unknown as D1Database;empty=await runtime.getD1Database("EMPTY") as unknown as D1Database;
  for(const file of ["0008_trash_tombstones.sql","0223_operations_portal_workspace_publications.sql","0224_operations_portal_native_recipient_authority.sql",
   "0227_operations_portal_native_delivery_authority.sql","0228_operations_portal_native_content_start_audit.sql","0229_operations_portal_native_delivery_regrant.sql",
   "0230_operations_portal_native_delivery_terminal_cancellations.sql","0235_windows_portal_successor_candidates.sql","0236_windows_portal_successor_content_start_audit.sql"])await apply(db,file);
  await db.prepare("CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT,size INTEGER)").run();
  await db.prepare("INSERT INTO file_index VALUES('synthetic/photos/map.tif','trusted-index-etag',42)").run();
  command=grant();published=publication(command);published={...published,snapshot:{...published.snapshot,snapshotSha256:await sha256OperationsPortalWorkspaceSnapshot(published)}};
  const receipt=await consumeOperationsPortalWorkspacePublication(db,published);
  command={...command,publication:{...command.publication,snapshotSha256:published.snapshot.snapshotSha256}};
  const home={protocol:"operations-portal-native-authority",protocolVersion:1,permissionSchemaVersion:3,action:"recipient.grant",operationId:command.recipient.homeGrantOperationId,target:command.target,
   recipient:{recipientBindingId:command.recipient.recipientBindingId,enrollmentIntentId:command.recipient.enrollmentIntentId,targetClientRecordId:command.recipient.targetClientRecordId,...principal},
   expected:{ownershipEpoch:"0",grantRevision:"0"},resulting:{ownershipEpoch:"1",grantRevision:"1"},permissions:["operations.service_home.read"],expiresAt:null,
   publication:{...command.publication,requestFingerprint:receipt.requestFingerprint},actorProof:published.actorProof,observedAt:new Date().toISOString()};
  const homeResult=JSON.parse(await applyOperationsPortalNativeRecipientAuthority({DELIVERY_DB:db,ENVIRONMENT:"staging",EXPECTED_HOST:"client-staging.example.test",CLIENT_PORTAL_ORIGIN:"https://client-staging.example.test",CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED:"true"},JSON.stringify(home)));
  expect(homeResult.ok).toBe(true);command={...command,recipient:{...command.recipient,homeRequestFingerprint:homeResult.requestFingerprint}};
  expect(JSON.parse(await applyOperationsPortalNativeDeliveryAuthority({DELIVERY_DB:db,ENVIRONMENT:"staging",CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED:"true"},canonicalOperationsPortalNativeDeliveryAuthorityCommand(command)))).toMatchObject({ok:true});
  rpc.mockImplementation(reply);context=await authorized();
 },120_000);
 afterAll(async()=>{await runtime?.dispose();});
 it("records pseudonymous immutable pins, replays only under fresh proofs, and binds the complete version tuple",async()=>{
  const time=new Date();const first=await append(env(),input(),time),again=await append(env(),input(),time);
  expect(first.replayed).toBe(false);expect(again).toEqual({...first,replayed:true});expect(Object.isFrozen(first)).toBe(true);
  const before=await count();
  for(const changed of [{providerVersion:"provider-sensitive-two"},{sha256:"f".repeat(64)}]){
   const result=await append(env(),{...input(),...changed},time);expect(result.eventId).not.toBe(first.eventId);
  }
  expect(await count()).toBe(before!+2);
  const rows=(await db.prepare(`SELECT * FROM ${TABLE}`).all()).results;
  const stored=JSON.stringify(rows);
  for(const raw of [principal.issuer,principal.subject,input().storageKey,input().indexedETag,input().providerVersion,input().sha256])expect(stored).not.toContain(raw);
  expect(rows[0]).toMatchObject({original_publication_revision:1,effective_publication_revision:1,publication_count:1,chain_sha256:"d".repeat(64)});
  await expect(db.prepare(`UPDATE ${TABLE} SET chain_sha256=? WHERE event_id=?`).bind("c".repeat(64),first.eventId).run()).rejects.toThrow("immutable");
  await expect(db.prepare(`DELETE FROM ${TABLE} WHERE event_id=?`).bind(first.eventId).run()).rejects.toThrow("durable");
 });
 it("audits a new current publication without rewriting the original grant or ordinary ledger",async()=>{
  const old=context;
  let next={...published,operationId:id(102),publicationId:id(202),expectedRevision:"1",resultingRevision:"2",snapshot:{...published.snapshot,snapshotId:id(302),checkpointId:id(402),sourceSequence:"2"}};
  next={...next,snapshot:{...next.snapshot,snapshotSha256:await sha256OperationsPortalWorkspaceSnapshot(next)}};
  await consumeOperationsPortalWorkspacePublication(db,next);published=next;context=await authorized();
  await expect(append(env(),{...input(),context:old})).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);
  const result=await append(env(),input());
  expect(await db.prepare(`SELECT original_publication_revision,effective_publication_revision,publication_count FROM ${TABLE} WHERE event_id=?`).bind(result.eventId).first())
   .toEqual({original_publication_revision:1,effective_publication_revision:2,publication_count:2});
  expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_delivery_live_heads").first("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_content_start_events").first("n")).toBe(0);
 });
 it("rejects wrong identity, stale or forged context, malformed version, mismatched index and all tombstones",async()=>{
  const before=await count();
  const altered=JSON.parse(JSON.stringify(context)) as WindowsPortalSuccessorContext;
  Object.assign(altered.continuity,{chainSha256:"f".repeat(64)});
  for(const change of [{principal:{...principal,subject:"another-person"}},{context:altered},{indexedETag:'W/"trusted-index-etag"'},
   {strongETag:'W/"trusted-index-etag"'},{strongETag:'"different"'},{size:43},{sha256:"INVALID"},{providerVersion:" padded "},{storageKey:"synthetic/photos/../other"}])
   await expect(append(env(),{...input(),...change})).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);
  for(const [kind,key] of [["exact",input().storageKey],["prefix","synthetic/photos/"]]){
   await db.prepare("INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,deleted_by,purge_after) VALUES(?,?,?,'synthetic-owner','2099-01-01')").bind(crypto.randomUUID(),key,kind).run();
   await expect(append(env(),input())).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);
   await db.prepare("UPDATE delivery_tombstones SET restored_at=datetime('now') WHERE restored_at IS NULL").run();
  }
  expect(await count()).toBe(before);
 });
 it("requires all new schema objects and existing gates and never leaks storage or identity errors",async()=>{
  for(const change of [{DELIVERY_DB:empty},{CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED:"false"},{CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET:"short"}]){
   try{await append({...env(),...change},input());throw new Error("unexpected receipt");}catch(error){expect(error).toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);expect(String(error)).not.toMatch(/SELECT|sqlite|map.tif|synthetic-recipient|provider-sensitive/);}
  }
  await db.prepare("DROP TRIGGER windows_portal_successor_content_start_no_delete").run();
  await expect(append(env(),input())).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);
  await db.prepare("CREATE TRIGGER windows_portal_successor_content_start_no_delete BEFORE DELETE ON windows_portal_successor_content_start_events BEGIN SELECT RAISE(ABORT,'successor content start audit is durable'); END").run();
 });
 it("rejects expired context and direct inserts with mismatched current authority pins",async()=>{
  const expired=JSON.parse(JSON.stringify(context)) as WindowsPortalSuccessorContext;
  Object.assign(expired.originalGrant,{expiresAt:"2000-01-01T00:00:00.000Z"});
  const calls=rpc.mock.calls.length;
  await expect(append(env(),{...input(),context:expired})).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);
  expect(rpc.mock.calls.length).toBe(calls);
  const current=await db.prepare(`SELECT * FROM ${TABLE} WHERE effective_publication_revision=2 LIMIT 1`).first<Record<string,string|number>>();
  if(!current)throw new Error("synthetic current event missing");
  const {recorded_sequence:_sequence,...base}=current;
  for(const edit of [{home_ownership_epoch:2},{effective_publication_snapshot_sha256:"f".repeat(64)},{original_publication_revision:2},{feature:"file.preview"},{publication_count:65}]){
   const row={...base,...edit,event_id:crypto.randomUUID(),dedupe_key:"z".repeat(43)},columns=Object.keys(row);
   await expect(db.prepare(`INSERT INTO ${TABLE}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).bind(...Object.values(row)).run()).rejects.toThrow();
  }
 });
 it("snapshots mutable input and the audit clock before cryptographic or remote awaits",async()=>{
  const value=JSON.parse(JSON.stringify({...input(),providerVersion:"snapshot-provider"})) as WindowsPortalSuccessorContentStartInput;
  const clock=new Date(),expectedTime=clock.toISOString();
  const pending=append(env(),value,clock);
  Object.assign(value,{storageKey:"another/private/key",providerVersion:"changed-after-call"});
  Object.assign(value.context.continuity.current,{snapshotId:id(999)});
  Object.assign(value.principal,{subject:"changed-after-call"});clock.setUTCFullYear(2099);
  const receipt=await pending;
  expect(receipt.occurredAt).toBe(expectedTime);
  const replay=await append(env(),{...input(),providerVersion:"snapshot-provider"},new Date(expectedTime));
  expect(replay).toEqual({...receipt,replayed:true});
 });
 it("returns no receipt when the remote post-append check fails, even if the attempted start was recorded",async()=>{
  const response=await reply(),before=await count();rpc.mockResolvedValueOnce(response).mockResolvedValueOnce(JSON.stringify({ok:false,protocolVersion:1,code:"denied"}));
  await expect(append(env(),{...input(),providerVersion:"post-append-race"})).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);
  expect(await count()).toBe(before!+1);
 });
 it("denies local revoke even while a stale remote proof still claims active access",async()=>{
  const before=await count();const revoke:OperationsPortalNativeDeliveryAuthorityCommand={...command,operationId:id(501),action:"delivery.revoke",authority:{...command.authority,expectedRevision:"1",resultingRevision:"2"},features:[],expiresAt:null};
  expect(JSON.parse(await applyOperationsPortalNativeDeliveryAuthority({DELIVERY_DB:db,ENVIRONMENT:"staging",CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED:"true"},canonicalOperationsPortalNativeDeliveryAuthorityCommand(revoke)))).toMatchObject({ok:true});
  await expect(append(env(),input())).rejects.toBeInstanceOf(WindowsPortalSuccessorAuditUnavailableError);expect(await count()).toBe(before);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
 });
});
