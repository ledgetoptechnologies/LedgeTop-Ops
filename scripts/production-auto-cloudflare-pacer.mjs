/** Shared, bounded Cloudflare API pacing for one automatic release run. */
export const PRODUCTION_AUTO_CF_DISPATCH_PERMIT = Symbol('production-auto-cf-dispatch-permit');

const API_ORIGIN = 'https://api.cloudflare.com';
const DEFAULT_INTERVAL_MS = 333;
const DEFAULT_MAX_RUN_MS = 45 * 60_000;
const PERMIT_MAX_AGE_MS = 30_000;
// The joined 28-bucket release measured 1,272 Cloudflare GETs plus mutation
// calls. Round the observed per-bucket envelope up and add fixed reconciliation
// headroom; reevaluate before any bucket payload is sent.
export const PRODUCTION_AUTO_CF_REQUESTS_PER_ASSET_BUCKET = 48;
export const PRODUCTION_AUTO_CF_FIXED_REQUEST_HEADROOM = 80;
// Two remaining 300s byte-verification windows, plus cleanup, final readbacks
// and artifact association. Reading asset bodies is not covered by API pacing.
export const PRODUCTION_AUTO_CF_FINALIZATION_HEADROOM_MS = 2 * 300_000 + 120_000;
const nativePacedTransports = new WeakMap();
export function isNativeProductionCloudflareTransport(value, accountId) {
  return nativePacedTransports.get(value) === accountId;
}
const need = (condition, code) => { if (!condition) throw new Error(code); };

export function createProductionAutoCloudflarePacer({ fetchImpl = fetch, accountId,
  intervalMs = DEFAULT_INTERVAL_MS, maxRunMs = DEFAULT_MAX_RUN_MS,
  now = () => performance.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  noWait = false } = {}) {
  need(typeof fetchImpl === 'function' && /^[a-f0-9]{32}$/u.test(accountId ?? '')
    && Number.isSafeInteger(intervalMs) && intervalMs >= 1 && intervalMs <= 5_000
    && Number.isSafeInteger(maxRunMs) && maxRunMs >= 60_000 && maxRunMs <= DEFAULT_MAX_RUN_MS
    && typeof now === 'function' && typeof pause === 'function' && typeof noWait === 'boolean',
  'runtime_cloudflare_pacer_configuration_invalid');
  const startedAt = now();
  let nextSlotAt = startedAt;
  const permits = new WeakMap();
  const pending = new Set();
  const abortHandlers = new WeakMap();
  const counts = { cloudflareApiRequests: 0, reads: 0, mutations: 0 };

  const waitSlot = async () => {
    need(now() - startedAt <= maxRunMs, 'runtime_cloudflare_release_time_budget_exceeded');
    const slot = Math.max(now(), nextSlotAt);
    nextSlotAt = slot + intervalMs;
    const delay = slot - now();
    if (delay > 0 && !noWait) {
      need(delay <= intervalMs && now() + delay - startedAt <= maxRunMs,
        'runtime_cloudflare_release_time_budget_exceeded');
      await pause(delay);
      need(now() - startedAt <= maxRunMs, 'runtime_cloudflare_release_time_budget_exceeded');
    }
  };
  const parse = input => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const match = url.origin === API_ORIGIN && url.pathname.startsWith(`/client/v4/accounts/${accountId}/`);
    return { url, accountRequest: match, key: `${url.pathname}${url.search}` };
  };
  const reserve = async ({ path, method, signal }) => {
    need(typeof path === 'string' && path.startsWith('/') && ['POST','PUT','DELETE'].includes(method),
      'runtime_cloudflare_dispatch_reservation_invalid');
    const key = path;
    await waitSlot();
    need(!signal?.aborted, 'runtime_cloudflare_dispatch_reservation_aborted');
    const permit = Object.freeze({});
    permits.set(permit, { key, method, reservedAt: now(), used: false });
    pending.add(permit);
    if (signal) {
      const onAbort = () => cancel(permit);
      abortHandlers.set(permit, { signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    return permit;
  };
  const cancel = permit => {
    if (permit && pending.delete(permit)) {
      permits.delete(permit);
      const handler = abortHandlers.get(permit);
      if (handler) handler.signal.removeEventListener('abort', handler.onAbort);
      abortHandlers.delete(permit);
    }
  };
  const assertProjectedBudget = (futureRequests, { reservedMs = 0 } = {}) => {
    need(Number.isSafeInteger(futureRequests) && futureRequests >= 0 && futureRequests <= 100_000,
      'runtime_cloudflare_request_projection_invalid');
    need(Number.isSafeInteger(reservedMs) && reservedMs >= 0 && reservedMs <= maxRunMs,
      'runtime_cloudflare_reserved_time_invalid');
    const elapsed = now() - startedAt;
    const queued = Math.max(0, nextSlotAt - now());
    need(elapsed >= 0 && elapsed <= maxRunMs
      && queued + futureRequests * intervalMs + reservedMs <= maxRunMs - elapsed,
    'runtime_cloudflare_projected_request_budget_exceeded');
    return Object.freeze({ futureRequests, reservedMs, elapsedMs: elapsed, projectedMs: queued + futureRequests * intervalMs,
      remainingMs: maxRunMs - elapsed });
  };
  const pacedFetch = async (input, init = {}) => {
    const { accountRequest, key } = parse(input);
    if (!accountRequest) return fetchImpl(input, init);
    const method = String(init.method ?? 'GET').toUpperCase();
    const isD1Read = method === 'POST' && /\/d1\/database\/(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/query$/u.test(key);
    if (method === 'GET' || isD1Read) {
      await waitSlot();
      need(!init.signal?.aborted, 'runtime_cloudflare_request_aborted_before_dispatch');
      counts.cloudflareApiRequests++; counts.reads++;
      return fetchImpl(input, init);
    }
    const permit = init[PRODUCTION_AUTO_CF_DISPATCH_PERMIT];
    const record = permits.get(permit);
    need(record && pending.has(permit) && !record.used && record.method === method && record.key === key,
      'runtime_cloudflare_mutation_permit_invalid');
    if (init.signal?.aborted || now() - record.reservedAt > PERMIT_MAX_AGE_MS) cancel(permit);
    need(record && pending.has(permit) && !init.signal?.aborted && now() - startedAt <= maxRunMs,
      'runtime_cloudflare_mutation_budget_expired');
    record.used = true;
    cancel(permit);
    const cleanInit = { ...init };
    delete cleanInit[PRODUCTION_AUTO_CF_DISPATCH_PERMIT];
    counts.cloudflareApiRequests++; counts.mutations++;
    return fetchImpl(input, cleanInit);
  };
  if (fetchImpl === globalThis.fetch && !noWait) nativePacedTransports.set(pacedFetch, accountId);
  return Object.freeze({ fetchImpl: pacedFetch, reserve, cancel, startedAt,
    elapsedMs: () => Math.max(0, now() - startedAt), maxRunMs,
    assertProjectedBudget, stats: () => Object.freeze({ ...counts }) });
}
