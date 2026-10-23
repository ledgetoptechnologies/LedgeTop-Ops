import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NATIVE_STAFF_PRODUCTION_TARGET = Object.freeze({
  accountId: "846c924bf17bf4f3dd15c97a4c5d1d51", databaseId: "6ebf7514-d306-4615-ae56-ad869c874dbd", databaseName: "ltds-ops",
});
const SHA = /^[0-9a-f]{64}$/u, COMMIT = /^[0-9a-f]{40}$/u;
const fail = message => { throw new Error(`native_staff_cutover_not_ready:${message}`); };
const hash = value => createHash("sha256").update(value).digest("hex");
export function canonicalStaffReadiness(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStaffReadiness).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalStaffReadiness(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const same = (a, b) => canonicalStaffReadiness(a) === canonicalStaffReadiness(b);
function boundedRows(value, max = 1024) {
  if (!Array.isArray(value) || value.length > max || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) fail("rows_invalid");
  return value;
}
function cohort(rows) {
  const selected = boundedRows(rows).map(row => {
    if (!exact(row, ["staffId", "email", "accessSubject", "displayName", "active", "admissionVersion", "profileVersion"])
      || typeof row.staffId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(row.staffId)
      || typeof row.email !== "string" || row.email !== row.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+$/u.test(row.email)
      || typeof row.accessSubject !== "string" || !row.accessSubject.trim() || row.accessSubject.length > 191 || /\p{C}/u.test(row.accessSubject)
      || typeof row.displayName !== "string" || !row.displayName.trim() || row.displayName.length > 160
      || typeof row.active !== "boolean" || !positive(row.admissionVersion) || !positive(row.profileVersion)) fail("cohort_identity_invalid");
    return { ...row };
  }).sort((a, b) => a.staffId.localeCompare(b.staffId));
  if (!selected.length || new Set(selected.map(r => r.staffId)).size !== selected.length
    || new Set(selected.map(r => r.email)).size !== selected.length || new Set(selected.map(r => r.accessSubject)).size !== selected.length) fail("cohort_ambiguous");
  return selected;
}

/** review is a private packet already accepted by the release's trusted review
 * procedure. This function neither creates approval nor treats a boolean/name/
 * owner role as approval. Actual durable bootstrap evidence must match it. */
export function verifyNativeStaffCutoverReadiness(review, observation, { sourceCommit, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  if (!COMMIT.test(sourceCommit ?? "") || !Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) fail("caller_invalid");
  if (!exact(review, ["schemaVersion", "sourceCommit", "accountId", "databaseId", "cohort", "bootstrapReceipts"])
    || review.schemaVersion !== 1 || review.sourceCommit !== sourceCommit
    || review.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId || review.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId) fail("review_target_invalid");
  if (!exact(observation, ["schemaVersion", "accountId", "databaseId", "observedAt", "control", "cohort", "bridgeMismatchCount", "controlPlaneStaffIds", "bootstrapReceipts"])
    || observation.schemaVersion !== 1 || observation.accountId !== review.accountId || observation.databaseId !== review.databaseId
    || !Number.isFinite(Date.parse(observation.observedAt)) || Date.parse(observation.observedAt) > now
    || now - Date.parse(observation.observedAt) > maxAgeMs || observation.bridgeMismatchCount !== 0) fail("observation_invalid_or_stale");
  const control = observation.control;
  if (!exact(control, ["enabled", "generation", "appliedGeneration", "leaseId", "lastSuccessAt", "lastError"])
    || control.enabled !== 1 || !Number.isSafeInteger(control.generation) || control.generation < 0
    || control.appliedGeneration !== control.generation || control.leaseId !== null || control.lastError !== null
    || !Number.isFinite(Date.parse(control.lastSuccessAt)) || Date.parse(control.lastSuccessAt) > now
    || now - Date.parse(control.lastSuccessAt) > 60_000) fail("cutover_or_reconciliation_pending");
  const reviewed = cohort(review.cohort), actual = cohort(observation.cohort);
  if (!same(reviewed, actual)) fail("reviewed_cohort_changed");
  if (!Array.isArray(observation.controlPlaneStaffIds) || !observation.controlPlaneStaffIds.length
    || observation.controlPlaneStaffIds.some(id => !actual.some(row => row.staffId === id && row.active))
    || new Set(observation.controlPlaneStaffIds).size !== observation.controlPlaneStaffIds.length) fail("control_plane_unavailable");
  const refs = boundedRows(review.bootstrapReceipts, 128), proofs = boundedRows(observation.bootstrapReceipts, 128);
  if (!refs.length || new Set(refs.map(r => r.commandId)).size !== refs.length) fail("bootstrap_review_missing");
  for (const ref of refs) {
    if (!exact(ref, ["approvalId", "commandId", "canonicalPlanSha256", "bindingEvidenceSha256", "operatorStaffId", "operatorSubject"])
      || !SHA.test(ref.canonicalPlanSha256) || !SHA.test(ref.bindingEvidenceSha256)) fail("bootstrap_reference_invalid");
    const matching = proofs.filter(proof => proof.commandId === ref.commandId);
    if (matching.length !== 1) fail("bootstrap_receipt_missing");
    const proof = matching[0];
    if (!exact(proof, ["approvalId", "commandId", "canonicalPlanSha256", "bindingEvidenceSha256", "operatorStaffId", "operatorSubject",
      "canonicalPlanJson", "bindingEvidenceJson", "valid"])
      || proof.valid !== 1 || !same(ref, Object.fromEntries(Object.keys(ref).map(key => [key, proof[key]])))
      || typeof proof.canonicalPlanJson !== "string" || Buffer.byteLength(proof.canonicalPlanJson) > 262144
      || typeof proof.bindingEvidenceJson !== "string" || Buffer.byteLength(proof.bindingEvidenceJson) > 262144
      || hash(proof.canonicalPlanJson) !== ref.canonicalPlanSha256 || hash(proof.bindingEvidenceJson) !== ref.bindingEvidenceSha256
      || !actual.some(row => row.staffId === ref.operatorStaffId && row.accessSubject === ref.operatorSubject && row.active)) fail("bootstrap_proof_invalid");
    let plan, evidence;
    try { plan = JSON.parse(proof.canonicalPlanJson); evidence = JSON.parse(proof.bindingEvidenceJson); } catch { fail("bootstrap_json_invalid"); }
    const cohortSha256 = hash(canonicalStaffReadiness(actual));
    if (!exact(plan, ["kind", "cohortSha256", "controlPlaneStaffIds"])
      || plan.kind !== "operations-native-staff-cutover-v1" || plan.cohortSha256 !== cohortSha256
      || !Array.isArray(plan.controlPlaneStaffIds)
      || !same([...plan.controlPlaneStaffIds].sort(), [...observation.controlPlaneStaffIds].sort())
      || !exact(evidence, ["kind", "cohortSha256", "operatorStaffId", "operatorSubject"])
      || evidence.kind !== "operations-native-staff-binding-review-v1" || evidence.cohortSha256 !== cohortSha256
      || evidence.operatorStaffId !== ref.operatorStaffId || evidence.operatorSubject !== ref.operatorSubject) fail("staff_cutover_review_purpose_invalid");
  }
  return Object.freeze({ schemaVersion: 1, sourceCommit, accountId: review.accountId, databaseId: review.databaseId,
    reviewSha256: hash(canonicalStaffReadiness(review)), cohortSha256: hash(canonicalStaffReadiness(actual)),
    observedAt: observation.observedAt, staffCount: actual.length, generation: control.generation });
}

// Finite read-only SQL. No caller text, table identifier, email or staff ID is
// interpolated. Staff identities remain in process; the public receipt is hashes
// and counts only. Over-capacity queries refuse instead of truncating readiness.
export const NATIVE_STAFF_READINESS_QUERIES = Object.freeze({
  control: "SELECT enabled,generation,applied_generation AS appliedGeneration,lease_id AS leaseId,last_success_at AS lastSuccessAt,last_error AS lastError FROM native_staff_access_reconciliation WHERE singleton=1",
  cohort: `SELECT s.id AS staffId,p.login_email AS email,a.bound_access_subject AS accessSubject,p.display_name AS displayName,
    a.active,a.version AS admissionVersion,p.version AS profileVersion FROM staff_users s
    LEFT JOIN native_staff_admissions a ON a.staff_id=s.id LEFT JOIN native_staff_profiles p ON p.staff_id=s.id
    WHERE s.status='active' OR a.staff_id IS NOT NULL ORDER BY s.id LIMIT 1025`,
  bridge: `SELECT count(*) AS count FROM staff_users s LEFT JOIN native_staff_admissions a ON a.staff_id=s.id
    LEFT JOIN native_staff_profiles p ON p.staff_id=s.id WHERE (s.status='active' OR a.staff_id IS NOT NULL)
      AND (a.staff_id IS NULL OR p.staff_id IS NULL OR s.email IS NOT p.login_email COLLATE BINARY OR s.access_subject IS NOT a.bound_access_subject
        OR s.display_name IS NOT p.display_name OR s.status IS NOT CASE a.active WHEN 1 THEN 'active' ELSE 'inactive' END)`,
  controlPlane: "SELECT staff_id AS staffId FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id LIMIT 1025",
  bootstrap: `SELECT r.approval_id AS approvalId,r.command_id AS commandId,r.canonical_plan_sha256 AS canonicalPlanSha256,
    r.independent_binding_verification_sha256 AS bindingEvidenceSha256,r.operator_staff_id AS operatorStaffId,
    r.operator_access_subject AS operatorSubject,r.canonical_plan_json AS canonicalPlanJson,
    r.independent_binding_verification_json AS bindingEvidenceJson,
    CASE WHEN a.revoked_at IS NULL AND a.canonical_plan_sha256=r.canonical_plan_sha256
      AND a.canonical_plan_json=r.canonical_plan_json AND a.independent_binding_verification_sha256=r.independent_binding_verification_sha256
      AND a.independent_binding_verification_json=r.independent_binding_verification_json
      AND a.approved_operator_staff_id=r.operator_staff_id AND a.approved_operator_access_subject=r.operator_access_subject
      AND julianday(r.executed_at)>=julianday(a.issued_at) AND julianday(r.executed_at)<julianday(a.expires_at)
    THEN 1 ELSE 0 END AS valid FROM native_staff_bootstrap_receipts r
    JOIN native_staff_bootstrap_approvals a ON a.approval_id=r.approval_id ORDER BY r.command_id LIMIT 129`,
});
function jsonRows(query, keys) {
  return `(SELECT json_group_array(json_object(${keys.map(key => `'${key}',r."${key}"`).join(",")})) FROM (${query}) r)`;
}
// One SELECT is one database snapshot. Separate before/after generation reads
// cannot fence profile/delegation changes which do not advance that generation.
export const NATIVE_STAFF_READINESS_SNAPSHOT_QUERY = `SELECT json_object(
  'control',json((SELECT json_object('enabled',enabled,'generation',generation,'appliedGeneration',appliedGeneration,
    'leaseId',leaseId,'lastSuccessAt',lastSuccessAt,'lastError',lastError) FROM (${NATIVE_STAFF_READINESS_QUERIES.control}))),
  'cohort',json(${jsonRows(NATIVE_STAFF_READINESS_QUERIES.cohort, ["staffId", "email", "accessSubject", "displayName", "active", "admissionVersion", "profileVersion"])}),
  'bridgeMismatchCount',(SELECT count FROM (${NATIVE_STAFF_READINESS_QUERIES.bridge})),
  'controlPlaneStaffIds',json((SELECT json_group_array(staffId) FROM (${NATIVE_STAFF_READINESS_QUERIES.controlPlane}))),
  'bootstrapReceipts',json(${jsonRows(NATIVE_STAFF_READINESS_QUERIES.bootstrap, ["approvalId", "commandId", "canonicalPlanSha256", "bindingEvidenceSha256", "operatorStaffId", "operatorSubject", "canonicalPlanJson", "bindingEvidenceJson", "valid"])})
) AS readiness_snapshot`;
function rows(output) {
  let value; try { value = typeof output === "string" ? JSON.parse(output) : output; } catch { fail("reader_json_invalid"); }
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0].results)) fail("reader_result_invalid");
  return value[0].results;
}

