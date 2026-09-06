import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import { feedbackFixture, feedbackStaff } from "./helpers/client-feedback-fixture";

const projectRead = vi.hoisted(()=>({ changed:false }));
vi.mock("../src/worker/client-hub-business-project-detail",()=>({
  readClientHubBusinessProjectDetail:vi.fn(async(_env:unknown,_actor:unknown,context:ClientHubCollectionContext,projectId:string,
    options:{expectedContextVersion?:string}={})=>{
    if(options.expectedContextVersion!==undefined&&options.expectedContextVersion!==context.contextVersion)
      throw new HTTPException(409,{message:"Project context changed"});
    if(projectRead.changed)throw new HTTPException(409,{message:"Project ownership changed"});
    if(projectId!==context.root.public_id)throw new HTTPException(404,{message:"Business project not found"});
    return {canonicalRoot:context.canonicalRoot,contextVersion:context.contextVersion,
      project:{id:projectId,status:"active",manager:null,start_date:null,end_date:null}};
  }),
}));
import { listClientHubProjectFeedbackHistory } from "../src/worker/client-hub-project-feedback-history";
import { transitionStaffFeedback } from "../src/worker/client-feedback";

function context(publicId:string,sourceId:ClientHubCollectionContext["root"]["source_id"]="project-alpha:primary"):ClientHubCollectionContext{
  return {root:{source_id:sourceId,root_namespace:"business",kind:"standalone_client",public_id:publicId,
    pa_public_id:null,mapping_status:"missing",display_name:"Client",sort_name:"client",status:"active",portal_status:"not_provisioned",
    workspace_id:null,legacy_account_id:null,account_count:0,project_count:0,request_count:0,contact_count:0,
    meaningful_activity_at:null,source_version:null,indexed_at:"",scan_generation:0},
  canonicalRoot:{sourceId,rootNamespace:"business",kind:"standalone_client",publicId},
  access:{directory:true,requests:true,delivery:true,viewer:false},contextVersion:"a".repeat(43)};
}

