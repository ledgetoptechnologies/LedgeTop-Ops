// One-shot operator: grant one production Ops owner the native onboarding approver authority.
//
// Migration 0242 makes every onboarding approval require a current global allow delegation
// for `staff.onboarding.approve` in `native_staff_management_delegations` (contract_version 1).
// No application route writes that table, so this tool installs exactly one such row for one
// named owner, through the same Cloudflare D1 REST style as the reviewed 0226 and 0227..0244
// one-shots. It is pinned to the production Ops database and does nothing else.
//
// The default mode is a read-only dry run. `--execute` needs `--approval-ref`, an unused
// absolute `--receipt` path, a clean `main` checkout equal to `origin/main`, and the typed
// confirmation phrase at an interactive terminal. The write is one INSERT .. SELECT in one
// D1 batch whose WHERE clause repeats every precondition, so it inserts nothing unless they
// still hold. It is never retried: an ambiguous outcome is reconciled read-only with
// `--reconcile`. See docs/operations/production-ops-onboarding-approver-grant.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { OPS_PRODUCTION_DATABASE } from './production-ops-0227-0244-ordered-once.mjs';

export const APPROVER_GRANT_CONTRACT = 'production-ops-onboarding-approver-grant-once-v1';
export const APPROVER_GRANT_CAPABILITY = 'staff.onboarding.approve';
export const APPROVER_GRANT_REQUIRED_MIGRATION = '0242_native_staff_onboarding_approval_actor_authority.sql';
export const APPROVER_GRANT_TARGET = Object.freeze({ ...OPS_PRODUCTION_DATABASE });
export const APPROVER_GRANT_CONFIRMATION = (staffId, databaseName) =>
  `GRANT ${APPROVER_GRANT_CAPABILITY} TO ${staffId} ON ${databaseName}`;
/** Deterministic, so an ambiguous write can be reconciled by id. Fits the 0067 id CHECK. */
export const approverGrantDelegationId = staffId => `ops-onboarding-approver-grant.${staffId}`;

const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const APPROVAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{2,127}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const fail = code => { throw new Error(`ops_approver_grant:${code}`); };
export const isApproverGrantStaffId = value => typeof value === 'string' && STAFF_ID.test(value);

// ---------------------------------------------------------------------------
// Pinned SQL. ?1 is the target staff id, ?2 the delegation id. Nothing personal is read back:
// email and access subject are compared inside SQL and only counts leave the database.

const CAP = `'${APPROVER_GRANT_CAPABILITY}'`;
const TRACKED_TABLES = Object.freeze(['staff_users', 'staff_role_assignments', 'staff_permission_overrides',
  'native_staff_admissions', 'native_staff_profiles', 'native_staff_management_delegations',
  'native_staff_delegation_ceilings', 'native_staff_admin_delegations']);
export const APPROVER_GRANT_TRACKED_TABLES = TRACKED_TABLES;

const ELIGIBLE_ACTOR = `EXISTS(SELECT 1 FROM staff_users s
    JOIN native_staff_admissions a ON a.staff_id=s.id AND a.active=1 AND a.bound_access_subject=s.access_subject
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.login_email=s.email COLLATE BINARY
    WHERE s.id=?1 AND s.status='active')
  AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=?1 AND r.role_id='role-owner' AND r.scope='global')
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.actor_staff_id=?1 AND d.capability=${CAP})
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.id=?2)
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.contract_version=1 AND d.capability=${CAP}
    AND d.effect='allow' AND d.scope_kind='global' AND d.active=1)
  AND EXISTS(SELECT 1 FROM d1_migrations m WHERE m.name='${APPROVER_GRANT_REQUIRED_MIGRATION}')
  AND EXISTS(SELECT 1 FROM native_staff_authority_capabilities c WHERE c.contract_version=1
    AND c.authority_domain='staff_admin' AND c.capability=${CAP})`;

