import test from "node:test";
import assert from "node:assert/strict";
import { PaAcceptanceError, parseAcceptanceConfig, runPaApiV2StagingAcceptance } from "./pa-api-v2-staging-acceptance.mjs";

const source = "11111111-1111-4111-8111-111111111111";
const application = "22222222-2222-4222-8222-222222222222";
const epoch = "33333333-3333-4333-8333-333333333333";
const token = "test-bearer-do-not-print";
const prefix = "pa-acceptance-test";
const projectId = "a".repeat(32);
const revision = "1";
const hash = "b".repeat(64);
const updatedHash = "e".repeat(64);
const organization = { externalId: "pa-acceptance-test:organization", expectedPublicId: "c".repeat(32), expectedRevision: "1", expectedProjectionSha256: "d".repeat(64) };

function env(overrides = {}) {
  return {
    PA_BASE_URL: "https://pa-staging.example.test", PA_API_TOKEN: token,
    PA_ACCEPTANCE_ALLOW_MUTATIONS: "allow", PA_ACCEPTANCE_PREFIX: prefix,
    PA_SOURCE_INSTANCE_ID: source, PA_APPLICATION_ID: application, PA_HISTORY_EPOCH: epoch,
    PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: JSON.stringify(organization),
    PA_ACCEPTANCE_PROJECT_PROFILE_JSON: JSON.stringify({ name: "pa-acceptance-test Project", description: null, estimatedStart: null, estimatedEnd: null }),
    PA_ACCEPTANCE_EXERCISE_STATUS: "allow", PA_ACCEPTANCE_EXERCISE_INVENTORY: "allow", ...overrides,
  };
}

function response(payload, status = 200, requestId = "44444444-4444-4444-8444-444444444444") {
  const { apiVersion, sourceInstanceId, applicationId, historyEpoch, requestId: payloadRequestId, ...rest } = payload || {};
  const body = apiVersion === undefined ? { ...rest, requestId: payloadRequestId ?? requestId }
    : { apiVersion, sourceInstanceId, applicationId, historyEpoch, requestId: payloadRequestId ?? requestId, ...rest };
  return Response.json(body, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}

function capabilities() {
  const routes = [
    ["projects_create", "projects.create", "POST", "/api/v2/projects/commands"],
    ["projects_read", "projects.v2.read", "GET", "/api/v2/projects/{publicId}"],
    ["projects_write", "projects.write", "POST", "/api/v2/projects/profile/commands"],
    ["projects_binding_status", "projects.binding_status.read", "GET", "/api/v2/projects/bindings/status/{base64urlExternalId}"],
    ["projects_inventory", "projects.inventory.read", "GET", "/api/v2/projects/inventory"],
  ];
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
    grantedCapabilities: [{ name: "api.capabilities.read" }, ...routes.map(([, scope]) => ({ name: scope }))],
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, ...routes.map(([, scope, method, path]) => ({ method, path, requiredCapability: scope, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }))] };
}

function fixtureFetcher() {
  const calls = [];
  const created = { publicId: projectId, revision, projectionSha256: hash };
  const identity = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch };
  const commandState = new Map();
  let createBody;
  let updateBody;
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v2/capabilities") return response(capabilities());
    if (parsed.pathname === `/api/v2/projects/${projectId}`) {
      const body = updateBody || createBody;
      const currentRevision = updateBody ? "2" : "1";
      return response({ ...identity, replayed: false, accepted: true, resource: { type: "project", id: projectId, revision: currentRevision, projectionSha256: updateBody ? updatedHash : hash }, data: {
        name: body.project.name, description: body.project.description, status: "not_started", archived: false, overdueWarning: false,
        completedAt: null, archivedAt: null, estimatedStart: body.project.estimatedStart, estimatedEnd: body.project.estimatedEnd,
        clientPublicId: createBody.client?.expectedPublicId ?? null, organizationPublicId: createBody.organization.expectedPublicId,
      } });
    }
    if (parsed.pathname === "/api/v2/projects/inventory") {
      const externalId = [...commandState.values()][0]?.externalId;
      return response({ ...identity, authorizationGeneration: externalId ? "1" : "0", projects: externalId ? [{ externalId, publicId: projectId, revision: "2", projectionSha256: updatedHash, status: "not_started", archived: false }] : [], nextCursor: null });
    }
    if (parsed.pathname.includes("/bindings/status/")) return response({ ...identity, authorizationGeneration: "1", binding: { externalId: [...commandState.values()][0]?.externalId, publicId: projectId, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:01Z" }, resource: { revision: "2", projectionSha256: updatedHash, status: "not_started", archived: false } });
    const body = JSON.parse(init.body);
    const prior = commandState.get(body.commandId);
    const fingerprint = JSON.stringify(body);
    if (prior && prior.fingerprint !== fingerprint) return response({}, 409);
    const replayed = Boolean(prior);
    commandState.set(body.commandId, { fingerprint, externalId: body.externalId });
    const isCreate = parsed.pathname === "/api/v2/projects/commands";
    if (isCreate) createBody = body;
    if (parsed.pathname === "/api/v2/projects/profile/commands") updateBody = body;
    return response({ ...identity, replayed, result: { resource: { type: "project", id: body.externalId, publicId: projectId, revision: isCreate ? "1" : "2", projectionSha256: isCreate ? hash : updatedHash }, authorizationGeneration: isCreate ? "1" : "1", presentation: { portalPublished: false, publicLinkEnabled: false } } }, isCreate ? 201 : 200);
  };
  return { fetcher, calls };
}

test("fails fast before fetching when mutable mode lacks the explicit test prefix", () => {
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_PREFIX: "production" })), {
    code: "invalid_pa_acceptance_prefix",
  });
});

