import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_APPS } from "./staging-bootstrap.mjs";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKET_SCHEMA_VERSION = 2;
export const AUTHORITY_MIGRATIONS_TABLE = "staging_native_authority_migrations";
const OUTPUT_ROOT = ".staging-native-authority";
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const IDENTIFIER = /^staging-[a-z0-9]+(?:[a-z0-9._:-]*[a-z0-9])?$/;
const PACKET_ID = /^staging-authority-[a-z0-9]+(?:-[a-z0-9]+){1,7}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const canonicalPeople = new Set([
  "beaukoltz@ledgetopdroneservices.com", "kstirn@ledgetopdroneservices.com",
  "staff-beau-koltz", "staff-kollins-stirn", "initial-beau-koltz", "initial-kollins-stirn",
]);

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;
const populated = value => typeof value === "string" && value.length > 0 && value === value.trim()
  && !/[\u0000-\u001f\u007f]/.test(value) && !/replace|placeholder|example[_-]?only/i.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

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

export function validatePacketInput(input) {
  const errors = [];
  exactKeys(input, ["schemaVersion", "packet"], "input", errors);
  if (!plain(input)) return errors;
  if (input.schemaVersion !== PACKET_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PACKET_SCHEMA_VERSION}`);
  const packet = input.packet;
  exactKeys(packet, ["packetId", "mode", "staffId", "email", "displayName", "accessSubject", "issuedAt", "expiresAt", "reason", "expected", "evidence"], "packet", errors);
  if (!plain(packet)) return errors;
  exactKeys(packet.expected, ["admissionVersion", "profileVersion", "grantVersion", "grantGeneration"], "packet.expected", errors);
  exactKeys(packet.evidence, ["changeTicket", "reviewer", "bindingEvidenceSha256"], "packet.evidence", errors);
  if (!PACKET_ID.test(packet.packetId ?? "")) errors.push("packet.packetId must be a bounded staging-authority identifier");
  if (!['create', 'reactivate'].includes(packet.mode)) errors.push("packet.mode must be create or reactivate");
  if (!IDENTIFIER.test(packet.staffId ?? "") || String(packet.staffId).length > 120) errors.push("packet.staffId must be a staging-prefixed identifier");
  if (typeof packet.email !== "string" || packet.email !== packet.email.trim().toLowerCase()
    || !EMAIL.test(packet.email) || packet.email.length > 254 || !packet.email.includes("staging"))
    errors.push("packet.email must be a normalized synthetic staging email");
  if (!populated(packet.displayName) || packet.displayName.length > 160 || !/staging/i.test(packet.displayName))
    errors.push("packet.displayName must visibly identify staging");
  if (!populated(packet.accessSubject) || !SUBJECT.test(packet.accessSubject)
    || String(packet.accessSubject).split(".").length === 3) errors.push("packet.accessSubject must be a reviewed opaque Access subject, not a token");
  if (!populated(packet.reason) || packet.reason.length > 500) errors.push("packet.reason must be a bounded non-placeholder string");
  for (const key of ["issuedAt", "expiresAt"]) {
    if (typeof packet[key] !== "string" || !EXACT_UTC.test(packet[key]) || new Date(packet[key]).toISOString() !== packet[key])
      errors.push(`packet.${key} must be an exact millisecond UTC timestamp`);
  }
  const issued = Date.parse(packet.issuedAt), expires = Date.parse(packet.expiresAt);
  if (Number.isFinite(issued) && Number.isFinite(expires) && (expires <= issued || expires - issued > 4 * 60 * 60 * 1000))
    errors.push("packet authority window must be positive and no longer than four hours");
  if (plain(packet.expected)) {
    for (const [key, value] of Object.entries(packet.expected))
      if (!Number.isSafeInteger(value) || value < 0) errors.push(`packet.expected.${key} must be a nonnegative safe integer`);
    const expected = packet.expected;
    if (packet.mode === "create" && [expected.admissionVersion, expected.profileVersion, expected.grantVersion, expected.grantGeneration].some(value => value !== 0))
      errors.push("create mode requires every expected version to be zero");
    if (packet.mode === "reactivate" && [expected.admissionVersion, expected.profileVersion, expected.grantVersion, expected.grantGeneration].some(value => value < 1))
      errors.push("reactivate mode requires positive expected versions");
  }
  if (plain(packet.evidence)) {
    for (const key of ["changeTicket", "reviewer"])
      if (!populated(packet.evidence[key]) || packet.evidence[key].length > 191) errors.push(`packet.evidence.${key} must be a bounded non-placeholder reference`);
    if (!SHA256.test(packet.evidence.bindingEvidenceSha256 ?? "") || /^([0-9a-f])\1{63}$/.test(packet.evidence.bindingEvidenceSha256 ?? ""))
      errors.push("packet.evidence.bindingEvidenceSha256 must be a nontrivial lowercase SHA-256");
  }
  for (const value of [packet.staffId, packet.email].filter(value => typeof value === "string"))
    if (canonicalPeople.has(value.toLowerCase())) errors.push("canonical human identities are forbidden");
  return errors;
}

function canonicalJson(value) { return JSON.stringify(value); }
function versionState(packet) {
  const expected = packet.expected;
  return packet.mode === "create"
    ? { admissionBefore: 0, profile: 1, grantBefore: 0, generationBefore: 0, admissionActive: 1, grantActive: 1, generationActive: 1 }
    : { admissionBefore: expected.admissionVersion, profile: expected.profileVersion, grantBefore: expected.grantVersion,
      generationBefore: expected.grantGeneration, admissionActive: expected.admissionVersion + 1,
      grantActive: expected.grantVersion + 1, generationActive: expected.grantGeneration + 1 };
}

function plan(packet, action, ids, versions) {
  const base = {
    schemaVersion: PACKET_SCHEMA_VERSION, environment: "staging", packetId: packet.packetId, action, mode: packet.mode,
    staffId: packet.staffId, emailSha256: sha256(packet.email), displayNameSha256: sha256(packet.displayName),
    accessSubjectSha256: sha256(packet.accessSubject),
    grant: { id: ids.grant, capability: "project.shared.sync", effect: "allow", scopeKind: "global" },
    directoryGrant: { id: ids.directoryGrant, permission: "directory.profile.edit", effect: "allow", scopeKind: "global" },
    issuedAt: packet.issuedAt, expiresAt: packet.expiresAt, reason: packet.reason,
    evidence: packet.evidence,
  };
  if (action === "provision") return { ...base, expected: packet.expected,
    result: { admissionVersion: versions.admissionActive, profileVersion: versions.profile,
      grantVersion: versions.grantActive, grantGeneration: versions.generationActive, directoryGrantActive: 1 } };
  return { ...base, provisionApprovalId: ids.provisionApproval,
    expected: { admissionVersion: versions.admissionActive, profileVersion: versions.profile,
      grantVersion: versions.grantActive, grantGeneration: versions.generationActive, directoryGrantActive: 1 },
    result: { admissionVersion: versions.admissionActive + 1, profileVersion: versions.profile,
      grantVersion: versions.grantActive + 1, grantGeneration: versions.generationActive + 1, directoryGrantActive: 0 } };
}

function verification(packet) {
  return canonicalJson({ schemaVersion: PACKET_SCHEMA_VERSION, changeTicket: packet.evidence.changeTicket, reviewer: packet.evidence.reviewer,
    bindingEvidenceSha256: packet.evidence.bindingEvidenceSha256, emailSha256: sha256(packet.email),
    accessSubjectSha256: sha256(packet.accessSubject) });
}

function guardTable(packetId, phase) { return `staging_native_authority_guard_${sha256(`${packetId}:${phase}`).slice(0, 20)}`; }
function guardInsert(table, expression) { return `INSERT INTO ${table}(ok) SELECT CASE WHEN (${expression}) THEN 1 ELSE 0 END;` }
function canonicalLedger(names) {
  const list = sqlString(JSON.stringify(names));
  return `(SELECT count(*) FROM d1_migrations)=${names.length}
    AND NOT EXISTS(SELECT 1 FROM json_each(${list}) expected
      WHERE NOT EXISTS(SELECT 1 FROM d1_migrations applied WHERE applied.name=expected.value))
    AND NOT EXISTS(SELECT 1 FROM d1_migrations applied
      WHERE NOT EXISTS(SELECT 1 FROM json_each(${list}) expected WHERE expected.value=applied.name))`;
}

function minimalAuthorityAbsent(staff) {
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

function commonPrecondition(packet, ids) {
  const staff = sqlString(packet.staffId), email = sqlString(packet.email), subject = sqlString(packet.accessSubject);
  return `(SELECT count(*) FROM staff_users WHERE id=${staff} AND email=${email} AND display_name=${sqlString(packet.displayName)}
      AND status='active' AND access_subject=${subject})=1
    AND NOT EXISTS(SELECT 1 FROM staff_users WHERE id<>${staff} AND (lower(email)=${email} OR access_subject=${subject}))
    AND EXISTS(SELECT 1 FROM staff_role_assignments WHERE staff_id=${staff} AND role_id IN ('role-owner','role-admin') AND scope='global')
    AND EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=${staff} AND assignment.scope='global' AND permission.permission_key='integrations.manage')
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides WHERE staff_id=${staff} AND permission_key='integrations.manage' AND effect='deny' AND scope='global')
    AND NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id<>${staff} AND bound_access_subject=${subject})
    AND NOT EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id<>${staff} AND login_email=${email})
    AND NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=${staff} OR target_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=${staff} OR target_staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id IN (${sqlString(ids.provisionApproval)},${sqlString(ids.revokeApproval)}))
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id IN (${sqlString(ids.provisionCommand)},${sqlString(ids.revokeCommand)}))
    AND ${minimalAuthorityAbsent(staff)}`;
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

function provisionSql(packet, ids, versions, names, migrationNames) {
  const table = guardTable(packet.packetId, "provision"), staff = sqlString(packet.staffId);
  const canonicalPlan = canonicalJson(plan(packet, "provision", ids, versions)), planSha = sha256(canonicalPlan);
  const verificationJson = verification(packet), verificationSha = sha256(verificationJson);
  const createState = `NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=${staff} OR id=${sqlString(ids.directoryGrant)})
    AND NOT EXISTS(SELECT 1 FROM native_project_grants WHERE staff_id=${staff} OR id=${sqlString(ids.grant)})
    AND NOT EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff})`;
  const reactivateState = `EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND bound_access_subject=${sqlString(packet.accessSubject)}
      AND active=0 AND version=${versions.admissionBefore} AND admitted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sqlString(packet.email)}
      AND display_name=${sqlString(packet.displayName)} AND version=${versions.profile})
    AND (SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff}
      AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='global'
      AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL
      AND active=0 AND granted_by=${staff})
    AND (SELECT count(*) FROM native_project_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_project_grants WHERE id=${sqlString(ids.grant)} AND staff_id=${staff}
      AND capability='project.shared.sync' AND effect='allow' AND scope_kind='global'
      AND business_area_id IS NULL AND division_id IS NULL AND external_project_id IS NULL
      AND active=0 AND version=${versions.grantBefore} AND granted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff} AND generation=${versions.generationBefore})`;
  const mutations = packet.mode === "create" ? `INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
