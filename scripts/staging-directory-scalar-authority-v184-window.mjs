import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";
import {
  createPrivateEvidenceDirectory,
  writePrivateEvidence,
} from "./staging-native-authority-packet-rehearsal.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  DIRECTORY_SCALAR_AUTHORITY_V184_TARGET as target,
  applyDirectoryScalarAuthorityV184,
  compileDirectoryScalarAuthorityV184,
} from "./staging-directory-scalar-authority-v184.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FILES = new Set([
  "recovery-lineage.json",
  "scalar-prestate.json",
  "provision.json",
  "revoke.json",
  "settlement.json",
  "granted-readback.json",
]);

function fail(message) {
  throw Error(`staging-directory-scalar-authority-v184-window: ${message}`);
}

async function all(db, sql, ...params) {
  return (await db.prepare(sql).bind(...params).all()).results;
}

function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

async function snapshot(db) {
  return {
    migrationNames: (await all(db, "SELECT name FROM d1_migrations ORDER BY name")).map(
      (row) => row.name,
    ),
    staff: await first(
      db,
      "SELECT id,status,access_subject FROM staff_users WHERE id=?",
      target.staffId,
    ),
    admission: await first(
      db,
      "SELECT * FROM native_staff_admissions WHERE staff_id=?",
      target.staffId,
    ),
    profile: await first(
      db,
      "SELECT * FROM native_staff_profiles WHERE staff_id=?",
      target.staffId,
    ),
    generation: await first(
      db,
      "SELECT * FROM native_directory_grant_generations WHERE staff_id=?",
      target.staffId,
    ),
    record: await first(
      db,
      "SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id=?",
      target.clientRecordId,
    ),
    relationship: await first(
      db,
      "SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?",
      target.clientRecordId,
    ),
    grants: await all(
      db,
      "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id",
      target.staffId,
    ),
    history: await all(
      db,
      "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation",
      target.staffId,
    ),
  };
}

async function clock(db) {
  return (await first(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp")).stamp;
}

function privatePath(root, file, expectedNames = FILES) {
  const base = path.resolve(root, ".backups/staging-native-authority");
  const resolved = path.resolve(file);
  const relative = path.relative(base, resolved);
  const parts = relative.split(path.sep);
  if (
    parts.length !== 2 ||
    !UUID.test(parts[0]) ||
    !expectedNames.has(parts[1]) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    fail("exact private authority path required");
  }
  for (const entry of [
    path.resolve(root),
    path.resolve(root, ".backups"),
    base,
    path.join(base, parts[0]),
    resolved,
  ]) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (entry === resolved ? !stat.isFile() : !stat.isDirectory())) {
      fail("private evidence must be regular and non-symlink");
    }
  }
  const realBase = fs.realpathSync(base);
  const realResolved = fs.realpathSync(resolved);
  const realRelative = path.relative(realBase, realResolved);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    fail("private artifact resolved outside evidence root");
  }
  return realResolved;
}

function readJson(root, file, expectedNames) {
  return JSON.parse(fs.readFileSync(privatePath(root, file, expectedNames), "utf8"));
}

function readArtifact(root, file) {
  const artifact = readJson(root, file, new Set(["provision.json", "revoke.json"]));
  if (!same(artifact, compileDirectoryScalarAuthorityV184(artifact.input, { root }))) {
    fail("saved provision artifact changed");
  }
  return artifact;
}

async function build(db, phase, evidence, root, deps) {
  const state = await (deps.snapshot ?? snapshot)(db);
  // This pre-apply D1 observation is the bounded evidence floor for the
  // authority mutation. It is not asserted to be the transaction commit time.
  const stamp = await (deps.clock ?? clock)(db);
  const uuid = deps.randomUUID ?? crypto.randomUUID;
  const input = {
    schemaVersion: 1,
    staging: STAGING_TARGET,
    phase,
    target,
    ...state,
    recoveryLineage: evidence.recoveryLineage,
    scalarPrestate: evidence.scalarPrestate,
    approval: {
      approvalId: uuid(),
      commandId: uuid(),
      issuedAt: stamp,
      expiresAt: new Date(Date.parse(stamp) + 60 * 60_000).toISOString(),
      executedAt: stamp,
    },
    ...(phase === "revoke"
      ? { provisionArtifact: evidence.provisionArtifact, settlement: evidence.settlement }
      : {}),
  };
  return (deps.compile ?? compileDirectoryScalarAuthorityV184)(input, { root });
}

function phaseDirectoryState(artifact) {
  const snapshot = artifact.input.phase === "provision"
    ? artifact.input.scalarPrestate?.before
    : artifact.input.settlement?.settled;
  if (!snapshot?.record || !snapshot.relationship) return null;
  const project = (value, template) => Object.fromEntries(
    Object.keys(template).map((key) => [key, value[key]]),
  );
  return {
    record: project(snapshot.record, artifact.input.record),
    relationship: project(snapshot.relationship, artifact.input.relationship),
  };
}

