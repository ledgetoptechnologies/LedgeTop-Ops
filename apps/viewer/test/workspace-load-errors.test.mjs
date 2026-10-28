import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { loadHierarchy } from '../workspace-hierarchy.mjs';

const source = await readFile(new URL('../workspace-projects.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const line = name => {
  const found = source.split('\n').find(text => text.startsWith(name));
  assert.ok(found, `missing one-line declaration ${name}`);
  return found;
};

function harness({ failing = new Set(), previous = {}, onHierarchy = null, routes = {} } = {}) {
  const fixtures = {
    '/api/v1/projects': { projects: [{ id: 'fresh-project' }] },
    '/api/v1/datasets': { datasets: [] },
    '/api/v1/tasks': { tasks: [{ id: 'fresh-task' }] },
    '/api/v1/processing/providers?limit=100': { providers: [{ id: 'fresh-node' }] },
    '/api/v1/processing/outputs': { outputs: [] },
    '/api/v1/processing/ready': { ok: true },
    '/api/v1/operations': { operations: [{ id: 'fresh-operation' }] },
    '/api/v1/processing/derivatives': { derivatives: [{ id: 'fresh-derivative' }] },
    '/api/v1/processing/hierarchy': { schemaVersion: 1, organizations: [], groups: [], nextCursor: null, capabilities: {} },
  };
  let context;
  const reply = path => {
    if (path.startsWith('/api/v1/processing/hierarchy') && onHierarchy) return onHierarchy(context.state);
    if (routes[path]) return routes[path](context.state);
    return failing.has(path)
      ? Promise.reject(new Error(`${path} returned 503`))
      : Promise.resolve(fixtures[path] || {});
  };
  const renders = [];
  const elements = {};
  const element = selector => (elements[selector] ||= { className: '', textContent: '' });
  context = vm.createContext({
    loadHierarchy,
    state: { token: 'token', projects: [], datasets: [], tasks: [], providers: [], presets: [], outputs: [], failedMutations: [], operations: [], derivativeJobs: [], storage: null, ...previous },
    pagedApi: path => reply(path),
    shareCalls: [],
    api: path => reply(path),
    pagedStorage: () => Promise.resolve({ usage: {}, items: [] }),
    can: () => false,
    access() { throw new Error('access() should not run with a token'); },
    validateWorkspaceView() {},
    syncWorkspaceView() {},
    render: () => renders.push(true),
    hydrateExpandedTask() {},
    scheduleOperationRefresh() {},
    document: { querySelector: element },
    encodeURIComponent,
    Promise,
    Object,
  });
  vm.runInContext(`${line('async function load(')};globalThis.load=load;`, context);
  return { context, renders, elements };
}

test('a 401 while loading the hierarchy stops the load: no render and no late hierarchy write', async () => {
  const kept = { organizations: [{ id: 'org-old' }], groups: [] };
  const { context, renders } = harness({
    previous: { hierarchy: kept },
    onHierarchy: state => { state.token = null; return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })); },
  });
  await context.load();
  assert.equal(context.state.token, null);
  assert.equal(renders.length, 0);
  assert.equal(context.state.hierarchy, kept);
});

test('a hierarchy answer that arrives after the session changed is dropped', async () => {
  const { context, renders } = harness({
    onHierarchy: state => { state.token = 'newer-session'; return Promise.resolve({ schemaVersion: 1, organizations: [{ id: 'org-late' }], groups: [], nextCursor: null }); },
  });
  await context.load();
  assert.equal(renders.length, 0);
  assert.equal(context.state.hierarchy, undefined);
});

test('a hierarchy failure keeps the last loaded grouping', async () => {
  const kept = { organizations: [{ id: 'org-old' }], groups: [] };
  const { context, renders } = harness({ previous: { hierarchy: kept }, onHierarchy: () => Promise.reject(new Error('503')) });
  await context.load();
  assert.equal(context.state.hierarchy, kept);
  assert.equal(renders.length, 1);
});

test('a rejected readiness check shows status unavailable instead of a stale Platform ready', async () => {
  const { context, elements } = harness({ failing: new Set(['/api/v1/processing/ready']), previous: { ready: { ok: true } } });
  await context.load();
  assert.equal(context.state.ready, null);
  assert.equal(elements['#nav-health-label'].textContent, 'Status unavailable');
  assert.doesNotMatch(elements['#nav-health-dot'].className, /good/);
  assert.deepEqual(plain(context.state.loadErrors.map(error => error.label)), ['platform status']);
});

