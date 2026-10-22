const CHANNEL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_PATH_PATTERN = /^\/session\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

export function beginIsolatedViewerLaunch({
  windowRef = globalThis.window,
  origin = globalThis.location?.origin,
  channelId = globalThis.crypto?.randomUUID?.(),
  createChannel = (name) => new BroadcastChannel(name),
  timeoutMs = 5_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!windowRef?.open || typeof origin !== 'string' || !CHANNEL_PATTERN.test(channelId || '')) {
    throw new TypeError('invalid isolated Viewer launcher dependencies');
  }
  const channel = createChannel(`ltds-viewer-review:${channelId}`);
  if (!channel?.postMessage || !channel?.close) throw new TypeError('invalid isolated Viewer launch channel');
  const timeout = Math.max(1, Math.min(Number(timeoutMs) || 5_000, 15_000));
  let closed = false;
  let ready = false;
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  let timer = null;

  function close() {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    channel.close();
  }

  function finishReady(value) {
    if (ready || closed) return;
    if (!value) {
      close();
      resolveReady(false);
      return;
    }
    ready = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    resolveReady(true);
  }

  channel.onmessage = ({ data }) => {
    if (!exactKeys(data, ['version', 'type', 'channelId'])
      || data.version !== 1 || data.type !== 'ltds-viewer:launcher-ready'
      || data.channelId !== channelId) return;
    finishReady(true);
  };
  timer = setTimeoutFn(() => finishReady(false), timeout);
  try {
    const launcherUrl = `/review-launch.html#channel=${encodeURIComponent(channelId)}`;
    const windowName = `ltds-viewer-${channelId}`;
    windowRef.open(launcherUrl, windowName, 'noopener');
  } catch {
    finishReady(false);
  }

  function navigate(embedUrl, { renewable = false } = {}) {
    if (!ready || closed) return false;
    let parsed;
    try { parsed = new URL(embedUrl, origin); } catch { return false; }
    if (parsed.origin !== origin || parsed.username || parsed.password || !SESSION_PATH_PATTERN.test(parsed.pathname)) return false;
    parsed.hash = new URLSearchParams({ [renewable ? 'reviewController' : 'launchController']: channelId }).toString();
    channel.postMessage({ version: 1, type: 'ltds-viewer:navigate', url: parsed.href });
    return true;
  }

  function fail() {
    if (ready && !closed) channel.postMessage({ version: 1, type: 'ltds-viewer:launch-failed' });
    close();
  }

  return Object.freeze({
    channelId,
    waitUntilReady: () => readyPromise,
    navigate,
    fail,
    close,
    get closed() { return closed; },
  });
}

export { CHANNEL_PATTERN, SESSION_PATH_PATTERN };
