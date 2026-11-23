import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp as CdpClient } from './bounded-test-cdp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeArrayBuffer } from 'geotiff';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { FINE_POINTER_SWITCH, assertFinePointer } from './fine-pointer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
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

// Edge on Windows relaunches itself (--edge-skip-compat-layer-relaunch), so the spawned process
// is not the browser and killing its tree leaves the browser running. Stop every browser process
// that uses this run's own temporary profile, and nothing else.
function stopProfileBrowsers(profile) {
  if (process.platform !== 'win32') return;
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(tmpdir(), 'ltds-viewer-browser-'))) return;
  const script = `$p='${resolved.replace(/'/g, "''")}';Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 20_000, windowsHide: true });
}

async function removeBrowserProfile(profile, t) {
  if (!profile) return;
  const resolved = path.resolve(profile);
  const expectedPrefix = path.resolve(tmpdir(), 'ltds-viewer-browser-');
  if (!resolved.startsWith(expectedPrefix)) throw new Error(`refusing to remove unexpected browser profile: ${resolved}`);
  stopProfileBrowsers(resolved);
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
  const projectFolders = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/folders$/);
  if (projectFolders && method === 'GET') return json({folders:[]});
  if (pathname === '/api/v1/datasets') return json({ datasets: fixtures.datasets, nextCursor: null });
  if (pathname === '/api/v1/tasks') {
    const projectId=url.searchParams.get('projectId');
    const tasks=fixtures.tasks.filter(item=>!runtime.archivedTasks.has(item.id))
      .map(item=>{
        const stored=runtime.folderProcessing?.getTask(item.id);
        return stored?{...item,projectId:stored.projectId,folderId:stored.folderId,folderRevision:stored.folderRevision,status:stored.status}:item;
      })
      .filter(item=>!projectId||item.projectId===projectId);
    return json({tasks,nextCursor:null});
  }
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
  const taskDelete = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (taskDelete && method === 'DELETE') { runtime.archivedTasks.add(taskDelete[1]); return json({ trash: { id: `trash-task-${taskDelete[1]}`, entityType: 'task' } }); }
  const taskRestore = pathname.match(/^\/api\/v1\/storage\/trash\/trash-task-([^/]+)\/restore$/);
  if (taskRestore && method === 'POST' && runtime.archivedTasks.delete(taskRestore[1])) return json({ task: { id: taskRestore[1] } });
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
  if (pathname === '/api/v1/workspace/native-client-grants') return json({targets:[],grants:[]});
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
  // Like the task list, the detail follows a task the folder backend stores (its project, folder and revision).
  if (pathname === '/api/v1/tasks/task-quarry') return json({ task: { ...fixtures.tasks[1], ...(stored => stored ? { projectId: stored.projectId, folderId: stored.folderId, folderRevision: stored.folderRevision } : {})(runtime.folderProcessing?.getTask('task-quarry')), status: runtime.archivedTasks.has('task-quarry')?'archived':'ready_for_review', metrics: { sourceImageCount: 12, processingStatus: 'ready_for_review', outputCount: 1 }, outputs: [fixtures.outputs[2]] } });
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
    const createdAt = new Date().toISOString();
    return json({
      attempt: fixtures.tasks[0].latestAttempt,
      logs: [
        ...Array.from({ length: runtime.longTaskOutput ? 50 : 0 }, (_, index) => ({ createdAt, level: 'info', message: `Fixture output line ${index}` })),
        { createdAt, level: 'info', message: `Running stage odm_dem · browser refresh ${sequence}` },
      ],
    });
  }
  if (runtime.testIngestRecovery && pathname === '/api/v1/attempts/attempt-johnson-old/recover-ingest' && method === 'POST') {
    runtime.recoveryPosts = (runtime.recoveryPosts || 0) + 1;
    if (runtime.recoveryPosts === 1) return json({error:'synthetic_uncertain'},503);
    runtime.recoveryDone = true; return json({attempt:{id:'attempt-johnson-old',status:'ingesting'}},202);
  }
  if (pathname === '/api/v1/attempts/attempt-johnson-old/diagnostics') return json({ diagnostics: {
    ...(runtime.testIngestRecovery ? {recovery:{kind:'ingest',available:!runtime.recoveryDone,remainingRequests:3}} : {}),
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
  const builtRoot = path.resolve(process.env.VIEWER_BROWSER_DIST || path.join(root, 'dist'));
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
        if(runtime.folderBackend&&(/^\/api\/v1\/projects\/[^/]+\/folders(?:\/[^/]+)?$/.test(url.pathname)||/^\/api\/v1\/tasks\/[^/]+\/(?:folder|project)$/.test(url.pathname))){
          if(runtime.taskMoveResponseGate&&/^\/api\/v1\/tasks\/[^/]+\/(?:folder|project)$/.test(url.pathname))await runtime.taskMoveResponseGate;
          const upstream=await fetch(`${runtime.folderBackend}${url.pathname}`,{method:request.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':request.headers['idempotency-key']||'folder-browser-fixture-key'},...(raw?{body:raw}:{})});
          result={status:upstream.status,type:'application/json',body:Buffer.from(await upstream.arrayBuffer())};
        }else result = url.pathname === '/api/v1/processing/outputs/output-johnson/assets/ortho' && runtime.failOrthophotoResponse
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

async function createDevToolsTarget(devTools, label = 'create browser target') {
  const origin = new URL(devTools);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  const response = await fetch(new URL('/json/new?about:blank', origin), {
    method: 'PUT',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true, label);
  const target = await response.json();
  const socket = new URL(target.webSocketDebuggerUrl);
  assert.equal(socket.protocol, 'ws:');
  assert.equal(socket.host, origin.host);
  return target;
}

async function closeDevToolsTarget(client) {
  try {
    await client.command('Page.close').catch(() => {});
  } finally {
    client.close();
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

// Times a task-list change from the page's own records, not from polling (CI poll gaps reach
// 50-70 ms): Resource Timing's responseEnd for the move request to the MutationObserver record
// that removes (or adds) the row. Arm before the action whose response is measured.
function armRowChange(client, selector, present) {
  return client.evaluate(`(()=>{
    window.__rowObserver?.disconnect();performance.clearResourceTimings();window.__rowChange=null;
    const observer=new MutationObserver(()=>{if(window.__rowChange===null&&Boolean(document.querySelector(${JSON.stringify(selector)}))===${Boolean(present)}){window.__rowChange=performance.now();observer.disconnect();}});
    window.__rowObserver=observer;observer.observe(document.documentElement,{childList:true,subtree:true});
  })()`);
}
async function assertRowChangeWithin(client, pathname, message, bound = 300) {
  const timing = await client.evaluate(`(()=>{
    const entry=performance.getEntriesByType('resource').filter(item=>new URL(item.name).pathname===${JSON.stringify(pathname)}).at(-1);
    return {change:window.__rowChange,responseEnd:entry?entry.responseEnd:null};
  })()`);
  assert.notEqual(timing.change, null, `${message}: the task list never changed`);
  assert.notEqual(timing.responseEnd, null, `${message}: the move response was not recorded`);
  const elapsed = timing.change - timing.responseEnd;
  assert.ok(elapsed <= bound, `${message}: the task list changed ${Math.round(elapsed)} ms after the move response (bound ${bound} ms)`);
}

async function waitForDevTools(profile) {
  const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'), {label:'Browser did not expose a DevTools endpoint'});
  return `http://127.0.0.1:${port}`;
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

// A project row can show 3-5 parts: name, summary, activity chips (only when
// something is happening), a status badge (only when not active) and the
// chevron. Rows are laid out by the project list's width: 720px or wider is one
// line; narrower (phones, or a small window with the sidebar open) stacks into
// name/summary on the left, status/chevron on the right and activity below.
// Either way no part may wrap out of place, spill, or squeeze the name away.
async function verifyProjectRowColumns(client, viewport) {
  const cases = [
    { name: 'inactive with activity', status: 'archived', activity: true },
    { name: 'inactive, no activity', status: 'archived', activity: false },
    { name: 'active with activity', status: null, activity: true },
  ];
  try {
    for (const width of viewport.mobile ? [viewport.width] : [721, 1000, 1101, 1280, 1440, 1600]) {
      await client.command('Emulation.setDeviceMetricsOverride', { width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile, screenWidth: width, screenHeight: viewport.height });
      const results = await client.evaluate(`(() => {
        const source = document.querySelector('.project-row');
        const listWidth = source.parentElement.getBoundingClientRect().width;
        const out = [];
        for (const item of ${JSON.stringify(cases)}) {
          const row = source.cloneNode(true);
          row.classList.remove('selected');
          row.querySelector('.project-detail')?.remove();
          const button = row.querySelector('.project-open');
          button.querySelector('.project-name strong').textContent = 'A long synthetic project name for the row layout check ' + item.name;
          button.querySelector('.project-open > .status')?.remove();
          button.querySelector('.project-activity').innerHTML = item.activity ? '<span class="activity-chip processing">2 processing</span><span class="activity-chip failed">1 needs attention</span>' : '';
          if (item.status) button.querySelector('.project-chevron').insertAdjacentHTML('beforebegin', '<span class="status ' + item.status + '">' + item.status + '</span>');
          source.parentElement.append(row);
          const box = button.getBoundingClientRect();
          const parts = Object.fromEntries([...button.children].filter(child => getComputedStyle(child).display !== 'none').map(child => [child.classList[0], child.getBoundingClientRect()]));
          const rects = Object.values(parts), name = parts['project-name'];
          out.push({ name: item.name, listWidth, count: rects.length, nameWidth: name.width,
            layout: Object.entries(parts).map(([cls, r]) => cls + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)).join(' | '),
            oneLine: rects.every(r => r.top < name.bottom && r.bottom > name.top),
            chevronLast: rects.every(r => r === parts['project-chevron'] || r.right <= parts['project-chevron'].left + 0.5),
            stacked: parts['project-summary'].top >= name.bottom - 0.5 && Math.abs(parts['project-summary'].left - name.left) < 1
              && parts['project-chevron'].left >= name.right - 0.5 && (!parts.status || parts.status.left >= name.right - 0.5)
              && (!parts['project-activity'] || parts['project-activity'].top >= parts['project-summary'].bottom - 0.5),
            inside: rects.every(r => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
            overflow: button.scrollWidth > button.clientWidth + 1 });
          row.remove();
        }
        return out;
      })()`);
      for (const result of results) {
        const label = `${viewport.name} at ${width}px (list ${Math.round(result.listWidth)}px), ${result.name}: ${result.layout}`;
        assert.equal(result.count, result.name === 'inactive with activity' ? 5 : 4, `${label}: unexpected visible part count`);
        if (result.listWidth >= 720) {
          assert.equal(result.oneLine, true, `${label}: project row parts wrapped onto a second line`);
          assert.equal(result.chevronLast, true, `${label}: chevron is not the right-most part`);
          assert.ok(result.nameWidth >= 180, `${label}: project name squeezed`);
        } else {
          assert.equal(result.stacked, true, `${label}: narrow project row is not stacked`);
          assert.ok(result.nameWidth >= 120, `${label}: project name squeezed`);
        }
        assert.equal(result.inside, true, `${label}: project row parts spill outside the row`);
        assert.equal(result.overflow, false, `${label}: project row overflows`);
      }
    }
  } finally {
    await client.command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile, screenWidth: viewport.width, screenHeight: viewport.height });
  }
}

