'use strict';

// Draft transport only. No application entry point mounts these routes. A
// pending journal is not a retained file or a published GCP set.
const { MAX_SOURCE_BYTES } = require('./gcpImport');
const { parseRawGcpSource } = require('./gcpRawSource');
const { prepareGcpRawJournal } = require('./gcpRawJournal');

// base64 expansion plus bounded metadata; this parser must be installed
// before the generic body parser, after authentication and permission checks.
const RAW_GCP_JSON_LIMIT = Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 16384;
const onlyKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const fail = (res, err) => {
  const code = err?.code || 'invalid_gcp_input';
  const status = ['dataset_not_available', 'gcp_preview_confirmation_required', 'gcp_source_conflict'].includes(code) ? 409 :
    ['gcp_capacity_unavailable', 'gcp_capacity_exceeded', 'gcp_journal_unavailable'].includes(code) ? 503 : 400;
  return res.status(status).json({ error: code, code });
};

function mountDraftRawGcpRoutes(router, { processing, authorize, mutate, jsonParser, capacityPolicy }) {
  if (!router || !processing?.database || typeof processing.getDataset !== 'function' ||
      typeof authorize !== 'function' || typeof mutate !== 'function' || typeof jsonParser !== 'function') {
    throw new TypeError('Raw GCP routes require authenticated dependencies');
  }
  const parser = jsonParser({ limit: RAW_GCP_JSON_LIMIT, strict: true, verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);} });
  if (typeof parser !== 'function') throw new TypeError('Raw GCP body parser required');
  const path = '/api/v1/datasets/:datasetId/gcp-sets/raw';
  router.post(`${path}/preview`, authorize('viewer.gcp.write'), parser, (req, res) => {
    if (!onlyKeys(req.body, ['encoded', 'format', 'declarations']) || !['generic-csv-v1','emlid-all-columns-v1'].includes(req.body.format)) return fail(res, {code:'invalid_gcp_input'});
    const dataset = processing.getDataset(req.params.datasetId);
    if (!dataset || dataset.status !== 'finalized') return fail(res, {code:'dataset_not_available'});
    try {
      const raw = parseRawGcpSource(req.body);
      return res.json({ sourceSha256: raw.sha256, byteSize: raw.byteSize, pointCount: raw.parsed.points.length,
        provenance: raw.parsed.provenance, sample: raw.parsed.points.slice(0,5), confirmationToken: raw.confirmationToken });
    } catch (err) { return fail(res, err); }
  });
  router.post(`${path}/prepare`, authorize('viewer.gcp.write'), parser, mutate, (req, res) => {
    if (!onlyKeys(req.body, ['encoded','format','declarations','confirmationToken','displayName','fileName','requestKey']) || req.get('Idempotency-Key') !== req.body.requestKey) return fail(res, {code:'invalid_gcp_input'});
    try {
      const journal = prepareGcpRawJournal(processing.database, { datasetId:req.params.datasetId, encoded:req.body.encoded,
        format:req.body.format, declarations:req.body.declarations ?? null, confirmation:req.body.confirmationToken,
        displayName:req.body.displayName, fileName:req.body.fileName, requestKey:req.body.requestKey, actorId:req.actorId }, {capacityPolicy});
      // This response intentionally cannot be mistaken for completed import.
      return res.status(202).json({ status:'pending', journalId:journal.id, replayed:journal.replayed });
    } catch (err) { return fail(res, err); }
  });
}
module.exports = { mountDraftRawGcpRoutes, RAW_GCP_JSON_LIMIT };
