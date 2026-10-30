import test from "node:test";
import assert from "node:assert/strict";
import { dispatchInactiveVersionUploadOnce, isAllowedNativeStaffCohortReviewBridgeGetPath } from "./native-staff-cohort-review-bridge-inactive-upload.mjs";

const uploadPath = "/workers/scripts/ledgetop-ops/versions?bindings_inherit=strict";
const intent = Object.freeze({ method: "POST", path: uploadPath, automaticRetry: false });
function api(upload) { return { get: async () => { throw new Error("unused"); }, uploadInactiveVersion: upload }; }
function form() { return new FormData(); }

test("writes durable intent before final guard and the single fixed POST", async () => {
  const order = [];
  const response = { status: 200, bodyBytes: Buffer.from('{"success":true,"result":{"id":"c5b4b633-99ac-4e90-a19a-4004d160ad4b"}}') };
  const result = await dispatchInactiveVersionUploadOnce({
    api: api(async (path, sent) => { order.push("post"); assert.equal(path, uploadPath); assert.ok(sent instanceof FormData); return response; }),
    form: form(), intent,
    persistIntent: async value => { order.push("intent"); assert.equal(value.path, uploadPath); },
    preDispatchCheck: async () => { order.push("guard"); return true; },
  });
  assert.deepEqual(order, ["intent", "guard", "post"]);
  assert.deepEqual(result, { dispatched: true, outcome: "response_received", response });
});

test("intent persistence failure prevents the guard and POST", async () => {
  let posts = 0;
  await assert.rejects(dispatchInactiveVersionUploadOnce({ api: api(async () => { posts++; }), form: form(), intent,
    persistIntent: async () => { throw new Error("disk full"); }, preDispatchCheck: async () => true }));
  assert.equal(posts, 0);
});

test("a failed final baseline guard prevents POST", async () => {
  let posts = 0;
  const result = await dispatchInactiveVersionUploadOnce({ api: api(async () => { posts++; }), form: form(), intent,
    persistIntent: async () => {}, preDispatchCheck: async () => false });
  assert.deepEqual(result, { dispatched: false, outcome: "baseline_changed_before_post" });
  assert.equal(posts, 0);
});

test("a lost POST response is uncertain and never retried", async () => {
  let posts = 0;
  const result = await dispatchInactiveVersionUploadOnce({ api: api(async () => { posts++; throw new Error("transport reset"); }), form: form(), intent,
    persistIntent: async () => {}, preDispatchCheck: async () => true });
  assert.deepEqual(result, { dispatched: true, outcome: "dispatch_uncertain", response: null });
  assert.equal(posts, 1);
});

test("rejects a broader API surface before persisting intent", async () => {
  let intents = 0;
  await assert.rejects(dispatchInactiveVersionUploadOnce({ api: { ...api(async () => {}), delete: async () => {} }, form: form(), intent,
    persistIntent: async () => { intents++; }, preDispatchCheck: async () => true }));
  assert.equal(intents, 0);
});

test("allowlists exact version detail and modern module GET paths only", () => {
  assert.equal(isAllowedNativeStaffCohortReviewBridgeGetPath(`/workers/scripts/ledgetop-ops/versions/${"0b1ab5a8-9db0-42ab-b718-8569fae2382e"}`), true);
  assert.equal(isAllowedNativeStaffCohortReviewBridgeGetPath(`/workers/workers/ledgetop-ops/versions/${"0b1ab5a8-9db0-42ab-b718-8569fae2382e"}?include=modules`), true);
  assert.equal(isAllowedNativeStaffCohortReviewBridgeGetPath("/workers/scripts/ledgetop-ops/versions/not-a-uuid"), false);
  assert.equal(isAllowedNativeStaffCohortReviewBridgeGetPath(`/workers/scripts/ledgetop-ops/versions/${"0b1ab5a8-9db0-42ab-b718-8569fae2382e"}/bindings`), false);
  assert.equal(isAllowedNativeStaffCohortReviewBridgeGetPath(`/workers/workers/ledgetop-ops/versions/${"0b1ab5a8-9db0-42ab-b718-8569fae2382e"}?include=modules&env=production`), false);
});
import { executeNativeStaffCohortReviewBridgeInactiveUpload } from "./native-staff-cohort-review-bridge-inactive-upload.mjs";

const candidateDir = process.env.OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR;
const activeId = "0b1ab5a8-9db0-42ab-b718-8569fae2382e";
const candidateId = "c5b4b633-99ac-4e90-a19a-4004d160ad4b";
const emptyReconciliation = Object.fromEntries(["created", "deleted", "info", "removable_entries", "renamed", "transfer_pending", "transferred", "updated", "warnings"].map(key => [key, []]));

