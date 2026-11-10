import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ProductionCloudflareProvider, newTemporaryVerifierName, readCandidateVersionWithVisibilityRetry,
  samePinnedRootAssetConfig } from "./production-auto-provider.mjs";
import { createAssetVerificationNonce } from "./production-auto-verify.mjs";
import { PROFILE } from "./production-deploy.mjs";
import { assertProductionAutoPost0226PreservationReceiptFresh,
  loadPinnedProductionAutoPost0226PreservationPolicy,
  validateProductionAutoPost0226PreservationObservation } from "./production-auto-post0226-policy.mjs";
import { POST0226_STAFF_PRESERVATION_CONTRACT } from "./ordinary-frontend-authority-post0226.mjs";
import { ledgerBytes } from "./production-auto-assets.mjs";

const accountId = "a".repeat(32), token = "synthetic-private-token-at-least20";
const parent = "00000000-0000-4000-8000-000000000001", candidate = "00000000-0000-4000-8000-000000000002";
const hash = value => createHash("sha256").update(value).digest("hex");
const ok = result => Response.json({ success: true, errors: [], result });
const assets = { base_path: "/", run_worker_first: ["/api/*"], not_found_handling: "single-page-application" };
const runtime = { compatibility_date: "2026-07-22", compatibility_flags: ["nodejs_compat"], usage_model: "standard", assets: { synthetic: true } };
const { base_path, ...uploadAssetsConfig } = assets;
const profile = { workers: { operations: { name: "ledgetop-ops", runtime, metadata: { usage_model: "standard", assets: { config: uploadAssetsConfig }, exports: { Existing: { type: "worker" } } } } } };
const preservationPolicy = loadPinnedProductionAutoPost0226PreservationPolicy();
const sourceCommit = "b".repeat(40);
function preservationReceipt(now) {
  const baseline = preservationPolicy.baseline;
  const observedAt = new Date(now).toISOString();
  return validateProductionAutoPost0226PreservationObservation(preservationPolicy, { schemaVersion: 1,
    contract: POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit,
    accountId: preservationPolicy.accountId, databaseId: preservationPolicy.databaseId,
    observedAt, ...structuredClone(baseline), schemaSha256: baseline.loginSchemaSha256 },
  { sourceCommit, now });
}

