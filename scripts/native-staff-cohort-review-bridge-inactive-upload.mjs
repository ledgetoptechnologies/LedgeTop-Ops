import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, resourcesShape } from "./production-deploy.mjs";
import {
  createNativeStaffCohortReviewBridgeUploadPlan,
  inspectNativeStaffCohortReviewBridgeCandidatePackage,
} from "./native-staff-cohort-review-bridge-upload-plan.mjs";

const WORKER = "ledgetop-ops";
const SCRIPT_PATH = `/workers/scripts/${WORKER}`;
const MODERN_PATH = `/workers/workers/${WORKER}/versions/`;
const UPLOAD_PATH = `${SCRIPT_PATH}/versions?bindings_inherit=strict`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_GET_BODY = 32 * 1024 * 1024;
const MAX_POST_BODY = 2 * 1024 * 1024;
const MAX_MODULE_BYTES = 8 * 1024 * 1024;
const CANDIDATE_VISIBILITY_CODE = 100146;
const VISIBILITY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 3000, 3000, 3000]);
const VISIBILITY_MAX_MS = 15_000;
const RECONCILIATION_KEYS = Object.freeze([
  "created", "deleted", "info", "removable_entries", "renamed", "transfer_pending", "transferred", "updated", "warnings",
]);
const LIFECYCLE_RECONCILIATION_KEYS = Object.freeze(["created", "deleted", "renamed", "transfer_pending", "transferred", "updated", "removable_entries"]);
const USED_UPLOAD_APIS = new WeakSet();
const sha256 = value => createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const STATIC_GET_PATHS = new Set([
  `${SCRIPT_PATH}/settings`,
  `${SCRIPT_PATH}/schedules`,
  `${SCRIPT_PATH}/deployments?per_page=1`,
  `${SCRIPT_PATH}/versions?per_page=1`,
]);
function allowedGetPath(value) {
  if (STATIC_GET_PATHS.has(value)) return true;
  const uuidPath = "[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  return new RegExp(`^${SCRIPT_PATH}/versions/${uuidPath}$`, "u").test(value)
    || new RegExp(`^${MODERN_PATH}${uuidPath}\\?include=modules$`, "u").test(value);
}
export function isAllowedNativeStaffCohortReviewBridgeGetPath(value) {
  return typeof value === "string" && allowedGetPath(value);
}
function validateApi(api) {
  need(isObject(api) && Object.keys(api).sort().join(",") === "get,uploadInactiveVersion"
    && typeof api.get === "function" && typeof api.uploadInactiveVersion === "function",
  "Inactive upload requires the fixed-scope GET and one-version-upload adapter");
}

function parseResponseEnvelope(response, maxBytes, { allowCandidateNotVisible = false } = {}) {
  need(isObject(response) && Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599
    && Buffer.isBuffer(response.bodyBytes) && response.bodyBytes.byteLength <= maxBytes,
  "Provider adapter response is outside the bounded response contract");
  let envelope;
  try { envelope = JSON.parse(response.bodyBytes.toString("utf8")); } catch { throw new Error("Provider response is invalid JSON"); }
  need(isObject(envelope), "Provider response envelope is invalid");
  if (allowCandidateNotVisible && response.status === 404 && envelope.success === false && envelope.result === null
    && Array.isArray(envelope.errors) && envelope.errors.length === 1 && envelope.errors[0]?.code === CANDIDATE_VISIBILITY_CODE) {
    return { candidateNotVisible: true, responseBytes: response.bodyBytes };
  }
  need(response.status >= 200 && response.status < 300 && envelope.success === true
    && envelope.result !== undefined && (envelope.errors == null || Array.isArray(envelope.errors) && envelope.errors.length === 0),
  "Provider returned a failed or incomplete response");
  return { envelope, result: envelope.result, responseBytes: response.bodyBytes };
}

async function getResult(api, endpoint, { candidateRead = false } = {}) {
  need(allowedGetPath(endpoint), "Inactive upload refused an unapproved GET path");
  const response = await api.get(endpoint);
  const parsed = parseResponseEnvelope(response, MAX_GET_BODY, { allowCandidateNotVisible: candidateRead });
  if (parsed.candidateNotVisible) return parsed;
  return parsed.result;
}

