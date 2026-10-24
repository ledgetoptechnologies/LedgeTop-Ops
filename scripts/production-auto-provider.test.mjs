import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ProductionCloudflareProvider, newTemporaryVerifierName } from "./production-auto-provider.mjs";
import { createAssetVerificationNonce } from "./production-auto-verify.mjs";
import { PROFILE } from "./production-deploy.mjs";

const accountId = "a".repeat(32), token = "synthetic-private-token-at-least20";
const parent = "00000000-0000-4000-8000-000000000001", candidate = "00000000-0000-4000-8000-000000000002";
const hash = value => createHash("sha256").update(value).digest("hex");
const ok = result => Response.json({ success: true, errors: [], result });
const assets = { base_path: "/", run_worker_first: ["/api/*"], not_found_handling: "single-page-application" };
const runtime = { compatibility_date: "2026-07-22", compatibility_flags: ["nodejs_compat"], usage_model: "standard", assets: { synthetic: true } };
const { base_path, ...uploadAssetsConfig } = assets;
const profile = { workers: { operations: { name: "ledgetop-ops", runtime, metadata: { usage_model: "standard", assets: { config: uploadAssetsConfig }, exports: { Existing: { type: "worker" } } } } } };
function setup(fetchImpl = async () => ok({}), overrides = {}) {
  const intents = [], persisted = [];
  const provider = new ProductionCloudflareProvider({ accountId, token, profile, fetchImpl,
    recordIntent: async value => { intents.push(value); }, persistResponse: async value => { persisted.push(value); }, ...overrides });
  return { provider, intents, persisted };
}
function creation() {
  const js = Buffer.from("export default {fetch(){return new Response('ok')}};\n//# sourceMappingURL=index.js.map\n");
  const map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: ["original.ts"], sourcesContent: ["export default {}"], mappings: "" }));
  return { workerName: "ledgetop-ops", state: { latest: parent, deployment: { versions: [{ version_id: parent, percentage: 100 }] },
    version: { id: parent, resources: { script_runtime: structuredClone(runtime), bindings: [{ name: "CURRENT", type: "plain_text", text: "private-sentinel" }, { name: "OLD_SECRET", type: "secret_text" }, { name: "ASSETS", type: "assets" }] } },
    modern: { id: parent, assets: { config: structuredClone(assets) } } },
  modules: { js: { bytes: js, sha256: hash(js) }, sourceMap: { bytes: map, sha256: hash(map) } },
  ledger: { schemaVersion: 1, workerName: "ledgetop-ops", accountId, sourceCommit: "b".repeat(40), parentVersionId: parent,
    observedAt: "2026-10-23T00:00:00.000Z", minimumRetentionHours: 48, automaticPruning: false,
    assets: [{ path: "/index.html", size: 1, sha256: hash("x"), mime: "text/html", providerHash: hash("x").slice(0, 32) }] },
  assetCompletionToken: "synthetic.complete.jwt", annotations: { "workers/message": "Reviewed test", "workers/tag": "test-release" } };
}

