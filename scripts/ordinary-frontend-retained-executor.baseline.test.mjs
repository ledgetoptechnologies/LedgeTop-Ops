import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertOperationsBaselineRows, OPS_SOLE_ACTIVE_BASELINE_CONTRACT,
  selectOperationsBaselineMode } from './ordinary-frontend-retained-executor.mjs';

const ACTIVE = '1a13d939-4323-4136-85ca-8d9e3bef5f2c';
const OTHER = '844a999f-eb29-4a67-9166-5b272893c8a5';
const reviewed = Object.freeze({ operations: [
  { versionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e', percentage: 0 },
  { versionId: 'a45943f4-e5c5-4142-9057-fb9adb5cf739', percentage: 100 },
] });

test('without a selector, Operations still requires the reviewed 0/100 rows', () => {
  assert.equal(selectOperationsBaselineMode({ app: 'operations', expectedDeploymentVersions: reviewed }), 'reviewed-0-100');
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations' }), /exact reviewed 0\/100 baseline/u);
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations',
    expectedDeploymentVersions: { operations: [{ versionId: ACTIVE, percentage: 100 }] } }), /exact reviewed 0\/100 baseline/u);
});

test('the explicit selector admits a sole 100% Operations baseline', () => {
  assert.equal(OPS_SOLE_ACTIVE_BASELINE_CONTRACT, 'ops-sole-active-baseline-v1');
  assert.equal(selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT }),
    'sole-active');
});

test('the selector refuses staged weights, browser retirement, resume, promotion and unknown names', () => {
  const contract = OPS_SOLE_ACTIVE_BASELINE_CONTRACT;
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: contract,
    expectedDeploymentVersions: reviewed }), /excludes pinned staged weights/u);
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: contract,
    canonicalBrowserRetirementSelector: 'canonical-browser-retirement-v1' }), /excludes pinned staged weights/u);
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: contract,
    resumeCandidate: { candidateId: OTHER } }), /excludes pinned staged weights/u);
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: contract,
    operationsSuccessorPromotion: true }), /successor promotion requires/u);
  for (const name of ['ops-sole-active-baseline-v2', 'sole-active', '', null, true])
    assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsBaselineContract: name }),
      /Unreviewed Operations baseline contract/u);
});

test('Client releases cannot select the Operations baseline contract and are otherwise unchanged', () => {
  assert.equal(selectOperationsBaselineMode({ app: 'client' }), 'not-operations');
  assert.equal(selectOperationsBaselineMode({ app: 'client', expectedDeploymentVersions: reviewed }), 'not-operations');
  assert.throws(() => selectOperationsBaselineMode({ app: 'client', operationsBaselineContract: OPS_SOLE_ACTIVE_BASELINE_CONTRACT }),
    /Client release cannot select/u);
});

test('successor promotion keeps its existing sole-active rule', () => {
  assert.equal(selectOperationsBaselineMode({ app: 'operations', operationsSuccessorPromotion: true }), 'successor-promotion');
  assert.throws(() => selectOperationsBaselineMode({ app: 'operations', operationsSuccessorPromotion: true,
    expectedDeploymentVersions: reviewed }), /successor promotion requires/u);
});

test('captured rows must be exactly the captured version at 100% in sole-active mode', () => {
  assert.equal(assertOperationsBaselineRows('sole-active', [{ versionId: ACTIVE, percentage: 100 }], ACTIVE), true);
  assert.throws(() => assertOperationsBaselineRows('sole-active', [{ versionId: OTHER, percentage: 100 }], ACTIVE), /differs from captured/u);
  assert.throws(() => assertOperationsBaselineRows('sole-active',
    [{ versionId: ACTIVE, percentage: 100 }, { versionId: OTHER, percentage: 0 }], ACTIVE), /differs from captured/u);
  assert.throws(() => assertOperationsBaselineRows('sole-active', [{ versionId: ACTIVE, percentage: 90 }], ACTIVE), /differs from captured/u);
  assert.throws(() => assertOperationsBaselineRows('sole-active', [], ACTIVE), /differs from captured/u);
  assert.throws(() => assertOperationsBaselineRows('sole-active', undefined, ACTIVE), /differs from captured/u);
});

test('reviewed 0/100 mode keeps its existing captured-row rule', () => {
  const rows = reviewed.operations;
  assert.equal(assertOperationsBaselineRows('reviewed-0-100', rows, rows[1].versionId), true);
  assert.throws(() => assertOperationsBaselineRows('reviewed-0-100', rows, rows[0].versionId), /differs from captured/u);
  assert.throws(() => assertOperationsBaselineRows('unknown', rows, rows[1].versionId), /differs from captured/u);
  assert.equal(assertOperationsBaselineRows('not-operations', undefined, undefined), true);
});

test('the executor selects the baseline before any capture and the production entry forwards the selector', () => {
  const source = fs.readFileSync(new URL('./ordinary-frontend-retained-executor.mjs', import.meta.url), 'utf8');
  const release = source.slice(source.indexOf('export async function executeOrdinaryFrontendRetainedRelease('),
    source.indexOf('export async function executeOrdinaryFrontendRetainedProduction('));
  const select = release.indexOf('selectOperationsBaselineMode({'), firstCapture = release.indexOf('await captureFn(');
  assert.ok(select > 0 && firstCapture > select, 'baseline mode must be decided before the first provider capture');
  assert.match(release, /assertOperationsBaselineRows\(operationsBaselineMode, operationsBaselineRows, baselineVersionId\)/u);
  assert.doesNotMatch(release, /operations\.some\(row => row\.versionId === baselineVersionId/u);
  const production = source.slice(source.indexOf('export async function executeOrdinaryFrontendRetainedProduction('),
    source.indexOf('export function validateProductionAuthorityPacketSelection('));
  assert.match(production, /canonicalBrowserRetirementClientVersionId, operationsBaselineContract,[^}]*journalDirectory/u);
  assert.match(production, /canonicalBrowserRetirementClientVersionId,\s*operationsBaselineContract,[^}]*reader,/u);
});
