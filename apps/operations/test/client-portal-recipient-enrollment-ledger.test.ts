import {readFileSync} from "node:fs";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {Miniflare} from "miniflare";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";
import {confirmRecipientEnrollmentIntent,inspectRecipientEnrollmentIntent,issueRecipientEnrollmentIntent,
  listRecipientEnrollmentIntentsForOwner,readRecipientEnrollmentIntentForOwner,redeemRecipientEnrollmentIntent,
  revokeRecipientEnrollmentBinding} from "../src/worker/client-portal-recipient-enrollment-ledger";
import {readClientPortalServiceMetadata} from "../src/worker/client-portal-service-metadata";
import {enqueueClientPortalAuthorityV3} from "../src/worker/client-portal-authority-v2-outbox";
import type {AuthenticatedNativeStaffWithAdmissionVersion} from "../src/worker/native-staff-auth";

const owner:AuthenticatedNativeStaffWithAdmissionVersion={identity:{kind:"native",staffId:"owner",verifiedAccessSubject:"access|owner",
  email:"owner@example.test",displayName:"Owner",profileVersion:3},admissionVersion:2,
  verifiedUntil:new Date(Date.now()+3_600_000).toISOString()};
const selectionId="11111111-1111-4111-8111-111111111111",authorityId="22222222-2222-4222-8222-222222222222";
const activationId="33333333-3333-4333-8333-333333333333",root="organization:one",client="client:one";
const future=()=>new Date(Date.now()+1_800_000).toISOString();
const operation=()=>crypto.randomUUID();

