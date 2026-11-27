import { isProductionAutoHoldCode, PRODUCTION_AUTO_COORDINATOR_REASONS, PRODUCTION_AUTO_RELEASE_PHASES } from './production-auto-hold-codes.mjs';

const COORDINATOR_HOLD = 'Automatic release held; preserve journal and reconcile read-only; no retry or rollback performed';
const COORDINATOR_CAUSES = new Set(PRODUCTION_AUTO_COORDINATOR_REASONS.values());
/** Causes that do not say what refused on their own, so a hold may also name the original built-in class. */
export const PRODUCTION_AUTO_GENERIC_HOLD_CAUSES = Object.freeze(['unexpected_error', 'production_provider_refused_or_uncertain_no_retry']);
const GENERIC_CAUSES = new Set(PRODUCTION_AUTO_GENERIC_HOLD_CAUSES);

/** Fixed sub-steps inside the coordinator's prepare phase, after the old-asset verifier ran. A hold may name the
 * step that failed (never its text) so an unexpected crash can be located without exposing provider data. */
export const PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS = Object.freeze(['old_assets_final_fence','old_assets_schema',
  'old_assets_ci','old_assets_capture','old_assets_predecessor','old_assets_complete_inventory','archive_root_html',
  'merge_asset_ledger',
  // The post-intent revalidation every mutation runs after its intent is durable and before it is dispatched.
  'mutation_fence_schema','mutation_fence_ci','mutation_fence_capture','mutation_fence_predecessor',
  // The deployment read behind a stage/activation readback and the terminal reconciliation.
  'deployment_capture']);
const ORIGINAL_FAILURE_STEPS = new Set(PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS);
const STARTUP_STAGES = new Set(['recipient','gate','trigger_env','trigger_file','trigger_json','trigger_shape',
  'source','adapter','coordination','unknown', ...PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS]);
const SAFE_CHECK_KEYS = Object.freeze({
  trigger_shape: Object.freeze(['name','path','event','status','conclusion','branch','repo','headRepo','id','attempt','sha']),
  adapter: Object.freeze(['accountIdMatches','cloudflareTokenShape','githubTokenShape','workflowRunId','workflowAttempt']),
});
const SAFE_CODES = new Set([
  'unexpected_error','production_auto_release_disabled','sync_auto_release_disabled',
  'runtime_trigger_event_missing','runtime_trigger_event_invalid','runtime_trigger_run_refused',
  'runtime_credentials_or_run_identity_missing','runtime_target_or_profile_refused',
  'runtime_trigger_source_mismatch','runtime_verified_ci_identity_missing',
  'sync_runtime_identity_or_credentials_invalid','sync_trigger_source_mismatch',
  'migration_required_pending','migration_application_schema_confirmation_required',
  'runtime_mode_refused','production_auto_diagnostic_refused','runtime_diagnostic_injection_refused','runtime_diagnostic_transport_refused',
]);
const SAFE_REASONS = new Map([
  ['Exact successful main CI is required; automatic release held','exact_main_ci_required'],
  ['Git source overrides are unsupported for production deployment','git_source_override_blocked'],
  ['Current reviewed source checkout cannot be verified','source_checkout_unavailable'],
  ['Deployment source checkout differs','source_checkout_mismatch'],
  ['Deployment requires the exact clean reviewed source commit','source_checkout_not_clean'],
]);
const CODE_ONLY_REASONS = new Set(['migration_required_pending','migration_application_schema_confirmation_required']);
// Specific built-in error classes are safe to name (they carry no data) and tell an operator whether a hold was a
// guard refusal or a crash.
const NATIVE_ERROR_TYPES = Object.freeze([['TypeError', TypeError], ['RangeError', RangeError], ['SyntaxError', SyntaxError],
  ['ReferenceError', ReferenceError], ['AggregateError', AggregateError]]);
