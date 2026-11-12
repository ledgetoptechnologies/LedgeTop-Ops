import { executeStagingInquirySuccessor } from './staging-inquiry-successor-core.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateStagingInquiryUploadFence } from './staging-inquiry-window-bindings.mjs';

const PREFLIGHT_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.cHJlZmxpZ2h0LXN5bnRoZXRpYy1vbmx5';
const digest = value => createHash('sha256').update(value).digest('hex');
function verifyPreparedPlan(plan, token, expected) {
  if (plan?.metadata?.assets?.jwt !== token) throw new Error('staging_inquiry_runner_completion_token_mismatch');
  const metadataTemplate = structuredClone(plan.metadata);
  metadataTemplate.assets.jwt = '<fresh-asset-completion-token>';
  if (digest(JSON.stringify(metadataTemplate)) !== expected.metadataTemplateSha256)
    throw new Error('staging_inquiry_runner_metadata_pin_mismatch');
  if (JSON.stringify(plan.receipt ?? {}).includes(token)) throw new Error('staging_inquiry_runner_receipt_contains_token');
  if (!Buffer.isBuffer(plan.mainModule?.bytes) || digest(plan.mainModule.bytes) !== expected.mainModuleSha256
    || !Buffer.isBuffer(plan.ledgerModule?.bytes) || digest(plan.ledgerModule.bytes) !== expected.ledgerModuleSha256)
    throw new Error('staging_inquiry_runner_module_pin_mismatch');
  if (plan.receipt?.packetSHA256 !== expected.packetSha256
    || plan.receipt?.mainModuleSHA256 !== expected.mainModuleSha256
    || plan.receipt?.ledgerModuleSHA256 !== expected.ledgerModuleSha256)
    throw new Error('staging_inquiry_runner_plan_pin_mismatch');
}

