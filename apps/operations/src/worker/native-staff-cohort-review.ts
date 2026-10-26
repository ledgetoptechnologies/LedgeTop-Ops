import { createHash } from "node:crypto";

const REQUIRED_TABLES = Object.freeze([
  "staff_users", "staff_divisions", "divisions", "roles", "permissions", "role_permissions",
  "staff_role_assignments", "local_staff_role_assignments", "staff_permission_overrides",
  "native_staff_admissions", "native_staff_profiles", "native_directory_grants", "native_directory_grant_generations",
  "native_directory_grant_history", "native_project_grants", "native_project_grant_generations",
  "native_staff_management_delegations", "native_staff_bootstrap_approvals", "native_staff_bootstrap_receipts",
]);
const OPTIONAL_TABLES = Object.freeze([
  "native_staff_access_reconciliation", "native_staff_access_reconciliation_events", "native_staff_management_commands",
  "native_staff_lifecycle_fences", "native_staff_pending_onboarding",
]);
const OPTIONAL_VIEWS = Object.freeze(["native_staff_control_plane_candidates", "native_staff_lifecycle_control_plane_candidates"]);
const TABLES = Object.freeze([...REQUIRED_TABLES, ...OPTIONAL_TABLES]);
const CLIENT_REFERENCE_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  native_directory_grants: Object.freeze({ business_area_id: "business_area_ref_sha256", division_id: "division_ref_sha256", resource_id: "resource_ref_sha256" }),
  native_directory_grant_history: Object.freeze({ business_area_id: "business_area_ref_sha256", division_id: "division_ref_sha256", resource_id: "resource_ref_sha256" }),
  native_project_grants: Object.freeze({ business_area_id: "business_area_ref_sha256", division_id: "division_ref_sha256", external_project_id: "external_project_ref_sha256" }),
});
const MAX_ROWS_PER_TABLE = 20_000;
const MAX_PACKET_BYTES = 4 * 1024 * 1024;

type Row = Record<string, unknown>;
type D1Read = { results?: Row[]; success?: boolean; error?: string };
export class NativeStaffCohortReviewError extends Error {
  constructor(readonly status: 409 | 503, readonly code: "cohort_changed" | "review_unavailable") { super(code); }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const plainObject = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

function stableRows(table: string, value: unknown): Row[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS_PER_TABLE || value.some(row => !plainObject(row)))
    throw new NativeStaffCohortReviewError(503, "review_unavailable");
  const protectedColumns = CLIENT_REFERENCE_COLUMNS[table] ?? {};
  return value.map(row => Object.fromEntries(Object.keys(row).sort().map(key => {
    const outputKey = protectedColumns[key] ?? key, raw = row[key];
    return [outputKey, protectedColumns[key] && raw !== null && raw !== undefined ? sha256(canonical(raw)) : raw];
  })))
    .sort((left, right) => canonical(left) < canonical(right) ? -1 : canonical(left) > canonical(right) ? 1 : 0);
}