function composedFixture({ postMode = "accepted", failResponseReceipt = false } = {}) {
  const bindings = Array.from({ length: 145 }, (_, index) => ({ name: `fixture-binding-${String(index).padStart(3, "0")}`, type: "inherit" }));
  const deployment = { id: "fixture-deployment", versions: [{ version_id: activeId, percentage: 100 }] };
  const resources = { script: { handlers: [], named_handlers: [] }, script_runtime: { compatibility_date: "2026-10-29", compatibility_flags: [] }, bindings };
  const settings = { compatibility_date: "2026-10-29", compatibility_flags: [], annotations: {} };
  const schedules = { schedules: [{ cron: "0 0 * * *" }] };
  const assetConfig = { html_handling: "auto-trailing-slash", base_path: "/" };
  const modern = { id: activeId, main_module: "index.js", compatibility_date: settings.compatibility_date, compatibility_flags: [], exports: [], usage_model: "bundled", containers: [], migration_tag: null, env: {}, bindings,
    assets: { config: assetConfig }, modules: ["index.js", "__ops_c880_retention_ledger.json", "__ops_release_ledger.json"].map(name => ({ name, content_type: name === "index.js" ? "application/javascript+module" : "text/plain", content_base64: "" })) };
  const baselineVersion = { id: activeId, resources };
  const baseline = { operations: { deployment, latest: activeId, version: baselineVersion, modern, settings, schedules } };
  const metadataDraft = { main_module: "wrapper.js", compatibility_date: settings.compatibility_date, compatibility_flags: [], bindings, keep_assets: true, assets: { config: assetConfig }, annotations: {} };
  const plan = { metadataDraft, safeSummary: { baseline: { bindingCount: bindings.length, bindingNamesAndTypesSha256: "a".repeat(64) }, candidate: { modules: [] } } };
  const state = { latest: activeId, postCount: 0, intentCount: 0, receipts: [], paths: [], postForm: null };
  const api = {
    async get(path) {
      state.paths.push(path);
      let result;
      if (path.endsWith("/deployments?per_page=1")) result = { deployments: [deployment] };
      else if (path.endsWith("/versions?per_page=1")) result = { items: [{ id: state.latest }] };
      else if (path.endsWith("/settings")) result = settings;
      else if (path.endsWith("/schedules")) result = schedules;
      else if (path === `/workers/scripts/ledgetop-ops/versions/${activeId}`) result = baselineVersion;
      else if (path === `/workers/workers/ledgetop-ops/versions/${activeId}?include=modules`) result = modern;
      else if (path === `/workers/scripts/ledgetop-ops/versions/${candidateId}`) result = { id: candidateId, resources };
      else if (path === `/workers/workers/ledgetop-ops/versions/${candidateId}?include=modules`) {
        const modules = [];
        for (const [name, value] of state.postForm.entries()) {
          if (name === "metadata") continue;
          modules.push({ name, content_type: value.type, content_base64: Buffer.from(await value.arrayBuffer()).toString("base64") });
        }
        result = { ...modern, id: candidateId, main_module: "wrapper.js", modules, created_on: "2026-10-30T00:00:00Z", author_id: "fixture", startup_time_ms: 7, number: 42 };
      } else throw new Error(`unexpected GET ${path}`);
      return { status: 200, bodyBytes: Buffer.from(JSON.stringify({ success: true, result, errors: [] })) };
    },
    async uploadInactiveVersion(path, form) {
      assert.equal(path, uploadPath);
      state.postCount++;
      state.postForm = form;
      if (postMode === "timeout") throw new Error("fixture transport timeout");
      if (postMode === "reject") return { status: 400, bodyBytes: Buffer.from(JSON.stringify({ success: false, result: null, errors: [{ code: 10021, message: "must not persist" }] })) };
      if (postMode === "http408") return { status: 408, bodyBytes: Buffer.from(JSON.stringify({ success: false, result: null, errors: [{ code: 10021 }] })) };
      if (postMode === "html400") return { status: 400, bodyBytes: Buffer.from("<html>proxy error</html>") };
      state.latest = candidateId;
      return { status: 200, bodyBytes: Buffer.from(JSON.stringify({ success: true, result: { id: candidateId, exports_reconciliation: emptyReconciliation }, errors: [] })) };
    },
  };
  let receiptWrites = 0;
  const persistIntent = async value => { state.intentCount++; state.intent = value; };
  const persistReceipt = async value => {
    receiptWrites++;
    if (failResponseReceipt && receiptWrites === 1) throw new Error("simulated journal error");
    state.receipts.push(structuredClone(value));
  };
  const run = () => executeNativeStaffCohortReviewBridgeInactiveUpload({ api, candidateDir,
    persistIntent, persistReceipt,
    testHooks: { protocolTestOnly: true, createPlan: async ({ baselineSnapshot }) => { assert.equal(baselineSnapshot.operations.version.id, activeId); return plan; } },
  });
  return { api, run, state };
}