test("rejects mutable configuration before network activity", () => {
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_PREFIX: "not-clear" })), { code: "invalid_pa_acceptance_prefix" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_CF_ACCESS_CLIENT_ID: "id" })), { code: "incomplete_cloudflare_access_service_credentials" });
  assert.throws(() => parseAcceptanceConfig({ PA_BASE_URL: "https://pa-staging.example.test", PA_API_TOKEN: token }), { code: "missing_pa_source_instance_id" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_LIFECYCLE_ONLY: "allow" })), { code: "lifecycle_only_requires_fixture" });
  assert.throws(() => parseAcceptanceConfig(env({
    PA_ACCEPTANCE_LIFECYCLE_ONLY: "allow", PA_ACCEPTANCE_ALLOW_LIFECYCLE: "allow",
    PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON: JSON.stringify({ projectPublicId: projectId, expectedRevision: "2", expectedProjectionSha256: updatedHash, expectedName: `${prefix} Project`, publicLinkUrl: "https://public.example.test/project", enabledStatus: 200, disabledStatus: 404 }),
    PA_ACCEPTANCE_BIND_COMMAND_JSON: JSON.stringify({ externalId: `${prefix}:bound`, expectedPublicId: projectId, expectedName: "Bound project" }),
  })), { code: "lifecycle_only_rejects_binding_commands" });
});

test("accepts lifecycle-only configuration without create or update fixtures", () => {
  const config = parseAcceptanceConfig(env({
    PA_ACCEPTANCE_LIFECYCLE_ONLY: "allow", PA_ACCEPTANCE_ALLOW_LIFECYCLE: "allow",
    PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: undefined, PA_ACCEPTANCE_PROJECT_PROFILE_JSON: undefined,
    PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON: JSON.stringify({ projectPublicId: projectId, expectedRevision: "2", expectedProjectionSha256: updatedHash, expectedName: `${prefix} Project`, publicLinkUrl: "https://public.example.test/project", enabledStatus: 200, disabledStatus: 404 }),
  }));
  assert.equal(config.lifecycleOnly, true);
  assert.equal(config.organization, undefined);
  assert.equal(config.project, undefined);
});

test("accepts only lowercase canonical wire identifiers and fixture member order", () => {
  assert.throws(() => parseAcceptanceConfig(env({ PA_SOURCE_INSTANCE_ID: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })), { code: "invalid_pa_identity" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: JSON.stringify({ ...organization, expectedPublicId: organization.expectedPublicId.toUpperCase() }) })), { code: "invalid_pa_acceptance_organization_binding_json" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: JSON.stringify({ expectedPublicId: organization.expectedPublicId, externalId: organization.externalId, expectedRevision: "1", expectedProjectionSha256: organization.expectedProjectionSha256 }) })), { code: "invalid_pa_acceptance_organization_binding_json" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_BIND_COMMAND_JSON: JSON.stringify({ expectedPublicId: projectId, externalId: `${prefix}:bound` }) })), { code: "invalid_pa_acceptance_bind_command_json" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_REFRESH_COMMAND_JSON: JSON.stringify({ externalId: `${prefix}:bound`, expectedPublicId: projectId, expectedPriorRevision: "01" }) })), { code: "invalid_pa_acceptance_refresh_command_json" });
});

