/** Shared, bounded Cloudflare API pacing for one automatic release run. */
import { probeFetch } from './production-auto-readonly-guard.mjs';
export const PRODUCTION_AUTO_CF_DISPATCH_PERMIT = Symbol('production-auto-cf-dispatch-permit');

const API_ORIGIN = 'https://api.cloudflare.com';
const DEFAULT_INTERVAL_MS = 333;
const DEFAULT_MAX_RUN_MS = 45 * 60_000;
const PERMIT_MAX_AGE_MS = 30_000;
// FUTURE requests at bucket admission, after the session ACK and old helper.
// Automatic capture fails on its first head change: C<=30 for three Workers.
// Schema S=C+4; runtime fence F=S+C. Client coordinator Q=2S+C. Remaining
// B+7 noncleanup intents, B+5 coordinator fences, four asset-proof fences,
// candidate/helper/cleanup readbacks and terminal reconciliation give
// (B+7)(2F+1)+(B+5)Q+4F+4C+63 = (7C+17)B+55C+182.
// C30 =>227B+1832, conservatively dominating Ops225B+1824 (one paced staff
// SELECT per preservation read). Mandatory latest/split/active schema-option
// observations are included even when TTL has not expired. Static asset reads
// are separate bounded verification windows. No mutation retries are allowed.
export const PRODUCTION_AUTO_CF_REQUESTS_PER_ASSET_BUCKET = 227;
export const PRODUCTION_AUTO_CF_FIXED_REQUEST_HEADROOM = 1832;
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
  noWait = false, readonlyRefusals = null } = {}) {
  need(typeof fetchImpl === 'function' && /^[a-f0-9]{32}$/u.test(accountId ?? '')
    && Number.isSafeInteger(intervalMs) && intervalMs >= 1 && intervalMs <= 5_000
    && Number.isSafeInteger(maxRunMs) && maxRunMs >= 60_000 && maxRunMs <= DEFAULT_MAX_RUN_MS
    && typeof now === 'function' && typeof pause === 'function' && typeof noWait === 'boolean',
  'runtime_cloudflare_pacer_configuration_invalid');
  // Read-only diagnostic composition: when a refusal sink is given, every request this transport sends goes through
  // the canonical read-only guard (imported here, never caller-supplied) wrapped around the same inner transport.
  // The native brand below is unchanged: it still requires the inner transport to be exactly globalThis.fetch.
  need(readonlyRefusals === null || Array.isArray(readonlyRefusals), 'runtime_cloudflare_pacer_configuration_invalid');
  const readonly = Array.isArray(readonlyRefusals);
  const send = readonly ? probeFetch(fetchImpl, readonlyRefusals) : fetchImpl;
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
      // A timer can fire slightly before its delay has elapsed on the monotonic clock (whole-millisecond rounding
      // on a cached loop clock). Never dispatch before the slot: otherwise the next request, arriving before this
      // slot, would compute a wait longer than intervalMs and be refused by the check above.
      for (let attempt = 0; attempt < 8 && now() < slot; attempt++) await pause(Math.max(1, Math.ceil(slot - now())));
      need(now() >= slot && now() - startedAt <= maxRunMs, 'runtime_cloudflare_release_time_budget_exceeded');
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
    if (!accountRequest) return send(input, init);
    const method = String(init.method ?? 'GET').toUpperCase();
    const isD1Read = method === 'POST' && /\/d1\/database\/(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/query$/u.test(key);
    if (method === 'GET' || isD1Read) {
      await waitSlot();
      need(!init.signal?.aborted, 'runtime_cloudflare_request_aborted_before_dispatch');
      counts.cloudflareApiRequests++; counts.reads++;
      return send(input, init);
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
    return send(input, cleanInit);
  };
  if (fetchImpl === globalThis.fetch && !noWait) nativePacedTransports.set(pacedFetch, accountId);
  return Object.freeze({ fetchImpl: pacedFetch, readonly, reserve, cancel, startedAt,
    elapsedMs: () => Math.max(0, now() - startedAt), maxRunMs,
    assertProjectedBudget, stats: () => Object.freeze({ ...counts }) });
}