test("root asset config comparison permits only Cloudflare's documented omitted html_handling default", () => {
  const captured = { html_handling: "auto-trailing-slash", not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/health"], base_path: "/" };
  const upload = { not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/health"] };
  assert.equal(samePinnedRootAssetConfig(captured, upload), true);
  assert.equal(samePinnedRootAssetConfig(captured, { ...upload, html_handling: "auto-trailing-slash" }), true);
  for (const changed of [
    { ...upload, html_handling: "drop-trailing-slash" },
    { ...upload, run_worker_first: ["/api/*"] },
    { ...upload, not_found_handling: "none" },
    { ...upload, static_routing: { user_worker: ["/api/*"] } },
    { ...upload, raw_run_worker_first: ["/api/*"] },
    { ...upload, serve_directly: true },
  ]) assert.equal(samePinnedRootAssetConfig(captured, changed), false, JSON.stringify(changed));
  assert.equal(samePinnedRootAssetConfig({ ...captured, html_handling: "none" }, upload), false);
});
function setup(fetchImpl = async () => ok({}), overrides = {}) {
  const intents = [], persisted = [];
  const temporary = new Map();
  const { verifierModuleTamper, ...providerOverrides } = overrides;
  const transport = async (url, init) => {
    const parsed = new URL(url);
    const scriptMatch = parsed.pathname.match(/\/workers\/scripts\/(ops-ui-verify-[a-f0-9]{24})(?:\/versions(?:\/([a-f0-9-]+))?)?$/u);
    const modernMatch = parsed.pathname.match(/\/workers\/workers\/(ops-ui-verify-[a-f0-9]{24})\/versions\/([a-f0-9-]+)$/u);
    if (init.method === "PUT" && scriptMatch?.[1] && !url.includes("/versions")) {
      const form = init.body, metadata = JSON.parse(form.get("metadata"));
      const bytes = Buffer.from(await form.get("index.js").arrayBuffer());
      temporary.set(scriptMatch[1], { bytes, bindings: metadata.bindings });
    }
    if (scriptMatch?.[1] && parsed.pathname.endsWith("/versions") && parsed.search === "?per_page=1") {
      const row = temporary.get(scriptMatch[1]); return row ? ok({ items: [{ id: candidate }] }) : Response.json({ success: false }, { status: 404 });
    }
    if (scriptMatch?.[1] && scriptMatch[2] && !parsed.search) {
      const row = temporary.get(scriptMatch[1]);
      return row ? ok({ id: candidate, resources: { bindings: row.bindings } }) : Response.json({ success: false }, { status: 404 });
    }
    if (modernMatch?.[1] && parsed.search === "?include=modules") {
      const row = temporary.get(modernMatch[1]);
      if (!row) return Response.json({ success: false }, { status: 404 });
      const bytes = verifierModuleTamper ? verifierModuleTamper(Buffer.from(row.bytes)) : row.bytes;
      return ok({ id: candidate, modules: [{ name: "index.js", content_base64: bytes.toString("base64") }] });
    }
    return fetchImpl(url, init);
  };
  const provider = new ProductionCloudflareProvider({ accountId, token, profile, fetchImpl: transport,
    recordIntent: async value => { intents.push(value); }, recordCleanupIntent: async value => { intents.push(value); },
    persistResponse: async value => { persisted.push(value); }, ...providerOverrides });
  return { provider, intents, persisted };
}
async function ownedVerifierFixture(assetFetch, overrides = {}) {
  const { verifierInitialSubdomain = { enabled: false, previews_enabled: true }, ...providerOverrides } = overrides;
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const entry = { path: "/assets/test.js", size: 1, sha256: hash("x"), contentType: "application/javascript" };
  let verifierSubdomain = structuredClone(verifierInitialSubdomain);
  const state = setup(async (url, init) => {
    if (url.includes(".workers.dev")) return assetFetch(url, init);
    if (init.method === "PUT") return ok({ id: candidate });
    if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
    if (init.method === "DELETE") return ok({});
    if (url.endsWith("/subdomain") && init.method === "POST") {
      verifierSubdomain = { enabled: true, previews_enabled: false }; return ok(verifierSubdomain);
    }
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok(verifierSubdomain);
    return Response.json({ success: false }, { status: 404 });
  }, providerOverrides);
  await state.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry],
    nonceHash: nonce.nonceHash, versionId: parent });
  return { ...state, nonce, name, entry };
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
    assert.equal(form.get("__ops_release_ledger.json").type, "application/octet-stream");
    assert.deepEqual(Buffer.from(await form.get("index.js").arrayBuffer()), input.modules.js.bytes);
    assert.deepEqual(Buffer.from(await form.get("index.js.map").arrayBuffer()), input.modules.sourceMap.bytes);
    const ledgerPart = Buffer.from(await form.get("__ops_release_ledger.json").arrayBuffer());
    assert.deepEqual(ledgerPart, ledgerBytes(input.ledger), "the Data module keeps its canonical JSON bytes");
    assert.equal(JSON.parse(ledgerPart.toString("utf8")).minimumRetentionHours, 48);
    assert.equal(intents[0].modules["__ops_release_ledger.json"], hash(ledgerPart));
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

test('Ops Sync backend version upload inherits its exact bindings and carries no asset or ledger payload', async () => {
  const spec = PROFILE.workers['ops-sync'], js = Buffer.from('export default {fetch(){return new Response("sync")}};');
  const map = Buffer.from(JSON.stringify({ version: 3, file: 'index.js', sources: ['src/index.ts'],
    sourcesContent: ['export default {};'], mappings: '', names: [] }));
  const state = { latest: parent, deployment: { versions: [{ version_id: parent, percentage: 100 }] },
    version: { id: parent, resources: { script_runtime: structuredClone(spec.runtime),
      bindings: structuredClone(spec.bindings), script: { handlers: ['fetch'], named_handlers: [] } } },
    modern: { id: parent, assets: null } };
  let metadata, formKeys;
  const { provider, intents, persisted } = setup(async (url, init) => {
    assert.match(url, /\/workers\/scripts\/ledgetop-ops-sync\/versions\?bindings_inherit=strict$/u);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    formKeys = [...init.body.keys()]; metadata = JSON.parse(init.body.get('metadata'));
    assert.deepEqual(Buffer.from(await init.body.get('index.js').arrayBuffer()), js);
    assert.deepEqual(Buffer.from(await init.body.get('index.js.map').arrayBuffer()), map);
    return ok({ id: candidate });
  }, { profile: PROFILE });
  const result = await provider.createInactiveBackendVersion({ workerName: 'ledgetop-ops-sync', state,
    modules: { js: { bytes: js, sha256: hash(js) }, sourceMap: { bytes: map, sha256: hash(map) } },
    annotations: { 'workers/message': 'synthetic sync release', 'workers/tag': 'sync-test' } });
  assert.equal(result.id, candidate);
  assert.deepEqual(formKeys, ['metadata', 'index.js', 'index.js.map']);
  assert.equal(metadata.assets, undefined); assert.equal(metadata.migrations, undefined); assert.deepEqual(metadata.keep_bindings, []);
  assert.deepEqual(metadata.bindings, spec.bindings.map(row => ({ name: row.name, type: 'inherit' })));
  assert.deepEqual(intents[0].modules, { 'index.js': hash(js), 'index.js.map': hash(map) });
  assert.equal(intents[0].phase, 'sync-version-upload'); assert.equal(persisted.length, 1);
});

