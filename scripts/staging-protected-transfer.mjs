import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

const SOURCE = Object.freeze({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', operationsDatabaseId: '78b34173-b168-4e3d-9832-bb9d245cc6b8', portalDatabaseId: 'b6f653ab-9acd-4421-9ad0-207754b59aeb' });
const TARGET = Object.freeze({ accountId: 'df3f376bae6ee621f50cf972ebcc9484', operationsDatabaseId: 'a58ea102-f04d-417a-bfd1-b0654cfeb503', portalDatabaseId: '15d02028-8c52-40b2-9979-d67abf7d5bbf' });
const HASH_FIELDS = ['reviewedInputSha256', 'quietWindowSha256', 'sourceSnapshotSha256', 'operationsMigrationChainSha256', 'portalMigrationChainSha256'];
const ROLES = ['operations', 'portal'];
const PREFIX = ['verify-source-fence', 'verify-target-fence', 'verify-independent-recovery-key-custody'];
const BETWEEN = ['verify-export-set-lineage-and-both-fences-again'];
const TAIL = ['verify-final-migrated-parity', 'verify-restored-schema-ledger-references-source-authority', 'ready-for-Merger-acceptance'];
const EVENTS_MAX = 256;
const PLAN_STEPS_MAX = 32;
const fail = (code) => { throw new Error(code); };
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const hash = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};
const freeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; };
function plainSnapshot(value, code='INVALID_INPUT') {
  try {
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
    const keys = Reflect.ownKeys(value), out = Object.create(null);
    if (keys.length > 16) fail(code);
    for (const k of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, k);
      if (typeof k !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code);
      Object.defineProperty(out, k, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } catch { fail(code); }
}
function arraySnapshot(value, max, code, mapItem = x => x) {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const len = lengthDescriptor?.value;
    if (!Number.isSafeInteger(len) || len < 0 || len > max || !lengthDescriptor || lengthDescriptor.enumerable || !Object.hasOwn(lengthDescriptor, 'value')) fail(code);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== len + 1) fail(code);
    const out = [];
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail(code);
      out.push(mapItem(d.value));
    }
    if (keys.some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= len))) fail(code);
    return out;
  } catch { fail(code); }
}
function exactKeys(obj, keys, code) { if (Object.keys(obj).length !== keys.length || keys.some(k => !Object.hasOwn(obj, k))) fail(code); }
function inputSnapshot(input) {
  const x = plainSnapshot(input); exactKeys(x, ['runId', ...HASH_FIELDS], 'INVALID_INPUT');
  if (typeof x.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.runId)) fail('INVALID_RUN_ID');
  for (const f of HASH_FIELDS) if (typeof x[f] !== 'string' || !/^[0-9a-f]{64}$/.test(x[f])) fail('INVALID_HASH');
  return x;
}
function stepList() {
  // The poll action is an abstract contract: a future adapter must poll the
  // same current_bookmark, never start a second export, and keep protected
  // response custody. These interfaces do not implement that adapter.
  const s = [...PREFIX];
  for (const role of ROLES) s.push(`${role}-export-start`, `${role}-export-poll-to-complete`, `${role}-persist-authenticated-encrypted-backup`, `${role}-independent-recovery-check`);
  s.push(...BETWEEN);
  for (const role of ROLES) s.push(`${role}-validate-reviewed-import-plan`);
  for (const role of ROLES) s.push(`${role}-fresh-import-fence`, `${role}-import`);
  s.push('verify-restored-baseline-parity');
  for (const role of ROLES) s.push(`${role}-fresh-migration-fence`, `${role}-migrate-reviewed-chain`);
  return [...s, ...TAIL];
}
function makePlan(meta) {
  const names = stepList();
  const namespace = hash({ schema: 'protected-transfer-plan/v1', metadata: meta, source: SOURCE, target: TARGET, stepNames: names });
  const steps = names.map((name, index) => ({ name, actionId: `a-${hash({ namespace, index, name }).slice(0, 32)}` }));
  const p = { schema: 'protected-transfer-plan/v1', implementation: 'review-only', providerOperationsEnabled: false, metadata: meta, source: SOURCE, target: TARGET, steps };
  p.planSha256 = hash(p);
  return freeze(p);
}
export function compileProtectedTransferPlan(input) {
  const meta = inputSnapshot(input);
  return makePlan(meta);
}
function validatePlan(plan) {
  try {
  const p = plainSnapshot(plan, 'INVALID_PLAN');
  exactKeys(p, ['schema','implementation','providerOperationsEnabled','metadata','source','target','steps','planSha256'], 'INVALID_PLAN');
  const meta = plainSnapshot(p.metadata, 'INVALID_PLAN');
  p.metadata = meta;
  p.source = plainSnapshot(p.source, 'INVALID_PLAN');
  p.target = plainSnapshot(p.target, 'INVALID_PLAN');
  p.steps = arraySnapshot(p.steps, PLAN_STEPS_MAX, 'INVALID_PLAN', s => plainSnapshot(s, 'INVALID_PLAN'));
  exactKeys(meta, ['runId', ...HASH_FIELDS], 'INVALID_PLAN');
  exactKeys(p.source, ['accountId','operationsDatabaseId','portalDatabaseId'], 'INVALID_PLAN');
  exactKeys(p.target, ['accountId','operationsDatabaseId','portalDatabaseId'], 'INVALID_PLAN');
  if (p.schema !== 'protected-transfer-plan/v1' || p.implementation !== 'review-only' || p.providerOperationsEnabled !== false || !isHash(p.planSha256)) fail('INVALID_PLAN');
  for (const k of ['accountId','operationsDatabaseId','portalDatabaseId']) if (p.source[k] !== SOURCE[k] || p.target[k] !== TARGET[k]) fail('INVALID_PLAN');
  let expected;
  try { expected = makePlan(inputSnapshot(meta)); } catch { fail('INVALID_PLAN'); }
  if (p.steps.length !== expected.steps.length) fail('INVALID_PLAN');
  for (let i=0; i<p.steps.length; i++) {
    exactKeys(p.steps[i], ['name','actionId'], 'INVALID_PLAN');
    if (p.steps[i].name !== expected.steps[i].name || p.steps[i].actionId !== expected.steps[i].actionId) fail('INVALID_PLAN');
  }
  if (canonical(p) !== canonical(expected)) fail('INVALID_PLAN');
  return expected;
  } catch { fail('INVALID_PLAN'); }
}
export function backupBindingForTransferPlan(plan, role) {
  const p = validatePlan(plan);
  if (role !== 'operations' && role !== 'portal') fail('INVALID_ROLE');
  const databaseField = role === 'operations' ? 'operationsDatabaseId' : 'portalDatabaseId';
  const chainField = role === 'operations' ? 'operationsMigrationChainSha256' : 'portalMigrationChainSha256';
  return freeze({ role, runId: p.metadata.runId, sourceAccountId: p.source.accountId,
    targetAccountId: p.target.accountId, sourceDatabaseId: p.source[databaseField],
    targetDatabaseId: p.target[databaseField], migrationChainSha256: p.metadata[chainField],
    sourceSnapshotSha256: p.metadata.sourceSnapshotSha256 });
}
export function createTransferJournal(plan) {
  // This returned value is advisory in-memory state. It is not durable
  // authority; production use requires separate append-only CAS custody and
  // proofs. Multi-request inner-journal handling remains pending design.
  const p = validatePlan(plan);
  return freeze({ schema: 'protected-transfer-journal/v1', planSha256: p.planSha256, events: [] });
}
function replay(plan, journal) {
  const p = validatePlan(plan), j = plainSnapshot(journal, 'INVALID_JOURNAL');
  exactKeys(j, ['schema','planSha256','events'], 'INVALID_JOURNAL');
  if (j.schema !== 'protected-transfer-journal/v1' || j.planSha256 !== p.planSha256) fail('INVALID_JOURNAL');
  j.events = arraySnapshot(j.events, EVENTS_MAX, 'INVALID_JOURNAL', raw => plainSnapshot(raw, 'INVALID_JOURNAL_EVENT'));
  let started = false, unknown = false, stopped = false, complete = false, next = 0, revision = 0;
  let lastConfirmedReceiptSha256 = null;
  for (const raw of j.events) {
    const e = raw;
    const type = e.type;
    if (type === 'begin') {
      const requiresControl = /-(?:import|migrate-reviewed-chain)$/.test(p.steps[next]?.name ?? '');
      exactKeys(e, ['type','actionId','expectedRevision', ...(requiresControl ? ['controlReceiptSha256'] : [])], 'INVALID_JOURNAL_EVENT');
      if (stopped || complete || started || unknown || e.expectedRevision !== revision || e.actionId !== p.steps[next]?.actionId) fail('INVALID_EVENT_ORDER');
      if (requiresControl && (!isHash(e.controlReceiptSha256) || e.controlReceiptSha256 !== lastConfirmedReceiptSha256)) fail('CONTROL_RECEIPT_MISMATCH');
      started = true;
    } else if (type === 'confirm' || type === 'unknown' || type === 'fail') {
      exactKeys(e, ['type','actionId','expectedRevision','receiptSha256'], 'INVALID_JOURNAL_EVENT');
      if (!started || e.expectedRevision !== revision || e.actionId !== p.steps[next]?.actionId || !isHash(e.receiptSha256)) fail('INVALID_EVENT_ORDER');
      started = false;
      if (type === 'confirm') { lastConfirmedReceiptSha256 = e.receiptSha256; next++; if (next === p.steps.length) complete = true; }
      if (type === 'unknown') unknown = true;
      if (type === 'fail') stopped = true;
    } else if (type === 'reconcile') {
      exactKeys(e, ['type','actionId','expectedRevision','receiptSha256','disposition'], 'INVALID_JOURNAL_EVENT');
      if (!unknown || e.expectedRevision !== revision || e.actionId !== p.steps[next]?.actionId || !isHash(e.receiptSha256) || !['confirmed','not_performed','unresolved'].includes(e.disposition)) fail('INVALID_EVENT_ORDER');
      unknown = false;
      if (e.disposition === 'confirmed') { lastConfirmedReceiptSha256 = e.receiptSha256; next++; if (next === p.steps.length) complete = true; }
      if (e.disposition === 'not_performed') stopped = true;
      if (e.disposition === 'unresolved') unknown = true;
    } else fail('INVALID_EVENT_TYPE');
    revision++;
  }
  return { p, j, started, unknown, stopped, complete, next, revision };
}
export function summarizeTransferJournal(plan, journal) {
  const r = replay(plan, journal);
  return freeze({ state: r.complete ? 'ready-for-merger-acceptance' : r.stopped ? 'stopped' : r.unknown ? 'needs-reconciliation' : r.started ? 'in-progress' : 'ready', nextActionId: r.stopped || r.complete ? null : r.p.steps[r.next]?.actionId ?? null, revision: r.revision, eventCount: r.j.events.length, planSha256: r.p.planSha256 });
}
export function appendTransferJournalEvent(plan, journal, event) {
  const r = replay(plan, journal), e = plainSnapshot(event, 'INVALID_JOURNAL_EVENT');
  if (r.j.events.length >= EVENTS_MAX) fail('EVENT_LIMIT');
  if (e.expectedRevision !== r.revision) fail('REVISION_CONFLICT');
  const ev = [...r.j.events, e];
  const out = { schema: r.j.schema, planSha256: r.j.planSha256, events: ev };
  replay(plan, out);
  return freeze(out);
}
export async function executeProtectedTransferPlan() {
  fail('TRANSFER_EXECUTION_DISABLED');
}
