import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN as origin,
  CLIENT_PORTAL_PRINCIPAL_OBSERVATION_TARGET as target,
  ClientPortalPrincipalObservationError,
  checkClientPortalObservedDistinctPrincipalDenial,
  observeClientPortalDistinctPrincipals,
} from "./staging-client-portal-principal-observation.mjs";
import { compilePortalByteFixture } from "./staging-portal-byte-fixture.mjs";

const intentId = "10000000-0000-4000-8000-000000000001";
const opaqueToken = "ab".repeat(32);
const link = `${origin}/portal/operations-recipient-enrollment/${intentId}#${opaqueToken}`;
const csrf = suffix => `123456.${suffix.repeat(64)}`;
const inspect = { intentId, revision: 1, state: "issued", target: {
  targetId: "20000000-0000-4000-8000-000000000002", targetRevision: 2,
  clientRecordId: "synthetic-client", displayLabel: "Synthetic staging client",
}, expiresAt: "2099-01-01T00:00:00.000Z" };
const acceptanceRunId = "30000000-0000-4000-8000-000000000003";
const acceptanceConfig = {
  origin,
  expectedHome: { authorityId: "40000000-0000-4000-8000-000000000004",
    workspaceId: "37fa87e6-f283-4a29-a2d7-f33629fbd0b7", ownershipEpoch: 1, grantRevision: 1,
    serviceIds: ["drone-service"] },
  expectedDeliveryLabel: "Selected Deliverables",
  manifest: compilePortalByteFixture(acceptanceRunId),
  actions: ["preview", "download"],
};
const denialInput = { kind: "file", handle: "ond1_private_selected_file", action: "download" };

function snapshot(overrides = {}) {
  return { schemaVersion: 1, target: { ...target }, deployment: {
    deploymentId: "deployment-one", versions: [{ versionId: "version-one", percentage: 100 }],
  }, configMarker: "native-enrollment-key-v1", ...overrides };
}

function request(url, method, frame, headers = {}, body = null) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { url: () => url, method: () => method, frame: () => frame,
    headerValue: async name => normalized[name.toLowerCase()] ?? null,
    postDataBuffer: () => body === null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) };
}

function response(url, method, frame, value, options = {}) {
  const bytes = options.bytes ?? Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const headers = { "content-type": "application/json", "content-length": String(bytes.byteLength),
    "cache-control": "no-store", "cloudflare-cdn-cache-control": "no-store",
    ...options.responseHeaders };
  const requestBody = options.requestValue ?? (method === "POST" ? { intentId, opaqueToken } : null);
  const req = request(url, method, frame, { "x-operations-enrollment-request": "1", "sec-fetch-site": "same-origin",
    ...(method === "POST" ? { "content-type": "application/json" } : {}), ...options.requestHeaders }, requestBody);
  return { url: () => url, request: () => req, status: () => options.status ?? 200,
    headerValue: async name => headers[name.toLowerCase()] ?? null, body: async () => bytes };
}

function apiResponse(url, status) {
  const bytes = Buffer.from(JSON.stringify({ error: "unavailable" }));
  return { url: () => url, status: () => status, statusText: () => status === 403 ? "Forbidden" : "Not Found",
    headers: () => ({ "content-type": "application/json", "content-length": String(bytes.byteLength),
      "cache-control": "no-store" }), body: async () => bytes, dispose: async () => {} };
}

