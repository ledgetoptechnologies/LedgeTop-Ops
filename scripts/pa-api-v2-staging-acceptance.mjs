import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INVENTORY_RESPONSE_BYTES = 256 * 1024;
const MAX_INVENTORY_PAGES = 20;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const GENERATION = /^(0|[1-9][0-9]{0,18})$/;
const MAX_SIGNED_64 = "9223372036854775807";
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

function exactKeyOrder(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(keys));
}

function stringField(value, field, expression) {
  return typeof value?.[field] === "string" && expression.test(value[field]);
}

function validUtf8String(value) {
  if (typeof value !== "string" || /\p{C}/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function paTrim(value) {
  return value.replace(/^[\0\x09\x0a\x0b\x0d\x20]+|[\0\x09\x0a\x0b\x0d\x20]+$/g, "");
}

function scalarLength(value) { return [...value].length; }
function utf8Length(value) { return new TextEncoder().encode(value).byteLength; }
function validGeneration(value) { return typeof value === "string" && GENERATION.test(value) && (value.length < 19 || (value.length === 19 && value <= MAX_SIGNED_64)); }
function validRevision(value) { return typeof value === "string" && POSITIVE_INTEGER.test(value) && (value.length < 19 || (value.length === 19 && value <= MAX_SIGNED_64)); }

function validExternalId(value) {
  return validUtf8String(value) && value !== "" && utf8Length(value) <= 764 && scalarLength(value) <= 191;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
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
  if (!exactKeyOrder(value, fields) || !stringField(value, "expectedPublicId", PROJECT_ID) ||
      !validRevision(value.expectedRevision) || !stringField(value, "expectedProjectionSha256", SHA256) || !validExternalId(value.externalId))
    throw new PaAcceptanceError(`invalid_${name}`);
  return value;
}

function parseProjectProfile(value, prefix) {
  const fields = ["name", "description", "estimatedStart", "estimatedEnd"];
  if (!exactKeyOrder(value, fields) || !validUtf8String(value.name) ||
      !["description", "estimatedStart", "estimatedEnd"].every(field => value[field] === null || validUtf8String(value[field])))
    throw new PaAcceptanceError("invalid_pa_acceptance_project_profile_json");
  const profile = {
    name: paTrim(value.name),
    description: value.description === null ? null : paTrim(value.description),
    estimatedStart: value.estimatedStart === null ? null : paTrim(value.estimatedStart),
    estimatedEnd: value.estimatedEnd === null ? null : paTrim(value.estimatedEnd),
  };
  if (profile.name === "" || !profile.name.startsWith(prefix) || scalarLength(profile.name) > 139 ||
      (profile.description !== null && scalarLength(profile.description) > 10_000) ||
      ![profile.estimatedStart, profile.estimatedEnd].every(date => date === null || validDate(date)) ||
      (profile.estimatedStart !== null && profile.estimatedEnd !== null && profile.estimatedStart > profile.estimatedEnd))
    throw new PaAcceptanceError("invalid_pa_acceptance_project_profile_json");
  profile.description = profile.description === "" ? null : profile.description;
  return profile;
}

function assertOptionalCommand(value, kind, prefix) {
  if (value === undefined) return undefined;
  const fields = kind === "bind" ? ["externalId", "expectedPublicId", "expectedName"]
    : ["externalId", "expectedPublicId", "expectedPriorRevision"];
  if (!exactKeyOrder(value, fields) || !validExternalId(value.externalId) || !value.externalId.startsWith(prefix) ||
      !PROJECT_ID.test(value.expectedPublicId) || (kind === "refresh" &&
      !validRevision(value.expectedPriorRevision)) || (kind === "bind" && !validUtf8String(value.expectedName)))
    throw new PaAcceptanceError(`invalid_pa_acceptance_${kind}_command_json`);
  return value;
}

function parseLifecycleFixture(value, prefix) {
  if (value === undefined) return undefined;
  const keys = ["projectPublicId", "expectedRevision", "expectedProjectionSha256", "expectedName", "publicLinkUrl", "enabledStatus", "disabledStatus"];
  if (!exactKeyOrder(value, keys) || !validUtf8String(value.expectedName) || !value.expectedName.startsWith(prefix) ||
      !PROJECT_ID.test(value.projectPublicId) || !validRevision(value.expectedRevision) || !SHA256.test(value.expectedProjectionSha256) ||
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
  if (!config.mutate) {
    if (config.token) config.identity = parseIdentity(env);
    return config;
  }
  config.token = required(env, "PA_API_TOKEN");
  if (!/^pa-acceptance-[a-z0-9][a-z0-9-]{2,60}$/i.test(config.prefix))
    throw new PaAcceptanceError("invalid_pa_acceptance_prefix");
  config.identity = parseIdentity(env);
  config.organization = parseRelation(parseJson(env, "PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON", true), "pa_acceptance_organization_binding_json", true);
  config.client = parseRelation(parseJson(env, "PA_ACCEPTANCE_CLIENT_BINDING_JSON"), "pa_acceptance_client_binding_json", false);
  config.project = parseProjectProfile(parseJson(env, "PA_ACCEPTANCE_PROJECT_PROFILE_JSON", true), config.prefix);
  config.exerciseStatus = env.PA_ACCEPTANCE_EXERCISE_STATUS === "allow";
  config.bindCommand = assertOptionalCommand(parseJson(env, "PA_ACCEPTANCE_BIND_COMMAND_JSON"), "bind", config.prefix);
  config.refreshCommand = assertOptionalCommand(parseJson(env, "PA_ACCEPTANCE_REFRESH_COMMAND_JSON"), "refresh", config.prefix);
  config.lifecycleFixture = parseLifecycleFixture(parseJson(env, "PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON"), config.prefix);
  if (config.lifecycleFixture && env.PA_ACCEPTANCE_ALLOW_LIFECYCLE !== "allow")
    throw new PaAcceptanceError("lifecycle_requires_explicit_allow");
  return config;
}

async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new PaAcceptanceError("response_too_large");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new PaAcceptanceError("response_too_large"); }
    chunks.push(value);
  }
  if (total === 0) return null;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } catch { throw new PaAcceptanceError("invalid_json_response"); }
}