VALUES(${staff},${sqlString(packet.accessSubject)},1,${staff});
INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
VALUES(${staff},${sqlString(packet.email)},${sqlString(packet.displayName)});
INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
VALUES(${sqlString(ids.directoryGrant)},${staff},'directory.profile.edit','allow','global',1,${staff});
INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,granted_by)
VALUES(${sqlString(ids.grant)},${staff},'project.shared.sync','allow','global',1,${staff});`
    : `UPDATE native_staff_admissions SET active=1,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE staff_id=${staff} AND active=0 AND version=${versions.admissionBefore};
UPDATE native_directory_grants SET active=1
WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff} AND permission='directory.profile.edit'
  AND effect='allow' AND scope_kind='global' AND business_area_id IS NULL AND division_id IS NULL
  AND resource_id IS NULL AND active=0 AND granted_by=${staff};
UPDATE native_project_grants SET active=1,version=version+1
WHERE id=${sqlString(ids.grant)} AND staff_id=${staff} AND active=0 AND version=${versions.grantBefore};`;
  const result = { schemaVersion: PACKET_SCHEMA_VERSION, action: "provision", packetId: packet.packetId, staffId: packet.staffId,
    grantId: ids.grant, directoryGrantId: ids.directoryGrant, admissionVersion: versions.admissionActive,
    profileVersion: versions.profile, grantVersion: versions.grantActive,
    grantGeneration: versions.generationActive, directoryGrantActive: 1 };
  const final = `(SELECT count(*) FROM native_staff_admissions WHERE staff_id=${staff} AND bound_access_subject=${sqlString(packet.accessSubject)}
      AND active=1 AND version=${versions.admissionActive} AND admitted_by=${staff})=1
    AND (SELECT count(*) FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sqlString(packet.email)}
      AND display_name=${sqlString(packet.displayName)} AND version=${versions.profile})=1
    AND (SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff}
      AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='global' AND active=1
      AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL AND granted_by=${staff})
    AND (SELECT count(*) FROM native_project_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_project_grants WHERE id=${sqlString(ids.grant)} AND staff_id=${staff}
      AND capability='project.shared.sync' AND effect='allow' AND scope_kind='global' AND active=1
      AND version=${versions.grantActive} AND granted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff} AND generation=${versions.generationActive})
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.provisionCommand)}
      AND approval_id=${sqlString(ids.provisionApproval)} AND canonical_plan_sha256=${sqlString(planSha)})`;
  return `PRAGMA foreign_keys = ON;
