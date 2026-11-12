import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { backupBindingForTransferPlan } from './staging-protected-transfer.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const MAX_RESPONSE = 1024 * 1024;
const MAX_POLLS = 100;
const MAX_URL = 4096;
const sha = b => createHash('sha256').update(b).digest('hex');
class ExportCustodyError extends Error {}
const fail = code => { throw new ExportCustodyError(code); };
const hashString = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicView = Object.fromEntries(['buffer', 'byteOffset', 'byteLength'].map(name => [name, Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get]));
function snapshotBytes(value, code) {
  try {
    if (utilTypes.isProxy(value) || !utilTypes.isUint8Array(value)) fail(code);
    const length = intrinsicView.byteLength.call(value), offset = intrinsicView.byteOffset.call(value), buffer = intrinsicView.buffer.call(value);
    if (length === 0 || length > MAX_RESPONSE || utilTypes.isSharedArrayBuffer(buffer)) fail(code);
    return Buffer.from(new Uint8Array(buffer, offset, length));
  } catch { fail(code); }
}
function ownObject(value, code) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
    const out = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 16) fail(code);
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value')) fail(code);
      out[key] = d.value;
    }
    return out;
  } catch { fail(code); }
}
function responseSnapshot(value, expectedUrl) {
  const x = ownObject(value, 'd1_transport_response_invalid');
  const d = Object.getOwnPropertyDescriptor(x, 'status'), b = Object.getOwnPropertyDescriptor(x, 'rawResponseBytes');
  if (!d || !b || !Number.isInteger(d.value) || d.value < 100 || d.value > 599
    || x.redirected !== false || x.finalURL !== expectedUrl) fail('d1_transport_response_invalid');
  return { status: d.value, bytes: snapshotBytes(b.value, 'd1_response_capacity') };
}
function parse(raw) {
  let x;
  try { x = JSON.parse(raw.toString('utf8')); } catch { fail('d1_response_invalid'); }
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.success !== true || !Array.isArray(x.errors) || x.errors.length !== 0
    || !x.result || typeof x.result !== 'object' || Array.isArray(x.result)
    || typeof x.result.at_bookmark !== 'string' || !x.result.at_bookmark || x.result.at_bookmark.length > 2048
    || (x.result.status !== undefined && !['complete', 'error'].includes(x.result.status))
    || (x.result.success !== undefined && typeof x.result.success !== 'boolean')) fail('d1_response_refused');
  return x.result;
}
function checkedOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL) fail('d1_download_origin_invalid');
  let u;
  try { u = new URL(value); } catch { fail('d1_download_origin_invalid'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || u.origin !== value.replace(/\/$/, '')) fail('d1_download_origin_invalid');
  return u.origin;
}
function validateSignedUrl(value, origin) {
  if (typeof value !== 'string' || value.length > MAX_URL) fail('d1_download_capability_invalid');
  let u;
  try { u = new URL(value); } catch { fail('d1_download_capability_invalid'); }
  if (u.protocol !== 'https:' || u.origin !== origin || u.username || u.password || u.hash) fail('d1_download_capability_invalid');
  return u;
}
const bindingHash = binding => sha(Buffer.from(JSON.stringify(binding)));

