import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ClientPortalBrowserAcceptanceError,
  checkClientPortalDistinctPrincipalDenial,
  checkClientPortalOldHandleDenial,
  checkClientPortalServiceHomeDenial,
  parseClientPortalBrowserAcceptanceConfig,
  runClientPortalBrowserContextAcceptance,
} from "./staging-client-portal-browser-context-acceptance.mjs";

const origin = "https://client-staging.ledgetopdroneservices.com";
const authorityId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "37fa87e6-f283-4a29-a2d7-f33629fbd0b7";
const runId = "20000000-0000-4000-8000-000000000002";
const selectedPrefix = `staging/portal-acceptance/${workspaceId}/shared/`;
const hash = value => createHash("sha256").update(value).digest("hex");
const handle = suffix => `ond1_${suffix}`;
const body = (value, status = 200, headers = {}) => new Response(typeof value === "string" ? value : JSON.stringify(value), {
  status, headers: { "content-type": typeof value === "string" ? "text/plain" : "application/json", ...headers },
});
const manifestObject = (role, key, value) => ({ role, key, bytes: value, size: Buffer.byteLength(value), sha256: hash(value),
  customMetadata: { fixture: "staging-portal-byte-v1", runId, role, sha256: hash(value) } });
const manifest = {
  schemaVersion: 1, stagingOnly: true, accountId: "846c924bf17bf4f3dd15c97a4c5d1d51", bucketName: "client-data-staging",
  targetId: workspaceId, selectedPrefix, runId,
  objects: [
    manifestObject("selected-direct", `${selectedPrefix}${runId}/selected.txt`, "LTDS staging selected shared fixture\n"),
    manifestObject("selected-nested", `${selectedPrefix}${runId}/nested/selected.txt`, "LTDS staging nested shared fixture\n"),
    manifestObject("sibling-private", `staging/portal-acceptance/${workspaceId}/private/${runId}/sibling.txt`, "LTDS staging unselected private fixture\n"),
    manifestObject("cross-customer", `staging/portal-acceptance/cross-customer-${runId}/shared/cross.txt`, "LTDS staging cross-customer fixture\n"),
  ],
};
const config = {
  origin,
  expectedHome: { authorityId, workspaceId, ownershipEpoch: 2, grantRevision: 3, serviceIds: ["drone-service"] },
  expectedDeliveryLabel: "Selected Deliverables",
  manifest,
  actions: ["preview", "download"],
};
const home = { resourceMode: "operations_home", homes: [{ authorityId, workspaceId, ownershipEpoch: 2, grantRevision: 3,
  services: [{ serviceId: "drone-service", providerId: "operations", displayLabel: "Drone service", revision: 1 }] }] };
const file = (id, name, size) => ({ id, name, size, uploadedAt: "2026-10-10T12:00:00.000Z", contentType: "text/plain",
  kind: "text", previewPath: `/api/client/operations/data/files/${id}/preview`, thumbnailPath: null,
  downloadPath: `/api/client/operations/data/files/${id}/download` });

function positiveFetcher(log) {
  const delivery = handle("delivery"), run = handle("run"), nested = handle("nested"), direct = handle("direct"), nestedFile = handle("nested_file");
  return {
    delivery, direct,
    fetcher: async (url, init) => {
      const parsed = new URL(url); log.push({ path: parsed.pathname + parsed.search, init });
      if (parsed.pathname === "/api/client/v2/operations/home") return body(home);
      if (parsed.pathname === "/api/client/operations/data/deliveries") return body({ resourceMode: "operations_native_delivery",
        items: [{ id: delivery, displayName: "Selected Deliverables" }], page: { nextCursor: null } });
      if (parsed.pathname === `/api/client/operations/data/folders/${delivery}`) return body({ resourceMode: "operations_native_delivery",
        files: [], folders: [{ id: run, name: runId }], breadcrumbs: [{ id: delivery, name: "Selected Deliverables" }],
        folderId: delivery, prefix: "", cursor: null });
      if (parsed.pathname === `/api/client/operations/data/folders/${run}`) return body({ resourceMode: "operations_native_delivery",
        files: [file(direct, "selected.txt", Buffer.byteLength("LTDS staging selected shared fixture\n"))], folders: [{ id: nested, name: "nested" }],
        breadcrumbs: [{ id: run, name: runId }], folderId: run, prefix: "", cursor: null });
      if (parsed.pathname === `/api/client/operations/data/folders/${nested}`) return body({ resourceMode: "operations_native_delivery",
        files: [file(nestedFile, "selected.txt", Buffer.byteLength("LTDS staging nested shared fixture\n"))], folders: [],
        breadcrumbs: [{ id: nested, name: "nested" }], folderId: nested, prefix: "", cursor: null });
      if (parsed.pathname.startsWith(`/api/client/operations/data/files/${direct}/`)) return body("LTDS staging selected shared fixture\n");
      if (parsed.pathname.startsWith(`/api/client/operations/data/files/${nestedFile}/`)) return body("LTDS staging nested shared fixture\n");
      throw new Error(`unexpected ${url}`);
    },
  };
}

