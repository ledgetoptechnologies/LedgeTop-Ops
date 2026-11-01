'use strict';
// PUBLIC SYNTHETIC FIXTURE ONLY. No live authority, custody, quota or route.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../../server/database');
const { ProcessingRepository } = require('../../server/processingRepository');
const { createAssociationOutboxFixture } = require('../../server/referenceV2AssociationOutboxFixture');

const fail = () => { throw new Error('invalid synthetic fixture'); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function decode(value, encoding) {
  if (typeof value !== 'string' || value.length > 1400000) fail();
  const bytes = Buffer.from(value, encoding);
  if (bytes.toString(encoding) !== value) fail();
  return bytes;
}
function readInput() {
  const chunks = []; let total = 0; const buffer = Buffer.alloc(8192); let n;
  while ((n = fs.readSync(0, buffer, 0, buffer.length, null)) > 0) {
    total += n; if (total > 2 * 1024 * 1024) fail(); chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function main(input) {
  const allowed = ['schemaVersion','outputRoot','intentCanonicalBase64','intentSignatureBase64url','coordinatorPublicKeySpkiDerHex','coordinatorObservation','associationConfig','submission','capabilities','optionsCatalog','viewerAttemptId','sourceFiles','mode'];
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== allowed.length || allowed.some(k => !Object.hasOwn(input,k)) || input.schemaVersion !== 1 || !['prepare-sign','replay'].includes(input.mode) || !uuid(input.viewerAttemptId) || !path.isAbsolute(input.outputRoot) || !Array.isArray(input.sourceFiles) || input.sourceFiles.length < 1 || input.sourceFiles.length > 100) fail();
  const root = fs.realpathSync.native(input.outputRoot), rootStat = fs.lstatSync(input.outputRoot);
  if (root !== path.resolve(input.outputRoot) || !rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.platform === 'linux' && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)))) fail();
  const dbPath = path.join(root,'fixture.sqlite'), managedRoot = path.join(root,'managed'), datasetId = 'd', datasetRoot = path.join(managedRoot,datasetId);
  const raw = decode(input.intentCanonicalBase64,'base64'), signature = decode(input.intentSignatureBase64url,'base64url');
  if (!/^(?:[0-9a-f]{2})+$/.test(input.coordinatorPublicKeySpkiDerHex || '')) fail();
  const coordinatorKey = Buffer.from(input.coordinatorPublicKeySpkiDerHex,'hex'), intent = JSON.parse(raw.toString('ascii'));
  if (intent.environment !== 'staging' || intent.trustDomain !== 'test' || input.viewerAttemptId === intent.attemptId || input.associationConfig?.issuer !== 'viewer' || input.associationConfig?.keyId !== 'fixture-key' || input.associationConfig?.issuedAt !== 1000 || input.associationConfig?.expiresAt !== 1100 || input.submission?.manifest?.id !== 'dataset-d') fail();
  const files = input.sourceFiles.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'contentBase64,objectId,relativePath' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.objectId || '') || typeof item.relativePath !== 'string' || item.relativePath.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.relativePath) || item.relativePath === '.' || item.relativePath === '..') fail();
    const bytes = decode(item.contentBase64,'base64'); if (bytes.length > 1024 * 1024) fail();
    return { id:item.objectId, relativePath:item.relativePath, bytes, byteSize:bytes.length, sha256:hash(bytes) };
  });
  if (new Set(files.map(x=>x.id)).size !== files.length || new Set(files.map(x=>x.relativePath)).size !== files.length) fail();
  if (input.mode === 'prepare-sign') {
    if (fs.readdirSync(root).length !== 0) fail();
    fs.mkdirSync(managedRoot,{mode:0o700}); fs.mkdirSync(datasetRoot,{mode:0o700});
    for (const file of files) fs.writeFileSync(path.join(datasetRoot,file.relativePath),file.bytes,{flag:'wx',mode:0o600});
    fs.closeSync(fs.openSync(dbPath,'wx',0o600));
  } else {
    if (!fs.lstatSync(dbPath).isFile() || fs.lstatSync(dbPath).isSymbolicLink() || !fs.lstatSync(managedRoot).isDirectory() || fs.lstatSync(managedRoot).isSymbolicLink() || !fs.lstatSync(datasetRoot).isDirectory() || fs.lstatSync(datasetRoot).isSymbolicLink()) fail();
    if (fs.readdirSync(datasetRoot).sort().join('\0') !== files.map(x=>x.relativePath).sort().join('\0')) fail();
    for (const file of files) { const target=path.join(datasetRoot,file.relativePath), stat=fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(target).equals(file.bytes)) fail(); }
  }
  const db = new DatabaseSync(dbPath); try {
    db.exec('PRAGMA foreign_keys=ON');
    if (input.mode === 'prepare-sign') {
      applyMigrations(db); const repo = new ProcessingRepository(db);
      repo.createProject({id:'p',displayName:'Public synthetic fixture'});
      repo.createDataset({id:datasetId,projectId:'p',displayName:'Public synthetic fixture',storageMode:'managed',rootKey:'datasets',relativePath:datasetId});
      const manifestHash=hash(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256}))));
      repo.finalizeDataset(datasetId,files.map(({id,relativePath,byteSize,sha256})=>({id,relativePath,byteSize,sha256})),manifestHash);
      db.prepare("INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t','p','d','Fixture','draft','t','t')").run();
      db.prepare("INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES(?,'t','d',1,'{}','pending','t','t')").run(input.viewerAttemptId);
      db.prepare("UPDATE processing_tasks SET active_attempt_id=? WHERE id='t'").run(input.viewerAttemptId);
      db.exec('UPDATE reference_catalog_projection_state SET scan_complete=1; DROP TRIGGER viewer_source_binding_unavailable; DROP TRIGGER viewer_reference_attempt_admission_unavailable');
      const requestJson=JSON.stringify(input.submission),o=input.coordinatorObservation,jobJson=JSON.stringify({jobId:o.jobId,generation:o.generation,environment:o.environment,manifestSha256:o.manifestSha256,pipelineDigest:o.pipelineDigest});
      db.prepare('INSERT INTO viewer_reference_attempt_journal(attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256,job_id,job_json,job_sha256) VALUES(?,?,?,?,?,?,?,?,?)').run(input.viewerAttemptId,input.submission.submissionId,intent.environment,requestJson,hash(requestJson),input.submission.manifest.sha256,intent.jobId,jobJson,hash(jobJson));
    }
    const processing = new ProcessingRepository(db), outbox=createAssociationOutboxFixture(processing,'isolated-association-outbox-fixture');
    const sourceFiles=Object.fromEntries(files.map(file=>[file.id,file.relativePath]));
    const registryEntry={issuer:intent.issuer,keyId:intent.keyId,purpose:'grant',audience:intent.audience,operation:intent.operation,revoked:false,notBefore:0,notAfter:2000,publicKeyDer:coordinatorKey};
    const args={scope:'isolated-v2-issuer-inspection',processing,bindingId:'binding',intentBytes:raw,signature,registryEntry,expectedIntent:intent,now:1050,submission:input.submission,capabilities:input.capabilities,optionsCatalog:input.optionsCatalog,sourceFiles,excludedIds:[],coordinatorObservation:input.coordinatorObservation,associationConfig:input.associationConfig};
    const privateKey=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,0x51)]),format:'der',type:'pkcs8'}),pub=crypto.createPublicKey(privateKey).export({format:'der',type:'spki'});
    if (input.mode === 'prepare-sign') outbox.prepareWithBinding(args,pub,{id:'binding',attemptId:input.viewerAttemptId,managedRoot});
    const result=outbox.signCommitted(args,pub,input.mode === 'replay' ? ()=>{throw new Error('unexpected signer invocation');} : message=>crypto.sign(null,message,privateKey));
    const output={schemaVersion:1,state:result.state,bodyBase64:result.body.toString('base64'),signatureBase64url:result.signature.toString('base64url'),viewerPublicKeySpkiDerHex:pub.toString('hex'),sqlitePath:dbPath};
    process.stdout.write(JSON.stringify(output)+'\n');
    if (process.env.VIEWER_ASSOC_FIXTURE_PAUSE_AFTER_COMMIT === '1') { process.stdout.write('FIXTURE_SIGNED_COMMIT\n'); process.kill(process.pid,'SIGSTOP'); }
  } finally { db.close(); }
}
try { main(readInput()); } catch { process.stderr.write('synthetic fixture unavailable\n'); process.exitCode=1; }