/** Separate from the production metadata reader. It uses only installed
 * Wrangler's supported remote SELECT command through its existing credential
 * provider. It never reads or returns a private credential file. */
export function nativeStaffReadinessEnvironment(env) {
  const unsafe = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  if (Object.entries(env).some(([key, value]) => unsafe.includes(key.toUpperCase()) && value)
    || env.CLOUDFLARE_ACCOUNT_ID !== NATIVE_STAFF_PRODUCTION_TARGET.accountId
    || typeof env.CLOUDFLARE_API_TOKEN !== "string" || !/^[A-Za-z0-9_-]{20,1024}$/u.test(env.CLOUDFLARE_API_TOKEN)) fail("noninteractive_environment_required");
  const keys = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "PATHEXT", "HOME"];
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => keys.includes(key.toUpperCase()))),
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4", CI: "true", NO_COLOR: "1", WRANGLER_LOG: "error",
    WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false" };
}
export async function readNativeStaffCutoverReadiness({ review, sourceCommit, read, now = Date.now, env = process.env } = {}) {
  review = structuredClone(review);
  if (!COMMIT.test(sourceCommit ?? "") || review?.sourceCommit !== sourceCommit
    || review.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId || review.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId) fail("read_target_invalid");
  const environment = read ? null : nativeStaffReadinessEnvironment(env);
  const runtime = path.join(ROOT, "apps/operations/node_modules/wrangler/wrangler-dist/cli.js");
  if (!read) {
    const profile = JSON.parse(await readFile(path.join(ROOT, "scripts/production-deploy-profile.json"), "utf8"));
    if (!SHA.test(profile.wranglerRuntimeSHA256) || hash(await readFile(runtime)) !== profile.wranglerRuntimeSHA256) fail("reader_runtime_unqualified");
  }
  const target = NATIVE_STAFF_PRODUCTION_TARGET, folder = await mkdtemp(path.join(tmpdir(), "ops-staff-readiness-")), config = path.join(folder, "wrangler.json");
  try {
    await writeFile(config, JSON.stringify({ name: "ops-staff-readiness-read-only", account_id: target.accountId,
      compatibility_date: "2026-07-22", d1_databases: [{ binding: "OPS_DB", database_name: target.databaseName, database_id: target.databaseId }] }), { flag: "wx" });
    const reader = read ?? (async args => {
      try {
        return (await promisify(execFile)(process.execPath, [runtime, ...args], {
          cwd: folder, env: environment,
          timeout: 45_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true, shell: false,
        })).stdout;
      } catch { fail("read_failed"); }
    });
    const started = now(), selectedRows = rows(await reader(["d1", "execute", target.databaseId, "--remote", "--config", config,
      "--command", NATIVE_STAFF_READINESS_SNAPSHOT_QUERY, "--json"], { cwd: folder }));
    if (selectedRows.length !== 1 || typeof selectedRows[0].readiness_snapshot !== "string"
      || Buffer.byteLength(selectedRows[0].readiness_snapshot) > 16 * 1024 * 1024 || now() - started > 60_000) fail("read_state_invalid");
    let selected; try { selected = JSON.parse(selectedRows[0].readiness_snapshot); } catch { fail("read_state_invalid"); }
    if (!exact(selected, ["control", "cohort", "bridgeMismatchCount", "controlPlaneStaffIds", "bootstrapReceipts"])) fail("read_state_invalid");
    if (!Array.isArray(selected.cohort) || selected.cohort.length > 1024 || selected.cohort.some(row => row.active !== 0 && row.active !== 1)) fail("cohort_active_invalid");
    const observation = { schemaVersion: 1, accountId: target.accountId, databaseId: target.databaseId,
      observedAt: new Date(started).toISOString(), ...selected, cohort: selected.cohort.map(row => ({ ...row, active: row.active === 1 })) };
    return verifyNativeStaffCutoverReadiness(review, observation, { sourceCommit, now: now() });
  } finally { await unlink(config).catch(() => {}); await rmdir(folder).catch(() => {}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== "--read-only" || args[1] !== "--review" || args[3] !== "--source") throw Error("Use --read-only --review PRIVATE_REVIEW_PACKET --source EXACT_COMMIT");
  try { console.log(JSON.stringify(await readNativeStaffCutoverReadiness({ review: JSON.parse(await readFile(args[2], "utf8")), sourceCommit: args[4] }))); }
  catch { console.error("Native staff cutover readiness refused; no deployment or database mutation performed."); process.exitCode = 1; }
}
