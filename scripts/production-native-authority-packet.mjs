import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKET_SCHEMA_VERSION = 1;
export const AUTHORITY_MIGRATIONS_TABLE = "production_native_authority_migrations";
const OUTPUT_ROOT = ".production-native-authority";
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const PACKET_ID = /^production-authority-[a-z0-9]+(?:-[a-z0-9]+){1,7}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PERMISSION_KEY = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const PERMISSION_OVERRIDE_KEYS = Object.freeze([
  "id", "permissionKey", "effect", "scope", "divisionId", "scopeKey", "createdBy",
]);
const CANONICAL_OPERATIONS = Object.freeze({
  count: 124,
  finalMigration: "0124_project_alpha_project_adoption_review_evidence.sql",
  namesSha256: "70aa4ced9990c013a6d9badde983eaeb76918ae3e0126e102ecaedb2325c86e1",
  contentsSha256: "3b0b07069ad42d8d22a925548ee4821b1c6718eeaaa0c03a39a695e18d08c323",
});

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const populated = value => typeof value === "string" && value.length > 0 && value === value.trim()
  && !/[\u0000-\u001f\u007f]/.test(value) && !/replace|placeholder|example[_-]?only/i.test(value);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function exactKeys(value, allowed, label, errors) {
  if (!plain(value)) { errors.push(`${label} must be an object`); return; }
  for (const key of allowed) if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`unexpected ${label}.${key}`);
}

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requireRegularFile(file, label) {
  const stat = lstat(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function requireRegularDirectory(directory, label) {
  const stat = lstat(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
}

function validateOutputAncestors(base, target) {
  const absoluteBase = path.resolve(base), absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteBase, absoluteTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("generated output escaped the repository");
  let current = absoluteBase;
  for (const part of path.dirname(relative).split(path.sep).filter(part => part && part !== ".")) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(`generated output ancestor ${path.relative(base, current)} must be a regular non-symlink directory`);
  }
}

function databaseIdentities(config) {
  if (!Array.isArray(config?.d1_databases)) return [];
  return config.d1_databases.map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id }))
    .sort((left, right) => String(left.binding).localeCompare(String(right.binding)));
}

function validateProductionIdentity(value, errors) {
  exactKeys(value, ["worker", "d1_databases"], "production", errors);
  if (!plain(value)) return;
  exactKeys(value.worker, ["name", "environment", "workers_dev"], "production.worker", errors);
  if (plain(value.worker)) {
    if (!populated(value.worker.name) || value.worker.name.length > 63)
      errors.push("production.worker.name must be a bounded non-placeholder string");
    if (value.worker.environment !== "production") errors.push("production.worker.environment must be production");
    if (value.worker.workers_dev !== false) errors.push("production.worker.workers_dev must be false");
  }
  if (!Array.isArray(value.d1_databases) || value.d1_databases.length === 0)
    errors.push("production.d1_databases must be a non-empty array");
  else {
    const bindings = new Set();
    for (const [index, database] of value.d1_databases.entries()) {
      const label = `production.d1_databases[${index}]`;
      exactKeys(database, ["binding", "database_name", "database_id"], label, errors);
      if (!plain(database)) continue;
      if (!populated(database.binding) || bindings.has(database.binding)) errors.push(`${label}.binding must be unique and non-placeholder`);
      bindings.add(database.binding);
      if (!populated(database.database_name) || database.database_name.length > 63)
        errors.push(`${label}.database_name must be a bounded non-placeholder string`);
      if (typeof database.database_id !== "string" || !DATABASE_ID.test(database.database_id))
        errors.push(`${label}.database_id must be a lowercase Cloudflare D1 UUID`);
    }
  }
}