-- Generated staging-only authority packet. Apply only through the dedicated Wrangler migration config.
CREATE TABLE ${table}(ok INTEGER NOT NULL CHECK(ok=1));
${guardInsert(table, `${canonicalLedger(names)}
    AND NOT EXISTS(SELECT 1 FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name IN (${sqlString(migrationNames.provision)},${sqlString(migrationNames.revoke)}))
    AND ${commonPrecondition(packet, ids)} AND ${packet.mode === "create" ? createState : reactivateState}
    AND ${sqlString(packet.issuedAt)}<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND ${sqlString(packet.expiresAt)}>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)}
${approvalSql(packet, ids, "provision", canonicalPlan, planSha, verificationJson, verificationSha)}
${mutations}
${receiptSql(packet, ids, "provision", canonicalPlan, planSha, verificationJson, verificationSha, result)}
${guardInsert(table, final)}
DROP TABLE ${table};
`;
}

function revokeSql(packet, ids, versions, provision, names, migrationNames) {
  const table = guardTable(packet.packetId, "revoke"), staff = sqlString(packet.staffId);
  const canonicalPlan = canonicalJson(plan(packet, "revoke", ids, versions)), planSha = sha256(canonicalPlan);
  const verificationJson = verification(packet), verificationSha = sha256(verificationJson);
  const result = { schemaVersion: PACKET_SCHEMA_VERSION, action: "revoke", packetId: packet.packetId, staffId: packet.staffId,
    grantId: ids.grant, directoryGrantId: ids.directoryGrant, admissionVersion: versions.admissionActive + 1,
    profileVersion: versions.profile, grantVersion: versions.grantActive + 1,
    grantGeneration: versions.generationActive + 1, directoryGrantActive: 0 };
  const precondition = `${canonicalLedger(names)}
    AND EXISTS(SELECT 1 FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name=${sqlString(migrationNames.provision)})
    AND NOT EXISTS(SELECT 1 FROM ${AUTHORITY_MIGRATIONS_TABLE} WHERE name=${sqlString(migrationNames.revoke)})
    AND (SELECT count(*) FROM staff_users WHERE id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND bound_access_subject=${sqlString(packet.accessSubject)}
      AND active=1 AND version=${versions.admissionActive} AND admitted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sqlString(packet.email)}
      AND display_name=${sqlString(packet.displayName)} AND version=${versions.profile})
    AND (SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff}
      AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='global' AND active=1
      AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL AND granted_by=${staff})
    AND (SELECT count(*) FROM native_project_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_project_grants WHERE id=${sqlString(ids.grant)} AND staff_id=${staff}
      AND capability='project.shared.sync' AND effect='allow' AND scope_kind='global' AND active=1
      AND version=${versions.grantActive} AND granted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff} AND generation=${versions.generationActive})
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sqlString(ids.provisionApproval)}
      AND canonical_plan_sha256=${sqlString(provision.planSha)} AND revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.provisionCommand)}
      AND approval_id=${sqlString(ids.provisionApproval)} AND canonical_plan_sha256=${sqlString(provision.planSha)})
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sqlString(ids.revokeApproval)})
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.revokeCommand)})
    AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox outbox JOIN native_project_command_proofs proof ON proof.command_id=outbox.command_id
      WHERE proof.actor_staff_id=${staff} AND outbox.state IN ('pending','leased'))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox
      WHERE json_extract(origin_snapshot_json,'$.actorId')=${staff} AND state IN ('pending','leased'))`;
  const final = `EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND bound_access_subject=${sqlString(packet.accessSubject)}
      AND active=0 AND version=${versions.admissionActive + 1} AND admitted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND version=${versions.profile})
    AND (SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff})=1
    AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff}
      AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='global' AND active=0
      AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL AND granted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_project_grants WHERE id=${sqlString(ids.grant)} AND staff_id=${staff}
      AND active=0 AND version=${versions.grantActive + 1})
    AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=${staff} AND generation=${versions.generationActive + 1})
    AND NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs WHERE actor_staff_id=${staff})
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sqlString(ids.provisionApproval)} AND revoked_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sqlString(ids.revokeCommand)}
      AND approval_id=${sqlString(ids.revokeApproval)} AND canonical_plan_sha256=${sqlString(planSha)})`;
  return `PRAGMA foreign_keys = ON;
-- Generated staging-only revocation packet. It preserves durable authority history.
CREATE TABLE ${table}(ok INTEGER NOT NULL CHECK(ok=1));
${guardInsert(table, precondition)}
${approvalSql(packet, ids, "revoke", canonicalPlan, planSha, verificationJson, verificationSha)}
UPDATE native_directory_grants SET active=0
WHERE id=${sqlString(ids.directoryGrant)} AND staff_id=${staff} AND permission='directory.profile.edit'
  AND effect='allow' AND scope_kind='global' AND business_area_id IS NULL AND division_id IS NULL
  AND resource_id IS NULL AND active=1 AND granted_by=${staff};
UPDATE native_project_grants SET active=0,version=version+1
WHERE id=${sqlString(ids.grant)} AND staff_id=${staff} AND active=1 AND version=${versions.grantActive};
UPDATE native_staff_admissions SET active=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE staff_id=${staff} AND active=1 AND version=${versions.admissionActive};
UPDATE native_staff_bootstrap_approvals SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE approval_id=${sqlString(ids.provisionApproval)} AND revoked_at IS NULL;
${receiptSql(packet, ids, "revoke", canonicalPlan, planSha, verificationJson, verificationSha, result)}
${guardInsert(table, final)}
DROP TABLE ${table};
`;
}

function canonicalOperations(base) {
  const appDir = path.join(base, "apps", "operations"), sourceConfigPath = path.join(appDir, "wrangler.staging.json");
  requireRegularFile(sourceConfigPath, "Operations staging config");
  const config = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
  const expected = STAGING_INVENTORY.operations;
  if (config.name !== "ledgetop-ops-staging" || config.account_id !== STAGING_ACCOUNT_ID || config.vars?.ENVIRONMENT !== "staging")
    throw new Error("authority source must be the exact staging Operations config");
  if (!isDeepStrictEqual(databaseIdentities(config), databaseIdentities(expected)))
    throw new Error("authority source must contain the complete reviewed staging D1 inventory");
  const selected = config.d1_databases.find(item => item.binding === "OPS_DB");
  const expectedDb = expected.d1_databases.find(item => item.binding === "OPS_DB");
  if (!selected || selected.database_name !== "ltds-ops-staging" || selected.database_id !== expectedDb?.database_id
    || selected.migrations_dir !== "migrations" || Object.hasOwn(selected, "migrations_pattern") || Object.hasOwn(selected, "migrations_table"))
    throw new Error("authority source must use the exact canonical Operations migration binding");
  const directory = path.join(appDir, "migrations");
  requireRegularDirectory(directory, "Operations canonical migrations");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) if (entry.name.endsWith(".sql") && (!entry.isFile() || entry.isSymbolicLink()))
    throw new Error(`Operations canonical migration ${entry.name} must be a regular non-symlink file`);
  const names = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql")).map(entry => entry.name).sort();
  const contract = BOOTSTRAP_APPS.operations;
  if (names.length !== contract.migrationCount || sha256(names.join("\n")) !== contract.migrationNamesSha256)
    throw new Error(`authority source must be the exact complete ${contract.migrationCount}-file Operations chain`);
  const contents = names.map(name => {
    const file = path.join(directory, name); requireRegularFile(file, `Operations canonical migration ${name}`);
    return `${name}\0${sha256(fs.readFileSync(file, "utf8"))}`;
  });
  const chainSha256 = sha256(contents.join("\n"));
  if (chainSha256 !== contract.migrationContentsSha256) throw new Error("Operations canonical migration contents changed");
  return { config, selected, chainSha256, names };
}

