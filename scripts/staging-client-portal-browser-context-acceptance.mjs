import { createHash } from "node:crypto";
import { compilePortalByteFixture } from "./staging-portal-byte-fixture.mjs";

export const CLIENT_PORTAL_BROWSER_ACCEPTANCE_ORIGIN = "https://client-staging.ledgetopdroneservices.com";
const CLIENT_ORIGIN = CLIENT_PORTAL_BROWSER_ACCEPTANCE_ORIGIN;
const HOME_PATH = "/api/client/v2/operations/home";
const SESSION_PATH = "/api/client/session";
const DELIVERY_BASE = "/api/client/operations/data";
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024;
const MAX_PAGES = 128;
const MAX_ENTRIES = 4096;
const MAX_HANDLE_LENGTH = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HANDLE = /^ond1_[A-Za-z0-9_-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_BROWSER_HEADERS = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
  "origin",
]);

export class ClientPortalBrowserAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ClientPortalBrowserAcceptanceError";
    this.code = code;
  }
}

const fail = code => { throw new ClientPortalBrowserAcceptanceError(code); };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value >= 1;
const bounded = (value, maximum) => typeof value === "string" && value.length >= 1
  && value.length <= maximum && value.trim() === value && !CONTROL.test(value);
const validHandle = value => typeof value === "string" && value.length <= MAX_HANDLE_LENGTH && HANDLE.test(value);

function exact(value, keys, code) {
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== "string")
    || !sameStrings(Object.keys(value), keys)
    || Object.keys(value).some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
    })) fail(code);
  return value;
}

function sameStrings(left, right) {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function parseOrigin(value) {
  let url;
  try { url = new URL(value ?? CLIENT_ORIGIN); } catch { fail("invalid_client_origin"); }
  if (url.origin !== CLIENT_ORIGIN || url.protocol !== "https:" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) fail("production_or_noncanonical_client_origin");
  return url.origin;
}

function parseExpectedHome(value) {
  exact(value, ["authorityId", "workspaceId", "ownershipEpoch", "grantRevision", "serviceIds"], "invalid_expected_home");
  if (!UUID.test(value.authorityId) || !bounded(value.workspaceId, 200) || !positive(value.ownershipEpoch)
    || !positive(value.grantRevision) || !Array.isArray(value.serviceIds) || value.serviceIds.length > 100
    || value.serviceIds.some(service => !bounded(service, 191))
    || new Set(value.serviceIds).size !== value.serviceIds.length) fail("invalid_expected_home");
  return structuredClone(value);
}

function validateManifest(value) {
  exact(value, ["schemaVersion", "stagingOnly", "accountId", "bucketName", "targetId", "selectedPrefix", "runId", "objects"], "invalid_private_manifest");
  if (value.schemaVersion !== 1 || value.stagingOnly !== true || !bounded(value.accountId, 64)
    || !bounded(value.bucketName, 128) || !UUID.test(value.targetId) || !bounded(value.selectedPrefix, 1024)
    || !UUID.test(value.runId) || !Array.isArray(value.objects) || value.objects.length < 2 || value.objects.length > 32)
    fail("invalid_private_manifest");
  const roles = new Set(), keys = new Set(), selected = [], excluded = [];
  for (const raw of value.objects) {
    exact(raw, ["role", "key", "bytes", "size", "sha256", "customMetadata"], "invalid_private_manifest_object");
    exact(raw.customMetadata, ["fixture", "runId", "role", "sha256"], "invalid_private_manifest_metadata");
    if (!bounded(raw.role, 128) || !bounded(raw.key, 2048) || typeof raw.bytes !== "string"
      || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_FILE_BYTES || !SHA256.test(raw.sha256)
      || raw.customMetadata.fixture !== "staging-portal-byte-v1" || raw.customMetadata.runId !== value.runId
      || raw.customMetadata.role !== raw.role || raw.customMetadata.sha256 !== raw.sha256
      || roles.has(raw.role) || keys.has(raw.key)) fail("invalid_private_manifest_object");
    const bytes = Buffer.from(raw.bytes);
    if (bytes.length !== raw.size || sha256(bytes) !== raw.sha256) fail("private_manifest_byte_hash_mismatch");
    roles.add(raw.role); keys.add(raw.key);
    const item = { role: raw.role, key: raw.key, size: raw.size, sha256: raw.sha256 };
    if (raw.role.startsWith("selected-")) {
      if (!raw.key.startsWith(value.selectedPrefix)) fail("selected_manifest_scope_mismatch");
      const relative = raw.key.slice(value.selectedPrefix.length);
      const parts = relative.split("/");
      if (!relative || parts.some(part => !bounded(part, 500) || part === "." || part === ".."))
        fail("invalid_selected_manifest_path");
      selected.push({ ...item, parts });
    } else {
      if (raw.key.startsWith(value.selectedPrefix)) fail("excluded_manifest_scope_mismatch");
      excluded.push({ ...item, name: raw.key.split("/").at(-1) });
    }
  }
  if (!selected.length || !excluded.length) fail("manifest_selected_and_excluded_required");
  if (canonical(value) !== canonical(compilePortalByteFixture(value.runId))) fail("private_manifest_changed");
  return { bindingSha256: sha256(canonical(value)), selected, excluded };
}

export function parseClientPortalBrowserAcceptanceConfig(value) {
  exact(value, ["origin", "expectedHome", "expectedDeliveryLabel", "manifest", "actions"], "invalid_acceptance_config");
  const origin = parseOrigin(value.origin);
  const expectedHome = parseExpectedHome(value.expectedHome);
  if (!bounded(value.expectedDeliveryLabel, 500)) fail("invalid_delivery_label");
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 2
    || value.actions.some(action => !["preview", "download"].includes(action))
    || new Set(value.actions).size !== value.actions.length) fail("invalid_content_actions");
  const manifest = validateManifest(value.manifest);
  return Object.freeze({ origin, expectedHome, expectedDeliveryLabel: value.expectedDeliveryLabel,
    actions: Object.freeze([...value.actions]), manifest: Object.freeze(manifest) });
}