export function validatePacketInput(input) {
  const errors = [];
  exactKeys(input, ["schemaVersion", "production", "packet"], "input", errors);
  if (!plain(input)) return errors;
  if (input.schemaVersion !== PACKET_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PACKET_SCHEMA_VERSION}`);
  validateProductionIdentity(input.production, errors);
  const packet = input.packet;
  exactKeys(packet, ["packetId", "mode", "staffId", "email", "displayName", "accessSubject", "issuedAt", "expiresAt", "reason", "permissionOverrides", "expected", "evidence"], "packet", errors);
  if (!plain(packet)) return errors;
  exactKeys(packet.expected, ["admissionVersion", "profileVersion", "directoryGrantVersion", "directoryGrantGeneration", "projectGrantVersion", "projectGrantGeneration"], "packet.expected", errors);
  exactKeys(packet.evidence, ["changeTicket", "reviewer", "bindingEvidenceSha256"], "packet.evidence", errors);
  if (!PACKET_ID.test(packet.packetId ?? "")) errors.push("packet.packetId must be a bounded production-authority identifier");
  if (packet.mode !== "create") errors.push("packet.mode must be create; production reactivation is not supported");
  if (typeof packet.staffId !== "string" || !/^staff-[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(packet.staffId))
    errors.push("packet.staffId must be a bounded reviewed staff identifier");
  if (typeof packet.email !== "string" || packet.email !== packet.email.trim().toLowerCase()
    || packet.email.length > 254 || !EMAIL.test(packet.email))
    errors.push("packet.email must be a normalized reviewed email address");
  if (!populated(packet.displayName) || packet.displayName.length > 160)
    errors.push("packet.displayName must be a bounded reviewed display name");
  if (!populated(packet.accessSubject) || !SUBJECT.test(packet.accessSubject)
    || String(packet.accessSubject).split(".").length === 3)
    errors.push("packet.accessSubject must be a reviewed opaque Access subject, not a token");
  if (!populated(packet.reason) || packet.reason.length > 500) errors.push("packet.reason must be a bounded non-placeholder string");
  if (!Array.isArray(packet.permissionOverrides)) errors.push("packet.permissionOverrides must be an array");
  else {
    const ids = new Set(), identities = new Set();
    for (const [index, override] of packet.permissionOverrides.entries()) {
      const label = `packet.permissionOverrides[${index}]`;
      exactKeys(override, PERMISSION_OVERRIDE_KEYS, label, errors);
      if (!plain(override)) continue;
      if (!populated(override.id) || override.id.length > 191 || ids.has(override.id))
        errors.push(`${label}.id must be unique, bounded, and non-placeholder`);
      ids.add(override.id);
      if (!populated(override.permissionKey) || override.permissionKey.length > 191 || !PERMISSION_KEY.test(override.permissionKey))
        errors.push(`${label}.permissionKey must be a bounded lowercase permission key`);
      if (!["allow", "deny"].includes(override.effect)) errors.push(`${label}.effect must be allow or deny`);
      if (!["global", "division", "assigned", "own"].includes(override.scope))
        errors.push(`${label}.scope must be global, division, assigned, or own`);
      if (override.scope === "division") {
        if (!populated(override.divisionId) || override.divisionId.length > 191)
          errors.push(`${label}.divisionId must be a bounded non-placeholder string for division scope`);
        if (override.scopeKey !== override.divisionId) errors.push(`${label}.scopeKey must equal divisionId for division scope`);
      } else {
        if (override.divisionId !== null) errors.push(`${label}.divisionId must be null outside division scope`);
        if (override.scopeKey !== override.scope) errors.push(`${label}.scopeKey must equal scope outside division scope`);
      }
      if (!populated(override.scopeKey) || override.scopeKey.length > 191)
        errors.push(`${label}.scopeKey must be a bounded non-placeholder string`);
      if (override.createdBy !== packet.staffId) errors.push(`${label}.createdBy must equal packet.staffId`);
      const identity = canonicalJson([override.permissionKey, override.effect, override.scope, override.scopeKey]);
      if (identities.has(identity)) errors.push(`${label} duplicates a database permission override identity`);
      identities.add(identity);
    }
  }
  for (const key of ["issuedAt", "expiresAt"]) {
    if (typeof packet[key] !== "string" || !EXACT_UTC.test(packet[key]) || new Date(packet[key]).toISOString() !== packet[key])
      errors.push(`packet.${key} must be an exact millisecond UTC timestamp`);
  }
  const issued = Date.parse(packet.issuedAt), expires = Date.parse(packet.expiresAt);
  if (Number.isFinite(issued) && Number.isFinite(expires) && (expires <= issued || expires - issued > 4 * 60 * 60 * 1000))
    errors.push("packet authority window must be positive and no longer than four hours");
  if (plain(packet.expected)) {
    for (const [key, value] of Object.entries(packet.expected))
      if (value !== 0) errors.push(`create mode requires packet.expected.${key} to be zero`);
  }
  if (plain(packet.evidence)) {
    for (const key of ["changeTicket", "reviewer"])
      if (!populated(packet.evidence[key]) || packet.evidence[key].length > 191)
        errors.push(`packet.evidence.${key} must be a bounded non-placeholder reference`);
    if (!SHA256.test(packet.evidence.bindingEvidenceSha256 ?? "")
      || /^([0-9a-f])\1{63}$/.test(packet.evidence.bindingEvidenceSha256 ?? ""))
      errors.push("packet.evidence.bindingEvidenceSha256 must be a nontrivial lowercase SHA-256");
  }
  return errors;
}

function canonicalJson(value) { return JSON.stringify(value); }
function canonicalPermissionOverrides(packet) {
  return packet.permissionOverrides.map(override => ({
    id: override.id,
    permissionKey: override.permissionKey,
    effect: override.effect,
    scope: override.scope,
    divisionId: override.divisionId,
    scopeKey: override.scopeKey,
    createdBy: override.createdBy,
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function permissionOverridesSummary(packet) {
  const canonical = canonicalJson(canonicalPermissionOverrides(packet));
  return { count: packet.permissionOverrides.length, sha256: sha256(canonical) };
}
function state(active) {
  return active
    ? { admissionVersion: 1, profileVersion: 1, directoryGrantActive: 1, directoryGrantVersion: 1,
      directoryGrantGeneration: 1, projectGrantActive: 1, projectGrantVersion: 1, projectGrantGeneration: 1 }
    : { admissionVersion: 2, profileVersion: 1, directoryGrantActive: 0, directoryGrantVersion: 2,
      directoryGrantGeneration: 2, projectGrantActive: 0, projectGrantVersion: 2, projectGrantGeneration: 2 };
}

function plan(packet, action, ids) {
  const base = {
    schemaVersion: PACKET_SCHEMA_VERSION,
    environment: "production",
    packetId: packet.packetId,
    action,
    mode: "create",
    staffId: packet.staffId,
    emailSha256: sha256(packet.email),
    displayNameSha256: sha256(packet.displayName),
    accessSubjectSha256: sha256(packet.accessSubject),
    permissionOverrides: permissionOverridesSummary(packet),
    directoryGrant: { id: ids.directoryGrant, permission: "directory.profile.edit", effect: "allow", scopeKind: "global" },
    projectGrant: { id: ids.projectGrant, capability: "project.shared.sync", effect: "allow", scopeKind: "global" },
    issuedAt: packet.issuedAt,
    expiresAt: packet.expiresAt,
    reason: packet.reason,
    evidence: packet.evidence,
  };
  if (action === "provision") return { ...base, expected: packet.expected, result: state(true) };
  return { ...base, provisionApprovalId: ids.provisionApproval, expected: state(true), result: state(false) };
}

function verification(packet) {
  return canonicalJson({
    schemaVersion: PACKET_SCHEMA_VERSION,
    changeTicket: packet.evidence.changeTicket,
    reviewer: packet.evidence.reviewer,
    bindingEvidenceSha256: packet.evidence.bindingEvidenceSha256,
    emailSha256: sha256(packet.email),
    accessSubjectSha256: sha256(packet.accessSubject),
    permissionOverrides: permissionOverridesSummary(packet),
  });
}

function guardTable(packetId, phase) {
  return `production_native_authority_guard_${sha256(`${packetId}:${phase}`).slice(0, 20)}`;
}
function guardInsert(table, expression) {
  return `INSERT INTO ${table}(ok) SELECT CASE WHEN (${expression}) THEN 1 ELSE 0 END;`;
}
function canonicalLedger(names) {
  const list = sqlString(JSON.stringify(names));
  return `(SELECT count(*) FROM d1_migrations)=${names.length}
    AND NOT EXISTS(SELECT 1 FROM json_each(${list}) expected
      WHERE NOT EXISTS(SELECT 1 FROM d1_migrations applied WHERE applied.name=expected.value))
    AND NOT EXISTS(SELECT 1 FROM d1_migrations applied
      WHERE NOT EXISTS(SELECT 1 FROM json_each(${list}) expected WHERE expected.value=applied.name))`;
}

function minimalNativeAuthorityAbsent(staff) {
  return `NOT EXISTS(SELECT 1 FROM native_staff_target_memberships WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_admin_delegations WHERE actor_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations WHERE actor_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_integration_control_grants WHERE actor_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_integration_management_grants WHERE actor_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_workforce_authority_grants WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_workforce_grant_manager_delegations WHERE actor_staff_id=${staff} OR target_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations WHERE actor_staff_id=${staff} OR beneficiary_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations WHERE actor_staff_id=${staff} OR beneficiary_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_delegations WHERE actor_staff_id=${staff} OR beneficiary_staff_id=${staff})`;
}

function noPendingActorWork(staff) {
  return `NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=${staff} OR target_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=${staff} OR target_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox outbox
      JOIN native_project_command_proofs proof ON proof.command_id=outbox.command_id
      WHERE proof.actor_staff_id=${staff} AND outbox.state IN ('pending','leased'))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox
      WHERE json_extract(origin_snapshot_json,'$.actorId')=${staff} AND state IN ('pending','leased'))`;
}

function permissionOverridesState(packet) {
  const staff = sqlString(packet.staffId);
  const expected = sqlString(canonicalJson(canonicalPermissionOverrides(packet)));
  const match = `actual.id=json_extract(expected.value,'$.id')
        AND actual.permission_key=json_extract(expected.value,'$.permissionKey')
        AND actual.effect=json_extract(expected.value,'$.effect')
        AND actual.scope=json_extract(expected.value,'$.scope')
        AND actual.division_id IS json_extract(expected.value,'$.divisionId')
        AND actual.scope_key=json_extract(expected.value,'$.scopeKey')
        AND actual.created_by=json_extract(expected.value,'$.createdBy')`;
  return `(SELECT count(*) FROM staff_permission_overrides WHERE staff_id=${staff})=${packet.permissionOverrides.length}
    AND NOT EXISTS(SELECT 1 FROM json_each(${expected}) expected
      WHERE NOT EXISTS(SELECT 1 FROM staff_permission_overrides actual WHERE actual.staff_id=${staff} AND ${match}))
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides actual WHERE actual.staff_id=${staff}
      AND NOT EXISTS(SELECT 1 FROM json_each(${expected}) expected WHERE ${match}))`;
}

function verifiedOwner(packet) {
  const staff = sqlString(packet.staffId), email = sqlString(packet.email), subject = sqlString(packet.accessSubject);
  return `(SELECT count(*) FROM staff_users WHERE id=${staff} AND email=${email}
      AND display_name=${sqlString(packet.displayName)} AND status='active' AND access_subject=${subject})=1
    AND NOT EXISTS(SELECT 1 FROM staff_users WHERE id<>${staff} AND (lower(email)=${email} OR access_subject=${subject}))
    AND (SELECT count(*) FROM staff_role_assignments WHERE staff_id=${staff})=1
    AND (SELECT count(*) FROM staff_role_assignments WHERE staff_id=${staff} AND role_id='role-owner'
      AND scope='global' AND division_id IS NULL AND scope_key='global')=1
    AND EXISTS(SELECT 1 FROM role_permissions WHERE role_id='role-owner' AND permission_key='integrations.manage')
    AND ${permissionOverridesState(packet)}
    AND NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id<>${staff} AND bound_access_subject=${subject})
    AND NOT EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id<>${staff} AND login_email=${email})`;
}

function approvalSql(packet, ids, action, canonicalPlan, planSha, verificationJson, verificationSha) {
  const approvalId = action === "provision" ? ids.provisionApproval : ids.revokeApproval;
  return `INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,
  approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,
  independent_binding_verification_sha256,issued_by_staff_id,issued_by_access_subject,issued_at,expires_at)
