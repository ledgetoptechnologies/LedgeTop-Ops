// Read-only diagnosis of a held automatic release. It runs the same startup (recipient, gate, trigger, source,
// adapter) and the real coordinator as production-auto-runtime.mjs, but every coordinator step that can write is
// replaced by a counted stop, starting with readOldAssets (which creates the journal and the asset verifier).
// The receipt step is a counted no-op: before readOldAssets there is no journal, so the real step is a no-op too.
//
// What it reports (stdout, one JSON line): whether the release reaches the first write boundary, otherwise the
// sanitized stage/phase/cause/class from production-auto-startup-diagnostics; how many write steps were blocked;
// and an audit of every non-GET/HEAD network request by method, host and id-free path shape (never bodies,
// headers, query strings or ids). It never retries, deploys, or writes the journal. Merger owns any live run.
//   node scripts/production-auto-readonly-probe.mjs   (same environment as the release job)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProductionAutoRelease, createProductionAutoReleaseAdapter } from './production-auto-runtime.mjs';
import { productionAutoStartupFailure } from './production-auto-startup-diagnostics.mjs';

export const PROBE_STOP = 'probe_stopped_before_first_write';
/** Coordinator adapter steps that write (journal, verifier, assets, versions, deployment) or follow a write. */
export const PROBE_BLOCKED_STEPS = Object.freeze(['readOldAssets', 'completeInventory', 'upload', 'candidateReadback',
  'stageZero', 'activate', 'verifyAssets', 'recordIntent']);

const READ_METHODS = new Set(['GET', 'HEAD']);
const ID_SEGMENT = /^(?:[0-9a-f]{8,}|[0-9a-f-]{32,}|\d+|[A-Za-z0-9_-]{24,})$/u;

/** Method, host and a path shape with every id-like segment replaced; nothing else from the request. */
export function requestShape(input, init = {}) {
  let url, method;
  try {
    url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? ''));
    method = String(init?.method ?? (typeof input === 'object' && input?.method) ?? 'GET').toUpperCase();
  } catch { return { method: 'UNKNOWN', host: 'unparsed', path: '/' }; }
  const shape = url.pathname.split('/').map(part => (part && ID_SEGMENT.test(part) ? ':id' : part)).join('/');
  return { method: /^[A-Z]{3,7}$/u.test(method) ? method : 'OTHER', host: url.hostname, path: shape.slice(0, 160) };
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

export async function runProductionAutoReadonlyProbe({ env = process.env, fetchImpl = fetch, runtimeFactory = createProductionAutoReleaseAdapter,
  ...rest } = {}) {
  const counts = { blocked: {}, receiptsSkipped: 0 }, nonRead = [];
  const auditedFetch = (input, init) => {
    const shape = requestShape(input, init);
    if (!READ_METHODS.has(shape.method)) nonRead.push(shape);
    return fetchImpl(input, init);
  };
  const probeFactory = options => {
    const runtime = runtimeFactory(options);
    return Object.freeze({ ...runtime, adapter: probeAdapter(runtime.adapter, counts) });
  };
  let outcome;
  try {
    await runProductionAutoRelease({ ...rest, env, fetchImpl: auditedFetch, runtimeFactory: probeFactory });
    outcome = { status: 'unexpected_completion' };
  } catch (error) {
    const failure = productionAutoStartupFailure(error);
    const reachedBoundary = failure.reason === 'release_held' && failure.phase === 'prepare' && failure.cause === PROBE_STOP;
    outcome = reachedBoundary ? { status: 'reached_first_write_boundary' } : { status: 'held_before_first_write', ...failure };
  }
  return Object.freeze({ ...outcome, blockedSteps: counts.blocked, receiptsSkipped: counts.receiptsSkipped,
    nonReadRequests: nonRead });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runProductionAutoReadonlyProbe();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'reached_first_write_boundary' ? 0 : 1;
}