function safeRequestId(response) {
  const requestId = response.headers.get("x-request-id");
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

async function requestApi(fetcher, config, path, { method = "GET", body, identity = false, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
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
  const payload = await readBoundedJson(response, maxResponseBytes);
  return { status: response.status, requestId: safeRequestId(response), payload };
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

function assertExactCapabilities(payload, routeNames) {
  if (!exactKeyOrder(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "grantedCapabilities", "implementedEndpoints"]) ||
      !Array.isArray(payload.grantedCapabilities) || !Array.isArray(payload.implementedEndpoints))
    throw new PaAcceptanceError("invalid_capabilities_payload");
  const expectedEndpoints = new Set(["GET /api/v2/capabilities"]);
  const expectedScopes = new Set(["api.capabilities.read"]);
  for (const routeName of routeNames) {
    const [, scope, method, path] = FEATURE_ROUTES[routeName];
    expectedEndpoints.add(`${method} ${path}`);
    expectedScopes.add(scope);
  }
  const actual = advertised(payload);
  const endpointKeys = payload.implementedEndpoints.map(endpoint => `${endpoint?.method} ${endpoint?.path}`);
  const scopeNames = payload.grantedCapabilities.map(capability => capability?.name);
  if (new Set(endpointKeys).size !== endpointKeys.length || new Set(scopeNames).size !== scopeNames.length ||
      actual.endpointSet.size !== expectedEndpoints.size || actual.scopes.size !== expectedScopes.size ||
      [...actual.endpointSet].some(route => !expectedEndpoints.has(route)) || [...actual.scopes].some(scope => !expectedScopes.has(scope)) ||
      payload.grantedCapabilities.some(capability => !exactKeyOrder(capability, ["name"]) || typeof capability.name !== "string"))
    throw new PaAcceptanceError("unexpected_route_or_scope_advertised");
  for (const endpoint of payload.implementedEndpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (key === "GET /api/v2/capabilities") {
      if (!exactKeyOrder(endpoint, ["method", "path", "requiredCapability"]) || endpoint.requiredCapability !== "api.capabilities.read")
        throw new PaAcceptanceError("unexpected_route_or_scope_advertised");
      continue;
    }
    const matching = Object.values(FEATURE_ROUTES).find(([, scope, method, path]) => `${method} ${path}` === key);
    if (!matching || !exactKeyOrder(endpoint, ["method", "path", "requiredCapability", "requiresSourceInstanceId", "requiresApplicationId", "requiresHistoryEpoch"]) ||
        endpoint.requiredCapability !== matching[1] || endpoint.requiresSourceInstanceId !== true || endpoint.requiresApplicationId !== true || endpoint.requiresHistoryEpoch !== true)
      throw new PaAcceptanceError("unexpected_route_or_scope_advertised");
  }
}

function assertResponse(response, expectedStatus, stage) {
  if (response.status !== expectedStatus) throw new PaAcceptanceError(`unexpected_status_${stage}`);
  return response;
}

function assertIdentity(payload, identity) {
  if (!payload || payload.apiVersion !== "2" || payload.sourceInstanceId !== identity.sourceInstanceId ||
      payload.applicationId !== identity.applicationId || payload.historyEpoch !== identity.historyEpoch || !UUID_V4.test(payload.requestId))
    throw new PaAcceptanceError("capability_identity_mismatch");
}

function assertResponseIdentity(response, identity) {
  assertIdentity(response.payload, identity);
  if (response.requestId !== response.payload.requestId) throw new PaAcceptanceError("response_request_id_mismatch");
}

function assertConflictRequestId(response, stage) {
  if (!response.requestId) throw new PaAcceptanceError(`missing_conflict_request_id_${stage}`);
}

function changedBody(command) {
  const changed = structuredClone(command);
  if (Object.hasOwn(changed, "expectedAuthorizationGeneration")) {
    changed.expectedAuthorizationGeneration = changed.expectedAuthorizationGeneration === "0" ? "1" : "0";
  } else if (Object.hasOwn(changed, "expectedRevision")) {
    changed.expectedRevision = changed.expectedRevision === "1" ? "2" : "1";
  } else throw new PaAcceptanceError("cannot_construct_changed_command_body");
  return changed;
}

function replaceLastScalar(value) {
  const scalars = Array.from(value);
  scalars[scalars.length - 1] = scalars.at(-1) === "x" ? "y" : "x";
  return scalars.join("");
}

function assertSyncResource(resource, expected, code) {
  if (!resource || resource.type !== "project" || resource.id !== expected.externalId || resource.publicId !== expected.publicId ||
      !validRevision(resource.revision) || resource.revision !== expected.revision || !SHA256.test(resource.projectionSha256) ||
      resource.projectionSha256 !== expected.projectionSha256)
    throw new PaAcceptanceError(code);
}

function assertReadProject(payload, expected, code) {
  const resource = payload?.resource;
  const data = payload?.data;
  if (!exactKeyOrder(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "accepted", "resource", "data"]) ||
      payload.replayed !== false || payload.accepted !== true || !exactKeyOrder(resource, ["type", "id", "revision", "projectionSha256"]) ||
      !exactKeyOrder(data, ["name", "description", "status", "archived", "overdueWarning", "completedAt", "archivedAt", "estimatedStart", "estimatedEnd", "clientPublicId", "organizationPublicId"]) ||
      resource.type !== "project" || resource.id !== expected.publicId || resource.revision !== expected.revision ||
      !validRevision(resource.revision) || resource.projectionSha256 !== expected.projectionSha256 || !SHA256.test(resource.projectionSha256) ||
      !data || data.name !== expected.project.name || data.description !== expected.project.description ||
      data.estimatedStart !== expected.project.estimatedStart || data.estimatedEnd !== expected.project.estimatedEnd ||
      data.organizationPublicId !== expected.organization.expectedPublicId ||
      data.clientPublicId !== (expected.client?.expectedPublicId ?? null)) throw new PaAcceptanceError(code);
}

function assertBindingStatus(payload, expected, code) {
  const binding = payload?.binding;
  const resource = payload?.resource;
  if (!exactKeyOrder(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "binding", "resource"]) ||
      !exactKeyOrder(binding, ["externalId", "publicId", "createdAt", "updatedAt"]) ||
      !exactKeyOrder(resource, ["revision", "projectionSha256", "status", "archived"]) || !validGeneration(payload?.authorizationGeneration) || payload.authorizationGeneration !== expected.generation ||
      !binding || binding.externalId !== expected.externalId || binding.publicId !== expected.publicId ||
      typeof binding.createdAt !== "string" || binding.createdAt === "" || typeof binding.updatedAt !== "string" || binding.updatedAt === "" ||
      !resource || resource.revision !== expected.revision || !validRevision(resource.revision) ||
      resource.projectionSha256 !== expected.projectionSha256 || !SHA256.test(resource.projectionSha256) ||
      typeof resource.status !== "string" || resource.status === "" || typeof resource.archived !== "boolean")
    throw new PaAcceptanceError(code);
}

