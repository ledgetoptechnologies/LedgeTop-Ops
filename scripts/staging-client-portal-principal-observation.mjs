import { checkClientPortalUnenrolledContextDenial } from "./staging-client-portal-browser-context-acceptance.mjs";
import { createClientPortalPlaywrightContextFetcher } from "./staging-client-portal-playwright-context-request.mjs";

export const CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN = "https://client-staging.ledgetopdroneservices.com";
export const CLIENT_PORTAL_PRINCIPAL_OBSERVATION_TARGET = Object.freeze({
  accountId: "846c924bf17bf4f3dd15c97a4c5d1d51",
  workerName: "ledgetop-clients-staging",
  environment: "staging",
  origin: CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN,
});

const SESSION_PATH = "/api/client/operations/recipient-enrollment/session";
const INSPECT_PATH = "/api/client/operations/recipient-enrollment/inspect";
const REDEEM_PATH = "/api/client/operations/recipient-enrollment/redeem";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;
const CSRF = /^(\d{1,12})\.([0-9a-f]{64})$/u;
const CONTROL = /\p{C}/u;

export class ClientPortalPrincipalObservationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ClientPortalPrincipalObservationError";
    this.code = code;
    this.status = "inconclusive";
  }
}

const fail = code => { throw new ClientPortalPrincipalObservationError(code); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const bounded = (value, maximum = 512) => typeof value === "string" && value.length >= 1
  && value.length <= maximum && value.trim() === value && !CONTROL.test(value);

function exact(value, keys, code) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== "string")
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail(code);
  return value;
}

function boundedTimeout(value) {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS)
    fail("principal_observation_timeout_invalid");
  return timeout;
}

