import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import * as potreePatch from '../scripts/patch-potree-ept.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shared='new Potree.PointCloudCopcGeometryNode(geometry)';
const nonexistent='new Potree.PointCloudEptGeometryNode(geometry)';
const {patchPotreeEptSource}=potreePatch;
const bundle=(eptNode=shared)=>`prefix class EptLoader { static load(){ ${eptNode}; } } class CopcLoader { static load(){ ${shared}; } } suffix`;

test('Potree 1.8.2 keeps the shared COPC/EPT geometry node constructor',()=>{
  const source=bundle();
  assert.equal(patchPotreeEptSource(source),source);
});

test('the production patch repairs the non-exported EPT constructor regression',()=>{
  const repaired=patchPotreeEptSource(bundle(nonexistent));
  assert.equal(repaired.includes(nonexistent),false);
  assert.equal(repaired.split(shared).length-1,2);
});

test('unknown Potree loader layouts fail the image build closed',()=>{
  assert.throws(()=>patchPotreeEptSource('class EptLoader {} class CopcLoader {}'),/COPC loader signature changed/);
  assert.throws(()=>patchPotreeEptSource(bundle('new UnknownNode(geometry)')),/EPT loader signature changed/);
});

test('standalone EPT files use LAZ-RS while COPC chunks retain the pinned decoder',()=>{
  assert.equal(typeof potreePatch.patchPotreeEptWorkerRoute,'function','the worker router patch is exported');
  const legacy="let workerPath = Potree.scriptPath +\n\t\t\t\t'/workers/EptLaszipDecoderWorker.js';";
  const routed="let workerPath = Potree.scriptPath +\n\t\t\t\t(isFullFile ? '/workers/EptLazRsDecoderWorker.js' : '/workers/EptLaszipDecoderWorker.js');";
  assert.equal(potreePatch.patchPotreeEptWorkerRoute(legacy),routed);
  assert.equal(potreePatch.patchPotreeEptWorkerRoute(routed),routed);
  assert.throws(()=>potreePatch.patchPotreeEptWorkerRoute('let workerPath = unknown;'),/worker route signature changed/);
});

test('only the LAZ-RS worker is launched as an ECMAScript module',()=>{
  assert.equal(typeof potreePatch.patchPotreeEptWorkerFactory,'function','the worker factory patch is exported');
  const released='let worker = new Worker(url);';
  const patched='let worker = new Worker(url, url.endsWith("/EptLazRsDecoderWorker.js") ? {type: "module"} : undefined);';
  assert.equal(potreePatch.patchPotreeEptWorkerFactory(released),patched);
  assert.equal(potreePatch.patchPotreeEptWorkerFactory(patched),patched);
  assert.throws(()=>potreePatch.patchPotreeEptWorkerFactory('let worker = createWorker(url);'),/worker factory signature changed/);
});

test('Potree consumes the decoder-confirmed point count when EPT hierarchy metadata is absent',()=>{
  assert.equal(typeof potreePatch.patchPotreeEptDecodedPointCount,'function','the decoded point-count patch is exported');
  const released='\t\t\t\t\tpointCount,\n\t\t\t\t\tnew Vector3(...e.data.mean));';
  const patched='\t\t\t\t\tNumber.isSafeInteger(e.data.pointCount) && e.data.pointCount > 0 ? e.data.pointCount : pointCount,\n\t\t\t\t\tnew Vector3(...e.data.mean));';
  assert.equal(potreePatch.patchPotreeEptDecodedPointCount(released),patched);
  assert.equal(potreePatch.patchPotreeEptDecodedPointCount(patched),patched);
  assert.throws(()=>potreePatch.patchPotreeEptDecodedPointCount('doneLoading(pointCount)'),/decoded point-count signature changed/);
});

test('the production EPT worker uses the bounded LAZ-RS decoder',()=>{
  const workerPath=path.join(root,'ept-lazrs-worker.mjs');
  const buildPath=path.join(root,'scripts','build-potree-ept-worker.mjs');
  assert.equal(fs.existsSync(workerPath),true,'the custom EPT worker source exists');
  assert.equal(fs.existsSync(buildPath),true,'the deterministic worker build exists');
  const worker=fs.readFileSync(workerPath,'utf8');
  const build=fs.readFileSync(buildPath,'utf8');
  assert.match(worker,/decodeEptLazNode/);
  assert.match(worker,/readLasPointCount/);
  assert.match(worker,/headerPointCount > 10_000_000/);
  assert.match(worker,/compressed\.byteLength > 256 \* 1024 \* 1024/);
  assert.match(worker,/decoded\.pointCount !== headerPointCount/);
  assert.match(worker,/postMessage\(decoded, transferables\)/);
  assert.match(build,/base:\s*'\.\/'/);
  assert.match(build,/assetsInlineLimit:\s*0/);
  assert.match(build,/format:\s*'es'/);
  assert.match(build,/EptLazRsDecoderWorker\.js/);
  assert.match(build,/externalWasm\.length !== 1/);
  assert.match(build,/const relativeWasmReference\s*=/);
  assert.match(build,/emptyOutDir:\s*false/);
});

test('container build enforces the EPT contract before Vite copies Potree',()=>{
  const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
  assert.match(docker,/COPY --from=potree \/potree \.\/public\/potree\s+RUN node scripts\/patch-potree-ept\.mjs public\/potree\/build\/potree\/potree\.js\s+RUN node scripts\/build-potree-ept-worker\.mjs\s+RUN npx vite build/);
});
