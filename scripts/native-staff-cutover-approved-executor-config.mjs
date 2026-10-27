import { createHash, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PINNED_NATIVE_STAFF_CUTOVER_CONFIG_SHA256 } from './native-staff-cutover-approved-executor-config-pin-value.mjs';

// A separately reviewed Windows provisioning step must replace this zero pin.
export { PINNED_NATIVE_STAFF_CUTOVER_CONFIG_SHA256 };
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = code => { throw new Error(`native_staff_cutover_config_${code}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

export function parseNativeStaffCutoverConfig(text, expectedSha256) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 32 * 1024
    || !HASH.test(expectedSha256 ?? '') || expectedSha256 === '0'.repeat(64) || sha(text) !== expectedSha256) fail('pin_mismatch');
  let value;
  try { value = JSON.parse(text); } catch { fail('json_invalid'); }
  const keys = ['schemaVersion','kind','target','accessGroup','source','access','signer','receiptDirectory'];
  if (!exact(value, keys) || value.schemaVersion !== 1 || value.kind !== 'operations-native-staff-cutover-trust-config-v1'
    || !exact(value.target, ['accountId','databaseId','databaseName']) || !/^[a-f0-9]{32}$/u.test(value.target.accountId ?? '')
    || !UUID.test(value.target.databaseId ?? '') || typeof value.target.databaseName !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u.test(value.target.databaseName)
    || !exact(value.accessGroup, ['id','name']) || !UUID.test(value.accessGroup.id ?? '')
    || typeof value.accessGroup.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u.test(value.accessGroup.name)
    || !exact(value.source, ['commit','migrationNamesSha256','migrationContentsSha256','cutoverModuleSha256','syncPreparationModuleSha256',
      'accessGroupModuleSha256','installerModuleSha256'])
    || !COMMIT.test(value.source.commit ?? '')
    || ![value.source.migrationNamesSha256,value.source.migrationContentsSha256,value.source.cutoverModuleSha256,
      value.source.syncPreparationModuleSha256,value.source.accessGroupModuleSha256,value.source.installerModuleSha256].every(item => HASH.test(item ?? ''))
    || !exact(value.access, ['origin','issuer','audience','owner','cloudflaredExecutablePath','cloudflaredExecutableSha256'])
    || !exact(value.access.owner, ['staffId','accessSubject'])
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(value.access.owner.staffId ?? '')
    || typeof value.access.owner.accessSubject !== 'string' || !value.access.owner.accessSubject.trim()
    || value.access.owner.accessSubject.length > 191
    || !exact(value.signer, ['algorithm','keyId','publicKeyPem','protectedPrivateKeyPath','dpapiEntropy'])
    || value.signer.algorithm !== 'RSA-PSS-SHA256' || !HASH.test(value.signer.keyId ?? '')
    || typeof value.signer.publicKeyPem !== 'string' || value.signer.publicKeyPem.length > 16 * 1024
    || typeof value.signer.protectedPrivateKeyPath !== 'string' || !path.isAbsolute(value.signer.protectedPrivateKeyPath)
    || typeof value.signer.dpapiEntropy !== 'string' || value.signer.dpapiEntropy.length < 32
    || typeof value.receiptDirectory !== 'string' || !path.isAbsolute(value.receiptDirectory)) fail('schema_invalid');
  let origin, issuer, key;
  try { origin = new URL(value.access.origin); issuer = new URL(value.access.issuer); key = createPublicKey(value.signer.publicKeyPem); }
  catch { fail('schema_invalid'); }
  if (origin.protocol !== 'https:' || origin.origin !== value.access.origin || origin.username || origin.password
    || origin.port || origin.pathname !== '/' || origin.search || origin.hash
    || issuer.protocol !== 'https:' || issuer.origin !== value.access.issuer || issuer.username || issuer.password
    || issuer.port || issuer.pathname !== '/' || issuer.search || issuer.hash
    || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.hostname === '.cloudflareaccess.com'
    || typeof value.access.audience !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.access.audience)
    || typeof value.access.cloudflaredExecutablePath !== 'string' || !path.isAbsolute(value.access.cloudflaredExecutablePath)
    || !HASH.test(value.access.cloudflaredExecutableSha256 ?? '')
    || key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
    || sha(key.export({ type: 'spki', format: 'der' })) !== value.signer.keyId) fail('schema_invalid');
  return deepFreeze(value);
}

export function loadPinnedNativeStaffCutoverConfig({ env = process.env, read = readFileSync, stat = lstatSync } = {}) {
  const pin = PINNED_NATIVE_STAFF_CUTOVER_CONFIG_SHA256;
  if (!HASH.test(pin) || pin === '0'.repeat(64)) fail('pin_unprovisioned');
  if (typeof env.LOCALAPPDATA !== 'string' || !env.LOCALAPPDATA) fail('config_unavailable');
  const file = path.join(env.LOCALAPPDATA, 'LedgeTop', 'native-staff-cutover', 'trust-config.json');
  let text;
  try {
    const info = stat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 32 * 1024) fail('config_unavailable');
    text = read(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_staff_cutover_config_')) throw error;
    fail('config_unavailable');
  }
  return parseNativeStaffCutoverConfig(text, pin);
}
