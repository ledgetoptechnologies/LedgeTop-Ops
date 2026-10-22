import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'browser_workspace_token_1234567890abcdef';
const manualFixture = process.env.LTDS_WORKSPACE_MANUAL_QA === '1';
const manualFixtureGrant = 'local_fixture_grant_00000000000000000000';
// Manual mode serves only the synthetic API/compiled UI; it never launches a browser.
// Browser interaction remains with the user's selected in-app browser.
if (manualFixture) setImmediate(async () => {
  const fixture = await startFixtureServer();
  console.log(`Synthetic workspace QA: ${fixture.origin}/workspace/${manualFixtureGrant}`);
  console.log(`Responsive synthetic QA: ${fixture.origin}/manual-responsive?width=390`);
  const stop = () => fixture.server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
});
const orthophotoFixture = Buffer.from(writeArrayBuffer(new Uint8Array([
  238,80,7, 255,150,48,
  34,97,74, 109,190,140,
]), { width:2, height:2, SamplesPerPixel:3, BitsPerSample:[8,8,8], PhotometricInterpretation:2, PlanarConfiguration:1 }));

const fixtures = {
  projects: [
    { id: 'project-johnson', displayName: 'Johnson Road Survey', description: 'Road corridor reconstruction', status: 'active' },
    { id: 'project-quarry', displayName: 'Alpha Quarry', description: 'Quarry progress capture', status: 'active' },
  ],
  datasets: [
    { id: 'dataset-johnson', projectId: 'project-johnson', displayName: 'Johnson imagery', status: 'finalized', fileCount: 48, byteSize: 7340032 },
    { id: 'dataset-quarry', projectId: 'project-quarry', displayName: 'Quarry imagery', status: 'finalized', fileCount: 12, byteSize: 1048576 },
  ],
  tasks: [
    {
      id: 'task-johnson', projectId: 'project-johnson', datasetId: 'dataset-johnson', displayName: 'Johnson reconstruction',
      status: 'processing', createdAt: '2026-08-19T12:00:00.000Z',
      metrics: { sourceImageCount: 48 },
      latestAttempt: {
        id: 'attempt-johnson', attemptNumber: 2, providerId: 'provider-nodeodm', status: 'running',
        createdAt: '2026-08-19T12:00:00.000Z', startedAt: '2026-08-19T12:01:00.000Z', updatedAt: '2026-08-19T12:05:00.000Z',
      },
    },
    {
      id: 'task-quarry', projectId: 'project-quarry', datasetId: 'dataset-quarry', displayName: 'Quarry reconstruction',
      status: 'ready_for_review', createdAt: '2026-08-18T12:00:00.000Z', metrics: { sourceImageCount: 12 },
      latestAttempt: { id: 'attempt-quarry', attemptNumber: 1, providerId: 'provider-nodeodm', status: 'ready_for_review', createdAt: '2026-08-18T12:00:00.000Z', updatedAt: '2026-08-18T12:05:00.000Z' },
    },
  ],
  providers: [
    {
      id: 'provider-nodeodm', displayName: 'TrueNAS NodeODM', type: 'nodeodm', endpoint: 'https://nodeodm.example.test',
      enabled: true, admissionLimit: 2, runtimeHealth: 'healthy', capabilityFingerprint: 'browser-fingerprint', credential: { configured: true, mode: 'token' },
      capabilities: {
        providerType: 'nodeodm', apiVersion: '2.2.3', engine: 'ODM', engineVersion: '3.5.0', taskQueueCount: 1,
        maxParallelTasks: 99999999999, options: [
          { name: 'orthophoto-resolution', type: 'float', value: 5, domain: 'float > 0', help: 'Orthophoto resolution in cm/pixel.' },
          { name: 'dsm', type: 'bool', value: false, help: 'Generate a digital surface model.' },
          { name: 'feature-quality', type: 'string', value: 'high', domain: ['ultra', 'high', 'medium', 'low', 'lowest'], help: 'Feature extraction quality.' },
          { name: 'min-num-features', type: 'int', value: 10000, help: 'Minimum number of features per image.' },
        ],
      },
    },
  ],
  presets: [{ id: 'preset-fast', displayName: 'Fast', description: '', providerType: 'nodeodm', capabilityFingerprint: 'browser-fingerprint', options: {}, enabled: true, builtIn: false }],
  outputs: [{
    id: 'output-johnson', taskId: 'task-johnson', modelId: 'model-johnson', displayName: 'Johnson output',
    status: 'published', activePublished: true, byteSize: 4096, assetCount: 3, assetKinds: ['glb', 'ortho', 'report'],
    downloadProducts: [
      { kind: 'glb', label: 'Textured model (glTF)', format: 'GLB', byteSize: 2048, fileName: 'johnson-model.glb', grantUrl: '/api/v1/processing/outputs/output-johnson/products/glb/download-grants' },
      { kind: 'ortho', label: 'Orthophoto', format: 'GeoTIFF', byteSize: 1024, fileName: 'johnson-orthophoto.tif', grantUrl: '/api/v1/processing/outputs/output-johnson/products/ortho/download-grants' },
      { kind: 'report', label: 'Quality report', format: 'PDF', byteSize: 1024, fileName: 'johnson-report.pdf', grantUrl: '/api/v1/processing/outputs/output-johnson/products/report/download-grants' },
    ],
    lod: { status: 'fallback', canGenerate: false, canRetry: true, jobId: 'derivative-stale-fallback', reason: 'Imported tiles did not verify.', recoveryAction: { kind: 'new_version', eligible: true, sourceVersionId: 'output-johnson', endpoint: '/api/v1/processing/outputs/output-johnson/lod-recovery-attempts', reason: 'Create a new immutable recovery version.' } },
    downloadUrl: '/api/v1/processing/outputs/output-johnson/assets/glb',
    reportUrl: '/api/v1/processing/outputs/output-johnson/assets/report',
    viewSessionUrl: '/api/v1/processing/outputs/output-johnson/view-sessions',
  }, {
    id: 'output-johnson-archived', taskId: 'task-johnson', modelId: 'model-johnson-old', displayName: 'Johnson archived output',
    status: 'archived', activePublished: false, byteSize: 2048, assetCount: 1, assetKinds: [],
  }, {
    id: 'output-quarry-ready', taskId: 'task-quarry', modelId: 'model-quarry', attemptId: 'attempt-quarry', displayName: 'Quarry ready output',
    status: 'ready', activePublished: false, byteSize: 3072, assetCount: 3, assetKinds: ['glb', 'ortho', 'report'],
    lod: { status: 'eligible', canGenerate: true },
    downloadUrl: '/api/v1/processing/outputs/output-quarry-ready/assets/glb',
    reportUrl: '/api/v1/processing/outputs/output-quarry-ready/assets/report',
  }],
  operations: [{
    id: 'operation-running', type: 'webodm_task_import', subject: 'server import', projectId: 'project-johnson',
    status: 'leased', phase: 'adopting', progress: .35, source: { kind: 'server_zip', browserTransferRequired: false, transferComplete: true },
    attemptCount: 1, heartbeatAt: '2026-08-19T13:04:00.000Z', createdAt: '2026-08-19T13:00:00.000Z', updatedAt: '2026-08-19T13:04:00.000Z',
  }, {
    id: 'operation-failed', type: 'webodm_task_import', subject: 'failed import', projectId: 'project-quarry',
    status: 'failed', phase: 'failed', progress: .25, source: { kind: 'server_folder', browserTransferRequired: false, transferComplete: true },
    attemptCount: 1, errorCode: 'invalid_archive', errorMessage: 'The archive could not be imported.', createdAt: '2026-08-19T11:00:00.000Z', updatedAt: '2026-08-19T11:02:00.000Z',
  }, {
    id: 'operation-recovery-failed', type: 'lod_recovery', subject: 'failed recovery', projectId: 'project-johnson',
    sourceOutputId: 'output-johnson',
    status: 'failed', phase: 'failed', progress: .6, source: { kind: 'existing_model', browserTransferRequired: false, transferComplete: true },
    attemptCount: 1, errorCode: 'lod_recovery_source_changed', errorMessage: 'Recovery source validation failed; the existing model remains safe.', createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:02:00.000Z',
  }],
  derivatives: [
    { id: 'derivative-running', attemptId: 'attempt-running', type: 'lod_audit', status: 'leased', optional: true, result: {}, taskId: 'task-running', taskDisplayName: 'Existing tile audit', projectId: 'project-johnson', projectDisplayName: 'Johnson Road Survey', heartbeatAt: '2026-08-19T13:04:00.000Z', createdAt: '2026-08-19T13:00:00.000Z', updatedAt: '2026-08-19T13:04:00.000Z' },
    { id: 'derivative-queued', attemptId: 'attempt-queued', type: 'mesh_tiles', status: 'pending', optional: true, result: {}, taskId: 'task-queued', taskDisplayName: 'Queued tile model', projectId: 'project-quarry', projectDisplayName: 'Alpha Quarry', createdAt: '2026-08-19T12:00:00.000Z', updatedAt: '2026-08-19T12:00:00.000Z' },
    { id: 'derivative-failed', attemptId: 'attempt-johnson', type: 'mesh_tiles', status: 'failed', optional: true, result: { error: 'Tile conversion failed; the original model remains available.' }, taskId: 'task-johnson', taskDisplayName: 'Johnson task', projectId: 'project-johnson', projectDisplayName: 'Johnson Road Survey', createdAt: '2026-08-19T11:00:00.000Z', updatedAt: '2026-08-19T11:02:00.000Z' },
  ],
};

function browserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(existsSync) || null;
}

async function removeBrowserProfile(profile, t) {
  if (!profile) return;
  const resolved = path.resolve(profile);
  const expectedPrefix = path.resolve(tmpdir(), 'ltds-viewer-browser-');
  if (!resolved.startsWith(expectedPrefix)) throw new Error(`refusing to remove unexpected browser profile: ${resolved}`);
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(lastError?.code)) {
    t.diagnostic(`Windows retained a lock on temporary browser profile ${resolved}; functional browser assertions completed.`);
    return;
  }
  throw lastError;
}

function json(response, status = 200) {
  return { status, body: Buffer.from(JSON.stringify(response)), type: 'application/json; charset=utf-8' };
}