test("inactive multipart preserves approved metadata and every binding, genuine map and unreferenced ledger", async () => {
  const input = creation(), before = structuredClone(input); let calls = 0;
  const { provider, intents, persisted } = setup(async (url, init) => {
    calls++; assert.equal(intents.length, 1); assert.match(url, /\/workers\/scripts\/ledgetop-ops\/versions\?bindings_inherit=strict$/u);
    assert.equal(init.redirect, "error"); assert.equal(init.method, "POST");
    const form = init.body; assert.deepEqual([...form.keys()], ["metadata", "index.js", "index.js.map", "__ops_release_ledger.json"]);
    const metadata = JSON.parse(form.get("metadata"));
    assert.deepEqual(metadata.bindings, [{ name: "CURRENT", type: "inherit" }, { name: "OLD_SECRET", type: "inherit" }, { name: "ASSETS", type: "assets" }]);
    assert.deepEqual(metadata.keep_bindings, []); assert.equal(metadata.keep_assets, undefined);
    assert.equal(metadata.assets.jwt, input.assetCompletionToken); assert.deepEqual(metadata.assets.config, uploadAssetsConfig);
    assert.deepEqual(intents[0].hashes, []); assert.equal(intents[0].phase, "worker-version-upload");
    assert.deepEqual(metadata.exports, profile.workers.operations.metadata.exports);
    assert(!JSON.stringify(metadata).includes("private-sentinel")); assert(!JSON.stringify(intents).includes(input.assetCompletionToken));
    assert.equal(form.get("index.js").type, "application/javascript+module");
    assert.equal(form.get("index.js.map").type, "application/source-map");
    assert.equal(form.get("__ops_release_ledger.json").type, "application/json");
    assert.deepEqual(Buffer.from(await form.get("index.js").arrayBuffer()), input.modules.js.bytes);
    assert.deepEqual(Buffer.from(await form.get("index.js.map").arrayBuffer()), input.modules.sourceMap.bytes);
    assert.equal(JSON.parse(await form.get("__ops_release_ledger.json").text()).minimumRetentionHours, 48);
    return ok({ id: candidate });
  });
  assert.equal((await provider.createInactiveVersion(input)).id, candidate); assert.equal(calls, 1); assert.equal(persisted[0].status, 200);
  assert.deepEqual(structuredClone(input), before); assert(!JSON.stringify(provider).includes(token));
});

test("wrong inheritance head/runtime/map/hash/ledger and production target are refused before send", async () => {
  for (const mutate of [v => { v.workerName = "ledgetop-ops-staging"; }, v => { v.state.latest = candidate; },
    v => { v.state.version.resources.script_runtime.unknown = true; }, v => { v.modules.js.sha256 = "0".repeat(64); },
    v => { v.ledger.parentVersionId = candidate; }, v => { v.assetCompletionToken = "private malformed token"; },
    v => { v.state.version.resources.bindings.push({ name: "CURRENT", type: "secret_text" }); }]) {
    let calls = 0; const { provider } = setup(async () => { calls++; return ok({}); }); const input = creation(); mutate(input);
    await assert.rejects(provider.createInactiveVersion(input), /refused_or_uncertain/u); assert.equal(calls, 0);
  }
});

test("stage and activate use only exact deployments JSON and durable intent, no settings or routes", async () => {
  const bodies = []; const { provider, intents } = setup(async (url, init) => {
    assert.equal(intents.length, bodies.length + 1); assert(url.endsWith("/workers/scripts/ledgetop-ops/deployments"));
    bodies.push(JSON.parse(init.body)); return ok({ id: candidate });
  });
  await provider.stageVersion({ workerName: "ledgetop-ops", parentVersionId: parent, candidateVersionId: candidate, message: "stage" });
  await provider.activateCandidate({ workerName: "ledgetop-ops", candidateVersionId: candidate, message: "activate" });
  assert.deepEqual(bodies[0], { strategy: "percentage", versions: [{ version_id: parent, percentage: 100 }, { version_id: candidate, percentage: 0 }], annotations: { "workers/message": "stage" } });
  assert.deepEqual(bodies[1].versions, [{ version_id: candidate, percentage: 100 }]);
});

test("intent refusal sends nothing; provider errors and malformed bodies persist privately, never retry or echo", async () => {
  let calls = 0;
  const blocked = setup(async () => { calls++; return ok({}); }, { recordIntent: async () => { throw Error(token); } }).provider;
  await assert.rejects(blocked.activateCandidate({ workerName: "ledgetop-ops", candidateVersionId: candidate, message: "x" }), error => !error.message.includes(token)); assert.equal(calls, 0);
  for (const response of [Response.json({ success: false, errors: [{ code: 10021, message: token }] }, { status: 400 }), new Response(token, { status: 200 }), new Response(null, { status: 302, headers: { Location: "https://evil.test" } })]) {
    const state = setup(async (_url, init) => { calls++; assert.equal(init.redirect, "error"); return response; }); const before = calls;
    await assert.rejects(state.provider.activateCandidate({ workerName: "ledgetop-ops", candidateVersionId: candidate, message: "x" }), error => !error.message.includes(token));
    assert.equal(calls, before + 1); assert.equal(state.persisted.length, 1);
  }
});

