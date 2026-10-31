import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileOrdinaryFrontendReleasePlan, validateOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
import { compileOrdinaryFrontendRetainedPlan, validateOrdinaryFrontendRetainedPlan } from './ordinary-frontend-retained-plan.mjs';
import { hash, ORDINARY_FRONTEND_PREFLIGHT_MODE, OPS_SUCCESSOR_READER_INSTALLED_CONTRACT } from './production-deploy.mjs';

const fixturePath = process.env.LEDGETOP_ORDINARY_FRONTEND_EXECUTOR_PRIVATE_FIXTURE;
const versionPath = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_VERSION_READBACK;
const modernPath = process.env.LEDGETOP_ORDINARY_FRONTEND_SUCCESSOR_MODERN_READBACK;
const retainedAssetRoot = process.env.LEDGETOP_ORDINARY_FRONTEND_CLIENT_ASSET_ROOT
  ?? 'C:/Users/fstor/.codex/artifacts/ui-retained-packets-b0c99cdd-20261028-v3/client-packet/assets';
const candidateId = 'fc9bc572-0b87-4857-8b8a-b0e0f7582c68';
const clone = value => structuredClone(value);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('Client offline compile and retained-plan revalidation recognize only the exact installed Ops candidate', {
  skip: !fixturePath || !versionPath || !modernPath,
}, t => {
  const fixture = readJson(fixturePath), profile = fixture.profile;
  const snapshot = clone(fixture.snapshot);
  const opsVersion = readJson(versionPath), opsModern = readJson(modernPath);
  assert.equal(opsVersion.id, candidateId); assert.equal(opsModern.id, candidateId);
  const opsMain = opsModern.modules.find(row => row.name === 'index.js');
  assert.equal(hash(Buffer.from(opsMain.content_base64, 'base64')),
    'f4cdefd633441df8db18cc5c0b192fc8faa72ebd7b1db730122bd77318164e68');
  snapshot.operations.version = opsVersion; snapshot.operations.modern = opsModern;
  snapshot.operations.latest = candidateId;
  snapshot.operations.deployment.versions = [{ version_id: candidateId, percentage: 100 }];
  delete snapshot.operations.latestVersion; delete snapshot.operations.latestModern;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-ops-successor-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets'); fs.mkdirSync(path.join(assets, 'assets'), { recursive: true });
  const assetRoot = fs.realpathSync(retainedAssetRoot);
  const publicFiles = {
    'index.html': '<!doctype html><script type="module" src="/assets/index-reviewed.js"></script>',
    'assets/index-reviewed.js': 'export const ui = "reviewed-client";',
    'favicon.svg': fs.readFileSync(path.join(assetRoot, 'favicon.svg')),
    'apple-touch-icon.png': fs.readFileSync(path.join(assetRoot, 'apple-touch-icon.png')),
  };
  for (const [name, bytes] of Object.entries(publicFiles)) fs.writeFileSync(path.join(assets, name), bytes);
  fs.writeFileSync(path.join(assets, '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  const main = path.join(root, 'index.js'), sourceMap = `${main}.map`;
  fs.writeFileSync(main, 'export default {fetch(){return new Response("client")}};');
  fs.writeFileSync(sourceMap, JSON.stringify({ version: 3, file: 'index.js', sources: ['client.ts'],
    sourcesContent: ['export const client = true;'], names: [], mappings: '' }));
  const pin = file => { const bytes = fs.readFileSync(file); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
  const release = { schemaVersion: 1, application: 'client', sourceCommit: 'c'.repeat(40),
    frontendSHA256: hash('synthetic-reviewed-client-frontend'), main: pin(main), sourceMap: pin(sourceMap),
    assets: { directory: assets, files: Object.entries(publicFiles).map(([name, body]) => ({ path: `/${name}`,
      size: Buffer.byteLength(body), sha256: hash(body) })).sort((a, b) => a.path.localeCompare(b.path)) } };
  const options = { app: 'client', release, profile, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT };

  assert.throws(() => compileOrdinaryFrontendReleasePlan(snapshot, { ...options,
    installedOpsSuccessorReaderContract: undefined }), /unrecognized exports\/runtime\/resources/u,
  'strict default continues to reject the additional Ops handlers');
  assert.throws(() => compileOrdinaryFrontendReleasePlan(snapshot, { ...options, app: 'operations',
    release: { ...release, application: 'operations' } }), /Client-only read contract/u,
  'the installed-state selector cannot authorize an Operations frontend release');
  const ordinaryPlan = compileOrdinaryFrontendReleasePlan(snapshot, options);
  assert.equal(ordinaryPlan.installedOpsSuccessorReaderContract, OPS_SUCCESSOR_READER_INSTALLED_CONTRACT);
  assert.equal(ordinaryPlan.config.name, 'ledgetop-clients');
  assert.equal(ordinaryPlan.config.assets.binding, 'ASSETS');
  assert.equal(validateOrdinaryFrontendReleasePlan(snapshot, ordinaryPlan, options), ordinaryPlan);
  assert.throws(() => validateOrdinaryFrontendReleasePlan(snapshot, ordinaryPlan, { ...options,
    installedOpsSuccessorReaderContract: undefined }), /unrecognized exports\/runtime\/resources/u,
  'revalidation requires the same explicit selector pinned into the ordinary plan');

  const clientLedgerModule = snapshot.client.modern.modules.find(row => row.name === '__ops_release_ledger.json');
  assert.ok(clientLedgerModule);
  const previousLedger = JSON.parse(Buffer.from(clientLedgerModule.content_base64, 'base64').toString('utf8'));
  const previousAssetBytes = new Map();
  for (const row of previousLedger.assets) {
    const file = path.resolve(assetRoot, row.path.slice(1)), real = fs.realpathSync(file);
    assert.ok(real.startsWith(`${assetRoot}${path.sep}`));
    const stat = fs.lstatSync(real), bytes = fs.readFileSync(real);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(bytes.length, row.size); assert.equal(hash(bytes), row.sha256);
    previousAssetBytes.set(row.path, bytes);
  }
  const retainedOptions = { ordinaryPlan, profile, previousLedger, previousAssetBytes,
    observedAt: new Date().toISOString(), installedOpsSuccessorReaderContract: OPS_SUCCESSOR_READER_INSTALLED_CONTRACT };
  const retainedPlan = compileOrdinaryFrontendRetainedPlan(snapshot, retainedOptions);
  assert.equal(retainedPlan.installedOpsSuccessorReaderContract, OPS_SUCCESSOR_READER_INSTALLED_CONTRACT);
  assert.equal(validateOrdinaryFrontendRetainedPlan(snapshot, retainedPlan, retainedOptions), retainedPlan);
  assert.throws(() => validateOrdinaryFrontendRetainedPlan(snapshot, retainedPlan, { ...retainedOptions,
    installedOpsSuccessorReaderContract: undefined }), /exact selected read-only Ops recognition contract/u);
});
