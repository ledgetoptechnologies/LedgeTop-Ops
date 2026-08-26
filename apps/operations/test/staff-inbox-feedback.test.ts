import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listStaffFeedback, transitionStaffFeedback } from "../src/worker/client-feedback";
import { feedbackFixture, feedbackStaff } from "./helpers/client-feedback-fixture";

describe("staff feedback open read filter",{timeout:60_000},()=>{
  let fixture:Awaited<ReturnType<typeof feedbackFixture>>;
  beforeAll(async()=>{fixture=await feedbackFixture();},120_000);
  afterAll(async()=>{await fixture?.runtime.dispose();});
  async function seedReadQueue(newCount:number,progressCount:number){
    const owner=await fixture.seed(),base=await owner.create("Open filter 100%_literal");
    const newIds=[base.id],progressIds:string[]=[],doneId=crypto.randomUUID();
    const copies:{id:string;status:"new"|"in_progress"|"done"}[]=[];
    for(let index=1;index<newCount;index++){
      const id=crypto.randomUUID();newIds.push(id);copies.push({id,status:"new"});
    }
    for(let index=0;index<progressCount;index++){
      const id=crypto.randomUUID();progressIds.push(id);copies.push({id,status:"in_progress"});
    }
    copies.push({id:doneId,status:"done"});
    // This is a read-filter fixture, not a creation/lifecycle test. Copy one
    // authoritative submission's exact scope, target, message and fingerprints;
    // only IDs/keys and schema-valid lifecycle fields differ. The existing
    // client-feedback suites cover mutation receipts, events and notifications.
    const seeded=await fixture.db.batch(copies.map(row=>fixture.db.prepare(`INSERT INTO client_feedback
      (id,account_id,scope_key,workspace_id,creator_identity_id,creator_workspace_identity_id,
       principal_issuer,principal_subject,target_kind,project_id,target_json,target_fingerprint,message,
       status,revision,completion_note,completed_at,completed_by_staff_id,mutation_key,request_fingerprint,created_at,updated_at)
      SELECT ?,account_id,scope_key,workspace_id,creator_identity_id,creator_workspace_identity_id,
       principal_issuer,principal_subject,target_kind,project_id,target_json,target_fingerprint,message,
       ?,?,NULL,?,?,?,request_fingerprint,created_at,updated_at FROM client_feedback WHERE id=?`)
      .bind(row.id,row.status,row.status==="new"?1:2,
        row.status==="done"?base.createdAt:null,row.status==="done"?feedbackStaff.id:null,
        "read-fixture-"+row.id,base.id)));
    expect(seeded.every(result=>Number(result.meta.changes)===1)).toBe(true);
    return {owner,newIds,progressIds,doneId};
  }
  it("pages more than 25 combined new/in-progress records while excluding done and binding the cursor",async()=>{
    const {owner,newIds,progressIds}=await seedReadQueue(25,2);
    const query={accountId:owner.id,status:"open",q:"100%_literal"};
    const first=await listStaffFeedback(fixture.env,feedbackStaff,query);
    expect(first.items).toHaveLength(25);expect(first.nextCursor).toBeTruthy();
    const next=await listStaffFeedback(fixture.env,feedbackStaff,{...query,cursor:first.nextCursor!});
    expect(next.items).toHaveLength(2);expect(next.nextCursor).toBeNull();
    expect([...first.items,...next.items].map(row=>row.id).sort()).toEqual([...newIds,...progressIds].sort());
    expect([...first.items,...next.items].every(row=>row.status==="new"||row.status==="in_progress")).toBe(true);
    await expect(listStaffFeedback(fixture.env,feedbackStaff,{...query,status:"new",cursor:first.nextCursor!})).rejects.toMatchObject({status:409});
    expect(await listStaffFeedback(fixture.env,feedbackStaff,{...query,cursor:first.nextCursor!})).toEqual(next);
  });
  it("preserves default and explicit status filters plus literal search on an independent bounded queue",async()=>{
    const {owner,newIds,progressIds,doneId}=await seedReadQueue(1,1);
    const query={accountId:owner.id,status:"open",q:"100%_literal"};
    expect((await listStaffFeedback(fixture.env,feedbackStaff,{accountId:owner.id})).items.map(row=>row.id).sort()).toEqual(newIds.sort());
    expect((await listStaffFeedback(fixture.env,feedbackStaff,{accountId:owner.id,status:"in_progress"})).items.map(row=>row.id).sort()).toEqual(progressIds.sort());
    expect((await listStaffFeedback(fixture.env,feedbackStaff,{accountId:owner.id,status:"done"})).items.map(row=>row.id)).toEqual([doneId]);
    expect((await listStaffFeedback(fixture.env,feedbackStaff,{accountId:owner.id,status:"all"})).items.map(row=>row.id).sort()).toEqual([...newIds,...progressIds,doneId].sort());
    expect((await listStaffFeedback(fixture.env,feedbackStaff,query)).items.map(row=>row.id).sort()).toEqual([...newIds,...progressIds].sort());
    expect((await listStaffFeedback(fixture.env,feedbackStaff,{...query,q:"100Xliteral"})).items).toEqual([]);
  });
  it("retains live scope/denial filtering for open records and never treats open as a mutation status",async()=>{
    const owner=await fixture.seed(),record=await owner.create();
    await fixture.ops.prepare("INSERT INTO staff_permission_overrides VALUES(?,'operations.manage','deny','division',?)").bind(feedbackStaff.id,owner.division).run();
    expect((await listStaffFeedback(fixture.env,feedbackStaff,{accountId:owner.id,status:"open"})).items).toEqual([]);
    await expect(transitionStaffFeedback(fixture.env,feedbackStaff,record.id,
      {expectedRevision:1,status:"open",note:null},"invalid-"+crypto.randomUUID())).rejects.toMatchObject({status:400});
  });
});