async function reconcile(db, artifact, deps = {}) {
  const current = await (deps.snapshot ?? snapshot)(db);
  const approval = await first(
    db,
    "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?",
    artifact.approval.approval_id,
  );
  const receipt = await first(
    db,
    "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?",
    artifact.receipt.command_id,
  );
  const selected = new Set(artifact.selection.map((entry) => entry.grantId));
  const expectedActive = artifact.input.phase === "provision" ? 1 : 0;
  const committedGrants = artifact.input.grants.map((grant) =>
    selected.has(grant.id) ? { ...grant, active: expectedActive } : grant,
  );
  const historyPrefix = current.history.slice(0, artifact.input.history.length);
  const historySuffix = current.history.slice(artifact.input.history.length);
  const executionObservedAt = Date.parse(artifact.input.approval.executedAt);
  const updatedAt = Date.parse(current.generation?.updated_at);
  const directoryState = phaseDirectoryState(artifact);
  const exactProtectedState = directoryState !== null &&
    same(artifact.input.record, directoryState.record) &&
    same(artifact.input.relationship, directoryState.relationship) &&
    same(current.staff, artifact.input.staff) &&
    same(current.admission, artifact.input.admission) &&
    same(current.profile, artifact.input.profile) &&
    same(current.record, directoryState.record) &&
    same(current.relationship, directoryState.relationship);
  const committedGeneration =
    current.generation?.staff_id === artifact.input.generation.staff_id &&
    current.generation?.generation === artifact.input.generation.generation + 2 &&
    typeof current.generation?.updated_at === "string" &&
    TIMESTAMP.test(current.generation.updated_at) &&
    Number.isFinite(updatedAt) &&
    updatedAt >= executionObservedAt;
  const committedHistory =
    same(historyPrefix, artifact.input.history) &&
    historySuffix.length === artifact.selection.length &&
    artifact.selection.length === 2 &&
    artifact.selection.every((selection, index) => {
      const grant = artifact.input.grants.find((candidate) => candidate.id === selection.grantId);
      const row = historySuffix[index];
      if (!grant || !row || typeof row.recorded_at !== "string" || !TIMESTAMP.test(row.recorded_at)) {
        return false;
      }
      const recordedAt = Date.parse(row.recorded_at);
      const structural = { ...row };
      delete structural.recorded_at;
      return Number.isFinite(recordedAt) &&
        recordedAt >= executionObservedAt &&
        recordedAt <= updatedAt &&
        same(structural, {
          grant_id: grant.id,
          grant_version: artifact.input.history.filter(
            (history) => history.grant_id === grant.id,
          ).length + 1,
          staff_id: grant.staff_id,
          permission: grant.permission,
          effect: grant.effect,
          scope_kind: grant.scope_kind,
          business_area_id: grant.business_area_id,
          division_id: grant.division_id,
          resource_id: grant.resource_id,
          active: expectedActive,
          grant_generation: artifact.input.generation.generation + index + 1,
        });
    }) &&
    Math.max(...historySuffix.map((row) => Date.parse(row.recorded_at))) === updatedAt;
  const committed =
    same(approval, artifact.approval) &&
    same(receipt, artifact.receipt) &&
    exactProtectedState &&
    committedGeneration &&
    committedHistory &&
    same(current.grants, committedGrants);
  if (committed) return { status: "committed", receipt };

  const untouched =
    approval === null &&
    receipt === null &&
    exactProtectedState &&
    same(current.generation, artifact.input.generation) &&
    same(current.grants, artifact.input.grants) &&
    same(current.history, artifact.input.history);
  if (untouched) return { status: "not-committed" };
  fail("uncertain outcome is neither exact committed poststate nor exact untouched prestate");
}

async function execute(config, phase, files, deps = {}) {
  const root = deps.root ?? ROOT;
  const runner = deps.withBinding ?? withStagingAuthorityBinding;
  const provisionArtifact = phase === "revoke"
    ? (deps.readArtifact ?? readArtifact)(root, files.provision)
    : null;
  const recoveryLineage = phase === "provision"
    ? readJson(root, files.recovery, new Set(["recovery-lineage.json"]))
    : provisionArtifact.input.recoveryLineage;
  const scalarPrestate = phase === "provision"
    ? readJson(root, files.prestate, new Set(["scalar-prestate.json"]))
    : provisionArtifact.input.scalarPrestate;
  const settlement = phase === "revoke"
    ? readJson(root, files.settlement, new Set(["settlement.json", "granted-readback.json"]))
    : null;

  return runner(config, async ({ db, target: binding }) => {
    if (!same(binding, STAGING_TARGET)) fail("trusted staging target required");
    const artifact = await build(
      db,
      phase,
      { recoveryLineage, scalarPrestate, provisionArtifact, settlement },
      root,
      deps,
    );
    const create = deps.createEvidence ?? createPrivateEvidenceDirectory;
    const write = deps.writeEvidence ?? writePrivateEvidence;
    const created = phase === "provision"
      ? create(root, artifact.approval.approval_id)
      : { evidenceDir: path.dirname(privatePath(root, files.provision, new Set(["provision.json"]))) };
    let savedSettlementPath = null;
    if (phase === "revoke" && path.dirname(privatePath(
      root,
      files.settlement,
      new Set(["settlement.json", "granted-readback.json"]),
    )) !== created.evidenceDir) {
      const savedSettlement = write(root, created.evidenceDir, "granted-readback.json", settlement);
      if (!savedSettlement) fail("private settlement save failed");
      savedSettlementPath = savedSettlement;
    } else if (phase === "revoke") {
      savedSettlementPath = privatePath(
        root,
        files.settlement,
        new Set(["settlement.json", "granted-readback.json"]),
      );
    }
    const name = phase === "provision" ? "provision.json" : "revoke.json";
    const saved = write(root, created.evidenceDir, name, artifact);
    if (!saved) fail("private artifact save failed");
    let result;
    try {
      await (deps.apply ?? applyDirectoryScalarAuthorityV184)(db, artifact, {
        target: binding,
        root,
      });
      result = await reconcile(db, artifact, deps);
      if (result.status !== "committed") fail("committed authority poststate drifted");
    } catch (error) {
      throw Error(`authority outcome unknown; reconcile ${saved}`, { cause: error });
    }
    return {
      mode: phase === "provision" ? "applied" : "closed",
      artifactPath: saved,
      settlementPath: savedSettlementPath,
      receipt: {
        commandId: artifact.receipt.command_id,
        approvalId: artifact.receipt.approval_id,
        planSha256: artifact.receipt.canonical_plan_sha256,
        resultSha256: artifact.receipt.result_sha256,
      },
      outcome: { status: result.status },
    };
  }, deps);
}