function apiResponse(url, runtime, method = 'GET', body = {}) {
  const pathname = url.pathname;
  if (pathname === '/api/v1/admin-sessions/current') {
    return json({
      controllerOrigin: 'https://ops.example.test',
      session: {
        id: 'browser-session', subject: 'ops:browser-audit', displayUnits: 'imperial',
        permissions: runtime.permissions || ['viewer.projects.read','viewer.projects.write','viewer.datasets.read','viewer.datasets.write','viewer.datasets.import','viewer.processing.read','viewer.processing.write','viewer.processing.publish','viewer.providers.read','viewer.providers.write','viewer.storage.purge','viewer.gcp.read','viewer.gcp.write','viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.client_grants.manage'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
  }
  if (pathname === '/api/v1/projects') return json({ projects: fixtures.projects.filter(item=>!runtime.archivedProjects.has(item.id)), nextCursor: null });
  if (pathname === '/api/v1/datasets') return json({ datasets: fixtures.datasets, nextCursor: null });
  if (pathname === '/api/v1/tasks') return json({ tasks: fixtures.tasks.filter(item=>!runtime.archivedTasks.has(item.id)), nextCursor: null });
  if (pathname === '/api/v1/processing/providers' && method === 'GET') return json({ providers: fixtures.providers });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm' && method === 'PATCH') return json({ provider: { ...fixtures.providers[0], ...body } });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm/credential' && ['PUT', 'DELETE'].includes(method)) return json({ provider: fixtures.providers[0] });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm/capabilities/probe' && method === 'POST') return json({ capabilities: fixtures.providers[0].capabilities, fingerprint: 'browser-fingerprint' });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm/capabilities/refresh' && method === 'POST') return json({ capabilities: fixtures.providers[0].capabilities, fingerprint: 'browser-fingerprint' });
  if (pathname === '/api/v1/processing/presets' && method === 'GET') return json({ presets: fixtures.presets });
  if (pathname === '/api/v1/processing/presets' && method === 'POST') return json({ preset: { id: 'preset-new', providerType: 'nodeodm', capabilityFingerprint: 'browser-fingerprint', ...body } }, 201);
  if (pathname.startsWith('/api/v1/processing/presets/') && ['PATCH', 'DELETE'].includes(method)) return method === 'DELETE' ? { status: 204, body: Buffer.alloc(0), type: 'application/json' } : json({ preset: { ...fixtures.presets[0], ...body } });
  if (pathname === '/api/v1/processing/outputs') return json({ outputs: runtime.outputs, nextCursor: null });
  const shareMatch = pathname.match(/^\/api\/v1\/processing\/outputs\/([^/]+)\/shares$/);
  if (shareMatch) {
    const output = runtime.outputs.find(item => item.id === shareMatch[1]);
    if (!output) return json({ error: 'output_not_found' }, 404);
    if (method === 'GET') return json({ shares: runtime.shares.filter(item => item.outputId === output.id),
      publicationRequired: !output.activePublished, existingAccessUpdateRequired: false,
      eligibleAssetKinds: output.assetKinds.filter(kind => kind !== 'report') });
    if (manualFixture && method === 'POST') {
      if (!output.activePublished && body.publishIfReady !== true) return json({ error: 'publication_confirmation_required' }, 409);
      output.activePublished = true; output.status = 'published';
      const share = { id: `synthetic-share-${runtime.shares.length + 1}`, outputId: output.id,
        label: body.label, hasPassword: Boolean(body.password), revokedAt: null,
        expiresAt: body.expiresAt || null, permissions: body.permissions,
        allowedViews: body.allowedViews ?? null, accessCount: 0 };
      runtime.shares.push(share);
      return json({ share, viewUrl: `/share/synthetic-${share.id}` }, 201);
    }
  }
  const managedShare = pathname.match(/^\/api\/v1\/processing\/shares\/([^/]+)(\/link)?$/);
  if (manualFixture && managedShare && ['GET', 'PATCH'].includes(method)) {
    const share = runtime.shares.find(item => item.id === managedShare[1]);
    if (!share || share.revokedAt) return json({ error: 'share_not_found' }, 404);
    if (managedShare[2] && method === 'GET') return json({ viewUrl: `/share/synthetic-${share.id}` });
    if (!managedShare[2] && method === 'PATCH') {
      for (const key of ['label', 'expiresAt', 'permissions', 'allowedViews']) {
        if (Object.hasOwn(body, key)) share[key] = body[key];
      }
      if (Object.hasOwn(body, 'password')) share.hasPassword = Boolean(body.password);
      return json({ share });
    }
  }
  if (manualFixture && pathname.startsWith('/api/v1/processing/shares/') && method === 'DELETE') {
    const share = runtime.shares.find(item => pathname.endsWith(`/${item.id}`));
    if (!share) return json({ error: 'share_not_found' }, 404);
    share.revokedAt = new Date().toISOString();
    return json({ share });
  }
  if (pathname === '/api/v1/processing/outputs/output-johnson/view-sessions' && method === 'POST') return json({ grant: '99999999-8888-4777-8666-555555555555', sessionMode: 'published', sessionTtlSeconds: 1800, modelId: 'model-johnson', modelVersionId: 'output-johnson', embedUrl: '/session/99999999-8888-4777-8666-555555555555' }, 201);
  if (pathname === '/api/v1/attempts/attempt-quarry/review-sessions' && method === 'POST') return json({ grant: '11111111-2222-4333-8444-555555555555', sessionMode: 'review', sessionTtlSeconds: 1800, attemptId: 'attempt-quarry', modelId: 'model-quarry', modelVersionId: 'output-quarry-ready', embedUrl: '/session/11111111-2222-4333-8444-555555555555', assetKinds: ['glb', 'ortho', 'report'] }, 201);
  const productGrant = pathname.match(/^\/api\/v1\/processing\/outputs\/([^/]+)\/products\/([^/]+)\/download-grants$/);
  if (productGrant && method === 'POST') {
    const product = runtime.outputs.find(output => output.id === productGrant[1])?.downloadProducts?.find(item => item.kind === productGrant[2]);
    if (!product) return json({ error: 'product_not_found' }, 404);
    return json({ url: `/api/v1/processing/product-downloads/synthetic-${product.kind}`, fileName: product.fileName }, 201);
  }
  if (pathname === '/api/v1/processing/outputs/output-johnson/assets/glb') return { status: 200, body: Buffer.from('browser-glb'), type: 'model/gltf-binary' };
  if (pathname === '/api/v1/processing/outputs/output-johnson/assets/ortho') return { status: 200, body: orthophotoFixture, type: 'image/tiff' };
  if (pathname === '/api/v1/processing/outputs/output-johnson/assets/report') return { status: 200, body: Buffer.from('%PDF-browser'), type: 'application/pdf' };
  if (pathname === '/api/v1/processing/outputs/output-johnson' && method === 'DELETE') return json({ output: fixtures.outputs[0], trash: { id: 'trash-output-live' } });
  if (pathname === '/api/v1/processing/outputs/output-johnson-archived' && method === 'DELETE') return json({ output: fixtures.outputs[1], trash: { id: 'trash-output' } });
  if (pathname === '/api/v1/projects/project-quarry' && method === 'DELETE') { runtime.archivedProjects.add('project-quarry'); runtime.failNextStorage = true; return json({ trash: { id: 'trash-project', entityType: 'project' } }); }
  if (pathname === '/api/v1/tasks/task-quarry' && method === 'DELETE') { runtime.archivedTasks.add('task-quarry'); return json({ trash: { id: 'trash-task', entityType: 'task' } }); }
  if (pathname === '/api/v1/datasets/dataset-johnson' && method === 'DELETE') return json({ trash: { id: 'trash-dataset' } });
  if (pathname === '/api/v1/storage') {
    if (runtime.failNextStorage) { runtime.failNextStorage = false; return json({ error: 'storage_inventory_unavailable', message: 'Storage inventory is temporarily unavailable.' }, 503); }
    return url.searchParams.get('cursor')
      ? json({ storage: {}, trash: { items: [{ id: 'trash-second-page', entityId: 'output-trash', entityType: 'output', displayName: 'Old output', byteSize: 1024, purgeAfter: '2026-10-01T00:00:00.000Z' }], nextCursor: null } })
      : json({ storage: {
        datasets: { total: 10 * 1024 ** 2, available: 6 * 1024 ** 2, reserve: 1024 },
        models: { total: 20 * 1024 ** 2, available: 12 * 1024 ** 2, reserve: 1024 },
        cache: { total: 30 * 1024 ** 2, available: 18 * 1024 ** 2, reserve: 1024 },
        trash: { total: 40 * 1024 ** 2, available: 24 * 1024 ** 2, reserve: 1024 },
      }, usage: { status: 'complete', measuredAt: '2026-09-05T12:00:00.000Z', totalBytes: 40 * 1024 ** 2,
        categories: Object.fromEntries(['sources', 'products', 'cache', 'trash', 'other'].map((name, index) => [name, { bytes: [4, 8, 12, 16, 0][index] * 1024 ** 2, files: index + 1 }])),
        filesystems: [{ availableBytes: 60 * 1024 ** 2, totalBytes: 100 * 1024 ** 2, roots: ['datasets', 'models', 'cache', 'trash'] }],
      }, trash: { items: [{ id: 'trash-johnson', entityId: 'dataset-trash', entityType: 'dataset', displayName: 'Discarded draft', byteSize: 0, purgeAfter: '2026-10-02T00:00:00.000Z' }], nextCursor: 'trash-page-two' } });
  }
  if (pathname === '/api/v1/storage/mutations') return json({ mutations: [{ id: 'mutation-failed', type: 'restore', entityType: 'output', entityId: 'output-conflict', status: 'failed', errorCode: 'storage_conflict', errorMessage: 'destination conflicts with the recorded item' }], nextCursor: null });
  if (pathname === '/api/v1/storage/mutations/mutation-failed/retry' && method === 'POST') return json({ mutation: { id: 'mutation-failed', status: 'complete' } });
  if (pathname === '/api/v1/storage/trash/trash-johnson/restore' && method === 'POST') return json({ dataset: { id: 'dataset-trash', status: 'archived' } });
  if (pathname === '/api/v1/storage/trash/trash-johnson' && method === 'DELETE') return { status: 204, body: Buffer.alloc(0), type: 'application/json' };
  if (pathname === '/api/v1/processing/ready') return json({ ok: true });
  if (pathname === '/api/v1/workspace/client-grants') return json({ projects: [], associations: [], grants: [] });
  if (pathname === '/api/v1/operations' && method === 'GET') return json({ operations: runtime.operations, nextCursor: null });
  if (pathname === '/api/v1/processing/derivatives' && method === 'GET') return json({ derivatives: runtime.derivatives });
  if (pathname === '/api/v1/diagnostics/runs' && method === 'GET') return url.searchParams.get('cursor')
    ? json({ runs: [{ attemptId: 'attempt-global-older', attemptNumber: 1, taskId: 'task-quarry', taskDisplayName: 'Quarry reconstruction', projectId: 'project-quarry', projectDisplayName: 'Alpha Quarry', status: 'succeeded', phase: 'complete', derivativeCount: 1, failedDerivativeCount: 0, createdAt: '2026-08-16T12:00:00.000Z', updatedAt: '2026-08-16T12:05:00.000Z', completedAt: '2026-08-16T12:05:00.000Z' }], nextCursor: null })
    : json({ runs: [
      { attemptId: 'attempt-johnson', attemptNumber: 2, taskId: 'task-johnson', taskDisplayName: 'Johnson reconstruction', projectId: 'project-johnson', projectDisplayName: 'Johnson Road Survey', status: 'running', phase: 'processing', derivativeCount: 0, failedDerivativeCount: 0, createdAt: '2026-08-18T12:00:00.000Z', updatedAt: '2026-08-18T12:04:00.000Z' },
      { attemptId: 'attempt-johnson-old', attemptNumber: 1, taskId: 'task-johnson', taskDisplayName: 'Johnson reconstruction', projectId: 'project-johnson', projectDisplayName: 'Johnson Road Survey', status: 'failed', phase: 'obj2tiles_generate', error: { code: 'obj2tiles_exit_nonzero', message: 'Textured tile conversion failed.' }, derivativeCount: 1, failedDerivativeCount: 1, createdAt: '2026-08-17T12:00:00.000Z', updatedAt: '2026-08-17T12:04:00.000Z', completedAt: '2026-08-17T12:04:00.000Z' },
      { attemptId: 'attempt-global-flaky', attemptNumber: 2, taskId: 'task-quarry', taskDisplayName: 'Quarry reconstruction', projectId: 'project-quarry', projectDisplayName: 'Alpha Quarry', status: 'failed', phase: 'materializing_recovery', error: { code: 'recovery_failed', message: 'Recovery diagnostics are available.' }, derivativeCount: 0, failedDerivativeCount: 0, createdAt: '2026-08-18T12:00:00.000Z', updatedAt: '2026-08-18T12:03:00.000Z', completedAt: '2026-08-18T12:03:00.000Z' },
    ], nextCursor: 'diagnostic-page-two' });
  if (pathname === '/api/v1/processing/derivatives/derivative-failed/retry' && method === 'POST') {
    runtime.derivatives = runtime.derivatives.map(job => job.id === 'derivative-failed' ? { ...job, status: 'pending', result: {} } : job);
    return json({ derivative: runtime.derivatives.find(job => job.id === 'derivative-failed') }, 202);
  }
  if (pathname === '/api/v1/processing/derivatives/derivative-stale-fallback/retry' && method === 'POST') {
    return json({ derivative: { id: 'derivative-stale-fallback', status: 'pending', manualRetryCount: 1 } }, 202);
  }
  if (pathname === '/api/v1/processing/outputs/output-quarry-ready/derivatives/tiles' && method === 'POST') {
    const derivative = { id: 'derivative-quarry', attemptId: 'attempt-quarry', type: 'mesh_tiles', status: 'pending', optional: true, result: {}, taskId: 'task-quarry', taskDisplayName: 'Quarry reconstruction', projectId: 'project-quarry', projectDisplayName: 'Alpha Quarry', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    runtime.derivatives = [derivative, ...runtime.derivatives];
    return json({ derivative }, 202);
  }
  if (pathname === '/api/v1/processing/outputs/output-johnson/lod-recovery-attempts' && method === 'POST') {
    const queued = { id: 'operation-recovery-new', type: 'lod_recovery', subject: 'ops:browser-audit', projectId: 'project-johnson', status: 'queued', phase: 'queued', progress: 0, source: { kind: 'existing_model', browserTransferRequired: false, transferComplete: true }, attemptCount: 0, heartbeatAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    runtime.operations = [{ ...queued, status: 'leased', phase: 'validating_source', progress: .25, attemptCount: 1, heartbeatAt: new Date().toISOString(), processingAttemptId: 'attempt-recovery-new' }, ...runtime.operations];
    return json({ operation: queued }, 202);
  }
  if (pathname === '/api/v1/processing/outputs/output-johnson/companion-repair-attempts' && method === 'POST') {
    if (runtime.rejectCompanionRepair) return json({ error: 'companion_source_changed', message: 'Retained companion source verification failed.' }, 409);
    const operation = {
      id: 'operation-companion', type: 'lod_recovery', companionRepair: true, sourceOutputId: 'output-johnson',
      projectId: 'project-johnson', status: 'queued', phase: 'queued', progress: 0,
      source: { kind: 'existing_model', browserTransferRequired: false, transferComplete: true },
      attemptCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    runtime.operations = [operation, ...runtime.operations];
    return json({ operation }, 202);
  }
  if (pathname === '/api/v1/operations/operation-companion/retry' && method === 'POST') {
    runtime.operations = runtime.operations.map(operation => operation.id === 'operation-companion'
      ? { ...operation, status: 'queued', phase: 'queued', progress: 0, errorCode: null, errorMessage: null, updatedAt: new Date().toISOString() }
      : operation);
    return json({ operation: runtime.operations.find(operation => operation.id === 'operation-companion') }, 202);
  }
  if (pathname === '/api/v1/operations/operation-failed/retry' && method === 'POST') {
    runtime.operations = runtime.operations.map(operation => operation.id === 'operation-failed' ? { ...operation, status: 'queued', phase: 'queued', progress: 0, heartbeatAt: null, errorCode: null, errorMessage: null, updatedAt: new Date().toISOString() } : operation);
    return json({ operation: runtime.operations.find(operation => operation.id === 'operation-failed') }, 202);
  }
  if (pathname === '/api/v1/operations/operation-recovery-failed/retry' && method === 'POST') {
    runtime.operations = runtime.operations.map(operation => operation.id === 'operation-recovery-failed' ? { ...operation, status: 'queued', phase: 'queued', progress: 0, heartbeatAt: null, errorCode: null, errorMessage: null, updatedAt: new Date().toISOString() } : operation);
    return json({ operation: runtime.operations.find(operation => operation.id === 'operation-recovery-failed') }, 202);
  }
  if (pathname === '/api/v1/processing/server-task-imports/browse' && method === 'GET') return json({ path: '', entries: [{ name: 'church-backup.zip', relativePath: 'church-backup.zip', kind: 'zip', byteSize: 4096 }], nextCursor: null });
  if (pathname === '/api/v1/processing/webodm-task-imports' && method === 'POST') {
    const operation = { id: 'operation-new', type: 'webodm_task_import', subject: body.taskDisplayName, projectId: body.projectId, status: 'queued', phase: 'queued', progress: 0, source: { kind: 'server_zip', browserTransferRequired: false, transferComplete: true }, attemptCount: 0, heartbeatAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    runtime.operations = [operation, ...runtime.operations];
    return json({ operation }, 202);
  }
  if (pathname === '/api/v1/tasks/task-johnson') {
    return json({ task: { ...fixtures.tasks[0], metrics: {
      averageGsdM: 0.021, surveyedAreaM2: 18000, sourceImageCount: 48, reconstructedPointCount: 1250000,
      georeferencingCrs: 'EPSG:32616', processingDurationMs: 240000, processingStatus: 'running', outputCount: 1,
      taskDiskUsageBytes: 9437184,
    }, outputs: runtime.outputs } });
  }
  if (pathname === '/api/v1/tasks/task-quarry') return json({ task: { ...fixtures.tasks[1], status: runtime.archivedTasks.has('task-quarry')?'archived':'ready_for_review', metrics: { sourceImageCount: 12, processingStatus: 'ready_for_review', outputCount: 1 }, outputs: [fixtures.outputs[2]] } });
  if (pathname === '/api/v1/tasks/task-johnson/storage') return json({ task: { totalBytes: 9437184 } });
  if (pathname === '/api/v1/tasks/task-quarry/storage') return json({ task: { totalBytes: 1048576 } });
  if (pathname === '/api/v1/tasks/task-johnson/attempts') return url.searchParams.get('cursor')
    ? json({ attempts: [{ id: 'attempt-johnson-old', attemptNumber: 1, providerId: 'provider-nodeodm', providerTaskId: 'nodeodm-41', status: 'failed', errorCode: 'obj2tiles_exit_nonzero', errorMessage: 'Textured tile conversion failed.', createdAt: '2026-08-17T12:00:00.000Z', startedAt: '2026-08-17T12:01:00.000Z', completedAt: '2026-08-17T12:04:00.000Z' }], nextCursor: null })
    : json({ attempts: [fixtures.tasks[0].latestAttempt], nextCursor: 'older-johnson-runs' });
  if (pathname === '/api/v1/tasks/task-quarry/attempts') return json({ attempts: [fixtures.tasks[1].latestAttempt], nextCursor: null });
  const gcpSet = { id: 'gcp-set-johnson', displayName: 'Rome Dam control', pointCount: 1, crs: 'EPSG:32616', provenance: { coordinateSystem: 'NAD83 / UTM zone 16N', verticalDatum: 'NAVD88', linearUnit: 'ftUS' } };
  const gcpPoint = { id: 'gcp-point-1', externalId: 'ltds-1', label: 'ltds-1', latitude: 44.1, longitude: -88.2, elevationM: 220 };
  if (pathname === '/api/v1/datasets/dataset-johnson/gcp-sets') return json({ sets: [gcpSet] });
  if (pathname === '/api/v1/gcp-sets/gcp-set-johnson') return json({ set: gcpSet, points: [gcpPoint] });
  if (pathname === '/api/v1/tasks/task-johnson/gcp-correspondences' && method === 'GET') return json({ correspondences: runtime.correspondences });
  if (pathname === '/api/v1/tasks/task-johnson/gcp-correspondences' && method === 'POST') {
    const correspondence = { id: 'gcp-mark-1', ...body };
    runtime.correspondences = [correspondence];
    return json({ correspondence }, 201);
  }
  if (pathname === '/api/v1/gcp-correspondences/gcp-mark-1' && method === 'PATCH') {
    runtime.correspondences = runtime.correspondences.map(item => ({ ...item, ...body }));
    return json({ correspondence: runtime.correspondences[0] });
  }
  if (pathname === '/api/v1/gcp-correspondences/gcp-mark-1' && method === 'DELETE') {
    runtime.correspondences = [];
    return { status: 204, body: Buffer.alloc(0), type: 'application/json' };
  }
  if (pathname === '/api/v1/datasets/dataset-johnson/gcp-images') return json({ images: [{ id: 'image-1', relativePath: 'DJI_0001.JPG', distanceM: 4.2, width: 100, height: 80 }], ranking: { mode: 'auto', notice: 'Adaptive camera spacing', warnings: [] } });
  if (pathname === '/api/v1/datasets/dataset-johnson/gcp-images/image-1/content') return { status: 200, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#555"/></svg>'), type: 'image/svg+xml' };
  if (pathname === '/api/v1/attempts/attempt-johnson') {
    const sequence = ++runtime.logSequence;
    return json({
      attempt: fixtures.tasks[0].latestAttempt,
      logs: [{ createdAt: new Date().toISOString(), level: 'info', message: `Running stage odm_dem · browser refresh ${sequence}` }],
    });
  }
  if (pathname === '/api/v1/attempts/attempt-johnson-old/diagnostics') return json({ diagnostics: {
    attempt: { id: 'attempt-johnson-old', attemptNumber: 1, status: 'failed' },
    errorDetail: { errorCode: 'obj2tiles_exit_nonzero', errorMessage: 'Textured tile conversion failed.', stage: 'obj2tiles_generate', diagnosticId: 'diag-browser-41' },
    events: [
      { stage: 'source_validate', state: 'succeeded', summary: 'Textured OBJ source verified.', createdAt: '2026-08-17T12:02:00.000Z' },
      { stage: 'obj2tiles_generate', state: 'failed', summary: 'Obj2Tiles exited with code 1.', createdAt: '2026-08-17T12:04:00.000Z' },
    ],
    derivativeJobs: [{ id: 'derivative-old', type: 'mesh_tiles', status: 'failed', errorMessage: 'Tile conversion failed.' }],
    processingJobs: [], operations: [], logs: [{ createdAt: '2026-08-17T12:04:00.000Z', level: 'error', message: 'Obj2Tiles exited with code 1 [REDACTED PATH]' }],
    logsTruncated: false, logRetentionDays: 30,
  } });
  if (pathname === '/api/v1/attempts/attempt-global-flaky/diagnostics') {
    runtime.flakyDiagnosticRequests += 1;
    if (runtime.flakyDiagnosticRequests === 1) return json({ error: 'diagnostics_temporarily_unavailable', message: 'Run diagnostics are temporarily unavailable.' }, 503);
    return json({ diagnostics: {
      attempt: { id: 'attempt-global-flaky', attemptNumber: 2, status: 'failed' },
      events: [{ eventType: 'materializing_recovery', status: 'failed', message: 'Recovery materialization failed.', createdAt: '2026-08-18T12:03:00.000Z' }],
      derivatives: [], operation: null,
      logs: [{ createdAt: '2026-08-18T12:03:00.000Z', level: 'error', message: 'Retained sanitized recovery output [REDACTED PATH]' }],
      logsTruncated: false, logRetentionDays: 30,
    } });
  }
  if (pathname === '/api/v1/attempts/attempt-global-older/diagnostics') return json({ diagnostics: {
    attempt: { id: 'attempt-global-older', attemptNumber: 1, status: 'ready_for_review' },
    events: [{ eventType: 'processing.ready_for_review', status: 'succeeded', message: 'Verified derivative registered.', createdAt: '2026-08-16T12:05:00.000Z' }],
    derivativeJobs: [{
      id: 'derivative-rome-v4', type: 'mesh_tiles', status: 'complete', summary: 'Verified derivative registered and ready for the Viewer.',
      auditEvidence: { policyRevision: 'ltds-controlled-surface-policy-v4', acceptance: 'gray-zone', metric: 'areaRelativeDelta', observed: 0.000010618457348535776, limit: 0.00001, grayZoneLimit: 0.000012, numericalAgreement: 0, equivalenceSha256: 'e'.repeat(64) },
    }],
    processingJobs: [], operations: [], logs: [], logsTruncated: false, logRetentionDays: 30,
  } });
  return json({ error: `Unhandled fixture route: ${pathname}` }, 404);
}

function startFixtureServer() {
  const runtime = { logSequence: 0, flakyDiagnosticRequests: 0, correspondences: [], shares: [], requests: [], permissions: null, outputs: structuredClone(fixtures.outputs), archivedProjects: new Set(), archivedTasks: new Set(), failNextStorage: false, operations: structuredClone(fixtures.operations), derivatives: structuredClone(fixtures.derivatives) };
  const builtRoot = path.join(root, 'dist');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    let result;
    if (manualFixture && url.pathname === '/manual-responsive') {
      // A real nested viewport exercises production media queries without
      // changing the user's browser window. This is layout QA, not touch-device
      // emulation. The route and grant exist only in the local synthetic fixture.
      const width = [320, 390, 1200].includes(Number(url.searchParams.get('width'))) ? Number(url.searchParams.get('width')) : 390;
      result = { status: 200, type: 'text/html; charset=utf-8', body: Buffer.from(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic responsive Viewer QA</title><style>body{margin:8px;background:#333;color:white;font:14px sans-serif}nav{margin-bottom:8px}a{color:white;margin-right:16px}iframe{display:block;border:1px solid #888;width:${width}px;height:844px;max-width:none}</style><nav>Synthetic layout viewport: <a href="?width=320">320px</a><a href="?width=390">390px</a><a href="?width=1200">1200px</a></nav><iframe title="Synthetic Viewer workspace" src="/workspace/${manualFixtureGrant}"></iframe>`) };
    } else if (url.pathname.startsWith('/api/')) {
      if (manualFixture && url.pathname === '/api/v1/admin-sessions/redeem' && request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        const session = apiResponse(new URL('/api/v1/admin-sessions/current', url), runtime, 'GET', {});
        result = body.grant === manualFixtureGrant ? json({ ...JSON.parse(session.body.toString()), accessToken: token }) : json({ error: 'invalid_fixture_grant' }, 401);
      } else if (request.headers.authorization !== `Bearer ${token}`) result = json({ error: 'authorization_required' }, 401);
      else {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        let body = {};
        if (raw) try { body = JSON.parse(raw); } catch {}
        runtime.requests.push({ method: request.method, path: url.pathname, body, idempotencyKey: request.headers['idempotency-key']||null });
        if (url.pathname === '/api/v1/processing/outputs/output-johnson/assets/ortho' && runtime.orthophotoResponseGate) {
          await runtime.orthophotoResponseGate;
        }
        if (url.pathname === '/api/v1/tasks/task-johnson' && runtime.taskDetailResponseGate) {
          await runtime.taskDetailResponseGate;
        }
        if (manualFixture && request.method !== 'GET') console.log(`Synthetic mutation: ${request.method} ${url.pathname}`);
        result = url.pathname === '/api/v1/processing/outputs/output-johnson/assets/ortho' && runtime.failOrthophotoResponse
          ? json({ error: 'synthetic_preview_unavailable' }, 503)
          : apiResponse(url, runtime, request.method, body);
      }
    } else {
      const relative = url.pathname === '/workspace' || url.pathname === '/' || (manualFixture && url.pathname === `/workspace/${manualFixtureGrant}`) ? 'workspace.html' : decodeURIComponent(url.pathname.slice(1));
      const absolute = path.resolve(builtRoot, relative);
      if (!absolute.startsWith(builtRoot + path.sep) || !existsSync(absolute)) result = json({ error: 'not_found' }, 404);
      else {
        const extension = path.extname(absolute);
        const type = extension === '.html' ? 'text/html; charset=utf-8'
          : extension === '.css' ? 'text/css; charset=utf-8'
            : ['.js', '.mjs'].includes(extension) ? 'text/javascript; charset=utf-8'
              : 'application/octet-stream';
        result = { status: 200, body: readFileSync(absolute), type };
      }
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (result.status === 200 && range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]), result.body.length - 1);
      if (start <= end) result = { ...result, status: 206, body: result.body.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${result.body.length}` } };
    }
    response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': 'no-store', ...(result.headers || {}) });
    response.end(result.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, runtime, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
      } else {
        this.events.push(message);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(client, expression, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(expression);
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const diagnostics = await client.evaluate(`({
    readyState: document.readyState,
    title: document.title,
    content: document.querySelector('#workspace-content')?.textContent?.trim().slice(0, 240),
    tokenPresent: Boolean(sessionStorage.getItem('ltds-viewer-admin-token')),
    viewerActions: window.__viewerActions?.slice(-12),
  })`).catch(error => ({ evaluationError: error.message }));
  const exceptions = client.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => ({
      description: event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text,
      url: event.params?.exceptionDetails?.url,
      line: event.params?.exceptionDetails?.lineNumber,
      column: event.params?.exceptionDetails?.columnNumber,
    }))
    .slice(-3);
  throw new Error(`${message}; last result: ${JSON.stringify(last)}; diagnostics: ${JSON.stringify(diagnostics)}; exceptions: ${JSON.stringify(exceptions)}`);
}

async function waitForRequest(runtime, start, method, pathname, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (runtime.requests.slice(start).some(item => item.method === method && item.path === pathname)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`missing browser mutation ${method} ${pathname}`);
}

async function waitForDevTools(profile) {
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      const port = readFileSync(activePortFile, 'utf8').split(/\r?\n/, 1)[0];
      if (port) return `http://127.0.0.1:${port}`;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Browser did not expose a DevTools endpoint');
}

// Drive the shipped in-app dialog in the isolated CI browser; never bypass its
// cancel/typed-identifier validation with native confirm/prompt replacements.
async function confirmAppAction(client, runtime, selector, { title, fields = {}, cancelFirst = false, invalidFields } = {}) {
  const mutations = () => runtime.requests.filter(item => item.method !== 'GET').length;
  const before = mutations();
  const open = async () => {
    await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(client, 'Boolean(document.querySelector("dialog.workspace-decision[open]"))', `Confirmation did not open: ${selector}`);
    if (title) assert.equal(await client.evaluate('document.querySelector(".workspace-decision h2").textContent'), title);
    assert.equal(mutations(), before, 'Opening a confirmation must not mutate state');
  };
  const submit = async values => client.evaluate(`(() => {
    const form=document.querySelector('.workspace-decision[open] form');
    for(const [name,value] of Object.entries(${JSON.stringify(values)})) {
      form.elements.namedItem(name).value=value;
      form.elements.namedItem(name).dispatchEvent(new Event('input',{bubbles:true}));
    }
    form.querySelector('button[type="submit"]').click();
  })()`);
  await open();
  if (cancelFirst) {
    await client.evaluate(`document.querySelector('.workspace-decision [aria-label="Cancel and close dialog"]').click()`);
    await waitFor(client, '!document.querySelector(".workspace-decision")', 'Cancel did not close the confirmation');
    assert.equal(mutations(), before, 'Cancelling must not mutate state');
    await open();
  }
  if (invalidFields) {
    await submit(invalidFields);
    await waitFor(client, `Boolean(document.querySelector('.workspace-decision [aria-invalid="true"]'))`, 'Invalid identifier was not rejected');
    assert.equal(mutations(), before, 'Invalid confirmation must not issue a mutation');
  }
  await submit(fields);
  await waitFor(client, '!document.querySelector(".workspace-decision")', 'Confirmation did not close after valid submit');
}

async function verifyViewport(devTools, origin, viewport, runtime) {
  runtime.archivedProjects.clear();
  runtime.archivedTasks.clear();
  runtime.failNextStorage = false;
  runtime.flakyDiagnosticRequests = 0;
  runtime.operations = structuredClone(fixtures.operations);
  runtime.derivatives = structuredClone(fixtures.derivatives);
  const requestStart = runtime.requests.length;
  const targetResponse = await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' });
  assert.equal(targetResponse.ok, true, `create browser target for ${viewport.name}`);
  const target = await targetResponse.json();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
      screenWidth: viewport.width, screenHeight: viewport.height,
    });
    await client.command('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        sessionStorage.setItem('ltds-viewer-admin-token', ${JSON.stringify(token)});
        window.__viewerActions=[];
        window.__broadcastChannels=new Map();
        window.BroadcastChannel=class FakeBroadcastChannel{
          constructor(name){this.name=name;this.onmessage=null;this.closed=false;const channels=window.__broadcastChannels.get(name)||[];channels.push(this);window.__broadcastChannels.set(name,channels)}
          postMessage(message){window.__viewerActions.push({type:'post',name:this.name,message});for(const channel of window.__broadcastChannels.get(this.name)||[])if(channel!==this&&!channel.closed)queueMicrotask(()=>channel.onmessage?.({data:structuredClone(message)}))}
          close(){this.closed=true;const channels=window.__broadcastChannels.get(this.name)||[];window.__broadcastChannels.set(this.name,channels.filter(channel=>channel!==this))}
        };
        window.open=(url,name,features)=>{window.__viewerActions.push({type:'launcher',url,name,features});if(window.__blockNextLauncher){window.__blockNextLauncher=false;return null}const channelId=decodeURIComponent(new URL(url,location.origin).hash.slice(1).split('=')[1]),launcher=new BroadcastChannel('ltds-viewer-review:'+channelId);launcher.onmessage=event=>{if(event.data?.type==='ltds-viewer:navigate'){window.__viewerActions.push({type:'open',url:event.data.url});launcher.close()}};setTimeout(()=>launcher.postMessage({version:1,type:'ltds-viewer:launcher-ready',channelId}),25);return null};
        const originalAnchorClick=HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click=function(){window.__viewerActions.push({type:'download',name:this.download,url:this.href});};
      `,
    });
    await client.command('Page.navigate', { url: `${origin}/workspace` });
    await waitFor(client, "document.querySelectorAll('[data-project-name]').length === 2", `${viewport.name}: workspace did not load`);

    await waitFor(client, "document.querySelector('#background-work-count')?.textContent === '4'", `${viewport.name}: background work count did not include active processing, imports, and derivatives`);
    await client.evaluate(`document.querySelector('[data-section="background"]').click()`);
    await waitFor(client, "document.querySelectorAll('#import-activity .operation-row').length === 3", `${viewport.name}: dedicated import and recovery activity did not load`);
    const activityText = await client.evaluate(`document.querySelector('#import-activity').textContent`);
    for (const expected of ['Import activity', '35%', 'Server ZIP', 'Phase: adopting', 'Worker heartbeat', 'The archive could not be imported.', 'Existing model', 'Retry recovery', 'existing model remains safe']) assert.ok(activityText.includes(expected), `${viewport.name}: missing operation detail ${expected}`);
    const derivativeText = await client.evaluate(`document.querySelector('#workspace-content').textContent`);
    for (const expected of ['Model derivatives', 'Validate imported 3D tiles', 'Generate streaming 3D tiles', 'Running', 'Queued', 'Tile conversion failed']) assert.ok(derivativeText.includes(expected), `${viewport.name}: missing derivative detail ${expected}`);
    assert.equal(await client.evaluate(`document.querySelector('[data-derivative-id="derivative-running"] progress')?.hasAttribute('value')`), false, `${viewport.name}: running derivative progress was not indeterminate`);
    assert.equal(activityText.includes('server import'), false, `${viewport.name}: internal operation subject leaked into the activity title`);
    await client.evaluate(`document.querySelector('[data-action="retry-operation"][data-id="operation-failed"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/operations/operation-failed/retry');
    await waitFor(client, "document.querySelector('[data-operation-id=\"operation-failed\"]')?.textContent.includes('queued')", `${viewport.name}: failed import retry did not return to queued`);
    await waitFor(client, "document.querySelector('[data-action=\"retry-derivative\"][data-id=\"derivative-failed\"]')", `${viewport.name}: failed optional derivative did not expose manual retry`);
    await client.evaluate(`document.querySelector('[data-action="retry-derivative"][data-id="derivative-failed"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/derivatives/derivative-failed/retry');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: failed derivative retry did not settle`);
    await client.evaluate(`document.querySelector('[data-section="dashboard"]').click()`);

    const noOverflow = `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth`;
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: dashboard overflows horizontally`);

    await client.evaluate(`(() => { const input=document.querySelector('#project-filter'); input.value='Johnson'; input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('[data-project-name]')].map(row=>({name:row.dataset.projectName,hidden:row.hidden}))`), [
      { name: 'johnson road survey', hidden: false },
      { name: 'alpha quarry', hidden: true },
    ], `${viewport.name}: project search result visibility`);

    await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-johnson"]').click()`);
    await waitFor(client, "document.querySelector('.project-detail')?.getAttribute('aria-label') === 'Johnson Road Survey tasks and actions'", `${viewport.name}: project selection failed`);
    assert.equal(await client.evaluate(`(() => { const card=document.querySelector('.project-row.selected'),toggle=card?.querySelector('[data-action="open-project"]'),detail=card?.querySelector(':scope > .project-detail'); return Boolean(detail && toggle?.getAttribute('aria-expanded')==='true' && toggle.getAttribute('aria-controls')===detail.id && !detail.querySelector('.project-title')); })()`), true, `${viewport.name}: selected project tasks must expand inside their own card`);
    assert.equal(await client.evaluate(`new URL(location.href).searchParams.get('project')`), 'project-johnson', `${viewport.name}: selected project was not encoded in the URL`);
    assert.equal(await client.evaluate(`document.body.textContent.includes('Project datasets')`), false, `${viewport.name}: redundant project datasets card remained visible`);
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: selected project overflows horizontally`);

    await client.evaluate(`document.querySelector('[data-action="project-import"][data-id="project-johnson"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true", `${viewport.name}: import dialog did not open`);
    await client.evaluate(`document.querySelector('[data-import-tab="server"]').click()`);
    await waitFor(client, "document.querySelector('[data-select-path=\"church-backup.zip\"]') !== null", `${viewport.name}: server import browser did not load`);
    await client.evaluate(`document.querySelector('[data-select-path="church-backup.zip"]').click()`);
    await client.evaluate(`document.querySelector('#server-import-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/webodm-task-imports');
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === false && Number(document.querySelector('#background-work-count')?.textContent) >= 1", `${viewport.name}: modal import did not update the background work count`);

    await client.evaluate(`document.querySelector('[data-action="toggle-task"][data-id="task-johnson"]').click()`);
    await waitFor(client, "document.querySelector('.compact-task-detail .task-facts') !== null", `${viewport.name}: task details did not expand`);
    assert.match(await client.evaluate(`document.querySelector('.task-authority-note').textContent`), /separate from node connection health/, `${viewport.name}: missing survey statistics must not be presented as a node connection failure`);
    assert.deepEqual(await client.evaluate(`({section:new URL(location.href).searchParams.get('section'),project:new URL(location.href).searchParams.get('project'),task:new URL(location.href).searchParams.get('task')})`),
      { section: 'dashboard', project: 'project-johnson', task: 'task-johnson' }, `${viewport.name}: expanded task route state`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions > button')].map(button=>button.textContent)`),
      ['View', 'Model report', 'Share'], `${viewport.name}: published task shortcuts must remain focused on viewing and sharing`);
    await client.evaluate(`document.querySelector('.task-more-actions > summary').click()`);
    assert.equal(await client.evaluate(`(() => { const menu=document.querySelector('.task-more-actions[open] .project-more-menu'),r=menu.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&getComputedStyle(menu.closest('.task-panel')).overflow==='visible' })()`),true,`${viewport.name}: task menu must open without horizontal clipping`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-more-actions[open] button')].map(button=>button.textContent)`),['Rename','Download model files','Details & processing','Files & versions','Processing history','Ground control points']);
    await client.evaluate(`document.querySelector('[data-action="task-history"]').click()`);
    await waitFor(client, "new URL(location.href).searchParams.get('section')==='diagnostics' && document.querySelector('[data-action=\"load-more-diagnostic-runs\"]') !== null", `${viewport.name}: task history did not route to paginated Diagnostics`);
    assert.equal(await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-johnson"]')?.textContent.includes('Run #2')`), true, `${viewport.name}: current run number was not rendered`);
    await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-johnson-old"] [data-action="open-global-attempt-diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('#global-attempt-diagnostic-attempt-johnson-old')?.textContent.includes('Obj2Tiles exited with code 1')", `${viewport.name}: historical run diagnostics did not load`);
    const runDiagnosticText = await client.evaluate(`document.querySelector('#global-attempt-diagnostic-attempt-johnson-old').textContent`);
    for (const expected of ['obj2tiles_exit_nonzero', 'obj2tiles generate', 'diag-browser-41', '[REDACTED PATH]']) assert.equal(runDiagnosticText.toLowerCase().includes(expected.toLowerCase()), true, `${viewport.name}: missing run diagnostic ${expected}`);
    await waitForRequest(runtime, requestStart, 'GET', '/api/v1/attempts/attempt-johnson-old/diagnostics');
    await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-johnson-old"] [data-action="open-global-attempt-diagnostics"]').click(); history.back()`);
    await waitFor(client, "document.querySelector('[data-action=\"task-settings\"]') !== null", `${viewport.name}: returning from Diagnostics did not restore task tools`);
    await client.evaluate(`document.querySelector('[data-action="task-settings"]').click()`);
    await waitFor(client, "new URL(location.href).searchParams.get('panel')==='settings' && document.querySelector('[data-action=\"retry-operation\"][data-id=\"operation-recovery-failed\"]') !== null", `${viewport.name}: Settings did not expose retry of the existing recovery`);
    await client.evaluate(`document.querySelector('[data-action="retry-operation"][data-id="operation-recovery-failed"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/operations/operation-recovery-failed/retry');
    assert.equal(runtime.requests.some(item => item.method === 'POST' && item.path === '/api/v1/processing/outputs/output-johnson/lod-recovery-attempts'), false,
      `${viewport.name}: failed recovery quick action created a second immutable version instead of retrying in place`);
    await waitFor(client, "document.querySelector('#workspace-toast')?.textContent.includes('existing model remains safe')", `${viewport.name}: recovery retry confirmation did not preserve the old-version safety message`);
    await client.evaluate(`history.back()`);
    await waitFor(client, "document.querySelector('.compact-task-detail') !== null", `${viewport.name}: Settings back did not restore the compact task`);
    await client.evaluate(`document.querySelector('[data-section="background"]').click()`);
    await waitFor(client, "document.querySelector('[data-operation-id=\"operation-recovery-failed\"]')?.textContent.includes('queued')", `${viewport.name}: failed recovery retry did not return to queued`);
    const recoveryActivity = await client.evaluate(`document.querySelector('[data-operation-id="operation-recovery-failed"]').textContent`);
    for (const expected of ['3D tile recovery version', 'Existing model', 'queued']) assert.ok(recoveryActivity.includes(expected), `${viewport.name}: missing recovery activity ${expected}`);
    await client.evaluate(`history.back()`);
    await waitFor(client, "new URL(location.href).searchParams.get('task')==='task-johnson' && document.querySelector('.task-lod-notice')?.textContent.includes('Preparing streaming tiles')", `${viewport.name}: returning from recovery activity did not restore the unobtrusive streaming status`);
    assert.equal(await client.evaluate(`document.querySelectorAll('button button').length`), 0, `${viewport.name}: task shortcuts were nested inside a button`);
    assert.equal(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions > button,.task-more-actions > summary')].every(button=>button.getBoundingClientRect().height>=44)`), true, `${viewport.name}: task shortcuts have sub-44px targets`);
    await client.evaluate(`history.back()`);
    await waitFor(client, "new URL(location.href).searchParams.get('project')==='project-johnson' && !new URL(location.href).searchParams.has('task') && document.querySelector('[data-action=\"toggle-task\"][data-id=\"task-johnson\"]')?.getAttribute('aria-expanded')==='false'", `${viewport.name}: browser Back did not collapse the task in place`);
    await client.evaluate(`history.forward()`);
    await waitFor(client, "new URL(location.href).searchParams.get('task')==='task-johnson' && document.querySelector('[data-action=\"toggle-task\"][data-id=\"task-johnson\"]')?.getAttribute('aria-expanded')==='true'", `${viewport.name}: browser Forward did not restore the task`);
    await client.command('Page.reload');
    await waitFor(client, "new URL(location.href).searchParams.get('task')==='task-johnson' && document.querySelector('.compact-task-detail .task-facts') !== null", `${viewport.name}: refresh did not restore the selected project and expanded task`);
    await waitFor(client, "document.querySelector('.task-detail .task-live-output .log-tail')?.textContent.includes('browser refresh')", `${viewport.name}: expanded task must show current task output`);
    assert.equal(await client.evaluate(`document.querySelector('.task-live-output .task-output-status strong')?.textContent`), 'Elevation models', `${viewport.name}: reported processing stage must be human-readable`);
    assert.equal(await client.evaluate(`document.querySelector('.task-live-output progress') === null`), true, `${viewport.name}: absent node progress must not be fabricated`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-live-output .row-actions button')].map(button=>button.textContent)`), ['Download tail', 'Fullscreen'], `${viewport.name}: task output must expose its own viewing/export controls`);
    assert.equal(await client.evaluate(`document.querySelector('.task-live-output .log-tail')?.getAttribute('tabindex')`), '0', `${viewport.name}: task output must be keyboard-scrollable`);
    await client.evaluate(`document.querySelector('.task-live-output [data-action="fullscreen-logs"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true && document.querySelector('.fullscreen-log')?.textContent.includes('Running stage odm_dem')", `${viewport.name}: task output fullscreen did not preserve recorded lines`);
    await client.evaluate(`document.querySelector('.modal-close').click()`);
    // Expanded task output refreshes in place; full historical diagnostics
    // remain available through the separately exercised Diagnostics route.
    const firstLog = runtime.logSequence;
    const refreshStart = runtime.requests.length;
    await waitForRequest(runtime, refreshStart, 'GET', '/api/v1/attempts/attempt-johnson');
    assert.ok(runtime.logSequence > firstLog, `${viewport.name}: running-task log data did not refresh`);
    await waitFor(client, `document.querySelector('.task-live-output .log-tail')?.textContent.includes('browser refresh ${runtime.logSequence}')`, `${viewport.name}: refreshed task output did not reach the visible panel`);
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: expanded task overflows horizontally`);
    await waitFor(client, "document.querySelector('.task-ortho-preview canvas')?.getAttribute('aria-label') === 'Published orthophoto preview' || document.querySelector('.task-ortho-preview img') !== null", `${viewport.name}: real orthophoto preview did not render`);
    assert.equal(await client.evaluate(`(() => { const canvas=document.querySelector('.task-ortho-preview canvas'); if(!canvas)return true; return [...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data].some(value=>value>0) })()`), true, `${viewport.name}: orthophoto preview canvas is empty`);

    await client.evaluate(`document.querySelector('[data-action="task-gcp"]').click()`);
    await waitFor(client, "new URL(location.href).searchParams.get('panel')==='gcp' && document.querySelector('.task-workspace-page') !== null", `${viewport.name}: dedicated GCP page did not open`);
    await waitFor(client, "document.querySelector('[data-action=\"gcp-open-image\"][data-id=\"image-1\"]') !== null", `${viewport.name}: GCP image candidates did not load`);
    await client.evaluate(`document.querySelector('[data-action="gcp-open-image"][data-id="image-1"]').click()`);
    await waitFor(client, "document.querySelector('.gcp-mark-form') !== null", `${viewport.name}: private GCP image did not open`);
    await client.evaluate(`(() => { const form=document.querySelector('.gcp-mark-form'); form.elements.pixelX.value='12'; form.elements.pixelY.value='14'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('.gcp-mark-row')?.textContent.includes('x 12, y 14')", `${viewport.name}: GCP correspondence was not created`);
    await client.evaluate(`(() => { const form=document.querySelector('.gcp-mark-form'); form.elements.pixelX.value='13'; form.elements.pixelY.value='15'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('.gcp-mark-row')?.textContent.includes('x 13, y 15')", `${viewport.name}: GCP correspondence was not updated`);
    await confirmAppAction(client, runtime, '[data-action="gcp-delete-mark"]', { title: 'Delete image mark', cancelFirst: true });
    await waitFor(client, "document.querySelector('.gcp-mark-row') === null", `${viewport.name}: GCP correspondence was not deleted`);

    await client.evaluate(`document.querySelector('[data-action="task-return"]').click()`);
    await waitFor(client, "!new URL(location.href).searchParams.has('panel') && document.querySelector('.task-quick-actions') !== null", `${viewport.name}: GCP Back to task did not restore shortcuts`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="download-output"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true && document.querySelectorAll('.product-download-item').length === 3", `${viewport.name}: registered product chooser did not open`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.product-download-item strong')].map(item=>item.textContent)`), ['Textured model (glTF)', 'Orthophoto', 'Quality report']);
    await client.evaluate(`document.querySelector('[data-product-index="1"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/outputs/output-johnson/products/ortho/download-grants');
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='download'&&item.name==='johnson-orthophoto.tif'&&new URL(item.url).pathname==='/api/v1/processing/product-downloads/synthetic-ortho')", `${viewport.name}: selected orthophoto did not use its secure download ticket`);
    await client.evaluate(`document.querySelector('.modal-close').click()`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="download-report"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/outputs/output-johnson/products/report/download-grants');
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='download'&&item.name.includes('report.pdf'))", `${viewport.name}: authenticated report download did not complete`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="view-output"]').click()`);
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='open'&&item.url.includes('/session/99999999-8888-4777-8666-555555555555#reviewController='))", `${viewport.name}: renewable published output session did not open`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="share-output"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true && document.querySelector('.share-form')?.dataset.outputId === 'output-johnson'", `${viewport.name}: task Share shortcut did not target the published output`);
    await client.evaluate(`document.querySelector('.modal-close').click()`);

    await client.evaluate(`document.querySelector('[data-action="task-files"]').click()`);
    await waitFor(client, "new URL(location.href).searchParams.get('panel')==='files' && document.querySelector('.task-workspace-page')?.textContent.includes('Model files')", `${viewport.name}: dedicated Files page did not open`);

    await confirmAppAction(client, runtime, '[data-action="trash-output"][data-id="output-johnson"]', { title: 'Move to Recycle Bin', cancelFirst: true });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/processing/outputs/output-johnson');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: output delete did not settle`);
    await confirmAppAction(client, runtime, '[data-action="trash-output"][data-id="output-johnson-archived"]', { title: 'Move to Recycle Bin' });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/processing/outputs/output-johnson-archived');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: output trash did not settle`);
    await client.evaluate(`document.querySelector('[data-action="task-return"]').click(); document.querySelector('[data-action="task-settings"]').click()`);
    await waitFor(client, "new URL(location.href).searchParams.get('panel')==='settings' && document.querySelector('[data-action=\"trash-dataset\"]') !== null", `${viewport.name}: dedicated Task settings did not open`);
    await confirmAppAction(client, runtime, '[data-action="trash-dataset"][data-id="dataset-johnson"]', { title: 'Move to Recycle Bin' });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/datasets/dataset-johnson');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: dataset trash did not settle`);

    await client.evaluate(`document.querySelector('[data-action="task-return"]').click()`);
    await client.evaluate(`(() => { const input=document.querySelector('#project-filter'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
    await waitFor(client, "document.querySelector('[data-action=\"open-project\"][data-id=\"project-quarry\"]') !== null", `${viewport.name}: project filter did not clear`);
    await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-quarry"]').click()`);
    await waitFor(client, "document.querySelector('.project-detail')?.getAttribute('aria-label') === 'Alpha Quarry tasks and actions'", `${viewport.name}: terminal project selection failed`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions > button')].map(button=>button.textContent)`),
      ['View', 'Model report', 'Share'], `${viewport.name}: ready output did not expose focused View, report, and Share shortcuts`);
    await client.evaluate(`document.querySelector('[data-action="toggle-task"][data-id="task-quarry"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"task-settings\"]') !== null", `${viewport.name}: ready task tools did not load`);
    await client.evaluate(`document.querySelector('[data-action="task-settings"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"generate-tiles\"]') !== null", `${viewport.name}: Task settings did not expose tile generation`);
    await client.evaluate(`document.querySelector('[data-action="generate-tiles"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/outputs/output-quarry-ready/derivatives/tiles');
    await waitFor(client, "document.querySelector('.task-workspace-page')?.textContent.includes('3D tiles queued')", `${viewport.name}: queued tile derivative did not replace the generate action`);
    await client.evaluate(`document.querySelector('[data-action="task-return"]').click()`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="open-review"]').click()`);
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='open'&&item.url.includes('/session/11111111-2222-4333-8444-555555555555#reviewController='))", `${viewport.name}: ready output View did not open its isolated review session`);
    await client.evaluate(`(() => {
      const launch=window.__viewerActions.filter(item=>item.type==='launcher').at(-1),channelId=new URL(launch.url,location.origin).hash.slice(1).split('=')[1],channel=new BroadcastChannel('ltds-viewer-review:'+decodeURIComponent(channelId)),expiresAt=new Date(Date.now()+4*60*1000).toISOString();
      window.__reviewViewerChannel=channel;
      channel.postMessage({version:1,type:'ltds-viewer:ready',modelId:'model-quarry',expiresAt});
      channel.postMessage({version:1,type:'ltds-viewer:session-expiring',requestId:'22222222-3333-4444-8555-666666666666',modelId:'model-quarry',expiresAt});
      return true;
    })()`);
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='post'&&item.message?.type==='ltds-viewer:renew-session'&&item.message?.requestId==='22222222-3333-4444-8555-666666666666'&&item.message?.grant==='11111111-2222-4333-8444-555555555555')", `${viewport.name}: review child did not receive its exact scoped renewal grant`);
    if (viewport.name === 'desktop') {
      const grantsBeforeBlockedPopup = runtime.requests.filter(item => item.method === 'POST' && item.path === '/api/v1/attempts/attempt-quarry/review-sessions').length;
      await client.evaluate(`(() => { window.__blockNextLauncher=true; document.querySelector('.task-quick-actions [data-action="open-review"]').click(); return true; })()`);
      await waitFor(client, "document.querySelector('#workspace-toast')?.textContent.includes('Viewer popup was blocked or failed to initialize')", `${viewport.name}: blocked popup did not fail through the bounded launcher timeout`, 10_000);
      const grantsAfterBlockedPopup = runtime.requests.filter(item => item.method === 'POST' && item.path === '/api/v1/attempts/attempt-quarry/review-sessions').length;
      assert.equal(grantsAfterBlockedPopup, grantsBeforeBlockedPopup, `${viewport.name}: blocked popup minted a review grant before readiness`);
    }
    await client.evaluate(`document.querySelector('[data-action="task-settings"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"trash-task\"][data-id=\"task-quarry\"]') !== null", `${viewport.name}: terminal task Delete was not reachable`);
    await confirmAppAction(client, runtime, '[data-action="trash-task"][data-id="task-quarry"]', { title: 'Move to Recycle Bin', cancelFirst: true });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/tasks/task-quarry');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: task Delete did not settle`);
    assert.equal(runtime.archivedTasks.has('task-quarry'), true, `${viewport.name}: fixture did not archive the deleted task`);
    const remainingTasks = JSON.parse(apiResponse(new URL('/api/v1/tasks', origin), runtime).body).tasks;
    assert.equal(remainingTasks.some(task => task.id === 'task-quarry'), false, `${viewport.name}: deleted task remained in the active task list`);
    await waitFor(client, "new URL(location.href).searchParams.get('project')==='project-quarry' && !new URL(location.href).searchParams.has('task') && !new URL(location.href).searchParams.has('panel') && document.querySelector('.task-workspace-page') === null", `${viewport.name}: deleting the selected task did not leave Settings and restore its project`);
    await waitFor(client, "document.querySelector('[data-action=\"trash-project\"][data-id=\"project-quarry\"]') !== null", `${viewport.name}: project Delete was not reachable`);
    await confirmAppAction(client, runtime, '[data-action="trash-project"][data-id="project-quarry"]', { title: 'Move to Recycle Bin' });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/projects/project-quarry');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: project Delete did not settle`);
    await waitFor(client, "document.querySelector('#workspace-toast .toast-action')?.textContent === 'View Recycle Bin'", `${viewport.name}: Delete did not expose a direct Recycle Bin action`);
    await client.evaluate(`document.querySelector('#workspace-toast .toast-action').click()`);
    await waitFor(client, "new URL(location.href).searchParams.get('section')==='trash' && document.querySelector('[data-action=\"retry-trash-load\"]') !== null", `${viewport.name}: Recycle Bin did not distinguish a storage load failure from an empty bin`);
    assert.equal(await client.evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('Storage inventory is temporarily unavailable.')`), true, `${viewport.name}: Recycle Bin omitted the storage load error`);
    await client.evaluate(`document.querySelector('[data-action="retry-trash-load"]').click()`);
    await waitFor(client, "document.querySelectorAll('.trash-group').length === 2 && document.querySelectorAll('[data-action=\"restore-trash\"]').length === 2", `${viewport.name}: Recycle Bin retry did not render grouped recoverable items`);

    await client.evaluate(`document.querySelector('[data-section="providers"]').click()`);
    await waitFor(client, "document.querySelector('.provider-workspace [data-action=\"select-provider\"][data-id=\"provider-nodeodm\"]') !== null", `${viewport.name}: provider section did not render`);
    assert.equal(await client.evaluate(`Number(document.querySelector('#background-work-count')?.textContent) >= 1`), true, `${viewport.name}: background count did not persist across navigation`);
    await client.evaluate(`document.querySelector('[data-action="select-provider"][data-id="provider-nodeodm"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === false && document.querySelector('#provider-inline-detail .provider-detail') !== null", `${viewport.name}: provider selection must show inline, not in a modal`);
    assert.equal(await client.evaluate(`document.querySelector('.provider-detail h3')?.textContent`), 'TrueNAS NodeODM', `${viewport.name}: provider inline selection`);
    assert.match(await client.evaluate(`document.querySelector('.provider-detail').textContent`), /Cluster-managed capacity/);
    assert.equal(await client.evaluate(`document.querySelector('.provider-detail').textContent.includes('99999999999')`), false, `${viewport.name}: cluster sentinel must not imply real upstream slots`);
    assert.match(await client.evaluate(`document.querySelector('.provider-detail').textContent`), /Viewer admission2 concurrent jobs/, `${viewport.name}: Viewer admission stays separate from cluster-managed capacity`);
    assert.equal(await client.evaluate(`document.querySelector('[data-action="select-provider"][data-id="provider-nodeodm"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('.provider-workspace .provider-list')).overflowY`), 'auto', `${viewport.name}: node list must scroll independently`);
    assert.equal(await client.evaluate(`(()=>{const left=document.querySelector('.provider-workspace>aside').getBoundingClientRect(),right=document.querySelector('#provider-inline-detail').getBoundingClientRect();return innerWidth>720?left.right<right.left:right.top>=left.bottom;})()`),true,`${viewport.name}: node list/detail must be side-by-side on desktop and stacked on mobile`);
    if(process.env.LTDS_PROVIDER_SCREENSHOTS==='1'){
      await client.evaluate(`document.querySelector('.provider-workspace').scrollIntoView({block:'start'})`);
      const shot=await client.command('Page.captureScreenshot',{format:'png'}),directory=path.join(root,'tmp','provider-browser-qa');
      mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,`${viewport.name.replace(/[^a-z0-9]+/gi,'-')}.png`),Buffer.from(shot.data,'base64'));
    }
    await client.evaluate(`document.querySelector('[data-action="edit-provider"]').click()`);
    await waitFor(client, "document.querySelector('#provider-edit-form') !== null", `${viewport.name}: provider edit form did not open`);
    await client.evaluate(`window.__providerBeforeChange=document.querySelector('#provider-inline-detail')`);
    await client.evaluate(`(() => { const form=document.querySelector('#provider-edit-form'); form.elements.admissionLimit.value='3'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "!window.__providerBeforeChange.isConnected && document.querySelector('#workspace-modal')?.open === false && document.querySelector('[data-action=\"replace-provider-token\"]') !== null", `${viewport.name}: provider edit did not return to refreshed node detail`);
    await client.evaluate(`document.querySelector('[data-action="replace-provider-token"]').click()`);
    await waitFor(client, "document.querySelector('#provider-token-form') !== null", `${viewport.name}: provider token form did not open`);
    await client.evaluate(`window.__providerBeforeChange=document.querySelector('#provider-inline-detail')`);
    await client.evaluate(`(() => { const form=document.querySelector('#provider-token-form'); form.elements.token.value='browser-secret-token'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "!window.__providerBeforeChange.isConnected && document.querySelector('#workspace-modal')?.open === false && document.querySelector('[data-action=\"new-preset\"]') !== null", `${viewport.name}: provider token update did not return to refreshed node detail`);
    await client.evaluate(`document.querySelector('[data-action="new-preset"]').click()`);
    await waitFor(client, "document.querySelector('#preset-form') !== null", `${viewport.name}: preset form did not open`);
    await client.evaluate(`window.__providerBeforeChange=document.querySelector('#provider-inline-detail')`);
    await client.evaluate(`(() => { const form=document.querySelector('#preset-form'); form.elements.displayName.value='Browser preset'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "!window.__providerBeforeChange.isConnected && document.querySelector('#workspace-modal')?.open === false && document.querySelector('[data-action=\"delete-preset\"]') !== null", `${viewport.name}: preset creation did not return to refreshed node detail`);
    await confirmAppAction(client, runtime, '[data-action="delete-preset"]', { title: 'Delete preset', cancelFirst: true });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/processing/presets/preset-fast');
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === false && document.querySelector('#provider-inline-detail') !== null", `${viewport.name}: preset deletion did not return to inline node detail`);
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: provider workspace overflows horizontally`);

    await client.evaluate(`document.querySelector('[data-section="diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"open-trash\"]') !== null", `${viewport.name}: diagnostics did not link to the dedicated Recycle Bin`);
    assert.deepEqual(await client.evaluate(`Object.fromEntries([...document.querySelectorAll('#storage-usage-cards .metric-card')].slice(0,6).map(card=>[card.querySelector('p').textContent,card.querySelector('strong').textContent]))`), {
      'Total Viewer files': '40.0 MB', 'Original photos & source inputs': '4.0 MB',
      'Model products': '8.0 MB', 'Temporary cache & import ZIPs': '12.0 MB',
      'Recycle Bin files': '16.0 MB', 'Other retained files': '0 B',
    }, `${viewport.name}: diagnostics did not show non-overlapping measured file usage`);
    const storageText = await client.evaluate(`document.querySelector('#storage-usage-cards').textContent`);
    for (const expected of ['Shared filesystem 1', '60.0 MB free', 'not a folder subtotal', 'Categories do not overlap', 'snapshots']) assert.ok(storageText.includes(expected), `${viewport.name}: storage accounting omitted ${expected}`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.diagnostic-project-group>h3')].map(item=>item.textContent)`), ['Johnson Road Survey', 'Alpha Quarry'], `${viewport.name}: global diagnostic runs were not grouped by project`);
    assert.equal(await client.evaluate(`document.querySelectorAll('.diagnostic-task-group').length`), 2, `${viewport.name}: global diagnostic runs were not grouped by task`);
    await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-johnson-old"] [data-action="open-global-attempt-diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('#global-attempt-diagnostic-attempt-johnson-old')?.textContent.includes('[REDACTED PATH]')", `${viewport.name}: retained sanitized diagnostics log did not render`);
    assert.equal(await client.evaluate(`(() => { const button=document.querySelector('[data-diagnostic-attempt-id="attempt-johnson-old"] [data-action="open-global-attempt-diagnostics"]'); return document.getElementById(button.getAttribute('aria-controls')) !== null })()`), true, `${viewport.name}: run disclosure did not reference its stable diagnostic panel`);
    await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-global-flaky"] [data-action="open-global-attempt-diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('#global-attempt-diagnostic-attempt-global-flaky.load-error [data-action=\"retry-global-attempt-diagnostics\"]') !== null", `${viewport.name}: diagnostic load failure did not expose Retry`);
    const flakyRequestsBeforeRetry = runtime.requests.filter(item => item.path === '/api/v1/attempts/attempt-global-flaky/diagnostics').length;
    await client.evaluate(`document.querySelector('#global-attempt-diagnostic-attempt-global-flaky [data-action="retry-global-attempt-diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('#global-attempt-diagnostic-attempt-global-flaky')?.textContent.includes('Retained sanitized recovery output')", `${viewport.name}: diagnostic Retry toggled closed instead of reloading`);
    assert.equal(runtime.requests.filter(item => item.path === '/api/v1/attempts/attempt-global-flaky/diagnostics').length, flakyRequestsBeforeRetry + 1, `${viewport.name}: diagnostic Retry did not issue a fresh request`);
    await client.evaluate(`document.querySelector('[data-action="load-more-diagnostic-runs"]').click()`);
    await waitFor(client, "document.querySelector('[data-diagnostic-attempt-id=\"attempt-global-older\"]') !== null", `${viewport.name}: older global diagnostic runs did not append`);
    await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-global-older"] [data-action="open-global-attempt-diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('#global-attempt-diagnostic-attempt-global-older')?.textContent.includes('Audit acceptance: gray-zone')", `${viewport.name}: successful v4 gray-zone audit acceptance was not exposed`);
    const acceptedAuditText = await client.evaluate(`document.querySelector('#global-attempt-diagnostic-attempt-global-older').textContent`);
    for (const expected of ['areaRelativeDelta', '0.000010618457348535776', 'ltds-controlled-surface-policy-v4']) assert.ok(acceptedAuditText.includes(expected), `${viewport.name}: successful v4 diagnostics omitted ${expected}`);
    await confirmAppAction(client, runtime, '[data-action="retry-storage-mutation"][data-id="mutation-failed"]', { title: 'Confirm action', cancelFirst: true });
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/storage/mutations/mutation-failed/retry');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: lifecycle retry did not settle`);
    await client.evaluate(`document.querySelector('[data-action="open-trash"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"purge-trash\"]') !== null", `${viewport.name}: trash lifecycle controls did not render`);
    assert.equal(await client.evaluate(`new URL(location.href).searchParams.get('section')`), 'trash', `${viewport.name}: Recycle Bin was not a top-level routed section`);
    assert.equal(await client.evaluate(`document.querySelectorAll('[data-action="restore-trash"]').length`), 2, `${viewport.name}: paginated trash was not fully rendered`);
    await client.evaluate(`document.querySelector('[data-action="restore-trash"][data-id="trash-johnson"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/storage/trash/trash-johnson/restore');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: trash restore did not settle`);
    assert.equal(await client.evaluate(`document.querySelector('[data-action="purge-trash"][data-id="trash-johnson"]').dataset.entityId`), 'dataset-trash', `${viewport.name}: trash confirmation must bind the exact entity identifier`);
    await confirmAppAction(client, runtime, '[data-action="purge-trash"][data-id="trash-johnson"]', {
      title: 'Permanently delete item', cancelFirst: true,
      invalidFields: { typedId: 'wrong-id' }, fields: { typedId: 'dataset-trash' },
    });
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/storage/trash/trash-johnson');
    assert.deepEqual(runtime.requests.slice(requestStart).find(item => item.method === 'DELETE' && item.path === '/api/v1/storage/trash/trash-johnson').body, { typedId: 'dataset-trash' });

    const recent = runtime.requests.slice(requestStart);
    for (const expected of [
      ['POST', '/api/v1/tasks/task-johnson/gcp-correspondences'],
      ['PATCH', '/api/v1/gcp-correspondences/gcp-mark-1'],
      ['DELETE', '/api/v1/gcp-correspondences/gcp-mark-1'],
      ['POST', '/api/v1/processing/outputs/output-johnson/view-sessions'],
      ['POST', '/api/v1/operations/operation-recovery-failed/retry'],
      ['DELETE', '/api/v1/processing/outputs/output-johnson'],
      ['POST', '/api/v1/processing/outputs/output-quarry-ready/derivatives/tiles'],
      ['DELETE', '/api/v1/processing/outputs/output-johnson-archived'],
      ['DELETE', '/api/v1/datasets/dataset-johnson'],
      ['DELETE', '/api/v1/tasks/task-quarry'],
      ['DELETE', '/api/v1/projects/project-quarry'],
      ['PATCH', '/api/v1/processing/providers/provider-nodeodm'],
      ['PUT', '/api/v1/processing/providers/provider-nodeodm/credential'],
      ['POST', '/api/v1/processing/presets'],
      ['DELETE', '/api/v1/processing/presets/preset-fast'],
      ['POST', '/api/v1/storage/trash/trash-johnson/restore'],
      ['POST', '/api/v1/storage/mutations/mutation-failed/retry'],
      ['DELETE', '/api/v1/storage/trash/trash-johnson'],
    ]) assert.ok(recent.some(item => item.method === expected[0] && item.path === expected[1]), `${viewport.name}: missing browser mutation ${expected.join(' ')}`);

    const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(exceptions, [], `${viewport.name}: uncaught browser exceptions`);
  } finally {
    await client.command('Page.close').catch(() => {});
    client.close();
  }
}

test('project-first workspace is interactive and overflow-free in real desktop and mobile browsers', { timeout: 180_000, skip: manualFixture }, async t => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Set CHROME_PATH or EDGE_PATH to a Chromium-family browser to run the real browser verification.');
    return;
  }

  const releaseBrowserLock = await acquireBrowserHarnessLock({ root });
  let server, runtime, origin, profile, browser;
  try {
    ({ server, runtime, origin } = await startFixtureServer());
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-browser-'));
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const devTools = await waitForDevTools(profile);
    const requestedViewport = process.env.LTDS_WORKSPACE_BROWSER_VIEWPORT;
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900, mobile: false },
      { name: '390px mobile', width: 390, height: 844, mobile: true },
      { name: '320px mobile', width: 320, height: 720, mobile: true },
    ].filter(viewport => !requestedViewport || viewport.name === requestedViewport)) await t.test(viewport.name, () => verifyViewport(devTools, origin, viewport, runtime));
  } finally {
    try {
      if (browser) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        browser.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
      }
    } finally {
      releaseBrowserLock();
    }
    if (server) await new Promise(resolve => server.close(resolve));
    await removeBrowserProfile(profile, t);
  }
});

test('orthophoto preview settles on the mounted task after navigation during decoding', { timeout: 60_000, skip: manualFixture }, async t => {
  const executable = browserPath();
  if (!executable) { t.skip('Chrome or Edge is required for preview lifecycle browser QA.'); return; }
  const releaseBrowserLock = await acquireBrowserHarnessLock({ root });
  let server, runtime, origin, profile, browser, releaseResponse;
  try {
    ({ server, runtime, origin } = await startFixtureServer());
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-browser-'));
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const devTools = await waitForDevTools(profile);
    for (const fail of [false, true]) await t.test(fail ? 'failed response updates replacement preview' : 'decoded response updates replacement preview', async () => {
      runtime.requests = [];
      runtime.failOrthophotoResponse = fail;
      runtime.orthophotoResponseGate = new Promise(resolve => { releaseResponse = resolve; });
      const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
      const client = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await client.command('Page.enable');
        await client.command('Runtime.enable');
        await client.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await client.command('Page.addScriptToEvaluateOnNewDocument', { source: `sessionStorage.setItem('ltds-viewer-admin-token', ${JSON.stringify(token)});` });
        await client.command('Page.navigate', { url: `${origin}/workspace?section=dashboard&project=project-johnson&task=task-johnson` });
        await waitForRequest(runtime, 0, 'GET', '/api/v1/processing/outputs/output-johnson/assets/ortho');
        await waitFor(client, "document.querySelector('.compact-task-detail .task-facts') !== null", 'Initial task details did not settle');
        await client.evaluate(`window.__firstPreview=document.querySelector('.task-ortho-preview canvas'); document.querySelector('[data-section="background"]').click()`);
        await waitFor(client, "document.querySelector('#import-activity') !== null", 'Background route did not replace the task');
        await client.evaluate(`history.back()`);
        await waitFor(client, "Boolean(document.querySelector('.task-ortho-preview canvas'))", 'Returning to Dashboard did not restore the pending preview');
        assert.equal(await client.evaluate(`!window.__firstPreview.isConnected && window.__firstPreview !== document.querySelector('.task-ortho-preview canvas')`), true, 'Navigation must replace the captured preview while its response is pending');
        releaseResponse();
        if (fail) {
          await waitFor(client, "document.querySelector('.task-ortho-preview.unavailable')?.textContent.includes('Preview unavailable')", 'Failed decode did not update the mounted replacement preview');
          assert.equal(await client.evaluate(`document.querySelector('.task-ortho-preview.loading') === null`), true);
        } else {
          await waitFor(client, "document.querySelector('.task-ortho-preview canvas')?.getAttribute('aria-label') === 'Published orthophoto preview' || (()=>{const image=document.querySelector('.task-ortho-preview img');return Boolean(image?.complete && image.naturalWidth>0)})()", 'Successful decode did not update the mounted replacement preview');
          assert.equal(await client.evaluate(`(() => {const canvas=document.querySelector('.task-ortho-preview canvas'),image=document.querySelector('.task-ortho-preview img');return canvas ? [...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data].some(value=>value>0) : Boolean(image?.complete && image.naturalWidth>0)})()`), true, 'Mounted preview must contain decoded pixels');
        }
        assert.equal(runtime.requests.filter(item => item.path === '/api/v1/processing/outputs/output-johnson/assets/ortho').length, 1, 'Rerender must reuse one in-flight decode rather than issuing duplicate reads');
      } finally {
        releaseResponse?.();
        await client.command('Page.close').catch(() => {});
        client.close();
      }
    });
  } finally {
    releaseResponse?.();
    if (browser) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    releaseBrowserLock();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await removeBrowserProfile(profile, t);
  }
});

test('companion product restore is explicit, immutable-version scoped, and permission-safe in a real browser', { timeout: 120_000, skip: manualFixture }, async t => {
  const executable = browserPath();
  if (!executable) { t.skip('Chrome or Edge is required for companion repair browser QA.'); return; }
  const releaseBrowserLock = await acquireBrowserHarnessLock({ root });
  let server, runtime, origin, profile, browser;
  try {
    ({ server, runtime, origin } = await startFixtureServer());
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-browser-'));
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const devTools = await waitForDevTools(profile);
    const endpoint = '/api/v1/processing/outputs/output-johnson/companion-repair-attempts';
    const readOnly = ['viewer.projects.read', 'viewer.datasets.read', 'viewer.processing.read', 'viewer.providers.read'];
    const cases = [
      { name: 'explicit new-version restore', click: 'create' },
      { name: 'pending restore suppresses duplicate creation', status: 'queued' },
      { name: 'failed restore retries its existing operation', status: 'failed', click: 'retry' },
      { name: 'legacy companion operation still retries correctly', status: 'failed', click: 'retry', legacy: true },
      { name: 'read-only does not expose creation', readOnly: true },
      { name: 'read-only does not expose failed-operation retry', status: 'failed', readOnly: true },
      { name: 'exhausted retry remains failed without offering another version', status: 'failed', retryable: false },
      { name: 'source rejection restores an actionable control', click: 'create', reject: true },
    ];
    for (const scenario of cases) await t.test(scenario.name, async () => {
      let releaseTaskDetail;
      // Force one slow detail response so opening Settings cannot accidentally
      // rely on the speed of the synthetic server or Chromium scheduling.
      runtime.taskDetailResponseGate = scenario.reject
        ? new Promise(resolve => { releaseTaskDetail = resolve; }) : null;
      runtime.requests = [];
      runtime.permissions = scenario.readOnly ? readOnly : null;
      runtime.rejectCompanionRepair = Boolean(scenario.reject);
      runtime.derivatives = [];
      runtime.outputs = structuredClone(fixtures.outputs);
      Object.assign(runtime.outputs[0], {
        assetKinds: ['tiles'], lod: { status: 'available' },
        companionRepairAction: { kind: 'new_version', eligible: true, endpoint, missingAssetKinds: ['ortho', 'dsm', 'dtm', 'ept'] },
      });
      runtime.operations = scenario.status ? [{
        id: 'operation-companion', type: scenario.legacy ? 'companion_repair' : 'lod_recovery',
        companionRepair: !scenario.legacy, projectId: 'project-johnson',
        sourceOutputId: 'output-johnson', status: scenario.status, phase: scenario.status,
        retryable: scenario.retryable !== false, progress: 0,
        errorMessage: scenario.status === 'failed' ? 'Retained companion source verification failed.' : null,
        source: { kind: 'existing_model', browserTransferRequired: false, transferComplete: true },
        attemptCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }] : [];
      const originalOutput = structuredClone(runtime.outputs[0]);
      const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
      const client = await CdpClient.connect(target.webSocketDebuggerUrl);
      try {
        await client.command('Page.enable');
        await client.command('Runtime.enable');
        await client.command('Page.addScriptToEvaluateOnNewDocument', {
          source: `sessionStorage.setItem('ltds-viewer-admin-token', ${JSON.stringify(token)});`,
        });
        await client.command('Page.navigate', { url: `${origin}/workspace?section=dashboard&project=project-johnson&task=task-johnson` });
        await waitFor(client, `Boolean(document.querySelector('.task-quick-actions')) && !document.querySelector('#workspace').hasAttribute('aria-busy')`, 'Task output actions did not load');
        assert.equal(runtime.requests.filter(request => request.method === 'POST').length, 0, 'Page load must never create/retry/import/publish work');
        assert.equal(await client.evaluate(`Boolean(document.querySelector('.task-quick-actions [data-action="restore-products"], .task-quick-actions [data-action="retry-operation"]'))`), false, 'Recovery actions belong in Task settings, not beside View');
        await waitFor(client, `Boolean(document.querySelector('[data-action="task-settings"]'))`, 'Task settings navigation did not load');
        await client.evaluate(`document.querySelector('[data-action="task-settings"]').click()`);
        await waitFor(client, `new URL(location.href).searchParams.get('panel')==='settings' && Boolean(document.querySelector('.task-workspace-page'))`, 'Task settings route did not load');
        if (scenario.reject) {
          await waitForRequest(runtime, 0, 'GET', '/api/v1/tasks/task-johnson');
          assert.equal(await client.evaluate(`document.querySelector('.task-workspace-page')?.textContent.includes('Loading authoritative task details')`), true, 'Settings must expose the pending detail state');
          assert.equal(await client.evaluate(`document.querySelectorAll('.task-workspace-page button').length`), 0, 'The loading placeholder is not the settled action list');
          releaseTaskDetail();
        }
        await waitFor(client, `Boolean(document.querySelector('.task-workspace-page .task-options'))`, 'Authoritative task settings did not finish loading');
        assert.equal(runtime.requests.filter(request => request.method === 'POST').length, 0, 'Opening settings must never create/retry/import/publish work');
        const actions = await client.evaluate(`Array.from(document.querySelectorAll('.task-workspace-page button'), button => ({ text: button.textContent, action: button.dataset.action, disabled: button.disabled, title: button.title }))`);
        if (scenario.readOnly) {
          assert.equal(actions.some(button => ['restore-products', 'retry-operation'].includes(button.action)), false, JSON.stringify(actions));
        } else if (scenario.status === 'queued') {
          assert.ok(actions.some(button => button.text === 'Restoring products…' && button.disabled), JSON.stringify(actions));
          assert.equal(actions.some(button => button.action === 'restore-products'), false);
        } else if (scenario.retryable === false) {
          assert.ok(actions.some(button => button.text === 'Product restore failed' && button.disabled), JSON.stringify(actions));
        } else if (scenario.click === 'retry') {
          assert.ok(actions.some(button => button.action === 'retry-operation' && button.text === 'Retry product restore'), JSON.stringify(actions));
          await client.evaluate(`document.querySelector('.task-workspace-page [data-action="retry-operation"]').click()`);
          await waitForRequest(runtime, 0, 'POST', '/api/v1/operations/operation-companion/retry');
          assert.equal(runtime.requests.some(request => request.path === endpoint), false, 'Retry must not create a second restore version');
        } else {
          assert.ok(actions.some(button => button.action === 'restore-products' && button.title.includes('new version')), JSON.stringify(actions));
          await client.evaluate(`(() => { const button=document.querySelector('.task-workspace-page [data-action="restore-products"]');button.click();button.click();return true; })()`);
          await waitForRequest(runtime, 0, 'POST', endpoint);
          const mutations = runtime.requests.filter(request => request.method === 'POST');
          assert.equal(mutations.length, 1, 'A double click must submit only one version-bound repair');
          assert.equal(mutations[0].path, endpoint);
          assert.deepEqual(mutations[0].body, {}, 'The browser must not supply filesystem paths or trusted hashes');
          assert.match(mutations[0].idempotencyKey, /^[0-9a-f-]{36}$/i);
          if (scenario.reject) {
            await waitFor(client, `document.querySelector('#workspace-toast')?.textContent.includes('verification failed')`, 'Source failure was not exposed');
            assert.equal(await client.evaluate(`document.querySelector('.task-workspace-page [data-action="restore-products"]').disabled`), false);
            assert.equal(runtime.operations.length, 0, 'Failed admission must not enqueue a fake repair');
          } else {
            await waitFor(client, `document.querySelector('#workspace-toast')?.textContent.includes('Existing versions and publications are unchanged')`, 'New-version safety message was absent');
            assert.equal(runtime.operations.length, 1);
            assert.equal(runtime.operations[0].type, 'lod_recovery');
            assert.equal(runtime.operations[0].companionRepair, true);
            assert.equal(runtime.operations[0].sourceOutputId, originalOutput.id);
          }
        }
        assert.deepEqual(runtime.outputs[0], originalOutput, 'The source version and its publication must remain unchanged');
        await client.evaluate(`document.querySelector('[data-section="background"]').click()`);
        await waitFor(client, `Boolean(document.querySelector('#import-activity'))`, 'Background work did not load');
        if (runtime.operations.length) {
          const row = await client.evaluate(`document.querySelector('[data-operation-id="operation-companion"]')?.textContent`);
          assert.ok(row.includes('Restore missing products'), row);
          if (scenario.readOnly || scenario.retryable === false || runtime.operations[0].status !== 'failed') {
            assert.equal(await client.evaluate(`Boolean(document.querySelector('[data-operation-id="operation-companion"] [data-action="retry-operation"]'))`), false);
          }
        }
        const unexpectedMutations = runtime.requests.filter(request => request.method !== 'GET'
          && ![endpoint, '/api/v1/operations/operation-companion/retry'].includes(request.path));
        assert.deepEqual(unexpectedMutations, [], 'No provider restart, re-import, publication or deletion is allowed');
        const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown');
        assert.deepEqual(exceptions, []);
      } finally {
        releaseTaskDetail?.();
        await client.command('Page.close').catch(() => {});
        client.close();
      }
    });
  } finally {
    try {
      if (browser) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        browser.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
      }
    } finally { releaseBrowserLock(); }
    if (server) await new Promise(resolve => server.close(resolve));
    await removeBrowserProfile(profile, t);
  }
});