test("mirrors PA profile, date, and external-ID fixture constraints", () => {
  const profile = { name: "pa-acceptance-test Project", description: null, estimatedStart: null, estimatedEnd: null };
  const invalidProfile = value => assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_PROJECT_PROFILE_JSON: JSON.stringify({ ...profile, ...value }) })), { code: "invalid_pa_acceptance_project_profile_json" });
  invalidProfile({ name: null });
  invalidProfile({ name: " " });
  invalidProfile({ name: `${prefix}${"x".repeat(140 - prefix.length)}` });
  invalidProfile({ name: `${prefix} ok`, description: "x".repeat(10_001) });
  invalidProfile({ name: `${prefix} ok`, description: "line\nbreak" });
  invalidProfile({ name: `${prefix} ok`, estimatedStart: "2026-02-29" });
  invalidProfile({ name: `${prefix} ok`, estimatedStart: "2024-02-29", estimatedEnd: "2024-02-28" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: JSON.stringify({ ...organization, externalId: "x".repeat(192) }) })), { code: "invalid_pa_acceptance_organization_binding_json" });
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: JSON.stringify({ ...organization, externalId: "😀".repeat(192) }) })), { code: "invalid_pa_acceptance_organization_binding_json" });
});

test("normalizes PA-trimmed profile strings while retaining the canonical wire order", () => {
  const config = parseAcceptanceConfig(env({ PA_ACCEPTANCE_PROJECT_PROFILE_JSON: JSON.stringify({ name: ` ${prefix} Project `, description: " note ", estimatedStart: " 2024-02-29 ", estimatedEnd: " 2024-03-01 " }) }));
  assert.deepEqual(config.project, { name: `${prefix} Project`, description: "note", estimatedStart: "2024-02-29", estimatedEnd: "2024-03-01" });
});

test("runs create/update replay and changed-body conflicts without exposing credentials or profile bodies", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher, calls } = fixtureFetcher();
  const uuids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"];
  const report = await runPaApiV2StagingAcceptance(config, { fetcher, uuid: () => uuids.shift(), now: () => Date.UTC(2026, 8, 17) });
  assert.equal(report.status, "passed");
  assert.equal(report.mutationsPerformed, true);
  assert.equal(report.stages.create.first.status, 201);
  assert.equal(report.stages.create.replay.replayed, true);
  assert.equal(report.stages.create.changedBody.status, 409);
  assert.equal(report.stages.update.changedBody.status, 409);
  assert.equal(report.stages.bindingStatus.status, 200);
  assert.equal(report.stages.inventory.status, 200);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("pa-acceptance-test Project"), false);
  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.authorization, `Bearer ${token}`);
    assert.equal(
      call.init.headers["x-pa-source-instance-id"],
      call.url.endsWith("/api/v2/capabilities") ? undefined : source,
    );
  }
  const writes = calls.filter(call => call.init.method === "POST").map(call => JSON.parse(call.init.body));
  assert.deepEqual(Object.keys(writes[0]), ["commandId", "externalId", "expectedAuthorizationGeneration", "project", "organization", "client"]);
  assert.deepEqual(Object.keys(writes[0].project), ["name", "description", "estimatedStart", "estimatedEnd"]);
  assert.deepEqual(Object.keys(writes[0].organization), ["externalId", "expectedPublicId", "expectedRevision", "expectedProjectionSha256"]);
  assert.equal(writes[2].expectedAuthorizationGeneration, "1");
});

test("rejects mismatched read, binding-status, and inventory evidence", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  const mismatchedRead = async (url, init) => {
    if (String(url).endsWith(`/api/v2/projects/${projectId}`)) return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, resource: { type: "project", id: projectId, revision: "1", projectionSha256: hash }, data: { name: "wrong", description: null, estimatedStart: null, estimatedEnd: null, organizationPublicId: organization.expectedPublicId, clientPublicId: null } });
    return fetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: mismatchedRead }), { code: "read_after_create_mismatch" });

  const { fetcher: freshFetcher } = fixtureFetcher();
  const badInventory = async (url, init) => {
    if (String(url).includes("/inventory?limit=20")) return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, authorizationGeneration: "1", projects: [{ externalId: "wrong", publicId: projectId, revision: "2", projectionSha256: hash, status: "not_started", archived: false }], nextCursor: null });
    return freshFetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: badInventory }), { code: "created_project_missing_from_inventory" });

  const { fetcher: statusFetcher } = fixtureFetcher();
  const badStatus = async (url, init) => {
    if (String(url).includes("/bindings/status/")) return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, authorizationGeneration: "1", binding: { externalId: "wrong", publicId: projectId, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:01Z" }, resource: { revision: "2", projectionSha256: hash, status: "not_started", archived: false } });
    return statusFetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: badStatus }), { code: "invalid_binding_status" });
});