test("stage and activate use only exact deployments JSON and durable intent, no settings or routes", async () => {
  const bodies = []; const { provider, intents } = setup(async (url, init) => {
    assert.equal(intents.length, bodies.length + 1); assert(url.endsWith("/workers/scripts/ledgetop-ops/deployments"));
    bodies.push(JSON.parse(init.body)); return ok({ id: candidate });
  });
  await provider.stageVersion({ workerName: "ledgetop-ops", parentVersionId: parent, candidateVersionId: candidate, message: "stage" });
  await provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent, candidateVersionId: candidate, message: "activate" });
  assert.deepEqual(bodies[0], { strategy: "percentage", versions: [{ version_id: parent, percentage: 100 }, { version_id: candidate, percentage: 0 }], annotations: { "workers/message": "stage" } });
  assert.deepEqual(bodies[1].versions, [{ version_id: candidate, percentage: 100 }]);
  assert.deepEqual(intents.map(({ parentVersionId, candidateVersionId }) => ({ parentVersionId, candidateVersionId })),
    [{ parentVersionId: parent, candidateVersionId: candidate }, { parentVersionId: parent, candidateVersionId: candidate }]);
});

test("expired preservation receipt holds the durable mutation intent before provider dispatch", async () => {
  let now = Date.now(), calls = 0;
  const receipt = preservationReceipt(now), events = [];
  const state = setup(async () => { calls++; events.push("dispatch"); return ok({ id: candidate }); }, {
    recordIntent: async value => { events.push("journal-intent"); },
    beforeDispatch: async () => {
      events.push("final-fence");
      now += 60_001; // model slow CI/control-state fences after the coordinator read
      assertProductionAutoPost0226PreservationReceiptFresh(preservationPolicy, receipt, { sourceCommit, now });
    },
  });
  await assert.rejects(state.provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent,
    candidateVersionId: candidate, message: "expired preservation receipt" }));
  assert.deepEqual(events, ["journal-intent", "final-fence"]);
  assert.equal(calls, 0);
  assert.equal(state.persisted.length, 1);
  assert.equal(state.persisted[0].incomplete, true);
  assert.equal(state.persisted[0].status, null);
});

test("fresh preservation receipt permits dispatch after durable intent and final fence", async () => {
  const now = Date.now(), receipt = preservationReceipt(now), events = [];
  const state = setup(async () => { events.push("dispatch"); return ok({ id: candidate }); }, {
    recordIntent: async () => { events.push("journal-intent"); },
    beforeDispatch: async () => {
      events.push("final-fence");
      assertProductionAutoPost0226PreservationReceiptFresh(preservationPolicy, receipt, { sourceCommit, now });
    },
  });
  await state.provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent,
    candidateVersionId: candidate, message: "fresh preservation receipt" });
  assert.deepEqual(events, ["journal-intent", "final-fence", "dispatch"]);
  assert.equal(events.filter(event => event === "journal-intent").length, 1);
  assert.equal(state.persisted.length, 1);
  assert.equal(state.persisted[0].incomplete, undefined);
});

