import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  createPrivateEvidenceDirectory,
  loadPrivateProvisionArtifact,
  recoverStagingNativeAuthority,
  rehearseStagingNativeAuthority,
  writePrivateEvidence,
} from "./staging-native-authority-packet-rehearsal.mjs";

const AREA = { id: "staging-native-only-portal-acceptance-20261002", name: "Synthetic portal acceptance — 2026-10-02", active: 1 };
const IDS = {
  approvalId: "00000000-0000-4000-8000-000000000001",
  commandId: "00000000-0000-4000-8000-000000000002",
  revokeApprovalId: "00000000-0000-4000-8000-000000000003",
  revokeCommandId: "00000000-0000-4000-8000-000000000004",
};
const GRANT_IDS = ["grant-profile", "grant-identity"];
const CLIENT_CREATION_GRANT_IDS = [...GRANT_IDS, "grant-enrollment"];
const clone = value => structuredClone(value);

function beforeState() {
  return {
    admission: { staff_id: "staff-beau-koltz", bound_access_subject: "native|owner", active: 1, admitted_by: "staff-beau-koltz", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1 },
    profile: { staff_id: "staff-beau-koltz", login_email: "owner@example.test", display_name: "Owner", version: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    generation: { staff_id: "staff-beau-koltz", generation: 5, updated_at: "2026-01-01T00:00:00.000Z" },
    businessArea: clone(AREA),
    grants: [{ id: "prior", staff_id: "staff-beau-koltz", permission: "directory.profile.view", effect: "allow", scope_kind: "global", business_area_id: null, division_id: null, resource_id: null, active: 1, granted_by: "staff-beau-koltz", created_at: "2026-01-01T00:00:00.000Z" }],
    history: [{ grant_id: "prior", grant_version: 1, staff_id: "staff-beau-koltz", permission: "directory.profile.view", effect: "allow", scope_kind: "global", business_area_id: null, division_id: null, resource_id: null, active: 1, grant_generation: 5, recorded_at: "2026-01-01T00:00:00.000Z" }],
  };
}

function targetRows(input, active) {
  const permissions = ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"];
  return input.approval.grantIds.map((id, index) => ({
    id,
    staff_id: input.admission.staff_id,
    permission: permissions[index],
    effect: "allow",
    scope_kind: "business_area",
    business_area_id: input.businessArea.id,
    division_id: null,
    resource_id: null,
    active,
    granted_by: input.approval.issuedByStaffId,
    created_at: input.approval.executedAt,
  }));
}

function stateAfter(input, active) {
  const target = targetRows(input, active);
  const grantCount = input.approval.grantIds.length;
  return {
    admission: clone(input.admission),
    profile: clone(input.profile),
    generation: { ...clone(input.generation), generation: input.generation.generation + (active ? grantCount : grantCount * 2) },
    businessArea: clone(input.businessArea),
    grants: [...clone(input.grants), ...target],
    history: [...clone(input.history), ...target.map((row, index) => ({
      grant_id: row.id,
      grant_version: active ? 1 : 2,
      staff_id: row.staff_id,
      permission: row.permission,
      effect: row.effect,
      scope_kind: row.scope_kind,
      business_area_id: row.business_area_id,
      division_id: null,
      resource_id: null,
      active,
      grant_generation: input.generation.generation + (active ? index + 1 : grantCount + index + 1),
      recorded_at: input.approval.executedAt,
    }))],
  };
}

function packetCompiler(input) {
  const value = clone(input);
  if (value.phase === "revoke") {
    const original = JSON.parse(value.priorProvision.receipt.canonical_plan_json);
    if (!same(value.admission, original.admission) || !same(value.profile, original.profile)
      || !same(value.businessArea, original.businessArea)) throw new Error("paired prior provision mismatch");
    const targets = value.grants.filter(row => original.approval.grantIds.includes(row.id));
    if (targets.length !== original.approval.grantIds.length || targets.some(row => row.active !== 1)) {
      throw new Error("exact active packet grants required");
    }
  }
  const canonical_plan_json = JSON.stringify(value);
  const provision = value.phase === "provision";
  const approval = {
    approval_id: provision ? value.approval.approvalId : value.approval.revokeApprovalId,
    canonical_plan_json,
    revoked_at: null,
  };
  const receipt = {
    command_id: provision ? value.approval.commandId : value.approval.revokeCommandId,
    approval_id: approval.approval_id,
    canonical_plan_json,
  };
  return { schemaVersion: 2, input: value, planHash: "reviewed", approval, receipt, statements: [{ sql: "atomic" }] };
}

function provisionInput(overrides = {}) {
  const state = beforeState();
  return {
    schemaVersion: 2,
    staging: clone(STAGING_TARGET),
    phase: "provision",
    ...state,
    approval: {
      ...IDS,
      issuedByStaffId: state.admission.staff_id,
      issuedByAccessSubject: state.admission.bound_access_subject,
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:10:00.000Z",
      executedAt: "2020-01-01T00:00:00.000Z",
      grantIds: [...GRANT_IDS],
    },
    priorProvision: null,
    ...overrides,
  };
}

function engine(options = {}) {
  const state = {
    current: beforeState(),
    provisionPacket: options.provisionPacket ?? null,
    provisionReceipt: options.provisionPacket?.receipt ?? null,
    revokePacket: options.revokePacket ?? null,
    revokeReceipt: options.revokePacket?.receipt ?? null,
    provisionApproval: options.provisionPacket?.approval ?? null,
    provisionCalls: 0,
    revokeCalls: 0,
    lastRevoke: null,
  };
  if (state.provisionPacket && !state.revokePacket) state.current = stateAfter(state.provisionPacket.input, 1);
  if (state.revokePacket) state.current = stateAfter(state.provisionPacket.input, 0);
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async run() { return {}; },
      };
    },
  };
  return {
    state,
    dependencies(extra = {}) {
      const uuids = [IDS.approvalId, IDS.commandId, IDS.revokeApprovalId, IDS.revokeCommandId];
      return {
        root: extra.root ?? path.resolve(os.tmpdir()),
        withBinding: async (_config, callback) => callback({ db, target: STAGING_TARGET }),
        snapshot: async () => clone(state.current),
        clock: async () => extra.clock ?? "2030-01-01T00:00:00.000Z",
        first: async (_db, sql, id) => {
          if (sql.includes("native_business_areas")) return clone(AREA);
          if (sql.includes("native_staff_bootstrap_approvals")) return clone(state.provisionApproval);
          if (sql.includes("native_staff_bootstrap_receipts")) {
            if (id === IDS.commandId) return clone(state.provisionReceipt);
            if (id === IDS.revokeCommandId) return clone(state.revokeReceipt);
          }
          return null;
        },
        compilePacket: packetCompiler,
        grantIds: () => [...GRANT_IDS],
        randomUUID: () => uuids.shift(),
        applyPacket: async (_db, packet) => {
          if (packet.input.phase === "provision") {
            state.provisionCalls += 1;
            state.provisionPacket = clone(packet);
            state.provisionReceipt = clone(packet.receipt);
            state.provisionApproval = clone(packet.approval);
            state.current = stateAfter(packet.input, 1);
            if (options.loseProvisionResponse) throw new Error("lost provision response");
            return { replayed: false };
          }
          state.revokeCalls += 1;
          state.lastRevoke = clone(packet);
          if (state.revokeReceipt) return { replayed: true };
          state.revokePacket = clone(packet);
          state.revokeReceipt = clone(packet.receipt);
          state.current = stateAfter(state.provisionPacket.input, 0);
          if (options.loseRevokeResponse) throw new Error("lost revoke response");
          return { replayed: false };
        },
        ...extra,
      };
    },
  };
}

