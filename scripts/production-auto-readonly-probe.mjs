// Read-only diagnosis of a held automatic release. It runs the same startup (recipient, gate, trigger, source,
// adapter) and the real coordinator as production-auto-runtime.mjs, but every coordinator step that can write is
// replaced by a counted stop, starting with readOldAssets (which creates the journal and the asset verifier).
// The receipt step is a counted no-op: before readOldAssets there is no journal, so the real step is a no-op too.
//
// What it reports (stdout, one JSON line): whether the release reaches the first write boundary, otherwise the
// sanitized stage/phase/cause/class from production-auto-startup-diagnostics; how many write steps were blocked;
// and every refused network request by method, host and id-free path shape (never bodies, headers, query strings
// or ids). Network enforcement is an exact allowlist (see allowedProbeRequest): pinned GitHub repo and Cloudflare
// account reads, and POST only for exact reviewed SQL on pinned D1 databases. Everything else is refused before
// it is sent.
// It never retries, deploys, or writes the journal. Merger owns any live run; it builds, so never on Beau's PC.
//   node scripts/production-auto-readonly-probe.mjs   (same environment as the release job)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProductionAutoRelease, createProductionAutoReleaseAdapter } from './production-auto-runtime.mjs';
import { productionAutoStartupFailure } from './production-auto-startup-diagnostics.mjs';
import { PRODUCTION_MIGRATION_QUERY } from './production-auto-migration-readiness.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

export const PROBE_STOP = 'probe_stopped_before_first_write';
/** Coordinator adapter steps that write (journal, verifier, assets, versions, deployment) or follow a write. */
export const PROBE_BLOCKED_STEPS = Object.freeze(['readOldAssets', 'completeInventory', 'upload', 'candidateReadback',
  'stageZero', 'activate', 'verifyAssets', 'recordIntent']);

const READ_METHODS = new Set(['GET', 'HEAD']);
// Pinned read targets. Anything not matched here is refused before it is sent (fail closed); Merger extends
// these only after review, never at run time.
export const PROBE_GITHUB_REPO = 'ledgetoptechnologies/LedgeTop-Ops';
export const PROBE_CLOUDFLARE_ACCOUNT = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
export const PROBE_D1_DATABASES = Object.freeze(['6ebf7514-d306-4615-ae56-ad869c874dbd', '7f40a7b7-c3ec-470e-a626-e798867f71f8']);
/** The only SQL a probe may POST: exact reviewed read statements (no runtime-built SQL). */
export const PROBE_REVIEWED_SQL = Object.freeze([PRODUCTION_MIGRATION_QUERY]);

function parsedRequest(input, init) {
  let url;
  try { url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : String(input?.url ?? '')); } catch { return null; }
  const requested = init?.method ?? (input && typeof input === 'object' && !(input instanceof URL) ? input.method : undefined);
  return { url, method: String(requested ?? 'GET').toUpperCase() };
}

/**
 * Exact read allowlist. GET/HEAD only to the pinned GitHub repository (or /rate_limit) and the pinned Cloudflare
 * account; POST only to a pinned D1 database's /query with a JSON body { sql, params: [] } whose sql is exactly a
 * reviewed statement. No query strings on D1, no other hosts, no other methods, no other SQL.
 */
export function allowedProbeRequest(input, init = {}) {
  const request = parsedRequest(input, init);
  if (!request || request.url.protocol !== 'https:' || request.url.username || request.url.password || request.url.port) return false;
  const { url, method } = request, path = url.pathname;
  if (url.hostname === 'api.github.com')
    return READ_METHODS.has(method) && (path === '/rate_limit' || path.startsWith(`/repos/${PROBE_GITHUB_REPO}/`));
  if (url.hostname !== 'api.cloudflare.com') return false;
  const accountRoot = `/client/v4/accounts/${PROBE_CLOUDFLARE_ACCOUNT}/`;
  if (!path.startsWith(accountRoot)) return false;
  if (READ_METHODS.has(method)) return true;
  if (method !== 'POST' || url.search) return false;
  const d1 = /^d1\/database\/([0-9a-f-]{36})\/query$/u.exec(path.slice(accountRoot.length));
  if (!d1 || !PROBE_D1_DATABASES.includes(d1[1]) || typeof init?.body !== 'string') return false;
  let body; try { body = JSON.parse(init.body); } catch { return false; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  if (!(keys.length === 1 && keys[0] === 'sql') && !(keys.length === 2 && keys[0] === 'params' && keys[1] === 'sql')) return false;
  if (body.params !== undefined && !(Array.isArray(body.params) && body.params.length === 0)) return false;
  return PROBE_REVIEWED_SQL.includes(body.sql);
}
const ID_SEGMENT = /^(?:[0-9a-f]{8,}|[0-9a-f-]{32,}|\d+|[A-Za-z0-9_-]{24,})$/u;

/** Method, host and a path shape with every id-like segment replaced; nothing else from the request. */
export function requestShape(input, init = {}) {
  const request = parsedRequest(input, init);
  if (!request) return { method: 'UNKNOWN', host: 'unparsed', path: '/' };
  const shape = request.url.pathname.split('/').map(part => (part && ID_SEGMENT.test(part) ? ':id' : part)).join('/');
  return { method: /^[A-Z]{3,7}$/u.test(request.method) ? request.method : 'OTHER', host: request.url.hostname, path: shape.slice(0, 160) };
}

/** Wraps the real adapter: every write-capable step becomes a counted stop; receipts become counted no-ops. */
export function probeAdapter(adapter, counts) {
  const wrapped = { ...adapter };
  for (const step of PROBE_BLOCKED_STEPS) {
    if (typeof adapter[step] !== 'function') continue;
    wrapped[step] = async () => { counts.blocked[step] = (counts.blocked[step] ?? 0) + 1; throw new Error('probe_stopped_before_first_write'); };
  }
  wrapped.receipt = async () => { counts.receiptsSkipped++; };
  return Object.freeze(wrapped);
}

/** fetch that forwards only allowlisted reads; anything else is recorded (shape only) and refused, never sent. */
export function probeFetch(fetchImpl, refused) {
  return async (input, init) => {
    if (!allowedProbeRequest(input, init)) {
      refused.push(requestShape(input, init));
      throw new Error('probe_refused_non_read_request');
    }
    return fetchImpl(input, init);
  };
}

export async function runProductionAutoReadonlyProbe({ env = process.env, fetchImpl = fetch, runtimeFactory = createProductionAutoReleaseAdapter,
  ...rest } = {}) {
  const counts = { blocked: {}, receiptsSkipped: 0 }, refused = [];
  const guardedFetch = probeFetch(fetchImpl, refused);
  const probeFactory = options => {
    const runtime = runtimeFactory(options);
    return Object.freeze({ ...runtime, adapter: probeAdapter(runtime.adapter, counts) });
  };
  let outcome;
  try {
    await runProductionAutoRelease({ ...rest, env, fetchImpl: guardedFetch, runtimeFactory: probeFactory });
    outcome = { status: 'unexpected_completion' };
  } catch (error) {
    const failure = productionAutoStartupFailure(error);
    const reachedBoundary = failure.reason === 'release_held' && failure.phase === 'prepare' && failure.cause === PROBE_STOP;
    outcome = reachedBoundary ? { status: 'reached_first_write_boundary' } : { status: 'held_before_first_write', ...failure };
  }
  return Object.freeze({ ...outcome, blockedSteps: counts.blocked, receiptsSkipped: counts.receiptsSkipped,
    refusedRequests: refused });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runProductionAutoReadonlyProbe();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'reached_first_write_boundary' ? 0 : 1;
}
