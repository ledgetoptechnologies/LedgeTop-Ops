import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

export const RETAINED_DIRECTORY_TARGET = Object.freeze({
  staffId: "staff-beau-koltz",
  areaId: "staging-native-only-portal-acceptance-20261008-window-1",
  recordId: "614ed50f-8800-4ab3-aa69-009d8e5cefa9",
  predecessorCommandId: "7dbf5685-91cf-494a-aa46-4d59c138d94e",
  sourceId: "project-alpha:staging",
});

export const REVIEWED_REFERENCE_BASELINE = Object.freeze({
  native_business_divisions: 0,
  native_directory_grant_history: 6,
  native_directory_grants: 3,
  native_directory_resource_scopes: 1,
  native_project_grants: 1,
  native_staff_admin_delegations: 0,
  native_staff_delegation_ceilings: 0,
  native_staff_management_delegations: 0,
  native_staff_target_memberships: 0,
  native_workforce_authority_grants: 0,
  native_workforce_grant_issuer_ceilings: 0,
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN = Object.freeze({ count: 181, final: "0181_project_alpha_directory_create_generation_recovery.sql",
  names: "42090dbacb9d23e4cc92371743c15e7ebc31c0e6d33f6bf7e48faf7f92cd96db",
  contents: "7b165451ebea6bdc680ef8b54600924064a3871b09a227abeb38d6218b7fed2e" });
const ADMISSION_COLUMNS = ["staff_id", "bound_access_subject", "active", "admitted_by", "created_at", "updated_at", "version"];
const PROFILE_COLUMNS = ["staff_id", "login_email", "display_name", "version", "created_at", "updated_at"];
const GENERATION_COLUMNS = ["staff_id", "generation", "updated_at"];
const AREA_COLUMNS = ["id", "name", "active"];
const SCOPE_COLUMNS = ["record_id", "scope_kind", "business_area_id", "division_id", "active"];
const PROJECT_GRANT_COLUMNS = ["id", "staff_id", "capability", "effect", "scope_kind", "business_area_id", "division_id", "external_project_id", "active", "version", "granted_by", "created_at"];
const PROJECT_GENERATION_COLUMNS = ["staff_id", "generation"];

const GRANT_COLUMNS = ["id", "staff_id", "permission", "effect", "scope_kind", "business_area_id", "division_id", "resource_id", "active", "granted_by", "created_at"];
const HISTORY_COLUMNS = ["grant_id", "grant_version", "staff_id", "permission", "effect", "scope_kind", "business_area_id", "division_id", "resource_id", "active", "grant_generation", "recorded_at"];
const APPROVAL_COLUMNS = ["approval_id", "canonical_plan_json", "canonical_plan_sha256", "approved_operator_staff_id", "approved_operator_access_subject", "independent_binding_verification_json", "independent_binding_verification_sha256", "issued_by_staff_id", "issued_by_access_subject", "issued_at", "expires_at", "revoked_at"];
const RECEIPT_COLUMNS = ["command_id", "approval_id", "operator_staff_id", "operator_access_subject", "canonical_plan_json", "canonical_plan_sha256", "independent_binding_verification_json", "independent_binding_verification_sha256", "result_json", "result_sha256", "executed_at"];
const PERMISSIONS = ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const MAX_PLAN_BYTES = 262_144;
const MAX_D1_ROW_BYTES = 2_000_000;
const MAX_D1_SQL_BYTES = 100_000;
const MAX_D1_BOUND_PARAMETERS = 100;
const encodedBytes = value => value === null ? 0 : Buffer.byteLength(typeof value === "string" ? value : String(value));
const assertD1Bounds = (statements, approval, receipt) => {
  for (const statement of statements) {
    if (Buffer.byteLength(statement.sql) > MAX_D1_SQL_BYTES) fail("D1 SQL statement size exceeded");
    if (statement.params.length > MAX_D1_BOUND_PARAMETERS) fail("D1 bound parameter limit exceeded");
    if (statement.params.some(value => encodedBytes(value) > MAX_D1_ROW_BYTES)) fail("D1 bound value size exceeded");
  }
  for (const row of [approval, receipt]) {
    if (Object.values(row).reduce((total, value) => total + encodedBytes(value), 0) > MAX_D1_ROW_BYTES) fail("D1 authority row size exceeded");
  }
};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const fail = message => { throw new Error(`staging-retained-directory-authority: ${message}`); };
const exact = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || !same(Object.keys(value).sort(), [...keys].sort())) fail(`${label} shape`);
};
function plainTree(value, label) {
  if (Array.isArray(value)) { value.forEach(item => plainTree(item, label)); return; }
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} prototype`);
    Object.values(value).forEach(item => plainTree(item, label));
  }
}
function reviewedMigrations(root) {
  const directory = path.join(root, "apps", "operations", "migrations");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const contents = names.map(name => {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("regular canonical migration required");
    return `${name}\0${sha(fs.readFileSync(filename))}`;
  });
  if (names.length !== CHAIN.count || names.at(-1) !== CHAIN.final || sha(names.join("\n")) !== CHAIN.names
    || sha(contents.join("\n")) !== CHAIN.contents) fail("exact canonical 181 migration chain required");
  return names;
}
const guard = (condition, params, label) => ({
  sql: `SELECT CASE WHEN (${condition}) THEN 1 ELSE json('retained-directory-${label}-guard-failed') END verified`, params,
});
function equality(table, columns, expected, predicate, predicateParams = []) {
  const compare = columns.map(column => `t.${column} IS json_extract(e.value,'$.${column}')`).join(" AND ");
  const query = `SELECT ${columns.join(",")} FROM ${table} WHERE ${predicate}`;
  return guard(`(SELECT count(*) FROM (${query}))=json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM (${query}) t WHERE NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE ${compare}))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM (${query}) t WHERE ${compare}))`,
  [...predicateParams, json(expected), ...predicateParams, json(expected), json(expected), ...predicateParams], `${table}-exact`);
}
const insert = (table, columns, row) => ({
  sql: `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  params: columns.map(key => row[key]),
});