export async function prepareDirectoryScalarAuthorityV184(
  config,
  recoveryFile,
  prestateFile,
  deps = {},
) {
  const root = deps.root ?? ROOT;
  const runner = deps.withBinding ?? withStagingAuthorityBinding;
  const recoveryLineage = readJson(root, recoveryFile, new Set(["recovery-lineage.json"]));
  const scalarPrestate = readJson(root, prestateFile, new Set(["scalar-prestate.json"]));
  return runner(config, async ({ db, target: binding }) => {
    if (!same(binding, STAGING_TARGET)) fail("trusted staging target required");
    return {
      mode: "prepare-readonly",
      artifact: await build(db, "provision", { recoveryLineage, scalarPrestate }, root, deps),
      mutationsPerformed: false,
    };
  }, deps);
}

export const openDirectoryScalarAuthorityV184 = (
  config,
  recoveryFile,
  prestateFile,
  deps = {},
) => execute(config, "provision", { recovery: recoveryFile, prestate: prestateFile }, deps);

export const closeDirectoryScalarAuthorityV184 = (
  config,
  provisionFile,
  settlementFile,
  deps = {},
) => execute(
  config,
  "revoke",
  { provision: provisionFile, settlement: settlementFile },
  deps,
);

export async function reconcileDirectoryScalarAuthorityWindowV184(config, file, deps = {}) {
  const root = deps.root ?? ROOT;
  const runner = deps.withBinding ?? withStagingAuthorityBinding;
  const artifact = (deps.readArtifact ?? readArtifact)(root, file);
  return runner(config, async ({ db, target: binding }) => {
    if (!same(binding, STAGING_TARGET)) fail("trusted staging target required");
    const result = await reconcile(db, artifact, deps);
    return {
      mode: "reconciled-readonly",
      mutationsPerformed: false,
      status: result.status,
      ...(result.receipt
        ? {
            receipt: {
              commandId: result.receipt.command_id,
              approvalId: result.receipt.approval_id,
              planSha256: result.receipt.canonical_plan_sha256,
              resultSha256: result.receipt.result_sha256,
            },
          }
        : {}),
    };
  }, deps);
}

function parseEvidenceArgs(argv) {
  const values = new Map();
  for (let index = 3; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  return values;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [mode, flag, config] = argv;
  if (flag !== "--config" || !config) {
    fail("usage: prepare|apply|close|reconcile --config <path> [evidence flags]");
  }
  const evidence = parseEvidenceArgs(argv);
  if ((mode === "prepare" || mode === "apply") && argv.length === 7) {
    const recovery = evidence.get("--recovery");
    const prestate = evidence.get("--prestate");
    if (!recovery || !prestate) fail("recovery and prestate evidence required");
    return mode === "prepare"
      ? prepareDirectoryScalarAuthorityV184(config, recovery, prestate, deps)
      : openDirectoryScalarAuthorityV184(config, recovery, prestate, deps);
  }
  if (mode === "close" && argv.length === 7) {
    const provision = evidence.get("--artifact");
    const settlement = evidence.get("--settlement");
    if (!provision || !settlement) fail("provision and settlement evidence required");
    return closeDirectoryScalarAuthorityV184(config, provision, settlement, deps);
  }
  if (mode === "reconcile" && argv.length === 5 && evidence.get("--artifact")) {
    return reconcileDirectoryScalarAuthorityWindowV184(
      config,
      evidence.get("--artifact"),
      deps,
    );
  }
  fail("invalid arguments");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify({
      mode: result.mode,
      artifactPath: result.artifactPath ?? null,
      mutationsPerformed: result.mutationsPerformed ?? true,
    })}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
