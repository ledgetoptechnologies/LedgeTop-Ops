import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  closeDirectoryScalarAuthorityV184 as close,
  openDirectoryScalarAuthorityV184 as open,
  prepareDirectoryScalarAuthorityV184 as prepare,
  reconcileDirectoryScalarAuthorityWindowV184 as reconcile,
} from "./staging-directory-scalar-authority-v184-window.mjs";

const ids = Array.from(
  { length: 12 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const staff = { id: "staff", status: "active", access_subject: "access|staff" };
const admission = {
  staff_id: "staff",
  bound_access_subject: "access|staff",
  active: 1,
  version: 3,
};
const profile = {
  staff_id: "staff",
  login_email: "staff@example.test",
  display_name: "Staff",
  version: 2,
};
const originalRecord = { record_id: "client", record_kind: "client", current_version: 2 };
const settledRecord = { ...originalRecord, current_version: 3 };
const relationship = {
  client_record_id: "client",
  organization_record_id: "organization",
  relationship_version: 2,
};

function artifact(input) {
  const grantIds = input.grants.map((grant) => grant.id);
  return {
    schemaVersion: 1,
    input,
    selection: grantIds.map((grantId, index) => ({
      grantId,
      permission: index === 0 ? "directory.profile.edit" : "directory.identity.link",
    })),
    approval: {
      approval_id: input.approval.approvalId,
      canonical_plan_sha256: "plan",
    },
    receipt: {
      command_id: input.approval.commandId,
      approval_id: input.approval.approvalId,
      canonical_plan_sha256: "plan",
      result_sha256: "result",
    },
  };
}

function evidence(root, directoryId = ids[10]) {
  const directory = path.join(root, ".backups", "staging-native-authority", directoryId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const recovery = path.join(directory, "recovery-lineage.json");
  const prestate = path.join(directory, "scalar-prestate.json");
  const settlement = path.join(directory, "settlement.json");
  fs.writeFileSync(recovery, `${JSON.stringify({ closed: true })}\n`, { mode: 0o600 });
  fs.writeFileSync(prestate, `${JSON.stringify({
    plan: {},
    before: { record: originalRecord, relationship },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(settlement, `${JSON.stringify({
    acknowledged: true,
    settled: { record: settledRecord, relationship },
  })}\n`, { mode: 0o600 });
  return { directory, recovery, prestate, settlement };
}

function setup(root, extra = {}) {
  let uuidIndex = 0;
  const events = [];
  const grants = [
    {
      id: "profile-grant",
      staff_id: "staff",
      permission: "directory.profile.edit",
      effect: "allow",
      scope_kind: "resource",
      business_area_id: null,
      division_id: null,
      resource_id: "client",
      active: 0,
    },
    {
      id: "identity-grant",
      staff_id: "staff",
      permission: "directory.identity.link",
      effect: "allow",
      scope_kind: "resource",
      business_area_id: null,
      division_id: null,
      resource_id: "client",
      active: 0,
    },
  ];
  const state = {
    snapshot: {
      migrationNames: [],
      staff,
      admission,
      profile,
      generation: { staff_id: "staff", generation: 10, updated_at: "before" },
      record: originalRecord,
      relationship,
      grants,
      history: [],
    },
    approval: null,
    receipt: null,
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("native_staff_bootstrap_approvals")
              ? state.approval
              : state.receipt,
          };
        },
      };
    },
  };
  const deps = {
    root,
    withBinding: async (_config, callback) => callback({ db, target: STAGING_TARGET }),
    snapshot: async () => structuredClone(state.snapshot),
    clock: async () => "2026-10-10T12:00:00.000Z",
    randomUUID: () => ids[uuidIndex++],
    compile: (input) => artifact(input),
    apply: async (_db, compiled) => {
      events.push("apply");
      const active = compiled.input.phase === "provision" ? 1 : 0;
      state.snapshot.grants = compiled.input.grants.map((grant) => ({ ...grant, active }));
      state.snapshot.generation = {
        ...compiled.input.generation,
        generation: compiled.input.generation.generation + 2,
        updated_at: compiled.input.approval.executedAt,
      };
      state.snapshot.history = [
        ...compiled.input.history,
        ...compiled.selection.map((selection, index) => {
          const grant = compiled.input.grants.find((candidate) => candidate.id === selection.grantId);
          return {
            grant_id: grant.id,
            grant_version: compiled.input.history.filter(
              (history) => history.grant_id === grant.id,
            ).length + 1,
            staff_id: grant.staff_id,
            permission: grant.permission,
            effect: grant.effect,
            scope_kind: grant.scope_kind,
            business_area_id: grant.business_area_id,
            division_id: grant.division_id,
            resource_id: grant.resource_id,
            active,
            grant_generation: compiled.input.generation.generation + index + 1,
            recorded_at: compiled.input.approval.executedAt,
          };
        }),
      ];
      state.approval = compiled.approval;
      state.receipt = compiled.receipt;
    },
    readArtifact: (_root, file) => JSON.parse(fs.readFileSync(file, "utf8")),
    ...extra,
  };
  return { deps, events, state };
}

function snapshotFromInput(input) {
  return structuredClone(Object.fromEntries([
    "migrationNames",
    "staff",
    "admission",
    "profile",
    "generation",
    "record",
    "relationship",
    "grants",
    "history",
  ].map((key) => [key, input[key]])));
}

test("prepare is read-only and compiles the exact current snapshot with required evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-prepare-"));
  try {
    const files = evidence(root);
    const context = setup(root);
    const result = await prepare("config", files.recovery, files.prestate, context.deps);
    assert.equal(result.mode, "prepare-readonly");
    assert.equal(result.mutationsPerformed, false);
    assert.deepEqual(result.artifact.input.grants, context.state.snapshot.grants);
    assert.deepEqual(result.artifact.input.recoveryLineage, { closed: true });
    assert.deepEqual(result.artifact.input.scalarPrestate, {
      plan: {},
      before: { record: originalRecord, relationship },
    });
    assert.deepEqual(context.events, []);

    const wrong = setup(root, {
      withBinding: async (_config, callback) => callback({
        db: {},
        target: { ...STAGING_TARGET, databaseId: "wrong" },
      }),
    });
    await assert.rejects(
      prepare("config", files.recovery, files.prestate, wrong.deps),
      /trusted staging target/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply saves the provision artifact before mutation and returns bounded evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-open-"));
  try {
    const files = evidence(root);
    const context = setup(root);
    const result = await open("config", files.recovery, files.prestate, context.deps);
    assert.deepEqual(context.events, ["apply"]);
    assert.equal(result.mode, "applied");
    assert.equal(result.outcome.status, "committed");
    assert.match(result.artifactPath, /staging-native-authority[\\/].+[\\/]provision\.json$/);
    assert.equal(fs.existsSync(result.artifactPath), true);
    assert.doesNotMatch(JSON.stringify(result), /canonical_plan_json|recoveryLineage/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile distinguishes exact committed and untouched outcomes and rejects uncertainty", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-reconcile-"));
  try {
    const files = evidence(root);
    const untouched = setup(root);
    const prepared = await prepare("config", files.recovery, files.prestate, untouched.deps);
    const saved = path.join(files.directory, "provision.json");
    fs.writeFileSync(saved, `${JSON.stringify(prepared.artifact)}\n`, { mode: 0o600 });
    assert.equal((await reconcile("config", saved, untouched.deps)).status, "not-committed");
    const validUntouchedSnapshot = structuredClone(untouched.state.snapshot);
    for (const mutate of [
      snapshot => { snapshot.staff.status = "disabled"; },
      snapshot => { snapshot.admission.version += 1; },
      snapshot => { snapshot.profile.login_email = "forged@example.test"; },
      snapshot => { snapshot.record.current_version += 1; },
      snapshot => { snapshot.relationship.organization_record_id = "other"; },
    ]) {
      untouched.state.snapshot = structuredClone(validUntouchedSnapshot);
      mutate(untouched.state.snapshot);
      await assert.rejects(
        reconcile("config", saved, untouched.deps),
        /neither exact committed poststate nor exact untouched prestate/,
      );
    }
    untouched.state.snapshot = structuredClone(validUntouchedSnapshot);
    const forgedUntouched = structuredClone(prepared.artifact);
    forgedUntouched.input.scalarPrestate.before.record.current_version += 1;
    fs.writeFileSync(saved, `${JSON.stringify(forgedUntouched)}\n`, { mode: 0o600 });
    await assert.rejects(
      reconcile("config", saved, untouched.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    fs.writeFileSync(saved, `${JSON.stringify(prepared.artifact)}\n`, { mode: 0o600 });
    untouched.state.snapshot.history.push({ contradictory: true });
    await assert.rejects(
      reconcile("config", saved, untouched.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );

    const committed = setup(root);
    const opened = await open("config", files.recovery, files.prestate, committed.deps);
    assert.equal((await reconcile("config", opened.artifactPath, committed.deps)).status, "committed");

    const openedArtifact = JSON.parse(fs.readFileSync(opened.artifactPath, "utf8"));
    const validSnapshot = structuredClone(committed.state.snapshot);
    for (const mutate of [
      snapshot => { snapshot.staff.access_subject = "access|forged"; },
      snapshot => { snapshot.admission.active = 0; },
      snapshot => { snapshot.profile.version += 1; },
      snapshot => { snapshot.record.current_version += 1; },
      snapshot => { snapshot.relationship.relationship_version += 1; },
    ]) {
      committed.state.snapshot = structuredClone(validSnapshot);
      mutate(committed.state.snapshot);
      await assert.rejects(
        reconcile("config", opened.artifactPath, committed.deps),
        /neither exact committed poststate nor exact untouched prestate/,
      );
    }
    committed.state.snapshot = structuredClone(validSnapshot);
    const forgedCommitted = structuredClone(openedArtifact);
    forgedCommitted.input.scalarPrestate.before.relationship.organization_record_id = "forged";
    fs.writeFileSync(opened.artifactPath, `${JSON.stringify(forgedCommitted)}\n`, { mode: 0o600 });
    await assert.rejects(
      reconcile("config", opened.artifactPath, committed.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    fs.writeFileSync(opened.artifactPath, `${JSON.stringify(openedArtifact)}\n`, { mode: 0o600 });
    committed.state.snapshot.history.pop();
    await assert.rejects(
      reconcile("config", opened.artifactPath, committed.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    committed.state.snapshot = structuredClone(validSnapshot);
    committed.state.snapshot.history.at(-1).permission = "directory.enrollment.manage";
    await assert.rejects(
      reconcile("config", opened.artifactPath, committed.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    committed.state.snapshot = structuredClone(validSnapshot);
    committed.state.snapshot.generation.staff_id = "other-staff";
    await assert.rejects(
      reconcile("config", opened.artifactPath, committed.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    committed.state.snapshot = structuredClone(validSnapshot);
    committed.state.snapshot.generation.updated_at = "not-a-timestamp";
    await assert.rejects(
      reconcile("config", opened.artifactPath, committed.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    committed.state.snapshot = structuredClone(validSnapshot);
    committed.state.receipt = null;
    await assert.rejects(
      reconcile("config", opened.artifactPath, committed.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("close requires saved provision and settlement and saves settlement before revocation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-close-"));
  try {
    const files = evidence(root);
    const openedContext = setup(root);
    const opened = await open("config", files.recovery, files.prestate, openedContext.deps);
    const closeContext = setup(root);
    closeContext.state.snapshot.grants = openedContext.state.snapshot.grants;
    closeContext.state.snapshot.generation = openedContext.state.snapshot.generation;
    closeContext.state.snapshot.history = openedContext.state.snapshot.history;
    closeContext.state.snapshot.record = settledRecord;
    closeContext.state.snapshot.relationship = relationship;
    const result = await close(
      "config",
      opened.artifactPath,
      files.settlement,
      closeContext.deps,
    );
    assert.equal(result.mode, "closed");
    assert.equal(result.outcome.status, "committed");
    assert.match(result.artifactPath, /[\\/]revoke\.json$/);
    assert.match(result.settlementPath, /[\\/]granted-readback\.json$/);
    assert.equal(fs.existsSync(result.settlementPath), true);
    assert.deepEqual(closeContext.events, ["apply"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup reconciliation binds committed and untouched states to acknowledged settlement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-close-reconcile-"));
  try {
    const files = evidence(root);
    const openedContext = setup(root);
    const opened = await open("config", files.recovery, files.prestate, openedContext.deps);
    const closedContext = setup(root);
    closedContext.state.snapshot = structuredClone(openedContext.state.snapshot);
    closedContext.state.snapshot.record = structuredClone(settledRecord);
    const closed = await close("config", opened.artifactPath, files.settlement, closedContext.deps);
    assert.equal((await reconcile("config", closed.artifactPath, closedContext.deps)).status, "committed");

    const revokeArtifact = JSON.parse(fs.readFileSync(closed.artifactPath, "utf8"));
    const committedSnapshot = structuredClone(closedContext.state.snapshot);
    for (const mutate of [
      snapshot => { snapshot.admission.version += 1; },
      snapshot => { snapshot.profile.login_email = "cleanup-drift@example.test"; },
      snapshot => { snapshot.record.current_version += 1; },
      snapshot => { snapshot.relationship.organization_record_id = "cleanup-drift"; },
    ]) {
      closedContext.state.snapshot = structuredClone(committedSnapshot);
      mutate(closedContext.state.snapshot);
      await assert.rejects(
        reconcile("config", closed.artifactPath, closedContext.deps),
        /neither exact committed poststate nor exact untouched prestate/,
      );
    }
    closedContext.state.snapshot = structuredClone(committedSnapshot);
    const forgedCommitted = structuredClone(revokeArtifact);
    forgedCommitted.input.settlement.settled.record.current_version += 1;
    fs.writeFileSync(closed.artifactPath, `${JSON.stringify(forgedCommitted)}\n`, { mode: 0o600 });
    await assert.rejects(
      reconcile("config", closed.artifactPath, closedContext.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
    fs.writeFileSync(closed.artifactPath, `${JSON.stringify(revokeArtifact)}\n`, { mode: 0o600 });

    const untouched = setup(root);
    untouched.state.snapshot = snapshotFromInput(revokeArtifact.input);
    assert.equal((await reconcile("config", closed.artifactPath, untouched.deps)).status, "not-committed");
    untouched.state.snapshot.staff.status = "disabled";
    await assert.rejects(
      reconcile("config", closed.artifactPath, untouched.deps),
      /neither exact committed poststate nor exact untouched prestate/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private evidence reader rejects nested paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-path-"));
  try {
    const files = evidence(root);
    const context = setup(root);
    const nested = path.join(files.directory, "nested");
    fs.mkdirSync(nested);
    const nestedRecovery = path.join(nested, "recovery-lineage.json");
    fs.copyFileSync(files.recovery, nestedRecovery);
    await assert.rejects(
      prepare("config", nestedRecovery, files.prestate, context.deps),
      /exact private authority path/,
    );

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private evidence reader rejects UUID-directory symlinks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scalar-window-outside-"));
  try {
    const files = evidence(root);
    const context = setup(root);
    fs.writeFileSync(path.join(outside, "recovery-lineage.json"), "{}\n");
    const link = path.join(
      root,
      ".backups",
      "staging-native-authority",
      ids[11],
    );
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) {
        t.skip(`symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      prepare(
        "config",
        path.join(link, "recovery-lineage.json"),
        files.prestate,
        context.deps,
      ),
      /non-symlink/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