test("replays lifecycle commands exactly and rejects changed valid bodies without deleting fixtures", async () => {
  const config = parseAcceptanceConfig(env({
    PA_ACCEPTANCE_ALLOW_LIFECYCLE: "allow",
    PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON: JSON.stringify({ projectPublicId: projectId, expectedRevision: "2", expectedProjectionSha256: updatedHash, expectedName: `${prefix} Project 2026-09-1x`, publicLinkUrl: "https://public.example.test/project", enabledStatus: 200, disabledStatus: 404 }),
  }));
  const { fetcher } = fixtureFetcher();
  const receipts = new Map();
  let publicVisible = true;
  const lifecycleFetcher = async (url, init = {}) => {
    const text = String(url);
    if (text.startsWith("https://public.example.test/")) return new Response("", { status: publicVisible ? 200 : 404 });
    const parsed = new URL(text);
    if (parsed.pathname === "/api/v2/capabilities") {
      const body = capabilities();
      for (const [feature, scope, method, path] of [["projects_archive", "projects.lifecycle.archive", "POST", "/api/v2/projects/{publicId}/archive/commands"], ["projects_restore", "projects.lifecycle.restore", "POST", "/api/v2/projects/{publicId}/restore/commands"]]) {
        body.implementedEndpoints.push({ method, path, requiredCapability: scope, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true });
        body.grantedCapabilities.push({ name: scope });
      }
      return response(body);
    }
    if (parsed.pathname.endsWith("/archive/commands") || parsed.pathname.endsWith("/restore/commands")) {
      const body = JSON.parse(init.body);
      const key = `${parsed.pathname}:${body.commandId}`;
      const fingerprint = JSON.stringify(body);
      const prior = receipts.get(key);
      if (prior && prior !== fingerprint) return response({}, 409);
      const replayed = Boolean(prior);
      receipts.set(key, fingerprint);
      if (!replayed && parsed.pathname.endsWith("/archive/commands")) publicVisible = false;
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, replayed, accepted: true,
        resource: { type: "project", id: projectId, revision: parsed.pathname.endsWith("/archive/commands") ? "3" : "4" },
        result: { status: "not_started", completedAt: null, archived: parsed.pathname.endsWith("/archive/commands"), archivedAt: parsed.pathname.endsWith("/archive/commands") ? "2026-09-17T00:00:02Z" : null, presentation: { portalPublished: false, publicLinkEnabled: false } } });
    }
    return fetcher(url, init);
  };
  const uuids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"];
  const report = await runPaApiV2StagingAcceptance(config, { fetcher: lifecycleFetcher, uuid: () => uuids.shift(), now: () => Date.UTC(2026, 8, 17) });
  assert.equal(report.stages.lifecycle.archive.replay.replayed, true);
  assert.equal(report.stages.lifecycle.archive.changedBody.status, 409);
  assert.equal(report.stages.lifecycle.restore.replay.replayed, true);
  assert.equal(report.stages.lifecycle.restore.changedBody.status, 409);
  assert.deepEqual(report.stages.lifecycle.publicLink, { before: 200, archived: 404, restored: 404 });
});

