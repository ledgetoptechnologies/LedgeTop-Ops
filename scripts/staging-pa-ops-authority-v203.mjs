import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compileNativeOnlyAuthorityPacket, nativeClientCreationGrantIds, STAGING_TARGET } from "./staging-directory-authority-v203.mjs";
import { compileBusinessAreaAuthorityPair, PURPOSE, PINNED_BUSINESS_AREA } from "./staging-project-authority-v203.mjs";
import { withStagingAuthorityBinding } from "./staging-native-authority-binding-runner.mjs";
import { createPrivateEvidenceDirectory, writePrivateEvidence } from "./staging-native-authority-packet-rehearsal.mjs";
import { buildTwoSourceStagingConnectionPlan } from "./staging-ops-two-source-connection-profile-v1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STAFF = "staff-beau-koltz";
// Compiled SQL/audit metadata repeat the bounded input. New artifacts persist
// only version/input/hash; the same 4MB reader budget also accepts earlier full
// packets. Both apply and recovery recompile trusted source locally.
export const MAX_AUTHORITY_ARTIFACT_BYTES = 4_000_000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = () => { throw new Error("current203 authority validation failed"); };
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();

/** Both components are compiled against the exact current203 source bytes.
 * Existing inactive allows at the exact area are reactivated with their normal
 * audit transitions; otherwise a fresh scoped allow is inserted. Original deny
 * rows and every unrelated grant remain unchanged. */
export function compilePaOpsAuthority203(input, { root = ROOT } = {}) {
  if (!input || input.version !== 203 || Object.keys(input).sort().join() !== "directory,project,version"
    || !same(input.directory.sourceMetadata, input.project.sourceMetadata)
    || !same(input.directory.businessArea, input.project.businessArea)
    || input.directory.admission.staff_id !== STAFF || input.project.admission.staff_id !== STAFF) fail();
  if (!["staff_id", "bound_access_subject", "active", "version"].every(key => input.directory.admission[key] === input.project.admission[key])
    || !["staff_id", "login_email", "display_name", "version"].every(key => input.directory.profile[key] === input.project.profile[key])) fail();
  const directory = compileNativeOnlyAuthorityPacket(input.directory, { root });
  const project = compileBusinessAreaAuthorityPair(input.project, { root });
  const ids = [directory.input.approval.approvalId, directory.input.approval.commandId,
    directory.input.approval.revokeApprovalId, directory.input.approval.revokeCommandId,
    ...directory.input.approval.grantIds, ...Object.entries(project.input.approval)
      .filter(([key]) => key.endsWith("Id")).map(([, value]) => value)];
  if (new Set(ids).size !== ids.length) fail();
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 500_000) fail();
  const packet = { version: 203, input: structuredClone(input), planSha256: hash(serialized), directory, project };
  if (Buffer.byteLength(`${JSON.stringify(authorityArtifact203(packet), null, 2)}\n`) > MAX_AUTHORITY_ARTIFACT_BYTES) fail();
  return packet;
}

export function authorityArtifact203(packet) {
  return { version: packet.version, input: structuredClone(packet.input), planSha256: packet.planSha256 };
}

/** Trusted module-only write boundary. Call only after independent live binding
 * review and a verified backup. Provision AND revoke each use one D1.batch, so
 * failure in either authority family rolls back the complete paired action.
 * Exact receipt replay never reopens authority following revocation. */
export async function applyPaOpsAuthority203(db, packet, phase, { target, root = ROOT } = {}) {
  if (!same(target, STAGING_TARGET) || !["provision", "revoke"].includes(phase)) fail();
  const expected = compilePaOpsAuthority203(packet?.input, { root });
  if (!same(expected, packet) || expected.directory.input.phase !== phase) fail();
  const project = expected.project[phase];
  const receipts = await Promise.all([expected.directory.receipt, project.receipt].map(async receipt => ({
    expected: receipt, actual: await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", receipt.command_id),
  })));
  if (receipts.some(receipt => receipt.actual)) {
    if (!receipts.every(receipt => receipt.actual)) fail();
    for (const [index, receipt] of receipts.entries()) {
      const omitTime = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "executed_at"));
      if (index === 0 ? !same(receipt.actual, receipt.expected)
        : !same(omitTime(receipt.actual), omitTime(receipt.expected))
          || !Number.isFinite(Date.parse(receipt.actual.executed_at))) fail();
      if (index === 1) {
        const actualTime = Date.parse(receipt.actual.executed_at);
        if (new Date(actualTime).toISOString() !== receipt.actual.executed_at) fail();
        if (phase === "provision" && (actualTime < Date.parse(expected.project.input.approval.issuedAt)
          || actualTime >= Date.parse(expected.project.input.approval.expiresAt))) fail();
        if (phase === "revoke") {
          const prior = await first(db, "SELECT executed_at FROM native_staff_bootstrap_receipts WHERE command_id=?", expected.project.input.approval.commandId);
          if (!prior || actualTime < Date.parse(prior.executed_at)) fail();
        }
      }
    }
    return { status: "replayed", phase, mutationsPerformed: false, planSha256: expected.planSha256 };
  }
  const statements = [...expected.directory.statements, ...project.statements];
  await db.batch(statements.map(statement => db.prepare(statement.sql).bind(...statement.params)));
  return { status: "applied", phase, mutationsPerformed: true, planSha256: expected.planSha256 };
}