function browser(csrfToken, options = {}) {
  const frame = {}, listeners = new Set(), waiters = [], calls = [], apiCalls = [];
  const apiRequest = {
    async get(url, requestOptions) {
      apiCalls.push({ url, requestOptions });
      if (typeof options.apiHandler === "function") return options.apiHandler(url, requestOptions, apiCalls.length);
      return apiResponse(url, new URL(url).pathname.endsWith("/home") ? 403 : 404);
    },
    async head(url, requestOptions) { apiCalls.push({ url, requestOptions }); return apiResponse(url, 404); },
  };
  const context = { request: apiRequest }; let activeContext = context;
  let currentUrl = `${origin}/portal`;
  const page = {
    context: () => activeContext, mainFrame: () => frame, isClosed: () => false, url: () => currentUrl,
    on: (event, listener) => { if (event === "request") listeners.add(listener); },
    off: (event, listener) => { if (event === "request") listeners.delete(listener); },
    waitForResponse(predicate, { timeout }) { return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: value => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => reject(new Error("mock response timeout")), timeout);
      waiters.push(waiter);
    }); },
    async goto(url) {
      calls.push(url); currentUrl = url.split("#")[0];
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      const observedCsrf = options.csrfTokens?.[calls.length - 1] ?? csrfToken;
      const sessionUrl = `${origin}/api/client/operations/recipient-enrollment/session`;
      const inspectUrl = `${origin}/api/client/operations/recipient-enrollment/inspect`;
      const redeemUrl = `${origin}/api/client/operations/recipient-enrollment/redeem`;
      const session = response(sessionUrl, "GET", frame, options.sessionValue ?? { csrfToken: observedCsrf }, options.sessionOptions);
      const reviewed = response(inspectUrl, "POST", frame, options.inspectValue ?? inspect, {
        ...options.inspectOptions,
        requestHeaders: { "x-csrf-token": observedCsrf, ...options.inspectOptions?.requestHeaders },
      });
      const emitted = [session, reviewed];
      for (const item of emitted) {
        for (const listener of listeners) listener(item.request());
        for (const waiter of waiters) if (await waiter.predicate(item)) waiter.resolve(item);
      }
      if (options.redeem) {
        const redeem = request(redeemUrl, "POST", frame, { "x-operations-enrollment-request": "1", "sec-fetch-site": "same-origin" });
        for (const listener of listeners) listener(redeem);
      }
      return null;
    },
  };
  return { page, context, calls, listeners, apiCalls, driftContext: value => { activeContext = value; },
    emitRedeem: () => {
      const emitted = request(`${origin}/api/client/operations/recipient-enrollment/redeem`, "POST", frame);
      for (const listener of listeners) listener(emitted);
    } };
}

function fixture(first = browser(csrf("a")), second = browser(csrf("b")), snapshots = [snapshot(), snapshot()]) {
  const phases = [];
  return { first, second, phases, dependencies: { enrolled: first, distinct: second,
    readDeploymentSnapshot: async phase => { phases.push(phase); return structuredClone(snapshots[phases.length - 1]); } } };
}

test("passively observes normal enrollment UI in two contexts and returns only redacted proof", async () => {
  assert.equal(target.accountId, "846c924bf17bf4f3dd15c97a4c5d1d51");
  const f = fixture();
  const proof = await observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, f.dependencies);
  assert.equal(proof.status, "passed");
  assert.deepEqual(proof.observations, { sessionStatuses: [200, 200], inspectStatuses: [200, 200],
    fragmentScrubbed: true, pageRedeemObserved: false });
  assert.deepEqual(proof.principalBindings, { serverAuthenticated: true, sameBucket: true, distinct: true,
    valuesExcluded: true });
  assert.deepEqual(proof.deployment, { version: "version-one", snapshotStable: true, singleVersion: true,
    atOneHundredPercent: true });
  assert.deepEqual(f.phases, ["before", "after"]);
  assert.deepEqual(f.first.calls, [link]); assert.deepEqual(f.second.calls, [link]);
  const encoded = JSON.stringify(proof);
  for (const secret of [opaqueToken, csrf("a"), csrf("b"), intentId, "deployment-one", "native-enrollment-key-v1"])
    assert.equal(encoded.includes(secret), false);
  assert.equal(f.first.listeners.size, 0); assert.equal(f.second.listeners.size, 0);
});

