import {readFileSync} from "node:fs";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {Miniflare} from "miniflare";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import {applyVerifiedRecipientDeliveryAuthority,getVerifiedRecipientDeliveryAuthorityStatus} from "../src/worker/verified-recipient-delivery-authority";
import {applyVerifiedRecipientDeliveryAuthorityRpc,getVerifiedRecipientDeliveryAuthorityStatusRpc} from "../src/worker/verified-recipient-delivery-authority-entrypoint";
import {canonicalVerifiedRecipientDeliveryAuthorityCommand,parseVerifiedRecipientDeliveryAuthorityCommand}
  from "@ltds/shared/verified-recipient-delivery-authority";

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

async function seedAuthorityDependencies(db:D1Database){
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
}

async function migrate(db:D1Database,name:string){
  const migration=readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8");
  await db.batch(splitD1MigrationStatements(migration).map(statement=>db.prepare(statement)));
}

async function insertLegacy0221Authority(db:D1Database,raw:unknown){
  const value=parseVerifiedRecipientDeliveryAuthorityCommand(raw);
  if(!value)throw new Error("legacy fixture invalid");
  const json=canonicalVerifiedRecipientDeliveryAuthorityCommand(value);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(json));
  const hash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  await db.batch([
    db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_heads
      (authority_id,workspace_id,client_authority_id,selection_id,client_record_id,recipient_binding_id,enrollment_intent_id,enrollment_revision,issuer,subject,
       home_ownership_epoch,home_grant_revision,home_grant_operation_id,folder_binding_id,folder_binding_source_version,source_id,project_public_id,
       project_source_version,current_generation_id,access_terms_id,access_terms_kind,access_terms_mode,reviewed_expires_at,effective_expires_at,
       expires_at,reason_code,owner_staff_id,owner_access_subject,owner_admission_version,owner_profile_version,owner_grant_generation,
       owner_verified_until,authority_revision,state,last_operation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        value.authority.authorityId,value.selection.workspaceId,value.selection.clientAuthorityId,value.selection.selectionId,
        value.selection.clientRecordId,value.recipient.recipientBindingId,value.recipient.enrollmentIntentId,
        value.recipient.enrollmentRevision,value.recipient.issuer,value.recipient.subject,value.homeAuthority.ownershipEpoch,
        value.homeAuthority.grantRevision,value.homeAuthority.grantOperationId,value.resource.folderBindingId,
        value.resource.folderBindingSourceVersion,value.resource.sourceId,value.resource.projectPublicId,
        value.resource.projectSourceVersion,value.resource.currentGenerationId,value.terms.accessTerms.id,
        value.terms.accessTerms.kind,value.terms.accessTerms.mode,value.terms.accessTerms.reviewedExpiresAt,
        value.terms.accessTerms.effectiveExpiresAt,value.terms.expiresAt,value.terms.reasonCode,value.ownerProof.staffId,
        value.ownerProof.verifiedAccessSubject,value.ownerProof.admissionVersion,value.ownerProof.profileVersion,
        value.ownerProof.grantGeneration,value.ownerProof.verifiedUntil,1,"active",value.operationId),
    db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_audit
      (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state)
      VALUES(?,?,?,?,?,'upsert',0,1,'active')`).bind(value.operationId,hash,json,value.authority.authorityId,value.selection.clientRecordId),
    db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_receipts
      (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state)
      VALUES(?,?,?,?,?,'upsert',0,1,'active')`).bind(value.operationId,hash,json,value.authority.authorityId,value.selection.clientRecordId),
  ]);
  return {value,hash};
}