VALUES(${sqlString(approvalId)},${sqlString(canonicalPlan)},${sqlString(planSha)},${sqlString(packet.staffId)},${sqlString(packet.accessSubject)},
  ${sqlString(verificationJson)},${sqlString(verificationSha)},${sqlString(packet.staffId)},${sqlString(packet.accessSubject)},
  ${sqlString(packet.issuedAt)},${sqlString(packet.expiresAt)});`;
}

function receiptSql(packet, ids, action, canonicalPlan, planSha, verificationJson, verificationSha, result) {
  const approvalId = action === "provision" ? ids.provisionApproval : ids.revokeApproval;
  const commandId = action === "provision" ? ids.provisionCommand : ids.revokeCommand;
  const resultJson = canonicalJson(result), resultSha = sha256(resultJson);
  return `INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
  canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,
  result_json,result_sha256)
VALUES(${sqlString(commandId)},${sqlString(approvalId)},${sqlString(packet.staffId)},${sqlString(packet.accessSubject)},
  ${sqlString(canonicalPlan)},${sqlString(planSha)},${sqlString(verificationJson)},${sqlString(verificationSha)},
  ${sqlString(resultJson)},${sqlString(resultSha)});`;
}

function directoryState(staff, ids, active, version, generation) {
  return `(SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff}
      AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='global' AND active=${active}
      AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL AND granted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_directory_grant_generations WHERE staff_id=${staff} AND generation=${generation})
    AND (SELECT count(*) FROM native_directory_grant_history WHERE grant_id=${sqlString(ids.directoryGrant)})=${version}
    AND EXISTS(SELECT 1 FROM native_directory_grant_history WHERE grant_id=${sqlString(ids.directoryGrant)}
      AND grant_version=${version} AND staff_id=${staff} AND permission='directory.profile.edit' AND effect='allow'
      AND scope_kind='global' AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL
      AND active=${active} AND grant_generation=${generation})`;
}

function projectState(staff, ids, active, version, generation) {
  return `(SELECT count(*) FROM native_project_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_project_grants WHERE id=${sqlString(ids.projectGrant)} AND staff_id=${staff}
      AND capability='project.shared.sync' AND effect='allow' AND scope_kind='global' AND active=${active}
      AND business_area_id IS NULL AND division_id IS NULL AND external_project_id IS NULL
      AND version=${version} AND granted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff} AND generation=${generation})`;
}

function provisionSql(packet, ids, names, migrationNames) {
  const table = guardTable(packet.packetId, "provision"), staff = sqlString(packet.staffId);
  const canonicalPlan = canonicalJson(plan(packet, "provision", ids)), planSha = sha256(canonicalPlan);
  const verificationJson = verification(packet), verificationSha = sha256(verificationJson);
  const result = { schemaVersion: PACKET_SCHEMA_VERSION, action: "provision", packetId: packet.packetId,
    staffId: packet.staffId, directoryGrantId: ids.directoryGrant, projectGrantId: ids.projectGrant, ...state(true) };
  const absent = `NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=${staff} OR id=${sqlString(ids.directoryGrant)})
    AND NOT EXISTS(SELECT 1 FROM native_directory_grant_generations WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_directory_grant_history WHERE staff_id=${staff} OR grant_id=${sqlString(ids.directoryGrant)})
    AND NOT EXISTS(SELECT 1 FROM native_project_grants WHERE staff_id=${staff} OR id=${sqlString(ids.projectGrant)})
    AND NOT EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=${staff} OR issued_by_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE operator_staff_id=${staff})`;
  const final = `(SELECT count(*) FROM native_staff_admissions WHERE staff_id=${staff}
      AND bound_access_subject=${sqlString(packet.accessSubject)} AND active=1 AND version=1 AND admitted_by=${staff})=1
    AND (SELECT count(*) FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sqlString(packet.email)}
      AND display_name=${sqlString(packet.displayName)} AND version=1)=1
    AND ${directoryState(staff, ids, 1, 1, 1)}
    AND ${projectState(staff, ids, 1, 1, 1)}
    AND ${permissionOverridesState(packet)}
    AND ${minimalNativeAuthorityAbsent(staff)}
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.provisionCommand)}
      AND approval_id=${sqlString(ids.provisionApproval)} AND canonical_plan_sha256=${sqlString(planSha)})`;
  return `PRAGMA foreign_keys = ON;
