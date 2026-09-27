import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";
import {bindClientAuthorityWorkspace,getClientAuthorityWorkspaceBindingStatus} from
  "../../client/src/worker/client-authority-workspace-binding-entrypoint";
import {applyClientPortalAuthorityV2,getClientPortalAuthorityV2Status} from
  "../../client/src/worker/client-portal-authority-v2-entrypoint";
import {selectPortalWorkspaceBinding} from "../src/worker/client-portal-workspace-binding-selection";
import {dispatchNextPortalWorkspaceBinding,enqueuePortalWorkspaceBinding,
  type WorkspaceBindingCommand,type WorkspaceBindingEnv} from "../src/worker/client-portal-workspace-binding-outbox";
import {dispatchNextClientPortalAuthorityV2,enqueueClientPortalAuthorityV2,
  type AuthorityV2Env, type ClientPortalAuthorityV2Command} from "../src/worker/client-portal-authority-v2-outbox";
import type {AuthenticatedNativeStaffWithAdmissionVersion} from "../src/worker/native-staff-auth";

describe("joined Operations to Client inactive workspace binding",()=>{
  let runtime:Miniflare,opsDb:D1Database,clientDb:D1Database;
  const recordId="11111111-1111-4111-8111-111111111111";
  const activationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const selectionId="22222222-2222-4222-8222-222222222222";
  const recipientBindingId="55555555-5555-4555-8555-555555555555",clientRecordId="66666666-6666-4666-8666-666666666666";
  const rootPublicId="a".repeat(32);
  const actor:AuthenticatedNativeStaffWithAdmissionVersion={identity:{kind:"native",staffId:"owner",
    verifiedAccessSubject:"access|owner",email:"owner@example.test",displayName:"Owner",profileVersion:3},
    admissionVersion:2,verifiedUntil:new Date(Date.now()+30*60_000).toISOString()};

  async function migrate(db:D1Database,url:URL){
    const sql=readFileSync(url,"utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
  }

  beforeEach(async()=>{
    runtime=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",
      d1Databases:{OPS_DB:crypto.randomUUID(),CLIENT_DB:crypto.randomUUID()}});
    opsDb=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    clientDb=await runtime.getD1Database("CLIENT_DB") as unknown as D1Database;
    await opsDb.batch([
      opsDb.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      opsDb.prepare("CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT)"),
      opsDb.prepare("CREATE TABLE client_onboarding_recipient_identity_bindings(binding_id TEXT PRIMARY KEY,target_client_record_id TEXT,access_issuer TEXT,access_subject TEXT,status TEXT,expires_at TEXT,revoked_at TEXT,CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)))"),
      opsDb.prepare(`CREATE TABLE project_alpha_existing_directory_binding_activation_receipts
        (activation_id TEXT PRIMARY KEY,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,
          history_epoch_id TEXT,project_alpha_public_id TEXT,resource_type TEXT,local_record_version INTEGER)`),
      opsDb.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
      opsDb.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER)"),
      opsDb.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      opsDb.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)"),
      opsDb.prepare(`CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,
        scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)`),
      opsDb.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)"),
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',4)").bind(recordId),
      opsDb.prepare("INSERT INTO operations_directory_records VALUES(?,'client',1)").bind(clientRecordId),
      opsDb.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?)").bind(clientRecordId,recordId),
      opsDb.prepare("INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?,?,?,'access|client-one','active',NULL,NULL)").bind(recipientBindingId,clientRecordId,"https://access.example.test"),
      opsDb.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
        VALUES(?,?,'project-alpha:primary','source-instance-a','application-a','epoch-a',?,'organization',4)`)
        .bind(activationId,recordId,rootPublicId),
      opsDb.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      opsDb.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      opsDb.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      opsDb.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
      opsDb.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)"),
    ]);
    await migrate(opsDb,new URL("../migrations/0143_client_portal_workspace_binding_selection.sql",import.meta.url));
    await migrate(opsDb,new URL("../migrations/0144_client_portal_workspace_binding_outbox.sql",import.meta.url));
    await migrate(opsDb,new URL("../migrations/0145_client_portal_authority_v2_outbox.sql",import.meta.url));

    await clientDb.batch([
      clientDb.prepare(`CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT NOT NULL,
        pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT NOT NULL)`),
      clientDb.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT NOT NULL,source_workspace_id TEXT NOT NULL)"),
      clientDb.prepare(`CREATE TABLE pa_portal_projection_generations(id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,projection_source_id TEXT NOT NULL,
        workspace_root_type TEXT NOT NULL,workspace_root_public_id TEXT NOT NULL)`),
      clientDb.prepare(`CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,
        source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,snapshot_generation_id TEXT NOT NULL)`),
      clientDb.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-a','organization',?,NULL,'project-alpha:primary')").bind(rootPublicId),
      clientDb.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-a','project-alpha:primary','pa-workspace-a')"),
      clientDb.prepare(`INSERT INTO pa_portal_projection_generations VALUES
        ('snapshot-7','workspace-a','generation-7',7,'project-alpha:primary','organization',?)`).bind(rootPublicId),
      clientDb.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-a','generation-7',7,'snapshot-7')"),
    ]);
    for(const migration of ["0216_client_authority_workspace_ownership_claim.sql",
      "0217_client_authority_workspace_claim_evidence.sql","0218_client_authority_workspace_binding.sql",
      "0219_operations_portal_authority_v2.sql"])
      await migrate(clientDb,new URL(`../../client/migrations/${migration}`,import.meta.url));
  });
  afterEach(async()=>runtime.dispose());

  it("recovers a lost response with the same operation and records the exact inactive receipt",async()=>{
    const selected=await selectPortalWorkspaceBinding(opsDb,actor,{selectionId,recordId,activationId,
      workspaceId:"workspace-a",sourceWorkspaceId:"pa-workspace-a",
      checkpoint:{sourceGeneration:"generation-7",sourceSequence:7,snapshotGenerationId:"snapshot-7"}});
    await enqueuePortalWorkspaceBinding(opsDb,actor,selected.selectionId);
    const sent:string[]=[];let loseFirstResponse=true;
    const binding={bindWorkspace:async(command:WorkspaceBindingCommand)=>{
      sent.push(command.operationId);
      const receipt=await bindClientAuthorityWorkspace({DELIVERY_DB:clientDb,
        CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED:"true"},command);
      if(loseFirstResponse){loseFirstResponse=false;throw new Error("response lost after Client commit");}
      return receipt;
    },getBindingStatus:(input:{protocolVersion:1;operationId:string})=>getClientAuthorityWorkspaceBindingStatus({
      DELIVERY_DB:clientDb,CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED:"true"},input)};
    const env={OPS_DB:opsDb,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:binding} satisfies WorkspaceBindingEnv;

    expect(await dispatchNextPortalWorkspaceBinding(env)).toEqual({status:"acknowledged",operationId:selectionId});
    expect(await clientDb.prepare("SELECT state FROM portal_client_authority_workspace_bindings WHERE operation_id=?")
      .bind(selectionId).first("state")).toBe("inactive");
    expect(sent).toEqual([selectionId]);

    const client=await clientDb.prepare(`SELECT client_authority_id,workspace_id,projection_source_id,
      source_workspace_id,root_type,root_public_id,reconciliation_source_generation,
      reconciliation_source_sequence,reconciliation_snapshot_generation_id,state,revision
      FROM portal_client_authority_workspace_bindings WHERE operation_id=?`).bind(selectionId).first();
    expect(client).toMatchObject({client_authority_id:selected.clientAuthorityId,workspace_id:"workspace-a",
      projection_source_id:"project-alpha:primary",source_workspace_id:"pa-workspace-a",root_type:"organization",
      root_public_id:rootPublicId,reconciliation_source_generation:"generation-7",reconciliation_source_sequence:7,
      reconciliation_snapshot_generation_id:"snapshot-7",state:"inactive",revision:1});
    const receipt=await opsDb.prepare(`SELECT client_authority_id,workspace_id,projection_source_id,
      source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
      checkpoint_snapshot_generation_id,state,revision,replayed FROM client_portal_workspace_binding_outbox_receipts
      WHERE operation_id=?`).bind(selectionId).first();
    expect(receipt).toEqual({client_authority_id:selected.clientAuthorityId,workspace_id:"workspace-a",
      projection_source_id:"project-alpha:primary",source_workspace_id:"pa-workspace-a",root_type:"organization",
      root_public_id:rootPublicId,checkpoint_source_generation:"generation-7",checkpoint_source_sequence:7,
      checkpoint_snapshot_generation_id:"snapshot-7",state:"inactive",revision:1,replayed:1});
  });

  it("uses only an acknowledged inactive binding and recovers an active v2 grant through status",async()=>{
    const selected=await selectPortalWorkspaceBinding(opsDb,actor,{selectionId,recordId,activationId,
      workspaceId:"workspace-a",sourceWorkspaceId:"pa-workspace-a",
      checkpoint:{sourceGeneration:"generation-7",sourceSequence:7,snapshotGenerationId:"snapshot-7"}});
    await enqueuePortalWorkspaceBinding(opsDb,actor,selected.selectionId);
    const binding={bindWorkspace:(command:WorkspaceBindingCommand)=>bindClientAuthorityWorkspace({DELIVERY_DB:clientDb,
      CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED:"true"},command),getBindingStatus:(input:{protocolVersion:1;operationId:string})=>getClientAuthorityWorkspaceBindingStatus({DELIVERY_DB:clientDb,CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED:"true"},input)};
    await expect(dispatchNextPortalWorkspaceBinding({OPS_DB:opsDb,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:binding} satisfies WorkspaceBindingEnv)).resolves.toMatchObject({status:"acknowledged"});
    const pending=await enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"33333333-3333-4333-8333-333333333333",bindingOperationId:selectionId,recipientBindingId,
      clientAuthorityId:selected.clientAuthorityId,workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-one",
      desiredState:"active",expectedOwnershipEpoch:0,expectedGrantRevision:0});
    let lost=true; const authority={applyAuthority:async(command:ClientPortalAuthorityV2Command)=>{
      const value=await applyClientPortalAuthorityV2({DELIVERY_DB:clientDb,CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED:"true"},command);
      if(lost){lost=false;throw Error("lost response");} return value;
    },getAuthorityStatus:(input:{protocolVersion:2;operationId:string})=>getClientPortalAuthorityV2Status({DELIVERY_DB:clientDb,
      CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED:"true"},input)};
    await expect(dispatchNextClientPortalAuthorityV2({OPS_DB:opsDb,CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED:"true",
      CLIENT_PORTAL_AUTHORITY_V2:authority} satisfies AuthorityV2Env)).resolves.toEqual({status:"acknowledged",operationId:pending.operationId});
    expect(await opsDb.prepare("SELECT resulting_state FROM client_portal_authority_v2_outbox_receipts WHERE operation_id=?")
      .bind(pending.operationId).first("resulting_state")).toBe("active");
    const secondBinding="77777777-7777-4777-8777-777777777777";
    await opsDb.prepare("INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?,?,?,'access|client-two','active',NULL,NULL)")
      .bind(secondBinding,clientRecordId,"https://access.example.test").run();
    const second=await enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"88888888-8888-4888-8888-888888888888",bindingOperationId:selectionId,recipientBindingId:secondBinding,
      clientAuthorityId:selected.clientAuthorityId,workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-two",desiredState:"active",expectedOwnershipEpoch:1,expectedGrantRevision:0});
    await expect(dispatchNextClientPortalAuthorityV2({OPS_DB:opsDb,CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2:authority} satisfies AuthorityV2Env))
      .resolves.toEqual({status:"acknowledged",operationId:second.operationId});
    const revoke=await enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"99999999-9999-4999-8999-999999999999",bindingOperationId:selectionId,recipientBindingId,
      clientAuthorityId:selected.clientAuthorityId,workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-one",desiredState:"revoked",expectedOwnershipEpoch:1,expectedGrantRevision:1});
    await expect(dispatchNextClientPortalAuthorityV2({OPS_DB:opsDb,CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2:authority} satisfies AuthorityV2Env))
      .resolves.toEqual({status:"acknowledged",operationId:revoke.operationId});
    const regrant=await enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",bindingOperationId:selectionId,recipientBindingId,
      clientAuthorityId:selected.clientAuthorityId,workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-one",desiredState:"active",expectedOwnershipEpoch:1,expectedGrantRevision:2});
    await expect(dispatchNextClientPortalAuthorityV2({OPS_DB:opsDb,CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2:authority} satisfies AuthorityV2Env))
      .resolves.toEqual({status:"acknowledged",operationId:regrant.operationId});
    const disabledBinding="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await opsDb.prepare("INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?,?,?,'access|client-three','active',NULL,NULL)")
      .bind(disabledBinding,clientRecordId,"https://access.example.test").run();
    const stale=await enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",bindingOperationId:selectionId,recipientBindingId:disabledBinding,
      clientAuthorityId:selected.clientAuthorityId,workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-three",
      desiredState:"active",expectedOwnershipEpoch:1,expectedGrantRevision:0});
    await opsDb.prepare("UPDATE client_onboarding_recipient_identity_bindings SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE binding_id=?")
      .bind(disabledBinding).run();
    await expect(dispatchNextClientPortalAuthorityV2({OPS_DB:opsDb,CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2:authority} satisfies AuthorityV2Env))
      .resolves.toEqual({status:"retry",operationId:stale.operationId,code:"recipient-stale"});
    expect(await clientDb.prepare("SELECT COUNT(*) AS count FROM portal_operations_principal_grant_heads WHERE subject='access|client-three'")
      .first<number>("count")).toBe(0);
    await expect(enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",bindingOperationId:selectionId,recipientBindingId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clientAuthorityId:selected.clientAuthorityId,workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-one",desiredState:"active",expectedOwnershipEpoch:1,expectedGrantRevision:3})).rejects.toThrow("denied");
    await expect(enqueueClientPortalAuthorityV2(opsDb,actor,{operationId:"44444444-4444-4444-8444-444444444444",bindingOperationId:crypto.randomUUID(),recipientBindingId,clientAuthorityId:selected.clientAuthorityId,
      workspaceId:"workspace-a",issuer:"https://access.example.test",subject:"access|client-two",desiredState:"active",expectedOwnershipEpoch:0,expectedGrantRevision:0})).rejects.toThrow("denied");
  });
});