export const APPROVER_GRANT_READ_SQL = `SELECT
  (SELECT count(*) FROM staff_users WHERE id=?1) AS staff_exists,
  (SELECT count(*) FROM staff_users WHERE id=?1 AND status='active') AS staff_active,
  (SELECT count(*) FROM staff_role_assignments WHERE staff_id=?1 AND role_id='role-owner' AND scope='global') AS owner_assignments,
  (SELECT count(*) FROM native_staff_admissions WHERE staff_id=?1 AND active=1) AS admission_active,
  (SELECT count(*) FROM staff_users s
    JOIN native_staff_admissions a ON a.staff_id=s.id AND a.active=1 AND a.bound_access_subject=s.access_subject
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.login_email=s.email COLLATE BINARY
    WHERE s.id=?1 AND s.status='active') AS native_identity_consistent,
  (SELECT count(*) FROM native_staff_management_delegations WHERE actor_staff_id=?1 AND capability=${CAP} AND effect='allow') AS actor_allow_rows,
  (SELECT count(*) FROM native_staff_management_delegations WHERE actor_staff_id=?1 AND capability=${CAP} AND effect='deny') AS actor_deny_rows,
  (SELECT count(*) FROM native_staff_management_delegations WHERE id=?2) AS delegation_id_rows,
  (SELECT count(*) FROM native_staff_management_delegations WHERE contract_version=1 AND capability=${CAP}
    AND effect='allow' AND scope_kind='global' AND active=1) AS global_approvers,
  (SELECT count(*) FROM d1_migrations WHERE name='${APPROVER_GRANT_REQUIRED_MIGRATION}') AS ledger_0242,
  (SELECT count(*) FROM native_staff_authority_capabilities WHERE contract_version=1 AND authority_domain='staff_admin'
    AND capability=${CAP}) AS capability_catalog,
  (SELECT json_object('id',id,'actor_staff_id',actor_staff_id,'contract_version',contract_version,
    'authority_domain',authority_domain,'capability',capability,'effect',effect,'scope_kind',scope_kind,
    'business_area_id',business_area_id,'division_id',division_id,'target_staff_id',target_staff_id,
    'active',active,'version',version,'granted_by',granted_by)
    FROM native_staff_management_delegations WHERE id=?2) AS grant_row,
  ${TRACKED_TABLES.map(table => `(SELECT count(*) FROM ${table}) AS count_${table}`).join(',\n  ')}`;

export const APPROVER_GRANT_INSERT_SQL = `INSERT INTO native_staff_management_delegations
  (id,actor_staff_id,contract_version,authority_domain,capability,effect,scope_kind,
   business_area_id,division_id,target_staff_id,active,version,granted_by)
SELECT ?2,?1,1,'staff_admin',${CAP},'allow','global',NULL,NULL,NULL,1,1,?1
WHERE ${ELIGIBLE_ACTOR}`;

const COUNT_FIELDS = Object.freeze(['staff_exists', 'staff_active', 'owner_assignments', 'admission_active',
  'native_identity_consistent', 'actor_allow_rows', 'actor_deny_rows', 'delegation_id_rows', 'global_approvers',
  'ledger_0242', 'capability_catalog', ...TRACKED_TABLES.map(table => `count_${table}`)]);

/** The exact row the grant installs. `granted_by` is the owner: no other admitted staff takes part. */
export function expectedApproverGrantRow(staffId) {
  return Object.freeze({ id: approverGrantDelegationId(staffId), actor_staff_id: staffId, contract_version: 1,
    authority_domain: 'staff_admin', capability: APPROVER_GRANT_CAPABILITY, effect: 'allow', scope_kind: 'global',
    business_area_id: null, division_id: null, target_staff_id: null, active: 1, version: 1, granted_by: staffId });
}

/** Validates one D1 read row into counts plus the parsed grant row (or null). */
export function parseApproverGrantSnapshot(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('snapshot_invalid');
  const counts = {};
  for (const field of COUNT_FIELDS) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) fail('snapshot_invalid');
    counts[field] = row[field];
  }
  let grantRow = null;
  if (row.grant_row !== null) {
    if (typeof row.grant_row !== 'string') fail('snapshot_invalid');
    try { grantRow = JSON.parse(row.grant_row); } catch { fail('snapshot_invalid'); }
    if (!grantRow || typeof grantRow !== 'object' || Array.isArray(grantRow)) fail('snapshot_invalid');
  }
  return Object.freeze({ ...counts, grantRow });
}