test("lifecycle-only mode calls only capability, fixture read, archive, restore, and public-link routes", async () => {
  const config = parseAcceptanceConfig(env({
    PA_ACCEPTANCE_LIFECYCLE_ONLY: "allow", PA_ACCEPTANCE_ALLOW_LIFECYCLE: "allow",
    PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: undefined, PA_ACCEPTANCE_PROJECT_PROFILE_JSON: undefined,
    PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON: JSON.stringify({ projectPublicId: projectId, expectedRevision: "2", expectedProjectionSha256: updatedHash, expectedName: `${prefix} Project`, publicLinkUrl: "https://public.example.test/project", enabledStatus: 200, disabledStatus: 404 }),
  }));
  const calls = [];
  const receipts = new Map();
  let publicVisible = true;
  const fetcher = async (url, init = {}) => {
    const text = String(url);
    calls.push({ text, method: init.method || "GET" });
    if (text.startsWith("https://public.example.test/")) return new Response("", { status: publicVisible ? 200 : 404 });
    const parsed = new URL(text);
    if (parsed.pathname === "/api/v2/capabilities") {
      const body = capabilities();
      for (const [scope, path] of [["projects.lifecycle.archive", "/api/v2/projects/{publicId}/archive/commands"], ["projects.lifecycle.restore", "/api/v2/projects/{publicId}/restore/commands"]]) {
        body.implementedEndpoints.push({ method: "POST", path, requiredCapability: scope, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true });
        body.grantedCapabilities.push({ name: scope });
      }
      return response(body);
    }
    if (parsed.pathname === `/api/v2/projects/${projectId}`) return response({
      apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
      resource: { type: "project", id: projectId, revision: "2", projectionSha256: updatedHash },
      data: { name: `${prefix} Project`, status: "not_started", completedAt: null, archived: false, archivedAt: null },
    });
    if (parsed.pathname === "/api/v2/projects/inventory" || parsed.pathname === "/api/v2/projects/commands" || parsed.pathname === "/api/v2/projects/profile/commands" || parsed.pathname.includes("/bindings/status/"))
      throw new Error(`forbidden lifecycle-only call: ${parsed.pathname}`);
    if (parsed.pathname.endsWith("/archive/commands") || parsed.pathname.endsWith("/restore/commands")) {
      const body = JSON.parse(init.body);
      const key = `${parsed.pathname}:${body.commandId}`;
      const fingerprint = JSON.stringify(body);
      const prior = receipts.get(key);
      if (prior && prior !== fingerprint) return response({}, 409);
      const replayed = Boolean(prior);
      receipts.set(key, fingerprint);
      const archive = parsed.pathname.endsWith("/archive/commands");
      if (!replayed && archive) publicVisible = false;
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, replayed, accepted: true,
        resource: { type: "project", id: projectId, revision: archive ? "3" : "4" },
        result: { status: "not_started", completedAt: null, archived: archive, archivedAt: archive ? "2026-09-17T00:00:02Z" : null, presentation: { portalPublished: false, publicLinkEnabled: false } } });
    }
    throw new Error(`unexpected lifecycle-only call: ${parsed.pathname}`);
  };
  const uuids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"];
  const report = await runPaApiV2StagingAcceptance(config, { fetcher, uuid: () => uuids.shift(), now: () => Date.UTC(2026, 8, 17) });
  assert.equal(report.status, "passed");
  assert.equal(report.mutationsPerformed, true);
  assert.deepEqual(report.stages.lifecycle.publicLink, { before: 200, archived: 404, restored: 404 });
  assert.equal(calls.some(call => call.text.includes("/inventory") || call.text.includes("/profile/commands") || call.text.includes("/bindings/status/")), false);
  assert.equal(calls.some(call => call.text.endsWith("/api/v2/projects/commands")), false);
  assert.equal(calls.filter(call => call.text.endsWith("/api/v2/capabilities")).length, 1);
  assert.equal(calls.filter(call => call.text.endsWith(`/api/v2/projects/${projectId}`)).length, 1);
});

test("lifecycle-only mode rejects missing or surplus advertised Project capabilities", async () => {
  const config = parseAcceptanceConfig(env({
    PA_ACCEPTANCE_LIFECYCLE_ONLY: "allow", PA_ACCEPTANCE_ALLOW_LIFECYCLE: "allow",
    PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: undefined, PA_ACCEPTANCE_PROJECT_PROFILE_JSON: undefined,
    PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON: JSON.stringify({ projectPublicId: projectId, expectedRevision: "2", expectedProjectionSha256: updatedHash, expectedName: `${prefix} Project`, publicLinkUrl: "https://public.example.test/project", enabledStatus: 200, disabledStatus: 404 }),
  }));
  const lifecycleCapabilities = () => {
    const body = capabilities();
    for (const [scope, path] of [["projects.lifecycle.archive", "/api/v2/projects/{publicId}/archive/commands"], ["projects.lifecycle.restore", "/api/v2/projects/{publicId}/restore/commands"]]) {
      body.implementedEndpoints.push({ method: "POST", path, requiredCapability: scope, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true });
      body.grantedCapabilities.push({ name: scope });
    }
    return body;
  };
  const missing = async url => {
    const body = lifecycleCapabilities();
    body.grantedCapabilities = body.grantedCapabilities.filter(item => item.name !== "projects.binding_status.read");
    return response(body);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: missing }), { code: "missing_route_or_scope_status" });
  const surplus = async url => {
    const body = lifecycleCapabilities();
    body.grantedCapabilities.push({ name: "projects.lifecycle.cancel" });
    return response(body);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: surplus }), { code: "unexpected_route_or_scope_advertised" });
});

