import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRecoverExistingResult, recoverExistingResult } from '../workspace-ingest-recovery.mjs';

const eligible = () => ({ recovery: { kind: 'ingest', available: true, remainingRequests: 1 } });
function memoryStorage() { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) }; }

test('existing result recovery requires fresh server eligibility and current write permission', () => {
  assert.equal(canRecoverExistingResult(eligible(), true), true);
  for (const diagnostic of [null, {}, { recovery: { kind: 'ingest', available: false } },
    { recovery: { kind: 'other', available: true } }, { ...eligible(), loading: true },
    { ...eligible(), error: 'unavailable' }]) assert.equal(canRecoverExistingResult(diagnostic, true), false);
  assert.equal(canRecoverExistingResult(eligible(), false), false);
});

test('concurrent activation issues one same-attempt request and invalidates stale eligibility', async () => {
  const calls = [], storage = memoryStorage(), diagnostic = eligible(); let resolve, refreshed=0;
  const mutate = (...args) => { calls.push(args); return new Promise(r => { resolve=r; }); };
  const options={storage,makeId:()=> 'intent-1'};
  const first = recoverExistingResult(diagnostic,true,'attempt/one',mutate,()=>{refreshed++;},options);
  assert.equal(canRecoverExistingResult(diagnostic,true),false);
  await recoverExistingResult(eligible(),true,'attempt/one',mutate,()=>{},options);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],['/api/v1/attempts/attempt%2Fone/recover-ingest',
    {method:'POST',body:{},headers:{'Idempotency-Key':'intent-1'}},'Existing result recovery queued']);
  resolve({accepted:true}); assert.deepEqual(await first,{accepted:true}); assert.equal(refreshed,1);
  assert.equal(storage.getItem('ltds-viewer-ingest-recovery:attempt/one'),null);
});

test('uncertain response refreshes diagnostics and reuses identity after page-like reload', async () => {
  const storage=memoryStorage(),keys=[],first=eligible();let refreshed=0;
  const options={storage,makeId:()=> 'intent-original'};
  await recoverExistingResult(first,true,'attempt',async (_path,options)=>{keys.push(options.headers['Idempotency-Key']);return undefined;},()=>{refreshed++;},options);
  assert.equal(canRecoverExistingResult(first,true),false);assert.equal(refreshed,1);
  const fresh=eligible();await recoverExistingResult(fresh,true,'attempt',async (_path,options)=>{keys.push(options.headers['Idempotency-Key']);return {accepted:true};},()=>{refreshed++;},{storage,makeId:()=> 'wrong-new-key'});
  assert.deepEqual(keys,['intent-original','intent-original']);assert.equal(refreshed,2);
});

test('thrown transport failure retains identity and refreshes without reusing stale eligibility', async () => {
  const storage=memoryStorage(), diagnostic=eligible(); let refreshed=0;
  await assert.rejects(recoverExistingResult(diagnostic,true,'attempt-throw',async()=>{throw Error('transport');},()=>{refreshed++;},{storage,makeId:()=> 'saved-intent'}),/transport/);
  assert.equal(refreshed,1);assert.equal(canRecoverExistingResult(diagnostic,true),false);
  assert.equal(storage.getItem('ltds-viewer-ingest-recovery:attempt-throw'),'saved-intent');
});

test('lost permission, unavailable storage and stale diagnostics do not send a request', async () => {
  let calls=0; const mutate=()=>{calls++;}, refresh=()=>{};
  const broken={getItem(){throw Error('denied');}};
  await recoverExistingResult(eligible(),false,'attempt',mutate,refresh,{storage:memoryStorage(),makeId:()=> 'x'});
  await recoverExistingResult(eligible(),true,'attempt',mutate,refresh,{storage:broken,makeId:()=> 'x'});
  await recoverExistingResult({loading:true,...{recovery:eligible().recovery}},true,'attempt',mutate,refresh,{storage:memoryStorage(),makeId:()=> 'x'});
  assert.equal(calls,0);
});

test('workspace uses server diagnostics and the ordinary authenticated API helper', () => {
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  assert.match(source,/canRecoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\)\)/);
  assert.match(source,/recoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\),id,mutate,/);
  assert.match(source,/delete detail\.attemptDiagnostics\[id\]/);assert.match(source,/loadTaskAttemptDiagnostics\(taskId,id\)/);
  assert.match(source,/delete state\.diagnosticDetails\[id\]/);assert.match(source,/loadGlobalAttemptDiagnostics\(id\)/);
  assert.match(source,/detail\.attemptDiagnostics\?\.\[attemptId\]!==pending/);assert.match(source,/state\.diagnosticDetails\[attemptId\]!==pending/);
  const api=source.split(/\r?\n/).find(line=>line.startsWith('async function api('));
  assert.match(api,/Authorization:`Bearer \$\{state\.token\}`/);assert.match(api,/!init\.headers\['Idempotency-Key'\]/);
});
