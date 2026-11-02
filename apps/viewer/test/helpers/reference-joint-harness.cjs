'use strict';

/* Synthetic transport/durability fixture ONLY. No project/model publication or
 * geometry admission occurs. Production ingestion retains its geometry validators.
 * Node >=24; no dependencies. Run on a private Docker internal network, no host
 * ports: REFERENCE_SYNTHETIC_FIXTURE=1 NODE_EXTRA_CA_CERTS=/tls/ca.pem
 * node test/helpers/reference-joint-harness.cjs /fixture/config.json
 * (Alternatively REFERENCE_JOINT_CONFIG supplies the explicit JSON config path.)
 * Config: {keyPath:'/tls/viewer.key',certPath:'/tls/viewer.pem',
 * controlEndpoint:'https://processing:9443',controlToken:'synthetic-token-16plus',
 * fixtureControlToken:'different-synthetic-16plus',environment:'staging',
 * host:'0.0.0.0',port:9444,fixtureRoot:'/fixture/viewer-state',
 * failAfterLedgerCommit:false}. fixtureRoot must be a new/empty directory or a
 * prior root created by this helper. Omit it to allocate in os.tmpdir(). Restart
 * with the same root for outbox replay. CA trust uses native Node configuration;
 * no TLS validation bypass is supported. Filesystem directory fsync is required.
 * Every /fixture/* request needs Bearer fixtureControlToken. POST bodies are {}
 * except ingest optionally accepts {acceptedObjectIds:['result-id']}. submit,
 * pump return jobId/phase/status; ingest and replay-acceptance return durableCopy,
 * published:false, storageReceiptId/acceptance/acknowledged. GET state returns
 * safe job state and counts. Tokens, source paths and raw upstream errors never
 * appear in HTTP output. The broker recovery key below is fixed test data only;
 * never persist production grant tokens or use this key outside the fixture.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const {randomUUID, timingSafeEqual} = require('node:crypto');

const fail = code => { const error = new Error(code); error.code = code; throw error; };
function validateConfig(config, env = process.env) {
  if (env.REFERENCE_SYNTHETIC_FIXTURE !== '1') fail('SYNTHETIC_FIXTURE_REQUIRED');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('TLS_VALIDATION_REQUIRED');
  const keys = ['keyPath','certPath','controlEndpoint','controlToken','fixtureControlToken','environment','host','port','fixtureRoot','failAfterLedgerCommit'];
  if (!config || Object.getPrototypeOf(config) !== Object.prototype || Object.keys(config).some(k => !keys.includes(k))) fail('INVALID_CONFIG');
  for (const key of ['keyPath','certPath']) if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) fail('INVALID_CONFIG');
  for (const key of ['controlToken','fixtureControlToken']) if (typeof config[key] !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(config[key])) fail('INVALID_CONFIG');
  if (config.controlToken === config.fixtureControlToken) fail('SEPARATE_FIXTURE_TOKEN_REQUIRED');
  let url; try { url = new URL(config.controlEndpoint); } catch { fail('INVALID_CONFIG'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^https:\/\/[^/?#\s\\]+\/?$/.test(config.controlEndpoint)) fail('INVALID_CONFIG');
  if (!['staging','production'].includes(config.environment) || typeof config.host !== 'string' || !config.host || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) fail('INVALID_CONFIG');
  if (config.fixtureRoot !== undefined && (typeof config.fixtureRoot !== 'string' || !path.isAbsolute(config.fixtureRoot) || path.parse(config.fixtureRoot).root === path.resolve(config.fixtureRoot))) fail('INVALID_CONFIG');
  if (config.failAfterLedgerCommit !== undefined && typeof config.failAfterLedgerCommit !== 'boolean') fail('INVALID_CONFIG');
  return config;
}
function closedBody(body, ingest = false) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).some(k => !ingest || k !== 'acceptedObjectIds')) fail('INVALID_FIXTURE_BODY');
  if (body.acceptedObjectIds !== undefined && (!Array.isArray(body.acceptedObjectIds) || !body.acceptedObjectIds.length || body.acceptedObjectIds.length > 32 || new Set(body.acceptedObjectIds).size !== body.acceptedObjectIds.length || body.acceptedObjectIds.some(v => typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)))) fail('INVALID_FIXTURE_BODY');
  return body;
}
function safeChain(directory) {
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_FIXTURE_ROOT');
  }
}
async function start(config, env = process.env) {
  validateConfig(config, env);
  // Delay production modules (including SQLite) until after the opt-in guard.
  const {ReferenceProvider} = require('../../server/referenceProvider');
  const {ReferenceTransferBroker} = require('../../server/referenceTransferBroker');
  const {ReferenceAcceptanceLedger, syncDirectory} = require('../../server/referenceAcceptance');
  const {createReferenceBrokerHandler} = require('../../server/referenceHttp');
  const protocol = require('../../server/referenceProtocol');
  const root = config.fixtureRoot ? path.resolve(config.fixtureRoot) : fs.mkdtempSync(path.join(os.tmpdir(),'reference-joint-'));
  if (!fs.existsSync(root)) { safeChain(path.dirname(root)); fs.mkdirSync(root,{mode:0o700}); }
  safeChain(root);
  const statePath = path.join(root,'fixture-state.json');
  let state = {syntheticFixture:true,version:1,environment:config.environment,controlOriginSha256:protocol.sha256(Buffer.from(new URL(config.controlEndpoint).origin)),submission:null,job:null,capabilities:null,results:null,grantAttempted:false};
  if (fs.existsSync(statePath)) {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > protocol.LIMITS.metadataBytes) fail('UNSAFE_FIXTURE_STATE');
    const restored = JSON.parse(fs.readFileSync(statePath,'utf8'));
    for (const key of ['syntheticFixture','version','environment','controlOriginSha256']) if (restored[key] !== state[key]) fail('FIXTURE_STATE_BINDING');
    state = restored;
  } else if (fs.readdirSync(root).length) fail('FIXTURE_ROOT_NOT_EMPTY');
  function atomicFile(target, bytes) {
    const temp = target + '.tmp-' + randomUUID(); let fd;
    try { fd = fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp,target); syncDirectory(path.dirname(target)); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  const save = () => atomicFile(statePath,JSON.stringify(state));
  syncDirectory(root); save();
  const inputRoot = path.join(root,'input'), resultRoot = path.join(root,'results');
  for (const dir of [inputRoot,resultRoot]) { if (!fs.existsSync(dir)) fs.mkdirSync(dir,{mode:0o700}); safeChain(dir); }
  const inputFile = path.join(inputRoot,'Survey_001.JPG');
  if (!fs.existsSync(inputFile)) atomicFile(inputFile,Buffer.from('abc'));
  const sourceStat = fs.lstatSync(inputFile);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || protocol.sha256(fs.readFileSync(inputFile)) !== protocol.sha256(Buffer.from('abc'))) fail('FIXTURE_SOURCE_CHANGED');
  const fixtureBytes = fs.readFileSync(path.join(__dirname,'../fixtures/reference-v1.contract.json'));
  const normalizedFixtureBytes = Buffer.from(fixtureBytes.toString('utf8').replace(/\r\n/g,'\n'),'utf8');
  if (protocol.sha256(normalizedFixtureBytes) !== 'fad338cc40b56fce9f571fa0b34a9041983a3868e830a0a90d6242cde5729210') fail('FROZEN_FIXTURE_CHANGED');
  const frozen = JSON.parse(normalizedFixtureBytes);
  if (frozen.transferGrantAcknowledgement.grantSha256 !== protocol.sha256(protocol.canonicalBytes(frozen.transferGrant))) fail('TRANSFER_GRANT_ACK_VECTOR_MISMATCH');
  for (const basename of ['broker.sqlite','acceptance.sqlite']) for (const suffix of ['','-wal','-shm']) {
    const candidate = path.join(root,basename + suffix);
    if (fs.existsSync(candidate)) {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_FIXTURE_STATE');
    }
  }
  const client = new ReferenceProvider({endpoint:config.controlEndpoint,token:config.controlToken,environment:config.environment,enabled:true,maxObjectBytes:4194304});
  const broker = new ReferenceTransferBroker({databasePath:path.join(root,'broker.sqlite'),managedRoot:inputRoot,environment:config.environment,allowCreate:true,grantRecoveryKey:Buffer.alloc(32,0x73)});
  const ledger = new ReferenceAcceptanceLedger({databasePath:path.join(root,'acceptance.sqlite'),managedRoot:resultRoot});
  const brokerHandler = createReferenceBrokerHandler({broker,enabled:true});
  function expected() {
    if (!state.job || !state.submission) fail('SUBMISSION_REQUIRED');
    return {jobId:state.job.jobId,generation:state.job.generation,environment:config.environment,manifestSha256:state.submission.manifest.sha256,inputManifestSha256:state.submission.manifest.sha256,pipelineDigest:state.job.pipelineDigest,requestedEngines:['odm'],objectIds:state.submission.manifest.objects.map(o => o.id)};
  }
  async function refresh() { state.job = await client.status(state.job.jobId,expected()); save(); return state.job; }
  const publicJob = () => ({jobId:state.job?.jobId ?? null,phase:state.job?.phase ?? null,status:state.job?.status ?? null});
  async function acknowledge(row) {
    const value = await client.acceptResult(state.job.jobId,row.payload,{...expected(),resultManifestSha256:state.results.resultManifestSha256});
    ledger.markAcked(row.receiptId,row.payload); state.job = value.job; save();
    return {durableCopy:true,published:false,storageReceiptId:row.payload.storageReceiptId,acceptance:row.payload,acknowledged:true,...publicJob()};
  }
  async function route(name,body) {
    if (name === 'state') {
      const rows = ledger.db.prepare('SELECT payload FROM acceptances').all();
      return {syntheticFixture:true,...publicJob(),pendingOutboxCount:ledger.db.prepare('SELECT count(*) n FROM ack_outbox WHERE acked=0').get().n,acceptedObjectIds:[...new Set(rows.flatMap(r => JSON.parse(r.payload).acceptedObjectIds))].sort(),published:false};
    }
    if (name === 'submit') {
      if (!state.submission) {
        state.capabilities = await client.capabilities();
        state.submission = structuredClone(frozen.submission); state.submission.submissionId = randomUUID();
        state.submission.capabilityFingerprint = state.capabilities.capabilityFingerprint;
        state.submission.pipeline.odm.optionsFingerprint = state.capabilities.engines.odm.optionsFingerprint;
        save(); // immutable request survives uncertain submit ACK
      }
      if (!state.job) { state.job = await client.submit(state.submission); save(); }
      return publicJob();
    }
    if (name === 'pump') {
      await refresh();
      if (state.job.phase === 'awaiting_transfer' && state.job.transferRequest && !state.job.transferGrantAcknowledgement) {
        if (state.grantAttempted) fail('GRANT_ACK_UNCERTAIN');
        const minted = broker.mintGrant({jobId:state.job.jobId,generation:state.job.generation,manifest:state.submission.manifest,reservation:state.job.transferRequest,reservationAvailable:true,objectFiles:{'image-1':inputFile},capabilities:state.capabilities,capabilityFingerprint:state.capabilities.capabilityFingerprint});
        if (!minted.tokenRecoverable) fail('GRANT_ACK_UNCERTAIN');
        state.grantAttempted = true; save();
        await client.postTransferGrant(state.job.jobId,minted.grant,expected());
        await refresh();
      }
      return publicJob();
    }
    if (name === 'replay-acceptance') {
      await refresh();
      state.results = await client.results(state.job.jobId,{...expected(),...(state.results ? {resultManifestSha256:state.results.resultManifestSha256} : {})}); save();
      const pending = ledger.pendingOutbox(Date.now(),100);
      const replies = []; for (const row of pending) replies.push(await acknowledge(row));
      return {replayed:replies.length,receipts:replies,...publicJob()};
    }
    if (name === 'ingest') {
      await refresh(); state.results = await client.results(state.job.jobId,expected()); save();
      const accepted = body.acceptedObjectIds ?? state.results.objects.map(o => o.id);
      if (accepted.some(id => !state.results.objects.some(o => o.id === id))) fail('INVALID_FIXTURE_BODY');
      const mappings = [], retained = [];
      for (const object of state.results.objects) {
        const relativePath = randomUUID() + (object.role === 'odm_archive' ? '.zip' : '.bin');
        const chunks = [];
        for await (const chunk of await client.downloadObject(state.job.jobId,object.id,{expectedBinding:expected()})) chunks.push(chunk);
        atomicFile(path.join(resultRoot,relativePath),Buffer.concat(chunks));
        retained.push({id:object.id,relativePath});
        if (accepted.includes(object.id)) mappings.push({id:object.id,relativePath});
      }
      state.resultFiles = retained; save();
      const binding = {...expected(),resultManifestSha256:state.results.resultManifestSha256,objectIds:state.results.objects.map(o => o.id)};
      const acceptance = {schemaVersion:1,receiptId:randomUUID(),storageReceiptId:randomUUID(),jobId:binding.jobId,generation:binding.generation,environment:binding.environment,inputManifestSha256:binding.inputManifestSha256,pipelineDigest:binding.pipelineDigest,resultManifestSha256:binding.resultManifestSha256,acceptedObjectIds:accepted,acceptedAt:new Date().toISOString(),validationVersion:'ltds-reference-v1'};
      ledger.accept({expected:binding,resultManifest:state.results,acceptance,objects:mappings,reconstruction:{syntheticFixture:true,transportOnly:true,published:false,retainedObjects:retained}});
      if (config.failAfterLedgerCommit) process.exit(86);
      return acknowledge({receiptId:acceptance.receiptId,payload:acceptance});
    }
    fail('NOT_FOUND');
  }
  let busy = false;
  const server = https.createServer({key:fs.readFileSync(config.keyPath),cert:fs.readFileSync(config.certPath),minVersion:'TLSv1.2'},async (req,res) => {
    const send = (status,value) => { if (res.destroyed) return; res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(value)); };
    try {
      if (await brokerHandler(req,res)) return;
      const match = /^\/fixture\/(submit|pump|ingest|replay-acceptance|state)$/.exec(req.url || '');
      if (!match) return send(404,{error:'not_found'});
      const supplied = Buffer.from(req.headers.authorization || ''), required = Buffer.from('Bearer ' + config.fixtureControlToken);
      if (supplied.length !== required.length || !timingSafeEqual(supplied,required)) return send(401,{error:'unauthorized'});
      if (req.method !== (match[1] === 'state' ? 'GET' : 'POST')) return send(405,{error:'method_not_allowed'});
      if (busy) return send(409,{error:'fixture_busy'});
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return send(413,{error:'body_limit'}); chunks.push(chunk); }
      let body = {};
      if (req.method === 'GET') { if (bytes) fail('INVALID_FIXTURE_BODY'); }
      else { if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') fail('INVALID_FIXTURE_BODY'); try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_FIXTURE_BODY'); } closedBody(body,match[1] === 'ingest'); }
      if (busy) return send(409,{error:'fixture_busy'});
      busy = true;
      try { send(200,await route(match[1],body)); } finally { busy = false; }
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code.toLowerCase() : 'fixture_failed';
      send(code === 'invalid_fixture_body' ? 400 : 409,{error:code});
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(config.port,config.host,resolve); });
  return {server,root,close:async () => { await new Promise(resolve => server.close(resolve)); broker.close(); ledger.close(); }};
}
module.exports = {validateConfig,closedBody,start};
if (require.main === module) {
  (async () => {
    if (process.env.REFERENCE_SYNTHETIC_FIXTURE !== '1') fail('SYNTHETIC_FIXTURE_REQUIRED');
    const configPath = process.argv[2] || process.env.REFERENCE_JOINT_CONFIG;
    if (!configPath || !path.isAbsolute(configPath) || fs.statSync(configPath).size > 16384) fail('EXPLICIT_CONFIG_PATH_REQUIRED');
    const harness = await start(JSON.parse(fs.readFileSync(configPath,'utf8')));
    process.stdout.write(JSON.stringify({syntheticFixture:true,ready:true,port:harness.server.address().port,fixtureRoot:harness.root}) + '\n');
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,() => { void harness.close().then(() => process.exit(0)); });
  })().catch(error => { const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'FIXTURE_START_FAILED'; process.stderr.write(code + '\n'); process.exitCode = 1; });
}
