import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STAGING_HOSTS } from "./staging-requirements.mjs";

const ROUTE = "/api/admin/project-alpha/projects/v2/commands";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PUBLIC_LINK_BYTES = 256 * 1024;
const MAX_STORAGE_STATE_BYTES = 1024 * 1024;
const MAX_COOKIE_BYTES = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const APPLICATION_ID = UUID_V4;
const PREFIX = /^ops-joined-acceptance-[a-z0-9][a-z0-9-]{2,60}$/i;
const STAGING_OPERATIONS_ORIGIN = `https://${STAGING_HOSTS.operations}`;
const STAGING_PUBLIC_HOSTS = new Set([STAGING_HOSTS.delivery, STAGING_HOSTS.client, "portal-staging.ledgetoptechnologies.com"]);
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

export class JoinedAcceptanceError extends Error {
  constructor(code) { super(code); this.name = "JoinedAcceptanceError"; this.code = code; }
}

const fail = code => { throw new JoinedAcceptanceError(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => structuredClone(value);
const validExternalId = value => typeof value === "string" && value !== "" && !/\p{C}/u.test(value)
  && [...value].length <= 191 && new TextEncoder().encode(value).byteLength <= 764;

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fail(`missing_${name.toLowerCase()}`);
}

function parseOrigin(value, expected = STAGING_OPERATIONS_ORIGIN) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_operations_base_url"); }
  if (url.origin !== expected || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail("production_or_noncanonical_operations_origin");
  return url.origin;
}

function parsePublicLink(value) {
  if (value === undefined || value === "") return undefined;
  let url;
  try { url = new URL(value); } catch { fail("invalid_public_link_url"); }
  if (url.protocol !== "https:" || url.username || url.password || !STAGING_PUBLIC_HOSTS.has(url.hostname))
    fail("production_or_nonstaging_public_link");
  return url.toString();
}

function parseJson(value, code) {
  try { return JSON.parse(value); } catch { fail(code); }
}

function parseIdentity(env) {
  const identity = {
    sourceId: required(env, "OPS_PROJECT_ALPHA_SOURCE_ID"),
    applicationId: required(env, "OPS_PROJECT_ALPHA_APPLICATION_ID"),
  };
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(identity.sourceId) || !APPLICATION_ID.test(identity.applicationId))
    fail("invalid_project_alpha_identity");
  return identity;
}

function parseScopes(env) {
  const value = parseJson(required(env, "OPS_ACCEPTANCE_SCOPES_JSON"), "invalid_acceptance_scopes_json");
  if (!Array.isArray(value) || value.length > 128) fail("invalid_acceptance_scopes_json");
  for (const scope of value) {
    if (!object(scope) || typeof scope.scopeKind !== "string" || typeof scope.businessAreaId !== "string" || !scope.businessAreaId.trim())
      fail("invalid_acceptance_scopes_json");
    if (scope.scopeKind === "business_area") {
      if (scope.divisionId !== null) fail("invalid_acceptance_scopes_json");
    } else if (scope.scopeKind === "division") {
      if (typeof scope.divisionId !== "string" || !scope.divisionId.trim()) fail("invalid_acceptance_scopes_json");
    } else fail("invalid_acceptance_scopes_json");
  }
  return value;
}

