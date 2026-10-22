'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');
const { processIngest } = require('../server/processingWorker');
const { makeZip } = require('./helpers/zipFixture');

const root = path.resolve(__dirname, '..');
const immutableImage = `example.invalid/provider@sha256:${'a'.repeat(64)}`;
const validOutputZip = Buffer.from('UEsDBBQAAAAAAG5SEV1oIC3YAwAAAAMAAAAoAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYmdsYlBLAwQUAAAAAABuUhFdQ7+mowIAAAACAAAAGwAAAGVudHdpbmVfcG9pbnRjbG91ZC9lcHQuanNvbnt9UEsDBBQAAAAAAG5SEV1Dv6ajAgAAAAIAAAAbAAAAM2RfdGlsZXMvbW9kZWwvdGlsZXNldC5qc29ue31QSwECFAAUAAAAAABuUhFdaCAt2AMAAAADAAAAKAAAAAAAAAAAAAAAAAAAAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYlBLAQIUABQAAAAAAG5SEV1Dv6ajAgAAAAIAAAAbAAAAAAAAAAAAAAAAAEkAAABlbnR3aW5lX3BvaW50Y2xvdWQvZXB0Lmpzb25QSwECFAAUAAAAAABuUhFdQ7+mowIAAAACAAAAGwAAAAAAAAAAAAAAAACEAAAAM2RfdGlsZXMvbW9kZWwvdGlsZXNldC5qc29uUEsFBgAAAAADAAMA6AAAAL8AAAAAAA==', 'base64');
const missingOutputZip = Buffer.from('UEsDBBQAAAAAAIBSEV1oIC3YAwAAAAMAAAAoAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYmdsYlBLAQIUABQAAAAAAIBSEV1oIC3YAwAAAAMAAAAoAAAAAAAAAAAAAAAAAAAAAABvZG1fdGV4dHVyaW5nL29kbV90ZXh0dXJlZF9tb2RlbF9nZW8uZ2xiUEsFBgAAAAABAAEAVgAAAEkAAAAAAA==', 'base64');

const completeOutputEntries = [
  { path:'odm_texturing/odm_textured_model_geo.glb', data:'glb' },
  { path:'odm_texturing/odm_textured_model_geo.obj', data:'mtllib materials/model.mtl\nv 0 0 0\n' },
  { path:'odm_texturing/materials/model.mtl', data:'newmtl surface\nmap_Kd ../textures/model.jpg\n' },
  { path:'odm_texturing/textures/model.jpg', data:'texture' },
  { path:'entwine_pointcloud/ept.json', data:'{}' },
  { path:'3d_tiles/model/tileset.json', data:'{}' },
];
const completeOutputZip = makeZip(completeOutputEntries);
const completeOutputBytes = completeOutputEntries.reduce((sum,entry)=>sum+Buffer.byteLength(entry.data),0);
const missingNativeOutputZip = makeZip(completeOutputEntries.filter((entry)=>entry.path.startsWith('odm_texturing/')));
const incompleteMeshOutputZip = makeZip(completeOutputEntries.filter((entry)=>!entry.path.endsWith('/model.jpg')));

function respondJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type':'application/json', 'content-length':Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

