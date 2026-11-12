// Bounded entry point for the main-only read-only release diagnostic (.github/workflows/production-auto-diagnostic.yml).
// The workflow copies this file and production-auto-readonly-probe.mjs OUTSIDE the clean checkout ($RUNNER_TEMP),
// verifies both against hashes pinned in the workflow, and runs this file there.
//
// It does not change the environment: no gate is substituted. The probe runs the release runtime's explicit
// 'readonly_diagnostic' mode, which has its own gate (diagnostic opt-in on AND global release exactly OFF) and applies
// the read-only guard itself. This file only adds:
//   - the same preconditions checked up front, so a refused run never starts a process;
//   - a process boundary: the probe runs as a child in its own process group (POSIX) or job tree (Windows). On the
//     deadline, or if its output passes the limit, the whole group/tree is killed (including any npm/build it
//     spawned) and the runner waits until the group is gone and reports whether it was reaped;
//   - bounded, allowlisted output: one JSON line, at most PROBE_OUTPUT_LIMIT bytes, fixed label-shaped fields only.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIAGNOSTIC_WORKER = 'ledgetop-clients';
export const PROBE_TIMEOUT_MS = 15 * 60_000;
export const PROBE_OUTPUT_LIMIT = 16 * 1024;
export const PROBE_REFUSAL_LIMIT = 50;
export const REAP_WAIT_MS = 5_000;
const STATUSES = new Set(['reached_first_write_boundary', 'held_before_first_write', 'unexpected_completion']);
// The fixed-vocabulary fields production-auto-startup-diagnostics returns (errorType is a built-in class name).
const FAILURE_FIELDS = ['stage', 'reason', 'phase', 'cause', 'errorType'];
const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,96}$/u;

/** The same preconditions the runtime's diagnostic gate enforces; checked here so a refused run never spawns. */
export function diagnosticPreconditions(env) {
  if (env.PRODUCTION_AUTO_DIAGNOSTIC_ENABLED !== 'true') return 'diagnostic_opt_in_off';
  if (env.PRODUCTION_AUTO_RELEASE_ENABLED !== 'false') return 'global_release_not_off';
  if (env.PRODUCTION_AUTO_WORKER !== DIAGNOSTIC_WORKER) return 'lane';
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') return 'event';
  if (!env.PRODUCTION_AUTO_PROBE_CHECKOUT || !path.isAbsolute(env.PRODUCTION_AUTO_PROBE_CHECKOUT)) return 'checkout';
  return null;
}

const label = value => (typeof value === 'string' && SAFE_LABEL.test(value) ? value : value == null ? null : 'unlabelled');
const labels = (list, limit) => (Array.isArray(list) ? list.slice(0, limit).map(label) : []);

/** Keeps only fixed, label-shaped fields; caps every list; drops anything else the probe or checkout might add. */
export function boundedReport(result) {
  const status = STATUSES.has(result?.status) ? result.status : 'unlabelled';
  const failure = {};
  for (const field of FAILURE_FIELDS) if (result?.[field] !== undefined) failure[field] = label(result[field]);
  const checks = {};
  if (result?.checks && typeof result.checks === 'object')
    for (const [key, value] of Object.entries(result.checks).slice(0, 16)) if (SAFE_LABEL.test(key) && typeof value === 'boolean') checks[key] = value;
  const refused = Array.isArray(result?.refusedRequests) ? result.refusedRequests : [];
  const blocked = {};
  for (const [step, count] of Object.entries(result?.blockedSteps ?? {}).slice(0, 16))
    if (SAFE_LABEL.test(step) && Number.isSafeInteger(count)) blocked[step] = count;
  const report = {
    status, ...failure, ...(Object.keys(checks).length ? { checks } : {}),
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid, group) {
  try { process.kill(group ? -pid : pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
/** Kills the child's whole group (POSIX) or process tree (Windows). */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}
/** Waits until the group (POSIX) or the child (Windows; taskkill /T already took its tree) no longer exists. */
async function reaped(child, waitMs) {
  const group = process.platform !== 'win32';
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await sleep(50)) if (!alive(child.pid, group)) return true;
  return !alive(child.pid, group);
}

/**
 * Runs the probe in a child process with a hard deadline and output limit. `probePath` defaults to the probe copied
 * next to this file; tests pass a fixture.
 */
export async function runDiagnostic({ env = process.env, probePath = path.join(here, 'production-auto-readonly-probe.mjs'),
  timeoutMs = PROBE_TIMEOUT_MS, reapWaitMs = REAP_WAIT_MS, spawnImpl = spawn } = {}) {
  const refused = diagnosticPreconditions(env);
  if (refused) return { exitCode: 2, line: JSON.stringify({ status: 'refused', reason: refused }) };
  const child = spawnImpl(process.execPath, [probePath], { cwd: env.PRODUCTION_AUTO_PROBE_CHECKOUT, env,
    stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true, shell: false });
  const chunks = [];
  let bytes = 0, stopped = null;
  const closed = new Promise(resolve => { child.on('close', code => resolve(code)); child.on('error', () => resolve(null)); });
  const stop = reason => { if (stopped) return; stopped = reason; killTree(child); };
  child.stdout.on('data', chunk => {
    if (stopped) return;
    bytes += chunk.length;
    if (bytes > PROBE_OUTPUT_LIMIT) { stop('output_limit'); return; }
    chunks.push(chunk);
  });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const code = await closed;
  clearTimeout(timer);
  if (stopped) {
    // The direct child has exited; make sure nothing it started is still running.
    killTree(child);
    return { exitCode: 3, line: JSON.stringify({ status: stopped, reaped: await reaped(child, reapWaitMs) }) };
  }
  // A probe that exits on its own may still have left a grandchild behind; take the group down regardless.
  if (process.platform !== 'win32' && alive(child.pid, true)) killTree(child);
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]); }
  catch { return { exitCode: 3, line: JSON.stringify({ status: 'probe_error', spawned: code !== null }) }; }
  return { exitCode: result?.status === 'reached_first_write_boundary' || result?.status === 'held_before_first_write' ? 0 : 1, line: boundedReport(result) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, line } = await runDiagnostic();
  console.log(line);
  process.exitCode = exitCode;
}
