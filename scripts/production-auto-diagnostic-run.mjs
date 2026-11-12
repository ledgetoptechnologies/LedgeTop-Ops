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
// held_after_probe_refusal is reported but is NOT a diagnosis of the original release (exit 1): the hold may be the
// probe guard's own refusal.
const STATUSES = new Set(['reached_first_write_boundary', 'held_before_first_write', 'held_after_probe_refusal', 'unexpected_completion']);
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
export function boundedReport(result, cleanup = null) {
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
    status, ...failure, ...(Object.keys(checks).length ? { checks } : {}), ...(cleanup === 'leftover_reaped' ? { cleanup } : {}),
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
/** Real process control. POSIX acts on the child's whole process group; Windows on its process tree via taskkill /T. */
export function processControl(platform = process.platform) {
  const posix = platform !== 'win32';
  return Object.freeze({
    posix,
    alive(pid) { try { process.kill(posix ? -pid : pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } },
    killTree(pid) {
      if (!pid) return;
      if (!posix) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      else { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    },
  });
}
/** Waits, bounded, until the group (POSIX) or the child (Windows; taskkill /T already took its tree) is gone. */
async function reaped(control, pid, waitMs) {
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await sleep(50)) if (!control.alive(pid)) return true;
  return !control.alive(pid);
}

export const DRAIN_WAIT_MS = 2_000;
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

/**
 * Runs the probe in a child process with a hard deadline and output limit. `probePath` defaults to the probe copied
 * next to this file and `control` to the real process control; tests pass fixtures.
 *
 * Only the exact child this call spawned, and on POSIX the process group it leads (detached, so its group id is its
 * pid), is ever signalled; no other or shared pid is touched, and nothing is signalled once the group is confirmed
 * gone. With `handleSignals` (the CLI sets it), a SIGINT, SIGTERM or SIGHUP to the runner (e.g. the outer
 * `timeout` or an Actions cancel) kills that group, waits a bounded time for it to be gone, and then exits with the
 * conventional 128+n status; a plain process exit also kills it synchronously.
 */
export async function runDiagnostic({ env = process.env, probePath = path.join(here, 'production-auto-readonly-probe.mjs'),
  timeoutMs = PROBE_TIMEOUT_MS, reapWaitMs = REAP_WAIT_MS, drainWaitMs = DRAIN_WAIT_MS, spawnImpl = spawn, control = processControl(),
  handleSignals = false } = {}) {
  const refused = diagnosticPreconditions(env);
  if (refused) return { exitCode: 2, line: JSON.stringify({ status: 'refused', reason: refused }) };
  const child = spawnImpl(process.execPath, [probePath], { cwd: env.PRODUCTION_AUTO_PROBE_CHECKOUT, env,
    stdio: ['ignore', 'pipe', 'ignore'], detached: control.posix, windowsHide: true, shell: false });
  const pid = child.pid;
  let gone = false;
  const killOwned = () => { if (!gone && pid) control.killTree(pid); };
  // Interruption of the runner itself: take the owned group down, bounded, then exit with the signal's status.
  const onSignal = signal => {
    killOwned();
    reaped(control, pid, reapWaitMs).finally(() => process.exit(SIGNAL_EXIT[signal]));
  };
  const onExit = () => killOwned();
  if (handleSignals) { for (const signal of Object.keys(SIGNAL_EXIT)) process.once(signal, onSignal); process.once('exit', onExit); }
  const unhook = () => { if (!handleSignals) return; for (const signal of Object.keys(SIGNAL_EXIT)) process.off(signal, onSignal); process.off('exit', onExit); };
  try {
    const chunks = [];
    let bytes = 0, stopped = null;
    // 'exit' is the direct child ending; 'close' also waits for every holder of the stdout pipe (a descendant that
    // inherited it). They are waited for separately, and the pipe drain is bounded.
    const exited = new Promise(resolve => { child.on('exit', code => resolve(code)); child.on('error', () => resolve(null)); });
    const drained = new Promise(resolve => { child.stdout.on('close', resolve); child.stdout.on('error', resolve); });
    const stop = reason => { if (stopped) return; stopped = reason; killOwned(); };
    child.stdout.on('data', chunk => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > PROBE_OUTPUT_LIMIT) { stop('output_limit'); return; }
      chunks.push(chunk);
    });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const code = await exited;
    clearTimeout(timer);
    // Bounded drain of the probe's own output; a descendant still holding the pipe cannot stretch it.
    const pipeClosed = await Promise.race([drained.then(() => true), sleep(drainWaitMs).then(() => false)]);
    if (stopped) {
      killOwned();
      gone = await reaped(control, pid, reapWaitMs);
      child.stdout.destroy();
      return { exitCode: 3, line: JSON.stringify({ status: stopped, reaped: gone }) };
    }
    // The probe exited on its own but may have left a descendant in its group (POSIX), possibly holding the pipe.
    // Kill the group and wait, bounded, until it is gone; if it persists the run fails as cleanup_failed.
    // (Windows has no group to inspect after the direct child exits; the hosted workflow runs on Linux.)
    let cleanup = null;
    if (control.posix && pid && control.alive(pid)) {
      killOwned();
      gone = await reaped(control, pid, reapWaitMs);
      if (!gone) { child.stdout.destroy(); return { exitCode: 3, line: JSON.stringify({ status: 'cleanup_failed', reaped: false }) }; }
      cleanup = 'leftover_reaped';
    } else gone = true;
    if (!pipeClosed) child.stdout.destroy();
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]); }
  catch { return { exitCode: 3, line: JSON.stringify({ status: 'probe_error', spawned: code !== null }) }; }
  return { exitCode: result?.status === 'reached_first_write_boundary' || result?.status === 'held_before_first_write' ? 0 : 1, line: boundedReport(result, cleanup) };
  } finally { unhook(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, line } = await runDiagnostic({ handleSignals: true });
  console.log(line);
  process.exitCode = exitCode;
}
