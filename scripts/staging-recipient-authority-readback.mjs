import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = "apps/operations/wrangler.staging.json";
const OUTPUT_ROOT = ".backups/staging-recipient-authority-readback";
const EXPECTED_ACCOUNT_ID = "846c924bf17bf4f3dd15c97a4c5d1d51";
const EXPECTED_DATABASE_ID = "78b34173-b168-4e3d-9832-bb9d245cc6b8";
const EXPECTED_DATABASE_NAME = "ltds-ops-staging";
const EXPECTED_WORKER_NAME = "ledgetop-ops-staging";
const EXPECTED_BINDING = "OPS_DB";
const EXPECTED_FINAL_MIGRATION = "0183_project_alpha_binding_standalone_relationship_rows.sql";
const REVIEWED_OPERATIONS_MIGRATIONS = Object.freeze({
  source: "operations",
  count: 183,
  namesSha256: "e85a63e7f7f018f8fb473f913660d5fbe13d798d3c19e281342b0cbca70d5ac7",
  contentsSha256: "134957a54a3eb9462a2e19b839d0aa2bb5fe5eb46096dc4677ab9d8324547cb8",
});
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const SYNTHETIC_RECORD_ID = /^staging-[a-z0-9](?:[a-z0-9:._-]{0,182}[a-z0-9])?$/;
const OUTPUT_NAME = /^recipient-authority-readback-\d{8}T\d{6}Z-[a-z0-9]{6,32}\.json$/;
const MUTATION = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|REINDEX)\b/i;

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function safeId(value, label, pattern = IDENTIFIER) {
  if (typeof value !== "string" || value !== value.trim() || !pattern.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function reviewedExpectations(value) {
  if (!plain(value)) throw new Error("reviewed history generation expectations are required");
  const global = positiveInteger(value.globalHistoryGeneration, "expected global generation");
  if (!Array.isArray(value.onboardingHistoryGenerations) || value.onboardingHistoryGenerations.length !== 3)
    throw new Error("expected onboarding generations must contain exactly three values");
  const onboarding = value.onboardingHistoryGenerations.map((entry, index) =>
    positiveInteger(entry, `expected onboarding generation ${index + 1}`));
  if (!(onboarding[0] < onboarding[1] && onboarding[1] < onboarding[2]))
    throw new Error("expected onboarding generations must be strictly increasing");
  return { globalHistoryGeneration: global, onboardingHistoryGenerations: onboarding };
}

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requireRegularFile(file, label) {
  const stat = lstat(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

export function parseArguments(argv) {
  const values = {};
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute-readback") {
      if (execute) throw new Error("duplicate --execute-readback");
      execute = true;
      continue;
    }
    if (!["--staff-id", "--record-id", "--expected-global-generation", "--expected-onboarding-generations", "--output"].includes(argument))
      throw new Error("unknown argument");
    const key = argument.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key)) throw new Error(`duplicate ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values[key] = value;
  }
  if (!execute) throw new Error("--execute-readback is required");
  if (!values.staff_id || !values.record_id || !values.expected_global_generation
    || !values.expected_onboarding_generations || !values.output)
    throw new Error("staff, record, reviewed generations, and output are required");
  safeId(values.staff_id, "staff id");
  safeId(values.record_id, "record id", SYNTHETIC_RECORD_ID);
  const expectations = reviewedExpectations({
    globalHistoryGeneration: values.expected_global_generation,
    onboardingHistoryGenerations: values.expected_onboarding_generations.split(","),
  });
  return { execute, staffId: values.staff_id, recordId: values.record_id, expectations, output: values.output };
}

function canonicalMigrationInventory(base) {
  const contract = REVIEWED_OPERATIONS_MIGRATIONS;
  const directory = path.join(base, "apps", contract.source, "migrations");
  const stat = lstat(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Operations migrations must be a regular directory");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const namesSha256 = sha256(names.join("\n"));
  if (names.length !== contract.count || namesSha256 !== contract.namesSha256
    || names.at(-1) !== EXPECTED_FINAL_MIGRATION)
    throw new Error("Operations canonical migration inventory changed");
  const contents = names.map(name => {
    const file = path.join(directory, name);
    requireRegularFile(file, "Operations migration");
    return `${name}\0${sha256(fs.readFileSync(file, "utf8"))}`;
  });
  const contentsSha256 = sha256(contents.join("\n"));
  if (contentsSha256 !== contract.contentsSha256)
    throw new Error("Operations canonical migration contents changed");
  return { names, namesSha256, contentsSha256, finalMigration: names.at(-1) };
}

export function validateStagingConfigDocument(config) {
  const inventory = STAGING_INVENTORY.operations;
  if (STAGING_ACCOUNT_ID !== EXPECTED_ACCOUNT_ID || config.account_id !== EXPECTED_ACCOUNT_ID
    || config.name !== EXPECTED_WORKER_NAME || config.vars?.ENVIRONMENT !== "staging"
    || config.vars?.PUBLIC_BASE_URL !== "https://ops-staging.ledgetopdroneservices.com"
    || !sameJson(config.routes, inventory.routes))
    throw new Error("Operations config is not the exact pinned staging target");
  const selected = config.d1_databases?.filter(database => database.binding === EXPECTED_BINDING) ?? [];
  const expected = inventory.d1_databases.filter(database => database.binding === EXPECTED_BINDING);
  if (selected.length !== 1 || expected.length !== 1 || !sameJson(selected[0], expected[0])
    || selected[0].database_name !== EXPECTED_DATABASE_NAME || selected[0].database_id !== EXPECTED_DATABASE_ID
    || selected[0].migrations_dir !== "migrations")
    throw new Error("Operations config does not select the exact pinned staging database");
  return selected[0];
}

export function validateStagingConfiguration(base = root) {
  const file = path.join(base, CONFIG_PATH);
  requireRegularFile(file, "Operations staging config");
  const source = fs.readFileSync(file, "utf8");
  const config = JSON.parse(source);
  const selected = validateStagingConfigDocument(config);
  return {
    configSha256: sha256(source),
    database: selected,
    inventory: canonicalMigrationInventory(base),
  };
}

export function assertReadOnlyQuery(sql) {
  if (typeof sql !== "string" || !/^\s*(?:SELECT\b|PRAGMA\s+foreign_key_check\b)/i.test(sql)
    || sql.includes(";") || /--|\/\*/.test(sql) || MUTATION.test(sql))
    throw new Error("query is not a single read-only SELECT or foreign-key PRAGMA");
}

export function createD1QueryRunner({ fetchImpl = globalThis.fetch, token, accountId, databaseId }) {
  if (typeof fetchImpl !== "function" || typeof token !== "string" || token.length < 1)
    throw new Error("readback transport is not configured");
  if (accountId !== EXPECTED_ACCOUNT_ID || databaseId !== EXPECTED_DATABASE_ID)
    throw new Error("readback transport target is not staging");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return async ({ name, sql, params = [] }) => {
    assertReadOnlyQuery(sql);
    if (!Array.isArray(params) || params.some(value => !["string", "number", "boolean"].includes(typeof value)))
      throw new Error(`query ${name} parameters are invalid`);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      });
    } catch {
      throw new Error(`query ${name} transport failed`);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`query ${name} returned invalid JSON`); }
    const result = Array.isArray(payload?.result) && payload.result.length === 1 ? payload.result[0] : null;
    if (!response.ok || payload?.success !== true || result?.success !== true || !Array.isArray(result.results)
      || result.meta?.changed_db === true || (result.meta?.changes !== undefined && result.meta.changes !== 0))
      throw new Error(`query ${name} failed`);
    return result.results;
  };
}

export const READBACK_QUERIES = Object.freeze([
  { name: "migrationLedger", sql: "SELECT id,name,applied_at FROM d1_migrations ORDER BY id", params: () => [] },
  { name: "staffUser", sql: "SELECT id,email,display_name,status,access_subject FROM staff_users WHERE id=?", params: s => [s.staffId] },
  { name: "admission", sql: "SELECT * FROM native_staff_admissions WHERE staff_id=?", params: s => [s.staffId] },
  { name: "profile", sql: "SELECT * FROM native_staff_profiles WHERE staff_id=?", params: s => [s.staffId] },
  { name: "roles", sql: "SELECT role_id,scope FROM staff_role_assignments WHERE staff_id=? ORDER BY role_id,scope", params: s => [s.staffId] },
  { name: "rolePermissions", sql: "SELECT assignment.role_id,assignment.scope,permission.permission_key FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id WHERE assignment.staff_id=? ORDER BY assignment.role_id,assignment.scope,permission.permission_key", params: s => [s.staffId] },
  { name: "permissionOverrides", sql: "SELECT permission_key,effect,scope FROM staff_permission_overrides WHERE staff_id=? ORDER BY permission_key,effect,scope", params: s => [s.staffId] },
  { name: "directoryGeneration", sql: "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", params: s => [s.staffId] },
  { name: "directoryGrants", sql: "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", params: s => [s.staffId] },
  { name: "directoryHistory", sql: "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version", params: s => [s.staffId] },
  { name: "businessAreas", sql: "SELECT area.* FROM native_business_areas area WHERE area.id IN (SELECT grant.business_area_id FROM native_directory_grants grant WHERE grant.staff_id=? AND grant.business_area_id IS NOT NULL) ORDER BY area.id", params: s => [s.staffId] },
  { name: "projectGeneration", sql: "SELECT * FROM native_project_grant_generations WHERE staff_id=?", params: s => [s.staffId] },
  { name: "projectGrants", sql: "SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id", params: s => [s.staffId] },
  { name: "record", sql: "SELECT * FROM operations_directory_records WHERE record_id=?", params: s => [s.recordId] },
  { name: "recordReviews", sql: "SELECT * FROM project_alpha_existing_directory_binding_review_evidence WHERE record_id=? ORDER BY reviewed_at,receipt_id", params: s => [s.recordId] },
  { name: "activationReceipts", sql: "SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE record_id=? ORDER BY activated_at,activation_id", params: s => [s.recordId] },
  { name: "staffManagementFences", sql: "SELECT * FROM native_staff_management_fences WHERE actor_staff_id=? OR target_staff_id=? ORDER BY command_id", params: s => [s.staffId, s.staffId] },
  { name: "staffAdminFences", sql: "SELECT * FROM native_staff_admin_command_fences WHERE actor_staff_id=? OR target_staff_id=? ORDER BY command_id", params: s => [s.staffId, s.staffId] },
  { name: "writeFences", sql: "SELECT * FROM operations_directory_write_fences WHERE actor_id=? ORDER BY mutation_id", params: s => [s.staffId] },
  { name: "projectLiveProofs", sql: "SELECT * FROM native_project_live_command_proofs WHERE actor_staff_id=? ORDER BY command_id", params: s => [s.staffId] },
  { name: "pendingProjectOutbox", sql: "SELECT outbox.command_id,outbox.state FROM project_alpha_project_outbox outbox JOIN native_project_command_proofs proof ON proof.command_id=outbox.command_id WHERE proof.actor_staff_id=? AND outbox.state IN ('pending','leased') ORDER BY outbox.command_id", params: s => [s.staffId] },
  { name: "pendingDirectoryOutbox", sql: "SELECT command_id,state FROM project_alpha_directory_outbox WHERE json_extract(origin_snapshot_json,'$.actorId')=? AND state IN ('pending','leased') ORDER BY command_id", params: s => [s.staffId] },
  { name: "pendingWorkspaceOutbox", sql: "SELECT operation_id,state FROM client_portal_workspace_binding_outbox WHERE reviewed_by_staff_id=? AND state IN ('pending','retry','dispatching') ORDER BY operation_id", params: s => [s.staffId] },
  { name: "pendingAuthorityOutbox", sql: "SELECT operation_id,state FROM client_portal_authority_v2_outbox WHERE authorized_by_staff_id=? AND state IN ('pending','retry','dispatching') ORDER BY operation_id", params: s => [s.staffId] },
  { name: "nonterminalRecipientIntents", sql: "SELECT intent.intent_id,intent.state FROM client_portal_recipient_enrollment_intents intent JOIN client_portal_workspace_binding_selections selection ON selection.selection_id=intent.selection_id WHERE selection.record_id=? AND intent.state IN ('issued','pending','active','revoking') AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations cancellation WHERE cancellation.intent_id=intent.intent_id) ORDER BY intent.intent_id", params: s => [s.recordId] },
  { name: "foreignKeyCheck", sql: "PRAGMA foreign_key_check", params: () => [] },
]);

export const MINIMAL_AUTHORITY_QUERY = Object.freeze({
  name: "minimalAuthority",
  sql: `SELECT
    (SELECT count(*) FROM native_staff_target_memberships WHERE staff_id=?) AS target_memberships,
    (SELECT count(*) FROM native_staff_admin_delegations WHERE actor_staff_id=?) AS admin_delegations,
    (SELECT count(*) FROM native_staff_management_delegations WHERE actor_staff_id=?) AS management_delegations,
    (SELECT count(*) FROM native_integration_control_grants WHERE actor_staff_id=?) AS integration_control_grants,
    (SELECT count(*) FROM native_integration_management_grants WHERE actor_staff_id=?) AS integration_management_grants,
    (SELECT count(*) FROM native_workforce_authority_grants WHERE staff_id=?) AS workforce_authority_grants,
    (SELECT count(*) FROM native_workforce_grant_manager_delegations WHERE actor_staff_id=? OR target_staff_id=?) AS workforce_grant_manager_delegations,
    (SELECT count(*) FROM native_workforce_time_beneficiary_selection_delegations WHERE actor_staff_id=? OR beneficiary_staff_id=?) AS time_selection_delegations,
    (SELECT count(*) FROM native_workforce_time_beneficiary_selection_issuer_delegations WHERE actor_staff_id=? OR beneficiary_staff_id=?) AS time_selection_issuer_delegations,
    (SELECT count(*) FROM native_workforce_time_beneficiary_selection_lifecycle_delegations WHERE actor_staff_id=? OR beneficiary_staff_id=?) AS time_selection_lifecycle_delegations`,
  params: selection => Array(14).fill(selection.staffId),
});

export const IDENTITY_COLLISIONS_QUERY = Object.freeze({
  name: "identityCollisions",
  sql: `SELECT
    (SELECT count(*) FROM staff_users WHERE id<>? AND (lower(email)=lower(?) OR access_subject=?)) AS staff_users,
    (SELECT count(*) FROM native_staff_admissions WHERE staff_id<>? AND bound_access_subject=?) AS admissions,
    (SELECT count(*) FROM native_staff_profiles WHERE staff_id<>? AND lower(login_email)=lower(?)) AS profiles`,
  params: (selection, actor) => [selection.staffId, actor.email, actor.access_subject,
    selection.staffId, actor.access_subject, selection.staffId, actor.email],
});

function one(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${label} must resolve to exactly one row`);
  return rows[0];
}

function nullish(value) { return value === null || value === undefined; }
function allZero(row) { return plain(row) && Object.values(row).every(value => value === 0); }

function exactHistory(rows, grant, expectedActive, expectedGenerations) {
  if (rows.length !== expectedActive.length || rows.length !== expectedGenerations.length) return false;
  return rows.every((row, index) => row.grant_id === grant.id && row.grant_version === index + 1
    && row.staff_id === grant.staff_id && row.permission === grant.permission && row.effect === grant.effect
    && row.scope_kind === grant.scope_kind && row.business_area_id === grant.business_area_id
    && row.division_id === grant.division_id && row.resource_id === grant.resource_id
    && row.active === expectedActive[index] && row.grant_generation === expectedGenerations[index]);
}

function evaluateReadiness(data, selection, canonicalNames, expectations) {
  const actor = data.staffUser[0];
  const admission = data.admission[0];
  const profile = data.profile[0];
  const generation = data.directoryGeneration[0];
  const projectGeneration = data.projectGeneration[0];
  const record = data.record[0];
  const grants = data.directoryGrants;
  const global = grants.find(grant => grant.scope_kind === "global");
  const onboarding = grants.find(grant => grant.scope_kind === "business_area");
  const expectedGlobalId = `staging-directory-profile-edit:${selection.staffId}`;
  const expectedOnboardingId = onboarding?.business_area_id
    ? `staging-onboarding-profile-edit:${sha256(`${selection.staffId}:${onboarding.business_area_id}`).slice(0, 32)}` : null;
  const expectedProjectId = `staging-project-sync:${selection.staffId}`;
  const globalHistory = data.directoryHistory.filter(row => row.grant_id === global?.id);
  const onboardingHistory = data.directoryHistory.filter(row => row.grant_id === onboarding?.id);
  const exactGrantShape = (grant, scope, businessArea) => grant?.staff_id === selection.staffId
    && grant.permission === "directory.profile.edit" && grant.effect === "allow" && grant.scope_kind === scope
    && grant.business_area_id === businessArea && nullish(grant.division_id) && nullish(grant.resource_id)
    && grant.active === 0 && grant.granted_by === selection.staffId;
  const project = data.projectGrants[0];
  const inFlightNames = ["staffManagementFences", "staffAdminFences", "writeFences", "projectLiveProofs", "pendingProjectOutbox", "pendingDirectoryOutbox",
    "pendingWorkspaceOutbox", "pendingAuthorityOutbox", "nonterminalRecipientIntents"];
  const historyGenerations = data.directoryHistory.map(row => row.grant_generation);
  const checks = {
    migrationLedgerNamesMatchCanonical: data.migrationLedger.length === canonicalNames.length
      && data.migrationLedger.every((row, index) => row.name === canonicalNames[index]),
    currentOwner: actor?.id === selection.staffId && actor.status === "active"
      && data.roles.some(row => row.role_id === "role-owner" && row.scope === "global")
      && data.rolePermissions.some(row => row.permission_key === "integrations.manage" && row.scope === "global")
      && !data.permissionOverrides.some(row => row.permission_key === "integrations.manage" && row.effect === "deny" && row.scope === "global"),
    exactInactiveAdmissionProfile: admission?.staff_id === selection.staffId && admission.active === 0
      && admission.bound_access_subject === actor?.access_subject && admission.admitted_by === selection.staffId
      && Number.isSafeInteger(admission.version) && admission.version > 0
      && profile?.staff_id === selection.staffId && profile.login_email === actor?.email
      && profile.display_name === actor?.display_name && Number.isSafeInteger(profile.version) && profile.version > 0,
    noIdentityCollisions: allZero(data.identityCollisions[0]),
    exactDirectoryGeneration: generation?.staff_id === selection.staffId
      && Number.isSafeInteger(generation.generation) && generation.generation > 0,
    exactKnownInactiveGrants: grants.length === 2 && exactGrantShape(global, "global", null)
      && global.id === expectedGlobalId && exactGrantShape(onboarding, "business_area", onboarding?.business_area_id)
      && typeof onboarding?.business_area_id === "string" && onboarding.id === expectedOnboardingId
      && data.businessAreas.length === 1 && data.businessAreas[0].id === onboarding.business_area_id
      && data.businessAreas[0].active === 1,
    exactPerGrantHistory: data.directoryHistory.length === 4
      && exactHistory(globalHistory, global ?? {}, [0], [expectations.globalHistoryGeneration])
      && exactHistory(onboardingHistory, onboarding ?? {}, [0, 1, 0], expectations.onboardingHistoryGenerations)
      && historyGenerations.every(value => value <= generation?.generation)
      && Math.max(...historyGenerations) === generation?.generation,
    exactInactiveProjectGrant: data.projectGrants.length === 1 && project?.id === expectedProjectId
      && project.staff_id === selection.staffId && project.capability === "project.shared.sync"
      && project.effect === "allow" && project.scope_kind === "global" && nullish(project.business_area_id)
      && nullish(project.division_id) && nullish(project.external_project_id) && project.active === 0
      && project.granted_by === selection.staffId && Number.isSafeInteger(project.version) && project.version > 0
      && projectGeneration?.staff_id === selection.staffId && Number.isSafeInteger(projectGeneration.generation)
      && projectGeneration.generation === project.version,
    noAdditionalAuthority: allZero(data.minimalAuthority[0]),
    exactSyntheticRecord: record?.record_id === selection.recordId
      && ["organization", "client"].includes(record?.record_kind)
      && Number.isSafeInteger(record?.current_version) && record.current_version > 0,
    zeroActivationReceipts: data.activationReceipts.length === 0,
    zeroInFlightWork: inFlightNames.every(name => data[name].length === 0),
    foreignKeysClean: data.foreignKeyCheck.length === 0,
  };
  return { checks, ready: Object.values(checks).every(Boolean) };
}

export async function collectReadback({ base = root, selection, expectations, query, now = () => new Date() }) {
  safeId(selection?.staffId, "staff id");
  safeId(selection?.recordId, "record id", SYNTHETIC_RECORD_ID);
  const reviewed = reviewedExpectations(expectations);
  if (typeof query !== "function") throw new Error("query runner is required");
  const captureStartedAt = now().toISOString();
  const source = validateStagingConfiguration(base);
  const data = {};
  for (const definition of READBACK_QUERIES) {
    assertReadOnlyQuery(definition.sql);
    data[definition.name] = await query({ name: definition.name, sql: definition.sql, params: definition.params(selection) });
    if (!Array.isArray(data[definition.name])) throw new Error(`query ${definition.name} did not return rows`);
    if (definition.name === "staffUser") one(data.staffUser, "selected staff user");
    if (definition.name === "admission") one(data.admission, "selected admission");
    if (definition.name === "profile") one(data.profile, "selected profile");
    if (definition.name === "directoryGeneration") one(data.directoryGeneration, "Directory generation");
    if (definition.name === "projectGeneration") one(data.projectGeneration, "project generation");
    if (definition.name === "record") one(data.record, "selected synthetic record");
  }
  assertReadOnlyQuery(IDENTITY_COLLISIONS_QUERY.sql);
  data.identityCollisions = await query({ name: IDENTITY_COLLISIONS_QUERY.name, sql: IDENTITY_COLLISIONS_QUERY.sql,
    params: IDENTITY_COLLISIONS_QUERY.params(selection, one(data.staffUser, "selected staff user")) });
  assertReadOnlyQuery(MINIMAL_AUTHORITY_QUERY.sql);
  data.minimalAuthority = await query({ name: MINIMAL_AUTHORITY_QUERY.name, sql: MINIMAL_AUTHORITY_QUERY.sql,
    params: MINIMAL_AUTHORITY_QUERY.params(selection) });
  one(data.identityCollisions, "identity collision check");
  one(data.minimalAuthority, "minimal authority check");
  if (!allZero(data.identityCollisions[0])) throw new Error("selected actor identity is ambiguous");
  const { checks, ready } = evaluateReadiness(data, selection, source.inventory.names, reviewed);
  const captureCompletedAt = now().toISOString();
  return {
    schemaVersion: 1,
    environment: "staging",
    private: true,
    observedAt: captureCompletedAt,
    capture: {
      startedAt: captureStartedAt,
      completedAt: captureCompletedAt,
      atomicSnapshot: false,
    },
    limitations: {
      preflightOnly: true,
      provisioningAuthority: false,
      finalProvisionGuardMustRecheckLiveState: true,
      localMigrationHashesDoNotAttestRemoteAppliedSql: true,
    },
    selection: structuredClone(selection),
    reviewedHistoryGenerations: reviewed,
    source: {
      workerName: EXPECTED_WORKER_NAME,
      databaseName: EXPECTED_DATABASE_NAME,
      accountIdSha256: sha256(EXPECTED_ACCOUNT_ID),
      databaseIdSha256: sha256(EXPECTED_DATABASE_ID),
      configPath: CONFIG_PATH,
      configSha256: source.configSha256,
      localCanonicalLedger: {
        count: source.inventory.names.length,
        finalMigration: source.inventory.finalMigration,
        namesSha256: source.inventory.namesSha256,
        contentsSha256: source.inventory.contentsSha256,
        hashScope: "local-source-files-only",
        attestsRemoteAppliedSql: false,
      },
    },
    actor: {
      staffUser: data.staffUser[0], admission: data.admission[0], profile: data.profile[0],
      roles: data.roles, rolePermissions: data.rolePermissions, permissionOverrides: data.permissionOverrides,
      identityCollisions: data.identityCollisions[0], projectGeneration: data.projectGeneration[0],
      projectGrants: data.projectGrants,
    },
    directory: {
      generation: data.directoryGeneration[0], grants: data.directoryGrants,
      history: data.directoryHistory, businessAreas: data.businessAreas,
    },
    target: { record: data.record[0], reviews: data.recordReviews, activationReceipts: data.activationReceipts },
    authority: { minimal: data.minimalAuthority[0] },
    inFlight: Object.fromEntries(["staffManagementFences", "staffAdminFences", "writeFences", "projectLiveProofs", "pendingProjectOutbox", "pendingDirectoryOutbox",
      "pendingWorkspaceOutbox", "pendingAuthorityOutbox", "nonterminalRecipientIntents"].map(name => [name, data[name]])),
    integrity: { foreignKeyViolations: data.foreignKeyCheck },
    checks,
    ready,
    credentials: { valuesExcluded: true },
    mutationsPerformed: false,
  };
}

export function resolveOutputPath(base, requested) {
  if (typeof requested !== "string" || requested !== requested.trim()) throw new Error("output path is invalid");
  const allowedRoot = path.join(base, OUTPUT_ROOT);
  const target = path.resolve(base, requested);
  const relative = path.relative(allowedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== "."
    || !OUTPUT_NAME.test(path.basename(target)))
    throw new Error("output must be a new generic JSON file directly inside the private readback directory");
  for (const ancestor of [path.join(base, ".backups"), allowedRoot]) {
    const stat = lstat(ancestor);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("output ancestor is not a regular directory");
  }
  if (lstat(target)) throw new Error("output already exists");
  return { allowedRoot, target, relative: path.relative(base, target).replaceAll(path.sep, "/") };
}

export function writePrivateArtifact(base, requested, artifact) {
  const output = resolveOutputPath(base, requested);
  fs.mkdirSync(output.allowedRoot, { recursive: true, mode: 0o700 });
  for (const directory of [path.join(base, ".backups"), output.allowedRoot]) {
    const directoryStat = lstat(directory);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("output directory is unsafe");
  }
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(output.target, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { relative: output.relative, sha256: sha256(bytes) };
}

export function sanitizedSummary(artifact, written) {
  const inFlightCount = Object.values(artifact.inFlight).reduce((total, rows) => total + rows.length, 0);
  return {
    status: "captured",
    ready: artifact.ready,
    report: written.relative,
    sha256: written.sha256,
    counts: {
      directoryGrants: artifact.directory.grants.length,
      directoryHistory: artifact.directory.history.length,
      activationReceipts: artifact.target.activationReceipts.length,
      inFlight: inFlightCount,
    },
    checks: artifact.checks,
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseArguments(argv);
  const base = dependencies.base ?? root;
  const source = validateStagingConfiguration(base);
  resolveOutputPath(base, parsed.output);
  const token = dependencies.token ?? process.env.CLOUDFLARE_API_TOKEN;
  const query = dependencies.query ?? createD1QueryRunner({ fetchImpl: dependencies.fetchImpl, token,
    accountId: EXPECTED_ACCOUNT_ID, databaseId: source.database.database_id });
  const artifact = await collectReadback({ base, selection: { staffId: parsed.staffId, recordId: parsed.recordId },
    expectations: parsed.expectations, query, now: dependencies.now });
  const written = writePrivateArtifact(base, parsed.output, artifact);
  (dependencies.log ?? console.log)(JSON.stringify(sanitizedSummary(artifact, written)));
  return artifact.ready ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`staging recipient authority readback failed: ${error.message}`);
    process.exitCode = 1;
  });
}
