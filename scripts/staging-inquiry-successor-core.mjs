import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateStagingInquiryUploadFence, verifyStagingInquiryVersionBindings } from './staging-inquiry-window-bindings.mjs';

// Pure protocol coordinator. Injected adapters are trusted boundaries: this
// module cannot prove provider identity, provider no-retry behavior, or that
// record performs the required worker-scoped atomic create. `true` is that
// adapter's assertion; any other result is refused.
const ACCOUNT = '846c924bf17bf4f3dd15c97a4c5d1d51';
const WORKER = 'ledgetop-ops-staging';
const PATH = `/workers/scripts/${WORKER}/versions?bindings_inherit=strict`;
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value ?? '');
const versionId = row => row?.id ?? row?.version_id ?? row?.versionId;
const versionTime = row => Date.parse(row?.created_on ?? row?.createdOn ?? '');
function newestListedVersion(list) {
  const listedAt = Date.parse(list?.observedAt), age = Date.now() - listedAt;
  need(list?.complete === true && Number.isFinite(listedAt) && age >= -10000 && age <= 30000, 'staging_inquiry_version_list_stale_or_incomplete');
  const rows = list.rows;
  need(Array.isArray(rows) && rows.length > 0 && rows.every(row => uuid(versionId(row)) && Number.isFinite(versionTime(row))), 'staging_inquiry_version_list_invalid');
  need(new Set(rows.map(versionId)).size === rows.length, 'staging_inquiry_version_list_duplicate');
  const sorted = [...rows].sort((a, b) => versionTime(b) - versionTime(a));
  need(versionTime(sorted[0]) > versionTime(sorted[1] ?? { created_on: '1970-01-01T00:00:00.000Z' }), 'staging_inquiry_version_list_order_ambiguous');
  return versionId(sorted[0]);
}
function currentFence(raw, pinnedZeroPercentVersion = raw.pinnedZeroPercentVersion ?? raw.latestVersion, pin = raw.pin) {
  // The source's `now` field is untrusted. Freshness is measured at validation time.
  return validateStagingInquiryUploadFence({ accountId: raw.accountId, workerName: raw.workerName,
    observedAt: raw.observedAt, now: new Date().toISOString(), deployment: raw.deployment,
    latestVersion: pinnedZeroPercentVersion, pin });
}
const samePin = (a, b) => isDeepStrictEqual(
  (({ deploymentId, activeVersionId, latestVersionId, bindingsSha256 }) => ({ deploymentId, activeVersionId, latestVersionId, bindingsSha256 }))(a ?? {}),
  (({ deploymentId, activeVersionId, latestVersionId, bindingsSha256 }) => ({ deploymentId, activeVersionId, latestVersionId, bindingsSha256 }))(b ?? {})
);