// Dependency-injected composition seam. This module deliberately has no
// artifact imports and no CLI/default credential path: callers supply every
// provider, journal, artifact, and payload dependency explicitly.
export function createStagingInquiryRunner({ provider, uploader, prepare, packet, packetBytes, packetManifest,
  token, resolvePayload, fetchImpl, record, seal, baselinePin, expected, attemptId, tag }) {
  const need = (ok, code) => { if (!ok) throw new Error(code); };
  need(provider && typeof provider.readFence === 'function' && typeof provider.postVersion === 'function'
    && typeof provider.readCandidate === 'function', 'staging_inquiry_runner_provider_invalid');
  need(typeof uploader === 'function' && typeof prepare === 'function' && typeof record === 'function'
    && typeof seal === 'function' && typeof resolvePayload === 'function', 'staging_inquiry_runner_dependency_missing');
  need(typeof token === 'string' && token.length > 0 && Buffer.isBuffer(packetBytes) && packetManifest,
    'staging_inquiry_runner_upload_input_missing');
  const packetDigest = createHash('sha256').update(packetBytes).digest('hex');
  need(packetDigest === expected.packetSha256 && packet?.sha256 === packetDigest,
    'staging_inquiry_runner_packet_digest_mismatch');
  let parsedPacket;
  try { parsedPacket = JSON.parse(packetBytes.toString('utf8')); }
  catch { throw new Error('staging_inquiry_runner_packet_invalid'); }
  need(isDeepStrictEqual(parsedPacket, packetManifest)
    && packetManifest?.environment === 'staging'
    && packetManifest?.accountId === '846c924bf17bf4f3dd15c97a4c5d1d51'
    && packetManifest?.workerName === 'ledgetop-ops-staging'
    && Array.isArray(packetManifest?.union?.files), 'staging_inquiry_runner_packet_identity_invalid');

  // Resolve and verify every payload before the asset uploader can create a
  // session. Cache the verified bytes so the uploader cannot observe changed
  // content between preflight and its own per-hash validation.
  const verifiedPayloads = new Map();
  let preparedPlan;
  const resolveVerifiedPayload = async hash => {
    const payload = verifiedPayloads.get(hash);
    need(payload, 'staging_inquiry_runner_unpinned_payload');
    return payload;
  };

  const verifyCurrentFence = async () => {
    const fence = await provider.readFence();
    const now = new Date().toISOString();
    const pin = validateStagingInquiryUploadFence({ ...fence,
      latestVersion: fence?.pinnedZeroPercentVersion ?? fence?.latestVersion, now });
    const versionList = fence?.versionList, listedAt = Date.parse(versionList?.observedAt), current = Date.parse(now);
    const rows = versionList?.rows;
    need(versionList?.complete === true && Number.isFinite(listedAt) && current >= listedAt
      && current - listedAt <= 30000 && Array.isArray(rows) && rows.length > 0
      && rows.every(row => typeof (row?.id ?? row?.version_id ?? row?.versionId) === 'string'
        && Number.isFinite(Date.parse(row?.created_on ?? row?.createdOn ?? ''))),
    'staging_inquiry_runner_version_list_invalid');
    const ordered = [...rows].sort((a, b) => Date.parse(b.created_on ?? b.createdOn) - Date.parse(a.created_on ?? a.createdOn));
    need(new Set(rows.map(row => row.id ?? row.version_id ?? row.versionId)).size === rows.length
      && Date.parse(ordered[0].created_on ?? ordered[0].createdOn) > Date.parse(ordered[1]?.created_on ?? ordered[1]?.createdOn ?? '1970-01-01T00:00:00.000Z')
      && (ordered[0].id ?? ordered[0].version_id ?? ordered[0].versionId) === baselinePin.latestVersionId,
    'staging_inquiry_runner_latest_version_drift');
    need(['deploymentId', 'activeVersionId', 'latestVersionId', 'bindingsSha256']
      .every(key => pin[key] === baselinePin[key]), 'staging_inquiry_runner_pin_drift');
    return pin;
  };

  const uploadAssets = async ({ recordIntent, sealOutcome }) => {
    // The pure plan must be valid before the uploader can create its asset session.
    const plan = prepare(PREFLIGHT_TOKEN, tag);
    verifyPreparedPlan(plan, PREFLIGHT_TOKEN, expected);
    // Freeze copies of the exact validated bytes and metadata. The untrusted
    // planner is not called again with the real asset completion token.
    preparedPlan = { ...plan, metadata: structuredClone(plan.metadata), receipt: structuredClone(plan.receipt),
      mainModule: { ...plan.mainModule, bytes: Buffer.from(plan.mainModule.bytes) },
      ledgerModule: { ...plan.ledgerModule, bytes: Buffer.from(plan.ledgerModule.bytes) } };
    await verifyCurrentFence();
    for (const row of packetManifest.union.files) {
      need(row && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256)
        && Number.isSafeInteger(row.size) && row.size >= 0 && typeof row.mime === 'string',
      'staging_inquiry_runner_packet_entry_invalid');
      const hash = row.sha256.slice(0, 32);
      let payload;
      try { payload = await resolvePayload(hash); }
      catch { throw new Error('staging_inquiry_runner_payload_unavailable'); }
      need(payload && Buffer.isBuffer(payload.bytes) && payload.sha256 === row.sha256
        && payload.bytes.length === row.size && payload.mime === row.mime
        && createHash('sha256').update(payload.bytes).digest('hex') === row.sha256,
      'staging_inquiry_runner_payload_pin_mismatch');
      const prior = verifiedPayloads.get(hash);
      need(!prior || prior.sha256 === payload.sha256 && prior.mime === payload.mime && prior.bytes.equals(payload.bytes),
        'staging_inquiry_runner_provider_hash_collision');
      verifiedPayloads.set(hash, { bytes: Buffer.from(payload.bytes), sha256: payload.sha256, mime: payload.mime });
    }
    let sequence = 0;
    const intents = new Map(), outcomes = [];
    const uploaded = await uploader({ packetManifest, token, resolvePayload: resolveVerifiedPayload, fetchImpl,
      beforeDispatch: async () => {
        await verifyCurrentFence();
      },
      recordIntent: async intent => {
        const id = `asset-${String(++sequence).padStart(6, '0')}`;
        await recordIntent({ ...intent, id });
        intents.set(id, intent);
        return id;
      },
      sealOutcome: async sealed => {
        const intent = intents.get(sealed?.intentId);
        need(intent && !outcomes.some(row => row.intentId === sealed.intentId), 'staging_inquiry_runner_orphan_asset_seal');
        const custody = await sealOutcome({ intentId: sealed.intentId,
          rawResponseBytes: sealed.rawResponseBytes, responseStatus: sealed.responseStatus });
        outcomes.push({ intentId: sealed.intentId, status: 'accepted', ok: true });
        // The upload helper requires an opaque durable receipt identifier.
        return custody.digest;
      },
    });
    return { completionToken: uploaded?.completionToken,
      verifiedPacketDigest: packetDigest,
      sealedIntents: [...intents.keys()].filter(id => outcomes.some(row => row.intentId === id)), outcomes };
  };

  const prepareFromValidatedPlan = (completionToken, requestedTag) => {
    need(preparedPlan && requestedTag === tag, 'staging_inquiry_runner_plan_not_prepared');
    const metadata = structuredClone(preparedPlan.metadata);
    metadata.assets.jwt = completionToken;
    return { ...preparedPlan, metadata };
  };
  return Object.freeze({ run: () => executeStagingInquirySuccessor({ prepare: prepareFromValidatedPlan, packet, readFence: provider.readFence,
    uploadAssets, postVersion: provider.postVersion, readCandidate: provider.readCandidate,
    record, seal, baselinePin, expected, attemptId, tag }) });
}
