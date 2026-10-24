import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

// Opt in deliberately: ordinary Linux/unit runs do not import Playwright or
// require Edge. An opted-in run fails if the build/browser is unavailable.
// Run after npm run build in apps/viewer:
// $env:LTDS_DIRECT_SHARE_BROWSER='true'; node --test test/workspace-direct-client-browser.test.mjs
const enabled = process.env.LTDS_DIRECT_SHARE_BROWSER === 'true';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECT = '/api/v1/workspace/direct-client-grants';
const TOKEN = 'synthetic_direct_share_browser_token_000000000000000000';
const PROJECT = '00000000-0000-4000-8000-000000000001';
const TASKS = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
const CLIENT = { sourceId: 'project-alpha:primary', workspaceId: 'synthetic-client-workspace', displayName: 'Synthetic recipient', businessName: 'Ledge Top Drone Services' };
const permissions = ['viewer.projects.read', 'viewer.datasets.read', 'viewer.processing.read', 'viewer.shares.read', 'viewer.client_grants.manage'];
const grantKeys = ['sourceId', 'workspaceId', 'viewerProjectId', 'taskId', 'scopeType', 'includeFuturePublished', 'permissions', 'expiresAt', 'confirmedScope'].sort();
async function capture(page, name) {
  const directory = process.env.LTDS_DIRECT_SHARE_SCREENSHOTS_DIR;
  if (!directory) return;
  assert.ok(path.isAbsolute(directory), 'Screenshot output must be an explicit absolute directory');
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: false });
}

