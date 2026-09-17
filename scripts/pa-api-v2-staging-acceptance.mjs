import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[0-9a-f]{32}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const FEATURE_ROUTES = {
  read: ["projects_read", "projects.v2.read", "GET", "/api/v2/projects/{publicId}"],
  create: ["projects_create", "projects.create", "POST", "/api/v2/projects/commands"],
  write: ["projects_write", "projects.write", "POST", "/api/v2/projects/profile/commands"],
  bind: ["projects_binding", "projects.bind", "POST", "/api/v2/projects/bindings/commands"],
  refresh: ["projects_binding_refresh", "projects.binding.revision.refresh", "POST", "/api/v2/projects/bindings/revisions/commands"],
  status: ["projects_binding_status", "projects.binding_status.read", "GET", "/api/v2/projects/bindings/status/{base64urlExternalId}"],
  inventory: ["projects_inventory", "projects.inventory.read", "GET", "/api/v2/projects/inventory"],
  archive: ["projects_archive", "projects.lifecycle.archive", "POST", "/api/v2/projects/{publicId}/archive/commands"],
  restore: ["projects_restore", "projects.lifecycle.restore", "POST", "/api/v2/projects/{publicId}/restore/commands"],
};

export class PaAcceptanceError extends Error {
  constructor(code) { super(code); this.name = "PaAcceptanceError"; this.code = code; }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new PaAcceptanceError(`missing_${name.toLowerCase()}`);
  return value.trim();
}

