import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";
import { RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 } from "./staging-relationship-generation-recovery-authority-v184.mjs";
import { validateClosedRelationshipRecoveryLineageV184 } from "./staging-project-business-area-authority-v184.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

export { validateClosedRelationshipRecoveryLineageV184 };

const fail = message => { throw Error(`project-organization-authority-v184: ${message}`); };
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GRANT = ["id", "staff_id", "permission", "effect", "scope_kind", "business_area_id", "division_id", "resource_id", "active", "granted_by", "created_at"];
const HISTORY = ["grant_id", "grant_version", "staff_id", "permission", "effect", "scope_kind", "business_area_id", "division_id", "resource_id", "active", "grant_generation", "recorded_at"];
const GENERATION = ["staff_id", "generation", "updated_at"];
const APPROVAL = ["approval_id", "canonical_plan_json", "canonical_plan_sha256", "approved_operator_staff_id", "approved_operator_access_subject", "independent_binding_verification_json", "independent_binding_verification_sha256", "issued_by_staff_id", "issued_by_access_subject", "issued_at", "expires_at", "revoked_at"];
const RECEIPT = ["command_id", "approval_id", "operator_staff_id", "operator_access_subject", "canonical_plan_json", "canonical_plan_sha256", "independent_binding_verification_json", "independent_binding_verification_sha256", "result_json", "result_sha256", "executed_at"];
const PROJECT_GRANT = ["id", "staff_id", "capability", "effect", "scope_kind", "business_area_id", "division_id", "external_project_id", "active", "version", "granted_by", "created_at"];
const ROLE = ["id", "staff_id", "role_id", "scope", "division_id", "scope_key", "created_by", "created_at"];
const STAFF = ["id", "status", "access_subject"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN = Object.freeze({ count: 184, final: "0184_project_alpha_directory_relationship_generation_recovery.sql", names: "c6d567a0c4d9450cc867d99db6188dc54e7a827e581059d4714e7bf55b66bc15", contents: "52a45f212ce83e639a9ac3b9753a7122a56d897c187bf4dcbc741b4a059948cc" });

export const PROJECT_ORGANIZATION_AUTHORITY_V184_PURPOSE = "synthetic-staging-organization-project-shared-sync-v184";
export const PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET = Object.freeze({
  staffId: "staff-beau-koltz",
  businessAreaId: "drone-services-staging",
  businessAreaName: "Drone services staging acceptance",
});

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

function plain(value, label = "input") {
  if (Array.isArray(value)) { value.forEach((item, index) => plain(item, `${label}[${index}]`)); return; }
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} plain object required`);
    for (const [key, item] of Object.entries(value)) plain(item, `${label}.${key}`);
  }
}
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !same(Object.keys(value).sort(), [...keys].sort())) fail(`${label} shape`);
}
function exactRows(values, columns, label) {
  if (!Array.isArray(values)) fail(`${label} array required`);
  values.forEach(value => exact(value, columns, label));
}
function timestamp(value, label) {
  if (typeof value !== "string" || !TS.test(value) || new Date(value).toISOString() !== value) fail(`${label} timestamp`);
  return Date.parse(value);
}
function migrations(root) {
  const directory = path.join(root, "apps", "operations", "migrations");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const contents = names.map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("regular migration required");
    return `${name}\0${sha(fs.readFileSync(file))}`;
  });
  if (names.length !== CHAIN.count || names.at(-1) !== CHAIN.final || sha(names.join("\n")) !== CHAIN.names || sha(contents.join("\n")) !== CHAIN.contents) fail("exact reviewed 0184 migration chain required");
  return names;
}
const guard = (condition, params = [], label = "state") => ({ sql: `SELECT CASE WHEN (${condition}) THEN 1 ELSE json('project-organization-authority-v184-${label}-guard-failed') END verified`, params });
const insert = (table, row, dbClock = false) => {
  const keys = Object.keys(row).filter(key => !dbClock || key !== "executed_at");
  return { sql: `INSERT INTO ${table}(${keys.join(",")}${dbClock ? ",executed_at" : ""}) VALUES(${keys.map(() => "?").join(",")}${dbClock ? ",strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ""})`, params: keys.map(key => row[key]) };
};
const rows = (table, columns, values, predicate, params, label) => [
  guard(`(SELECT count(*) FROM ${table} WHERE ${predicate})=?`, [...params, values.length], `${label}-count`),
  ...values.map(value => guard(`EXISTS(SELECT 1 FROM ${table} WHERE ${columns.map(key => `${key} IS ?`).join(" AND ")})`, columns.map(key => value[key]), `${label}-row`)),
];

export function compileProjectOrganizationAuthorityV184(raw, { root = ROOT } = {}) {
  plain(raw);
  const input = structuredClone(raw), hasReadback = Object.hasOwn(raw, "provisionReadback");
  exact(input, ["schemaVersion", "purpose", "staging", "migrationNames", "target", "staff", "roles", "admission", "profile", "businessArea", "projectGeneration", "projectGrants", "recoveryLineage", "approval", ...(hasReadback ? ["provisionReadback"] : [])], "input");
  if (input.schemaVersion !== 1 || input.purpose !== PROJECT_ORGANIZATION_AUTHORITY_V184_PURPOSE || !same(input.staging, STAGING_TARGET)
    || !same(input.migrationNames, migrations(root)) || !same(input.target, PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET)) fail("exact staging target required");
  exact(input.staff, STAFF, "staff");
  if (input.staff.id !== input.target.staffId || input.staff.status !== "active" || input.staff.access_subject !== input.admission?.bound_access_subject) fail("active pinned staff required");
  if (!Array.isArray(input.roles) || !input.roles.length) fail("complete current administrator roles required");
  input.roles.forEach(role => exact(role, ROLE, "role"));
  if (new Set(input.roles.map(role => role.id)).size !== input.roles.length || input.roles.some(role => role.staff_id !== input.target.staffId)
    || !input.roles.some(role => ["role-owner", "role-admin"].includes(role.role_id) && role.scope === "global" && role.division_id === null && role.scope_key === "global")) fail("complete current administrator roles required");
  exact(input.admission, ["staff_id", "bound_access_subject", "active", "admitted_by", "created_at", "updated_at", "version"], "admission");
  exact(input.profile, ["staff_id", "login_email", "display_name", "version", "created_at", "updated_at"], "profile");
  if (input.admission.staff_id !== input.target.staffId || input.admission.active !== 1 || input.profile.staff_id !== input.target.staffId
    || !Number.isSafeInteger(input.admission.version) || input.admission.version < 1 || !Number.isSafeInteger(input.profile.version) || input.profile.version < 1) fail("current native actor required");
  exact(input.businessArea, ["id", "name", "active"], "business area");
  if (input.businessArea.id !== input.target.businessAreaId || input.businessArea.name !== input.target.businessAreaName || input.businessArea.active !== 1) fail("exact active organization area required");
  exact(input.projectGeneration, ["staff_id", "generation"], "project generation");
  if (input.projectGeneration.staff_id !== input.target.staffId || !Number.isSafeInteger(input.projectGeneration.generation) || input.projectGeneration.generation < 0) fail("project generation");
  exactRows(input.projectGrants, PROJECT_GRANT, "project grant");
  if (new Set(input.projectGrants.map(grant => grant.id)).size !== input.projectGrants.length
    || input.projectGrants.some(grant => grant.staff_id !== input.target.staffId || grant.capability !== "project.shared.sync"
      || !["allow", "deny"].includes(grant.effect) || ![0, 1].includes(grant.active) || !Number.isSafeInteger(grant.version)
      || grant.version < 1 || !TS.test(grant.created_at))) fail("complete project grant snapshot required");
  for (const grant of input.projectGrants) {
    const tuple = grant.scope_kind === "global" ? grant.business_area_id === null && grant.division_id === null && grant.external_project_id === null
      : grant.scope_kind === "business_area" ? typeof grant.business_area_id === "string" && grant.division_id === null && grant.external_project_id === null
        : grant.scope_kind === "division" ? typeof grant.business_area_id === "string" && typeof grant.division_id === "string" && grant.external_project_id === null
          : grant.scope_kind === "exact_project" ? grant.business_area_id === null && grant.division_id === null && typeof grant.external_project_id === "string" : false;
    if (!tuple) fail("project grant scope tuple");
  }
  if (input.projectGrants.some(grant => grant.effect === "deny" && grant.active === 1 && (grant.scope_kind === "global"
    || grant.scope_kind === "business_area" && grant.business_area_id === input.target.businessAreaId))) fail("applicable project deny");
  const closed = validateClosedRelationshipRecoveryLineageV184(input.recoveryLineage, { root });
  const recoveryProvision = input.recoveryLineage.provisionArtifact, recoveryRevoke = input.recoveryLineage.revokeArtifact;
  if (recoveryProvision.input.schemaVersion !== 2 || recoveryRevoke.input.schemaVersion !== 2
    || !same(recoveryProvision.input.target, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2)
    || !same(recoveryRevoke.input.target, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2)) fail("exact paired v2 recovery lineage required");
  exact(input.approval, ["provisionApprovalId", "provisionCommandId", "revokeApprovalId", "revokeCommandId", "grantId", "issuedAt", "expiresAt"], "approval");
  const ids = [input.approval.provisionApprovalId, input.approval.provisionCommandId, input.approval.revokeApprovalId, input.approval.revokeCommandId, input.approval.grantId];
  if (!ids.every(value => UUID.test(value)) || new Set(ids).size !== 5 || input.projectGrants.some(grant => grant.id === input.approval.grantId)) fail("fresh approval ids required");
  const issued = timestamp(input.approval.issuedAt, "issuedAt"), expires = timestamp(input.approval.expiresAt, "expiresAt");
  if (expires <= issued || expires - issued > 14_400_000) fail("bounded approval window");

  const lineageReferences = { schemaVersion: 2, provisionArtifactSha256: sha(json(input.recoveryLineage.provisionArtifact)), revokeArtifactSha256: sha(json(input.recoveryLineage.revokeArtifact)), approvalsSha256: sha(json(input.recoveryLineage.approvals)), receiptsSha256: sha(json(input.recoveryLineage.receipts)), directoryGrantsSha256: sha(json(input.recoveryLineage.directoryGrants)), directoryGrantHistorySha256: sha(json(input.recoveryLineage.directoryGrantHistory)), directoryGrantGenerationSha256: sha(json(input.recoveryLineage.directoryGrantGeneration)), closedRecovery: closed };
  const planInput = { ...input, recoveryLineage: lineageReferences };
  delete planInput.provisionReadback;
  const plan = json(planInput), planHash = sha(plan);
  const verification = json({ staging: input.staging, target: input.target, migrationChain: CHAIN, recoveryLineage: lineageReferences });
  const verificationHash = sha(verification);
  if (Buffer.byteLength(plan) > 262_144 || Buffer.byteLength(verification) > 262_144) fail("bounded ledger evidence exceeded");
  const metadata = phase => {
    const provision = phase === "provision";
    const approval = { approval_id: provision ? input.approval.provisionApprovalId : input.approval.revokeApprovalId, canonical_plan_json: plan, canonical_plan_sha256: planHash, approved_operator_staff_id: input.target.staffId, approved_operator_access_subject: input.admission.bound_access_subject, independent_binding_verification_json: verification, independent_binding_verification_sha256: verificationHash, issued_by_staff_id: input.target.staffId, issued_by_access_subject: input.admission.bound_access_subject, issued_at: input.approval.issuedAt, expires_at: input.approval.expiresAt, revoked_at: null };
    const result = json({ phase, grantId: input.approval.grantId, generation: input.projectGeneration.generation + (provision ? 1 : 2), active: provision ? 1 : 0 });
    return { approval, receipt: { command_id: provision ? input.approval.provisionCommandId : input.approval.revokeCommandId, approval_id: approval.approval_id, operator_staff_id: input.target.staffId, operator_access_subject: input.admission.bound_access_subject, canonical_plan_json: plan, canonical_plan_sha256: planHash, independent_binding_verification_json: verification, independent_binding_verification_sha256: verificationHash, result_json: result, result_sha256: sha(result), executed_at: input.approval.issuedAt } };
  };
  const provisionMetadata = metadata("provision"), revokeMetadata = metadata("revoke");
  let readback = null;
  if (hasReadback) {
    exact(input.provisionReadback, ["approval", "receipt", "grant"], "provision readback");
    exact(input.provisionReadback.approval, APPROVAL, "provision readback approval");
    exact(input.provisionReadback.receipt, RECEIPT, "provision readback receipt");
    exact(input.provisionReadback.grant, PROJECT_GRANT, "provision readback grant");
    const receipt = input.provisionReadback.receipt, grant = input.provisionReadback.grant;
    const executed = timestamp(receipt.executed_at, "provision receipt executed_at"), created = timestamp(grant.created_at, "provision grant created_at");
    const expectedReceipt = { ...provisionMetadata.receipt, executed_at: receipt.executed_at };
    const expectedGrant = { id: input.approval.grantId, staff_id: input.target.staffId, capability: "project.shared.sync", effect: "allow", scope_kind: "business_area", business_area_id: input.target.businessAreaId, division_id: null, external_project_id: null, active: 1, version: 1, granted_by: input.target.staffId, created_at: grant.created_at };
    if (!same(input.provisionReadback.approval, provisionMetadata.approval) || !same(receipt, expectedReceipt) || !same(grant, expectedGrant)
      || executed < issued || executed >= expires || created < issued || created > executed) fail("exact bounded provision readback required");
    readback = input.provisionReadback;
  }

  const lineage = input.recoveryLineage;
  const common = [
    ...rows("d1_migrations", ["name"], input.migrationNames.map(name => ({ name })), "1", [], "migrations"),
    ...rows("staff_users", STAFF, [input.staff], "id=?", [input.target.staffId], "staff"),
    ...rows("staff_role_assignments", ROLE, input.roles, "staff_id=?", [input.target.staffId], "roles"),
    ...rows("native_staff_admissions", Object.keys(input.admission), [input.admission], "staff_id=?", [input.target.staffId], "admission"),
    ...rows("native_staff_profiles", Object.keys(input.profile), [input.profile], "staff_id=?", [input.target.staffId], "profile"),
    ...rows("native_business_areas", Object.keys(input.businessArea), [input.businessArea], "id=?", [input.target.businessAreaId], "area"),
    ...rows("native_staff_bootstrap_approvals", APPROVAL, lineage.approvals, "approval_id IN (?,?)", lineage.approvals.map(value => value.approval_id), "closed-recovery-approvals"),
    ...rows("native_staff_bootstrap_receipts", RECEIPT, lineage.receipts, "command_id IN (?,?)", lineage.receipts.map(value => value.command_id), "closed-recovery-receipts"),
    ...rows("native_directory_grants", GRANT, lineage.directoryGrants, "staff_id=?", [input.target.staffId], "closed-recovery-grants"),
    ...rows("native_directory_grant_history", HISTORY, lineage.directoryGrantHistory, "staff_id=?", [input.target.staffId], "closed-recovery-history"),
    ...rows("native_directory_grant_generations", GENERATION, [lineage.directoryGrantGeneration], "staff_id=?", [input.target.staffId], "closed-recovery-generation"),
  ];
  const quiet = guard("NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=? OR target_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=? OR target_staff_id=?) AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?) AND NOT EXISTS(SELECT 1 FROM operations_directory_relationship_write_fences WHERE actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased')) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox WHERE state IN ('pending','leased')) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_recovery_outbox WHERE state IN ('pending','leased')) AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox WHERE state IN ('pending','leased'))", [input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId], "work");
  const snapshot = [
    ...rows("native_project_grants", PROJECT_GRANT, input.projectGrants, "staff_id=?", [input.target.staffId], "project-grants"),
    guard("EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=? AND generation=?)", [input.target.staffId, input.projectGeneration.generation], "generation"),
  ];
  const provisionStatements = [
    ...common, ...snapshot, quiet,
    guard("julianday(?)<=julianday('now') AND julianday(?)>julianday('now')", [input.approval.issuedAt, input.approval.expiresAt], "expiry"),
    guard("NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=? AND revoked_at IS NULL AND julianday(expires_at)>julianday('now') AND approval_id<>?)", [input.target.staffId, closed.revokeApprovalId], "open-window"),
    insert("native_staff_bootstrap_approvals", provisionMetadata.approval),
    { sql: "INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,'project.shared.sync','allow','business_area',?,1,?)", params: [input.approval.grantId, input.target.staffId, input.target.businessAreaId, input.target.staffId] },
    guard("changes()=1", [], "grant-cas"),
    guard("EXISTS(SELECT 1 FROM native_project_grants WHERE id=? AND staff_id=? AND capability='project.shared.sync' AND effect='allow' AND scope_kind='business_area' AND business_area_id=? AND division_id IS NULL AND external_project_id IS NULL AND active=1 AND version=1 AND granted_by=?) AND (SELECT generation FROM native_project_grant_generations WHERE staff_id=?)=?", [input.approval.grantId, input.target.staffId, input.target.businessAreaId, input.target.staffId, input.target.staffId, input.projectGeneration.generation + 1], "poststate"),
    insert("native_staff_bootstrap_receipts", provisionMetadata.receipt, true),
  ];
  const revokeStatements = readback ? [
    ...common, quiet,
    guard("julianday('now')>=julianday(?)", [readback.receipt.executed_at], "revoke-chronology"),
    guard("(SELECT count(*) FROM native_project_grants WHERE staff_id=?)=?", [input.target.staffId, input.projectGrants.length + 1], "revoke-grant-count"),
    ...input.projectGrants.map(grant => guard(`EXISTS(SELECT 1 FROM native_project_grants WHERE ${PROJECT_GRANT.map(key => `${key} IS ?`).join(" AND ")})`, PROJECT_GRANT.map(key => grant[key]), "revoke-unrelated-grant")),
    ...rows("native_project_grants", PROJECT_GRANT, [readback.grant], "id=?", [input.approval.grantId], "paired-grant"),
    guard("(SELECT generation FROM native_project_grant_generations WHERE staff_id=?)=?", [input.target.staffId, input.projectGeneration.generation + 1], "revoke-generation"),
    ...rows("native_staff_bootstrap_approvals", APPROVAL, [readback.approval], "approval_id=?", [provisionMetadata.approval.approval_id], "paired-approval"),
    ...rows("native_staff_bootstrap_receipts", RECEIPT, [readback.receipt], "command_id=?", [provisionMetadata.receipt.command_id], "paired-receipt"),
    insert("native_staff_bootstrap_approvals", revokeMetadata.approval),
    { sql: "UPDATE native_project_grants SET active=0,version=version+1 WHERE id=? AND staff_id=? AND active=1 AND version=1", params: [input.approval.grantId, input.target.staffId] },
    guard("changes()=1", [], "grant-cas"),
    { sql: "UPDATE native_staff_bootstrap_approvals SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE approval_id=? AND revoked_at IS NULL", params: [provisionMetadata.approval.approval_id] },
    guard("changes()=1", [], "approval-cas"),
    guard("EXISTS(SELECT 1 FROM native_project_grants WHERE id=? AND active=0 AND version=2) AND (SELECT generation FROM native_project_grant_generations WHERE staff_id=?)=?", [input.approval.grantId, input.target.staffId, input.projectGeneration.generation + 2], "poststate"),
    insert("native_staff_bootstrap_receipts", revokeMetadata.receipt, true),
  ] : null;
  return Object.freeze({ schemaVersion: 1, input, planHash, provision: { ...provisionMetadata, ...(!readback ? { statements: provisionStatements } : {}) }, ...(revokeStatements ? { revoke: { ...revokeMetadata, statements: revokeStatements } } : {}), trustedApplyOnly: true });
}