async function fixture(t, { failSecondTaskOnce = false } = {}) {
  const built = realpathSync(path.join(root, 'dist'));
  assert.ok(existsSync(path.join(built, 'workspace.html')), 'Build Viewer before opting into browser acceptance');
  const requests = [], grants = [], receipts = new Map(), forbidden = [];
  let failedSecond = false;
  const project = { id: PROJECT, displayName: 'Synthetic property mapping', description: 'Local synthetic browser acceptance only', status: 'active' };
  const tasks = TASKS.map((id, index) => ({ id, projectId: PROJECT, datasetId: `dataset-${index}`, displayName: index ? 'South field' : 'North field',
    status: 'published', createdAt: `2026-01-0${index + 1}T12:00:00.000Z`, metrics: { sourceImageCount: 3 }, latestAttempt: { id: `attempt-${index}`, status: 'published', attemptNumber: 1 } }));
  const outputs = tasks.map((task, index) => ({ id: `output-${index}`, taskId: task.id, projectId: PROJECT, modelId: `model-${index}`,
    displayName: task.displayName, status: 'published', activePublished: true, byteSize: 1024, assetCount: 1, assetKinds: ['glb'] }));
  function api(url, method, body, key) {
    const current = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, key }; requests.push(current);
    if (method !== 'GET' && !url.pathname.startsWith(DIRECT)) {
      forbidden.push(current); return [405, { error: 'Synthetic fixture forbids unrelated mutations' }];
    }
    if (url.pathname === DIRECT && method === 'GET') return [200, { clients: [CLIENT], clientsNextCursor: null, grants: grants.filter(grant => !grant.revokedAt) }];
    if (url.pathname === DIRECT && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), grantKeys, 'UI must use direct client authority, without a PA/business project');
      assert.equal(body.sourceId, CLIENT.sourceId); assert.equal(body.workspaceId, CLIENT.workspaceId); assert.equal(body.viewerProjectId, PROJECT);
      assert.equal(body.confirmedScope, true); assert.match(key || '', /^[A-Za-z0-9._:-]{16,128}$/);
      assert.deepEqual(body.permissions, { measure: true, cameras: false, download: false });
      assert.equal(body.expiresAt, null);
      if (body.scopeType === 'project') { assert.equal(body.taskId, null); assert.equal(body.includeFuturePublished, true); }
      else { assert.equal(body.scopeType, 'task'); assert.ok(TASKS.includes(body.taskId)); assert.equal(body.includeFuturePublished, false); }
      if (receipts.has(key)) {
        const receipt = receipts.get(key); assert.deepEqual(receipt.input, body, 'A retry key must retain the same exact scope');
        return [200, { grant: receipt.grant, replayed: true }];
      }
      if (failSecondTaskOnce && body.taskId === TASKS[1] && !failedSecond) {
        failedSecond = true; return [503, { error: 'Synthetic transient second-task failure', code: 'fixture_transient' }];
      }
      const { confirmedScope: _consent, ...scope } = body;
      const grant = { ...scope, grantId: `synthetic-grant-${grants.length + 1}`, grantVersion: 1, revokedAt: null,
        clientDisplayName: CLIENT.displayName, createdAt: new Date().toISOString() };
      grants.push(grant); receipts.set(key, { input: body, grant });
      return [201, { grant, replayed: false }];
    }
    if (url.pathname.startsWith(DIRECT + '/') && method === 'DELETE') {
      const grant = grants.find(item => item.grantId === url.pathname.slice(DIRECT.length + 1));
      assert.ok(grant); assert.equal(body.reason, 'Synthetic acceptance cleanup'); assert.ok(key);
      grant.revokedAt = new Date().toISOString();
      return [202, { success: true, replayed: false, sessionRevocation: { pending: true } }];
    }
    if (url.pathname === '/api/v1/admin-sessions/current') return [200, { controllerOrigin: 'https://ops.example.test', session: {
      id: 'synthetic-browser-session', subject: 'ops:synthetic-owner', permissions, displayUnits: 'imperial', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }];
    if (url.pathname === '/api/v1/projects') return [200, { projects: [project], nextCursor: null }];
    if (url.pathname === '/api/v1/datasets') return [200, { datasets: tasks.map(task => ({ id: task.datasetId, projectId: PROJECT, displayName: 'Synthetic source', status: 'finalized', fileCount: 3, byteSize: 1024 })), nextCursor: null }];
    if (url.pathname === '/api/v1/tasks') return [200, { tasks, nextCursor: null }];
    if (url.pathname === '/api/v1/processing/outputs') return [200, { outputs, nextCursor: null }];
    if (url.pathname === '/api/v1/processing/providers') return [200, { providers: [], nextCursor: null }];
    if (url.pathname === '/api/v1/processing/presets') return [200, { presets: [] }];
    if (url.pathname === '/api/v1/processing/ready') return [200, { ok: true }];
    if (url.pathname === '/api/v1/workspace/client-grants') return [200, { projects: [], associations: [], grants: [] }];
    if (url.pathname === '/api/v1/workspace/native-client-grants') return [200, { targets: [], grants: [] }];
    if (url.pathname.endsWith('/shares')) return [200, { shares: [], publicationRequired: false, existingAccessUpdateRequired: false, availableViews: ['model3d'] }];
    if (url.pathname.endsWith('/public-shares')) return [200, { shares: [] }];
    if (url.pathname === '/api/v1/operations') return [200, { operations: [], nextCursor: null }];
    if (url.pathname === '/api/v1/processing/derivatives') return [200, { derivatives: [], nextCursor: null }];
    if (url.pathname === '/api/v1/diagnostics/runs') return [200, { runs: [], nextCursor: null }];
    if (url.pathname === '/api/v1/storage') return [200, { storage: {}, trash: { items: [], nextCursor: null }, usage: { filesystems: [] } }];
    if (url.pathname === '/api/v1/storage/usage') return [200, { usage: { filesystems: [] } }];
    errors.push(new Error(`Unimplemented synthetic fixture API: ${method} ${url.pathname}`));
    return [404, { error: 'Unimplemented synthetic fixture API', path: url.pathname }];
  }
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Synthetic identity required"}'); }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 32_768) throw new Error('Fixture body too large'); chunks.push(chunk); }
        const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : {};
        const [status, payload] = api(url, req.method, body, req.headers['idempotency-key']);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(payload));
      }
      const relative = url.pathname === '/workspace' ? 'workspace.html' : decodeURIComponent(url.pathname.slice(1));
      const candidate = path.resolve(built, relative);
      if (!candidate.startsWith(built + path.sep) || !existsSync(candidate)) { res.writeHead(404); return res.end(); }
      const resolved = realpathSync(candidate);
      if (!resolved.startsWith(built + path.sep) || !statSync(resolved).isFile()) { res.writeHead(404); return res.end(); }
      const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' })[path.extname(resolved)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(readFileSync(resolved));
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Synthetic fixture assertion failed"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, grants, forbidden, errors };
}