function verifiedLegacyArtifact(value, root, label, historicalVerifier) {
  if (!value || !value.input) fail(`${label} artifact required`);
  let expected;
  try { expected = historicalVerifier(value, { root }); } catch { fail(`${label} artifact invalid`); }
  if (!same(value, expected)) fail(`${label} artifact changed`);
  return expected;
}

export function verifyHistoricalNativeOnlyArtifact(input) {
  const artifact = input?.__artifact ?? input;
  if (!artifact || !artifact.input || !artifact.approval || !artifact.receipt) fail("historical artifact shape");
  exact(artifact, ["schemaVersion", "input", "planHash", "approval", "receipt", "statements"], "historical artifact");
  exact(artifact.approval, APPROVAL_COLUMNS, "historical approval");
  exact(artifact.receipt, RECEIPT_COLUMNS, "historical receipt");
  const plan = json(artifact.input), planSha = sha(plan);
  if (artifact.schemaVersion !== 3 || artifact.input.schemaVersion !== 3 || !same(artifact.input.staging, STAGING_TARGET)
    || artifact.planHash !== planSha || artifact.input.phase !== "provision" && artifact.input.phase !== "revoke") fail("historical artifact phase");
  if (artifact.approval.canonical_plan_json !== plan || artifact.approval.canonical_plan_sha256 !== planSha
    || artifact.receipt.canonical_plan_json !== plan || artifact.receipt.canonical_plan_sha256 !== planSha
    || artifact.receipt.approval_id !== artifact.approval.approval_id
    || artifact.receipt.operator_staff_id !== artifact.approval.approved_operator_staff_id
    || artifact.receipt.operator_access_subject !== artifact.approval.approved_operator_access_subject
    || artifact.receipt.independent_binding_verification_json !== artifact.approval.independent_binding_verification_json
    || artifact.receipt.independent_binding_verification_sha256 !== artifact.approval.independent_binding_verification_sha256
    || sha(artifact.receipt.independent_binding_verification_json) !== artifact.receipt.independent_binding_verification_sha256
    || sha(artifact.receipt.result_json) !== artifact.receipt.result_sha256) fail("historical artifact hashes");
  return artifact;
}