async function verifyViewport(devTools, origin, viewport, runtime) {
  runtime.archivedProjects.clear();
  runtime.archivedTasks.clear();
  runtime.failNextStorage = false;
  runtime.flakyDiagnosticRequests = 0;
  runtime.operations = structuredClone(fixtures.operations);
  runtime.derivatives = structuredClone(fixtures.derivatives);
  const requestStart = runtime.requests.length;
  const target = await createDevToolsTarget(devTools, `create browser target for ${viewport.name}`);
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
    // Viewports share one browser profile; start each with every project closed in the tree.
    if (await client.evaluate(`Boolean(localStorage.getItem('ltds-viewer-tree:v1:ops:browser-audit'))`)) {
      await client.evaluate(`localStorage.removeItem('ltds-viewer-tree:v1:ops:browser-audit')`);
      await client.command('Page.reload');
      await waitFor(client, "document.querySelectorAll('[data-project-name]').length === 2 && !document.querySelector('.project-row.selected')", `${viewport.name}: workspace did not reload with closed projects`);
    }
    await verifyProjectRowColumns(client, viewport);

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

    if (!viewport.mobile) {
      // The sidebar changes the list width independently of the window width.
      // Exercise the previously uncovered range on both sidebar settings.
      for (const width of [721, 800, 950]) {
        await client.command('Emulation.setDeviceMetricsOverride', { width, height: viewport.height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: viewport.height });
        for (const collapsed of [false, true]) {
          await client.evaluate(`(() => { const shell=document.querySelector('#workspace'); if (shell.classList.contains('nav-collapsed') !== ${collapsed}) document.querySelector('#nav-collapse').click(); })()`);
          await new Promise(resolve => setTimeout(resolve, 400)); // sidebar width transition
          const layout = await client.evaluate(`(() => {
            const list=document.querySelector('.tree-body'), panel=list.querySelector('.task-panel'), toggle=panel.querySelector('.task-summary-toggle'), status=toggle.querySelector('.status'), actions=panel.querySelector('.task-quick-actions');
            const bounds=panel.getBoundingClientRect(), fits=el=>{const r=el.getBoundingClientRect();return r.width>0 && r.left>=bounds.left-1 && r.right<=bounds.right+1};
            const controls=actions ? [...actions.querySelectorAll(':scope > button, :scope > details > summary')] : [];
            return { listWidth:list.getBoundingClientRect().width, overflow:panel.scrollWidth>panel.clientWidth+1, status:!!status && fits(status), labels:controls.map(el=>el.getAttribute('aria-label') || el.textContent.trim()), actions:controls.length===4 && controls.every(fits) };
          })()`);
          assert.equal(layout.overflow, false, `${width}px sidebar collapsed=${collapsed}: task row overflows`);
          assert.equal(layout.status, true, `${width}px sidebar collapsed=${collapsed}: status is clipped or missing`);
          assert.deepEqual(layout.labels, ['View', 'Model report', 'Share', 'More task actions'], `${width}px sidebar collapsed=${collapsed}: expected visible task shortcuts`);
          assert.equal(layout.actions, true, `${width}px sidebar collapsed=${collapsed}: task actions are clipped or missing`);
        }
      }
      await client.evaluate(`(() => { if (document.querySelector('#workspace').classList.contains('nav-collapsed')) document.querySelector('#nav-collapse').click(); })()`);
      await client.command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false, screenWidth: viewport.width, screenHeight: viewport.height });
    }

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
    // "⋯" holds the rest: Rename (F2), Move to…, Duplicate (a disabled follow-up), the task pages, then Delete.
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-more-actions[open] button')].map(button=>[button.firstChild.textContent,button.disabled])`),[['Rename',false],['Move to…',false],['Duplicate',true],['Download model files',false],['Details & processing',false],['Files & versions',false],['Processing history',false],['Ground control points',false],['Delete',true]]);
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
    // Compact density: 32px shortcuts on a desktop pointer, 44px at phone widths.
    const minimumTarget = viewport.mobile ? 44 : 32;
    assert.equal(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions > button,.task-more-actions > summary')].every(button=>button.getBoundingClientRect().height>=${minimumTarget})`), true, `${viewport.name}: task shortcuts have sub-${minimumTarget}px targets`);
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
    const fullscreen = '.task-live-output [data-action="fullscreen-logs"]';
    const tailSelector = '.task-live-output .log-tail';
    const focusTargets = viewport.mobile ? [fullscreen] : [
      fullscreen, '.task-live-output [data-action="download-logs"]', tailSelector, '#project-filter',
    ];
    runtime.longTaskOutput = true;
    try {
      for (const selector of focusTargets) {
        if (selector === tailSelector) {
          await waitFor(client, `document.querySelector(${JSON.stringify(tailSelector)})?.textContent.includes('Fixture output line 49')`, 'Long task output did not render');
        }
        assert.equal(await client.evaluate(`(() => {
          const target = document.querySelector(${JSON.stringify(selector)});
          window.__taskOutputFocus = target;
          target.focus({preventScroll:true});
          if (target.matches('.log-tail')) target.scrollTop = 24;
          return document.activeElement === target && (!target.matches('.log-tail') || target.scrollTop === 24);
        })()`), true, `${viewport.name}: fixture could not focus ${selector}`);
        const firstLog = runtime.logSequence;
        const refreshStart = runtime.requests.length;
        await waitForRequest(runtime, refreshStart, 'GET', '/api/v1/attempts/attempt-johnson');
        assert.ok(runtime.logSequence > firstLog, `${viewport.name}: running-task log data did not refresh`);
        await waitFor(client, `document.querySelector('.task-live-output .log-tail')?.textContent.endsWith('browser refresh ${runtime.logSequence}')`, `${viewport.name}: refreshed task output did not reach the visible panel (${selector})`);
        assert.equal(await client.evaluate(`document.activeElement === window.__taskOutputFocus && document.querySelector(${JSON.stringify(selector)}) === window.__taskOutputFocus`), true, `${viewport.name}: task output refresh replaced or blurred ${selector}`);
        if (selector === tailSelector) assert.equal(await client.evaluate('window.__taskOutputFocus.scrollTop'), 24, 'Refresh moved the scrolled log tail');
      }
    } finally {
      runtime.longTaskOutput = false;
    }
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
    await client.evaluate(`document.querySelector('[data-share-mode="internal"]').focus()`);
    await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
    await client.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
    assert.deepEqual(await client.evaluate(`({focused:document.activeElement?.id,selected:document.querySelector('#share-tab-public')?.getAttribute('aria-selected'),publicVisible:!document.querySelector('#share-panel-public')?.hidden,internalHidden:document.querySelector('#share-panel-internal')?.hidden})`),{focused:'share-tab-public',selected:'true',publicVisible:true,internalHidden:true},`${viewport.name}: Public link tab must activate and receive keyboard focus`);
    await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await client.command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    assert.deepEqual(await client.evaluate(`({focused:document.activeElement?.id,selected:document.querySelector('#share-tab-internal')?.getAttribute('aria-selected'),internalVisible:!document.querySelector('#share-panel-internal')?.hidden,publicHidden:document.querySelector('#share-panel-public')?.hidden})`),{focused:'share-tab-internal',selected:'true',internalVisible:true,publicHidden:true},`${viewport.name}: Client Workspace tab must activate and receive keyboard focus`);
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
    // Johnson stays open too: several projects can be open at once.
    await waitFor(client, "document.querySelector('#project-detail-project-quarry')?.getAttribute('aria-label') === 'Alpha Quarry tasks and actions' && document.querySelectorAll('.project-row.selected').length === 2", `${viewport.name}: terminal project selection failed`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('#project-detail-project-quarry .task-quick-actions > button')].map(button=>button.textContent)`),
      ['View', 'Model report', 'Share'], `${viewport.name}: ready output did not expose focused View, report, and Share shortcuts`);
    await client.evaluate(`document.querySelector('[data-action="toggle-task"][data-id="task-quarry"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"task-settings\"][data-id=\"task-quarry\"]') !== null", `${viewport.name}: ready task tools did not load`);
    await client.evaluate(`document.querySelector('[data-action="task-settings"][data-id="task-quarry"]').click()`);
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
    await client.evaluate(`document.querySelector('[data-action="task-settings"][data-id="task-quarry"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"trash-task\"][data-id=\"task-quarry\"]') !== null", `${viewport.name}: terminal task Delete was not reachable`);
    // An unpublished task goes to the Recycle Bin at once, with Undo instead of a confirmation.
    await client.evaluate(`document.querySelector('[data-action="trash-task"][data-id="task-quarry"]').click()`);
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/tasks/task-quarry');
    assert.equal(await client.evaluate(`Boolean(document.querySelector('.workspace-decision'))`), false, `${viewport.name}: task Delete asked for a confirmation`);
    await waitFor(client, "document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Recycle Bin')", `${viewport.name}: task Delete did not offer Undo`);
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
    assert.match(await client.evaluate(`document.querySelector('.provider-detail').textContent`), /Viewer upload admission2 concurrent task uploads/, `${viewport.name}: Viewer upload limit stays separate from cluster-managed capacity`);
    assert.match(await client.evaluate(`document.querySelector('.provider-detail').textContent`), /coordinator owns its queued and running work/, `${viewport.name}: coordinator queue ownership is explicit`);
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
    await closeDevToolsTarget(client);
  }
}

// ---- Folder drill-down tree, in a real browser against the real folder and move API ----
const TREE_PERMISSIONS=['viewer.projects.read','viewer.projects.write','viewer.datasets.write','viewer.processing.read','viewer.processing.write','viewer.processing.publish'];
const KEY_CODES={ArrowDown:40,ArrowUp:38,ArrowLeft:37,ArrowRight:39,Home:36,End:35,Enter:13,Escape:27,F2:113,F10:121,Delete:46};
async function pressKey(client,name,{shift=false}={}){
  for(const type of ['keyDown','keyUp'])await client.command('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:KEY_CODES[name],nativeVirtualKeyCode:KEY_CODES[name],modifiers:shift?8:0,...(type==='keyDown'&&name==='Enter'?{text:'\r'}:{})});
}
async function until(read,message,timeout=10_000){
  for(const deadline=Date.now()+timeout;Date.now()<deadline;){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(message);
}
const treeRow=key=>`[data-tree-key="${key}"]`;
const focusedTreeKey=client=>client.evaluate(`document.activeElement?.closest('[data-tree-key]')?.dataset.treeKey||null`);
const centreOf=(client,selector)=>client.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return{x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()`);
async function treeScreenshot(client,name){
  const directory=process.env.LTDS_FOLDER_TREE_SCREENSHOTS;
  if(!directory)return;
  mkdirSync(directory,{recursive:true});
  await new Promise(resolve=>setTimeout(resolve,300)); // let menu and row transitions finish
  const shot=await client.command('Page.captureScreenshot',{format:'png'});
  writeFileSync(path.join(directory,name),Buffer.from(shot.data,'base64'));
}
// Two projects on the real processing API; task-johnson (published in the fixture outputs) in
// Johnson Road Survey, task-quarry in Alpha Quarry unless the test puts it beside task-johnson.
async function withTreeBrowser(t,{name,width=1280,height=860,mobile=false,fine=!mobile,quarryInJohnson=false,seed,configure},run){
  const executable=browserPath();if(!executable)return t.skip('Chromium-family browser required');
  const release=await acquireBrowserHarnessLock({root});let server,runtime,origin,profile,browser,client,folderServer,folderDb,folderRoot;
  try{
    const express=require('express'),auth=require('../server/auth'),{openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');
    folderRoot=mkdtempSync(path.join(tmpdir(),`viewer-${name}-api-`));folderDb=openDatabase(path.join(folderRoot,'viewer.sqlite'));
    const repository=new ViewerRepository(folderDb),processing=new ProcessingRepository(folderDb);
    processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:browser-audit',permissions:TREE_PERMISSIONS,displayUnits:'imperial',expiresAt:new Date(Date.now()+180000).toISOString()});
    processing.createProject({id:'project-johnson',displayName:'Johnson Road Survey'});processing.createProject({id:'project-quarry',displayName:'Alpha Quarry'});
    const johnson=processing.createDataset({id:'dataset-johnson',projectId:'project-johnson',displayName:'Source',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});processing.finalizeDataset(johnson.id,[],'a'.repeat(64));
    processing.createTask({id:'task-johnson',projectId:'project-johnson',datasetId:johnson.id,displayName:'Johnson reconstruction'});
    const quarryProject=quarryInJohnson?'project-johnson':'project-quarry';
    const quarry=processing.createDataset({id:'dataset-quarry',projectId:quarryProject,displayName:'Quarry source',rootKey:'datasets',relativePath:'synthetic-quarry',storageMode:'managed'});processing.finalizeDataset(quarry.id,[],'b'.repeat(64));
    processing.createTask({id:'task-quarry',projectId:quarryProject,datasetId:quarry.id,displayName:'Quarry reconstruction'});
    const seeded=(await seed?.(processing))||{};
    const app=express();app.use(express.json());app.use(createProcessingApi({repository,processing,storage:{}}));folderServer=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    ({server,runtime,origin}=await startFixtureServer());runtime.folderProcessing=processing;runtime.folderBackend=`http://127.0.0.1:${folderServer.address().port}`;
    configure?.(runtime);
    profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-browser-'));
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox',...(fine?[FINE_POINTER_SWITCH]:[]),'--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const devTools=await waitForDevTools(profile),target=await createDevToolsTarget(devTools);client=await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');await client.command('Runtime.enable');await client.command('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('ltds-viewer-admin-token',${JSON.stringify(token)});`});
    await client.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile,screenWidth:width,screenHeight:height});
    if(mobile)await client.command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    if(fine)await assertFinePointer(expression=>client.evaluate(expression),name);
    await run({client,runtime,origin,processing,...seeded});
    assert.deepEqual(client.events.filter(event=>event.method==='Runtime.exceptionThrown').map(event=>event.params?.exceptionDetails?.exception?.description),[]);
  }finally{
    if(client)client.close();
    if(browser&&browser.exitCode===null&&browser.signalCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));if(process.platform==='win32')spawnSync('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',timeout:10000});else browser.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);}
    if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}if(folderServer){folderServer.closeAllConnections?.();await new Promise(resolve=>folderServer.close(resolve));}folderDb?.close();if(folderRoot)rmSync(folderRoot,{recursive:true,force:true});try{await removeBrowserProfile(profile,t);}finally{release();}
  }
}
const nestedFolders=processing=>{
  const top=processing.createProjectFolder('project-johnson',{displayName:'Client folder'},'staff');
  const site=processing.createProjectFolder('project-johnson',{displayName:'Site folder',parentId:top.id},'staff');
  return{top,site};
};

test('folder tree opens folders in place, keeps them per user, and is one keyboard tab stop with arrow keys', {timeout:90000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-keys',seed:processing=>{const folders=nestedFolders(processing);processing.moveTaskToFolder('task-johnson',folders.site.id,'staff');return folders;}},async({client,origin,top,site})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
  await waitFor(client,`document.querySelector('${treeRow(`f:${top.id}`)}')?.getAttribute('aria-expanded')==='false'`,'top folder unavailable');
  assert.equal(await client.evaluate(`document.querySelector('#project-list').getAttribute('role')`),'treegrid');
  assert.equal(await client.evaluate(`Boolean(document.querySelector('${treeRow('t:task-johnson')}'))`),false,'a task in a closed folder is hidden');
  assert.equal(await client.evaluate(`document.querySelectorAll('#project-list [tabindex="0"]').length`),1,'the tree is one tab stop');
  assert.match(await client.evaluate(`document.querySelector('${treeRow(`f:${top.id}`)}').textContent`),/Client folder1 task/,'name on the left with a muted count');
  await client.evaluate(`document.querySelector('${treeRow('p:project-johnson')} [data-tree-focus]').focus()`);
  await pressKey(client,'ArrowDown');assert.equal(await focusedTreeKey(client),`f:${top.id}`);
  await pressKey(client,'ArrowRight');
  await waitFor(client,`document.querySelector('${treeRow(`f:${site.id}`)}')?.getAttribute('aria-level')==='3'`,'Right did not open the folder in place');
  assert.equal(await focusedTreeKey(client),`f:${top.id}`,'focus stays on the folder it opened');
  await pressKey(client,'ArrowRight');assert.equal(await focusedTreeKey(client),`f:${site.id}`,'Right enters the first child');
  await pressKey(client,'ArrowRight');
  await waitFor(client,`document.querySelector('${treeRow('t:task-johnson')}')?.getAttribute('aria-level')==='4'`,'the nested task did not appear');
  await pressKey(client,'ArrowDown');assert.equal(await focusedTreeKey(client),'t:task-johnson');
  await pressKey(client,'ArrowRight');
  assert.equal(await client.evaluate(`document.activeElement.closest('.task-quick-actions')!==null&&document.activeElement.textContent==='View'`),true,'Right on a task steps into its buttons');
  await pressKey(client,'ArrowRight');assert.equal(await client.evaluate(`document.activeElement.textContent`),'Model report');
  await pressKey(client,'Escape');assert.equal(await client.evaluate(`document.activeElement.matches('[data-tree-focus]')`),true,'Escape returns to the row');
  await pressKey(client,'ArrowLeft');assert.equal(await focusedTreeKey(client),`f:${site.id}`,'Left goes to the parent');
  await pressKey(client,'ArrowLeft');
  await waitFor(client,`!document.querySelector('${treeRow('t:task-johnson')}')&&document.querySelector('${treeRow(`f:${site.id}`)}').getAttribute('aria-expanded')==='false'`,'Left did not close the folder');
  await pressKey(client,'Home');assert.equal(await focusedTreeKey(client),'p:project-johnson');
  await pressKey(client,'End');assert.equal(await focusedTreeKey(client),'p:project-quarry');
  assert.equal(await client.evaluate(`document.activeElement.tabIndex===0&&document.querySelectorAll('#project-list [tabindex="0"]').length===1`),true,'the tab stop follows focus');
  // Expanded state is saved per user and survives a reload.
  await client.command('Page.reload');
  await waitFor(client,`document.querySelector('${treeRow(`f:${top.id}`)}')?.getAttribute('aria-expanded')==='true'&&document.querySelector('${treeRow(`f:${site.id}`)}')?.getAttribute('aria-expanded')==='false'`,'expanded folders were not restored');
  assert.deepEqual(await client.evaluate(`JSON.parse(localStorage.getItem('ltds-viewer-tree:v1:ops:browser-audit')).folders`),[top.id]);
  // An old ?folder= link still opens that folder.
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson&folder=${site.id}`});
  await waitFor(client,`document.querySelector('${treeRow(`f:${site.id}`)}')?.getAttribute('aria-expanded')==='true'&&Boolean(document.querySelector('${treeRow('t:task-johnson')}'))&&!new URL(location.href).searchParams.has('folder')`,'an old folder link did not open its folder');
}));

