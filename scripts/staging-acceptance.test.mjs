import test from "node:test";
import assert from "node:assert/strict";
import { runReadOnlyStagingAcceptance, StagingAcceptanceError, validateExactOrigin } from "./staging-acceptance.mjs";

const opsOrigin = "https://ops-staging.ledgetopdroneservices.com";
const viewerOrigin = "https://viewer-staging.ledgetopdroneservices.com";
const viewerCommit = "a".repeat(40), operationsCommit = "b".repeat(40);
const dependencies = {
  contractFinalized: true,
  viewer: { origin: viewerOrigin, image: `ghcr.io/ledgetoptechnologies/3d-viewer@sha256:${"c".repeat(64)}`, schemaVersion: 17 },
  candidates: { viewer: viewerCommit, operations: operationsCommit },
  runId: "00000000-0000-4000-8000-000000000001", now: Date.parse("2026-08-17T12:00:00.000Z"),
};

function json(payload, headers = {}, status = 200) { return Response.json(payload, { status, headers }); }
function healthyFetcher(overrides = {}) {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ url: String(input), init });
    const path = new URL(String(input)).pathname;
    if (overrides[path]) return overrides[path](input, init);
    const identity = { "Cache-Control": "no-store", "X-LTDS-Viewer-Revision": viewerCommit, "X-LTDS-Viewer-Schema-Version": "17" };
    if (path === "/api/v1/health") return json({ ok: true }, identity);
    if (path === "/api/v1/ready") return json({ ok: true, missing: [] }, identity);
    if (path === "/api/viewer/connection-preflight") return json({
      integrationEnabled: false, configured: true, publicHealthReachable: true, publicHealthOk: true,
      publicReadyReachable: true, publicReady: true, readinessIssueCount: 0,
      serviceAuthReachable: true, modelCount: 2, readyModelCount: 1,
    }, { "Cache-Control": "no-store" });
    throw new Error("unexpected request");
  };
  return { fetcher, calls };
}

test("accepts only the exact staging HTTPS origins", () => {
  assert.equal(validateExactOrigin(viewerOrigin, viewerOrigin), viewerOrigin);
  for (const value of ["https://viewer.ledgetopdroneservices.com", "https://viewer-staging.ledgetopdroneservices.com.evil.test",
    "http://viewer-staging.ledgetopdroneservices.com", "https://viewer-staging.ledgetopdroneservices.com:444",
    "https://user@viewer-staging.ledgetopdroneservices.com", `${viewerOrigin}/api`, `${viewerOrigin}/?x=1`, `${viewerOrigin}/#x`])
    assert.throws(() => validateExactOrigin(value, viewerOrigin), { code: "invalid_origin" });
});

test("uses only GET/manual requests and emits a secret-free bounded report", async () => {
  const { fetcher, calls } = healthyFetcher();
  const report = await runReadOnlyStagingAcceptance({ accessCookie: "x".repeat(32) }, { ...dependencies, fetcher });
  assert.equal(report.status, "passed");
  assert.equal(report.mutationsPerformed, false);
  assert.equal(report.credentials.valuesExcluded, true);
  assert.equal(JSON.stringify(report).includes("x".repeat(10)), false);
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.init.method, "GET"); assert.equal(call.init.redirect, "manual"); }
  assert.equal(calls.filter(call => call.init.headers.Cookie).length, 1);
  assert.equal(calls.filter(call => call.url.startsWith(viewerOrigin) && call.init.headers.Cookie).length, 0);
});

test("refuses unfinalized, mutable, or wrong-origin runs before fetching", async () => {
  for (const variant of [{ contractFinalized: false },
    { viewer: { ...dependencies.viewer, image: "ghcr.io/ledgetoptechnologies/3d-viewer:latest" } }]) {
    const fetcher = async () => { throw new Error("must not fetch"); };
    await assert.rejects(runReadOnlyStagingAcceptance({ accessCookie: "x".repeat(32) }, { ...dependencies, ...variant, fetcher }), StagingAcceptanceError);
  }
  const fetcher = async () => { throw new Error("must not fetch"); };
  await assert.rejects(runReadOnlyStagingAcceptance({ accessCookie: "x".repeat(32), viewerOrigin: "https://viewer.ledgetopdroneservices.com" },
    { ...dependencies, fetcher }), { code: "invalid_origin" });
});

test("fails closed on redirects, identity drift, cache drift, oversize, and DTO drift", async t => {
  const cases = [
    ["redirect", "/api/v1/health", () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }), "redirect_denied"],
    ["cache", "/api/v1/health", () => json({ ok: true }, { "X-LTDS-Viewer-Revision": viewerCommit, "X-LTDS-Viewer-Schema-Version": "17" }), "viewer_identity_mismatch"],
    ["schema", "/api/v1/ready", () => json({ ok: true, missing: [] }, { "Cache-Control": "no-store", "X-LTDS-Viewer-Revision": viewerCommit, "X-LTDS-Viewer-Schema-Version": "16" }), "viewer_identity_mismatch"],
    ["oversize", "/api/v1/health", () => json({ ok: true }, { "Content-Length": "20000" }), "response_too_large"],
    ["dto", "/api/viewer/connection-preflight", () => json({ secret: "blocked" }, { "Cache-Control": "no-store" }), "operations_preflight_invalid"],
  ];
  for (const [name, path, factory, code] of cases) await t.test(name, async () => {
    const { fetcher, calls } = healthyFetcher({ [path]: factory });
    await assert.rejects(runReadOnlyStagingAcceptance({ accessCookie: "x".repeat(32) }, { ...dependencies, fetcher }), { code });
    if (name === "redirect") assert.equal(calls.filter(call => call.url.includes("evil.test")).length, 0);
  });
});
