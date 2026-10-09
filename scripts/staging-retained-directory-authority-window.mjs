import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";
import { createPrivateEvidenceDirectory, writePrivateEvidence } from "./staging-native-authority-packet-rehearsal.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  RETAINED_DIRECTORY_TARGET as TARGET, REVIEWED_REFERENCE_BASELINE,
  applyAndReconcileRetainedDirectoryAuthority, compileRetainedDirectoryAuthority, verifyReviewedReferenceSchema,
} from "./staging-retained-directory-authority.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_LINEAGE = path.join(".backups", "staging-native-authority", "5731d19f-fea5-4be7-8b6f-83fc2e427e26");
const MAX_PRIVATE_JSON_BYTES = 16_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
const fail = message => { throw new Error(`staging-retained-directory-authority-window: ${message}`); };

function historicalJson(root, filename) {
  const privateRoot = path.resolve(root, PRIVATE_LINEAGE), resolved = path.resolve(privateRoot, filename);
  if (path.dirname(resolved) !== privateRoot) fail("private artifact path escaped");
  for (const candidate of [path.resolve(root), path.resolve(root, ".backups"), path.dirname(privateRoot), privateRoot, resolved]) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || candidate === resolved && (!stat.isFile() || stat.size > MAX_PRIVATE_JSON_BYTES)) fail("bounded non-symlink private artifact required");
    if (candidate !== resolved && !stat.isDirectory()) fail("private evidence directory required");
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function retainedPrivateJson(root, filename) {
  const evidenceRoot = path.resolve(root, ".backups", "staging-native-authority"), resolved = path.resolve(filename);
  const relative = path.relative(evidenceRoot, resolved), evidenceDir = path.dirname(resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) === "."
    || path.dirname(path.relative(evidenceRoot, evidenceDir)) !== "." || !UUID.test(path.basename(evidenceDir))) fail("private reactivation path escaped");
  for (const candidate of [path.resolve(root), path.resolve(root, ".backups"), evidenceRoot, evidenceDir, resolved]) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || candidate === resolved && (!stat.isFile() || stat.size > MAX_PRIVATE_JSON_BYTES)) fail("bounded non-symlink private artifact required");
    if (candidate !== resolved && !stat.isDirectory()) fail("private evidence directory required");
  }
  const isProvision = path.basename(resolved) === "provision.json";
  if (!isProvision && !/^revoke-recovery-[0-9TZ.-]+\.json$/.test(path.basename(resolved))) {
    fail("exact private retained artifact filename required");
  }
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (path.basename(evidenceDir) !== value?.approval?.approval_id) fail("private artifact directory identity mismatch");
  if (value?.input?.phase !== (isProvision ? "reactivate" : "revoke")) fail("private artifact filename phase mismatch");
  if (!isProvision && path.basename(resolved) !== `revoke-recovery-${value?.input?.approval?.executedAt?.replace(/:/g, "-")}.json`) {
    fail("exact private retained artifact filename required");
  }
  return value;
}

