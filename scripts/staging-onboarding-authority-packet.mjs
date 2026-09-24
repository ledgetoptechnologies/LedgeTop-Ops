import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_APPS } from "./staging-bootstrap.mjs";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ONBOARDING_AUTHORITY_SCHEMA_VERSION = 1;
export const ONBOARDING_AUTHORITY_MIGRATIONS_TABLE = "staging_native_authority_migrations";
const OUTPUT_ROOT = ".staging-onboarding-authority";
const PURPOSE = "client-onboarding-positive-acceptance";
const SEEDED_OWNER = Object.freeze({ staffId: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com", displayName: "Beau Koltz" });
const ID = /^staging-[a-z0-9]+(?:[a-z0-9._:-]*[a-z0-9])?$/;
const PACKET_ID = /^staging-onboarding-authority-[a-z0-9]+(?:-[a-z0-9]+){1,7}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const sql = value => `'${String(value).replaceAll("'", "''")}'`;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const canonicalJson = value => JSON.stringify(value);

function exactKeys(value, allowed, label, errors) {
  if (!plain(value)) { errors.push(`${label} must be an object`); return; }
  for (const key of allowed) if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`unexpected ${label}.${key}`);
}

export function validateOnboardingAuthorityInput(input) {
  const errors = [];
  exactKeys(input, ["schemaVersion", "packet"], "input", errors);
  if (!plain(input)) return errors;
  if (input.schemaVersion !== ONBOARDING_AUTHORITY_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  const p = input.packet;
  exactKeys(p, ["packetId", "purpose", "operatorKind", "staffId", "email", "displayName", "accessSubject", "businessAreaId", "issuedAt", "expiresAt", "reason", "expected", "evidence"], "packet", errors);
  if (!plain(p)) return errors;
  exactKeys(p.expected, ["admissionVersion", "profileVersion"], "packet.expected", errors);
  exactKeys(p.evidence, ["changeTicket", "reviewer", "bindingEvidenceSha256"], "packet.evidence", errors);
  if (!PACKET_ID.test(p.packetId ?? "")) errors.push("packet.packetId is invalid");
  if (p.purpose !== PURPOSE) errors.push(`packet.purpose must be ${PURPOSE}`);
  if (!['synthetic', 'legacy-roster-staging'].includes(p.operatorKind)) errors.push("packet.operatorKind is invalid");
  const seeded = p.staffId === SEEDED_OWNER.staffId && p.email === SEEDED_OWNER.email && p.displayName === SEEDED_OWNER.displayName;
  if (p.operatorKind === "legacy-roster-staging" && !seeded) errors.push("legacy-roster-staging requires the exact seeded staging owner tuple");
  if (p.operatorKind === "synthetic" && (!ID.test(p.staffId ?? "") || !String(p.email ?? "").includes("staging") || !/staging/i.test(p.displayName ?? "")))
    errors.push("synthetic operator identity must be visibly staging-only");
  if (!SUBJECT.test(p.accessSubject ?? "") || String(p.accessSubject).split(".").length === 3) errors.push("packet.accessSubject must be an opaque subject, not a token");
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/.test(p.businessAreaId ?? "")) errors.push("packet.businessAreaId is invalid");
  if (!plain(p.expected) || !Number.isSafeInteger(p.expected?.admissionVersion) || p.expected.admissionVersion < 1
    || !Number.isSafeInteger(p.expected?.profileVersion) || p.expected.profileVersion < 1) errors.push("expected versions must be positive safe integers");
  for (const key of ["issuedAt", "expiresAt"]) if (!EXACT_UTC.test(p[key] ?? "") || new Date(p[key]).toISOString() !== p[key]) errors.push(`packet.${key} must be exact UTC`);
  const issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt);
  if (Number.isFinite(issued) && Number.isFinite(expires) && (expires <= issued || expires - issued > 4 * 60 * 60 * 1000)) errors.push("authority window must be positive and no longer than four hours");
  if (typeof p.reason !== "string" || p.reason.length < 8 || p.reason.length > 500 || /replace|placeholder/i.test(p.reason)) errors.push("packet.reason is invalid");
  for (const key of ["changeTicket", "reviewer"]) if (typeof p.evidence?.[key] !== "string" || p.evidence[key].length < 3 || /replace|placeholder/i.test(p.evidence[key])) errors.push(`packet.evidence.${key} is invalid`);
  if (!SHA256.test(p.evidence?.bindingEvidenceSha256 ?? "") || /^([0-9a-f])\1{63}$/.test(p.evidence?.bindingEvidenceSha256 ?? "")) errors.push("binding evidence digest is invalid");
  return errors;
}