function activeDeployment(result) {
  need(isObject(result) && Array.isArray(result.deployments) && result.deployments.length >= 1 && result.deployments.length <= 100,
    "Operations deployment head is missing or unbounded");
  const deployment = result.deployments[0];
  const rows = deployment?.versions;
  need(Array.isArray(rows) && rows.length === 1 && UUID.test(rows[0]?.version_id ?? "") && rows[0].percentage === 100,
    "Operations must have exactly one 100-percent active version before the inactive upload");
  return deployment;
}

async function captureOperationsSnapshot(api) {
  const deploymentsResult = await getResult(api, `${SCRIPT_PATH}/deployments?per_page=1`);
  const deployment = activeDeployment(deploymentsResult);
  const versionsResult = await getResult(api, `${SCRIPT_PATH}/versions?per_page=1`);
  need(isObject(versionsResult) && Array.isArray(versionsResult.items) && versionsResult.items.length >= 1 && versionsResult.items.length <= 100
    && UUID.test(versionsResult.items[0]?.id ?? ""), "Operations version head is missing or unbounded");
  const activeVersionId = deployment.versions[0].version_id;
  const versionId = versionsResult.items[0].id;
  const [version, modern, settings, schedules] = await Promise.all([
    getResult(api, `${SCRIPT_PATH}/versions/${activeVersionId}`),
    getResult(api, `${MODERN_PATH}${activeVersionId}?include=modules`),
    getResult(api, `${SCRIPT_PATH}/settings`),
    getResult(api, `${SCRIPT_PATH}/schedules`),
  ]);
  need(version?.id === activeVersionId && modern?.id === activeVersionId, "Operations active-version reads disagree");
  const [deploymentsAfter, versionsAfter] = await Promise.all([
    getResult(api, `${SCRIPT_PATH}/deployments?per_page=1`),
    getResult(api, `${SCRIPT_PATH}/versions?per_page=1`),
  ]);
  need(same(activeDeployment(deploymentsAfter), deployment)
    && versionsAfter.items?.[0]?.id === versionId,
  "Operations heads changed during the bounded capture");
  return {
    operations: {
      deployment,
      latest: versionId,
      version,
      modern,
      settings,
      schedules,
    },
  };
}

function metadataDigest(metadata) {
  return sha256(canonical(metadata));
}

async function readVerifiedModule(descriptor) {
  need(isObject(descriptor) && typeof descriptor.path === "string" && path.isAbsolute(descriptor.path)
    && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= MAX_MODULE_BYTES
    && SHA256.test(descriptor.sha256 ?? "") && typeof descriptor.contentType === "string",
  "Candidate module descriptor is malformed");
  const target = path.resolve(descriptor.path);
  const before = await lstat(target);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === descriptor.bytes
    && await realpath(target) === target,
  "Candidate module is not the pinned regular file");
  const bytes = await readFile(target);
  const after = await lstat(target);
  need(after.isFile() && !after.isSymbolicLink() && after.nlink === before.nlink && after.size === before.size
    && after.dev === before.dev && after.ino === before.ino && bytes.byteLength === descriptor.bytes
    && sha256(bytes) === descriptor.sha256,
  "Candidate module changed or failed its byte pin before upload");
  return bytes;
}