function browserInit(init = {}) {
  const headers = new Headers(init.headers);
  for (const name of FORBIDDEN_BROWSER_HEADERS) if (headers.has(name)) fail("browser_context_credentials_forbidden");
  if (init.body !== undefined && init.body !== null) fail("read_only_browser_context_required");
  const method = (init.method ?? "GET").toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) fail("read_only_browser_context_required");
  return { ...init, method, body: undefined, headers: Object.fromEntries(headers), credentials: "same-origin",
    redirect: "error", cache: "no-store" };
}

export function isClientPortalBrowserAcceptanceUrl(url) {
  if (!(url instanceof URL) || url.origin !== CLIENT_ORIGIN || url.username || url.password) return false;
  if (url.pathname === HOME_PATH || url.pathname === SESSION_PATH)
    return !url.search && !url.hash;
  if (url.pathname === `${DELIVERY_BASE}/deliveries`)
    return !url.hash && [...url.searchParams.keys()].every(key => key === "cursor") && url.searchParams.getAll("cursor").length <= 1
      && (!url.searchParams.has("cursor") || validHandle(url.searchParams.get("cursor") ?? ""));
  const folder = new RegExp(`^${DELIVERY_BASE}/folders/(ond1_[A-Za-z0-9_-]+)$`, "u").exec(url.pathname);
  if (folder) return validHandle(folder[1]) && !url.hash && [...url.searchParams.keys()].every(key => key === "cursor")
    && url.searchParams.getAll("cursor").length <= 1
    && (!url.searchParams.has("cursor") || validHandle(url.searchParams.get("cursor") ?? ""));
  const file = new RegExp(`^${DELIVERY_BASE}/files/(ond1_[A-Za-z0-9_-]+)(?:/(preview|download))?$`, "u").exec(url.pathname);
  return Boolean(file && validHandle(file[1]) && !url.search && !url.hash);
}

function contextRequest(config, fetcher, path, init = {}) {
  if (typeof fetcher !== "function") fail("browser_context_fetcher_required");
  let url;
  try { url = new URL(path, config.origin); } catch { fail("browser_context_fetch_destination_denied"); }
  if (url.origin !== config.origin || !isClientPortalBrowserAcceptanceUrl(url)) fail("browser_context_fetch_destination_denied");
  return fetcher(url.toString(), browserInit(init));
}

async function bytes(response, maximum, code = "response_too_large") {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) fail(code);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) { await reader.cancel(); fail(code); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function json(response, expectedStatus = 200) {
  if (response.status >= 300 && response.status < 400) fail("browser_context_redirect_denied");
  if (response.status !== expectedStatus) fail(`unexpected_http_${response.status}`);
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("invalid_json_content_type");
  let result;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, MAX_JSON_BYTES))); }
  catch (error) { if (error instanceof ClientPortalBrowserAcceptanceError) throw error; fail("invalid_json_response"); }
  return result;
}