async function tableInventory(db: D1Database): Promise<{ names: Set<string>; tableNames: Set<string>; schema: Row[] }> {
  const result = await db.withSession("first-primary").prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE type IN ('table','view','trigger','index') ORDER BY type,name`).all<{ type: string; name: string; sql: string | null }>();
  const objects = result.results.map(({ type, name, sql }) => ({ type, name, definitionSha256: sql === null ? null : sha256(sql) }));
  return { names: new Set(objects.map(row => String(row.name))),
    tableNames: new Set(objects.filter(row => row.type === "table").map(row => String(row.name))),
    schema: [{ objectCount: objects.length, definitionsSha256: sha256(canonical(objects)) }] };
}

async function readSnapshot(db: D1Database): Promise<{ schema: Row[]; tables: Row }> {
  const inventory = await tableInventory(db);
  if (REQUIRED_TABLES.some(name => !inventory.tableNames.has(name))) throw new NativeStaffCohortReviewError(503, "review_unavailable");
  const presentTables = TABLES.filter(name => inventory.tableNames.has(name));
  const presentViews = OPTIONAL_VIEWS.filter(name => inventory.names.has(name));
  const present = [...presentTables, ...presentViews];
  const statements = present.map(name => db.withSession("first-primary").prepare(`SELECT * FROM ${name} LIMIT ${MAX_ROWS_PER_TABLE + 1}`));
  const results = await db.batch(statements) as D1Read[];
  if (results.length !== present.length || results.some(result => result.success === false || !Array.isArray(result.results)))
    throw new NativeStaffCohortReviewError(503, "review_unavailable");
  const state: Row = {};
  for (let index = 0; index < present.length; index += 1) state[present[index]!] = stableRows(present[index]!, results[index]!.results);
  for (const name of OPTIONAL_TABLES) if (!inventory.tableNames.has(name)) state[name] = null;
  for (const name of OPTIONAL_VIEWS) if (!inventory.names.has(name)) state[name] = null;
  return { schema: inventory.schema, tables: state };
}

function deriveCohort(tables: Row): Row[] {
  const staff = tables.staff_users as Row[], roles = tables.staff_role_assignments as Row[];
  const localRoles = tables.local_staff_role_assignments as Row[], overrides = tables.staff_permission_overrides as Row[];
  const admissions = tables.native_staff_admissions as Row[], profiles = tables.native_staff_profiles as Row[];
  const directoryGrants = tables.native_directory_grants as Row[], projectGrants = tables.native_project_grants as Row[];
  const delegations = (tables.native_staff_management_delegations as Row[] | null) ?? [];
  return staff.map(person => {
    const admission = admissions.find(row => row.staff_id === person.id) ?? null;
    const profile = profiles.find(row => row.staff_id === person.id) ?? null;
    let bridgeStatus = "matched";
    if (!admission) bridgeStatus = "not_admitted";
    else if (!profile) bridgeStatus = "profile_missing";
    else if (person.email !== profile.login_email || person.access_subject !== admission.bound_access_subject)
      bridgeStatus = "identity_mismatch";
    else if (person.display_name !== profile.display_name) bridgeStatus = "display_name_mismatch";
    else if (person.status !== (admission.active === 1 ? "active" : "inactive")) bridgeStatus = "status_mismatch";
    return {
      staffId: person.id,
      email: person.email,
      displayName: person.display_name,
      accessSubject: person.access_subject,
      status: person.status,
      staffRoleAssignments: roles.filter(row => row.staff_id === person.id),
      localStaffRoleAssignments: localRoles.filter(row => row.staff_id === person.id),
      directPermissionOverrides: overrides.filter(row => row.staff_id === person.id),
      admission,
      profile,
      bridgeStatus,
      directoryGrantCount: directoryGrants.filter(row => row.staff_id === person.id).length,
      projectGrantCount: projectGrants.filter(row => row.staff_id === person.id).length,
      managementDelegationCount: delegations.filter(row => row.actor_staff_id === person.id).length,
    };
  });
}

/**
 * Read a two-pass, read-only snapshot of existing Operations staff authority.
 * The resulting packet is explicitly advisory and has no executable fields.
 * It refuses if rows or schema change while the review is being prepared.
 */
export async function prepareNativeStaffCohortReview(db: D1Database, owner: { staffId: string }): Promise<{
  packet: Row; packetSha256: string;
}> {
  try {
    const before = await readSnapshot(db);
    const after = await readSnapshot(db);
    const beforeJson = canonical(before), afterJson = canonical(after);
    if (beforeJson !== afterJson) throw new NativeStaffCohortReviewError(409, "cohort_changed");
    const packet = {
      schemaVersion: 1,
      kind: "operations-current-staff-cohort-review-draft-v1",
      ownerStaffId: owner.staffId,
      snapshotSha256: sha256(beforeJson),
      schema: before.schema,
      tables: before.tables,
      cohort: deriveCohort(before.tables),
      status: "draft",
      advisory: true,
      executionAuthority: false,
      bootstrapApproval: false,
      acceptedReceipt: false,
      installerClaim: false,
    };
    const packetJson = canonical(packet);
    if (new TextEncoder().encode(packetJson).byteLength > MAX_PACKET_BYTES)
      throw new NativeStaffCohortReviewError(503, "review_unavailable");
    return { packet, packetSha256: sha256(packetJson) };
  } catch (error) {
    if (error instanceof NativeStaffCohortReviewError) throw error;
    throw new NativeStaffCohortReviewError(503, "review_unavailable");
  }
}

export function canonicalNativeStaffCohortReview(value: unknown): string { return canonical(value); }
