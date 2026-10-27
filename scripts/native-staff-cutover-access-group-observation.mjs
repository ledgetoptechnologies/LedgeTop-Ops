import { createHash } from 'node:crypto';

const fail = code => { throw new Error(`native_staff_access_group_${code}`); };
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RULES = 10_000;
const MAX_OBSERVATION_AGE_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const FRESH_READER_OBSERVATIONS = new WeakSet();
const OBSERVATION_KEYS = ['schemaVersion','kind','accountId','groupId','groupName','observedAt','managedEmailCount',
  'managedEmailsSha256','includeRuleCount','policySha256','providerResponseSha256','evidenceSha256'];
const GROUP_RESULT_KEYS = ['id','name','include','exclude','require','is_default','created_at','updated_at'];
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateTarget(config) {
  if (!config || !config.target || !/^[a-f0-9]{32}$/u.test(config.target.accountId ?? '')
    || !config.accessGroup || !UUID.test(config.accessGroup.id ?? '')
    || typeof config.accessGroup.name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u.test(config.accessGroup.name)) fail('target_unpinned');
  return { accountId: config.target.accountId, groupId: config.accessGroup.id, groupName: config.accessGroup.name };
}

function normalizeGroup(result, expected) {
  if (!exact(result, Reflect.ownKeys(result ?? {}).filter(key => typeof key === 'string'))
    || Reflect.ownKeys(result).some(key => !GROUP_RESULT_KEYS.includes(key))
    || !['id','name','include','exclude','require','is_default'].every(key => Object.hasOwn(result, key))
    || ['created_at','updated_at'].some(key => Object.hasOwn(result, key) && typeof result[key] !== 'string')) fail('group_shape_invalid');
  if (result.id !== expected.groupId || result.name !== expected.groupName
    || !Array.isArray(result.include) || !Array.isArray(result.exclude) || !Array.isArray(result.require)
    || !Array.isArray(result.is_default) || result.include.length > MAX_RULES
    || result.exclude.length > MAX_RULES || result.require.length > MAX_RULES) fail('group_identity_or_policy_invalid');
  // This cutover profile observes an include-only employee group. Cloudflare
  // models all three policy fields as AccessRule arrays; do not silently accept
  // an unfamiliar or additional policy rule merely because it hashes cleanly.
  if (result.exclude.length !== 0 || result.require.length !== 0 || result.is_default.length !== 0)
    fail('unsupported_group_policy');

  const members = result.include.map(rule => {
    if (!exact(rule, ['email']) || !exact(rule.email, ['email']) || typeof rule.email.email !== 'string') fail('unmanaged_include_rule');
    const email = rule.email.email.trim().toLowerCase();
    if (email.length < 3 || email.length > 254 || /[\p{Cc}\p{Cf}]/u.test(email) || !/^[^\s@]+@[^\s@]+$/u.test(email))
      fail('group_member_invalid');
    return email;
  }).sort();
  if (new Set(members).size !== members.length) fail('group_member_duplicate');

  const policy = { exclude: result.exclude, require: result.require, is_default: result.is_default };
  let policyJson;
  try { policyJson = canonical(policy); }
  catch { fail('group_policy_invalid'); }
  if (Buffer.byteLength(policyJson, 'utf8') > MAX_BODY_BYTES) fail('group_policy_invalid');
  return { members, policySha256: sha(policyJson), includeRuleCount: result.include.length };
}

function validateNotices(value) {
  if (!Array.isArray(value) || value.length > MAX_RULES) fail('provider_envelope_invalid');
  for (const notice of value) {
    const keys=['code','message','documentation_url','source'].filter(key=>Object.hasOwn(notice??{},key));
    if (!exact(notice,keys) || !Object.hasOwn(notice,'code') || !Object.hasOwn(notice,'message')
      || !Number.isSafeInteger(notice.code) || notice.code < 1000 || typeof notice.message !== 'string'
      || Object.hasOwn(notice,'documentation_url') && typeof notice.documentation_url !== 'string'
      || Object.hasOwn(notice,'source') && (!exact(notice.source,Object.hasOwn(notice.source??{},'pointer')?['pointer']:[])
        || Object.hasOwn(notice.source,'pointer') && typeof notice.source.pointer !== 'string')) fail('provider_envelope_invalid');
  }
  return value;
}

function validateTimestamp(value, now) {
  if (!Number.isSafeInteger(now) || now < 0) fail('clock_invalid');
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) fail('observation_time_invalid');
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value
    || epoch > now + MAX_CLOCK_SKEW_MS || now - epoch > MAX_OBSERVATION_AGE_MS) fail('observation_stale');
  return epoch;
}