async function buildMultipart(plan, packageReceipt) {
  need(plan?.metadataDraft?.main_module === "wrapper.js" && !Object.hasOwn(plan.metadataDraft, "migrations")
    && plan.metadataDraft.keep_assets === true && isObject(plan.metadataDraft.assets?.config)
    && Array.isArray(plan.metadataDraft.bindings) && plan.metadataDraft.bindings.length === 145
    && plan.metadataDraft.bindings.every(binding => isObject(binding) && binding.type === "inherit" && !Object.hasOwn(binding, "text")),
  "Inactive upload metadata draft is not the exact retained-Operations profile");
  need(Array.isArray(plan.modules) && plan.modules.length === 4, "Inactive upload requires the exact four-module candidate");
  const expectedNames = ["wrapper.js", "index.js", "__ops_c880_retention_ledger.json", "__ops_release_ledger.json"];
  need(same(plan.modules.map(module => module.name).sort(), expectedNames.slice().sort()), "Candidate module list differs from the reviewed bridge");
  const checked = [];
  for (const descriptor of plan.modules) {
    const bytes = await readVerifiedModule(descriptor);
    checked.push({ descriptor, bytes });
  }
  // Re-run the package inspector after reading bytes so the immutable receipt
  // pin and module inventory are still valid at the immediate pre-upload boundary.
  const rechecked = await inspectNativeStaffCohortReviewBridgeCandidatePackage(path.dirname(checked[0].descriptor.path));
  need(rechecked.receipt.wrapper.sha256 === packageReceipt.wrapper.sha256
    && same(rechecked.modules.map(({ name, bytes, sha256: digest, contentType }) => ({ name, bytes, sha256: digest, contentType })).sort((a, b) => a.name.localeCompare(b.name)),
      checked.map(({ descriptor }) => ({ name: descriptor.name, bytes: descriptor.bytes, sha256: descriptor.sha256, contentType: descriptor.contentType })).sort((a, b) => a.name.localeCompare(b.name))),
  "Candidate package changed after its offline plan was built");

  const form = new FormData();
  form.set("metadata", JSON.stringify(plan.metadataDraft));
  for (const { descriptor, bytes } of checked) {
    form.set(descriptor.name, new Blob([bytes], { type: descriptor.contentType }), descriptor.name);
  }
  return {
    form,
    moduleHashes: checked.map(({ descriptor }) => ({ name: descriptor.name, bytes: descriptor.bytes, sha256: descriptor.sha256, contentType: descriptor.contentType })),
    metadataSha256: metadataDigest(plan.metadataDraft),
  };
}

function safeExportsReconciliation(value) {
  if (!isObject(value)) return { present: false, reviewRequired: true, missingKeys: [...RECONCILIATION_KEYS], unknownKeys: [] };
  const unknownKeys = Object.keys(value).filter(key => !RECONCILIATION_KEYS.includes(key)).sort();
  const missingKeys = RECONCILIATION_KEYS.filter(key => !Object.hasOwn(value, key)).sort();
  const counts = Object.create(null);
  let reviewRequired = unknownKeys.length > 0 || missingKeys.length > 0;
  for (const key of RECONCILIATION_KEYS) {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length > 4096) {
      counts[key] = null;
      reviewRequired = true;
      continue;
    }
    counts[key] = rows.length;
    if (LIFECYCLE_RECONCILIATION_KEYS.includes(key) && rows.length > 0) reviewRequired = true;
  }
  const project = key => {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length > 4096) return [];
    return rows.slice(0, 256).map(row => {
      if (!isObject(row)) { reviewRequired = true; return { malformed: true }; }
      const allowed = new Set(["class", "scenario", "namespace_id", "referencing_scripts"]);
      const unknownFields = Object.keys(row).filter(name => !allowed.has(name)).sort();
      if (unknownFields.length > 0) reviewRequired = true;
      const safe = { unknownFieldNames: unknownFields };
      if (typeof row.class === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(row.class)) safe.class = row.class;
      else { safe.class = null; reviewRequired = true; }
      if (typeof row.scenario === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(row.scenario)) safe.scenario = row.scenario;
      else { safe.scenario = null; reviewRequired = true; }
      if (row.namespace_id !== undefined) {
        if (typeof row.namespace_id === "string" && UUID.test(row.namespace_id)) safe.namespaceIdSha256 = sha256(row.namespace_id);
        else { safe.namespaceIdSha256 = null; reviewRequired = true; }
      }
      if (row.referencing_scripts !== undefined) {
        if (Array.isArray(row.referencing_scripts) && row.referencing_scripts.length <= 100
          && row.referencing_scripts.every(item => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(item))) {
          safe.referencingScriptCount = row.referencing_scripts.length;
        } else { safe.referencingScriptCount = null; reviewRequired = true; }
      }
      return safe;
    });
  };
  const info = project("info"), warnings = project("warnings");
  if ((counts.info ?? 0) > 0 || (counts.warnings ?? 0) > 0 || (counts.removable_entries ?? 0) > 0) reviewRequired = true;
  return { present: true, counts, info, warnings, missingKeys, unknownKeys, reviewRequired };
}

function moduleInventory(modern) {
  const modules = modern?.modules;
  if (!Array.isArray(modules) || modules.length !== 4 || modules.some(row => !isObject(row) || typeof row.name !== "string")
    || new Set(modules.map(row => row.name)).size !== 4) return null;
  return modules;
}

