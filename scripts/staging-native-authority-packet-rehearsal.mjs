import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";
import {
  nativeOnlyGrantIds,
  compileNativeOnlyAuthorityPacket,
  applyNativeOnlyAuthorityPacket,
} from "./staging-onboarding-native-only-authority-packet.mjs";

const AREA = Object.freeze({
  id: "staging-native-only-portal-acceptance-20261002",
  name: "Synthetic portal acceptance — 2026-10-02",
  active: 1,
});
const STAFF = "staff-beau-koltz";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_SUBDIRECTORY = path.join(".backups", "staging-native-authority");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVOKE_FILE = /^revoke(?:-recovery-[0-9TZ.-]+)?\.json$/;

const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();

async function snapshot(db, areaId = AREA.id) {
  return {
    admission: await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", STAFF),
    profile: await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", STAFF),
    generation: await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", STAFF),
    businessArea: await first(db, "SELECT * FROM native_business_areas WHERE id=?", areaId),
    grants: await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", STAFF),
    history: await all(db, "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version", STAFF),
  };
}

async function clock(db) {
  return (await first(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp")).stamp;
}

function exactDirectory(directory, fsImpl, create) {
  let stat;
  try {
    stat = fsImpl.lstatSync(directory);
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw error;
    fsImpl.mkdirSync(directory, { mode: 0o700 });
    stat = fsImpl.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("private evidence ancestor must be a non-symlink directory");
  }
  fsImpl.chmodSync(directory, 0o700);
}

function assertNonSymlinkRoot(root, fsImpl) {
  const stat = fsImpl.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("private evidence root must be a non-symlink directory");
  }
}

export function createPrivateEvidenceDirectory(root, approvalId, dependencies = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !UUID.test(approvalId)) {
    throw new Error("invalid private evidence destination");
  }
  const fsImpl = dependencies.fs ?? fs;
  assertNonSymlinkRoot(root, fsImpl);
  const backups = path.join(root, ".backups");
  const evidenceRoot = path.join(root, EVIDENCE_SUBDIRECTORY);
  const evidenceDir = path.join(evidenceRoot, approvalId);
  exactDirectory(backups, fsImpl, true);
  exactDirectory(evidenceRoot, fsImpl, true);
  exactDirectory(evidenceDir, fsImpl, true);
  return Object.freeze({ evidenceRoot, evidenceDir, provisionPath: path.join(evidenceDir, "provision.json") });
}

function assertSafeEvidenceDirectory(root, evidenceDir, fsImpl) {
  assertNonSymlinkRoot(root, fsImpl);
  const evidenceRoot = path.join(root, EVIDENCE_SUBDIRECTORY);
  const relative = path.relative(evidenceRoot, evidenceDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== "."
    || !UUID.test(relative)) throw new Error("evidence path is outside the private root");
  for (const directory of [path.join(root, ".backups"), evidenceRoot, evidenceDir]) {
    exactDirectory(directory, fsImpl, false);
  }
}

export function writePrivateEvidence(root, evidenceDir, filename, value, dependencies = {}) {
  if (filename !== "provision.json" && filename !== "granted-readback.json"
    && filename !== "revoked-readback.json" && !REVOKE_FILE.test(filename)) {
    throw new Error("invalid private evidence filename");
  }
  const fsImpl = dependencies.fs ?? fs;
  assertSafeEvidenceDirectory(root, evidenceDir, fsImpl);
  const target = path.join(evidenceDir, filename);
  fsImpl.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const stat = fsImpl.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence is not a regular file");
  fsImpl.chmodSync(target, 0o600);
  return target;
}

function readPrivateJson(root, filename, dependencies = {}) {
  const fsImpl = dependencies.fs ?? fs;
  const resolved = path.resolve(filename);
  const evidenceDir = path.dirname(resolved);
  assertSafeEvidenceDirectory(root, evidenceDir, fsImpl);
  const stat = fsImpl.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("evidence must be a non-symlink regular file");
  return JSON.parse(fsImpl.readFileSync(resolved, "utf8"));
}

function operations(dependencies) {
  return {
    root: dependencies.root ?? ROOT,
    fs: dependencies.fs ?? fs,
    withBinding: dependencies.withBinding ?? withStagingAuthorityBinding,
    snapshot: dependencies.snapshot ?? snapshot,
    clock: dependencies.clock ?? clock,
    first: dependencies.first ?? first,
    compile: dependencies.compilePacket ?? compileNativeOnlyAuthorityPacket,
    apply: dependencies.applyPacket ?? applyNativeOnlyAuthorityPacket,
    grantIds: dependencies.grantIds ?? nativeOnlyGrantIds,
    randomUUID: dependencies.randomUUID ?? crypto.randomUUID,
    createEvidence: dependencies.createEvidence ?? createPrivateEvidenceDirectory,
    writeEvidence: dependencies.writeEvidence ?? writePrivateEvidence,
  };
}

