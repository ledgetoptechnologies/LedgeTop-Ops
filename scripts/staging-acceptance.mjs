import { lstat, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_CANDIDATES, RELEASE_CONTRACT_FINALIZED, STAGING_HOSTS, STAGING_VIEWER } from "./staging-requirements.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_STORAGE_STATE_BYTES = 1024 * 1024;
const AGGREGATE_TIMEOUT_MS = 30_000;
const IMMUTABLE_VIEWER_IMAGE = /^ghcr\.io\/ledgetoptechnologies\/3d-viewer@sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[0-9a-f-]{36}$/i;

export class StagingAcceptanceError extends Error {
  constructor(code) { super(code); this.name = "StagingAcceptanceError"; this.code = code; }
}

export function validateExactOrigin(value, expected) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new StagingAcceptanceError("invalid_origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== expected)
    throw new StagingAcceptanceError("invalid_origin");
  return parsed.origin;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("Content-Length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new StagingAcceptanceError("response_too_large");
  if (!response.body) throw new StagingAcceptanceError("invalid_response");
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new StagingAcceptanceError("response_too_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new StagingAcceptanceError("invalid_response"); }
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

async function getJson(fetcher, url, headers, signal) {
  const response = await fetcher(url, { method: "GET", headers, cache: "no-store", redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) throw new StagingAcceptanceError("redirect_denied");
  return { response, payload: await boundedJson(response) };
}

export async function runReadOnlyStagingAcceptance(options = {}, dependencies = {}) {
  const contractFinalized = dependencies.contractFinalized ?? RELEASE_CONTRACT_FINALIZED;
  const viewer = dependencies.viewer ?? STAGING_VIEWER;
  const candidates = dependencies.candidates ?? RELEASE_CANDIDATES;
  const fetcher = dependencies.fetcher ?? fetch;
  if (contractFinalized !== true) throw new StagingAcceptanceError("release_contract_not_finalized");
  if (!IMMUTABLE_VIEWER_IMAGE.test(viewer.image)) throw new StagingAcceptanceError("viewer_image_not_immutable");
  const viewerOrigin = validateExactOrigin(options.viewerOrigin ?? viewer.origin, viewer.origin);
  const opsExpected = `https://${STAGING_HOSTS.operations}`;
  const opsOrigin = validateExactOrigin(options.operationsOrigin ?? opsExpected, opsExpected);
  if (!/^[0-9a-f]{40}$/.test(candidates.viewer) || !/^[0-9a-f]{40}$/.test(candidates.operations))
    throw new StagingAcceptanceError("candidate_not_pinned");
  if (typeof options.accessCookie !== "string" || options.accessCookie.length < 20 || options.accessCookie.length > 8192)
    throw new StagingAcceptanceError("access_cookie_required");

  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), AGGREGATE_TIMEOUT_MS);
  const common = { Accept: "application/json" };
  try {
    const [health, ready] = await Promise.all([
      getJson(fetcher, `${viewerOrigin}/api/v1/health`, common, controller.signal),
      getJson(fetcher, `${viewerOrigin}/api/v1/ready`, common, controller.signal),
    ]);
    for (const probe of [health, ready]) {
      if (probe.response.status !== 200 || probe.response.headers.get("Cache-Control") !== "no-store" ||
          probe.response.headers.get("X-LTDS-Viewer-Revision") !== candidates.viewer ||
          probe.response.headers.get("X-LTDS-Viewer-Schema-Version") !== String(viewer.schemaVersion))
        throw new StagingAcceptanceError("viewer_identity_mismatch");
    }
    if (!exactObject(health.payload, ["ok"]) || health.payload.ok !== true ||
        !exactObject(ready.payload, ["ok", "missing"]) || ready.payload.ok !== true ||
        !Array.isArray(ready.payload.missing) || ready.payload.missing.length !== 0)
      throw new StagingAcceptanceError("viewer_not_ready");

    const preflight = await getJson(fetcher, `${opsOrigin}/api/viewer/connection-preflight`, {
      ...common, Cookie: `CF_Authorization=${options.accessCookie}`,
    }, controller.signal);
    const preflightKeys = ["integrationEnabled", "configured", "publicHealthReachable", "publicHealthOk",
      "publicReadyReachable", "publicReady", "readinessIssueCount", "serviceAuthReachable", "serviceAuthStatus",
      "modelCount", "readyModelCount"];
    if (preflight.response.status !== 200 || preflight.response.headers.get("Cache-Control") !== "no-store" ||
        !exactObject(preflight.payload, preflightKeys)) throw new StagingAcceptanceError("operations_preflight_invalid");
    const counts = [preflight.payload.readinessIssueCount, preflight.payload.modelCount, preflight.payload.readyModelCount];
    if (counts.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0)) ||
        ["integrationEnabled", "configured", "publicHealthReachable", "publicHealthOk", "publicReadyReachable",
          "publicReady", "serviceAuthReachable"].some(key => typeof preflight.payload[key] !== "boolean"))
      throw new StagingAcceptanceError("operations_preflight_invalid");
    const serviceAuthStatuses = new Set(["connected", "not_configured", "authentication_failed", "route_not_found",
      "invalid_response", "unavailable"]);
    const serviceConnected = preflight.payload.serviceAuthStatus === "connected";
    if (!serviceAuthStatuses.has(preflight.payload.serviceAuthStatus) ||
        serviceConnected !== preflight.payload.serviceAuthReachable ||
        preflight.payload.configured === (preflight.payload.serviceAuthStatus === "not_configured") ||
        (serviceConnected && (preflight.payload.modelCount === null || preflight.payload.readyModelCount === null)) ||
        (!serviceConnected && (preflight.payload.modelCount !== null || preflight.payload.readyModelCount !== null)) ||
        (serviceConnected && preflight.payload.readyModelCount > preflight.payload.modelCount))
      throw new StagingAcceptanceError("operations_preflight_invalid");

    return {
      schemaVersion: 1,
      runId: dependencies.runId ?? crypto.randomUUID(),
      environment: "staging", mode: "read-only",
      status: preflight.payload.configured && preflight.payload.publicHealthOk && preflight.payload.publicReady &&
        preflight.payload.serviceAuthReachable ? "passed" : "failed",
      observedAt: new Date(dependencies.now ?? Date.now()).toISOString(),
      candidateBinding: {
        operationsExpectedCommit: candidates.operations, viewerExpectedCommit: candidates.viewer,
        viewerExpectedImage: viewer.image, viewerObservedRevision: candidates.viewer,
        viewerObservedSchemaVersion: viewer.schemaVersion,
      },
      probes: { viewerHealth: true, viewerReady: true, operationsPreflight: { ...preflight.payload } },
      credentials: { valuesExcluded: true, accessCookiePresent: true },
      mutationsPerformed: false, externalGates: {},
      manualChecks: [{ id: "operations-deployment-version", status: "pending" }],
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new StagingAcceptanceError("aggregate_timeout");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function readAccessCookie(storageStatePath) {
  const absolute = resolve(storageStatePath), info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORAGE_STATE_BYTES)
    throw new StagingAcceptanceError("invalid_storage_state");
  const parsed = JSON.parse(await readFile(absolute, "utf8"));
  const matches = Array.isArray(parsed.cookies) ? parsed.cookies.filter(cookie =>
    cookie?.name === "CF_Authorization" && cookie?.domain === STAGING_HOSTS.operations &&
    cookie?.secure === true && cookie?.httpOnly === true &&
    typeof cookie.value === "string") : [];
  if (matches.length !== 1) throw new StagingAcceptanceError("access_cookie_required");
  return matches[0].value;
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function main() {
  if (RELEASE_CONTRACT_FINALIZED !== true) throw new StagingAcceptanceError("release_contract_not_finalized");
  if (!IMMUTABLE_VIEWER_IMAGE.test(STAGING_VIEWER.image)) throw new StagingAcceptanceError("viewer_image_not_immutable");
  const storageIndex = process.argv.indexOf("--storage-state");
  if (storageIndex < 0 || !process.argv[storageIndex + 1]) throw new StagingAcceptanceError("storage_state_required");
  const accessCookie = await readAccessCookie(process.argv[storageIndex + 1]);
  const report = await runReadOnlyStagingAcceptance({ accessCookie });
  if (!SAFE_ID.test(report.runId)) throw new StagingAcceptanceError("invalid_run_id");
  const relativeOutput = `.backups/staging-acceptance/${report.runId}.json`;
  await atomicWriteJson(resolve(relativeOutput), report);
  process.stdout.write(`${JSON.stringify({ status: report.status, runId: report.runId, report: relativeOutput })}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof StagingAcceptanceError ? error.code : "acceptance_failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