async function fakeProvider({ loseFirstInitResponse=false, rejectRemove=false, outputZip=completeOutputZip } = {}) {
  const tasks = new Map();
  const order = [];
  let lost = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://provider.test');
    if (request.method === 'GET' && url.pathname === '/info') return respondJson(response, 200, { version:'2.2.3',engine:'odm',engineVersion:'3.5.0',taskQueueCount:0,maxImages:null });
    if (request.method === 'GET' && url.pathname === '/options') return respondJson(response, 200, [
      { name:'pc-ept',type:'bool',value:true }, { name:'gltf',type:'bool',value:true }, { name:'3d-tiles',type:'bool',value:true },
    ]);
    if (request.method === 'POST' && url.pathname === '/task/new/init') {
      await readBody(request);
      const uuid = String(request.headers['set-uuid'] || '');
      tasks.set(uuid, { status:10 });
      order.push(uuid);
      if (loseFirstInitResponse && !lost) { lost = true; request.socket.destroy(); return; }
      return respondJson(response, 200, { uuid });
    }
    if (request.method === 'POST' && /^\/task\/new\/upload\//.test(url.pathname)) { await readBody(request);return respondJson(response,200,{success:true}); }
    if (request.method === 'POST' && /^\/task\/new\/commit\//.test(url.pathname)) {
      const uuid = decodeURIComponent(url.pathname.split('/').pop());
      const task = tasks.get(uuid);
      if (!task) return respondJson(response, 404, { error:'missing' });
      task.status = order.indexOf(uuid) === 0 ? 40 : 10;
      return respondJson(response, 200, {});
    }
    const info = /^\/task\/([^/]+)\/info$/.exec(url.pathname);
    if (request.method === 'GET' && info) {
      const uuid = decodeURIComponent(info[1]);
      const task = tasks.get(uuid);
      return task ? respondJson(response, 200, { uuid,status:{code:task.status},progress:task.status === 40 ? 100 : 0,imagesCount:1 }) : respondJson(response, 404, { error:'missing' });
    }
    if (request.method === 'GET' && /^\/task\/[^/]+\/output$/.test(url.pathname)) return respondJson(response, 200, '');
    if (request.method === 'GET' && /^\/task\/[^/]+\/download\/all\.zip$/.test(url.pathname)) { response.writeHead(200, { 'content-type':'application/zip' });response.end(outputZip);return; }
    if (request.method === 'POST' && url.pathname === '/task/cancel') {
      const uuid = new URLSearchParams(await readBody(request)).get('uuid');
      if (tasks.has(uuid)) tasks.get(uuid).status = 50;
      return respondJson(response, 200, {});
    }
    if (request.method === 'POST' && url.pathname === '/task/remove') {
      const uuid = new URLSearchParams(await readBody(request)).get('uuid');
      if (rejectRemove) return respondJson(response, 500, { error:'rejected' });
      if (!tasks.delete(uuid)) return respondJson(response, 404, { error:'missing' });
      return respondJson(response, 200, {});
    }
    respondJson(response, 404, { error:'unexpected' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  return { endpoint:`http://127.0.0.1:${server.address().port}`,tasks,close:()=>new Promise((resolve) => server.close(resolve)) };
}

function runHarness(endpoint, corpus, extra = []) {
  const args = [
    'scripts/verify-odm-provider.mjs', '--endpoint', endpoint, '--provider-type', 'nodeodm',
    '--destructive', '--corpus', corpus, '--provider-image', immutableImage,
    '--confirm', 'I_UNDERSTAND_PROVIDER_TASKS_WILL_BE_CREATED_AND_REMOVED', '--timeout-ms', '60000', ...extra,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd:root, env:{...process.env,ODM_PROVIDER_TOKEN:''} });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => { child.kill();reject(new Error('compatibility harness test timed out')); }, 20_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer);resolve({code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}); });
  });
}

test('processIngest rejects a provider mesh without EPT before adopting it', async (t) => {
  const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-ingest-'));
  const database = openDatabase(path.join(resultRoot, 'viewer.sqlite'));
  t.after(() => { database.close();fs.rmSync(resultRoot, { recursive:true, force:true }); });
  const task = { id:'task-ept-contract', projectId:'project-ept-contract', datasetId:'dataset-ept-contract', displayName:'EPT contract' };
  const attempt = { id:'attempt-ept-contract', taskId:task.id, datasetId:task.datasetId, providerId:'provider-ept-contract', providerTaskId:'remote-ept-contract', createdBy:'ops:test' };
  const destination = path.join(resultRoot, task.id, attempt.id);
  for (const entry of completeOutputEntries.filter((item) => item.path.startsWith('odm_texturing/'))) {
    const absolute = path.join(destination, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive:true });
    fs.writeFileSync(absolute, entry.data);
  }
  let adopted = false;
  const processing = {
    database,
    getAttempt: () => attempt,
    getAttemptTransferProvenance: () => null,
    getTask: () => task,
    getProject: () => ({ id:task.projectId, displayName:'EPT project' }),
    getProvider: () => ({ id:attempt.providerId, type:'nodeodm', endpoint:'http://127.0.0.1:3000' }),
  };
  const storage = {
    space: () => ({ available:2 * 1024 ** 3, reserve:0 }),
    resolve: (_rootKey, relativePath) => path.join(resultRoot, ...relativePath.split('/')),
  };
  await assert.rejects(processIngest({ id:'job-ept-contract', attempt_id:attempt.id, lease_owner:'worker:ept' }, {
    processing,
    repository:{ upsertModelVersion() { adopted = true; } },
    storage,
    config:{ processingProviderTransferTimeoutMs:1000 },
    providerCredentials:{ resolve:() => '' },
    signal:new AbortController().signal,
  }), (error) => error.code === 'missing_required_output' && /required EPT output/.test(error.message));
  assert.equal(adopted, false, 'the incomplete provider result must not reach model adoption');
});