function compileExactProvision(raw, ops) {
  if (!raw || ![2, 3].includes(raw.schemaVersion) || ![2, 3].includes(raw.input?.schemaVersion)
    || raw.input?.phase !== "provision") {
    throw new Error("exact compiled provision artifact required");
  }
  const expected = ops.compile(raw.input, { root: ops.root });
  if (!same(raw, expected)) throw new Error("compiled provision artifact changed");
  return expected;
}

export function loadPrivateProvisionArtifact(filename, dependencies = {}) {
  const ops = operations(dependencies);
  const resolved = path.resolve(filename);
  if (path.basename(resolved) !== "provision.json") throw new Error("recovery requires provision.json");
  const provision = compileExactProvision(readPrivateJson(ops.root, resolved, { fs: ops.fs }), ops);
  if (path.basename(path.dirname(resolved)) !== provision.input.approval.approvalId) {
    throw new Error("provision evidence directory does not match approval");
  }
  return Object.freeze({ provision, provisionPath: resolved, evidenceDir: path.dirname(resolved) });
}

function recoveryMessage(provisionPath, message) {
  return `${message}; authority state requires exact recovery: --recover ${provisionPath}`;
}

function verifyRevoked(after, provision) {
  const before = provision.input;
  const ids = before.approval.grantIds;
  assert.deepEqual(after.admission, before.admission, "admission drift blocks verified cleanup");
  assert.deepEqual(after.profile, before.profile, "profile drift blocks verified cleanup");
  assert.deepEqual(after.businessArea, before.businessArea, "synthetic area drift blocks verified cleanup");
  assert.deepEqual(after.grants.filter(row => !ids.includes(row.id)), before.grants, "prior grants changed");
  const targets = after.grants.filter(row => ids.includes(row.id));
  const grantCount = ids.length;
  assert.equal(targets.length, grantCount, "paired grants missing after revoke");
  assert.ok(targets.every(row => row.active === 0), "paired grants remain active");
  assert.deepEqual(after.history.filter(row => row.grant_generation <= before.generation.generation),
    before.history, "prior grant history changed");
  assert.equal(after.generation.generation, before.generation.generation + grantCount * 2,
    "unexpected final generation");
}

function verifiedPacketFromReceipt(receipt, ops) {
  let input;
  try {
    input = JSON.parse(receipt.canonical_plan_json);
  } catch {
    throw new Error("revoke receipt canonical plan is invalid");
  }
  const packet = ops.compile(input, { root: ops.root });
  if (packet.input.phase !== "revoke" || !same(packet.receipt, receipt)) {
    throw new Error("revoke receipt does not match an exact compiled packet");
  }
  return packet;
}

function savedPacketForReceipt(evidenceDir, receipt, ops) {
  const names = ops.fs.readdirSync(evidenceDir).filter(name => REVOKE_FILE.test(name)).sort();
  for (const name of names) {
    const raw = readPrivateJson(ops.root, path.join(evidenceDir, name), { fs: ops.fs });
    if (!raw || ![2, 3].includes(raw.schemaVersion) || ![2, 3].includes(raw.input?.schemaVersion)
      || raw.input?.phase !== "revoke") {
      throw new Error("saved revoke artifact is invalid");
    }
    const expected = ops.compile(raw.input, { root: ops.root });
    if (!same(raw, expected)) throw new Error("saved revoke artifact changed");
    if (same(expected.receipt, receipt)) return expected;
  }
  return null;
}

async function receipts(db, provision, ops) {
  const approval = provision.input.approval;
  return {
    provision: await ops.first(db,
      "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", approval.commandId),
    revoke: await ops.first(db,
      "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", approval.revokeCommandId),
  };
}

function freshRevokePacket(current, provision, priorApproval, priorReceipt, executedAt, ops) {
  const original = provision.input;
  return ops.compile({
    ...original,
    ...current,
    phase: "revoke",
    approval: {
      ...original.approval,
      issuedAt: executedAt,
      executedAt,
      expiresAt: new Date(Date.parse(executedAt) + 10 * 60_000).toISOString(),
    },
    priorProvision: { approval: priorApproval, receipt: priorReceipt },
  }, { root: ops.root });
}