/** Validate safe serialized evidence. Freshness still requires a new GET via readNativeStaffAccessGroupObservation. */
export function validateNativeStaffAccessGroupObservation(value, { now = Date.now() } = {}) {
  if (!exact(value, OBSERVATION_KEYS) || value.schemaVersion !== 1
    || value.kind !== 'cloudflare-access-group-observation-v1'
    || !/^[a-f0-9]{32}$/u.test(value.accountId ?? '') || !UUID.test(value.groupId ?? '')
    || typeof value.groupName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u.test(value.groupName)
    || !Number.isSafeInteger(value.managedEmailCount) || value.managedEmailCount < 0 || value.managedEmailCount > MAX_RULES
    || !Number.isSafeInteger(value.includeRuleCount) || value.includeRuleCount !== value.managedEmailCount
    || ![value.managedEmailsSha256,value.policySha256,value.providerResponseSha256,value.evidenceSha256].every(hash => HASH.test(hash ?? '')))
    fail('evidence_shape_invalid');
  validateTimestamp(value.observedAt, now);
  const { evidenceSha256, ...body } = value;
  if (sha(canonical(body)) !== evidenceSha256) fail('evidence_digest_invalid');
  return deepFreeze({ ...body, evidenceSha256 });
}

/**
 * Compare the security-relevant current group state. Observation time and raw
 * response digest are bound by the approval receipt but naturally differ on a
 * fresh GET; identity, complete member set and policy must remain exact.
 */
export function assertNativeStaffAccessGroupStateMatches(left, right, { now = Date.now() } = {}) {
  const first = validateNativeStaffAccessGroupObservation(left, { now });
  const second = validateNativeStaffAccessGroupObservation(right, { now });
  if (first.accountId !== second.accountId || first.groupId !== second.groupId || first.groupName !== second.groupName
    || first.managedEmailCount !== second.managedEmailCount || first.managedEmailsSha256 !== second.managedEmailsSha256
    || first.includeRuleCount !== second.includeRuleCount || first.policySha256 !== second.policySha256)
    fail('group_state_changed');
  return true;
}

/** An observation serialized to disk is not a fresh provider read. */
export function assertNativeStaffAccessGroupObservationWasReadHere(value) {
  if (!FRESH_READER_OBSERVATIONS.has(value)) fail('serialized_observation_not_fresh');
  return true;
}

async function readBoundedBody(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await response.body?.cancel().catch(() => {});
    fail('response_too_large');
  }
  if (!response.body) fail('response_body_missing');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        fail('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message.startsWith('native_staff_access_group_')) throw error;
    fail('response_read_failed');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

/** One bounded GET. No retries, redirects, writes, or caller-supplied endpoint. */
export async function readNativeStaffAccessGroupObservation({ config, getBearerToken, fetchImpl = globalThis.fetch,
  now = Date.now } = {}) {
  const target = validateTarget(config);
  if (typeof getBearerToken !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') fail('reader_unavailable');
  const token = await getBearerToken();
  if (typeof token !== 'string' || token.length < 20 || token.length > 16_384 || !/^[\x21-\x7e]+$/u.test(token)) fail('provider_token_invalid');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId)}/access/groups/${encodeURIComponent(target.groupId)}`;
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(8_000) });
  } catch { fail('provider_read_failed'); }
  if (!response || response.redirected || response.status !== 200 || response.url && response.url !== endpoint) {
    await response?.body?.cancel().catch(() => {});
    fail('provider_response_invalid');
  }
  const raw = await readBoundedBody(response);
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { fail('response_json_invalid'); }
  if (!exact(envelope,Reflect.ownKeys(envelope??{}).filter(key=>typeof key==='string'))
    || Reflect.ownKeys(envelope).some(key=>!['success','result','errors','messages'].includes(key))) fail('provider_envelope_invalid');
  const errors=Object.hasOwn(envelope,'errors')?validateNotices(envelope.errors):[];
  if (Object.hasOwn(envelope,'messages')) validateNotices(envelope.messages);
  if (envelope.success !== true || errors.length !== 0
    || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) fail('provider_envelope_invalid');
  const normalized = normalizeGroup(envelope.result, target);
  const observedAt = new Date(now()).toISOString();
  const body = { schemaVersion: 1, kind: 'cloudflare-access-group-observation-v1', accountId: target.accountId,
    groupId: target.groupId, groupName: target.groupName, observedAt,
    managedEmailCount: normalized.members.length, managedEmailsSha256: sha(canonical(normalized.members)),
    includeRuleCount: normalized.includeRuleCount, policySha256: normalized.policySha256,
    providerResponseSha256: sha(raw) };
  const observation=validateNativeStaffAccessGroupObservation({ ...body, evidenceSha256: sha(canonical(body)) }, { now: now() });
  FRESH_READER_OBSERVATIONS.add(observation);
  return observation;
}

/** Fresh GET compared to the reviewed pair; provider details remain in memory. */
export async function assertFreshNativeStaffAccessGroup({ config, reviewedBefore, reviewedAfter, getBearerToken,
  fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const before = validateNativeStaffAccessGroupObservation(reviewedBefore, { now: now() });
  const after = validateNativeStaffAccessGroupObservation(reviewedAfter, { now: now() });
  assertNativeStaffAccessGroupStateMatches(before, after, { now: now() });
  const live = await readNativeStaffAccessGroupObservation({ config, getBearerToken, fetchImpl, now });
  assertNativeStaffAccessGroupStateMatches(after, live, { now: now() });
  return live;
}