test('processIngest exposes a pending mesh derivative only with its verified provider closure and reservation', { skip: process.platform !== 'linux' }, async (t) => {
  const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-provider-snapshot-'));
  const config = {
    datasetsMount:path.join(resultRoot, 'datasets'), modelsMount:path.join(resultRoot, 'models'),
    cacheMount:path.join(resultRoot, 'cache'), trashMount:path.join(resultRoot, 'trash'),
    storageReserveBytes:0, storageReservePercent:0, meshDerivativesEnabled:true,
    processingProviderTransferTimeoutMs:1000, opsBaseUrl:'http://operations.test',
  };
  for (const directory of [config.datasetsMount, config.modelsMount, config.cacheMount, config.trashMount]) fs.mkdirSync(directory, { recursive:true });
  const database = openDatabase(path.join(resultRoot, 'viewer.sqlite')), processing = new ProcessingRepository(database), repository = new ViewerRepository(database), storage = new StorageManager(config);
  storage.initialize();
  t.after(() => { database.close();fs.rmSync(resultRoot, { recursive:true, force:true }); });
  const project = processing.createProject({ displayName:'Provider snapshot project' });
  const dataset = processing.createDataset({ projectId:project.id, displayName:'Provider snapshot dataset', storageMode:'managed', rootKey:'datasets', relativePath:'source' });
  processing.finalizeDataset(dataset.id, [{ relativePath:'photo.jpg', byteSize:1, sha256:'a'.repeat(64) }], 'b'.repeat(64));
  const task = processing.createTask({ projectId:project.id, datasetId:dataset.id, displayName:'Provider snapshot task' });
  const provider = processing.upsertProvider({ type:'nodeodm', displayName:'ODM', endpoint:'http://127.0.0.1:3000', enabled:true });
  const attempt = processing.createAttempt({ taskId:task.id, providerId:provider.id, options:{}, createdBy:'ops:test' }), owner = 'provider-snapshot-owner', job = processing.claimJob(owner);
  processing.transitionAttemptForJob(job.id, owner, 'ingesting');
  const destination = path.join(config.modelsMount, task.id, attempt.id);
  for (const entry of completeOutputEntries) {
    const absolute = path.join(destination, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive:true });
    fs.writeFileSync(absolute, entry.data);
  }
  await processIngest(job, { processing, repository, storage, config, providerCredentials:{ resolve:() => '' }, signal:new AbortController().signal });
  const derivative = database.prepare("SELECT id,status FROM derivative_jobs WHERE attempt_id=? AND derivative_type='mesh_tiles'").get(attempt.id);
  assert.equal(derivative.status, 'pending');
  const snapshot = processing.derivativeInputSnapshot(derivative.id), expectedBytes = completeOutputEntries.filter((entry) => entry.path.startsWith('odm_texturing/')).reduce((sum, entry) => sum + Buffer.byteLength(entry.data), 0);
  assert.equal(snapshot.totalByteSize, expectedBytes);
  assert.deepEqual(snapshot.files.map((file) => file.role), ['mesh_mtl', 'mesh_glb', 'mesh_obj', 'mesh_texture']);
  assert.deepEqual(snapshot.files.map((file) => file.relativePath), [
    `${task.id}/${attempt.id}/odm_texturing/materials/model.mtl`,
    `${task.id}/${attempt.id}/odm_texturing/odm_textured_model_geo.glb`,
    `${task.id}/${attempt.id}/odm_texturing/odm_textured_model_geo.obj`,
    `${task.id}/${attempt.id}/odm_texturing/textures/model.jpg`,
  ]);
  assert.deepEqual(processing.derivativeStorageReservation(derivative.id), {
    reservedByteSize:8 * 1024 ** 3, accountedByteSize:8 * 1024 ** 3, state:'reserved', inputByteSize:expectedBytes,
    inputManifestSha256:snapshot.manifestSha256, inputFileCount:4,
  });
});