function verifyCandidateReadback({ baseline, candidateId, version, modern, moduleHashes }) {
  const errors = [];
  const oldResources = baseline.operations.version.resources;
  try {
    if (!UUID.test(version?.id ?? "") || version.id !== candidateId) errors.push("candidate_version_id_mismatch");
    if (!same(resourcesShape(version?.resources), resourcesShape(oldResources))) errors.push("legacy_resources_changed");
  } catch { errors.push("legacy_resource_shape_invalid"); }
  if (modern?.main_module !== "wrapper.js") errors.push("candidate_main_module_mismatch");
  for (const key of ["compatibility_date", "compatibility_flags", "exports", "usage_model", "containers", "migration_tag", "env"]) {
    if (Object.hasOwn(baseline.operations.modern, key) !== Object.hasOwn(modern ?? {}, key)
      || Object.hasOwn(baseline.operations.modern, key) && !same(modern[key], baseline.operations.modern[key])) errors.push(`modern_${key}_changed`);
  }
  const oldBindings = baseline.operations.modern.bindings;
  const newBindings = modern?.bindings;
  const bindingProjection = rows => Array.isArray(rows) ? rows.map(row => ({ name: row.name, type: row.type })).sort((a, b) => a.name.localeCompare(b.name)) : null;
  if (!same(bindingProjection(oldBindings), bindingProjection(newBindings))) errors.push("modern_binding_names_types_changed");
  if (!same(modern?.assets?.config, baseline.operations.modern.assets?.config)) errors.push("asset_config_changed");

  const rows = moduleInventory(modern);
  if (!rows) errors.push("candidate_module_inventory_invalid");
  else {
    const byName = new Map(rows.map(row => [row.name, row]));
    for (const expected of moduleHashes) {
      const row = byName.get(expected.name);
      if (!row || row.content_type !== expected.contentType || typeof row.content_base64 !== "string") {
        errors.push(`candidate_module_metadata_mismatch:${expected.name}`);
        continue;
      }
      let bytes;
      try { bytes = Buffer.from(row.content_base64, "base64"); } catch { errors.push(`candidate_module_base64_invalid:${expected.name}`); continue; }
      if (bytes.toString("base64") !== row.content_base64 || bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
        errors.push(`candidate_module_bytes_mismatch:${expected.name}`);
      }
    }
  }
  const oldModern = baseline.operations.modern;
  const ignoredModernKeys = new Set(["id", "main_module", "urls", "source", "modules", "assets", "annotations", "compatibility_date", "compatibility_flags", "exports", "usage_model", "containers", "migration_tag", "env", "bindings"]);
  const changedModernKeys = [...new Set([...Object.keys(oldModern ?? {}), ...Object.keys(modern ?? {})])]
    .filter(key => !ignoredModernKeys.has(key) && !same(oldModern?.[key], modern?.[key])).sort();
  const providerGeneratedModernFields = new Set(["number", "startup_time_ms", "created_on", "author_id", "author_email"]);
  const providerGeneratedModernMetadataFieldNames = changedModernKeys.filter(key => providerGeneratedModernFields.has(key));
  const unknownModernChangedKeys = changedModernKeys.filter(key => !providerGeneratedModernFields.has(key));
  return { verified: errors.length === 0, errors, unknownModernChangedKeys, providerGeneratedModernMetadataFieldNames };
}

async function waitForCandidateVersion(api, candidateId, { pauseImpl = pause, now = () => performance.now() } = {}) {
  const started = now();
  need(Number.isFinite(started), "Candidate visibility clock is invalid");
  const deadline = started + VISIBILITY_MAX_MS;
  for (let attempt = 0; attempt <= VISIBILITY_DELAYS_MS.length; attempt++) {
    const remaining = deadline - now();
    need(remaining > 0, "Candidate visibility wait expired");
    let result;
    try {
      result = await getResult(api, `${SCRIPT_PATH}/versions/${candidateId}`, { candidateRead: true });
    } catch { throw new Error("Candidate metadata read failed; preserve candidate id and reconcile by GET only"); }
    if (!result.candidateNotVisible) return result;
    if (attempt === VISIBILITY_DELAYS_MS.length) throw new Error("Candidate visibility unresolved; preserve candidate id and reconcile by GET only");
    const delay = VISIBILITY_DELAYS_MS[attempt];
    need(now() + delay < deadline, "Candidate visibility deadline expired");
    await pauseImpl(delay);
  }
  throw new Error("Candidate visibility unresolved; preserve candidate id and reconcile by GET only");
}