function parseDirectoryProof(env) {
  const organization = {
    organizationRecordId: required(env, "OPS_ACCEPTANCE_ORGANIZATION_RECORD_ID"),
    expectedPublicId: required(env, "OPS_ACCEPTANCE_ORGANIZATION_PUBLIC_ID"),
    expectedRevision: required(env, "OPS_ACCEPTANCE_ORGANIZATION_REVISION"),
    expectedProjectionSha256: required(env, "OPS_ACCEPTANCE_ORGANIZATION_PROJECTION_SHA256"),
  };
  if (!validExternalId(organization.organizationRecordId) || !/^[0-9a-f]{32}$/.test(organization.expectedPublicId)
    || !/^[1-9][0-9]{0,18}$/.test(organization.expectedRevision) || !SHA256.test(organization.expectedProjectionSha256))
    fail("invalid_organization_proof");
  const clientRecordId = env.OPS_ACCEPTANCE_CLIENT_RECORD_ID?.trim() || null;
  const clientPublicId = env.OPS_ACCEPTANCE_CLIENT_PUBLIC_ID?.trim() || null;
  const client = clientRecordId || clientPublicId ? {
    recordId: clientRecordId, publicId: clientPublicId,
    revision: env.OPS_ACCEPTANCE_CLIENT_REVISION?.trim() || "", hash: env.OPS_ACCEPTANCE_CLIENT_PROJECTION_SHA256?.trim() || "",
  } : null;
  if (client && (!client.recordId || !client.publicId || !client.revision || !client.hash || !validExternalId(client.recordId)
    || !/^[0-9a-f]{32}$/.test(client.publicId) || !/^[1-9][0-9]{0,18}$/.test(client.revision) || !SHA256.test(client.hash)))
    fail("invalid_client_proof");
  return { organization, client };
}

async function readStorageState(path, expectedHost) {
  const absolute = resolve(path);
  const info = await lstat(absolute).catch(() => fail("invalid_operations_storage_state"));
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORAGE_STATE_BYTES) fail("invalid_operations_storage_state");
  let parsed;
  try { parsed = JSON.parse(await readFile(absolute, "utf8")); } catch { fail("invalid_operations_storage_state"); }
  if (!Array.isArray(parsed?.cookies)) fail("invalid_operations_storage_state");
  const cookies = parsed.cookies.filter(cookie => {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string" || !cookie.name || /[\r\n;=]/.test(cookie.name)
      || /[\r\n]/.test(cookie.value)) return false;
    const domain = typeof cookie.domain === "string" ? cookie.domain.replace(/^\./, "").toLowerCase() : "";
    return cookie.name === "CF_Authorization" && domain === expectedHost && cookie.secure === true;
  });
  if (cookies.length !== 1) fail("operations_session_required");
  const value = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  if (value.length > MAX_COOKIE_BYTES) fail("operations_session_too_large");
  return value;
}

async function sessionCookie(env, origin) {
  if (typeof env.OPS_SESSION_COOKIE === "string" && env.OPS_SESSION_COOKIE.trim()) {
    const value = env.OPS_SESSION_COOKIE.trim();
    if (value.length > MAX_COOKIE_BYTES || /[\r\n]/.test(value) || !/^CF_Authorization=[^;\r\n]+$/.test(value)) fail("invalid_operations_session");
    return value;
  }
  const path = env.OPS_STORAGE_STATE;
  if (!path) fail("operations_session_required");
  return readStorageState(path, new URL(origin).hostname);
}

function optionalAccessAssertion(env) {
  const value = env.OPS_CF_ACCESS_JWT_ASSERTION?.trim();
  if (value === undefined || value === "") return undefined;
  if (value.length > MAX_COOKIE_BYTES || /[\r\n]/.test(value)) fail("invalid_access_assertion");
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some(segment => !JWT_SEGMENT.test(segment))) fail("invalid_access_assertion");
  return value;
}

export async function parseJoinedAcceptanceConfig(env = process.env) {
  const origin = parseOrigin(env.OPS_BASE_URL || STAGING_OPERATIONS_ORIGIN);
  const mutate = env.OPS_ACCEPTANCE_ALLOW_MUTATIONS === "allow";
  if (!mutate) return Object.freeze({ origin, mutate: false });
  const prefix = required(env, "OPS_ACCEPTANCE_PREFIX");
  if (!PREFIX.test(prefix)) fail("invalid_acceptance_prefix");
  const identity = parseIdentity(env);
  const proof = parseDirectoryProof(env);
  const scopes = parseScopes(env);
  const authorizationGeneration = required(env, "OPS_ACCEPTANCE_AUTHORIZATION_GENERATION");
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(authorizationGeneration)) fail("invalid_authorization_generation");
  const cookie = await sessionCookie(env, origin);
  const publicLinkUrl = parsePublicLink(required(env, "OPS_ACCEPTANCE_PUBLIC_LINK_URL"));
  return Object.freeze({ origin, mutate: true, prefix, identity, proof, scopes, authorizationGeneration, cookie,
    accessAssertion: optionalAccessAssertion(env), publicLinkUrl,
  });
}