test("composed fake API exercises allowlisted version GETs and exact typed multipart readback", { skip: !candidateDir && "set OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR to the pinned candidate package" }, async () => {
  const fixture = composedFixture();
  const receipt = await fixture.run();
  assert.equal(receipt.status, "provider_accepted_inactive_verified");
  assert.equal(fixture.state.intentCount, 1);
  assert.equal(fixture.state.postCount, 1);
  assert.deepEqual(fixture.state.intent.moduleHashes.map(row => row.name).sort(), ["wrapper.js", "index.js", "__ops_c880_retention_ledger.json", "__ops_release_ledger.json"].sort());
  assert.equal(fixture.state.postForm.get("__ops_c880_retention_ledger.json").type, "text/plain");
  assert.equal(fixture.state.postForm.get("__ops_release_ledger.json").type, "text/plain");
  assert.equal(fixture.state.postForm.get("index.js").type, "application/javascript+module");
  assert.equal(fixture.state.postForm.get("wrapper.js").type, "application/javascript+module");
  assert.ok(fixture.state.paths.includes(`/workers/scripts/ledgetop-ops/versions/${activeId}`));
  assert.ok(fixture.state.paths.includes(`/workers/scripts/ledgetop-ops/versions/${candidateId}`));
  assert.equal(receipt.activeDeploymentUnchanged, true);
  assert.equal(receipt.latestVersionIsCandidate, true);
  assert.equal(receipt.providerGeneratedModernMetadataFieldNames.join(","), "author_id,created_on,number,startup_time_ms");
  assert.equal(receipt.actualNamespaceAssetBytesVerified, false);
  assert.equal(receipt.assetsRequestedKept, true);
});

test("composed fake API treats provider 4xx as explicit rejection and never retries", { skip: !candidateDir && "set OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR to the pinned candidate package" }, async () => {
  const fixture = composedFixture({ postMode: "reject" });
  const receipt = await fixture.run();
  assert.equal(fixture.state.postCount, 1);
  assert.equal(receipt.status, "explicit_provider_rejection_no_retry");
  assert.equal(receipt.providerAcceptancePending, false);
  assert.deepEqual(receipt.providerErrorCodes, [10021]);
  assert.equal(JSON.stringify(receipt).includes("must not persist"), false);
});

test("composed fake API reports uncertain timeout without retry", { skip: !candidateDir && "set OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR to the pinned candidate package" }, async () => {
  const fixture = composedFixture({ postMode: "timeout" });
  const receipt = await fixture.run();
  assert.equal(fixture.state.postCount, 1);
  assert.equal(receipt.status, "upload_outcome_uncertain_no_retry");
  assert.equal(receipt.providerAcceptancePending, true);
});

test("composed fake API keeps HTTP 408 uncertain despite an error envelope", { skip: !candidateDir && "set OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR to the pinned candidate package" }, async () => {
  const fixture = composedFixture({ postMode: "http408" });
  const receipt = await fixture.run();
  assert.equal(fixture.state.postCount, 1);
  assert.equal(receipt.status, "upload_outcome_uncertain_no_retry");
  assert.equal(receipt.providerAcceptancePending, true);
  assert.equal(Object.hasOwn(receipt, "providerErrorCodes"), false);
});

test("composed fake API keeps malformed HTTP 400 body uncertain", { skip: !candidateDir && "set OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR to the pinned candidate package" }, async () => {
  const fixture = composedFixture({ postMode: "html400" });
  const receipt = await fixture.run();
  assert.equal(fixture.state.postCount, 1);
  assert.equal(receipt.status, "upload_outcome_uncertain_no_retry");
  assert.equal(receipt.providerAcceptancePending, true);
  assert.equal(Object.hasOwn(receipt, "providerErrorCodes"), false);
});

test("composed fake API returns accepted candidate ID if receipt journaling fails", { skip: !candidateDir && "set OPS_COHORT_BRIDGE_TEST_CANDIDATE_DIR to the pinned candidate package" }, async () => {
  const fixture = composedFixture({ failResponseReceipt: true });
  const receipt = await fixture.run();
  assert.equal(fixture.state.postCount, 1);
  assert.equal(receipt.candidateVersionId, candidateId);
  assert.equal(receipt.status, "accepted_response_receipt_persistence_failed");
  assert.equal(receipt.providerAcceptancePending, true);
});