// The original failure behind a coordinator hold may also be a plain Error (an unregistered message) or a
// DOMException (e.g. an aborted fetch). Still matched by exact prototype identity only.
const ORIGINAL_ERROR_TYPES = Object.freeze([...NATIVE_ERROR_TYPES, ['Error', Error],
  ...(typeof DOMException === 'function' ? [['DOMException', DOMException]] : [])]);
const ORIGINAL_ERROR_TYPE_NAMES = new Set(ORIGINAL_ERROR_TYPES.map(([type]) => type));

/**
 * Names a crash by its built-in class only, found by prototype identity: never reads `name` or any other
 * property, so no own or inherited getter runs, and a custom class or spoofed name is never reported.
 */
function safeErrorType(error, types = NATIVE_ERROR_TYPES) {
  if (!isRecord(error)) return null;
  let proto;
  try { proto = Object.getPrototypeOf(error); } catch { return null; }
  for (const [type, ctor] of types) if (proto === ctor.prototype) return type;
  return null;
}
const failures = new WeakMap();
/** Fixed names for the Cloudflare endpoints a release reads or writes. A provider failure is reported only as
 * method, one of these names, the HTTP status number and whether it timed out: never a path, id, body or text. */
export const PRODUCTION_AUTO_PROVIDER_ENDPOINTS = Object.freeze(['deployments','versions_list','version_upload','version',
  'version_modules','settings','schedules','script_subdomain','account_subdomain','asset_session','asset_upload','script',
  'other']);
const PROVIDER_ENDPOINTS = new Set(PRODUCTION_AUTO_PROVIDER_ENDPOINTS);
const PROVIDER_METHODS = new Set(['GET','POST','PUT','DELETE']);
const ENDPOINT_PATTERNS = Object.freeze([
  [/^\/workers\/scripts\/[a-z0-9-]+\/deployments(?:\?per_page=1)?$/u, 'deployments'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/versions\?per_page=1$/u, 'versions_list'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/versions\?bindings_inherit=strict$/u, 'version_upload'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/versions\/[a-f0-9-]+$/u, 'version'],
  [/^\/workers\/workers\/[a-z0-9-]+\/versions\/[a-f0-9-]+\?include=modules(?:,sourcemaps)?$/u, 'version_modules'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/settings$/u, 'settings'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/schedules$/u, 'schedules'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/subdomain$/u, 'script_subdomain'],
  [/^\/workers\/subdomain$/u, 'account_subdomain'],
  [/^\/workers\/scripts\/[a-z0-9-]+\/assets-upload-session$/u, 'asset_session'],
  [/^\/workers\/assets\/upload\?base64=true$/u, 'asset_upload'],
  [/^\/workers\/scripts\/[a-z0-9-]+$/u, 'script'],
]);
/** Maps an account-relative Cloudflare path to its fixed endpoint name; anything unrecognized is 'other'. */
export function productionAutoProviderEndpoint(suffix) {
  if (typeof suffix !== 'string' || suffix.length > 512) return 'other';
  for (const [pattern, name] of ENDPOINT_PATTERNS) if (pattern.test(suffix)) return name;
  return 'other';
}
const providerFailures = new WeakMap();
/** Record which provider request failed (the first mark wins). Only fixed vocabulary and numbers are kept. */
export function markProductionAutoProviderFailure(error, { method, endpoint, status = null, timedOut = false } = {}) {
  if (isRecord(error) && !providerFailures.has(error)) providerFailures.set(error, Object.freeze({
    method: PROVIDER_METHODS.has(method) ? method : 'GET',
    endpoint: PROVIDER_ENDPOINTS.has(endpoint) ? endpoint : 'other',
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    timedOut: timedOut === true }));
  return error;
}
/** A wrapper that replaces an error with a fixed-code error keeps the original's marks (never its text). */
export function carryProductionAutoFailureMarks(from, to) {
  if (!isRecord(from) || !isRecord(to) || from === to) return to;
  if (failures.has(from) && !failures.has(to)) failures.set(to, failures.get(from));
  if (providerFailures.has(from) && !providerFailures.has(to)) providerFailures.set(to, providerFailures.get(from));
  if (!originalTypes.has(to)) {
    const type = originalTypes.has(from) ? originalTypes.get(from) : safeErrorType(from, ORIGINAL_ERROR_TYPES);
    if (type) originalTypes.set(to, type);
  }
  return to;
}
const PROVIDER_TEXT = new RegExp(`^(?:GET|POST|PUT|DELETE):(?:${PRODUCTION_AUTO_PROVIDER_ENDPOINTS.join('|')}):(?:[1-5][0-9]{2}|none)(?::timeout)?$`, 'u');
function providerText(value) {
  return value ? `${value.method}:${value.endpoint}:${value.status ?? 'none'}${value.timedOut ? ':timeout' : ''}` : null;
}
const syncReadbackSteps = new WeakMap();
const SYNC_READBACK_STEPS = new Set(['classic_metadata', 'modern_modules', 'candidate_proof',
  'post_upload_capture', 'capture_validation', 'inactive_receipt']);