test("rejects added or reordered lifecycle envelope and resource members", async () => {
  const config = parseAcceptanceConfig(env({ PA_ACCEPTANCE_ALLOW_LIFECYCLE: "allow",
    PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON: JSON.stringify({ projectPublicId: projectId, expectedRevision: "2", expectedProjectionSha256: updatedHash, expectedName: `${prefix} Project 2026-09-1x`, publicLinkUrl: "https://public.example.test/project", enabledStatus: 200, disabledStatus: 404 }),
  }));
  const { fetcher } = fixtureFetcher();
  const receipts = new Map();
  const malformedLifecycle = async (url, init = {}) => {
    const text = String(url); const parsed = new URL(text);
    if (text.startsWith("https://public.example.test/")) return new Response("", { status: 200 });
    if (parsed.pathname === "/api/v2/capabilities") {
      const body = capabilities();
      for (const [scope, path] of [["projects.lifecycle.archive", "/api/v2/projects/{publicId}/archive/commands"], ["projects.lifecycle.restore", "/api/v2/projects/{publicId}/restore/commands"]]) {
        body.implementedEndpoints.push({ method: "POST", path, requiredCapability: scope, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }); body.grantedCapabilities.push({ name: scope });
      }
      return response(body);
    }
    if (parsed.pathname.endsWith("/archive/commands") || parsed.pathname.endsWith("/restore/commands")) {
      const body = JSON.parse(init.body); const key = `${parsed.pathname}:${body.commandId}`; const fingerprint = JSON.stringify(body); const prior = receipts.get(key);
      if (prior && prior !== fingerprint) return response({}, 409); receipts.set(key, fingerprint);
      const archive = parsed.pathname.endsWith("/archive/commands");
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, replayed: Boolean(prior), accepted: true,
        resource: { id: projectId, type: "project", revision: archive ? "3" : "4", unexpected: true },
        result: { status: "not_started", completedAt: null, archived: archive, archivedAt: archive ? "2026-09-17T00:00:02Z" : null, presentation: { portalPublished: false, publicLinkEnabled: false } } });
    }
    return fetcher(url, init);
  };
  const values = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"];
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: malformedLifecycle, uuid: () => values.shift(), now: () => Date.UTC(2026, 8, 17) }), { code: "invalid_replay_archive" });
});

