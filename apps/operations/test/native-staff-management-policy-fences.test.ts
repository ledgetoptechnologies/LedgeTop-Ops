import { describe, expect, it } from "vitest";
import { evaluateNativeStaffManagementTargetScope, type NativeStaffManagementPolicyRequest, type NativeStaffManagementScope } from "../src/worker/native-staff-management-policy";

const scopes: NativeStaffManagementScope[] = ["global", "business_area", "division", "exact_staff"];
const base: NativeStaffManagementPolicyRequest = {
  actor: { staffId: "actor", verifiedAccessSubject: "Opaque/Subject", boundAccessSubject: "Opaque/Subject", activeNativeAdmission: true },
  capability: "staff.profile.edit",
  target: { staffId: "target", memberships: [
    { id: "m1", scopeKind: "division", businessAreaId: "drone", divisionId: "north", active: true, businessAreaActive: true, divisionActive: true },
    { id: "m2", scopeKind: "business_area", businessAreaId: "web", divisionId: null, active: true, businessAreaActive: true, divisionActive: null },
  ] },
  delegations: [],
};
function delegation(scopeKind: NativeStaffManagementScope, effect: "allow" | "deny" = "allow"): NativeStaffManagementPolicyRequest["delegations"][number] {
  return { id: `${effect}:${scopeKind}`, actorStaffId: "actor", contractVersion: 1, capability: "staff.profile.edit", effect, scopeKind,
    businessAreaId: scopeKind === "business_area" || scopeKind === "division" ? "drone" : null,
    divisionId: scopeKind === "division" ? "north" : null, targetStaffId: scopeKind === "exact_staff" ? "target" : null, active: true };
}

describe("independent staff scope fences", () => {
  it.each(scopes.flatMap(allow => scopes.map(deny => [allow, deny] as const)))("%s allow never overrides %s deny", (allow, deny) => {
    const rows = [delegation(allow), delegation(deny, "deny")];
    const outcome = evaluateNativeStaffManagementTargetScope({ ...base, delegations: rows });
    expect(outcome).toMatchObject({ allowed: false, reason: "explicit_deny", effective: { denyDelegationIds: [`deny:${deny}`] } });
    expect(evaluateNativeStaffManagementTargetScope({ ...base, delegations: [...rows].reverse() })).toEqual(outcome);
  });

  it("uses every active membership, not just the first department", () => {
    const deny = { ...delegation("business_area", "deny"), businessAreaId: "web" };
    expect(evaluateNativeStaffManagementTargetScope({ ...base, delegations: [delegation("global"), deny] })).toMatchObject({ allowed: false, reason: "explicit_deny" });
  });

  it.each(["actor", "capability", "area", "division", "target", "inactive"])("does not use a nonmatching %s allow", variant => {
    const row = delegation(variant === "target" ? "exact_staff" : "division");
    if (variant === "actor") row.actorStaffId = "someone-else";
    if (variant === "capability") row.capability = "staff.admission.disable";
    if (variant === "area") row.businessAreaId = "web";
    if (variant === "division") row.divisionId = "south";
    if (variant === "target") row.targetStaffId = "someone-else";
    if (variant === "inactive") row.active = false;
    expect(evaluateNativeStaffManagementTargetScope({ ...base, delegations: [row] })).toMatchObject({ allowed: false, reason: "no_matching_allow" });
  });

  it("does not normalize subjects or expand legacy capabilities", () => {
    expect(evaluateNativeStaffManagementTargetScope({ ...base, actor: { ...base.actor, verifiedAccessSubject: "opaque/subject" }, delegations: [delegation("global")] }).reason).toBe("subject_mismatch");
    expect(evaluateNativeStaffManagementTargetScope({ ...base, capability: "staff.admission.enable", delegations: [delegation("global")] }).allowed).toBe(false);
    expect(evaluateNativeStaffManagementTargetScope({ ...base, capability: "staff.*", delegations: [delegation("global")] }).reason).toBe("invalid_input");
    expect(evaluateNativeStaffManagementTargetScope({ ...base, delegations: [{ ...delegation("global"), contractVersion: 2 }] }).reason).toBe("invalid_input");
  });

  it("preserves inactive transfer history without retaining its old deny scope", () => {
    const memberships = base.target.memberships.map(row => row.id === "m1"
      ? { ...row, active: false, businessAreaActive: false, divisionActive: false } : row);
    const outcome = evaluateNativeStaffManagementTargetScope({ ...base,
      target: { ...base.target, memberships },
      delegations: [delegation("global"), delegation("division", "deny")],
    });
    expect(outcome).toMatchObject({ allowed: true, effective: { denyDelegationIds: [], invalidMembershipIds: [] } });
    expect(memberships).toHaveLength(2);
    expect(memberships[0]?.active).toBe(false);
  });
});