async function within(work, timeout, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new ClientPortalPrincipalObservationError(code)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

function enrollmentLink(value) {
  if (typeof value !== "string" || value.length > 1_024 || CONTROL.test(value))
    fail("principal_observation_link_invalid");
  let url;
  try { url = new URL(value); } catch { fail("principal_observation_link_invalid"); }
  const match = /^\/portal\/operations-recipient-enrollment\/([^/]+)$/u.exec(url.pathname);
  const intentId = match ? (() => { try { return decodeURIComponent(match[1]); } catch { return ""; } })() : "";
  const opaqueToken = url.hash.startsWith("#") ? (() => { try { return decodeURIComponent(url.hash.slice(1)); } catch { return ""; } })() : "";
  if (url.origin !== CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN || url.protocol !== "https:"
    || url.username || url.password || url.search || !UUID.test(intentId) || !TOKEN.test(opaqueToken))
    fail("principal_observation_link_invalid");
  return { url, intentId, opaqueToken, scrubbedUrl: `${url.origin}${url.pathname}` };
}

function observationConfiguration(configValue) {
  const config = exact(configValue, Object.hasOwn(configValue ?? {}, "timeoutMs")
    ? ["enrollmentUrl", "timeoutMs"] : ["enrollmentUrl"], "principal_observation_config_invalid");
  return Object.freeze({ link: enrollmentLink(config.enrollmentUrl), timeout: boundedTimeout(config.timeoutMs) });
}

function pageContext(value, label) {
  const page = value?.page, context = value?.context;
  if (!page || !context || typeof page.context !== "function" || page.context() !== context
    || typeof page.isClosed !== "function" || page.isClosed() || typeof page.url !== "function"
    || typeof page.goto !== "function" || typeof page.waitForResponse !== "function"
    || typeof page.on !== "function" || typeof page.off !== "function" || typeof page.mainFrame !== "function")
    fail(`principal_observation_${label}_context_invalid`);
  let current;
  try { current = new URL(page.url()); } catch { fail(`principal_observation_${label}_page_invalid`); }
  if (current.origin !== CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN || current.protocol !== "https:"
    || current.username || current.password) fail(`principal_observation_${label}_page_invalid`);
  return { page, context };
}

function deploymentSnapshot(value) {
  if (!plain(value)) fail("principal_observation_deployment_invalid");
  exact(value, ["schemaVersion", "target", "deployment", "configMarker"],
    "principal_observation_deployment_invalid");
  if (value.schemaVersion !== 1) fail("principal_observation_deployment_invalid");
  exact(value.target, ["accountId", "workerName", "environment", "origin"], "principal_observation_deployment_invalid");
  for (const [key, expected] of Object.entries(CLIENT_PORTAL_PRINCIPAL_OBSERVATION_TARGET))
    if (value.target[key] !== expected) fail("principal_observation_deployment_target_invalid");
  exact(value.deployment, ["deploymentId", "versions"], "principal_observation_deployment_invalid");
  if (!bounded(value.deployment.deploymentId, 191) || !Array.isArray(value.deployment.versions)
    || value.deployment.versions.length !== 1) fail("principal_observation_deployment_not_single_version");
  const active = exact(value.deployment.versions[0], ["versionId", "percentage"],
    "principal_observation_deployment_invalid");
  if (!bounded(active.versionId, 191) || active.percentage !== 100)
    fail("principal_observation_deployment_not_single_version");
  if (!bounded(value.configMarker, 512)) fail("principal_observation_deployment_invalid");
  return { deploymentId: value.deployment.deploymentId, versionId: active.versionId,
    configMarker: value.configMarker };
}

function sameDeployment(before, after) {
  if (before.deploymentId !== after.deploymentId || before.versionId !== after.versionId
    || before.configMarker !== after.configMarker) fail("principal_observation_deployment_drift");
}

function sameIdentity(expected, actual, label) {
  const checked = pageContext(actual, label);
  if (checked.page !== expected.page || checked.context !== expected.context)
    fail("principal_observation_context_drift");
}

function samePrincipalObservation(before, after) {
  sameDeployment(before.deployment, after.deployment);
  if (before.enrolled.proof.bucket !== after.enrolled.proof.bucket
    || before.distinct.proof.bucket !== after.distinct.proof.bucket)
    fail("principal_observation_bucket_drift");
  if (before.enrolled.proof.token !== after.enrolled.proof.token
    || before.distinct.proof.token !== after.distinct.proof.token)
    fail("principal_observation_principal_drift");
  if (before.identity.enrolled.page !== after.identity.enrolled.page
    || before.identity.enrolled.context !== after.identity.enrolled.context
    || before.identity.distinct.page !== after.identity.distinct.page
    || before.identity.distinct.context !== after.identity.distinct.context)
    fail("principal_observation_context_drift");
}

function redeemListener(state) {
  return request => {
    try {
      const url = new URL(request.url());
      if (url.origin === CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN && url.pathname === REDEEM_PATH)
        state.redeemObserved = true;
    } catch { state.redeemObserved = true; }
  };
}

function responseMatches(response, page, pathname, method) {
  try {
    if (!response || typeof response.url !== "function" || typeof response.request !== "function") return false;
    const url = new URL(response.url()), request = response.request();
    return url.origin === CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN && url.pathname === pathname
      && !url.search && !url.hash && request && typeof request.method === "function" && request.method() === method
      && typeof request.frame === "function" && request.frame() === page.mainFrame();
  } catch { return false; }
}

async function safeHeader(source, name, code) {
  if (!source || typeof source.headerValue !== "function") fail(code);
  try {
    const value = await source.headerValue(name);
    if (value !== null && typeof value !== "string") fail(code);
    return value;
  } catch (error) {
    if (error instanceof ClientPortalPrincipalObservationError) throw error;
    fail(code);
  }
}

async function validateInspectBody(request, link) {
  if (typeof request.postDataBuffer !== "function") fail("principal_observation_inspect_request_invalid");
  let bytes;
  try { bytes = request.postDataBuffer(); }
  catch { fail("principal_observation_inspect_request_invalid"); }
  if (!ArrayBuffer.isView(bytes) || bytes.byteLength < 1 || bytes.byteLength > 1_024)
    fail("principal_observation_inspect_request_invalid");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("principal_observation_inspect_request_invalid"); }
  exact(parsed, ["intentId", "opaqueToken"], "principal_observation_inspect_request_invalid");
  if (parsed.intentId !== link.intentId || parsed.opaqueToken !== link.opaqueToken)
    fail("principal_observation_inspect_request_invalid");
}