test('only imports and derivatives failing keeps their last rows and still reports both', async () => {
  const previous = { operations: [{ id: 'kept-operation' }], derivativeJobs: [{ id: 'kept-derivative' }] };
  const { context, elements } = harness({ failing: new Set(['/api/v1/operations', '/api/v1/processing/derivatives']), previous });
  await context.load();
  assert.deepEqual(plain(context.state.operations.map(item => item.id)), ['kept-operation']);
  assert.deepEqual(plain(context.state.derivativeJobs.map(item => item.id)), ['kept-derivative']);
  assert.deepEqual(plain(context.state.loadErrors.map(error => error.label)), ['imports', 'model derivatives']);
  assert.equal(elements['#nav-health-label'].textContent, 'Platform ready');
});

test('a failed core request keeps the last loaded data and reports which source failed', async () => {
  const previous = { projects: [{ id: 'kept-project' }], providers: [{ id: 'kept-node' }], loaded: true };
  const { context, renders } = harness({ failing: new Set(['/api/v1/projects', '/api/v1/processing/providers?limit=100']), previous });
  await context.load();
  assert.deepEqual(plain(context.state.projects.map(project => project.id)), ['kept-project']);
  assert.deepEqual(plain(context.state.providers.map(provider => provider.id)), ['kept-node']);
  assert.deepEqual(plain(context.state.tasks.map(task => task.id)), ['fresh-task']);
  assert.deepEqual(plain(context.state.loadErrors.map(error => error.label)), ['projects', 'processing nodes']);
  assert.match(context.state.loadErrors[0].message, /503/);
  assert.equal(renders.length, 1);
});

test('a clean load clears earlier load errors', async () => {
  const { context } = harness({ previous: { loadErrors: [{ label: 'projects', message: 'old' }] } });
  await context.load();
  assert.deepEqual(plain(context.state.loadErrors), []);
  assert.deepEqual(plain(context.state.projects.map(project => project.id)), ['fresh-project']);
  assert.equal(context.state.loaded, true);
});

test('render shows a retryable alert instead of an empty list when data failed to load', () => {
  const render = line('function render(');
  assert.match(render, /load-error-banner" role="alert"/);
  assert.match(render, /data-load-retry>Try again</);
  assert.match(line('function bind('), /\[data-load-retry\][\s\S]*refreshWorkspace\(\)/);
});

test('navigation marks the current section and modals return focus to their opener', () => {
  assert.match(line('function renderNav('), /aria-current="page"/);
  assert.match(line('function openModal('), /addEventListener\('close'[\s\S]*opener\.focus\(\)/);
});

const published = { outputs: [{ id: 'output-live', taskId: 'fresh-task', activePublished: true }] };

test('a 401 on the final share lookup stops the load before health or render', async () => {
  const { context, renders, elements } = harness({
    routes: {
      '/api/v1/processing/outputs': () => Promise.resolve(published),
      '/api/v1/processing/outputs/output-live/shares': state => { state.token = null; return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })); },
    },
  });
  await context.load();
  assert.equal(renders.length, 0);
  assert.equal(elements['#nav-health-label'], undefined);
});

test('a session replaced during the core requests leaves state untouched', async () => {
  const previous = { projects: [{ id: 'new-session-project' }] };
  const { context, renders } = harness({
    previous,
    routes: { '/api/v1/projects': state => { state.token = 'replacement'; return Promise.resolve({ projects: [{ id: 'old-session-project' }] }); } },
  });
  await context.load();
  assert.deepEqual(plain(context.state.projects.map(project => project.id)), ['new-session-project']);
  assert.equal(context.state.loadErrors, undefined);
  assert.equal(renders.length, 0);
});

test('a failing hierarchy is reported, but a server without the endpoint is not', async () => {
  const failing = harness({ onHierarchy: () => Promise.reject(Object.assign(new Error('hierarchy 503'), { status: 503 })) });
  await failing.context.load();
  assert.deepEqual(plain(failing.context.state.loadErrors.map(error => error.label)), ['customer grouping']);
  const absent = harness({ onHierarchy: () => Promise.reject(Object.assign(new Error('not found'), { status: 404 })) });
  await absent.context.load();
  assert.deepEqual(plain(absent.context.state.loadErrors), []);
});

test('failed share lookups are reported and keep the last loaded links', async () => {
  const { context } = harness({
    previous: { shares: { 'output-live': [{ id: 'kept-share' }] } },
    routes: {
      '/api/v1/processing/outputs': () => Promise.resolve(published),
      '/api/v1/processing/outputs/output-live/shares': () => Promise.reject(new Error('503')),
    },
  });
  await context.load();
  assert.deepEqual(plain(context.state.loadErrors.map(error => error.label)), ['share links']);
  assert.deepEqual(plain(context.state.shares['output-live'].map(share => share.id)), ['kept-share']);
});
