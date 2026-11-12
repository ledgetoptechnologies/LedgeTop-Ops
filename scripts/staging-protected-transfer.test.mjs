import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { openStagingBackup, sealStagingBackup } from './staging-backup-envelope.mjs';
import { appendTransferJournalEvent, backupBindingForTransferPlan, compileProtectedTransferPlan, createTransferJournal, executeProtectedTransferPlan, summarizeTransferJournal } from './staging-protected-transfer.mjs';

const H = 'a'.repeat(64);
const input = (runId='11111111-1111-4111-8111-111111111111') => ({ runId, reviewedInputSha256:H, quietWindowSha256:H, sourceSnapshotSha256:H, operationsMigrationChainSha256:H, portalMigrationChainSha256:H });
const setup = () => { const plan = compileProtectedTransferPlan(input()); return { plan, journal:createTransferJournal(plan) }; };
const event = (type, actionId, expectedRevision, extra={}) => ({ type, actionId, expectedRevision, ...extra });
const receipt = { receiptSha256:H };
const append = (x, e) => { x.journal = appendTransferJournalEvent(x.plan, x.journal, e); };

test('fixed offline plan carries ordered fences, recovery checks, exports and migrations', () => {
  const p = compileProtectedTransferPlan(input());
  assert.equal(p.providerOperationsEnabled, false);
  assert.equal(p.implementation, 'review-only');
  assert.equal(p.source.accountId, '846c924bf17bf4f3dd15c97a4c5d1d51');
  assert.equal(p.target.accountId, 'df3f376bae6ee621f50cf972ebcc9484');
  const names = p.steps.map(s=>s.name);
  assert.deepEqual(names.slice(0,3), ['verify-source-fence','verify-target-fence','verify-independent-recovery-key-custody']);
  assert(names.indexOf('verify-export-set-lineage-and-both-fences-again') > names.indexOf('portal-independent-recovery-check'));
  assert(names.includes('operations-export-poll-to-complete') && names.includes('portal-migrate-reviewed-chain'));
  assert(names.indexOf('operations-validate-reviewed-import-plan') < names.indexOf('operations-import'));
  assert(names.indexOf('portal-validate-reviewed-import-plan') < names.indexOf('operations-import'));
  assert(names.indexOf('portal-import') < names.indexOf('verify-restored-baseline-parity'));
  assert(names.indexOf('verify-restored-baseline-parity') < names.indexOf('operations-migrate-reviewed-chain'));
  assert(names.indexOf('portal-migrate-reviewed-chain') < names.indexOf('verify-final-migrated-parity'));
  assert.deepEqual(compileProtectedTransferPlan(input()), p);
  assert.notDeepEqual(compileProtectedTransferPlan({...input(), sourceSnapshotSha256:'b'.repeat(64)}).steps.map(s=>s.actionId), p.steps.map(s=>s.actionId));
  assert(Object.isFrozen(p) && Object.isFrozen(p.steps));
  assert.equal(JSON.stringify(p).match(/actionId/g).length, p.steps.length);
  assert.equal(JSON.stringify(p).includes('https://'), false);
});

test('normal ordered journal flow validates transitions and revisions', () => {
  const x=setup();
  for (const s of x.plan.steps) {
    const rev=summarizeTransferJournal(x.plan,x.journal).revision;
    append(x,event('begin',s.actionId,rev,/-(?:import|migrate-reviewed-chain)$/.test(s.name) ? {controlReceiptSha256:H} : {}));
    append(x,event('confirm',s.actionId,rev+1,receipt));
  }
  assert.equal(summarizeTransferJournal(x.plan,x.journal).state,'ready-for-merger-acceptance');
});

test('every import and migration immediately follows a role-specific fence and links its receipt', () => {
  const x = setup();
  for (const role of ['operations', 'portal']) for (const [name, fence] of [
    [`${role}-import`, `${role}-fresh-import-fence`],
    [`${role}-migrate-reviewed-chain`, `${role}-fresh-migration-fence`],
  ]) {
    const index = x.plan.steps.findIndex(step => step.name === name);
    assert.equal(x.plan.steps[index - 1].name, fence);
  }
  for (const step of x.plan.steps) {
    const rev = summarizeTransferJournal(x.plan, x.journal).revision;
    if (step.name === 'operations-import') {
      assert.throws(() => appendTransferJournalEvent(x.plan, x.journal,
        event('begin', step.actionId, rev)), /INVALID_JOURNAL_EVENT/);
      assert.throws(() => appendTransferJournalEvent(x.plan, x.journal,
        event('begin', step.actionId, rev, { controlReceiptSha256: 'b'.repeat(64) })), /CONTROL_RECEIPT_MISMATCH/);
      append(x, event('begin', step.actionId, rev, { controlReceiptSha256: H }));
      assert.equal(summarizeTransferJournal(x.plan, x.journal).state, 'in-progress');
      break;
    }
    append(x, event('begin', step.actionId, rev));
    append(x, event('confirm', step.actionId, rev + 1, receipt));
  }
});