export function buildAuthorityArtifacts(base, input, phase) {
  const errors = validatePacketInput(input);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!['provision', 'revoke'].includes(phase)) throw new Error("phase must be provision or revoke");
  const { config, selected, chainSha256, names } = canonicalOperations(base);
  const packet = structuredClone(input.packet), versions = versionState(packet);
  const ids = {
    grant: `staging-project-sync:${packet.staffId}`,
    directoryGrant: `staging-directory-profile-edit:${packet.staffId}`,
    provisionApproval: `${packet.packetId}:provision:approval`, provisionCommand: `${packet.packetId}:provision:command`,
    revokeApproval: `${packet.packetId}:revoke:approval`, revokeCommand: `${packet.packetId}:revoke:command`,
  };
  for (const [label, value] of Object.entries(ids)) if (value.length > 191) throw new Error(`${label} exceeds the database identifier limit`);
  const provisionName = `9000_${packet.packetId}_provision.sql`, revokeName = `9001_${packet.packetId}_revoke.sql`;
  const migrationNames = { provision: provisionName, revoke: revokeName };
  const provision = provisionSql(packet, ids, versions, names, migrationNames);
  const provisionPlan = canonicalJson(plan(packet, "provision", ids, versions));
  const revoke = revokeSql(packet, ids, versions, { planSha: sha256(provisionPlan) }, names, migrationNames);
  const configs = {};
  for (const action of ["provision", "revoke"]) {
    const outputConfig = structuredClone(config);
    const target = outputConfig.d1_databases.find(item => item.binding === "OPS_DB");
    target.migrations_dir = `${OUTPUT_ROOT}/${packet.packetId}/${action}`;
    target.migrations_table = AUTHORITY_MIGRATIONS_TABLE;
    configs[action] = outputConfig;
  }
  const identity = { staffId: packet.staffId, emailSha256: sha256(packet.email), displayNameSha256: sha256(packet.displayName),
    accessSubjectSha256: sha256(packet.accessSubject) };
  const baseManifest = { schemaVersion: PACKET_SCHEMA_VERSION, environment: "staging", packetId: packet.packetId,
    databaseName: selected.database_name, databaseId: selected.database_id, migrationsTable: AUTHORITY_MIGRATIONS_TABLE,
    canonicalOperationsLedger: { count: names.length, finalMigration: names.at(-1), chainSha256 }, identity,
    grant: { id: ids.grant, capability: "project.shared.sync", effect: "allow", scopeKind: "global" },
    directoryGrant: { id: ids.directoryGrant, permission: "directory.profile.edit", effect: "allow", scopeKind: "global" },
    issuedAt: packet.issuedAt, expiresAt: packet.expiresAt, reasonSha256: sha256(packet.reason) };
  const manifests = {
    provision: { ...baseManifest, phase: "provision", mode: packet.mode, migration: { name: provisionName, sha256: sha256(provision) },
      expected: packet.expected, result: { admissionVersion: versions.admissionActive, profileVersion: versions.profile,
        grantVersion: versions.grantActive, grantGeneration: versions.generationActive, directoryGrantActive: 1 } },
    revoke: { ...baseManifest, phase: "revoke", migration: { name: revokeName, sha256: sha256(revoke) },
      expected: { admissionVersion: versions.admissionActive, profileVersion: versions.profile,
        grantVersion: versions.grantActive, grantGeneration: versions.generationActive, directoryGrantActive: 1 },
      result: { admissionVersion: versions.admissionActive + 1, profileVersion: versions.profile,
        grantVersion: versions.grantActive + 1, grantGeneration: versions.generationActive + 1, directoryGrantActive: 0 } },
  };
  return { packet, ids, versions, configs, provision: { name: provisionName, sql: provision, manifest: manifests.provision },
    revoke: { name: revokeName, sql: revoke, manifest: manifests.revoke }, phase };
}

