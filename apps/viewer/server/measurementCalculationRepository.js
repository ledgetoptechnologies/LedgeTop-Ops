'use strict';
const crypto = require('node:crypto');
const problem = (code, status = 400) => Object.assign(new Error(code), { code, status });
class MeasurementCalculationRepository {
  constructor(database) { this.database = database; }
  transaction(fn) { this.database.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.database.exec('COMMIT'); return result; } catch (e) { this.database.exec('ROLLBACK'); throw e; } }
  enqueue(measurement, request) {
    return this.transaction(() => {
      const current = this.database.prepare('SELECT revision FROM private_measurements WHERE id=? AND deleted_at IS NULL').get(measurement.id);
      if (current?.revision !== measurement.revision) throw problem('measurement_revision_conflict', 409);
      const active = this.database.prepare("SELECT (SELECT count(*) FROM measurement_calculation_jobs WHERE status IN ('queued','running'))+(SELECT count(*) FROM ephemeral_measurement_jobs WHERE status IN ('queued','running') AND expires_at>?) n").get(new Date().toISOString()).n;
      if (active >= 20) throw problem('measurement_queue_full', 429);
      const prior = this.database.prepare("SELECT * FROM measurement_calculation_jobs WHERE measurement_id=? AND revision=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(measurement.id, measurement.revision);
      if (prior) throw problem('measurement_calculation_already_active', 409);
      const id = crypto.randomUUID(), at = new Date().toISOString();
      // Keep at most twenty terminal calculations per record. Retain the
      // numerical provenance with each remaining result, not unbounded private
      // geometry/capability snapshots from every historical button press.
      const terminal=this.database.prepare("SELECT id FROM measurement_calculation_jobs WHERE measurement_id=? AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC").all(measurement.id);
      const protectedIds=new Set([measurement.results?.calculationJobId,request.parentCalculationId,...this.database.prepare("SELECT json_extract(request_json,'$.parentCalculationId') AS parent FROM measurement_calculation_jobs WHERE measurement_id=? AND status IN ('queued','running')").all(measurement.id).map(row=>row.parent)].filter(Boolean));
      const keep=new Set(terminal.filter(row=>protectedIds.has(row.id)).map(row=>row.id));
      if(keep.size>19)throw problem('measurement_queue_full',429);
      for(const row of terminal){if(keep.size>=19)break;keep.add(row.id);}
      for(const row of terminal)if(!keep.has(row.id))this.database.prepare('DELETE FROM measurement_calculation_jobs WHERE id=? AND measurement_id=?').run(row.id,measurement.id);
      this.database.prepare("INSERT INTO measurement_calculation_jobs(id,measurement_id,revision,request_json,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)").run(id, measurement.id, measurement.revision, JSON.stringify(request), at, at);
      return this.get(measurement.id, id);
    });
  }
  get(measurementId, id) {
    const row = this.database.prepare('SELECT j.*,m.document_json AS current_document,m.revision AS current_revision,m.model_id AS current_model_id,m.model_version_id AS current_version_id FROM measurement_calculation_jobs j JOIN private_measurements m ON m.id=j.measurement_id WHERE j.id=? AND j.measurement_id=? AND m.deleted_at IS NULL').get(id, measurementId);
    if(!row)return null;
    const request=JSON.parse(row.request_json),reference=request.reference||{};
    const parameters={revision:row.revision,method:request.method,sourceAssetId:request.source?.id,reference:{type:reference.type,...(Number.isFinite(reference.elevationM)?{elevationM:reference.elevationM}:{}),...(Number.isFinite(reference.offsetM)?{offsetM:reference.offsetM}:{})},sourceVerticalUnit:request.sourceVerticalUnit||null,...(request.method==='surface-transect'?{parentCalculationId:request.parentCalculationId,parentRevision:request.parentRevision,line:request.line,baseHash:request.baseHash}:{})};
    if(request.source?.kind==='ept')Object.assign(parameters,{sourceKind:'ept',cellSizeM:request.cellSizeM,classFilter:request.classFilter||'all',requireEncodedVerticalUnits:request.requireEncodedVerticalUnits===true});
    const result=row.result_json?JSON.parse(row.result_json):null,document=JSON.parse(row.current_document);
    // Attaching a result is itself a document revision. Reuse only the exact
    // explicitly attached job, never any arbitrary historical result. Recheck
    // its immutable input geometry and registered source, not browser assertions.
    const geometry=value=>JSON.stringify([value.collection,value.vertices,[value.coordinateReference?.crs,value.coordinateReference?.verticalUnit]]);
    let attachmentRevision=null;
    if(row.status==='complete'&&['surface-cut-fill','point-surface-cut-fill'].includes(request.method)&&document.kind==='polygon'&&document.results?.calculationJobId===row.id&&row.current_revision>row.revision&&request.modelId===row.current_model_id&&request.modelVersionId===row.current_version_id&&geometry(document)===geometry(request)){
      const asset=this.database.prepare('SELECT version_id,kind,root_key,relative_path,sha256,byte_size,manifest_sha256 FROM model_assets WHERE id=?').get(request.source?.id||'');
      const pointMatches=request.method!=='point-surface-cut-fill'||(asset?.manifest_sha256===request.source.manifestSha256&&result?.source?.manifestSha256===request.source.manifestSha256&&result?.method===request.method);
      if(pointMatches&&asset&&asset.version_id===request.modelVersionId&&asset.kind===request.source.kind&&asset.root_key===request.source.rootKey&&asset.relative_path===request.source.relativePath&&asset.sha256===request.source.sha256&&asset.byte_size===request.source.byteSize&&result?.source?.assetId===request.source.id&&result.source.sha256===request.source.sha256&&result.source.kind===request.source.kind&&result.source.modelVersionId===request.modelVersionId)attachmentRevision=row.current_revision;
    }
    return { id: row.id, measurementId: row.measurement_id, revision: row.revision, method: request.method, parameters, attachmentRevision, status: row.status, result, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list(measurementId) {
    return this.database.prepare('SELECT j.id FROM measurement_calculation_jobs j JOIN private_measurements m ON m.id=j.measurement_id WHERE j.measurement_id=? AND m.deleted_at IS NULL ORDER BY j.created_at DESC,j.id DESC LIMIT 20').all(measurementId).map(row => this.get(measurementId, row.id));
  }
  parent(measurementId,id){if(typeof id!=='string')return null;const job=this.get(measurementId,id);if(!job)return null;const row=this.database.prepare('SELECT request_json FROM measurement_calculation_jobs WHERE id=? AND measurement_id=?').get(id,measurementId);return{job,request:JSON.parse(row.request_json)};}
  cancel(measurementId, id) {
    return this.database.prepare("UPDATE measurement_calculation_jobs SET request_json=json_remove(request_json,'$.authority'),status='cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND measurement_id=? AND status IN ('queued','running')").run(new Date().toISOString(), id, measurementId).changes === 1;
  }
  claim(owner, at = Date.now()) {
    return this.transaction(() => {
      const time = new Date(at).toISOString();
      if(this.database.prepare("SELECT 1 FROM ephemeral_measurement_jobs WHERE status='running' AND lease_expires_at>? AND expires_at>? LIMIT 1").get(time,time))return null;
      // Do not automatically replay a heavy job after process death. Its source
      // and authorization must be explicitly submitted again by the owner.
      this.database.prepare("UPDATE measurement_calculation_jobs SET request_json=json_remove(request_json,'$.authority'),status='failed',error_code='worker_interrupted',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=?").run(time, time);
      if (this.database.prepare("SELECT 1 FROM measurement_calculation_jobs WHERE status='running' LIMIT 1").get()) return null;
      // Reserve measurements only while existing processing lanes have no work
      // leased. Worker dispatch also prevents newly starting heavy local lanes.
      for (const table of ['dataset_operations','processing_jobs','derivative_jobs']) if (this.database.prepare(`SELECT 1 FROM ${table} WHERE status='leased' LIMIT 1`).get()) return null;
      this.database.prepare("UPDATE measurement_calculation_jobs SET request_json=json_remove(request_json,'$.authority'),status='cancelled',updated_at=? WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM private_measurements m WHERE m.id=measurement_calculation_jobs.measurement_id AND m.revision=measurement_calculation_jobs.revision AND m.deleted_at IS NULL)").run(time);
      const row = this.database.prepare("SELECT * FROM measurement_calculation_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
      if (!row) return null;
      const token = crypto.randomUUID();
      this.database.prepare("UPDATE measurement_calculation_jobs SET status='running',lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?").run(owner, token, new Date(at + 90_000).toISOString(), time, row.id);
      return { id: row.id, measurementId: row.measurement_id, revision: row.revision, request: JSON.parse(row.request_json), token };
    });
  }
  live(job, owner, at = Date.now()) {
    return Boolean(this.database.prepare("SELECT 1 FROM measurement_calculation_jobs j JOIN private_measurements m ON m.id=j.measurement_id WHERE j.id=? AND j.status='running' AND j.lease_owner=? AND j.lease_token=? AND j.lease_expires_at>? AND m.deleted_at IS NULL AND m.revision=j.revision").get(job.id, owner, job.token, new Date(at).toISOString()));
  }
  heartbeat(job, owner) {
    if (!this.live(job, owner)) return false;
    return this.database.prepare("UPDATE measurement_calculation_jobs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?").run(new Date(Date.now() + 90_000).toISOString(), job.id, owner, job.token).changes === 1;
  }
  finish(job, owner, result, errorCode = null) {
    return this.transaction(() => {
      if (!this.live(job, owner)) return false;
      return this.database.prepare("UPDATE measurement_calculation_jobs SET status=?,result_json=?,error_code=?,request_json=json_remove(request_json,'$.authority'),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=? AND lease_token=?").run(errorCode ? 'failed' : 'complete', result ? JSON.stringify(result) : null, errorCode, new Date().toISOString(), job.id, owner, job.token).changes === 1;
    });
  }
}
module.exports = { MeasurementCalculationRepository };
