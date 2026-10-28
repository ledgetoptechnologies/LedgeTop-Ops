import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrantRow, StaffPrincipal } from "../src/worker/types";
import { buildScopedWhere, evaluatePermission, sqlScope, sqlScopes } from "../src/worker/acl";
import { decodeRef, encodeRef, normalizePrefix } from "../src/worker/delivery";

const login = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/worker/staff-login-bindings", () => ({ assertCurrentStaffLogin: login.current }));

const principal:StaffPrincipal={id:"kollins",email:"kstirn@ledgetopdroneservices.com",displayName:"Kollins",accessSubject:"access-sub",projectAlphaUserId:null};
function grant(values:Partial<GrantRow>):GrantRow{return{permission:"delivery.browse",effect:"allow",scope:"division",divisionId:"chippewa",source:"role",...values};}

function grantsDb(currentGrants: () => GrantRow[]) {
  const all = vi.fn(async () => ({ results: currentGrants() }));
  const prepared = { bind: vi.fn(() => prepared), all };
  const prepare = vi.fn(() => prepared);
  const db = { withSession: vi.fn(() => ({ prepare })) };
  return { db: db as unknown as D1Database, all, prepare };
}

beforeEach(() => { login.current.mockReset().mockResolvedValue(true); });

describe("ACL evaluation",()=>{
  it("permits a same-division resource and denies another division",()=>{const grants=[grant({})];expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"chippewa"})).toBe(true);expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"madison"})).toBe(false);});
  it("gives an applicable explicit deny precedence over global role access",()=>{const grants=[grant({scope:"global",divisionId:null}),grant({effect:"deny",source:"override",scope:"division",divisionId:"chippewa"})];expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"chippewa"})).toBe(false);expect(evaluatePermission(grants,principal,"delivery.browse",{divisionId:"madison"})).toBe(true);});
  it("applies division denies conservatively to explicitly unknown classification without granting division allows",()=>{
    const global=grant({scope:"global",divisionId:null}),deny=grant({effect:"deny",source:"override"});
    const unknown={divisionId:null,divisionAuthorityUnknown:true};
    expect(evaluatePermission([global,deny],principal,"delivery.browse",unknown)).toBe(false);
    expect(evaluatePermission([global],principal,"delivery.browse",unknown)).toBe(true);
    expect(evaluatePermission([grant({})],principal,"delivery.browse",unknown)).toBe(false);
    expect(evaluatePermission([global,deny],principal,"delivery.browse",{divisionId:"madison",divisionAuthorityUnknown:false})).toBe(true);
  });
  it("filters division and assigned access in SQL before pagination",()=>{const result=buildScopedWhere({global:false,divisions:["chippewa"],assigned:true,own:false,deniedDivisions:[],deniedGlobal:false},principal,"o","EXISTS (SELECT 1 FROM operation_staff os WHERE os.operation_id=o.id AND os.staff_id=?)");expect(result.sql).toContain("o.division_id IN (?)");expect(result.sql).toContain("operation_staff");expect(result.values).toEqual(["chippewa","kollins"]);});

  it("derives requested global, division, assigned, own and deny scopes from one grant query", async () => {
    const rows = [
      grant({ permission: "team.view", scope: "global", divisionId: null }),
      grant({ permission: "team.view", effect: "deny", source: "override", scope: "global", divisionId: null }),
      grant({ permission: "operations.manage", scope: "global", divisionId: null }),
      grant({ permission: "operations.manage", effect: "deny", source: "override", scope: "division", divisionId: "private" }),
      grant({ permission: "delivery.share.audit", scope: "division", divisionId: "chippewa" }),
      grant({ permission: "delivery.share.create", scope: "assigned", divisionId: null }),
      grant({ permission: "viewer.view", scope: "own", divisionId: null }),
    ];
    const fixture = grantsDb(() => rows);
    const scopes = await sqlScopes({ OPS_DB: fixture.db } as never, principal,
      ["team.view", "operations.manage", "delivery.share.audit", "delivery.share.create", "viewer.view", "viewer.manage"] as const);

    expect(fixture.all).toHaveBeenCalledOnce();
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(scopes["team.view"]).toMatchObject({ global: false, deniedGlobal: true });
    expect(scopes["operations.manage"]).toMatchObject({ global: true, deniedGlobal: false, deniedDivisions: ["private"] });
    expect(scopes["delivery.share.audit"]).toMatchObject({ global: false, divisions: ["chippewa"] });
    expect(scopes["delivery.share.create"]).toMatchObject({ assigned: true });
    expect(scopes["viewer.view"]).toMatchObject({ own: true });
    expect(scopes["viewer.manage"]).toMatchObject({ global: false, assigned: false, own: false });
  });

  it("preserves sqlScope behavior and reads fresh grants on each invocation", async () => {
    let current = [grant({ permission: "team.view", scope: "global", divisionId: null })];
    const fixture = grantsDb(() => current);
    const env = { OPS_DB: fixture.db } as never;
    await expect(sqlScope(env, principal, "team.view")).resolves.toMatchObject({ global: true, deniedGlobal: false });

    current = [grant({ permission: "team.view", effect: "deny", source: "override", scope: "global", divisionId: null })];
    await expect(sqlScopes(env, principal, ["team.view"] as const)).resolves.toMatchObject({
      "team.view": { global: false, deniedGlobal: true },
    });
    expect(fixture.all).toHaveBeenCalledTimes(2);
  });

  it("rechecks alternate login revocation on every batched scope read", async () => {
    let current = true;
    login.current.mockImplementation(async () => current);
    const fixture = grantsDb(() => [grant({ permission: "team.view", scope: "global", divisionId: null })]);
    const alternate = { ...principal, verifiedLogin: { kind: "alternate", staffId: principal.id } } as StaffPrincipal;
    const env = { OPS_DB: fixture.db } as never;
    await expect(sqlScopes(env, alternate, ["team.view", "viewer.view"] as const))
      .resolves.toMatchObject({ "team.view": { global: true }, "viewer.view": { global: false } });
    current = false;
    await expect(sqlScopes(env, alternate, ["team.view", "viewer.view"] as const)).rejects.toMatchObject({ status: 403 });
    expect(login.current).toHaveBeenCalledTimes(2);
    expect(fixture.all).toHaveBeenCalledTimes(2);
  });
});

describe("operations delivery paths",()=>{
  it("uses opaque references and preserves unedited folders",()=>{const ref=encodeRef("jobs/2026/Client/unedited/photo.jpg");expect(ref).not.toContain("/");expect(decodeRef(ref)).toBe("jobs/2026/Client/unedited/photo.jpg");expect(normalizePrefix("jobs/2026/Client/unedited")).toBe("jobs/2026/Client/unedited/");});
  it("rejects dump and root prefixes",()=>{expect(()=>normalizePrefix("dump")).toThrow();expect(()=>normalizePrefix("/")).toThrow();});
});
