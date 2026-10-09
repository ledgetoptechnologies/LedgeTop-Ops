import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeRetainedDirectoryAuthority, openRetainedDirectoryAuthority, prepareRetainedDirectoryAuthority,
  reconcileSavedRetainedDirectoryAuthority, main } from "./staging-retained-directory-authority-window.mjs";
import { RETAINED_DIRECTORY_TARGET as target, REVIEWED_REFERENCE_BASELINE } from "./staging-retained-directory-authority.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const ids = ["g1", "g2", "g3"];
const legacy = phase => ({ input: { phase, approval: { grantIds: ids } }, receipt: { command_id: `${phase}-command` }, approval: {} });
const before = { migrationNames: ["0181.sql"], admission: { staff_id: target.staffId }, profile: {},
  generation: { staff_id: target.staffId, generation: 6, updated_at: "2026-10-08T11:00:00.000Z" },
  projectGeneration: {}, businessArea: {}, resourceScope: {}, projectGrant: {},
  grants: ids.map((id, index) => ({ id, staff_id: target.staffId, permission: `permission-${index}`, effect: "allow", scope_kind: "business_area",
    business_area_id: target.areaId, division_id: null, resource_id: null, active: 0 })),
  history: Array.from({ length: 6 }, (_, index) => ({ grant_generation: index + 1 })),
  referenceCounts: { ...REVIEWED_REFERENCE_BASELINE }, predecessor: {} };
const after = phase => {
  const active = phase === "reactivate" ? 1 : 0, grants = before.grants.map(row => ({ ...row, active }));
  return { ...structuredClone(before), generation: { staff_id: target.staffId, generation: 9, updated_at: "2026-10-08T12:00:00.000Z" }, grants,
    referenceCounts: { ...before.referenceCounts, native_directory_grant_history: before.referenceCounts.native_directory_grant_history + 3 },
    history: [...before.history, ...grants.map((row, index) => ({ ...row, grant_id: row.id, grant_version: phase === "reactivate" ? 3 : 4,
      grant_generation: before.generation.generation + index + 1, recorded_at: "2026-10-08T12:00:00.000Z" }))] };
};
const compiled = input => ({ schemaVersion: 1, input, approval: { approval_id: input.approval.approvalId },
  receipt: { command_id: input.approval.commandId }, statements: [] });

