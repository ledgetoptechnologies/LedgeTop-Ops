import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { createFeedbackRecord, type FeedbackWriteAuthorization } from "../../../client/src/worker/client-portal/feedback-store";
import type { Env, StaffPrincipal } from "../../src/worker/types";

export const feedbackStaff: StaffPrincipal = { id:"feedback-staff",email:"staff@example.test",displayName:"Staff",accessSubject:"staff-subject",projectAlphaUserId:"staff-pa" };
export async function feedbackFixture() {
  const runtime = new Miniflare({ compatibilityDate:"2026-07-22",modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:crypto.randomUUID(),OPS:crypto.randomUUID()} });
  const db = await runtime.getD1Database("DB") as unknown as D1Database, ops = await runtime.getD1Database("OPS") as unknown as D1Database;
  const directory = new URL("../../../client/migrations/",import.meta.url);
  for (const file of readdirSync(directory).filter(name=>name.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file,directory),"utf8").replace(/\r\n/g,"\n").replace(/^\s*--.*$/gm,"");
    if (/CREATE\s+TRIGGER\b/i.test(sql)) await db.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i,"").replace(/\s*\n\s*/g," "));
    else { const statements=sql.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(s=>s&&!/^PRAGMA/i.test(s)); if(statements.length)await db.batch(statements.map(s=>db.prepare(s))); }
  }
  await ops.exec(`CREATE TABLE pa_projects(id TEXT PRIMARY KEY,client_id TEXT,organization_id TEXT,active INTEGER,business_unit_id TEXT,manager_user_id TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,organization_id TEXT,active INTEGER);
    CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,active INTEGER);
    CREATE TABLE divisions(id TEXT PRIMARY KEY,project_alpha_business_unit_id TEXT UNIQUE,active INTEGER);
    CREATE TABLE project_folders(id TEXT PRIMARY KEY,project_id TEXT,division_id TEXT,r2_prefix TEXT UNIQUE);
    CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER);
    CREATE TABLE pa_operations(id TEXT,project_id TEXT,active INTEGER);
    CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER);
    CREATE TABLE pa_tasks(id TEXT,project_id TEXT,active INTEGER);
    CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER);
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);`.replace(/\s*\n\s*/g," "));
  const env = { DELIVERY_DB:db,OPS_DB:ops,OPERATIONS_SESSION_SECRET:"feedback-test-session-secret-0123456789",DELIVERY_BASE_URL:"https://client.example.test",
    PUBLIC_BASE_URL:"https://ops.example.test",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"false" } as Env;
  async function seed(kind:"project"|"file"="project") {
    const id=crypto.randomUUID(),pa=`pa-${id}`,identity=`identity-${id}`,division=`division-${id}`,prefix=`Clients/${id}/`;
    await db.batch([
      db.prepare("INSERT INTO client_accounts(project_alpha_source_id,id,display_name,status,project_alpha_client_id) VALUES ('project-alpha:primary',?,?,'active',?)").bind(id,`Client ${id}`,pa),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES (?,?,'https://issuer.test',?,?)").bind(identity,id,identity,`${id}@example.test`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES (?,?,'manager')").bind(id,identity),
      db.prepare("INSERT INTO projects(project_alpha_source_id,id,project_alpha_project_id,client_name,project_name,r2_prefix) VALUES ('project-alpha:primary',?,?,?,?,?)").bind(id,pa,"Client","North site",prefix),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES (?,?,1)").bind(id,id),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,division_id,created_by) VALUES (?,'client',?,?,?,?,'staff')").bind(id,id,prefix,id,division),
    ]);
    await ops.batch([
      ops.prepare("INSERT INTO pa_projects(id,client_id,organization_id,active,business_unit_id,manager_user_id) VALUES(?,?,NULL,1,?,'staff-pa')").bind(pa,pa,division),
      ops.prepare("INSERT INTO pa_clients VALUES(?,NULL,1)").bind(pa),
      ops.prepare("INSERT INTO divisions VALUES(?,?,1)").bind(division,division),
      ops.prepare("INSERT INTO project_folders VALUES(?,?,?,?)").bind(id,pa,division,prefix),
      ...["operations.manage","projects.view","delivery.browse"].map(permission=>ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,?,'allow','division',?)").bind(feedbackStaff.id,permission,division)),
    ]);
    const authorization: FeedbackWriteAuthorization = { context:{accountId:id,identityId:identity,workspaceId:null,workspaceIdentityId:null,issuer:"https://issuer.test",subject:identity},
      target:{kind,projectId:kind==="project"?id:null,associationId:kind==="file"?id:null,relativePath:null,storageKey:kind==="file"?`${prefix}photo.jpg`:null,
        label:kind==="project"?"North site":"photo.jpg",projectName:kind==="project"?"North site":null,
        sourceOwner:{account:{projectAlphaClientId:pa,projectAlphaOrganizationId:null},project:kind==="project"?{projectAlphaProjectId:pa,sourceUpdatedAt:null}:null,
          workspace:null,association:kind==="file"?{prefix}:null,file:kind==="file"?{etag:"etag",size:100,uploadedAt:"2026-08-25T00:00:00Z"}:null}},
      guard:{sql:"EXISTS(SELECT 1 FROM client_accounts WHERE id=? AND status='active')",bindings:[id]} };
    const create=async(message="Please fix this private detail.")=>(await createFeedbackRecord(db,authorization,message,`create-${crypto.randomUUID()}`)).record;
    return {id,pa,identity,division,prefix,authorization,create};
  }
  return {runtime,db,ops,env,seed};
}