function parseHome(value) {
  exact(value, ["resourceMode", "homes"], "invalid_service_home");
  if (value.resourceMode !== "operations_home" || !Array.isArray(value.homes) || value.homes.length > 20) fail("invalid_service_home");
  const parsed = value.homes.map(home => {
    exact(home, ["authorityId", "workspaceId", "ownershipEpoch", "grantRevision", "services"], "invalid_service_home");
    if (!UUID.test(home.authorityId) || !bounded(home.workspaceId, 200) || !positive(home.ownershipEpoch)
      || !positive(home.grantRevision) || !Array.isArray(home.services) || home.services.length > 100) fail("invalid_service_home");
    const serviceIds = home.services.map(service => {
      exact(service, ["serviceId", "providerId", "displayLabel", "revision"], "invalid_service_home");
      if (!bounded(service.serviceId, 191) || !bounded(service.providerId, 128) || !bounded(service.displayLabel, 160)
        || !positive(service.revision)) fail("invalid_service_home");
      return service.serviceId;
    });
    if (new Set(serviceIds).size !== serviceIds.length) fail("invalid_service_home");
    return { authorityId: home.authorityId, workspaceId: home.workspaceId, ownershipEpoch: home.ownershipEpoch,
      grantRevision: home.grantRevision, serviceIds };
  });
  const authorityIds = new Set(), tuples = new Set();
  for (const home of parsed) {
    const tuple = `${home.authorityId}\0${home.workspaceId}\0${home.ownershipEpoch}\0${home.grantRevision}`;
    if (authorityIds.has(home.authorityId) || tuples.has(tuple)) fail("invalid_service_home");
    authorityIds.add(home.authorityId); tuples.add(tuple);
  }
  return parsed;
}

async function readExpectedHome(config, fetcher) {
  const homes = parseHome(await json(await contextRequest(config, fetcher, HOME_PATH,
    { headers: { Accept: "application/json", "Cache-Control": "no-store" } })));
  const expected = config.expectedHome;
  const matches = homes.filter(home => home.authorityId === expected.authorityId && home.workspaceId === expected.workspaceId
    && home.ownershipEpoch === expected.ownershipEpoch && home.grantRevision === expected.grantRevision
    && sameStrings(home.serviceIds, expected.serviceIds));
  if (matches.length !== 1) fail("expected_service_home_missing_or_ambiguous");
  return { status: 200, bindingSha256: sha256(canonical(expected)), ownershipEpoch: expected.ownershipEpoch,
    grantRevision: expected.grantRevision, serviceCount: expected.serviceIds.length,
    serviceIdsSha256: sha256(canonical([...expected.serviceIds].sort())) };
}

function parseDiscovery(value) {
  exact(value, ["resourceMode", "items", "page"], "invalid_delivery_discovery");
  exact(value.page, ["nextCursor"], "invalid_delivery_discovery");
  if (value.resourceMode !== "operations_native_delivery" || !Array.isArray(value.items) || value.items.length > 25
    || value.page.nextCursor !== null && !validHandle(value.page.nextCursor)) fail("invalid_delivery_discovery");
  const items = value.items.map(item => {
    exact(item, ["id", "displayName"], "invalid_delivery_discovery");
    if (!validHandle(item.id) || !bounded(item.displayName, 500)) fail("invalid_delivery_discovery");
    return item;
  });
  if (new Set(items.map(item => item.id)).size !== items.length) fail("duplicate_delivery_selector");
  return { items, nextCursor: value.page.nextCursor };
}

