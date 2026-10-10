import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";
import {reviewedOperationsMigrationNames} from "./helpers/reviewed-operations-migration-chain";
import {selectPortalWorkspaceBinding} from "../src/worker/client-portal-workspace-binding-selection";
import {dispatchNextPortalWorkspaceBinding,enqueuePortalWorkspaceBinding,
  type WorkspaceBindingCommand,type WorkspaceBindingEnv} from "../src/worker/client-portal-workspace-binding-outbox";
import type {AuthenticatedNativeStaffWithAdmissionVersion} from "../src/worker/native-staff-auth";

describe("inactive Ops portal workspace binding selection",()=>{
  let mf:Miniflare,db:D1Database;
  const recordId="11111111-1111-4111-8111-111111111111";
  const activationA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const activationB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const rootA="a".repeat(32),rootB="b".repeat(32);
  const actor:AuthenticatedNativeStaffWithAdmissionVersion={identity:{kind:"native",
    staffId:"owner",verifiedAccessSubject:"access|owner",email:"owner@example.test",
    displayName:"Owner",profileVersion:3},admissionVersion:2,
    verifiedUntil:new Date(Date.now()+30*60_000).toISOString()};
  const command=(overrides:Record<string,unknown>={})=>({
    selectionId:"22222222-2222-4222-8222-222222222222",recordId,activationId:activationA,
    workspaceId:"workspace-a",sourceWorkspaceId:"pa-workspace-a",
    checkpoint:{sourceGeneration:"generation-7",sourceSequence:7,snapshotGenerationId:"snapshot-7"},
    ...overrides});
  const insert=(overrides:Record<string,string|number|undefined>={})=>{
    const value={selectionId:"22222222-2222-4222-8222-222222222222",
      authorityId:"33333333-3333-4333-8333-333333333333",activationId:activationA,
      sourceId:"project-alpha:primary",sourceInstanceId:"source-instance-a",applicationId:"application-a",
      historyEpochId:"epoch-a",rootPublicId:rootA,workspaceId:"workspace-a",sourceWorkspaceId:"pa-workspace-a",
      recordVersion:4,staffId:"owner",subject:"access|owner",admissionVersion:2,profileVersion:3,grantGeneration:5,
      ...overrides};
    return db.prepare(`INSERT INTO client_portal_workspace_binding_selections
      (selection_id,request_sha256,client_authority_id,record_id,activation_id,record_version,source_id,
        source_instance_id,application_id,history_epoch_id,root_type,root_public_id,workspace_id,source_workspace_id,
        checkpoint_source_generation,checkpoint_source_sequence,checkpoint_snapshot_generation_id,
        reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,reviewed_profile_version,
        reviewed_grant_generation,verified_until)
      VALUES(?,'${"a".repeat(64)}',?,?,?, ?,?,?,?,?,'organization',?,?,?,
        'generation-7',7,'snapshot-7',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'))`)
      .bind(value.selectionId,value.authorityId,recordId,value.activationId,value.recordVersion,value.sourceId,
        value.sourceInstanceId,value.applicationId,value.historyEpochId,value.rootPublicId,value.workspaceId,
        value.sourceWorkspaceId,value.staffId,value.subject,value.admissionVersion,value.profileVersion,value.grantGeneration);
  };
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{OPERATIONS_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("OPERATIONS_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      db.prepare(`CREATE TABLE project_alpha_existing_directory_binding_activation_receipts
        (activation_id TEXT PRIMARY KEY,record_id TEXT,source_id TEXT,source_instance_id TEXT,
          application_id TEXT,history_epoch_id TEXT,project_alpha_public_id TEXT,resource_type TEXT,local_record_version INTEGER)`),
      db.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER)"),
      db.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER)"),
      db.prepare("CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER)"),
      db.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)"),
      db.prepare(`CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,
        scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)`),
      db.prepare("CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)"),
      db.prepare("CREATE TABLE existing_public_links(id TEXT PRIMARY KEY,token TEXT)"),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',4)").bind(recordId),
      db.prepare("INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES(? ,?,'project-alpha:primary','source-instance-a','application-a','epoch-a',?,'organization',4)").bind(activationA,recordId,rootA),
      db.prepare("INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES(? ,?,'project-alpha:secondary','source-instance-b','application-b','epoch-b',?,'organization',4)").bind(activationB,recordId,rootB),
      db.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      db.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      db.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
      db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)"),
      db.prepare("INSERT INTO existing_public_links VALUES('legacy','unchanged')"),
    ]);
    const sql=readFileSync(new URL("../migrations/0143_client_portal_workspace_binding_selection.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
    const outboxSql=readFileSync(new URL("../migrations/0144_client_portal_workspace_binding_outbox.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(outboxSql).map(statement=>db.prepare(statement)));
  });
  afterEach(async()=>mf.dispose());

  it("records only an immutable inactive reviewed selection",async()=>{
    await insert().run();
    expect(await db.prepare("SELECT state FROM client_portal_workspace_binding_selections").first("state")).toBe("inactive");
    expect(await db.prepare("SELECT token FROM existing_public_links").first("token")).toBe("unchanged");
    await expect(db.prepare("DELETE FROM client_portal_workspace_binding_selections").run()).rejects.toThrow("durable");
    await expect(db.prepare("UPDATE client_portal_workspace_binding_selections SET workspace_id='other'").run()).rejects.toThrow("immutable");
  });

  it("rejects a changed PA root, source, record version, or reviewer fence",async()=>{
    for(const changed of [{rootPublicId:rootB},{sourceId:"project-alpha:secondary"},{recordVersion:3},
      {subject:"access|other"},{grantGeneration:4}])
      await expect(insert(changed).run()).rejects.toThrow("exact current mapping and owner authority");
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections").first("count")).toBe(0);
    await expect(insert({authorityId:recordId}).run()).rejects.toThrow("CHECK");
  });

  it("rejects revoked owner authority and an effective resource deny",async()=>{
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='owner'").run();
    await expect(insert().run()).rejects.toThrow("exact current mapping and owner authority");
    await db.prepare("UPDATE native_staff_admissions SET active=1 WHERE staff_id='owner'").run();
    await db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','deny',1,'resource',?,NULL,NULL)")
      .bind(recordId).run();
    await expect(insert().run()).rejects.toThrow("exact current mapping and owner authority");
  });

  it("allows distinct LTDS/LTT handles for one Ops customer but rejects duplicate handles",async()=>{
    await insert().run();
    await insert({selectionId:"44444444-4444-4444-8444-444444444444",
      authorityId:"55555555-5555-4555-8555-555555555555",activationId:activationB,
      sourceId:"project-alpha:secondary",sourceInstanceId:"source-instance-b",applicationId:"application-b",
      historyEpochId:"epoch-b",rootPublicId:rootB,workspaceId:"workspace-b",sourceWorkspaceId:"pa-workspace-b"}).run();
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections WHERE record_id=?")
      .bind(recordId).first("count")).toBe(2);
    await expect(insert({selectionId:"66666666-6666-4666-8666-666666666666",
      activationId:activationB,sourceId:"project-alpha:secondary",sourceInstanceId:"source-instance-b",
      applicationId:"application-b",historyEpochId:"epoch-b",rootPublicId:rootB,workspaceId:"workspace-c"}).run())
      .rejects.toThrow("UNIQUE");
  });

  it("permits append-only re-review after a checkpoint changes without changing public links",async()=>{
    await insert().run();
    await insert({selectionId:"77777777-7777-4777-8777-777777777777",
      authorityId:"88888888-8888-4888-8888-888888888888"}).run();
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections")
      .first("count")).toBe(2);
    expect(await db.prepare("SELECT token FROM existing_public_links").first("token")).toBe("unchanged");
  });

  it("produces a private inactive selection and exact replay with the same handle",async()=>{
    const first=await selectPortalWorkspaceBinding(db,actor,command());
    expect(first).toMatchObject({recordId,activationId:activationA,workspaceId:"workspace-a",
      sourceId:"project-alpha:primary",rootType:"organization",rootPublicId:rootA,
      state:"inactive",replayed:false});
    expect(first.clientAuthorityId).not.toBe(recordId);
    expect(await selectPortalWorkspaceBinding(db,actor,command())).toEqual({...first,replayed:true});
    expect(await db.prepare("SELECT token FROM existing_public_links").first("token")).toBe("unchanged");
  });

  it("can re-review a changed checkpoint without reusing the stale authority handle",async()=>{
    const first=await selectPortalWorkspaceBinding(db,actor,command());
    const second=await selectPortalWorkspaceBinding(db,actor,command({
      selectionId:"77777777-7777-4777-8777-777777777777",
      checkpoint:{sourceGeneration:"generation-8",sourceSequence:8,snapshotGenerationId:"snapshot-8"},
    }));
    expect(second.clientAuthorityId).not.toBe(first.clientAuthorityId);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.checkpoint.sourceSequence).toBe(8);
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections")
      .first("count")).toBe(2);
  });

  it("rejects a reused selection ID with different scope or reviewer",async()=>{
    await selectPortalWorkspaceBinding(db,actor,command());
    await expect(selectPortalWorkspaceBinding(db,actor,command({workspaceId:"other"})))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
    await expect(selectPortalWorkspaceBinding(db,{...actor,identity:{...actor.identity,
      verifiedAccessSubject:"access|other"}},command()))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
  });

  it("rejects stale record versions, revoked grants, and expired authentication",async()=>{
    await db.prepare("UPDATE operations_directory_records SET current_version=5 WHERE record_id=?")
      .bind(recordId).run();
    await expect(selectPortalWorkspaceBinding(db,actor,command()))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
    await db.prepare("UPDATE operations_directory_records SET current_version=4 WHERE record_id=?")
      .bind(recordId).run();
    await db.prepare("UPDATE native_directory_grants SET active=0").run();
    await expect(selectPortalWorkspaceBinding(db,actor,command()))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
    await db.prepare("UPDATE native_directory_grants SET active=1").run();
    await expect(selectPortalWorkspaceBinding(db,{...actor,verifiedUntil:new Date(Date.now()-1000).toISOString()},command()))
      .rejects.toThrow("portal_workspace_binding_selection_denied");
  });

  it("enqueues one frozen inactive command and acknowledges only an exact Client tuple",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    const first=await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
    expect(first).toEqual({operationId:selected.selectionId,state:"pending",replayed:false});
    expect(await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId))
      .toEqual({...first,replayed:true});
    const binding={bindWorkspace:async(input:WorkspaceBindingCommand)=>({ok:true,protocolVersion:1,
      status:"recorded",operationId:input.operationId,clientAuthorityId:input.clientAuthorityId,
      workspaceId:input.workspaceId,projectionSourceId:input.projectionSourceId,
      sourceWorkspaceId:input.sourceWorkspaceId,rootType:input.rootType,rootPublicId:input.rootPublicId,
      checkpoint:input.expectedCheckpoint,state:"inactive",revision:1})};
    const env={OPS_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:binding} satisfies WorkspaceBindingEnv;
    expect(await dispatchNextPortalWorkspaceBinding(env)).toEqual({status:"acknowledged",operationId:selected.selectionId});
    expect(await db.prepare("SELECT state FROM client_portal_workspace_binding_outbox WHERE operation_id=?")
      .bind(selected.selectionId).first("state")).toBe("acknowledged");
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_outbox_receipts")
      .first("count")).toBe(1);
    expect(await db.prepare("SELECT token FROM existing_public_links").first("token")).toBe("unchanged");
    await expect(db.prepare("UPDATE client_portal_workspace_binding_outbox SET state='rejected', acknowledged_claim_token=NULL WHERE operation_id=?")
      .bind(selected.selectionId).run()).rejects.toThrow("transition denied");
  });

  it("keeps an ambiguously delivered command occupied and retries its original operation",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
    const second=await selectPortalWorkspaceBinding(db,actor,command({
      selectionId:"77777777-7777-4777-8777-777777777777",
      checkpoint:{sourceGeneration:"generation-8",sourceSequence:8,snapshotGenerationId:"snapshot-8"},
    }));
    await expect(enqueuePortalWorkspaceBinding(db,actor,second.selectionId)).rejects.toThrow("denied");
    const sent:string[]=[];
    const env={OPS_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:{bindWorkspace:async(input:WorkspaceBindingCommand)=>{
        sent.push(input.operationId); throw Error("reply lost after Client commit");
      }}} satisfies WorkspaceBindingEnv;
    expect(await dispatchNextPortalWorkspaceBinding(env)).toMatchObject({status:"retry",operationId:selected.selectionId});
    expect(await db.prepare("SELECT state FROM client_portal_workspace_binding_outbox WHERE operation_id=?")
      .bind(selected.selectionId).first("state")).toBe("retry");
    await db.prepare("UPDATE client_portal_workspace_binding_outbox SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') WHERE operation_id=?")
      .bind(selected.selectionId).run();
    expect(await dispatchNextPortalWorkspaceBinding(env)).toMatchObject({status:"retry",operationId:selected.selectionId});
    expect(sent).toEqual([selected.selectionId,selected.selectionId]);
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_outbox WHERE workspace_id='workspace-a'")
      .first("count")).toBe(1);
  });

  it("recovers an exact Client receipt after a null binding response",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
    let statusCalls=0;
    const env={OPS_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:{
        bindWorkspace:async()=>null,
        getBindingStatus:async(input:{protocolVersion:1;operationId:string})=>{
          statusCalls++;
          return {ok:true,protocolVersion:1,status:"recorded",operationId:input.operationId,
            clientAuthorityId:selected.clientAuthorityId,workspaceId:selected.workspaceId,
            projectionSourceId:selected.sourceId,sourceWorkspaceId:selected.sourceWorkspaceId,
            rootType:selected.rootType,rootPublicId:selected.rootPublicId,
            checkpoint:selected.checkpoint,state:"inactive",revision:1};
        },
      }} satisfies WorkspaceBindingEnv;
    expect(await dispatchNextPortalWorkspaceBinding(env)).toEqual({status:"acknowledged",operationId:selected.selectionId});
    expect(statusCalls).toBe(1);
    expect(await db.prepare("SELECT replayed FROM client_portal_workspace_binding_outbox_receipts WHERE operation_id=?")
      .bind(selected.selectionId).first("replayed")).toBe(1);
  });

  it.each(["missing","malformed","mismatched","unavailable"] as const)(
    "retries when lost-response status is %s",async(kind)=>{
      const selected=await selectPortalWorkspaceBinding(db,actor,command());
      await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
      const env={OPS_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
        CLIENT_AUTHORITY_WORKSPACE_BINDING:{
          bindWorkspace:async()=>{throw Error("response lost");},
          getBindingStatus:async(input:{protocolVersion:1;operationId:string})=>{
            if(kind==="unavailable")throw Error("status unavailable");
            if(kind==="missing")return {ok:false,protocolVersion:1,code:"not_found",retryable:false};
            if(kind==="malformed")return {ok:true,protocolVersion:1,status:"recorded",operationId:input.operationId};
            return {ok:true,protocolVersion:1,status:"recorded",operationId:input.operationId,
              clientAuthorityId:selected.clientAuthorityId,workspaceId:"wrong-workspace",
              projectionSourceId:"project-alpha:primary",sourceWorkspaceId:"pa-workspace-a",
              rootType:"organization",rootPublicId:rootA,checkpoint:selected.checkpoint,state:"inactive",revision:1};
          },
        }} satisfies WorkspaceBindingEnv;
      expect(await dispatchNextPortalWorkspaceBinding(env)).toEqual({status:"retry",operationId:selected.selectionId,
        code:"transport-or-ambiguous"});
      expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_outbox_receipts").first("count")).toBe(0);
    });

  it("does not acknowledge recovered status after the dispatch lease is lost",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
    let sent:WorkspaceBindingCommand|undefined;
    const env={OPS_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:{bindWorkspace:async(input:WorkspaceBindingCommand)=>{sent=input;throw Error("response lost");},
        getBindingStatus:async()=>{
          // Simulate wall-clock lease expiry without making the test sleep for two minutes.
          await db.prepare("DROP TRIGGER client_portal_workspace_binding_outbox_control_guard").run();
          await db.prepare(`UPDATE client_portal_workspace_binding_outbox
            SET claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE operation_id=?`)
            .bind(selected.selectionId).run();
          if(!sent)throw Error("command not sent");
          return {ok:true,protocolVersion:1,status:"recorded",operationId:sent.operationId,
            clientAuthorityId:sent.clientAuthorityId,workspaceId:sent.workspaceId,
            projectionSourceId:sent.projectionSourceId,sourceWorkspaceId:sent.sourceWorkspaceId,
            rootType:sent.rootType,rootPublicId:sent.rootPublicId,checkpoint:sent.expectedCheckpoint,
            state:"inactive",revision:1};
        }}} satisfies WorkspaceBindingEnv;
    expect(await dispatchNextPortalWorkspaceBinding(env)).toEqual({status:"retry",operationId:selected.selectionId,
      code:"lease-lost"});
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_outbox_receipts").first("count")).toBe(0);
  });

  it("dispatches only the explicitly requested operation",async()=>{
    const first=await selectPortalWorkspaceBinding(db,actor,command());
    const second=await selectPortalWorkspaceBinding(db,actor,command({
      selectionId:"77777777-7777-4777-8777-777777777777",workspaceId:"workspace-b",
      sourceWorkspaceId:"source-workspace-b",
    }));
    await enqueuePortalWorkspaceBinding(db,actor,first.selectionId);
    await enqueuePortalWorkspaceBinding(db,actor,second.selectionId);
    const sent:string[]=[];
    const env={OPS_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true",
      CLIENT_AUTHORITY_WORKSPACE_BINDING:{bindWorkspace:async(input:WorkspaceBindingCommand)=>{
        sent.push(input.operationId);return {ok:true,protocolVersion:1,status:"recorded",
          operationId:input.operationId,clientAuthorityId:input.clientAuthorityId,workspaceId:input.workspaceId,
          projectionSourceId:input.projectionSourceId,sourceWorkspaceId:input.sourceWorkspaceId,
          rootType:input.rootType,rootPublicId:input.rootPublicId,checkpoint:input.expectedCheckpoint,
          state:"inactive",revision:1};
      }}} satisfies WorkspaceBindingEnv;
    expect(await dispatchNextPortalWorkspaceBinding(env,second.selectionId))
      .toEqual({status:"acknowledged",operationId:second.selectionId});
    expect(sent).toEqual([second.selectionId]);
    expect(await db.prepare("SELECT state FROM client_portal_workspace_binding_outbox WHERE operation_id=?")
      .bind(first.selectionId).first("state")).toBe("pending");
  });

  it("denies stale owner or record changes at enqueue",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='owner'").run();
    await expect(enqueuePortalWorkspaceBinding(db,actor,selected.selectionId)).rejects.toThrow("denied");
    await db.prepare("UPDATE native_staff_admissions SET active=1 WHERE staff_id='owner'").run();
    await db.prepare("UPDATE operations_directory_records SET current_version=5 WHERE record_id=?").bind(recordId).run();
    await expect(enqueuePortalWorkspaceBinding(db,actor,selected.selectionId)).rejects.toThrow("denied");
  });

  it("does not expose prior outbox state after the reviewed owner's live authority is revoked",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='owner'").run();
    await expect(enqueuePortalWorkspaceBinding(db,actor,selected.selectionId)).rejects.toThrow("denied");
    await db.prepare("UPDATE native_staff_admissions SET active=1 WHERE staff_id='owner'").run();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE staff_id='owner'").run();
    await expect(enqueuePortalWorkspaceBinding(db,actor,selected.selectionId)).rejects.toThrow("denied");
  });

  it("does not expose prior outbox state after the frozen activation or record version becomes stale",async()=>{
    const selected=await selectPortalWorkspaceBinding(db,actor,command());
    await enqueuePortalWorkspaceBinding(db,actor,selected.selectionId);
    await db.prepare("UPDATE operations_directory_records SET current_version=5 WHERE record_id=?").bind(recordId).run();
    await expect(enqueuePortalWorkspaceBinding(db,actor,selected.selectionId)).rejects.toThrow("denied");
    await db.prepare("UPDATE operations_directory_records SET current_version=4 WHERE record_id=?").bind(recordId).run();
    await db.prepare("UPDATE project_alpha_existing_directory_binding_activation_receipts SET history_epoch_id='epoch-other' WHERE activation_id=?")
      .bind(activationA).run();
    await expect(enqueuePortalWorkspaceBinding(db,actor,selected.selectionId)).rejects.toThrow("denied");
  });
});

describe("portal workspace selection full migration order",()=>{
  it("applies every Ops migration without granting portal access",async()=>{
    const runtime=new Miniflare({compatibilityDate:"2026-07-16",modules:true,
      script:"export default {}",d1Databases:{OPS_DB:crypto.randomUUID()}});
    try {
      const database=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
      const directory=new URL("../migrations/",import.meta.url);
      const names=reviewedOperationsMigrationNames(directory);
      expect(names).toHaveLength(184);
      expect(names.at(-1)).toBe("0184_project_alpha_directory_relationship_generation_recovery.sql");
      for(const name of names){
        const statements=splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8"));
        await database.batch(statements.map(statement=>database.prepare(statement)));
      }
      expect(await database.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections")
        .first("count")).toBe(0);
      for (const table of ["operations_portal_workspace_reservation_commands",
        "operations_portal_workspace_reservation_heads", "operations_portal_folder_reservation_heads"]) {
        expect(await database.prepare(`SELECT count(*) count FROM ${table}`).first("count")).toBe(0);
      }
      expect(await database.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='client_portal_workspace_binding_selections'")
        .first("count")).toBe(1);
      expect(await database.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='client_portal_workspace_binding_outbox'")
        .first("count")).toBe(1);
    } finally { await runtime.dispose(); }
  // This bounded full-chain rehearsal applies 168 reviewed release migrations individually;
  // keep ordinary authorization unit tests at their existing timeout.
  },120_000);
});