function validate(raw, root, historicalVerifier) {
  plainTree(raw, "input");
  exact(raw, ["schemaVersion", "staging", "phase", "target", "migrationNames", "admission", "profile", "generation", "projectGeneration", "businessArea", "resourceScope", "projectGrant", "grants", "history", "referenceCounts", "predecessor", "lineage", "approval"], "input");
  const input = structuredClone(raw);
  exact(input, ["schemaVersion", "staging", "phase", "target", "migrationNames", "admission", "profile", "generation", "projectGeneration", "businessArea", "resourceScope", "projectGrant", "grants", "history", "referenceCounts", "predecessor", "lineage", "approval"], "input");
  if (input.schemaVersion !== 1 || !["reactivate", "revoke"].includes(input.phase) || !same(input.staging, STAGING_TARGET)
    || !same(input.target, RETAINED_DIRECTORY_TARGET)) fail("exact staging retained target required");
  if (!same(input.migrationNames, reviewedMigrations(root ?? ROOT))) fail("exact canonical 181 migration ledger required");
  exact(input.referenceCounts, Object.keys(REVIEWED_REFERENCE_BASELINE), "reference baseline");
  const expectedReferences = { ...REVIEWED_REFERENCE_BASELINE,
    native_directory_grant_history: input.phase === "reactivate" ? 6 : 9 };
  if (!same(input.referenceCounts, expectedReferences)) fail("exact reviewed reference baseline required");
  exact(input.resourceScope, ["record_id", "scope_kind", "business_area_id", "division_id", "active"], "resource scope");
  exact(input.admission, ADMISSION_COLUMNS, "admission"); exact(input.profile, PROFILE_COLUMNS, "profile");
  exact(input.generation, GENERATION_COLUMNS, "generation"); exact(input.businessArea, AREA_COLUMNS, "business area");
  exact(input.projectGeneration, PROJECT_GENERATION_COLUMNS, "project generation");
  exact(input.projectGrant, PROJECT_GRANT_COLUMNS, "project grant");
  if (input.projectGeneration.staff_id !== input.target.staffId || input.projectGeneration.generation !== 14
    || input.projectGrant.staff_id !== input.target.staffId || input.projectGrant.capability !== "project.shared.sync"
    || input.projectGrant.effect !== "allow" || input.projectGrant.scope_kind !== "business_area"
    || input.projectGrant.business_area_id !== input.target.areaId || input.projectGrant.division_id !== null
    || input.projectGrant.external_project_id !== null || input.projectGrant.active !== 0 || input.projectGrant.version !== 2
    || input.projectGrant.granted_by !== input.target.staffId) fail("exact inactive retained project grant required");
  if (!same(input.resourceScope, { record_id: input.target.recordId, scope_kind: "business_area", business_area_id: input.target.areaId, division_id: null, active: 1 })) fail("exact retained resource scope required");
  exact(input.predecessor, ["command_id", "source_id", "resource_type", "external_id", "state", "outcome_json"], "predecessor");
  let outcome; try { outcome = JSON.parse(input.predecessor.outcome_json); } catch { fail("predecessor outcome JSON"); }
  exact(outcome, ["directoryProfileDispatcher", "reason", "httpStatus", "requestId"], "terminal outcome");
  if (input.predecessor.command_id !== input.target.predecessorCommandId || input.predecessor.source_id !== input.target.sourceId
    || input.predecessor.resource_type !== "client" || input.predecessor.external_id !== input.target.recordId
    || input.predecessor.state !== "terminal" || outcome.directoryProfileDispatcher !== "conflict"
    || outcome.reason !== "http_status" || outcome.httpStatus !== 409 || typeof outcome.requestId !== "string" || !outcome.requestId.length)
    fail("exact immutable terminal predecessor required");
  if (input.admission.staff_id !== input.target.staffId || input.admission.active !== 1
    || input.profile.staff_id !== input.target.staffId || input.generation.staff_id !== input.target.staffId
    || !Number.isSafeInteger(input.generation.generation) || input.generation.generation < 1) fail("current active operator state required");
  if (input.businessArea.id !== input.target.areaId || input.businessArea.active !== 1) fail("exact active retained area required");
  if (!Array.isArray(input.grants) || !Array.isArray(input.history)) fail("complete staff grant snapshot required");
  input.grants.forEach(row => exact(row, GRANT_COLUMNS, "grant")); input.history.forEach(row => exact(row, HISTORY_COLUMNS, "history"));
  const targetIds = input.lineage?.provisionArtifact?.input?.approval?.grantIds;
  if (!Array.isArray(targetIds) || targetIds.length !== 3) fail("three prior grant ids required");
  const ordered = targetIds.map(id => input.grants.find(row => row.id === id));
  if (ordered.some(row => !row)) fail("complete retained target grant snapshot required");
  if (new Set(input.grants.map(row => row.id)).size !== input.grants.length || new Set(ordered.map(row => row.id)).size !== 3 || ordered.some((row, index) => row.staff_id !== input.target.staffId
    || row.permission !== PERMISSIONS[index] || row.effect !== "allow" || row.scope_kind !== "business_area"
    || row.business_area_id !== input.target.areaId || row.division_id !== null || row.resource_id !== null
    || row.active !== (input.phase === "reactivate" ? 0 : 1))) fail("exact retained grant state required");
  for (const grant of ordered) {
    const rows = input.history.filter(row => row.grant_id === grant.id).sort((a, b) => a.grant_version - b.grant_version);
    const expectedVersions = input.phase === "reactivate" ? [1, 2] : [1, 2, 3];
    if (rows.length !== expectedVersions.length || rows.some((row, index) => row.grant_version !== expectedVersions[index]
      || row.active !== (index % 2 === 0 ? 1 : 0)
      || !["staff_id", "permission", "effect", "scope_kind", "business_area_id", "division_id", "resource_id"].every(key => row[key] === grant[key])
      || !Number.isSafeInteger(row.grant_generation) || typeof row.recorded_at !== "string" || !TS.test(row.recorded_at))) fail("complete retained grant history required");
  }
  exact(input.lineage, input.phase === "reactivate" ? ["provisionArtifact", "revokeArtifact", "provisionReceipt", "revokeReceipt"]
    : ["provisionArtifact", "revokeArtifact", "provisionReceipt", "revokeReceipt", "reactivationArtifact", "reactivationReceipt"], "lineage");
  const provision = verifiedLegacyArtifact(input.lineage.provisionArtifact, root, "prior provision", historicalVerifier);
  const revoke = verifiedLegacyArtifact(input.lineage.revokeArtifact, root, "prior revoke", historicalVerifier);
  if (provision.input.phase !== "provision" || revoke.input.phase !== "revoke" || !same(provision.receipt, input.lineage.provisionReceipt)
    || !same(revoke.receipt, input.lineage.revokeReceipt) || !same(revoke.input.priorProvision?.receipt, provision.receipt)
    || !same(revoke.input.approval?.grantIds, provision.input.approval.grantIds)
    || provision.input.admission?.staff_id !== input.target.staffId || provision.input.businessArea?.id !== input.target.areaId
    || !same(provision.input.staging, STAGING_TARGET) || !same(revoke.input.staging, STAGING_TARGET)
    || !same(provision.input.approval.grantIds, ordered.map(row => row.id))) fail("prior immutable provision/revoke lineage mismatch");
  exact(input.approval, ["approvalId", "commandId", "issuedAt", "expiresAt", "executedAt"], "approval");
  if (![input.approval.approvalId, input.approval.commandId].every(value => typeof value === "string" && UUID.test(value))
    || input.approval.approvalId === input.approval.commandId || ![input.approval.issuedAt, input.approval.expiresAt, input.approval.executedAt].every(value => TS.test(value))
    || Date.parse(input.approval.expiresAt) <= Date.parse(input.approval.issuedAt)
    || Date.parse(input.approval.expiresAt) - Date.parse(input.approval.issuedAt) > 4 * 3600_000
    || Date.parse(input.approval.executedAt) < Date.parse(input.approval.issuedAt)
    || Date.parse(input.approval.executedAt) >= Date.parse(input.approval.expiresAt)) fail("bounded fresh approval required");
  const historicalIds = [provision.approval.approval_id, provision.receipt.command_id, revoke.approval.approval_id, revoke.receipt.command_id];
  if (historicalIds.includes(input.approval.approvalId) || historicalIds.includes(input.approval.commandId)) fail("fresh phase identifiers required");
  if (input.phase === "revoke") {
    const prior = input.lineage.reactivationArtifact;
    if (!prior || prior.input?.phase !== "reactivate" || !same(prior, compileRetainedDirectoryAuthority(prior.input, { root, historicalVerifier }))
      || !same(prior.receipt, input.lineage.reactivationReceipt)) fail("immutable reactivation lineage required");
  }
  return { input, grants: ordered };
}

