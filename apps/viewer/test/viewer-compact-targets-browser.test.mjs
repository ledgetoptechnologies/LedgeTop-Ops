import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp } from './bounded-test-cdp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { FINE_POINTER_SWITCH, assertFinePointer } from './fine-pointer.mjs';

// Compact density keeps 32px controls only for a desktop fine pointer. Narrow
// viewports and coarse pointers must get 44px targets. Both pages use the
// shipped CSS (index.html <style>, and the workspace sheets in the bundle's
// order) with static markup: no WebGL, session or API is involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const binary = () => [process.env.CHROME_PATH, process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);

const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
const modelCss = indexHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
// measurement-workspace.css is imported by a module, so the bundle links it after the inline style.
const measurementCss = readFileSync(path.join(root, 'measurement-workspace.css'), 'utf8');
const modelMarkup = indexHtml.match(/<div id="app">[\s\S]*?<div id="viewer-wrap">/)[0] + '</div></div></div>';
const modelPageWith = css => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>${measurementCss}</style>${modelMarkup}<script>document.querySelector('#panel-property-lines').hidden=false;</script>`;
const modelPage = modelPageWith(modelCss);
// Probe: the compact tool grid gap rule must be the one in effect on every tool grid,
// the measurement tools included, so changing it must move them all.
const gapRule = '.tool-grid { gap: 6px; }';
assert.ok(modelCss.includes(gapRule), 'index.html keeps the compact tool grid gap rule');
const gapProbePage = modelPageWith(modelCss.replace(gapRule, '.tool-grid { gap: 5px; }'));

const workspaceHtml = readFileSync(path.join(root, 'workspace.html'), 'utf8');
const workspaceSheets = [...workspaceHtml.matchAll(/<link rel="stylesheet" href="\/([a-z-]+\.css)">/g)].map(match => match[1]);
// workspace-task-workflow.css is imported by a module, so the bundle places it last.
const workspaceCss = [...workspaceSheets, 'workspace-task-workflow.css'].map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');
const workspacePage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${workspaceCss}</style>
<div id="workspace" class="workspace-shell"><aside class="workspace-nav"><nav><div class="nav-group"><button class="nav-link active" data-t="nav-link"><span class="nav-label">Dashboard</span></button></div></nav><button class="nav-collapse" data-t="nav-collapse"><span class="nav-label">Collapse sidebar</span></button></aside>
<main class="workspace-main"><header class="workspace-header"><button class="icon-button" data-t="nav-toggle">&#9776;</button><div><h1>Dashboard</h1></div><div class="workspace-actions"><button class="secondary-button background-work-indicator" data-t="background-button"><span aria-hidden="true">&#8635;</span><span>Background</span><strong>0</strong></button><button class="secondary-button" data-t="secondary-button">Refresh</button><button class="primary-button" data-t="primary-button">New project</button></div></header>
<section id="workspace-content">
<div class="project-search"><input data-t="project-search" placeholder="Search projects"></div>
<div class="project-list"><div class="project-row"><button class="project-open" data-t="project-open"><span class="project-name"><strong>Road survey</strong></span></button></div></div>
<div class="task-list"><div class="task-panel"><div class="task-summary"><button class="task-summary-toggle" data-t="task-summary-toggle"><span class="task-summary-name"><strong>Reconstruction</strong></span></button><div class="task-quick-actions"><button class="primary-button" data-t="quick-view">View</button><button class="secondary-button" data-t="quick-share">Share</button><details class="project-more-actions task-more-actions" open><summary data-t="more-summary">&hellip;</summary><div class="project-more-menu"><button data-t="more-menu-button">Rename</button></div></details></div></div></div></div>
<details class="task-disclosure"><summary data-t="task-disclosure"><span>Details</span></summary></details>
<div class="quick-actions"><button class="quick-action" data-t="quick-action">Open</button></div>
<div class="import-choice"><button class="import-tab" data-t="import-tab">Server</button></div>
<details class="share-legacy"><summary data-t="share-legacy">Share through an Operations project instead</summary></details>
<form class="manage-form"><label>Name<input data-t="manage-input"></label><select data-t="manage-select"><option>One</option></select></form>
<dialog class="workspace-modal" open style="position:static"><div class="modal-heading"><div><h2>Share</h2></div><button class="icon-button modal-close" data-t="modal-close">&times;</button></div></dialog>
</section></main></div>`;

function serve(request, response) {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const body = pathname === '/model' ? modelPage : pathname === '/model-gap-probe' ? gapProbePage : pathname === '/workspace' ? workspacePage : null;
  if (!body) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(body);
}

const modes = [
  { name: 'desktop fine pointer', width: 1440, height: 900, mobile: false, touch: false, minimum: 32, compact: true },
  { name: '390px phone', width: 390, height: 844, mobile: true, touch: false, minimum: 44, compact: false },
  { name: 'wide coarse pointer', width: 1440, height: 900, mobile: false, touch: true, minimum: 44, compact: false },
];
const modelTargets = ['.tab-btn', '#tool-distance', '#layer-cameras', '#layer-property-lines'];

