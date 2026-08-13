export const ACTIVE_SHARE_LOAD_TIMEOUT_MS = 10_000;

export function createShareLoadDeadline(timeoutMs = ACTIVE_SHARE_LOAD_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cancel() {
      globalThis.clearTimeout(timer);
      controller.abort();
    },
    clear() {
      globalThis.clearTimeout(timer);
    },
  };
}

export function activeShareLoadError(error: unknown, timedOut: boolean): string {
  if (timedOut) return "The share status check took too long. No link was created or changed.";
  const message = error instanceof Error && error.message
    ? error.message
    : "The share status could not be loaded.";
  return `${message} No link was created or changed.`;
}
