import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";
import { createPrivateEvidenceDirectory } from "./staging-native-authority-packet-rehearsal.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  compileRelationshipRecoveryAuthorityV184,
  RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2,
} from "./staging-relationship-generation-recovery-authority-v184.mjs";
import {
  compileProjectOrganizationAuthorityV184,
  PROJECT_ORGANIZATION_AUTHORITY_V184_PURPOSE,
  PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET,
} from "./staging-project-organization-authority-v184.mjs";
import {
  applyProjectOrganizationAuthorityV184,
  reconcileProjectOrganizationAuthorityV184,
} from "./staging-project-organization-authority-v184-apply.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "restrict-private-authority-file.ps1");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_REVOKE = /^revoke-recovery-[0-9TZ.-]+\.json$/;
export const MAX_PRIVATE_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const PROJECT_ORGANIZATION_APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const fail = message => { throw Error(`project-organization-authority-v184-window: ${message}`); };
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();

export function writeProjectOrganizationPrivateEvidence(root, directory, filename, value) {
  const base = path.resolve(root, ".backups/staging-native-authority");
  const relative = path.relative(base, directory);
  if (!UUID.test(relative) || relative.includes(path.sep)
    || !["provision.json", "revoke.json"].includes(filename)) fail("invalid private evidence destination");
  for (const entry of [path.resolve(root), path.join(root, ".backups"), base, directory]) {
    const stat = fs.lstatSync(entry);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("private evidence ancestor must be a non-symlink directory");
  }
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_PRIVATE_ARTIFACT_BYTES) fail("private artifact exceeds size limit");
  const destination = path.join(directory, filename);
  const descriptor = fs.openSync(destination, "wx", 0o600);
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File",
      ACL_SCRIPT, "-LiteralFile", destination],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000 });
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
    if (fs.readFileSync(destination, "utf8") !== bytes) fail("private evidence verification failed");
  } catch (error) {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(destination); } catch {}
    throw error;
  }
  fs.closeSync(descriptor);
  return destination;
}

function privateFile(root, filename, allowedNames) {
  const base = path.resolve(root, ".backups/staging-native-authority");
  const resolved = path.resolve(filename);
  const relative = path.relative(base, resolved);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !UUID.test(parts[0]) || !allowedNames(parts[1])
    || relative.startsWith("..") || path.isAbsolute(relative)) fail("exact private authority path required");
  for (const entry of [path.resolve(root), path.join(root, ".backups"), base, path.join(base, parts[0]), resolved]) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (entry === resolved ? !stat.isFile() : !stat.isDirectory())) {
      fail("private evidence must be regular and non-symlink");
    }
  }
  const realBase = fs.realpathSync(base), realResolved = fs.realpathSync(resolved);
  const realRelative = path.relative(realBase, realResolved);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) fail("private artifact resolved outside evidence root");
  const stat = fs.statSync(realResolved);
  if (stat.size > MAX_PRIVATE_ARTIFACT_BYTES) fail("private artifact exceeds size limit");
  return { value: JSON.parse(fs.readFileSync(realResolved, "utf8")), resolved, directory: path.dirname(realResolved) };
}

function readRecovery(root, provisionFile, revokeFile, compile = compileRelationshipRecoveryAuthorityV184) {
  const provisionRead = privateFile(root, provisionFile, name => name === "provision.json");
  const revokeRead = privateFile(root, revokeFile, name => RECOVERY_REVOKE.test(name));
  const provision = provisionRead.value, revoke = revokeRead.value;
  if (![2, 3].includes(provision?.input?.schemaVersion) || revoke?.input?.schemaVersion !== provision.input.schemaVersion
    || provision.input.phase !== "provision" || revoke.input.phase !== "revoke"
    || !same(provision.input.target, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2)
    || !same(revoke.input.target, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2)
    || !same(provision, compile(provision.input, { root })) || !same(revoke, compile(revoke.input, { root }))
    || !same(revoke.input.provisionArtifact, provision)) fail("exact paired v2/v3 recovery artifacts required");
  return { provisionArtifact: provision, revokeArtifact: revoke };
}

export function readProjectOrganizationPrivateArtifact(root, filename, compile = compileProjectOrganizationAuthorityV184) {
  const read = privateFile(root, filename, name => name === "provision.json" || name === "revoke.json");
  const artifact = read.value;
  if (!same(artifact, compile(artifact?.input, { root }))) fail("saved project artifact changed");
  if (path.basename(read.directory) !== artifact.input.approval.provisionApprovalId) fail("project evidence directory does not match approval");
  return { artifact, ...read };
}

