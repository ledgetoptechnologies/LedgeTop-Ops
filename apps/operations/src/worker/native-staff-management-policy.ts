import { isNativeAccessSubject } from "./native-access-subject";
export const NATIVE_STAFF_MANAGEMENT_CAPABILITIES = Object.freeze(["staff.profile.read", "staff.profile.edit", "staff.effective_access.read", "staff.revocation_impact.read", "staff.onboarding.create", "staff.onboarding.approve", "staff.onboarding.cancel", "staff.admission.enable", "staff.admission.disable", "staff.membership.manage", "staff.directory_grant.manage", "staff.admin_delegation.manage", "staff.identity.recover"] as const);
export type NativeStaffManagementCapability = typeof NATIVE_STAFF_MANAGEMENT_CAPABILITIES[number];
export type NativeStaffManagementScope = "global" | "business_area" | "division" | "exact_staff";
type Actor = {
    staffId: string;
    verifiedAccessSubject: string;
    boundAccessSubject: string;
    activeNativeAdmission: boolean;
};
type TargetMembership = {
    id: string;
    scopeKind: "business_area" | "division";
    businessAreaId: string;
    divisionId: string | null;
    active: boolean;
    businessAreaActive: boolean;
    divisionActive: boolean | null;
};
type Target = {
    staffId: string;
    memberships: TargetMembership[];
};
type Delegation = {
    id: string;
    actorStaffId: string;
    contractVersion: 1;
    capability: NativeStaffManagementCapability;
    effect: "allow" | "deny";
    scopeKind: NativeStaffManagementScope;
    businessAreaId: string | null;
    divisionId: string | null;
    targetStaffId: string | null;
    active: boolean;
};
export type NativeStaffManagementPolicyRequest = {
    actor: Actor;
    capability: NativeStaffManagementCapability;
    target: Target;
    delegations: Delegation[];
};
export type NativeStaffManagementPolicyDecision = {
    allowed: boolean;
    reason: "allowed" | "invalid_input" | "not_native_admitted" | "subject_mismatch" | "invalid_target_membership" | "out_of_band_required" | "explicit_deny" | "no_matching_allow";
    effective: {
        allowDelegationIds: string[];
        denyDelegationIds: string[];
        matchingScopes: NativeStaffManagementScope[];
        invalidMembershipIds: string[];
    };
};
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const empty = (): NativeStaffManagementPolicyDecision["effective"] => ({ allowDelegationIds: [], denyDelegationIds: [], matchingScopes: [], invalidMembershipIds: [] });
function rec(x: unknown): x is Record<string, unknown> { if (x === null || typeof x !== "object" || Array.isArray(x))
    return false; const ks = Object.keys(x); return (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null) && Reflect.ownKeys(x).length === ks.length && ks.every(k => { const d = Object.getOwnPropertyDescriptor(x, k); return d?.enumerable === true && "value" in d; }); }
function keys(x: Record<string, unknown>, want: string[]) { const got = Object.keys(x).sort(), w = [...want].sort(); return got.length === w.length && got.every((v, i) => v === w[i]); }
function id(x: unknown): x is string { return typeof x === "string" && ID.test(x) && !/\p{C}/u.test(x); }
function array(x: unknown, max = 512): x is unknown[] {
    if (!Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype
        || !Number.isSafeInteger(x.length) || x.length > max || Object.keys(x).length !== x.length)
        return false;
    const own = Reflect.ownKeys(x);
    if (own.length !== x.length + 1 || own.some(key => key !== "length"
        && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key))))
        return false;
    for (let index = 0; index < x.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(x, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            return false;
    }
    return true;
}
function capability(x: unknown): x is NativeStaffManagementCapability { return typeof x === "string" && NATIVE_STAFF_MANAGEMENT_CAPABILITIES.includes(x as NativeStaffManagementCapability); }
function membership(x: unknown): x is TargetMembership { if (!rec(x) || !keys(x, ["id", "scopeKind", "businessAreaId", "divisionId", "active", "businessAreaActive", "divisionActive"]) || !id(x.id) || !id(x.businessAreaId) || typeof x.active !== "boolean" || typeof x.businessAreaActive !== "boolean")
    return false; return x.scopeKind === "business_area" ? x.divisionId === null && x.divisionActive === null : x.scopeKind === "division" && id(x.divisionId) && typeof x.divisionActive === "boolean"; }
