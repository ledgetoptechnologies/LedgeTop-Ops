import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STAGING_HOSTS, STAGING_PROJECT_ALPHA_ORIGIN } from "./staging-requirements.mjs";
import { parseStagingCloudflareD1Target, stagingCloudflareD1QueryUrl } from "./staging-cloudflare-d1-target.mjs";

const ROOT = "/api/client-hub/directory";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PUBLIC_LINK_BYTES = 256 * 1024;
const MAX_STORAGE_STATE_BYTES = 1024 * 1024;
const MAX_COOKIE_BYTES = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const SELECTOR = /^[a-z0-9][a-z0-9:_-]{0,190}$/i;
const PREFIX = /^ops-directory-acceptance-[a-z0-9][a-z0-9-]{2,48}$/i;
const STAGING_ORIGIN = `https://${STAGING_HOSTS.operations}`;
const STAGING_PUBLIC_HOSTS = new Set([STAGING_HOSTS.delivery, STAGING_HOSTS.client,
  "portal-staging.ledgetoptechnologies.com", new URL(STAGING_PROJECT_ALPHA_ORIGIN).hostname]);
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const REVISION = /^[1-9][0-9]{0,18}$/;
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

export class DirectoryJoinedAcceptanceError extends Error {
  constructor(code) { super(code); this.name = "DirectoryJoinedAcceptanceError"; this.code = code; }
}

const fail = code => { throw new DirectoryJoinedAcceptanceError(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => structuredClone(value);
const sha256Json = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function required(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fail(`missing_${name.toLowerCase()}`);
}

function parseOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_operations_base_url"); }
  if (url.origin !== STAGING_ORIGIN || url.protocol !== "https:" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) fail("production_or_noncanonical_operations_origin");
  return url.origin;
}

function parsePublicLink(value) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_public_link_url"); }
  if (url.protocol !== "https:" || url.username || url.password || !STAGING_PUBLIC_HOSTS.has(url.hostname))
    fail("production_or_nonstaging_public_link");
  return url.toString();
}

async function readStorageState(path, expectedHost) {
  const absolute = resolve(path), info = await lstat(absolute).catch(() => fail("invalid_operations_storage_state"));
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORAGE_STATE_BYTES) fail("invalid_operations_storage_state");
  let parsed;
  try { parsed = JSON.parse(await readFile(absolute, "utf8")); } catch { fail("invalid_operations_storage_state"); }
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies.filter(cookie => cookie?.name === "CF_Authorization"
    && typeof cookie.value === "string" && cookie.secure === true
    && String(cookie.domain ?? "").replace(/^\./, "").toLowerCase() === expectedHost) : [];
  if (cookies.length !== 1 || /[\r\n]/.test(cookies[0].value)) fail("operations_session_required");
  const value = `CF_Authorization=${cookies[0].value}`;
  if (value.length > MAX_COOKIE_BYTES) fail("operations_session_too_large");
  return value;
}

async function sessionCookie(env, origin) {
  if (typeof env.OPS_SESSION_COOKIE === "string" && env.OPS_SESSION_COOKIE.trim()) {
    const value = env.OPS_SESSION_COOKIE.trim();
    if (value.length > MAX_COOKIE_BYTES || /[\r\n]/.test(value) || !/^CF_Authorization=[^;\r\n]+$/.test(value))
      fail("invalid_operations_session");
    return value;
  }
  if (!env.OPS_STORAGE_STATE) fail("operations_session_required");
  return readStorageState(env.OPS_STORAGE_STATE, new URL(origin).hostname);
}

function accessAssertion(env) {
  const value = env.OPS_CF_ACCESS_JWT_ASSERTION?.trim();
  if (!value) return undefined;
  const segments = value.split(".");
  if (value.length > MAX_COOKIE_BYTES || /[\r\n]/.test(value) || segments.length !== 3
    || segments.some(segment => !JWT_SEGMENT.test(segment))) fail("invalid_access_assertion");
  return value;
}