async function openWorkspace(t, browser, state, viewport = { width: 1366, height: 1000 }) {
  const context = await browser.newContext({ viewport }); t.after(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === state.origin ? route.continue() : route.abort());
  await context.addInitScript(({ token }) => sessionStorage.setItem('ltds-viewer-admin-token', token), { token: TOKEN });
  const page = await context.newPage(), pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${state.origin}/workspace?project=${PROJECT}`, { waitUntil: 'networkidle' });
  await page.locator(`[data-action="project-share"][data-id="${PROJECT}"]`).waitFor({ state: 'visible' });
  return { page, pageErrors };
}
async function openShare(page, outputId = null) {
  await page.locator(outputId ? `[data-action="share-output"][data-id="${outputId}"]` : `[data-action="project-share"][data-id="${PROJECT}"]`).click();
  const form = page.locator('#direct-client-grant-form'); await form.waitFor({ state: 'visible' });
  assert.equal(await form.getByRole('checkbox', { name: /^Camera positions/ }).isChecked(), false,
    'New direct shares must keep photo locations off until explicitly selected');
  await form.locator('select[name="client"]').selectOption(JSON.stringify([CLIENT.sourceId, CLIENT.workspaceId]));
  return form;
}
function assertNoUnrelatedWrites(state, pageErrors) {
  assert.deepEqual(state.errors.map(error => error.message), []);
  assert.deepEqual(state.forbidden, [], 'Direct sharing must not create PA/business projects, model associations or public links');
  assert.deepEqual(pageErrors, [], 'The compiled production workspace must run without browser exceptions');
}

test('built Viewer shares directly to clients through the real Edge UI', { skip: !enabled, timeout: 120_000 }, async t => {
  assert.equal(process.platform, 'win32', 'This opt-in acceptance test requires Windows Edge');
  const operationsRequire = createRequire(path.resolve(root, '../operations/package.json'));
  const { chromium } = operationsRequire('playwright');
  const edge = process.env.LTDS_EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  assert.ok(existsSync(edge), `Microsoft Edge executable unavailable: ${edge}`);
  const release = await acquireBrowserHarnessLock({ root }); let browser;
  t.after(async () => { try { await browser?.close(); } finally { release(); } });
  browser = await chromium.launch({ executablePath: edge, headless: true, args: ['--disable-gpu', '--no-first-run'] });

  await t.test('whole project needs explicit future-task consent; pending revoke stays honest', async child => {
    const state = await fixture(child), { page, pageErrors } = await openWorkspace(child, browser, state), form = await openShare(page);
    const consent = form.locator('[name="confirmedScope"]'); assert.equal(await consent.isChecked(), false);
    assert.equal(await consent.getAttribute('required'), '');
    assert.match(await form.locator('[data-direct-summary]').innerText(), /every published task.*including tasks published later/);
    await capture(page, 'viewer-direct-share-desktop.png');
    await form.getByRole('button', { name: 'Share with client', exact: true }).click();
    assert.equal(state.requests.filter(req => req.method === 'POST').length, 0, 'Missing explicit consent must not send a grant');
    await consent.check(); await form.getByRole('button', { name: 'Share with client', exact: true }).click();
    await page.locator('[data-action="revoke-direct-client-grant"]').waitFor();
    const posts = state.requests.filter(req => req.method === 'POST'); assert.equal(posts.length, 1);
    assert.equal(posts[0].body.scopeType, 'project'); assert.equal(posts[0].body.includeFuturePublished, true); assert.equal(posts[0].body.taskId, null);
    await page.locator('[data-action="revoke-direct-client-grant"]').click();
    const decision = page.getByRole('dialog', { name: 'Revoke client access', exact: true });
    await decision.getByLabel('Reason for revoking this client access').fill('Synthetic acceptance cleanup');
    await decision.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#workspace-toast')?.textContent.includes('Revocation of existing sessions is pending'));
    assert.equal(state.requests.filter(req => req.method === 'DELETE').length, 1);
    assert.equal(await page.locator('[data-action="revoke-direct-client-grant"]').count(), 0);
    assertNoUnrelatedWrites(state, pageErrors);
  });

  await t.test('task Share grants one exact task and remains usable on a narrow screen', async child => {
    const state = await fixture(child), { page, pageErrors } = await openWorkspace(child, browser, state, { width: 390, height: 844 });
    const form = await openShare(page, 'output-0');
    assert.equal(await form.locator('[name="scope"][value="tasks"]').isChecked(), true);
    assert.equal(await form.locator(`[name="taskId"][value="${TASKS[0]}"]`).isChecked(), true);
    assert.equal(await form.locator(`[name="taskId"][value="${TASKS[1]}"]`).isChecked(), false);
    assert.match(await form.locator('[data-direct-summary]').innerText(), /only “North field”.*Other tasks.*stay hidden/);
    await capture(page, 'viewer-direct-share-mobile.png');
    await form.locator('[name="confirmedScope"]').check(); await form.getByRole('button', { name: 'Share with client', exact: true }).click();
    await page.locator('[data-action="revoke-direct-client-grant"]').waitFor();
    const posts = state.requests.filter(req => req.method === 'POST'); assert.equal(posts.length, 1);
    assert.equal(posts[0].body.taskId, TASKS[0]); assert.equal(posts[0].body.scopeType, 'task'); assert.equal(posts[0].body.includeFuturePublished, false);
    const layout = await page.evaluate(() => { const dialog=document.querySelector('#workspace-modal'),bounds=dialog.getBoundingClientRect();return {
      viewport:innerWidth,document:document.documentElement.scrollWidth,dialog:dialog.clientWidth,content:dialog.scrollWidth,
      top:bounds.top,bottom:bounds.bottom,height:innerHeight};});
    assert.ok(layout.document <= layout.viewport + 1, `Mobile document overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.content <= layout.dialog + 1, `Mobile sharing dialog overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.top>=0&&layout.bottom<=layout.height+1, `Mobile sharing dialog must fit the viewport: ${JSON.stringify(layout)}`);
    assertNoUnrelatedWrites(state, pageErrors);
  });

  await t.test('a partial multi-task failure retries with stable exact-scope keys', async child => {
    const state = await fixture(child, { failSecondTaskOnce: true }), { page, pageErrors } = await openWorkspace(child, browser, state), form = await openShare(page);
    await form.locator('[name="scope"][value="tasks"]').check();
    for (const taskId of TASKS) await form.locator(`[name="taskId"][value="${taskId}"]`).check();
    await form.locator('[name="confirmedScope"]').check(); await form.getByRole('button', { name: 'Share with client', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-direct-summary]')?.textContent.includes('Shared 1 of 2'));
    assert.equal(state.grants.length, 1);
    await form.getByRole('button', { name: 'Share with client', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-action="revoke-direct-client-grant"]').length === 2);
    assert.equal(state.grants.length, 2, 'Replaying the first successful task must not create another grant');
    for (const taskId of TASKS) {
      const attempts = state.requests.filter(req => req.method === 'POST' && req.body.taskId === taskId);
      assert.equal(attempts.length, 2); assert.equal(new Set(attempts.map(req => req.key)).size, 1);
      assert.deepEqual(attempts[0].body, attempts[1].body);
    }
    assertNoUnrelatedWrites(state, pageErrors);
  });
});
