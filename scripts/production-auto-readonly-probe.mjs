// Read-only diagnosis of a held automatic release. It runs the same startup (recipient, gate, trigger, source,
// adapter) and the real coordinator as production-auto-runtime.mjs, but every coordinator step that can write is
// replaced by a counted stop, starting with readOldAssets (which creates the journal and the asset verifier).
// The receipt step is a counted no-op: before readOldAssets there is no journal, so the real step is a no-op too.
//
// What it reports (stdout, one JSON line): whether the release reaches the first write boundary, otherwise the
// sanitized stage/phase/cause/class from production-auto-startup-diagnostics; how many write steps were blocked;
// and every refused network request as a fixed method label and fixed category (never host, path, body, headers
// or query text). Network enforcement is an exact allowlist (see allowedProbeRequest): pinned GitHub repo and Cloudflare
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
/** Production Worker names the release reads (production-auto-provider.mjs WORKERS). */
export const PROBE_WORKERS = Object.freeze(['ledgetop-ops', 'ledgetop-clients', 'ledgetop-ops-sync']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WORKER = `(?:${PROBE_WORKERS.join('|')})`;
// Exact read endpoints (path + full query string) the release startup and capture use, relative to the
// repository or account root. Anything else, including extra or reordered query fields, is refused.
const GITHUB_REPO_READS = [
  /^\/commits\/main$/u,
  /^\/actions\/workflows\/ci\.yml\/runs\?branch=main&event=push&head_sha=[a-f0-9]{40}&per_page=100$/u,
  /^\/actions\/runs\/[1-9][0-9]*\/jobs\?filter=latest&per_page=100$/u,
  /^\/actions\/artifacts\/[1-9][0-9]*$/u,
];
const CLOUDFLARE_ACCOUNT_READS = [
  new RegExp(`^workers/scripts/${WORKER}$`, 'u'),
  new RegExp(`^workers/scripts/${WORKER}/(?:settings|schedules|subdomain)$`, 'u'),
  new RegExp(`^workers/scripts/${WORKER}/deployments\\?per_page=1$`, 'u'),
  new RegExp(`^workers/scripts/${WORKER}/versions\\?per_page=1$`, 'u'),
  new RegExp(`^workers/scripts/${WORKER}/versions/${UUID}$`, 'u'),
  new RegExp(`^workers/workers/${WORKER}/versions/${UUID}\\?include=modules$`, 'u'),
];
/** The only SQL a probe may POST: exact reviewed read statements (no runtime-built SQL). */
export const PROBE_REVIEWED_SQL = Object.freeze([PRODUCTION_MIGRATION_QUERY]);

function parsedRequest(input, init) {
  let url;
  try { url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : String(input?.url ?? '')); } catch { return null; }
  const requested = init?.method ?? (input && typeof input === 'object' && !(input instanceof URL) ? input.method : undefined);
  return { url, method: String(requested ?? 'GET').toUpperCase() };
}

/** Fixed labels for every request decision; refusals are reported only by these, never by host or path text. */
export const PROBE_REQUEST_CATEGORIES = Object.freeze(['allowed_github_read', 'allowed_cloudflare_read', 'allowed_d1_reviewed_query',
  'refused_invalid_url', 'refused_not_https', 'refused_other_host', 'refused_github_other_target', 'refused_github_write',
  'refused_cloudflare_other_account', 'refused_cloudflare_other_target', 'refused_cloudflare_write', 'refused_d1_other_database', 'refused_d1_malformed_body',
  'refused_d1_unreviewed_sql']);
const METHOD_LABELS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Exact read allowlist. GET/HEAD only to the pinned GitHub repository (or /rate_limit) and the pinned Cloudflare
 * account; POST only to a pinned D1 database's /query with a JSON body { sql } or { sql, params: [] } whose sql is
 * exactly a reviewed statement. No query strings on D1, no other hosts, no other methods, no other SQL.
 * Returns one fixed category from PROBE_REQUEST_CATEGORIES.
 */
export function classifyProbeRequest(input, init = {}) {
  const request = parsedRequest(input, init);
  if (!request) return 'refused_invalid_url';
  const { url, method } = request, path = url.pathname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'refused_not_https';
  if (url.hostname === 'api.github.com') {
    if (!READ_METHODS.has(method)) return 'refused_github_write';
    if (path === '/rate_limit' && !url.search) return 'allowed_github_read';
    const repoRoot = `/repos/${PROBE_GITHUB_REPO}`;
    const rest = path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length) + url.search : null;
    return rest !== null && GITHUB_REPO_READS.some(pattern => pattern.test(rest)) ? 'allowed_github_read' : 'refused_github_other_target';
  }
  if (url.hostname !== 'api.cloudflare.com') return 'refused_other_host';
  const accountRoot = `/client/v4/accounts/${PROBE_CLOUDFLARE_ACCOUNT}/`;
  if (!path.startsWith(accountRoot)) return 'refused_cloudflare_other_account';
  if (READ_METHODS.has(method))
    return CLOUDFLARE_ACCOUNT_READS.some(pattern => pattern.test(path.slice(accountRoot.length) + url.search))
      ? 'allowed_cloudflare_read' : 'refused_cloudflare_other_target';
  const d1 = /^d1\/database\/([0-9a-f-]{36})\/query$/u.exec(path.slice(accountRoot.length));
  if (method !== 'POST' || !d1) return 'refused_cloudflare_write';
  if (!PROBE_D1_DATABASES.includes(d1[1])) return 'refused_d1_other_database';
  if (url.search || typeof init?.body !== 'string') return 'refused_d1_malformed_body';
  let body; try { body = JSON.parse(init.body); } catch { return 'refused_d1_malformed_body'; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'refused_d1_malformed_body';
  const keys = Object.keys(body).sort();
  if (!(keys.length === 1 && keys[0] === 'sql') && !(keys.length === 2 && keys[0] === 'params' && keys[1] === 'sql')) return 'refused_d1_malformed_body';
  if (body.params !== undefined && !(Array.isArray(body.params) && body.params.length === 0)) return 'refused_d1_malformed_body';
  return PROBE_REVIEWED_SQL.includes(body.sql) ? 'allowed_d1_reviewed_query' : 'refused_d1_unreviewed_sql';
}

export const allowedProbeRequest = (input, init = {}) => classifyProbeRequest(input, init).startsWith('allowed_');

/** What a refusal records: a fixed method label and a fixed category. Nothing derived from the URL or body. */
export function refusalRecord(input, init = {}) {
  const request = parsedRequest(input, init);
  return Object.freeze({ method: request && METHOD_LABELS.has(request.method) ? request.method : 'OTHER', category: classifyProbeRequest(input, init) });
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

/** fetch that forwards only allowlisted reads; anything else is recorded (fixed labels only) and refused, never sent. */
export function probeFetch(fetchImpl, refused) {
  return async (input, init) => {
    if (!allowedProbeRequest(input, init)) {
      refused.push(refusalRecord(input, init));
      throw new Error('probe_refused_non_read_request');
    }
    // Never follow a redirect: a redirected hop would bypass this classification. Forced for every request,
    // whatever the caller (or a Request object) asked for.
    return fetchImpl(input, { ...(init ?? {}), redirect: 'error' });
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
