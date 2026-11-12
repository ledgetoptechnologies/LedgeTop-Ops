// Bounded entry point for the main-only read-only release diagnostic (.github/workflows/production-auto-diagnostic.yml).
// The workflow copies this file and production-auto-readonly-probe.mjs OUTSIDE the clean checkout ($RUNNER_TEMP),
// verifies both against the hashes pinned in the workflow, and runs this file there. The release modules still load
// from the exact clean checkout (PRODUCTION_AUTO_PROBE_CHECKOUT) and their own fences run unchanged.
//
// What this adds on top of the probe (the probe itself is unchanged):
//   - refuses to run unless the explicit diagnostic opt-in is on AND the global automatic release is OFF;
//   - the Client lane only (the lane whose release failed);
//   - one wall-clock bound, and bounded, allowlisted output (one JSON line, at most PROBE_OUTPUT_LIMIT bytes).
//
// GATE SUBSTITUTION (needs Merger's explicit acceptance; see docs/operations/production-auto-diagnostic.md):
// the release runtime's first check is `PRODUCTION_AUTO_RELEASE_ENABLED === 'true'`. With the global release OFF,
// an unmodified run would stop at that gate and diagnose nothing. So, only inside this process's own env copy and
// only after confirming the real repository variable is OFF, the probe is handed `PRODUCTION_AUTO_RELEASE_ENABLED:
// 'true'`. This is safe only because the probe replaces every write step with a counted stop and refuses every
// non-allowlisted request before it is sent. It never changes the repository variable, and the real release
// workflow evaluates the real variable (OFF) and does not run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProductionAutoReadonlyProbe } from './production-auto-readonly-probe.mjs';

export const DIAGNOSTIC_WORKER = 'ledgetop-clients';
export const PROBE_TIMEOUT_MS = 15 * 60_000;
export const PROBE_OUTPUT_LIMIT = 16 * 1024;
export const PROBE_REFUSAL_LIMIT = 50;
const STATUSES = new Set(['reached_first_write_boundary', 'held_before_first_write', 'unexpected_completion']);
const FAILURE_FIELDS = ['stage', 'reason', 'phase', 'cause', 'class'];
const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,96}$/u;

/** Refuses unless the diagnostic opt-in is on, the global release is OFF, the lane is the Client and the event is workflow_run. */
export function diagnosticEnvironment(env) {
  const refuse = reason => { throw new Error(`diagnostic_refused: ${reason}`); };
  if (env.PRODUCTION_AUTO_DIAGNOSTIC_ENABLED !== 'true') refuse('diagnostic_opt_in_off');
  if (env.PRODUCTION_AUTO_RELEASE_ENABLED !== 'false') refuse('global_release_not_off');
  if (env.PRODUCTION_AUTO_WORKER !== DIAGNOSTIC_WORKER) refuse('lane');
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') refuse('event');
  if (!env.PRODUCTION_AUTO_PROBE_CHECKOUT) refuse('checkout');
  // Gate substitution, in this process's env copy only (see the header).
  return Object.freeze({ ...env, PRODUCTION_AUTO_RELEASE_ENABLED: 'true' });
}

const label = value => (typeof value === 'string' && SAFE_LABEL.test(value) ? value : value == null ? null : 'unlabelled');
const labels = (list, limit) => (Array.isArray(list) ? list.slice(0, limit).map(label) : []);

/** Keeps only fixed, label-shaped fields; caps every list; drops anything else the probe or checkout might add. */
export function boundedReport(result) {
  const status = STATUSES.has(result?.status) ? result.status : 'unlabelled';
  const failure = {};
  for (const field of FAILURE_FIELDS) if (result?.[field] !== undefined) failure[field] = label(result[field]);
  const refused = Array.isArray(result?.refusedRequests) ? result.refusedRequests : [];
  const blocked = {};
  for (const [step, count] of Object.entries(result?.blockedSteps ?? {}).slice(0, 16))
    if (SAFE_LABEL.test(step) && Number.isSafeInteger(count)) blocked[step] = count;
  const report = {
    status, ...failure,
    readStepsEntered: labels(result?.readStepsEntered, 16), readStepsCompleted: labels(result?.readStepsCompleted, 16),
    failedReadStep: label(result?.failedReadStep ?? null), blockedSteps: blocked,
    receiptsSkipped: Number.isSafeInteger(result?.receiptsSkipped) ? result.receiptsSkipped : null,
    refusedRequestCount: refused.length,
    refusedRequests: refused.slice(0, PROBE_REFUSAL_LIMIT).map(item => ({ method: label(item?.method), category: label(item?.category) })),
  };
  let line = JSON.stringify(report);
  if (Buffer.byteLength(line) > PROBE_OUTPUT_LIMIT) line = JSON.stringify({ status, ...failure, truncated: true, refusedRequestCount: refused.length });
  return line;
}

export async function runDiagnostic({ env = process.env, probe = runProductionAutoReadonlyProbe, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let probeEnv;
  try { probeEnv = diagnosticEnvironment(env); }
  catch (error) { return { exitCode: 2, line: JSON.stringify({ status: 'refused', reason: label(String(error.message).split(': ')[1]) }) }; }
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic_timeout')), timeoutMs); });
  try {
    const result = await Promise.race([probe({ env: probeEnv }), timeout]);
    return { exitCode: result?.status === 'reached_first_write_boundary' || result?.status === 'held_before_first_write' ? 0 : 1, line: boundedReport(result) };
  } catch (error) {
    return { exitCode: 3, line: JSON.stringify({ status: error?.message === 'diagnostic_timeout' ? 'timeout' : 'probe_error' }) };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, line } = await runDiagnostic();
  console.log(line);
  process.exitCode = exitCode;
}