async function applyRevokeAndVerify(db, target, provision, revoke, ops) {
  let transportError;
  try {
    await ops.apply(db, revoke, { target, root: ops.root });
  } catch (error) {
    transportError = error;
  }
  const receipt = await ops.first(db,
    "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", revoke.input.approval.revokeCommandId);
  if (!receipt) {
    throw new AggregateError(transportError ? [transportError] : [], "paired revoke has no immutable receipt");
  }
  assert.deepEqual(receipt, revoke.receipt, "paired revoke receipt mismatch");
  const after = await ops.snapshot(db, provision.input.businessArea.id);
  verifyRevoked(after, provision);
  return { after, lostResponseRecovered: Boolean(transportError), transportError };
}

function recoveryEvidenceName(executedAt) {
  return `revoke-recovery-${executedAt.replaceAll(":", "-")}.json`;
}

async function recoverWithBinding(db, target, loaded, ops) {
  const { provision, provisionPath, evidenceDir } = loaded;
  const areaId = provision.input.businessArea.id;
  let ledger;
  try {
    ledger = await receipts(db, provision, ops);
  } catch (error) {
    throw new AggregateError([error], recoveryMessage(provisionPath, "could not read paired receipts"));
  }
  if (!ledger.provision) {
    const current = await ops.snapshot(db, areaId);
    if (current.grants.some(row => provision.input.approval.grantIds.includes(row.id))) {
      throw new Error(recoveryMessage(provisionPath, "packet grant exists without its atomic provision receipt"));
    }
    return { status: "provision-not-committed", cleanupVerified: true, evidencePath: evidenceDir };
  }
  assert.deepEqual(ledger.provision, provision.receipt, "provision receipt mismatch");
  if (ledger.revoke) {
    const committed = savedPacketForReceipt(evidenceDir, ledger.revoke, ops)
      ?? verifiedPacketFromReceipt(ledger.revoke, ops);
    if (!same(committed.input.priorProvision?.receipt, provision.receipt)
      || committed.input.approval.revokeCommandId !== provision.input.approval.revokeCommandId
      || !same(committed.input.approval.grantIds, provision.input.approval.grantIds)) {
      throw new Error("committed revoke is not paired to this provision");
    }
    await ops.apply(db, committed, { target, root: ops.root });
    verifyRevoked(await ops.snapshot(db, areaId), provision);
    return { status: "already-revoked", cleanupVerified: true, evidencePath: evidenceDir };
  }

  const current = await ops.snapshot(db, areaId);
  const executedAt = await ops.clock(db);
  const priorApproval = await ops.first(db,
    "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?", provision.input.approval.approvalId);
  const revoke = freshRevokePacket(current, provision, priorApproval, ledger.provision, executedAt, ops);
  let evidenceError;
  try {
    ops.writeEvidence(ops.root, evidenceDir, recoveryEvidenceName(executedAt), revoke, { fs: ops.fs });
  } catch (error) {
    evidenceError = error;
  }
  let result;
  try {
    result = await applyRevokeAndVerify(db, target, provision, revoke, ops);
  } catch (error) {
    throw new AggregateError([...(evidenceError ? [evidenceError] : []), error],
      recoveryMessage(provisionPath, "paired revoke is not verified"));
  }
  try {
    ops.writeEvidence(ops.root, evidenceDir, "revoked-readback.json", result.after, { fs: ops.fs });
  } catch (error) {
    evidenceError ??= error;
  }
  return {
    status: result.lostResponseRecovered ? "revoke-response-recovered" : "recovered-and-revoked",
    cleanupVerified: true,
    evidenceComplete: !evidenceError,
    evidencePath: evidenceDir,
  };
}

export async function recoverStagingNativeAuthority(configPath, provisionPath, dependencies = {}) {
  const ops = operations(dependencies);
  const loaded = loadPrivateProvisionArtifact(provisionPath, dependencies);
  try {
    return await ops.withBinding(configPath, ({ db, target }) => recoverWithBinding(db, target, loaded, ops),
      dependencies.bindingDependencies ?? {});
  } catch (error) {
    if (error.message?.includes("--recover")) throw error;
    throw new AggregateError([error], recoveryMessage(loaded.provisionPath, "exact recovery did not complete"));
  }
}

