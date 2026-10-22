import { NATIVE_DIRECTORY_PERMISSIONS } from "./native-directory-permissions";
import { isNativeAccessSubject } from "./native-access-subject";
import { evaluateNativeStaffManagementTargetScope, type NativeStaffManagementCapability, type NativeStaffManagementPolicyRequest } from "./native-staff-management-policy";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const READ_CAPABILITIES = new Set<NativeStaffManagementCapability>(["staff.profile.read", "staff.effective_access.read", "staff.revocation_impact.read"]);
const MANAGEMENT_CAPABILITIES = new Set<string>([
  "staff.profile.read", "staff.profile.edit", "staff.effective_access.read", "staff.revocation_impact.read",
  "staff.onboarding.create", "staff.onboarding.approve", "staff.onboarding.cancel", "staff.admission.enable",
  "staff.admission.disable", "staff.membership.manage", "staff.directory_grant.manage",
  "staff.admin_delegation.manage", "staff.identity.recover", "staff.documents.read", "staff.documents.upload", "staff.documents.manage", "staff.profile.archive", "staff.profile.restore",
]);
const DIRECTORY_CAPABILITIES = new Set<string>(NATIVE_DIRECTORY_PERMISSIONS);
type ReadCapability = "staff.profile.read" | "staff.effective_access.read" | "staff.revocation_impact.read";
type ReadInput = { actorStaffId: string; verifiedAccessSubject: string; targetStaffId: string; capability: ReadCapability };
type Row = Record<string, unknown>;

type TargetEvidence = Readonly<{ staffId: string; admissionActive: boolean; admissionVersion: number; profileVersion: number }>;
type ManagementSnapshot = Readonly<{
    partial: true;
    memberships: readonly Readonly<{ referenceId: string; scopeKind: "business_area" | "division"; businessAreaId: string; divisionId: string | null; active: boolean; version: number; businessAreaActive: boolean; divisionActive: boolean | null }>[];
    delegations: readonly Readonly<{ referenceId: string; source: "legacy_0061" | "management_0067"; capability: NativeStaffManagementCapability; effect: "allow" | "deny"; scopeKind: "global" | "business_area" | "division" | "exact_staff"; businessAreaId: string | null; divisionId: string | null; targetStaffId: string | null; active: boolean; version: number }>[];
    ceilings: readonly Readonly<{ referenceId: string; parentReferenceId: string; domain: "directory" | "staff_admin"; capability: string; effect: "allow" | "deny"; grantEffects: readonly ("allow" | "deny")[]; operations: readonly ("create" | "revoke")[]; scopeKind: "global" | "business_area" | "division" | "assigned" | "resource" | "exact_staff"; businessAreaId: string | null; divisionId: string | null; resourceId: string | null; targetStaffId: string | null; active: boolean; version: number }>[];
  }>;
