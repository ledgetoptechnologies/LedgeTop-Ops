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