async function validateNaturalRequest(response, page, pathname, method, link, expectedCsrf) {
  if (!responseMatches(response, page, pathname, method)) fail("principal_observation_response_mismatch");
  const request = response.request();
  if (await safeHeader(request, "x-operations-enrollment-request", "principal_observation_request_invalid") !== "1"
    || await safeHeader(request, "sec-fetch-site", "principal_observation_request_invalid") !== "same-origin")
    fail("principal_observation_request_invalid");
  const origin = await safeHeader(request, "origin", "principal_observation_request_invalid");
  if (origin !== null && origin !== CLIENT_PORTAL_PRINCIPAL_OBSERVATION_ORIGIN)
    fail("principal_observation_request_invalid");
  if (pathname === INSPECT_PATH) {
    const contentType = await safeHeader(request, "content-type", "principal_observation_inspect_request_invalid");
    if (!/^application\/json(?:;|$)/iu.test(contentType ?? ""))
      fail("principal_observation_inspect_request_invalid");
    if (await safeHeader(request, "x-csrf-token", "principal_observation_inspect_request_invalid") !== expectedCsrf)
      fail("principal_observation_inspect_request_invalid");
    await validateInspectBody(request, link);
  }
}

async function responseJson(response, page, pathname, method, link, expectedCsrf) {
  await validateNaturalRequest(response, page, pathname, method, link, expectedCsrf);
  let status;
  try { status = response.status(); } catch { fail("principal_observation_response_invalid"); }
  if (!Number.isInteger(status) || status < 100 || status > 599) fail("principal_observation_response_invalid");
  if (status !== 200) fail(`principal_observation_${pathname === SESSION_PATH ? "session" : "inspect"}_http_${status}`);
  const contentType = await safeHeader(response, "content-type", "principal_observation_response_invalid");
  if (!/^application\/json(?:;|$)/iu.test(contentType ?? "")) fail("principal_observation_json_content_type_invalid");
  const cacheControl = await safeHeader(response, "cache-control", "principal_observation_response_invalid");
  const edgeCacheControl = await safeHeader(response, "cloudflare-cdn-cache-control", "principal_observation_response_invalid");
  if (cacheControl !== "no-store" || edgeCacheControl !== null && edgeCacheControl !== "no-store")
    fail("principal_observation_no_store_required");
  const declared = await safeHeader(response, "content-length", "principal_observation_response_invalid");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_JSON_BYTES))
    fail("principal_observation_response_too_large");
  let bytes;
  try { bytes = await response.body(); } catch { fail("principal_observation_response_body_failed"); }
  if (!ArrayBuffer.isView(bytes) || bytes.byteLength > MAX_JSON_BYTES) fail("principal_observation_response_too_large");
  try { return { status, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }; }
  catch { fail("principal_observation_json_invalid"); }
}

function sessionProof(value) {
  const parsed = exact(value, ["csrfToken"], "principal_observation_session_invalid");
  const match = typeof parsed.csrfToken === "string" ? CSRF.exec(parsed.csrfToken) : null;
  if (!match) fail("principal_observation_session_invalid");
  const bucket = Number(match[1]);
  if (!Number.isSafeInteger(bucket) || bucket < 0) fail("principal_observation_session_invalid");
  return { bucket, token: parsed.csrfToken };
}

function inspectProof(value, expectedIntentId) {
  const parsed = exact(value, ["intentId", "revision", "state", "target", "expiresAt"],
    "principal_observation_inspect_invalid");
  const target = exact(parsed.target, ["targetId", "targetRevision", "clientRecordId", "displayLabel"],
    "principal_observation_inspect_invalid");
  if (parsed.intentId !== expectedIntentId || parsed.revision !== 1 || parsed.state !== "issued"
    || !UUID.test(target.targetId) || !Number.isSafeInteger(target.targetRevision) || target.targetRevision < 1
    || !bounded(target.clientRecordId, 191) || !bounded(target.displayLabel, 300)
    || typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt))
    || Date.parse(parsed.expiresAt) <= Date.now()) fail("principal_observation_inspect_invalid");
}

async function observePage(page, link, timeout, state) {
  const sessionWait = page.waitForResponse(response => responseMatches(response, page, SESSION_PATH, "GET"), { timeout });
  const inspectWait = page.waitForResponse(response => responseMatches(response, page, INSPECT_PATH, "POST"), { timeout });
  try {
    const results = await Promise.allSettled([
      page.goto(link.url.toString(), { waitUntil: "domcontentloaded", timeout }), sessionWait, inspectWait,
    ]);
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
    const sessionResponse = results[1].value, inspectResponse = results[2].value;
    const session = await responseJson(sessionResponse, page, SESSION_PATH, "GET", link);
    const proof = sessionProof(session.value);
    const inspect = await responseJson(inspectResponse, page, INSPECT_PATH, "POST", link, proof.token);
    inspectProof(inspect.value, link.intentId);
    if (page.url() !== link.scrubbedUrl) fail("principal_observation_fragment_not_scrubbed");
    if (state.redeemObserved) fail("principal_observation_redeem_observed");
    return { sessionStatus: session.status, inspectStatus: inspect.status, proof };
  } catch (error) {
    if (error instanceof ClientPortalPrincipalObservationError) throw error;
    fail("principal_observation_browser_failed");
  }
}