/** Offline coordinator; callbacks must implement separately reviewed protected custody. */
export function createStagingD1ExportCustody({ plan, role, transport, sealRawResponse, validateProof, record, downloadOrigin }) {
  const planMeta = ownObject(plan, 'd1_plan_invalid');
  const planSha256 = planMeta.planSha256;
  if (!hashString(planSha256)) fail('d1_plan_invalid');
  const binding = Object.freeze({ ...backupBindingForTransferPlan(plan, role) });
  const bindingSha256 = bindingHash(binding);
  const origin = checkedOrigin(downloadOrigin);
  for (const fn of [transport, sealRawResponse, validateProof, record]) if (typeof fn !== 'function') fail('d1_adapter_missing');
  let started = false, bookmark = null, polls = 0, blocked = false, terminal = false, complete = false, busy = false;
  let pending = null, capabilitySealed = false;
  const state = (showBusy = busy) => Object.freeze({ status: showBusy ? 'in-flight' : blocked ? 'needs-reconciliation' : terminal ? 'stopped' : complete ? 'export-capability-sealed' : started ? 'export-polling' : 'ready', actionId: pending?.actionId ?? null, polls, maxPolls: MAX_POLLS, automaticRetry: false, durablePersistenceVerified: false });
  async function journal(entry) {
    try { if (await record(Object.freeze(entry)) !== true) fail('d1_journal_refused'); } catch { fail('d1_journal_refused'); }
  }
  function requestFor(kind, seq) {
    const url = `${API}/accounts/${binding.sourceAccountId}/d1/database/${binding.sourceDatabaseId}/export`;
    const body = JSON.stringify({ output_format: 'polling', dump_options: { compatibility: 'd1', no_data: false, no_schema: false }, ...(kind === 'poll' ? { current_bookmark: bookmark } : {}) });
    const actionId = `d1x-${sha(Buffer.from(`${planSha256}|${role}|${seq}|${kind}`)).slice(0, 32)}`;
    return Object.freeze({ actionId, kind, seq, url, method: 'POST', body, requestSha256: sha(Buffer.from(body)) });
  }
  async function run(req) {
    const op = { actionId: req.actionId, kind: req.kind, seq: req.seq, requestSha256: req.requestSha256, bindingSha256, request: req };
    pending = op;
    try { await journal({ actionId: op.actionId, phase: 'intent', requestSha256: op.requestSha256, bindingSha256, sequence: op.seq }); }
    catch { terminal = true; fail('d1_intent_unrecorded'); }
    let response, snap;
    try { response = await transport(Object.freeze({ url: req.url, method: req.method, body: req.body, redirect: 'error', credentials: 'omit', timeoutMs: 30000, maxResponseBytes: MAX_RESPONSE, cancelOnLimit: true, headers: Object.freeze({ 'content-type': 'application/json' }) })); }
    catch { blocked = true; fail('d1_outcome_unknown'); }
    try { snap = responseSnapshot(response, req.url); }
    catch (e) { blocked = true; fail(e.message === 'd1_response_capacity' ? 'd1_response_capacity_unknown' : 'd1_outcome_unknown'); }
    const responseSha256 = sha(snap.bytes), httpStatus = snap.status;
    let sealed;
    try {
      const context = Object.freeze({ schema: 'staging-d1-export-response/v1', actionId: op.actionId, requestSha256: op.requestSha256, responseSha256, httpStatus, bindingSha256 });
      const sealerCopy = Buffer.from(snap.bytes);
      try { sealed = ownObject(await sealRawResponse(Object.freeze({ rawResponseBytes: sealerCopy, destination: op.actionId, context })), 'd1_seal_invalid'); }
      finally { sealerCopy.fill(0); }
      if (sealed.verified !== true || !hashString(sealed.digest) || !hashString(sealed.receiptRef)) fail('d1_seal_invalid');
      const expectedProof = Object.freeze({ ...context, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef });
      const proofCopy = Buffer.from(snap.bytes);
      let proofResult;
      try { proofResult = ownObject(await validateProof(Object.freeze({ ...expectedProof, context, rawResponseBytes: proofCopy, request: Object.freeze({ actionId: req.actionId, method: req.method, url: req.url, body: req.body }) })), 'd1_proof_invalid'); }
      finally { proofCopy.fill(0); }
      if (proofResult.verified !== true || proofResult.actionId !== op.actionId || proofResult.requestSha256 !== op.requestSha256
        || proofResult.responseSha256 !== responseSha256 || proofResult.httpStatus !== httpStatus || proofResult.sealedDigest !== sealed.digest
        || proofResult.receiptRef !== sealed.receiptRef || proofResult.bindingSha256 !== bindingSha256) fail('d1_proof_invalid');
      Object.assign(op, { responseSha256, httpStatus, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef });
      await journal({ actionId: op.actionId, phase: 'custodied', requestSha256: op.requestSha256, responseSha256, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, bindingSha256, httpStatus });
    } catch {
      snap.bytes.fill(0);
      blocked = true;
      try { await journal({ actionId: op.actionId, phase: 'custody-unknown', requestSha256: op.requestSha256, bindingSha256 }); } catch { /* fixed state */ }
      fail('d1_response_custody_unknown');
    }
    try {
      if (httpStatus !== 200 && httpStatus !== 202) { terminal = true; await journal({ actionId: op.actionId, phase: 'refused', requestSha256: op.requestSha256, responseSha256, bindingSha256, httpStatus }); fail('d1_http_refused'); }
      const result = parse(snap.bytes);
      if (req.kind === 'poll' && result.at_bookmark !== bookmark) { terminal = true; fail('d1_bookmark_changed'); }
      return classify(result);
    } catch (e) {
      if (!terminal) terminal = true;
      if (e instanceof ExportCustodyError) throw e;
      fail('d1_response_refused');
    } finally { snap.bytes.fill(0); }
  }
  function classify(result) {
    if (result.type !== undefined && result.type !== 'export') fail('d1_response_refused');
    if (result.status === 'error' || result.success === false) { terminal = true; return state(false); }
    if (result.status === 'complete') {
      if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)
        || (result.result.filename !== undefined && (typeof result.result.filename !== 'string' || !result.result.filename || result.result.filename.length > 512))) fail('d1_completion_invalid');
      const u = validateSignedUrl(result.result.signed_url, origin);
      void u;
      capabilitySealed = true;
      complete = true;
      return Object.freeze({ ...state(false), continuationReceipt: Object.freeze({ schema: 'staging-d1-export-response/v1', actionId: pending.actionId, requestSha256: pending.requestSha256, responseSha256: pending.responseSha256, httpStatus: pending.httpStatus, sealedDigest: pending.sealedDigest, receiptRef: pending.receiptRef, bindingSha256, role, planSha256, capabilitySealed: true }) });
    }
    if (result.status !== undefined) fail('d1_status_unknown');
    if (Object.hasOwn(result, 'result')) fail('d1_active_response_invalid');
    bookmark = result.at_bookmark;
    return state(false);
  }
  async function start() {
    if (busy || started || blocked || terminal || complete) fail('d1_start_refused');
    busy = true; started = true;
    const req = requestFor('start', 0);
    try { return await run(req); } catch (e) { if (!blocked) terminal = true; throw e; } finally { busy = false; }
  }
  async function poll() {
    if (busy || !started || blocked || terminal || complete || !bookmark) fail('d1_poll_refused');
    if (polls >= MAX_POLLS) { terminal = true; fail('d1_poll_limit'); }
    busy = true; polls++;
    try { return await run(requestFor('poll', polls)); } catch (e) { if (!blocked) terminal = true; throw e; } finally { busy = false; }
  }
  async function reconcile(input) {
    if (busy || !blocked || !pending) fail('d1_reconcile_refused');
    busy = true;
    let custodyAccepted = false;
    try {
      const x = ownObject(input, 'd1_reconcile_refused');
      if (Object.keys(x).sort().join(',') !== 'actionId,proof,rawResponseBytes,receiptRef,responseStatus,sealedDigest'
        || x.actionId !== pending.actionId || !Number.isInteger(x.responseStatus) || x.responseStatus < 100 || x.responseStatus > 599
        || !hashString(x.sealedDigest) || !hashString(x.receiptRef)) fail('d1_reconcile_refused');
      const raw = snapshotBytes(x.rawResponseBytes, 'd1_reconcile_refused'), responseSha256 = sha(raw);
      try {
        const context = Object.freeze({ schema: 'staging-d1-export-response/v1', actionId: pending.actionId, requestSha256: pending.requestSha256, responseSha256, httpStatus: x.responseStatus, bindingSha256 });
        const proofCopy = Buffer.from(raw);
        let checked;
        try { checked = ownObject(await validateProof(Object.freeze({ ...context, context, sealedDigest: x.sealedDigest, receiptRef: x.receiptRef, rawResponseBytes: proofCopy, proof: x.proof, request: Object.freeze({ actionId: pending.actionId, method: pending.request.method, url: pending.request.url, body: pending.request.body }) })), 'd1_proof_invalid'); }
        finally { proofCopy.fill(0); }
        if (checked.verified !== true || checked.actionId !== pending.actionId || checked.requestSha256 !== pending.requestSha256 || checked.responseSha256 !== responseSha256
          || checked.httpStatus !== x.responseStatus || checked.sealedDigest !== x.sealedDigest || checked.receiptRef !== x.receiptRef || checked.bindingSha256 !== bindingSha256) fail('d1_proof_invalid');
        await journal({ actionId: pending.actionId, phase: 'reconciled-custody', requestSha256: pending.requestSha256, responseSha256, sealedDigest: x.sealedDigest, receiptRef: x.receiptRef, bindingSha256, httpStatus: x.responseStatus });
        Object.assign(pending, { responseSha256, httpStatus: x.responseStatus, sealedDigest: x.sealedDigest, receiptRef: x.receiptRef });
        custodyAccepted = true;
        const result = x.responseStatus === 200 || x.responseStatus === 202 ? parse(raw) : null;
        blocked = false;
        if (!result) { terminal = true; fail('d1_http_refused'); }
        if (pending.kind === 'poll' && result.at_bookmark !== bookmark) fail('d1_bookmark_changed');
        if (pending.kind === 'start') { started = true; }
        return classify(result);
      } finally { raw.fill(0); }
    } catch {
      if (custodyAccepted) { blocked = false; terminal = true; }
      else blocked = true;
      fail(custodyAccepted ? 'd1_response_refused' : 'd1_reconcile_refused');
    }
    finally { busy = false; }
  }
  async function download() {
    if (busy || !complete || blocked || !capabilitySealed) fail('d1_download_refused');
    return Object.freeze({ status: 'download-adapter-required', capabilitySealed: true, maxBytes: 32 * 1024 * 1024, automaticRetry: false });
  }
  return Object.freeze({ start, poll, reconcile, download, state, binding });
}