function fakeEvidence() {
  return {
    createEvidence: (root, approvalId) => {
      const evidenceDir = path.join(root, ".backups", "staging-native-authority", approvalId);
      return { evidenceDir, provisionPath: path.join(evidenceDir, "provision.json") };
    },
  };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-authority-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function saveProvision(t, packet = packetCompiler(provisionInput())) {
  const root = tempRoot(t);
  const evidence = createPrivateEvidenceDirectory(root, packet.input.approval.approvalId);
  writePrivateEvidence(root, evidence.evidenceDir, "provision.json", packet);
  return { root, evidence, packet };
}

test("private artifacts use closed paths, 0700 directories, 0600 files, and reject symlink ancestors", t => {
  const { root, evidence, packet } = saveProvision(t);
  for (const directory of [path.join(root, ".backups"), path.join(root, ".backups", "staging-native-authority"), evidence.evidenceDir]) {
    assert.ok(fs.statSync(directory).isDirectory());
    if (process.platform !== "win32") assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  assert.ok(fs.statSync(evidence.provisionPath).isFile());
  if (process.platform !== "win32") assert.equal(fs.statSync(evidence.provisionPath).mode & 0o777, 0o600);
  assert.throws(() => writePrivateEvidence(root, evidence.evidenceDir, "../escape.json", packet), /filename/);
  const symlinkFs = {
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => true }),
    mkdirSync: () => assert.fail("must not create through symlink"),
    chmodSync: () => assert.fail("must not chmod symlink"),
  };
  assert.throws(() => createPrivateEvidenceDirectory(root, IDS.approvalId, { fs: symlinkFs }), /non-symlink/);
});

