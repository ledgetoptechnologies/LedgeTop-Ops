import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  MAX_PRIVATE_ARTIFACT_BYTES,
  PROJECT_ORGANIZATION_APPROVAL_WINDOW_MS,
  closeProjectOrganizationAuthorityV184 as close,
  openProjectOrganizationAuthorityV184 as open,
  prepareProjectOrganizationAuthorityV184 as prepare,
  readProjectOrganizationPrivateArtifact,
  reconcileProjectOrganizationAuthorityWindowV184 as reconcile,
  writeProjectOrganizationPrivateEvidence,
} from "./staging-project-organization-authority-v184-window.mjs";

const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const snapshot = {
  migrationNames: [], staff: { id: "staff", status: "active", access_subject: "subject" }, roles: [],
  admission: {}, profile: {}, businessArea: {}, projectGeneration: { staff_id: "staff", generation: 4 }, projectGrants: [],
};

function compiled(input) {
  const phase = Object.hasOwn(input, "provisionReadback") ? "revoke" : "provision";
  const selected = { approval: { approval_id: input.approval[`${phase}ApprovalId`] }, receipt: {
    command_id: input.approval[`${phase}CommandId`], approval_id: input.approval[`${phase}ApprovalId`],
    canonical_plan_sha256: "plan", result_sha256: "result",
  } };
  return { schemaVersion: input.schemaVersion, input, provision: phase === "provision" ? selected : {}, ...(phase === "revoke" ? { revoke: selected } : {}) };
}

