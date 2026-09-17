import assert from "node:assert/strict";
import test from "node:test";
import { DIRECTORY_FLAGS, DIRECTORY_ROUTES, DirectoryAcceptanceError, parseDirectoryAcceptanceConfig, runDirectoryAcceptance } from "./pa-api-v2-directory-staging-acceptance.mjs";

const sourceInstanceId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const prefix = "pa-directory-acceptance-test";
const profile = {
  organization: { name: "Acceptance Organization", generalEmail: "organization@example.test", generalPhone: "555-0100", addressLine1: "1 Main", addressLine2: "", city: "Madison", state: "WI", postalCode: "53703", country: "US" },
  moveOrganization: { name: "Move Organization", generalEmail: "move@example.test", generalPhone: "555-0101", addressLine1: "2 Main", addressLine2: "", city: "Madison", state: "WI", postalCode: "53703", country: "US" },
  client: { name: "Acceptance Client", email: "client@example.test", phone: "555-0102", clientType: "business", addressLine1: "3 Main", addressLine2: "", city: "Madison", state: "WI", postalCode: "53703", country: "US" },
};

function environment(overrides = {}) {
  return {
    PA_DIRECTORY_BASE_URL: "https://pa-staging.example.test",
    PA_DIRECTORY_API_TOKEN: "directory-test-secret",
    PA_DIRECTORY_ACCEPTANCE_ALLOW_MUTATIONS: "allow",
    PA_DIRECTORY_ACCEPTANCE_PREFIX: prefix,
    PA_SOURCE_INSTANCE_ID: sourceInstanceId,
    PA_APPLICATION_ID: applicationId,
    PA_HISTORY_EPOCH: historyEpoch,
    PA_DIRECTORY_ORGANIZATION_PROFILE_JSON: JSON.stringify(profile.organization),
    PA_DIRECTORY_MOVE_ORGANIZATION_PROFILE_JSON: JSON.stringify(profile.moveOrganization),
    PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify(profile.client),
    PA_DIRECTORY_ACCEPTANCE_MIN_REQUEST_INTERVAL_MS: "0",
    ...overrides,
  };
}

const copy = (value) => structuredClone(value);
const increment = (value) => String(BigInt(value) + 1n);
const external = (value) => Buffer.from(value, "utf8").toString("base64url");
const response = (payload, status = 200, headers = {}) => new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId, ...headers } });
const error = (status) => response({ error: "conflict" }, status);
const identity = () => ({ sourceInstanceId, applicationId, historyEpoch, requestId });
const resourceId = (number) => number.toString(16).padStart(32, "a");

function commandKeys(path) {
  if (path.includes("/profile/")) return ["commandId", "expectedRevision", "expectedAuthorizationGeneration", "profile"];
  if (path.includes("/bindings/revisions/")) return ["commandId", "externalId", "expectedPriorRevision", "expectedLiveRevision", "expectedAuthorizationGeneration"];
  if (path.includes("/bindings/revoke/")) return ["commandId", "externalId", "expectedPublicId", "expectedRevision", "expectedAuthorizationGeneration"];
  if (path.includes("/bindings/commands")) return ["commandId", "externalId", "expectedPublicId", "expectedRevision"];
  if (path.includes("/organization/") && path.includes("/commands")) return ["commandId", "expectedClientRevision", "expectedAuthorizationGeneration", "expectedCurrentOrganizationPublicId", "organization"];
  if (path.includes("/archive/") || path.includes("/restore/")) return ["commandId", "expectedRevision", "expectedAuthorizationGeneration"];
  if (path.endsWith("/organizations/commands")) return ["commandId", "externalId", "expectedAuthorizationGeneration", "profile"];
  return ["commandId", "externalId", "expectedAuthorizationGeneration", "profile", "organization"];
}