function parseListing(value, requestedHandle) {
  exact(value, ["resourceMode", "files", "folders", "breadcrumbs", "folderId", "prefix", "cursor"], "invalid_folder_listing");
  if (value.resourceMode !== "operations_native_delivery" || value.folderId !== requestedHandle || value.prefix !== ""
    || !Array.isArray(value.files) || !Array.isArray(value.folders) || !Array.isArray(value.breadcrumbs)
    || value.files.length + value.folders.length > 25 || value.breadcrumbs.length > 512
    || value.cursor !== null && !validHandle(value.cursor)) fail("invalid_folder_listing");
  const folders = value.folders.map(folder => {
    exact(folder, ["id", "name"], "invalid_folder_listing");
    if (!validHandle(folder.id) || !bounded(folder.name, 500)) fail("invalid_folder_listing");
    return folder;
  });
  for (const breadcrumb of value.breadcrumbs) {
    exact(breadcrumb, ["id", "name"], "invalid_folder_listing");
    if (!validHandle(breadcrumb.id) || !bounded(breadcrumb.name, 500)) fail("invalid_folder_listing");
  }
  const files = value.files.map(file => {
    exact(file, ["id", "name", "size", "uploadedAt", "contentType", "kind", "previewPath", "thumbnailPath", "downloadPath"], "invalid_folder_listing");
    if (!validHandle(file.id) || !bounded(file.name, 500) || !Number.isSafeInteger(file.size) || file.size < 0
      || !bounded(file.uploadedAt, 80) || file.contentType !== null && !bounded(file.contentType, 256)
      || !["image", "video", "audio", "pdf", "text", "other"].includes(file.kind) || file.thumbnailPath !== null)
      fail("invalid_folder_listing");
    for (const action of ["preview", "download"]) {
      const path = file[`${action}Path`];
      if (path !== null && path !== `${DELIVERY_BASE}/files/${file.id}/${action}`) fail("invalid_file_action_path");
    }
    return file;
  });
  const selectors = [...folders, ...files].map(item => item.id);
  if (new Set(selectors).size !== selectors.length) fail("duplicate_folder_entry_selector");
  return { files, folders, nextCursor: value.cursor };
}

async function deliveryHandle(config, fetcher) {
  let cursor = null, pages = 0, entries = 0, match = null;
  const seen = new Set();
  do {
    if (++pages > MAX_PAGES || cursor && seen.has(cursor)) fail("delivery_pagination_bound_exceeded");
    if (cursor) seen.add(cursor);
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = parseDiscovery(await json(await contextRequest(config, fetcher, `${DELIVERY_BASE}/deliveries${suffix}`,
      { headers: { Accept: "application/json", "Cache-Control": "no-store" } })));
    entries += page.items.length;
    if (entries > MAX_ENTRIES) fail("delivery_entry_bound_exceeded");
    for (const item of page.items) if (item.displayName === config.expectedDeliveryLabel) {
      if (match) fail("expected_delivery_ambiguous");
      match = item.id;
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (!match) fail("expected_delivery_missing");
  return { handle: match, pages, entries };
}

async function listing(config, fetcher, handle) {
  let cursor = null, pages = 0, entries = 0;
  const seen = new Set(), files = [], folders = [];
  do {
    if (++pages > MAX_PAGES || cursor && seen.has(cursor)) fail("folder_pagination_bound_exceeded");
    if (cursor) seen.add(cursor);
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = parseListing(await json(await contextRequest(config, fetcher,
      `${DELIVERY_BASE}/folders/${encodeURIComponent(handle)}${suffix}`,
      { headers: { Accept: "application/json", "Cache-Control": "no-store" } })), handle);
    entries += page.files.length + page.folders.length;
    if (entries > MAX_ENTRIES) fail("folder_entry_bound_exceeded");
    files.push(...page.files); folders.push(...page.folders); cursor = page.nextCursor;
  } while (cursor);
  const names = [...files, ...folders].map(item => item.name);
  if (new Set(names).size !== names.length) fail("duplicate_folder_entry_name");
  return { files, folders, pages, entries };
}

async function resolveSelectedFiles(config, fetcher, rootHandle) {
  const cache = new Map(), resolved = [];
  const read = async handle => {
    if (!cache.has(handle)) cache.set(handle, await listing(config, fetcher, handle));
    return cache.get(handle);
  };
  for (const expected of config.manifest.selected) {
    let handle = rootHandle;
    for (const segment of expected.parts.slice(0, -1)) {
      const page = await read(handle);
      const matches = page.folders.filter(folder => folder.name === segment);
      if (matches.length !== 1) fail("selected_folder_path_missing_or_ambiguous");
      handle = matches[0].id;
    }
    const page = await read(handle), name = expected.parts.at(-1);
    const matches = page.files.filter(file => file.name === name);
    if (matches.length !== 1 || matches[0].size !== expected.size) fail("selected_file_missing_or_mismatched");
    resolved.push({ expected, file: matches[0] });
  }
  const observedNames = [...cache.values()].flatMap(page => [...page.files, ...page.folders].map(item => item.name));
  for (const item of config.manifest.excluded) if (observedNames.includes(item.name)) fail("excluded_fixture_visible");
  return { resolved, listings: cache.size, listingPages: [...cache.values()].reduce((sum, item) => sum + item.pages, 0),
    observedEntries: [...cache.values()].reduce((sum, item) => sum + item.entries, 0) };
}

async function verifyContent(config, fetcher, selected) {
  const evidence = [];
  for (const { expected, file } of selected) for (const action of config.actions) {
    const path = file[`${action}Path`];
    if (path === null) fail(`selected_file_${action}_unavailable`);
    const response = await contextRequest(config, fetcher, path,
      { headers: { Accept: "*/*", "Cache-Control": "no-store" } });
    if (response.status >= 300 && response.status < 400) fail("browser_context_redirect_denied");
    if (response.status !== 200) fail(`selected_file_${action}_http_${response.status}`);
    const actual = await bytes(response, Math.min(MAX_FILE_BYTES, expected.size + 1), "selected_file_response_too_large");
    const digest = sha256(actual);
    if (actual.length !== expected.size || digest !== expected.sha256) fail("selected_file_byte_hash_mismatch");
    evidence.push({ role: expected.role, action, status: response.status, size: actual.length, sha256: digest,
      contentType: response.headers.get("content-type")?.split(";", 1)[0] || null });
  }
  return evidence;
}

export async function runClientPortalBrowserContextAcceptance(configValue, dependencies = {}) {
  const config = parseClientPortalBrowserAcceptanceConfig(configValue);
  const fetcher = dependencies.browserContextFetcher;
  const home = await readExpectedHome(config, fetcher);
  const discovery = await deliveryHandle(config, fetcher);
  const selected = await resolveSelectedFiles(config, fetcher, discovery.handle);
  const files = await verifyContent(config, fetcher, selected.resolved);
  if (dependencies.capturePrivateProof !== undefined) {
    if (typeof dependencies.capturePrivateProof !== "function") fail("invalid_private_proof_sink");
    await dependencies.capturePrivateProof(Object.freeze({ schemaVersion: 1, deliveryHandle: discovery.handle,
      files: Object.freeze(selected.resolved.map(({ expected, file }) => Object.freeze({ role: expected.role, fileHandle: file.id }))) }));
  }
  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: false,
    observedAt: new Date(dependencies.now ?? Date.now()).toISOString(),
    credentials: { browserContext: true, nativeSameOrigin: true, valuesExcluded: true }, home,
    delivery: { labelSha256: sha256(config.expectedDeliveryLabel), pages: discovery.pages, observedEntries: discovery.entries,
      listingCount: selected.listings, listingPages: selected.listingPages, listedEntries: selected.observedEntries },
    manifest: { bindingSha256: config.manifest.bindingSha256, selectedCount: config.manifest.selected.length,
      excludedCount: config.manifest.excluded.length, excludedNamesObserved: 0 }, files });
}