function parseJson(env, name, requiredValue = false) {
  const text = env[name];
  if (text === undefined || text === "") {
    if (requiredValue) throw new PaAcceptanceError(`missing_${name.toLowerCase()}`);
    return undefined;
  }
  try { return JSON.parse(text); } catch { throw new PaAcceptanceError(`invalid_${name.toLowerCase()}`); }
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function stringField(value, field, expression) {
  return typeof value?.[field] === "string" && expression.test(value[field]);
}

function parseBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new PaAcceptanceError("invalid_pa_base_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new PaAcceptanceError("invalid_pa_base_url");
  return url.origin;
}

function parseIdentity(env) {
  const identity = {
    sourceInstanceId: required(env, "PA_SOURCE_INSTANCE_ID"),
    applicationId: required(env, "PA_APPLICATION_ID"),
    historyEpoch: required(env, "PA_HISTORY_EPOCH"),
  };
  if (!Object.values(identity).every(value => UUID_V4.test(value))) throw new PaAcceptanceError("invalid_pa_identity");
  return identity;
}

function parseRelation(value, name, requiredValue) {
  if (value === undefined) {
    if (requiredValue) throw new PaAcceptanceError(`missing_${name}`);
    return null;
  }
  const fields = ["externalId", "expectedPublicId", "expectedRevision", "expectedProjectionSha256"];
  if (!exactKeys(value, fields) || !stringField(value, "expectedPublicId", PROJECT_ID) ||
      !stringField(value, "expectedRevision", POSITIVE_INTEGER) || !stringField(value, "expectedProjectionSha256", SHA256) ||
      typeof value.externalId !== "string" || value.externalId.length < 1 || value.externalId.length > 191)
    throw new PaAcceptanceError(`invalid_${name}`);
  return value;
}

function parseProjectProfile(value, prefix) {
  const fields = ["name", "description", "estimatedStart", "estimatedEnd"];
  if (!exactKeys(value, fields) || typeof value.name !== "string" || !value.name.startsWith(prefix) ||
      !["description", "estimatedStart", "estimatedEnd"].every(field => value[field] === null || typeof value[field] === "string"))
    throw new PaAcceptanceError("invalid_pa_acceptance_project_profile_json");
  return value;
}

function assertOptionalCommand(value, kind, prefix) {
  if (value === undefined) return undefined;
  const fields = kind === "bind"
    ? ["commandId", "externalId", "expectedPublicId", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration"]
    : ["commandId", "externalId", "expectedPublicId", "expectedPriorRevision", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration"];
  if (!exactKeys(value, fields) || !UUID_V4.test(value.commandId) || typeof value.externalId !== "string" ||
      !value.externalId.startsWith(prefix) || !PROJECT_ID.test(value.expectedPublicId) ||
      !POSITIVE_INTEGER.test(value.expectedRevision) || !SHA256.test(value.expectedProjectionSha256) ||
      !/^(0|[1-9][0-9]*)$/.test(value.expectedAuthorizationGeneration) ||
      (kind === "refresh" && !POSITIVE_INTEGER.test(value.expectedPriorRevision)))
    throw new PaAcceptanceError(`invalid_pa_acceptance_${kind}_command_json`);
  return value;
}

function parseLifecycleFixture(value, prefix) {
  if (value === undefined) return undefined;
  const keys = ["testLabel", "projectPublicId", "expectedRevision", "publicLinkUrl", "enabledStatus", "disabledStatus"];
  if (!exactKeys(value, keys) || typeof value.testLabel !== "string" || !value.testLabel.startsWith(prefix) ||
      !PROJECT_ID.test(value.projectPublicId) || !POSITIVE_INTEGER.test(value.expectedRevision) ||
      !Number.isInteger(value.enabledStatus) || !Number.isInteger(value.disabledStatus) ||
      value.enabledStatus < 200 || value.enabledStatus > 399 || value.disabledStatus < 400 || value.disabledStatus > 499)
    throw new PaAcceptanceError("invalid_pa_acceptance_lifecycle_fixture_json");
  let url;
  try { url = new URL(value.publicLinkUrl); } catch { throw new PaAcceptanceError("invalid_pa_acceptance_lifecycle_fixture_json"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new PaAcceptanceError("invalid_pa_acceptance_lifecycle_fixture_json");
  return value;
}

export function parseAcceptanceConfig(env = process.env) {
  const config = {
    baseUrl: parseBaseUrl(required(env, "PA_BASE_URL")),
    token: typeof env.PA_API_TOKEN === "string" && env.PA_API_TOKEN.trim() !== "" ? env.PA_API_TOKEN.trim() : undefined,
    cfAccessClientId: env.PA_CF_ACCESS_CLIENT_ID || undefined,
    cfAccessClientSecret: env.PA_CF_ACCESS_CLIENT_SECRET || undefined,
    mutate: env.PA_ACCEPTANCE_ALLOW_MUTATIONS === "allow",
    prefix: env.PA_ACCEPTANCE_PREFIX || "",
  };
  if ((config.cfAccessClientId && !config.cfAccessClientSecret) || (!config.cfAccessClientId && config.cfAccessClientSecret))
    throw new PaAcceptanceError("incomplete_cloudflare_access_service_credentials");
  if (!config.mutate) return config;
  config.token = required(env, "PA_API_TOKEN");
  if (!/^pa-acceptance-[a-z0-9][a-z0-9-]{2,60}$/i.test(config.prefix))
    throw new PaAcceptanceError("invalid_pa_acceptance_prefix");
  config.identity = parseIdentity(env);
  config.organization = parseRelation(parseJson(env, "PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON", true), "pa_acceptance_organization_binding_json", true);
  config.client = parseRelation(parseJson(env, "PA_ACCEPTANCE_CLIENT_BINDING_JSON"), "pa_acceptance_client_binding_json", false);
  config.project = parseProjectProfile(parseJson(env, "PA_ACCEPTANCE_PROJECT_PROFILE_JSON", true), config.prefix);
  config.exerciseStatus = env.PA_ACCEPTANCE_EXERCISE_STATUS === "allow";
  config.exerciseInventory = env.PA_ACCEPTANCE_EXERCISE_INVENTORY === "allow";
  config.bindCommand = assertOptionalCommand(parseJson(env, "PA_ACCEPTANCE_BIND_COMMAND_JSON"), "bind", config.prefix);
  config.refreshCommand = assertOptionalCommand(parseJson(env, "PA_ACCEPTANCE_REFRESH_COMMAND_JSON"), "refresh", config.prefix);
  config.lifecycleFixture = parseLifecycleFixture(parseJson(env, "PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON"), config.prefix);
  if (config.lifecycleFixture && env.PA_ACCEPTANCE_ALLOW_LIFECYCLE !== "allow")
    throw new PaAcceptanceError("lifecycle_requires_explicit_allow");
  return config;
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new PaAcceptanceError("response_too_large");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new PaAcceptanceError("response_too_large"); }
    chunks.push(value);
  }
  if (total === 0) return null;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(data)); } catch { throw new PaAcceptanceError("invalid_json_response"); }
}

function safeRequestId(response, payload) {
  const requestId = response.headers.get("x-request-id") || payload?.requestId;
  return typeof requestId === "string" && UUID_V4.test(requestId) ? requestId : null;
}

function sanitizePayload(payload) {
  const resource = payload?.resource || payload?.result?.resource;
  const presentation = payload?.result?.presentation || payload?.result?.presentation;
  const value = {
    requestId: typeof payload?.requestId === "string" && UUID_V4.test(payload.requestId) ? payload.requestId : null,
    replayed: typeof payload?.replayed === "boolean" ? payload.replayed : undefined,
    accepted: typeof payload?.accepted === "boolean" ? payload.accepted : undefined,
    authorizationGeneration: typeof payload?.authorizationGeneration === "string" && /^(0|[1-9][0-9]*)$/.test(payload.authorizationGeneration)
      ? payload.authorizationGeneration : undefined,
  };
  if (resource && typeof resource === "object") {
    value.resource = {
      id: typeof resource.id === "string" ? resource.id : undefined,
      publicId: typeof resource.publicId === "string" ? resource.publicId : undefined,
      revision: typeof resource.revision === "string" ? resource.revision : undefined,
      projectionSha256: typeof resource.projectionSha256 === "string" && SHA256.test(resource.projectionSha256) ? resource.projectionSha256 : undefined,
    };
  }
  if (presentation && typeof presentation === "object") {
    value.presentation = {
      portalPublished: typeof presentation.portalPublished === "boolean" ? presentation.portalPublished : undefined,
      publicLinkEnabled: typeof presentation.publicLinkEnabled === "boolean" ? presentation.publicLinkEnabled : undefined,
    };
  }
  return JSON.parse(JSON.stringify(value));
}

function requestHeaders(config, json = false, includeIdentity = false) {
  const headers = { accept: "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (json) headers["content-type"] = "application/json";
  if (config.cfAccessClientId) {
    headers["cf-access-client-id"] = config.cfAccessClientId;
    headers["cf-access-client-secret"] = config.cfAccessClientSecret;
  }
  if (includeIdentity) {
    headers["x-pa-source-instance-id"] = config.identity.sourceInstanceId;
    headers["x-pa-application-id"] = config.identity.applicationId;
    headers["x-pa-history-epoch"] = config.identity.historyEpoch;
  }
  return headers;
}

async function requestApi(fetcher, config, path, { method = "GET", body, identity = false } = {}) {
  const response = await fetcher(`${config.baseUrl}${path}`, {
    method, headers: requestHeaders(config, body !== undefined, identity), body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual", cache: "no-store",
  });
  if (response.status >= 300 && response.status < 400) throw new PaAcceptanceError("redirect_denied");
  if (response.headers.has("set-cookie")) throw new PaAcceptanceError("api_cookie_denied");
  if (!(response.headers.get("cache-control") || "").toLowerCase().includes("no-store"))
    throw new PaAcceptanceError("api_no_store_required");
  if (!(response.headers.get("content-type") || "").toLowerCase().startsWith("application/json"))
    throw new PaAcceptanceError("api_json_required");
  const payload = await readBoundedJson(response);
  return { status: response.status, requestId: safeRequestId(response, payload), payload };
}

async function requestPublic(fetcher, url) {
  const response = await fetcher(url, { method: "GET", redirect: "manual", cache: "no-store" });
  if (response.status >= 300 && response.status < 400) throw new PaAcceptanceError("public_link_redirect_denied");
  return response.status;
}

function advertised(capabilities) {
  const endpointSet = new Set((capabilities.implementedEndpoints || []).map(endpoint => `${endpoint.method} ${endpoint.path}`));
  const scopes = new Set((capabilities.grantedCapabilities || []).map(capability => capability?.name).filter(value => typeof value === "string"));
  return { endpointSet, scopes };
}

function requireRoute(available, routeName) {
  const [feature, scope, method, path] = FEATURE_ROUTES[routeName];
  if (!available.features?.[feature] || !available.endpointSet.has(`${method} ${path}`) || !available.scopes.has(scope))
    throw new PaAcceptanceError(`missing_route_or_scope_${routeName}`);
}

function assertResponse(response, expectedStatus, stage) {
  if (response.status !== expectedStatus) throw new PaAcceptanceError(`unexpected_status_${stage}`);
  return response;
}

function assertIdentity(payload, identity) {
  if (!payload || payload.apiVersion !== "2" || payload.sourceInstanceId !== identity.sourceInstanceId ||
      payload.applicationId !== identity.applicationId || payload.historyEpoch !== identity.historyEpoch)
    throw new PaAcceptanceError("capability_identity_mismatch");
}

function changedBody(command) {
  const changed = structuredClone(command);
  if (changed.project) changed.project.description = `${changed.project.description || ""} changed`;
  else changed.expectedAuthorizationGeneration = changed.expectedAuthorizationGeneration === "0" ? "1" : "0";
  return changed;
}

function createdProjectInput(config, uuid, now, expectedAuthorizationGeneration) {
  const externalId = `${config.prefix}:${uuid()}`;
  return {
    commandId: uuid(), externalId, expectedAuthorizationGeneration, project: {
      ...config.project,
      name: `${config.project.name} ${new Date(now()).toISOString().slice(0, 10)}`,
    }, organization: config.organization, client: config.client,
  };
}

async function runReplayExpectation(fetcher, config, path, command, successStatus, stage, evidence) {
  const first = assertResponse(await requestApi(fetcher, config, path, { method: "POST", body: command, identity: true }), successStatus, `${stage}_first`);
  const replay = assertResponse(await requestApi(fetcher, config, path, { method: "POST", body: command, identity: true }), successStatus, `${stage}_replay`);
  const conflict = assertResponse(await requestApi(fetcher, config, path, { method: "POST", body: changedBody(command), identity: true }), 409, `${stage}_conflict`);
  assertIdentity(first.payload, config.identity);
  assertIdentity(replay.payload, config.identity);
  if (replay.payload?.replayed !== true || first.payload?.replayed !== false) throw new PaAcceptanceError(`invalid_replay_${stage}`);
  evidence[stage] = {
    first: { status: first.status, ...sanitizePayload(first.payload) },
    replay: { status: replay.status, ...sanitizePayload(replay.payload) },
    changedBody: { status: conflict.status, requestId: conflict.requestId },
    requestBodySha256: sha256(JSON.stringify(command)),
  };
  return first;
}

/**
 * Runs a bounded Project Alpha API-v2 staging acceptance sequence. The report
 * intentionally contains only status, IDs, revisions, generations, and hashes.
 */
export async function runPaApiV2StagingAcceptance(config, dependencies = {}) {
  const fetcher = dependencies.fetcher || fetch;
  const uuid = dependencies.uuid || randomUUID;
  const now = dependencies.now || Date.now;
  const report = {
    schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: false,
    credentials: { valuesExcluded: true, cloudflareAccessServiceCredentialsPresent: Boolean(config.cfAccessClientId) },
    stages: {},
  };

  if (!config.token) {
    const noKey = assertResponse(await requestApi(fetcher, config, "/api/v2/capabilities"), 401, "capabilities_no_key");
    const defaultOff = assertResponse(await requestApi(fetcher, config, "/api/v2/projects/inventory?limit=1"), 404, "projects_default_off");
    report.stages.capabilitiesNoKey = { status: noKey.status, requestId: noKey.requestId };
    report.stages.projectsDefaultOff = { status: defaultOff.status, requestId: defaultOff.requestId };
    return report;
  }

  const capabilities = assertResponse(await requestApi(fetcher, config, "/api/v2/capabilities"), 200, "capabilities");
  const capabilityPayload = capabilities.payload;
  if (!capabilityPayload || capabilityPayload.apiVersion !== "2") throw new PaAcceptanceError("invalid_capabilities_payload");
  const available = { ...advertised(capabilityPayload), features: Object.fromEntries(
    Object.entries(FEATURE_ROUTES).map(([name, [feature]]) => [feature, (capabilityPayload.implementedEndpoints || []).some(endpoint => endpoint.path === FEATURE_ROUTES[name][3])])) };
  report.stages.capabilities = {
    status: capabilities.status, requestId: capabilities.requestId,
    apiVersion: capabilityPayload.apiVersion,
    implementedEndpointCount: Array.isArray(capabilityPayload.implementedEndpoints) ? capabilityPayload.implementedEndpoints.length : 0,
    grantedCapabilityCount: Array.isArray(capabilityPayload.grantedCapabilities) ? capabilityPayload.grantedCapabilities.length : 0,
  };
  if (!config.mutate) return report;
  assertIdentity(capabilityPayload, config.identity);
  for (const routeName of ["create", "read", "write"]) requireRoute(available, routeName);
  if (config.exerciseStatus) requireRoute(available, "status");
  if (config.exerciseInventory) requireRoute(available, "inventory");
  if (config.bindCommand) requireRoute(available, "bind");
  if (config.refreshCommand) requireRoute(available, "refresh");
  if (config.lifecycleFixture) { requireRoute(available, "archive"); requireRoute(available, "restore"); }

  report.mutationsPerformed = true;
  requireRoute(available, "inventory");
  const inventoryBefore = assertResponse(await requestApi(fetcher, config, "/api/v2/projects/inventory?limit=1", { identity: true }), 200, "inventory_before");
  assertIdentity(inventoryBefore.payload, config.identity);
  const initialGeneration = inventoryBefore.payload?.authorizationGeneration;
  if (!/^(0|[1-9][0-9]*)$/.test(initialGeneration || "")) throw new PaAcceptanceError("invalid_initial_authorization_generation");
  report.stages.inventoryBefore = { status: inventoryBefore.status, requestId: inventoryBefore.requestId, authorizationGeneration: initialGeneration };
  const createCommand = createdProjectInput(config, uuid, now, initialGeneration);
  const create = await runReplayExpectation(fetcher, config, "/api/v2/projects/commands", createCommand, 201, "create", report.stages);
  const created = create.payload?.result?.resource;
  const generation = create.payload?.result?.authorizationGeneration;
  if (!created || !PROJECT_ID.test(created.publicId) || !POSITIVE_INTEGER.test(created.revision) || !SHA256.test(created.projectionSha256) || !/^(0|[1-9][0-9]*)$/.test(generation || ""))
    throw new PaAcceptanceError("invalid_create_result");

  const readAfterCreate = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${created.publicId}`, { identity: true }), 200, "read_after_create");
  assertIdentity(readAfterCreate.payload, config.identity);
  report.stages.readAfterCreate = { status: readAfterCreate.status, ...sanitizePayload(readAfterCreate.payload) };
  const updateCommand = {
    commandId: uuid(), externalId: createCommand.externalId, expectedRevision: created.revision,
    expectedProjectionSha256: created.projectionSha256, expectedAuthorizationGeneration: generation,
    project: { ...createCommand.project, description: `${createCommand.project.description || ""} acceptance-update` },
  };
  const update = await runReplayExpectation(fetcher, config, "/api/v2/projects/profile/commands", updateCommand, 200, "update", report.stages);
  const updated = update.payload?.result?.resource;
  const updatedGeneration = update.payload?.result?.authorizationGeneration;
  if (!updated || !PROJECT_ID.test(updated.publicId) || !POSITIVE_INTEGER.test(updated.revision) || !SHA256.test(updated.projectionSha256) || updatedGeneration !== generation)
    throw new PaAcceptanceError("invalid_update_result");
  const readAfterUpdate = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${updated.publicId}`, { identity: true }), 200, "read_after_update");
  assertIdentity(readAfterUpdate.payload, config.identity);
  report.stages.readAfterUpdate = { status: readAfterUpdate.status, ...sanitizePayload(readAfterUpdate.payload) };

  if (config.exerciseStatus) {
    const encoded = Buffer.from(createCommand.externalId, "utf8").toString("base64url");
    const status = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/bindings/status/${encoded}`, { identity: true }), 200, "binding_status");
    assertIdentity(status.payload, config.identity);
    report.stages.bindingStatus = { status: status.status, ...sanitizePayload(status.payload) };
  }
  if (config.exerciseInventory) {
    const inventory = assertResponse(await requestApi(fetcher, config, "/api/v2/projects/inventory?limit=20", { identity: true }), 200, "inventory");
    assertIdentity(inventory.payload, config.identity);
    if (!Array.isArray(inventory.payload?.projects) || !inventory.payload.projects.some(project => project.externalId === createCommand.externalId))
      throw new PaAcceptanceError("created_project_missing_from_inventory");
    report.stages.inventory = { status: inventory.status, requestId: inventory.requestId,
      projectCount: inventory.payload.projects.length, authorizationGeneration: inventory.payload.authorizationGeneration };
  }
  if (config.bindCommand) await runReplayExpectation(fetcher, config, "/api/v2/projects/bindings/commands", config.bindCommand, 200, "bind", report.stages);
  if (config.refreshCommand) await runReplayExpectation(fetcher, config, "/api/v2/projects/bindings/revisions/commands", config.refreshCommand, 200, "refresh", report.stages);
  if (config.lifecycleFixture) {
    const fixture = config.lifecycleFixture;
    const before = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${fixture.projectPublicId}`, { identity: true }), 200, "lifecycle_fixture_read");
    assertIdentity(before.payload, config.identity);
    if (typeof before.payload?.data?.name !== "string" || !before.payload.data.name.startsWith(config.prefix)) throw new PaAcceptanceError("lifecycle_fixture_not_disposable");
    const preStatus = await requestPublic(fetcher, fixture.publicLinkUrl);
    if (preStatus !== fixture.enabledStatus) throw new PaAcceptanceError("unexpected_public_link_pre_archive_status");
    const archive = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${fixture.projectPublicId}/archive/commands`, {
      method: "POST", body: { commandId: uuid(), expectedRevision: fixture.expectedRevision }, identity: true,
    }), 200, "archive");
    assertIdentity(archive.payload, config.identity);
    const archiveRevision = archive.payload?.resource?.revision;
    if (!POSITIVE_INTEGER.test(archiveRevision || "") || archive.payload?.result?.presentation?.publicLinkEnabled !== false || archive.payload?.result?.presentation?.portalPublished !== false)
      throw new PaAcceptanceError("invalid_archive_result");
    const archivedStatus = await requestPublic(fetcher, fixture.publicLinkUrl);
    if (archivedStatus !== fixture.disabledStatus) throw new PaAcceptanceError("unexpected_public_link_archived_status");
    const restore = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${fixture.projectPublicId}/restore/commands`, {
      method: "POST", body: { commandId: uuid(), expectedRevision: archiveRevision }, identity: true,
    }), 200, "restore");
    assertIdentity(restore.payload, config.identity);
    const restoredStatus = await requestPublic(fetcher, fixture.publicLinkUrl);
    if (restoredStatus !== fixture.disabledStatus || restore.payload?.result?.presentation?.publicLinkEnabled !== false || restore.payload?.result?.presentation?.portalPublished !== false)
      throw new PaAcceptanceError("unexpected_public_link_restored_status");
    report.stages.lifecycle = { archive: { status: archive.status, ...sanitizePayload(archive.payload) },
      restore: { status: restore.status, ...sanitizePayload(restore.payload) }, publicLink: { before: preStatus, archived: archivedStatus, restored: restoredStatus } };
  }
  return report;
}

async function main() {
  const config = parseAcceptanceConfig();
  const report = await runPaApiV2StagingAcceptance(config);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof PaAcceptanceError ? error.code : "acceptance_failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