async function lineage(db, artifacts) {
  const p = artifacts.provisionArtifact, r = artifacts.revokeArtifact, staff = RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2.staffId;
  return {
    ...artifacts,
    approvals: await all(db, "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?) ORDER BY approval_id", p.approval.approval_id, r.approval.approval_id),
    receipts: await all(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?) ORDER BY command_id", p.receipt.command_id, r.receipt.command_id),
    directoryGrants: await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", staff),
    directoryGrantHistory: await all(db, "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation,grant_id,grant_version", staff),
    directoryGrantGeneration: await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", staff),
  };
}

async function projectSnapshot(db) {
  const target = PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET;
  return {
    migrationNames: (await all(db, "SELECT name FROM d1_migrations ORDER BY name")).map(row => row.name),
    staff: await first(db, "SELECT id,status,access_subject FROM staff_users WHERE id=?", target.staffId),
    roles: await all(db, "SELECT id,staff_id,role_id,scope,division_id,scope_key,created_by,created_at FROM staff_role_assignments WHERE staff_id=? ORDER BY id", target.staffId),
    admission: await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", target.staffId),
    profile: await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", target.staffId),
    businessArea: await first(db, "SELECT id,name,active FROM native_business_areas WHERE id=?", target.businessAreaId),
    projectGeneration: await first(db, "SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?", target.staffId),
    projectGrants: await all(db, "SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id", target.staffId),
  };
}