function delegation(x: unknown): x is Delegation { if (!rec(x) || !keys(x, ["id", "actorStaffId", "contractVersion", "capability", "effect", "scopeKind", "businessAreaId", "divisionId", "targetStaffId", "active"]) || !id(x.id) || !id(x.actorStaffId) || x.contractVersion !== 1 || !capability(x.capability) || (x.effect !== "allow" && x.effect !== "deny") || typeof x.active !== "boolean")
    return false; if (x.scopeKind === "global")
    return x.businessAreaId === null && x.divisionId === null && x.targetStaffId === null; if (x.scopeKind === "business_area")
    return id(x.businessAreaId) && x.divisionId === null && x.targetStaffId === null; if (x.scopeKind === "division")
    return id(x.businessAreaId) && id(x.divisionId) && x.targetStaffId === null; return x.scopeKind === "exact_staff" && x.businessAreaId === null && x.divisionId === null && id(x.targetStaffId); }
function valid(x: unknown): x is NativeStaffManagementPolicyRequest { if (!rec(x) || !keys(x, ["actor", "capability", "target", "delegations"]) || !rec(x.actor) || !keys(x.actor, ["staffId", "verifiedAccessSubject", "boundAccessSubject", "activeNativeAdmission"]) || !id(x.actor.staffId) || !isNativeAccessSubject(x.actor.verifiedAccessSubject) || !isNativeAccessSubject(x.actor.boundAccessSubject) || typeof x.actor.activeNativeAdmission !== "boolean" || !capability(x.capability) || !rec(x.target) || !keys(x.target, ["staffId", "memberships"]) || !id(x.target.staffId) || !array(x.target.memberships, 128) || !x.target.memberships.every(membership) || !array(x.delegations, 512) || !x.delegations.every(delegation))
    return false; return new Set(x.target.memberships.map(m => m.id)).size === x.target.memberships.length && new Set(x.delegations.map(d => d.id)).size === x.delegations.length; }
function invalidMemberships(target: Target) { return target.memberships.filter(m => m.active && (!m.businessAreaActive || (m.scopeKind === "division" && m.divisionActive !== true))).map(m => m.id).sort(); }
function matches(d: Delegation, t: Target) { if (d.scopeKind === "global")
    return true; if (d.scopeKind === "exact_staff")
    return d.targetStaffId === t.staffId; if (d.scopeKind === "business_area")
    return t.memberships.some(m => m.active && m.businessAreaActive && m.businessAreaId === d.businessAreaId); return t.memberships.some(m => m.active && m.businessAreaActive && m.scopeKind === "division" && m.divisionActive === true && m.businessAreaId === d.businessAreaId && m.divisionId === d.divisionId); }
/** Target-scope decision only. Callers must separately prove ceilings and re-evaluate in their write fence. */
export function evaluateNativeStaffManagementTargetScope(value: unknown): NativeStaffManagementPolicyDecision { try {
    if (!valid(value))
        return { allowed: false, reason: "invalid_input", effective: empty() };
    if (!value.actor.activeNativeAdmission)
        return { allowed: false, reason: "not_native_admitted", effective: empty() };
    if (value.actor.verifiedAccessSubject !== value.actor.boundAccessSubject)
        return { allowed: false, reason: "subject_mismatch", effective: empty() };
    const bad = invalidMemberships(value.target);
    if (bad.length)
        return { allowed: false, reason: "invalid_target_membership", effective: { ...empty(), invalidMembershipIds: bad } };
    if (value.capability === "staff.identity.recover")
        return { allowed: false, reason: "out_of_band_required", effective: empty() };
    const matched = value.delegations.filter(d => d.active && d.actorStaffId === value.actor.staffId && d.capability === value.capability && matches(d, value.target));
    const allows = matched.filter(d => d.effect === "allow").map(d => d.id).sort(), denies = matched.filter(d => d.effect === "deny").map(d => d.id).sort(), effective = { allowDelegationIds: allows, denyDelegationIds: denies, matchingScopes: [...new Set(matched.map(d => d.scopeKind))].sort() as NativeStaffManagementScope[], invalidMembershipIds: [] };
    if (denies.length)
        return { allowed: false, reason: "explicit_deny", effective };
    return allows.length ? { allowed: true, reason: "allowed", effective } : { allowed: false, reason: "no_matching_allow", effective };
}
catch {
    return { allowed: false, reason: "invalid_input", effective: empty() };
} }