export type NativeStaffManagementReadResult = Readonly<{
  capability: ReadCapability;
  target: TargetEvidence;
  authorization: Readonly<{ allowed: true }>;
  scopedProfile: Readonly<{ loginEmail: string; displayName: string }>;
  managementSnapshot: null;
}> | Readonly<{
  capability: Exclude<ReadCapability, "staff.profile.read">;
  target: TargetEvidence;
  authorization: Readonly<{ allowed: true }>;
  scopedProfile: null;
  managementSnapshot: ManagementSnapshot;
}>;

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return typeof key === "string" && descriptor?.enumerable === true && "value" in descriptor; });
}
function exact(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)); }
function identifier(value: unknown): value is string { return typeof value === "string" && ID.test(value) && !/\p{C}/u.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function bit(value: unknown): value is 0 | 1 { return value === 0 || value === 1; }
function nullableId(value: unknown): value is string | null { return value === null || identifier(value); }
function loginEmail(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length >= 3 && Array.from(value).length <= 254
    && value === value.toLowerCase() && value === value.trim() && !value.includes("\0") && value.indexOf("@") > 0;
}
function displayName(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length >= 1 && Array.from(value).length <= 160
    && Array.from(value.trim()).length >= 1 && Array.from(value.trim()).length <= 160 && !value.includes("\0");
}
function input(value: unknown): ReadInput {
  if (!plain(value) || !exact(value, ["actorStaffId", "verifiedAccessSubject", "targetStaffId", "capability"])
    || !identifier(value.actorStaffId) || !isNativeAccessSubject(value.verifiedAccessSubject) || !identifier(value.targetStaffId)
    || typeof value.capability !== "string" || !READ_CAPABILITIES.has(value.capability as NativeStaffManagementCapability)) throw new Error("native_staff_management_read_denied");
  return { actorStaffId: value.actorStaffId, verifiedAccessSubject: value.verifiedAccessSubject, targetStaffId: value.targetStaffId, capability: value.capability as ReadCapability };
}
async function reference(prefix: string, raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${prefix}\0${raw}`));
  return `${prefix}:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function rows(result: unknown, maximum: number): Promise<Row[]> {
  if (!plain(result) || result.success !== true || !Array.isArray(result.results)
    || Object.getPrototypeOf(result.results) !== Array.prototype || result.results.length > maximum
    || Object.keys(result.results).length !== result.results.length
    || Reflect.ownKeys(result.results).length !== result.results.length + 1) throw new Error("native_staff_management_read_denied");
  const output: Row[] = [];
  for (let index = 0; index < result.results.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(result.results, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || !plain(descriptor.value)) throw new Error("native_staff_management_read_denied");
    output.push(descriptor.value);
  }
  return output;
}
function delegationShape(row: Row): boolean {
  if (typeof row.scope_kind !== "string") return false;
  return (row.scope_kind === "global" && row.business_area_id === null && row.division_id === null && row.target_staff_id === null)
    || (row.scope_kind === "business_area" && identifier(row.business_area_id) && row.division_id === null && row.target_staff_id === null)
    || (row.scope_kind === "division" && identifier(row.business_area_id) && identifier(row.division_id) && row.target_staff_id === null)
    || (row.scope_kind === "exact_staff" && row.business_area_id === null && row.division_id === null && identifier(row.target_staff_id));
}
function ceilingShape(row: Row): boolean {
  if (typeof row.scope_kind !== "string") return false;
  const shape = (row.scope_kind === "global" || row.scope_kind === "assigned") && row.business_area_id === null && row.division_id === null && row.resource_id === null && row.target_staff_id === null
    || row.scope_kind === "business_area" && identifier(row.business_area_id) && row.division_id === null && row.resource_id === null && row.target_staff_id === null
    || row.scope_kind === "division" && identifier(row.business_area_id) && identifier(row.division_id) && row.resource_id === null && row.target_staff_id === null
    || row.scope_kind === "resource" && row.business_area_id === null && row.division_id === null && identifier(row.resource_id) && row.target_staff_id === null
    || row.scope_kind === "exact_staff" && row.business_area_id === null && row.division_id === null && row.resource_id === null && identifier(row.target_staff_id);
  return Boolean(shape) && (row.authority_domain === "directory"
    ? ["global", "business_area", "division", "assigned", "resource"].includes(row.scope_kind)
    : ["global", "business_area", "division", "exact_staff"].includes(row.scope_kind));
}

/** Trusted, read-only management snapshot. It is not mutation authorization or complete operational access. */
export async function readNativeStaffManagement(database: D1Database, rawInput: unknown): Promise<NativeStaffManagementReadResult> {
  try {
    const request = input(rawInput);
    const db = database.withSession("first-primary");
    const batchResults: unknown = await db.batch<Row>([
      db.prepare(`SELECT admission.staff_id,admission.bound_access_subject,admission.active admission_active,admission.version admission_version,
        profile.staff_id profile_staff_id,profile.login_email,profile.display_name,profile.version profile_version
        FROM native_staff_admissions admission LEFT JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id WHERE admission.staff_id=?`).bind(request.actorStaffId),
      db.prepare(`SELECT admission.staff_id,admission.active admission_active,admission.version admission_version,
        profile.staff_id profile_staff_id,profile.login_email,profile.display_name,profile.version profile_version
        FROM native_staff_admissions admission LEFT JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id WHERE admission.staff_id=?`).bind(request.targetStaffId),
      db.prepare(`SELECT membership.id,membership.scope_kind,membership.business_area_id,membership.division_id,membership.active,membership.version,
        area.active business_area_active,division.active division_active FROM native_staff_target_memberships membership
        LEFT JOIN native_business_areas area ON area.id=membership.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=membership.division_id AND division.business_area_id=membership.business_area_id
        WHERE membership.staff_id=? AND membership.active<>0 ORDER BY membership.id LIMIT 129`).bind(request.targetStaffId),
      db.prepare(`SELECT id,action capability,effect,scope_kind,business_area_id,division_id,target_staff_id,active,version
        FROM native_staff_admin_delegations WHERE actor_staff_id=? AND active<>0 ORDER BY id LIMIT 513`).bind(request.actorStaffId),
      db.prepare(`SELECT id,contract_version,authority_domain,capability,effect,scope_kind,business_area_id,division_id,target_staff_id,active,version
        FROM native_staff_management_delegations WHERE actor_staff_id=? AND active<>0 ORDER BY id LIMIT 513`).bind(request.actorStaffId),
      db.prepare(`SELECT id,action capability,effect,scope_kind,business_area_id,division_id,target_staff_id,active,version
        FROM native_staff_admin_delegations WHERE actor_staff_id=? AND active<>0 AND ?<>'staff.profile.read' ORDER BY id LIMIT 513`).bind(request.targetStaffId, request.capability),
      db.prepare(`SELECT id,contract_version,authority_domain,capability,effect,scope_kind,business_area_id,division_id,target_staff_id,active,version
        FROM native_staff_management_delegations WHERE actor_staff_id=? AND active<>0 AND ?<>'staff.profile.read' ORDER BY id LIMIT 513`).bind(request.targetStaffId, request.capability),
      db.prepare(`SELECT ceiling.id,ceiling.parent_delegation_id,ceiling.authority_domain,ceiling.capability,ceiling.effect,
        ceiling.grant_allow,ceiling.grant_deny,ceiling.operation_create,ceiling.operation_revoke,ceiling.scope_kind,
        ceiling.business_area_id,ceiling.division_id,ceiling.resource_id,ceiling.target_staff_id,ceiling.active,ceiling.version,
        ceiling.contract_version,parent.capability parent_capability,parent.effect parent_effect,parent.active parent_active
        FROM native_staff_delegation_ceilings ceiling JOIN native_staff_management_delegations parent ON parent.id=ceiling.parent_delegation_id
        WHERE parent.actor_staff_id=? AND parent.active<>0 AND ceiling.active<>0 AND ?<>'staff.profile.read' ORDER BY ceiling.id LIMIT 513`).bind(request.targetStaffId, request.capability),
    ]);
    if (!Array.isArray(batchResults) || Object.getPrototypeOf(batchResults) !== Array.prototype
      || batchResults.length !== 8 || Object.keys(batchResults).length !== batchResults.length
      || Reflect.ownKeys(batchResults).length !== batchResults.length + 1) throw new Error("native_staff_management_read_denied");
    const results: unknown[] = [];
    for (let index = 0; index < batchResults.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(batchResults, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || !plain(descriptor.value)) throw new Error("native_staff_management_read_denied");
      results.push(descriptor.value);
    }
    const actorRows = await rows(results[0]!, 1); const targetRows = await rows(results[1]!, 1);
    const membershipRows = await rows(results[2]!, 128); const oldRows = await rows(results[3]!, 512);
    const newRows = await rows(results[4]!, 512); const targetOldRows = await rows(results[5]!, 512);
    const targetNewRows = await rows(results[6]!, 512); const ceilingRows = await rows(results[7]!, 512);
    if (oldRows.length + newRows.length > 512 || targetOldRows.length + targetNewRows.length > 512 || actorRows.length !== 1 || targetRows.length !== 1) throw new Error("native_staff_management_read_denied");
    const actor = actorRows[0]!; const target = targetRows[0]!;
    if (actor.staff_id !== request.actorStaffId || actor.bound_access_subject !== request.verifiedAccessSubject || actor.admission_active !== 1
      || actor.profile_staff_id !== request.actorStaffId || !integer(actor.admission_version) || !integer(actor.profile_version)
      || !loginEmail(actor.login_email) || !displayName(actor.display_name)
      || target.staff_id !== request.targetStaffId || target.profile_staff_id !== request.targetStaffId
      || !bit(target.admission_active) || !integer(target.admission_version) || !integer(target.profile_version)
      || !loginEmail(target.login_email) || !displayName(target.display_name)) throw new Error("native_staff_management_read_denied");

    const memberships: NativeStaffManagementPolicyRequest["target"]["memberships"] = [];
    const membershipEvidence: ManagementSnapshot["memberships"][number][] = [];
    for (const row of membershipRows) {
      if (!identifier(row.id) || (row.scope_kind !== "business_area" && row.scope_kind !== "division") || !identifier(row.business_area_id)
        || !nullableId(row.division_id) || !bit(row.active) || !integer(row.version) || !bit(row.business_area_active)
        || (row.scope_kind === "business_area" ? row.division_id !== null || row.division_active !== null : !identifier(row.division_id) || !bit(row.division_active))) throw new Error("native_staff_management_read_denied");
      const item: NativeStaffManagementPolicyRequest["target"]["memberships"][number] = { id: await reference("membership", row.id), scopeKind: row.scope_kind, businessAreaId: row.business_area_id, divisionId: row.division_id, active: row.active === 1, businessAreaActive: row.business_area_active === 1, divisionActive: row.division_active === null ? null : row.division_active === 1 };
      memberships.push(item); membershipEvidence.push({ referenceId: item.id, scopeKind: item.scopeKind, businessAreaId: item.businessAreaId, divisionId: item.divisionId, active: item.active, version: row.version, businessAreaActive: item.businessAreaActive, divisionActive: item.divisionActive });
    }

    const policyDelegations: NativeStaffManagementPolicyRequest["delegations"] = [];
    const delegationEvidence: ManagementSnapshot["delegations"][number][] = [];
    const parentReferences = new Map<string, string>();
    for (const [source, sourceRows, owner, expose] of [["legacy_0061", oldRows, request.actorStaffId, false], ["management_0067", newRows, request.actorStaffId, false], ["legacy_0061", targetOldRows, request.targetStaffId, true], ["management_0067", targetNewRows, request.targetStaffId, true]] as const) {
      for (const row of sourceRows) {
        const knownCapability = source === "legacy_0061" ? row.capability === "staff.profile.edit" || row.capability === "staff.admission.disable" : typeof row.capability === "string" && MANAGEMENT_CAPABILITIES.has(row.capability);
        if (!identifier(row.id) || !knownCapability
          || (source === "management_0067" && (row.contract_version !== 1 || row.authority_domain !== "staff_admin"))
          || (row.effect !== "allow" && row.effect !== "deny") || !delegationShape(row)
          || !nullableId(row.business_area_id) || !nullableId(row.division_id) || !nullableId(row.target_staff_id)
          || !bit(row.active) || !integer(row.version)) throw new Error("native_staff_management_read_denied");
        const referenceId = await reference(source === "legacy_0061" ? "legacy" : "management", row.id);
        if (source === "management_0067" && expose) parentReferences.set(row.id, referenceId);
        const mapped = { id: referenceId, actorStaffId: owner, contractVersion: 1 as const, capability: row.capability as NativeStaffManagementCapability, effect: row.effect, scopeKind: row.scope_kind, businessAreaId: row.business_area_id, divisionId: row.division_id, targetStaffId: row.target_staff_id, active: row.active === 1 } as NativeStaffManagementPolicyRequest["delegations"][number];
        if (!expose) policyDelegations.push(mapped);
        else delegationEvidence.push({ referenceId, source, capability: mapped.capability, effect: mapped.effect, scopeKind: mapped.scopeKind, businessAreaId: mapped.businessAreaId, divisionId: mapped.divisionId, targetStaffId: mapped.targetStaffId, active: mapped.active, version: row.version });
      }
    }

    const ceilingEvidence: ManagementSnapshot["ceilings"][number][] = [];
    for (const row of ceilingRows) {
      const expectedParent = row.authority_domain === "directory" ? "staff.directory_grant.manage" : "staff.admin_delegation.manage";
      if (!identifier(row.id) || !identifier(row.parent_delegation_id) || !parentReferences.has(row.parent_delegation_id)
        || row.contract_version !== 1 || row.parent_capability !== expectedParent || row.parent_effect !== "allow" || row.parent_active !== 1
        || (row.authority_domain !== "directory" && row.authority_domain !== "staff_admin") || typeof row.capability !== "string"
        || !(row.authority_domain === "directory" ? DIRECTORY_CAPABILITIES : MANAGEMENT_CAPABILITIES).has(row.capability)
        || (row.effect !== "allow" && row.effect !== "deny") || !bit(row.grant_allow) || !bit(row.grant_deny)
        || (!row.grant_allow && !row.grant_deny) || !bit(row.operation_create) || !bit(row.operation_revoke)
        || (!row.operation_create && !row.operation_revoke) || !ceilingShape(row)
        || !nullableId(row.business_area_id) || !nullableId(row.division_id) || !nullableId(row.resource_id) || !nullableId(row.target_staff_id)
        || !bit(row.active) || !integer(row.version)) throw new Error("native_staff_management_read_denied");
      ceilingEvidence.push({ referenceId: await reference("ceiling", row.id), parentReferenceId: parentReferences.get(row.parent_delegation_id)!, domain: row.authority_domain, capability: row.capability, effect: row.effect, grantEffects: [row.grant_allow && "allow", row.grant_deny && "deny"].filter(Boolean) as ("allow" | "deny")[], operations: [row.operation_create && "create", row.operation_revoke && "revoke"].filter(Boolean) as ("create" | "revoke")[], scopeKind: row.scope_kind as typeof ceilingEvidence[number]["scopeKind"], businessAreaId: row.business_area_id, divisionId: row.division_id, resourceId: row.resource_id, targetStaffId: row.target_staff_id, active: row.active === 1, version: row.version });
    }
    const decision = evaluateNativeStaffManagementTargetScope({ actor: { staffId: request.actorStaffId, verifiedAccessSubject: request.verifiedAccessSubject, boundAccessSubject: String(actor.bound_access_subject), activeNativeAdmission: true }, capability: request.capability, target: { staffId: request.targetStaffId, memberships }, delegations: policyDelegations });
    if (!decision.allowed) throw new Error("native_staff_management_read_denied");
    const targetEvidence = { staffId: request.targetStaffId, admissionActive: target.admission_active === 1, admissionVersion: target.admission_version, profileVersion: target.profile_version };
    if (request.capability === "staff.profile.read") return freeze({ capability: request.capability, target: targetEvidence, authorization: { allowed: true as const }, scopedProfile: { loginEmail: target.login_email, displayName: target.display_name }, managementSnapshot: null });
    return freeze({ capability: request.capability, target: targetEvidence, authorization: { allowed: true as const }, scopedProfile: null, managementSnapshot: { partial: true as const, memberships: membershipEvidence, delegations: delegationEvidence, ceilings: ceilingEvidence } });
  } catch {
    throw new Error("native_staff_management_read_denied");
  }
}