test("reads home and selected opaque folder bytes in a native same-origin context without reporting handles", async () => {
  const log = [], privateProofs = [], fixture = positiveFetcher(log);
  const report = await runClientPortalBrowserContextAcceptance(config, {
    browserContextFetcher: fixture.fetcher,
    capturePrivateProof: value => privateProofs.push(value),
    now: Date.parse("2026-10-10T12:30:00.000Z"),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.mutationsPerformed, false);
  assert.equal(report.observedAt, "2026-10-10T12:30:00.000Z");
  assert.deepEqual(report.files.map(value => [value.role, value.action, value.sha256]), [
    ["selected-direct", "preview", manifest.objects[0].sha256],
    ["selected-direct", "download", manifest.objects[0].sha256],
    ["selected-nested", "preview", manifest.objects[1].sha256],
    ["selected-nested", "download", manifest.objects[1].sha256],
  ]);
  assert.equal(report.manifest.excludedNamesObserved, 0);
  assert.equal(JSON.stringify(report).includes("ond1_"), false);
  assert.equal(JSON.stringify(report).includes(selectedPrefix), false);
  assert.equal(privateProofs[0].deliveryHandle, fixture.delivery);
  assert.equal(privateProofs[0].files[0].fileHandle, fixture.direct);
  assert(log.every(call => call.init.credentials === "same-origin" && call.init.redirect === "error" && call.init.cache === "no-store"));
  assert(log.every(call => !Object.keys(call.init.headers).some(name => /cookie|authorization|cf-access/i.test(name))));
  assert(log.every(call => call.init.method === "GET"));
});

test("rejects host drift, manifest drift, credential-bearing config, and byte drift", async () => {
  assert.throws(() => parseClientPortalBrowserAcceptanceConfig({ ...config, origin: "https://client.ledgetopdroneservices.com" }),
    error => error instanceof ClientPortalBrowserAcceptanceError && error.code === "production_or_noncanonical_client_origin");
  const badManifest = structuredClone(manifest); badManifest.objects[0].sha256 = "f".repeat(64);
  badManifest.objects[0].customMetadata.sha256 = "f".repeat(64);
  assert.throws(() => parseClientPortalBrowserAcceptanceConfig({ ...config, manifest: badManifest }), /private_manifest_byte_hash_mismatch/);
  assert.throws(() => parseClientPortalBrowserAcceptanceConfig({ ...config, cookie: "forbidden" }), /invalid_acceptance_config/);
  const drift = positiveFetcher([]);
  const fetcher = async (url, init) => new URL(url).pathname.endsWith(`/${drift.direct}/download`) ? body("changed\n") : drift.fetcher(url, init);
  await assert.rejects(() => runClientPortalBrowserContextAcceptance(config, { browserContextFetcher: fetcher }), /selected_file_byte_hash_mismatch/);
  assert.equal(JSON.stringify(config).includes("/api/client/operations/data/files/staging/"), false);
});

test("fails closed when excluded fixture names become visible", async () => {
  const fixture = positiveFetcher([]);
  const fetcher = async (url, init) => {
    const response = await fixture.fetcher(url, init), parsed = new URL(url);
    if (parsed.pathname.endsWith(`/${handle("run")}`)) {
      const value = await response.json();
      value.files.push(file(handle("sibling"), "sibling.txt", 8));
      return body(value);
    }
    return response;
  };
  await assert.rejects(() => runClientPortalBrowserContextAcceptance(config, { browserContextFetcher: fetcher }), /excluded_fixture_visible/);
  const malformedBreadcrumbs = positiveFetcher([]);
  const malformedFetcher = async (url, init) => {
    const response = await malformedBreadcrumbs.fetcher(url, init), parsed = new URL(url);
    if (parsed.pathname.includes("/folders/")) {
      const value = await response.json(); value.breadcrumbs = [{ name: "missing opaque selector" }]; return body(value);
    }
    return response;
  };
  await assert.rejects(() => runClientPortalBrowserContextAcceptance(config,
    { browserContextFetcher: malformedFetcher }), /invalid_folder_listing/);
});

test("checks a previously captured opaque handle only after revalidating the current home", async () => {
  const calls = [], old = handle("old_file");
  const report = await checkClientPortalOldHandleDenial(config, { kind: "file", handle: old, action: "download" }, {
    browserContextFetcher: async (url, init) => {
      const path = new URL(url).pathname; calls.push({ path, init });
      if (path === "/api/client/v2/operations/home") return body(home);
      if (path === `/api/client/operations/data/files/${old}/download`) return body({ error: "Shared data is unavailable" }, 404);
      throw new Error("unexpected");
    },
  });
  assert.equal(report.denial.status, 404);
  assert.equal(JSON.stringify(report).includes(old), false);
  assert.deepEqual(calls.map(value => value.path), ["/api/client/v2/operations/home", `/api/client/operations/data/files/${old}/download`]);
  await assert.rejects(() => checkClientPortalOldHandleDenial(config,
    { kind: "file", handle: manifest.objects[2].key, action: "download" },
    { browserContextFetcher: async () => { throw new Error("must not fetch"); } }), /invalid_denial_probe/);
  await assert.rejects(() => checkClientPortalOldHandleDenial(config,
    { kind: "file", handle: `ond1_${"a".repeat(8192)}`, action: "download" },
    { browserContextFetcher: async () => { throw new Error("must not fetch"); } }), /invalid_denial_probe/);
});

test("checks service-home denial without trying enrollment, grant, revoke, or recovery routes", async () => {
  const calls = [];
  const report = await checkClientPortalServiceHomeDenial(config, {
    browserContextFetcher: async (url, init) => { calls.push({ url, init }); return body({ error: "revoked" }, 403); },
  });
  assert.equal(report.statusCode, 403);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/api/client/v2/operations/home"]);
  assert.equal(calls[0].init.method, "GET");
});

function principalFetcher(binding, old, calls) {
  return async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, init });
    if (path === "/api/client/session") return body({ principal: binding });
    if (path === "/api/client/v2/operations/home") return body({ error: "not provisioned" }, 403);
    if (path === `/api/client/operations/data/files/${old}/download`) return body({ error: "unavailable" }, 404);
    throw new Error(`unexpected ${path}`);
  };
}

