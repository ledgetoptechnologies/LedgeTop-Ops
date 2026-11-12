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
const digestText = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');

export function buildContract() {
  const workers = Object.entries(sources).map(([role, path]) => {
    const raw = readFileSync(resolve(root, path), 'utf8');
    const parsed = parseConfigFileTextToJson(path, raw);
    if (parsed.error) throw Error(`Invalid source config: ${path}`);
    const config = parsed.config;
    return { role, name: target[role], accountId: 'df3f376bae6ee621f50cf972ebcc9484',
      source: { path, sha256: digestText(raw), textNormalization: 'CRLF-to-LF' },
      workersDev: false, previewUrls: false, routes: [],
      publicOrigin: ['assets', 'iosRead'].includes(role) ? null : placeholder(`${role}_protected_origin`),
      sourceEntrypoint: config.main,
      services: (config.services ?? []).map(({ binding, service, entrypoint }) => {
        if (!services[service]) throw Error(`Unreviewed service target: ${service}`);
        return { binding, target: services[service], ...(entrypoint ? { entrypoint } : {}) };
      }),
      databases: (config.d1_databases ?? []).map(({ binding }) => ({ binding,
        name: binding === 'OPS_DB' ? 'ledge-top-ops-staging' : 'ledge-top-portal-staging',
        id: placeholder(binding === 'OPS_DB' ? 'ops_database_id' : 'portal_database_id') })),
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
  return {
    schema: 'ledge-top.staging-migration-review.v1', deployable: false, providerWrites: false,
    owner: 'Merger', accountId: 'df3f376bae6ee621f50cf972ebcc9484',
    teamDomain: 'https://ledge-top-staging.cloudflareaccess.com',
    inputSourceCommit: 'f29edae3f77e4c96fea921266fe4efd49e59c489', workers,
    migrationSources: ['operations', 'client'].map(app => {
      const directory = `apps/${app}/migrations`;
      const files = readdirSync(resolve(root, directory)).filter(name => name.endsWith('.sql')).sort();
      const lines = files.map(name => `${name}\t${digestText(readFileSync(resolve(root, directory, name), 'utf8'))}\n`).join('');
      return { directory, fileCount: files.length, chainSha256: digestText(lines), textNormalization: 'CRLF-to-LF',
        ledgerRequirement: 'compare-every-applied-name-and-body-before-rehearsed-apply' };
    }),
    access: { opsAudience: placeholder('ops_audience'), portalAudience: placeholder('portal_audience'),
      syncAudience: placeholder('sync_audience'), iosAudience: placeholder('ios_oauth_audience'),
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
      keyCustody: 'new-staging-only-secrets-no-production-reuse', assetRetentionHours: 48 },
    unresolvedLiveBindings: ['CLIENT_AUTHORITY_WORKSPACE_BINDING', 'CLIENT_PORTAL_ACCESS_AUTHORITY',
      'OPS_INVENTORY_CATALOG_PROMOTION', 'OPS_INVENTORY_CATALOG_STAGING', 'VERIFIED_RECIPIENT_DELIVERY_AUTHORITY'],
    unresolvedLiveWorkflows: [{ role: 'operations', className: 'ProjectAlphaCatalogPromotionWorkflow',
      sourceWorkflowCount: 4, previouslyObservedLiveWorkflowCount: 5,
      targetName: 'REQUIRES_REVIEW:catalog-promotion-workflow-name-and-binding',
      status: 'fresh-live-readback-and-class-export-review-required' }],
    holds: ['not-a-wrangler-config', 'missing-allocated-resource-identities', 'source-live-binding-delta',
      'ios-source-reviewed-origin-pins', 'ios-live-source-enable-delta', 'verified-source-authority-and-grants',
      'private-backup-and-restored-data-parity', 'retained-asset-body-proof', 'fresh-immutable-deployment-receipts',
      'real-protected-host-and-revocation-acceptance'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(buildContract(), null, 2)}\n`);
}