test('New folder and Rename happen inline, and an empty folder deletes with Undo', {timeout:90000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-inline',seed:processing=>{const folders=nestedFolders(processing);processing.moveTaskToFolder('task-johnson',folders.site.id,'staff');return folders;}},async({client,runtime,origin,processing,top})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
  await waitFor(client,`Boolean(document.querySelector('${treeRow(`f:${top.id}`)} [data-tree-focus]'))`,'top folder unavailable');
  // New subfolder from the folder's "⋯", opened with Shift+F10, named inline.
  await client.evaluate(`document.querySelector('${treeRow(`f:${top.id}`)} [data-tree-focus]').focus()`);
  await pressKey(client,'F10',{shift:true});
  await waitFor(client,`document.activeElement?.dataset.action==='folder-new'`,'Shift+F10 did not open the folder menu');
  await pressKey(client,'Enter');
  await waitFor(client,`document.activeElement?.matches('.tree-inline-name[data-tree-new-folder="${top.id}"]')&&document.activeElement.value==='New folder'&&document.activeElement.selectionEnd===10`,'the inline New folder row did not take focus');
  let start=runtime.requests.length;
  await client.command('Input.insertText',{text:'Flights'});
  await pressKey(client,'Enter');
  await waitForRequest(runtime,start,'POST','/api/v1/projects/project-johnson/folders');
  const flights=await until(()=>processing.projectFolders('project-johnson').find(folder=>folder.displayName==='Flights'),'the folder was not created');
  assert.equal(flights.parentId,top.id);
  await waitFor(client,`document.activeElement?.closest('[data-tree-key]')?.dataset.treeKey==='f:${flights.id}'`,'focus did not move to the new folder');
  await waitFor(client,`document.querySelector('#workspace-tree-live').textContent.includes('Created folder Flights')`,'the new folder was not announced');
  // F2 renames in place; Escape cancels without a request.
  await pressKey(client,'F2');
  await waitFor(client,`document.activeElement?.matches('.tree-inline-name[data-tree-rename="${flights.id}"]')`,'F2 did not start renaming');
  start=runtime.requests.length;
  await client.command('Input.insertText',{text:'Ignored'});
  await pressKey(client,'Escape');
  await waitFor(client,`!document.querySelector('.tree-inline-name')&&document.activeElement?.closest('[data-tree-key]')?.dataset.treeKey==='f:${flights.id}'`,'Escape did not cancel the rename');
  assert.equal(runtime.requests.slice(start).some(request=>request.method==='PATCH'),false);
  await pressKey(client,'F2');
  await waitFor(client,`document.activeElement?.matches('.tree-inline-name[data-tree-rename="${flights.id}"]')`,'F2 did not start renaming again');
  await client.command('Input.insertText',{text:'Drone flights'});
  await pressKey(client,'Enter');
  await waitFor(client,`document.querySelector('${treeRow(`f:${flights.id}`)} strong')?.textContent==='Drone flights'&&document.activeElement?.closest('[data-tree-key]')?.dataset.treeKey==='f:${flights.id}'`,'the rename did not land on the row');
  assert.equal(processing.projectFolders('project-johnson').find(folder=>folder.id===flights.id).displayName,'Drone flights');
  // An empty folder deletes without a confirmation and comes back with Undo; a folder with tasks cannot be deleted.
  assert.equal(await client.evaluate(`document.querySelector('${treeRow(`f:${top.id}`)} [data-action="folder-delete"]').disabled`),true);
  start=runtime.requests.length;
  await client.evaluate(`(()=>{const menu=document.querySelector('${treeRow(`f:${flights.id}`)} details');menu.open=true;menu.querySelector('[data-action="folder-delete"]').click();})()`);
  await waitForRequest(runtime,start,'DELETE',`/api/v1/projects/project-johnson/folders/${flights.id}`);
  assert.equal(await client.evaluate(`Boolean(document.querySelector('.workspace-decision'))`),false,'folder Delete asked for a confirmation');
  await waitFor(client,`!document.querySelector('${treeRow(`f:${flights.id}`)}')&&document.querySelector('#workspace-folder-undo')?.textContent.includes('Folder deleted')`,'folder Delete did not offer Undo');
  await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
  await waitFor(client,`[...document.querySelectorAll('.folder-tree-row[aria-level="3"] strong')].some(name=>name.textContent==='Drone flights')`,'Undo did not restore the folder');
  assert.ok(processing.projectFolders('project-johnson').some(folder=>folder.displayName==='Drone flights'&&folder.parentId===top.id));
  // The project's "⋯" adds a top-level folder.
  await client.evaluate(`(()=>{const menu=document.querySelector('${treeRow('p:project-johnson')} details');menu.open=true;menu.querySelector('[data-action="folder-create"]').click();})()`);
  await waitFor(client,`document.activeElement?.matches('.tree-inline-name[data-tree-new-folder=""]')`,'project New folder did not open an inline row');
  await client.command('Input.insertText',{text:'Archive'});
  await pressKey(client,'Enter');
  await waitFor(client,`[...document.querySelectorAll('.folder-tree-row[aria-level="2"] strong')].some(name=>name.textContent==='Archive')`,'the top-level folder was not created');
  assert.equal(processing.projectFolders('project-johnson').find(folder=>folder.displayName==='Archive').parentId,null);
}));