async function boundedBytes(response, maximum) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maximum) fail("response_too_large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel(); fail("response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function jsonResponse(response) {
  const bytes = await boundedBytes(response, MAX_RESPONSE_BYTES);
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("invalid_operations_response"); }
  return { payload, responseSha256: sha256Bytes(bytes) };
}

function safeOutcome(value) {
  if (!object(value)) fail("invalid_operations_outcome");
  const safe = {};
  for (const key of ["status", "reason", "receiptId", "activationId", "settlementId", "commandId", "externalProjectId"]) {
    if (typeof value[key] === "string") safe[key] = value[key];
  }
  for (const key of ["replayed", "accepted"]) if (typeof value[key] === "boolean") safe[key] = value[key];
  if (Number.isSafeInteger(value.version)) safe.version = value.version;
  if (typeof safe.status !== "string") fail("invalid_operations_outcome");
  return safe;
}

function safeResponse(payload, responseSha256) {
  if (!object(payload) || typeof payload.stage !== "string") fail("invalid_operations_response");
  return { stage: payload.stage, outcome: safeOutcome(payload.outcome), responseSha256 };
}

async function acquireSession(config, fetcher) {
  const response = await fetcher(`${config.origin}/api/session`, { method: "GET", redirect: "manual", cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-store", Origin: config.origin, Cookie: config.cookie,
      ...(config.accessAssertion ? { "Cf-Access-Jwt-Assertion": config.accessAssertion } : {}) } });
  if (response.status >= 300 && response.status < 400) fail("operations_session_redirect_denied");
  if (response.status !== 200) fail(`operations_session_http_${response.status}`);
  const parsed = await jsonResponse(response);
  const user = parsed.payload?.user, permissions = user?.permissions;
  if (!object(parsed.payload) || typeof parsed.payload.csrfToken !== "string" || parsed.payload.csrfToken.length < 16
    || parsed.payload.csrfToken.length > 512 || /[\r\n]/.test(parsed.payload.csrfToken)
    || !object(user) || user.isAdministrator !== true || !Array.isArray(permissions) || !permissions.includes("integrations.manage"))
    fail("invalid_operations_session");
  return parsed.payload.csrfToken;
}

function generatedCommand(config) {
  const commandId = randomUUID();
  const externalId = `${config.prefix}:project:${commandId}`;
  const name = `${config.prefix} disposable project ${commandId.slice(0, 8)}`;
  return {
    sourceId: config.identity.sourceId, expectedApplicationId: config.identity.applicationId, operation: "create",
    scopes: clone(config.scopes), local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
    directory: { organizationRecordId: config.proof.organization.organizationRecordId, clientRecordId: config.proof.client?.recordId ?? null },
    command: {
      commandId, externalId, expectedAuthorizationGeneration: config.authorizationGeneration,
      project: { name, description: "staging-only joined Project-v2 acceptance", estimatedStart: null, estimatedEnd: null },
      organization: { externalId: config.proof.organization.organizationRecordId, expectedPublicId: config.proof.organization.expectedPublicId,
        expectedRevision: config.proof.organization.expectedRevision, expectedProjectionSha256: config.proof.organization.expectedProjectionSha256 },
      client: config.proof.client ? { externalId: config.proof.client.recordId, expectedPublicId: config.proof.client.publicId,
        expectedRevision: config.proof.client.revision, expectedProjectionSha256: config.proof.client.hash } : null,
    },
  };
}

async function postCommand(config, command, fetcher, expectedStatuses = [200]) {
  const body = JSON.stringify(command);
  const response = await fetcher(`${config.origin}${ROUTE}`, { method: "POST", redirect: "manual", cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store", Origin: config.origin,
      Cookie: config.cookie, "X-CSRF-Token": config.csrfToken, "Idempotency-Key": command.command.commandId,
      ...(config.accessAssertion ? { "Cf-Access-Jwt-Assertion": config.accessAssertion } : {}) }, body });
  if (response.status >= 300 && response.status < 400) fail("operations_redirect_denied");
  const parsed = await jsonResponse(response);
  if (!expectedStatuses.includes(response.status)) fail(`operations_http_${response.status}`);
  return safeResponse(parsed.payload, parsed.responseSha256);
}