/** Every reason the grant may not be written, in a fixed order. Empty means eligible. */
export function approverGrantRefusals(snapshot) {
  const refusals = [];
  if (snapshot.ledger_0242 !== 1) refusals.push('ledger_missing_0242');
  if (snapshot.capability_catalog !== 1) refusals.push('capability_not_in_catalog');
  if (snapshot.staff_exists !== 1) refusals.push('target_staff_missing');
  else if (snapshot.staff_active !== 1) refusals.push('target_staff_inactive');
  if (snapshot.owner_assignments < 1) refusals.push('target_staff_not_owner');
  if (snapshot.admission_active !== 1) refusals.push('target_native_admission_not_active');
  else if (snapshot.native_identity_consistent !== 1) refusals.push('target_native_identity_inconsistent');
  if (snapshot.actor_allow_rows !== 0) refusals.push('target_already_has_allow_row');
  if (snapshot.actor_deny_rows !== 0) refusals.push('target_has_deny_row');
  if (snapshot.delegation_id_rows !== 0) refusals.push('delegation_id_in_use');
  if (snapshot.global_approvers !== 0) refusals.push(`global_approver_count_not_zero:${snapshot.global_approvers}`);
  return refusals;
}

const publicCounts = snapshot => Object.fromEntries(COUNT_FIELDS.map(field => [field, snapshot[field]]));
const sameRow = (actual, expected) => actual !== null
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);

/** Exact post-write checks: one new row, approver count 1, only the delegation table grew by one. */
export function approverGrantPostChecks(before, after, staffId) {
  const failures = [];
  if (!sameRow(after.grantRow, expectedApproverGrantRow(staffId))) failures.push('grant_row_mismatch');
  if (after.actor_allow_rows !== 1) failures.push('actor_allow_rows_not_one');
  if (after.actor_deny_rows !== 0) failures.push('actor_deny_rows_not_zero');
  if (after.global_approvers !== 1) failures.push('global_approver_count_not_one');
  for (const table of TRACKED_TABLES) {
    const delta = after[`count_${table}`] - before[`count_${table}`];
    if (delta !== (table === 'native_staff_management_delegations' ? 1 : 0)) failures.push(`count_changed:${table}:${delta}`);
  }
  for (const field of ['staff_exists', 'staff_active', 'owner_assignments', 'admission_active', 'native_identity_consistent', 'ledger_0242']) {
    if (after[field] !== before[field]) failures.push(`precondition_changed:${field}`);
  }
  return failures;
}

/** Read-only classification of the current state, for --reconcile and after an ambiguous write. */
export function classifyApproverGrant(snapshot, staffId) {
  if (snapshot.grantRow === null && snapshot.actor_allow_rows === 0) return 'not-granted';
  if (sameRow(snapshot.grantRow, expectedApproverGrantRow(staffId)) && snapshot.actor_allow_rows === 1
    && snapshot.actor_deny_rows === 0 && snapshot.global_approvers === 1) return 'granted-exactly';
  return 'unexpected';
}

// ---------------------------------------------------------------------------
// Receipt: exclusive create, whole-file rewrite with fsync on every update. No secrets: the token is
// never passed in, and snapshots carry counts and ids only.

export function openApproverGrantReceipt(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('receipt_path_invalid');
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); } catch (error) {
    if (error?.code === 'EEXIST') fail('receipt_exists_no_replay');
    fail('receipt_create_failed');
  }
  let closed = false;
  return {
    write(value) {
      if (closed) fail('receipt_write_failed');
      try {
        const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.ftruncateSync(fd, 0);
        for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        fs.fsyncSync(fd);
      } catch { fail('receipt_write_failed'); }
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } },
  };
}

// ---------------------------------------------------------------------------
// Run

const NOT_SENT = /^ops_approver_grant_provider:(?:writes_disabled|target_not_verified|grant_already_sent_no_retry|auth_unavailable|configuration_invalid|staff_id_invalid)$/u;
const RECONCILE_NOTE = 'Do not retry. Run --reconcile (read-only) and compare with this receipt.';
const errorCode = error => (error instanceof Error && /^ops_approver_grant[a-z_]*:/u.test(error.message)) ? error.message
  : (error instanceof Error && /^production_ops_0226_runner_[a-z_]+$/u.test(error.message)) ? `ops_approver_grant:source_check_failed:${error.message}`
    : 'ops_approver_grant:unexpected_error';