function safeReceiptBase({ status, baselineId, activePercent, plan, multipart, candidateId = null }) {
  return {
    schemaVersion: 1,
    kind: "operations-cohort-review-inactive-version-receipt",
    workerName: WORKER,
    status,
    providerAccepted: false,
    providerAcceptancePending: true,
    candidateVersionId: candidateId,
    parentVersionId: baselineId,
    activePercent,
    candidateMainModule: "wrapper.js",
    moduleHashes: multipart?.moduleHashes ?? plan?.safeSummary?.candidate?.modules ?? [],
    metadataSha256: multipart?.metadataSha256 ?? null,
    bindingCount: plan?.safeSummary?.baseline?.bindingCount ?? null,
    bindingNamesAndTypesSha256: plan?.safeSummary?.baseline?.bindingNamesAndTypesSha256 ?? null,
    assetsRequestedKept: true,
    actualNamespaceAssetBytesVerified: false,
    migrationsAdded: false,
    activationAttempted: false,
    fullMainDeploymentAttempted: false,
    previewUnavailableDo: true,
  };
}

/**
 * Execute one strictly inherited, non-activating Operations version upload.
 * The caller supplies only fixed-scope OAuth callbacks and durable journal hooks;
 * this module never reads credentials and never performs another POST.
 */