function browserContextCredentialsPresent(env) {
  return ["OPS_SESSION_COOKIE", "OPS_STORAGE_STATE", "OPS_CF_ACCESS_JWT_ASSERTION", "CLOUDFLARE_API_TOKEN"]
    .some(name => typeof env[name] === "string" && env[name].trim());
}

async function parseDirectoryJoinedAcceptanceConfigForTransport(env, browserContext) {
  const origin = parseOrigin(env.OPS_BASE_URL || STAGING_ORIGIN);
  const mutate = env.OPS_DIRECTORY_ACCEPTANCE_ALLOW_MUTATIONS === "allow";
  if (browserContext && browserContextCredentialsPresent(env)) fail("browser_context_credentials_forbidden");
  if (!mutate) return Object.freeze({ origin, mutate: false, ...(browserContext ? { browserContext: true } : {}) });
  const prefix = required(env, "OPS_DIRECTORY_ACCEPTANCE_PREFIX");
  const sourceId = required(env, "OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID");
  const businessAreaId = required(env, "OPS_DIRECTORY_ACCEPTANCE_BUSINESS_AREA_ID");
  const divisionValue = required(env, "OPS_DIRECTORY_ACCEPTANCE_DIVISION_ID");
  if (!PREFIX.test(prefix)) fail("invalid_acceptance_prefix");
  if (!SOURCE_ID.test(sourceId)) fail("invalid_source_id");
  if (!SELECTOR.test(businessAreaId)) fail("invalid_business_area_id");
  const divisionId = divisionValue === "none" ? null : divisionValue;
  if (divisionId !== null && !SELECTOR.test(divisionId)) fail("invalid_division_id");
  const pollIntervalMs = Number(env.OPS_DIRECTORY_ACCEPTANCE_POLL_INTERVAL_MS ?? "1000");
  const timeoutMs = Number(env.OPS_DIRECTORY_ACCEPTANCE_TIMEOUT_MS ?? "600000");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < pollIntervalMs || timeoutMs > 20 * 60_000)
    fail("invalid_poll_window");
  const publicLinkUrl = parsePublicLink(required(env, "OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL"));
  if (browserContext) return Object.freeze({ origin, mutate: true, browserContext: true, prefix, sourceId, businessAreaId,
    divisionId, pollIntervalMs, timeoutMs, publicLinkUrl });
  const cookie = await sessionCookie(env, origin);
  const d1Token = required(env, "CLOUDFLARE_API_TOKEN");
  const d1Target = parseStagingCloudflareD1Target(env, "OPS_DB");
  return Object.freeze({ origin, mutate: true, prefix, sourceId, businessAreaId, divisionId, pollIntervalMs, timeoutMs,
    cookie, accessAssertion: accessAssertion(env), publicLinkUrl, d1Token, d1Target });
}

export async function parseDirectoryJoinedAcceptanceConfig(env = process.env) {
  return parseDirectoryJoinedAcceptanceConfigForTransport(env, false);
}

export async function parseBrowserContextDirectoryJoinedAcceptanceConfig(env = process.env) {
  return parseDirectoryJoinedAcceptanceConfigForTransport(env, true);
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail("response_too_large");
  if (!response.body) fail("invalid_operations_response");
  const reader = response.body.getReader(), chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); fail("response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("invalid_operations_response"); }
}