-- Generated production-only native authority provision packet. No route or live apply is included.
CREATE TABLE ${table}(ok INTEGER NOT NULL CHECK(ok=1));
${guardInsert(table, `${canonicalLedger(names)}
    AND (SELECT count(*) FROM ${AUTHORITY_MIGRATIONS_TABLE})=0
    AND NOT EXISTS(SELECT 1 FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name IN (${sqlString(migrationNames.provision)},${sqlString(migrationNames.revoke)}))
    AND ${verifiedOwner(packet)}
    AND ${absent}
    AND ${minimalNativeAuthorityAbsent(staff)}
    AND ${noPendingActorWork(staff)}
    AND ${sqlString(packet.issuedAt)}<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND ${sqlString(packet.expiresAt)}>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)}
${approvalSql(packet, ids, "provision", canonicalPlan, planSha, verificationJson, verificationSha)}
INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
VALUES(${staff},${sqlString(packet.accessSubject)},1,${staff});
INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
VALUES(${staff},${sqlString(packet.email)},${sqlString(packet.displayName)});
INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
VALUES(${sqlString(ids.directoryGrant)},${staff},'directory.profile.edit','allow','global',1,${staff});
INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,granted_by)
VALUES(${sqlString(ids.projectGrant)},${staff},'project.shared.sync','allow','global',1,${staff});
${receiptSql(packet, ids, "provision", canonicalPlan, planSha, verificationJson, verificationSha, result)}
${guardInsert(table, final)}
DROP TABLE ${table};
`;
}

function revokeSql(packet, ids, names, migrationNames, provisionPlanSha) {
  const table = guardTable(packet.packetId, "revoke"), staff = sqlString(packet.staffId);
  const canonicalPlan = canonicalJson(plan(packet, "revoke", ids)), planSha = sha256(canonicalPlan);
  const verificationJson = verification(packet), verificationSha = sha256(verificationJson);
  const result = { schemaVersion: PACKET_SCHEMA_VERSION, action: "revoke", packetId: packet.packetId,
    staffId: packet.staffId, directoryGrantId: ids.directoryGrant, projectGrantId: ids.projectGrant, ...state(false) };
  const precondition = `${canonicalLedger(names)}
    AND (SELECT count(*) FROM ${AUTHORITY_MIGRATIONS_TABLE})=1
    AND EXISTS(SELECT 1 FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name=${sqlString(migrationNames.provision)})
    AND NOT EXISTS(SELECT 1 FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name=${sqlString(migrationNames.revoke)})
    AND ${verifiedOwner(packet)}
    AND (SELECT count(*) FROM native_staff_admissions WHERE staff_id=${staff}
      AND bound_access_subject=${sqlString(packet.accessSubject)} AND active=1 AND version=1 AND admitted_by=${staff})=1
    AND (SELECT count(*) FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sqlString(packet.email)}
      AND display_name=${sqlString(packet.displayName)} AND version=1)=1
    AND ${directoryState(staff, ids, 1, 1, 1)}
    AND ${projectState(staff, ids, 1, 1, 1)}
    AND ${minimalNativeAuthorityAbsent(staff)}
    AND (SELECT count(*) FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=${staff} OR issued_by_staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sqlString(ids.provisionApproval)}
      AND canonical_plan_sha256=${sqlString(provisionPlanSha)} AND revoked_at IS NULL)
    AND (SELECT count(*) FROM native_staff_bootstrap_receipts WHERE operator_staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.provisionCommand)}
      AND approval_id=${sqlString(ids.provisionApproval)} AND canonical_plan_sha256=${sqlString(provisionPlanSha)})
    AND ${noPendingActorWork(staff)}`;
  const final = `(SELECT count(*) FROM native_staff_admissions WHERE staff_id=${staff}
      AND bound_access_subject=${sqlString(packet.accessSubject)} AND active=0 AND version=2 AND admitted_by=${staff})=1
    AND (SELECT count(*) FROM native_staff_profiles WHERE staff_id=${staff} AND version=1)=1
    AND ${directoryState(staff, ids, 0, 2, 2)}
    AND EXISTS(SELECT 1 FROM native_directory_grant_history WHERE grant_id=${sqlString(ids.directoryGrant)}
      AND grant_version=1 AND active=1 AND grant_generation=1)
    AND ${projectState(staff, ids, 0, 2, 2)}
    AND ${permissionOverridesState(packet)}
    AND ${minimalNativeAuthorityAbsent(staff)}
    AND NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs WHERE actor_staff_id=${staff})
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sqlString(ids.provisionApproval)} AND revoked_at IS NOT NULL)
    AND (SELECT count(*) FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=${staff} OR issued_by_staff_id=${staff})=2
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sqlString(ids.revokeApproval)}
      AND canonical_plan_sha256=${sqlString(planSha)} AND revoked_at IS NULL)
    AND (SELECT count(*) FROM native_staff_bootstrap_receipts WHERE operator_staff_id=${staff})=2
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.revokeCommand)}
      AND approval_id=${sqlString(ids.revokeApproval)} AND canonical_plan_sha256=${sqlString(planSha)})`;
  return `PRAGMA foreign_keys = ON;
-- Generated production-only native authority revocation packet. Durable history is preserved.
CREATE TABLE ${table}(ok INTEGER NOT NULL CHECK(ok=1));
${guardInsert(table, precondition)}
${approvalSql(packet, ids, "revoke", canonicalPlan, planSha, verificationJson, verificationSha)}
UPDATE native_directory_grants SET active=0
WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff} AND active=1;
UPDATE native_project_grants SET active=0,version=version+1
WHERE id=${sqlString(ids.projectGrant)} AND staff_id=${staff} AND active=1 AND version=1;
UPDATE native_staff_admissions SET active=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE staff_id=${staff} AND active=1 AND version=1;
UPDATE native_staff_bootstrap_approvals SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE approval_id=${sqlString(ids.provisionApproval)} AND revoked_at IS NULL;
${receiptSql(packet, ids, "revoke", canonicalPlan, planSha, verificationJson, verificationSha, result)}
${guardInsert(table, final)}
DROP TABLE ${table};
`;
}

function canonicalOperations(base, expectedProduction) {
  const appDir = path.join(base, "apps", "operations"), sourceConfigPath = path.join(appDir, "wrangler.jsonc");
  requireRegularFile(sourceConfigPath, "Operations production config");
  const config = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
  if (config.name !== expectedProduction.worker.name
    || config.vars?.ENVIRONMENT !== expectedProduction.worker.environment
    || config.workers_dev !== expectedProduction.worker.workers_dev)
    throw new Error("authority source must be the exact production Operations config");
  const expectedDatabases = databaseIdentities(expectedProduction);
  if (!isDeepStrictEqual(databaseIdentities(config), expectedDatabases))
    throw new Error("authority source must contain the complete pinned production D1 inventory");
  const selected = config.d1_databases.find(item => item.binding === "OPS_DB");
  const expectedSelected = expectedProduction.d1_databases.find(item => item.binding === "OPS_DB");
  if (!selected || !expectedSelected
    || selected.database_name !== expectedSelected.database_name
    || selected.database_id !== expectedSelected.database_id
    || selected.migrations_dir !== "migrations" || Object.hasOwn(selected, "migrations_pattern")
    || Object.hasOwn(selected, "migrations_table"))
    throw new Error("authority source must use the exact canonical production Operations migration binding");
  const directory = path.join(appDir, "migrations");
  requireRegularDirectory(directory, "Operations canonical migrations");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) if (entry.name.endsWith(".sql") && (!entry.isFile() || entry.isSymbolicLink()))
    throw new Error(`Operations canonical migration ${entry.name} must be a regular non-symlink file`);
  const names = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql"))
    .map(entry => entry.name).sort();
  if (names.length !== CANONICAL_OPERATIONS.count || names.at(-1) !== CANONICAL_OPERATIONS.finalMigration
    || sha256(names.join("\n")) !== CANONICAL_OPERATIONS.namesSha256)
    throw new Error("authority source must be the exact complete 124-file Operations chain through 0124");
  const contents = names.map(name => {
    const file = path.join(directory, name);
    requireRegularFile(file, `Operations canonical migration ${name}`);
    return `${name}\0${sha256(fs.readFileSync(file, "utf8"))}`;
  });
  const chainSha256 = sha256(contents.join("\n"));
  if (chainSha256 !== CANONICAL_OPERATIONS.contentsSha256)
    throw new Error("Operations canonical migration contents changed from the reviewed production chain");
  return { config, selected, chainSha256, names };
}