test('compact Viewer targets are 32px on a desktop fine pointer and 44px on phones and coarse pointers', { timeout: 90_000 }, async t => {
  const executable = binary();
  if (!executable) { t.skip('Chromium-family browser required for target-size checks.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, profile, server;
  try {
    server = createServer(serve); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-targets-'));
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', FINE_POINTER_SWITCH, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await BoundedTestCdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    const evaluate = async expression => { const result = await client.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    const open = async (mode, page) => {
      await client.command('Emulation.setDeviceMetricsOverride', { width: mode.width, height: mode.height, deviceScaleFactor: 1, mobile: mode.mobile });
      await client.command('Emulation.setTouchEmulationEnabled', mode.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await client.command('Page.navigate', { url: `${origin}/${page}?w=${mode.width}&touch=${mode.touch}` });
      const until = Date.now() + 8000;
      while (Date.now() < until) { if (await evaluate(`location.pathname==='/${page}'&&document.readyState==='complete'`)) break; await delay(25); }
      assert.equal(await evaluate(`matchMedia('(pointer: coarse)').matches`), mode.touch, `${mode.name}: pointer emulation`);
      if (!mode.touch) await assertFinePointer(evaluate, mode.name);
    };
    const measure = selectors => evaluate(`(${JSON.stringify(selectors)}).flatMap(selector=>[...document.querySelectorAll(selector)].filter(element=>element.getClientRects().length).map(element=>{const r=element.getBoundingClientRect();return {target:element.dataset.t||element.id||selector,width:r.width,height:r.height};}))`);

    const toolGridGaps = `[...document.querySelectorAll('.tool-grid')].filter(grid=>grid.getClientRects().length).map(grid=>({panel:grid.closest('.panel')?.id,gap:getComputedStyle(grid).gap}))`;

    for (const mode of modes) await t.test(`${mode.name}: model viewer controls`, async () => {
      await open(mode, 'model');
      const sizes = await measure(modelTargets);
      assert.ok(sizes.length >= 8, JSON.stringify(sizes));
      for (const size of sizes) assert.ok(size.height >= mode.minimum - 0.5, `${mode.name}: ${size.target} is ${size.height}px, below ${mode.minimum}px`);
      if (mode.compact) for (const size of sizes) assert.ok(size.height < 36, `${mode.name}: ${size.target} is not compact (${size.height}px)`);
      const header = await evaluate(`(()=>{const h=document.querySelector('#topbar').getBoundingClientRect(),n=document.querySelector('#view-tabs').getBoundingClientRect();return {height:h.height,bottom:h.bottom,tabsBottom:n.bottom,tabsTop:n.top,top:h.top};})()`);
      assert.ok(header.tabsTop >= header.top && header.tabsBottom <= header.bottom, `${mode.name}: mode tabs fit inside the top bar ${JSON.stringify(header)}`);
      if (mode.width > 1024) assert.equal(header.height, mode.touch ? 60 : 52, `${mode.name}: top bar height`);
      const gaps = await evaluate(toolGridGaps);
      assert.ok(gaps.some(grid => grid.panel === 'panel-measure'), JSON.stringify(gaps));
      for (const grid of gaps) assert.equal(grid.gap, '6px', `${mode.name}: ${grid.panel} tool grid gap`);
    });

    await t.test('the compact tool grid gap rule sets every tool grid, measurement tools included', async () => {
      await open(modes[0], 'model-gap-probe');
      const gaps = await evaluate(toolGridGaps);
      assert.ok(gaps.length >= 4, JSON.stringify(gaps));
      for (const grid of gaps) assert.equal(grid.gap, '5px', `${grid.panel} tool grid does not follow the compact gap rule`);
    });

    for (const mode of modes) await t.test(`${mode.name}: workspace controls`, async () => {
      await open(mode, 'workspace');
      const sizes = await measure(['[data-t]']);
      const expected = ['nav-link', 'background-button', 'secondary-button', 'primary-button', 'project-search', 'project-open', 'task-summary-toggle', 'quick-view', 'quick-share', 'more-summary', 'more-menu-button', 'task-disclosure', 'quick-action', 'import-tab', 'share-legacy', 'manage-input', 'manage-select', 'modal-close'];
      if (mode.width > 720) expected.push('nav-collapse');
      if (mode.width <= 720) expected.push('nav-toggle');
      for (const target of expected) assert.ok(sizes.some(size => size.target === target), `${mode.name}: ${target} is not visible`);
      for (const size of sizes) assert.ok(size.height >= mode.minimum - 0.5, `${mode.name}: ${size.target} is ${size.height}px, below ${mode.minimum}px`);
      if (!mode.compact) for (const target of ['more-summary', 'modal-close']) assert.ok(sizes.find(size => size.target === target).width >= 43.5, `${mode.name}: ${target} is narrower than 44px`);
      if (mode.compact) for (const target of ['primary-button', 'secondary-button', 'quick-view']) assert.ok(sizes.find(size => size.target === target).height < 36, `${mode.name}: ${target} is not compact`);
      // Header buttons share one stretched row, so the Background count badge must not make it taller than 32px.
      if (mode.compact) for (const target of ['background-button', 'secondary-button', 'primary-button']) assert.equal(sizes.find(size => size.target === target).height, 32, `${mode.name}: ${target} header button height`);
    });
  } finally {
    client?.close();
    if (browser) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await Promise.race([exited, delay(3000)]); }
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    unlock();
    if (profile) { const absolute = path.resolve(profile); assert.ok(absolute.startsWith(path.resolve(tmpdir(), 'ltds-viewer-targets-'))); try { rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error; } }
  }
});