test('destructive compatibility result binds corpus/image and prints only after verified cleanup', async (t) => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-harness-'));
  fs.writeFileSync(path.join(corpus, 'one.jpg'), 'image');
  const provider = await fakeProvider();
  t.after(async () => { await provider.close();fs.rmSync(corpus, {recursive:true,force:true}); });
  const result = await runHarness(provider.endpoint, corpus);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(provider.tasks.size, 0);
  assert.match(result.stdout, /"result": "compatible"/);
  assert.match(result.stdout, /"providerImage": "example\.invalid\/provider@sha256:/);
  assert.match(result.stdout, /"fileCount": 1/);
  assert.match(result.stdout, /"totalBytes": 5/);
  assert.match(result.stdout, /"manifestSha256": "[0-9a-f]{64}"/);
  assert.match(result.stdout, new RegExp(`"archiveEntries": ${completeOutputEntries.length}`));
  assert.match(result.stdout, new RegExp(`"expandedBytes": ${completeOutputBytes}`));
  assert.match(result.stdout, /"outputKinds": \[/);
  assert.match(result.stdout, /"obj"/);
  assert.match(result.stdout, /"nativeTiles"/);
  assert.match(result.stdout, /"meshInput": \{/);
  assert.match(result.stdout, /"fileCount": 4/);
  assert.match(result.stdout, /"manifestSha256": "[0-9a-f]{64}"/);
  assert.match(result.stdout, /"cancelStatus": "cancelled"/);
});

test('missing required native outputs fails closed and removes the processing task', async (t) => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-harness-'));
  fs.writeFileSync(path.join(corpus, 'one.jpg'), 'image');
  const provider = await fakeProvider({outputZip:missingNativeOutputZip});
  t.after(async () => { await provider.close();fs.rmSync(corpus, {recursive:true,force:true}); });
  const result = await runHarness(provider.endpoint, corpus);
  assert.notEqual(result.code, 0);
  assert.equal(provider.tasks.size, 0);
  assert.match(result.stderr, /missing one or more required native outputs/);
  assert.doesNotMatch(result.stdout, /"result": "compatible"/);
});

test('advertised native outputs cannot substitute for the local KTX2 input closure', async (t) => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-harness-'));
  fs.writeFileSync(path.join(corpus, 'one.jpg'), 'image');
  t.after(() => fs.rmSync(corpus, {recursive:true,force:true}));
  for (const outputZip of [validOutputZip, missingOutputZip]) {
    const provider = await fakeProvider({outputZip});
    try {
      const result = await runHarness(provider.endpoint, corpus);
      assert.notEqual(result.code, 0);
      assert.equal(provider.tasks.size, 0);
      assert.match(result.stderr, /complete textured OBJ, MTL, texture, and companion GLB closure/);
      assert.doesNotMatch(result.stdout, /"result": "compatible"/);
    } finally { await provider.close(); }
  }
});

test('an incomplete textured mesh closure fails closed even when advertised outputs exist', async (t) => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-harness-'));
  fs.writeFileSync(path.join(corpus, 'one.jpg'), 'image');
  const provider = await fakeProvider({outputZip:incompleteMeshOutputZip});
  t.after(async () => { await provider.close();fs.rmSync(corpus, {recursive:true,force:true}); });
  const result = await runHarness(provider.endpoint, corpus);
  assert.notEqual(result.code, 0);
  assert.equal(provider.tasks.size, 0);
  assert.match(result.stderr, /complete textured OBJ, MTL, texture, and companion GLB closure/);
  assert.doesNotMatch(result.stdout, /"result": "compatible"/);
});

test('lost initialization response still removes the assigned UUID and fails the operation', async (t) => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-harness-'));
  fs.writeFileSync(path.join(corpus, 'one.jpg'), 'image');
  const provider = await fakeProvider({loseFirstInitResponse:true});
  t.after(async () => { await provider.close();fs.rmSync(corpus, {recursive:true,force:true}); });
  const result = await runHarness(provider.endpoint, corpus);
  assert.notEqual(result.code, 0);
  assert.equal(provider.tasks.size, 0);
  assert.doesNotMatch(result.stdout, /"result": "compatible"/);
});

test('provider removal rejection fails closed without printing compatible', async (t) => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-harness-'));
  fs.writeFileSync(path.join(corpus, 'one.jpg'), 'image');
  const provider = await fakeProvider({rejectRemove:true});
  t.after(async () => { await provider.close();fs.rmSync(corpus, {recursive:true,force:true}); });
  const result = await runHarness(provider.endpoint, corpus);
  assert.notEqual(result.code, 0);
  assert.equal(provider.tasks.size, 2);
  assert.match(result.stderr, /provider compatibility cleanup could not be verified/);
  assert.doesNotMatch(result.stdout, /"result": "compatible"/);
});

test('invalid aggregate timeout is rejected before any network request', async () => {
  const result = await runHarness('http://127.0.0.1:1', process.cwd(), ['--timeout-ms', 'NaN']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--timeout-ms must be an integer/);
});
