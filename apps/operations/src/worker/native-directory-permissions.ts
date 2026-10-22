import { isNativeAccessSubject } from "./native-access-subject";

export const NATIVE_DIRECTORY_PERMISSIONS = [
  "directory.profile.view",
  "directory.profile.edit",
  "directory.identity.link",
  "directory.enrollment.manage",
  "directory.portal_access.manage",
] as const;

export type NativeDirectoryPermission = typeof NATIVE_DIRECTORY_PERMISSIONS[number];
export type NativeDirectoryScopeKind = "global" | "business_area" | "division" | "assigned" | "resource";

export type NativeDirectoryIdentity = {
  staffId: string;
  accessSubject: string;
  boundAccessSubject: string;
  active: boolean;
  nativeAdmitted: boolean;
};

export type NativeDirectoryGrant = {
  id: string;
  staffId: string;
  permission: NativeDirectoryPermission;
  effect: "allow" | "deny";
  scopeKind: NativeDirectoryScopeKind;
  scopeId: string | null;
  active: boolean;
};

export type NativeDirectoryResourceContext = {
  resourceId: string;
  businessAreaIds: string[];
  divisions: Array<{ businessAreaId: string; divisionId: string }>;
  assignedStaffIds: string[];
};

export type NativeDirectoryPermissionRequest = {
  identity: NativeDirectoryIdentity;
  permission: NativeDirectoryPermission;
  grants: NativeDirectoryGrant[];
  resource: NativeDirectoryResourceContext;
};

export type NativeDirectoryPermissionDecision = {
  allowed: boolean;
  reason: "allowed" | "invalid_input" | "not_native_admitted" | "inactive_identity" | "subject_mismatch"
    | "missing_context" | "explicit_deny" | "no_matching_allow";
  effective: {
    allowGrantIds: string[];
    denyGrantIds: string[];
    matchingScopes: NativeDirectoryScopeKind[];
  };
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
function emptyEffective(): NativeDirectoryPermissionDecision["effective"] {
  return { allowGrantIds: [], denyGrantIds: [], matchingScopes: [] };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value) && !/\p{C}/u.test(value);
}

function permission(value: unknown): value is NativeDirectoryPermission {
  return typeof value === "string" && NATIVE_DIRECTORY_PERMISSIONS.includes(value as NativeDirectoryPermission);
}

function identity(value: unknown): value is NativeDirectoryIdentity {
  return plainRecord(value) && exactKeys(value,
    ["staffId", "accessSubject", "boundAccessSubject", "active", "nativeAdmitted"])
    && identifier(value.staffId) && isNativeAccessSubject(value.accessSubject) && isNativeAccessSubject(value.boundAccessSubject)
    && typeof value.active === "boolean" && typeof value.nativeAdmitted === "boolean";
}

function grant(value: unknown): value is NativeDirectoryGrant {
  if (!plainRecord(value) || !exactKeys(value,
    ["id", "staffId", "permission", "effect", "scopeKind", "scopeId", "active"])) return false;
  if (!identifier(value.id) || !identifier(value.staffId) || !permission(value.permission)
    || (value.effect !== "allow" && value.effect !== "deny") || typeof value.scopeKind !== "string"
    || !["global", "business_area", "division", "assigned", "resource"].includes(value.scopeKind)
    || typeof value.active !== "boolean") return false;
  return value.scopeKind === "global" || value.scopeKind === "assigned"
    ? value.scopeId === null
    : identifier(value.scopeId);
}

function uniqueIdentifiers(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(identifier) && new Set(value).size === value.length;
}

function resource(value: unknown): value is NativeDirectoryResourceContext {
  if (!plainRecord(value) || !exactKeys(value, ["resourceId", "businessAreaIds", "divisions", "assignedStaffIds"])
    || !identifier(value.resourceId) || !uniqueIdentifiers(value.businessAreaIds)
    || !uniqueIdentifiers(value.assignedStaffIds) || !Array.isArray(value.divisions) || value.divisions.length > 128) return false;
  const memberships = new Set<string>();
  for (const division of value.divisions) {
    if (!plainRecord(division) || !exactKeys(division, ["businessAreaId", "divisionId"])
      || !identifier(division.businessAreaId) || !identifier(division.divisionId)
      || !value.businessAreaIds.includes(division.businessAreaId)) return false;
    memberships.add(`${division.businessAreaId}\0${division.divisionId}`);
  }
  return memberships.size === value.divisions.length;
}

function validRequest(value: unknown): value is NativeDirectoryPermissionRequest {
  if (!(plainRecord(value) && exactKeys(value, ["identity", "permission", "grants", "resource"])
    && identity(value.identity) && permission(value.permission) && Array.isArray(value.grants)
    && value.grants.length <= 512 && Object.keys(value.grants).length === value.grants.length
    && value.grants.every(grant) && resource(value.resource))) return false;
  return new Set(value.grants.map(candidate => candidate.id)).size === value.grants.length;
}

function matchesScope(grant: NativeDirectoryGrant, identity: NativeDirectoryIdentity,
  context: NativeDirectoryResourceContext): boolean {
  if (grant.scopeKind === "global") return true;
  if (grant.scopeKind === "business_area") return context.businessAreaIds.includes(grant.scopeId!);
  if (grant.scopeKind === "division") return context.divisions.some(item => item.divisionId === grant.scopeId);
  if (grant.scopeKind === "assigned") return context.assignedStaffIds.includes(identity.staffId);
  return grant.scopeId === context.resourceId;
}

/** Pure policy evaluation only. A later database write fence must revalidate the
 * same native admission, grants, memberships and assignment transactionally. */
export function evaluateNativeDirectoryPermission(value: unknown): NativeDirectoryPermissionDecision {
  if (plainRecord(value) && exactKeys(value, ["identity", "permission", "grants", "resource"])
    && (value.resource === null || (plainRecord(value.resource) && value.resource.resourceId === ""))) {
    return { allowed: false, reason: "missing_context", effective: emptyEffective() };
  }
  if (!validRequest(value)) return { allowed: false, reason: "invalid_input", effective: emptyEffective() };
  if (!value.identity.nativeAdmitted) return { allowed: false, reason: "not_native_admitted", effective: emptyEffective() };
  if (!value.identity.active) return { allowed: false, reason: "inactive_identity", effective: emptyEffective() };
  if (value.identity.accessSubject !== value.identity.boundAccessSubject) {
    return { allowed: false, reason: "subject_mismatch", effective: emptyEffective() };
  }
  const matching = value.grants.filter(candidate => candidate.active && candidate.staffId === value.identity.staffId
    && candidate.permission === value.permission && matchesScope(candidate, value.identity, value.resource));
  const denies = matching.filter(candidate => candidate.effect === "deny");
  const allows = matching.filter(candidate => candidate.effect === "allow");
  const effective = {
    allowGrantIds: allows.map(candidate => candidate.id).sort(),
    denyGrantIds: denies.map(candidate => candidate.id).sort(),
    matchingScopes: [...new Set(matching.map(candidate => candidate.scopeKind))].sort(),
  };
  if (denies.length) return { allowed: false, reason: "explicit_deny", effective };
  return allows.length ? { allowed: true, reason: "allowed", effective }
    : { allowed: false, reason: "no_matching_allow", effective };
}
