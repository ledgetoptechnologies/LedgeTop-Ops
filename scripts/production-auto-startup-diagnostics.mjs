const STARTUP_STAGES = new Set(['recipient','gate','trigger_env','trigger_file','trigger_json','trigger_shape',
  'source','adapter','coordination','unknown']);
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
const SAFE_ERROR_TYPES = new Set(['TypeError','RangeError','SyntaxError','ReferenceError','AggregateError','AbortError','TimeoutError']);

/**
 * The release modules refuse with fixed snake_case codes (for example `runtime_predecessor_invalid`). Such a
 * code is safe to report: lowercase words joined by underscores, at most 80 characters, and no segment that
 * looks like data (12+ hex characters, or 6+ digits). Free text, hashes, ids and tokens never match.
 */
function guardCode(message) {
  if (typeof message !== 'string' || message.length > 80 || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,11}$/u.test(message)) return null;
  return message.split('_').some(part => (part.length >= 12 && /^[0-9a-f]+$/u.test(part)) || /\d{6}/u.test(part)) ? null : message;
}

function safeErrorType(error) {
  if (!isRecord(error)) return null;
  let name = null;
  try { name = typeof error.name === 'string' ? error.name : null; } catch { return null; }
  return name && SAFE_ERROR_TYPES.has(name) ? name : null;
}
const failures = new WeakMap();
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
    : !CODE_ONLY_REASONS.has(message) && guardCode(message) ? message
    : guardCode(code) ?? 'unexpected_error');
  return candidate;
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
    const reason = safeReason(error), errorType = reason === 'unexpected_error' ? safeErrorType(error) : null;
    failures.set(error, Object.freeze({ stage: safeStage, reason, ...(errorType ? { errorType } : {}), ...(safe ? { checks: safe } : {}) }));
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

export function formatProductionAutoReleaseHold(error) {
  const { stage, reason, errorType, checks } = productionAutoStartupFailure(error);
  const checksText = checks ? `, checks=${formatChecks(stage, checks)}` : '';
  const typeText = errorType ? `, error=${errorType}` : '';
  return `Production retained-asset release held (stage=${stage}, reason=${reason}${typeText}${checksText}); inspect the durable journal and reconcile read-only.`;
}

export function formatProductionAutoSyncHold(error) {
  const { stage, reason, errorType, checks } = productionAutoStartupFailure(error);
  const checksText = checks ? `, checks=${formatChecks(stage, checks)}` : '';
  const typeText = errorType ? `, error=${errorType}` : '';
  return `Ops Sync automatic backend release held (stage=${stage}, reason=${reason}${typeText}${checksText}); inspect the durable journal and reconcile read-only.`;
}

function formatChecks(stage, checks) {
  return SAFE_CHECK_KEYS[stage].filter(key => Object.hasOwn(checks, key)).map(key => `${key}=${checks[key]}`).join(',');
}