test('a real mouse drag of the whole task row: blocked drops, a closed folder opens on hover, auto-scroll, moves with Undo', {timeout:120000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-drag',width:1440,height:640,seed:nestedFolders,configure:runtime=>{runtime.outputs=runtime.outputs.filter(output=>output.taskId!=='task-johnson');}},async({client,runtime,origin,processing,top,site})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
  const task='t:task-johnson',atRoot=`${treeRow(task)}[data-tree-parent="p:project-johnson"]`;
  await waitFor(client,`Boolean(document.querySelector('${atRoot} .task-summary[draggable="true"]'))&&Boolean(document.querySelector('${treeRow(`f:${top.id}`)}'))`,'task and folder unavailable');
  assert.equal(await client.evaluate(`document.querySelector('${treeRow(task)} [data-action="folder-move-task"]')?.closest('.task-quick-actions > button')??null`),null,'no separate Move button on the row');
  await treeScreenshot(client,'desktop-1440-drag-ready.png');
  const startDrag=async selector=>{
    await client.command('Input.setInterceptDrags',{enabled:true});
    const from=await centreOf(client,selector);
    await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x,y:from.y});
    await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:from.x,y:from.y,button:'left',buttons:1,clickCount:1});
    const eventsBefore=client.events.length;
    for(let step=1;step<=6;step++)await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+step*6,y:from.y+step*4,button:'left',buttons:1});
    let intercepted=null;
    for(const deadline=Date.now()+5000;!intercepted&&Date.now()<deadline;){intercepted=client.events.slice(eventsBefore).find(event=>event.method==='Input.dragIntercepted');if(!intercepted)await new Promise(resolve=>setTimeout(resolve,25));}
    assert.ok(intercepted,`the browser started a real drag from ${selector}`);
    return intercepted.params.data;
  };
  const over=async(data,selector)=>{const to=await centreOf(client,selector);for(const type of ['dragEnter','dragOver'])await client.command('Input.dispatchDragEvent',{type,x:to.x,y:to.y,data});return to;};
  const finish=async(data,to)=>{
    await client.command('Input.dispatchDragEvent',{type:'drop',x:to.x,y:to.y,data});
    await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:to.x,y:to.y,button:'left',buttons:0,clickCount:1});
    await client.command('Input.setInterceptDrags',{enabled:false});
  };
  // 1. Drag from the row's image count: no handle needed, the whole row moves.
  let data=await startDrag(`${atRoot} .task-summary-stat`);
  await waitFor(client,`document.body.classList.contains('tree-dragging')`,'the row did not enter the dragging state');
  // The task's current place (its own project's top level) is not a drop target.
  await over(data,treeRow('p:project-johnson'));
  assert.equal(await client.evaluate(`document.querySelector('${treeRow('p:project-johnson')}').classList.contains('folder-drop-active')`),false,'the current location must not accept the drop');
  // Near the bottom edge the page scrolls.
  await client.evaluate(`(()=>{const spacer=document.createElement('div');spacer.id='drag-scroll-spacer';spacer.style.height='1600px';document.querySelector('#workspace-content').append(spacer);window.scrollTo(0,0);})()`);
  for(let step=0;step<6;step++)await client.command('Input.dispatchDragEvent',{type:'dragOver',x:400,y:636,data});
  assert.ok(await client.evaluate('window.scrollY')>0,'a drag near the bottom edge did not scroll');
  // Hovering a closed folder highlights it and opens it after about 700 ms.
  let to=await over(data,treeRow(`f:${top.id}`));
  assert.equal(await client.evaluate(`document.querySelector('${treeRow(`f:${top.id}`)}').classList.contains('folder-drop-active')`),true,'the target folder did not highlight');
  assert.equal(await client.evaluate(`document.querySelector('${treeRow(`f:${top.id}`)}').getAttribute('aria-expanded')`),'false');
  const hoverStart=Date.now();
  for(let ticks=0;ticks<12;ticks++){await client.command('Input.dispatchDragEvent',{type:'dragOver',x:to.x,y:to.y,data});await new Promise(resolve=>setTimeout(resolve,100));}
  await waitFor(client,`document.querySelector('${treeRow(`f:${top.id}`)}').getAttribute('aria-expanded')==='true'&&Boolean(document.querySelector('${treeRow(`f:${site.id}`)}'))`,'hovering did not open the closed folder');
  assert.ok(Date.now()-hoverStart>=600,'the folder opened before the hover delay');
  to=await over(data,treeRow(`f:${site.id}`));
  assert.equal(await client.evaluate(`document.querySelector('${treeRow(`f:${site.id}`)}').classList.contains('folder-drop-active')&&!document.querySelector('${treeRow(`f:${top.id}`)}').classList.contains('folder-drop-active')`),true,'the highlight did not follow the pointer');
  await treeScreenshot(client,'desktop-1440-drag-hover.png');
  let start=runtime.requests.length;
  await armRowChange(client,atRoot,false);
  await finish(data,to);
  await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/folder');
  await waitFor(client,`!document.querySelector('#workspace').hasAttribute('aria-busy')&&!document.querySelector('${atRoot}')`,'the moved row stayed at the top level');
  await assertRowChangeWithin(client,'/api/v1/tasks/task-johnson/folder','drag');
  assert.equal(processing.getTask('task-johnson').folderId,site.id);
  await waitFor(client,`document.querySelector('${treeRow(task)}')?.dataset.treeParent==='f:${site.id}'&&document.querySelector('${treeRow(task)}').getAttribute('aria-level')==='4'`,'the moved row did not appear in its folder');
  assert.equal(await focusedTreeKey(client),task,'focus followed the moved row');
  await waitFor(client,`document.querySelector('#workspace-tree-live').textContent.includes('Moved Johnson reconstruction to Johnson Road Survey / Client folder / Site folder')`,'the move was not announced');
  await waitFor(client,`document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Johnson Road Survey / Client folder / Site folder')`,'the move did not offer Undo');
  await client.evaluate(`document.getElementById('drag-scroll-spacer')?.remove()`);
  await treeScreenshot(client,'desktop-1440-moved-undo.png');
  start=runtime.requests.length;
  await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
  await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/folder');
  await waitFor(client,`Boolean(document.querySelector('${atRoot}'))&&!document.querySelector('#workspace').hasAttribute('aria-busy')`,'Undo did not return the task to the top level');
  assert.equal(processing.getTask('task-johnson').folderId,null);
  // 2. Another project: hover its closed row to open it, drop on its folder; unpublished, so no confirmation.
  const quarryFolder=processing.createProjectFolder('project-quarry',{displayName:'2026 reprocess'},'staff');
  data=await startDrag(`${atRoot} .task-summary-stat`);
  to=await over(data,treeRow('p:project-quarry'));
  for(let ticks=0;ticks<12;ticks++){await client.command('Input.dispatchDragEvent',{type:'dragOver',x:to.x,y:to.y,data});await new Promise(resolve=>setTimeout(resolve,100));}
  await waitFor(client,`document.querySelector('${treeRow('p:project-quarry')}').getAttribute('aria-expanded')==='true'&&Boolean(document.querySelector('${treeRow(`f:${quarryFolder.id}`)}'))`,'hovering did not open the other project and load its folders');
  to=await over(data,treeRow(`f:${quarryFolder.id}`));
  start=runtime.requests.length;
  await finish(data,to);
  await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
  assert.equal(await client.evaluate(`Boolean(document.querySelector('.workspace-decision'))`),false,'an unpublished task moves without a confirmation');
  assert.deepEqual(runtime.requests.slice(start).filter(request=>request.path==='/api/v1/tasks/task-johnson/project').map(request=>request.body),[{projectId:'project-quarry',folderId:quarryFolder.id,expectedProjectId:'project-johnson',expectedFolderId:null,expectedFolderRevision:2,confirmSharingChange:false}]);
  await waitFor(client,`document.querySelector('${treeRow(task)}')?.dataset.treeParent==='f:${quarryFolder.id}'&&!document.querySelector('#workspace').hasAttribute('aria-busy')`,'the task did not appear in the other project');
  assert.equal(processing.getTask('task-johnson').projectId,'project-quarry');
  await waitFor(client,`document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Alpha Quarry')`,'the project move did not offer Undo');
  start=runtime.requests.length;
  await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
  await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
  await waitFor(client,`Boolean(document.querySelector('${atRoot}'))`,'Undo did not bring the task back');
  assert.equal(processing.getTask('task-johnson').projectId,'project-johnson');
}));

