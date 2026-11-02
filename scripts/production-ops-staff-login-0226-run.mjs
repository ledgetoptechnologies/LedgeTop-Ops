import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  createProductionOps0226Operator,
  PRODUCTION_OPS_0226_PRE_READ_QUERY,
  PRODUCTION_OPS_0226_TARGET,
} from './production-ops-staff-login-0226-once.mjs';
import { createProductionOps0226CloudflareProvider } from './production-ops-staff-login-0226-cloudflare-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY_CONFIRMATION = 'APPLY 0226';

function fail(code) { throw new Error(`production_ops_0226_runner_${code}`); }

export function parseProductionOps0226RunArgs(args) {
  if (Array.isArray(args) && args.length === 1 && args[0] === '--check') return { mode: 'check', journalPath: null };
  if (Array.isArray(args) && args.length === 3 && args[0] === '--apply' && args[1] === '--journal'
    && typeof args[2] === 'string' && path.isAbsolute(args[2])) return { mode: 'apply', journalPath: args[2] };
  fail('usage');
}

function currentMainSource() {
  let root, branch, changes;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    branch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { fail('git_source_unavailable'); }
  if (path.resolve(root) !== ROOT) fail('repository_root_mismatch');
  if (branch !== 'main') fail('main_branch_required');
  if (changes) fail('working_tree_not_clean');
  let sourceCommit;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { fail('git_source_unavailable'); }
  return sourceCommit;
}

async function confirmApply(confirm) {
  if (confirm) return (await confirm(APPLY_CONFIRMATION)) === true;
  if (!stdin.isTTY || !stdout.isTTY) fail('interactive_confirmation_required');
  const terminal = createInterface({ input: stdin, output: stdout });
  try { return (await terminal.question(`Production D1 schema migration; this does not link any email or create a staff account. Type ${APPLY_CONFIRMATION} to continue: `)) === APPLY_CONFIRMATION; }
  finally { terminal.close(); }
}

function safeSummary(plan, mode) {
  return {
    mode,
    target: { environment: plan.target.environment, accountId: plan.target.accountId, databaseName: plan.target.databaseName, databaseId: plan.target.databaseId },
    sourceCommit: plan.sourceCommit,
    planSha256: plan.planSha256,
    expiresAt: plan.expiresAt,
    preflight: {
      observedAt: plan.preflight.observedAt,
      ledgerCount: plan.preflight.ledgerCount,
      ledgerSha256: plan.preflight.ledgerSha256,
      lastMigration: '0225_native_staff_lifecycle_bridge.sql',
      schemaObjectCount: plan.preflight.schemaObjectCount,
      schemaSha256: plan.preflight.schemaSha256,
      nativeStaffControlEnabled: plan.preflight.nativeStaffControlEnabled,
      protectedStateSha256: plan.preflight.protectedAuthorityStateSHA256,
    },
    writesPerformed: 0,
  };
}

export async function runProductionOps0226(args, dependencies = {}) {
  const options = parseProductionOps0226RunArgs(args);
  const sourceCommit = dependencies.sourceCommit ?? currentMainSource();
  const token = dependencies.token ?? process.env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== 'string' || token.length < 20 || token.length > 16_384) fail('cloudflare_token_missing');
  const providerFactory = dependencies.providerFactory ?? createProductionOps0226CloudflareProvider;
  const operatorFactory = dependencies.operatorFactory ?? createProductionOps0226Operator;
  const provider = providerFactory({ getBearerToken: () => token });
  const operator = operatorFactory();
  const target = await provider.assertTarget(PRODUCTION_OPS_0226_TARGET);
  if (!target || target.databaseId !== PRODUCTION_OPS_0226_TARGET.databaseId || target.name !== PRODUCTION_OPS_0226_TARGET.databaseName)
    fail('target_mismatch');
  const snapshot = await provider.readSnapshot({ target: PRODUCTION_OPS_0226_TARGET, phase: 'immediate-prewrite', query: PRODUCTION_OPS_0226_PRE_READ_QUERY });
  const plan = operator.compile(snapshot, { sourceCommit, root: ROOT });
  const preview = safeSummary(plan, options.mode);
  if (options.mode === 'check') return preview;
  if (!await confirmApply(dependencies.confirm)) return { ...preview, mode: 'cancelled', writesPerformed: 0 };
  const receipt = await operator.executeOnce({ plan, provider, journalPath: options.journalPath });
  return {
    mode: 'applied', target: preview.target, sourceCommit, planSha256: receipt.planSha256,
    migrationSha256: receipt.migrationSha256, journalPath: options.journalPath,
    before: { ledgerCount: receipt.before.ledgerCount, schemaObjectCount: receipt.before.schemaObjectCount,
      protectedStateSha256: receipt.before.protectedAuthorityStateSHA256 },
    after: { ledgerCount: receipt.after.ledgerCount, schemaObjectCount: receipt.after.schemaObjectCount,
      protectedStateSha256: receipt.after.protectedAuthorityStateSHA256, loginObjectsAdded: receipt.after.loginObjectsAdded,
      seededControlRows: receipt.after.seededControlRows, aliasRowsAdded: receipt.after.aliasRowsAdded },
    mutationCalls: receipt.mutationCalls,
  };
}

function safeFailureCode(error) {
  const message = error instanceof Error ? error.message : '';
  return /^production_ops_0226_[a-z_]+$/u.test(message) ? message : 'production_ops_0226_runner_failed';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runProductionOps0226(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.mode === 'cancelled') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  }
}