async function boundedBytes(response, limit) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > limit) fail("public_link_response_too_large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); fail("public_link_response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function publicLinkProbe(url, fetcher) {
  const response = await fetcher(url, { method: "GET", redirect: "manual", cache: "no-store",
    headers: { Accept: "text/html,application/json" } });
  if (response.status >= 300 && response.status < 400) fail("public_link_redirect_denied");
  const bytes = await boundedBytes(response, MAX_PUBLIC_LINK_BYTES);
  return { status: response.status, bodySha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: response.headers.get("content-type")?.split(";", 1)[0] || null };
}

function assertPublicLinkPreserved(before, after) {
  if (before.status !== 200) fail("public_link_not_accessible_before");
  if (after.status !== before.status || after.bodySha256 !== before.bodySha256 || after.contentType !== before.contentType)
    fail("public_link_changed");
}

const DESTINATION_READBACK_SQL = `WITH selected AS (
  SELECT * FROM project_alpha_active_directory_mappings
  WHERE record_id=? AND source_id=? AND resource_type='client'
), update_receipt AS (
  SELECT outbox.outcome_json FROM operations_directory_intents intent
  JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
  JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
  WHERE intent.mutation_id=? AND outbox.state='acknowledged'
)
SELECT
  (SELECT count(*) FROM operations_directory_records WHERE record_id=? AND record_kind='client') record_count,
  (SELECT count(*) FROM selected) mapping_count,
  (SELECT count(*) FROM selected WHERE external_id=record_id AND mapping_kind='legacy') exact_mapping_count,
  (SELECT count(*) FROM project_alpha_active_directory_mappings candidate JOIN selected exact
    ON candidate.source_id=exact.source_id AND candidate.source_instance_id=exact.source_instance_id
      AND candidate.application_id=exact.application_id AND candidate.history_epoch_id=exact.history_epoch_id
      AND candidate.resource_type=exact.resource_type AND candidate.provenance_id<>exact.provenance_id
    WHERE candidate.record_id IN (exact.record_id,exact.external_id,exact.project_alpha_public_id)
      OR candidate.external_id IN (exact.record_id,exact.external_id,exact.project_alpha_public_id)
      OR candidate.project_alpha_public_id IN (exact.record_id,exact.external_id,exact.project_alpha_public_id)) collision_count,
  (SELECT record_id FROM selected LIMIT 1) record_id,
  (SELECT external_id FROM selected LIMIT 1) external_id,
  (SELECT project_alpha_public_id FROM selected LIMIT 1) project_alpha_public_id,
  (SELECT mapping_kind FROM selected LIMIT 1) mapping_kind,
  (SELECT count(*) FROM update_receipt) update_receipt_count,
  (SELECT json_extract(outcome_json,'$.response.result.data.publicId') FROM update_receipt LIMIT 1) binding_public_id,
  (SELECT json_extract(outcome_json,'$.response.result.resource.revision') FROM update_receipt LIMIT 1) binding_revision`;

async function destinationReadback(config, recordId, updateMutationId, fetcher) {
  const response = await fetcher(stagingCloudflareD1QueryUrl(config.d1Target), { method: "POST", redirect: "manual", cache: "no-store", headers: {
    Accept: "application/json", Authorization: `Bearer ${config.d1Token}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ sql: DESTINATION_READBACK_SQL,
    params: [recordId, config.sourceId, updateMutationId, recordId] }) });
  const payload = await boundedJson(response), result = response.ok && payload?.success === true
    && Array.isArray(payload.result) && payload.result.length === 1 ? payload.result[0] : null;
  if (!result?.success || result.meta?.changed_db !== false || result.meta?.changes !== 0 || !Array.isArray(result.results))
    fail("destination_readback_unavailable");
  if (result.results.length !== 1) fail("destination_mapping_missing");
  return result.results[0];
}

function assertDestinationReadback(value, recordId) {
  if (!object(value) || value.record_count !== 1 || value.mapping_count === 0) fail("destination_mapping_missing");
  if (value.mapping_count !== 1 || value.exact_mapping_count > 1) fail("destination_mapping_duplicate");
  if (value.exact_mapping_count !== 1 || value.record_id !== recordId || value.external_id !== recordId
    || value.mapping_kind !== "legacy" || !PUBLIC_ID.test(value.project_alpha_public_id || ""))
    fail("destination_mapping_mismatch");
  if (value.collision_count !== 0) fail("destination_mapping_collision");
  if (value.update_receipt_count !== 1 || value.binding_public_id !== value.project_alpha_public_id
    || !REVISION.test(value.binding_revision || "") || value.binding_revision === "1")
    fail("destination_binding_revision_mismatch");
  return { status: "verified", recordIdSha256: createHash("sha256").update(recordId).digest("hex"),
    publicIdSha256: createHash("sha256").update(value.project_alpha_public_id).digest("hex"),
    mappingCount: 1, collisionCount: 0, bindingRevision: value.binding_revision };
}

function safeOutcome(payload) {
  if (!object(payload) || typeof payload.status !== "string") fail("invalid_operations_response");
  const safe = { status: payload.status };
  if (typeof payload.reason === "string") safe.reason = payload.reason;
  if (typeof payload.recordId === "string") safe.recordId = payload.recordId;
  if (typeof payload.kind === "string") safe.kind = payload.kind;
  if (typeof payload.replayed === "boolean") safe.replayed = payload.replayed;
  if (Number.isSafeInteger(payload.version)) safe.version = payload.version;
  if (Array.isArray(payload.destinations)) safe.destinations = payload.destinations.map(value => ({
    sourceId: typeof value?.sourceId === "string" ? value.sourceId : fail("invalid_operations_response"),
    state: typeof value?.state === "string" ? value.state : fail("invalid_operations_response"),
  }));
  return safe;
}

async function acquireSession(config, fetcher) {
  const response = await fetcher(`${config.origin}/api/session`, { method: "GET", redirect: "manual", cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-store", ...(config.browserContext ? {} : { Origin: config.origin,
      Cookie: config.cookie, ...(config.accessAssertion ? { "Cf-Access-Jwt-Assertion": config.accessAssertion } : {}) }) } });
  if (response.status !== 200) fail(`operations_session_http_${response.status}`);
  const payload = await boundedJson(response);
  if (!object(payload) || typeof payload.csrfToken !== "string" || payload.csrfToken.length < 16 || payload.csrfToken.length > 512
    || /[\r\n]/.test(payload.csrfToken) || payload.user?.isAdministrator !== true) fail("invalid_operations_session");
  return payload.csrfToken;
}

async function request(config, fetcher, path, method, csrfToken, body, expectedStatuses) {
  const headers = { Accept: "application/json", "Cache-Control": "no-store", ...(config.browserContext ? {} : {
    Origin: config.origin, Cookie: config.cookie,
    ...(config.accessAssertion ? { "Cf-Access-Jwt-Assertion": config.accessAssertion } : {}) }) };
  if (body !== undefined) Object.assign(headers, { "Content-Type": "application/json", "X-CSRF-Token": csrfToken,
    "Idempotency-Key": body.mutationId });
  const response = await fetcher(`${config.origin}${path}`, { method, redirect: "manual", cache: "no-store", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status >= 300 && response.status < 400) fail("operations_redirect_denied");
  const payload = await boundedJson(response);
  if (!expectedStatuses.includes(response.status)) fail(`operations_http_${response.status}`);
  return { httpStatus: response.status, payload };
}

function syntheticCreate(config) {
  const mutationId = randomUUID();
  return { kind: "client", mutationId, sourceIds: [config.sourceId],
    scopes: [{ businessAreaId: config.businessAreaId, divisionId: config.divisionId }],
    profile: { name: `${config.prefix}-${mutationId.slice(0, 8)}`, email: "", phone: "", clientType: "unknown",
      addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "" },
    relationship: { organizationRecordId: null, expectedOrganizationVersion: null } };
}

function assertPrepared(result) {
  if (result.httpStatus !== 200 || result.payload?.status !== "prepared") fail("create_admission_missing");
}

function assertCreateOptions(result, config) {
  const value = result.payload;
  if (result.httpStatus !== 200 || !object(value) || value.kind !== "client"
    || !Array.isArray(value.sources) || !Array.isArray(value.scopes)) fail("directory_create_options_missing");
  if (!value.sources.some(source => object(source) && source.id === config.sourceId)) fail("directory_source_not_offered");
  const area = value.scopes.find(scope => object(scope) && scope.id === config.businessAreaId);
  if (!area || !Array.isArray(area.divisions)) fail("directory_business_area_not_offered");
  if (config.divisionId !== null && !area.divisions.some(division => object(division) && division.id === config.divisionId))
    fail("directory_division_not_offered");
}

function assertConflict(result, reason) {
  const safe = safeOutcome(result.payload);
  if (result.httpStatus !== 409 || safe.status !== "conflict" || safe.reason !== reason) fail(`${reason}_missing`);
  return safe;
}

function assertWrite(result, expected) {
  const safe = safeOutcome(result.payload);
  if (![200, 202].includes(result.httpStatus) || !["written", "pending"].includes(safe.status)
    || safe.recordId !== expected.recordId || safe.kind !== "client" || !Number.isSafeInteger(safe.version)
    || safe.version !== expected.version || safe.replayed !== expected.replayed || safe.destinations?.length !== 1
    || safe.destinations[0].sourceId !== expected.sourceId) fail("directory_write_evidence_missing");
  return safe;
}

function reportWrite(value) {
  return { status: value.status, recordId: value.recordId, kind: value.kind, version: value.version,
    replayed: value.replayed, destinationStates: value.destinations.map(destination => destination.state) };
}

async function waitForAcknowledgement(config, fetcher, route, method, csrfToken, body, expected, dependencies) {
  const started = dependencies.now(), deadline = started + config.timeoutMs;
  let polls = 0;
  while (true) {
    const result = await request(config, fetcher, route, method, csrfToken, body, [200, 202, 409]);
    const safe = assertWrite(result, { ...expected, replayed: true });
    polls += 1;
    if (safe.status === "written" && safe.destinations.every(value => value.state === "acknowledged"))
      return { outcome: reportWrite(safe), polls, elapsedMs: dependencies.now() - started };
    if (dependencies.now() >= deadline) fail("project_alpha_ack_timeout");
    await dependencies.sleep(config.pollIntervalMs);
  }
}

function assertExactProfile(result, expected) {
  const value = result.payload;
  if (result.httpStatus !== 200 || !object(value) || value.recordId !== expected.recordId || value.kind !== "client"
    || value.version !== expected.version || JSON.stringify(value.profile) !== JSON.stringify(expected.profile)
    || !Array.isArray(value.scopes) || JSON.stringify(value.scopes) !== JSON.stringify(expected.scopes)
    || value.linkage !== "standalone" || value.relationship?.organization !== null || value.editing?.available !== true)
    fail("exact_profile_read_missing");
  return { status: "verified", recordId: value.recordId, version: value.version, linkage: value.linkage,
    profileSha256: sha256Json(value.profile), scopesSha256: sha256Json(value.scopes) };
}

export async function runDirectoryJoinedAcceptance(config, dependencies = {}) {
  if (!config?.mutate) fail("mutation_allow_required");
  parseOrigin(config.origin);
  const fetcher = dependencies.fetcher ?? fetch;
  const clock = { now: dependencies.now ?? Date.now, sleep: dependencies.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))) };
  const beforePublicLink = await publicLinkProbe(config.publicLinkUrl, fetcher);
  const csrfToken = await acquireSession(config, fetcher), create = syntheticCreate(config);
  const admissionRoute = `${ROOT}/create-admissions`, createRoute = `${ROOT}/standalone-clients`;
  // Check server-owned, actor-scoped choices before any write request. The
  // admission and write endpoints still re-authorize all fields themselves.
  assertCreateOptions(await request(config, fetcher, `${ROOT}/create-options?kind=client`, "GET", csrfToken, undefined, [200]), config);
  const prepared = await request(config, fetcher, admissionRoute, "POST", csrfToken, create, [200]); assertPrepared(prepared);
  const preparedReplay = await request(config, fetcher, admissionRoute, "POST", csrfToken, clone(create), [200]); assertPrepared(preparedReplay);
  const changedAdmission = clone(create); changedAdmission.profile.name += "-changed";
  const admissionConflict = assertConflict(await request(config, fetcher, admissionRoute, "POST", csrfToken, changedAdmission, [409]), "idempotency_body_conflict");

  const firstCreateResult = await request(config, fetcher, createRoute, "POST", csrfToken, create, [200, 202]);
  const firstCreate = assertWrite(firstCreateResult, { recordId: create.mutationId, version: 1, replayed: false, sourceId: config.sourceId });
  const createAck = await waitForAcknowledgement(config, fetcher, createRoute, "POST", csrfToken, create,
    { recordId: create.mutationId, version: 1, sourceId: config.sourceId }, clock);
  const changedCreate = clone(create); changedCreate.profile.name += "-changed";
  const createConflict = assertConflict(await request(config, fetcher, createRoute, "POST", csrfToken, changedCreate, [409]), "idempotency_body_conflict");
  const readRoute = `${ROOT}/standalone-clients/${encodeURIComponent(create.mutationId)}`;
  const createRead = assertExactProfile(await request(config, fetcher, readRoute, "GET", csrfToken, undefined, [200]), {
    recordId: create.mutationId, version: 1, profile: create.profile, scopes: create.scopes,
  });

  const update = { mutationId: randomUUID(), expectedLocalVersion: 1,
    profile: { name: `${create.profile.name}-updated`, email: "", phone: "", addressLine1: "", addressLine2: "",
      city: "", state: "", postalCode: "", country: "" } };
  const firstUpdateResult = await request(config, fetcher, readRoute, "PATCH", csrfToken, update, [200, 202]);
  const firstUpdate = assertWrite(firstUpdateResult, { recordId: create.mutationId, version: 2, replayed: false, sourceId: config.sourceId });
  const updateAck = await waitForAcknowledgement(config, fetcher, readRoute, "PATCH", csrfToken, update,
    { recordId: create.mutationId, version: 2, sourceId: config.sourceId }, clock);
  const changedUpdate = clone(update); changedUpdate.profile.name += "-changed";
  const updateConflict = assertConflict(await request(config, fetcher, readRoute, "PATCH", csrfToken, changedUpdate, [409]), "idempotency_body_conflict");
  const stale = { ...clone(update), mutationId: randomUUID(), profile: { ...update.profile, name: `${update.profile.name}-stale` } };
  const staleConflict = assertConflict(await request(config, fetcher, readRoute, "PATCH", csrfToken, stale, [409]), "stale_local_version");
  const updateRead = assertExactProfile(await request(config, fetcher, readRoute, "GET", csrfToken, undefined, [200]), {
    recordId: create.mutationId, version: 2, profile: { ...update.profile, clientType: "unknown" }, scopes: create.scopes,
  });
  const readback = assertDestinationReadback(await (dependencies.destinationReadback
    ? dependencies.destinationReadback(config, create.mutationId, update.mutationId)
    : destinationReadback(config, create.mutationId, update.mutationId, fetcher)), create.mutationId);
  if (readback.bindingRevision !== String(updateRead.version)) fail("destination_binding_revision_mismatch");
  const afterPublicLink = await publicLinkProbe(config.publicLinkUrl, fetcher);
  assertPublicLinkPreserved(beforePublicLink, afterPublicLink);

  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: true,
    synthetic: { recordId: create.mutationId, createMutationId: create.mutationId, updateMutationId: update.mutationId },
    admission: { first: { status: prepared.payload.status }, replay: { status: preparedReplay.payload.status }, changedBodyConflict: admissionConflict },
    create: { first: reportWrite(firstCreate), acknowledgement: createAck, changedBodyConflict: createConflict, exactRead: createRead },
    update: { first: reportWrite(firstUpdate), acknowledgement: updateAck, changedBodyConflict: updateConflict,
      staleVersionConflict: staleConflict, exactRead: updateRead },
    destinationReadback: readback,
    publicLink: { before: beforePublicLink, after: afterPublicLink },
    credentials: { valuesExcluded: true, sessionPresent: true },
  });
}

function requireBrowserContextConfig(config) {
  if (!config?.mutate) fail("mutation_allow_required");
  if (!config?.browserContext) fail("browser_context_config_required");
  parseOrigin(config.origin);
  if (typeof config.publicLinkUrl !== "string" || parsePublicLink(config.publicLinkUrl) !== config.publicLinkUrl)
    fail("invalid_public_link_url");
  for (const name of ["cookie", "accessAssertion", "d1Token", "d1Target"])
    if (Object.hasOwn(config, name)) fail("browser_context_credentials_forbidden");
}

function browserSafeInit(init, credentials) {
  const headers = new Headers(init?.headers);
  if (headers.has("cookie") || headers.has("cf-access-jwt-assertion") || headers.has("authorization"))
    fail("browser_context_credentials_forbidden");
  if (headers.has("origin")) fail("browser_context_origin_header_forbidden");
  return { ...init, headers: Object.fromEntries(headers), credentials };
}

function approvedBrowserDirectoryRoute(url) {
  if (url.pathname === "/api/session" && !url.search) return true;
  if (url.pathname === `${ROOT}/create-options` && url.search === "?kind=client") return true;
  if ((url.pathname === `${ROOT}/create-admissions` || url.pathname === `${ROOT}/standalone-clients`) && !url.search) return true;
  const detailPrefix = `${ROOT}/standalone-clients/`;
  return url.pathname.startsWith(detailPrefix) && UUID_V4.test(url.pathname.slice(detailPrefix.length)) && !url.search;
}

/** Runs Directory acceptance through an already-authenticated same-origin browser without exporting its credentials. */
export async function runDirectoryJoinedAcceptanceWithBrowserContext(config, dependencies = {}) {
  requireBrowserContextConfig(config);
  const browserContextFetcher = dependencies.browserContextFetcher;
  const publicFetcher = dependencies.publicFetcher ?? fetch;
  const trustedDestinationReadback = dependencies.destinationReadback;
  if (typeof browserContextFetcher !== "function") fail("browser_context_fetcher_required");
  if (typeof publicFetcher !== "function") fail("public_fetcher_required");
  if (typeof trustedDestinationReadback !== "function") fail("destination_readback_required");
  const routedFetcher = async (input, init = {}) => {
    let url;
    try { url = new URL(input); } catch { fail("browser_context_fetch_destination_denied"); }
    if (url.origin === config.origin) {
      if (!approvedBrowserDirectoryRoute(url)) fail("browser_context_fetch_destination_denied");
      return browserContextFetcher(url.toString(), browserSafeInit(init, "same-origin"));
    }
    if (url.toString() !== config.publicLinkUrl) fail("browser_context_fetch_destination_denied");
    return publicFetcher(url.toString(), browserSafeInit(init, "omit"));
  };
  return runDirectoryJoinedAcceptance(config, { ...dependencies, fetcher: routedFetcher,
    destinationReadback: trustedDestinationReadback });
}

async function atomicWriteJson(path, value) {
  const target = resolve(path); await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, target);
}

async function main() {
  const report = await runDirectoryJoinedAcceptance(await parseDirectoryJoinedAcceptanceConfig());
  const index = process.argv.indexOf("--output");
  if (index >= 0) { if (!process.argv[index + 1]) fail("output_path_required"); await atomicWriteJson(process.argv[index + 1], report); }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ status: "failed",
    code: error instanceof DirectoryJoinedAcceptanceError ? error.code : "acceptance_failed" })}\n`); process.exitCode = 1; });
}
