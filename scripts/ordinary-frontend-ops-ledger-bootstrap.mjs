/** Exact one-time bridge from the reviewed a459 Operations legacy ledgers to
 * the v2 native retained-ledger module. Its result is reconstructed from the
 * pinned, previously accepted 471-row packet and fresh byte reads through the
 * current active version. It never treats the legacy ledgers' 393/432 rows as
 * a complete inventory, and its SHA-prefix provider IDs are reconstructions,
 * not claims about Cloudflare's existing asset identifiers. */
import { createHash } from 'node:crypto';
import { readPinnedAssetInventoryBootstrap, prepareAssetInventoryBootstrap,
  completeAssetInventoryBootstrap } from './production-auto-asset-bootstrap.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { ledgerBytes, validateAssetLedger } from './production-auto-assets.mjs';
import { parseProviderUtcTimestamp } from './production-auto-time.mjs';
import { canonical, need } from './production-deploy.mjs';

export const OPS_LEGACY_LEDGER_BOOTSTRAP = Object.freeze({
  activeVersionId: 'a45943f4-e5c5-4142-9057-fb9adb5cf739',
  modules: Object.freeze({
    '__ops_c880_retention_ledger.json': Object.freeze({ size: 66973,
      sha256: 'ccee26957c3c99ff28a1f4c4d6c5a29c6ce97033fd5978f00d1a5b3422c155aa' }),
    '__ops_release_ledger.json': Object.freeze({ size: 60961,
      sha256: '29c66e83afb37a9a2952c8606318949a5ee9ee05a62b3e8c8bb0e29c14080b1d' }),
  }),
  acceptedPacketVersionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a,b) => canonical(a) === canonical(b);

/** Return null for all other active versions. At the exact observed a459
 * baseline, any module omission, duplicate, or digest drift is a hard hold. */
export function prepareOpsLegacyLedgerBootstrap(snapshot) {
  const state = snapshot?.operations;
  if (state?.version?.id !== OPS_LEGACY_LEDGER_BOOTSTRAP.activeVersionId) return null;
  need(state.modern?.id === OPS_LEGACY_LEDGER_BOOTSTRAP.activeVersionId,
    'Ops legacy-ledger bootstrap active version mismatch');
  const modules = state.modern.modules;
  need(Array.isArray(modules), 'Ops legacy-ledger module inventory missing');
  const context = {};
  for (const [name, pin] of Object.entries(OPS_LEGACY_LEDGER_BOOTSTRAP.modules)) {
    const rows = modules.filter(module => module?.name === name);
    need(rows.length === 1 && rows[0].content_type === 'text/plain' && typeof rows[0].content_base64 === 'string',
      'Ops legacy-ledger module missing or duplicated');
    const encoded = rows[0].content_base64;
    need(encoded.length <= 4 * Math.ceil(pin.size / 3) && encoded.length % 4 === 0,
      'Ops legacy-ledger module encoding size invalid');
    const bytes = Buffer.from(encoded, 'base64');
    need(bytes.length === pin.size && bytes.toString('base64') === encoded && digest(bytes) === pin.sha256,
      'Ops legacy-ledger module differs from exact observed baseline pin');
    context[name] = bytes;
  }
  const workerName = 'ledgetop-ops', accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  const bootstrap = readPinnedAssetInventoryBootstrap({ workerName,
    activeVersionId: OPS_LEGACY_LEDGER_BOOTSTRAP.acceptedPacketVersionId });
  need(bootstrap, 'Previously accepted complete Ops asset packet is unavailable');
  const receipt = JSON.parse(bootstrap.acceptedReceiptBytes.toString('utf8'));
  const packet = JSON.parse(bootstrap.packetManifestBytes.toString('utf8'));
  const index = packet.union?.files?.find(row => row.path === '/index.html');
  const acceptedCutover = parseProviderUtcTimestamp(receipt.cutoverAt);
  need(index && acceptedCutover, 'Pinned Ops packet lacks accepted index/cutover evidence');
  const staleIndex = Buffer.from('retired passive index placeholder');
  const prior = validateAssetLedger({ schemaVersion: 1, workerName, accountId, sourceCommit: packet.sourceCommit,
    parentVersionId: state.version.id, observedAt: new Date(acceptedCutover.milliseconds).toISOString(), minimumRetentionHours: 48, automaticPruning: false,
    assets: [{ path: '/index.html', size: staleIndex.length, sha256: digest(staleIndex), mime: 'text/html',
      providerHash: digest(staleIndex).slice(0, 32) }] }, { workerName, accountId });
  const prepared = prepareAssetInventoryBootstrap({ bootstrap, previous: prior,
    activeVersionId: OPS_LEGACY_LEDGER_BOOTSTRAP.acceptedPacketVersionId, workerName, accountId });
  need(prepared.rows.length === 471, 'Pinned Ops bootstrap packet no longer contains the complete reviewed 471-row union');
  return Object.freeze({ activeVersionId: state.version.id, workerName, accountId, bootstrap, prior, prepared,
    previousAssetRows: Object.freeze(prepared.rows.map(({ path, size, sha256, mime }) => ({ path, size, sha256, mime }))),
    legacyModuleSHA256: Object.freeze(Object.fromEntries(Object.entries(context).map(([name, bytes]) => [name, digest(bytes)]))) });
}

/** Complete the baseline only after every current active-version byte is read
 * through the closed nonce verifier. IDs are derived from those bytes. */
export function completeOpsLegacyLedgerBootstrap(context, { verifiedAssets, verifiedVersionId } = {}) {
  need(context?.activeVersionId === OPS_LEGACY_LEDGER_BOOTSTRAP.activeVersionId
    && verifiedVersionId === context.activeVersionId && verifiedAssets instanceof Map,
  'Fresh current-version Ops bootstrap byte proof is required');
  const prior = completeAssetInventoryBootstrap({ bootstrap: context.bootstrap, previous: context.prior,
    verifiedAssets, activeVersionId: OPS_LEGACY_LEDGER_BOOTSTRAP.acceptedPacketVersionId,
    workerName: context.workerName, accountId: context.accountId });
  return validateAssetLedger({ ...prior, parentVersionId: context.activeVersionId },
    { workerName: context.workerName, accountId: context.accountId });
}

/** Pure planner-side reconstruction check. The caller's byte map is evidence
 * only when produced by the executor's active-version nonce verifier. */
export function validateOpsLegacyLedgerBootstrap(snapshot, { previousLedger, previousAssetBytes } = {}) {
  const context = prepareOpsLegacyLedgerBootstrap(snapshot);
  need(context && previousAssetBytes instanceof Map, 'Exact Ops legacy-ledger bootstrap evidence required');
  const rebuilt = completeOpsLegacyLedgerBootstrap(context, { verifiedAssets: previousAssetBytes,
    verifiedVersionId: context.activeVersionId });
  need(equal(rebuilt, validateAssetLedger(previousLedger, { workerName: context.workerName, accountId: context.accountId }))
    && ledgerBytes(rebuilt).equals(ledgerBytes(previousLedger)),
  'Supplied Ops prior ledger does not reconstruct from the accepted packet and exact current active bytes');
  return rebuilt;
}
