import {readFileSync} from "node:fs";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {Miniflare} from "miniflare";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import {applyVerifiedRecipientDeliveryAuthority,getVerifiedRecipientDeliveryAuthorityStatus} from "../src/worker/verified-recipient-delivery-authority";
import {applyVerifiedRecipientDeliveryAuthorityRpc,getVerifiedRecipientDeliveryAuthorityStatusRpc} from "../src/worker/verified-recipient-delivery-authority-entrypoint";
import {parseVerifiedRecipientDeliveryAuthorityCommand} from "@ltds/shared/verified-recipient-delivery-authority";

const workspace="workspace-01",authority="66666666-6666-4666-8666-666666666666",selection="55555555-5555-4555-8555-555555555555";
const homeOperation="77777777-7777-4777-8777-777777777777",folder="folder-01",generation="generation-01";
const issuer="https://access.example.test",subject="recipient-subject-01";
const env=(db:D1Database,writer="true",status="true")=>({DELIVERY_DB:db,ENVIRONMENT:"staging",
  EXPECTED_HOST:"delivery-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED:writer,
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED:status});
const command=(operationId="11111111-1111-4111-8111-111111111111",action:"upsert"|"revoke"="upsert",expectedRevision=0)=>({
  protocol:"verified-recipient-delivery-authority",protocolVersion:1,action,operationId,
  recipient:{recipientBindingId:"22222222-2222-4222-8222-222222222222",enrollmentIntentId:"33333333-3333-4333-8333-333333333333",enrollmentRevision:4,issuer,subject},
  selection:{selectionId:selection,clientAuthorityId:authority,clientRecordId:"client-record-01",workspaceId:workspace},
  homeAuthority:{ownershipEpoch:4,grantRevision:7,grantOperationId:homeOperation},
  resource:{folderBindingId:folder,folderBindingSourceVersion:"binding-v1",sourceId:"project-alpha:primary",projectPublicId:"project-01",projectSourceVersion:"project-v1",currentGenerationId:generation},
  authority:{authorityId:"88888888-8888-4888-8888-888888888888",expectedRevision,resultingRevision:expectedRevision+1},
  terms:{reasonCode:"verified_recipient_folder",expiresAt:null,accessTerms:{id:"terms-01",kind:"customer",mode:"until_revoked",reviewedExpiresAt:null,effectiveExpiresAt:null}},
  ownerProof:{staffId:"staff-01",verifiedAccessSubject:"owner-access-01",admissionVersion:6,profileVersion:11,grantGeneration:5,verifiedUntil:"2099-01-02T03:04:05.678Z"},
} as const);

