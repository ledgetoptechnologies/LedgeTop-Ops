const MIB = 1024 * 1024;

export function fullMeshByteLimit(deviceMemoryGiB, jsHeapSizeLimitBytes) {
  const memory = Number(deviceMemoryGiB);
  const normalized = Number.isFinite(memory) && memory > 0 ? memory : 4;
  const deviceBudget = Math.floor(normalized * 64 * MIB);
  const heapLimit = Number(jsHeapSizeLimitBytes);
  // Chromium caps navigator.deviceMemory at 8 GiB even on larger workstations.
  // When the runtime exposes its actual JS heap ceiling, reserve at least 85%
  // for Draco expansion, scene objects, and the rest of the application.
  const heapBudget = Number.isFinite(heapLimit) && heapLimit > 0 ? Math.floor(heapLimit * 0.15) : 0;
  return Math.min(768 * MIB, Math.max(128 * MIB, deviceBudget, heapBudget));
}

export function fullMeshDecodeTimeoutMs(byteLength) {
  const bytes = Number(byteLength);
  if (!Number.isFinite(bytes) || bytes <= 0) return 90_000;
  return Math.min(5 * 60_000, Math.max(90_000, Math.ceil(bytes / (64 * MIB)) * 30_000));
}

export function meshRuntimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function withDecodeWatchdog(operation, { timeoutMs, onTimeout = () => {} } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive safe integer');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(meshRuntimeError('full_mesh_decode_timeout', 'Full-resolution mesh decode timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function fullMeshUserMessage(error, { hasLod = false } = {}) {
  const recovery = hasLod
    ? ' Continue with the streaming LOD model.'
    : ' A streaming LOD derivative must finish before this model can be viewed safely on this device.';
  switch (error?.code || error?.name) {
    case 'asset_too_large':
      return `This full-resolution mesh is too large for safe in-browser decoding on this device.${recovery}`;
    case 'full_mesh_decode_timeout':
      return `The full-resolution mesh took too long to decode.${recovery}${hasLod ? ' You can also retry.' : ''}`;
    case 'AbortError':
    case 'full_mesh_cancelled':
      return 'Full-resolution mesh loading was cancelled.';
    default:
      return `The full-resolution mesh could not be loaded.${recovery}${hasLod ? ' You can also retry.' : ' Retry after the LOD derivative is available.'}`;
  }
}

export function isRetryableFullMeshError(error) {
  return !['asset_too_large', 'AbortError', 'full_mesh_cancelled'].includes(error?.code || error?.name);
}

export function fullMeshFailureDisposition(activeAttempt, failedAttempt, { cancelled = false } = {}) {
  const isCurrent = activeAttempt === failedAttempt;
  return Object.freeze({
    isCurrent,
    clearSharedState: isCurrent,
    recover: isCurrent && !cancelled,
  });
}