export async function executeStagingInquirySuccessor({
  prepare, packet, readFence, uploadAssets, postVersion, readCandidate,
  record, seal, baselinePin, expected, attemptId, tag
}) {
  need(uuid(attemptId) && typeof tag === 'string' && tag.length >= 1 && tag.length <= 160, 'staging_inquiry_attempt_invalid');
  need(expected && /^[a-f0-9]{64}$/u.test(expected.packetSha256 ?? '')
    && /^[a-f0-9]{64}$/u.test(expected.mainModuleSha256 ?? '')
    && /^[a-f0-9]{64}$/u.test(expected.ledgerModuleSha256 ?? ''), 'staging_inquiry_expected_pin_invalid');
  for (const name of ['prepare', 'readFence', 'uploadAssets', 'postVersion', 'readCandidate', 'record', 'seal'])
    need(typeof ({ prepare, readFence, uploadAssets, postVersion, readCandidate, record, seal })[name] === 'function', 'staging_inquiry_adapter_missing');

  const rawFirst = await readFence();
  const firstPin = currentFence(rawFirst);
  need(samePin(firstPin, baselinePin), 'staging_inquiry_pin_drift');
  need(newestListedVersion(rawFirst.versionList) === baselinePin.latestVersionId, 'staging_inquiry_latest_list_drift');
  const first = { deployment: structuredClone(rawFirst.deployment), pin: firstPin,
    bindings: structuredClone((rawFirst.pinnedZeroPercentVersion ?? rawFirst.latestVersion).resources.bindings) };
  const write = async (name, value) => need(await record(name, value) === true, 'staging_inquiry_journal_create_refused');
  const holdJournal = async (name, value, result) => {
    try { await write(name, value); return { ...result, outcomeJournaled: true }; }
    catch { return { ...result, outcomeJournaled: false, journalCreateFailed: true }; }
  };
  await write('active-attempt.claim.json', { claimKey: `${ACCOUNT}/${WORKER}`, attemptId, tag, workerName: WORKER, baselinePin: firstPin, automaticRetry: false, activation: false });
  await write('attempt.intent.json', { attemptId, tag, baselinePin: firstPin, expected, automaticRetry: false, activation: false });

  need(packet?.sha256 === expected.packetSha256, 'staging_inquiry_packet_pin_mismatch');

  const intentIds = new Set(), outcomeIds = new Set();
  const assets = await uploadAssets({ packet, recordIntent: async intent => {
    need(intent && typeof intent.id === 'string' && !intentIds.has(intent.id), 'staging_inquiry_duplicate_asset_intent');
    intentIds.add(intent.id); await write(`${intent.id}.intent.json`, { ...intent, attemptId, tag,
      status: 'intent_pending_outcome_reconciliation_required', automaticRetry: false });
    return intent.id;
  }, sealOutcome: async outcome => {
    need(outcome && intentIds.has(outcome.intentId) && !outcomeIds.has(outcome.intentId), 'staging_inquiry_asset_outcome_invalid');
    try {
      const sealed = await seal(outcome.rawResponseBytes, `${outcome.intentId}.response`);
      need(sealed?.verified === true && /^[a-f0-9]{64}$/u.test(sealed.digest ?? ''), 'staging_inquiry_asset_seal_unverified');
      await write(`${outcome.intentId}.outcome.json`, { intentId: outcome.intentId, responseStatus: outcome.responseStatus,
        responseSha256: sha(outcome.rawResponseBytes), sealedDigest: sealed.digest, acceptedCandidateId: outcome.acceptedCandidateId ?? null,
        uncertain: outcome.uncertain === true });
      outcomeIds.add(outcome.intentId); return sealed;
    } catch {
      await write(`${outcome.intentId}.outcome.json`, { intentId: outcome.intentId, uncertain: true, status: 'asset_response_custody_uncertain',
        automaticRetry: false, activation: false });
      throw new Error('staging_inquiry_asset_response_uncertain');
    }
  } });
  need(assets && typeof assets.completionToken === 'string' && assets.completionToken.length > 0
    && assets.verifiedPacketDigest === expected.packetSha256 && Array.isArray(assets.sealedIntents)
    && Array.isArray(assets.outcomes) && assets.sealedIntents.length === intentIds.size
    && assets.outcomes.length === outcomeIds.size && intentIds.size === outcomeIds.size
    && intentIds.size > 0 && assets.outcomes.length > 0
    && assets.sealedIntents.every(id => intentIds.has(id) && outcomeIds.has(id))
    && assets.outcomes.every(outcome => outcome && outcome.uncertain !== true && outcome.ok !== false
      && ['accepted', 'success', 'succeeded'].includes(outcome.status)
      && outcomeIds.has(outcome.intentId ?? outcome.id))
    && new Set(assets.outcomes.map(outcome => outcome.intentId ?? outcome.id)).size === outcomeIds.size,
    'staging_inquiry_assets_incomplete');

  const plan = prepare(assets.completionToken, tag);
  need(plan?.metadata?.assets?.jwt === assets.completionToken, 'staging_inquiry_completion_token_mismatch');
  need(sha(plan.mainModule?.bytes) === expected.mainModuleSha256
    && sha(plan.ledgerModule?.bytes) === expected.ledgerModuleSha256, 'staging_inquiry_module_pin_mismatch');
  need(plan?.receipt?.packetSHA256 === expected.packetSha256
    && plan.receipt.mainModuleSHA256 === expected.mainModuleSha256
    && plan.receipt.ledgerModuleSHA256 === expected.ledgerModuleSha256, 'staging_inquiry_plan_pin_mismatch');
  const form = new FormData();
  form.append('metadata', JSON.stringify(plan.metadata));
  for (const module of [plan.mainModule, plan.ledgerModule]) {
    need(typeof module?.name === 'string' && Buffer.isBuffer(module.bytes) && typeof module.contentType === 'string', 'staging_inquiry_module_invalid');
    form.append(module.name, new Blob([module.bytes], { type: module.contentType }), module.name);
  }
  const req = new Request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${PATH}`, { method: 'POST', body: form });
  const request = { body: Buffer.from(await req.arrayBuffer()), path: PATH, contentType: req.headers.get('content-type') };
  need(request.body.length > 0 && request.body.length <= 16 * 1024 * 1024
    && request.path === PATH && request.contentType?.startsWith('multipart/form-data;'), 'staging_inquiry_request_invalid');
  const rawBeforePost = await readFence();
  const beforePostPin = currentFence(rawBeforePost);
  need(samePin(beforePostPin, baselinePin) && isDeepStrictEqual(rawBeforePost.deployment, first.deployment)
    && newestListedVersion(rawBeforePost.versionList) === baselinePin.latestVersionId, 'staging_inquiry_prepost_drift');
  await write('version-upload.intent.json', { attemptId, tag, requestPath: PATH, bodySha256: sha(request.body),
    status: 'post_pending_reconcile_before_any_retry',
    plan: plan.receipt, pin: beforePostPin, automaticRetry: false, activation: false });

  let response;
  try { response = await postVersion({ path: PATH, body: request.body, contentType: request.contentType }); }
  catch {
    return holdJournal('version-upload.outcome.json', { status: 'transport_uncertain_read_only_reconciliation_required', automaticRetry: false, activation: false },
      { status: 'hold_uncertain', automaticRetry: false, activation: false });
  }
  let versionSeal;
  try {
    need(Buffer.isBuffer(response?.rawResponseBytes), 'staging_inquiry_post_response_missing');
    versionSeal = await seal(response.rawResponseBytes, 'version-upload.response');
    need(versionSeal?.verified === true && /^[a-f0-9]{64}$/u.test(versionSeal.digest ?? ''), 'staging_inquiry_version_seal_unverified');
  } catch {
    return holdJournal('version-upload.outcome.json', { status: 'response_custody_uncertain_read_only_reconciliation_required', automaticRetry: false, activation: false },
      { status: 'hold_response_uncertain', automaticRetry: false, activation: false });
  }
  let parsed; try { parsed = JSON.parse(response.rawResponseBytes.toString('utf8')); } catch { /* held below */ }
  const candidateId = response.httpStatus >= 200 && response.httpStatus < 300 && parsed?.success === true
    && uuid(parsed.result?.id) ? parsed.result.id : null;
  const outcome = await holdJournal('version-upload.outcome.json', { httpStatus: response.httpStatus, responseSha256: sha(response.rawResponseBytes),
    sealedDigest: versionSeal.digest, candidateId, status: candidateId ? 'candidate_readback_required' : 'held_no_retry',
    automaticRetry: false, activation: false }, { status: candidateId ? 'candidate_readback_required' : 'hold_unacknowledged',
    candidateVersionId: candidateId, automaticRetry: false, activation: false });
  if (!outcome.outcomeJournaled) return outcome;
  if (!candidateId) return { status: 'hold_unacknowledged', automaticRetry: false, activation: false };

  try {
    const after = await readCandidate(candidateId);
    const afterPin = currentFence(after.fence, after.fence.pinnedZeroPercentVersion, baselinePin);
    need(samePin(afterPin, baselinePin) && isDeepStrictEqual(after.fence.deployment, first.deployment), 'staging_inquiry_readback_deployment_drift');
    need(newestListedVersion(after.versionList) === candidateId, 'staging_inquiry_candidate_not_newest');
    verifyStagingInquiryVersionBindings(first.bindings, after.candidateVersion.resources.bindings);
    need(after.candidateVersion.id === candidateId, 'staging_inquiry_readback_candidate_mismatch');
    const result = { status: 'inactive_candidate_verified', candidateVersionId: candidateId,
      baselinePin: firstPin, automaticRetry: false, activation: false, liveAssetAndSourceProof: false };
    await write('upload-summary.json', result);
    return result;
  } catch (error) {
    const reasonCode = /^staging_inquiry_[a-z_]+$/u.test(error?.message ?? '') ? error.message : 'staging_inquiry_readback_adapter_failed';
    return holdJournal('readback.outcome.json', { status: 'uncertain_or_mismatched_hold', reasonCode, candidateId, automaticRetry: false, activation: false },
      { status: 'hold_readback_uncertain', candidateVersionId: candidateId, automaticRetry: false, activation: false });
  }
}
