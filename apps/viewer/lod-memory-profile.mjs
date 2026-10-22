/**
 * Stable, user-selectable memory modes for mesh LOD streaming.
 *
 * `navigator.deviceMemory` is an intentionally coarse browser hint. It is not
 * a measurement of system RAM, GPU memory, or memory currently available to
 * this tab, so only Auto uses it and missing information selects the safe
 * standard profile.
 */
export const LOD_MEMORY_MODES = Object.freeze(['auto', 'balanced', 'high']);
export const DEFAULT_LOD_MEMORY_MODE = 'auto';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const PROFILE_TABLE = Object.freeze({
  constrained: Object.freeze({
    cacheSoftBytes: 768 * MiB,
    cacheHardBytes: 1 * GiB,
    downloadConcurrency: 4,
    parseConcurrency: 1,
    shellRetentionBytes: 256 * MiB,
    recentFrontierBytes: 128 * MiB,
  }),
  balanced: Object.freeze({
    cacheSoftBytes: 2.5 * GiB,
    cacheHardBytes: 3.125 * GiB,
    downloadConcurrency: 6,
    parseConcurrency: 2,
    shellRetentionBytes: 512 * MiB,
    recentFrontierBytes: 384 * MiB,
  }),
  roomy: Object.freeze({
    cacheSoftBytes: 3 * GiB,
    cacheHardBytes: 3.75 * GiB,
    downloadConcurrency: 8,
    parseConcurrency: 2,
    shellRetentionBytes: 512 * MiB,
    recentFrontierBytes: 512 * MiB,
  }),
  high: Object.freeze({
    cacheSoftBytes: 4 * GiB,
    cacheHardBytes: 5 * GiB,
    downloadConcurrency: 10,
    parseConcurrency: 3,
    shellRetentionBytes: 768 * MiB,
    recentFrontierBytes: 768 * MiB,
  }),
});

export function isLodMemoryMode(value) {
  return typeof value === 'string' && LOD_MEMORY_MODES.includes(value);
}

/**
 * Returns a stable mode key. Unknown, legacy, or structured values fail safe
 * to Auto instead of becoming implicit memory limits.
 */
export function normalizeLodMemoryMode(value) {
  return isLodMemoryMode(value) ? value : DEFAULT_LOD_MEMORY_MODE;
}

/**
 * The local-storage representation is deliberately only the stable mode key.
 * Runtime limits and browser hints must never be persisted because policy
 * values can be safely tuned in later releases.
 */
export function serializeLodMemoryMode(value) {
  return normalizeLodMemoryMode(value);
}

export function parseLodMemoryMode(value) {
  return normalizeLodMemoryMode(value);
}

function classifyDeviceMemoryHint(deviceMemoryGiB) {
  const hint = Number(deviceMemoryGiB);
  if (!Number.isFinite(hint) || hint <= 0) return 'unknown';
  if (hint <= 4) return 'constrained';
  if (hint >= 8) return 'roomy';
  return 'standard';
}

/**
 * Resolve byte and queue limits without inspecting globals or mutating a
 * renderer. Balanced and High are explicit user choices. Auto alone adapts to
 * the browser's coarse device-memory hint; an unavailable hint is Balanced.
 */
export function resolveLodMemoryProfile({
  mode = DEFAULT_LOD_MEMORY_MODE,
  deviceMemoryGiB,
} = {}) {
  const requestedMode = normalizeLodMemoryMode(mode);
  const deviceClass = classifyDeviceMemoryHint(deviceMemoryGiB);
  // A known <=4 GiB browser hint always keeps the established reduced-memory
  // safety profile. A stale/manual High key must not turn a known-constrained
  // tab into a multi-gigabyte allocation. Explicit modes remain predictable on
  // capable or unknown desktop browsers.
  const policyKey = deviceClass === 'constrained'
    ? 'constrained'
    : requestedMode === 'auto'
      ? deviceClass === 'roomy'
        ? 'roomy'
        : 'balanced'
      : requestedMode;
  const policy = PROFILE_TABLE[policyKey];

  return {
    mode: requestedMode,
    policyKey,
    deviceClass,
    cacheSoftBytes: policy.cacheSoftBytes,
    cacheHardBytes: policy.cacheHardBytes,
    cacheOverflowBytes: policy.cacheHardBytes - policy.cacheSoftBytes,
    downloadConcurrency: policy.downloadConcurrency,
    parseConcurrency: policy.parseConcurrency,
    shellRetentionBytes: policy.shellRetentionBytes,
    recentFrontierBytes: policy.recentFrontierBytes,
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Evaluate prospective cache admission, including the incoming decoded tile.
 *
 * - `normal`: within the steady-state soft cache.
 * - `overflow`: temporarily allowed while stale content is reclaimed.
 * - `defer`: would cross the absolute hard bound and must wait for eviction.
 *
 * `reclaimableBytes` is capped at current residency so bad telemetry cannot
 * create imaginary headroom.
 */
export function evaluateLodMemoryAdmission(profile, {
  residentBytes = 0,
  incomingBytes = 0,
  reclaimableBytes = 0,
} = {}) {
  const safeProfile = profile && Number.isFinite(Number(profile.cacheSoftBytes))
    && Number.isFinite(Number(profile.cacheHardBytes))
    ? profile
    : resolveLodMemoryProfile();
  const resident = finiteNonNegative(residentBytes);
  const incoming = finiteNonNegative(incomingBytes);
  const reclaimable = Math.min(resident, finiteNonNegative(reclaimableBytes));
  const projectedBytes = Math.max(0, resident - reclaimable) + incoming;
  const softBytes = Math.max(0, Number(safeProfile.cacheSoftBytes));
  const hardBytes = Math.max(softBytes, Number(safeProfile.cacheHardBytes));
  const state = projectedBytes <= softBytes
    ? 'normal'
    : projectedBytes <= hardBytes
      ? 'overflow'
      : 'defer';

  return {
    state,
    admit: state !== 'defer',
    projectedBytes,
    softBytes,
    hardBytes,
    overflowBytes: Math.max(0, projectedBytes - softBytes),
    bytesToFree: Math.max(0, projectedBytes - hardBytes),
  };
}