function databaseIdentities(config) {
  return (config?.d1_databases ?? []).map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id }))
    .sort((a, b) => String(a.binding).localeCompare(String(b.binding)));
}
function regular(file, label) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
function canonicalOperations(base) {
  const app = path.join(base, "apps", "operations"), configPath = path.join(app, "wrangler.staging.json");
  regular(configPath, "Operations staging config");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")), expected = STAGING_INVENTORY.operations;
  if (config.name !== "ledgetop-ops-staging" || config.account_id !== STAGING_ACCOUNT_ID || config.vars?.ENVIRONMENT !== "staging"
    || !isDeepStrictEqual(databaseIdentities(config), databaseIdentities(expected))) throw new Error("authority source must be the exact staging Operations config");
  const selected = config.d1_databases.find(row => row.binding === "OPS_DB"), wanted = expected.d1_databases.find(row => row.binding === "OPS_DB");
  if (!selected || selected.database_name !== "ltds-ops-staging" || selected.database_id !== wanted?.database_id || selected.migrations_dir !== "migrations") throw new Error("authority source must use the exact canonical Operations D1 binding");
  const directory = path.join(app, "migrations"), names = fs.readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  const contract = BOOTSTRAP_APPS.operations;
  if (names.length !== contract.migrationCount || sha256(names.join("\n")) !== contract.migrationNamesSha256) throw new Error(`authority source must be the exact complete ${contract.migrationCount}-file Operations chain`);
  const contents = names.map(name => { const file = path.join(directory, name); regular(file, name); return `${name}\0${sha256(fs.readFileSync(file, "utf8"))}`; });
  if (sha256(contents.join("\n")) !== contract.migrationContentsSha256) throw new Error("Operations canonical migration contents changed");
  return { config, selected, names, chainSha256: sha256(contents.join("\n")) };
}