describe("Client Hub project feedback history",{timeout:60_000},()=>{
  let fixture:Awaited<ReturnType<typeof feedbackFixture>>;
  beforeAll(async()=>{fixture=await feedbackFixture();},90_000);
  afterAll(async()=>fixture?.runtime.dispose());

  it("pages safe submission lifecycle DTOs 5 then 25 without exposing feedback content",async()=>{
    const owner=await fixture.seed(),records:Awaited<ReturnType<typeof owner.create>>[]=[];
    for(let index=0;index<31;index++)records.push(await owner.create(`Private feedback message ${index}`));
    await transitionStaffFeedback(fixture.env,feedbackStaff,records[0]!.id,{expectedRevision:1,status:"done",note:"Private completion note"},`history-done-${crypto.randomUUID()}`);
    const first=await listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa),owner.pa,{limit:5,expectedContextVersion:"a".repeat(43)});
    expect(first).toMatchObject({coverage:"feedback_only",projectId:owner.pa,page:{available:true,returned:5,limit:5,hasMore:true}});
    const second=await listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa),owner.pa,{limit:25,cursor:first.page.nextCursor!,expectedContextVersion:"a".repeat(43)});
    expect(second.page).toMatchObject({returned:25,limit:25,hasMore:true});
    const third=await listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa),owner.pa,{limit:25,cursor:second.page.nextCursor!,expectedContextVersion:"a".repeat(43)});
    expect(third.page).toMatchObject({returned:1,hasMore:false,nextCursor:null});
    const combined=[...first.items,...second.items,...third.items];
    expect(new Set(combined.map(item=>item.feedbackId)).size).toBe(31);
    expect(combined.find(item=>item.feedbackId===records[0]!.id)?.events.map(event=>event.action)).toEqual(["submitted","completed"]);
    expect(JSON.stringify(combined)).not.toMatch(/Private feedback|Private completion|actor|message|note|sourceOwner|storageKey|identity|fingerprint|guard/i);
    expect(combined.every(item=>item.detailPath===`/clients/feedback/${encodeURIComponent(item.feedbackId)}?status=all`)).toBe(true);
  });

  it("enables secondary history without borrowing primary feedback for colliding raw IDs",async()=>{
    const owner=await fixture.seed(),record=await owner.create();
    const result=await listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa,"project-alpha:secondary"),owner.pa,{limit:5});
    expect(result).toMatchObject({coverage:"feedback_only",items:[],page:{available:true,reason:null,nextCursor:null}});
    expect(JSON.stringify(result)).not.toContain(record.id);
  });

  it("binds continuations to root, project, policy and the exact Delivery mapping",async()=>{
    const owner=await fixture.seed();for(let index=0;index<7;index++)await owner.create(`History ${index}`);
    const first=await listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa),owner.pa,{limit:5});
    await expect(listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context("different-root"),"different-root",{limit:5,cursor:first.page.nextCursor!}))
      .rejects.toMatchObject({status:400});
    await fixture.db.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id=? AND project_id=?").bind(owner.id,owner.id).run();
    await expect(listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa),owner.pa,{limit:5,cursor:first.page.nextCursor!}))
      .rejects.toMatchObject({status:409});
  });

  it("rejects rows when a grant is revoked after the last per-record scope check",async()=>{
    await fixture.seed();
    const owner=await fixture.seed(),record=await owner.create("Must remain private after access changes");
    let scopeReads=0,revoked=false;
    const wrapStatement=(statement:D1PreparedStatement,afterFirst?:()=>Promise<void>):D1PreparedStatement=>({
      bind(...values:unknown[]){return wrapStatement(statement.bind(...values),afterFirst);},
      async first(columnName?:string){
        const result=columnName===undefined?await statement.first():await statement.first(columnName);
        if(afterFirst)await afterFirst();
        return result;
      },
      all:statement.all.bind(statement),
    }) as unknown as D1PreparedStatement;
    const racingOps={withSession:()=>{
      const session=fixture.ops.withSession("first-primary");
      return {prepare:(sql:string)=>wrapStatement(session.prepare(sql),sql.includes("FROM pa_projects p JOIN divisions d")?async()=>{
        scopeReads+=1;
        if(scopeReads===2){
          revoked=true;
          await fixture.ops.prepare(`DELETE FROM staff_permission_overrides
            WHERE staff_id=? AND permission_key='operations.manage' AND scope='division' AND division_id=?`)
            .bind(feedbackStaff.id,owner.division).run();
        }
      }:undefined)};
    }} as unknown as D1Database;
    await expect(listClientHubProjectFeedbackHistory({...fixture.env,OPS_DB:racingOps},feedbackStaff,
      context(owner.pa),owner.pa,{limit:5})).rejects.toMatchObject({status:409});
    expect({scopeReads,revoked}).toEqual({scopeReads:2,revoked:true});
    expect(await fixture.db.prepare("SELECT id FROM client_feedback WHERE id=?").bind(record.id).first("id")).toBe(record.id);
  });

  it("uses the source-qualified project index with a stable row watermark and invalidates project changes",async()=>{
    const owner=await fixture.seed();await owner.create();
    const plan=await fixture.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid watermark,id,created_at FROM client_feedback INDEXED BY idx_client_feedback_project
      WHERE account_id=? AND project_id=? AND rowid<=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 51`)
      .bind(owner.id,owner.id,Number.MAX_SAFE_INTEGER,new Date().toISOString()).all<{detail:string}>();
    expect(plan.results.some(row=>row.detail.includes("idx_client_feedback_project")&&row.detail.includes("account_id=?")&&row.detail.includes("project_id=?"))).toBe(true);
    projectRead.changed=true;
    await expect(listClientHubProjectFeedbackHistory(fixture.env,feedbackStaff,context(owner.pa),owner.pa,{limit:5})).rejects.toMatchObject({status:409});
    projectRead.changed=false;
  });
});