test("revoke evidence write failure cannot block paired revocation", async () => {
  const model = engine();
  const writes = [];
  const dependencies = model.dependencies({
    ...fakeEvidence(),
    writeEvidence: (_root, _directory, name) => {
      writes.push(name);
      if (name === "revoke.json") throw new Error("disk full");
    },
  });
  await assert.rejects(rehearseStagingNativeAuthority("config.json", dependencies),
    /paired revocation was verified/);
  assert.equal(model.state.provisionCalls, 1);
  assert.equal(model.state.revokeCalls, 1);
  assert.ok(model.state.current.grants.filter(row => GRANT_IDS.includes(row.id)).every(row => row.active === 0));
  assert.ok(writes.includes("revoke.json"));
});

test("provision artifact write failure prevents every authority apply", async () => {
  const model = engine();
  const dependencies = model.dependencies({
    ...fakeEvidence(),
    writeEvidence: (_root, _directory, name) => {
      assert.equal(name, "provision.json");
      throw new Error("recovery disk unavailable");
    },
  });
  await assert.rejects(rehearseStagingNativeAuthority("config.json", dependencies), /recovery disk unavailable/);
  assert.equal(model.state.provisionCalls, 0);
  assert.equal(model.state.revokeCalls, 0);
  assert.deepEqual(model.state.current, beforeState());
});

test("lost provision response is reconciled by its immutable receipt and still revoked", async () => {
  const model = engine({ loseProvisionResponse: true });
  const dependencies = model.dependencies({ ...fakeEvidence(), writeEvidence: () => {} });
  await assert.rejects(rehearseStagingNativeAuthority("config.json", dependencies),
    /paired revocation was verified/);
  assert.equal(model.state.revokeCalls, 1);
  assert.ok(model.state.current.grants.filter(row => GRANT_IDS.includes(row.id)).every(row => row.active === 0));
});

test("lost revoke response is verified from its immutable receipt", async () => {
  const model = engine({ loseRevokeResponse: true });
  const dependencies = model.dependencies({ ...fakeEvidence(), writeEvidence: () => {} });
  await assert.rejects(rehearseStagingNativeAuthority("config.json", dependencies),
    /paired revocation was verified/);
  assert.equal(model.state.revokeCalls, 1);
  assert.ok(model.state.current.grants.filter(row => GRANT_IDS.includes(row.id)).every(row => row.active === 0));
});