test("derives bind and refresh command IDs and generations from this run's CAS sequence", async () => {
  const bindTarget = "e".repeat(32);
  const refreshTarget = "f".repeat(32);
  const targetHash = "c".repeat(64);
  const config = parseAcceptanceConfig(env({
    PA_ACCEPTANCE_BIND_COMMAND_JSON: JSON.stringify({ externalId: `${prefix}:bind-target`, expectedPublicId: bindTarget, expectedName: "Reviewed bind target" }),
    PA_ACCEPTANCE_REFRESH_COMMAND_JSON: JSON.stringify({ externalId: `${prefix}:refresh-target`, expectedPublicId: refreshTarget, expectedPriorRevision: "2" }),
  }));
  const { fetcher } = fixtureFetcher();
  const receipts = new Map();
  const derived = [];
  const commandFetcher = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v2/capabilities") {
      const body = capabilities();
      for (const [scope, path] of [["projects.bind", "/api/v2/projects/bindings/commands"], ["projects.binding.revision.refresh", "/api/v2/projects/bindings/revisions/commands"]]) {
        body.implementedEndpoints.push({ method: "POST", path, requiredCapability: scope, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true });
        body.grantedCapabilities.push({ name: scope });
      }
      return response(body);
    }
    if (parsed.pathname === `/api/v2/projects/${bindTarget}` || parsed.pathname === `/api/v2/projects/${refreshTarget}`) {
      const isBind = parsed.pathname.endsWith(bindTarget);
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
        resource: { type: "project", id: isBind ? bindTarget : refreshTarget, revision: isBind ? "7" : "3", projectionSha256: targetHash },
        data: { name: isBind ? "Reviewed bind target" : "Refresh target" } });
    }
    if (parsed.pathname.endsWith("/bindings/commands") || parsed.pathname.endsWith("/bindings/revisions/commands")) {
      const body = JSON.parse(init.body);
      derived.push(body);
      const fingerprint = JSON.stringify(body);
      const key = `${parsed.pathname}:${body.commandId}`;
      const prior = receipts.get(key);
      if (prior && prior !== fingerprint) return response({}, 409);
      const replayed = Boolean(prior); receipts.set(key, fingerprint);
      const isBind = parsed.pathname.endsWith("/bindings/commands");
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, replayed,
        result: { resource: { type: "project", id: body.externalId, publicId: isBind ? bindTarget : refreshTarget, revision: isBind ? "7" : "3", projectionSha256: targetHash }, authorizationGeneration: isBind ? "2" : "3", presentation: { portalPublished: false, publicLinkEnabled: false } } });
    }
    return fetcher(url, init);
  };
  const uuids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5"];
  await runPaApiV2StagingAcceptance(config, { fetcher: commandFetcher, uuid: () => uuids.shift(), now: () => Date.UTC(2026, 8, 17) });
  assert.deepEqual(derived[0], { commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", externalId: `${prefix}:bind-target`, expectedPublicId: bindTarget, expectedRevision: "7", expectedProjectionSha256: targetHash, expectedAuthorizationGeneration: "1" });
  assert.deepEqual(derived[3], { commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", externalId: `${prefix}:refresh-target`, expectedPublicId: refreshTarget, expectedPriorRevision: "2", expectedRevision: "3", expectedProjectionSha256: targetHash, expectedAuthorizationGeneration: "2" });
});

test("paginates post-update inventory until it finds the created project", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  const paged = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v2/projects/inventory" && parsed.search === "?limit=200") {
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, authorizationGeneration: "1",
        projects: [{ externalId: "other-project", publicId: "d".repeat(32), revision: "1", projectionSha256: "f".repeat(64), status: "not_started", archived: false }], nextCursor: `${prefix}:page-2` });
    }
    return fetcher(url, init);
  };
  const report = await runPaApiV2StagingAcceptance(config, { fetcher: paged, uuid: (() => {
    const values = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"];
    return () => values.shift();
  })(), now: () => Date.UTC(2026, 8, 17) });
  assert.equal(report.stages.inventory.pageCount, 2);
  assert.equal(report.stages.inventory.projectCount, 2);
});

test("allows PA's documented 256 KiB inventory response bound without raising other route bounds", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  const oversizedInventoryHeader = async (url, init) => {
    if (String(url).includes("/inventory?limit=200")) return new Response(JSON.stringify({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "44444444-4444-4444-8444-444444444444", authorizationGeneration: "1", projects: [], nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "x-request-id": "44444444-4444-4444-8444-444444444444", "content-length": "70000" },
    });
    return fetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: oversizedInventoryHeader }), { code: "created_project_missing_from_inventory" });
});

test("fails closed on surplus advertised routes or capabilities", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  const surplus = async (url, init) => {
    if (String(url).endsWith("/api/v2/capabilities")) {
      const body = capabilities();
      body.implementedEndpoints.push({ method: "POST", path: "/api/v2/projects/{publicId}/cancel/commands", requiredCapability: "projects.lifecycle.cancel" });
      body.grantedCapabilities.push({ name: "projects.lifecycle.cancel" });
      return response(body);
    }
    return fetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: surplus }), { code: "unexpected_route_or_scope_advertised" });
});