function migrationConfig(source, selected, packetId, action) {
  return {
    $schema: source.$schema,
    name: source.name,
    main: source.main,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    workers_dev: false,
    d1_databases: [{
      binding: "OPS_DB",
      database_name: selected.database_name,
      database_id: selected.database_id,
      migrations_dir: `${OUTPUT_ROOT}/${packetId}/${action}`,
      migrations_table: AUTHORITY_MIGRATIONS_TABLE,
    }],
  };
}

export function buildAuthorityArtifacts(base, input, phase) {
  const errors = validatePacketInput(input);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!["provision", "revoke"].includes(phase)) throw new Error("phase must be provision or revoke");
  const { config, selected, chainSha256, names } = canonicalOperations(base, input.production);
  const packet = structuredClone(input.packet);
  const ids = {
    directoryGrant: `production-directory-profile-edit:${packet.staffId}`,
    projectGrant: `production-project-sync:${packet.staffId}`,
    provisionApproval: `${packet.packetId}:provision:approval`,
    provisionCommand: `${packet.packetId}:provision:command`,
    revokeApproval: `${packet.packetId}:revoke:approval`,
    revokeCommand: `${packet.packetId}:revoke:command`,
  };
  for (const [label, value] of Object.entries(ids))
    if (value.length > 191) throw new Error(`${label} exceeds the database identifier limit`);
  const provisionName = `9000_${packet.packetId}_provision.sql`;
  const revokeName = `9001_${packet.packetId}_revoke.sql`;
  const migrationNames = { provision: provisionName, revoke: revokeName };
  const provisionPlan = canonicalJson(plan(packet, "provision", ids));
  const provision = provisionSql(packet, ids, names, migrationNames);
  const revoke = revokeSql(packet, ids, names, migrationNames, sha256(provisionPlan));
  const configs = {
    provision: migrationConfig(config, selected, packet.packetId, "provision"),
    revoke: migrationConfig(config, selected, packet.packetId, "revoke"),
  };
  const identity = { staffId: packet.staffId, emailSha256: sha256(packet.email), displayNameSha256: sha256(packet.displayName),
    accessSubjectSha256: sha256(packet.accessSubject) };
  const permissionOverrides = permissionOverridesSummary(packet);
  const baseManifest = {
    schemaVersion: PACKET_SCHEMA_VERSION,
    environment: "production",
    packetId: packet.packetId,
    mode: "create",
    databaseBinding: selected.binding,
    databaseName: selected.database_name,
    databaseId: selected.database_id,
    migrationsTable: AUTHORITY_MIGRATIONS_TABLE,
    canonicalOperationsLedger: { count: names.length, finalMigration: names.at(-1), chainSha256 },
    identity,
    permissionOverrides,
    directoryGrant: { id: ids.directoryGrant, permission: "directory.profile.edit", effect: "allow", scopeKind: "global" },
    projectGrant: { id: ids.projectGrant, capability: "project.shared.sync", effect: "allow", scopeKind: "global" },
    issuedAt: packet.issuedAt,
    expiresAt: packet.expiresAt,
    reasonSha256: sha256(packet.reason),
  };
  const manifests = {
    provision: { ...baseManifest, phase: "provision", migration: { name: provisionName, sha256: sha256(provision) },
      expected: packet.expected, result: state(true) },
    revoke: { ...baseManifest, phase: "revoke", migration: { name: revokeName, sha256: sha256(revoke) },
      expected: state(true), result: state(false) },
  };
  return { packet, ids, configs,
    provision: { name: provisionName, sql: provision, manifest: manifests.provision },
    revoke: { name: revokeName, sql: revoke, manifest: manifests.revoke }, phase };
}