test("metadata GET supports capture suffixes but refuses arbitrary paths and bounded response violations", async () => {
  const calls = []; const { provider } = setup(async (url, init) => { calls.push(url); assert.equal(init.method, "GET"); return ok({ deployments: [] }); });
  await provider.readDeployment("ledgetop-ops");
  await provider.get(`/workers/workers/ledgetop-clients/versions/${parent}?include=modules`);
  for (const path of ["/zones", "/workers/scripts/arbitrary/settings", "/workers/scripts/ledgetop-ops/../secrets", "/workers/scripts/ledgetop-ops/settings?token=secret"]) await assert.rejects(provider.get(path));
  assert.equal(calls.length, 2);
  const oversized = setup(async () => new Response("x", { headers: { "Content-Length": String(33 * 1024 * 1024) } }));
  await assert.rejects(oversized.provider.readDeployment("ledgetop-ops")); assert.equal(oversized.persisted.length, 1);
});

test("temporary verifier creation, exact service readback, temporary-only enable, fetch and delete404", async () => {
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName(), events = []; let metadata;
  const entry = { path: "/assets/test.js", size: 1, sha256: hash("x"), contentType: "application/javascript" };
  const state = setup(async (url, init) => {
    events.push({ url, method: init.method });
    if (url.includes(".workers.dev")) { assert.equal(init.headers.Authorization, "Bearer " + nonce.bearer); assert.equal(init.headers["Accept-Encoding"], "identity"); return new Response("x"); }
    if (init.method === "PUT") { metadata = JSON.parse(init.body.get("metadata")); return ok({ id: candidate }); }
    if (url.endsWith("/settings")) return ok({ bindings: metadata.bindings });
    if (url.endsWith("/subdomain") && init.method === "POST") { assert.deepEqual(JSON.parse(init.body), { enabled: true, previews_enabled: false }); return ok({ enabled: true, previews_enabled: false }); }
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
    if (init.method === "DELETE") return ok({});
    return Response.json({ success: false }, { status: 404 });
  });
  const result = await state.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry], nonceHash: nonce.nonceHash, versionId: parent });
  assert.equal(result.origin, `https://${name}.synthetic.workers.dev`);
  assert.deepEqual(metadata.bindings, [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }]);
  assert.equal(await (await state.provider.fetchVerifierAsset({ name, path: entry.path, bearer: nonce.bearer })).text(), "x");
  await assert.rejects(state.provider.fetchVerifierAsset({ name, path: "/api/session", bearer: nonce.bearer }));
  await state.provider.removeVerifier(name); assert.equal(await state.provider.verifierAbsent(name), true);
  await assert.rejects(state.provider.removeVerifier(name)); assert.equal(events.filter(e => e.method === "DELETE").length, 1);
  await assert.rejects(state.provider.removeVerifier("ledgetop-ops"));
});

test("existing or mismatched temporary Worker is never enabled, and ambiguous creation can be cleaned once", async () => {
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName(), args = { name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [{ path: "/assets/x.js", size: 1, sha256: hash("x"), contentType: "application/javascript" }], nonceHash: nonce.nonceHash, versionId: parent };
  let calls = 0; const exists = setup(async () => { calls++; return ok({}); }).provider;
  await assert.rejects(exists.createVerifier(args)); assert.equal(calls, 1); await assert.rejects(exists.removeVerifier(name));
  const methods = []; const state = setup(async (_url, init) => { methods.push(init.method); if (init.method === "PUT") throw Error(token); if (init.method === "DELETE") return ok({}); return Response.json({ success: false }, { status: 404 }); });
  await assert.rejects(state.provider.createVerifier(args)); await state.provider.removeVerifier(name); assert.equal(await state.provider.verifierAbsent(name), true);
  assert.deepEqual(methods, ["GET", "PUT", "DELETE", "GET"]);
});