function ledger(names) {
  const encoded = sql(JSON.stringify(names));
  return `(SELECT count(*) FROM d1_migrations)=${names.length}
    AND NOT EXISTS(SELECT 1 FROM json_each(${encoded}) expected WHERE NOT EXISTS(SELECT 1 FROM d1_migrations applied WHERE applied.name=expected.value))
    AND NOT EXISTS(SELECT 1 FROM d1_migrations applied WHERE NOT EXISTS(SELECT 1 FROM json_each(${encoded}) expected WHERE expected.value=applied.name))`;
}
function guardTable(packetId, phase) { return `staging_onboarding_authority_guard_${sha256(`${packetId}:${phase}`).slice(0, 20)}`; }
function guard(table, predicate) { return `INSERT INTO ${table}(ok) SELECT CASE WHEN (${predicate}) THEN 1 ELSE 0 END;`; }
function plan(p, action, ids) {
  return { schemaVersion: 1, environment: "staging", purpose: PURPOSE, packetId: p.packetId, action,
    staffId: p.staffId, emailSha256: sha256(p.email), displayNameSha256: sha256(p.displayName), accessSubjectSha256: sha256(p.accessSubject),
    businessAreaIdSha256: sha256(p.businessAreaId), grant: { id: ids.grant, permission: "directory.profile.edit", effect: "allow", scopeKind: "business_area" },
    issuedAt: p.issuedAt, expiresAt: p.expiresAt, reason: p.reason, evidence: p.evidence,
    expected: action === "provision" ? p.expected : { admissionVersion: p.expected.admissionVersion + 1, profileVersion: p.expected.profileVersion, grantActive: 1 },
    result: action === "provision" ? { admissionVersion: p.expected.admissionVersion + 1, profileVersion: p.expected.profileVersion, grantActive: 1 }
      : { admissionVersion: p.expected.admissionVersion + 2, profileVersion: p.expected.profileVersion, grantActive: 0 } };
}
function verification(p) { return canonicalJson({ schemaVersion: 1, packetId: p.packetId, staffId: p.staffId, accessSubjectSha256: sha256(p.accessSubject), bindingEvidenceSha256: p.evidence.bindingEvidenceSha256 }); }
function approval(p, ids, action, planJson, planSha, verificationJson, verificationSha) {
  const id = action === "provision" ? ids.provisionApproval : ids.revokeApproval;
  return `INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,issued_by_staff_id,issued_by_access_subject,issued_at,expires_at)
VALUES(${sql(id)},${sql(planJson)},${sql(planSha)},${sql(p.staffId)},${sql(p.accessSubject)},${sql(verificationJson)},${sql(verificationSha)},${sql(p.staffId)},${sql(p.accessSubject)},${sql(p.issuedAt)},${sql(p.expiresAt)});`;
}
function receipt(p, ids, action, planJson, planSha, verificationJson, verificationSha, result) {
  const approvalId = action === "provision" ? ids.provisionApproval : ids.revokeApproval, commandId = action === "provision" ? ids.provisionCommand : ids.revokeCommand;
  const resultJson = canonicalJson(result);
  return `INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256)
VALUES(${sql(commandId)},${sql(approvalId)},${sql(p.staffId)},${sql(p.accessSubject)},${sql(planJson)},${sql(planSha)},${sql(verificationJson)},${sql(verificationSha)},${sql(resultJson)},${sql(sha256(resultJson))});`;
}
function noWork(staff) {
  return `NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=${staff})
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE json_extract(origin_snapshot_json,'$.actorId')=${staff} AND state IN ('pending','leased'))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox outbox JOIN native_project_command_proofs proof ON proof.command_id=outbox.command_id WHERE proof.actor_staff_id=${staff} AND outbox.state IN ('pending','leased'))
    AND NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs WHERE actor_staff_id=${staff})`;
}
function priorApproval(p, ids, provision) {
  return `EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sql(ids.provisionApproval)} AND canonical_plan_json=${sql(provision.planJson)} AND canonical_plan_sha256=${sql(provision.planSha)} AND approved_operator_staff_id=${sql(p.staffId)} AND approved_operator_access_subject=${sql(p.accessSubject)} AND independent_binding_verification_json=${sql(provision.verificationJson)} AND independent_binding_verification_sha256=${sql(provision.verificationSha)} AND issued_by_staff_id=${sql(p.staffId)} AND issued_by_access_subject=${sql(p.accessSubject)} AND issued_at=${sql(p.issuedAt)} AND expires_at=${sql(p.expiresAt)} AND revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sql(ids.provisionCommand)} AND approval_id=${sql(ids.provisionApproval)} AND operator_staff_id=${sql(p.staffId)} AND operator_access_subject=${sql(p.accessSubject)} AND canonical_plan_json=${sql(provision.planJson)} AND canonical_plan_sha256=${sql(provision.planSha)} AND independent_binding_verification_json=${sql(provision.verificationJson)} AND independent_binding_verification_sha256=${sql(provision.verificationSha)} AND result_json=${sql(provision.resultJson)} AND result_sha256=${sql(provision.resultSha)})`;
}

