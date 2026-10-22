'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLLECTIONS = new Set(['spatial3d', 'map']);
const LIMITS = Object.freeze({ vertices: 2000, bytes: 256 * 1024, records: 1000 });
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => plain(v) && Object.keys(v).every((key) => allowed.includes(key));
function problem(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function jsonSafe(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  if (Array.isArray(value)) return value.length <= 2000 && value.every((v) => jsonSafe(v, depth + 1));
  return plain(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([k,v]) => !['__proto__','prototype','constructor'].includes(k) && k.length <= 80 && jsonSafe(v, depth + 1));
}
// Stable ordering makes a retried create independent of JSON object key order.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function validateMeasurement(input, { update = false } = {}) {
  if (!keys(input, ['id','name','collection','kind','vertices','coordinateReference','visible','source','results','displayPreferences', ...(update ? ['revision'] : [])])
      || !UUID.test(input.id || '') || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200
      || !COLLECTIONS.has(input.collection) || !['distance','polygon'].includes(input.kind)
      || !Array.isArray(input.vertices) || input.vertices.length < (input.kind === 'polygon' ? 3 : 2) || input.vertices.length > LIMITS.vertices
      || !input.vertices.every((vertex) => Array.isArray(vertex) && vertex.length === 3 && vertex.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9))
      || !keys(input.coordinateReference, ['crs','verticalUnit']) || typeof input.coordinateReference.crs !== 'string' || !input.coordinateReference.crs.trim() || input.coordinateReference.crs.length > 512
      || input.coordinateReference.verticalUnit !== 'm' || (input.visible !== undefined && typeof input.visible !== 'boolean')
      || (input.source !== undefined && (!keys(input.source, ['kind','assetId']) || (input.source.kind !== undefined && !['mesh','pointCloud','ortho','dsm','dtm','ept','glb','obj'].includes(input.source.kind)) || (input.source.assetId !== undefined && (typeof input.source.assetId !== 'string' || input.source.assetId.length > 200))))
      || (update && (!Number.isSafeInteger(input.revision) || input.revision < 1))
      || !jsonSafe(input) || Buffer.byteLength(JSON.stringify(input)) > LIMITS.bytes) throw problem('invalid_measurement');
  const doc = { id: input.id.toLowerCase(), name: input.name.trim(), collection: input.collection, kind: input.kind,
    vertices: input.vertices.map((v) => [...v]), coordinateReference: { ...input.coordinateReference }, visible: input.visible !== false,
    source: input.source || {} };
  if (input.results !== undefined) {
    if (!plain(input.results)) throw problem('invalid_measurement_results');
    // Browser results are never attested server calculations, regardless of their supplied labels.
    doc.results = { ...input.results, calculationOrigin: 'browser', verified: false };
  }
  if (input.displayPreferences !== undefined) {
    if (!keys(input.displayPreferences, ['units','showLabels','color']) || (input.displayPreferences.units !== undefined && !['imperial','metric','ft','ft-in','yd','m','cm'].includes(input.displayPreferences.units)) || (input.displayPreferences.showLabels !== undefined && typeof input.displayPreferences.showLabels !== 'boolean') || (input.displayPreferences.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.displayPreferences.color))) throw problem('invalid_display_preferences');
    doc.displayPreferences = { ...input.displayPreferences };
  }
  return stable(doc);
}

class MeasurementRepository {
  constructor(database) { this.database = database; }
  transaction(fn) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  owner(principal) { return [principal.modelId, principal.modelVersionId, principal.audience, principal.subject]; }
  view(row) {
    return row && !row.deleted_at ? { ...JSON.parse(row.document_json), modelId: row.model_id, modelVersionId: row.model_version_id,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  row(principal, id) {
    return this.database.prepare('SELECT * FROM private_measurements WHERE id=? AND model_id=? AND model_version_id=? AND owner_audience=? AND owner_subject=?').get(id, ...this.owner(principal));
  }
  get(principal, id) { return this.view(this.row(principal, id)); }
  list(principal, collection) {
    return this.database.prepare(`SELECT * FROM private_measurements WHERE model_id=? AND model_version_id=? AND owner_audience=? AND owner_subject=? AND deleted_at IS NULL ${collection ? 'AND collection=?' : ''} ORDER BY created_at,id LIMIT ?`).all(...this.owner(principal), ...(collection ? [collection] : []), LIMITS.records).map((row) => this.view(row));
  }
  create(principal, input) {
    const doc = validateMeasurement(input), serialized = JSON.stringify(doc), hash = crypto.createHash('sha256').update(serialized).digest('hex');
    return this.transaction(() => {
      const row = this.row(principal, doc.id);
      if (row) {
        if (row.deleted_at || row.creation_hash !== hash) throw problem('measurement_id_conflict', 409);
        return { measurement: this.view(row), replayed: true };
      }
      // UUID collision or a guessed ID never reveals another principal's document.
      if (this.database.prepare('SELECT 1 FROM private_measurements WHERE id=?').get(doc.id)) throw problem('measurement_id_conflict', 409);
      const count = this.database.prepare('SELECT count(*) n FROM private_measurements WHERE model_id=? AND model_version_id=? AND owner_audience=? AND owner_subject=? AND deleted_at IS NULL').get(...this.owner(principal)).n;
      if (count >= LIMITS.records) throw problem('measurement_limit_reached', 429);
      const now = new Date().toISOString();
      this.database.prepare('INSERT INTO private_measurements(id,model_id,model_version_id,owner_audience,owner_subject,collection,document_json,revision,creation_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)').run(doc.id,...this.owner(principal),doc.collection,serialized,hash,now,now);
      return { measurement: this.get(principal, doc.id), replayed: false };
    });
  }
  update(principal, id, input) {
    const doc = validateMeasurement(input, { update: true });
    if (doc.id !== id) throw problem('measurement_id_mismatch');
    return this.transaction(() => {
      const old = this.get(principal, id);
      if (!old) throw problem('measurement_not_found', 404);
      if (old.revision !== input.revision) throw problem('measurement_revision_conflict', 409);
      if (old.collection !== doc.collection || old.kind !== doc.kind || JSON.stringify(stable(old.coordinateReference)) !== JSON.stringify(stable(doc.coordinateReference))) throw problem('measurement_identity_immutable', 409);
      const now = new Date().toISOString();
      this.database.prepare('UPDATE private_measurements SET document_json=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(doc),now,id);
      this.database.prepare("UPDATE measurement_calculation_jobs SET status='cancelled',updated_at=? WHERE measurement_id=? AND status IN ('queued','running')").run(now,id);
      return this.get(principal, id);
    });
  }
  delete(principal, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw problem('measurement_revision_required', 428);
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!row) throw problem('measurement_not_found', 404);
      if (row.revision !== revision) throw problem('measurement_revision_conflict', 409);
      if (!row.deleted_at) {
        const now = new Date().toISOString();
        this.database.prepare("UPDATE private_measurements SET deleted_at=?,updated_at=?,document_json='{}' WHERE id=?").run(now,now,id);
        this.database.prepare("UPDATE measurement_calculation_jobs SET status='cancelled',result_json=NULL,request_json='{}',updated_at=? WHERE measurement_id=?").run(now,id);
      }
      return true;
    });
  }
}

module.exports = { MeasurementRepository, validateMeasurement, COLLECTIONS, LIMITS, problem };
