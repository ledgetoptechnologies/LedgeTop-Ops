'use strict';

// Unmounted reference result workflow. This module does not issue custody,
// authorize a caller, or enable the reference worker. Its caller must retain
// the already-verified storage/writer authority across *all* operations and
// supply a replay-safe, durable Viewer-ingest implementation. In particular,
// extraction alone is not publication and an acceptance is not permission to
// delete the source. No production route imports this module.
const p = require('./referenceProtocol');
const fs = require('node:fs');
const {ReferenceProvider} = require('./referenceProvider');
const {ReferenceResultJournal, validateResultBinding} = require('./referenceResultJournal');
const {ReferenceAcceptanceLedger} = require('./referenceAcceptance');
const {checkAuthority} = require('./referenceResultSpool');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const equal = (a,b) => p.canonicalBytes(a).equals(p.canonicalBytes(b));

async function handleReferenceResult({provider, expected, journal, ledger, acceptance, ingestRetained, verifyIngest, assertAuthority, signal} = {}) {
  if (!(provider instanceof ReferenceProvider) || !(journal instanceof ReferenceResultJournal) || !(ledger instanceof ReferenceAcceptanceLedger) || typeof ingestRetained !== 'function' || typeof verifyIngest !== 'function' || typeof assertAuthority !== 'function') fail('REFERENCE_RESULT_RUNTIME_UNAVAILABLE');
  // Snapshot the caller's committed plan before any network await. Production
  // construction must come from a durable, authenticated job binding.
  try { expected = structuredClone(expected); acceptance = structuredClone(acceptance); } catch { fail('REFERENCE_RESULT_BINDING'); }
  const check = () => {
    signal?.throwIfAborted();
    if (assertAuthority() !== true) fail('REFERENCE_RESULT_AUTHORITY_LOST');
    checkAuthority(journal.authority);
    const stat=fs.lstatSync(ledger.root,{bigint:true});
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== journal.authority.device || stat.ino !== journal.authority.inode) fail('REFERENCE_RESULT_ROOT_MISMATCH');
    checkAuthority(journal.authority);
  };
  check();
  const manifest = structuredClone(await provider.results(expected.jobId,expected,{signal}));
  check();
  p.validateResultManifest(manifest,expected);
  if (!Array.isArray(expected.requestedEngines) || !equal(expected.requestedEngines,['odm']) || manifest.resultManifestSha256 !== expected.resultManifestSha256 || manifest.objects.length !== 1 || manifest.objects[0].role !== 'odm_archive' || manifest.objects[0].byteSize < 1) fail('REFERENCE_RESULT_UNSUPPORTED');
  const object = manifest.objects[0];
  const receiptBinding = {...expected,objectIds:[object.id]};
  p.validateAcceptance(acceptance,receiptBinding);
  if (!equal(acceptance.acceptedObjectIds,[object.id])) fail('REFERENCE_RESULT_BINDING');
  // Derive the same key as the journal without writing its immutable intent.
  // A receipt mismatch must never leave an unrecoverable pending record.
  const binding = validateResultBinding(expected,manifest,object.id);
  const storageKey = p.sha256(p.canonicalBytes(binding));
  if (acceptance.storageReceiptId !== storageKey) fail('REFERENCE_RESULT_BINDING');
  check();
  const retained = await journal.retain({expected,manifest,objectId:object.id,signal,source:()=>provider.downloadObject(expected.jobId,object.id,{expectedBinding:expected,signal})});
  check();
  if (!retained || acceptance.storageReceiptId !== retained.storageKey || retained.binding?.objectId !== object.id || retained.binding?.objectSha256 !== object.sha256 || retained.binding?.objectBytes !== object.byteSize || retained.receipt?.relativePath !== `${retained.storageKey}.zip`) fail('REFERENCE_RESULT_BINDING');

  // Replays must use the same immutable receipt and retained object. A caller
  // must guarantee its own ingest operation is idempotent and durable before
  // returning; this bridge cannot establish that authority by itself.
  const verifyLedger = stored => {
    if (!stored || !equal(stored.acceptance,acceptance) || !equal(stored.storage?.resultManifest,manifest) || !equal(stored.storage?.objects,[{id:object.id,relativePath:retained.receipt.relativePath}])) fail('REFERENCE_RESULT_CONFLICT');
  };
  const existing = ledger.get(acceptance.receiptId);
  if (existing) verifyLedger(existing);
  if (!existing) {
    await ingestRetained({expected,manifest,object,retained,signal});
    check();
    if (await verifyIngest({expected,manifest,object,retained,signal}) !== true) fail('REFERENCE_RESULT_INGEST_UNVERIFIED');
    check();
    ledger.accept({expected:receiptBinding,resultManifest:manifest,acceptance,objects:[{id:object.id,relativePath:retained.receipt.relativePath}]});
    verifyLedger(ledger.get(acceptance.receiptId));
  } else if (await verifyIngest({expected,manifest,object,retained,signal}) !== true) fail('REFERENCE_RESULT_INGEST_UNVERIFIED');
  check();
  try {
    const response = await provider.acceptResult(expected.jobId,acceptance,expected,{signal});
    check();
    if (!response || response.fullyAccepted !== true || !equal(response.acceptedObjectIds,[object.id])) fail('REFERENCE_RESULT_BINDING');
    ledger.markAcked(acceptance.receiptId,acceptance);
    return {receiptId:acceptance.receiptId,fullyAccepted:response.fullyAccepted};
  } catch (error) {
    // Lost responses are uncertain; preserve the immutable outbox for replay.
    // Do not mask the primary error if recording a retry also fails.
    try { ledger.markFailed(acceptance.receiptId); } catch {}
    throw error;
  }
}
module.exports = {handleReferenceResult};