function assertInventoryShape(payload, generation, code) {
  if (!exactKeyOrder(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "projects", "nextCursor"]) ||
      !validGeneration(payload?.authorizationGeneration) || payload.authorizationGeneration !== generation ||
      !Array.isArray(payload?.projects) || !(payload.nextCursor === null || validExternalId(payload.nextCursor)))
    throw new PaAcceptanceError(code);
  for (const item of payload.projects) {
    if (!exactKeyOrder(item, ["externalId", "publicId", "revision", "projectionSha256", "status", "archived"]) ||
        !validExternalId(item.externalId) || !PROJECT_ID.test(item.publicId) || !validRevision(item.revision) ||
        !SHA256.test(item.projectionSha256) || typeof item.status !== "string" || item.status === "" || typeof item.archived !== "boolean")
      throw new PaAcceptanceError(code);
  }
}

function assertInventory(payload, expected, code) {
  assertInventoryShape(payload, expected.generation, code);
  if (!payload.projects.some(item => item.externalId === expected.externalId && item.publicId === expected.publicId &&
      item.revision === expected.revision && item.projectionSha256 === expected.projectionSha256))
    throw new PaAcceptanceError("created_project_missing_from_inventory");
}

async function findInventoryProject(fetcher, config, expected) {
  let cursor;
  let pageCount = 0;
  let projectCount = 0;
  const seenCursors = new Set();
  while (pageCount < MAX_INVENTORY_PAGES) {
    const query = cursor === undefined ? "?limit=200" : `?limit=200&cursor=${encodeURIComponent(cursor)}`;
    const inventory = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/inventory${query}`, { identity: true, maxResponseBytes: MAX_INVENTORY_RESPONSE_BYTES }), 200, "inventory");
    assertResponseIdentity(inventory, config.identity);
    assertInventoryShape(inventory.payload, expected.generation, "invalid_inventory");
    pageCount += 1;
    projectCount += inventory.payload.projects.length;
    if (inventory.payload.projects.some(item => item.externalId === expected.externalId && item.publicId === expected.publicId &&
        item.revision === expected.revision && item.projectionSha256 === expected.projectionSha256)) {
      return { inventory, pageCount, projectCount };
    }
    cursor = inventory.payload.nextCursor;
    if (cursor === null) throw new PaAcceptanceError("created_project_missing_from_inventory");
    if (seenCursors.has(cursor)) throw new PaAcceptanceError("invalid_inventory_pagination");
    seenCursors.add(cursor);
  }
  throw new PaAcceptanceError("inventory_pagination_limit");
}

async function readProjectCommandTarget(fetcher, config, publicId, stage, expectedName) {
  const response = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${publicId}`, { identity: true }), 200, stage);
  assertResponseIdentity(response, config.identity);
  const resource = response.payload?.resource;
  if (!resource || resource.type !== "project" || resource.id !== publicId || !validRevision(resource.revision) || !SHA256.test(resource.projectionSha256) ||
      (expectedName !== undefined && response.payload?.data?.name !== expectedName))
    throw new PaAcceptanceError(`invalid_${stage}`);
  return { publicId, revision: resource.revision, projectionSha256: resource.projectionSha256 };
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
  assertResponseIdentity(first, config.identity);
  assertResponseIdentity(replay, config.identity);
  assertConflictRequestId(conflict, stage);
  const validResult = payload => {
    const result = payload?.result;
    const resource = result?.resource;
    return exactKeyOrder(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) &&
      exactKeyOrder(result, ["resource", "authorizationGeneration", "presentation"]) &&
      exactKeyOrder(resource, ["type", "id", "publicId", "revision", "projectionSha256"]) &&
      exactKeyOrder(result.presentation, ["portalPublished", "publicLinkEnabled"]) && resource.type === "project" && resource.id === command.externalId && PROJECT_ID.test(resource.publicId) &&
      validRevision(resource.revision) && SHA256.test(resource.projectionSha256) && validGeneration(result?.authorizationGeneration) &&
      typeof result?.presentation?.portalPublished === "boolean" && typeof result?.presentation?.publicLinkEnabled === "boolean";
  };
  if (replay.payload?.replayed !== true || first.payload?.replayed !== false || !validResult(first.payload) || !validResult(replay.payload) ||
      JSON.stringify(first.payload.result) !== JSON.stringify(replay.payload.result)) throw new PaAcceptanceError(`invalid_replay_${stage}`);
  evidence[stage] = {
    first: { status: first.status, ...sanitizePayload(first.payload) },
    replay: { status: replay.status, ...sanitizePayload(replay.payload) },
    changedBody: { status: conflict.status, requestId: conflict.requestId },
    requestBodySha256: sha256(JSON.stringify(command)),
  };
  return first;
}