describe("verified-recipient Client resource authority",()=>{
  let mf:Miniflare,db:D1Database;
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT)"),
      db.prepare("CREATE TABLE portal_v2_root_access_policies(projection_source_id TEXT,root_type TEXT,root_public_id TEXT,state TEXT)"),
      db.prepare("CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY,state TEXT,active_revision INTEGER)"),
      db.prepare("CREATE TABLE pa_portal_source_authority_revisions(source_id TEXT,revision INTEGER,PRIMARY KEY(source_id,revision))"),
      db.prepare("CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,owner_scope_type TEXT,owner_public_id TEXT,source_version TEXT,status TEXT,revoked_at TEXT,UNIQUE(id,workspace_id))"),
      db.prepare("CREATE TABLE portal_client_authority_workspace_bindings(client_authority_id TEXT PRIMARY KEY,workspace_id TEXT,operation_id TEXT UNIQUE,state TEXT,revision INTEGER)"),
      db.prepare("CREATE TABLE portal_client_authority_workspace_binding_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,workspace_id TEXT)"),
      db.prepare("CREATE TABLE portal_client_authority_workspace_binding_audit(operation_id TEXT PRIMARY KEY)"),
      db.prepare("CREATE TABLE portal_operations_workspace_authority_heads(workspace_id TEXT PRIMARY KEY,client_authority_id TEXT,ownership_epoch INTEGER,state TEXT,binding_operation_id TEXT)"),
      db.prepare("CREATE TABLE portal_operations_principal_grant_heads(workspace_id TEXT,client_authority_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,state TEXT,last_operation_id TEXT,protocol_version INTEGER,permissions_json TEXT,PRIMARY KEY(workspace_id,issuer,subject))"),
      db.prepare("CREATE TABLE portal_operations_authority_v2_receipts(operation_id TEXT PRIMARY KEY,client_authority_id TEXT,workspace_id TEXT,issuer TEXT,subject TEXT,ownership_epoch INTEGER,grant_revision INTEGER,resulting_state TEXT,protocol_version INTEGER,permissions_json TEXT)"),
      db.prepare("CREATE TABLE portal_operations_authority_v2_audit(operation_id TEXT PRIMARY KEY)"),
      db.prepare("CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER)"),
      db.prepare("CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT)"),
      db.prepare("CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER)"),
      db.prepare("CREATE TABLE portal_project_access_terms(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,project_public_id TEXT,kind TEXT,mode TEXT,expires_at TEXT)"),
      db.prepare("CREATE TABLE portal_project_access_deadlines(access_terms_id TEXT PRIMARY KEY,deadline_at TEXT)"),
      db.prepare("CREATE TABLE portal_project_access_current_lifecycle(workspace_id TEXT,source_id TEXT,project_public_id TEXT,lifecycle_status TEXT)"),
      db.prepare("CREATE TABLE portal_primary_staff_bindings(binding_id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,owner_scope_type TEXT,project_public_id TEXT,directory_generation_id TEXT,project_source_version TEXT,state TEXT)"),
      db.prepare("CREATE TABLE portal_native_staff_bindings(binding_id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,project_public_id TEXT)"),
      db.prepare("CREATE TABLE portal_native_staff_grants(grant_id TEXT PRIMARY KEY,binding_id TEXT,source_id TEXT,state TEXT,authorization_id TEXT)"),
      db.prepare("CREATE TABLE portal_native_staff_grant_events(grant_id TEXT,authorization_id TEXT,action TEXT)"),
      db.prepare("CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,binding_source_version TEXT,status TEXT,revoked_at TEXT)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,?,?,?,?)").bind(workspace,"project-alpha:primary","active","organization","root-01",null),
      db.prepare("INSERT INTO portal_v2_folder_bindings VALUES(?,?,?,?,?,?,?)").bind(folder,workspace,"project","project-01","binding-v1","active",null),
      db.prepare("INSERT INTO portal_client_authority_workspace_bindings VALUES(?,?,?,?,?)").bind(authority,workspace,selection,"inactive",1),
      db.prepare("INSERT INTO portal_client_authority_workspace_binding_receipts VALUES(?,?,?)").bind(selection,authority,workspace),
      db.prepare("INSERT INTO portal_operations_workspace_authority_heads VALUES(?,?,?,?,?)").bind(workspace,authority,4,"active",selection),
      db.prepare("INSERT INTO portal_operations_principal_grant_heads VALUES(?,?,?,?,?,?,?,?,?,?)").bind(workspace,authority,issuer,subject,4,7,"active",homeOperation,3,'["operations.service_home.read"]'),
      db.prepare("INSERT INTO portal_operations_authority_v2_receipts VALUES(?,?,?,?,?,?,?,?,?,?)").bind(homeOperation,authority,workspace,issuer,subject,4,7,"active",3,'["operations.service_home.read"]'),
      db.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,?,?)").bind(generation,workspace,"active",1),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)").bind(workspace,generation),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,?,?,?)").bind(workspace,generation,"project","project-01","project-v1",1),
      db.prepare("INSERT INTO portal_project_access_terms VALUES(?,?,?,?,?,?,?)").bind("terms-01",workspace,"project-alpha:primary","project-01","customer","until_revoked",null),
      db.prepare("INSERT INTO portal_primary_staff_bindings VALUES(?,?,?,?,?,?,?,?)").bind(folder,workspace,"project-alpha:primary","project","project-01",generation,"project-v1","active"),
    ]);
    const migration=readFileSync(new URL("../migrations/0221_verified_recipient_delivery_authority.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(migration).map(statement=>db.prepare(statement)));
  });
  afterEach(async()=>mf.dispose());

  it("is default-off and does not create identity, membership, entitlement, or grant rows",async()=>{
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db,"false"),command())).rejects.toThrow("writer-disabled");
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_heads").first("count")).toBe(0);
  });
  it("requires exact current home proof, folder publication, generation, project, and terms",async()=>{
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),command())).resolves.toMatchObject({resultingState:"active",resultingRevision:1,status:"recorded"});
    expect(await db.prepare("SELECT client_record_id,selection_id,home_ownership_epoch,home_grant_revision,home_grant_operation_id,folder_binding_id,current_generation_id,state FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({client_record_id:"client-record-01",selection_id:selection,home_ownership_epoch:4,home_grant_revision:7,home_grant_operation_id:homeOperation,folder_binding_id:folder,current_generation_id:generation,state:"active"});
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),command())).resolves.toMatchObject({status:"replayed"});
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),{...command("99999999-9999-4999-8999-999999999999"),recipient:{...command().recipient,subject:"different"}})).rejects.toThrow("current-proof-missing");
    expect(await getVerifiedRecipientDeliveryAuthorityStatus(env(db),command())).toMatchObject({resultingState:"active",resultingRevision:1,status:"replayed"});
  });
  it("rejects stale source generation and CAS without creating a head",async()=>{
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),{...command(),operationId:"99999999-9999-4999-8999-999999999999",resource:{...command().resource,currentGenerationId:"stale-generation"}})).rejects.toThrow("current-proof-missing");
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),{...command("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","upsert",1),authority:{...command().authority,expectedRevision:0,resultingRevision:1}})).rejects.toThrow("cas-conflict");
  });
  it("permits only one active authority for a recipient-folder target",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    const duplicate={...command("99999999-9999-4999-8999-999999999999"),authority:{...command().authority,authorityId:"99999999-9999-4999-8999-999999999999"}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),duplicate)).rejects.toThrow("cas-conflict");
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_heads WHERE state='active'").first("count")).toBe(1);
  });
  it("revokes deny-first after folder/source drift and preserves immutable evidence",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    await db.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at='2099-01-01T00:00:00.000Z' WHERE id=?").bind(folder).run();
    const revoke=command("22222222-2222-4222-8222-222222222222","revoke",1);
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),revoke)).resolves.toMatchObject({resultingState:"revoked",resultingRevision:2,status:"recorded"});
    expect(await db.prepare("SELECT state,authority_revision FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({state:"revoked",authority_revision:2});
    await expect(db.prepare("DELETE FROM portal_verified_recipient_delivery_authority_receipts").run()).rejects.toThrow("immutable");
  });
  it("denies renewal but permits exact revoke after owner proof expiry and publication loss",async()=>{
    const create=command();
    await applyVerifiedRecipientDeliveryAuthority(env(db),create);
    await db.prepare("UPDATE portal_primary_staff_bindings SET state='revoked' WHERE binding_id=?")
      .bind(folder).run();
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.parse(create.ownerProof.verifiedUntil)+1);
    try {
      const renewal={...create,operationId:"13131313-1313-4313-8313-131313131313",
        authority:{...create.authority,expectedRevision:1,resultingRevision:2}};
      await expect(applyVerifiedRecipientDeliveryAuthority(env(db),renewal))
        .rejects.toThrow("verified-recipient-delivery-authority-owner-proof-expired");
      expect(await db.prepare("SELECT state,authority_revision,last_operation_id FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({
        state:"active",authority_revision:1,last_operation_id:create.operationId});
      const revoke={...create,action:"revoke" as const,operationId:"14141414-1414-4414-8414-141414141414",
        authority:{...create.authority,expectedRevision:1,resultingRevision:2}};
      await expect(applyVerifiedRecipientDeliveryAuthority(env(db),revoke)).resolves.toMatchObject({
        resultingState:"revoked",resultingRevision:2,status:"recorded"});
      expect(await db.prepare("SELECT state,authority_revision,last_operation_id FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({
        state:"revoked",authority_revision:2,last_operation_id:revoke.operationId});
    } finally { clock.mockRestore(); }
  });
  it("rejects malformed command before any SQL write and preserves operation replay bytes",async()=>{
    const malformed={...command(),terms:{...command().terms,reasonCode:"bad/character"}};
    expect(parseVerifiedRecipientDeliveryAuthorityCommand(malformed)).toBeNull();
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),{...command(),ownerProof:{...command().ownerProof,staffId:"changed"}})).rejects.toThrow("operation-conflict");
  });
  it("fails closed when status is disabled",async()=>{
    await expect(getVerifiedRecipientDeliveryAuthorityStatus(env(db,"true","false"),command())).rejects.toThrow("status-disabled");
  });
  it("renews by CAS with fresh mutable proof while preserving target identity",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    const renewed={...command("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","upsert",1),
      terms:{...command().terms,reasonCode:"renewed_recipient_folder"},
      ownerProof:{...command().ownerProof,staffId:"staff-02",verifiedAccessSubject:"owner-access-02",profileVersion:12}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),renewed)).resolves.toMatchObject({status:"recorded",resultingRevision:2});
    expect(await db.prepare("SELECT recipient_binding_id,client_record_id,reason_code,owner_staff_id,owner_profile_version,authority_revision FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({
      recipient_binding_id:command().recipient.recipientBindingId,client_record_id:"client-record-01",reason_code:"renewed_recipient_folder",
      owner_staff_id:"staff-02",owner_profile_version:12,authority_revision:2});
    const wrongReviewer={...command("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","revoke",2),terms:renewed.terms};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),wrongReviewer)).rejects.toThrow("cas-conflict");
    expect(await db.prepare("SELECT state,authority_revision,last_operation_id,owner_staff_id FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({
      state:"active",authority_revision:2,last_operation_id:renewed.operationId,owner_staff_id:"staff-02"});
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=?")
      .bind(wrongReviewer.operationId).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?")
      .bind(wrongReviewer.operationId).first("count")).toBe(0);
  });
  it("rejects a renewal command for a different immutable selection target",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    const mismatch={...command("dddddddd-dddd-4ddd-8ddd-dddddddddddd","upsert",1),
      selection:{...command().selection,clientRecordId:"other-client-record"}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),mismatch)).rejects.toThrow("cas-conflict");
    expect(await db.prepare("SELECT authority_revision,client_record_id,last_operation_id FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({
      authority_revision:1,client_record_id:"client-record-01",last_operation_id:command().operationId});
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?").bind(mismatch.operationId).first("count")).toBe(0);
  });
  it("rejects direct target mutation and fake audit JSON atomically",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    await expect(db.prepare("UPDATE portal_verified_recipient_delivery_authority_heads SET folder_binding_id='other-folder',authority_revision=2,last_operation_id=? WHERE authority_id=?")
      .bind("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",command().authority.authorityId).run()).rejects.toThrow("cas-denied");
    const fakeOperation="ffffffff-ffff-4fff-8fff-ffffffffffff";
    const fakeRequest={...command(fakeOperation,"upsert",1),selection:{...command().selection,clientRecordId:"other-client-record"}};
    await expect(db.batch([
      db.prepare("UPDATE portal_verified_recipient_delivery_authority_heads SET authority_revision=2,last_operation_id=? WHERE authority_id=?")
        .bind(fakeOperation,command().authority.authorityId),
      db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_audit
        (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state)
        VALUES(?,?,?,?,?,'upsert',1,2,'active')`).bind(fakeOperation,"0".repeat(64),JSON.stringify(fakeRequest),command().authority.authorityId,"other-client-record"),
    ])).rejects.toThrow("exact-post-cas-head");
    expect(await db.prepare("SELECT authority_revision,last_operation_id FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({authority_revision:1,last_operation_id:command().operationId});
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=?").bind(fakeOperation).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?").bind(fakeOperation).first("count")).toBe(0);
  });
  it("rejects a mismatched audit client-record column despite exact request JSON",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    const operationId="12121212-1212-4212-8212-121212121212";
    const renewal=command(operationId,"upsert",1);
    await expect(db.batch([
      db.prepare("UPDATE portal_verified_recipient_delivery_authority_heads SET authority_revision=2,last_operation_id=? WHERE authority_id=?")
        .bind(operationId,command().authority.authorityId),
      db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_audit
        (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state)
        VALUES(?,?,?,?,?,'upsert',1,2,'active')`).bind(operationId,"0".repeat(64),JSON.stringify(renewal),command().authority.authorityId,"other-client-record"),
    ])).rejects.toThrow("exact-post-cas-head");
    expect(await db.prepare("SELECT authority_revision,last_operation_id FROM portal_verified_recipient_delivery_authority_heads").first()).toEqual({authority_revision:1,last_operation_id:command().operationId});
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=?").bind(operationId).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?").bind(operationId).first("count")).toBe(0);
  });
  it("transactionally rejects root-policy drift between preflight and insert batch",async()=>{
    let raced=false;
    const raceDb=new Proxy(db,{get(target,property){
      if(property!=="withSession")return Reflect.get(target,property,target);
      return()=>{const session=target.withSession("first-primary");return new Proxy(session,{get(current,key){
        if(key!=="batch")return Reflect.get(current,key,current);
        return async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await db.prepare("INSERT INTO portal_v2_root_access_policies VALUES(?,?,?,?)").bind("project-alpha:primary","organization","root-01","revoked").run();}return current.batch(statements);};
      }});};
    }}) as D1Database;
    await expect(applyVerifiedRecipientDeliveryAuthority(env(raceDb),command())).rejects.toThrow("cas-conflict");
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_heads").first("count")).toBe(0);
  });
  it("runs the private RPC helpers against durable Miniflare rows",async()=>{
    const applied=await applyVerifiedRecipientDeliveryAuthorityRpc(env(db),command());
    expect(applied).toMatchObject({ok:true,receipt:{status:"recorded",resultingState:"active",resultingRevision:1}});
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env(db),command())).resolves.toMatchObject({ok:true,receipt:{status:"replayed"}});
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env(db),command())).resolves.toMatchObject({ok:true,receipt:{status:"replayed"}});
    const drift={...command(),ownerProof:{...command().ownerProof,profileVersion:12}};
    await expect(getVerifiedRecipientDeliveryAuthorityStatusRpc(env(db),drift)).resolves.toMatchObject({ok:false,code:"conflict"});
    const revoke=command("cccccccc-cccc-4ccc-8ccc-cccccccccccc","revoke",1);
    await expect(applyVerifiedRecipientDeliveryAuthorityRpc(env(db),revoke)).resolves.toMatchObject({ok:true,receipt:{status:"recorded",resultingState:"revoked",capabilities:[]}});
  });
});