/** Record a fixed internal step only; never copy exception or provider text. */
export function markProductionAutoSyncReadbackStep(error, step) {
  if (isRecord(error) && SYNC_READBACK_STEPS.has(step)) syncReadbackSteps.set(error, step);
  return error;
}
// Built-in class captured when an error is first marked, so a later prototype change cannot rename it.
const originalTypes = new WeakMap();
const isRecord = value => (typeof value === 'object' && value !== null) || typeof value === 'function';

function ownString(value, key) {
  if (!isRecord(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : null;
  } catch { return null; }
}

function safeReason(error) {
  const message = ownString(error, 'message');
  const code = ownString(error, 'code');
  const candidate = SAFE_REASONS.get(message) ?? (SAFE_CODES.has(code) ? code
    : SAFE_CODES.has(message) && !CODE_ONLY_REASONS.has(message) ? message
    : !CODE_ONLY_REASONS.has(message) && isProductionAutoHoldCode(message) ? message
    : isProductionAutoHoldCode(code) ? code : 'unexpected_error');
  return candidate;
}

/** The coordinator's own hold: a fixed phase and an allowlisted cause it attached (own data properties only). */
function coordinatorHold(error) {
  if (ownString(error, 'message') !== COORDINATOR_HOLD) return null;
  const phase = ownString(error, 'holdPhase'), cause = ownString(error, 'holdCause');
  const step = ownString(error, 'holdStep'), errorType = ownString(error, 'holdErrorType');
  const provider = ownString(error, 'holdProvider');
  const reconcileStep = ownString(error, 'holdReconcileStep'), reconcileProvider = ownString(error, 'holdReconcileProvider');
  const safeCause = cause && (cause === 'unexpected_error' || isProductionAutoHoldCode(cause) || COORDINATOR_CAUSES.has(cause)) ? cause : null;
  return {
    ...(PRODUCTION_AUTO_RELEASE_PHASES.includes(phase) ? { phase } : {}),
    ...(safeCause ? { cause: safeCause } : {}),
    ...(ORIGINAL_FAILURE_STEPS.has(step) ? { step } : {}),
    // A class name only explains a crash or the generic provider refusal; a specific reviewed code already says
    // what refused.
    ...(GENERIC_CAUSES.has(safeCause) && ORIGINAL_ERROR_TYPE_NAMES.has(errorType) ? { errorType } : {}),
    ...(provider && PROVIDER_TEXT.test(provider) ? { provider } : {}),
    ...(ORIGINAL_FAILURE_STEPS.has(reconcileStep) ? { reconcileStep } : {}),
    ...(reconcileProvider && PROVIDER_TEXT.test(reconcileProvider) ? { reconcileProvider } : {}),
  };
}

/**
 * For the coordinator: the fixed sub-step an original failure was marked with (if it is one of
 * PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS) and its exact built-in class. Reads only this module's own records
 * and the prototype; never `name`, `message`, getters or any other text.
 */
export function productionAutoOriginalFailureDetails(error) {
  if (!isRecord(error)) return Object.freeze({});
  const stage = failures.get(error)?.stage;
  const errorType = originalTypes.has(error) ? originalTypes.get(error) : safeErrorType(error, ORIGINAL_ERROR_TYPES);
  const provider = providerText(providerFailures.get(error));
  return Object.freeze({ ...(ORIGINAL_FAILURE_STEPS.has(stage) ? { step: stage } : {}), ...(errorType ? { errorType } : {}),
    ...(provider ? { provider } : {}) });
}

function safeChecks(value, stage) {
  const allowed = SAFE_CHECK_KEYS[stage];
  if (!allowed || !value) return null;
  try { if (Object.getPrototypeOf(value) !== Object.prototype) return null; } catch { return null; }
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (!keys.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return null;
  const copy = {};
  for (const key of allowed) {
    if (!keys.includes(key)) continue;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') return null;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

export function markProductionAutoStartupFailure(error, stage, checks) {
  if (isRecord(error) && !failures.has(error)) {
    const safeStage = STARTUP_STAGES.has(stage) ? stage : 'unknown';
    const safe = safeChecks(checks, safeStage);
    const hold = coordinatorHold(error);
    const reason = hold ? 'release_held' : safeReason(error), errorType = reason === 'unexpected_error' ? safeErrorType(error) : null;
    failures.set(error, Object.freeze({ stage: safeStage, reason, ...(hold ?? {}), ...(errorType ? { errorType } : {}), ...(safe ? { checks: safe } : {}) }));
    originalTypes.set(error, safeErrorType(error, ORIGINAL_ERROR_TYPES));
  }
  return error;
}

export function trackProductionAutoStartupStage(stage, action) {
  try { return action(); }
  catch (error) { markProductionAutoStartupFailure(error, stage); throw error; }
}

export async function trackProductionAutoStartupStageAsync(stage, action) {
  try { return await action(); }
  catch (error) { markProductionAutoStartupFailure(error, stage); throw error; }
}

export function productionAutoStartupFailure(error) {
  return isRecord(error) ? failures.get(error) ?? Object.freeze({ stage: 'unknown', reason: 'unexpected_error' })
    : Object.freeze({ stage: 'unknown', reason: 'unexpected_error' });
}

function detailText({ provider, reconcileStep, reconcileProvider }) {
  return `${provider ? `, provider=${provider}` : ''}${reconcileStep ? `, reconcile_step=${reconcileStep}` : ''}`
    + `${reconcileProvider ? `, reconcile_provider=${reconcileProvider}` : ''}`;
}

export function formatProductionAutoReleaseHold(error) {
  const failure = productionAutoStartupFailure(error);
  const { stage, reason, phase, cause, step, errorType, checks } = failure;
  const checksText = checks ? `, checks=${formatChecks(stage, checks)}` : '';
  const typeText = `${phase ? `, phase=${phase}` : ''}${cause ? `, cause=${cause}` : ''}${step ? `, step=${step}` : ''}${errorType ? `, error=${errorType}` : ''}${detailText(failure)}`;
  return `Production retained-asset release held (stage=${stage}, reason=${reason}${typeText}${checksText}); inspect the durable journal and reconcile read-only.`;
}

export function formatProductionAutoSyncHold(error) {
  const { stage, reason, phase, cause, step, errorType, checks } = productionAutoStartupFailure(error);
  const checksText = checks ? `, checks=${formatChecks(stage, checks)}` : '';
  const typeText = `${phase ? `, phase=${phase}` : ''}${cause ? `, cause=${cause}` : ''}${step ? `, step=${step}` : ''}${errorType ? `, error=${errorType}` : ''}`;
  const readbackStep = isRecord(error) ? syncReadbackSteps.get(error) : undefined;
  return `Ops Sync automatic backend release held (stage=${stage}, reason=${reason}${typeText}${checksText}${readbackStep ? `, readback_step=${readbackStep}` : ''}); inspect the durable journal and reconcile read-only.`;
}

function formatChecks(stage, checks) {
  return SAFE_CHECK_KEYS[stage].filter(key => Object.hasOwn(checks, key)).map(key => `${key}=${checks[key]}`).join(',');
}