function expectedFiles(base, artifact) {
  const directory = path.join(base, "apps", "operations", OUTPUT_ROOT, artifact.packet.packetId);
  const files = new Map([
    [path.join(base, "apps", "operations", `wrangler.production.native-authority.${artifact.packet.packetId}.provision.json`),
      `${JSON.stringify(artifact.configs.provision, null, 2)}\n`],
    [path.join(directory, "provision", artifact.provision.name), artifact.provision.sql],
    [path.join(directory, "provision.manifest.json"), `${JSON.stringify(artifact.provision.manifest, null, 2)}\n`],
  ]);
  if (artifact.phase === "revoke") {
    files.set(path.join(base, "apps", "operations", `wrangler.production.native-authority.${artifact.packet.packetId}.revoke.json`),
      `${JSON.stringify(artifact.configs.revoke, null, 2)}\n`);
    files.set(path.join(directory, "revoke", artifact.revoke.name), artifact.revoke.sql);
    files.set(path.join(directory, "revoke.manifest.json"), `${JSON.stringify(artifact.revoke.manifest, null, 2)}\n`);
  }
  return files;
}

function generatedErrors(base, artifact, requireAll) {
  const errors = [], expected = expectedFiles(base, artifact);
  for (const [file, content] of expected) {
    try { validateOutputAncestors(base, file); }
    catch (error) { errors.push(error.message); continue; }
    const stat = lstat(file);
    if (!stat) { if (requireAll) errors.push(`${path.relative(base, file)} is missing`); }
    else if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`${path.relative(base, file)} must be a regular non-symlink file`);
    else if (fs.readFileSync(file, "utf8") !== content) errors.push(`${path.relative(base, file)} is stale or was edited`);
  }
  for (const action of ["provision", ...(artifact.phase === "revoke" ? ["revoke"] : [])]) {
    const migrations = path.join(base, "apps", "operations", OUTPUT_ROOT, artifact.packet.packetId, action);
    const stat = lstat(migrations);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) errors.push(`${path.relative(base, migrations)} must be a regular non-symlink directory`);
      else {
        const actual = fs.readdirSync(migrations, { withFileTypes: true });
        for (const entry of actual) if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".sql"))
          errors.push(`${path.relative(base, path.join(migrations, entry.name))} is not an allowed migration file`);
        const names = actual.filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql"))
          .map(entry => entry.name).sort();
        if (!isDeepStrictEqual(names, [artifact[action].name]))
          errors.push(`${path.relative(base, migrations)} has missing or unexpected migrations`);
      }
    } else if (requireAll) errors.push(`${path.relative(base, migrations)} is missing`);
  }
  return errors;
}