function expectedFiles(base, artifact) {
  const directory = path.join(base, "apps", "operations", OUTPUT_ROOT, artifact.packet.packetId);
  const files = new Map([
    [path.join(base, "apps", "operations", `wrangler.staging.native-authority.${artifact.packet.packetId}.provision.json`), `${JSON.stringify(artifact.configs.provision, null, 2)}\n`],
    [path.join(directory, "provision", artifact.provision.name), artifact.provision.sql],
    [path.join(directory, "provision.manifest.json"), `${JSON.stringify(artifact.provision.manifest, null, 2)}\n`],
  ]);
  if (artifact.phase === "revoke") {
    files.set(path.join(base, "apps", "operations", `wrangler.staging.native-authority.${artifact.packet.packetId}.revoke.json`), `${JSON.stringify(artifact.configs.revoke, null, 2)}\n`);
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
        const wanted = [artifact[action].name];
        const names = actual.filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql")).map(entry => entry.name).sort();
        if (!isDeepStrictEqual(names, wanted)) errors.push(`${path.relative(base, migrations)} has missing or unexpected migrations`);
      }
    } else if (requireAll) errors.push(`${path.relative(base, migrations)} is missing`);
  }
  return errors;
}

export function validateGeneratedAuthority(base, artifact) { return generatedErrors(base, artifact, true); }
export function writeGeneratedAuthority(base, artifact) {
  const errors = generatedErrors(base, artifact, false);
  if (errors.length) throw new Error(`generated authority artifacts are invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  const files = expectedFiles(base, artifact), written = [];
  for (const [file, content] of files) {
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
    throw new Error("usage: node scripts/staging-native-authority-packet.mjs --write|--check --phase provision|revoke --values <ignored-json>");
  return { mode, phase, valuesFile };
}

export function run(argv = process.argv.slice(2), base = root) {
  const { mode, phase, valuesFile } = parseArguments(argv);
  const absoluteValues = path.resolve(base, valuesFile);
  requireRegularFile(absoluteValues, "authority values file");
  const artifact = buildAuthorityArtifacts(base, JSON.parse(fs.readFileSync(absoluteValues, "utf8")), phase);
  if (mode === "--check") {
    const errors = validateGeneratedAuthority(base, artifact);
    if (errors.length) throw new Error(`staging native authority artifacts are invalid:\n${errors.map(error => `- ${error}`).join("\n")}`);
    console.log(`Staging native authority ${phase} artifacts are current. No SQL was applied.`);
    return [];
  }
  const written = writeGeneratedAuthority(base, artifact);
  console.log(`Wrote ${written.length} ignored staging native authority ${phase} artifacts. No SQL was applied.`);
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Staging native authority packet failed: ${error.message}`); process.exitCode = 1; }
}