test("rejects same-principal and bucket-mismatched observations without disclosing proof values", async () => {
  for (const [expected, first, second] of [
    ["principal_observation_same_principal", browser(csrf("c")), browser(csrf("c"))],
    ["principal_observation_bucket_mismatch", browser(csrf("d")), browser(`123457.${"e".repeat(64)}`)],
  ]) {
    const f = fixture(first, second);
    await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, f.dependencies), error =>
      error instanceof ClientPortalPrincipalObservationError && error.code === expected
      && !error.message.includes(opaqueToken) && !error.message.includes("123456") && !error.message.includes("123457"));
  }
});

test("requires one sampled 100-percent deployment and detects every snapshot marker drift", async () => {
  const omittedMarker = snapshot(); delete omittedMarker.configMarker;
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(undefined, undefined, [omittedMarker]).dependencies), /principal_observation_deployment_invalid/);
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(undefined, undefined, [snapshot({ configMarker: "" })]).dependencies),
    /principal_observation_deployment_invalid/);
  const mixed = snapshot(); mixed.deployment.versions.push({ versionId: "version-two", percentage: 1 });
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, fixture(undefined, undefined, [mixed]).dependencies),
    /principal_observation_deployment_not_single_version/);
  for (const changed of [
    snapshot({ deployment: { deploymentId: "deployment-two", versions: [{ versionId: "version-one", percentage: 100 }] } }),
    snapshot({ deployment: { deploymentId: "deployment-one", versions: [{ versionId: "version-two", percentage: 100 }] } }),
    snapshot({ configMarker: "native-enrollment-key-v2" }),
  ]) await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(undefined, undefined, [snapshot(), changed]).dependencies), /principal_observation_deployment_drift/);
  const partial = snapshot(); partial.deployment.versions[0].percentage = 99;
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(undefined, undefined, [partial]).dependencies), /principal_observation_deployment_not_single_version/);
  const wrongSchema = snapshot(); wrongSchema.schemaVersion = 2;
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(undefined, undefined, [wrongSchema]).dependencies), /principal_observation_deployment_invalid/);
  const wrongTarget = snapshot(); wrongTarget.target.workerName = "another-worker";
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(undefined, undefined, [wrongTarget]).dependencies), /principal_observation_deployment_target_invalid/);
});

test("rejects wrong hosts, userinfo, query strings, and malformed private links before observation", async () => {
  for (const value of [
    link.replace("client-staging", "client"),
    link.replace("https://", "https://user:secret@"),
    link.replace("#", "?leak=1#"),
    `${origin}/portal/operations-recipient-enrollment/not-a-uuid#${opaqueToken}`,
    `${origin}/portal/operations-recipient-enrollment/${intentId}#short`,
  ]) {
    const f = fixture();
    await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: value }, f.dependencies),
      /principal_observation_link_invalid/);
    assert.equal(f.phases.length, 0); assert.equal(f.first.calls.length, 0); assert.equal(f.second.calls.length, 0);
  }
});

test("fails if normal UI emits any redeem request", async () => {
  const f = fixture(browser(csrf("a"), { redeem: true }), browser(csrf("b")));
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, f.dependencies),
    /principal_observation_redeem_observed/);
});

test("keeps both request listeners active until concurrent observations settle", async () => {
  const first = browser(csrf("a"), { sessionValue: { csrfToken: "invalid" } });
  const delayedRedeem = browser(csrf("b"), { delayMs: 10, redeem: true });
  const f = fixture(first, delayedRedeem);
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, f.dependencies),
    /principal_observation_redeem_observed/);
  assert.equal(f.first.listeners.size, 0); assert.equal(f.second.listeners.size, 0);
});