async function publicLinkProbe(url, fetcher) {
  const response = await fetcher(url, { method: "GET", redirect: "manual", cache: "no-store", headers: { Accept: "text/html,application/json" } });
  if (response.status >= 300 && response.status < 400) fail("public_link_redirect_denied");
  const bytes = await boundedBytes(response, MAX_PUBLIC_LINK_BYTES);
  return { status: response.status, bodySha256: sha256Bytes(bytes), contentType: response.headers.get("content-type")?.split(";", 1)[0] || null };
}

function assertPublicLinkPreserved(before, after) {
  if (before.status !== 200) fail("public_link_not_accessible_before");
  if (after.status !== before.status || after.bodySha256 !== before.bodySha256 || after.contentType !== before.contentType)
    fail("public_link_changed");
}

function assertActivated(result, replayed, command) {
  const outcome = result.outcome;
  if (result.stage !== "activate" || outcome.status !== "activated" || outcome.replayed !== replayed
    || !UUID_V4.test(outcome.activationId || "") || !UUID_V4.test(outcome.settlementId || "")
    || outcome.commandId !== command.command.commandId || outcome.externalProjectId !== command.command.externalId
    || !Number.isSafeInteger(outcome.version) || outcome.version < 1)
    fail(replayed ? "replay_activation_missing" : "activation_missing");
}

export async function runJoinedAcceptance(config, dependencies = {}) {
  if (!config?.mutate) fail("mutation_allow_required");
  const fetcher = dependencies.fetcher ?? fetch;
  const csrfToken = await acquireSession(config, fetcher);
  const requestConfig = { ...config, csrfToken };
  const command = generatedCommand(requestConfig);
  const before = await publicLinkProbe(requestConfig.publicLinkUrl, fetcher);
  const first = await postCommand(requestConfig, command, fetcher);
  assertActivated(first, false, command);
  const replay = await postCommand(requestConfig, clone(command), fetcher);
  assertActivated(replay, true, command);
  if (replay.outcome.activationId !== first.outcome.activationId
    || replay.outcome.settlementId !== first.outcome.settlementId
    || replay.outcome.version !== first.outcome.version)
    fail("replay_identity_changed");
  const changed = clone(command);
  changed.command.project.name = `${changed.command.project.name} changed`;
  const conflict = await postCommand(requestConfig, changed, fetcher, [200, 409]);
  if (conflict.stage !== "plan" || conflict.outcome.status !== "conflict" || conflict.outcome.reason !== "command_id")
    fail("changed_body_conflict_missing");
  const after = await publicLinkProbe(requestConfig.publicLinkUrl, fetcher);
  assertPublicLinkPreserved(before, after);
  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", observedAt: new Date(dependencies.now ?? Date.now()).toISOString(),
    mutationsPerformed: true, command: { commandId: command.command.commandId, externalProjectId: command.command.externalId, operation: "create" },
    exactReplay: { first, replay }, changedBodyConflict: conflict,
    readSettlement: { status: first.outcome.status === "activated" ? "evidence_present" : "missing", settlementId: first.outcome.settlementId },
    canonicalActivation: first.outcome.status === "activated" ? { status: "evidence_present", activationId: first.outcome.activationId, version: first.outcome.version } : { status: "missing" },
    publicLink: { before, after }, credentials: { valuesExcluded: true, sessionPresent: true },
  });
}

async function atomicWriteJson(path, value) {
  const target = resolve(path); await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, target);
}

async function main() {
  const config = await parseJoinedAcceptanceConfig();
  const report = await runJoinedAcceptance(config);
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) { if (!process.argv[outputIndex + 1]) fail("output_path_required"); await atomicWriteJson(process.argv[outputIndex + 1], report); }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof JoinedAcceptanceError ? error.code : "acceptance_failed" })}\n`); process.exitCode = 1; });
}