/**
 * Observes the supported enrollment UI in two already-authenticated, distinct
 * BrowserContexts. The caller owns creation of the issued synthetic intent,
 * sign-in, and the trusted read-only provider snapshot reader. This helper has
 * no provider/network fallback and never clicks, submits, or calls page code.
 * The reader must derive configMarker from the active Worker/secret
 * configuration; a hand-entered identity assertion is not authoritative.
 * The before/after snapshots establish sampled stability only and cannot rule
 * out a transient configuration change that is reverted between reads.
 * Redeem monitoring covers requests emitted by the two observed pages only;
 * it does not cover APIRequestContext, other tabs, service workers, or prove
 * the absence of mutations globally.
 */
async function observeClientPortalDistinctPrincipalsInternal(observation, dependencies) {
  const { link, timeout } = observation;
  const enrolled = pageContext(dependencies.enrolled, "enrolled");
  const distinct = pageContext(dependencies.distinct, "distinct");
  if (enrolled.context === distinct.context || enrolled.page === distinct.page)
    fail("principal_observation_two_contexts_required");
  if (typeof dependencies.readDeploymentSnapshot !== "function")
    fail("principal_observation_snapshot_reader_required");
  const states = [{ redeemObserved: false }, { redeemObserved: false }];
  const listeners = states.map(redeemListener);
  enrolled.page.on("request", listeners[0]); distinct.page.on("request", listeners[1]);
  try {
    let before;
    try { before = deploymentSnapshot(await within(() => dependencies.readDeploymentSnapshot("before"), timeout,
      "principal_observation_snapshot_read_timeout")); }
    catch (error) {
      if (error instanceof ClientPortalPrincipalObservationError) throw error;
      fail("principal_observation_snapshot_read_failed");
    }
    const observations = await Promise.allSettled([
      observePage(enrolled.page, link, timeout, states[0]),
      observePage(distinct.page, link, timeout, states[1]),
    ]);
    if (states.some(state => state.redeemObserved)) fail("principal_observation_redeem_observed");
    const rejected = observations.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
    const first = observations[0].value, second = observations[1].value;
    let after;
    try { after = deploymentSnapshot(await within(() => dependencies.readDeploymentSnapshot("after"), timeout,
      "principal_observation_snapshot_read_timeout")); }
    catch (error) {
      if (error instanceof ClientPortalPrincipalObservationError) throw error;
      fail("principal_observation_snapshot_read_failed");
    }
    sameDeployment(before, after);
    if (states.some(state => state.redeemObserved)) fail("principal_observation_redeem_observed");
    if (first.proof.bucket !== second.proof.bucket) fail("principal_observation_bucket_mismatch");
    if (first.proof.token === second.proof.token) fail("principal_observation_same_principal");
    const report = Object.freeze({
      status: "passed",
      mutationsPerformed: false,
      observations: Object.freeze({ sessionStatuses: Object.freeze([first.sessionStatus, second.sessionStatus]),
        inspectStatuses: Object.freeze([first.inspectStatus, second.inspectStatus]), fragmentScrubbed: true,
        pageRedeemObserved: false }),
      principalBindings: Object.freeze({ serverAuthenticated: true, sameBucket: true, distinct: true,
        valuesExcluded: true }),
      deployment: Object.freeze({ version: before.versionId, snapshotStable: true, singleVersion: true,
        atOneHundredPercent: true }),
    });
    return Object.freeze({ report, enrolled: first, distinct: second, deployment: before,
      identity: Object.freeze({ enrolled, distinct }) });
  } finally {
    enrolled.page.off("request", listeners[0]); distinct.page.off("request", listeners[1]);
  }
}

export async function observeClientPortalDistinctPrincipals(configValue, dependencies = {}) {
  try { return (await observeClientPortalDistinctPrincipalsInternal(
    observationConfiguration(configValue), dependencies)).report; }
  catch (error) {
    if (error instanceof ClientPortalPrincipalObservationError) throw error;
    fail("principal_observation_failed");
  }
}

