import { isProductionAutoHoldCode, PRODUCTION_AUTO_COORDINATOR_REASONS, PRODUCTION_AUTO_RELEASE_PHASES } from './production-auto-hold-codes.mjs';

const COORDINATOR_HOLD = 'Automatic release held; preserve journal and reconcile read-only; no retry or rollback performed';
const COORDINATOR_CAUSES = new Set(PRODUCTION_AUTO_COORDINATOR_REASONS.values());

/** Fixed sub-steps inside the coordinator's prepare phase, after the old-asset verifier ran. A hold may name the
 * step that failed (never its text) so an unexpected crash can be located without exposing provider data. */
export const PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS = Object.freeze(['old_assets_final_fence','old_assets_schema',
  'old_assets_ci','old_assets_capture','old_assets_predecessor','old_assets_complete_inventory','archive_root_html',
  'merge_asset_ledger']);
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
  const safeCause = cause && (cause === 'unexpected_error' || isProductionAutoHoldCode(cause) || COORDINATOR_CAUSES.has(cause)) ? cause : null;
  return {
    ...(PRODUCTION_AUTO_RELEASE_PHASES.includes(phase) ? { phase } : {}),
    ...(safeCause ? { cause: safeCause } : {}),
    ...(ORIGINAL_FAILURE_STEPS.has(step) ? { step } : {}),
    // A class name only explains an unexpected crash; a reviewed code already says what refused.
    ...(safeCause === 'unexpected_error' && ORIGINAL_ERROR_TYPE_NAMES.has(errorType) ? { errorType } : {}),
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
  return Object.freeze({ ...(ORIGINAL_FAILURE_STEPS.has(stage) ? { step: stage } : {}), ...(errorType ? { errorType } : {}) });
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

export function formatProductionAutoReleaseHold(error) {
  const { stage, reason, phase, cause, step, errorType, checks } = productionAutoStartupFailure(error);
  const checksText = checks ? `, checks=${formatChecks(stage, checks)}` : '';
  const typeText = `${phase ? `, phase=${phase}` : ''}${cause ? `, cause=${cause}` : ''}${step ? `, step=${step}` : ''}${errorType ? `, error=${errorType}` : ''}`;
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
