import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executeOrdinaryFrontendRetainedRelease, validateAssetVerificationConcurrency } from './ordinary-frontend-retained-executor.mjs';

test('asset verification concurrency is an explicit option from 1 to 3, default 1', () => {
  assert.equal(validateAssetVerificationConcurrency(undefined), 1);
  for (const n of [1, 2, 3]) assert.equal(validateAssetVerificationConcurrency(n), n);
  for (const bad of [0, 4, 1.5, '3', null, -1, Infinity])
    assert.throws(() => validateAssetVerificationConcurrency(bad), /Asset verification concurrency/u);
});

test('an invalid concurrency is refused before anything else in the release', async () => {
  await assert.rejects(executeOrdinaryFrontendRetainedRelease({ assetVerificationConcurrency: 4 }), /Asset verification concurrency/u);
});

test('every verifier pass uses the selected concurrency and the production entry forwards it', () => {
  const source = fs.readFileSync(new URL('./ordinary-frontend-retained-executor.mjs', import.meta.url), 'utf8');
  const release = source.slice(source.indexOf('export async function executeOrdinaryFrontendRetainedRelease('),
    source.indexOf('export async function executeOrdinaryFrontendRetainedProduction('));
  const passes = [...release.matchAll(/await verifyVersionAssets\(\{[^}]*\}\)/gsu)].map(m => m[0]);
  assert.equal(passes.length, 3);
  for (const pass of passes) assert.match(pass, /concurrency: assetVerificationConcurrency/u);
  const production = source.slice(source.indexOf('export async function executeOrdinaryFrontendRetainedProduction('),
    source.indexOf('export function validateProductionAuthorityPacketSelection('));
  assert.match(production, /assetVerificationConcurrency/u);
  assert.match(production, /executeOrdinaryFrontendRetainedRelease\(\{[^]*assetVerificationConcurrency[^]*\}\)/u);
});
