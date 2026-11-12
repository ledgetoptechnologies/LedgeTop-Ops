// Offline review contract only. Never imports Wrangler or makes network requests.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'apps/operations/package.json'));
const { parseConfigFileTextToJson } = require('typescript');
const target = {
  operations: 'ledge-top-ops-staging', client: 'ledge-top-portal-staging',
  sync: 'ledge-top-sync-staging', assets: 'ledge-top-ui-assets-staging',
  iosRead: 'ledge-top-ios-read-staging', iosEdge: 'ledge-top-ios-edge-staging',
};
const sources = {
  operations: 'apps/operations/wrangler.jsonc', client: 'apps/client/wrangler.jsonc',
  sync: 'apps/ops-sync/wrangler.jsonc', assets: 'apps/ui-release-assets/wrangler.jsonc',
  iosRead: 'apps/operations/wrangler.ios-pilot-read-staging.jsonc',
  iosEdge: 'apps/operations/wrangler.ios-pilot-edge-staging.jsonc',
};
const services = {
  'ledgetop-ops': target.operations, 'ledgetop-clients': target.client,
  'lt-ops-ios-pilot-read-staging': target.iosRead,
};
const placeholder = value => `REQUIRES_ALLOCATION:${value}`;
const allocatedDatabases = {
  OPS_DB: 'a58ea102-f04d-417a-bfd1-b0654cfeb503',
  DELIVERY_DB: '15d02028-8c52-40b2-9979-d67abf7d5bbf',
};
const digestText = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const retainedLiveServices = [
  ['CLIENT_AUTHORITY_WORKSPACE_BINDING', 'ClientAuthorityWorkspaceBindingIngress', 'client-portal-workspace-binding-outbox.ts',
    'CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED', 'Preserve workspace-binding outbox and ambiguous-result status reconciliation.'],
  ['CLIENT_PORTAL_ACCESS_AUTHORITY', 'OpsPortalAccessAuthorityIngress', 'client-portal-access-authority-outbox.ts',
    'CLIENT_PORTAL_ACCESS_AUTHORITY_OUTBOX_ENABLED', 'Preserve existing authority outbox receipts; do not recreate grants from email.'],
  ['OPS_INVENTORY_CATALOG_PROMOTION', 'OpsInventoryCatalogPromotionCoordinator', 'project-alpha-catalog-staging-coordinator.ts',
    'PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED', 'Preserve exact snapshot promotion protocol and idempotent receipt continuity.'],
  ['OPS_INVENTORY_CATALOG_STAGING', 'OpsInventoryCatalogStagingIngress', 'project-alpha-catalog-staging-coordinator.ts',
    'PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED', 'Preserve staged source pages and source sequence/snapshot authority.'],
  ['VERIFIED_RECIPIENT_DELIVERY_AUTHORITY', 'VerifiedRecipientDeliveryAuthorityIngress', 'verified-recipient-delivery-authority-ledger.ts',
    'VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED', 'Preserve reviewed recipient delivery-authority dispatch and existing receipts.'],
];