export async function executeNativeStaffCohortReviewBridgeInactiveUpload({
  api,
  candidateDir,
  persistIntent,
  persistReceipt,
  testHooks,
}) {
  validateApi(api);
  need(typeof candidateDir === "string" && path.isAbsolute(candidateDir)
    && typeof persistIntent === "function" && typeof persistReceipt === "function",
  "Inactive upload requires an absolute candidate directory and durable journal callbacks");
  if (testHooks !== undefined) need(isObject(testHooks) && testHooks.protocolTestOnly === true,
    "Inactive upload test hooks require the explicit protocol-test-only marker");
  if (testHooks !== undefined) need(Object.keys(testHooks).every(key => ["protocolTestOnly", "createPlan"].includes(key)),
    "Only the offline planner may be replaced in a protocol-only test");
  const capture = captureOperationsSnapshot;
  const createPlan = testHooks?.createPlan ?? createNativeStaffCohortReviewBridgeUploadPlan;
  const inspect = inspectNativeStaffCohortReviewBridgeCandidatePackage;
  need(typeof capture === "function" && typeof createPlan === "function" && typeof inspect === "function",
    "Inactive upload planner callbacks are invalid");

  const baseline = await capture(api);
  const plan = await createPlan({ baselineSnapshot: baseline, candidateDir });
  const packageReceipt = await inspect(candidateDir);
  need(packageReceipt?.receipt && Array.isArray(packageReceipt.modules), "Offline candidate package verification failed");
  const multipart = await buildMultipart({ metadataDraft: plan.metadataDraft, modules: packageReceipt.modules }, packageReceipt.receipt);
  const preIntent = safeReceiptBase({ status: "prepared", baselineId: baseline.operations.version.id,
    activePercent: baseline.operations.deployment.versions[0].percentage, plan, multipart });
  const intent = {
    schemaVersion: 1,
    phase: "operations-cohort-review-version-upload",
    method: "POST",
    path: UPLOAD_PATH,
    workerName: WORKER,
    parentVersionId: baseline.operations.version.id,
    expectedActiveVersionId: baseline.operations.version.id,
    expectedActivePercent: 100,
    latestVersionId: baseline.operations.latest,
    moduleHashes: multipart.moduleHashes,
    metadataSha256: multipart.metadataSha256,
    bindingCount: preIntent.bindingCount,
    bindingNamesAndTypesSha256: preIntent.bindingNamesAndTypesSha256,
    automaticRetry: false,
    activation: false,
  };

  let dispatch;
  try {
    dispatch = await dispatchInactiveVersionUploadOnce({ api, form: multipart.form, intent, persistIntent,
      preDispatchCheck: async () => {
        try { return same(await capture(api), baseline); } catch { return false; }
      } });
  } catch {
    const receipt = safeReceiptBase({ status: "pre_dispatch_blocked_no_upload", baselineId: baseline.operations.version.id,
      activePercent: baseline.operations.deployment.versions[0].percentage, plan, multipart });
    receipt.postAttempted = false;
    receipt.providerAcceptancePending = false;
    receipt.intentPersistence = "uncertain";
    await persistReceipt(receipt);
    return receipt;
  }
  if (!dispatch.dispatched) {
    const receipt = safeReceiptBase({ status: "baseline_drift_before_dispatch", baselineId: baseline.operations.version.id,
      activePercent: baseline.operations.deployment.versions[0].percentage, plan, multipart });
    receipt.postAttempted = false;
    receipt.providerAcceptancePending = false;
    receipt.intentPersistence = "complete";
    await persistReceipt(receipt);
    return receipt;
  }
  const postResponse = dispatch.response;
  if (dispatch.outcome === "dispatch_uncertain") {
    const receipt = safeReceiptBase({ status: "upload_outcome_uncertain_no_retry", baselineId: baseline.operations.version.id,
      activePercent: baseline.operations.deployment.versions[0].percentage, plan, multipart });
    receipt.postAttempted = true;
    await persistReceipt(receipt);
    return receipt;
  }

  let postEnvelope = null;
  let candidateId = null;
  let postHash = null;
  try {
    need(isObject(postResponse) && Number.isSafeInteger(postResponse.status) && Buffer.isBuffer(postResponse.bodyBytes)
      && postResponse.bodyBytes.byteLength <= MAX_POST_BODY, "Inactive upload response is outside its bounded contract");
    postHash = sha256(postResponse.bodyBytes);
    postEnvelope = JSON.parse(postResponse.bodyBytes.toString("utf8"));
    candidateId = postEnvelope?.result?.id;
    if (!UUID.test(candidateId ?? "")) candidateId = null;
  } catch { /* persist the body digest below when available */ }
  const accepted = postResponse && postResponse.status >= 200 && postResponse.status < 300
    && postEnvelope?.success === true && isObject(postEnvelope.result)
    && (postEnvelope.errors == null || Array.isArray(postEnvelope.errors) && postEnvelope.errors.length === 0);
  const responseReceipt = safeReceiptBase({ status: accepted ? "upload_response_accepted" : "upload_outcome_uncertain_no_retry",
    baselineId: baseline.operations.version.id, activePercent: baseline.operations.deployment.versions[0].percentage,
    plan, multipart, candidateId });
  responseReceipt.providerStatus = Number.isSafeInteger(postResponse?.status) ? postResponse.status : null;
  responseReceipt.postResponseSha256 = postHash;
  responseReceipt.providerAccepted = accepted;
  responseReceipt.providerAcceptancePending = !accepted || !candidateId;
  responseReceipt.postAttempted = true;
  responseReceipt.intentPersistence = "complete";
  if (accepted && !candidateId) responseReceipt.status = "provider_acceptance_id_unresolved_review_required";
  const explicitErrorRows = postEnvelope?.errors;
  const authoritativeRejection = postResponse?.status >= 400 && postResponse.status < 500 && postResponse.status !== 408
    && postEnvelope?.success === false && postEnvelope.result === null && Array.isArray(explicitErrorRows)
    && explicitErrorRows.length > 0 && explicitErrorRows.length <= 32
    && explicitErrorRows.every(row => isObject(row) && (Number.isSafeInteger(row.code)
      || typeof row.code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(row.code)));
  if (!accepted && authoritativeRejection) {
    responseReceipt.status = "explicit_provider_rejection_no_retry";
    responseReceipt.providerAcceptancePending = false;
    responseReceipt.providerErrorCodes = explicitErrorRows.map(row => row.code);
  }
  try { await persistReceipt(responseReceipt); } catch {
    responseReceipt.status = "accepted_response_receipt_persistence_failed";
    responseReceipt.providerAcceptancePending = true;
    return responseReceipt;
  }
  if (!accepted || !candidateId) {
    return responseReceipt;
  }

  let candidateVersion;
  let candidateModern;
  try {
    candidateVersion = await waitForCandidateVersion(api, candidateId);
    candidateModern = await getResult(api, `${MODERN_PATH}${candidateId}?include=modules`);
  } catch {
    const receipt = { ...responseReceipt, status: "provider_accepted_readback_pending", providerAcceptancePending: false,
      inactiveReadbackVerified: false, readbackError: "candidate_readback_unavailable_get_only_reconcile" };
    try { await persistReceipt(receipt); } catch { receipt.finalReceiptPersistenceFailed = true; }
    return receipt;
  }

  const reconciliation = safeExportsReconciliation(postEnvelope.result.exports_reconciliation);
  const readback = verifyCandidateReadback({ baseline, candidateId, version: candidateVersion, modern: candidateModern, moduleHashes: multipart.moduleHashes });
  let activeUnchanged = false, latestCandidate = false, settingsUnchanged = false, schedulesUnchanged = false;
  try {
    const [deployments, versions, settings, schedules] = await Promise.all([
      getResult(api, `${SCRIPT_PATH}/deployments?per_page=1`),
      getResult(api, `${SCRIPT_PATH}/versions?per_page=1`),
      getResult(api, `${SCRIPT_PATH}/settings`),
      getResult(api, `${SCRIPT_PATH}/schedules`),
    ]);
    const deployment = activeDeployment(deployments);
    activeUnchanged = same(deployment, baseline.operations.deployment);
    latestCandidate = versions.items?.[0]?.id === candidateId;
    settingsUnchanged = same(settings, baseline.operations.settings);
    schedulesUnchanged = same(schedules, baseline.operations.schedules);
  } catch { /* the accepted candidate remains recorded for GET-only reconciliation */ }
  const verified = readback.verified && activeUnchanged && latestCandidate && settingsUnchanged && schedulesUnchanged;
  const reviewRequired = !verified || reconciliation.reviewRequired || readback.unknownModernChangedKeys.length > 0;
  const finalReceipt = {
    ...responseReceipt,
    status: reviewRequired ? "provider_accepted_review_required" : "provider_accepted_inactive_verified",
    providerAccepted: true,
    providerAcceptancePending: false,
    inactiveReadbackVerified: verified,
    resourcesPreserved: readback.verified,
    modulesPreserved: readback.verified && readback.errors.every(error => !error.startsWith("candidate_module_")),
    activeDeploymentUnchanged: activeUnchanged,
    latestVersionIsCandidate: latestCandidate,
    settingsUnchanged,
    schedulesUnchanged,
    reviewRequired,
    readbackErrorCodes: readback.errors,
    unknownModernChangedFieldNames: readback.unknownModernChangedKeys,
    providerGeneratedModernMetadataFieldNames: readback.providerGeneratedModernMetadataFieldNames,
    exportsReconciliation: reconciliation,
    activationAttempted: false,
    fullMainDeploymentAttempted: false,
  };
  try { await persistReceipt(finalReceipt); } catch { finalReceipt.finalReceiptPersistenceFailed = true; }
  return finalReceipt;
}

