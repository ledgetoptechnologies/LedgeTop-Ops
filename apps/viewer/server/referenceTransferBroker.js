'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Readable } = require('node:stream');
const p = require('./referenceProtocol');
const STORED_METADATA_LIMIT=p.LIMITS.metadataBytes, STORED_FILES_LIMIT=p.LIMITS.metadataBytes, STORED_IDENTITY_LIMIT=2*p.LIMITS.metadataBytes, STORED_AGGREGATE_LIMIT=4*p.LIMITS.metadataBytes, DATABASE_GRANT_LIMIT=64*1024*1024;
function validateStoredSizes(metadata,files,identity){const sizes=[metadata,files,identity].map(x=>typeof x==='string'?Buffer.byteLength(x,'utf8'):Infinity);if(sizes[0]>STORED_METADATA_LIMIT||sizes[1]>STORED_FILES_LIMIT||sizes[2]>STORED_IDENTITY_LIMIT||sizes.reduce((a,b)=>a+b,0)>STORED_AGGREGATE_LIMIT)fail('GRANT_METADATA_LIMIT');}
function validateAggregateBytes(total,additional=0){if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(additional)||additional<0||total>DATABASE_GRANT_LIMIT-additional)fail('GRANT_STORAGE_LIMIT');}
function grantBytes(db){const row=db.prepare('SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))+length(CAST(files AS BLOB))+length(CAST(identity AS BLOB))),0) AS n FROM reference_grants').get();validateAggregateBytes(row.n);return row.n;}
function checkedGrant(db,id){
 const lengths=db.prepare('SELECT length(CAST(metadata AS BLOB)) m,length(CAST(files AS BLOB)) f,length(CAST(identity AS BLOB)) i FROM reference_grants WHERE id=?').get(id);if(!lengths)return null;
 if(![lengths.m,lengths.f,lengths.i].every(x=>Number.isSafeInteger(x)&&x>=0)||lengths.m>STORED_METADATA_LIMIT||lengths.f>STORED_FILES_LIMIT||lengths.i>STORED_IDENTITY_LIMIT||lengths.m+lengths.f+lengths.i>STORED_AGGREGATE_LIMIT)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
 const row=db.prepare('SELECT * FROM reference_grants WHERE id=?').get(id);let meta,files,identity;try{meta=JSON.parse(row.metadata);files=JSON.parse(row.files);identity=JSON.parse(row.identity)}catch{fail('TRANSFER_ACCOUNTING_UNAVAILABLE')}
 const keys=['jobId','generation','reservationId','manifestSha256','environment','objectIds','nonce','byteBudget','expiresAt'];
 if(!meta||Array.isArray(meta)||Object.keys(meta).length!==keys.length||keys.some(k=>!Object.hasOwn(meta,k))||meta.jobId!==row.job_id||meta.reservationId!==row.reservation_id||!Array.isArray(meta.objectIds)||meta.objectIds.length>p.LIMITS.objects||new Set(meta.objectIds).size!==meta.objectIds.length||!files||Array.isArray(files)||typeof files!=='object'||Object.keys(files).length!==meta.objectIds.length||!identity||typeof identity.capabilityFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(identity.capabilityFingerprint)||JSON.stringify(meta)!==row.metadata||JSON.stringify(files)!==row.files||JSON.stringify({metadata:meta,files,capabilityFingerprint:identity.capabilityFingerprint})!==row.identity)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
 for(const id of meta.objectIds){const file=files[id];if(typeof id!=='string'||!Object.hasOwn(files,id)||!file||Object.keys(file).length!==3||typeof file.path!=='string'||!path.isAbsolute(file.path)||!Number.isSafeInteger(file.byteSize)||file.byteSize<0||!/^[a-f0-9]{64}$/.test(file.sha256))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');}
 return {row,metadata:meta,files};
}
class ReferenceTransferError extends Error {
  constructor(code) { super(code); this.name = 'ReferenceTransferError'; this.code = code; }
}
const fail = code => { throw new ReferenceTransferError(code); };
// readObject returns a paused Readable in body. Consume or destroy it; destroy/EOF/error
// releases the unconsumed reservation. Bytes pushed into the stream count as spent,
// including buffered bytes on cancellation. No plaintext token is recoverable on retry.
const ERROR_CODES = Object.freeze(['INVALID_INTEGER','INVALID_ID','EXTRA_FIELDS','INVALID_ENVIRONMENT','INVALID_LIMIT','DURABLE_DATABASE_REQUIRED','UNSAFE_SOURCE','SYMLINK_SOURCE','SOURCE_UNAVAILABLE','RESERVATION_REQUIRED','CAPABILITY_BINDING','INVALID_EXPIRY','RESERVATION_BINDING','OBJECT_SET_BINDING','STALE_RESERVATION','INVALID_REQUEST','UNAUTHORIZED','OBJECT_NOT_GRANTED','INVALID_RANGE','TRANSFER_LIMIT','SOURCE_CHANGED','TRANSFER_ACCOUNTING_UNAVAILABLE','GRANT_METADATA_LIMIT','GRANT_STORAGE_LIMIT']);
function safeInt(n) { if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_INTEGER'); return n; }
function slug(s) { if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)) fail('INVALID_ID'); }
function exact(o, fields) { if (!o || typeof o !== 'object' || Array.isArray(o) || ![Object.prototype,null].includes(Object.getPrototypeOf(o)) || Object.keys(o).some(k => !fields.includes(k))) fail('EXTRA_FIELDS'); }
class ReferenceTransferBroker {
  constructor({ databasePath, managedRoot, environment, now = Date.now, maxGrantTtlMs = 300000, maxConcurrentRequests = 2, maxConcurrentBytes = 67108864, maxResponseBytes = 16777216, maxRequests = 100, allowCreate = false }) {
    if (!['staging', 'production'].includes(environment)) fail('INVALID_ENVIRONMENT');
    this.environment = environment; this.now = now; this.root = fs.realpathSync(managedRoot);
    this.streams = new Set();
    this.settings = { maxGrantTtlMs, maxConcurrentRequests, maxConcurrentBytes, maxResponseBytes, maxRequests };
    for (const v of Object.values(this.settings)) if (!safeInt(v)) fail('INVALID_LIMIT');
    if (typeof databasePath !== 'string' || databasePath === ':memory:') fail('DURABLE_DATABASE_REQUIRED');
    const grantsSql='CREATE TABLE reference_grants (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, reservation_id TEXT NOT NULL, identity TEXT NOT NULL, token_hash TEXT NOT NULL, metadata TEXT NOT NULL, files TEXT NOT NULL, expires_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, used_bytes INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, in_flight INTEGER NOT NULL DEFAULT 0)';
    const indexSql='CREATE INDEX reference_grants_job ON reference_grants(job_id)';
    const usageSql='CREATE TABLE reference_job_usage (job_id TEXT PRIMARY KEY, environment TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, byte_limit INTEGER NOT NULL, request_limit INTEGER NOT NULL, charged_bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0)';
    const inspect=db=>{
      const names=['reference_grants','reference_grants_job','reference_job_usage'];
      const rows=names.map(name=>db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE').all(name));
      if(rows.every(x=>x.length===0))return false;
      const expected=[['table',grantsSql],['index',indexSql],['table',usageSql]];
      if(rows.some((x,i)=>x.length!==1||x[0].name!==names[i]||x[0].type!==expected[i][0]||x[0].sql!==expected[i][1]))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const extra=db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','index') AND sql IS NOT NULL AND tbl_name COLLATE NOCASE IN ('reference_grants','reference_job_usage') AND name<>'reference_grants_job' LIMIT 1").get();
      if(extra)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      grantBytes(db);
      const grants=db.prepare('SELECT id,job_id,used_bytes,reserved_bytes,requests,in_flight FROM reference_grants LIMIT 10001').iterate(),jobs=db.prepare('SELECT * FROM reference_job_usage LIMIT 10001').all(),jobMap=new Map(jobs.map(job=>[job.job_id,job])),sums=new Map();
      if(jobs.length>10000)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');let grantCount=0;
      for(const grant of grants){if(++grantCount>10000)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');const metadata=checkedGrant(db,grant.id)?.metadata,usage=jobMap.get(grant.job_id);if(!metadata||!usage||metadata.manifestSha256!==usage.manifest_sha256||metadata.environment!==usage.environment||![grant.used_bytes,grant.reserved_bytes,grant.requests,grant.in_flight].every(x=>Number.isSafeInteger(x)&&x>=0)||grant.in_flight>grant.requests)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');const total=sums.get(grant.job_id)||{bytes:0,requests:0};total.bytes+=grant.used_bytes+grant.reserved_bytes;total.requests+=grant.requests;if(!Number.isSafeInteger(total.bytes)||!Number.isSafeInteger(total.requests))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');sums.set(grant.job_id,total);}

      for(const job of jobs){const sum=sums.get(job.job_id)||{bytes:0,requests:0};if(!['staging','production'].includes(job.environment)||!/^([a-f0-9]{64})$/.test(job.manifest_sha256)||![job.byte_limit,job.request_limit,job.charged_bytes,job.requests].every(x=>Number.isSafeInteger(x)&&x>=0)||job.charged_bytes>job.byte_limit||job.requests>job.request_limit||sum.bytes>job.charged_bytes||sum.requests!==job.requests)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');}
      return true;
    };
    // A fresh database must be explicitly authorized and created exclusively.
    let fresh=false;
    if(!fs.existsSync(databasePath)){if(allowCreate!==true)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');let fd;try{fd=fs.openSync(databasePath,'wx',0o600);fresh=true}finally{if(fd!==undefined)fs.closeSync(fd)}}
    if(!fresh){let probe;try{probe=new DatabaseSync(databasePath,{readOnly:true});probe.exec('BEGIN');if(!inspect(probe))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');probe.exec('COMMIT')}catch(error){if(error instanceof ReferenceTransferError)throw error;fail('TRANSFER_ACCOUNTING_UNAVAILABLE')}finally{probe?.close()}}
    this.db = new DatabaseSync(databasePath);
    try{
      if(fresh)this.db.exec('PRAGMA journal_mode=WAL');
      else if(String(this.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase()!=='wal')fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const existing=inspect(this.db);if(fresh){if(existing)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');this.db.exec(`${grantsSql}; ${indexSql}; ${usageSql};`)}else if(!existing)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK')}catch{}this.db.close();if(error instanceof ReferenceTransferError)throw error;fail('TRANSFER_ACCOUNTING_UNAVAILABLE');}

  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  source(file) {
    try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) fail('UNSAFE_SOURCE');
    const relative = path.relative(this.root, path.resolve(file));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) fail('UNSAFE_SOURCE');
    let cursor = this.root;
    for (const part of relative.split(path.sep)) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) fail('SYMLINK_SOURCE'); }
    const real = fs.realpathSync(file); if (real !== path.resolve(file)) fail('UNSAFE_SOURCE');
    if (!fs.statSync(real).isFile()) fail('UNSAFE_SOURCE'); return real;
    } catch (error) { if (error instanceof ReferenceTransferError) throw error; fail('SOURCE_UNAVAILABLE'); }
  }
  mintGrant(input) { return this.#mintGrant(input, fn => this.tx(fn)); }
  #mintGrant(input, transact) {
    exact(input, ['jobId', 'generation', 'manifest', 'reservation', 'reservationAvailable', 'objectFiles', 'capabilities', 'capabilityFingerprint', 'replace']);
    const { jobId, generation, manifest, reservation, objectFiles, capabilities } = input;
    if (input.reservationAvailable !== true || !reservation) fail('RESERVATION_REQUIRED');
    slug(jobId); safeInt(generation); p.validateCapabilities(capabilities); p.validateManifest(manifest);
    if (capabilities.environment !== this.environment || input.capabilityFingerprint !== capabilities.capabilityFingerprint) fail('CAPABILITY_BINDING');
    p.validateTransferRequest(reservation);
    const expires = Date.parse(reservation.expiresAt), now = safeInt(this.now());
    if (expires <= now || expires - now > this.settings.maxGrantTtlMs) fail('INVALID_EXPIRY');
    if (reservation.generation !== generation || reservation.manifestSha256 !== manifest.sha256) fail('RESERVATION_BINDING');
    p.validateTransferByteBudget(manifest.totalBytes, reservation.byteBudget);
    if (!objectFiles || typeof objectFiles !== 'object' || Array.isArray(objectFiles) || Object.keys(objectFiles).length !== manifest.objects.length) fail('OBJECT_SET_BINDING');
    const files = {};
    for (const o of manifest.objects) { if (!Object.hasOwn(objectFiles, o.id)) fail('OBJECT_SET_BINDING'); files[o.id] = { path: this.source(objectFiles[o.id]), byteSize: o.byteSize, sha256: o.sha256 }; }
    const metadata = { jobId, generation, reservationId: reservation.reservationId, manifestSha256: manifest.sha256, environment: this.environment, objectIds: manifest.objects.map(o => o.id), nonce: reservation.nonce, byteBudget: reservation.byteBudget, expiresAt: reservation.expiresAt };
    const metadataJson=JSON.stringify(metadata),filesJson=JSON.stringify(files),identity=JSON.stringify({ metadata, files, capabilityFingerprint: input.capabilityFingerprint });
    validateStoredSizes(metadataJson,filesJson,identity);
    return transact(() => {
      const usage=this.db.prepare('SELECT * FROM reference_job_usage WHERE job_id=?').get(jobId);
      const legacy=this.db.prepare('SELECT 1 FROM reference_grants WHERE job_id=? LIMIT 1').get(jobId);
      if(!usage&&legacy)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const byteLimit=p.transferByteBudgetLimit(manifest.totalBytes);
      if(usage&&(usage.environment!==this.environment||usage.manifest_sha256!==manifest.sha256||usage.byte_limit!==byteLimit||usage.request_limit!==this.settings.maxRequests))fail('RESERVATION_BINDING');
      if(!usage&&this.db.prepare('SELECT COUNT(*) AS n FROM reference_job_usage').get().n>=10000)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      if(!usage)this.db.prepare('INSERT INTO reference_job_usage(job_id,environment,manifest_sha256,byte_limit,request_limit) VALUES(?,?,?,?,?)').run(jobId,this.environment,manifest.sha256,byteLimit,this.settings.maxRequests);
      const previousId=this.db.prepare('SELECT id FROM reference_grants WHERE job_id=? AND revoked=0 AND expires_ms>? ORDER BY rowid DESC LIMIT 1').get(jobId,now);const previous=previousId?checkedGrant(this.db,previousId.id).row:null;
      if (previous && previous.identity === identity && input.replace !== true) return { grantId: previous.id, grant: JSON.parse(previous.metadata), reused: true, tokenRecoverable: false };
      const latestId=this.db.prepare('SELECT id FROM reference_grants WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(jobId);const latest=latestId?checkedGrant(this.db,latestId.id).row:null;
      if (latest) {
        const latestMeta = JSON.parse(latest.metadata);
        if (latestMeta.manifestSha256 !== metadata.manifestSha256 || latest.files !== filesJson) fail('RESERVATION_BINDING');
        let seen=false;for(const prior of this.db.prepare('SELECT id FROM reference_grants WHERE job_id=?').iterate(jobId)){if(checkedGrant(this.db,prior.id).metadata.nonce===reservation.nonce){seen=true;break;}}
        if (generation < latestMeta.generation || (seen && (latestMeta.nonce !== reservation.nonce || latest.revoked || latest.expires_ms <= now))) fail('STALE_RESERVATION');
      }
      if(this.db.prepare('SELECT COUNT(*) AS n FROM reference_grants').get().n>=10000)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      validateAggregateBytes(grantBytes(this.db),Buffer.byteLength(metadataJson)+Buffer.byteLength(filesJson)+Buffer.byteLength(identity));
      this.db.prepare('UPDATE reference_grants SET revoked=1 WHERE job_id=?').run(jobId);
      const grantId = randomUUID(), token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO reference_grants(id,job_id,reservation_id,identity,token_hash,metadata,files,expires_ms) VALUES(?,?,?,?,?,?,?,?)').run(grantId, jobId, reservation.reservationId, identity, p.sha256(Buffer.from(token)), metadataJson, filesJson, expires);
      return { grantId, grant: { ...metadata, token }, reused: false, tokenRecoverable: true };
    });
  }
  // Explicitly synthetic and unmounted. This is not authenticated authority,
  // a production migration, anti-rollback, or a source custody guarantee.
  migrateAtomicGrantFixture(scope) {
    if(scope!=='synthetic-only') fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    this.tx(()=>this.db.exec("CREATE TABLE IF NOT EXISTS fixture_atomic_grants (operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, generation INTEGER NOT NULL, reservation_id TEXT NOT NULL, binding BLOB NOT NULL, key_id TEXT NOT NULL, version INTEGER NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL, grant_sha256 TEXT NOT NULL, UNIQUE(job_id,generation,reservation_id), UNIQUE(key_id,nonce)); CREATE TABLE IF NOT EXISTS fixture_atomic_delivery (operation_id TEXT PRIMARY KEY REFERENCES fixture_atomic_grants(operation_id), state TEXT NOT NULL CHECK(state IN ('prepared','sending','uncertain','acknowledged')), sender_generation INTEGER NOT NULL DEFAULT 0, ack_sha256 TEXT)"));
  }
  mintGrantAndSealFixture({scope,operationId,binding,input,verifyReservation,verifySourcePin,keyProvider}={}) {
    if(scope!=='synthetic-only'||typeof operationId!=='string'||!operationId||!binding||typeof verifyReservation!=='function'||typeof verifySourcePin!=='function'||typeof keyProvider!=='function')fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    const keyInfo=keyProvider();if(!keyInfo||typeof keyInfo.keyId!=='string'||!keyInfo.keyId||!Buffer.isBuffer(keyInfo.key)||keyInfo.key.length!==32)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    exact(binding,['attemptId','environment','jobId','generation','reservationId','manifestSha256','objectIds']);
    if(Object.keys(binding).length!==7||!input?.manifest||!input.reservation||binding.environment!==this.environment||binding.jobId!==input.jobId||binding.generation!==input.generation||binding.reservationId!==input.reservation.reservationId||binding.manifestSha256!==input.manifest.sha256||!Array.isArray(binding.objectIds)||JSON.stringify(binding.objectIds)!==JSON.stringify(input.manifest.objects.map(x=>x.id))||typeof binding.attemptId!=='string'||!binding.attemptId)fail('RESERVATION_BINDING');
    const aad=p.canonicalBytes({domain:'synthetic-atomic-grant-v1',version:1,keyId:keyInfo.keyId,binding});
    return this.tx(()=>{
      if(verifyReservation({operationId,binding,input})!==true||verifySourcePin({operationId,binding,input})!==true)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const old=this.db.prepare('SELECT * FROM fixture_atomic_grants WHERE operation_id=?').get(operationId);
      if(old){if(old.key_id!==keyInfo.keyId||old.version!==1||!Buffer.from(old.binding).equals(aad))fail('RESERVATION_BINDING');try{const d=createDecipheriv('aes-256-gcm',keyInfo.key,old.nonce);d.setAAD(aad);d.setAuthTag(old.tag);const bytes=Buffer.concat([d.update(old.ciphertext),d.final()]);if(p.sha256(bytes)!==old.grant_sha256)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');return bytes;}catch{fail('TRANSFER_ACCOUNTING_UNAVAILABLE');}}
      const minted=this.#mintGrant(input,fn=>fn());if(minted.reused||!minted.grant?.token)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const bytes=p.canonicalBytes(minted.grant),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyInfo.key,nonce);cipher.setAAD(aad);const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
      this.db.prepare('INSERT INTO fixture_atomic_grants VALUES(?,?,?,?,?,?,1,?,?,?,?)').run(operationId,input.jobId,input.generation,input.reservation.reservationId,aad,keyInfo.keyId,nonce,encrypted,cipher.getAuthTag(),p.sha256(bytes));this.db.prepare("INSERT INTO fixture_atomic_delivery(operation_id,state) VALUES(?,'prepared')").run(operationId);return bytes;
    });
  }
  beginAtomicDeliveryFixture({scope,operationId,senderGeneration}={}) {
    if(scope!=='synthetic-only'||typeof operationId!=='string'||!Number.isSafeInteger(senderGeneration)||senderGeneration<1)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    return this.tx(()=>{const result=this.db.prepare("UPDATE fixture_atomic_delivery SET state='sending',sender_generation=? WHERE operation_id=? AND state='prepared' AND sender_generation=0").run(senderGeneration,operationId);if(result.changes!==1)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');return true;});
  }
  // Synthetic receiver-only replay. A generation is not a real sender fence.
  reclaimAtomicDeliveryFixture({scope,operationId,senderGeneration}={}) {
    if(scope!=='synthetic-only'||typeof operationId!=='string'||!Number.isSafeInteger(senderGeneration)||senderGeneration<1)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    return this.tx(()=>{const result=this.db.prepare("UPDATE fixture_atomic_delivery SET state='sending',sender_generation=? WHERE operation_id=? AND state IN ('sending','uncertain') AND sender_generation<?").run(senderGeneration,operationId,senderGeneration);if(result.changes!==1)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');return true;});
  }
  markAtomicDeliveryUncertainFixture({scope,operationId,senderGeneration}={}) {
    if(scope!=='synthetic-only')fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    return this.tx(()=>{if(this.db.prepare("UPDATE fixture_atomic_delivery SET state='uncertain' WHERE operation_id=? AND state='sending' AND sender_generation=?").run(operationId,senderGeneration).changes!==1)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');return true;});
  }
  acknowledgeAtomicDeliveryFixture({scope,operationId,senderGeneration,ack,keyProvider,verifyReceiver}={}) {
    if(scope!=='synthetic-only'||typeof keyProvider!=='function'||typeof verifyReceiver!=='function'||!ack||typeof ack!=='object'||Array.isArray(ack))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    const keys=['accepted','generation','grantSha256','manifestSha256','nonce','reservationId'];if(JSON.stringify(Object.keys(ack).sort())!==JSON.stringify(keys))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    return this.tx(()=>{const row=this.db.prepare('SELECT g.*,d.state,d.sender_generation,d.ack_sha256 FROM fixture_atomic_grants g JOIN fixture_atomic_delivery d USING(operation_id) WHERE g.operation_id=?').get(operationId);const k=keyProvider();if(!row||!k||k.keyId!==row.key_id||!Buffer.isBuffer(k.key)||k.key.length!==32||row.version!==1||row.sender_generation!==senderGeneration||verifyReceiver({operationId,ack})!==true)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      let grant;try{const d=createDecipheriv('aes-256-gcm',k.key,row.nonce);d.setAAD(Buffer.from(row.binding));d.setAuthTag(row.tag);const bytes=Buffer.concat([d.update(row.ciphertext),d.final()]);if(p.sha256(bytes)!==row.grant_sha256)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');grant=JSON.parse(bytes.toString('utf8'));}catch{fail('TRANSFER_ACCOUNTING_UNAVAILABLE');}
      if(ack.accepted!==true||ack.reservationId!==grant.reservationId||ack.generation!==grant.generation||ack.manifestSha256!==grant.manifestSha256||ack.nonce!==grant.nonce||ack.grantSha256!==row.grant_sha256)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');const hash=p.sha256(p.canonicalBytes(ack));
      if(row.state==='acknowledged'){if(row.ack_sha256!==hash)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');return true;}
      if(!['sending','uncertain'].includes(row.state))fail('TRANSFER_ACCOUNTING_UNAVAILABLE');if(this.db.prepare("UPDATE fixture_atomic_delivery SET state='acknowledged',ack_sha256=? WHERE operation_id=? AND state IN ('sending','uncertain') AND sender_generation=?").run(hash,operationId,senderGeneration).changes!==1)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');return true;});
  }
  revokeGrant(grantId) { slug(grantId); this.db.prepare('UPDATE reference_grants SET revoked=1 WHERE id=?').run(grantId); }
  async readAuthorizedObject(request) {
    exact(request, ['objectId', 'authorization', 'method', 'range', 'query']);
    const authorization = request.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail('UNAUTHORIZED');
    const tokenHash = p.sha256(Buffer.from(authorization.slice(7)));
    const row = this.db.prepare('SELECT id FROM reference_grants WHERE token_hash=? AND revoked=0 AND expires_ms>?').get(tokenHash, this.now());
    if (!row) fail('UNAUTHORIZED');
    return this.readObject({ ...request, grantId: row.id });
  }
  async readObject(request) {
    exact(request, ['grantId', 'objectId', 'authorization', 'method', 'range', 'query']);
    const { grantId, objectId, authorization, range } = request; slug(grantId); slug(objectId);
    if (request.method !== 'GET' || (request.query !== undefined && (!request.query || typeof request.query !== 'object' || Array.isArray(request.query) || ![Object.prototype,null].includes(Object.getPrototypeOf(request.query)) || Object.keys(request.query).length))) fail('INVALID_REQUEST');
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail('UNAUTHORIZED');
    const tokenHash = p.sha256(Buffer.from(authorization.slice(7)));
    let reserved;
    this.tx(() => {
      const checked=checkedGrant(this.db,grantId),row=checked?.row;
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(tokenHash)) || row.revoked || row.expires_ms <= this.now()) fail('UNAUTHORIZED');
      const metadata=checked.metadata,files=checked.files,file=files[objectId]; if (!file || !metadata.objectIds.includes(objectId)) fail('OBJECT_NOT_GRANTED');
      const totalBytes = metadata.objectIds.reduce((sum, id) => sum + BigInt(files[id].byteSize), 0n);
      if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) fail('RESERVATION_BINDING');
      p.validateTransferByteBudget(Number(totalBytes), metadata.byteBudget);
      let start = 0, end = file.byteSize - 1;
      if (range !== undefined) {
        if (typeof range !== 'string' || !/^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)?$/.test(range)) fail('INVALID_RANGE');
        const match = /^bytes=(\d+)-(\d*)$/.exec(range); start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
        safeInt(start); safeInt(end); if (start > end || end >= file.byteSize) fail('INVALID_RANGE');
      }
      const length = file.byteSize === 0 && range === undefined ? 0 : end - start + 1;
      const totals = this.db.prepare('SELECT COALESCE(SUM(in_flight),0) requests, COALESCE(SUM(reserved_bytes),0) bytes FROM reference_grants').get();
      const usage=this.db.prepare('SELECT * FROM reference_job_usage WHERE job_id=?').get(row.job_id);
      if(!usage||usage.environment!==this.environment||usage.manifest_sha256!==metadata.manifestSha256)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      if (length > this.settings.maxResponseBytes || totals.requests >= this.settings.maxConcurrentRequests || totals.bytes + length > this.settings.maxConcurrentBytes || row.used_bytes + row.reserved_bytes + length > metadata.byteBudget || row.requests >= this.settings.maxRequests || usage.requests>=usage.request_limit || length>usage.byte_limit-usage.charged_bytes) fail('TRANSFER_LIMIT');
      // Charge the full reservation before opening the source. It is never
      // refunded, even if a process dies or a stream is cancelled; no crash
      // can manufacture fresh budget across grant epochs.
      this.db.prepare('UPDATE reference_job_usage SET charged_bytes=charged_bytes+?,requests=requests+1 WHERE job_id=?').run(length,row.job_id);
      this.db.prepare('UPDATE reference_grants SET reserved_bytes=reserved_bytes+?,requests=requests+1,in_flight=in_flight+1 WHERE id=?').run(length, grantId);
      reserved = { file, start, end, length, partial: range !== undefined };
    });
    let handle, handedOff = false;
    const release = () => { if (reserved) { this.db.prepare('UPDATE reference_grants SET reserved_bytes=reserved_bytes-?,in_flight=in_flight-1 WHERE id=?').run(reserved.remaining ?? reserved.length, grantId); reserved = null; } };
    try {
      const source = this.source(reserved.file.path);
      handle = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true }); if (!before.isFile() || before.size !== BigInt(reserved.file.byteSize)) fail('SOURCE_CHANGED');
      const unchanged = stat => stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.ino === before.ino && stat.dev === before.dev;
      const blockSize = 65536, blockHashes = new Map();
      const readBlock = async offset => {
        const block = Buffer.alloc(Math.min(blockSize, reserved.file.byteSize - offset)); let filled = 0;
        while (filled < block.length) { const { bytesRead } = await handle.read(block, filled, block.length - filled, offset + filled); if (!bytesRead) fail('SOURCE_CHANGED'); filled += bytesRead; }
        return block;
      };
      // Verify the whole object first. Retain only hashes for blocks intersecting the
      // bounded requested range; never retain a full source copy or trust timestamps
      // as proof of content identity. Each served buffer is rehashed before delivery.
      const { createHash } = require('node:crypto'); const digest = createHash('sha256'); let offset = 0;
      while (offset < reserved.file.byteSize) {
        const block = await readBlock(offset); digest.update(block);
        if (offset <= reserved.end && offset + block.length > reserved.start) blockHashes.set(offset, p.sha256(block));
        offset += block.length;
        const active = this.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId); if (active.revoked || active.expires_ms <= this.now()) fail('UNAUTHORIZED');
      }
      if (digest.digest('hex') !== reserved.file.sha256) fail('SOURCE_CHANGED');
      const after = await handle.stat({ bigint: true }); if (!unchanged(after)) fail('SOURCE_CHANGED');
      this.source(reserved.file.path);
      const row = this.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId); if (row.revoked || row.expires_ms <= this.now()) fail('UNAUTHORIZED');
      reserved.remaining = reserved.length; let transferOffset = reserved.start, reading = false;
      const broker = this;
      const body = new Readable({ highWaterMark: 65536,
        read() {
          if (reading) return; reading = true;
          (async () => {
            if (!reserved || this.destroyed) return;
            if (!reserved.remaining) { if (!unchanged(await handle.stat({ bigint: true }))) fail('SOURCE_CHANGED'); this.push(null); return; }
            const active = broker.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId);
            if (active.revoked || active.expires_ms <= broker.now()) fail('UNAUTHORIZED');
            broker.source(reserved.file.path);
            const stat = await handle.stat({ bigint: true }); if (!unchanged(stat)) fail('SOURCE_CHANGED');
            const blockOffset = Math.floor(transferOffset / blockSize) * blockSize;
            const block = await readBlock(blockOffset);
            if (p.sha256(block) !== blockHashes.get(blockOffset)) fail('SOURCE_CHANGED');
            const withinBlock = transferOffset - blockOffset;
            const chunk = block.subarray(withinBlock, withinBlock + Math.min(block.length - withinBlock, reserved.remaining));
            const bytesRead = chunk.length;
            if (this.destroyed || !reserved) return;
            const afterRead = await handle.stat({ bigint: true }); if (!unchanged(afterRead)) fail('SOURCE_CHANGED');
            if (this.destroyed || !reserved) return;
            const current = broker.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId);
            if (current.revoked || current.expires_ms <= broker.now()) fail('UNAUTHORIZED');
            const charged=broker.db.prepare('UPDATE reference_grants SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+? WHERE id=? AND revoked=0 AND expires_ms>? AND reserved_bytes>=?').run(bytesRead,bytesRead,grantId,broker.now(),bytesRead);
            if(charged.changes!==1)fail('UNAUTHORIZED');
            reserved.remaining -= bytesRead; transferOffset += bytesRead; reading = false; this.push(chunk);
          })().catch(error => { reading = false; this.destroy(error instanceof ReferenceTransferError ? error : new ReferenceTransferError('SOURCE_UNAVAILABLE')); });
        },
        destroy(error, callback) {
          broker.streams.delete(this);
          try { release(); } catch (e) { error = error || e; }
          handle.close().then(() => callback(error), e => callback(error || e));
        }
      });
      this.streams.add(body); handedOff = true;
      const headers = { 'Content-Length': String(reserved.length), 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      if (reserved.partial) headers['Content-Range'] = `bytes ${reserved.start}-${reserved.end}/${reserved.file.byteSize}`;
      return { status: reserved.partial ? 206 : 200, headers, body };
    } catch(error) { if (error instanceof ReferenceTransferError) throw error; fail('SOURCE_UNAVAILABLE'); } finally {
      if (!handedOff) { if (handle) await handle.close(); release(); }
    }
  }
  close() { for (const stream of this.streams) stream.destroy(); this.db.close(); }
}
module.exports = { ReferenceTransferBroker, ReferenceTransferError, ERROR_CODES, validateStoredSizes, STORED_METADATA_LIMIT, STORED_FILES_LIMIT, STORED_IDENTITY_LIMIT, STORED_AGGREGATE_LIMIT, DATABASE_GRANT_LIMIT, validateAggregateBytes };