test("requires two server-derived, genuinely distinct principals before claiming cross-principal denial", async () => {
  const old = handle("captured"), enrolledCalls = [], distinctCalls = [];
  const report = await checkClientPortalDistinctPrincipalDenial(config, { kind: "file", handle: old, action: "download" }, {
    enrolledBrowserContextFetcher: principalFetcher({ issuer: "https://access.example", subject: "subject-a" }, old, enrolledCalls),
    distinctBrowserContextFetcher: principalFetcher({ issuer: "https://access.example", subject: "subject-b" }, old, distinctCalls),
  });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.principalBindings, { distinct: true, valuesExcluded: true });
  assert.equal(JSON.stringify(report).includes("subject-a"), false);
  assert.equal(JSON.stringify(report).includes("subject-b"), false);
  assert.equal(JSON.stringify(report).includes(old), false);
  assert.deepEqual(enrolledCalls.map(value => value.path), ["/api/client/session"]);
  assert.deepEqual(distinctCalls.map(value => value.path), ["/api/client/session", "/api/client/v2/operations/home",
    `/api/client/operations/data/files/${old}/download`]);
});

test("reports distinct-principal evidence unsupported when the normal Client session does not expose issuer and subject", async () => {
  const old = handle("captured"), distinctCalls = [];
  const report = await checkClientPortalDistinctPrincipalDenial(config, { kind: "file", handle: old, action: "download" }, {
    enrolledBrowserContextFetcher: async () => body({ account: { id: "", displayName: "" }, capabilities: {} }),
    distinctBrowserContextFetcher: async url => { distinctCalls.push(new URL(url).pathname); return body({ error: "not provisioned" }, 403); },
  });
  assert.equal(report.status, "unsupported");
  assert.equal(report.reason, "server_principal_binding_unavailable");
  assert.deepEqual(report.sessionStatuses, [200, 403]);
  assert.deepEqual(distinctCalls, ["/api/client/session"]);
});

test("rejects same-principal contexts and never performs a denial request", async () => {
  const old = handle("captured"), calls = [];
  const fetcher = principalFetcher({ issuer: "https://access.example", subject: "same" }, old, calls);
  await assert.rejects(() => checkClientPortalDistinctPrincipalDenial(config,
    { kind: "file", handle: old, action: "download" },
    { enrolledBrowserContextFetcher: fetcher, distinctBrowserContextFetcher: fetcher }), /genuine_distinct_principal_required/);
  assert.deepEqual(calls.map(value => value.path), ["/api/client/session", "/api/client/session"]);
});