/**
 * provider: { assertTarget(), read({ staffId }) -> D1 row, grant({ staffId }) -> { changes } }.
 * mode 'dry-run' and 'reconcile' never call grant.
 */
export async function runApproverGrant(options = {}) {
  const state = { sent: false };
  try { return await runGrant(options, state); } catch (error) {
    const result = state.value;
    if (!result) throw error;
    // Once the write request may have left, any later failure needs a read-only reconcile, never a retry.
    result.status = state.sent ? 'reconciliation-required' : 'refused';
    result.stop = { phase: state.sent ? 'after-write' : 'before-write', code: errorCode(error),
      ...(state.sent ? { note: RECONCILE_NOTE } : {}) };
    if (state.sent && result.writesPerformed === 0) result.writesPerformed = null;
    try { options.receipt?.write(result); } catch { result.receiptFailure = 'ops_approver_grant:receipt_write_failed'; }
    return result;
  }
}

async function runGrant({ provider, mode = 'dry-run', target, staffId, approvalRef = null,
  sourceCommit = null, receipt = null, confirm = null, log = () => {}, now = () => new Date() } = {}, tracker) {
  if (!['dry-run', 'execute', 'reconcile'].includes(mode)) fail('mode_invalid');
  if (!isApproverGrantStaffId(staffId)) fail('staff_id_invalid');
  if (!provider || typeof provider.assertTarget !== 'function' || typeof provider.read !== 'function'
    || (mode === 'execute' && typeof provider.grant !== 'function')) fail('provider_contract_invalid');
  if (mode === 'execute' && (!receipt || typeof confirm !== 'function' || !APPROVAL_REF.test(approvalRef ?? '')
    || !/^[a-f0-9]{40}$/u.test(sourceCommit ?? ''))) fail('execute_requirements_missing');
  const state = { schemaVersion: 1, contract: APPROVER_GRANT_CONTRACT, mode, status: 'started',
    target: { databaseId: target?.databaseId ?? null, databaseName: target?.databaseName ?? null },
    targetStaffId: staffId, capability: APPROVER_GRANT_CAPABILITY, delegationId: approverGrantDelegationId(staffId),
    plannedRow: expectedApproverGrantRow(staffId), approvalRef, sourceCommit, startedAt: now().toISOString(),
    preRead: null, writeCheck: null, write: null, postRead: null, reconcile: null, stop: null, writesPerformed: 0 };
  tracker.value = state;
  const save = () => { state.updatedAt = now().toISOString(); receipt?.write(state); };
  const stop = (status, phase, code, extra = {}) => {
    state.status = status; state.stop = { phase, code, ...extra }; log(`STOP (${phase}): ${code}`); save(); return state;
  };
  save();
  const verified = await provider.assertTarget();
  state.target = { databaseId: verified.databaseId, databaseName: verified.databaseName };
  const pre = parseApproverGrantSnapshot(await provider.read({ staffId }));
  state.preRead = { counts: publicCounts(pre), refusals: approverGrantRefusals(pre), classification: classifyApproverGrant(pre, staffId) };
  log(`pre-read: global approvers ${pre.global_approvers}; refusals ${state.preRead.refusals.join(', ') || 'none'}`);
  if (mode === 'reconcile') {
    state.reconcile = state.preRead.classification;
    state.status = 'reconciled';
    save();
    return state;
  }
  if (state.preRead.refusals.length) return stop('refused', 'pre-read', 'ops_approver_grant:preconditions_failed',
    { refusals: state.preRead.refusals });
  if (mode === 'dry-run') { state.status = 'dry-run-passed'; save(); return state; }

  const phrase = APPROVER_GRANT_CONFIRMATION(staffId, verified.databaseName);
  if (!await confirm(phrase)) { state.status = 'cancelled'; save(); return state; }

  // Fresh read after the confirmation: the write must rest on what is true now.
  const check = parseApproverGrantSnapshot(await provider.read({ staffId }));
  state.writeCheck = { counts: publicCounts(check), refusals: approverGrantRefusals(check) };
  if (state.writeCheck.refusals.length) return stop('refused', 'write-check', 'ops_approver_grant:preconditions_failed',
    { refusals: state.writeCheck.refusals });

  // Saved before the request: a receipt that cannot record 'sending' stops the run with nothing sent.
  state.write = { outcome: 'sending' };
  try { save(); } catch (error) { state.write = null; throw error; }
  tracker.sent = true;
  let outcome;
  try { outcome = await provider.grant({ staffId }); } catch (error) {
    const code = errorCode(error);
    if (NOT_SENT.test(error?.message ?? '')) {
      state.write = { outcome: 'not-sent', code };
      return stop('refused', 'write', code);
    }
    state.write = { outcome: 'ambiguous', code };
    state.writesPerformed = null;
    return await reconcileAfter('ops_approver_grant:write_outcome_ambiguous');
  }
  if (outcome?.changes === 0) {
    state.write = { outcome: 'guard-refused', changes: 0 };
    return stop('refused', 'write', 'ops_approver_grant:write_guard_refused_no_row_inserted');
  }
  if (outcome?.changes !== 1) {
    state.write = { outcome: 'ambiguous', changes: outcome?.changes ?? null };
    state.writesPerformed = null;
    return await reconcileAfter('ops_approver_grant:write_changes_unexpected');
  }
  state.write = { outcome: 'acknowledged', changes: 1 };
  state.writesPerformed = 1;
  save();
  const after = parseApproverGrantSnapshot(await provider.read({ staffId }));
  const failures = approverGrantPostChecks(check, after, staffId);
  state.postRead = { counts: publicCounts(after), failures, classification: classifyApproverGrant(after, staffId) };
  if (failures.length) return stop('reconciliation-required', 'post-read', 'ops_approver_grant:post_check_failed',
    { failures, note: RECONCILE_NOTE });
  state.status = 'complete';
  save();
  return state;

  async function reconcileAfter(code) {
    // One read-only look; the write itself is never sent again.
    try {
      const seen = parseApproverGrantSnapshot(await provider.read({ staffId }));
      state.reconcile = classifyApproverGrant(seen, staffId);
      state.postRead = { counts: publicCounts(seen), classification: state.reconcile };
    } catch (error) { state.reconcile = `read-failed:${errorCode(error)}`; }
    return stop('reconciliation-required', 'write', code, { note: RECONCILE_NOTE });
  }
}