function dependencies({ phase = "reactivate", targetValue = STAGING_TARGET, save = true, apply } = {}) {
  let snapshots = 0;
  return { root: "C:\\private-root", randomUUID: (() => { let n = 1; return () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`; })(),
    withBinding: async (_config, callback) => callback({ db: {}, target: targetValue }),
    snapshot: async () => snapshots++ === 0 ? structuredClone(before) : after(phase),
    clock: async () => "2026-10-08T12:00:00.000Z", compile: compiled,
    readHistorical: (_root, name) => legacy(name === "provision.json" ? "provision" : "revoke"),
    readReactivation: () => compiled({ phase: "reactivate", lineage: { provisionArtifact: legacy("provision") }, approval: { approvalId: "a" } }),
    createEvidence: () => ({ evidenceDir: "private" }), writeEvidence: () => save ? "private/provision.json" : null,
    phaseRows: async (_db, artifact) => ({ approval: artifact.approval, receipt: artifact.receipt,
      activationApproval: artifact.input.phase === "revoke" ? { ...artifact.input.lineage.reactivationArtifact.approval,
        revoked_at: artifact.input.approval.executedAt } : null }),
    apply: apply ?? (async (_db, artifact) => ({ status: "committed-after-response-recovery", receipt: artifact.receipt })) };
}

test("prepare is read-only and rejects a swapped binding target", async () => {
  const prepared = await prepareRetainedDirectoryAuthority("config", dependencies());
  assert.equal(prepared.mode, "prepare-readonly"); assert.equal(prepared.mutationsPerformed, false);
  await assert.rejects(prepareRetainedDirectoryAuthority("config", dependencies({ targetValue: { ...STAGING_TARGET, databaseName: "wrong" } })), /target mismatch/);
});

test("private artifact save must complete before any authority write", async () => {
  let applied = false;
  await assert.rejects(openRetainedDirectoryAuthority("config", dependencies({ save: false, apply: async () => { applied = true; } })), /save failed/);
  assert.equal(applied, false);
});

test("open accepts only reconciled immutable-receipt outcome and verifies postread", async () => {
  const result = await openRetainedDirectoryAuthority("config", dependencies());
  assert.equal(result.mode, "applied");
  assert.equal(result.outcome.status, "committed-after-response-recovery");
});

test("paired close loads the exact private activation and persists revoke before apply", async () => {
  const deps = dependencies({ phase: "revoke" });
  deps.snapshot = (() => { let count = 0; const active = after("reactivate"); return async () => count++ === 0 ? active : ({ ...active,
    generation: { staff_id: target.staffId, generation: 12, updated_at: "2026-10-08T13:00:00.000Z" }, grants: active.grants.map(row => ({ ...row, active: 0 })),
    referenceCounts: { ...active.referenceCounts, native_directory_grant_history: active.referenceCounts.native_directory_grant_history + 3 },
    history: [...active.history, ...active.grants.map((row, index) => ({ ...row, grant_id: row.id, grant_version: 4, active: 0,
      grant_generation: 10 + index, recorded_at: "2026-10-08T13:00:00.000Z" }))] }); })();
  const result = await closeRetainedDirectoryAuthority("config", "C:\\private-root\\.backups\\staging-native-authority\\00000000-0000-4000-8000-000000000099\\provision.json", deps);
  assert.equal(result.mode, "closed");
  assert.equal(result.outcome.status, "committed-after-response-recovery");
});

test("close refuses an unreviewed or escaped private activation path before binding", async () => {
  const deps = dependencies({ phase: "revoke" });
  let bound = false;
  deps.withBinding = async () => { bound = true; };
  deps.readReactivation = () => { throw new Error("private reactivation path escaped"); };
  await assert.rejects(closeRetainedDirectoryAuthority("config", "C:\\public\\artifact.json", deps), /path escaped/);
  assert.equal(bound, false);
});

test("real private evidence helpers persist and reload large paired open/close artifacts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "retained-authority-window-"));
  try {
    const deps = dependencies();
    deps.root = tempRoot;
    delete deps.createEvidence; delete deps.writeEvidence;
    const baseCompile = deps.compile;
    deps.compile = input => ({ ...baseCompile(input), privatePadding: "x".repeat(2_100_000) });
    const result = await openRetainedDirectoryAuthority("config", deps);
    assert.ok(fs.statSync(result.artifactPath).size > 1_900_000);
    assert.equal(path.basename(result.artifactPath), "provision.json");
    const closeDeps = dependencies({ phase: "revoke" });
    closeDeps.root = tempRoot;
    delete closeDeps.createEvidence; delete closeDeps.writeEvidence; delete closeDeps.readReactivation;
    let sequence = 101;
    closeDeps.randomUUID = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    closeDeps.compile = input => ({ ...compiled(input), privatePadding: "y".repeat(5_500_000) });
    const active = after("reactivate");
    closeDeps.snapshot = (() => { let count = 0; return async () => count++ === 0 ? active : ({ ...active,
      generation: { staff_id: target.staffId, generation: 12, updated_at: "2026-10-08T13:00:00.000Z" },
      grants: active.grants.map(row => ({ ...row, active: 0 })),
      referenceCounts: { ...active.referenceCounts, native_directory_grant_history: active.referenceCounts.native_directory_grant_history + 3 },
      history: [...active.history, ...active.grants.map((row, index) => ({ ...row, grant_id: row.id, grant_version: 4, active: 0,
        grant_generation: 10 + index, recorded_at: "2026-10-08T13:00:00.000Z" }))] }); })();
    const closed = await closeRetainedDirectoryAuthority("config", result.artifactPath, closeDeps);
    assert.ok(fs.statSync(closed.artifactPath).size > 5_000_000);
    assert.match(path.basename(closed.artifactPath), /^revoke-recovery-.+\.json$/);
    const savedRevoke = JSON.parse(fs.readFileSync(closed.artifactPath, "utf8"));
    const renamedRevoke = path.join(path.dirname(closed.artifactPath), "revoke-recovery-2026-10-08T00-00-00.000Z.json");
    fs.copyFileSync(closed.artifactPath, renamedRevoke);
    await assert.rejects(reconcileSavedRetainedDirectoryAuthority("config", renamedRevoke, closeDeps),
      /exact private retained artifact filename required/);
    const reconcileDeps = { ...closeDeps, snapshot: closeDeps.snapshot, compile: () => savedRevoke,
      phaseRows: async () => ({ approval: savedRevoke.approval, receipt: savedRevoke.receipt,
        activationApproval: { ...savedRevoke.input.lineage.reactivationArtifact.approval,
          revoked_at: savedRevoke.input.approval.executedAt } }) };
    delete reconcileDeps.readReactivation;
    reconcileDeps.snapshot = async () => ({ ...active,
      generation: { staff_id: target.staffId, generation: 12, updated_at: "2026-10-08T13:00:00.000Z" },
      grants: active.grants.map(row => ({ ...row, active: 0 })),
      referenceCounts: { ...active.referenceCounts, native_directory_grant_history: active.referenceCounts.native_directory_grant_history + 3 },
      history: [...active.history, ...active.grants.map((row, index) => ({ ...row, grant_id: row.id, grant_version: 4, active: 0,
        grant_generation: 10 + index, recorded_at: "2026-10-08T13:00:00.000Z" }))] });
    reconcileDeps.withBinding = async (_config, callback) => callback({ target: STAGING_TARGET,
      db: { prepare: () => ({ bind() { return this; }, first: async () => savedRevoke.receipt }) } });
    assert.equal((await reconcileSavedRetainedDirectoryAuthority("config", closed.artifactPath, reconcileDeps)).mode, "reconciled-committed");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("saved revoke recovery reconciles a committed batch from immutable receipt plus exact poststate", async () => {
  const active = after("reactivate"), reactivationArtifact = { approval: { approval_id: "00000000-0000-4000-8000-000000000050", revoked_at: null } };
  const input = { schemaVersion: 1, phase: "revoke", target, ...active,
    lineage: { provisionArtifact: legacy("provision"), reactivationArtifact }, approval: { approvalId: "00000000-0000-4000-8000-000000000051",
      commandId: "00000000-0000-4000-8000-000000000052" } };
  const artifact = compiled(input), deps = dependencies({ phase: "revoke" });
  deps.readReactivation = () => artifact;
  deps.compile = () => artifact;
  deps.snapshot = async () => ({ ...active, generation: { staff_id: target.staffId, generation: 12, updated_at: "2026-10-08T13:00:00.000Z" }, grants: active.grants.map(row => ({ ...row, active: 0 })),
    referenceCounts: { ...active.referenceCounts, native_directory_grant_history: active.referenceCounts.native_directory_grant_history + 3 },
    history: [...active.history, ...active.grants.map((row, index) => ({ ...row, grant_id: row.id, grant_version: 4, active: 0,
      grant_generation: 10 + index, recorded_at: "2026-10-08T13:00:00.000Z" }))] });
  deps.withBinding = async (_config, callback) => callback({ target: STAGING_TARGET, db: { prepare: () => ({ bind() { return this; }, first: async () => artifact.receipt }) } });
  assert.equal((await reconcileSavedRetainedDirectoryAuthority("config", "private", deps)).mode, "reconciled-committed");
});

test("lost close response plus receipt-query failure preserves the saved revoke recovery path", async () => {
  const deps = dependencies({ phase: "revoke", apply: async () => { throw new AggregateError([new Error("transport"), new Error("receipt query")], "unknown"); } });
  deps.snapshot = async () => after("reactivate");
  await assert.rejects(closeRetainedDirectoryAuthority("config", "private/provision.json", deps),
    error => /exact private receipt reconciliation at private\/provision\.json/.test(error.message));
});

test("CLI modes reject trailing or incomplete arguments", async () => {
  await assert.rejects(main(["apply", "--config", "config", "extra"], dependencies()), /unexpected CLI arguments/);
  await assert.rejects(main(["close", "--config", "config"], dependencies()), /unexpected CLI arguments/);
  await assert.rejects(main(["reconcile", "--config", "config", "--artifact"], dependencies()), /unexpected CLI arguments/);
});

test("postread rejects noncanonical generation and history timestamps without exposing rows", async () => {
  const deps = dependencies(), invalid = after("reactivate");
  invalid.generation.updated_at = "2026-10-08 12:00:00";
  let count = 0;
  deps.snapshot = async () => count++ === 0 ? structuredClone(before) : invalid;
  await assert.rejects(openRetainedDirectoryAuthority("config", deps), error => {
    assert.match(error.message, /open failed/);
    assert.doesNotMatch(error.message, /permission-0|staff-beau-koltz/);
    return true;
  });
});

test("postread rejects an extra interleaved history row", async () => {
  const deps = dependencies(), invalid = after("reactivate");
  invalid.history.splice(7, 0, { ...invalid.history[6], grant_id: "interleaved", grant_generation: 7.5 });
  let count = 0;
  deps.snapshot = async () => count++ === 0 ? structuredClone(before) : invalid;
  await assert.rejects(openRetainedDirectoryAuthority("config", deps), /open failed/);
});