export function compileRetainedDirectoryAuthority(raw, { root, historicalVerifier = verifyHistoricalNativeOnlyArtifact } = {}) {
  const { input, grants } = validate(raw, root, historicalVerifier);
  const activating = input.phase === "reactivate";
  const compactLineage = {
    provision: { approvalId: input.lineage.provisionArtifact.approval.approval_id,
      commandId: input.lineage.provisionReceipt.command_id, artifactSha256: sha(json(input.lineage.provisionArtifact)),
      receiptSha256: sha(json(input.lineage.provisionReceipt)) },
    revoke: { approvalId: input.lineage.revokeArtifact.approval.approval_id,
      commandId: input.lineage.revokeReceipt.command_id, artifactSha256: sha(json(input.lineage.revokeArtifact)),
      receiptSha256: sha(json(input.lineage.revokeReceipt)) },
    ...(activating ? {} : { reactivation: { approvalId: input.lineage.reactivationArtifact.approval.approval_id,
      commandId: input.lineage.reactivationReceipt.command_id, artifactSha256: sha(json(input.lineage.reactivationArtifact)),
      receiptSha256: sha(json(input.lineage.reactivationReceipt)) } }),
  };
  const plan = json({ schemaVersion: input.schemaVersion, staging: input.staging, phase: input.phase, target: input.target,
    migrationLedgerSha256: sha(input.migrationNames.join("\n")), admission: input.admission, profile: input.profile,
    generation: input.generation, projectGeneration: input.projectGeneration, businessArea: input.businessArea,
    resourceScope: input.resourceScope, projectGrant: input.projectGrant, grants: input.grants, history: input.history,
    referenceCounts: input.referenceCounts, predecessor: input.predecessor, lineage: compactLineage, approval: input.approval }), planSha = sha(plan);
  if (Buffer.byteLength(plan) > MAX_PLAN_BYTES) fail("bounded canonical plan required");
  const verification = json({ staging: input.staging, target: input.target, migrationCount: 181, migrationFinal: input.migrationNames.at(-1), referenceBaseline: REVIEWED_REFERENCE_BASELINE,
    priorProvisionReceiptSha256: sha(json(input.lineage.provisionReceipt)), priorRevokeReceiptSha256: sha(json(input.lineage.revokeReceipt)) });
  const result = json({ phase: input.phase, grantIds: grants.map(row => row.id), generation: input.generation.generation + 3, active: activating ? 1 : 0 });
  const approval = { approval_id: input.approval.approvalId, canonical_plan_json: plan, canonical_plan_sha256: planSha,
    approved_operator_staff_id: input.target.staffId, approved_operator_access_subject: input.admission.bound_access_subject,
    independent_binding_verification_json: verification, independent_binding_verification_sha256: sha(verification),
    issued_by_staff_id: input.target.staffId, issued_by_access_subject: input.admission.bound_access_subject,
    issued_at: input.approval.issuedAt, expires_at: input.approval.expiresAt, revoked_at: null };
  const receipt = { command_id: input.approval.commandId, approval_id: approval.approval_id, operator_staff_id: input.target.staffId,
    operator_access_subject: input.admission.bound_access_subject, canonical_plan_json: plan, canonical_plan_sha256: planSha,
    independent_binding_verification_json: verification, independent_binding_verification_sha256: sha(verification),
    result_json: result, result_sha256: sha(result), executed_at: input.approval.executedAt };
  const referenceNames = JSON.stringify(Object.keys(REVIEWED_REFERENCE_BASELINE).sort());
  const statements = [guard(`(SELECT count(*) FROM sqlite_schema s JOIN pragma_table_info(s.name) p
      WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%' AND s.name NOT IN ('_cf_KV','_cf_METADATA') AND p.name='business_area_id')=json_array_length(?)
      AND NOT EXISTS(SELECT 1 FROM sqlite_schema s JOIN pragma_table_info(s.name) p
        WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%' AND s.name NOT IN ('_cf_KV','_cf_METADATA') AND p.name='business_area_id'
          AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE expected.value=s.name))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(
        SELECT 1 FROM sqlite_schema s JOIN pragma_table_info(s.name) p
        WHERE s.type='table' AND s.name=expected.value AND p.name='business_area_id'))`,
    [referenceNames, referenceNames, referenceNames], "reference-schema"),
    equality("d1_migrations", ["name"], input.migrationNames.map(name => ({ name })), "1"),
    equality("native_staff_admissions", Object.keys(input.admission), [input.admission], "staff_id=?", [input.target.staffId]),
    equality("native_staff_profiles", Object.keys(input.profile), [input.profile], "staff_id=?", [input.target.staffId]),
    equality("native_business_areas", Object.keys(input.businessArea), [input.businessArea], "id=?", [input.target.areaId]),
    equality("native_directory_grant_generations", Object.keys(input.generation), [input.generation], "staff_id=?", [input.target.staffId]),
    equality("native_project_grant_generations", PROJECT_GENERATION_COLUMNS, [input.projectGeneration], "staff_id=?", [input.target.staffId]),
    equality("native_project_grants", PROJECT_GRANT_COLUMNS, [input.projectGrant], "business_area_id=?", [input.target.areaId]),
    equality("native_directory_resource_scopes", Object.keys(input.resourceScope), [input.resourceScope], "business_area_id=?", [input.target.areaId]),
    equality("native_directory_grants", GRANT_COLUMNS, input.grants, "staff_id=?", [input.target.staffId]),
    equality("native_directory_grant_history", HISTORY_COLUMNS, input.history, "staff_id=?", [input.target.staffId])];
  for (const [table, count] of Object.entries(input.referenceCounts)) statements.push(guard(`(SELECT count(*) FROM ${table} WHERE business_area_id=?)=?`, [input.target.areaId, count], `reference-${table}`));
  statements.push(equality("project_alpha_directory_outbox", Object.keys(input.predecessor), [input.predecessor], "command_id=?", [input.target.predecessorCommandId]),
    guard("NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=? AND effect='deny' AND active=1)", [input.target.staffId], "deny"),
    guard(`NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=? OR target_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=? OR target_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?)
      AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox o JOIN native_project_command_proofs p ON p.command_id=o.command_id
        WHERE o.state IN ('pending','leased') AND p.actor_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased') AND json_extract(origin_snapshot_json,'$.actorId')=?)`,
    [input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId, input.target.staffId], "active-work"),
    guard(`NOT EXISTS(SELECT 1 FROM native_staff_target_memberships WHERE staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_staff_admin_delegations WHERE actor_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations WHERE actor_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_integration_control_grants WHERE actor_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_integration_management_grants WHERE actor_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_workforce_authority_grants WHERE staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_workforce_grant_manager_delegations WHERE actor_staff_id=? OR target_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations WHERE actor_staff_id=? OR beneficiary_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations WHERE actor_staff_id=? OR beneficiary_staff_id=?)
      AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_delegations WHERE actor_staff_id=? OR beneficiary_staff_id=?)`,
    Array(14).fill(input.target.staffId), "unrelated-authority"),
    guard(input.phase === "reactivate"
      ? `EXISTS(SELECT 1 FROM project_alpha_directory_unsettled_commands u JOIN project_alpha_directory_outbox o ON o.command_id=u.command_id
          WHERE u.command_id=? AND json_extract(o.origin_snapshot_json,'$.actorId')=?)
        AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_unsettled_commands u JOIN project_alpha_directory_outbox o ON o.command_id=u.command_id
          WHERE json_extract(o.origin_snapshot_json,'$.actorId')=? AND u.command_id<>?)`
      : `NOT EXISTS(SELECT 1 FROM project_alpha_directory_unsettled_commands u JOIN project_alpha_directory_outbox o ON o.command_id=u.command_id
          WHERE json_extract(o.origin_snapshot_json,'$.actorId')=?)`,
    input.phase === "reactivate"
      ? [input.target.predecessorCommandId, input.target.staffId, input.target.staffId, input.target.predecessorCommandId]
      : [input.target.staffId], "directory-unsettled"),
    guard("NOT EXISTS(SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations WHERE actor_staff_id=?)",
      [input.target.staffId], "project-recovery"),
    guard("julianday(?)<=julianday('now') AND julianday(?)>julianday('now') AND julianday(?)<=julianday('now') AND julianday(?)>=julianday('now','-5 minutes')",
      [input.approval.issuedAt, input.approval.expiresAt, input.approval.executedAt, input.approval.executedAt], "expiry"),
    guard("NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=?)", [approval.approval_id, receipt.command_id], "unused-packet"),
    equality("native_staff_bootstrap_approvals", APPROVAL_COLUMNS,
      [{ ...input.lineage.provisionArtifact.approval, revoked_at: input.lineage.revokeReceipt.executed_at }],
      "approval_id=?", [input.lineage.provisionArtifact.approval.approval_id]),
    equality("native_staff_bootstrap_approvals", APPROVAL_COLUMNS, [input.lineage.revokeArtifact.approval], "approval_id=?", [input.lineage.revokeArtifact.approval.approval_id]),
    equality("native_staff_bootstrap_receipts", RECEIPT_COLUMNS, [input.lineage.provisionReceipt], "command_id=?", [input.lineage.provisionReceipt.command_id]),
    equality("native_staff_bootstrap_receipts", RECEIPT_COLUMNS, [input.lineage.revokeReceipt], "command_id=?", [input.lineage.revokeReceipt.command_id]));
  if (!activating) statements.push(equality("native_staff_bootstrap_approvals", APPROVAL_COLUMNS, [input.lineage.reactivationArtifact.approval], "approval_id=?", [input.lineage.reactivationArtifact.approval.approval_id]),
    equality("native_staff_bootstrap_receipts", RECEIPT_COLUMNS, [input.lineage.reactivationReceipt], "command_id=?", [input.lineage.reactivationReceipt.command_id]),
    { sql: "UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL", params: [input.approval.executedAt, input.lineage.reactivationReceipt.approval_id] },
    guard("changes()=1", [], "reactivation-approval-cas"));
  statements.push(insert("native_staff_bootstrap_approvals", APPROVAL_COLUMNS, approval));
  grants.forEach(grant => statements.push({ sql: "UPDATE native_directory_grants SET active=? WHERE id=? AND staff_id=? AND active=?", params: [activating ? 1 : 0, grant.id, input.target.staffId, activating ? 0 : 1] }, guard("changes()=1", [], `grant-${grant.permission}-cas`)));
  const targetIds = new Set(grants.map(row => row.id));
  const expectedGrants = input.grants.map(row => targetIds.has(row.id) ? ({ ...row, active: activating ? 1 : 0 }) : row);
  statements.push(equality("native_directory_grants", GRANT_COLUMNS, expectedGrants, "staff_id=?", [input.target.staffId]),
    equality("native_project_grants", PROJECT_GRANT_COLUMNS, [input.projectGrant], "business_area_id=?", [input.target.areaId]),
    equality("native_project_grant_generations", PROJECT_GENERATION_COLUMNS, [input.projectGeneration], "staff_id=?", [input.target.staffId]),
    guard("(SELECT generation FROM native_directory_grant_generations WHERE staff_id=?)=?", [input.target.staffId, input.generation.generation + 3], "generation-poststate"),
    guard("(SELECT count(*) FROM native_directory_grant_history WHERE staff_id=? AND grant_generation>?)=3", [input.target.staffId, input.generation.generation], "history-suffix-count"));
  grants.forEach((grant, index) => statements.push(guard(`EXISTS(SELECT 1 FROM native_directory_grant_history WHERE grant_id=? AND grant_version=?
      AND staff_id=? AND permission=? AND effect='allow' AND scope_kind='business_area' AND business_area_id=?
      AND division_id IS NULL AND resource_id IS NULL AND active=? AND grant_generation=?)`,
  [grant.id, activating ? 3 : 4, input.target.staffId, grant.permission, input.target.areaId, activating ? 1 : 0,
    input.generation.generation + index + 1], `history-${grant.permission}-poststate`)));
  statements.push(
    guard("julianday(?)>julianday('now')", [input.approval.expiresAt], "expiry-poststate"),
    insert("native_staff_bootstrap_receipts", RECEIPT_COLUMNS, receipt),
    equality("native_staff_bootstrap_receipts", RECEIPT_COLUMNS, [receipt], "command_id=?", [receipt.command_id]));
  assertD1Bounds(statements, approval, receipt);
  return Object.freeze({ schemaVersion: 1, input, approval, receipt, statements });
}