async function runLifecycleReplayExpectation(fetcher, config, path, command, expectedPublicId, expectedState, stage, evidence) {
  const first = assertResponse(await requestApi(fetcher, config, path, { method: "POST", body: command, identity: true }), 200, `${stage}_first`);
  const replay = assertResponse(await requestApi(fetcher, config, path, { method: "POST", body: command, identity: true }), 200, `${stage}_replay`);
  const conflict = assertResponse(await requestApi(fetcher, config, path, { method: "POST", body: changedBody(command), identity: true }), 409, `${stage}_conflict`);
  assertResponseIdentity(first, config.identity);
  assertResponseIdentity(replay, config.identity);
  assertConflictRequestId(conflict, stage);
  const validOutcome = payload => {
    const result = payload?.result;
    return exactKeyOrder(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "accepted", "resource", "result"]) &&
      exactKeyOrder(payload.resource, ["type", "id", "revision"]) && payload?.accepted === true && payload.resource.type === "project" && payload.resource.id === expectedPublicId && validRevision(payload.resource.revision) &&
      exactKeyOrder(result, ["status", "completedAt", "archived", "archivedAt", "presentation"]) && result.status === expectedState.status &&
      result.completedAt === expectedState.completedAt && result.archived === expectedState.archived &&
      (expectedState.archived ? typeof result.archivedAt === "string" && result.archivedAt !== "" : result.archivedAt === null) &&
      exactKeyOrder(result.presentation, ["portalPublished", "publicLinkEnabled"]) && result.presentation.portalPublished === false && result.presentation.publicLinkEnabled === false;
  };
  if (first.payload?.replayed !== false || replay.payload?.replayed !== true || !validOutcome(first.payload) || !validOutcome(replay.payload) ||
      JSON.stringify(first.payload.resource) !== JSON.stringify(replay.payload.resource) || JSON.stringify(first.payload.result) !== JSON.stringify(replay.payload.result))
    throw new PaAcceptanceError(`invalid_replay_${stage}`);
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
  if (!config.mutate) {
    assertResponseIdentity(capabilities, config.identity);
    return report;
  }
  assertResponseIdentity(capabilities, config.identity);
  const selectedRoutes = ["create", "read", "write", "inventory"];
  if (config.exerciseStatus) selectedRoutes.push("status");
  if (config.bindCommand) selectedRoutes.push("bind");
  if (config.refreshCommand) selectedRoutes.push("refresh");
  if (config.lifecycleFixture) selectedRoutes.push("archive", "restore");
  for (const routeName of selectedRoutes) requireRoute(available, routeName);
  assertExactCapabilities(capabilityPayload, selectedRoutes);

  report.mutationsPerformed = true;
  requireRoute(available, "inventory");
  const inventoryBefore = assertResponse(await requestApi(fetcher, config, "/api/v2/projects/inventory?limit=1", { identity: true, maxResponseBytes: MAX_INVENTORY_RESPONSE_BYTES }), 200, "inventory_before");
  assertResponseIdentity(inventoryBefore, config.identity);
  const initialGeneration = inventoryBefore.payload?.authorizationGeneration;
  if (!validGeneration(initialGeneration)) throw new PaAcceptanceError("invalid_initial_authorization_generation");
  assertInventoryShape(inventoryBefore.payload, initialGeneration, "invalid_initial_inventory");
  report.stages.inventoryBefore = { status: inventoryBefore.status, requestId: inventoryBefore.requestId, authorizationGeneration: initialGeneration };
  const createCommand = createdProjectInput(config, uuid, now, initialGeneration);
  const create = await runReplayExpectation(fetcher, config, "/api/v2/projects/commands", createCommand, 201, "create", report.stages);
  const created = create.payload?.result?.resource;
  const generation = create.payload?.result?.authorizationGeneration;
  if (!created || !PROJECT_ID.test(created.publicId) || !validRevision(created.revision) || !SHA256.test(created.projectionSha256) || !validGeneration(generation))
    throw new PaAcceptanceError("invalid_create_result");
  if (generation !== (BigInt(initialGeneration) + 1n).toString()) throw new PaAcceptanceError("invalid_create_generation");
  assertSyncResource(created, { externalId: createCommand.externalId, publicId: created.publicId, revision: created.revision, projectionSha256: created.projectionSha256 }, "invalid_create_result");

  const readAfterCreate = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${created.publicId}`, { identity: true }), 200, "read_after_create");
  assertResponseIdentity(readAfterCreate, config.identity);
  assertReadProject(readAfterCreate.payload, { externalId: createCommand.externalId, publicId: created.publicId, revision: created.revision,
    projectionSha256: created.projectionSha256, project: createCommand.project, organization: createCommand.organization, client: createCommand.client }, "read_after_create_mismatch");
  report.stages.readAfterCreate = { status: readAfterCreate.status, ...sanitizePayload(readAfterCreate.payload) };
  const updateCommand = {
    commandId: uuid(), externalId: createCommand.externalId, expectedRevision: created.revision,
    expectedProjectionSha256: created.projectionSha256, expectedAuthorizationGeneration: generation,
    project: { ...createCommand.project, name: replaceLastScalar(createCommand.project.name) },
  };
  const update = await runReplayExpectation(fetcher, config, "/api/v2/projects/profile/commands", updateCommand, 200, "update", report.stages);
  const updated = update.payload?.result?.resource;
  const updatedGeneration = update.payload?.result?.authorizationGeneration;
  if (!updated || !PROJECT_ID.test(updated.publicId) || !validRevision(updated.revision) || !SHA256.test(updated.projectionSha256) || updatedGeneration !== generation ||
      BigInt(updated.revision) !== BigInt(created.revision) + 1n || updated.projectionSha256 === created.projectionSha256)
    throw new PaAcceptanceError("invalid_update_result");
  assertSyncResource(updated, { externalId: updateCommand.externalId, publicId: created.publicId, revision: updated.revision, projectionSha256: updated.projectionSha256 }, "invalid_update_result");
  const readAfterUpdate = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${updated.publicId}`, { identity: true }), 200, "read_after_update");
  assertResponseIdentity(readAfterUpdate, config.identity);
  assertReadProject(readAfterUpdate.payload, { externalId: updateCommand.externalId, publicId: updated.publicId, revision: updated.revision,
    projectionSha256: updated.projectionSha256, project: updateCommand.project, organization: createCommand.organization, client: createCommand.client }, "read_after_update_mismatch");
  report.stages.readAfterUpdate = { status: readAfterUpdate.status, ...sanitizePayload(readAfterUpdate.payload) };

  if (config.exerciseStatus) {
    const encoded = Buffer.from(createCommand.externalId, "utf8").toString("base64url");
    const status = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/bindings/status/${encoded}`, { identity: true }), 200, "binding_status");
    assertResponseIdentity(status, config.identity);
    assertBindingStatus(status.payload, { externalId: createCommand.externalId, publicId: updated.publicId, revision: updated.revision,
      projectionSha256: updated.projectionSha256, generation: updatedGeneration }, "invalid_binding_status");
    report.stages.bindingStatus = { status: status.status, ...sanitizePayload(status.payload) };
  }
  const inventory = await findInventoryProject(fetcher, config, { externalId: createCommand.externalId, publicId: updated.publicId, revision: updated.revision,
    projectionSha256: updated.projectionSha256, generation: updatedGeneration });
  report.stages.inventory = { status: inventory.inventory.status, requestId: inventory.inventory.requestId,
    projectCount: inventory.projectCount, pageCount: inventory.pageCount, authorizationGeneration: inventory.inventory.payload.authorizationGeneration };
  let currentAuthorizationGeneration = updatedGeneration;
  if (config.bindCommand) {
    const target = await readProjectCommandTarget(fetcher, config, config.bindCommand.expectedPublicId, "bind_target_read", config.bindCommand.expectedName);
    const bind = { commandId: uuid(), externalId: config.bindCommand.externalId, expectedPublicId: target.publicId,
      expectedRevision: target.revision, expectedProjectionSha256: target.projectionSha256,
      expectedAuthorizationGeneration: currentAuthorizationGeneration };
    const outcome = await runReplayExpectation(fetcher, config, "/api/v2/projects/bindings/commands", bind, 200, "bind", report.stages);
    assertSyncResource(outcome.payload?.result?.resource, { externalId: bind.externalId, publicId: bind.expectedPublicId, revision: bind.expectedRevision,
      projectionSha256: bind.expectedProjectionSha256 }, "invalid_bind_result");
    const nextGeneration = outcome.payload?.result?.authorizationGeneration;
    if (nextGeneration !== (BigInt(currentAuthorizationGeneration) + 1n).toString()) throw new PaAcceptanceError("invalid_bind_generation");
    currentAuthorizationGeneration = nextGeneration;
  }
  if (config.refreshCommand) {
    const target = await readProjectCommandTarget(fetcher, config, config.refreshCommand.expectedPublicId, "refresh_target_read");
    if (BigInt(config.refreshCommand.expectedPriorRevision) >= BigInt(target.revision)) throw new PaAcceptanceError("refresh_target_mismatch");
    const refresh = { commandId: uuid(), externalId: config.refreshCommand.externalId, expectedPublicId: target.publicId,
      expectedPriorRevision: config.refreshCommand.expectedPriorRevision, expectedRevision: target.revision,
      expectedProjectionSha256: target.projectionSha256, expectedAuthorizationGeneration: currentAuthorizationGeneration };
    const outcome = await runReplayExpectation(fetcher, config, "/api/v2/projects/bindings/revisions/commands", refresh, 200, "refresh", report.stages);
    assertSyncResource(outcome.payload?.result?.resource, { externalId: refresh.externalId, publicId: refresh.expectedPublicId, revision: refresh.expectedRevision,
      projectionSha256: refresh.expectedProjectionSha256 }, "invalid_refresh_result");
    if (outcome.payload?.result?.authorizationGeneration !== (BigInt(currentAuthorizationGeneration) + 1n).toString())
      throw new PaAcceptanceError("invalid_refresh_generation");
  }
  if (config.lifecycleFixture) {
    const fixture = config.lifecycleFixture;
    const before = assertResponse(await requestApi(fetcher, config, `/api/v2/projects/${fixture.projectPublicId}`, { identity: true }), 200, "lifecycle_fixture_read");
    assertResponseIdentity(before, config.identity);
    const lifecycleData = before.payload?.data;
    if (before.payload?.resource?.id !== fixture.projectPublicId || before.payload?.resource?.revision !== fixture.expectedRevision ||
        before.payload?.resource?.projectionSha256 !== fixture.expectedProjectionSha256 || lifecycleData?.name !== fixture.expectedName ||
        !["not_started", "active", "completed", "cancelled"].includes(lifecycleData?.status) ||
        !(lifecycleData.completedAt === null || (typeof lifecycleData.completedAt === "string" && lifecycleData.completedAt !== "")) ||
        lifecycleData.archived !== false || lifecycleData.archivedAt !== null)
      throw new PaAcceptanceError("lifecycle_fixture_not_disposable");
    const preStatus = await requestPublic(fetcher, fixture.publicLinkUrl);
    if (preStatus !== fixture.enabledStatus) throw new PaAcceptanceError("unexpected_public_link_pre_archive_status");
    const archive = await runLifecycleReplayExpectation(fetcher, config, `/api/v2/projects/${fixture.projectPublicId}/archive/commands`,
      { commandId: uuid(), expectedRevision: fixture.expectedRevision }, fixture.projectPublicId,
      { status: lifecycleData.status, completedAt: lifecycleData.completedAt, archived: true }, "archive", report.stages);
    const archiveRevision = archive.payload?.resource?.revision;
    if (!validRevision(archiveRevision) || BigInt(archiveRevision) !== BigInt(fixture.expectedRevision) + 1n)
      throw new PaAcceptanceError("invalid_archive_result");
    const archivedStatus = await requestPublic(fetcher, fixture.publicLinkUrl);
    if (archivedStatus !== fixture.disabledStatus) throw new PaAcceptanceError("unexpected_public_link_archived_status");
    const restore = await runLifecycleReplayExpectation(fetcher, config, `/api/v2/projects/${fixture.projectPublicId}/restore/commands`,
      { commandId: uuid(), expectedRevision: archiveRevision }, fixture.projectPublicId,
      { status: lifecycleData.status, completedAt: lifecycleData.completedAt, archived: false }, "restore", report.stages);
    if (!validRevision(restore.payload?.resource?.revision) || BigInt(restore.payload.resource.revision) !== BigInt(archiveRevision) + 1n)
      throw new PaAcceptanceError("invalid_restore_result");
    const restoredStatus = await requestPublic(fetcher, fixture.publicLinkUrl);
    if (restoredStatus !== fixture.disabledStatus || restore.payload?.result?.presentation?.publicLinkEnabled !== false || restore.payload?.result?.presentation?.portalPublished !== false)
      throw new PaAcceptanceError("unexpected_public_link_restored_status");
    report.stages.lifecycle = { archive: report.stages.archive, restore: report.stages.restore,
      publicLink: { before: preStatus, archived: archivedStatus, restored: restoredStatus } };
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