/**
 * Narrow one-shot dispatcher shared with protocol tests. It records the intent
 * first, permits one final GET-only guard, then invokes only the fixed upload callback.
 */
export async function dispatchInactiveVersionUploadOnce({ api, form, intent, persistIntent, preDispatchCheck }) {
  validateApi(api);
  need(typeof persistIntent === "function" && typeof preDispatchCheck === "function" && form instanceof FormData
    && isObject(intent) && intent.path === UPLOAD_PATH && intent.method === "POST" && intent.automaticRetry === false,
  "Inactive upload one-shot dispatch inputs are invalid");
  if (USED_UPLOAD_APIS.has(api)) throw new Error("This provider adapter already attempted its one allowed inactive upload");
  USED_UPLOAD_APIS.add(api);
  try { await persistIntent(deepFreeze(structuredClone(intent))); }
  catch { const error = new Error("Durable intent persistence failed; POST was not invoked"); error.code = "INTENT_PERSIST_FAILED"; throw error; }
  let allowed;
  try { allowed = await preDispatchCheck(); }
  catch { allowed = false; }
  if (allowed !== true) return { dispatched: false, outcome: "baseline_changed_before_post" };
  let response;
  try { response = await api.uploadInactiveVersion(UPLOAD_PATH, form); }
  catch { return { dispatched: true, outcome: "dispatch_uncertain", response: null }; }
  return { dispatched: true, outcome: "response_received", response };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error("This module is an in-memory executor library only; use the reviewed OAuth adapter caller");
}
