import { describe, expect, it } from "vitest";
import type { GrantRow, StaffPrincipal } from "../src/worker/types";
import { buildScopedWhere, evaluatePermission } from "../src/worker/acl";
import { decodeRef, encodeRef, normalizePrefix } from "../src/worker/delivery";

const principal:StaffPrincipal={id:"kollins",email:"kstirn@ledgetopdroneservices.com",displayName:"Kollins",accessSubject:"access-sub",projectAlphaUserId:null};
function grant(values:Partial<GrantRow>):GrantRow{return{permission:"delivery.browse",effect:"allow",scope:"division",divisionId:"chippewa",source:"role",...values};}

describe("ACL evaluation",()=>{
  it("permits a same-division resource and denies another division",()=>{const grants=[grant({})];expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"chippewa"})).toBe(true);expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"madison"})).toBe(false);});
  it("gives an applicable explicit deny precedence over global role access",()=>{const grants=[grant({scope:"global",divisionId:null}),grant({effect:"deny",source:"override",scope:"division",divisionId:"chippewa"})];expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"chippewa"})).toBe(false);expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"madison"})).toBe(true);});
  it("filters division and assigned access in SQL before pagination",()=>{const result=buildScopedWhere({global:false,divisions:["chippewa"],assigned:true,own:false,deniedDivisions:[],deniedGlobal:false},principal,"o","EXISTS (SELECT 1 FROM operation_staff os WHERE os.operation_id=o.id AND os.staff_id=?)");expect(result.sql).toContain("o.division_id IN (?)");expect(result.sql).toContain("operation_staff");expect(result.values).toEqual(["chippewa","kollins"]);});
});

describe("operations delivery paths",()=>{
  it("uses opaque references and preserves unedited folders",()=>{const ref=encodeRef("jobs/2026/Client/unedited/photo.jpg");expect(ref).not.toContain("/");expect(decodeRef(ref)).toBe("jobs/2026/Client/unedited/photo.jpg");expect(normalizePrefix("jobs/2026/Client/unedited")).toBe("jobs/2026/Client/unedited/");});
  it("rejects dump and root prefixes",()=>{expect(()=>normalizePrefix("dump")).toThrow();expect(()=>normalizePrefix("/")).toThrow();});
});