export function validateGeneratedAuthority(base, artifact) { return generatedErrors(base, artifact, true); }
export function writeGeneratedAuthority(base, artifact) {
  const errors = generatedErrors(base, artifact, false);
  if (errors.length) throw new Error(`generated authority artifacts are invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  const written = [];
  for (const [file, content] of expectedFiles(base, artifact)) {
    validateOutputAncestors(base, file);
    if (lstat(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    validateOutputAncestors(base, file);
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    written.push(path.relative(base, file));
  }
  return written;
}

function parseArguments(argv) {
  let mode = "", phase = "", valuesFile = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (["--write", "--check"].includes(argv[index]) && !mode) mode = argv[index];
    else if (argv[index] === "--phase" && argv[index + 1]) phase = argv[++index];
    else if (argv[index] === "--values" && argv[index + 1]) valuesFile = argv[++index];
    else throw new Error(`unknown or incomplete argument ${argv[index]}`);
  }
  if (!mode || !["provision", "revoke"].includes(phase) || !valuesFile)
    throw new Error("usage: node scripts/production-native-authority-packet.mjs --write|--check --phase provision|revoke --values <ignored-json>");
  return { mode, phase, valuesFile };
}

export function run(argv = process.argv.slice(2), base = root) {
  const { mode, phase, valuesFile } = parseArguments(argv);
  const absoluteValues = path.resolve(base, valuesFile);
  requireRegularFile(absoluteValues, "authority values file");
  const artifact = buildAuthorityArtifacts(base, JSON.parse(fs.readFileSync(absoluteValues, "utf8")), phase);
  if (mode === "--check") {
    const errors = validateGeneratedAuthority(base, artifact);
    if (errors.length) throw new Error(`production native authority artifacts are invalid:\n${errors.map(error => `- ${error}`).join("\n")}`);
    console.log(`Production native authority ${phase} artifacts are current. No SQL was applied.`);
    return [];
  }
  const written = writeGeneratedAuthority(base, artifact);
  console.log(`Wrote ${written.length} ignored production native authority ${phase} artifacts. No SQL was applied.`);
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Production native authority packet failed: ${error.message}`); process.exitCode = 1; }
}