test("rejects malformed, oversized, non-JSON, wrong-intent, and forged-metadata responses", async () => {
  const cases = [
    browser(csrf("a"), { sessionValue: { csrfToken: "invalid" } }),
    browser(csrf("a"), { sessionOptions: { bytes: Buffer.alloc(16 * 1024 + 1) } }),
    browser(csrf("a"), { sessionOptions: { responseHeaders: { "content-type": "text/plain" } } }),
    browser(csrf("a"), { sessionOptions: { responseHeaders: { "cache-control": "public, max-age=60" } } }),
    browser(csrf("a"), { inspectValue: { ...inspect, intentId: "30000000-0000-4000-8000-000000000003" } }),
    browser(csrf("a"), { inspectOptions: { requestValue: { intentId: "30000000-0000-4000-8000-000000000003", opaqueToken } } }),
    browser(csrf("a"), { inspectOptions: { requestValue: { intentId, opaqueToken: "cd".repeat(32) } } }),
    browser(csrf("a"), { inspectOptions: { requestHeaders: { "x-csrf-token": csrf("z") } } }),
    browser(csrf("a"), { sessionOptions: { requestHeaders: { "sec-fetch-site": "cross-site" } } }),
    browser(csrf("a"), { sessionOptions: { status: opaqueToken } }),
  ];
  for (const first of cases) await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(first, browser(csrf("b"))).dependencies), error => error instanceof ClientPortalPrincipalObservationError
      && !error.message.includes(opaqueToken) && !error.message.includes(intentId));
});

test("sanitizes provider and browser failures", async () => {
  const provider = fixture(); provider.dependencies.readDeploymentSnapshot = async () => { throw new Error(`provider leaked ${opaqueToken}`); };
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, provider.dependencies), error =>
    error.code === "principal_observation_snapshot_read_failed" && !error.message.includes(opaqueToken));
  const hanging = fixture(); hanging.dependencies.readDeploymentSnapshot = async () => new Promise(() => {});
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link, timeoutMs: 1_000 },
    hanging.dependencies), /principal_observation_snapshot_read_timeout/);
  const failed = browser(csrf("a")); failed.page.goto = async () => { throw new Error(`navigation leaked ${opaqueToken}`); };
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link, timeoutMs: 1_000 },
    fixture(failed, browser(csrf("b"))).dependencies), error => error.code === "principal_observation_browser_failed"
      && !error.message.includes(opaqueToken));
});

test("requires distinct browser contexts already on the exact staging origin", async () => {
  const shared = browser(csrf("a"));
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link }, {
    enrolled: shared, distinct: shared, readDeploymentSnapshot: async () => snapshot(),
  }), /principal_observation_two_contexts_required/);
  const wrong = browser(csrf("b")); wrong.page.url = () => "https://client.ledgetopdroneservices.com/portal";
  await assert.rejects(() => observeClientPortalDistinctPrincipals({ enrollmentUrl: link },
    fixture(browser(csrf("a")), wrong).dependencies), /principal_observation_distinct_page_invalid/);
});

test("binds actual native-context home and handle denial between two snapshot-stable private observations", async () => {
  const f = fixture(browser(csrf("a")), browser(csrf("b")), [snapshot(), snapshot(), snapshot(), snapshot()]);
  const report = await checkClientPortalObservedDistinctPrincipalDenial(acceptanceConfig, denialInput, {
    ...f.dependencies, observationConfig: { enrollmentUrl: link },
  });
  assert.equal(report.check, "distinct_principal_denial");
  assert.deepEqual(report.principalBindings, { serverAuthenticated: true, sameBucket: true, distinct: true,
    stableAcrossDenial: true, valuesExcluded: true });
  assert.deepEqual(report.denial, { homeStatus: 403, kind: "file", action: "download", status: 404 });
  assert.deepEqual(report.observations, { rounds: 2, fragmentScrubbed: true, pageRedeemObserved: false });
  assert.deepEqual(f.phases, ["before", "after", "before", "after"]);
  assert.equal(f.first.calls.length, 2); assert.equal(f.second.calls.length, 2);
  assert.deepEqual(f.second.apiCalls.map(call => new URL(call.url).pathname), [
    "/api/client/v2/operations/home", `/api/client/operations/data/files/${denialInput.handle}/download`,
  ]);
  assert(f.second.apiCalls.every(call => call.requestOptions.maxRetries === 0
    && call.requestOptions.maxRedirects === 0 && call.requestOptions.failOnStatusCode === false));
  assert(f.second.apiCalls.every(call => !Object.keys(call.requestOptions.headers)
    .some(name => /cookie|authorization|cf-access/i.test(name))));
  const encoded = JSON.stringify(report);
  for (const secret of [opaqueToken, csrf("a"), csrf("b"), intentId, denialInput.handle,
    "deployment-one", "native-enrollment-key-v1"])
    assert.equal(encoded.includes(secret), false);
});

