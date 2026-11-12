// Read-only diagnosis of a held automatic release: a thin CLI over the release runtime's explicit
// 'readonly_diagnostic' mode (production-auto-runtime.mjs). That mode has its own gate
// (PRODUCTION_AUTO_DIAGNOSTIC_ENABLED === 'true' AND the global release exactly OFF), never touches the release gate,
// and runs the same startup and the real coordinator with the read-only guard (production-auto-readonly-guard.mjs)
// applied by the runtime itself: every write step is a counted stop, starting with readOldAssets (which creates the
// journal and the asset verifier); receipts are counted no-ops; the network is an exact read allowlist.
//
// What it reports (stdout, one JSON line): whether the release reaches the first write boundary, otherwise the
// sanitized stage/phase/cause/class from production-auto-startup-diagnostics; the read steps entered and completed
// (fixed names); how many write steps were blocked; and every refused request as a fixed method label and category
// (never host, path, body, headers or query text). It never retries, deploys, or writes the journal. Merger owns any
// live run; it builds, so never on Beau's PC.
//
// Provenance: the release modules are loaded from an exact, clean checkout of the commit under test
// (PRODUCTION_AUTO_PROBE_CHECKOUT, default: this file's own repository), whose own fences still run unchanged: clean,
// at the trigger's CI commit and equal to main. This file has no static imports, so it may also run from outside
// that checkout.
//   PRODUCTION_AUTO_PROBE_CHECKOUT=<clean main checkout> node <path>/production-auto-readonly-probe.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Loads the release modules from an exact checkout (default: this repository). */
export async function loadReleaseModules(checkout = process.env.PRODUCTION_AUTO_PROBE_CHECKOUT || path.resolve(here, '..')) {
  const root = fs.realpathSync(checkout);
  const load = name => import(pathToFileURL(path.join(root, 'scripts', name)).href);
  const [runtime, diagnostics] = await Promise.all([load('production-auto-runtime.mjs'), load('production-auto-startup-diagnostics.mjs')]);
  return { root, runProductionAutoRelease: runtime.runProductionAutoRelease,
    productionAutoStartupFailure: diagnostics.productionAutoStartupFailure };
}

// Only the environment and the module source are chosen here; the runtime refuses any injected transport, factory or
// reader in diagnostic mode, so the probe cannot pass one.
export async function runProductionAutoReadonlyProbe({ env = process.env, modules } = {}) {
  const release = modules ?? await loadReleaseModules();
  // Data-only sink: the runtime's guard records into it. It cannot change what is blocked or allowed.
  const diagnostic = { counts: { blocked: {}, receiptsSkipped: 0, entered: [], completed: [] }, refused: [] };
  const { counts, refused } = diagnostic;
  let outcome;
  try {
    await release.runProductionAutoRelease({ mode: 'readonly_diagnostic', diagnostic, env, workerName: env.PRODUCTION_AUTO_WORKER });
    outcome = { status: 'unexpected_completion' };
  } catch (error) {
    const failure = release.productionAutoStartupFailure(error);
    // Reaching the first write step is the boundary, whatever the checkout's diagnostics can name.
    outcome = counts.blocked.readOldAssets ? { status: 'reached_first_write_boundary' } : { status: 'held_before_first_write', ...failure };
  }
  const failedStep = counts.entered.find((step, index) => counts.completed[index] !== step) ?? null;
  return Object.freeze({ ...outcome, readStepsEntered: counts.entered, readStepsCompleted: counts.completed, failedReadStep: failedStep,
    blockedSteps: counts.blocked, receiptsSkipped: counts.receiptsSkipped, refusedRequests: refused });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runProductionAutoReadonlyProbe();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'reached_first_write_boundary' ? 0 : 1;
}