/**
 * Binds the actual unenrolled home/handle denial to the same two authenticated
 * browser contexts and to exact private principal observations immediately
 * before and after it. This proves only distinct-principal denial; positive
 * enrolled access, grant correctness, byte integrity, and audit evidence are
 * separate acceptance ceremonies. Deployment stability is sampled by the
 * surrounding snapshots and cannot exclude transient changes between reads.
 * Redeem monitoring covers the two observed pages, not APIRequestContext,
 * other tabs, service workers, or global mutation activity.
 */
export async function checkClientPortalObservedDistinctPrincipalDenial(configValue, input, dependencies = {}) {
  try {
    const observation = observationConfiguration(dependencies.observationConfig);
    const timeout = observation.timeout;
    const enrolled = pageContext(dependencies.enrolled, "enrolled");
    const distinct = pageContext(dependencies.distinct, "distinct");
    if (enrolled.context === distinct.context || enrolled.page === distinct.page)
      fail("principal_observation_two_contexts_required");
    const ceremonyDependencies = { enrolled, distinct,
      readDeploymentSnapshot: dependencies.readDeploymentSnapshot };
    const states = [{ redeemObserved: false }, { redeemObserved: false }];
    const listeners = states.map(redeemListener);
    enrolled.page.on("request", listeners[0]); distinct.page.on("request", listeners[1]);
    try {
      const before = await observeClientPortalDistinctPrincipalsInternal(observation, ceremonyDependencies);
      sameIdentity(before.identity.enrolled, enrolled, "enrolled");
      sameIdentity(before.identity.distinct, distinct, "distinct");
      if (states.some(state => state.redeemObserved)) fail("principal_observation_redeem_observed");
      const distinctFetcher = createClientPortalPlaywrightContextFetcher({ page: distinct.page,
        context: distinct.context, timeoutMs: timeout });
      let denial;
      try {
        denial = await checkClientPortalUnenrolledContextDenial(configValue, input,
          { browserContextFetcher: distinctFetcher });
      } catch { fail("principal_observation_denial_failed"); }
      sameIdentity(before.identity.enrolled, enrolled, "enrolled");
      sameIdentity(before.identity.distinct, distinct, "distinct");
      if (states.some(state => state.redeemObserved)) fail("principal_observation_redeem_observed");
      const after = await observeClientPortalDistinctPrincipalsInternal(observation, ceremonyDependencies);
      samePrincipalObservation(before, after);
      sameIdentity(after.identity.enrolled, enrolled, "enrolled");
      sameIdentity(after.identity.distinct, distinct, "distinct");
      if (states.some(state => state.redeemObserved)) fail("principal_observation_redeem_observed");
      if (!plain(denial) || denial.status !== "passed" || denial.mutationsPerformed !== false
        || denial.check !== "unenrolled_context_denial" || denial.homeStatus !== 403
        || !plain(denial.denial) || denial.denial.status !== 404
        || !["file", "folder"].includes(denial.denial.kind)
        || !["list", "metadata", "preview", "download"].includes(denial.denial.action)
        || Object.hasOwn(denial, "principalBindings")) fail("principal_observation_denial_invalid");
      return Object.freeze({ schemaVersion: 1, environment: "staging", status: "passed",
        mutationsPerformed: false, check: "distinct_principal_denial",
        principalBindings: Object.freeze({ serverAuthenticated: true, sameBucket: true, distinct: true,
          stableAcrossDenial: true, valuesExcluded: true }),
        denial: Object.freeze({ homeStatus: 403, kind: denial.denial.kind,
          action: denial.denial.action, status: 404 }),
        observations: Object.freeze({ rounds: 2, fragmentScrubbed: true, pageRedeemObserved: false }),
        deployment: Object.freeze({ version: before.deployment.versionId, snapshotStable: true,
          singleVersion: true, atOneHundredPercent: true }),
        credentials: Object.freeze({ browserContexts: 2, nativeSameOrigin: true, valuesExcluded: true }) });
    } finally {
      enrolled.page.off("request", listeners[0]); distinct.page.off("request", listeners[1]);
    }
  } catch (error) {
    if (error instanceof ClientPortalPrincipalObservationError) throw error;
    fail("principal_observation_failed");
  }
}