test('unknown outcome blocks retries and advances only after confirmed reconciliation', () => {
  const x=setup(), id=x.plan.steps[0].actionId;
  append(x,event('begin',id,0)); append(x,event('unknown',id,1,receipt));
  assert.equal(summarizeTransferJournal(x.plan,x.journal).state,'needs-reconciliation');
  assert.throws(()=>appendTransferJournalEvent(x.plan,x.journal,event('begin',id,2)),/INVALID_EVENT_ORDER/);
  append(x,event('reconcile',id,2,{...receipt,disposition:'confirmed'}));
  assert.equal(summarizeTransferJournal(x.plan,x.journal).nextActionId,x.plan.steps[1].actionId);
});

test('unresolved remains blocked; not-performed is terminal and never auto-replays', () => {
  for (const disposition of ['unresolved','not_performed']) {
    const x=setup(), id=x.plan.steps[0].actionId;
    append(x,event('begin',id,0)); append(x,event('unknown',id,1,receipt));
    append(x,event('reconcile',id,2,{...receipt,disposition}));
    assert.equal(summarizeTransferJournal(x.plan,x.journal).state, disposition==='unresolved'?'needs-reconciliation':'stopped');
    assert.throws(()=>appendTransferJournalEvent(x.plan,x.journal,event('begin',id,3)),/INVALID_EVENT_ORDER/);
  }
});

test('rejects stale revisions, wrong order, wrong action, and arbitrary plan shape', () => {
  const x=setup(), id=x.plan.steps[0].actionId;
  assert.throws(()=>appendTransferJournalEvent(x.plan,x.journal,event('begin',id,1)),/REVISION_CONFLICT/);
  assert.throws(()=>appendTransferJournalEvent(x.plan,x.journal,event('begin','a-wrong',0)),/INVALID_EVENT_ORDER/);
  const forged={...x.plan,steps:[...x.plan.steps,{name:'delete',actionId:'a-forged'}]};
  assert.throws(()=>createTransferJournal(forged),/INVALID_PLAN/);
});

test('rejects malformed inputs, hashes, accessors, proxies and oversized histories with fixed codes', () => {
  assert.throws(()=>compileProtectedTransferPlan({...input(),extra:true}),/INVALID_INPUT/);
  assert.throws(()=>compileProtectedTransferPlan({...input(),quietWindowSha256:'A'.repeat(64)}),/INVALID_HASH/);
  assert.throws(()=>compileProtectedTransferPlan({...input(),runId:'ABCDEFAB-1111-4111-8111-111111111111'}),/INVALID_RUN_ID/);
  const accessor=input(); Object.defineProperty(accessor,'runId',{enumerable:true,get(){throw Error('sensitive');}});
  assert.throws(()=>compileProtectedTransferPlan(accessor),/^Error: INVALID_INPUT$/);
  const proxy=new Proxy({}, { ownKeys(){throw Error('secret'); }});
  assert.throws(()=>compileProtectedTransferPlan(proxy),/^Error: INVALID_INPUT$/);
  const poisoned=Object.create(null); for (const [k,v] of Object.entries(input())) Object.defineProperty(poisoned,k,{value:v,enumerable:true}); Object.defineProperty(poisoned,'__proto__',{value:'x',enumerable:true});
  assert.throws(()=>compileProtectedTransferPlan(poisoned),/^Error: INVALID_INPUT$/);
  const x=setup();
  const huge={...x.journal,events:Array(257).fill({})};
  assert.throws(()=>summarizeTransferJournal(x.plan,huge),/INVALID_JOURNAL/);
  const customMap=[...x.plan.steps]; customMap.map=()=>{throw new Error('untrusted map');};
  assert.throws(()=>createTransferJournal({...x.plan,steps:customMap}),/^Error: INVALID_PLAN$/);
  const getterSteps=[...x.plan.steps]; Object.defineProperty(getterSteps,'0',{get(){throw new Error('index getter');},enumerable:true});
  assert.throws(()=>createTransferJournal({...x.plan,steps:getterSteps}),/^Error: INVALID_PLAN$/);
  assert.throws(()=>createTransferJournal({...x.plan,steps:new Array(1_000_000)}),/^Error: INVALID_PLAN$/);
  assert.throws(()=>createTransferJournal({...x.plan,steps:Array(33).fill(x.plan.steps[0])}),/^Error: INVALID_PLAN$/);
  assert.throws(()=>createTransferJournal({...x.plan,source:{...x.plan.source,accountId:'a'.repeat(1_000_000)}}),/^Error: INVALID_PLAN$/);
  const sparse=[...x.plan.steps]; delete sparse[0];
  assert.throws(()=>createTransferJournal({...x.plan,steps:sparse}),/^Error: INVALID_PLAN$/);
  assert.throws(()=>createTransferJournal({...x.plan,source:{...x.plan.source,unexpected:{deep:true}}}),/^Error: INVALID_PLAN$/);
  const customEvents=[]; customEvents.map=()=>{throw new Error('untrusted map');};
  assert.throws(()=>summarizeTransferJournal(x.plan,{...x.journal,events:customEvents}),/^Error: INVALID_JOURNAL$/);
  const sparseEvents=Array(1);
  assert.throws(()=>summarizeTransferJournal(x.plan,{...x.journal,events:sparseEvents}),/^Error: INVALID_JOURNAL$/);
});

