'use strict';
const { MeasurementSourceUnitEvidence } = require('./measurementSourceUnitEvidence');
const { registeredPointDerivativeInput } = require('./derivativeInputSnapshot');
const { canonicalJson, unitProofSha256, createEptConversionReceipt, validateEptConversionReceipt } = require('./eptConversionReceipt');

function fail(code) { throw Object.assign(new Error(code), { code }); }

class EptConversionReceiptRepository {
  constructor(processing) {
    this.processing = processing;
    this.database = processing.database;
    this.units = new MeasurementSourceUnitEvidence(this.database);
  }

  get(jobId) {
    const row = this.database.prepare('SELECT receipt_json,receipt_sha256,created_at FROM derivative_ept_conversion_receipts WHERE job_id=?').get(jobId);
    if (!row) return null;
    try {
      const receipt = JSON.parse(row.receipt_json);
      if (receipt.jobId !== jobId || receipt.createdAt !== row.created_at || unitProofSha256(receipt) !== row.receipt_sha256) fail('ept_conversion_receipt_invalid');
      return receipt;
    } catch { return fail('ept_conversion_receipt_invalid'); }
  }

  // Must run while holding the write transaction used for validation or insert.
  // The source, snapshot and accepted proof always come from authoritative DB
  // rows, never a caller-supplied proof or an imported assertion.
  bindings(jobId, owner, outputAsset, leaseToken) {
    if (!this.database.isTransaction) fail('ept_conversion_receipt_transaction_required');
    if (typeof leaseToken !== 'string' || !leaseToken) return null;
    const job = this.processing.derivativeLease(jobId, owner, leaseToken);
    if (!job || job.derivative_type !== 'ept') return null;
    const sourceBindings = this.nativeBindings(jobId);
    return sourceBindings ? { ...sourceBindings, outputAsset } : null;
  }

  nativeBindings(jobId) {
    const job = this.database.prepare("SELECT attempt_id FROM derivative_jobs WHERE id=? AND derivative_type='ept'").get(jobId);
    if (!job) return null;
    const context = this.database.prepare(`SELECT a.id attempt_id,a.task_id,a.result_model_id model_id,a.result_model_version_id version_id
      FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id
      JOIN model_versions v ON v.id=a.result_model_version_id AND v.model_id=a.result_model_id
      JOIN models m ON m.id=a.result_model_id
      JOIN model_outputs o ON o.id=v.id AND o.model_id=m.id AND o.attempt_id=a.id AND o.task_id=t.id
      WHERE a.id=? AND a.status='derivatives' AND t.active_attempt_id=a.id AND o.status='staged'
      AND (m.active_version_id IS NULL OR m.active_version_id<>v.id)`).get(job.attempt_id);
    if (!context) return null;
    const inputSnapshot = this.processing.derivativeInputSnapshot(jobId);
    if (!inputSnapshot) return null;
    const assets = this.database.prepare("SELECT * FROM model_assets WHERE version_id=? AND kind='pointCloud'").all(context.version_id);
    let inputAsset;
    try { inputAsset = registeredPointDerivativeInput(inputSnapshot, assets); }
    catch { return null; }
    const source = { id: inputAsset.id, kind: 'pointCloud', sha256: inputAsset.sha256,
      byteSize: inputAsset.byte_size, manifestSha256: inputAsset.manifest_sha256 || '' };
    const summary = this.units.summary(context.model_id, context.version_id, source);
    if (!summary) return null;
    const inputUnitEvidence = this.units.get({ modelId: context.model_id, modelVersionId: context.version_id,
      source, coordinateReference: { crs: summary.crs } });
    if (!inputUnitEvidence) return null;
    return { jobId, attemptId: context.attempt_id, taskId: context.task_id, modelId: context.model_id,
      modelVersionId: context.version_id, inputAsset, inputSnapshot, inputUnitEvidence };
  }

  // A read-only planning hint for the worker's converter/metadata checks. It is
  // deliberately not authorization; create/persist/validate reload under lease.
  inputEvidence(jobId) { return this.nativeBindings(jobId)?.inputUnitEvidence || null; }

  // Creation is only called by the worker after observing conversion success,
  // source revalidation, output metadata inspection and verified output bytes.
  // This committed transaction must finish BEFORE filesystem promotion; callers
  // cannot nest it in asset registration and accidentally lose the crash receipt.
  create(jobId, owner, { converter, outputAsset }, { leaseToken } = {}) {
    if (this.database.isTransaction) fail('ept_conversion_receipt_requires_independent_commit');
    return this.processing.transaction(() => {
      const bindings = this.bindings(jobId, owner, outputAsset, leaseToken);
      if (!bindings) return null;
      const existing = this.get(jobId);
      if (existing) {
        if (!validateEptConversionReceipt(existing, { ...bindings, converter })) fail('ept_conversion_receipt_conflict');
        return existing;
      }
      const receipt = createEptConversionReceipt({ ...bindings, converter,
        generationLeaseToken: leaseToken, createdAt: new Date().toISOString() });
      this.insert(receipt);
      return receipt;
    });
  }

  persist(jobId, owner, receipt, { leaseToken, outputAsset } = {}) {
    if (this.database.isTransaction) fail('ept_conversion_receipt_requires_independent_commit');
    return this.processing.transaction(() => {
      const bindings = this.bindings(jobId, owner, outputAsset, leaseToken);
      if (!bindings) return null;
      if (!validateEptConversionReceipt(receipt, bindings)) fail('ept_conversion_receipt_invalid');
      const existing = this.get(jobId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(receipt)) fail('ept_conversion_receipt_conflict');
        return existing;
      }
      if (receipt.generationLeaseToken !== leaseToken) fail('ept_conversion_receipt_invalid');
      this.insert(receipt);
      return receipt;
    });
  }

  insert(receipt) {
    if (!this.database.isTransaction) fail('ept_conversion_receipt_transaction_required');
    this.database.prepare('INSERT INTO derivative_ept_conversion_receipts(job_id,receipt_json,receipt_sha256,created_at) VALUES(?,?,?,?)')
      .run(receipt.jobId, canonicalJson(receipt), unitProofSha256(receipt), receipt.createdAt);
  }

  // Registration/resume still has to freshly hash the actual output tree and
  // inspect its current metadata before passing its verified outputAsset here.
  validate(jobId, owner, outputAsset, { leaseToken } = {}) {
    const validate = () => {
      const bindings = this.bindings(jobId, owner, outputAsset, leaseToken);
      if (!bindings) return null;
      const receipt = this.get(jobId);
      return receipt && validateEptConversionReceipt(receipt, bindings) ? receipt : null;
    };
    return this.database.isTransaction ? validate() : this.processing.transaction(validate);
  }
}

module.exports = { EptConversionReceiptRepository };