test('a published task confirms before a cross-project drop, and Undo asks again', {timeout:90000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-published'},async({client,runtime,origin,processing})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
  await waitFor(client,`Boolean(document.querySelector('[data-folder-drag][data-id="task-johnson"]'))`,'task unavailable');
  const drop=()=>client.evaluate(`(()=>{
    const transfer=new DataTransfer(),row=document.querySelector('[data-folder-drag][data-id="task-johnson"]');
    row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    const target=document.querySelector('${treeRow('p:project-quarry')}');
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    if(!target.classList.contains('folder-drop-active'))throw Error('another project row did not accept the drop');
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  })()`);
  let start=runtime.requests.length;
  await drop();
  await waitFor(client,'Boolean(document.querySelector("dialog.workspace-decision[open]"))','the published move did not ask first');
  assert.equal(await client.evaluate('document.querySelector(".workspace-decision h2").textContent'),'Move published task');
  await client.evaluate(`document.querySelector('.workspace-decision [aria-label="Cancel and close dialog"]').click()`);
  await waitFor(client,'!document.querySelector(".workspace-decision")','Cancel did not close the confirmation');
  assert.equal(runtime.requests.slice(start).some(request=>request.method!=='GET'),false,'cancelling must not move the task');
  await drop();
  await waitFor(client,'Boolean(document.querySelector("dialog.workspace-decision[open]"))','the published move did not ask again');
  await client.evaluate(`document.querySelector('.workspace-decision form button[type="submit"]').click()`);
  await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
  assert.deepEqual(runtime.requests.slice(start).filter(request=>request.path==='/api/v1/tasks/task-johnson/project').map(request=>request.body.confirmSharingChange),[true]);
  await waitFor(client,`document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Alpha Quarry')`,'the move did not offer Undo');
  assert.equal(processing.getTask('task-johnson').projectId,'project-quarry');
  start=runtime.requests.length;
  await confirmAppAction(client,runtime,'#workspace-folder-undo button',{title:'Move published task back'});
  await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
  await until(()=>processing.getTask('task-johnson').projectId==='project-johnson','Undo did not move the task back');
}));

test('several projects stay open together and load their folders only when opened', {timeout:90000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-projects',width:1440,height:900,seed:processing=>{const folders=nestedFolders(processing);processing.createProjectFolder('project-quarry',{displayName:'2026 reprocess'},'staff');return folders;}},async({client,runtime,origin,top})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard`});
  await waitFor(client,`document.querySelectorAll('[data-project-name]').length===2`,'projects unavailable');
  const folderReads=project=>runtime.requests.filter(request=>request.method==='GET'&&request.path===`/api/v1/projects/${project}/folders`).length;
  assert.equal(folderReads('project-johnson')+folderReads('project-quarry'),0,'closed projects load no folders');
  await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-johnson"]').click()`);
  await waitFor(client,`Boolean(document.querySelector('${treeRow(`f:${top.id}`)}'))`,'the first project did not open');
  assert.equal(folderReads('project-quarry'),0);
  await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-quarry"]').click()`);
  await waitFor(client,`document.querySelectorAll('.project-row.selected').length===2&&Boolean(document.querySelector('#project-detail-project-quarry .folder-tree-row'))&&Boolean(document.querySelector('${treeRow(`f:${top.id}`)}'))`,'the second project did not open beside the first');
  assert.equal(folderReads('project-quarry'),1);
  assert.equal(await client.evaluate(`new URL(location.href).searchParams.get('project')`),'project-quarry');
  await client.evaluate(`document.querySelector('[data-action="folder-toggle"][data-id="${top.id}"]').click()`);
  await waitFor(client,`Boolean(document.querySelector('[data-tree-parent="f:${top.id}"]'))`,'the folder did not open');
  await client.command('Page.reload');
  await waitFor(client,`document.querySelectorAll('.project-row.selected').length===2&&Boolean(document.querySelector('[data-tree-parent="f:${top.id}"]'))`,'open projects and folders were not restored');
  await client.evaluate(`window.scrollTo(0,document.querySelector('#project-list').getBoundingClientRect().top+scrollY-80)`);
  await treeScreenshot(client,'desktop-1440-tree.png');
  // Closing one project leaves the other open.
  await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-johnson"]').click()`);
  await waitFor(client,`!document.querySelector('#project-detail-project-johnson')&&Boolean(document.querySelector('#project-detail-project-quarry'))`,'closing one project closed the other');
  await client.evaluate(`(()=>{const menu=document.querySelector('${treeRow('p:project-quarry')} details');menu.open=true;})()`);
  await treeScreenshot(client,'desktop-1440-project-menu.png');
}));

test('Delete moves a task to the Recycle Bin with Undo and no confirmation', {timeout:90000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-delete',width:1440,height:900,quarryInJohnson:true},async({client,runtime,origin})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
  await waitFor(client,`Boolean(document.querySelector('${treeRow('t:task-quarry')}'))&&Boolean(document.querySelector('${treeRow('t:task-johnson')}'))`,'tasks unavailable');
  // Live processing disables Delete; the menu shows Duplicate as a disabled follow-up.
  assert.equal(await client.evaluate(`document.querySelector('${treeRow('t:task-johnson')} [data-action="delete-task"]').disabled`),true);
  assert.equal(await client.evaluate(`document.querySelector('${treeRow('t:task-quarry')} [data-action="duplicate-task"]').title`),'Coming soon');
  await client.evaluate(`(()=>{const menu=document.querySelector('${treeRow('t:task-quarry')} details.task-more-actions');menu.open=true;menu.querySelector('[data-action="delete-task"]').focus();})()`);
  await treeScreenshot(client,'desktop-1440-task-menu.png');
  let start=runtime.requests.length;
  await client.evaluate(`document.querySelector('${treeRow('t:task-quarry')} [data-action="delete-task"]').click()`);
  await waitForRequest(runtime,start,'DELETE','/api/v1/tasks/task-quarry');
  assert.equal(await client.evaluate(`Boolean(document.querySelector('.workspace-decision'))`),false,'Delete asked for a confirmation');
  await waitFor(client,`!document.querySelector('${treeRow('t:task-quarry')}')&&document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Recycle Bin')`,'the deleted row stayed or Undo was not offered');
  assert.equal(await focusedTreeKey(client),'t:task-johnson','focus moved to the neighbouring row');
  await waitFor(client,`document.querySelector('#workspace-tree-live').textContent.includes('Moved Quarry reconstruction to the Recycle Bin')`,'the delete was not announced');
  start=runtime.requests.length;
  await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
  await waitForRequest(runtime,start,'POST','/api/v1/storage/trash/trash-task-task-quarry/restore');
  await waitFor(client,`Boolean(document.querySelector('${treeRow('t:task-quarry')}'))`,'Undo did not restore the task');
  assert.equal(runtime.archivedTasks.has('task-quarry'),false);
  // The Delete key on a focused row does the same.
  await client.evaluate(`document.querySelector('${treeRow('t:task-quarry')} [data-tree-focus]').focus()`);
  start=runtime.requests.length;
  await pressKey(client,'Delete');
  await waitForRequest(runtime,start,'DELETE','/api/v1/tasks/task-quarry');
  await waitFor(client,`!document.querySelector('${treeRow('t:task-quarry')}')`,'the Delete key did not delete the task');
}));