function sqlArtifacts(p, ids, names, migrationNames) {
  const staff = sql(p.staffId), area = sql(p.businessAreaId), activeVersion = p.expected.admissionVersion + 1;
  const verificationJson = verification(p), verificationSha = sha256(verificationJson);
  const pp = canonicalJson(plan(p, "provision", ids)), ppSha = sha256(pp), provisionResult = plan(p, "provision", ids).result, provisionResultJson = canonicalJson(provisionResult);
  const rp = canonicalJson(plan(p, "revoke", ids)), rpSha = sha256(rp), revokeResult = plan(p, "revoke", ids).result;
  const provisionEvidence = { planJson: pp, planSha: ppSha, verificationJson, verificationSha, resultJson: provisionResultJson, resultSha: sha256(provisionResultJson) };
  const provisionTable = guardTable(p.packetId, "provision"), revokeTable = guardTable(p.packetId, "revoke");
  const common = `(SELECT count(*) FROM staff_users WHERE id=${staff} AND email=${sql(p.email)} AND display_name=${sql(p.displayName)} AND status='active' AND access_subject=${sql(p.accessSubject)})=1
    AND NOT EXISTS(SELECT 1 FROM staff_users WHERE id<>${staff} AND (lower(email)=${sql(p.email)} OR access_subject=${sql(p.accessSubject)}))
    AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND bound_access_subject=${sql(p.accessSubject)} AND active=0 AND version=${p.expected.admissionVersion} AND admitted_by=${staff})
    AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sql(p.email)} AND display_name=${sql(p.displayName)} AND version=${p.expected.profileVersion})
    AND EXISTS(SELECT 1 FROM native_business_areas WHERE id=${area} AND active=1)
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=${staff} AND active=1)
    AND (NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sql(ids.grant)} OR (staff_id=${staff} AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='business_area' AND business_area_id=${area} AND division_id IS NULL AND resource_id IS NULL))
      OR EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sql(ids.grant)} AND staff_id=${staff} AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='business_area' AND business_area_id=${area} AND division_id IS NULL AND resource_id IS NULL AND active=0 AND granted_by=${staff}))
    AND NOT EXISTS(SELECT 1 FROM native_project_grants WHERE staff_id=${staff} AND active=1)
    AND ${noWork(staff)}`;
  const provision = `PRAGMA foreign_keys = ON;
-- Staging-only, business-area-scoped client-onboarding acceptance authority. No Project authority.
CREATE TABLE ${provisionTable}(ok INTEGER NOT NULL CHECK(ok=1));
${guard(provisionTable, `${ledger(names)} AND NOT EXISTS(SELECT 1 FROM ${ONBOARDING_AUTHORITY_MIGRATIONS_TABLE} WHERE name IN (${sql(migrationNames.provision)},${sql(migrationNames.revoke)})) AND ${common} AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id IN (${sql(ids.provisionApproval)},${sql(ids.revokeApproval)})) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id IN (${sql(ids.provisionCommand)},${sql(ids.revokeCommand)})) AND ${sql(p.issuedAt)}<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${sql(p.expiresAt)}>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)}
${approval(p, ids, "provision", pp, ppSha, verificationJson, verificationSha)}
UPDATE native_staff_admissions SET active=1,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=${staff} AND active=0 AND version=${p.expected.admissionVersion};
INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by)
SELECT ${sql(ids.grant)},${staff},'directory.profile.edit','allow','business_area',${area},0,${staff}
WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sql(ids.grant)});
UPDATE native_directory_grants SET active=1 WHERE id=${sql(ids.grant)} AND staff_id=${staff} AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='business_area' AND business_area_id=${area} AND division_id IS NULL AND resource_id IS NULL AND active=0 AND granted_by=${staff};
${receipt(p, ids, "provision", pp, ppSha, verificationJson, verificationSha, provisionResult)}
${guard(provisionTable, `EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND active=1 AND version=${activeVersion}) AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND version=${p.expected.profileVersion}) AND (SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff} AND active=1)=1 AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sql(ids.grant)} AND staff_id=${staff} AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='business_area' AND business_area_id=${area} AND division_id IS NULL AND resource_id IS NULL AND active=1 AND granted_by=${staff}) AND NOT EXISTS(SELECT 1 FROM native_project_grants WHERE staff_id=${staff} AND active=1) AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sql(ids.provisionCommand)} AND canonical_plan_sha256=${sql(ppSha)})`)}
DROP TABLE ${provisionTable};
`;
  const revoke = `PRAGMA foreign_keys = ON;