test("durable recovery mints fresh timestamps after expiry without changing any grant or approval IDs", async t => {
  const saved = saveProvision(t);
  const model = engine({ provisionPacket: saved.packet });
  const result = await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root, clock: async () => "2030-01-01T00:00:00.000Z" }));
  assert.equal(result.status, "recovered-and-revoked");
  assert.equal(result.cleanupVerified, true);
  assert.equal(model.state.lastRevoke.input.approval.issuedAt, "2030-01-01T00:00:00.000Z");
  assert.equal(model.state.lastRevoke.input.approval.expiresAt, "2030-01-01T00:10:00.000Z");
  assert.deepEqual(model.state.lastRevoke.input.approval.grantIds, saved.packet.input.approval.grantIds);
  for (const key of ["approvalId", "commandId", "revokeApprovalId", "revokeCommandId"]) {
    assert.equal(model.state.lastRevoke.input.approval[key], saved.packet.input.approval[key]);
  }
});

test("durable recovery verifies a lost revoke response and leaves authority inactive", async t => {
  const saved = saveProvision(t);
  const model = engine({ provisionPacket: saved.packet, loseRevokeResponse: true });
  const result = await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root }));
  assert.equal(result.status, "revoke-response-recovered");
  assert.equal(result.cleanupVerified, true);
  assert.ok(model.state.current.grants.filter(row => GRANT_IDS.includes(row.id)).every(row => row.active === 0));
});

test("schema 3 recovery preserves three permission-bound IDs and verifies lost revoke response", async t => {
  const input = provisionInput({
    schemaVersion: 3,
    approval: { ...provisionInput().approval, grantIds: [...CLIENT_CREATION_GRANT_IDS] },
  });
  const saved = saveProvision(t, packetCompiler(input));
  const model = engine({ provisionPacket: saved.packet, loseRevokeResponse: true });
  const result = await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root }));
  assert.equal(result.status, "revoke-response-recovered");
  assert.deepEqual(model.state.lastRevoke.input.approval.grantIds, CLIENT_CREATION_GRANT_IDS);
  assert.equal(model.state.lastRevoke.input.schemaVersion, 3);
  assert.equal(model.state.current.generation.generation, beforeState().generation.generation + 6);
  assert.ok(model.state.current.grants.filter(row => CLIENT_CREATION_GRANT_IDS.includes(row.id))
    .every(row => row.active === 0));
  const replay = await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root }));
  assert.equal(replay.status, "already-revoked");
  assert.equal(model.state.current.generation.generation, beforeState().generation.generation + 6);
});

test("recovery snapshots the exact area recorded by provision evidence", async t => {
  const recordedArea = { id: "staging-native-only-recorded-area", name: "Recorded area", active: 1 };
  const input = provisionInput({ businessArea: recordedArea });
  const saved = saveProvision(t, packetCompiler(input));
  const model = engine({ provisionPacket: saved.packet });
  const selected = [];
  const dependencies = model.dependencies({ root: saved.root });
  dependencies.snapshot = async (_db, areaId) => {
    selected.push(areaId);
    const value = clone(model.state.current);
    value.businessArea = clone(recordedArea);
    return value;
  };
  await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath, dependencies);
  assert.ok(selected.length >= 2);
  assert.ok(selected.every(areaId => areaId === recordedArea.id));
});

