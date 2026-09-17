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
  return Response.json(payload, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
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
    implementedEndpoints: routes.map(([, scope, method, path]) => ({ method, path, requiredCapability: scope })),
    grantedCapabilities: [{ name: "api.capabilities.read" }, ...routes.map(([, scope]) => ({ name: scope }))] };
}

function fixtureFetcher() {
  const calls = [];
  const created = { publicId: projectId, revision, projectionSha256: hash };
  const identity = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch };
  const commandState = new Map();
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v2/capabilities") return response(capabilities());
    if (parsed.pathname === `/api/v2/projects/${projectId}`) return response({ ...identity, resource: { type: "project", id: projectId, revision: "2", projectionSha256: hash }, data: { name: "pa-acceptance-test Project", description: null } });
    if (parsed.pathname === "/api/v2/projects/inventory") {
      const externalId = [...commandState.values()][0]?.externalId;
      return response({ ...identity, authorizationGeneration: externalId ? "1" : "0", projects: externalId ? [{ externalId, publicId: projectId, revision: "2", projectionSha256: hash }] : [], nextCursor: null });
    }
    if (parsed.pathname.includes("/bindings/status/")) return response({ ...identity, authorizationGeneration: "1", binding: { externalId: [...commandState.values()][0]?.externalId, publicId: projectId }, resource: { revision: "2", projectionSha256: hash } });
    const body = JSON.parse(init.body);
    const prior = commandState.get(body.commandId);
    const fingerprint = JSON.stringify(body);
    if (prior && prior.fingerprint !== fingerprint) return response({}, 409);
    const replayed = Boolean(prior);
    commandState.set(body.commandId, { fingerprint, externalId: body.externalId });
    const isCreate = parsed.pathname === "/api/v2/projects/commands";
    return response({ ...identity, replayed, result: { resource: { type: "project", id: body.externalId, publicId: projectId, revision: isCreate ? "1" : "2", projectionSha256: hash }, authorizationGeneration: isCreate ? "1" : "1", presentation: { portalPublished: false, publicLinkEnabled: false } } }, isCreate ? 201 : 200);
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
});

test("runs create/update replay and changed-body conflicts without exposing credentials or profile bodies", async () => {
  const config = parseAcceptanceConfig(env());
  const { fetcher, calls } = fixtureFetcher();
  const uuids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"];
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

test("baseline mode is read-only and omits mutation identity requirements", async () => {
  const config = parseAcceptanceConfig({ PA_BASE_URL: "https://pa-staging.example.test", PA_API_TOKEN: token });
  const report = await runPaApiV2StagingAcceptance(config, { fetcher: async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-pa-source-instance-id"], undefined);
    return response({ apiVersion: "2", implementedEndpoints: [], grantedCapabilities: [{ name: "api.capabilities.read" }] });
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