export async function captureAuthority203(db) {
  const generationBefore = await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", STAFF);
  const projectBefore = await first(db, "SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?", STAFF);
  const snapshot = {
    admission: await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", STAFF),
    profile: await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", STAFF),
    businessArea: await first(db, "SELECT * FROM native_business_areas WHERE id=?", PINNED_BUSINESS_AREA.id),
    grants: await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id LIMIT 2049", STAFF),
    history: await all(db, "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_id,grant_version LIMIT 2049", STAFF),
    generation: await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", STAFF),
    projectGrants: await all(db, "SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id LIMIT 2049", STAFF),
    projectGeneration: await first(db, "SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?", STAFF),
    observedAt: (await first(db, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp")).stamp,
  };
  if (!same(generationBefore, snapshot.generation) || !same(projectBefore, snapshot.projectGeneration)) fail();
  return snapshot;
}

/** Read-only capture and local compilation; it neither installs approvals nor
 * applies grants. Prepare after backup/review readiness: directory execution
 * time is guarded to five minutes; the approval window is one hour. Grants
 * have no automatic expiry and MUST be explicitly revoked after acceptance. */
export async function prepareAuthority203(db, sourceMetadata, priorPacket = null) {
  buildTwoSourceStagingConnectionPlan(sourceMetadata);
  const snapshot = await captureAuthority203(db);
  const now = snapshot.observedAt;
  const expiry = new Date(Date.parse(now) + 3600_000).toISOString();
  const issue = new Date(Date.parse(now) - 1000).toISOString();
  const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
  let directoryApproval, project;
  if (priorPacket) {
    const prior = compilePaOpsAuthority203(priorPacket.input);
    if (!same(prior, priorPacket) || prior.directory.input.phase !== "provision"
      || !same(prior.input.directory.sourceMetadata, sourceMetadata)) fail();
    directoryApproval = { ...prior.input.directory.approval, issuedAt: issue, expiresAt: expiry, executedAt: now };
    project = prior.input.project;
  } else {
    const approvalId = crypto.randomUUID();
    directoryApproval = { approvalId, commandId: crypto.randomUUID(), revokeApprovalId: crypto.randomUUID(), revokeCommandId: crypto.randomUUID(),
      issuedByStaffId: STAFF, issuedByAccessSubject: snapshot.admission.bound_access_subject,
      issuedAt: issue, expiresAt: expiry, executedAt: now,
      grantIds: nativeClientCreationGrantIds(STAFF, PINNED_BUSINESS_AREA.id, approvalId).map((fresh, index) =>
        snapshot.grants.find(row => row.permission === ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"][index]
          && row.effect === "allow" && row.scope_kind === "business_area" && row.business_area_id === PINNED_BUSINESS_AREA.id && row.active === 0)?.id ?? fresh) };
    project = { schemaVersion: 1, purpose: PURPOSE, staging: STAGING_TARGET,
      admission: pick(snapshot.admission, ["staff_id", "bound_access_subject", "active", "version"]),
      profile: pick(snapshot.profile, ["staff_id", "login_email", "display_name", "version"]),
      businessArea: snapshot.businessArea, generation: snapshot.projectGeneration, grants: snapshot.projectGrants,
      approval: { approvalId: crypto.randomUUID(), commandId: crypto.randomUUID(), revokeApprovalId: crypto.randomUUID(),
        revokeCommandId: crypto.randomUUID(), grantId: snapshot.projectGrants.find(row => row.effect === "allow"
          && row.scope_kind === "business_area" && row.business_area_id === PINNED_BUSINESS_AREA.id && row.active === 0)?.id ?? crypto.randomUUID(), issuedAt: issue, expiresAt: expiry,
        provisionExecutedAt: now, revokeExecutedAt: now, changeTicket: "staging-pa-ops-two-source-203", reviewer: STAFF }, sourceMetadata };
  }
  const priorProvision = priorPacket ? {
    approval: await first(db, "SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id=?", priorPacket.directory.approval.approval_id),
    receipt: await first(db, "SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?", priorPacket.directory.receipt.command_id),
  } : null;
  const directory = { schemaVersion: 3, staging: STAGING_TARGET, phase: priorPacket ? "revoke" : "provision",
    admission: snapshot.admission, profile: snapshot.profile, businessArea: snapshot.businessArea,
    grants: snapshot.grants, history: snapshot.history, generation: snapshot.generation,
    approval: directoryApproval, priorProvision, sourceMetadata };
  return compilePaOpsAuthority203({ version: 203, directory, project });
}

function protect(filename) {
  if (process.platform !== "win32") return;
  const result = spawnSync("pwsh", ["-NoProfile", "-File", path.join(ROOT, "scripts/restrict-private-authority-file.ps1"),
    "-LiteralFile", filename], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) fail();
}

function privateFile(filename, maximum) {
  if (typeof filename !== "string") fail();
  const absolute = path.resolve(filename), privateRoot = path.join(ROOT, ".backups");
  const relative = path.relative(privateRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail();
  for (let current = absolute; current !== ROOT; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || current === absolute && (!stat.isFile() || stat.size > maximum)) fail();
  }
  return absolute;
}

/** Shared local-only boundary: validates a persisted prepared packet without
 * contacting D1, installing approvals, applying grants, or opening a proxy. */
export function readAuthorityPacket203(filename) {
  const packetPath = privateFile(filename, MAX_AUTHORITY_ARTIFACT_BYTES);
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  const checked = compilePaOpsAuthority203(packet.input);
  const compact = Object.keys(packet).sort().join() === "input,planSha256,version";
  if (!same(packet, compact ? authorityArtifact203(checked) : checked)) fail();
  return checked;
}

export async function runReviewedApply(argv) {
  const [mode, c, config, p, packetFile, f, phase, h, planSha256, b, backupFile, s, backupSha256, confirmation] = argv;
  if (argv.length !== 14 || mode !== "apply" || c !== "--config" || p !== "--packet" || f !== "--phase"
    || h !== "--plan-sha256" || b !== "--backup" || s !== "--backup-sha256"
    || confirmation !== "--confirm-reviewed-staging-authority" || !["provision", "revoke"].includes(phase)
    || !/^[0-9a-f]{64}$/.test(planSha256) || !/^[0-9a-f]{64}$/.test(backupSha256)) fail();
  const packetPath = privateFile(packetFile, MAX_AUTHORITY_ARTIFACT_BYTES), backupPath = privateFile(backupFile, 1000_000_000);
  const backup = fs.readFileSync(backupPath), backupStat = fs.statSync(backupPath);
  // This binds the reviewed file bytes; the operator independently verifies
  // provider provenance, exact staging database and successful restoration.
  if (backup.length < 1024 || hash(backup) !== backupSha256 || !backup.includes(Buffer.from("CREATE TABLE"))
    || Date.now() - backupStat.mtimeMs > 4 * 3600_000) fail();
  const checked = readAuthorityPacket203(packetPath);
  if (checked.planSha256 !== planSha256 || checked.directory.input.phase !== phase) fail();
  const observed = await withStagingAuthorityBinding(config, async ({ db, target }) => ({
    result: await applyPaOpsAuthority203(db, checked, phase, { target }),
    readback: await captureAuthority203(db),
  }));
  const evidenceDir = path.dirname(packetPath), filename = phase === "provision" ? "granted-readback.json" : "revoked-readback.json";
  const readbackPath = path.join(evidenceDir, filename);
  if (!fs.existsSync(readbackPath)) {
    writePrivateEvidence(ROOT, evidenceDir, filename, { ...observed, backupSha256, planSha256 });
    protect(readbackPath);
  }
  console.log(JSON.stringify({ ...observed.result, readbackPath, automaticGrantExpiry: false,
    cleanupRequired: phase === "provision", credentialsExcluded: true }));
  return observed.result;
}

/** Preparation is read-only. Apply requires the exact independently reviewed
 * plan hash, verified staging backup bytes and an explicit confirmation flag. */
export async function run(argv = process.argv.slice(2)) {
  if (argv[0] === "apply") return runReviewedApply(argv);
  const [mode, configFlag, config, sourcesFlag, sources, priorFlag, prior] = argv;
  if (!["prepare", "prepare-revoke"].includes(mode) || configFlag !== "--config" || sourcesFlag !== "--sources"
    || mode === "prepare" && argv.length !== 5
    || mode === "prepare-revoke" && (argv.length !== 7 || priorFlag !== "--prior")) fail();
  const sourceStat = fs.lstatSync(sources);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 2_000_000) fail();
  const sourceMetadata = JSON.parse(fs.readFileSync(sources, "utf8"));
  const priorPacket = prior ? readAuthorityPacket203(prior) : null;
  const packet = await withStagingAuthorityBinding(config, ({ db }) => prepareAuthority203(db, sourceMetadata, priorPacket));
  const evidence = createPrivateEvidenceDirectory(ROOT, crypto.randomUUID());
  const artifactPath = writePrivateEvidence(ROOT, evidence.evidenceDir, "provision.json", authorityArtifact203(packet));
  protect(artifactPath);
  console.log(JSON.stringify({ status: "prepared-review-required", phase: packet.directory.input.phase,
    planSha256: packet.planSha256, artifactPath, mutationsPerformed: false, backupRequired: true,
    automaticGrantExpiry: false,
    preparedAt: packet.input.directory.approval.executedAt, expiresAt: packet.input.directory.approval.expiresAt }));
  return packet;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(() => { console.error("Current203 authority operation failed. Retain the exact artifact and verify receipts before retrying."); process.exitCode = 1; });
}