async function clock(db) {
  return (await first(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp")).stamp;
}

async function buildProvision(db, recovery, root, deps) {
  const state = await (deps.snapshot ?? projectSnapshot)(db);
  const closed = await (deps.lineage ?? lineage)(db, recovery);
  const now = await (deps.clock ?? clock)(db), uuid = deps.randomUUID ?? crypto.randomUUID;
  const reusable = state.projectGrants.filter(grant => grant.capability === "project.shared.sync" && grant.effect === "allow"
    && grant.scope_kind === "business_area" && grant.business_area_id === PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET.businessAreaId
    && grant.division_id === null && grant.external_project_id === null);
  if (reusable.length > 1 || reusable.some(grant => grant.active !== 0)) fail("exact inactive project grant identity required");
  const input = {
    schemaVersion: 2,
    purpose: PROJECT_ORGANIZATION_AUTHORITY_V184_PURPOSE,
    staging: STAGING_TARGET,
    ...state,
    target: PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET,
    recoveryLineage: closed,
    approval: {
      provisionApprovalId: uuid(), provisionCommandId: uuid(), revokeApprovalId: uuid(),
      revokeCommandId: uuid(), grantId: reusable[0]?.id ?? uuid(), issuedAt: now,
      expiresAt: new Date(Date.parse(now) + PROJECT_ORGANIZATION_APPROVAL_WINDOW_MS).toISOString(),
    },
  };
  return (deps.compile ?? compileProjectOrganizationAuthorityV184)(input, { root });
}

function summary(artifact, phase) {
  const selected = artifact[phase];
  return {
    commandId: selected.receipt.command_id,
    approvalId: selected.receipt.approval_id,
    planSha256: selected.receipt.canonical_plan_sha256,
    resultSha256: selected.receipt.result_sha256,
  };
}

async function trusted(config, deps, callback) {
  const runner = deps.withBinding ?? withStagingAuthorityBinding;
  return runner(config, async ({ db, target }) => {
    if (!same(target, STAGING_TARGET)) fail("trusted staging target required");
    return callback(db, target);
  }, deps);
}

export async function prepareProjectOrganizationAuthorityV184(config, recoveryProvision, recoveryRevoke, deps = {}) {
  const root = deps.root ?? ROOT;
  const recovery = (deps.readRecovery ?? readRecovery)(root, recoveryProvision, recoveryRevoke, deps.compileRecovery);
  return trusted(config, deps, async db => ({
    mode: "prepare-readonly",
    artifact: await buildProvision(db, recovery, root, deps),
    mutationsPerformed: false,
  }));
}

export async function openProjectOrganizationAuthorityV184(config, recoveryProvision, recoveryRevoke, deps = {}) {
  const root = deps.root ?? ROOT;
  const recovery = (deps.readRecovery ?? readRecovery)(root, recoveryProvision, recoveryRevoke, deps.compileRecovery);
  return trusted(config, deps, async (db, target) => {
    const artifact = await buildProvision(db, recovery, root, deps);
    const create = deps.createEvidence ?? createPrivateEvidenceDirectory;
    const write = deps.writeEvidence ?? writeProjectOrganizationPrivateEvidence;
    const directory = create(root, artifact.input.approval.provisionApprovalId).evidenceDir;
    const saved = write(root, directory, "provision.json", artifact);
    if (!saved) fail("private artifact save failed");
    try {
      const outcome = await (deps.apply ?? applyProjectOrganizationAuthorityV184)(db, artifact, "provision", { target, root });
      if (outcome?.status !== "settled") fail("committed authority poststate drifted");
      return { mode: "applied", artifactPath: saved, receipt: summary(artifact, "provision"), outcome: { status: "committed" } };
    } catch (error) {
      throw Error(`authority outcome unknown; reconcile ${saved}; do not retry`, { cause: error });
    }
  });
}

export async function closeProjectOrganizationAuthorityV184(config, projectProvision, deps = {}) {
  const root = deps.root ?? ROOT;
  const prior = (deps.readProject ?? readProjectOrganizationPrivateArtifact)(root, projectProvision, deps.compile);
  if (Object.hasOwn(prior.artifact.input, "provisionReadback")) fail("unsealed provision artifact required");
  return trusted(config, deps, async (db, target) => {
    const input = prior.artifact.input, ids = input.approval;
    const provisionReadback = {
      approval: await first(db, "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?", ids.provisionApprovalId),
      receipt: await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", ids.provisionCommandId),
      grant: await first(db, "SELECT * FROM native_project_grants WHERE id=?", ids.grantId),
    };
    const artifact = (deps.compile ?? compileProjectOrganizationAuthorityV184)({ ...input, provisionReadback }, { root });
    const write = deps.writeEvidence ?? writeProjectOrganizationPrivateEvidence;
    const saved = write(root, prior.directory, "revoke.json", artifact);
    if (!saved) fail("private revoke artifact save failed");
    try {
      const outcome = await (deps.apply ?? applyProjectOrganizationAuthorityV184)(db, artifact, "revoke", { target, root });
      if (outcome?.status !== "settled") fail("committed cleanup poststate drifted");
      return { mode: "closed", artifactPath: saved, receipt: summary(artifact, "revoke"), outcome: { status: "committed" } };
    } catch (error) {
      throw Error(`authority outcome unknown; reconcile ${saved}; do not retry`, { cause: error });
    }
  });
}

async function atomicReconciliationSnapshot(db, artifact, phase) {
  const input = artifact.input, ids = input.approval, target = input.target;
  const recoveryProvision = input.recoveryLineage.provisionArtifact, recoveryRevoke = input.recoveryLineage.revokeArtifact;
  const statements = [
    db.prepare("SELECT name FROM d1_migrations ORDER BY name"),
    db.prepare("SELECT id,status,access_subject FROM staff_users WHERE id=?").bind(target.staffId),
    db.prepare("SELECT id,staff_id,role_id,scope,division_id,scope_key,created_by,created_at FROM staff_role_assignments WHERE staff_id=? ORDER BY id").bind(target.staffId),
    db.prepare("SELECT * FROM native_staff_admissions WHERE staff_id=?").bind(target.staffId),
    db.prepare("SELECT * FROM native_staff_profiles WHERE staff_id=?").bind(target.staffId),
    db.prepare("SELECT id,name,active FROM native_business_areas WHERE id=?").bind(target.businessAreaId),
    db.prepare("SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?").bind(target.staffId),
    db.prepare("SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id").bind(target.staffId),
    db.prepare("SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?) ORDER BY approval_id").bind(recoveryProvision.approval.approval_id, recoveryRevoke.approval.approval_id),
    db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?) ORDER BY command_id").bind(recoveryProvision.receipt.command_id, recoveryRevoke.receipt.command_id),
    db.prepare("SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id").bind(RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2.staffId),
    db.prepare("SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation,grant_id,grant_version").bind(RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2.staffId),
    db.prepare("SELECT * FROM native_directory_grant_generations WHERE staff_id=?").bind(RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2.staffId),
    db.prepare("SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(phase === "provision" ? ids.provisionApprovalId : ids.revokeApprovalId),
    db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(phase === "provision" ? ids.provisionCommandId : ids.revokeCommandId),
    db.prepare("SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(ids.provisionApprovalId),
    db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(ids.provisionCommandId),
  ];
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length
    || results.some(result => result?.success !== true || !Array.isArray(result.results))) fail("invalid atomic reconciliation snapshot");
  const rows = index => results[index].results, one = index => rows(index).length === 1 ? rows(index)[0] : rows(index).length === 0 ? null : fail("non-unique reconciliation row");
  return {
    current: { migrationNames: rows(0).map(row => row.name), staff: one(1), roles: rows(2), admission: one(3), profile: one(4), businessArea: one(5), projectGeneration: one(6), projectGrants: rows(7) },
    currentLineage: { provisionArtifact: recoveryProvision, revokeArtifact: recoveryRevoke, approvals: rows(8), receipts: rows(9), directoryGrants: rows(10), directoryGrantHistory: rows(11), directoryGrantGeneration: one(12) },
    selectedApproval: one(13), selectedReceipt: one(14), provisionApproval: one(15), provisionReceipt: one(16),
  };
}

async function exactUntouched(db, artifact, phase, deps) {
  const input = artifact.input, ids = input.approval;
  const state = await (deps.reconciliationSnapshot ?? atomicReconciliationSnapshot)(db, artifact, phase);
  const { current, currentLineage, selectedApproval, selectedReceipt, provisionApproval, provisionReceipt } = state;
  const expectedGrants = phase === "provision" ? input.projectGrants
    : [...input.projectGrants.filter(grant => grant.id !== input.approval.grantId), input.provisionReadback.grant].sort((a, b) => a.id.localeCompare(b.id));
  const expectedGeneration = { ...input.projectGeneration, generation: input.projectGeneration.generation + (phase === "revoke" ? 1 : 0) };
  const staticState = ["migrationNames", "staff", "roles", "admission", "profile", "businessArea"]
    .every(key => same(current[key], input[key]));
  return staticState && same(current.projectGrants, expectedGrants) && same(current.projectGeneration, expectedGeneration)
    && same(currentLineage, input.recoveryLineage) && selectedApproval === null && selectedReceipt === null
    && (phase === "provision" || same(provisionApproval, input.provisionReadback.approval)
      && same(provisionReceipt, input.provisionReadback.receipt));
}

export async function reconcileProjectOrganizationAuthorityWindowV184(config, filename, deps = {}) {
  const root = deps.root ?? ROOT;
  const { artifact } = (deps.readProject ?? readProjectOrganizationPrivateArtifact)(root, filename, deps.compile);
  const phase = Object.hasOwn(artifact.input, "provisionReadback") ? "revoke" : "provision";
  return trusted(config, deps, async (db, target) => {
    const result = await (deps.reconcile ?? reconcileProjectOrganizationAuthorityV184)(db, artifact, phase, { target, root });
    if (result?.status === "settled") return { mode: "reconciled-readonly", mutationsPerformed: false, status: "committed", receipt: summary(artifact, phase) };
    if (await exactUntouched(db, artifact, phase, deps)) return { mode: "reconciled-readonly", mutationsPerformed: false, status: "not-committed" };
    fail("neither exact committed poststate nor exact untouched prestate; manual review required");
  });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [mode, configFlag, config, ...rest] = argv;
  if (configFlag !== "--config" || !config) fail("usage: prepare|open --config <path> --recovery-provision <path> --recovery-revoke <path>; close|reconcile --config <path> --artifact <path>");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) values.set(rest[index], rest[index + 1]);
  if ((mode === "prepare" || mode === "open") && rest.length === 4) {
    const p = values.get("--recovery-provision"), r = values.get("--recovery-revoke");
    if (!p || !r) fail("paired recovery artifacts required");
    return mode === "prepare" ? prepareProjectOrganizationAuthorityV184(config, p, r, deps)
      : openProjectOrganizationAuthorityV184(config, p, r, deps);
  }
  if ((mode === "close" || mode === "reconcile") && rest.length === 2 && values.get("--artifact")) {
    return mode === "close" ? closeProjectOrganizationAuthorityV184(config, values.get("--artifact"), deps)
      : reconcileProjectOrganizationAuthorityWindowV184(config, values.get("--artifact"), deps);
  }
  fail("invalid arguments");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => process.stdout.write(`${JSON.stringify({ mode: result.mode, artifactPath: result.artifactPath ?? null, mutationsPerformed: result.mutationsPerformed ?? true })}\n`),
    error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