function happyFetcher(options = {}) {
  const resources = new Map();
  const receipts = new Map();
  let generation = "0";
  let nextResource = 1;
  let rebindSucceeded = false;
  const alter = (kind, payload) => {
    const value = copy(payload);
    if (options.corrupt === kind) {
      if (kind === "capabilities") value.unexpected = true;
      else if (kind === "read") value.data.unexpected = true;
      else if (kind === "status") value.binding.unexpected = true;
      else if (kind === "inventory") { if (value.resources.length) value.resources[0].unexpected = true; else value.unexpected = true; }
      else value.result.unexpected = true;
    }
    if (options.omit === kind) {
      if (kind === "capabilities") delete value.implementedEndpoints;
      else if (kind === "read") delete value.data.address;
      else if (kind === "status") delete value.resource;
      else if (kind === "inventory") delete value.resources;
      else delete value.result;
    }
    if (options.invalidSigned64 === kind) {
      if (kind === "inventory") value.authorizationGeneration = "9223372036854775808";
      else if (kind === "create") value.result.resource.revision = "9223372036854775808";
    }
    if (options.wrongTransition === "bind" && kind === "status" && rebindSucceeded) value.authorizationGeneration = String(BigInt(value.authorizationGeneration) - 1n);
    const transition = kind === "lifecycle" ? value.result?.action : kind;
    if (options.wrongTransition === transition) {
      if (transition === "create") value.result.resource.revision = "2";
      else if (transition === "profile") value.result.authorizationGeneration = increment(value.result.authorizationGeneration);
      else if (transition === "refresh") value.result.binding.authorizationGeneration = "0";
      else if (transition === "relationship") value.result.client.revision = "1";
      else if (transition === "archive" || transition === "restore") value.result.authorizationGeneration = "0";
    }
    return value;
  };
  const send = (kind, payload, status = 200) => response(alter(kind, payload), status);
  const receipt = (command, path, make) => {
    const fingerprint = JSON.stringify(command);
    const prior = receipts.get(command.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint || prior.path !== path) return error(409);
      const replayed = copy(prior.payload); replayed.replayed = true;
      return send(prior.kind, replayed, 200);
    }
    const created = make();
    if (created.status !== 200 && created.status !== 201) return error(created.status);
    receipts.set(command.commandId, { fingerprint, path, kind: created.kind, payload: copy(created.payload) });
    return send(created.kind, created.payload, created.status);
  };
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
    if (parsed.pathname === "/api/v2/capabilities") {
      if (!init.headers.authorization) return error(401);
      const payload = { apiVersion: "2", ...identity(), grantedCapabilities: ["api.capabilities.read", ...DIRECTORY_ROUTES.map((route) => route.requiredCapability)].map((name) => ({ name })), implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, ...DIRECTORY_ROUTES] };
      return send("capabilities", payload);
    }
    assert.equal(init.headers["x-pa-source-instance-id"], sourceInstanceId);
    assert.equal(init.headers["x-pa-application-id"], applicationId);
    assert.equal(init.headers["x-pa-history-epoch"], historyEpoch);
    if (parsed.pathname.startsWith("/api/v2/directory/inventory")) {
      assert.equal(parsed.searchParams.get("type"), "all"); assert.equal(parsed.searchParams.get("limit"), "2");
      if (options.oversizedInventory) return response({}, 200, { "content-length": String(256 * 1024 + 1) });
      const orderedResources = [...resources.values()].sort((left, right) => `${left.type}:${left.publicId}`.localeCompare(`${right.type}:${right.publicId}`));
      const cursor = parsed.searchParams.get("cursor");
      const start = cursor === null ? 0 : orderedResources.findIndex((item) => `${item.type}:${item.publicId}` > cursor);
      const page = orderedResources.slice(start < 0 ? orderedResources.length : start, (start < 0 ? orderedResources.length : start) + 2);
      const nextCursor = start + page.length < orderedResources.length ? `${page.at(-1).type}:${page.at(-1).publicId}` : null;
      const items = page.map((item) => ({ type: item.type, publicId: item.publicId, revision: item.revision, present: item.present, lastAction: item.present ? "upsert" : "delete", projectionSha256: item.hash, binding: { externalId: item.externalId, status: item.bindingStatus, resourceRevision: item.bindingRevision } }));
      const inventoryGeneration = options.inventoryGenerationChanges && cursor !== null ? increment(generation) : generation;
      return send("inventory", { ...identity(), authorizationGeneration: inventoryGeneration, resources: items, nextCursor });
    }
    if (parsed.pathname.includes("/bindings/") && parsed.pathname.includes("/status/")) {
      const [, type] = parsed.pathname.match(/\/bindings\/(client|organization)\/status\//) || [];
      const item = [...resources.values()].find((resource) => resource.type === type && external(resource.externalId) === parsed.pathname.split("/").at(-1));
      if (!item) return error(404);
      if (item.bindingStatus === "tombstoned") return error(410);
      if (!item.present || item.bindingRevision !== item.revision) return error(409);
      return send("status", { apiVersion: "2", sourceInstanceId, historyEpoch, authorizationGeneration: generation, binding: { type, externalId: item.externalId, publicId: item.publicId, createdAt: "2026-09-17T12:00:00.000Z" }, resource: { revision: item.revision, present: true }, applicationId, requestId });
    }
    if (init.method === "GET") {
      const match = parsed.pathname.match(/^\/api\/v2\/directory\/(clients|organizations)\/([0-9a-f]{32})$/);
      assert(match); const type = match[1] === "clients" ? "client" : "organization"; const item = resources.get(match[2]);
      assert(item); assert.equal(item.type, type); assert.equal(item.present, true);
      const readNullable = (value) => value === "" ? null : value;
      const data = { publicId: item.publicId, name: item.profile.name, email: readNullable(type === "client" ? item.profile.email : item.profile.generalEmail), phone: readNullable(type === "client" ? item.profile.phone : item.profile.generalPhone), address: { line1: item.profile.addressLine1, line2: readNullable(item.profile.addressLine2), city: item.profile.city, state: item.profile.state, postalCode: item.profile.postalCode, country: item.profile.country } };
      if (type === "client") { data.clientType = item.profile.clientType; data.organizationPublicId = item.organizationPublicId; }
      return send("read", { apiVersion: "2", ...identity(), authorizationGeneration: generation, resource: { type, id: item.publicId, revision: item.revision }, data });
    }
    assert.equal(init.method, "POST"); assert.equal(init.headers["content-type"], "application/json; charset=utf-8");
    const command = JSON.parse(init.body); assert.deepEqual(Object.keys(command), commandKeys(parsed.pathname));
    return receipt(command, parsed.pathname, () => {
      if (parsed.pathname.endsWith("/organizations/commands") || parsed.pathname.endsWith("/clients/commands")) {
        const type = parsed.pathname.endsWith("/clients/commands") ? "client" : "organization";
        assert.equal(command.expectedAuthorizationGeneration, generation);
        options.onCreate?.(type, copy(command.profile));
        const publicId = resourceId(nextResource++); generation = increment(generation);
        const item = { type, publicId, externalId: command.externalId, revision: "1", present: true, bindingStatus: "active", bindingRevision: "1", profile: copy(command.profile), hash: "a".repeat(64), organizationPublicId: command.organization === null ? null : undefined };
        resources.set(publicId, item);
        return { kind: "create", status: 201, payload: { ...identity(), replayed: false, result: { resource: { type, id: command.externalId, publicId, revision: "1" }, authorizationGeneration: generation } } };
      }
      const type = parsed.pathname.includes("/directory/organizations/") || parsed.pathname.includes("/bindings/organization/") ? "organization" : "client";
      const publicId = parsed.pathname.match(/\/directory\/(?:clients|organizations)\/([0-9a-f]{32})/)?.[1] || command.expectedPublicId || [...resources.values()].find((resource) => resource.type === type && resource.externalId === command.externalId)?.publicId;
      const item = resources.get(publicId); assert(item); assert.equal(item.type, type);
      if (parsed.pathname.includes("/profile/")) {
        assert.equal(command.expectedRevision, item.revision); assert.equal(command.expectedAuthorizationGeneration, generation);
        // Profile writes advance the resource revision but, at 33e623ac, do
        // not advance the application authorization generation. Refresh owns
        // the next generation transition.
        item.profile = { ...item.profile, ...command.profile }; item.revision = increment(item.revision);
        return { kind: "profile", status: 200, payload: { ...identity(), replayed: false, result: { resource: { type, publicId, revision: item.revision }, authorizationGeneration: generation } } };
      }
      if (parsed.pathname.includes("/bindings/revisions/")) {
        assert.equal(command.externalId, item.externalId); assert.equal(command.expectedPriorRevision, item.bindingRevision); assert.equal(command.expectedLiveRevision, item.revision); assert.equal(command.expectedAuthorizationGeneration, generation); assert.notEqual(command.expectedPriorRevision, command.expectedLiveRevision);
        item.bindingRevision = item.revision; generation = increment(generation);
        return { kind: "refresh", status: 200, payload: { ...identity(), replayed: false, result: { resource: { type, id: item.externalId, revision: item.revision }, binding: { publicId, previousRevision: command.expectedPriorRevision, authorizationGeneration: generation } } } };
      }
      if (parsed.pathname.includes("/bindings/commands")) {
        assert.equal(command.externalId, item.externalId); assert.equal(command.expectedRevision, item.revision); assert.equal(item.bindingStatus, "tombstoned");
        item.bindingStatus = "active"; item.bindingRevision = item.revision; generation = increment(generation); rebindSucceeded = true;
        return { kind: "bind", status: 200, payload: { ...identity(), replayed: false, result: { resource: { type, id: item.externalId, revision: item.revision }, binding: { publicId } } } };
      }
      if (parsed.pathname.includes("/organization/") && parsed.pathname.includes("/commands")) {
        const action = parsed.pathname.match(/organization\/(assign|move|remove)\/commands/)?.[1]; assert(action);
        assert.equal(command.expectedClientRevision, item.revision); assert.equal(command.expectedAuthorizationGeneration, generation); assert.equal(command.expectedCurrentOrganizationPublicId, item.organizationPublicId);
        if (action === "remove") assert.equal(command.organization, null);
        else { const destination = resources.get(command.organization.publicId); assert(destination); assert.equal(destination.externalId, command.organization.externalId); assert.equal(destination.revision, command.organization.expectedRevision); item.organizationPublicId = destination.publicId; }
        if (action === "remove") item.organizationPublicId = null;
        item.revision = increment(item.revision); generation = increment(generation);
        return { kind: "relationship", status: 200, payload: { ...identity(), replayed: false, result: { action, client: { publicId, revision: item.revision }, organizationPublicId: item.organizationPublicId, authorizationGeneration: generation } } };
      }
      const action = parsed.pathname.includes("/archive/") ? "archive" : "restore";
      assert.equal(command.expectedRevision, item.revision); assert.equal(command.expectedAuthorizationGeneration, generation);
      item.present = action === "restore"; if (action === "archive") { item.bindingStatus = "tombstoned"; generation = increment(generation); } item.revision = increment(item.revision);
      return { kind: "lifecycle", status: 200, payload: { ...identity(), replayed: false, result: { action, resource: { type, publicId, revision: item.revision, present: item.present }, authorizationGeneration: generation } } };
    });
  };
}

