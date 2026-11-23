import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonical, hash, PROFILE, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
  validateInstallation } from './production-deploy.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { createHeldOpsSyncCompanionWitness, assertHeldOpsSyncCompanion } from './ops-sync-companion-witness.mjs';

const identities = {
  sourceCommit:'52d5a57d74814c821d8de39854b6a2a86b25ecab',
  accountId:NATIVE_STAFF_PRODUCTION_TARGET.accountId,
};
const opsId = '844a999f-eb29-4a67-9166-5b272893c8a5';
const syncActive = '6f8e224c-4202-4904-9de5-b78886b52e74';
const syncLatest = 'bc65f489-e8dd-4ef8-8411-abca3b3ef464';
const rejected = /Exact held Ops Sync companion evidence refused/u;

test('deployed witness rejects caller-made receipts and nonmatching evidence', () => {
  assert.throws(() => createHeldOpsSyncCompanionWitness({...identities,
    heldJournalBytes:Buffer.from('forged receipt'), immutableMapEvidenceBytes:Buffer.from('forged map')}),rejected);
  assert.throws(() => assertHeldOpsSyncCompanion(Object.freeze({}),{}),rejected);
  assert.throws(() => validateInstallation({}, {profile:PROFILE, selectedApp:'client',
    heldOpsSyncCompanionWitness:{}, ordinaryFrontendApp:'client',
    ordinaryFrontendPreflightMode:ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE}),
  /limited to canonical Operations release/u);
});

test('state-pinned witness detects companion mutations without exposing private fixture bytes', async () => {
  const snapshot = {
    operations:{deployment:{id:'c85dd11b-429e-4237-863e-ac1e06bb53e0'},version:{id:opsId},modern:{id:opsId}},
    'ops-sync':{
      deployment:{id:'d16949c4-d637-4b9b-8f6d-e21cc303e795',
        versions:[{version_id:syncActive,percentage:100}]},
      latest:syncLatest,
      version:{id:syncActive,resources:{script:{last_deployed_from:'wrangler'}}},
      latestVersion:{id:syncLatest,resources:{script:{last_deployed_from:'api'}}},
      modern:{id:syncActive,assets:null},latestModern:{id:syncLatest,assets:null},
      settings:{marker:'synthetic'},schedules:[],
    },
  };
  const heldJournalBytes = Buffer.from('synthetic held journal');
  const immutableMapEvidenceBytes = Buffer.from('synthetic immutable map evidence');
  // Load a test-only copy with synthetic pins. The production module never
  // accepts configurable pins, test environment switches, or injected proofs.
  let source = readFileSync(new URL('./ops-sync-companion-witness.mjs',import.meta.url),'utf8');
  source = source.replace(/from '\.\/([^']+)'/gu, (_,name) => `from '${new URL(name,import.meta.url).href}'`);
  const replacePin = (match,digest) => {
    assert.match(source,match);
    source = source.replace(match,(_,prefix) => `${prefix}'${digest}'`);
  };
  replacePin(/(const HELD_JOURNAL = )'[a-f0-9]{64}'/u,hash(heldJournalBytes));
  replacePin(/(const IMMUTABLE_MAP_EVIDENCE = )'[a-f0-9]{64}'/u,hash(immutableMapEvidenceBytes));
  for (const [key,value] of Object.entries(snapshot['ops-sync'])) {
    if (key !== 'latest') replacePin(new RegExp(`(\\b${key}:)'[a-f0-9]{64}'`,'u'),hash(canonical(value)));
  }
  const synthetic = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const witness = synthetic.createHeldOpsSyncCompanionWitness({...identities,snapshot,heldJournalBytes,immutableMapEvidenceBytes});
  assert.doesNotThrow(() => synthetic.assertHeldOpsSyncCompanion(witness,snapshot));
  assert.throws(() => assertHeldOpsSyncCompanion(witness,snapshot),rejected);
  assert.throws(() => synthetic.heldOpsSyncCompanionReceipt(witness,'0'.repeat(40)),rejected);
  const drift = [
    state=>{state.deployment.versions[0].percentage=0;},
    state=>{state.latest=syncActive;},
    state=>{state.latestVersion.resources.script.last_deployed_from='wrangler';},
    state=>{state.latestModern.assets={config:{}};},
    state=>{state.modern.module='changed';},
    state=>{state.schedules.push('changed');},
    state=>{state.settings.marker='changed';},
    state=>{state.extra=true;},
  ];
  for (const mutate of drift) {
    const changed = structuredClone(snapshot);
    mutate(changed['ops-sync']);
    assert.throws(() => synthetic.assertHeldOpsSyncCompanion(witness,changed),rejected);
  }
});