export async function verifyReviewedReferenceSchema(db) {
  // D1 owns these exact reserved storage/metadata tables and rejects their
  // column introspection. Application tables must still be exhaustively checked.
  const references = (await db.prepare(`SELECT DISTINCT s.name FROM sqlite_schema s JOIN pragma_table_info(s.name) p
    WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%' AND s.name NOT IN ('_cf_KV','_cf_METADATA') AND p.name='business_area_id' ORDER BY s.name`).all()).results?.map(row => row.name);
  if (!Array.isArray(references) || references.some(name => typeof name !== "string")) fail("invalid schema metadata");
  if (!same(references.sort(), Object.keys(REVIEWED_REFERENCE_BASELINE).sort())) {
    fail(`reviewed business-area reference schema changed: ${JSON.stringify(references)}`);
  }
  return references;
}

export async function applyRetainedDirectoryAuthority(db, artifact, { target } = {}) {
  if (!same(target, STAGING_TARGET)) fail("trusted staging target required");
  const expected = compileRetainedDirectoryAuthority(artifact?.input, { root: ROOT });
  if (!same(artifact, expected)) fail("compiled artifact changed");
  await verifyReviewedReferenceSchema(db);
  return db.batch(artifact.statements.map(statement => db.prepare(statement.sql).bind(...statement.params)));
}

export async function applyAndReconcileRetainedDirectoryAuthority(db, artifact, { apply = applyRetainedDirectoryAuthority, target } = {}) {
  if (!same(target, STAGING_TARGET)) fail("trusted staging target required");
  let transportError;
  try { await apply(db, artifact, { target }); } catch (error) { transportError = error; }
  let receipt;
  try { receipt = await db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(artifact.receipt.command_id).first(); }
  catch (error) { throw new AggregateError([...(transportError ? [transportError] : []), error], "retained authority outcome is unknown"); }
  if (!receipt) throw new AggregateError(transportError ? [transportError] : [], "retained authority did not commit");
  assert.deepEqual(receipt, artifact.receipt, "retained authority immutable receipt mismatch");
  return { status: transportError ? "committed-after-response-recovery" : "committed", receipt };
}
