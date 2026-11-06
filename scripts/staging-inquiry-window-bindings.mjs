import { isDeepStrictEqual } from 'node:util';

// Pure preparation only: callers must independently verify current provider
// state and the exact version/asset/authority fences before any upload.
const ACCOUNT = '846c924bf17bf4f3dd15c97a4c5d1d51';
const WORKER = 'ledgetop-ops-staging';
const OMIT = ['CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED'];
const ADD = ['CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED', 'OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED'];

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