test('on a phone, rows are 44px touch targets, drag is not offered and Move to… opens as a bottom sheet', {timeout:90000,skip:manualFixture}, async t=>withTreeBrowser(t,{name:'tree-phone',width:390,height:844,mobile:true,seed:processing=>{const folders=nestedFolders(processing);processing.moveTaskToFolder('task-quarry',folders.site.id,'staff');return folders;},quarryInJohnson:true},async({client,origin,top,site})=>{
  await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
  await waitFor(client,`Boolean(document.querySelector('${treeRow('t:task-johnson')}'))&&Boolean(document.querySelector('${treeRow(`f:${top.id}`)}'))`,'tree unavailable');
  assert.equal(await client.evaluate(`matchMedia('(pointer: coarse)').matches`),true);
  assert.equal(await client.evaluate(`document.querySelectorAll('[draggable="true"],[data-folder-drag]').length`),0,'drag is not offered on a phone');
  await client.evaluate(`document.querySelector('[data-action="folder-toggle"][data-id="${top.id}"]').click()`);
  await waitFor(client,`Boolean(document.querySelector('${treeRow(`f:${site.id}`)}'))`,'the folder did not open');
  await client.evaluate(`document.querySelector('[data-action="folder-toggle"][data-id="${site.id}"]').click()`);
  await waitFor(client,`Boolean(document.querySelector('${treeRow('t:task-quarry')}'))`,'the nested folder did not open');
  const small=await client.evaluate(`[...document.querySelectorAll('#project-list [data-tree-focus], #project-list .row-actions > button, #project-list .row-actions > details > summary, #project-list .task-quick-actions > button')].filter(element=>element.getClientRects().length).map(element=>[element.dataset.action||element.getAttribute('aria-label')||element.textContent.trim(),Math.round(element.getBoundingClientRect().height),Math.round(element.getBoundingClientRect().width)]).filter(([,height,width])=>height<44||width<44)`);
  assert.deepEqual(small,[],'every row target is at least 44px');
  assert.equal(await client.evaluate(`Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)<=innerWidth`),true,'the tree overflows the phone width');
  await client.evaluate(`window.scrollTo(0,document.querySelector('#project-list').getBoundingClientRect().top+scrollY-120)`);
  await treeScreenshot(client,'phone-390-tree.png');
  // Row menus and Move to… open as bottom sheets.
  await client.evaluate(`(()=>{const menu=document.querySelector('${treeRow('t:task-johnson')} details.task-more-actions');menu.open=true;})()`);
  const menuBox=await client.evaluate(`(()=>{const box=document.querySelector('${treeRow('t:task-johnson')} .project-more-menu').getBoundingClientRect();return{left:Math.round(box.left),right:Math.round(box.right),bottom:Math.round(box.bottom),width:innerWidth,height:innerHeight}})()`);
  assert.ok(menuBox.left<=8&&menuBox.right>=menuBox.width-8&&menuBox.bottom>=menuBox.height-16,`the row menu is not a bottom sheet: ${JSON.stringify(menuBox)}`);
  await treeScreenshot(client,'phone-390-menu.png');
  await client.evaluate(`document.querySelector('${treeRow('t:task-johnson')} [data-action="folder-move-task"]').click()`);
  await waitFor(client,`document.querySelector('#workspace-modal')?.open&&Boolean(document.querySelector('#folder-move-form'))`,'Move to… did not open');
  const sheet=await client.evaluate(`(()=>{const modal=document.querySelector('#workspace-modal'),box=modal.getBoundingClientRect();return{sheet:modal.classList.contains('sheet-modal'),left:Math.round(box.left),width:Math.round(box.width),bottom:Math.round(box.bottom),viewport:innerWidth,height:innerHeight}})()`);
  assert.equal(sheet.sheet,true);
  assert.ok(sheet.left===0&&sheet.width===sheet.viewport&&Math.abs(sheet.bottom-sheet.height)<=1,`Move to… is not a bottom sheet: ${JSON.stringify(sheet)}`);
  await treeScreenshot(client,'phone-390-move-sheet.png');
}));

test('Move to… picks a project, then a folder, and asks before moving a published task in a real browser', {timeout:60000,skip:manualFixture}, async t=>{
  const executable=browserPath();if(!executable)return t.skip('Chromium-family browser required');
  const release=await acquireBrowserHarnessLock({root});let server,runtime,origin,profile,browser,client,folderServer,folderDb,folderRoot;
  try{
    const express=require('express'),auth=require('../server/auth'),{openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');
    folderRoot=mkdtempSync(path.join(tmpdir(),'viewer-move-api-'));folderDb=openDatabase(path.join(folderRoot,'viewer.sqlite'));
    const repository=new ViewerRepository(folderDb),processing=new ProcessingRepository(folderDb);
    processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:browser-audit',permissions:['viewer.projects.read','viewer.projects.write','viewer.datasets.write','viewer.processing.read','viewer.processing.write','viewer.processing.publish'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
    processing.createProject({id:'project-johnson',displayName:'Johnson Road Survey'});processing.createProject({id:'project-quarry',displayName:'Alpha Quarry'});
    const dataset=processing.createDataset({id:'dataset-johnson',projectId:'project-johnson',displayName:'Source',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});processing.finalizeDataset(dataset.id,[],'a'.repeat(64));
    processing.createTask({id:'task-johnson',projectId:'project-johnson',datasetId:dataset.id,displayName:'Johnson reconstruction'});
    processing.createProjectFolder('project-johnson',{displayName:'Client folder'},'staff');
    const quarryFolder=processing.createProjectFolder('project-quarry',{displayName:'2026 reprocess'},'staff');
    const app=express();app.use(express.json());app.use(createProcessingApi({repository,processing,storage:{}}));folderServer=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    ({server,runtime,origin}=await startFixtureServer());runtime.folderProcessing=processing;runtime.folderBackend=`http://127.0.0.1:${folderServer.address().port}`;profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-browser-'));
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const devTools=await waitForDevTools(profile),target=await createDevToolsTarget(devTools);client=await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');await client.command('Runtime.enable');await client.command('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('ltds-viewer-admin-token',${JSON.stringify(token)});`});
    await client.command('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
    await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
    await waitFor(client,`Boolean(document.querySelector('.task-more-actions [data-action="folder-move-task"][data-id="task-johnson"]:not([disabled])'))`,'Move to… menu action unavailable');
    assert.equal(await client.evaluate(`document.querySelector('.task-more-actions [data-action="folder-move-task"][data-id="task-johnson"]').textContent`),'Move to…');
    await client.evaluate(`(()=>{const menu=document.querySelector('[data-project-task="task-johnson"] .task-more-actions');menu.open=true;menu.querySelector('[data-action="folder-move-task"]').click();})()`);
    await waitFor(client,`Boolean(document.querySelector('#folder-move-form select[name="projectId"]'))`,'project picker unavailable');
    assert.deepEqual(await client.evaluate(`[...document.querySelector('#folder-move-form').elements.projectId.options].map(option=>[option.value,option.textContent])`),
      [['project-johnson','Johnson Road Survey (current)'],['project-quarry','Alpha Quarry']]);
    await client.evaluate(`(()=>{const select=document.querySelector('#folder-move-form').elements.projectId;select.value='project-quarry';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(client,`(()=>{const f=document.querySelector('#folder-move-form');return !f.elements.folderId.disabled&&[...f.elements.folderId.options].some(option=>option.value==='${quarryFolder.id}')})()`,'destination project folders unavailable');
    assert.deepEqual(await client.evaluate(`[...document.querySelector('#folder-move-form').elements.folderId.options].map(option=>option.textContent)`),['Project root','2026 reprocess']);
    assert.equal(await client.evaluate(`document.querySelector('[data-move-project-note]').hidden`),false,'the cross-project note is shown');
    // A confirmation given for one destination is cleared when the destination project changes.
    await client.evaluate(`(()=>{const f=document.querySelector('#folder-move-form');f.elements.confirmSharingChange.checked=true;f.elements.projectId.value='project-johnson';f.elements.projectId.dispatchEvent(new Event('change',{bubbles:true}));f.elements.projectId.value='project-quarry';f.elements.projectId.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(client,`!document.querySelector('#folder-move-form').elements.folderId.disabled`,'destination folders did not reload');
    assert.equal(await client.evaluate(`document.querySelector('#folder-move-form').elements.confirmSharingChange.checked`),false,'switching projects clears the sharing confirmation');
    await client.evaluate(`document.querySelector('#folder-move-form').elements.folderId.value='${quarryFolder.id}'`);
    if(process.env.LTDS_MOVE_PICKER_SCREENSHOT){const shot=await client.command('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.LTDS_MOVE_PICKER_SCREENSHOT,Buffer.from(shot.data,'base64'));}
    // The fixture output is published, so the picker requires the sharing confirmation before any request.
    const beforeUnconfirmed=runtime.requests.length;
    await client.evaluate(`document.querySelector('#folder-move-form').requestSubmit()`);
    await waitFor(client,`!document.querySelector('[data-move-folder-status]').hidden`,'sharing confirmation was not requested');
    assert.equal(runtime.requests.slice(beforeUnconfirmed).some(request=>request.path==='/api/v1/tasks/task-johnson/project'),false);
    await client.evaluate(`(()=>{const f=document.querySelector('#folder-move-form');f.elements.confirmSharingChange.checked=true;f.requestSubmit();})()`);
    await waitFor(client,`!document.querySelector('#project-detail-project-johnson [data-project-task="task-johnson"]')&&document.querySelector('[data-tree-key="t:task-johnson"]')?.dataset.treeParent?.startsWith('f:')&&document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Alpha Quarry')`,'task did not leave the source project');
    const before=processing.getTask('task-johnson');
    assert.equal(before.projectId,'project-quarry');assert.equal(before.folderId,quarryFolder.id);assert.equal(processing.getDataset('dataset-johnson').projectId,'project-quarry');
    const moves=runtime.requests.filter(request=>request.path==='/api/v1/tasks/task-johnson/project');
    assert.deepEqual(moves.map(request=>request.body),[{projectId:'project-quarry',folderId:quarryFolder.id,expectedProjectId:'project-johnson',expectedFolderId:null,expectedFolderRevision:0,confirmSharingChange:true}]);
    // The fixture output is published, so Undo asks the same sharing question before it sends a confirmed request.
    const beforeUndo=runtime.requests.length;
    await confirmAppAction(client,runtime,'#workspace-folder-undo button',{title:'Move published task back'});
    await waitFor(client,`Boolean(document.querySelector('[data-tree-key="t:task-johnson"][data-tree-parent="p:project-johnson"]'))`,'Undo did not bring the task back');
    assert.deepEqual(runtime.requests.slice(beforeUndo).filter(request=>request.path==='/api/v1/tasks/task-johnson/project').map(request=>request.body),
      [{projectId:'project-johnson',folderId:null,expectedProjectId:'project-quarry',expectedFolderId:quarryFolder.id,expectedFolderRevision:1,undo:true,confirmSharingChange:true}]);
    assert.equal(processing.getTask('task-johnson').projectId,'project-johnson');assert.equal(processing.getTask('task-johnson').folderId,null);
  }finally{
    if(client)client.close();
    if(browser&&browser.exitCode===null&&browser.signalCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));if(process.platform==='win32')spawnSync('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',timeout:10000});else browser.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);assert.ok(browser.exitCode!==null||browser.signalCode!==null,'owned browser must exit');}
    if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}if(folderServer){folderServer.closeAllConnections?.();await new Promise(resolve=>folderServer.close(resolve));}folderDb?.close();if(folderRoot)rmSync(folderRoot,{recursive:true,force:true});try{await removeBrowserProfile(profile,t);}finally{release();}
  }
});