// ---------------------------------------------------------------------------
// CLI

export const APPROVER_GRANT_USAGE = 'usage: node scripts/production-ops-onboarding-approver-grant-once.mjs '
  + '[--dry-run | --reconcile | --execute --approval-ref <ref> --receipt <absolute path>] '
  + '--target-staff-id <staff id> --database-id <uuid> --database-name <name> [--receipt <absolute path>]';

export function parseApproverGrantArgs(args) {
  const options = { mode: 'dry-run', staffId: null, databaseId: null, databaseName: null, receiptPath: null, approvalRef: null };
  const valueFlags = { '--target-staff-id': 'staffId', '--database-id': 'databaseId', '--database-name': 'databaseName',
    '--receipt': 'receiptPath', '--approval-ref': 'approvalRef' };
  const seen = new Set();
  let modes = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail('usage');
    seen.add(arg);
    if (['--dry-run', '--execute', '--reconcile'].includes(arg)) { modes++; options.mode = arg.slice(2); }
    else if (Object.hasOwn(valueFlags, arg)) {
      const value = args[++i];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail('usage');
      options[valueFlags[arg]] = value;
    } else fail('usage');
  }
  if (modes > 1) fail('usage');
  if (!isApproverGrantStaffId(options.staffId)) fail('target_staff_id_required');
  if (!UUID.test(options.databaseId ?? '')) fail('database_id_required');
  if (options.databaseId !== APPROVER_GRANT_TARGET.databaseId) fail('database_id_not_pinned_production');
  if (options.databaseName !== APPROVER_GRANT_TARGET.databaseName) fail('database_name_mismatch');
  if (options.receiptPath !== null && !path.isAbsolute(options.receiptPath)) fail('receipt_path_invalid');
  if (options.mode === 'execute') {
    if (options.approvalRef === null) fail('approval_ref_required');
    if (!options.receiptPath) fail('receipt_required');
  }
  if (options.approvalRef !== null && (options.mode !== 'execute' || !APPROVAL_REF.test(options.approvalRef))) fail('approval_ref_invalid');
  return Object.freeze(options);
}