test("intent refusal sends nothing; provider errors and malformed bodies persist privately, never retry or echo", async () => {
  let calls = 0;
  const blocked = setup(async () => { calls++; return ok({}); }, { recordIntent: async () => { throw Error(token); } }).provider;
  await assert.rejects(blocked.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent, candidateVersionId: candidate, message: "x" }), error => !error.message.includes(token)); assert.equal(calls, 0);
  for (const response of [Response.json({ success: false, errors: [{ code: 10021, message: token }] }, { status: 400 }), new Response(token, { status: 200 }), new Response(null, { status: 302, headers: { Location: "https://evil.test" } })]) {
    const state = setup(async (_url, init) => { calls++; assert.equal(init.redirect, "error"); return response; }); const before = calls;
    await assert.rejects(state.provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent, candidateVersionId: candidate, message: "x" }), error => !error.message.includes(token));
    assert.equal(calls, before + 1); assert.equal(state.persisted.length, 1);
  }
});

test("metadata GET supports capture suffixes but refuses arbitrary paths and bounded response violations", async () => {
  const calls = []; const state = setup(async (url, init) => { calls.push(url); assert.equal(init.method, "GET"); return ok({ deployments: [] }); });
  const { provider } = state;
  await provider.readDeployment("ledgetop-ops");
  await provider.get(`/workers/workers/ledgetop-clients/versions/${parent}?include=modules`);
  for (const path of ["/zones", "/workers/scripts/arbitrary/settings", "/workers/scripts/ledgetop-ops/../secrets", "/workers/scripts/ledgetop-ops/settings?token=secret"]) await assert.rejects(provider.get(path));
  assert.equal(calls.length, 2); assert.equal(state.persisted.length, 0, "read-only configuration bodies stay out of the mutation journal");
  const oversized = setup(async () => new Response("x", { headers: { "Content-Length": String(33 * 1024 * 1024) } }));
  await assert.rejects(oversized.provider.readDeployment("ledgetop-ops")); assert.equal(oversized.persisted.length, 0);
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

test("exact owned verifier cleanup bypasses stale production age only after readback and durable intent", async () => {
  let now = 0; const dispatch = [], cleanup = [];
  const state = await ownedVerifierFixture(async () => new Response("x"), {
    beforeDispatch: async value => { dispatch.push(value); if (now > 60_000) throw Error("stale production receipt"); },
    recordCleanupIntent: async value => { cleanup.push(value); },
  });
  assert.equal(dispatch.length, 2, "create and enable retain their normal dispatch fences");
  now = 60_001;
  await state.provider.removeVerifier(state.name);
  assert.equal(cleanup.length, 1);
  assert.match(cleanup[0].sourceSHA256, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ method: cleanup[0].method, path: cleanup[0].path, phase: cleanup[0].phase,
    name: cleanup[0].name, workerName: cleanup[0].workerName,
    automaticRetry: cleanup[0].automaticRetry }, { method: "DELETE", path: `/workers/scripts/${state.name}`,
    phase: "temporary-verifier-delete", name: state.name, workerName: "ledgetop-ops", automaticRetry: false });
  assert.equal(dispatch.length, 2, "cleanup skips the expired production receipt fence only");
  await assert.rejects(state.provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent,
    candidateVersionId: candidate, message: "x" }), /no_retry/u);
  assert.equal(dispatch.length, 3, "application mutations still run the stale dispatch gate");
});

test("temporary verifier cleanup refuses a changed latest module before writing cleanup intent", async () => {
  let tamper = false; const cleanup = [];
  const state = await ownedVerifierFixture(async () => new Response("x"), {
    verifierModuleTamper: bytes => tamper ? Buffer.from("different module") : bytes,
    recordCleanupIntent: async value => { cleanup.push(value); },
  });
  tamper = true;
  await assert.rejects(state.provider.removeVerifier(state.name), /no_retry/u);
  assert.equal(cleanup.length, 0);
  assert.equal(state.intents.some(value => value.phase === "temporary-verifier-delete"), false);
});