function denialPath(input) {
  exact(input, ["kind", "handle", "action"], "invalid_denial_probe");
  if (!validHandle(input.handle)) fail("invalid_denial_probe");
  if (input.kind === "folder" && input.action === "list")
    return `${DELIVERY_BASE}/folders/${encodeURIComponent(input.handle)}`;
  if (input.kind === "file" && ["metadata", "preview", "download"].includes(input.action))
    return `${DELIVERY_BASE}/files/${encodeURIComponent(input.handle)}${input.action === "metadata" ? "" : `/${input.action}`}`;
  fail("invalid_denial_probe");
}

async function expectDenied(config, fetcher, input) {
  const response = await contextRequest(config, fetcher, denialPath(input), { headers: { Accept: "application/json" } });
  if (response.status >= 300 && response.status < 400) fail("browser_context_redirect_denied");
  await bytes(response, 64 * 1024);
  if (response.status !== 404) fail(`opaque_handle_denial_http_${response.status}`);
  return { kind: input.kind, action: input.action, status: 404 };
}

export async function checkClientPortalOldHandleDenial(configValue, input, dependencies = {}) {
  const config = parseClientPortalBrowserAcceptanceConfig(configValue), fetcher = dependencies.browserContextFetcher;
  denialPath(input);
  const home = await readExpectedHome(config, fetcher);
  const denial = await expectDenied(config, fetcher, input);
  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: false,
    observedAt: new Date(dependencies.now ?? Date.now()).toISOString(), check: "old_handle_denial",
    credentials: { browserContext: true, nativeSameOrigin: true, valuesExcluded: true }, home, denial });
}