test('execution always rejects before inspecting malicious arguments', async () => {
  let touched=false;
  const malicious=new Proxy({}, { get(){touched=true; throw new Error('must not inspect');}, ownKeys(){touched=true;throw new Error('must not inspect');} });
  await assert.rejects(executeProtectedTransferPlan(malicious),/TRANSFER_EXECUTION_DISABLED/);
  assert.equal(touched,false);
});

test('ambiguous actions cannot be confirmed or bypassed with the next step', () => {
  const x = setup(), id = x.plan.steps[0].actionId;
  append(x, event('begin', id, 0)); append(x, event('unknown', id, 1, receipt));
  assert.throws(() => appendTransferJournalEvent(x.plan, x.journal, event('confirm', id, 2, receipt)), /INVALID_EVENT_ORDER/);
  assert.throws(() => appendTransferJournalEvent(x.plan, x.journal, event('begin', x.plan.steps[1].actionId, 2)), /INVALID_EVENT_ORDER/);
  assert.equal(summarizeTransferJournal(x.plan, x.journal).state, 'needs-reconciliation');
});

test('a known failure is terminal and the valid history limit cannot be exceeded', () => {
  const failed = setup(), id = failed.plan.steps[0].actionId;
  append(failed, event('begin', id, 0)); append(failed, event('fail', id, 1, receipt));
  assert.equal(summarizeTransferJournal(failed.plan, failed.journal).nextActionId, null);
  assert.throws(() => appendTransferJournalEvent(failed.plan, failed.journal, event('begin', id, 2)), /INVALID_EVENT_ORDER/);
  const unknown = setup();
  append(unknown, event('begin', id, 0)); append(unknown, event('unknown', id, 1, receipt));
  for (let revision = 2; revision < 256; revision++) append(unknown,
    event('reconcile', id, revision, { ...receipt, disposition: 'unresolved' }));
  assert.equal(summarizeTransferJournal(unknown.plan, unknown.journal).eventCount, 256);
  assert.throws(() => appendTransferJournalEvent(unknown.plan, unknown.journal,
    event('reconcile', id, 256, { ...receipt, disposition: 'unresolved' })), /EVENT_LIMIT/);
});

test('compiled role bindings interoperate with authenticated envelopes and reject another plan', async () => {
  const p = compileProtectedTransferPlan(input());
  const changed = compileProtectedTransferPlan({ ...input(), sourceSnapshotSha256: 'b'.repeat(64) });
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const bytes = new TextEncoder().encode('synthetic transfer interface payload');
  for (const role of ['operations', 'portal']) {
    const binding = backupBindingForTransferPlan(p, role);
    const envelope = await sealStagingBackup(bytes, key, binding, 'backup-key-v1');
    assert.deepEqual(await openStagingBackup(envelope, key, binding, 'backup-key-v1'), bytes);
    await assert.rejects(openStagingBackup(envelope, key, backupBindingForTransferPlan(changed, role), 'backup-key-v1'), /BINDING_MISMATCH/);
  }
  assert.throws(() => backupBindingForTransferPlan(p, '__proto__'), /^Error: INVALID_ROLE$/);
});