function predictableUuid(start = 0) {
  let count = start;
  return () => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`;
}

test("runs the complete dynamic directory sequence with canonical request bodies and sanitized evidence", async () => {
  const report = await runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher(), uuid: predictableUuid() });
  assert.equal(report.status, "passed"); assert.equal(report.mutationsPerformed, true);
  assert.deepEqual(report.requiredFeatureFlags, DIRECTORY_FLAGS);
  assert.equal(report.stages.organizationCreate.first.status, 201); assert.equal(report.stages.clientCreate.replay.status, 200); assert.equal(report.stages.clientCreate.changedBody.status, 409);
  assert.equal(report.stages.organizationBindingStale.status, 409); assert.equal(report.stages.clientBindingStale.status, 409);
  assert.equal(report.stages.clientOrganizationAssignReadback.status, 200); assert.equal(report.stages.clientOrganizationMoveReadback.status, 200); assert.equal(report.stages.clientOrganizationRemoveReadback.status, 200);
  assert.equal(report.stages.lifecycleBinding.tombstone.status, 410); assert.equal(report.stages.lifecycleBinding.noAutoRebind.status, 410); assert.equal(report.stages.clientBindingRebind.replay.status, 200);
  assert.equal(report.stages.inventory.pages, 2);
  assert.deepEqual(report.stages.inventory.targetProjectionSha256, ["a".repeat(64), "a".repeat(64), "a".repeat(64)]);
  const evidence = JSON.stringify(report); assert.equal(evidence.includes("directory-test-secret"), false); assert.equal(evidence.includes(prefix), false); assert.equal(evidence.includes("Acceptance Client"), false);
});

test("gives every created organization a run-unique name, including the move organization", async () => {
  const captureOrganizationNames = async (uuid, acceptancePrefix) => {
    const names = [];
    await runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_ACCEPTANCE_PREFIX: acceptancePrefix })), {
      fetcher: happyFetcher({ onCreate: (type, createdProfile) => { if (type === "organization") names.push(createdProfile.name); } }),
      uuid,
    });
    return names;
  };
  const first = await captureOrganizationNames(predictableUuid(), "pa-directory-acceptance-first-run");
  const second = await captureOrganizationNames(predictableUuid(100), "pa-directory-acceptance-second-run");
  assert.equal(first.length, 2); assert.equal(second.length, 2);
  assert.match(first[0], /^Acceptance Organization [0-9a-f]{32} primary$/);
  assert.match(first[1], /^Move Organization [0-9a-f]{32} move$/);
  assert.notEqual(first[0], second[0]); assert.notEqual(first[1], second[1]);
  assert.equal(new Set([...first, ...second].map((name) => name.toLowerCase())).size, 4);
});

test("rejects invented fields in every capabilities and success-response family", async (context) => {
  for (const kind of ["capabilities", "create", "read", "status", "profile", "refresh", "relationship", "lifecycle", "bind", "inventory"]) {
    await context.test(kind, async () => {
      await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher({ corrupt: kind }), uuid: predictableUuid() }), DirectoryAcceptanceError);
    });
  }
});

test("rejects missing fields in every capabilities and success-response family", async (context) => {
  for (const kind of ["capabilities", "create", "read", "status", "profile", "refresh", "relationship", "lifecycle", "bind", "inventory"]) {
    await context.test(kind, async () => {
      await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher({ omit: kind }), uuid: predictableUuid() }), DirectoryAcceptanceError);
    });
  }
});

test("fails closed for an inventory response above the route-specific 256 KiB limit", async () => {
  await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher({ oversizedInventory: true }), uuid: predictableUuid() }), { code: "response_too_large" });
});

test("pins one authorization generation across every inventory page", async () => {
  await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher({ inventoryGenerationChanges: true }), uuid: predictableUuid() }), { code: "inventory_generation_changed_during_pagination" });
});

test("rejects incorrect Project Alpha transition deltas", async (context) => {
  for (const transition of ["create", "profile", "refresh", "relationship", "archive", "restore", "bind"]) {
    await context.test(transition, async () => {
      await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher({ wrongTransition: transition }), uuid: predictableUuid() }), DirectoryAcceptanceError);
    });
  }
});

test("rejects revision and generation values above signed-64 maximum", async () => {
  for (const kind of ["create", "inventory"]) {
    await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), { fetcher: happyFetcher({ invalidSigned64: kind }), uuid: predictableUuid() }), DirectoryAcceptanceError);
  }
});

test("default mode neither sends a key nor claims mutation identity", async () => {
  const report = await runDirectoryAcceptance(parseDirectoryAcceptanceConfig({ PA_DIRECTORY_BASE_URL: "https://pa-staging.example.test" }), { fetcher: async (_url, init) => { assert.equal(init.headers.authorization, undefined); return error(401); } });
  assert.equal(report.mutationsPerformed, false); assert.equal(report.stages.capabilitiesNoKey.status, 401);
});

test("models empty optional directory read fields as canonical null values", async () => {
  const emptyOptional = {
    ...profile.client,
    email: "",
    phone: "",
    addressLine2: "",
  };
  const config = parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify(emptyOptional) }));
  const report = await runDirectoryAcceptance(config, { fetcher: happyFetcher(), uuid: predictableUuid() });
  assert.equal(report.status, "passed");
});

test("retries bounded rate-limit responses, honors Retry-After, and reports pacing evidence", async () => {
  const base = happyFetcher();
  let throttled = 0;
  const sleeps = [];
  const report = await runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), {
    fetcher: async (url, init) => {
      if (throttled < 2) {
        throttled += 1;
        return response({ error: "rate_limited" }, 429, { "retry-after": "2" });
      }
      return base(url, init);
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    uuid: predictableUuid(),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.rateLimit.responses429, 2);
  assert.equal(report.rateLimit.retries, 2);
  assert.deepEqual(report.rateLimit.retryAfterMs, [2000, 2000]);
  assert.deepEqual(sleeps.slice(0, 2), [2000, 2000]);
});

test("fails closed after the bounded rate-limit retry budget", async () => {
  let calls = 0;
  await assert.rejects(runDirectoryAcceptance(parseDirectoryAcceptanceConfig(environment()), {
    fetcher: async () => { calls += 1; return response({ error: "rate_limited" }, 429, { "retry-after": "999999" }); },
    sleep: async () => {},
    uuid: predictableUuid(),
  }), { code: "rate_limit_retry_exhausted" });
  assert.equal(calls, 5);
});

test("rejects an unsafe request pacing interval", () => {
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_ACCEPTANCE_MIN_REQUEST_INTERVAL_MS: "60001" })), { code: "invalid_pa_directory_acceptance_min_request_interval_ms" });
});

test("configuration rejects incomplete Access credentials and client-type profile updates are not sent", () => {
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CF_ACCESS_CLIENT_ID: "id" })), { code: "incomplete_cloudflare_access_credentials" });
  const config = parseDirectoryAcceptanceConfig(environment());
  assert.equal(config.client.clientType, "business");
});

test("preflights PA profile rules and two distinct organization names before mutations", () => {
  const normalized = parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, email: "CLIENT@EXAMPLE.TEST" }) }));
  assert.equal(normalized.client.email, "client@example.test");
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_MOVE_ORGANIZATION_PROFILE_JSON: JSON.stringify({ ...profile.moveOrganization, name: "acceptance organization" }) })), { code: "directory_organization_names_not_distinct" });
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, state: "WIS" }) })), { code: "invalid_client_profile" });
  assert.doesNotThrow(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, name: "x".repeat(110) }) })));
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_ORGANIZATION_PROFILE_JSON: JSON.stringify({ ...profile.organization, name: "x".repeat(110) }) })), { code: "invalid_organization_profile" });
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, name: "bad\u0000name" }) })), { code: "invalid_client_profile" });
  for (const email of ["not-an-email", "a..b@example.com", ".a@example.com", "a.@example.com", "a@b..example.com", "a@-example.com", "a@example-.com"]) {
    assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, email }) })), { code: "invalid_client_profile" });
  }
  assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, clientType: "staff" }) })), { code: "invalid_client_profile" });
});

test("rejects PHP-invalid final domain labels during preflight, before a request can be made", () => {
  for (const email of ["a@b.1", "a@b.12", "a@b.123", "a@b.1c", "a@b.0a", "a@b.-c", "a@b.c-", "a@b..cc"]) {
    assert.throws(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, email }) })), { code: "invalid_client_profile" });
  }
  assert.doesNotThrow(() => parseDirectoryAcceptanceConfig(environment({ PA_DIRECTORY_CLIENT_PROFILE_JSON: JSON.stringify({ ...profile.client, email: "a@b.c1" }) })));
});

test("accepts maximum safe base organization names before a run begins", async () => {
  const names = [];
  const config = parseDirectoryAcceptanceConfig(environment({
    PA_DIRECTORY_ORGANIZATION_PROFILE_JSON: JSON.stringify({ ...profile.organization, name: "o".repeat(109) }),
    PA_DIRECTORY_MOVE_ORGANIZATION_PROFILE_JSON: JSON.stringify({ ...profile.moveOrganization, name: "m".repeat(109) }),
  }));
  await runDirectoryAcceptance(config, {
    fetcher: happyFetcher({ onCreate: (type, createdProfile) => { if (type === "organization") names.push(createdProfile.name); } }),
    uuid: predictableUuid(),
  });
  assert.deepEqual(names.map((name) => [...name].length), [150, 147]);
});

test("the contract has no hard-delete endpoint", () => {
  assert.equal(DIRECTORY_ROUTES.some((route) => /delete/i.test(route.path)), false);
});
