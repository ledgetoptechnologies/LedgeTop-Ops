'use strict';
// Review-only held journal. No file copy, storage authority or admission.
const crypto = require('node:crypto');
const { canonicalBytes } = require('./referenceProtocol');
const { getHeldSourceSnapshot, verifyHeldSourceSnapshot } = require('./heldSourceSnapshot');
const { fileFacts } = require('./viewerPagedSourceExport');
const { assertCurrentSnapshotSource } = require('./preclaimSourceAttestation');
const fail = () => { throw Object.assign(new Error('generation held'), { code: 'GENERATION_HELD' }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const records = bytes => Buffer.from(bytes).toString('utf8').trimEnd().split('\n').flatMap(line => JSON.parse(line).records);

function prepareSelectedGeneration(processing, { attemptId, generation, snapshotId, snapshotSha256, publicKey, rootRef, selected } = {}) {
  // rootRef and publicKey are operator-provisioned inputs, never request authority.
  if (!processing?.database || !Number.isSafeInteger(generation) || generation < 1 || generation > 1000000
      || typeof rootRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(rootRef)
      || !Array.isArray(selected) || selected.length < 1 || selected.length > 10000) fail();
  return processing.transaction(() => {
    const snapshot = getHeldSourceSnapshot(processing, snapshotId);
    if (!snapshot || snapshot.status !== 'held' || snapshot.attemptId !== attemptId
        || snapshot.intentSha256 !== snapshotSha256 || !verifyHeldSourceSnapshot(snapshot, publicKey)) fail();
    const current = processing.database.prepare(`SELECT 1 FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id
      JOIN datasets d ON d.id=t.dataset_id JOIN projects p ON p.id=t.project_id
      WHERE a.id=? AND a.dataset_id=d.id AND t.id=? AND t.active_attempt_id=a.id AND d.id=?
        AND d.project_id=t.project_id AND d.status='finalized' AND d.storage_mode='managed' AND d.root_key='datasets'
        AND d.manifest_sha256=? AND p.status='active' AND p.purged_at IS NULL
        AND t.status NOT IN ('archived','failed','cancelled','published') AND t.purged_at IS NULL
        AND a.status NOT IN ('failed','cancelled','published')
        AND NOT EXISTS(SELECT 1 FROM storage_mutations m WHERE m.entity_type='dataset' AND m.entity_id=d.id AND m.status IN ('intent','fs_applied','failed'))`)
      .get(attemptId, snapshot.taskId, snapshot.datasetId, snapshot.datasetManifestSha256);
    if (!current) fail();
    try { assertCurrentSnapshotSource(processing.getDataset(snapshot.datasetId, true), snapshot); } catch { fail(); }
    let source, marks;
    try { source = records(snapshot.sourceFrames); marks = records(snapshot.selectedFrames); } catch { fail(); }
    const photo=/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i,auxiliary=/\.(?:txt|geojson|json|zip|las|laz)$/i;
    for (const f of source) {
      if (f.type !== 'dataset_file' || f.processingRole === 'gcp_source'
          || (f.processingRole === 'image' && !photo.test(f.relativePath))
          || (f.processingRole === 'provider_input' && !auxiliary.test(f.relativePath))) fail();
      let checked;try { checked=fileFacts({id:f.datasetFileId,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256,processingRole:f.processingRole,contentType:f.mediaType}); } catch { fail(); }
      if (!canonicalBytes(checked).equals(canonicalBytes(f))) fail();
    }
    const byId = new Map(source.map(f => [f.datasetFileId, f]));
    if (byId.size !== source.length || marks.length !== selected.length) fail();
    const eligible=source.filter(f=>!['gcp_source','administrative'].includes(f.processingRole)
      && (f.processingRole!=='auto' || photo.test(f.relativePath)));
    const ordered=[...eligible.filter(f=>photo.test(f.relativePath)),...eligible.filter(f=>!photo.test(f.relativePath))];
    if (marks.length!==ordered.length || marks.some((m,i)=>m.datasetFileId!==ordered[i].datasetFileId)) fail();
    const expected = marks.map((m, index) => {
      const f = byId.get(m.datasetFileId);
      if (!f || m.type !== 'dataset_file' || m.ordinal !== index || m.pageObjectId !== m.datasetFileId
          || !Number.isSafeInteger(f.byteSize) || f.byteSize < 1 || !/^[a-f0-9]{64}$/.test(f.sha256)) fail();
      return { id: m.pageObjectId, relativePath: f.relativePath, byteSize: f.byteSize, sha256: f.sha256 };
    });
    const bytes = canonicalBytes(expected);
    if (bytes.length > 4194304 || !canonicalBytes(selected).equals(bytes)) fail();
    const input = expected.map(f => ({ relativePath: f.relativePath, byteSize: f.byteSize, sha256: f.sha256 }));
    if (digest(Buffer.from(JSON.stringify(input))) !== snapshot.inputManifestSha256) fail();
    const row = processing.database.prepare('SELECT * FROM candidate_selected_source_generations WHERE attempt_id=? AND generation=?').get(attemptId, generation);
    const expectedRow = [snapshotId, snapshotSha256, rootRef, bytes.toString('utf8'), digest(bytes)];
    if (row) {
      if (JSON.stringify([row.snapshot_id,row.snapshot_sha256,row.root_ref,row.selected_json,row.selected_sha256]) !== JSON.stringify(expectedRow)) fail();
      return { state: 'held', replay: true, admissionAvailable: false };
    }
    const prior = processing.database.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM candidate_selected_source_generations WHERE attempt_id=?').get(attemptId).n;
    if (generation !== prior + 1) fail();
    processing.database.prepare("INSERT INTO candidate_selected_source_generations VALUES(?,?,?,?,?,?,?,'held')")
      .run(attemptId,generation,...expectedRow);
    return { state: 'held', replay: false, admissionAvailable: false };
  });
}
module.exports = { prepareSelectedGeneration };