export async function rehearseStagingNativeAuthority(configPath, dependencies = {}) {
  const ops = operations(dependencies);
  return ops.withBinding(configPath, async ({ db, target }) => {
    let area = await ops.first(db, "SELECT * FROM native_business_areas WHERE id=?", AREA.id);
    if (area) assert.deepEqual(area, AREA, "existing synthetic area differs");
    else {
      await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,?)")
        .bind(AREA.id, AREA.name, AREA.active).run();
      area = await ops.first(db, "SELECT * FROM native_business_areas WHERE id=?", AREA.id);
      assert.deepEqual(area, AREA);
    }
    const before = await ops.snapshot(db);
    const issuedAt = await ops.clock(db);
    const approvalId = ops.randomUUID();
    const values = {
      schemaVersion: 2,
      staging: target,
      phase: "provision",
      ...before,
      approval: {
        approvalId,
        commandId: ops.randomUUID(),
        revokeApprovalId: ops.randomUUID(),
        revokeCommandId: ops.randomUUID(),
        issuedByStaffId: STAFF,
        issuedByAccessSubject: before.admission?.bound_access_subject,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 10 * 60_000).toISOString(),
        executedAt: issuedAt,
        grantIds: ops.grantIds(STAFF, AREA.id, approvalId),
      },
      priorProvision: null,
    };
    const provision = ops.compile(values, { root: ops.root });
    const evidence = ops.createEvidence(ops.root, approvalId, { fs: ops.fs });
    // Provisioning is forbidden unless its exact durable recovery artifact was
    // exclusively saved first.
    ops.writeEvidence(ops.root, evidence.evidenceDir, "provision.json", provision, { fs: ops.fs });

    const problems = [];
    try {
      await ops.apply(db, provision, { target, root: ops.root });
      const granted = await ops.snapshot(db);
      assert.equal(granted.generation.generation, before.generation.generation + 2);
      assert.deepEqual(granted.admission, before.admission);
      assert.deepEqual(granted.profile, before.profile);
      assert.deepEqual(granted.grants.filter(row => !values.approval.grantIds.includes(row.id)), before.grants);
      assert.equal(granted.grants.filter(row => values.approval.grantIds.includes(row.id) && row.active === 1).length, 2);
      try {
        ops.writeEvidence(ops.root, evidence.evidenceDir, "granted-readback.json", granted, { fs: ops.fs });
      } catch (error) {
        problems.push(error);
      }
    } catch (error) {
      problems.push(error);
    }

    let ledger;
    try {
      ledger = await receipts(db, provision, ops);
    } catch (error) {
      throw new AggregateError([...problems, error],
        recoveryMessage(evidence.provisionPath, "provision outcome could not be reconciled"));
    }
    if (!ledger.provision) {
      const current = await ops.snapshot(db);
      if (current.grants.some(row => values.approval.grantIds.includes(row.id))) {
        throw new Error(recoveryMessage(evidence.provisionPath, "packet grant exists without provision receipt"));
      }
      throw new AggregateError(problems, "provision did not commit; no packet authority is active");
    }
    if (!same(ledger.provision, provision.receipt)) {
      throw new Error(recoveryMessage(evidence.provisionPath, "provision receipt mismatch"));
    }

    let cleanup;
    try {
      const current = await ops.snapshot(db);
      const executedAt = await ops.clock(db);
      const priorApproval = await ops.first(db,
        "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?", approvalId);
      const revoke = freshRevokePacket(current, provision, priorApproval, ledger.provision, executedAt, ops);
      try {
        ops.writeEvidence(ops.root, evidence.evidenceDir, "revoke.json", revoke, { fs: ops.fs });
      } catch (error) {
        problems.push(error);
      }
      cleanup = await applyRevokeAndVerify(db, target, provision, revoke, ops);
      if (cleanup.transportError) problems.push(cleanup.transportError);
      try {
        ops.writeEvidence(ops.root, evidence.evidenceDir, "revoked-readback.json", cleanup.after, { fs: ops.fs });
      } catch (error) {
        problems.push(error);
      }
    } catch (error) {
      throw new AggregateError([...problems, error],
        recoveryMessage(evidence.provisionPath, "paired revoke is not verified"));
    }
    if (problems.length) {
      throw new AggregateError(problems, "rehearsal encountered errors, but paired revocation was verified");
    }
    return {
      environment: "staging",
      businessAreaId: AREA.id,
      provisionedPermissions: 2,
      revokedPermissions: 2,
      priorAuthorityPreserved: true,
      cleanupVerified: true,
      productionChanges: false,
      clientActivation: false,
      publicLinkChanges: false,
      evidencePath: evidence.evidenceDir,
    };
  }, dependencies.bindingDependencies ?? {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let action;
  if (args.length === 3 && args[0] === "--config" && args[2] === "--confirm-synthetic-provision-and-paired-revoke") {
    action = rehearseStagingNativeAuthority(args[1]);
  } else if (args.length === 4 && args[0] === "--config" && args[2] === "--recover") {
    action = recoverStagingNativeAuthority(args[1], args[3]);
  } else {
    throw new Error("usage: --config <exact staging binding JSON> --confirm-synthetic-provision-and-paired-revoke | --recover <private provision.json>");
  }
  action.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message.includes("--recover") ? error.message
      : "Staging rehearsal failed; inspect private evidence before retrying.");
    process.exitCode = 1;
  });
}