test("rejects duplicate, reordered, and oversized PA wire-contract members", async () => {
  assert.throws(() => parseAcceptanceConfig(env({ PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON: JSON.stringify({ ...organization, expectedRevision: "1".repeat(20) }) })), { code: "invalid_pa_acceptance_organization_binding_json" });
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  const duplicateCapability = async (url, init) => {
    if (String(url).endsWith("/api/v2/capabilities")) {
      const body = capabilities(); body.grantedCapabilities.push({ name: "projects.create" }); return response(body);
    }
    return fetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: duplicateCapability }), { code: "unexpected_route_or_scope_advertised" });

  const { fetcher: syncFetcher } = fixtureFetcher();
  let createFingerprint;
  const reorderedSync = async (url, init) => {
    if (String(url).endsWith("/api/v2/projects/commands")) {
      const body = JSON.parse(init.body);
      const fingerprint = JSON.stringify(body);
      if (createFingerprint && createFingerprint !== fingerprint) return response({}, 409);
      createFingerprint = fingerprint;
      return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, replayed: false,
        result: { authorizationGeneration: "1", resource: { type: "project", id: body.externalId, publicId: projectId, revision: "1", projectionSha256: hash }, presentation: { portalPublished: false, publicLinkEnabled: false } } }, 201);
    }
    return syncFetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: reorderedSync }), { code: "invalid_replay_create" });

  const { fetcher: readFetcher } = fixtureFetcher();
  const extraReadMember = async (url, init) => {
    const upstream = await readFetcher(url, init);
    if (!String(url).endsWith(`/api/v2/projects/${projectId}`)) return upstream;
    const body = await upstream.json();
    return response({ ...body, data: { ...body.data, unexpected: true } });
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: extraReadMember }), { code: "read_after_create_mismatch" });
});

test("rejects malformed UTF-8 API responses before JSON parsing", async () => {
  const config = parseAcceptanceConfig({ PA_BASE_URL: "https://pa-staging.example.test" });
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: async () => new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x7d]), {
    status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" },
  }) }), { code: "invalid_json_response" });
});

test("requires controller request IDs on conflicts and matching request IDs on reads", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  let createPosts = 0;
  const missingConflictId = async (url, init) => {
    if (String(url).endsWith("/api/v2/projects/commands") && init.method === "POST" && ++createPosts === 3) {
      return new Response("{}", { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return fetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: missingConflictId }), { code: "missing_conflict_request_id_create" });

  const { fetcher: readFetcher } = fixtureFetcher();
  const mismatchedReadId = async (url, init) => {
    if (String(url).endsWith(`/api/v2/projects/${projectId}`)) return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: "55555555-5555-4555-8555-555555555555", resource: { type: "project", id: projectId, revision: "1", projectionSha256: hash }, data: { name: `${prefix} Project 2026-09-17`, description: null, estimatedStart: null, estimatedEnd: null, organizationPublicId: organization.expectedPublicId, clientPublicId: null } });
    return readFetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: mismatchedReadId }), { code: "response_request_id_mismatch" });
});

test("fails closed when capabilities do not grant the requested mutable route", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher } = fixtureFetcher();
  const denied = async (url, init) => {
    if (String(url).endsWith("/api/v2/capabilities")) {
      const body = capabilities();
      body.grantedCapabilities = body.grantedCapabilities.filter(capability => capability.name !== "projects.write");
      return response(body);
    }
    return fetcher(url, init);
  };
  await assert.rejects(runPaApiV2StagingAcceptance(config, { fetcher: denied }), { code: "missing_route_or_scope_write" });
});

test("authenticated baseline is read-only and validates the bound identity", async () => {
  const config = parseAcceptanceConfig({ PA_BASE_URL: "https://pa-staging.example.test", PA_API_TOKEN: token,
    PA_SOURCE_INSTANCE_ID: source, PA_APPLICATION_ID: application, PA_HISTORY_EPOCH: epoch });
  const report = await runPaApiV2StagingAcceptance(config, { fetcher: async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-pa-source-instance-id"], undefined);
    return response({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
      implementedEndpoints: [], grantedCapabilities: [{ name: "api.capabilities.read" }] });
  } });
  assert.equal(report.mutationsPerformed, false);
  assert.equal(JSON.stringify(report).includes(token), false);
});

test("no-key baseline proves authentication and default-off routing", async () => {
  const config = parseAcceptanceConfig({ PA_BASE_URL: "https://pa-staging.example.test" });
  const responses = [
    response({ error: "Unauthorized" }, 401),
    response({ error: "Not found" }, 404),
  ];
  const report = await runPaApiV2StagingAcceptance(config, {
    fetcher: async (_url, init) => {
      assert.equal(init.headers.authorization, undefined);
      return responses.shift();
    },
  });
  assert.equal(report.mutationsPerformed, false);
  assert.equal(report.stages.capabilitiesNoKey.status, 401);
  assert.equal(report.stages.projectsDefaultOff.status, 404);
});