test("owned verifier retries only unmarked platform HTML visibility responses and keeps request identity", async () => {
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const entry = { path: "/assets/test.js", size: 1, sha256: hash("x"), contentType: "application/javascript" };
  const responses = [
    ...[404, 500, 502, 503, 504].map(status => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("temporary platform html")); },
      cancel() { canceledBodies++; },
    }), { status, headers: { "Content-Type": "text/html; charset=utf-8" } })),
    new Response("x", { headers: { "Content-Type": "application/javascript" } }),
  ];
  const calls = [], pauses = []; let canceledBodies = 0;
  const state = setup(async (url, init) => {
    if (!url.includes(".workers.dev")) {
      if (init.method === "PUT") return ok({ id: candidate });
      if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
      if (url.endsWith("/subdomain") && init.method === "POST") return ok({ enabled: true, previews_enabled: false });
      if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
      if (url.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
      return Response.json({ success: false }, { status: 404 });
    }
    calls.push({ url, init });
    return responses.shift();
  }, { verifierPause: async ms => { pauses.push(ms); } });
  await state.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry],
    nonceHash: nonce.nonceHash, versionId: parent });
  const mutationIntentsBeforeReads = state.intents.filter(row => row.method !== "GET").length;
  const response = await state.provider.fetchVerifierAsset({ name, path: entry.path, method: "HEAD", bearer: nonce.bearer });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 6);
  assert.equal(pauses.length, 5);
  assert.equal(canceledBodies, 5, "each retry response body is canceled before the next request");
  for (const { url, init } of calls) {
    assert.equal(url, `https://${name}.synthetic.workers.dev${entry.path}`);
    assert.equal(init.method, "HEAD"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, `Bearer ${nonce.bearer}`);
    assert.equal(init.headers["Accept-Encoding"], "identity");
  }
  assert.equal(state.intents.filter(row => row.method !== "GET").length, mutationIntentsBeforeReads,
    "visibility retries use only the owned verifier GET/HEAD endpoint and add no provider mutation intents");
});

test("HEAD 200 followed by GET 404 and GET 200 retries only the exact owned verifier asset", async () => {
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const entry = { path: `/_ui/operations/${hash("x").slice(0, 40)}/index.html`, size: 1, sha256: hash("x"), contentType: "text/html" };
  const responses = [
    new Response(null, { status: 200, headers: { "Content-Type": "text/html" } }),
    new Response("platform not ready", { status: 404, headers: { "Content-Type": "text/html" } }),
    new Response("x", { status: 200, headers: { "Content-Type": "text/html" } }),
  ];
  const calls = [], pauses = [];
  const state = setup(async (url, init) => {
    if (url.includes(".workers.dev")) { calls.push({ url, method: init.method }); return responses.shift(); }
    if (init.method === "PUT") return ok({ id: candidate });
    if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
    if (url.endsWith("/subdomain") && init.method === "POST") return ok({ enabled: true, previews_enabled: false });
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
    return Response.json({ success: false }, { status: 404 });
  }, { verifierPause: async ms => { pauses.push(ms); } });
  await state.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry],
    nonceHash: nonce.nonceHash, versionId: parent });
  assert.equal((await state.provider.fetchVerifierAsset({ name, path: entry.path, method: "HEAD", bearer: nonce.bearer })).status, 200);
  assert.equal((await state.provider.fetchVerifierAsset({ name, path: entry.path, method: "GET", bearer: nonce.bearer })).status, 200);
  assert.deepEqual(calls.map(row => row.method), ["HEAD", "GET", "GET"]);
  assert(calls.every(row => row.url === `https://${name}.synthetic.workers.dev${entry.path}`));
  assert.equal(pauses.length, 1);
});

test("verifier readiness never retries marked or non-HTML GET 404s, marked application failures, or unlisted statuses", async () => {
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const entry = { path: "/assets/test.js", size: 1, sha256: hash("x"), contentType: "application/javascript" };
  const cases = [
    ["GET", 404, { "Content-Type": "text/html", "X-Ops-Static-Check": "missing" }],
    ["GET", 404, { "Content-Type": "application/json" }],
    ["HEAD", 502, { "Content-Type": "text/html", "X-Ops-Static-Check": "upstream" }],
    ["GET", 503, { "Content-Type": "text/html", "X-Ops-Upstream-Status": "503" }],
    ["HEAD", 502, { "Content-Type": "application/json" }],
    ["HEAD", 501, { "Content-Type": "text/html" }],
  ];
  let assetCalls = 0;
  const state = setup(async (url, init) => {
    if (url.includes(".workers.dev")) { assetCalls++; return new Response("case", { status: cases[assetCalls - 1]?.[1], headers: cases[assetCalls - 1]?.[2] }); }
    if (init.method === "PUT") return ok({ id: candidate });
    if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
    if (url.endsWith("/subdomain") && init.method === "POST") return ok({ enabled: true, previews_enabled: false });
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
    return Response.json({ success: false }, { status: 404 });
  }, { verifierPause: async () => assert.fail("ineligible verifier response must not retry") });
  await state.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry],
    nonceHash: nonce.nonceHash, versionId: parent });
  for (const [method, status] of cases) {
    const response = await state.provider.fetchVerifierAsset({ name, path: entry.path, method, bearer: nonce.bearer });
    assert.equal(response.status, status);
  }
  assert.equal(assetCalls, cases.length);
});