test("uncooperative transport expires with one intent and one private uncertainty receipt, no retry", async () => {
  let calls = 0; const state = setup(async () => { calls++; return new Promise(() => {}); }, { timeoutMs: 5 });
  await assert.rejects(state.provider.activateCandidate({ workerName: "ledgetop-ops", candidateVersionId: candidate, message: "x" }), /no_retry/u);
  assert.equal(calls, 1); assert.equal(state.intents.length, 1); assert.equal(state.persisted.length, 1); assert.equal(state.persisted[0].incomplete, true);
});

test("direct asset upload delegates the real protocol and privately persists completion responses", async () => {
  const state = setup(async (url, init) => {
    assert(url.endsWith("/workers/scripts/ledgetop-ops/assets-upload-session"));
    assert.equal(state.intents.length, 1); assert.equal(init.method, "POST");
    return ok({ jwt: "synthetic.complete.jwt", buckets: [] });
  });
  const result = await state.provider.uploadAssets({ workerName: "ledgetop-ops",
    manifest: { "/index.html": { hash: "b".repeat(32), size: 1 } }, recordIntent: async () => {}, resolvePayload: async () => { throw Error("must not resolve reused assets"); } });
  assert.equal(result.completionToken, "synthetic.complete.jwt"); assert.equal(state.persisted.length, 1);
  assert.equal(state.persisted[0].requestId, state.intents[0].requestId);
  assert(!JSON.stringify(state.intents).includes("synthetic.complete.jwt"));
});

test("asset upload requires both the coordinator fence and durable provider intent before POST", async () => {
  const events = []; let calls = 0;
  const state = setup(async () => { calls++; events.push("post"); return ok({ jwt: "synthetic.complete.jwt", buckets: [] }); },
    { recordIntent: async () => { events.push("durable"); } });
  const options = { workerName: "ledgetop-ops", manifest: { "/index.html": { hash: "b".repeat(32), size: 1 } },
    resolvePayload: async () => { throw Error(); }, recordIntent: async value => { assert.equal(value.phase, "asset-session"); events.push("fence"); } };
  await state.provider.uploadAssets(options); assert.deepEqual(events, ["fence", "durable", "post"]);
  const before = calls;
  await assert.rejects(state.provider.uploadAssets({ ...options, recordIntent: async () => { throw Error("private-sentinel"); } }));
  assert.equal(calls, before);
  assert.throws(() => state.provider.uploadAssets({ ...options, recordIntent: undefined }));
});

test("committed production metadata root omission is accepted only with explicit observed root base", async () => {
  const spec = PROFILE.workers.operations;
  assert.equal(Object.hasOwn(spec.metadata.assets.config, "base_path"), false);
  const input = creation(); input.state.version.resources.script_runtime = structuredClone(spec.runtime);
  input.state.modern.assets.config = { ...structuredClone(spec.metadata.assets.config), base_path: "/" };
  let calls = 0;
  const state = setup(async (_url, init) => { calls++; const metadata = JSON.parse(init.body.get("metadata"));
    assert.deepEqual(metadata.assets.config, spec.metadata.assets.config); return ok({ id: candidate }); }, { profile: PROFILE });
  await state.provider.createInactiveVersion(input); assert.equal(calls, 1);
  for (const bad of [undefined, "/other", ""]) {
    const changed = structuredClone(input); changed.modules = input.modules;
    if (bad === undefined) delete changed.state.modern.assets.config.base_path;
    else changed.state.modern.assets.config.base_path = bad;
    await assert.rejects(state.provider.createInactiveVersion(changed));
  }
  const extra = structuredClone(input); extra.modules = input.modules; extra.state.modern.assets.config.unreviewed = true;
  await assert.rejects(state.provider.createInactiveVersion(extra)); assert.equal(calls, 1);
});