test("recovery uses an exact saved revoke plus immutable receipt when already revoked", async t => {
  const saved = saveProvision(t);
  const active = stateAfter(saved.packet.input, 1);
  const revoke = packetCompiler({
    ...saved.packet.input,
    ...active,
    phase: "revoke",
    approval: {
      ...saved.packet.input.approval,
      issuedAt: "2029-01-01T00:00:00.000Z",
      executedAt: "2029-01-01T00:00:00.000Z",
      expiresAt: "2029-01-01T00:10:00.000Z",
    },
    priorProvision: { approval: saved.packet.approval, receipt: saved.packet.receipt },
  });
  writePrivateEvidence(saved.root, saved.evidence.evidenceDir, "revoke.json", revoke);
  const model = engine({ provisionPacket: saved.packet, revokePacket: revoke });
  const result = await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root }));
  assert.equal(result.status, "already-revoked");
  assert.equal(result.cleanupVerified, true);
  assert.equal(model.state.revokeCalls, 1, "exact saved revoke is replay-validated once");
});

test("already-revoked recovery reconstructs the exact packet from receipt when revoke evidence was not saved", async t => {
  const saved = saveProvision(t);
  const active = stateAfter(saved.packet.input, 1);
  const revoke = packetCompiler({
    ...saved.packet.input,
    ...active,
    phase: "revoke",
    approval: {
      ...saved.packet.input.approval,
      issuedAt: "2029-02-01T00:00:00.000Z",
      executedAt: "2029-02-01T00:00:00.000Z",
      expiresAt: "2029-02-01T00:10:00.000Z",
    },
    priorProvision: { approval: saved.packet.approval, receipt: saved.packet.receipt },
  });
  const model = engine({ provisionPacket: saved.packet, revokePacket: revoke });
  const result = await recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root }));
  assert.equal(result.status, "already-revoked");
  assert.equal(result.cleanupVerified, true);
  assert.equal(model.state.revokeCalls, 1);
});

test("recovery rejects a symlinked final provision artifact before reading it", t => {
  const saved = saveProvision(t);
  const fakeFs = {
    lstatSync(filename) {
      if (path.resolve(filename) === path.resolve(saved.evidence.provisionPath)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true };
      }
      return fs.lstatSync(filename);
    },
    chmodSync: fs.chmodSync,
    readFileSync: () => assert.fail("symlinked provision must not be read"),
  };
  assert.throws(() => loadPrivateProvisionArtifact(saved.evidence.provisionPath, {
    root: saved.root,
    fs: fakeFs,
    compilePacket: packetCompiler,
  }), /non-symlink regular file/);
});

test("recovery rejects missing or arbitrary outer artifact schemas before binding", t => {
  for (const schemaVersion of [undefined, 99]) {
    const packet = packetCompiler(provisionInput({ schemaVersion: 3,
      approval: { ...provisionInput().approval, grantIds: [...CLIENT_CREATION_GRANT_IDS] } }));
    if (schemaVersion === undefined) delete packet.schemaVersion;
    else packet.schemaVersion = schemaVersion;
    const root = tempRoot(t);
    const evidence = createPrivateEvidenceDirectory(root, packet.input.approval.approvalId);
    writePrivateEvidence(root, evidence.evidenceDir, "provision.json", packet);
    assert.throws(() => loadPrivateProvisionArtifact(evidence.provisionPath, {
      root, compilePacket: packetCompiler,
    }), /exact compiled provision artifact required/);
  }
});

test("stale admission/profile authority fails closed without attempting revoke", async t => {
  const saved = saveProvision(t);
  const model = engine({ provisionPacket: saved.packet });
  model.state.current.profile.display_name = "Changed After Provision";
  await assert.rejects(recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root })), /exact recovery did not complete.*--recover/);
  assert.equal(model.state.revokeCalls, 0);
  assert.ok(model.state.current.grants.filter(row => GRANT_IDS.includes(row.id)).every(row => row.active === 1));
});

test("recovery without a provision receipt refuses impossible orphan packet grants", async t => {
  const saved = saveProvision(t);
  const model = engine();
  model.state.current.grants.push(...targetRows(saved.packet.input, 1));
  await assert.rejects(recoverStagingNativeAuthority("config.json", saved.evidence.provisionPath,
    model.dependencies({ root: saved.root })), /grant exists without its atomic provision receipt/);
  assert.equal(model.state.revokeCalls, 0);
});
