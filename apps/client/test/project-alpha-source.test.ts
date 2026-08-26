import { describe,expect,it } from "vitest";
import { primaryAlphaReference,primaryWorkspaceAccount,localOrPrimaryAlphaReference } from "../src/worker/client-portal/project-alpha-source";
import { feedbackSourceOwnerSource,type FeedbackSourceOwner } from "../src/worker/client-portal/feedback-target";

const owner:FeedbackSourceOwner={account:{projectAlphaClientId:null,projectAlphaOrganizationId:"same-public-id"},
  project:{projectAlphaProjectId:"same-project-id",sourceUpdatedAt:null},workspace:null,association:null,file:null};
describe("Delivery source compatibility contracts",()=>{
  it("accepts internal aliases with digits but never interpolates arbitrary SQL",()=>{
    expect(primaryWorkspaceAccount("portal_v2_workspaces")).toContain("portal_v2_workspaces.legacy_account_id");
    expect(primaryAlphaReference("account")).toBe("account.project_alpha_source_id='project-alpha:primary'");
    expect(localOrPrimaryAlphaReference("account")).toContain("account.project_alpha_source_id IS NULL");
    for(const alias of ["account;drop", "a.b", "a--", "1bad", ""]) expect(()=>primaryWorkspaceAccount(alias)).toThrow();
  });
  it("interprets only versionless historical Alpha references as primary without mutation",()=>{
    const original=JSON.stringify(owner);
    expect(feedbackSourceOwnerSource(owner,"account")).toBe("project-alpha:primary");
    expect(feedbackSourceOwnerSource(owner,"project")).toBe("project-alpha:primary");
    expect(JSON.stringify(owner)).toBe(original);
    expect(feedbackSourceOwnerSource({...owner,account:{projectAlphaClientId:null,projectAlphaOrganizationId:null}},"account")).toBeNull();
  });
  it("retains explicit v2 secondary provenance and rejects missing or unknown-version provenance",()=>{
    const secondary:FeedbackSourceOwner={...owner,version:2,account:{...owner.account,projectAlphaSourceId:"project-alpha:secondary"},
      project:{...owner.project!,projectAlphaSourceId:"project-alpha:secondary"}};
    expect(feedbackSourceOwnerSource(secondary,"account")).toBe("project-alpha:secondary");
    expect(feedbackSourceOwnerSource(secondary,"project")).toBe("project-alpha:secondary");
    expect(feedbackSourceOwnerSource({...owner,version:2},"account")).toBeUndefined();
    expect(feedbackSourceOwnerSource({...owner,account:{...owner.account,projectAlphaSourceId:"project-alpha:primary"}},"account")).toBeUndefined();
    expect(feedbackSourceOwnerSource({...owner,version:3} as unknown as FeedbackSourceOwner,"account")).toBeUndefined();
  });
});