export async function checkClientPortalServiceHomeDenial(configValue, dependencies = {}) {
  const config = parseClientPortalBrowserAcceptanceConfig(configValue);
  const response = await contextRequest(config, dependencies.browserContextFetcher, HOME_PATH,
    { headers: { Accept: "application/json", "Cache-Control": "no-store" } });
  if (response.status >= 300 && response.status < 400) fail("browser_context_redirect_denied");
  await bytes(response, 64 * 1024);
  if (response.status !== 403) fail(`service_home_denial_http_${response.status}`);
  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: false,
    observedAt: new Date(dependencies.now ?? Date.now()).toISOString(), check: "service_home_denial", statusCode: 403,
    credentials: { browserContext: true, nativeSameOrigin: true, valuesExcluded: true } });
}

/** Checks denial in one supplied context only. This deliberately makes no
 * identity/distinct-principal claim: the observation orchestrator must bind
 * genuine principals before and after these actual read-only requests. */
export async function checkClientPortalUnenrolledContextDenial(configValue, input, dependencies = {}) {
  const config = parseClientPortalBrowserAcceptanceConfig(configValue);
  denialPath(input);
  const home = await checkClientPortalServiceHomeDenial(configValue, dependencies);
  const denial = await expectDenied(config, dependencies.browserContextFetcher, input);
  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: false,
    observedAt: new Date(dependencies.now ?? Date.now()).toISOString(), check: "unenrolled_context_denial",
    homeStatus: home.statusCode, denial,
    credentials: { browserContext: true, nativeSameOrigin: true, valuesExcluded: true } });
}

async function serverPrincipal(config, fetcher) {
  const response = await contextRequest(config, fetcher, SESSION_PATH,
    { headers: { Accept: "application/json", "Cache-Control": "no-store" } });
  if (response.status >= 300 && response.status < 400) fail("browser_context_redirect_denied");
  if (response.status !== 200) { await bytes(response, 64 * 1024); return { supported: false, status: response.status }; }
  const value = await json(response);
  const principal = object(value) ? value.principal : null;
  if (!object(principal) || !bounded(principal.issuer, 512) || !bounded(principal.subject, 512))
    return { supported: false, status: 200 };
  return { supported: true, bindingSha256: sha256(`${principal.issuer}\0${principal.subject}`) };
}

export async function checkClientPortalDistinctPrincipalDenial(configValue, input, dependencies = {}) {
  const config = parseClientPortalBrowserAcceptanceConfig(configValue);
  const enrolledFetcher = dependencies.enrolledBrowserContextFetcher;
  const distinctFetcher = dependencies.distinctBrowserContextFetcher;
  if (typeof enrolledFetcher !== "function" || typeof distinctFetcher !== "function") fail("two_browser_contexts_required");
  const enrolled = await serverPrincipal(config, enrolledFetcher), distinct = await serverPrincipal(config, distinctFetcher);
  if (!enrolled.supported || !distinct.supported) return Object.freeze({ schemaVersion: 1, environment: "staging",
    status: "unsupported", mutationsPerformed: false, check: "distinct_principal_denial",
    observedAt: new Date(dependencies.now ?? Date.now()).toISOString(),
    reason: "server_principal_binding_unavailable", sessionStatuses: [enrolled.status, distinct.status],
    credentials: { browserContexts: 2, nativeSameOrigin: true, valuesExcluded: true } });
  if (enrolled.bindingSha256 === distinct.bindingSha256) fail("genuine_distinct_principal_required");
  const homeResponse = await contextRequest(config, distinctFetcher, HOME_PATH,
    { headers: { Accept: "application/json", "Cache-Control": "no-store" } });
  if (homeResponse.status >= 300 && homeResponse.status < 400) fail("browser_context_redirect_denied");
  await bytes(homeResponse, 64 * 1024);
  if (homeResponse.status !== 403) fail(`distinct_principal_home_http_${homeResponse.status}`);
  const denial = await expectDenied(config, distinctFetcher, input);
  return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed", mutationsPerformed: false,
    observedAt: new Date(dependencies.now ?? Date.now()).toISOString(), check: "distinct_principal_denial",
    principalBindings: { distinct: true, valuesExcluded: true }, homeStatus: 403, denial,
    credentials: { browserContexts: 2, nativeSameOrigin: true, valuesExcluded: true } });
}
