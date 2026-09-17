import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const POSITIVE = /^[1-9][0-9]{0,18}$/;
const GENERATION = /^(?:0|[1-9][0-9]{0,18})$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const SIGNED_64_MAX = "9223372036854775807";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INVENTORY_RESPONSE_BYTES = 256 * 1024;
// PA's default per-key limit is 60 requests/minute. Keep the acceptance
// client below that limit even when a replay probe deliberately performs
// three requests for one command. The interval is configurable for tests,
// but the live default is intentionally conservative (55 requests/minute).
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1100;
const MAX_MIN_REQUEST_INTERVAL_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RETRY_AFTER_MS = 30_000;
const RETRY_BACKOFF_MS = 1000;

export class DirectoryAcceptanceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const fail = (code) => { throw new DirectoryAcceptanceError(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ordered = (value, keys) => object(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key, index) => key === keys[index]);
const sameKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const required = (env, name) => typeof env[name] === "string" && env[name].trim() ? env[name].trim() : fail(`missing_${name.toLowerCase()}`);
const clone = (value) => structuredClone(value);
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const atMostSigned64 = (value) => typeof value === "string" && (value.length < SIGNED_64_MAX.length || (value.length === SIGNED_64_MAX.length && value <= SIGNED_64_MAX));
const positiveRevision = (value) => POSITIVE.test(value) && atMostSigned64(value);
const authorizationGeneration = (value) => GENERATION.test(value) && atMostSigned64(value);
const plusOne = (value) => {
  if (!authorizationGeneration(value) || value === SIGNED_64_MAX) fail("signed_64_overflow");
  return String(BigInt(value) + 1n);
};
const phpTrim = (value) => value.replace(/^[ \t\n\r\u0000\v]+|[ \t\n\r\u0000\v]+$/g, "");
const dotAtom = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const domainLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// PHP's FILTER_VALIDATE_EMAIL does not accept a numeric-leading final DNS
// label. This deliberately conservative subset also excludes quoted locals
// and address literals rather than letting a PHP-invalid address pass later.
const finalDomainLabel = /^[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
function phpEmail(value) {
  if (value === "") return true;
  if (!/^[\x21-\x7e]+$/.test(value) || Buffer.byteLength(value, "utf8") > 254) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at); const domain = value.slice(at + 1);
  if (local.length > 64 || !dotAtom.test(local) || domain.length > 253) return false;
  const labels = domain.split(".");
  return labels.length > 1
    && labels.slice(0, -1).every((label) => label.length > 0 && label.length <= 63 && domainLabel.test(label))
    && labels.at(-1).length > 0 && labels.at(-1).length <= 63 && finalDomainLabel.test(labels.at(-1));
}

const route = (method, path, requiredCapability) => Object.freeze({ method, path, requiredCapability, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true });
export const DIRECTORY_ROUTES = Object.freeze([
  route("GET", "/api/v2/directory/clients/{publicId}", "directory.clients.read"),
  route("GET", "/api/v2/directory/organizations/{publicId}", "directory.organizations.read"),
  route("GET", "/api/v2/bindings/client/status/{base64urlExternalId}", "directory.clients.binding_status.read"),
  route("GET", "/api/v2/bindings/organization/status/{base64urlExternalId}", "directory.organizations.binding_status.read"),
  route("POST", "/api/v2/directory/clients/bindings/commands", "directory.clients.bind"),
  route("POST", "/api/v2/directory/organizations/bindings/commands", "directory.organizations.bind"),
  route("POST", "/api/v2/directory/clients/bindings/revisions/commands", "directory.clients.binding.revision.refresh"),
  route("POST", "/api/v2/directory/organizations/bindings/revisions/commands", "directory.organizations.binding.revision.refresh"),
  route("POST", "/api/v2/directory/organizations/{publicId}/profile/commands", "directory.organizations.write"),
  route("POST", "/api/v2/directory/clients/{publicId}/profile/commands", "directory.clients.write"),
  route("POST", "/api/v2/directory/organizations/commands", "directory.organizations.create"),
  route("POST", "/api/v2/directory/clients/commands", "directory.clients.create"),
  route("POST", "/api/v2/directory/clients/{publicId}/archive/commands", "directory.clients.archive"),
  route("POST", "/api/v2/directory/clients/{publicId}/restore/commands", "directory.clients.restore"),
  route("POST", "/api/v2/directory/organizations/{publicId}/archive/commands", "directory.organizations.archive"),
  route("POST", "/api/v2/directory/organizations/{publicId}/restore/commands", "directory.organizations.restore"),
  route("POST", "/api/v2/directory/clients/{publicId}/organization/assign/commands", "directory.clients.organization.assign"),
  route("POST", "/api/v2/directory/clients/{publicId}/organization/remove/commands", "directory.clients.organization.remove"),
  route("POST", "/api/v2/directory/clients/{publicId}/organization/move/commands", "directory.clients.organization.move"),
  route("POST", "/api/v2/directory/clients/bindings/revoke/commands", "directory.clients.unbind"),
  route("POST", "/api/v2/directory/organizations/bindings/revoke/commands", "directory.organizations.unbind"),
  route("GET", "/api/v2/directory/inventory", "directory.inventory.read"),
]);
export const DIRECTORY_FEATURE_FLAGS = Object.freeze({
  directory_read: "APP_API_V2_DIRECTORY_READ_ENABLED",
  binding_status: "APP_API_V2_BINDING_STATUS_ENABLED",
  directory_binding: "APP_API_V2_DIRECTORY_BINDING_ENABLED",
  directory_binding_refresh: "APP_API_V2_DIRECTORY_BINDING_REFRESH_ENABLED",
  directory_organization_write: "APP_API_V2_DIRECTORY_ORGANIZATIONS_WRITE_ENABLED",
  directory_client_write: "APP_API_V2_DIRECTORY_CLIENTS_WRITE_ENABLED",
  directory_organization_create: "APP_API_V2_DIRECTORY_ORGANIZATIONS_CREATE_ENABLED",
  directory_client_create: "APP_API_V2_DIRECTORY_CLIENTS_CREATE_ENABLED",
  directory_client_archive: "APP_API_V2_DIRECTORY_CLIENTS_ARCHIVE_ENABLED",
  directory_client_restore: "APP_API_V2_DIRECTORY_CLIENTS_RESTORE_ENABLED",
  directory_organization_archive: "APP_API_V2_DIRECTORY_ORGANIZATIONS_ARCHIVE_ENABLED",
  directory_organization_restore: "APP_API_V2_DIRECTORY_ORGANIZATIONS_RESTORE_ENABLED",
  directory_relationship_write: "APP_API_V2_DIRECTORY_RELATIONSHIPS_WRITE_ENABLED",
  directory_binding_revoke: "APP_API_V2_DIRECTORY_BINDING_REVOKE_ENABLED",
  directory_inventory: "APP_API_V2_DIRECTORY_INVENTORY_ENABLED",
});
export const DIRECTORY_FLAGS = Object.freeze(Object.values(DIRECTORY_FEATURE_FLAGS));

const CREATE_PROFILE_FIELDS = Object.freeze({
  organization: ["name", "generalEmail", "generalPhone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"],
  client: ["name", "email", "phone", "clientType", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"],
});
const UPDATE_PROFILE_FIELDS = Object.freeze({
  organization: CREATE_PROFILE_FIELDS.organization,
  client: ["name", "email", "phone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"],
});
const PROFILE_LIMITS = Object.freeze({
  organization: Object.freeze({ name: 150, generalEmail: 255, generalPhone: 50, addressLine1: 255, addressLine2: 255, city: 100, state: 100, postalCode: 32, country: 100 }),
  client: Object.freeze({ name: 150, email: 255, phone: 50, clientType: 8, addressLine1: 255, addressLine2: 255, city: 100, state: 2, postalCode: 20, country: 100 }),
});

function normalizeProfile(value, type) {
  const fields = CREATE_PROFILE_FIELDS[type];
  if (!sameKeys(value, fields) || fields.some((field) => typeof value[field] !== "string")) fail(`invalid_${type}_profile`);
  // The PHP parsers first require valid UTF-8 and reject every Unicode control
  // category, then apply PHP's default trim. Preserve that ordering here.
  if (fields.some((field) => {
    const utf8 = Buffer.from(value[field], "utf8");
    return utf8.toString("utf8") !== value[field] || /\p{C}/u.test(value[field]);
  })) fail(`invalid_${type}_profile`);
  const normalized = Object.fromEntries(fields.map((field) => [field, phpTrim(value[field])]));
  if (!normalized.name) fail(`invalid_${type}_profile`);
  if (fields.some((field) => {
    const scalarLimit = PROFILE_LIMITS[type][field];
    const utf8 = Buffer.from(normalized[field], "utf8");
    return [...normalized[field]].length > scalarLimit || utf8.byteLength > scalarLimit * 4;
  })) fail(`invalid_${type}_profile`);
  const emailField = type === "client" ? "email" : "generalEmail";
  normalized[emailField] = normalized[emailField].toLowerCase();
  if (!phpEmail(normalized[emailField])) fail(`invalid_${type}_profile`);
  if (type === "client" && !["unknown", "business", "consumer"].includes(normalized.clientType)) fail("invalid_client_profile");
  // Profile updates append ` <32-hex> update`. Organization creates also add
  // a run label and the longest role suffix (` primary`), so reserve the
  // exact larger organization allowance before any mutation.
  if ([...normalized.name].length > (type === "organization" ? 109 : 110)) fail(`invalid_${type}_profile`);
  return normalized;
}
function parseJson(env, name) { try { return JSON.parse(required(env, name)); } catch { fail(`invalid_${name.toLowerCase()}`); } }

function boundedMilliseconds(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) fail(`invalid_${name.toLowerCase()}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_MIN_REQUEST_INTERVAL_MS) fail(`invalid_${name.toLowerCase()}`);
  return value;
}

export function parseDirectoryAcceptanceConfig(env = process.env) {
  let parsed;
  try { parsed = new URL(required(env, "PA_DIRECTORY_BASE_URL")); } catch { fail("invalid_pa_directory_base_url"); }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) fail("invalid_pa_directory_base_url");
  const config = { baseUrl: parsed.origin, token: env.PA_DIRECTORY_API_TOKEN?.trim(), mutate: env.PA_DIRECTORY_ACCEPTANCE_ALLOW_MUTATIONS === "allow", cfAccessClientId: env.PA_DIRECTORY_CF_ACCESS_CLIENT_ID || undefined, cfAccessClientSecret: env.PA_DIRECTORY_CF_ACCESS_CLIENT_SECRET || undefined, minRequestIntervalMs: boundedMilliseconds(env, "PA_DIRECTORY_ACCEPTANCE_MIN_REQUEST_INTERVAL_MS", DEFAULT_MIN_REQUEST_INTERVAL_MS) };
  if (Boolean(config.cfAccessClientId) !== Boolean(config.cfAccessClientSecret)) fail("incomplete_cloudflare_access_credentials");
  if (!config.mutate) return config;
  config.token = required(env, "PA_DIRECTORY_API_TOKEN");
  config.prefix = required(env, "PA_DIRECTORY_ACCEPTANCE_PREFIX");
  if (!/^pa-directory-acceptance-[a-z0-9][a-z0-9-]{2,60}$/i.test(config.prefix)) fail("invalid_pa_directory_acceptance_prefix");
  config.identity = { sourceInstanceId: required(env, "PA_SOURCE_INSTANCE_ID"), applicationId: required(env, "PA_APPLICATION_ID"), historyEpoch: required(env, "PA_HISTORY_EPOCH") };
  if (!Object.values(config.identity).every((value) => UUID.test(value))) fail("invalid_pa_directory_identity");
  config.organization = normalizeProfile(parseJson(env, "PA_DIRECTORY_ORGANIZATION_PROFILE_JSON"), "organization");
  config.moveOrganization = normalizeProfile(parseJson(env, "PA_DIRECTORY_MOVE_ORGANIZATION_PROFILE_JSON"), "organization");
  config.client = normalizeProfile(parseJson(env, "PA_DIRECTORY_CLIENT_PROFILE_JSON"), "client");
  if (config.organization.name.toLowerCase() === config.moveOrganization.name.toLowerCase()) fail("directory_organization_names_not_distinct");
  config.maxPages = Number(env.PA_DIRECTORY_INVENTORY_MAX_PAGES || "100");
  if (!Number.isInteger(config.maxPages) || config.maxPages < 2 || config.maxPages > 500) fail("invalid_pa_directory_inventory_max_pages");
  return config;
}

function headers(config, body, identity) {
  const value = { accept: "application/json" };
  if (config.token) value.authorization = `Bearer ${config.token}`;
  if (body !== undefined) value["content-type"] = "application/json; charset=utf-8";
  if (config.cfAccessClientId) { value["cf-access-client-id"] = config.cfAccessClientId; value["cf-access-client-secret"] = config.cfAccessClientSecret; }
  if (identity) { value["x-pa-source-instance-id"] = config.identity.sourceInstanceId; value["x-pa-application-id"] = config.identity.applicationId; value["x-pa-history-epoch"] = config.identity.historyEpoch; }
  return value;
}
function commandBody(path, body) {
  if (body === undefined) return undefined;
  let keys;
  if (path.includes("/profile/")) keys = ["commandId", "expectedRevision", "expectedAuthorizationGeneration", "profile"];
  else if (path.includes("/bindings/revisions/")) keys = ["commandId", "externalId", "expectedPriorRevision", "expectedLiveRevision", "expectedAuthorizationGeneration"];
  else if (path.includes("/bindings/revoke/")) keys = ["commandId", "externalId", "expectedPublicId", "expectedRevision", "expectedAuthorizationGeneration"];
  else if (path.includes("/bindings/commands")) keys = ["commandId", "externalId", "expectedPublicId", "expectedRevision"];
  else if (path.includes("/organization/") && path.includes("/commands")) keys = ["commandId", "expectedClientRevision", "expectedAuthorizationGeneration", "expectedCurrentOrganizationPublicId", "organization"];
  else if (path.includes("/archive/") || path.includes("/restore/")) keys = ["commandId", "expectedRevision", "expectedAuthorizationGeneration"];
  else if (path.endsWith("/organizations/commands")) keys = ["commandId", "externalId", "expectedAuthorizationGeneration", "profile"];
  else if (path.endsWith("/clients/commands")) keys = ["commandId", "externalId", "expectedAuthorizationGeneration", "profile", "organization"];
  else fail("unknown_command_schema");
  if (!sameKeys(body, keys)) fail("unsafe_command_shape");
  return Object.fromEntries(keys.map((key) => [key, body[key]]));
}
async function decode(response, maximum) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) fail("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) fail("missing_response_body");
  const chunks = []; let count = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength; if (count > maximum) { await reader.cancel(); fail("response_too_large"); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let at = 0;
  for (const part of chunks) { bytes.set(part, at); at += part.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("invalid_utf8_or_json_response"); }
}
function retryAfterMilliseconds(response, retryNumber) {
  const raw = response.headers.get("retry-after");
  if (raw !== null) {
    if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return Math.min(RETRY_BACKOFF_MS * (2 ** (retryNumber - 1)), MAX_RETRY_AFTER_MS);
}

function rateLimitState(config) {
  if (!config.rateLimitState) config.rateLimitState = { requests: 0, responses429: 0, retries: 0, retryAfterMs: [], retryAfterCapped: 0, nextRequestAt: 0 };
  return config.rateLimitState;
}

function recordRateLimitEvidence(config, report) {
  const state = config.rateLimitState;
  if (!state) return;
  report.rateLimit = {
    minRequestIntervalMs: config.minRequestIntervalMs,
    requests: state.requests,
    responses429: state.responses429,
    retries: state.retries,
    retryAfterMs: [...state.retryAfterMs],
    retryAfterCapped: state.retryAfterCapped,
  };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function api(fetcher, config, path, options = {}) {
  const { method = "GET", body, identity = false } = options;
  const request = commandBody(path, body);
  const state = rateLimitState(config);
  let retryNumber = 0;
  for (;;) {
    const delay = state.nextRequestAt - Date.now();
    if (delay > 0) await (config.sleep ?? wait)(delay);
    state.requests += 1;
    const response = await fetcher(`${config.baseUrl}${path}`, { method, headers: headers(config, request, identity), body: request === undefined ? undefined : JSON.stringify(request), redirect: "manual", credentials: "omit", cache: "no-store" });
    state.nextRequestAt = Date.now() + config.minRequestIntervalMs;
    if (response.status === 429) {
      state.responses429 += 1;
      if (++retryNumber > MAX_RATE_LIMIT_RETRIES) fail("rate_limit_retry_exhausted");
      const retryAfter = retryAfterMilliseconds(response, retryNumber);
      const rawRetryAfter = response.headers.get("retry-after");
      if (rawRetryAfter !== null && ((/^\d+$/.test(rawRetryAfter.trim()) && Number(rawRetryAfter) * 1000 > MAX_RETRY_AFTER_MS) || (!/^\d+$/.test(rawRetryAfter.trim()) && Number.isFinite(Date.parse(rawRetryAfter)) && Math.max(0, Date.parse(rawRetryAfter) - Date.now()) > MAX_RETRY_AFTER_MS))) state.retryAfterCapped += 1;
      state.retryAfterMs.push(retryAfter);
      state.retries += 1;
      state.nextRequestAt = Math.max(state.nextRequestAt, Date.now() + retryAfter);
      continue;
    }
    if ((response.status >= 300 && response.status < 400) || response.headers.has("set-cookie") || response.headers.has("location")) fail("unsafe_response");
    if (!(response.headers.get("cache-control") || "").split(",").some((value) => value.trim().toLowerCase() === "no-store")) fail("response_no_store_required");
    const requestId = response.headers.get("x-request-id");
    if (!UUID.test(requestId || "")) fail("invalid_request_id");
    if (response.status < 200 || response.status > 299) return { status: response.status, requestId, payload: null };
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) fail("response_json_required");
    const payload = await decode(response, path.startsWith("/api/v2/directory/inventory") ? MAX_INVENTORY_RESPONSE_BYTES : MAX_RESPONSE_BYTES);
    if (!object(payload) || payload.requestId !== requestId || !UUID.test(payload.requestId || "")) fail("invalid_request_id");
    return { status: response.status, requestId, payload };
  }
}

function identity(payload, config, versioned = false) {
  if (!object(payload) || payload.sourceInstanceId !== config.identity.sourceInstanceId || payload.applicationId !== config.identity.applicationId || payload.historyEpoch !== config.identity.historyEpoch || !UUID.test(payload.requestId || "") || (versioned && payload.apiVersion !== "2")) fail("identity_contract_mismatch");
}
const summary = (result) => ({ status: result.status, requestId: result.requestId });
function capabilityContract(payload, config) {
  identity(payload, config, true);
  const scopes = ["api.capabilities.read", ...DIRECTORY_ROUTES.map((value) => value.requiredCapability)];
  const endpoints = [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, ...DIRECTORY_ROUTES];
  if (!ordered(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "grantedCapabilities", "implementedEndpoints"]) || !equal(payload.grantedCapabilities, scopes.map((name) => ({ name }))) || !equal(payload.implementedEndpoints, endpoints)) fail("directory_capabilities_contract_mismatch");
}
function mutate(command, kind) {
  const altered = clone(command);
  if (kind === "create" || kind === "profile") {
    const scalars = [...altered.profile.name];
    if (scalars.length === 0) fail("unsafe_changed_body");
    const last = scalars.length - 1;
    scalars[last] = scalars[last] === "x" ? "y" : "x";
    altered.profile.name = scalars.join("");
  }
  else if (kind === "bind" || kind === "refresh") altered.externalId = `${altered.externalId}-changed`;
  else altered.expectedAuthorizationGeneration = altered.expectedAuthorizationGeneration === "0" ? "1" : "0";
  return altered;
}
function baseReceipt(payload, config) {
  identity(payload, config);
  if (!ordered(payload, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) || typeof payload.replayed !== "boolean" || !object(payload.result)) fail("command_receipt_contract_mismatch");
}
function receipt(payload, config, type, kind, command, meta) {
  baseReceipt(payload, config);
  const result = payload.result;
  if (kind === "create") {
    if (!ordered(result, ["resource", "authorizationGeneration"]) || !ordered(result.resource, ["type", "id", "publicId", "revision"]) || result.resource.type !== type || result.resource.id !== command.externalId || !PUBLIC_ID.test(result.resource.publicId) || !positiveRevision(result.resource.revision) || !authorizationGeneration(result.authorizationGeneration) || result.resource.revision !== "1" || result.authorizationGeneration !== plusOne(meta.priorGeneration)) fail("create_receipt_contract_mismatch");
    return { publicId: result.resource.publicId, externalId: command.externalId, revision: result.resource.revision, generation: result.authorizationGeneration, replayed: payload.replayed };
  }
  if (kind === "profile") {
    if (!ordered(result, ["resource", "authorizationGeneration"]) || !ordered(result.resource, ["type", "publicId", "revision"]) || result.resource.type !== type || result.resource.publicId !== meta.publicId || !positiveRevision(result.resource.revision) || !authorizationGeneration(result.authorizationGeneration) || result.resource.revision !== plusOne(meta.priorRevision) || result.authorizationGeneration !== meta.priorGeneration) fail("profile_receipt_contract_mismatch");
    return { revision: result.resource.revision, generation: result.authorizationGeneration, replayed: payload.replayed };
  }
  if (kind === "bind") {
    if (!ordered(result, ["resource", "binding"]) || !ordered(result.resource, ["type", "id", "revision"]) || !ordered(result.binding, ["publicId"]) || result.resource.type !== type || result.resource.id !== command.externalId || result.resource.revision !== command.expectedRevision || result.binding.publicId !== command.expectedPublicId) fail("binding_receipt_contract_mismatch");
    return { replayed: payload.replayed };
  }
  if (kind === "refresh") {
    if (!ordered(result, ["resource", "binding"]) || !ordered(result.resource, ["type", "id", "revision"]) || !ordered(result.binding, ["publicId", "previousRevision", "authorizationGeneration"]) || result.resource.type !== type || result.resource.id !== command.externalId || result.resource.revision !== command.expectedLiveRevision || result.binding.publicId !== meta.publicId || result.binding.previousRevision !== command.expectedPriorRevision || !authorizationGeneration(result.binding.authorizationGeneration) || command.expectedLiveRevision !== plusOne(meta.priorRevision) || result.binding.authorizationGeneration !== plusOne(meta.priorGeneration)) fail("refresh_receipt_contract_mismatch");
    return { generation: result.binding.authorizationGeneration, replayed: payload.replayed };
  }
  if (kind === "relationship") {
    if (!ordered(result, ["action", "client", "organizationPublicId", "authorizationGeneration"]) || !ordered(result.client, ["publicId", "revision"]) || result.action !== meta.action || result.client.publicId !== meta.clientPublicId || result.organizationPublicId !== meta.organizationPublicId || !positiveRevision(result.client.revision) || !authorizationGeneration(result.authorizationGeneration) || result.client.revision !== plusOne(meta.priorRevision) || result.authorizationGeneration !== plusOne(meta.priorGeneration)) fail("relationship_receipt_contract_mismatch");
    return { revision: result.client.revision, generation: result.authorizationGeneration, replayed: payload.replayed };
  }
  const expectedGeneration = meta.action === "archive" ? plusOne(meta.priorGeneration) : meta.priorGeneration;
  if (!ordered(result, ["action", "resource", "authorizationGeneration"]) || !ordered(result.resource, ["type", "publicId", "revision", "present"]) || result.action !== meta.action || result.resource.type !== type || result.resource.publicId !== meta.publicId || result.resource.present !== (meta.action === "restore") || !positiveRevision(result.resource.revision) || !authorizationGeneration(result.authorizationGeneration) || result.resource.revision !== plusOne(meta.priorRevision) || result.authorizationGeneration !== expectedGeneration) fail("lifecycle_receipt_contract_mismatch");
  return { revision: result.resource.revision, generation: result.authorizationGeneration, replayed: payload.replayed };
}
async function replay(fetcher, config, path, type, kind, command, report, meta) {
  const first = await api(fetcher, config, path, { method: "POST", body: command, identity: true });
  const exactRetry = await api(fetcher, config, path, { method: "POST", body: command, identity: true });
  const changed = await api(fetcher, config, path, { method: "POST", body: mutate(command, kind), identity: true });
  if (first.status !== (kind === "create" ? 201 : 200) || exactRetry.status !== 200 || changed.status !== 409) fail(`invalid_${kind}_replay_status`);
  const outcome = receipt(first.payload, config, type, kind, command, meta);
  const retried = receipt(exactRetry.payload, config, type, kind, command, meta);
  if (outcome.replayed || !retried.replayed) fail("invalid_replay_marker");
  report.stages[meta.stage] = { first: summary(first), replay: summary(exactRetry), changedBody: summary(changed), requestBodySha256: sha256(command) };
  return outcome;
}

// Directory write profiles intentionally use strings so command validation is
// unambiguous. PA's read projection follows nullable DB semantics for fields
// that are optional: an empty stored value is returned as null. Keep that
// normalization local to the read contract; it must not loosen command or
// response shape validation for any other field.
const nullableRead = (value) => value === "" ? null : value;
function readData(type, resource, profile, organizationPublicId) {
  const data = { publicId: resource.publicId, name: profile.name, email: nullableRead(type === "client" ? profile.email : profile.generalEmail), phone: nullableRead(type === "client" ? profile.phone : profile.generalPhone), address: { line1: profile.addressLine1, line2: nullableRead(profile.addressLine2), city: profile.city, state: profile.state, postalCode: profile.postalCode, country: profile.country } };
  return type === "client" ? { ...data, clientType: resource.clientType, organizationPublicId } : data;
}
async function read(fetcher, config, type, resource, profile, organizationPublicId, report, stage) {
  const result = await api(fetcher, config, `/api/v2/directory/${type}s/${resource.publicId}`, { identity: true });
  if (result.status !== 200) fail("directory_read_failed");
  const payload = result.payload;
  identity(payload, config, true);
  const dataKeys = type === "client" ? ["publicId", "name", "email", "phone", "address", "clientType", "organizationPublicId"] : ["publicId", "name", "email", "phone", "address"];
  if (!ordered(payload, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "resource", "data"]) || !authorizationGeneration(payload.authorizationGeneration) || !ordered(payload.resource, ["type", "id", "revision"]) || payload.resource.type !== type || payload.resource.id !== resource.publicId || !positiveRevision(payload.resource.revision) || !ordered(payload.data, dataKeys) || !ordered(payload.data.address, ["line1", "line2", "city", "state", "postalCode", "country"]) || !equal(payload.data, readData(type, resource, profile, organizationPublicId))) fail("directory_read_contract_mismatch");
  resource.revision = payload.resource.revision; resource.generation = payload.authorizationGeneration;
  report.stages[stage] = summary(result);
}
async function status(fetcher, config, type, resource, expected = 200, exact = {}) {
  const externalId = Buffer.from(resource.externalId, "utf8").toString("base64url");
  const result = await api(fetcher, config, `/api/v2/bindings/${type}/status/${externalId}`, { identity: true });
  if (result.status !== expected) fail("binding_status_unexpected_status");
  if (expected !== 200) return summary(result);
  const payload = result.payload;
  identity(payload, config, true);
  if (!ordered(payload, ["apiVersion", "sourceInstanceId", "historyEpoch", "authorizationGeneration", "binding", "resource", "applicationId", "requestId"]) || !authorizationGeneration(payload.authorizationGeneration) || !ordered(payload.binding, ["type", "externalId", "publicId", "createdAt"]) || !ordered(payload.resource, ["revision", "present"]) || payload.binding.type !== type || payload.binding.externalId !== resource.externalId || payload.binding.publicId !== resource.publicId || typeof payload.binding.createdAt !== "string" || !positiveRevision(payload.resource.revision) || payload.resource.present !== true) fail("binding_status_contract_mismatch");
  if ((exact.revision !== undefined && payload.resource.revision !== exact.revision) || (exact.generation !== undefined && payload.authorizationGeneration !== exact.generation)) fail("binding_status_transition_mismatch");
  resource.revision = payload.resource.revision; resource.generation = payload.authorizationGeneration;
  return summary(result);
}
function inventoryBinding(value) { return value === null || (ordered(value, ["externalId", "status", "resourceRevision"]) && typeof value.externalId === "string" && ["active", "tombstoned"].includes(value.status) && positiveRevision(value.resourceRevision)); }
async function inventory(fetcher, config, expected, report) {
  let cursor = null; let pages = 0; const resources = []; const seen = new Set(); let generation;
  do {
    if (++pages > config.maxPages) fail("inventory_page_bound_exceeded");
    const query = new URLSearchParams({ type: "all", limit: "2" }); if (cursor !== null) query.set("cursor", cursor);
    const result = await api(fetcher, config, `/api/v2/directory/inventory?${query}`, { identity: true });
    if (result.status !== 200) fail("inventory_failed");
    const payload = result.payload;
    identity(payload, config);
    if (!ordered(payload, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "resources", "nextCursor"]) || !authorizationGeneration(payload.authorizationGeneration) || !Array.isArray(payload.resources) || (payload.nextCursor !== null && typeof payload.nextCursor !== "string")) fail("inventory_contract_mismatch");
    if (generation !== undefined && payload.authorizationGeneration !== generation) fail("inventory_generation_changed_during_pagination");
    const permittedEmptyInitialPage = expected.length === 0 && pages === 1 && payload.resources.length === 0 && payload.nextCursor === null;
    if (payload.resources.length > 2 || (payload.resources.length < 1 && !permittedEmptyInitialPage)) fail("inventory_contract_mismatch");
    for (const item of payload.resources) {
      if (!ordered(item, ["type", "publicId", "revision", "present", "lastAction", "projectionSha256", "binding"]) || !["client", "organization"].includes(item.type) || !PUBLIC_ID.test(item.publicId) || !positiveRevision(item.revision) || typeof item.present !== "boolean" || !["upsert", "delete"].includes(item.lastAction) || !SHA256.test(item.projectionSha256) || !inventoryBinding(item.binding)) fail("inventory_resource_contract_mismatch");
      const key = `${item.type}:${item.publicId}`; if (seen.has(key)) fail("inventory_duplicate_resource"); seen.add(key); resources.push(item);
    }
    generation = payload.authorizationGeneration; cursor = payload.nextCursor;
  } while (cursor !== null);
  if ((expected.length > 0 && pages < 2) || resources.some((item, index) => index > 0 && `${resources[index - 1].type}:${resources[index - 1].publicId}` >= `${item.type}:${item.publicId}`)) fail("inventory_ordering_contract_mismatch");
  for (const resource of expected) {
    const item = resources.find((candidate) => candidate.type === resource.type && candidate.publicId === resource.publicId);
    if (!item || !item.present || item.revision !== resource.revision || !item.binding || item.binding.status !== "active" || item.binding.externalId !== resource.externalId || item.binding.resourceRevision !== resource.revision) fail("inventory_missing_or_stale_acceptance_resource");
    resource.projectionSha256 = item.projectionSha256;
  }
  report.stages.inventory = { pages, finalAuthorizationGeneration: generation, targetProjectionSha256: expected.map((resource) => resource.projectionSha256) };
  return generation;
}
function createCommand(config, type, profile, suffix, generation, commandId) {
  const value = { commandId, externalId: `${config.prefix}:${type}:${suffix}`, expectedAuthorizationGeneration: generation, profile: clone(profile) };
  return type === "client" ? { ...value, organization: null } : value;
}
function runUniqueOrganizationProfile(profile, label, role) {
  return { ...profile, name: `${profile.name} ${label} ${role}` };
}
function updateProfile(type, profile) { return Object.fromEntries(UPDATE_PROFILE_FIELDS[type].map((field) => [field, profile[field]])); }

export async function runDirectoryAcceptance(config, { fetcher = fetch, uuid = randomUUID, sleep } = {}) {
  config.rateLimitState = { requests: 0, responses429: 0, retries: 0, retryAfterMs: [], retryAfterCapped: 0, nextRequestAt: 0 };
  if (sleep) config.sleep = sleep;
  const report = { schemaVersion: 3, environment: "staging", status: "passed", mutationsPerformed: false, credentials: { valuesExcluded: true }, requiredFeatureFlags: DIRECTORY_FLAGS, stages: {} };
  if (!config.token) { const result = await api(fetcher, config, "/api/v2/capabilities"); if (result.status !== 401) fail("capabilities_requires_authentication"); report.stages.capabilitiesNoKey = summary(result); recordRateLimitEvidence(config, report); return report; }
  const capabilities = await api(fetcher, config, "/api/v2/capabilities");
  if (capabilities.status !== 200) fail("capabilities_failed");
  report.stages.capabilities = summary(capabilities);
  if (!config.mutate) { recordRateLimitEvidence(config, report); return report; }
  capabilityContract(capabilities.payload, config); report.mutationsPerformed = true;
  const issued = new Set();
  const commandId = () => { const value = uuid(); if (!UUID.test(value) || issued.has(value)) fail("unsafe_or_reused_command_id"); issued.add(value); return value; };
  const label = uuid().replaceAll("-", "").toLowerCase(); if (!/^[a-f0-9]{32}$/.test(label)) fail("unsafe_run_label");
  let generation = await inventory(fetcher, config, [], report);
  const organizationCreateProfile = runUniqueOrganizationProfile(config.organization, label, "primary");
  const moveOrganizationCreateProfile = runUniqueOrganizationProfile(config.moveOrganization, label, "move");
  const organization = await replay(fetcher, config, "/api/v2/directory/organizations/commands", "organization", "create", createCommand(config, "organization", organizationCreateProfile, `${label}-primary`, generation, commandId()), report, { stage: "organizationCreate", priorGeneration: generation }); organization.type = "organization"; generation = organization.generation;
  const moveOrganization = await replay(fetcher, config, "/api/v2/directory/organizations/commands", "organization", "create", createCommand(config, "organization", moveOrganizationCreateProfile, `${label}-move`, generation, commandId()), report, { stage: "moveOrganizationCreate", priorGeneration: generation }); moveOrganization.type = "organization"; generation = moveOrganization.generation;
  const client = await replay(fetcher, config, "/api/v2/directory/clients/commands", "client", "create", createCommand(config, "client", config.client, `${label}-client`, generation, commandId()), report, { stage: "clientCreate", priorGeneration: generation }); client.type = "client"; client.clientType = config.client.clientType; generation = client.generation;
  await read(fetcher, config, "organization", organization, organizationCreateProfile, undefined, report, "organizationReadAfterCreate");
  await read(fetcher, config, "organization", moveOrganization, moveOrganizationCreateProfile, undefined, report, "moveOrganizationReadAfterCreate");
  await read(fetcher, config, "client", client, config.client, null, report, "clientReadAfterCreate");
  report.stages.createAutoBindings = { organization: await status(fetcher, config, "organization", organization, 200, { revision: organization.revision, generation }), moveOrganization: await status(fetcher, config, "organization", moveOrganization, 200, { revision: moveOrganization.revision, generation }), client: await status(fetcher, config, "client", client, 200, { revision: client.revision, generation }) }; generation = client.generation;
  const organizationProfile = clone(config.organization); organizationProfile.name = `${organizationProfile.name} ${label} update`;
  let outcome = await replay(fetcher, config, `/api/v2/directory/organizations/${organization.publicId}/profile/commands`, "organization", "profile", { commandId: commandId(), expectedRevision: organization.revision, expectedAuthorizationGeneration: generation, profile: updateProfile("organization", organizationProfile) }, report, { publicId: organization.publicId, stage: "organizationProfileUpdate", priorRevision: organization.revision, priorGeneration: generation }); organization.revision = outcome.revision; generation = outcome.generation;
  await read(fetcher, config, "organization", organization, organizationProfile, undefined, report, "organizationReadAfterUpdate"); report.stages.organizationBindingStale = await status(fetcher, config, "organization", organization, 409);
  outcome = await replay(fetcher, config, "/api/v2/directory/organizations/bindings/revisions/commands", "organization", "refresh", { commandId: commandId(), externalId: organization.externalId, expectedPriorRevision: "1", expectedLiveRevision: organization.revision, expectedAuthorizationGeneration: generation }, report, { publicId: organization.publicId, stage: "organizationBindingRefresh", priorRevision: "1", priorGeneration: generation }); generation = outcome.generation; report.stages.organizationBindingRefreshed = await status(fetcher, config, "organization", organization, 200, { revision: organization.revision, generation }); generation = organization.generation;
  const clientProfile = clone(config.client); clientProfile.name = `${clientProfile.name} ${label} update`;
  outcome = await replay(fetcher, config, `/api/v2/directory/clients/${client.publicId}/profile/commands`, "client", "profile", { commandId: commandId(), expectedRevision: client.revision, expectedAuthorizationGeneration: generation, profile: updateProfile("client", clientProfile) }, report, { publicId: client.publicId, stage: "clientProfileUpdate", priorRevision: client.revision, priorGeneration: generation }); client.revision = outcome.revision; generation = outcome.generation;
  await read(fetcher, config, "client", client, clientProfile, null, report, "clientReadAfterUpdate"); report.stages.clientBindingStale = await status(fetcher, config, "client", client, 409);
  outcome = await replay(fetcher, config, "/api/v2/directory/clients/bindings/revisions/commands", "client", "refresh", { commandId: commandId(), externalId: client.externalId, expectedPriorRevision: "1", expectedLiveRevision: client.revision, expectedAuthorizationGeneration: generation }, report, { publicId: client.publicId, stage: "clientBindingRefresh", priorRevision: "1", priorGeneration: generation }); generation = outcome.generation; report.stages.clientBindingRefreshed = await status(fetcher, config, "client", client, 200, { revision: client.revision, generation }); generation = client.generation;
  const relationship = async (action, target, current, stage) => {
    const command = { commandId: commandId(), expectedClientRevision: client.revision, expectedAuthorizationGeneration: generation, expectedCurrentOrganizationPublicId: current, organization: target ? { externalId: target.externalId, publicId: target.publicId, expectedRevision: target.revision } : null };
    const result = await replay(fetcher, config, `/api/v2/directory/clients/${client.publicId}/organization/${action}/commands`, "client", "relationship", command, report, { clientPublicId: client.publicId, action, organizationPublicId: target?.publicId ?? null, stage, priorRevision: client.revision, priorGeneration: generation }); client.revision = result.revision; generation = result.generation;
    await read(fetcher, config, "client", client, clientProfile, target?.publicId ?? null, report, `${stage}Readback`); generation = client.generation;
  };
  await relationship("assign", organization, null, "clientOrganizationAssign"); await relationship("move", moveOrganization, organization.publicId, "clientOrganizationMove"); await relationship("remove", null, moveOrganization.publicId, "clientOrganizationRemove");
  outcome = await replay(fetcher, config, `/api/v2/directory/clients/${client.publicId}/archive/commands`, "client", "lifecycle", { commandId: commandId(), expectedRevision: client.revision, expectedAuthorizationGeneration: generation }, report, { publicId: client.publicId, action: "archive", stage: "clientArchive", priorRevision: client.revision, priorGeneration: generation }); client.revision = outcome.revision; generation = outcome.generation;
  const tombstone = await status(fetcher, config, "client", client, 410);
  outcome = await replay(fetcher, config, `/api/v2/directory/clients/${client.publicId}/restore/commands`, "client", "lifecycle", { commandId: commandId(), expectedRevision: client.revision, expectedAuthorizationGeneration: generation }, report, { publicId: client.publicId, action: "restore", stage: "clientRestore", priorRevision: client.revision, priorGeneration: generation }); client.revision = outcome.revision; generation = outcome.generation;
  const noAutoRebind = await status(fetcher, config, "client", client, 410); report.stages.lifecycleBinding = { tombstone, noAutoRebind };
  await read(fetcher, config, "client", client, clientProfile, null, report, "clientReadAfterRestore"); generation = client.generation;
  const rebindPriorGeneration = generation;
  await replay(fetcher, config, "/api/v2/directory/clients/bindings/commands", "client", "bind", { commandId: commandId(), externalId: client.externalId, expectedPublicId: client.publicId, expectedRevision: client.revision }, report, { stage: "clientBindingRebind", priorGeneration: rebindPriorGeneration }); report.stages.clientBindingRebound = await status(fetcher, config, "client", client, 200, { revision: client.revision, generation: plusOne(rebindPriorGeneration) }); generation = client.generation;
  await inventory(fetcher, config, [organization, moveOrganization, client], report);
  recordRateLimitEvidence(config, report);
  return report;
}
async function main() { process.stdout.write(`${JSON.stringify(await runDirectoryAcceptance(parseDirectoryAcceptanceConfig()))}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof DirectoryAcceptanceError ? error.code : "directory_acceptance_failed" })}\n`); process.exitCode = 1; });
