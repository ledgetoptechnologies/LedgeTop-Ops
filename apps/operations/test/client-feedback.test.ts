import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getStaffFeedback, listStaffFeedback, registerClientFeedbackRoutes, staffFeedbackEntryEnabled, transitionStaffFeedback } from "../src/worker/client-feedback";
import { requiresAdministratorForMutation } from "../src/worker/r2-crud-validation";
import { feedbackFixture, feedbackStaff } from "./helpers/client-feedback-fixture";
import type { Env, StaffPrincipal } from "../src/worker/types";

describe("staff feedback current-owner authority and transitions",{timeout:30_000},()=>{
  let f:Awaited<ReturnType<typeof feedbackFixture>>;
  beforeAll(async()=>{f=await feedbackFixture();},90_000);
  afterAll(async()=>f?.runtime.dispose());
  const action=(id:string,revision=1,status:"in_progress"|"done"="done",key=`action-${crypto.randomUUID()}`)=>transitionStaffFeedback(f.env,feedbackStaff,id,{expectedRevision:revision,status,note:status==="done"?"Updated the selection.":null},key);
  it("returns only public DTO and lifecycle history",async()=>{
    const owner=await f.seed(),record=await owner.create();
    const page=await listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id});
    expect(page.items).toMatchObject([{id:record.id,status:"new",canStart:true,canComplete:true}]);
    expect(JSON.stringify(page)).not.toMatch(/sourceOwner|storageKey|principalIssuer|identityId|targetFingerprint|pa-/);
    expect((await getStaffFeedback(f.env,feedbackStaff,record.id)).events).toEqual([expect.objectContaining({revision:1,actor:"client",status:"new"})]);
  });
  it("exposes feature readiness without expanding employee permissions or row scope",async()=>{
    const owner=await f.seed(),record=await owner.create();
    expect(await staffFeedbackEntryEnabled(f.env,feedbackStaff)).toBe(true);
    expect(await staffFeedbackEntryEnabled(f.env,{...feedbackStaff,id:"no-management"})).toBe(false);
    await f.ops.prepare("INSERT INTO staff_permission_overrides VALUES('denied-staff','operations.manage','allow','global',NULL)").run();
    await f.ops.prepare("INSERT INTO staff_permission_overrides VALUES('denied-staff','operations.manage','deny','global',NULL)").run();
    expect(await staffFeedbackEntryEnabled(f.env,{...feedbackStaff,id:"denied-staff"})).toBe(false);
    await f.ops.prepare("UPDATE pa_projects SET client_id='not-current-owner' WHERE id=?").bind(owner.pa).run();
    await expect(getStaffFeedback(f.env,feedbackStaff,record.id)).rejects.toMatchObject({status:404});
  });
  it("denies current division override even when a wider allow exists",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'operations.manage','deny','division',?)").bind(feedbackStaff.id,owner.division).run();
    expect((await listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id})).items).toEqual([]);
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("does not turn project view into all-project or assigned-management access",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("UPDATE pa_projects SET manager_user_id='different-user' WHERE id=?").bind(owner.pa).run();
    await expect(getStaffFeedback(f.env,feedbackStaff,record.id)).rejects.toMatchObject({status:404});
    await f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'operations.view_all','allow','global',NULL)").bind(feedbackStaff.id).run();
    await f.ops.prepare("UPDATE staff_permission_overrides SET scope='assigned',division_id=NULL WHERE staff_id=? AND permission_key='operations.manage' AND division_id=?").bind(feedbackStaff.id,owner.division).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
    await f.ops.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='operations.view_all'").run();
  });
  it("honors a division view-all deny for an unassigned all-work candidate",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.batch([
      f.ops.prepare("UPDATE pa_projects SET manager_user_id='different-user' WHERE id=?").bind(owner.pa),
      f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'projects.view','allow','global',NULL)").bind(feedbackStaff.id),
      f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'operations.view_all','allow','global',NULL)").bind(feedbackStaff.id),
      f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'operations.view_all','deny','division',?)").bind(feedbackStaff.id,owner.division),
    ]);
    await expect(getStaffFeedback(f.env,feedbackStaff,record.id)).rejects.toMatchObject({status:404});
    await expect(action(record.id)).rejects.toMatchObject({status:404});
    await f.ops.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='operations.view_all'").run();
  });
  it("keeps actual assigned access when only view-all is denied",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'operations.view_all','deny','global',NULL)").bind(feedbackStaff.id).run();
    expect((await getStaffFeedback(f.env,feedbackStaff,record.id)).feedback.id).toBe(record.id);
    expect((await action(record.id)).feedback.status).toBe("done");
    await f.ops.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='operations.view_all'").run();
  });
  it("does not carry primary staff assignments into a secondary-source feedback target",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("UPDATE pa_projects SET projection_source_id='project-alpha:secondary' WHERE id=?").bind(owner.pa).run();
    expect((await listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id})).items).toEqual([]);
    await expect(getStaffFeedback(f.env,feedbackStaff,record.id)).rejects.toMatchObject({status:404});
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it.each(["account", "project"] as const)("rejects explicit secondary %s ownership even when raw IDs match primary",async kind=>{
    const owner=await f.seed();
    const sourceOwner=owner.authorization.target.sourceOwner;
    sourceOwner.version=2;
    sourceOwner.account.projectAlphaSourceId=kind==="account"?"project-alpha:secondary":"project-alpha:primary";
    sourceOwner.project!.projectAlphaSourceId=kind==="project"?"project-alpha:secondary":"project-alpha:primary";
    const record=await owner.create();
    expect((await listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id})).items).toEqual([]);
    await expect(getStaffFeedback(f.env,feedbackStaff,record.id)).rejects.toMatchObject({status:404});
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("rejects moved source project and local account remapping",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("UPDATE pa_projects SET client_id='different-client' WHERE id=?").bind(owner.pa).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
    await f.ops.prepare("UPDATE pa_projects SET client_id=? WHERE id=?").bind(owner.pa,owner.pa).run();
    await f.db.prepare("UPDATE client_accounts SET project_alpha_client_id='new-client' WHERE id=?").bind(owner.id).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("uses an explicit organization owner even when the project has a primary contact",async()=>{
    const owner=await f.seed(),org=`organization-${owner.id}`;
    await f.ops.prepare("INSERT INTO pa_organizations VALUES(?,1)").bind(org).run();
    await f.ops.prepare("UPDATE pa_projects SET organization_id=? WHERE id=?").bind(org,owner.pa).run();
    await f.db.prepare("UPDATE client_accounts SET project_alpha_client_id=NULL,project_alpha_organization_id=? WHERE id=?").bind(org,owner.id).run();
    owner.authorization.target.sourceOwner.account={projectAlphaClientId:null,projectAlphaOrganizationId:org};
    const record=await owner.create();
    expect((await getStaffFeedback(f.env,feedbackStaff,record.id)).feedback.target.available).toBe(true);
    await f.ops.prepare("UPDATE pa_projects SET organization_id='different-org' WHERE id=?").bind(owner.pa).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("does not infer a project grant owner from the primary contact's organization",async()=>{
    const owner=await f.seed(),org=`organization-${owner.id}`;
    await f.ops.prepare("INSERT INTO pa_organizations VALUES(?,1)").bind(org).run();
    await f.ops.prepare("UPDATE pa_clients SET organization_id=? WHERE id=?").bind(org,owner.pa).run();
    await f.db.prepare("UPDATE client_accounts SET project_alpha_client_id=NULL,project_alpha_organization_id=? WHERE id=?").bind(org,owner.id).run();
    owner.authorization.target.sourceOwner.account={projectAlphaClientId:null,projectAlphaOrganizationId:org};
    const record=await owner.create();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("preserves a client-mapped project grant when the account omits the client's organization",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("UPDATE pa_clients SET organization_id='new-organization' WHERE id=?").bind(owner.pa).run();
    expect((await getStaffFeedback(f.env,feedbackStaff,record.id)).feedback.id).toBe(record.id);
    expect((await action(record.id)).feedback.status).toBe("done");
  });
  it("requires an active source client for a client-only project owner",async()=>{
    const owner=await f.seed(),record=await owner.create();
    await f.ops.prepare("UPDATE pa_clients SET active=0 WHERE id=?").bind(owner.pa).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("uses longest current client-folder ownership, not stored division",async()=>{
    const owner=await f.seed("file"),record=await owner.create();
    expect((await getStaffFeedback(f.env,feedbackStaff,record.id)).feedback.target.label).toBe("photo.jpg");
    await f.ops.prepare("UPDATE project_folders SET division_id='absent-division' WHERE id=?").bind(owner.id).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("can acknowledge missing files or former authors without impersonating them",async()=>{
    const owner=await f.seed("file"),record=await owner.create();
    await f.db.prepare("UPDATE client_identity_links SET revoked_at=datetime('now') WHERE id=?").bind(owner.identity).run();
    expect((await action(record.id)).feedback).toMatchObject({status:"done",target:{available:false,actionPath:null}});
  });
  it("also requires delivery browse for a file inside an otherwise visible project",async()=>{
    const owner=await f.seed("file");
    await f.db.prepare("UPDATE client_folder_associations SET scope_type='project',project_id=? WHERE id=?").bind(owner.id,owner.id).run();
    owner.authorization.target.projectId=owner.id;
    owner.authorization.target.projectName="North site";
    owner.authorization.target.sourceOwner.project={projectAlphaProjectId:owner.pa,sourceUpdatedAt:null};
    const record=await owner.create();
    await f.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'delivery.browse','deny','division',?)").bind(feedbackStaff.id,owner.division).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("creates one completion notice and replays the exact uncertain action",async()=>{
    const owner=await f.seed(),record=await owner.create(),key=`action-${crypto.randomUUID()}`;
    expect(await action(record.id,1,"done",key)).toMatchObject({replayed:false,appliedRevision:2});
    expect(await action(record.id,1,"done",key)).toMatchObject({replayed:true,appliedRevision:2});
    expect(await f.db.prepare("SELECT count(*) n FROM client_feedback_notifications WHERE feedback_id=?").bind(record.id).first("n")).toBe(1);
    await expect(action(record.id,1,"in_progress",key)).rejects.toMatchObject({status:409});
  });
  it("supports New to In Progress to Done, but never reopening or stale revision",async()=>{
    const owner=await f.seed(),record=await owner.create();
    expect((await action(record.id,1,"in_progress")).feedback.status).toBe("in_progress");
    await expect(action(record.id)).rejects.toMatchObject({status:409});
    expect((await action(record.id,2)).events.map(event=>event.status)).toEqual(["new","in_progress","done"]);
    await expect(action(record.id,2,"in_progress")).rejects.toMatchObject({status:409});
  });
  it("searches literal public fields and binds cursor to account, query and policy",async()=>{
    const owner=await f.seed();
    for(let i=0;i<27;i++)await owner.create(`Feedback ${i} 100%_literal`);
    const first=await listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id,q:"100%_literal"});
    expect(first.items).toHaveLength(25); expect(first.nextCursor).toBeTruthy();
    const next=await listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id,q:"100%_literal",cursor:first.nextCursor!});
    expect(next.items).toHaveLength(2);expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items,...next.items].map(row=>row.id)).size).toBe(27);
    await expect(listStaffFeedback(f.env,feedbackStaff,{accountId:owner.id,q:"other",cursor:first.nextCursor!})).rejects.toMatchObject({status:409});
    await expect(listStaffFeedback(f.env,{...feedbackStaff,id:"other"},{accountId:owner.id,cursor:first.nextCursor!})).rejects.toMatchObject({status:403});
    await expect(listStaffFeedback(f.env,feedbackStaff,{cursor:"invalid"})).rejects.toMatchObject({status:400});
  });
  it("does not replay through revoked scope",async()=>{
    const owner=await f.seed(),record=await owner.create(),key=`action-${crypto.randomUUID()}`;
    await action(record.id,1,"done",key);
    await f.db.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id=?").bind(owner.id).run();
    await expect(action(record.id,1,"done",key)).rejects.toMatchObject({status:404});
  });
  it("accepts exact eligibility-bridge workspace provenance without a workspace legacy_account_id",async()=>{
    const owner=await f.seed(),workspace=`workspace-${owner.id}`,native=`native-${owner.id}`;
    await f.db.batch([
      f.db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES (?,'https://issuer.test',?,'author@example.test')").bind(native,owner.identity),
      f.db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,display_name) VALUES (?,'standalone_client',?,'Workspace')").bind(workspace,owner.pa),
      f.db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type) VALUES (?,?,?,'project_alpha')").bind(crypto.randomUUID(),workspace,native),
      f.db.prepare("INSERT INTO portal_v2_identity_eligibility_legacy_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id) VALUES (?,?,?,?)").bind(workspace,native,owner.id,owner.identity),
    ]);
    owner.authorization.context.workspaceId=workspace;owner.authorization.context.workspaceIdentityId=native;
    owner.authorization.target.sourceOwner.workspace={rootType:"standalone_client",rootPublicId:owner.pa,generationId:"generation",sourceSequence:1};
    const record=await owner.create();
    expect((await getStaffFeedback(f.env,feedbackStaff,record.id)).feedback.id).toBe(record.id);
    await f.db.prepare("UPDATE portal_v2_workspaces SET pa_client_public_id='different-source-root' WHERE id=?").bind(workspace).run();
    await expect(action(record.id)).rejects.toMatchObject({status:404});
  });
  it("limits mutation exception to exactly POST status and bounds JSON",async()=>{
    expect(requiresAdministratorForMutation("POST","/api/operations/feedback/opaque/status")).toBe(false);
    for(const path of ["/api/operations/feedback","/api/operations/feedback/opaque/delete","/api/operations/feedback/opaque/status/extra"])
      expect(requiresAdministratorForMutation("POST",path)).toBe(true);
    expect(requiresAdministratorForMutation("DELETE","/api/operations/feedback/opaque/status")).toBe(true);
    const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
    app.use("*",async(c,next)=>{c.set("principal",feedbackStaff);c.set("administrator",false);await next();});
    app.onError((error,c)=>c.json({error:error.message},error instanceof HTTPException?error.status:500));
    registerClientFeedbackRoutes(app);
    const response=await app.request("https://ops.example.test/api/operations/feedback/opaque/status",{method:"POST",headers:{"Content-Type":"application/json"},body:"x".repeat(17_000)},f.env);
    expect(response.status).toBe(413);
  });
});
