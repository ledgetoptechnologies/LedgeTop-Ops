import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";

describe("inactive Ops portal workspace binding selection",()=>{
  let mf:Miniflare,db:D1Database;
  const recordId="11111111-1111-4111-8111-111111111111";
  const rootA="a".repeat(32),rootB="b".repeat(32);
  const insert=(overrides:Record<string,string|number|undefined>={})=>{
    const value={selectionId:"22222222-2222-4222-8222-222222222222",
      authorityId:"33333333-3333-4333-8333-333333333333",activationId:"activation-a",
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
      db.prepare("INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES('activation-a',?,'project-alpha:primary','source-instance-a','application-a','epoch-a',?,'organization',4)").bind(recordId,rootA),
      db.prepare("INSERT INTO project_alpha_existing_directory_binding_activation_receipts VALUES('activation-b',?,'project-alpha:secondary','source-instance-b','application-b','epoch-b',?,'organization',4)").bind(recordId,rootB),
      db.prepare("INSERT INTO native_staff_admissions VALUES('owner','access|owner',1,2)"),
      db.prepare("INSERT INTO native_staff_profiles VALUES('owner',3)"),
      db.prepare("INSERT INTO native_directory_grant_generations VALUES('owner',5)"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
      db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.portal_access.manage','allow',1,'global',NULL,NULL,NULL)"),
      db.prepare("INSERT INTO existing_public_links VALUES('legacy','unchanged')"),
    ]);
    const sql=readFileSync(new URL("../migrations/0143_client_portal_workspace_binding_selection.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
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
      authorityId:"55555555-5555-4555-8555-555555555555",activationId:"activation-b",
      sourceId:"project-alpha:secondary",sourceInstanceId:"source-instance-b",applicationId:"application-b",
      historyEpochId:"epoch-b",rootPublicId:rootB,workspaceId:"workspace-b",sourceWorkspaceId:"pa-workspace-b"}).run();
    expect(await db.prepare("SELECT count(*) count FROM client_portal_workspace_binding_selections WHERE record_id=?")
      .bind(recordId).first("count")).toBe(2);
    await expect(insert({selectionId:"66666666-6666-4666-8666-666666666666",
      activationId:"activation-b",sourceId:"project-alpha:secondary",sourceInstanceId:"source-instance-b",
      applicationId:"application-b",historyEpochId:"epoch-b",rootPublicId:rootB,workspaceId:"workspace-c"}).run())
      .rejects.toThrow("UNIQUE");
  });
});