function context(root, extra = {}) {
  let uuid = 0;
  const state = { snapshot: structuredClone(snapshot), approval: null, receipt: null, grant: null };
  const db = { prepare(sql) { return { bind() { return { first: async () => {
    if (sql.includes("bootstrap_approvals")) return state.approval;
    if (sql.includes("bootstrap_receipts")) return state.receipt;
    if (sql.includes("native_project_grants")) return state.grant;
    return null;
  } }; } }; } };
  return { state, deps: {
    root,
    withBinding: async (_config, callback) => callback({ db, target: STAGING_TARGET }),
    readRecovery: () => ({ provisionArtifact: {}, revokeArtifact: {} }),
    lineage: async () => ({ provisionArtifact: {}, revokeArtifact: {}, approvals: [], receipts: [], directoryGrants: [], directoryGrantHistory: [], directoryGrantGeneration: {} }),
    snapshot: async () => structuredClone(state.snapshot), clock: async () => "2026-10-10T12:00:00.000Z",
    randomUUID: () => ids[uuid++], compile: compiled,
    reconciliationSnapshot: async (_db, artifact, phase) => ({
      current: structuredClone(state.snapshot), currentLineage: structuredClone(artifact.input.recoveryLineage),
      selectedApproval: state.approval, selectedReceipt: state.receipt,
      provisionApproval: phase === "revoke" ? state.approval : null,
      provisionReceipt: phase === "revoke" ? state.receipt : null,
    }),
    createEvidence: (_root, approvalId) => { const evidenceDir = path.join(root, ".backups", "staging-native-authority", approvalId); fs.mkdirSync(evidenceDir, { recursive: true }); return { evidenceDir }; },
    writeEvidence: (_root, directory, name, value) => { const file = path.join(directory, name); fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" }); return file; },
    readProject: (_root, file) => ({ artifact: JSON.parse(fs.readFileSync(file, "utf8")), directory: path.dirname(file) }),
    apply: async (_db, artifact, phase) => { if (phase === "provision") {
      state.approval = artifact.provision.approval; state.receipt = { ...artifact.provision.receipt, executed_at: "2026-10-10T12:00:01.000Z" };
      state.grant = { id: artifact.input.approval.grantId, created_at: "2026-10-10T12:00:01.000Z" };
    } return { status: "settled" }; },
    ...extra,
  } };
}

test("prepare is read-only and freezes five distinct identifiers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-prepare-"));
  try {
    const { deps } = context(root);
    const result = await prepare("config", "recovery-provision", "recovery-revoke", deps);
    assert.equal(result.mode, "prepare-readonly");
    assert.equal(result.mutationsPerformed, false);
    assert.equal(result.artifact.input.schemaVersion, 2);
    assert.equal(new Set(Object.values(result.artifact.input.approval).slice(0, 5)).size, 5);
    assert.equal(PROJECT_ORGANIZATION_APPROVAL_WINDOW_MS, 600_000);
    assert.equal(Date.parse(result.artifact.input.approval.expiresAt)
      - Date.parse(result.artifact.input.approval.issuedAt), 600_000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("prepare reuses the exact inactive organization grant id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-reuse-"));
  try {
    const { deps, state } = context(root);
    state.snapshot.projectGrants = [{ id: ids[7], staff_id: "staff", capability: "project.shared.sync", effect: "allow", scope_kind: "business_area", business_area_id: "drone-services-staging", division_id: null, external_project_id: null, active: 0, version: 4, granted_by: "staff", created_at: "2026-10-09T12:00:00.000Z" }];
    const result = await prepare("config", "p", "r", deps);
    assert.equal(result.artifact.input.approval.grantId, ids[7]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("open writes durable evidence before its single apply and hides the artifact from output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-open-"));
  try {
    const events = [], { deps } = context(root, {
      writeEvidence: (_root, directory, name, value) => { events.push("write"); const file = path.join(directory, name); fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" }); return file; },
      apply: async () => { events.push("apply"); return { status: "settled" }; },
    });
    const result = await open("config", "recovery-provision", "recovery-revoke", deps);
    assert.deepEqual(events, ["write", "apply"]);
    assert.equal(fs.existsSync(result.artifactPath), true);
    assert.doesNotMatch(JSON.stringify(result), /recoveryLineage|canonical_plan_json/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an apply error is uncertain and explicitly forbids retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-unknown-"));
  try {
    const { deps } = context(root, { apply: async () => { throw Error("provider secret"); } });
    await assert.rejects(open("config", "p", "r", deps), /outcome unknown; reconcile .*do not retry/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("close compiles from exact current provision rows and saves revoke before apply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-close-"));
  try {
    const setup = context(root), opened = await open("config", "p", "r", setup.deps), events = [];
    const closeContext = context(root, {
      readProject: setup.deps.readProject,
      writeEvidence: (_root, directory, name, value) => { events.push("write"); const file = path.join(directory, name); fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" }); return file; },
      apply: async (_db, artifact) => { events.push("apply"); assert.deepEqual(artifact.input.provisionReadback, { approval: closeContext.state.approval, receipt: closeContext.state.receipt, grant: closeContext.state.grant }); return { status: "settled" }; },
    });
    closeContext.state.approval = setup.state.approval;
    closeContext.state.receipt = setup.state.receipt;
    closeContext.state.grant = setup.state.grant;
    const result = await close("config", opened.artifactPath, closeContext.deps);
    assert.deepEqual(events, ["write", "apply"]);
    assert.match(result.artifactPath, /revoke\.json$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reconcile reports exact committed, exact untouched, and rejects ambiguity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-reconcile-"));
  try {
    const setup = context(root), opened = await open("config", "p", "r", setup.deps);
    setup.state.snapshot = structuredClone(opened ? snapshot : snapshot);
    setup.state.approval = null; setup.state.receipt = null; setup.state.grant = null;
    setup.deps.reconcile = async () => null;
    assert.equal((await reconcile("config", opened.artifactPath, setup.deps)).status, "not-committed");
    setup.deps.reconcile = async () => ({ status: "settled" });
    assert.equal((await reconcile("config", opened.artifactPath, setup.deps)).status, "committed");
    setup.deps.reconcile = async () => null;
    setup.state.snapshot.profile = { drift: true };
    await assert.rejects(reconcile("config", opened.artifactPath, setup.deps), /manual review required/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("wrong binding is rejected before database work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-binding-"));
  try {
    const { deps } = context(root, { withBinding: async (_c, cb) => cb({ db: {}, target: { ...STAGING_TARGET, databaseId: "wrong" } }) });
    await assert.rejects(prepare("config", "p", "r", deps), /trusted staging target/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("private evidence writer and reader symmetrically accept realistic artifacts above 2 MiB", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-large-evidence-"));
  try {
    const approvalId = ids[0], directory = path.join(root, ".backups", "staging-native-authority", approvalId);
    fs.mkdirSync(directory, { recursive: true });
    const artifact = { input: { approval: { provisionApprovalId: approvalId }, padding: "x".repeat(4 * 1024 * 1024) } };
    const filename = writeProjectOrganizationPrivateEvidence(root, directory, "provision.json", artifact);
    assert.ok(fs.statSync(filename).size > 2 * 1024 * 1024);
    assert.deepEqual(readProjectOrganizationPrivateArtifact(root, filename, input => ({ input })).artifact, artifact);
  } finally {
    const protectedFile = path.join(root, ".backups", "staging-native-authority", ids[0], "provision.json");
    if (fs.existsSync(protectedFile)) execFileSync("icacls.exe", [protectedFile, "/reset"], { windowsHide: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private evidence exceeding 8 MiB is rejected before a file or mutation can exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-org-oversize-evidence-"));
  try {
    const approvalId = ids[0], directory = path.join(root, ".backups", "staging-native-authority", approvalId);
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, "provision.json");
    const artifact = { padding: "x".repeat(MAX_PRIVATE_ARTIFACT_BYTES) };
    assert.throws(() => writeProjectOrganizationPrivateEvidence(root, directory, "provision.json", artifact), /exceeds size limit/);
    assert.equal(fs.existsSync(destination), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