async function databaseClock(db) {
  const row = await first(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp");
  if (!row?.stamp) fail("database clock unavailable");
  return row.stamp;
}

async function snapshot(db) {
  await verifyReviewedReferenceSchema(db);
  const history = await all(db, "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version", TARGET.staffId);
  const referenceCounts = {};
  for (const name of Object.keys(REVIEWED_REFERENCE_BASELINE)) {
    referenceCounts[name] = (await first(db, `SELECT count(*) count FROM ${name} WHERE business_area_id=?`, TARGET.areaId)).count;
  }
  return {
    migrationNames: (await all(db, "SELECT name FROM d1_migrations ORDER BY name")).map(row => row.name),
    admission: await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", TARGET.staffId),
    profile: await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", TARGET.staffId),
    generation: await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", TARGET.staffId),
    projectGeneration: await first(db, "SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?", TARGET.staffId),
    businessArea: await first(db, "SELECT id,name,active FROM native_business_areas WHERE id=?", TARGET.areaId),
    resourceScope: await first(db, "SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id=?", TARGET.recordId),
    projectGrant: await first(db, `SELECT id,staff_id,capability,effect,scope_kind,business_area_id,division_id,external_project_id,active,version,granted_by,created_at
      FROM native_project_grants WHERE business_area_id=?`, TARGET.areaId),
    grants: await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", TARGET.staffId), history, referenceCounts,
    predecessor: await first(db, "SELECT command_id,source_id,resource_type,external_id,state,outcome_json FROM project_alpha_directory_outbox WHERE command_id=?", TARGET.predecessorCommandId),
  };
}

async function phaseRows(db, artifact) {
  return { approval: await first(db, "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.approval.approval_id),
    receipt: await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", artifact.receipt.command_id),
    activationApproval: artifact.input.phase === "revoke" ? await first(db,
      "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?", artifact.input.lineage.reactivationArtifact.approval.approval_id) : null };
}

function operations(dependencies = {}) {
  return { root: dependencies.root ?? ROOT, withBinding: dependencies.withBinding ?? withStagingAuthorityBinding,
    clock: dependencies.clock ?? databaseClock, snapshot: dependencies.snapshot ?? snapshot,
    compile: dependencies.compile ?? compileRetainedDirectoryAuthority,
    apply: dependencies.apply ?? applyAndReconcileRetainedDirectoryAuthority,
    createEvidence: dependencies.createEvidence ?? createPrivateEvidenceDirectory,
    writeEvidence: dependencies.writeEvidence ?? writePrivateEvidence,
    phaseRows: dependencies.phaseRows ?? phaseRows,
    randomUUID: dependencies.randomUUID ?? crypto.randomUUID,
    readHistorical: dependencies.readHistorical ?? historicalJson,
    readReactivation: dependencies.readReactivation ?? retainedPrivateJson };
}

function approval(clock, randomUUID) {
  const issued = new Date(clock), expires = new Date(issued.getTime() + 60 * 60_000);
  if (!Number.isFinite(issued.getTime())) fail("invalid database clock");
  return { approvalId: randomUUID(), commandId: randomUUID(), issuedAt: issued.toISOString(), expiresAt: expires.toISOString(), executedAt: issued.toISOString() };
}

function exactPost(before, after, artifact) {
  const ids = artifact.input.lineage.provisionArtifact.input.approval.grantIds;
  for (const key of ["admission", "profile", "businessArea", "resourceScope", "projectGrant", "projectGeneration",
    "migrationNames", "predecessor"]) if (!same(after[key], before[key])) fail("independent postread drift");
  const expectedCounts = { ...before.referenceCounts,
    native_directory_grant_history: before.referenceCounts.native_directory_grant_history + 3 };
  const priorHistory = after.history.filter(row => row.grant_generation <= before.generation.generation);
  const suffix = after.history.filter(row => row.grant_generation > before.generation.generation);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const priorTimestamp = Date.parse(before.generation.updated_at), currentTimestamp = Date.parse(after.generation.updated_at);
  if (!same(after.referenceCounts, expectedCounts)
    || !same(after.grants.filter(row => !ids.includes(row.id)), before.grants.filter(row => !ids.includes(row.id)))
    || !same(priorHistory, before.history) || suffix.length !== 3
    || after.generation.staff_id !== before.generation.staff_id
    || after.generation.generation !== before.generation.generation + 3
    || typeof after.generation.updated_at !== "string" || !timestamp.test(after.generation.updated_at)
    || !Number.isFinite(priorTimestamp) || currentTimestamp < priorTimestamp) fail("independent postread authority mismatch");
  for (const [index, id] of ids.entries()) {
    const oldGrant = before.grants.find(row => row.id === id), current = after.grants.find(row => row.id === id);
    const expectedActive = artifact.input.phase === "reactivate" ? 1 : 0;
    if (!oldGrant || !same(current, { ...oldGrant, active: expectedActive })) fail("independent postread retained grant mismatch");
    const history = suffix.find(row => row.grant_id === id);
    if (!history || history.grant_version !== (artifact.input.phase === "reactivate" ? 3 : 4)
      || history.active !== expectedActive || history.grant_generation !== before.generation.generation + index + 1
      || !["staff_id", "permission", "effect", "scope_kind", "business_area_id", "division_id", "resource_id"]
        .every(key => history[key] === oldGrant[key]) || typeof history.recorded_at !== "string"
      || !timestamp.test(history.recorded_at) || Date.parse(history.recorded_at) < priorTimestamp
      || Date.parse(history.recorded_at) > currentTimestamp) fail("independent postread retained history mismatch");
  }
  if (Math.max(...suffix.map(row => Date.parse(row.recorded_at))) !== currentTimestamp) fail("independent generation timestamp mismatch");
}

function exactPhaseRows(rows, artifact) {
  if (!same(rows.approval, artifact.approval) || !same(rows.receipt, artifact.receipt)) fail("independent approval receipt postread mismatch");
  if (artifact.input.phase === "revoke" && !same(rows.activationApproval,
    { ...artifact.input.lineage.reactivationArtifact.approval, revoked_at: artifact.input.approval.executedAt })) {
    fail("independent activation revocation postread mismatch");
  }
}

function historicalLineage(op) {
  const provision = op.readHistorical(op.root, "provision.json");
  const revoke = op.readHistorical(op.root, "revoke-recovery-2026-10-08T21-51-25.947Z.json");
  return { provisionArtifact: provision, revokeArtifact: revoke, provisionReceipt: provision.receipt, revokeReceipt: revoke.receipt };
}

async function build(db, phase, op, reactivation) {
  const before = await op.snapshot(db), stamp = await op.clock(db), lineage = historicalLineage(op);
  if (phase === "revoke") {
    if (!reactivation?.receipt) fail("exact local reactivation artifact required");
    lineage.reactivationArtifact = reactivation; lineage.reactivationReceipt = reactivation.receipt;
  }
  const input = { schemaVersion: 1, staging: STAGING_TARGET, phase, target: TARGET, ...before, lineage,
    approval: approval(stamp, op.randomUUID) };
  return { before, artifact: op.compile(input, { root: op.root }) };
}

async function persistBeforeApply(op, artifact, filename) {
  const evidence = op.createEvidence(op.root, artifact.approval.approval_id);
  const saved = op.writeEvidence(op.root, evidence.evidenceDir, filename, artifact);
  if (!saved) fail("private artifact save failed");
  return { evidence, path: saved };
}

export async function prepareRetainedDirectoryAuthority(configPath, dependencies = {}) {
  const op = operations(dependencies);
  return op.withBinding(configPath, async ({ db, target }) => {
    if (!same(target, STAGING_TARGET)) fail("trusted staging target mismatch");
    const { artifact } = await build(db, "reactivate", op);
    return { mode: "prepare-readonly", artifact, mutationsPerformed: false };
  }, dependencies);
}

export async function openRetainedDirectoryAuthority(configPath, dependencies = {}) {
  const op = operations(dependencies);
  return op.withBinding(configPath, async ({ db, target }) => {
    if (!same(target, STAGING_TARGET)) fail("trusted staging target mismatch");
    const { before, artifact } = await build(db, "reactivate", op);
    const saved = await persistBeforeApply(op, artifact, "provision.json");
    let outcome;
    try {
      outcome = await op.apply(db, artifact, { target });
      exactPost(before, await op.snapshot(db), artifact);
      exactPhaseRows(await op.phaseRows(db, artifact), artifact);
    } catch (error) {
      throw new Error(`retained authority open failed; inspect and close using exact private artifact ${saved.path}`, { cause: error });
    }
    return { mode: "applied", artifactPath: saved.path, receipt: artifact.receipt, outcome };
  }, dependencies);
}

export async function closeRetainedDirectoryAuthority(configPath, reactivationPath, dependencies = {}) {
  const op = operations(dependencies), reactivation = op.readReactivation(op.root, reactivationPath);
  if (reactivation?.input?.phase !== "reactivate") fail("exact private reactivation artifact required");
  return op.withBinding(configPath, async ({ db, target }) => {
    if (!same(target, STAGING_TARGET)) fail("trusted staging target mismatch");
    const { before, artifact } = await build(db, "revoke", op, reactivation);
    const revokeFilename = `revoke-recovery-${artifact.input.approval.executedAt.replace(/:/g, "-")}.json`;
    const saved = await persistBeforeApply(op, artifact, revokeFilename);
    let outcome;
    try {
      outcome = await op.apply(db, artifact, { target });
      exactPost(before, await op.snapshot(db), artifact);
      exactPhaseRows(await op.phaseRows(db, artifact), artifact);
    } catch (error) {
      throw new Error(`retained authority close outcome requires exact private receipt reconciliation at ${saved.path}`, { cause: error });
    }
    return { mode: "closed", artifactPath: saved.path, receipt: artifact.receipt, outcome };
  }, dependencies);
}

export async function reconcileSavedRetainedDirectoryAuthority(configPath, artifactPath, dependencies = {}) {
  const op = operations(dependencies), artifact = op.readReactivation(op.root, artifactPath);
  return op.withBinding(configPath, async ({ db, target }) => {
    if (!same(target, STAGING_TARGET)) fail("trusted staging target mismatch");
    const expected = op.compile(artifact.input, { root: op.root });
    if (!same(expected, artifact)) fail("saved retained artifact changed");
    const receipt = await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", artifact.receipt.command_id);
    const current = await op.snapshot(db);
    const rows = await op.phaseRows(db, artifact);
    if (receipt && same(receipt, artifact.receipt)) {
      exactPost(artifact.input, current, artifact);
      exactPhaseRows(rows, artifact);
      return { mode: "reconciled-committed", receipt, mutationsPerformed: false };
    }
    const keys = ["migrationNames", "admission", "profile", "generation", "projectGeneration", "businessArea", "resourceScope",
      "projectGrant", "grants", "history", "referenceCounts", "predecessor"];
    const activationUnchanged = artifact.input.phase !== "revoke" || same(rows.activationApproval, artifact.input.lineage.reactivationArtifact.approval);
    if (receipt === null && rows.receipt === null && rows.approval === null && activationUnchanged
      && keys.every(key => same(current[key], artifact.input[key]))) return { mode: "reconciled-not-committed", mutationsPerformed: false };
    fail("saved retained artifact outcome remains unknown");
  }, dependencies);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = argv[0] === "--config" ? ["prepare-readonly", ...argv] : argv;
  const [mode = "prepare-readonly", configFlag, configPath, artifactFlag, artifactPath] = values;
  if (configFlag !== "--config" || !configPath) fail("usage: [prepare-readonly|apply|close|reconcile] --config <path> [--artifact <private-retained-artifact.json>]");
  if ((mode === "prepare-readonly" || mode === "apply") && values.length !== 3) fail("unexpected CLI arguments");
  if ((mode === "close" || mode === "reconcile") && values.length !== 5) fail("unexpected CLI arguments");
  if (mode === "prepare-readonly") return prepareRetainedDirectoryAuthority(configPath, dependencies);
  if (mode === "apply") return openRetainedDirectoryAuthority(configPath, dependencies);
  if (mode === "close" && artifactFlag === "--artifact" && artifactPath && values.length === 5) return closeRetainedDirectoryAuthority(configPath, artifactPath, dependencies);
  if (mode === "reconcile" && artifactFlag === "--artifact" && artifactPath && values.length === 5) return reconcileSavedRetainedDirectoryAuthority(configPath, artifactPath, dependencies);
  fail("explicit apply or close mode required");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => process.stdout.write(`${JSON.stringify({ mode: result.mode, artifactPath: result.artifactPath ?? null, mutationsPerformed: result.mutationsPerformed ?? true })}\n`),
    error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