// While a move or Undo is in flight the user may focus something else; the landing move must leave it there.
test('a delayed move or Undo keeps focus on the control the user chose meanwhile in a real browser', {timeout:60000,skip:manualFixture}, async t=>{
  const executable=browserPath();if(!executable)return t.skip('Chromium-family browser required');
  const release=await acquireBrowserHarnessLock({root});let server,runtime,origin,profile,browser,client,folderServer,folderDb,folderRoot,openGate=null;
  try{
    const express=require('express'),auth=require('../server/auth'),{openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');
    folderRoot=mkdtempSync(path.join(tmpdir(),'viewer-move-held-api-'));folderDb=openDatabase(path.join(folderRoot,'viewer.sqlite'));
    const repository=new ViewerRepository(folderDb),processing=new ProcessingRepository(folderDb);
    processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:browser-audit',permissions:['viewer.projects.read','viewer.projects.write','viewer.datasets.write','viewer.processing.read','viewer.processing.write','viewer.processing.publish'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
    processing.createProject({id:'project-johnson',displayName:'Johnson Road Survey'});processing.createProject({id:'project-quarry',displayName:'Alpha Quarry'});
    const dataset=processing.createDataset({id:'dataset-johnson',projectId:'project-johnson',displayName:'Source',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});processing.finalizeDataset(dataset.id,[],'a'.repeat(64));
    processing.createTask({id:'task-johnson',projectId:'project-johnson',datasetId:dataset.id,displayName:'Johnson reconstruction'});
    // A second task in the same list gives the user another task control to move to.
    const otherDataset=processing.createDataset({id:'dataset-quarry',projectId:'project-johnson',displayName:'Other source',rootKey:'datasets',relativePath:'synthetic-other',storageMode:'managed'});processing.finalizeDataset(otherDataset.id,[],'b'.repeat(64));
    processing.createTask({id:'task-quarry',projectId:'project-johnson',datasetId:otherDataset.id,displayName:'Quarry reconstruction'});
    const folder=processing.createProjectFolder('project-johnson',{displayName:'Client folder'},'staff');
    const app=express();app.use(express.json());app.use(createProcessingApi({repository,processing,storage:{}}));folderServer=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    ({server,runtime,origin}=await startFixtureServer());runtime.folderProcessing=processing;runtime.folderBackend=`http://127.0.0.1:${folderServer.address().port}`;profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-browser-'));
    // Unpublished, so moves across projects and their Undo need no sharing confirmation.
    runtime.outputs=runtime.outputs.filter(output=>output.taskId!=='task-johnson');
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox',FINE_POINTER_SWITCH,'--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const devTools=await waitForDevTools(profile),target=await createDevToolsTarget(devTools);client=await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');await client.command('Runtime.enable');await client.command('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('ltds-viewer-admin-token',${JSON.stringify(token)});`});
    await client.command('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
    await client.command('Page.navigate',{url:`${origin}/workspace?section=dashboard&project=project-johnson`});
    // The moved row at the project's top level; a move into the folder takes it out of that list.
    const moved='[data-tree-key="t:task-johnson"][data-tree-parent="p:project-johnson"]',otherTask='[data-action="toggle-task"][data-id="task-quarry"]',filter='#project-filter';
    await waitFor(client,`Boolean(document.querySelector('${moved}'))&&Boolean(document.querySelector('${otherTask}'))&&Boolean(document.querySelector('[data-tree-key="f:${folder.id}"]'))`,'tasks and folder unavailable');
    const hold=()=>{let open;runtime.taskMoveResponseGate=new Promise(resolve=>{open=resolve;});openGate=()=>{runtime.taskMoveResponseGate=null;openGate=null;open();};};
    const focusOn=async selector=>assert.equal(await client.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.focus();return document.activeElement===element})()`),true,`could not focus ${selector}`);
    const focusedOn=selector=>client.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);
    const land=async(label,rowPresent,pathname)=>{
      await armRowChange(client,moved,rowPresent);
      openGate();
      await waitFor(client,`!document.querySelector('#workspace').hasAttribute('aria-busy')`,`${label}: move did not settle`);
      await waitFor(client,`${rowPresent?'':'!'}document.querySelector('${moved}')`,`${label}: task list did not update`);
      await assertRowChangeWithin(client,pathname,label);
    };
    const folderPath='/api/v1/tasks/task-johnson/folder',projectPath='/api/v1/tasks/task-johnson/project';
    const dragTaskTo=folderId=>client.evaluate(`(()=>{
      const transfer=new DataTransfer(),handle=document.querySelector('[data-folder-drag][data-id="task-johnson"]');
      handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      const target=document.querySelector(${JSON.stringify(`[data-tree-key="f:${folder.id}"]`)});
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    })()`);

    // 1. Folder move: the user moves to another task's control before the response.
    hold();let start=runtime.requests.length;
    await dragTaskTo(folder.id);
    await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/folder');
    await focusOn(otherTask);
    await land('folder move',false,folderPath);
    assert.equal(processing.getTask('task-johnson').folderId,folder.id);
    assert.equal(await focusedOn(otherTask),true,'folder move kept focus on the other task');

    // 2. Folder Undo: the user moves to the project filter before the response.
    await waitFor(client,`Boolean(document.querySelector('#workspace-folder-undo button'))`,'folder Undo unavailable');
    hold();start=runtime.requests.length;
    await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
    await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/folder');
    await focusOn(filter);
    await land('folder Undo',true,folderPath);
    assert.equal(processing.getTask('task-johnson').folderId,null);
    assert.equal(await focusedOn(filter),true,'folder Undo kept focus on the filter');

    // 3. Move to another project: the user closes the dialog and moves to the filter before the response.
    await waitFor(client,`Boolean(document.querySelector('.task-more-actions [data-action="folder-move-task"][data-id="task-johnson"]:not([disabled])'))`,'Move to… unavailable');
    await client.evaluate(`(()=>{const menu=document.querySelector('${moved} .task-more-actions');menu.open=true;menu.querySelector('[data-action="folder-move-task"]').click();})()`);
    await waitFor(client,`Boolean(document.querySelector('#folder-move-form select[name="projectId"]'))`,'project picker unavailable');
    await client.evaluate(`(()=>{const select=document.querySelector('#folder-move-form').elements.projectId;select.value='project-quarry';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(client,`!document.querySelector('#folder-move-form').elements.folderId.disabled`,'destination folders unavailable');
    hold();start=runtime.requests.length;
    await client.evaluate(`document.querySelector('#folder-move-form').requestSubmit()`);
    await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
    await client.evaluate(`document.querySelector('#workspace-modal').close()`);
    await focusOn(filter);
    await client.evaluate(`(()=>{const input=document.querySelector('${filter}');input.value='Jo';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(1,1);})()`);
    await land('project move',false,projectPath);
    assert.equal(processing.getTask('task-johnson').projectId,'project-quarry');
    assert.deepEqual(await client.evaluate(`[document.activeElement.id,document.activeElement.value,document.activeElement.selectionStart]`),['project-filter','Jo',1],'project move kept focus, text and caret in the filter');
    await client.evaluate(`(()=>{const input=document.querySelector('${filter}');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);

    // 4. Undo of the project move: the user moves to another task's control before the response.
    await waitFor(client,`document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Alpha Quarry')`,'project Undo unavailable');
    hold();start=runtime.requests.length;
    await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
    await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
    await focusOn(otherTask);
    await land('project Undo',true,projectPath);
    assert.equal(processing.getTask('task-johnson').projectId,'project-johnson');
    assert.equal(await focusedOn(otherTask),true,'project Undo kept focus on the other task');

    // 5. Nothing held focus and the move removed no focused control: focus stays where it was.
    await client.evaluate(`document.activeElement.blur()`);
    hold();start=runtime.requests.length;
    await dragTaskTo(folder.id);
    await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/folder');
    await land('unfocused move',false,folderPath);
    assert.equal(await client.evaluate(`document.activeElement===document.body`),true,'an unfocused move does not take focus');

    // 6. Undo of a project move while another, expanded task's menu has focus: the render replaces it.
    // The move opened the folder, so the task is visible inside it.
    await waitFor(client,`document.querySelector('[data-tree-key="t:task-johnson"]')?.dataset.treeParent==='f:${folder.id}'&&Boolean(document.querySelector('.task-more-actions [data-action="folder-move-task"][data-id="task-johnson"]:not([disabled])'))`,'Move to… unavailable in the folder');
    await client.evaluate(`(()=>{const menu=document.querySelector('[data-tree-key="t:task-johnson"] .task-more-actions');menu.open=true;menu.querySelector('[data-action="folder-move-task"]').click();})()`);
    await waitFor(client,`Boolean(document.querySelector('#folder-move-form select[name="projectId"]'))`,'project picker unavailable');
    await client.evaluate(`(()=>{const select=document.querySelector('#folder-move-form').elements.projectId;select.value='project-quarry';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(client,`!document.querySelector('#folder-move-form').elements.folderId.disabled`,'destination folders unavailable');
    await client.evaluate(`document.querySelector('#folder-move-form').requestSubmit()`);
    await waitFor(client,`document.querySelector('#workspace-folder-undo')?.textContent.includes('Task moved to Alpha Quarry')&&!document.querySelector('#workspace').hasAttribute('aria-busy')`,'second project move did not settle');
    await waitFor(client,`Boolean(document.querySelector('${otherTask}'))`,'other task unavailable at the top level');
    await client.evaluate(`document.querySelector('${otherTask}').click()`);
    const otherMenu='[data-project-task="task-quarry"] .task-more-actions > summary';
    // Expanding loads the task, repaints and focuses its toggle; let that finish before the user moves on.
    await waitFor(client,`document.querySelector('[data-project-task="task-quarry"]')?.classList.contains('expanded')&&Boolean(document.querySelector('[data-project-task="task-quarry"] .task-facts'))&&document.activeElement===document.querySelector('${otherTask}')&&Boolean(document.querySelector('${otherMenu}'))`,'other task did not finish expanding');
    await client.evaluate(`(()=>{const summary=document.querySelector('${otherMenu}');window.__heldFocus=summary;summary.focus();})()`);
    assert.equal(await client.evaluate(`document.activeElement===window.__heldFocus`),true);
    hold();start=runtime.requests.length;
    await client.evaluate(`document.querySelector('#workspace-folder-undo button').click()`);
    await waitForRequest(runtime,start,'PATCH','/api/v1/tasks/task-johnson/project');
    await land('project Undo with a task menu focused',false,projectPath);
    assert.equal(processing.getTask('task-johnson').projectId,'project-johnson');
    assert.equal(await client.evaluate(`!window.__heldFocus.isConnected&&document.activeElement===document.querySelector('${otherMenu}')`),true,'the re-rendered menu of the same task keeps focus');

    // 7. The shipped focus locator, run in this browser on the shipped disclosure markup: a full
    // render finds the same non-first disclosure again; an unnamed or ambiguous control is never guessed.
    const shipped=readFileSync(path.join(root,'workspace-projects.js'),'utf8');
    const slice=(from,to)=>{const start=shipped.indexOf(from),end=shipped.indexOf(to,start);assert.ok(start>=0&&end>start,`missing ${from}`);return shipped.slice(start,end);};
    const helpers=slice('function disclosureAttributes(','\nfunction bindTaskDisclosures(')+'\n'+slice('function focusLocator(','\n// A move moves focus only');
    const located=await client.evaluate(`(()=>{
      const content=document.createElement('div');document.body.append(content);
      const state={taskDisclosures:{}},esc=value=>String(value).replace(/[&<>"']/g,character=>'&#'+character.charCodeAt(0)+';');
      ${helpers}
      const markup='<article data-project-task="task-quarry"><details class="task-more-actions"><summary>Other</summary></details>'+
        taskDisclosurePanel('task-quarry','settings','Settings','<p>One</p>')+taskDisclosurePanel('task-quarry','history','History','<p>Two</p>')+
        '<button type="button" data-action="same">Same</button><button type="button" data-action="same">Same</button></article>';
      content.innerHTML=markup;
      const disclosure=content.querySelector('[data-task-disclosure="history"] > summary'),generic=content.querySelector('.task-more-actions > summary'),twin=content.querySelector('button');
      const locate=[focusLocator(disclosure),focusLocator(generic),focusLocator(twin)];
      content.innerHTML=markup;
      const found=locate[0]?.();
      const result={disclosure:Boolean(found&&found!==disclosure&&found===content.querySelector('[data-task-disclosure="history"] > summary')),generic:locate[1],twin:locate[2]};
      content.remove();return result;
    })()`);
    assert.deepEqual(located,{disclosure:true,generic:null,twin:null},'disclosures are found by name; unnamed and ambiguous controls are not guessed');
    assert.deepEqual(client.events.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  }finally{
    openGate?.();
    if(client)client.close();
    if(browser&&browser.exitCode===null&&browser.signalCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));if(process.platform==='win32')spawnSync('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',timeout:10000});else browser.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);assert.ok(browser.exitCode!==null||browser.signalCode!==null,'owned browser must exit');}
    if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}if(folderServer){folderServer.closeAllConnections?.();await new Promise(resolve=>folderServer.close(resolve));}folderDb?.close();if(folderRoot)rmSync(folderRoot,{recursive:true,force:true});try{await removeBrowserProfile(profile,t);}finally{release();}
  }
});

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
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        // The whole process tree: a plain kill leaves Edge's browser process running on Windows.
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
        else browser.kill();
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
      const target = await createDevToolsTarget(devTools);
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
        await closeDevToolsTarget(client);
      }
    });
  } finally {
    releaseResponse?.();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
      else browser.kill();
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
      const target = await createDevToolsTarget(devTools);
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
        await closeDevToolsTarget(client);
      }
    });
  } finally {
    try {
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        // The whole process tree: a plain kill leaves Edge's browser process running on Windows.
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
        else browser.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
      }
    } finally { releaseBrowserLock(); }
    if (server) await new Promise(resolve => server.close(resolve));
    await removeBrowserProfile(profile, t);
  }
});

test('recovery UI keeps one request identity across an uncertain response in a real browser', {timeout:60000,skip:manualFixture}, async t=>{
 const executable=browserPath();if(!executable)return t.skip('Chromium-family browser required');
 const release=await acquireBrowserHarnessLock({root});let server,runtime,origin,profile,browser,client;
 try{
  ({server,runtime,origin}=await startFixtureServer());runtime.testIngestRecovery=true;profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-browser-'));
  browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const devTools=await waitForDevTools(profile),target=await createDevToolsTarget(devTools);client=await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.command('Page.enable');await client.command('Runtime.enable');await client.command('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('ltds-viewer-admin-token',${JSON.stringify(token)});`});
  await client.command('Page.navigate',{url:`${origin}/workspace?section=diagnostics`});
  await waitFor(client,`Boolean(document.querySelector('[data-diagnostic-attempt-id="attempt-johnson-old"] [data-action="open-global-attempt-diagnostics"]'))`,'diagnostic row unavailable');
  await client.evaluate(`document.querySelector('[data-diagnostic-attempt-id="attempt-johnson-old"] [data-action="open-global-attempt-diagnostics"]').click()`);
  await waitFor(client,`Boolean(document.querySelector('[data-action="recover-existing-result"]'))`,'eligible recovery action unavailable');
  assert.equal(runtime.requests.filter(r=>r.method==='POST').length,0,'loading never starts recovery');
  await client.evaluate(`(()=>{const b=document.querySelector('[data-action="recover-existing-result"]');b.click();b.click()})()`);
  await waitFor(client,`Boolean(document.querySelector('[data-action="recover-existing-result"]')) && !document.querySelector('#workspace').hasAttribute('aria-busy')`,'diagnostics did not refresh after uncertain response');
  assert.equal(runtime.requests.filter(r=>r.path.endsWith('/recover-ingest')).length,1,'concurrent click sent only one request');
  await client.evaluate(`document.querySelector('[data-action="recover-existing-result"]').click()`);
  await waitFor(client,`!document.querySelector('[data-action="recover-existing-result"]') && !document.querySelector('#workspace').hasAttribute('aria-busy')`,'accepted recovery did not clear action');
  const requests=runtime.requests.filter(r=>r.path.endsWith('/recover-ingest'));assert.equal(requests.length,2);assert.ok(requests[0].idempotencyKey);assert.equal(requests[1].idempotencyKey,requests[0].idempotencyKey);
  assert.deepEqual(runtime.requests.filter(r=>r.method==='POST'&&!r.path.endsWith('/recover-ingest')),[],'no provider restart or unrelated mutation');
 }finally{
  if(client)client.close();
  if(browser&&browser.exitCode===null&&browser.signalCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));if(process.platform==='win32')spawnSync('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',timeout:10000});else browser.kill();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);assert.ok(browser.exitCode!==null||browser.signalCode!==null,'owned browser must exit');}
  if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}try{await removeBrowserProfile(profile,t);}finally{release();}
 }
});