describe("verified-recipient Client resource authority",()=>{
  let mf:Miniflare,db:D1Database;
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await seedAuthorityDependencies(db);
    for(const name of ["0221_verified_recipient_delivery_authority.sql","0222_verified_recipient_delivery_cross_manager_revoke.sql"]){
      await migrate(db,name);
    }
  });
  afterEach(async()=>mf.dispose());

  it("is default-off and does not create identity, membership, entitlement, or grant rows",async()=>{
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db,"false"),command())).rejects.toThrow("writer-disabled");
    expect(await db.prepare("SELECT count(*) count FROM portal_verified_recipient_delivery_authority_heads").first("count")).toBe(0);
  });
  it("backfills exact 0221 provenance on a stale head and restores the unchanged renewal fence",async()=>{
    const legacyMf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",
      d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    try{
      const legacyDb=await legacyMf.getD1Database("DELIVERY_DB") as unknown as D1Database;
      await seedAuthorityDependencies(legacyDb);
      await migrate(legacyDb,"0221_verified_recipient_delivery_authority.sql");
      const legacy={...command(),ownerProof:{...command().ownerProof,
        verifiedUntil:new Date(Date.now()+1100).toISOString()}};
      const origin=await insertLegacy0221Authority(legacyDb,legacy);
      await legacyDb.prepare("UPDATE portal_primary_staff_bindings SET state='revoked' WHERE binding_id=?").bind(folder).run();
      await new Promise(resolve=>setTimeout(resolve,1200));
      await expect(migrate(legacyDb,"0222_verified_recipient_delivery_cross_manager_revoke.sql")).resolves.toBeUndefined();
      expect(await legacyDb.prepare(`SELECT created_operation_id,created_request_fingerprint,created_by_staff_id,
        created_by_access_subject,created_by_admission_version,created_by_profile_version,created_by_grant_generation,
        created_by_verified_until,state,authority_revision FROM portal_verified_recipient_delivery_authority_heads`).first()).toEqual({
          created_operation_id:origin.value.operationId,created_request_fingerprint:origin.hash,
          created_by_staff_id:origin.value.ownerProof.staffId,
          created_by_access_subject:origin.value.ownerProof.verifiedAccessSubject,
          created_by_admission_version:origin.value.ownerProof.admissionVersion,
          created_by_profile_version:origin.value.ownerProof.profileVersion,
          created_by_grant_generation:origin.value.ownerProof.grantGeneration,
          created_by_verified_until:origin.value.ownerProof.verifiedUntil,state:"active",authority_revision:1});
      expect(await legacyDb.prepare(`SELECT actor_staff_id,actor_access_subject,actor_admission_version,
        actor_profile_version,actor_grant_generation,actor_verified_until
        FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=?`).bind(origin.value.operationId).first()).toEqual({
          actor_staff_id:origin.value.ownerProof.staffId,actor_access_subject:origin.value.ownerProof.verifiedAccessSubject,
          actor_admission_version:origin.value.ownerProof.admissionVersion,
          actor_profile_version:origin.value.ownerProof.profileVersion,
          actor_grant_generation:origin.value.ownerProof.grantGeneration,
          actor_verified_until:origin.value.ownerProof.verifiedUntil});
      await expect(legacyDb.prepare(`UPDATE portal_verified_recipient_delivery_authority_heads
        SET authority_revision=2,last_operation_id='67676767-6767-4767-8767-676767676767'
        WHERE authority_id=?`).bind(origin.value.authority.authorityId).run()).rejects.toThrow("current-proof-required");
      const revoke={...origin.value,action:"revoke" as const,operationId:"78787878-7878-4878-8878-787878787878",
        authority:{...origin.value.authority,expectedRevision:1,resultingRevision:2},
        ownerProof:{...origin.value.ownerProof,staffId:"staff-02",verifiedAccessSubject:"owner-access-02"}};
      await expect(applyVerifiedRecipientDeliveryAuthority(env(legacyDb),revoke)).resolves.toMatchObject({
        status:"recorded",resultingState:"revoked",resultingRevision:2});
      expect(await legacyDb.prepare("SELECT owner_staff_id,created_by_staff_id,state FROM portal_verified_recipient_delivery_authority_heads").first())
        .toEqual({owner_staff_id:"staff-01",created_by_staff_id:"staff-01",state:"revoked"});
    }finally{await legacyMf.dispose();}
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
  it("renews by CAS and lets a different authorized command actor revoke without replacing grant provenance",async()=>{
    await applyVerifiedRecipientDeliveryAuthority(env(db),command());
    const renewed={...command("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","upsert",1),
      terms:{...command().terms,reasonCode:"renewed_recipient_folder"},
      ownerProof:{...command().ownerProof,staffId:"staff-02",verifiedAccessSubject:"owner-access-02",profileVersion:12}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),renewed)).resolves.toMatchObject({status:"recorded",resultingRevision:2});
    expect(await db.prepare(`SELECT recipient_binding_id,client_record_id,reason_code,owner_staff_id,owner_profile_version,
      created_operation_id,created_by_staff_id,created_by_profile_version,authority_revision
      FROM portal_verified_recipient_delivery_authority_heads`).first()).toEqual({
      recipient_binding_id:command().recipient.recipientBindingId,client_record_id:"client-record-01",reason_code:"renewed_recipient_folder",
      owner_staff_id:"staff-02",owner_profile_version:12,created_operation_id:command().operationId,
      created_by_staff_id:"staff-01",created_by_profile_version:11,authority_revision:2});
    const revoke={...command("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","revoke",2),terms:renewed.terms,
      ownerProof:{...command().ownerProof,staffId:"staff-03",verifiedAccessSubject:"owner-access-03",
        admissionVersion:8,profileVersion:14,grantGeneration:7}};
    const wrongResource={...revoke,operationId:"34343434-3434-4434-8434-343434343434",
      resource:{...revoke.resource,currentGenerationId:"forged-generation"}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),wrongResource)).rejects.toThrow("cas-conflict");
    const staleCas={...revoke,operationId:"45454545-4545-4545-8545-454545454545",
      authority:{...revoke.authority,expectedRevision:1,resultingRevision:2}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),staleCas)).rejects.toThrow("cas-conflict");
    const wrongRecipient={...revoke,operationId:"56565656-5656-4656-8656-565656565656",
      recipient:{...revoke.recipient,subject:"forged-recipient"}};
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),wrongRecipient)).rejects.toThrow("cas-conflict");
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),revoke)).resolves.toMatchObject({
      status:"recorded",resultingState:"revoked",resultingRevision:3});
    expect(await db.prepare(`SELECT state,authority_revision,last_operation_id,owner_staff_id,owner_access_subject,
      created_operation_id,created_by_staff_id FROM portal_verified_recipient_delivery_authority_heads`).first()).toEqual({
      state:"revoked",authority_revision:3,last_operation_id:revoke.operationId,owner_staff_id:"staff-02",
      owner_access_subject:"owner-access-02",created_operation_id:command().operationId,created_by_staff_id:"staff-01"});
    expect(await db.prepare(`SELECT actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,
      actor_grant_generation,actor_verified_until FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=?`)
      .bind(revoke.operationId).first()).toEqual({actor_staff_id:"staff-03",actor_access_subject:"owner-access-03",
        actor_admission_version:8,actor_profile_version:14,actor_grant_generation:7,
        actor_verified_until:command().ownerProof.verifiedUntil});
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),revoke)).resolves.toMatchObject({status:"replayed"});
    await expect(applyVerifiedRecipientDeliveryAuthority(env(db),{
      ...revoke,ownerProof:{...revoke.ownerProof,profileVersion:15},
    })).rejects.toThrow("operation-conflict");
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
    await expect(db.prepare(`UPDATE portal_verified_recipient_delivery_authority_heads
      SET created_by_staff_id='forged-creator',authority_revision=2,last_operation_id=? WHERE authority_id=?`)
      .bind("23232323-2323-4323-8323-232323232323",command().authority.authorityId).run()).rejects.toThrow("creation-provenance-is-immutable");
    const nullActorOperation="24242424-2424-4424-8424-242424242424";
    const nullActorRequest={...command(nullActorOperation,"revoke",1),ownerProof:{staffId:null,
      verifiedAccessSubject:null,admissionVersion:null,profileVersion:null,grantGeneration:null,verifiedUntil:null}};
    await expect(db.batch([
      db.prepare(`UPDATE portal_verified_recipient_delivery_authority_heads SET authority_revision=2,state='revoked',
        last_operation_id=?,revoked_at='2099-01-01T00:00:00.000Z' WHERE authority_id=?`)
        .bind(nullActorOperation,command().authority.authorityId),
      db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_audit
        (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state,
         actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?,?,?,?,'revoke',1,2,'revoked',NULL,NULL,NULL,NULL,NULL,NULL)`).bind(nullActorOperation,"0".repeat(64),
          JSON.stringify(nullActorRequest),command().authority.authorityId,command().selection.clientRecordId),
    ])).rejects.toThrow("shaped-command-actor");
    expect(await db.prepare("SELECT state,authority_revision,last_operation_id FROM portal_verified_recipient_delivery_authority_heads").first())
      .toEqual({state:"active",authority_revision:1,last_operation_id:command().operationId});
    await expect(db.prepare("UPDATE portal_verified_recipient_delivery_authority_heads SET folder_binding_id='other-folder',authority_revision=2,last_operation_id=? WHERE authority_id=?")
      .bind("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",command().authority.authorityId).run()).rejects.toThrow("cas-denied");
    const fakeOperation="ffffffff-ffff-4fff-8fff-ffffffffffff";
    const fakeRequest={...command(fakeOperation,"upsert",1),selection:{...command().selection,clientRecordId:"other-client-record"}};
    await expect(db.batch([
      db.prepare("UPDATE portal_verified_recipient_delivery_authority_heads SET authority_revision=2,last_operation_id=? WHERE authority_id=?")
        .bind(fakeOperation,command().authority.authorityId),
      db.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_audit
        (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state,
         actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?,?,?,?,'upsert',1,2,'active',?,?,?,?,?,?)`).bind(fakeOperation,"0".repeat(64),JSON.stringify(fakeRequest),
          command().authority.authorityId,"other-client-record",fakeRequest.ownerProof.staffId,fakeRequest.ownerProof.verifiedAccessSubject,
          fakeRequest.ownerProof.admissionVersion,fakeRequest.ownerProof.profileVersion,fakeRequest.ownerProof.grantGeneration,
          fakeRequest.ownerProof.verifiedUntil),
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
        (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state,
         actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
        VALUES(?,?,?,?,?,'upsert',1,2,'active',?,?,?,?,?,?)`).bind(operationId,"0".repeat(64),JSON.stringify(renewal),
          command().authority.authorityId,"other-client-record",renewal.ownerProof.staffId,renewal.ownerProof.verifiedAccessSubject,
          renewal.ownerProof.admissionVersion,renewal.ownerProof.profileVersion,renewal.ownerProof.grantGeneration,
          renewal.ownerProof.verifiedUntil),
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