export function buildContract() {
  const workers = Object.entries(sources).map(([role, path]) => {
    const raw = readFileSync(resolve(root, path), 'utf8');
    const parsed = parseConfigFileTextToJson(path, raw);
    if (parsed.error) throw Error(`Invalid source config: ${path}`);
    const config = parsed.config;
    return { role, name: target[role], accountId: 'df3f376bae6ee621f50cf972ebcc9484',
      source: { path, sha256: digestText(raw), textNormalization: 'CRLF-to-LF' },
      workersDev: false, previewUrls: false, routes: [],
      publicOrigin: ['assets', 'iosRead'].includes(role) ? null : role === 'iosEdge'
        ? 'https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev'
        : role === 'operations' ? 'https://ledge-top-ops-staging.ledge-top-staging.workers.dev' : placeholder(`${role}_protected_origin`),
      sourceEntrypoint: config.main,
      services: (config.services ?? []).map(({ binding, service, entrypoint }) => {
        if (!services[service]) throw Error(`Unreviewed service target: ${service}`);
        return { binding, target: services[service], ...(entrypoint ? { entrypoint } : {}) };
      }),
      databases: (config.d1_databases ?? []).map(({ binding }) => ({ binding,
        name: binding === 'OPS_DB' ? 'ledge-top-ops-staging' : 'ledge-top-portal-staging',
        id: allocatedDatabases[binding] ?? (() => { throw Error(`Unreviewed database binding: ${binding}`); })() })),
      buckets: (config.r2_buckets ?? []).map(({ binding }) => ({ binding,
        name: binding === 'INCOMING_BUCKET' ? 'ledge-top-incoming-staging' : 'ledge-top-delivery-staging' })),
      workflows: (config.workflows ?? []).map(({ binding, class_name }) => ({ binding, className: class_name,
        name: `ledge-top-${class_name.replace(/Workflow$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}-staging` })),
    };
  });
  // Retained assets are a required dependency, not an implied native-ASSETS proof.
  for (const role of ['operations', 'client']) workers.find(w => w.role === role).services.push({
    binding: 'UI_RELEASE_ASSETS', target: target.assets, status: 'requires-reviewed-catalog-and-routing',
  });
  const operations = workers.find(w => w.role === 'operations');
  const reconciledLiveBindings = retainedLiveServices.map(([binding, entrypoint, caller, gate, rationale]) => ({
    binding, entrypoint, target: target.client, caller: `apps/operations/src/worker/${caller}`,
    exportSource: 'apps/client/src/worker/index.ts', gate, decision: 'preserve', rationale,
  }));
  for (const { binding, entrypoint, target: serviceTarget } of reconciledLiveBindings) {
    operations.services.push({ binding, entrypoint, target: serviceTarget, status: 'preserve-live-contract-gates-unchanged' });
  }
  operations.workflows.push({ binding: 'OPS_CATALOG_PROMOTION_WORKFLOW',
    className: 'ProjectAlphaCatalogPromotionWorkflow', name: 'ledge-top-catalog-promotion-staging',
    status: 'preserve-declaration-no-new-instances',
  });
  workers.find(w => w.role === 'iosRead').proposedEntrypoint = 'src/worker/staging-ios-private-read-entrypoint.ts';
  workers.find(w => w.role === 'iosEdge').proposedEntrypoint = 'src/worker/staging-ios-edge-entrypoint.ts';
  for (const [role, path] of [
    ['iosRead', 'apps/operations/wrangler.ios-pilot-read-staging-account.jsonc'],
    ['iosEdge', 'apps/operations/wrangler.ios-pilot-edge-staging-account.jsonc'],
  ]) workers.find(w => w.role === role).proposedConfig = { path,
    sha256: digestText(readFileSync(resolve(root, path), 'utf8')), textNormalization: 'CRLF-to-LF' };
  return {
    schema: 'ledge-top.staging-migration-review.v1', deployable: false, providerWrites: false,
    owner: 'Merger', accountId: 'df3f376bae6ee621f50cf972ebcc9484',
    teamDomain: 'https://ledge-top-staging.cloudflareaccess.com',
    baseSourceCommit: '655bdd6dd7db8fde5050f3a66d2b5027eea2b7cb', workers,
    storageAllocation: { status: 'allocated-no-schema-or-data-import',
      allocationReceipt: { file: 'merger-staging-storage-allocation-20261111.json',
        sha256: 'bbc579f205ef10d2ea8d05ce7a5e389824f67c897d5c1105d296876b2254fdd2' },
      readbackReceipt: { file: 'merger-staging-storage-readback-20261111.json',
        sha256: 'fa0fc4af2067d4178e98591cd3d2d9ae102d6553523ecc458753747eea36c788' },
      buckets: [{ name: 'ledge-top-delivery-staging', location: 'WNAM', managedPublic: false, customDomains: [] },
        { name: 'ledge-top-incoming-staging', location: 'ENAM', managedPublic: false, customDomains: [] }] },
    implementationSources: ['ios-pilot-reviewed-origins.ts', 'ios-pilot-read-entrypoint.ts',
      'ios-pilot-edge-bridge.ts', 'staging-ios-private-read-entrypoint.ts', 'staging-ios-edge-entrypoint.ts'].map(name => {
      const path = `apps/operations/src/worker/${name}`;
      return { path, sha256: digestText(readFileSync(resolve(root, path), 'utf8')), textNormalization: 'CRLF-to-LF' };
    }),
    migrationSources: ['operations', 'client'].map(app => {
      const directory = `apps/${app}/migrations`;
      const files = readdirSync(resolve(root, directory)).filter(name => name.endsWith('.sql')).sort();
      const lines = files.map(name => `${name}\t${digestText(readFileSync(resolve(root, directory, name), 'utf8'))}\n`).join('');
      return { directory, fileCount: files.length, chainSha256: digestText(lines), textNormalization: 'CRLF-to-LF',
        ledgerRequirement: 'compare-every-applied-name-and-body-before-rehearsed-apply' };
    }),
    access: { opsAudience: 'ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84', portalAudience: placeholder('portal_audience'),
      syncAudience: placeholder('sync_audience'), iosAudience: '17f32ab9f964a3e4c64864e06d3d0e1b128604192b9a7e457db1f8f88b8f5707',
      reviewedAllocations: [
        { role: 'ios', appId: '3ebfae1c-321b-46c6-ba56-6be95f95c50f', receipt: 'merger-ios-staging-access-20261111.json',
          sha256: 'b723814a8c23e37e39dbafdb6aee250c0aa9d920814324b7f9620e5f2d6b4d18', backendDeployed: false },
        { role: 'operations', appId: '37c5049c-a787-49cf-ac43-ba4d340bee70', receipt: 'merger-ops-staging-closed-access-20261111.json',
          sha256: '598160b9e0d729b2f3490b689f91be6d753925dee8ed65fd04c47dddb94facc2', admission: 'deny-everyone', backendDeployed: false },
      ],
      groupId: placeholder('staging_staff_group_id'), callback: 'com.ledgetoptechnologies.ops.pilot://auth/callback',
      pkce: 'public-client-required', providerMetadata: 'must-be-verified-before-app-pin-changes' },
    queues: ['file-events', 'file-events-dlq', 'thumbnail-jobs', 'thumbnail-jobs-dlq'].map(name => ({
      name: `ledge-top-${name}-staging`, id: placeholder(`${name}_queue_id`), activeConsumers: false,
    })),
    durableObjects: [{ binding: 'THUMBNAIL_RENDERER', className: 'ThumbnailRendererContainer',
      namespaceId: placeholder('thumbnail_namespace_id'), containerName: 'ledge-top-thumbnail-staging',
      enablement: 'requires-staging-entitlement-and-state-continuity-review' }],
    activation: { crons: false, queueConsumers: false, publicRoutes: false, iosManagedPilot: 'unresolved-live-source-delta',
      sourceAuthority: 'requires-preserved-or-explicitly-approved-mapping',
      keyCustody: 'new-staging-only-secrets-no-production-reuse', assetRetentionHours: 48,
      stagingBackupRequired: false },
    reconciledLiveBindings,
    liveEvidence: { file: 'merger-staging-live-binding-readback-20261111.json',
      sha256: '1925aa7968e1cc12aeb3138a05d09f35d7fc5f0bce61e700e69fa20088d3a54f',
      iosEdgeEnabled: true, iosReaderEnabled: true, sourceIosEnabled: false,
      targetIosEnabled: 'requires-explicit-reconciliation-before-activation',
      workflow: { binding: 'OPS_CATALOG_PROMOTION_WORKFLOW', className: 'ProjectAlphaCatalogPromotionWorkflow',
        legacyName: 'ledgetop-ops-catalog-promotion-staging', proposedName: 'ledge-top-catalog-promotion-staging',
        identityContinuity: 'not-preserved-by-renaming-requires-explicit-instance-history-reconciliation',
        sourceWorkflowCount: 4, liveWorkflowCount: 5,
        exportSource: 'apps/operations/src/worker/index.ts',
        caller: 'control-plane-workflow-dispatch-no-Env-caller-found',
        rationale: 'Retain old instances/history in place until Merger reconciles their outcomes; new name does not transfer executions. No automatic launch, replay or inferred retirement.' } },
    unresolvedLiveBindings: [], unresolvedLiveWorkflows: [],
    holds: ['not-a-wrangler-config', 'missing-allocated-resource-identities', 'materialize-reviewed-live-bindings',
      'catalog-workflow-identity-and-instance-history-migration',
      'ios-source-reviewed-origin-pins', 'ios-live-source-enable-delta', 'verified-source-authority-and-grants',
      'retained-data-and-authority-parity', 'retained-asset-body-proof', 'fresh-immutable-deployment-receipts',
      'real-protected-host-and-revocation-acceptance'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(buildContract(), null, 2)}\n`);
}