test("rejects stale principals, bucket drift, context swaps, snapshot drift, and observed-page redeem", async () => {
  const stale = fixture(browser(csrf("a"), { csrfTokens: [csrf("a"), csrf("c")] }),
    browser(csrf("b")), [snapshot(), snapshot(), snapshot(), snapshot()]);
  await assert.rejects(() => checkClientPortalObservedDistinctPrincipalDenial(acceptanceConfig, denialInput,
    { ...stale.dependencies, observationConfig: { enrollmentUrl: link } }),
  /principal_observation_principal_drift/);

  const nextBucketA = `123457.${"c".repeat(64)}`, nextBucketB = `123457.${"d".repeat(64)}`;
  const bucketDrift = fixture(browser(csrf("a"), { csrfTokens: [csrf("a"), nextBucketA] }),
    browser(csrf("b"), { csrfTokens: [csrf("b"), nextBucketB] }),
    [snapshot(), snapshot(), snapshot(), snapshot()]);
  await assert.rejects(() => checkClientPortalObservedDistinctPrincipalDenial(acceptanceConfig, denialInput,
    { ...bucketDrift.dependencies, observationConfig: { enrollmentUrl: link } }),
  /principal_observation_bucket_drift/);

  const swapOptions = {}, swapFirst = browser(csrf("a")), swapSecond = browser(csrf("b"), swapOptions);
  swapOptions.apiHandler = (url) => {
    swapSecond.driftContext(swapFirst.context);
    return apiResponse(url, new URL(url).pathname.endsWith("/home") ? 403 : 404);
  };
  const swapped = fixture(swapFirst, swapSecond, [snapshot(), snapshot(), snapshot(), snapshot()]);
  await assert.rejects(() => checkClientPortalObservedDistinctPrincipalDenial(acceptanceConfig, denialInput,
    { ...swapped.dependencies, observationConfig: { enrollmentUrl: link } }),
  /principal_observation_denial_failed/);

  const changed = snapshot({ configMarker: "native-enrollment-key-v2" });
  const configDrift = fixture(browser(csrf("a")), browser(csrf("b")),
    [snapshot(), snapshot(), changed, changed]);
  await assert.rejects(() => checkClientPortalObservedDistinctPrincipalDenial(acceptanceConfig, denialInput,
    { ...configDrift.dependencies, observationConfig: { enrollmentUrl: link } }),
  /principal_observation_deployment_drift/);

  const redeemOptions = {}, redeemFirst = browser(csrf("a")), redeemSecond = browser(csrf("b"), redeemOptions);
  redeemOptions.apiHandler = url => {
    // Model a concurrent request emitted by the observed page while the
    // APIRequestContext denial call is in flight; this is not instrumentation
    // of the APIRequestContext network request itself.
    redeemSecond.emitRedeem();
    return apiResponse(url, new URL(url).pathname.endsWith("/home") ? 403 : 404);
  };
  const observedPageRedeemDuringDenial = fixture(redeemFirst, redeemSecond,
    [snapshot(), snapshot(), snapshot(), snapshot()]);
  await assert.rejects(() => checkClientPortalObservedDistinctPrincipalDenial(acceptanceConfig, denialInput,
    { ...observedPageRedeemDuringDenial.dependencies, observationConfig: { enrollmentUrl: link } }),
  /principal_observation_redeem_observed/);
});

test("source contains no injected page execution, request-context transport, provider fallback, or logging", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./staging-client-portal-principal-observation.mjs", import.meta.url)), "utf8");
  for (const forbidden of [".evaluate(", ".evaluateHandle(", ".request.get(", ".request.post(", "console.", "globalThis.fetch", "page.click("])
    assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /page\.goto\(/u);
  assert.match(source, /page\.waitForResponse\(/u);
});