export async function promptApproverGrantConfirmation(phrase, { input = process.stdin, output = process.stdout } = {}) {
  if (!input?.isTTY || !output?.isTTY) fail('interactive_confirmation_required');
  const terminal = createInterface({ input, output });
  try {
    return (await terminal.question(`Production Ops D1: insert one global allow ${APPROVER_GRANT_CAPABILITY} delegation. `
      + `Type ${phrase} to continue: `)) === phrase;
  } finally { terminal.close(); }
}

async function defaultSourceCheck() {
  const { currentMainSource } = await import('./production-ops-staff-login-0226-run.mjs');
  return currentMainSource();
}

/** CLI entry with injectable dependencies for offline tests. */
export async function mainApproverGrant(args, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const out = dependencies.out ?? (line => process.stdout.write(`${line}\n`));
  const options = parseApproverGrantArgs(args);
  const target = { accountId: APPROVER_GRANT_TARGET.accountId, databaseId: options.databaseId, databaseName: options.databaseName };
  const receipt = options.receiptPath ? openApproverGrantReceipt(options.receiptPath) : null;
  const refuse = (phase, error) => {
    const result = { schemaVersion: 1, contract: APPROVER_GRANT_CONTRACT, mode: options.mode, status: 'refused',
      target: { databaseId: target.databaseId, databaseName: target.databaseName }, targetStaffId: options.staffId,
      approvalRef: options.approvalRef, stop: { phase, code: errorCode(error) }, writesPerformed: 0, at: new Date().toISOString() };
    try { receipt?.write(result); } catch { result.receiptFailure = 'ops_approver_grant:receipt_write_failed'; }
    return result;
  };
  try {
    let sourceCommit = null;
    if (options.mode === 'execute') {
      // Checked before any remote call: a non-interactive execute costs nothing.
      const input = dependencies.stdin ?? process.stdin, output = dependencies.stdout ?? process.stdout;
      if (!dependencies.confirm && (!input?.isTTY || !output?.isTTY)) return refuse('command-line', new Error('ops_approver_grant:interactive_confirmation_required'));
      try { sourceCommit = await (dependencies.sourceCheck ?? defaultSourceCheck)(); }
      catch (error) { return refuse('source-check', errorCode(error) === 'ops_approver_grant:unexpected_error'
        ? new Error('ops_approver_grant:source_check_failed') : error); }
    }
    const token = env.CLOUDFLARE_API_TOKEN;
    if (typeof token !== 'string' || token.length < 20 || token.length > 16_384) return refuse('command-line', new Error('ops_approver_grant:cloudflare_token_missing'));
    const factory = dependencies.providerFactory
      ?? (await import('./production-ops-onboarding-approver-grant-cloudflare-provider.mjs')).createApproverGrantCloudflareProvider;
    const provider = factory({ getBearerToken: () => token, accountId: target.accountId, databaseId: target.databaseId,
      databaseName: target.databaseName, allowWrites: options.mode === 'execute',
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) });
    const confirm = dependencies.confirm ?? (phrase => promptApproverGrantConfirmation(phrase,
      { input: dependencies.stdin ?? process.stdin, output: dependencies.stdout ?? process.stdout }));
    try {
      return await runApproverGrant({ provider, mode: options.mode, target, staffId: options.staffId,
        approvalRef: options.approvalRef, sourceCommit, receipt, confirm, log: out });
    } catch (error) {
      // Only raised before the run state exists (argument or provider checks): nothing was sent.
      return refuse('run', error);
    }
  } finally { receipt?.close(); }
}

async function runCommandLine(args) {
  try {
    const result = await mainApproverGrant(args);
    process.stdout.write(`${JSON.stringify({ status: result.status, mode: result.mode, stop: result.stop ?? null,
      reconcile: result.reconcile ?? null, writesPerformed: result.writesPerformed ?? 0 })}\n`);
    if (result.receiptFailure) process.stderr.write(`${result.receiptFailure}\n`);
    process.exitCode = result.receiptFailure ? 1
      : ['complete', 'dry-run-passed', 'reconciled'].includes(result.status) ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch (error) {
    const code = errorCode(error);
    process.stderr.write(`${code}\n${code === 'ops_approver_grant:usage' ? `${APPROVER_GRANT_USAGE}\n` : ''}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = 1;
  runCommandLine(process.argv.slice(2));
}