test("owned verifier readiness retries do not retry provider mutations or transport failures", async () => {
  let mutationCalls = 0;
  const mutation = setup(async () => { mutationCalls++; return new Response("platform", { status: 503, headers: { "Content-Type": "text/html" } }); });
  await assert.rejects(mutation.provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent,
    candidateVersionId: candidate, message: "x" }), /no_retry/u);
  assert.equal(mutationCalls, 1); assert.equal(mutation.intents.length, 1);
  let transportCalls = 0;
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName();
  const entry = { path: "/assets/test.js", size: 1, sha256: hash("x"), contentType: "application/javascript" };
  const transport = setup(async (url, init) => {
    if (url.includes(".workers.dev")) { transportCalls++; throw Error("transport failure"); }
    if (init.method === "PUT") return ok({ id: candidate });
    if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
    if (url.endsWith("/subdomain") && init.method === "POST") return ok({ enabled: true, previews_enabled: false });
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
    return Response.json({ success: false }, { status: 404 });
  });
  await transport.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry],
    nonceHash: nonce.nonceHash, versionId: parent });
  await assert.rejects(transport.provider.fetchVerifierAsset({ name, path: entry.path, bearer: nonce.bearer }), /no_retry/u);
  assert.equal(transportCalls, 1, "transport errors are never retried");
  let hungCalls = 0;
  const hung = setup(async (url, init) => {
    if (url.includes(".workers.dev")) { hungCalls++; return new Promise(() => {}); }
    if (init.method === "PUT") return ok({ id: candidate });
    if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
    if (url.endsWith("/subdomain") && init.method === "POST") return ok({ enabled: true, previews_enabled: false });
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
    return Response.json({ success: false }, { status: 404 });
  });
  await hung.provider.createVerifier({ name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry],
    nonceHash: nonce.nonceHash, versionId: parent });
  const controller = new AbortController();
  const read = hung.provider.fetchVerifierAsset({ name, path: entry.path, bearer: nonce.bearer, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(read, /no_retry/u);
  assert.equal(hungCalls, 1, "caller cancellation stops readiness even when an injected fetch ignores AbortSignal");
});

test("owned verifier retry-body cancellation is covered by the readiness deadline", { timeout: 20_000 }, async () => {
  let calls = 0, cancellationStarted = false, requestSignal;
  const state = await ownedVerifierFixture(async (_url, init) => {
    calls++;
    requestSignal = init.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("platform html")); },
      cancel() { cancellationStarted = true; return new Promise(() => {}); },
    }), { status: 404, headers: { "Content-Type": "text/html" } });
  });
  await assert.rejects(state.provider.fetchVerifierAsset({ name: state.name, path: state.entry.path,
    method: "GET", bearer: state.nonce.bearer }), /no_retry/u);
  assert.equal(cancellationStarted, true, "retry response disposal was attempted");
  assert.equal(calls, 1, "a stalled cancellation cannot extend readiness or start another read");
  assert.equal(requestSignal.aborted, true, "deadline abort also releases the underlying response transport");
});

test("caller abort stops while discarding a retry response body", async () => {
  let calls = 0, cancellationStarted, requestSignal;
  const state = await ownedVerifierFixture(async (_url, init) => {
    calls++;
    requestSignal = init.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("platform html")); },
      cancel() { cancellationStarted(); return new Promise(() => {}); },
    }), { status: 404, headers: { "Content-Type": "text/html" } });
  });
  const controller = new AbortController();
  const cancellation = new Promise(resolve => { cancellationStarted = resolve; });
  const read = state.provider.fetchVerifierAsset({ name: state.name, path: state.entry.path,
    method: "GET", bearer: state.nonce.bearer, signal: controller.signal });
  await cancellation;
  controller.abort();
  await assert.rejects(read, /no_retry/u);
  assert.equal(calls, 1, "caller abort during disposal cannot start another read");
  assert.equal(requestSignal.aborted, true, "caller abort also releases the underlying response transport");
});

