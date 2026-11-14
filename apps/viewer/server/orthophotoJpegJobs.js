'use strict';

const crypto=require('node:crypto');
const path=require('node:path');
const TABLE='viewer_orthophoto_jpeg_jobs';
const POLICY_REVISION='cjpeg-white-baseline-noopt-q90-v1';
const MAX_DIMENSION=65500;
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const isId=value=>typeof value==='string'&&ID.test(value);
const isHash=value=>typeof value==='string'&&HASH.test(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(value,code)=>{if(!value)fail(code);};
const json=value=>JSON.stringify(value);
const sourceFingerprint=value=>crypto.createHash('sha256').update(json(value)).digest('hex');
const acknowledgedRollbacks=new WeakSet();
const rollbackConfirmed=error=>Boolean(error&&typeof error==='object'&&acknowledgedRollbacks.has(error));

// This module is a durable queue, not execution admission or file validation.
// Worker evidence hashes below are a TRUSTED-WORKER seam: the repository cannot
// prove their contents, physical child closure, source bytes or JPEG correctness.
// Queue membership grants no permissions. Inactive historical versions are
// intentionally excluded in this prototype. API/worker/download integration is
// separate work; no succeeded row alone establishes product acceptance.
class OrthophotoJpegJobs {
  constructor(database,{clock=Date.now}={}){this.database=database;this.clock=clock;}

  transaction(fn){
    this.database.exec('BEGIN IMMEDIATE');
    try{const value=fn();this.database.exec('COMMIT');return value;}
    catch(caught){
      const error=caught instanceof Error?caught:new Error('JPEG job transaction failed',{cause:caught});
      acknowledgedRollbacks.delete(error);
      try{this.database.exec('ROLLBACK');acknowledgedRollbacks.add(error);}
      catch{/* Preserve first failure; an unacknowledged rollback is unknown. */}
      throw error;
    }
  }

  now(){const value=this.clock();need(Number.isSafeInteger(value)&&value>=0,'invalid_job_clock');return value;}

  source(versionId,assetId){
    const row=this.database.prepare(`SELECT a.id assetId,a.version_id versionId,v.model_id modelId,
      a.kind,a.sha256,a.byte_size byteSize,a.root_key rootKey,a.relative_path relativePath,a.storage_mode storageMode
      FROM model_assets a JOIN model_versions v ON v.id=a.version_id JOIN models m ON m.id=v.model_id
      WHERE a.id=? AND a.version_id=? AND a.kind='ortho' AND v.status='ready'
      AND m.status='ready' AND m.unregistered_at IS NULL AND m.active_version_id=v.id`).get(assetId,versionId);
    if(!row)return null;
    if(!isId(row.assetId)||!isId(row.versionId)||!isId(row.modelId)||!isHash(row.sha256)||
       !Number.isSafeInteger(row.byteSize)||row.byteSize<=0||
       typeof row.rootKey!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.rootKey)||
       !['managed','adopted','external_reference'].includes(row.storageMode)||
       typeof row.relativePath!=='string'||!row.relativePath||row.relativePath.length>4096||
       /[\x00-\x1f\\:]/.test(row.relativePath)||row.relativePath.startsWith('/')||
       path.posix.normalize(row.relativePath)!==row.relativePath||
       row.relativePath.split('/').some(part=>part==='..'||part==='.')||
       !/^\.(tif|tiff)$/i.test(path.posix.extname(row.relativePath)))return null;
    return row;
  }

  get(id){return this.database.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id)||null;}

  events(id){return this.database.prepare(`SELECT * FROM ${TABLE}_events WHERE job_id=? ORDER BY sequence`).all(id);}

  record(row,phase,at,evidence={}){
    const raw=json(evidence);need(Buffer.byteLength(raw)<=16384,'job_evidence_bound');
    this.database.prepare(`INSERT INTO ${TABLE}_events(job_id,phase,owner,token,observed_unix_ms,evidence_json)
      VALUES (?,?,?,?,?,?)`).run(row.id,phase,row.lease_owner||null,row.lease_token||null,at,raw);
  }

  sourceMatches(row){
    const current=this.source(row.model_version_id,row.source_asset_id);
    return current&&json(current)===row.source_snapshot_json;
  }

  request({versionId,sourceAssetId,converterSha256,encoderSha256,width,height,expectedSourceFingerprint=null,onPersisted=null}){
    need(isId(versionId)&&isId(sourceAssetId)&&isHash(converterSha256)&&isHash(encoderSha256),'invalid_jpeg_job_identity');
    need(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&
      width<=MAX_DIMENSION&&height<=MAX_DIMENSION,'invalid_jpeg_job_dimensions');
    need(expectedSourceFingerprint===null||isHash(expectedSourceFingerprint),'invalid_jpeg_source_fingerprint');
    need(onPersisted===null||typeof onPersisted==='function','invalid_jpeg_job_persistence_callback');
    return this.transaction(()=>{
      const snapshot=this.source(versionId,sourceAssetId);need(snapshot,'jpeg_job_source_unavailable');
      need(expectedSourceFingerprint===null||sourceFingerprint(snapshot)===expectedSourceFingerprint,'jpeg_job_source_changed');
      const key=crypto.createHash('sha256').update(json({snapshot,converterSha256,encoderSha256,
        policyRevision:POLICY_REVISION,width,height})).digest('hex');
      const existing=this.database.prepare(`SELECT * FROM ${TABLE} WHERE request_key=?`).get(key);
      if(existing){const result={job:existing,replayed:true};onPersisted?.(result);return result;}
      const id=crypto.randomUUID(),at=this.now();
      this.database.prepare(`INSERT INTO ${TABLE}(id,request_key,model_id,model_version_id,source_asset_id,
        source_snapshot_json,converter_sha256,encoder_sha256,policy_revision,width,height,status,created_unix_ms,updated_unix_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id,key,snapshot.modelId,versionId,sourceAssetId,
          json(snapshot),converterSha256,encoderSha256,POLICY_REVISION,width,height,at,at);
      const row=this.get(id);this.record(row,'queued',at);
      const result={job:row,replayed:false};onPersisted?.(result);return result;
    });
  }

  expire(at){
    const row=this.database.prepare(`SELECT * FROM ${TABLE} WHERE status='leased'`).get();
    if(row&&(row.lease_expires_unix_ms<=at||row.deadline_unix_ms<=at)){
      this.database.prepare(`UPDATE ${TABLE} SET status='cleanup_required',error_code=COALESCE(error_code,'lease_expired'),
        updated_unix_ms=? WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=?`)
        .run(at,row.id,row.lease_owner,row.lease_token);
      this.record(row,'cleanup_required',at,{reason:'lease_expired'});
    }
  }

  claim({owner,leaseMs=30000,deadlineUnixMs}){
    need(typeof owner==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(owner),'invalid_jpeg_job_owner');
    need(Number.isSafeInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=60000,'invalid_jpeg_job_lease');
    return this.transaction(()=>{
      const at=this.now();need(Number.isSafeInteger(deadlineUnixMs)&&deadlineUnixMs>at&&
        deadlineUnixMs<=at+900000,'invalid_jpeg_job_deadline');
      this.expire(at);
      if(this.database.prepare(`SELECT 1 FROM ${TABLE} WHERE status IN ('leased','cleanup_required')`).get())return null;
      const queued=this.database.prepare(`SELECT * FROM ${TABLE} WHERE status='queued' ORDER BY created_unix_ms,id LIMIT 64`).all();
      for(const row of queued){
        if(!this.sourceMatches(row)){
          this.database.prepare(`UPDATE ${TABLE} SET status='failed',error_code='source_changed',updated_unix_ms=? WHERE id=? AND status='queued'`).run(at,row.id);
          this.record(row,'failed',at,{reason:'source_changed_before_claim'});continue;
        }
        const token=crypto.randomUUID(),expires=Math.min(at+leaseMs,deadlineUnixMs);
        const changed=this.database.prepare(`UPDATE ${TABLE} SET status='leased',lease_owner=?,lease_token=?,
          lease_expires_unix_ms=?,deadline_unix_ms=?,error_code=NULL,updated_unix_ms=? WHERE id=? AND status='queued'`)
          .run(owner,token,expires,deadlineUnixMs,at,row.id).changes;
        need(changed===1,'jpeg_job_claim_conflict');
        const leased=this.get(row.id);this.record(leased,'leased',at);return leased;
      }
      return null;
    });
  }

  owned(row,owner,token){return row&&row.lease_owner===owner&&row.lease_token===token;}

  heartbeat({jobId,owner,token,leaseMs=30000}){
    need(Number.isSafeInteger(leaseMs)&&leaseMs>=1000&&leaseMs<=60000,'invalid_jpeg_job_lease');
    return this.transaction(()=>{
      const at=this.now();this.expire(at);const row=this.get(jobId);
      if(!this.owned(row,owner,token)||row.status!=='leased')return false;
      return this.database.prepare(`UPDATE ${TABLE} SET lease_expires_unix_ms=?,updated_unix_ms=?
        WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=? AND lease_expires_unix_ms>?
        AND deadline_unix_ms>?`).run(Math.min(at+leaseMs,row.deadline_unix_ms),at,jobId,owner,token,at,at).changes===1;
    });
  }

  complete({jobId,owner,token,result}){
    need(result&&Object.keys(result).sort().join(',')===['byteSize','closureEvidenceSha256','converterSha256','encoderSha256',
      'height','policyRevision','sha256','sourceAssetId','sourceByteSize','sourceSha256','sourceVersionId',
      'width','workerValidationEvidenceSha256'].sort().join(','),'invalid_jpeg_job_result_fields');
    need(isHash(result.sha256)&&isHash(result.workerValidationEvidenceSha256)&&
      isHash(result.closureEvidenceSha256)&&Number.isSafeInteger(result.byteSize)&&result.byteSize>0,
      'invalid_jpeg_job_result');
    return this.transaction(()=>{
      const at=this.now();this.expire(at);const row=this.get(jobId);
      if(!this.owned(row,owner,token)||row.status!=='leased')return false;
      const snapshot=JSON.parse(row.source_snapshot_json);
      need(result.sourceAssetId===row.source_asset_id&&result.sourceVersionId===row.model_version_id&&
        result.sourceSha256===snapshot.sha256&&result.sourceByteSize===snapshot.byteSize&&
        result.converterSha256===row.converter_sha256&&result.encoderSha256===row.encoder_sha256&&
        result.policyRevision===row.policy_revision&&
        result.width===row.width&&result.height===row.height,'jpeg_job_result_binding');
      if(!this.sourceMatches(row)){
        this.database.prepare(`UPDATE ${TABLE} SET status='cleanup_required',error_code='source_changed',updated_unix_ms=? WHERE id=? AND status='leased'`).run(at,jobId);
        this.record(row,'cleanup_required',at,{reason:'source_changed_before_completion'});return false;
      }
      const changed=this.database.prepare(`UPDATE ${TABLE} SET status='succeeded',result_json=?,updated_unix_ms=?
        WHERE id=? AND status='leased' AND lease_owner=? AND lease_token=? AND lease_expires_unix_ms>?
        AND deadline_unix_ms>?`).run(json(result),at,jobId,owner,token,at,at).changes===1;
      if(changed)this.record(row,'succeeded',at,{workerValidationEvidenceSha256:result.workerValidationEvidenceSha256,
        closureEvidenceSha256:result.closureEvidenceSha256,physicalValidationEstablishedByRepository:false});
      return changed;
    });
  }

  closeLease({jobId,owner,token,closureEvidenceSha256,action,errorCode='worker_failed'}){
    need(isHash(closureEvidenceSha256)&&typeof owner==='string'&&
      /^[A-Za-z0-9_.:-]{1,128}$/.test(owner)&&typeof token==='string'&&
      /^[a-f0-9-]{36}$/.test(token)&&['fail','retry'].includes(action)&&
      typeof errorCode==='string'&&/^[a-z0-9_]{1,80}$/.test(errorCode),'invalid_jpeg_job_closure');
    return this.transaction(()=>{
      const at=this.now();this.expire(at);const row=this.get(jobId);
      if(!this.owned(row,owner,token)||!['leased','cleanup_required'].includes(row.status))return false;
      const retry=action==='retry'&&this.sourceMatches(row);
      this.database.prepare(`UPDATE ${TABLE} SET status=?,error_code=?,updated_unix_ms=? WHERE id=?
        AND status IN ('leased','cleanup_required') AND lease_owner=? AND lease_token=?`)
        .run(retry?'queued':'failed',retry?null:action==='retry'?'source_changed':errorCode,at,jobId,owner,token);
      this.record(row,retry?'closed_retry':'closed_failed',at,{closureEvidenceSha256,
        physicalClosureEstablishedByRepository:false});
      return true;
    });
  }
}

// Merger reserved migration47; exported hook only, registry owned elsewhere.
function migrateOrthophotoJpegJobs(database){
  database.exec(`CREATE TABLE ${TABLE} (
    id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,
    model_id TEXT NOT NULL,model_version_id TEXT NOT NULL,source_asset_id TEXT NOT NULL,
    source_snapshot_json TEXT NOT NULL,converter_sha256 TEXT NOT NULL,encoder_sha256 TEXT NOT NULL,policy_revision TEXT NOT NULL,
    width INTEGER NOT NULL CHECK(width>0 AND width<=65500),height INTEGER NOT NULL CHECK(height>0 AND height<=65500),
    status TEXT NOT NULL CHECK(status IN ('queued','leased','cleanup_required','succeeded','failed')),
    lease_owner TEXT,lease_token TEXT,lease_expires_unix_ms INTEGER,deadline_unix_ms INTEGER,
    result_json TEXT,error_code TEXT,created_unix_ms INTEGER NOT NULL,updated_unix_ms INTEGER NOT NULL,
    CHECK(status NOT IN ('leased','cleanup_required') OR
      (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_unix_ms IS NOT NULL AND deadline_unix_ms IS NOT NULL))
  );
  CREATE UNIQUE INDEX viewer_ortho_jpeg_single_active ON ${TABLE}((1)) WHERE status IN ('leased','cleanup_required');
  CREATE INDEX viewer_ortho_jpeg_queue ON ${TABLE}(status,created_unix_ms,id);
  CREATE TRIGGER viewer_ortho_jpeg_identity_immutable BEFORE UPDATE OF request_key,model_id,model_version_id,
    source_asset_id,source_snapshot_json,converter_sha256,encoder_sha256,policy_revision,width,height ON ${TABLE}
    BEGIN SELECT RAISE(ABORT,'JPEG job source and policy are immutable'); END;
  CREATE TABLE ${TABLE}_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,
    phase TEXT NOT NULL,owner TEXT,token TEXT,observed_unix_ms INTEGER NOT NULL,evidence_json TEXT NOT NULL);
  CREATE TRIGGER viewer_ortho_jpeg_events_no_update BEFORE UPDATE ON ${TABLE}_events
    BEGIN SELECT RAISE(ABORT,'JPEG job evidence is immutable'); END;
  CREATE TRIGGER viewer_ortho_jpeg_events_no_delete BEFORE DELETE ON ${TABLE}_events
    BEGIN SELECT RAISE(ABORT,'JPEG job evidence is retained'); END;`);
}

module.exports={OrthophotoJpegJobs,migrateOrthophotoJpegJobs,POLICY_REVISION,sourceFingerprint,rollbackConfirmed};