describe("recipient enrollment ledger",()=>{let mf:Miniflare,db:D1Database;
  beforeEach(async()=>{mf=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default{}",
    d1Databases:{DB:crypto.randomUUID()}});db=await mf.getD1Database("DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      db.prepare("CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT,PRIMARY KEY(record_id,version))"),
      db.prepare("CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT)"),
      db.prepare(`CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(activation_id TEXT PRIMARY KEY,record_id TEXT,
        source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT,
        resource_type TEXT,local_record_version INTEGER)`),
      db.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
      db.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER)"),
      db.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      db.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)"),
      db.prepare("CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)"),
      db.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)"),
    ]);
    for(const name of ["0103_client_onboarding_recipient_identity_bindings.sql","0143_client_portal_workspace_binding_selection.sql",
      "0144_client_portal_workspace_binding_outbox.sql","0145_client_portal_authority_v2_outbox.sql",
      "0146_ops_customer_service_enrollments.sql","0147_client_portal_authority_v3_permissions.sql",
      "0148_client_portal_recipient_enrollment.sql","0149_client_portal_recipient_enrollment_sql_fences.sql"]){
      const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)))}
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',1)").bind(root),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(client),
      db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?)").bind(client,JSON.stringify({name:"Example Customer"})),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(client,root),
      db.prepare("INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES(?,?,'project-alpha:primary','instance','app','epoch',?,'organization',1)").bind(activationId,root,"a".repeat(32)),
      db.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      db.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      db.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
      db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)"),
    ]);
    await db.prepare(`INSERT INTO client_portal_workspace_binding_selections VALUES(?,?,?, ?,?,1,'project-alpha:primary','instance','app','epoch',
      'organization',?,'workspace-one','source-workspace','generation',1,'snapshot','owner','access|owner',2,3,5,?,'inactive',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(selectionId,"b".repeat(64),authorityId,root,activationId,"a".repeat(32),future()).run();
    await db.prepare(`INSERT INTO client_portal_workspace_binding_outbox(operation_id,client_authority_id,workspace_id,projection_source_id,
      source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
      checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,
      reviewed_profile_version,reviewed_grant_generation) VALUES(?,?,'workspace-one','project-alpha:primary','source-workspace',
      'organization',?,'generation',1,'snapshot','owner','access|owner',2,3,5)`).bind(selectionId,authorityId,"a".repeat(32)).run();
    await db.prepare("INSERT INTO client_portal_workspace_binding_outbox_audit VALUES(?,'inactive.binding.enqueued','owner',5,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(selectionId).run();
    await db.prepare("UPDATE client_portal_workspace_binding_outbox SET state='dispatching',claim_token='claim',claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE operation_id=?").bind(selectionId).run();
    await db.prepare(`INSERT INTO client_portal_workspace_binding_outbox_receipts VALUES(?,?,'workspace-one','project-alpha:primary',
      'source-workspace','organization',?,'generation',1,'snapshot','inactive',1,0,'claim',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(selectionId,authorityId,"a".repeat(32)).run();
    await db.prepare("UPDATE client_portal_workspace_binding_outbox SET state='acknowledged',attempt_count=1,claim_token=NULL,claim_until=NULL,acknowledged_claim_token='claim' WHERE operation_id=?").bind(selectionId).run();
  },30_000);afterEach(async()=>mf.dispose());

  async function acknowledgeAuthority(operationId:string,epoch:number,revision:number,state:"active"|"revoked",permissions:string){
    const claim=`claim-${revision}`;
    await db.prepare("UPDATE client_portal_authority_v2_outbox SET state='dispatching',claim_token=?,claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE operation_id=?")
      .bind(claim,operationId).run();
    const command=await db.prepare("SELECT client_authority_id,workspace_id,issuer,subject FROM client_portal_authority_v2_outbox WHERE operation_id=?")
      .bind(operationId).first<{client_authority_id:string;workspace_id:string;issuer:string;subject:string}>();
    await db.prepare(`INSERT INTO client_portal_authority_v2_outbox_receipts(operation_id,client_authority_id,workspace_id,issuer,subject,
      ownership_epoch,grant_revision,resulting_state,acknowledged_claim_token,protocol_version,permissions_json)
      VALUES(?,?,?,?,?,?,?,?,?,3,?)`).bind(operationId,command!.client_authority_id,command!.workspace_id,command!.issuer,
        command!.subject,epoch,revision,state,claim,permissions).run();
    await db.prepare("UPDATE client_portal_authority_v2_outbox SET state='acknowledged',attempt_count=attempt_count+1,claim_token=NULL,claim_until=NULL,acknowledged_claim_token=? WHERE operation_id=?")
      .bind(claim,operationId).run();
  }

  it("issues, previews, redeems and atomically queues an exact verified grant",async()=>{
    const issueId=operation(),issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},
      expiresAt:future(),operationId:issueId,owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    expect(issued).toMatchObject({state:"issued",revision:1,replayed:false,target:{clientRecordId:client,selectionId}});
    const issueReplay=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt:issued.expiresAt,
      operationId:issueId,owner});
    expect("opaqueToken" in issueReplay).toBe(false);
    expect(await inspectRecipientEnrollmentIntent(db,issued.intentId,issued.opaqueToken)).toMatchObject({
      state:"issued",target:{clientRecordId:client,selectionId,displayLabel:"Example Customer"}});
    const redeemId=operation(),principal={issuer:"https://client.cloudflareaccess.com",subject:"access|customer"};
    const redeemed=await redeemRecipientEnrollmentIntent(db,{intentId:issued.intentId,opaqueToken:issued.opaqueToken,principal,
      verifiedUntil:future(),operationId:redeemId,acknowledgedTarget:{clientRecordId:client,selectionId}});
    expect(redeemed.review).toMatchObject({state:"pending",revision:2,principal});
    const lateIssueReplay=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt:issued.expiresAt,
      operationId:issueId,owner});
    expect(lateIssueReplay).toMatchObject({state:"issued",revision:1,principal:null,replayed:true});
    expect("opaqueToken" in lateIssueReplay).toBe(false);
    await expect(redeemRecipientEnrollmentIntent(db,{intentId:issued.intentId,opaqueToken:"0".repeat(64),principal,
      verifiedUntil:future(),operationId:redeemId,acknowledgedTarget:{clientRecordId:client,selectionId}})).rejects.toThrow("denied");
    await expect(redeemRecipientEnrollmentIntent(db,{intentId:issued.intentId,opaqueToken:issued.opaqueToken,principal,
      verifiedUntil:future(),operationId:operation(),acknowledgedTarget:{clientRecordId:client,selectionId}})).rejects.toThrow("denied");
    const confirmed=await confirmRecipientEnrollmentIntent(db,{intentId:issued.intentId,expectedRevision:2,operationId:operation(),owner});
    expect(confirmed.review).toMatchObject({state:"active",revision:3});
    expect(await db.prepare("SELECT protocol_version,permissions_json,desired_state FROM client_portal_authority_v2_outbox WHERE operation_id=?")
      .bind(confirmed.operationId).first()).toEqual({protocol_version:3,permissions_json:'["operations.service_home.read"]',desired_state:"active"});
  });

  it("reauthorizes a current owner after generation rotation and filters a scoped deny",async()=>{
    const issueId=operation(),expiresAt=future(),issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt,operationId:issueId,owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    expect(await readRecipientEnrollmentIntentForOwner(db,issued.intentId,owner)).toMatchObject({state:"issued"});
    await db.prepare("UPDATE native_directory_grant_generations SET generation=6 WHERE staff_id='owner'").run();
    expect(await readRecipientEnrollmentIntentForOwner(db,issued.intentId,owner)).toMatchObject({state:"issued"});
    await db.batch([db.prepare("INSERT INTO native_directory_resource_scopes VALUES(?,1,'area',NULL)").bind(root),
      db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','deny',1,'business_area',NULL,'area',NULL)")]);
    expect(await listRecipientEnrollmentIntentsForOwner(db,owner)).toEqual([]);
    await expect(issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt,operationId:issueId,owner}))
      .rejects.toThrow("denied");
  });

  it("rejects direct non-issued insertion and state tampering",async()=>{
    await expect(db.prepare(`INSERT INTO client_portal_recipient_enrollment_intents(intent_id,selection_id,target_client_record_id,
      token_sha256,state,revision,access_issuer,access_subject,recipient_verified_until,issued_by_staff_id,issued_access_subject,
      issued_admission_version,issued_profile_version,issued_grant_generation,expires_at) VALUES(?,?,? ,?,'pending',2,'x','y',?,
      'owner','access|owner',2,3,5,?)`).bind(operation(),selectionId,client,"c".repeat(64),future(),future()).run()).rejects.toThrow();
    const issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt:future(),operationId:operation(),owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    await expect(db.prepare(`INSERT INTO client_portal_recipient_enrollment_operations(operation_id,intent_id,action,request_sha256,
      resulting_revision,resulting_state,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
      actor_grant_generation,actor_verified_until) VALUES(?,?,'issue',?,1,'issued','owner','access|owner',2,3,5,?)`)
      .bind(operation(),issued.intentId,"d".repeat(64),"2000-01-01T00:00:00.000Z").run()).rejects.toThrow();
    await expect(db.prepare("UPDATE client_portal_recipient_enrollment_intents SET state='active',revision=2 WHERE intent_id=?")
      .bind(issued.intentId).run()).rejects.toThrow();
  });

  it("rolls back confirmation after the verified recipient proof expires",async()=>{
    const issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt:future(),operationId:operation(),owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    await redeemRecipientEnrollmentIntent(db,{intentId:issued.intentId,opaqueToken:issued.opaqueToken,
      principal:{issuer:"https://client.cloudflareaccess.com",subject:"access|short"},
      verifiedUntil:new Date(Date.now()+3_000).toISOString(),operationId:operation(),acknowledgedTarget:{clientRecordId:client,selectionId}});
    await new Promise(resolve=>setTimeout(resolve,3_050));
    await expect(confirmRecipientEnrollmentIntent(db,{intentId:issued.intentId,expectedRevision:2,operationId:operation(),owner}))
      .rejects.toThrow("denied");
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_recipient_identity_bindings").first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM client_portal_authority_v2_outbox").first("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
      .bind(issued.intentId).first("state")).toBe("pending");
  });

  it("rejects an issued-to-pending transition when the proof expires before SQL commits",async()=>{
    const issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt:future(),
      operationId:operation(),owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    const redeemOperation=operation(),expired="2000-01-01T00:00:00.000Z";
    await expect(db.batch([
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_operations
        (operation_id,intent_id,action,request_sha256,resulting_revision,resulting_state)
        VALUES(?,?,'redeem',?,2,'pending')`).bind(redeemOperation,issued.intentId,"e".repeat(64)),
      db.prepare(`UPDATE client_portal_recipient_enrollment_intents SET state='pending',revision=2,
        access_issuer='https://client.cloudflareaccess.com',access_subject='access|expired',recipient_verified_until=?
        WHERE intent_id=?`).bind(expired,issued.intentId),
      db.prepare("INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(redeemOperation,issued.intentId),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT state,revision FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
      .bind(issued.intentId).first()).toEqual({state:"issued",revision:1});
    expect(await db.prepare("SELECT count(*) n FROM client_portal_recipient_enrollment_operations WHERE operation_id=?")
      .bind(redeemOperation).first("n")).toBe(0);
  });

  it("rejects direct redemption after the durable intent expires",async()=>{
    const expiresAt=new Date(Date.now()+3_000).toISOString();
    const issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt,
      operationId:operation(),owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    await new Promise(resolve=>setTimeout(resolve,3_050));
    const redeemOperation=operation();
    await expect(db.batch([
      db.prepare(`INSERT INTO client_portal_recipient_enrollment_operations
        (operation_id,intent_id,action,request_sha256,resulting_revision,resulting_state)
        VALUES(?,?,'redeem',?,2,'pending')`).bind(redeemOperation,issued.intentId,"f".repeat(64)),
      db.prepare(`UPDATE client_portal_recipient_enrollment_intents SET state='pending',revision=2,
        access_issuer='https://client.cloudflareaccess.com',access_subject='access|late',recipient_verified_until=?
        WHERE intent_id=?`).bind(future(),issued.intentId),
      db.prepare("INSERT INTO client_portal_recipient_enrollment_operation_commits(operation_id,intent_id) VALUES(?,?)")
        .bind(redeemOperation,issued.intentId),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT state,revision FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
      .bind(issued.intentId).first()).toEqual({state:"issued",revision:1});
  });

  it("fences metadata while a full revoke is uncertain and finalizes only the exact receipt",async()=>{
    const issued=await issueRecipientEnrollmentIntent(db,{target:{clientRecordId:client,selectionId},expiresAt:future(),operationId:operation(),owner});
    if(!("opaqueToken" in issued))throw Error("expected fresh issue");
    const redeemId=operation();
    await redeemRecipientEnrollmentIntent(db,{intentId:issued.intentId,opaqueToken:issued.opaqueToken,
      principal:{issuer:"https://client.cloudflareaccess.com",subject:"access|revoke"},verifiedUntil:future(),operationId:redeemId,
      acknowledgedTarget:{clientRecordId:client,selectionId}});
    const confirmed=await confirmRecipientEnrollmentIntent(db,{intentId:issued.intentId,expectedRevision:2,operationId:operation(),owner});
    await acknowledgeAuthority(confirmed.operationId,1,1,"active",'["operations.service_home.read"]');
    const request={protocolVersion:1 as const,authorityId,workspaceId:"workspace-one",ownershipEpoch:1,grantRevision:1,
      issuer:"https://client.cloudflareaccess.com",subject:"access|revoke"};
    expect(await readClientPortalServiceMetadata(db,request)).toMatchObject({ok:true,services:[]});
    const bindingId=await db.prepare("SELECT binding_id FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
      .bind(issued.intentId).first<string>("binding_id"),permissionRemoval=operation();
    await enqueueClientPortalAuthorityV3(db,owner,{operationId:permissionRemoval,bindingOperationId:selectionId,
      clientAuthorityId:authorityId,workspaceId:"workspace-one",recipientBindingId:bindingId!,issuer:request.issuer,
      subject:request.subject,desiredState:"active",expectedOwnershipEpoch:1,expectedGrantRevision:1,permissions:[]});
    await acknowledgeAuthority(permissionRemoval,1,2,"active","[]");
    expect(await db.prepare("SELECT desired_state,permissions_json FROM client_portal_authority_v2_outbox WHERE operation_id=?")
      .bind(permissionRemoval).first()).toEqual({desired_state:"active",permissions_json:"[]"});
    const revoked=await revokeRecipientEnrollmentBinding(db,{intentId:issued.intentId,expectedRevision:3,operationId:operation(),owner});
    expect(await db.prepare("SELECT desired_state,protocol_version,permissions_json FROM client_portal_authority_v2_outbox WHERE operation_id=?")
      .bind(revoked.operationId).first()).toEqual({desired_state:"revoked",protocol_version:3,permissions_json:"[]"});
    expect(await readClientPortalServiceMetadata(db,request)).toMatchObject({ok:false,code:"denied"});
    const {reconcileRecipientEnrollmentRevocation}=await import("../src/worker/client-portal-recipient-enrollment-ledger");
    await expect(reconcileRecipientEnrollmentRevocation(db,{intentId:issued.intentId,expectedRevision:4,operationId:operation(),owner}))
      .rejects.toThrow("denied");
    expect(await db.prepare("SELECT status FROM client_onboarding_recipient_identity_bindings").first("status")).toBe("active");
    await acknowledgeAuthority(revoked.operationId,1,3,"revoked","[]");
    const racedOperation=operation(),session=db.withSession("first-primary"),racingDb={withSession:()=>({
      prepare:(query:string)=>session.prepare(query),batch:async(statements:D1PreparedStatement[])=>{
        await db.prepare("DELETE FROM native_directory_grants WHERE staff_id='owner' AND permission='directory.portal_access.manage' AND effect='allow'").run();
        return session.batch(statements);
      },
    })} as unknown as D1Database;
    await expect(reconcileRecipientEnrollmentRevocation(racingDb,{intentId:issued.intentId,expectedRevision:4,
      operationId:racedOperation,owner})).rejects.toThrow("denied");
    expect(await db.prepare("SELECT state,revision FROM client_portal_recipient_enrollment_intents WHERE intent_id=?")
      .bind(issued.intentId).first()).toEqual({state:"revoking",revision:4});
    expect(await db.prepare("SELECT status FROM client_onboarding_recipient_identity_bindings").first("status")).toBe("active");
    expect(await db.prepare("SELECT count(*) n FROM client_portal_recipient_enrollment_operations WHERE operation_id=?")
      .bind(racedOperation).first("n")).toBe(0);
    await db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)").run();
    const closed=await reconcileRecipientEnrollmentRevocation(db,{intentId:issued.intentId,expectedRevision:4,operationId:operation(),owner});
    expect(closed.review).toMatchObject({state:"revoked",revision:5});
    expect(await db.prepare("SELECT status FROM client_onboarding_recipient_identity_bindings").first("status")).toBe("revoked");
    const replay=await redeemRecipientEnrollmentIntent(db,{intentId:issued.intentId,opaqueToken:issued.opaqueToken,
      principal:{issuer:request.issuer,subject:request.subject},verifiedUntil:future(),operationId:redeemId,
      acknowledgedTarget:{clientRecordId:client,selectionId}});
    expect(replay).toMatchObject({replayed:true,review:{state:"pending",revision:2}});
    expect(await db.prepare("SELECT count(*) n FROM client_onboarding_recipient_identity_bindings").first("n")).toBe(1);
  },30_000);
});