test("existing or mismatched temporary Worker is never enabled, and ambiguous creation can be cleaned once", async () => {
  const nonce = createAssetVerificationNonce(), name = newTemporaryVerifierName(), args = { name, workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [{ path: "/assets/x.js", size: 1, sha256: hash("x"), contentType: "application/javascript" }], nonceHash: nonce.nonceHash, versionId: parent };
  let calls = 0; const exists = setup(async () => { calls++; return ok({}); }).provider;
  await assert.rejects(exists.createVerifier(args)); assert.equal(calls, 1); await assert.rejects(exists.removeVerifier(name));
  const methods = []; const state = setup(async (url, init) => {
    methods.push(init.method);
    if (init.method === "PUT") throw Error(token);
    if (url.endsWith("/settings")) return ok({ bindings: [{ name: "SOURCE_ASSETS", type: "service", service: "ledgetop-ops", environment: "production" }] });
    if (url.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic" });
    if (url.endsWith("/subdomain")) return ok({ enabled: false, previews_enabled: false });
    if (init.method === "DELETE") return ok({});
    return Response.json({ success: false }, { status: 404 });
  });
  await assert.rejects(state.provider.createVerifier(args)); await state.provider.removeVerifier(name); assert.equal(await state.provider.verifierAbsent(name), true);
  assert.deepEqual(methods, ["GET", "PUT", "GET", "GET", "GET", "DELETE", "GET"]);
});

test("uncooperative transport expires with one intent and one private uncertainty receipt, no retry", async () => {
  let calls = 0; const state = setup(async () => { calls++; return new Promise(() => {}); }, { timeoutMs: 5 });
  await assert.rejects(state.provider.activateCandidate({ workerName: "ledgetop-ops", parentVersionId: parent, candidateVersionId: candidate, message: "x" }), /no_retry/u);
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
  assert.equal(state.persisted[0].path, state.intents[0].path);
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

test("asset session and bucket run the final dispatch fence after their durable intents", async () => {
  const events = [], assetHash = "b".repeat(32), bytes = Buffer.from("x"), contentHash = hash(bytes);
  const state = setup(async (_url, init) => {
    events.push("dispatch");
    if (init.body instanceof FormData) return Response.json({ success: true, errors: [], result: { jwt: "synthetic.complete.jwt" } }, { status: 201 });
    return ok({ jwt: "synthetic.upload.jwt", buckets: [[assetHash]] });
  }, {
    recordIntent: async value => { events.push(`journal-${value.phase}`); },
    beforeDispatch: async value => { events.push(`dispatch-fence-${value.phase}`); },
  });
  await state.provider.uploadAssets({ workerName: "ledgetop-ops",
    manifest: { "/index.html": { hash: assetHash, size: bytes.length } },
    resolvePayload: async () => ({ bytes, sha256: contentHash, mime: "text/html" }),
    recordIntent: async value => { events.push(`coordinator-${value.phase}`); },
  });
  assert.deepEqual(events, [
    "coordinator-asset-session", "journal-asset-session", "dispatch-fence-asset-session", "dispatch",
    "coordinator-asset-bucket", "journal-asset-bucket", "dispatch-fence-asset-bucket", "dispatch",
  ]);
});

test("committed production metadata root omission accepts only the documented HTML default and exact routing controls", async () => {
  const spec = PROFILE.workers.operations;
  assert.equal(Object.hasOwn(spec.metadata.assets.config, "base_path"), false);
  const input = creation(); input.state.version.resources.script_runtime = structuredClone(spec.runtime);
  input.state.modern.assets.config = { ...structuredClone(spec.metadata.assets.config), base_path: "/",
    html_handling: "auto-trailing-slash" };
  let calls = 0;
  const state = setup(async (_url, init) => { calls++; const metadata = JSON.parse(init.body.get("metadata"));
    assert.deepEqual(metadata.assets.config, spec.metadata.assets.config); return ok({ id: candidate }); }, { profile: PROFILE });
  await state.provider.createInactiveVersion(input); assert.equal(calls, 1);
  for (const bad of [undefined, "/other", "", "html", "routing", "raw-routing", "serve-directly"]) {
    const changed = structuredClone(input); changed.modules = input.modules;
    if (bad === undefined) delete changed.state.modern.assets.config.base_path;
    else if (bad === "/other" || bad === "") changed.state.modern.assets.config.base_path = bad;
    else if (bad === "html") changed.state.modern.assets.config.html_handling = "none";
    else if (bad === "routing") changed.state.modern.assets.config.run_worker_first = ["/health"];
    else if (bad === "raw-routing") changed.state.modern.assets.config.raw_run_worker_first = ["/api/*"];
    else changed.state.modern.assets.config.serve_directly = true;
    await assert.rejects(state.provider.createInactiveVersion(changed));
  }
  const extra = structuredClone(input); extra.modules = input.modules; extra.state.modern.assets.config.unreviewed = true;
  await assert.rejects(state.provider.createInactiveVersion(extra)); assert.equal(calls, 1);
});

test("candidate legacy metadata waits only for exact 404/100146 and remains a bounded GET", async () => {
  const calls = [], pauses = []; let now = 0;
  const state = setup(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({ success: false, result: null, errors: [{ code: 100146, message: "synthetic transient" }] }, { status: 404 });
    return ok({ id: candidate, resources: { synthetic: true } });
  });
  const result = await readCandidateVersionWithVisibilityRetry(state.provider, "ledgetop-ops", candidate, {
    pause: async ms => { pauses.push(ms); now += ms; }, now: () => now,
  });
  assert.equal(result.id, candidate);
  assert.equal(calls.length, 2);
  assert.deepEqual(pauses, [250]);
  assert(calls.every(({ url, init }) => url.endsWith(`/workers/scripts/ledgetop-ops/versions/${candidate}`)
    && init.method === "GET" && init.redirect === "error"));
  assert.equal(state.intents.length, 0, "readiness retries cannot create write intents");

  for (const bad of [
    { status: 404, body: { success: false, result: null, errors: [{ code: 100147 }] } },
    { status: 404, body: { success: false, result: null, errors: [{ code: 100146 }, { code: 100146 }] } },
    { status: 404, body: { success: false, result: {}, errors: [{ code: 100146 }] } },
    { status: 500, body: { success: false, result: null, errors: [{ code: 100146 }] } },
  ]) {
    let reads = 0;
    const refused = setup(async () => { reads++; return Response.json(bad.body, { status: bad.status }); });
    await assert.rejects(readCandidateVersionWithVisibilityRetry(refused.provider, "ledgetop-ops", candidate,
      { pause: async () => assert.fail("unexpected retry") }));
    assert.equal(reads, 1);
  }
});

test("candidate visibility exhaustion is eight exact GETs with bounded backoff and no write", async () => {
  let reads = 0, now = 0; const pauses = [];
  const provider = { async getCandidateVersion() {
    reads++;
    throw Object.assign(new Error("synthetic exact transient"), { code: "candidate_version_not_visible" });
  } };
  await assert.rejects(readCandidateVersionWithVisibilityRetry(provider, "ledgetop-ops-sync", candidate, {
    pause: async ms => { pauses.push(ms); now += ms; }, now: () => now,
  }), /unresolved/u);
  assert.equal(reads, 8);
  assert.deepEqual(pauses, [250, 500, 1000, 2000, 3000, 3000, 3000]);
});

test("slow candidate GET is stopped by the absolute deadline and receives an abort signal", async () => {
  let reads = 0, attemptSignal;
  const provider = { async getCandidateVersion(_workerName, _versionId, { signal }) {
    reads++; attemptSignal = signal;
    return new Promise(() => {});
  } };
  await assert.rejects(readCandidateVersionWithVisibilityRetry(provider, "ledgetop-ops", candidate, { timeoutMs: 5 }), /read_failed/u);
  assert.equal(reads, 1, "a slow GET is never retried as if it were the transient 404");
  assert.equal(attemptSignal.aborted, true, "the per-attempt abort reaches the in-flight metadata reader");
});

test("candidate GET deadline abort propagates through the provider transport without a write", async () => {
  let transportAborted = false, transportCalls = 0;
  const state = setup((_url, init) => new Promise((_, reject) => {
    transportCalls++;
    init.signal.addEventListener("abort", () => {
      transportAborted = init.signal.aborted;
      reject(Object.assign(new Error("synthetic transport abort"), { name: "AbortError" }));
    }, { once: true });
  }), { timeoutMs: 1000 });
  await assert.rejects(readCandidateVersionWithVisibilityRetry(state.provider, "ledgetop-ops", candidate, { timeoutMs: 5 }), /read_failed/u);
  assert.equal(transportCalls, 1);
  assert.equal(transportAborted, true, "outer visibility deadline abort reaches the actual fetch signal");
  assert.equal(state.intents.length, 0, "candidate visibility reads cannot create mutation intents");
  assert.equal(state.persisted.length, 0, "GET cancellation stores no response or credential material");
});