-- Staging-only revocation. Preserves all prior packet ledgers and inactive authority rows.
CREATE TABLE ${revokeTable}(ok INTEGER NOT NULL CHECK(ok=1));
${guard(revokeTable, `${ledger(names)} AND EXISTS(SELECT 1 FROM ${ONBOARDING_AUTHORITY_MIGRATIONS_TABLE} WHERE name=${sql(migrationNames.provision)}) AND NOT EXISTS(SELECT 1 FROM ${ONBOARDING_AUTHORITY_MIGRATIONS_TABLE} WHERE name=${sql(migrationNames.revoke)}) AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND bound_access_subject=${sql(p.accessSubject)} AND active=1 AND version=${activeVersion} AND admitted_by=${staff}) AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND login_email=${sql(p.email)} AND display_name=${sql(p.displayName)} AND version=${p.expected.profileVersion}) AND (SELECT count(*) FROM native_directory_grants WHERE staff_id=${staff} AND active=1)=1 AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sql(ids.grant)} AND staff_id=${staff} AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='business_area' AND business_area_id=${area} AND active=1 AND granted_by=${staff}) AND NOT EXISTS(SELECT 1 FROM native_project_grants WHERE staff_id=${staff} AND active=1) AND ${priorApproval(p, ids, provisionEvidence)} AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sql(ids.revokeApproval)}) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sql(ids.revokeCommand)}) AND ${noWork(staff)}`)}
${approval(p, ids, "revoke", rp, rpSha, verificationJson, verificationSha)}
UPDATE native_directory_grants SET active=0 WHERE id=${sql(ids.grant)} AND staff_id=${staff} AND active=1;
UPDATE native_staff_admissions SET active=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=${staff} AND active=1 AND version=${activeVersion};
UPDATE native_staff_bootstrap_approvals SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE approval_id=${sql(ids.provisionApproval)} AND revoked_at IS NULL;
${receipt(p, ids, "revoke", rp, rpSha, verificationJson, verificationSha, revokeResult)}
${guard(revokeTable, `EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=${staff} AND active=0 AND version=${activeVersion + 1}) AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=${staff} AND version=${p.expected.profileVersion}) AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=${sql(ids.grant)} AND active=0) AND NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=${staff} AND active=1) AND NOT EXISTS(SELECT 1 FROM native_project_grants WHERE staff_id=${staff} AND active=1) AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=${sql(ids.provisionApproval)} AND revoked_at IS NOT NULL) AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=${sql(ids.revokeCommand)} AND canonical_plan_sha256=${sql(rpSha)})`)}
DROP TABLE ${revokeTable};
`;
  return { provision, revoke, provisionPlan: plan(p, "provision", ids), revokePlan: plan(p, "revoke", ids) };
}

export function buildOnboardingAuthorityArtifacts(base, input, phase) {
  const errors = validateOnboardingAuthorityInput(input); if (errors.length) throw new Error(errors.join("\n"));
  if (!['provision', 'revoke'].includes(phase)) throw new Error("phase must be provision or revoke");
  const { config, selected, names, chainSha256 } = canonicalOperations(base), p = structuredClone(input.packet);
  const ids = { grant: `staging-onboarding-profile-edit:${sha256(`${p.staffId}:${p.businessAreaId}`).slice(0, 32)}`, provisionApproval: `${p.packetId}:provision:approval`, provisionCommand: `${p.packetId}:provision:command`, revokeApproval: `${p.packetId}:revoke:approval`, revokeCommand: `${p.packetId}:revoke:command` };
  const migrationNames = { provision: `0001_${p.packetId.replaceAll('-', '_')}_provision.sql`, revoke: `0002_${p.packetId.replaceAll('-', '_')}_revoke.sql` };
  const built = sqlArtifacts(p, ids, names, migrationNames), configs = {};
  for (const action of ["provision", "revoke"]) { const output = structuredClone(config), db = output.d1_databases.find(row => row.binding === "OPS_DB"); db.migrations_dir = `${OUTPUT_ROOT}/${p.packetId}/${action}`; db.migrations_table = ONBOARDING_AUTHORITY_MIGRATIONS_TABLE; configs[action] = output; }
  const baseManifest = { schemaVersion: 1, environment: "staging", purpose: PURPOSE, packetId: p.packetId, databaseName: selected.database_name, databaseId: selected.database_id, canonicalMigrationCount: names.length, canonicalMigrationChainSha256: chainSha256, staffId: p.staffId, businessAreaIdSha256: sha256(p.businessAreaId), grant: built.provisionPlan.grant };
  const manifests = { provision: { ...baseManifest, phase: "provision", migration: { name: migrationNames.provision, sha256: sha256(built.provision) }, plan: built.provisionPlan }, revoke: { ...baseManifest, phase: "revoke", migration: { name: migrationNames.revoke, sha256: sha256(built.revoke) }, plan: built.revokePlan } };
  return { packet: p, ids, configs, provision: { name: migrationNames.provision, sql: built.provision, manifest: manifests.provision }, revoke: { name: migrationNames.revoke, sql: built.revoke, manifest: manifests.revoke }, phase };
}

function files(base, artifact) {
  const dir = path.join(base, "apps", "operations", OUTPUT_ROOT, artifact.packet.packetId), values = new Map([
    [path.join(base, "apps", "operations", `wrangler.staging.onboarding-authority.${artifact.packet.packetId}.provision.json`), `${JSON.stringify(artifact.configs.provision, null, 2)}\n`],
    [path.join(dir, "provision", artifact.provision.name), artifact.provision.sql], [path.join(dir, "provision.manifest.json"), `${JSON.stringify(artifact.provision.manifest, null, 2)}\n`],
  ]);
  if (artifact.phase === "revoke") { values.set(path.join(base, "apps", "operations", `wrangler.staging.onboarding-authority.${artifact.packet.packetId}.revoke.json`), `${JSON.stringify(artifact.configs.revoke, null, 2)}\n`); values.set(path.join(dir, "revoke", artifact.revoke.name), artifact.revoke.sql); values.set(path.join(dir, "revoke.manifest.json"), `${JSON.stringify(artifact.revoke.manifest, null, 2)}\n`); }
  return values;
}
export function writeOnboardingAuthority(base, artifact) { const written = []; for (const [file, content] of files(base, artifact)) { if (fs.existsSync(file)) { if (fs.readFileSync(file, "utf8") !== content) throw new Error(`${path.relative(base, file)} is stale or edited`); continue; } fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 }); written.push(path.relative(base, file)); } return written; }
export function validateGeneratedOnboardingAuthority(base, artifact) { const errors = []; for (const [file, content] of files(base, artifact)) { if (!fs.existsSync(file)) errors.push(`${path.relative(base, file)} is missing`); else if (fs.readFileSync(file, "utf8") !== content) errors.push(`${path.relative(base, file)} is stale or edited`); } return errors; }
function run(argv = process.argv.slice(2), base = root) { let mode, phase, values; for (let i=0;i<argv.length;i++) { if (["--write","--check"].includes(argv[i])) mode=argv[i]; else if (argv[i]==="--phase") phase=argv[++i]; else if (argv[i]==="--values") values=argv[++i]; else throw new Error(`unknown argument ${argv[i]}`); } if (!mode || !phase || !values) throw new Error("usage: --write|--check --phase provision|revoke --values <ignored-json>"); const file=path.resolve(base,values), artifact=buildOnboardingAuthorityArtifacts(base,JSON.parse(fs.readFileSync(file,"utf8")),phase); if(mode==="--write") return writeOnboardingAuthority(base,artifact); const errors=validateGeneratedOnboardingAuthority(base,artifact); if(errors.length) throw new Error(errors.join("\n")); return []; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { const written=run(); console.log(`Staging onboarding authority artifacts current; ${written.length} file(s) written. No SQL was applied.`); } catch(error) { console.error(`Staging onboarding authority packet failed: ${error.message}`); process.exitCode=1; } }
