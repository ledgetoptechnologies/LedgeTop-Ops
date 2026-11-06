import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// Pure preparation only: callers must independently verify current provider
// state and the exact version/asset/authority fences before any upload.
const ACCOUNT = '846c924bf17bf4f3dd15c97a4c5d1d51';
const WORKER = 'ledgetop-ops-staging';
const OMIT = ['CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED'];
const ADD = ['CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED', 'OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Validate raw, freshly read provider metadata against an independently
// reviewed pin. This is not a provider client, asset proof or authorization.
export function validateStagingInquiryUploadFence({ accountId, workerName, observedAt, now, deployment, latestVersion, pin }) {
  if (accountId !== ACCOUNT || workerName !== WORKER || !pin || !UUID.test(pin.activeVersionId ?? '')
    || !UUID.test(pin.latestVersionId ?? '') || !UUID.test(pin.deploymentId ?? '')
    || pin.activeVersionId === pin.latestVersionId || !/^[a-f0-9]{64}$/u.test(pin.bindingsSha256 ?? ''))
    throw new Error('staging_inquiry_fence_target_invalid');
  const observed = Date.parse(observedAt), current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current) || observed > current || current - observed > 30000)
    throw new Error('staging_inquiry_fence_stale');
  const versions = deployment?.versions;
  if (deployment?.id !== pin.deploymentId || !Array.isArray(versions) || versions.length !== 2
    || !versions.some(row => row.version_id === pin.activeVersionId && row.percentage === 100)
    || !versions.some(row => row.version_id === pin.latestVersionId && row.percentage === 0)
    || latestVersion?.id !== pin.latestVersionId || !Array.isArray(latestVersion.resources?.bindings))
    throw new Error('staging_inquiry_fence_version_drift');
  const bindings = latestVersion.resources.bindings;
  if (bindings.some(row => !row || typeof row.name !== 'string') || new Set(bindings.map(row => row.name)).size !== bindings.length)
    throw new Error('staging_inquiry_fence_bindings_invalid');
  const sorted = [...bindings].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sha256 = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  if (sha256 !== pin.bindingsSha256 || bindings.filter(row => ['plain_text', 'json', 'secret_text', 'secret_key'].includes(row.type)).length !== 128)
    throw new Error('staging_inquiry_fence_bindings_drift');
  for (const name of OMIT) if (!isDeepStrictEqual(bindings.find(row => row.name === name), { name, type: 'plain_text', text: 'false' }))
    throw new Error('staging_inquiry_fence_flags_drift');
  if (ADD.some(name => bindings.some(row => row.name === name))) throw new Error('staging_inquiry_fence_flags_drift');
  const authority = bindings.find(row => row.name === 'OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY');
  if (!isDeepStrictEqual(authority, { name: 'OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY', type: 'service',
    service: 'ledgetop-clients-staging', environment: 'production', entrypoint: 'OperationsPortalNativeRecipientAuthorityIngress' }))
    throw new Error('staging_inquiry_fence_authority_drift');
  return Object.freeze({ deploymentId: pin.deploymentId, activeVersionId: pin.activeVersionId,
    latestVersionId: pin.latestVersionId, bindingsSha256: sha256, observedAt });
}

export function prepareStagingInquiryBindings(config, observed) {
  if (!config || config.account_id !== ACCOUNT || config.name !== WORKER || !Array.isArray(config.unsafe?.bindings))
    throw new Error('staging_inquiry_target_invalid');
  const bindings = config.unsafe.bindings;
  const metadata = config.unsafe.metadata;
  if (!metadata || !Array.isArray(metadata.keep_bindings) || metadata.keep_bindings.length !== 0
    || config.keep_vars !== false) throw new Error('staging_inquiry_preservation_invalid');
  if (bindings.some(row => !row || typeof row.name !== 'string') || new Set(bindings.map(row => row.name)).size !== bindings.length)
    throw new Error('staging_inquiry_bindings_invalid');
  const observedFlags = observed?.flags;
  if (observed?.textAndSecretBindings !== 128 || !observedFlags || [...OMIT, ...ADD].some(name => !Object.hasOwn(observedFlags, name))
    || OMIT.some(name => observedFlags[name] !== 'false') || ADD.some(name => observedFlags[name] !== null))
    throw new Error('staging_inquiry_observed_flags_invalid');
  if (OMIT.some(name => bindings.filter(row => row.name === name && row.type === 'inherit').length !== 1)
    || ADD.some(name => bindings.some(row => row.name === name))) throw new Error('staging_inquiry_source_bindings_invalid');
  const output = structuredClone(config);
  output.unsafe.bindings = output.unsafe.bindings.filter(row => !OMIT.includes(row.name));
  for (const name of ADD) output.unsafe.bindings.push({ name, type: 'plain_text', text: 'true' });
  return output;
}

// The retained-asset uploader produces API version metadata, rather than a
// Wrangler config. Transform a clone and preserve its asset/upload metadata.
// Its caller must still pin the worker, module bytes, asset token and latest
// provider version independently before making a strict-inheritance upload.
export function prepareStagingInquiryVersionMetadata(metadata, observed, target) {
  if (!metadata || !Array.isArray(metadata.bindings) || target?.accountId !== ACCOUNT || target?.workerName !== WORKER)
    throw new Error('staging_inquiry_metadata_invalid');
  // API metadata carries keep_bindings; keep_vars is a Wrangler-only setting.
  // Target values are checked here but still require an authenticated fence.
  const wrapper = { account_id: ACCOUNT, name: WORKER, keep_vars: false,
    unsafe: { bindings: metadata.bindings, metadata: { keep_bindings: metadata.keep_bindings } } };
  const prepared = prepareStagingInquiryBindings(wrapper, observed);
  const output = structuredClone(metadata);
  output.bindings = prepared.unsafe.bindings;
  return output;
}

// Compare independently obtained version metadata. This checks only bindings;
// it neither proves that the version is serving traffic nor authorizes it.
export function verifyStagingInquiryVersionBindings(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('staging_inquiry_version_bindings_invalid');
  const index = rows => {
    if (rows.some(row => !row || typeof row.name !== 'string') || new Set(rows.map(row => row.name)).size !== rows.length)
      throw new Error('staging_inquiry_version_bindings_invalid');
    return new Map(rows.map(row => [row.name, row]));
  };
  const prior = index(before), candidate = index(after);
  if (OMIT.some(name => !isDeepStrictEqual(prior.get(name), { name, type: 'plain_text', text: 'false' }) || candidate.has(name))
    || ADD.some(name => prior.has(name) || !isDeepStrictEqual(candidate.get(name), { name, type: 'plain_text', text: 'true' })))
    throw new Error('staging_inquiry_version_flags_mismatch');
  if (candidate.size !== prior.size) throw new Error('staging_inquiry_version_bindings_drift');
  for (const [name, row] of prior) if (!OMIT.includes(name) && !isDeepStrictEqual(row, candidate.get(name)))
    throw new Error('staging_inquiry_version_bindings_drift');
  return true;
}
